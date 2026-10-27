using System.Collections.Concurrent;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Npgsql;
using Teas.App;
using Teas.App.Platform;
using Teas.App.Platform.Jobs;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// SP3 4.3 / 4.7 Jobs (P6): one leader, a job claimed twice runs once, 3 retries then failed, work inside the job's company, cleanup > 7 days.
public sealed class JobsTests : IAsyncLifetime
{
    static readonly DateTimeOffset T0 = new(2026, 10, 27, 10, 0, 0, TimeSpan.Zero);

    DbClone _db = null!;
    FakeTimeProvider _clock = null!;
    ServiceProvider _sp = null!;
    readonly List<JobRunner> _runners = [];
    readonly ConcurrentQueue<(string Kind, Guid JobCompany, Guid? ScopeCompany, bool System, string Payload)> _runs = new();
    Func<string, Task<string?>> _behaviour = _ => Task.FromResult<string?>(null);

    public async Task InitializeAsync()
    {
        _db = await TestDb.CloneAsync();
        _clock = new FakeTimeProvider(T0);
        var s = new ServiceCollection();
        s.AddSingleton<TimeProvider>(_clock);
        s.AddTeasData(_db.AppCs);
        s.AddScoped<IJobHandler>(sp => new TestHandler(sp.GetRequiredService<TenantScope>(), _runs, p => _behaviour(p)));
        _sp = s.BuildServiceProvider();
    }

    public async Task DisposeAsync()
    {
        foreach (var r in _runners) await r.DisposeAsync();
        await _sp.DisposeAsync();
        await _db.DisposeAsync();
    }

    sealed class TestHandler(TenantScope scope, ConcurrentQueue<(string, Guid, Guid?, bool, string)> runs, Func<string, Task<string?>> behaviour) : IJobHandler
    {
        public string Kind => "test.job";
        public Task<string?> RunAsync(Guid companyId, string payload, CancellationToken ct)
        {
            runs.Enqueue((Kind, companyId, scope.Current.CompanyId, scope.Current.System, payload));
            return behaviour(payload);
        }
    }

    JobRunner NewRunner()
    {
        var r = new JobRunner(_sp.GetRequiredService<IServiceScopeFactory>(), _clock, _db.AppCs);
        _runners.Add(r);
        return r;
    }

    async Task<Guid> EnqueueAsync(Guid company, string kind = "test.job", string payload = "{}", DateTimeOffset? runAt = null)
    {
        var id = Guid.NewGuid();
        await _db.AsAppAsync(new ScopeState(company, null, false), async (c, t) =>
        {
            await using var cmd = new NpgsqlCommand("INSERT INTO teas.jobs (company_id, id, kind, payload, run_at) VALUES (@c, @i, @k, @p::jsonb, @r)", c, t);
            cmd.Parameters.AddWithValue("c", company);
            cmd.Parameters.AddWithValue("i", id);
            cmd.Parameters.AddWithValue("k", kind);
            cmd.Parameters.AddWithValue("p", payload);
            cmd.Parameters.AddWithValue("r", runAt ?? T0);
            return await cmd.ExecuteNonQueryAsync();
        }, commit: true);
        return id;
    }

    async Task<(string Status, int Attempts, string? Error, string? Result)> JobAsync(Guid company, Guid id) =>
        await _db.AsAppAsync(new ScopeState(company, null, false), async (c, t) =>
        {
            await using var cmd = new NpgsqlCommand("SELECT status, attempts, last_error, result::text FROM teas.jobs WHERE id = @i", c, t);
            cmd.Parameters.AddWithValue("i", id);
            await using var r = await cmd.ExecuteReaderAsync();
            Assert.True(await r.ReadAsync());
            return (r.GetString(0), r.GetInt32(1), r.IsDBNull(2) ? null : r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3));
        });

    async Task<DateTimeOffset> RunAtAsync(Guid company, Guid id) =>
        await _db.AsAppAsync(new ScopeState(company, null, false), async (c, t) =>
        {
            await using var cmd = new NpgsqlCommand("SELECT run_at FROM teas.jobs WHERE id = @i", c, t);
            cmd.Parameters.AddWithValue("i", id);
            await using var r = await cmd.ExecuteReaderAsync();
            await r.ReadAsync();
            return r.GetFieldValue<DateTimeOffset>(0);
        });

    Task SetRunningAsync(Guid company, Guid id, DateTimeOffset startedAt, int attempts) =>
        _db.AsAppAsync(new ScopeState(company, null, false), async (c, t) =>
        {
            await using var cmd = new NpgsqlCommand("UPDATE teas.jobs SET status = 'running', started_at = @s, attempts = @a WHERE id = @i", c, t);
            cmd.Parameters.AddWithValue("s", startedAt);
            cmd.Parameters.AddWithValue("a", attempts);
            cmd.Parameters.AddWithValue("i", id);
            return await cmd.ExecuteNonQueryAsync();
        }, commit: true);

    [Fact]
    public async Task AHandlersOwnTimeoutIsAFailedAttemptAndTheTickReturns()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var id = await EnqueueAsync(company);
        _behaviour = _ => throw new TaskCanceledException("handler timeout");
        Assert.Equal(1, await NewRunner().TickAsync(default));   // does not throw
        var job = await JobAsync(company, id);
        Assert.Equal(("queued", 1, "handler timeout"), (job.Status, job.Attempts, job.Error));
    }

    [Fact]
    public async Task AStaleRunningJobPastTheLeaseIsReclaimedOnceAFreshOneIsLeftAlone()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var stale = await EnqueueAsync(company);
        var fresh = await EnqueueAsync(company);
        await SetRunningAsync(company, stale, T0 - JobRunner.Lease - TimeSpan.FromMinutes(1), 1);
        await SetRunningAsync(company, fresh, T0 - TimeSpan.FromMinutes(5), 1);
        var runners = Enumerable.Range(0, 4).Select(_ => NewRunner()).ToArray();
        var claimed = await Task.WhenAll(runners.Select(r => r.RunJobAsync(company, stale, default)));
        Assert.Equal(1, claimed.Count(x => x));   // reaped once
        Assert.False(await runners[0].RunJobAsync(company, fresh, default));
        Assert.Single(_runs);
        var job = await JobAsync(company, stale);
        Assert.Equal(("done", 2), (job.Status, job.Attempts));
        Assert.Equal(("running", 1), ((await JobAsync(company, fresh)).Status, (await JobAsync(company, fresh)).Attempts));
    }

    [Fact]
    public async Task AZombieRunThatFinishesAfterItsLeaseWasReapedDoesNotOverwriteTheNewerRun()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var id = await EnqueueAsync(company);
        var release1 = new TaskCompletionSource();
        var release2 = new TaskCompletionSource();
        var calls = 0;
        _behaviour = async _ =>
        {
            if (Interlocked.Increment(ref calls) > 1) { await release2.Task; return """{"run":2}"""; }
            await release1.Task;
            return """{"run":1}""";
        };
        var first = NewRunner().RunJobAsync(company, id, default);   // claims, then waits inside its handler
        while (calls < 1) await Task.Delay(20);
        await _db.AsAppAsync(new ScopeState(company, null, false), async (c, t) =>
        {
            await using var cmd = new NpgsqlCommand("UPDATE teas.jobs SET started_at = @s WHERE id = @i", c, t);
            cmd.Parameters.AddWithValue("s", T0 - JobRunner.Lease - TimeSpan.FromMinutes(1));   // its lease ran out
            cmd.Parameters.AddWithValue("i", id);
            return await cmd.ExecuteNonQueryAsync();
        }, commit: true);
        _clock.Advance(TimeSpan.FromSeconds(1));
        var second = NewRunner().RunJobAsync(company, id, default);   // reaps the lease and is now running
        while (calls < 2) await Task.Delay(20);
        release1.SetResult();
        Assert.True(await first);   // the zombie finishes while the newer run is still going, and must not write
        var mid = await JobAsync(company, id);
        Assert.Equal(("running", 2, null), (mid.Status, mid.Attempts, mid.Result));
        release2.SetResult();
        Assert.True(await second);
        var job = await JobAsync(company, id);
        Assert.Equal(("done", 2), (job.Status, job.Attempts));
        Assert.Contains("2", job.Result);   // jsonb text: {"run": 2}
    }

    [Fact]
    public async Task AStaleRunningJobThatUsedItsLastAttemptFailsWithLeaseExpiredAndDoesNotRun()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var id = await EnqueueAsync(company);
        await SetRunningAsync(company, id, T0 - JobRunner.Lease - TimeSpan.FromMinutes(1), JobRunner.MaxRetries + 1);
        Assert.Equal(0, await NewRunner().TickAsync(default));
        Assert.Empty(_runs);
        var job = await JobAsync(company, id);
        Assert.Equal(("failed", "lease expired"), (job.Status, job.Error));
    }

    [Fact]
    public async Task ShutdownMidHandlerRequeuesTheJobWithoutCountingTheAttempt()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var id = await EnqueueAsync(company);
        using var cts = new CancellationTokenSource();
        _behaviour = async _ => { cts.Cancel(); await Task.Delay(Timeout.Infinite, cts.Token); return null; };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => NewRunner().RunJobAsync(company, id, cts.Token));
        var job = await JobAsync(company, id);
        Assert.Equal(("queued", 0), (job.Status, job.Attempts));
        _behaviour = _ => Task.FromResult<string?>(null);
        Assert.Equal(1, await NewRunner().TickAsync(default));   // due again at once
    }

    [Fact]
    public async Task ShutdownAfterTheHandlerReturnedNonJsonStillRequeuesTheJob()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var id = await EnqueueAsync(company);
        using var cts = new CancellationTokenSource();
        _behaviour = _ => { cts.Cancel(); return Task.FromResult<string?>("not json"); };   // the result is validated after shutdown began
        await Assert.ThrowsAnyAsync<Exception>(() => NewRunner().RunJobAsync(company, id, cts.Token));
        var job = await JobAsync(company, id);
        Assert.Equal(("queued", 0, null), (job.Status, job.Attempts, job.Result));
    }

    [Fact]
    public async Task ANonJsonResultIsAFailedAttemptAndTheNextDueJobStillRuns()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var bad = await EnqueueAsync(company, payload: """{"n":"bad"}""");
        var good = await EnqueueAsync(company, payload: """{"n":"good"}""", runAt: T0.AddSeconds(1));
        _clock.Advance(TimeSpan.FromSeconds(1));
        _behaviour = p => Task.FromResult<string?>(p.Contains("bad") ? "not json" : """{"ok":1}""");
        Assert.Equal(2, await NewRunner().TickAsync(default));
        var b = await JobAsync(company, bad);
        Assert.Equal("queued", b.Status);
        Assert.Null(b.Result);
        Assert.NotNull(b.Error);
        Assert.Equal("done", (await JobAsync(company, good)).Status);
    }

    [Fact]
    public async Task TwoRunnersOneLeaderAndTheOtherTakesOverWhenItStops()
    {
        var a = NewRunner();
        var b = NewRunner();
        await a.TickAsync(default);
        await b.TickAsync(default);
        Assert.True(a.IsLeader);
        Assert.False(b.IsLeader);
        await a.TickAsync(default);   // stays leader
        Assert.True(a.IsLeader);
        await a.DisposeAsync();
        await b.TickAsync(default);
        Assert.True(b.IsLeader);
    }

    [Fact]
    public async Task LeadershipIsLostWhenTheLockConnectionDrops()
    {
        var a = NewRunner();
        var b = NewRunner();
        await a.TickAsync(default);
        Assert.True(a.IsLeader);
        await a.LeaderConnection!.CloseAsync();   // the session (and its advisory lock) is gone
        await b.TickAsync(default);               // B takes over before A notices
        Assert.True(b.IsLeader);
        await a.TickAsync(default);               // A notices the drop, and cannot re-take the lock
        Assert.False(a.IsLeader);
        Assert.True(b.IsLeader);
    }

    [Fact]
    public async Task OnlyTheLeaderRunsJobs()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var a = NewRunner();
        var b = NewRunner();
        await a.TickAsync(default);   // A becomes the leader while the queue is empty
        var id = await EnqueueAsync(company);
        Assert.Equal(0, await b.TickAsync(default));
        Assert.Empty(_runs);
        Assert.Equal(1, await a.TickAsync(default));
        Assert.Equal("done", (await JobAsync(company, id)).Status);
    }

    [Fact]
    public async Task AJobClaimedTwiceRunsOnce()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var id = await EnqueueAsync(company);
        _behaviour = async _ => { await Task.Delay(300); return null; };
        var runners = Enumerable.Range(0, 6).Select(_ => NewRunner()).ToArray();
        var claimed = await Task.WhenAll(runners.Select(r => r.RunJobAsync(company, id, default)));
        Assert.Equal(1, claimed.Count(x => x));
        Assert.Single(_runs);
        var job = await JobAsync(company, id);
        Assert.Equal(("done", 1), (job.Status, job.Attempts));
    }

    [Fact]
    public async Task AFailingJobRetriesThreeTimesThenFailsWithItsError()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var id = await EnqueueAsync(company);
        _behaviour = _ => throw new InvalidOperationException("boom");
        var r = NewRunner();
        Assert.Equal(1, await r.TickAsync(default));
        var first = await JobAsync(company, id);
        Assert.Equal(("queued", 1, "boom"), (first.Status, first.Attempts, first.Error));
        Assert.Equal(T0.AddSeconds(30), await RunAtAsync(company, id));
        Assert.Equal(0, await r.TickAsync(default));   // backing off: not due yet
        foreach (var (i, wait, next) in new[] { (2, 30, 60), (3, 60, 120), (4, 120, 0) })
        {
            _clock.Advance(TimeSpan.FromSeconds(wait));
            Assert.Equal(1, await r.TickAsync(default));
            Assert.Equal(i, (await JobAsync(company, id)).Attempts);
            if (next > 0) Assert.Equal(_clock.GetUtcNow().AddSeconds(next), await RunAtAsync(company, id));   // 30 s, 60 s, 120 s
        }
        var last = await JobAsync(company, id);
        Assert.Equal(("failed", 4, "boom"), (last.Status, last.Attempts, last.Error));   // first run + 3 retries
        _clock.Advance(TimeSpan.FromDays(1));
        Assert.Equal(0, await r.TickAsync(default));
        Assert.Equal(4, _runs.Count);
    }

    [Fact]
    public async Task ARetryThatSucceedsIsDoneWithItsResult()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var id = await EnqueueAsync(company, payload: """{"n":1}""");
        var calls = 0;
        _behaviour = _ => ++calls == 1 ? throw new InvalidOperationException("once") : Task.FromResult<string?>("""{"ok":true}""");
        var r = NewRunner();
        await r.TickAsync(default);
        _clock.Advance(TimeSpan.FromMinutes(10));
        await r.TickAsync(default);
        var job = await JobAsync(company, id);
        Assert.Equal(("done", 2), (job.Status, job.Attempts));
        Assert.Contains("\"ok\"", job.Result);
    }

    [Fact]
    public async Task EachJobRunsInsideItsOwnCompanyScopeNeverSystem()
    {
        var a = await PlatformTestHost.NewCompanyAsync(_db);
        var b = await PlatformTestHost.NewCompanyAsync(_db);
        await EnqueueAsync(a, payload: """{"who":"a"}""");
        await EnqueueAsync(b, payload: """{"who":"b"}""");
        await EnqueueAsync(b, "no.handler");
        var r = NewRunner();
        Assert.Equal(3, await r.TickAsync(default));
        var runs = _runs.ToArray();
        Assert.Equal(2, runs.Length);
        Assert.All(runs, x => { Assert.Equal(x.JobCompany, x.ScopeCompany); Assert.False(x.System); });
        Assert.Contains(runs, x => x.JobCompany == a && x.Payload.Contains("\"a\""));
        Assert.Contains(runs, x => x.JobCompany == b && x.Payload.Contains("\"b\""));
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "jobs", "kind = 'no.handler' AND status = 'queued' AND last_error IS NOT NULL"));   // an unknown kind fails like any other error
    }

    [Fact]
    public async Task AFutureJobWaitsUntilItIsDue()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var id = await EnqueueAsync(company, runAt: T0.AddMinutes(5));
        var r = NewRunner();
        Assert.Equal(0, await r.TickAsync(default));
        _clock.Advance(TimeSpan.FromMinutes(5));
        Assert.Equal(1, await r.TickAsync(default));
        Assert.Equal("done", (await JobAsync(company, id)).Status);
    }

    async Task SeedIdempotencyAsync(Guid company, params TimeSpan[] ages)
    {
        await _db.AsAppAsync(new ScopeState(company, null, false), async (c, t) =>
        {
            foreach (var age in ages)
            {
                await using var cmd = new NpgsqlCommand("INSERT INTO teas.idempotency_records (company_id, actor_id, key, route, request_hash, status_code, created_at) VALUES (@c, gen_random_uuid(), gen_random_uuid(), 'POST /t', 'h', 201, @at)", c, t);
                cmd.Parameters.AddWithValue("c", company);
                cmd.Parameters.AddWithValue("at", T0 - age);
                await cmd.ExecuteNonQueryAsync();
            }
            return 0;
        }, commit: true);
    }

    [Fact]
    public async Task CleanupDeletesRecordsOlderThanSevenDaysInEveryCompanyAndKeepsTheRest()
    {
        var a = await PlatformTestHost.NewCompanyAsync(_db);
        var b = await PlatformTestHost.NewCompanyAsync(_db);
        var old = TimeSpan.FromDays(7) + TimeSpan.FromMinutes(1);
        var fresh = TimeSpan.FromDays(7) - TimeSpan.FromMinutes(1);
        await SeedIdempotencyAsync(a, old, old, fresh);
        await SeedIdempotencyAsync(b, old, TimeSpan.FromHours(1));
        await using var sc = _sp.CreateAsyncScope();
        Assert.Equal(3, await sc.ServiceProvider.GetRequiredService<IdempotencyCleanupJob>().RunAsync());
        Assert.Equal(2, await PlatformTestHost.CountAsync(_db, "idempotency_records"));
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "idempotency_records", $"company_id = '{a}'"));
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "idempotency_records", $"company_id = '{b}'"));
    }

    [Fact]
    public async Task TheLeaderTickRunsTheCleanupAtMostOncePerHourAndAFollowerNever()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        await SeedIdempotencyAsync(company, TimeSpan.FromDays(8));
        var a = NewRunner();
        var b = NewRunner();
        await a.TickAsync(default);
        await b.TickAsync(default);
        Assert.Equal(0, await PlatformTestHost.CountAsync(_db, "idempotency_records"));
        await SeedIdempotencyAsync(company, TimeSpan.FromDays(8));
        await a.TickAsync(default);   // same hour: not again
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "idempotency_records"));
        _clock.Advance(TimeSpan.FromHours(1));
        await b.TickAsync(default);   // a follower never cleans
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "idempotency_records"));
        await a.TickAsync(default);
        Assert.Equal(0, await PlatformTestHost.CountAsync(_db, "idempotency_records"));
    }
}
