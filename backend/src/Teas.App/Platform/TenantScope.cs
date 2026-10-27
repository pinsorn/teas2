using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Npgsql;

[assembly: InternalsVisibleTo("Teas.Migrator")]
[assembly: InternalsVisibleTo("Teas.Integration.Tests")]
[assembly: InternalsVisibleTo("Teas.Api")]   // StartupGuards only (architecture test)

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
/// Scoped per request and bound to ONE DbContext; it is not AsyncLocal. Scopes nest and must be disposed in reverse order.
/// GUCs follow savepoints: never ROLLBACK TO SAVEPOINT a savepoint taken inside a scope after leaving that scope; re-enter the
/// scope after any manual savepoint rollback.
/// </summary>
public sealed class TenantScope
{
    const string InFailedTransaction = "25P02";

    DbConnection? _conn;
    DbTransaction? _tx;
    int _depth;

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
        try { Set(next); }
        catch { Current = previous; throw; }   // a failed apply must not leave the new scope as the state of the NEXT transaction (fail-open)
        return new Restore(this, previous, ++_depth);
    }

    void Set(ScopeState state)
    {
        Current = state;
        // a transaction is already open: the GUCs were applied for the old state, so apply the new one now
        if (_tx is null || _conn is null) return;
        if (!Owns(_conn, _tx)) { _conn = null; _tx = null; return; }   // ended without an interceptor event (disposed = rolled back)
        try { ApplyAsync(_conn, _tx, state, force: true).GetAwaiter().GetResult(); }
        // a failed transaction accepts nothing and leaks nothing: skip, so the ORIGINAL error reaches the caller, not this one
        catch (PostgresException e) when (e.SqlState == InFailedTransaction) { }
    }

    /// <summary>The transaction is still ours: its connection is the one we attached to, and that connection is open.
    /// (Npgsql reuses transaction objects across pooled connections, so a cached object alone proves nothing.)</summary>
    static bool Owns(DbConnection conn, DbTransaction tx)
    {
        try { return conn.State == ConnectionState.Open && ReferenceEquals(tx.Connection, conn); }
        catch (ObjectDisposedException) { return false; }
    }

    sealed class Restore(TenantScope scope, ScopeState previous, int depth) : IDisposable
    {
        bool _done;

        public void Dispose()
        {
            if (_done) return;
            if (scope._depth != depth) throw new InvalidOperationException("TenantScope scopes must be disposed in reverse order of Enter");
            _done = true;
            scope._depth--;
            scope.Set(previous);
        }
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
    /// Startup RLS self-test (SP3 4.3): teas.companies (never hard-deleted) counted with no GUC (must be 0) and under system scope.
    /// </summary>
    internal static async Task<(long noGuc, long system)> SelfTestAsync(NpgsqlConnection conn, CancellationToken ct = default)
    {
        await using var tx = await conn.BeginTransactionAsync(ct);
        var noGuc = await Count(conn, tx, ct);
        await ApplyAsync(conn, tx, new ScopeState(null, null, true), ct);
        return (noGuc, await Count(conn, tx, ct));

        static async Task<long> Count(NpgsqlConnection c, NpgsqlTransaction t, CancellationToken ct)
        {
            await using var cmd = new NpgsqlCommand("SELECT count(*) FROM teas.companies", c, t);
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
