using System.Data.Common;
using System.Runtime.CompilerServices;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Npgsql;

[assembly: InternalsVisibleTo("Teas.Migrator")]
[assembly: InternalsVisibleTo("Teas.Integration.Tests")]

namespace Teas.App.Platform;

/// <summary>What the transaction-local GUCs say (SP3 4.3). None = no GUC at all: every tenant policy returns 0 rows.
/// Internal: system state is built only inside this file (architecture test greps the constructor).</summary>
internal readonly record struct ScopeState(Guid? CompanyId, Guid? UserId, bool System)
{
    public static ScopeState None => default;
    public bool IsNone => CompanyId is null && UserId is null && !System;
}

/// <summary>
/// The ONLY place that writes the RLS context (F3: transaction-local, never session-wide; an architecture test greps the
/// repo for it). Enter / EnterSystem set the state; if a transaction is already active on the context the new state is
/// applied to it at once, and disposing the scope re-applies the previous state (H1).
/// </summary>
public sealed class TenantScope
{
    DbConnection? _conn;
    DbTransaction? _tx;

    internal ScopeState Current { get; private set; }

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
        Set(next);
        return new Restore(this, previous);
    }

    void Set(ScopeState state)
    {
        Current = state;
        // a transaction is already open: the GUCs were applied for the old state, so apply the new one now
        if (_tx is null || _conn is null) return;
        if (!IsLive(_tx)) { _conn = null; _tx = null; return; }   // ended without an interceptor event (disposed = rolled back)
        ApplyAsync(_conn, _tx, state, force: true).GetAwaiter().GetResult();   // a real failure here must surface, never leave a stale scope
    }

    static bool IsLive(DbTransaction tx)
    {
        try { return tx.Connection is not null; } catch (ObjectDisposedException) { return false; }
    }

    sealed class Restore(TenantScope scope, ScopeState previous) : IDisposable
    {
        public void Dispose() => scope.Set(previous);
    }

    internal void Attach(DbConnection conn, DbTransaction tx) { _conn = conn; _tx = tx; }
    internal void Detach(DbTransaction tx) { if (ReferenceEquals(_tx, tx)) { _conn = null; _tx = null; } }

    /// <summary>First statement of a transaction. A None state is skipped (a no-GUC read stays a no-GUC read) unless
    /// <paramref name="force"/>, which writes empty values to clear a previously applied scope.</summary>
    internal static async Task ApplyAsync(DbConnection conn, DbTransaction tx, ScopeState s, CancellationToken ct = default, bool force = false)
    {
        if (s.IsNone && !force) return;
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
    internal static async Task<long> ForEachCompanyAsync(NpgsqlConnection conn, Func<Guid, NpgsqlTransaction, Task<long>> work, CancellationToken ct = default)
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

    /// <summary>
    /// Startup RLS self-test (SP3 4.3): per tenant table (already-quoted names from the catalog), the row count with no GUC
    /// (must be 0) and under system scope (the caller refuses 0 where the table is known to hold rows).
    /// </summary>
    public static async Task<Dictionary<string, (long noGuc, long system)>> SelfTestAsync(NpgsqlConnection conn, IReadOnlyList<string> quotedTables, CancellationToken ct = default)
    {
        await using var tx = await conn.BeginTransactionAsync(ct);
        var result = new Dictionary<string, (long, long)>();
        foreach (var t in quotedTables) result[t] = (await Count(conn, tx, t, ct), 0);
        await ApplyAsync(conn, tx, new ScopeState(null, null, true), ct);
        foreach (var t in quotedTables) result[t] = (result[t].Item1, await Count(conn, tx, t, ct));
        return result;

        static async Task<long> Count(NpgsqlConnection c, NpgsqlTransaction t, string table, CancellationToken ct)
        {
            await using var cmd = new NpgsqlCommand("SELECT count(*) FROM " + table, c, t);
            return (long)(await cmd.ExecuteScalarAsync(ct))!;
        }
    }
}

/// <summary>Applies the scope as the first statement of every EF transaction (explicit or SaveChanges' own) and tells the
/// scope which transaction is active, so a later Enter / Dispose reaches the database.</summary>
public sealed class TenantInterceptor(TenantScope scope) : DbTransactionInterceptor
{
    public override async ValueTask<DbTransaction> TransactionStartedAsync(DbConnection connection, TransactionEndEventData eventData, DbTransaction result, CancellationToken cancellationToken = default)
    {
        scope.Attach(connection, result);
        await TenantScope.ApplyAsync(connection, result, scope.Current, cancellationToken);
        return result;
    }

    public override DbTransaction TransactionStarted(DbConnection connection, TransactionEndEventData eventData, DbTransaction result)
    {
        scope.Attach(connection, result);
        TenantScope.ApplyAsync(connection, result, scope.Current).GetAwaiter().GetResult();
        return result;
    }

    public override void TransactionCommitted(DbTransaction transaction, TransactionEndEventData eventData) => scope.Detach(transaction);
    public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default) { scope.Detach(transaction); return Task.CompletedTask; }
    public override void TransactionRolledBack(DbTransaction transaction, TransactionEndEventData eventData) => scope.Detach(transaction);
    public override Task TransactionRolledBackAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default) { scope.Detach(transaction); return Task.CompletedTask; }
    public override void TransactionFailed(DbTransaction transaction, TransactionErrorEventData eventData) => scope.Detach(transaction);
    public override Task TransactionFailedAsync(DbTransaction transaction, TransactionErrorEventData eventData, CancellationToken cancellationToken = default) { scope.Detach(transaction); return Task.CompletedTask; }
}
