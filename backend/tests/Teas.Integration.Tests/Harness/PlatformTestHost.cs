using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Teas.App;
using Teas.App.Platform;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Concurrency;
using Teas.App.Platform.Idempotency;
using Teas.Domain;

namespace Teas.Integration.Tests.Harness;

/// <summary>Releases every waiter once <c>parties</c> have arrived: both requests are provably in flight before either proceeds.</summary>
public sealed class AsyncBarrier(int parties)
{
    readonly TaskCompletionSource _all = new(TaskCreationOptions.RunContinuationsAsynchronously);
    int _arrived;
    public Task ArriveAsync() { if (Interlocked.Increment(ref _arrived) >= parties) _all.TrySetResult(); return _all.Task.WaitAsync(TimeSpan.FromSeconds(20)); }
}

/// <summary>
/// SP3 P4: the test-only command endpoints (registered only in this test host, never in Program.cs, so they are not in
/// docs/api/openapi.v1.json). Header <c>x-barrier</c> makes the request wait for its twin before it touches the database.
/// </summary>
public static class PlatformTestHost
{
    public static readonly Guid User = Guid.Parse("00000000-0000-0000-0000-0000000000a1");

    sealed class TestRoutes : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            next(app);
            app.UseRouting();
            app.UseEndpoints(Map);
        };
    }

    public sealed record Cmd(bool Fail = false, string? Data = null, int Status = 201, int HoldMs = 0);
    public sealed record Upd(string Name, int Version);

    static void Map(Microsoft.AspNetCore.Routing.IEndpointRouteBuilder e)
    {
        // Idempotent command: one audit row 'test.effect' is its observable effect.
        e.MapPost("/internal/v1/_t/cmd/{company:guid}", async (Guid company, HttpRequest req, TenantScope scope, IdempotencyRunner idem, IAudit audit, AuditContext ctx, AsyncBarrier barrier) =>
        {
            var user = req.Headers.TryGetValue("x-actor", out var xa) ? Guid.Parse(xa.ToString()) : User;
            using var _ = scope.Enter(company, user);
            ctx.Actor = new AuditActor("user", user.ToString(), "Tester");
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            if (req.Headers.ContainsKey("x-barrier")) await barrier.ArriveAsync();
            var request = $"{req.Method} {req.Path}{req.QueryString}";   // the concrete request, not a template
            var key = Idempotency.ParseKey(req.Headers["Idempotency-Key"].FirstOrDefault());
            var cmd = JsonSerializer.Deserialize<Cmd>(body, JsonSerializerOptions.Web)!;
            var res = await idem.RunAsync(key, request, Idempotency.Hash(request, Encoding.UTF8.GetBytes(body)), async ct =>
            {
                await audit.RecordAsync("test.effect", "t:1", null, new { cmd.Data }, ct);
                if (cmd.HoldMs > 0) await Task.Delay(cmd.HoldMs, ct);
                if (cmd.Fail) throw new TeasException("record.invalid");
                if (cmd.Status == 204) return new StoredResponse(204, "");
                if (cmd.Status != 201) return new StoredResponse(cmd.Status, "{}");   // a non-2xx result: the runner must refuse it
                await Task.Delay(400, ct);   // the twin is blocked on the claim meanwhile
                return new StoredResponse(201, JsonSerializer.Serialize(new { ok = true, effect = Guid.NewGuid() }));
            });
            return Results.Text(res.Body, "application/json", statusCode: res.Status);
        });

        // Versioned update of companies.name inside one transaction (+ one audit row).
        e.MapPut("/internal/v1/_t/company/{company:guid}", async (Guid company, Upd body, HttpRequest req, TeasDbContext db, TenantScope scope, IAudit audit, AuditContext ctx, AsyncBarrier barrier) =>
        {
            // x-scope-company: act as another company than the row's (RLS must make the row not exist)
            using var _ = scope.Enter(req.Headers.TryGetValue("x-scope-company", out var sc) ? Guid.Parse(sc.ToString()) : company, User);
            ctx.Actor = new AuditActor("user", User.ToString(), "Tester");
            await using var tx = await db.Database.BeginTransactionAsync();
            if (req.Headers.ContainsKey("x-barrier")) await barrier.ArriveAsync();
            var v = await VersionedUpdate.UpdateAsync(db, "companies", "name = @name", company, body.Version, new Npgsql.NpgsqlParameter("name", body.Name));
            await audit.RecordAsync("test.rename", company.ToString(), null, new { body.Name });
            await tx.CommitAsync();
            return Results.Json(new { version = v });
        });

        // A refused 403: the 'rejected' row is written in its own short transaction, then the request fails.
        e.MapPost("/internal/v1/_t/forbidden/{company:guid}", async (Guid company, TenantScope scope, IAudit audit, AuditContext ctx) =>
        {
            using var _ = scope.Enter(company, User);
            ctx.Actor = new AuditActor("user", User.ToString(), "Tester");
            await audit.RecordRejectedAsync("test.forbidden", "t:1");
            throw new TeasException("auth.forbidden");
        });
    }

    public static WebApplicationFactory<Program> Create(DbClone db) => new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
    {
        b.UseEnvironment("Staging");
        b.UseSetting("ConnectionStrings:Teas", db.AppCs);
        b.UseSetting("TEAS_BFF_SECRET", "0123456789abcdef0123456789abcdef");
        b.ConfigureServices(s =>
        {
            s.AddSingleton(new AsyncBarrier(2));
            s.AddSingleton<IStartupFilter>(new TestRoutes());
        });
    });

    public static async Task<Guid> NewCompanyAsync(DbClone db)
    {
        var id = Guid.NewGuid();
        await db.AsAppAsync(new ScopeState(id, null, false), async (c, t) => { await TenantRowFactory.Inserts["companies"](c, t, id); return 0; }, commit: true);
        return id;
    }

    /// <summary>Row count of a table, read under system scope (reads everything, writes nothing).</summary>
    public static Task<long> CountAsync(DbClone db, string table, string? where = null) =>
        db.AsAppAsync(new ScopeState(null, null, true), async (c, t) =>
        {
            await using var cmd = new Npgsql.NpgsqlCommand($"SELECT count(*) FROM teas.{table}" + (where is null ? "" : " WHERE " + where), c, t);
            return (long)(await cmd.ExecuteScalarAsync())!;
        });
}
