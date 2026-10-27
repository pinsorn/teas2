using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Npgsql;

namespace Teas.App.Platform;

/// <summary>What the transaction-local GUCs say (SP3 4.3). None = no GUC at all: every tenant policy returns 0 rows.</summary>
public readonly record struct ScopeState(Guid? CompanyId, Guid? UserId, bool System)
{
    public static ScopeState None => default;
    public bool IsNone => CompanyId is null && UserId is null && !System;
}

/// <summary>
/// The ONLY place that writes the RLS context (F3: transaction-local, never session-wide; an architecture test greps the
/// repo for it). Enter / EnterSystem set the state; the interceptor applies it when a transaction starts.
/// </summary>
public sealed class TenantScope
{
    public ScopeState Current { get; private set; }

    public IDisposable Enter(Guid companyId, Guid? userId) => Swap(new ScopeState(companyId, userId, false));

    /// <summary>System scope reads and deletes across companies, never writes a row (WITH CHECK). The caller logs the reason.</summary>
    public IDisposable EnterSystem(string reason)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        return Swap(new ScopeState(null, null, true));
    }

    IDisposable Swap(ScopeState next)
    {
        var previous = Current;
        Current = next;
        return new Restore(this, previous);
    }

    sealed class Restore(TenantScope scope, ScopeState previous) : IDisposable
    {
        public void Dispose() => scope.Current = previous;
    }

    /// <summary>First statement of a transaction. No-op for None so a no-GUC read stays a no-GUC read.</summary>
    public static async Task ApplyAsync(DbConnection conn, DbTransaction tx, ScopeState s, CancellationToken ct = default)
    {
        if (s.IsNone) return;
        await using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "SELECT set_config('app.company_id', @c, true), set_config('app.user_id', @u, true), set_config('app.system', @s, true)";
        AddText(cmd, "c", s.CompanyId?.ToString() ?? "");
        AddText(cmd, "u", s.UserId?.ToString() ?? "");
        AddText(cmd, "s", s.System ? "on" : "off");
        await cmd.ExecuteNonQueryAsync(ct);
    }

    static void AddText(DbCommand cmd, string name, string value)
    {
        var p = cmd.CreateParameter();
        p.ParameterName = name;
        p.Value = value;
        cmd.Parameters.Add(p);
    }

    /// <summary>
    /// Data-migration helper (F5: FORCE RLS applies to the migrator, so a plain UPDATE touches 0 tenant rows). Lists the
    /// companies under system scope, then runs <paramref name="work"/> once per company in its own transaction with that
    /// company set. Returns the summed row count the callback reports; the CALLER asserts it.
    /// </summary>
    public static async Task<long> ForEachCompanyAsync(NpgsqlConnection conn, Func<Guid, NpgsqlTransaction, Task<long>> work, CancellationToken ct = default)
    {
        var ids = new List<Guid>();
        await using (var tx = await conn.BeginTransactionAsync(ct))
        {
            await ApplyAsync(conn, tx, new ScopeState(null, null, true), ct);
            await using var cmd = new NpgsqlCommand("SELECT id FROM teas.companies ORDER BY id", conn, tx);
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) ids.Add(r.GetGuid(0));
        }
        long total = 0;
        foreach (var id in ids)
        {
            await using var tx = await conn.BeginTransactionAsync(ct);
            await ApplyAsync(conn, tx, new ScopeState(id, null, false), ct);
            total += await work(id, tx);
            await tx.CommitAsync(ct);
        }
        return total;
    }

    /// <summary>Startup RLS self-test (SP3 4.3): companies with no GUC must count 0; under system scope it is above 0 on a non-empty DB.</summary>
    public static async Task<(long noGuc, long system)> CountCompaniesAsync(NpgsqlConnection conn, CancellationToken ct = default)
    {
        await using var tx = await conn.BeginTransactionAsync(ct);
        var noGuc = await Count(conn, tx, ct);
        await ApplyAsync(conn, tx, new ScopeState(null, null, true), ct);
        var system = await Count(conn, tx, ct);
        return (noGuc, system);

        static async Task<long> Count(NpgsqlConnection c, NpgsqlTransaction t, CancellationToken ct)
        {
            await using var cmd = new NpgsqlCommand("SELECT count(*) FROM teas.companies", c, t);
            return (long)(await cmd.ExecuteScalarAsync(ct))!;
        }
    }
}

/// <summary>Applies the scope as the first statement of every EF transaction (explicit or SaveChanges' own).</summary>
public sealed class TenantInterceptor(TenantScope scope) : DbTransactionInterceptor
{
    public override async ValueTask<DbTransaction> TransactionStartedAsync(DbConnection connection, TransactionEndEventData eventData, DbTransaction result, CancellationToken cancellationToken = default)
    {
        await TenantScope.ApplyAsync(connection, result, scope.Current, cancellationToken);
        return result;
    }

    public override DbTransaction TransactionStarted(DbConnection connection, TransactionEndEventData eventData, DbTransaction result)
    {
        TenantScope.ApplyAsync(connection, result, scope.Current).GetAwaiter().GetResult();
        return result;
    }
}
