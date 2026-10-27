using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Npgsql;
using NpgsqlTypes;
using Teas.App.Platform.Concurrency;

namespace Teas.App.Platform.Jobs;

/// <summary>One kind of job. Resolved from the job's own DI scope, which already sits inside <c>TenantScope.Enter(job.company_id)</c>:
/// inject <see cref="TeasDbContext"/> and do the work in a transaction. Return the result as JSON (or null; anything else fails the attempt); throw to fail it.
/// Handlers MUST be idempotent: a job whose runner died is claimed again after <see cref="JobRunner.Lease"/> and may therefore run twice.</summary>
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
    /// <summary>A job still <c>running</c> this long after it started is presumed dead and is claimed again.</summary>
    public static readonly TimeSpan Lease = TimeSpan.FromMinutes(15);
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
            try
            {
                await sc.ServiceProvider.GetRequiredService<IdempotencyCleanupJob>().RunAsync(ct);
                _lastCleanup = clock.GetUtcNow();
            }
            catch (Exception e) when (!ct.IsCancellationRequested)   // never stops the jobs; _lastCleanup stays, so the next tick retries
            {
                sc.ServiceProvider.GetService<ILogger<JobRunner>>()?.LogError(e, "idempotency cleanup failed");
            }
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
        await using var cmd = TxSql.Cmd(db, "SELECT company_id, id FROM teas.jobs WHERE (status = 'queued' AND run_at <= @now) OR (status = 'running' AND started_at < @lease) ORDER BY run_at LIMIT 100", TxSql.P("now", clock.GetUtcNow()), TxSql.P("lease", clock.GetUtcNow() - Lease));
        var due = new List<(Guid, Guid)>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) due.Add((r.GetGuid(0), r.GetGuid(1)));
        return due;
    }

    /// <summary>Claims one job and, if this caller won the claim, runs it. False = somebody else claimed it (or it is not due / its lease ran out for good).</summary>
    internal async Task<bool> RunJobAsync(Guid company, Guid id, CancellationToken ct)
    {
        string kind, payload;
        int attempts;
        var claimedAt = clock.GetUtcNow();
        await using (var sc = scopes.CreateAsyncScope())
        {
            var db = sc.ServiceProvider.GetRequiredService<TeasDbContext>();
            using var _ = sc.ServiceProvider.GetRequiredService<TenantScope>().Enter(company, null);
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            // a lease that ran out after the last allowed attempt: give up instead of running it again
            await using (var give = TxSql.Cmd(db, """
                UPDATE teas.jobs SET status = 'failed', last_error = 'lease expired', finished_at = @now
                WHERE company_id = @c AND id = @i AND status = 'running' AND started_at < @lease AND attempts > @max
                """, TxSql.P("now", claimedAt), TxSql.P("lease", claimedAt - Lease), TxSql.P("max", MaxRetries), TxSql.P("c", company), TxSql.P("i", id)))
                if (await give.ExecuteNonQueryAsync(ct) == 1) { await tx.CommitAsync(ct); return false; }
            // the guard on status (and, for a reaped job, on started_at) is what makes a job claimed twice run once
            await using var claim = TxSql.Cmd(db, """
                UPDATE teas.jobs SET status = 'running', attempts = attempts + 1, started_at = @now
                WHERE company_id = @c AND id = @i AND run_at <= @now
                  AND (status = 'queued' OR (status = 'running' AND started_at < @lease))
                RETURNING kind, payload::text, attempts
                """, TxSql.P("now", claimedAt), TxSql.P("lease", claimedAt - Lease), TxSql.P("c", company), TxSql.P("i", id));
            await using (var r = await claim.ExecuteReaderAsync(ct))
            {
                if (!await r.ReadAsync(ct)) return false;
                (kind, payload, attempts) = (r.GetString(0), r.GetString(1), r.GetInt32(2));
            }
            await tx.CommitAsync(ct);
        }

        string? result = null, error = null;
        var interrupted = true;   // anything that leaves this block without an outcome (shutdown, a bug) requeues the job instead of stranding it
        try
        {
            await using var sc = scopes.CreateAsyncScope();
            using var _ = sc.ServiceProvider.GetRequiredService<TenantScope>().Enter(company, null);   // the handler works inside this company
            var handler = sc.ServiceProvider.GetServices<IJobHandler>().FirstOrDefault(h => h.Kind == kind)
                ?? throw new InvalidOperationException($"no handler for job kind '{kind}'");
            result = await handler.RunAsync(company, payload, ct);
            if (result is not null) JsonDocument.Parse(result).Dispose();   // the column is jsonb: a non-JSON result is a failed attempt
            interrupted = false;
        }
        catch (Exception e) when (!ct.IsCancellationRequested)   // a handler's own TaskCanceledException (timeout) is an ordinary failure
        {
            error = e.Message.Length > 2000 ? e.Message[..2000] : e.Message;
            result = null;
            interrupted = false;
        }
        finally
        {
            await FinishAsync(company, id, claimedAt, attempts, result, error, interrupted);   // CancellationToken.None: the outcome must be written
        }
        return true;
    }

    async Task FinishAsync(Guid company, Guid id, DateTimeOffset claimedAt, int attempts, string? result, string? error, bool interrupted)
    {
        await using var sc = scopes.CreateAsyncScope();
        var db = sc.ServiceProvider.GetRequiredService<TeasDbContext>();
        using var _ = sc.ServiceProvider.GetRequiredService<TenantScope>().Enter(company, null);
        await using var tx = await db.Database.BeginTransactionAsync(CancellationToken.None);
        var now = clock.GetUtcNow();
        var retry = error is not null && attempts <= MaxRetries;
        var status = interrupted ? "queued" : error is null ? "done" : retry ? "queued" : "failed";
        // interrupted (shutdown): due again at once and the attempt is not counted, it never finished; failed attempt: backoff 30 s, 60 s, 120 s
        var runAt = interrupted ? now : now + FirstBackoff * Math.Pow(2, attempts - 1);
        // started_at = claimedAt: a run whose lease was reaped and re-claimed must not overwrite the newer run's outcome
        await using var done = TxSql.Cmd(db, """
            UPDATE teas.jobs SET status = @st, last_error = CASE WHEN @interrupted THEN last_error ELSE @e END, result = @r::jsonb,
              attempts = attempts - @undo, run_at = CASE WHEN @st = 'queued' THEN @at ELSE run_at END, finished_at = @fin
            WHERE company_id = @c AND id = @i AND status = 'running' AND started_at = @started
            """,
            TxSql.P("st", status), TxSql.P("interrupted", interrupted), Text("e", error), Text("r", status == "done" ? result : null), TxSql.P("undo", interrupted ? 1 : 0),
            TxSql.P("at", runAt), new NpgsqlParameter("fin", NpgsqlDbType.TimestampTz) { Value = status == "queued" ? DBNull.Value : now },
            TxSql.P("started", claimedAt), TxSql.P("c", company), TxSql.P("i", id));
        await done.ExecuteNonQueryAsync(CancellationToken.None);
        await tx.CommitAsync(CancellationToken.None);
    }

    static NpgsqlParameter Text(string name, string? value) => new(name, NpgsqlDbType.Text) { Value = (object?)value ?? DBNull.Value };
}
