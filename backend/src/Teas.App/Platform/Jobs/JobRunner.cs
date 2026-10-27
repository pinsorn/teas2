using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using NpgsqlTypes;
using Teas.App.Platform.Concurrency;

namespace Teas.App.Platform.Jobs;

/// <summary>One kind of job. Resolved from the job's own DI scope, which already sits inside <c>TenantScope.Enter(job.company_id)</c>:
/// inject <see cref="TeasDbContext"/> and do the work in a transaction. Return the result as JSON (or null); throw to fail the attempt.</summary>
public interface IJobHandler
{
    string Kind { get; }
    Task<string?> RunAsync(Guid companyId, string payload, CancellationToken ct);
}

/// <summary>
/// SP3 4.7 Jobs / 4.3 "Job runner (leader)". One leader per cluster: <c>pg_try_advisory_lock</c> held on a dedicated, unpooled connection
/// (the lock dies with the connection, so a dropped connection means lost leadership). The leader polls: it lists due jobs under system
/// scope, claims each inside the job's company (<c>UPDATE ... WHERE status = 'queued'</c>, rowcount 1 = claimed), runs the handler there,
/// and records the result. A failed attempt is requeued with backoff up to <see cref="MaxRetries"/> retries, then the job is <c>failed</c>
/// with its last error. Call <see cref="TickAsync"/> every 30 s.
/// </summary>
public sealed class JobRunner(IServiceScopeFactory scopes, TimeProvider clock, string connectionString) : IAsyncDisposable
{
    public const int MaxRetries = 3;
    const long LockKey = 0x5445_4153_4A4F_4253;   // "TEASJOBS"
    static readonly TimeSpan CleanupEvery = TimeSpan.FromHours(1);
    static readonly TimeSpan FirstBackoff = TimeSpan.FromSeconds(30);   // then 60 s, 120 s

    NpgsqlConnection? _lock;
    DateTimeOffset? _lastCleanup;

    public bool IsLeader => _lock is not null;
    internal NpgsqlConnection? LeaderConnection => _lock;

    /// <returns>The number of jobs this tick claimed and ran (0 for a follower).</returns>
    public async Task<int> TickAsync(CancellationToken ct)
    {
        if (!await HoldLeadershipAsync(ct)) return 0;
        if (_lastCleanup is not { } last || clock.GetUtcNow() - last >= CleanupEvery)
        {
            await using var sc = scopes.CreateAsyncScope();
            await sc.ServiceProvider.GetRequiredService<IdempotencyCleanupJob>().RunAsync(ct);
            _lastCleanup = clock.GetUtcNow();
        }
        var ran = 0;
        foreach (var (company, id) in await DueAsync(ct))
            if (await RunJobAsync(company, id, ct)) ran++;
        return ran;
    }

    async Task<bool> HoldLeadershipAsync(CancellationToken ct)
    {
        if (_lock is not null)
        {
            try
            {
                await using var ping = new NpgsqlCommand("SELECT 1", _lock);
                await ping.ExecuteScalarAsync(ct);
                return true;
            }
            catch (Exception e) when (e is NpgsqlException or InvalidOperationException or IOException)
            {
                await DropLockAsync();   // the session is gone, and so is the lock
            }
        }
        var conn = new NpgsqlConnection(new NpgsqlConnectionStringBuilder(connectionString) { Pooling = false }.ToString());
        try
        {
            await conn.OpenAsync(ct);
            await using var cmd = new NpgsqlCommand("SELECT pg_try_advisory_lock(@k)", conn);
            cmd.Parameters.AddWithValue("k", LockKey);
            if ((bool)(await cmd.ExecuteScalarAsync(ct))!) { _lock = conn; return true; }
        }
        catch { await conn.DisposeAsync(); throw; }
        await conn.DisposeAsync();
        return false;
    }

    async Task DropLockAsync()
    {
        var c = _lock;
        _lock = null;
        if (c is not null) await c.DisposeAsync();
    }

    public ValueTask DisposeAsync() => new(DropLockAsync());   // closing the session releases the advisory lock

    async Task<List<(Guid Company, Guid Id)>> DueAsync(CancellationToken ct)
    {
        await using var sc = scopes.CreateAsyncScope();
        var db = sc.ServiceProvider.GetRequiredService<TeasDbContext>();
        using var _ = sc.ServiceProvider.GetRequiredService<TenantScope>().EnterSystem("jobs");
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await using var cmd = TxSql.Cmd(db, "SELECT company_id, id FROM teas.jobs WHERE status = 'queued' AND run_at <= @now ORDER BY run_at LIMIT 100", TxSql.P("now", clock.GetUtcNow()));
        var due = new List<(Guid, Guid)>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) due.Add((r.GetGuid(0), r.GetGuid(1)));
        return due;
    }

    /// <summary>Claims one job and, if this caller won the claim, runs it. False = somebody else claimed it (or it is not queued / due).</summary>
    internal async Task<bool> RunJobAsync(Guid company, Guid id, CancellationToken ct)
    {
        string kind, payload;
        int attempts;
        await using (var sc = scopes.CreateAsyncScope())
        {
            var db = sc.ServiceProvider.GetRequiredService<TeasDbContext>();
            using var _ = sc.ServiceProvider.GetRequiredService<TenantScope>().Enter(company, null);
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            await using var claim = TxSql.Cmd(db, """
                UPDATE teas.jobs SET status = 'running', attempts = attempts + 1, started_at = @now
                WHERE company_id = @c AND id = @i AND status = 'queued' AND run_at <= @now
                RETURNING kind, payload::text, attempts
                """, TxSql.P("now", clock.GetUtcNow()), TxSql.P("c", company), TxSql.P("i", id));
            await using (var r = await claim.ExecuteReaderAsync(ct))
            {
                if (!await r.ReadAsync(ct)) return false;
                (kind, payload, attempts) = (r.GetString(0), r.GetString(1), r.GetInt32(2));
            }
            await tx.CommitAsync(ct);
        }

        string? result = null, error = null;
        try
        {
            await using var sc = scopes.CreateAsyncScope();
            using var _ = sc.ServiceProvider.GetRequiredService<TenantScope>().Enter(company, null);   // the handler works inside this company
            var handler = sc.ServiceProvider.GetServices<IJobHandler>().FirstOrDefault(h => h.Kind == kind)
                ?? throw new InvalidOperationException($"no handler for job kind '{kind}'");
            result = await handler.RunAsync(company, payload, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            error = e.Message.Length > 2000 ? e.Message[..2000] : e.Message;
        }

        await using (var sc = scopes.CreateAsyncScope())
        {
            var db = sc.ServiceProvider.GetRequiredService<TeasDbContext>();
            using var _ = sc.ServiceProvider.GetRequiredService<TenantScope>().Enter(company, null);
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            var now = clock.GetUtcNow();
            var retry = error is not null && attempts <= MaxRetries;
            await using var done = TxSql.Cmd(db, """
                UPDATE teas.jobs SET status = @st, last_error = @e, result = @r::jsonb, run_at = CASE WHEN @st = 'queued' THEN @at ELSE run_at END, finished_at = @fin
                WHERE company_id = @c AND id = @i AND status = 'running'
                """,
                TxSql.P("st", error is null ? "done" : retry ? "queued" : "failed"),
                Text("e", error), Text("r", result),
                TxSql.P("at", retry ? now + FirstBackoff * Math.Pow(2, attempts - 1) : now),
                new NpgsqlParameter("fin", NpgsqlDbType.TimestampTz) { Value = retry ? DBNull.Value : now },
                TxSql.P("c", company), TxSql.P("i", id));
            await done.ExecuteNonQueryAsync(ct);
            await tx.CommitAsync(ct);
        }
        return true;
    }

    static NpgsqlParameter Text(string name, string? value) => new(name, NpgsqlDbType.Text) { Value = (object?)value ?? DBNull.Value };
}
