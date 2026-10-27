using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Teas.App.Platform;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// S17 (P4): lost update. Two concurrent PUTs with the same version -> exactly one 200 and one 409, on real parallel connections.
public sealed class ConcurrencyTests : IAsyncLifetime
{
    DbClone _db = null!;
    public async Task InitializeAsync() => _db = await TestDb.CloneAsync();
    public async Task DisposeAsync() => await _db.DisposeAsync();

    static HttpRequestMessage Put(Guid company, string name, int version, bool barrier = false)
    {
        var r = new HttpRequestMessage(HttpMethod.Put, $"/internal/v1/_t/company/{company}") { Content = JsonContent.Create(new { name, version }) };
        if (barrier) r.Headers.Add("x-barrier", "1");
        return r;
    }

    static async Task<string> CodeAsync(HttpResponseMessage r) => JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement.GetProperty("code").GetString()!;

    [Fact]
    public async Task S17_TwoParallelUpdatesAtTheSameVersionGiveOneOkAndOneConflict()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        var res = await Task.WhenAll(f.CreateClient().SendAsync(Put(company, "A", 1, barrier: true)), f.CreateClient().SendAsync(Put(company, "B", 1, barrier: true)));
        Assert.Equal([HttpStatusCode.OK, HttpStatusCode.Conflict], res.Select(r => r.StatusCode).Order().ToArray());
        Assert.Equal("record.version_conflict", await CodeAsync(res.Single(r => r.StatusCode == HttpStatusCode.Conflict)));
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "companies", "version = 2"));   // incremented exactly once
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "audit_log", "command = 'test.rename'"));   // the loser's audit row rolled back
    }

    [Fact]
    public async Task ASequentialUpdateBumpsTheVersionAndAStaleOneConflicts()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        var c = f.CreateClient();
        var ok = await c.SendAsync(Put(company, "A", 1));
        Assert.Equal(2, JsonDocument.Parse(await ok.Content.ReadAsStringAsync()).RootElement.GetProperty("version").GetInt32());
        Assert.Equal(HttpStatusCode.Conflict, (await c.SendAsync(Put(company, "B", 1))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(Put(company, "B", 2))).StatusCode);
    }

    [Fact]
    public async Task ARowThatDoesNotExistInTheCompanyIs404NotAConflict()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var other = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        // the scope is `company`, the id is `other`'s row: RLS hides it, so it does not exist for this caller
        var r = new HttpRequestMessage(HttpMethod.Put, $"/internal/v1/_t/company/{other}") { Content = JsonContent.Create(new { name = "x", version = 1 }) };
        r.Headers.Add("x-scope-company", company.ToString());
        var res = await f.CreateClient().SendAsync(r);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("record.not_found", await CodeAsync(res));
    }

    // Review #1: the 0-row probe must run under the UPDATE policy. A member of B scoped in A may SEE B's company row (wider SELECT policy) but not update it.
    [Fact]
    public async Task ARowTheUserCanSeeButNotUpdateIs404NotAConflict()
    {
        var a = await PlatformTestHost.NewCompanyAsync(_db);
        var b = await PlatformTestHost.NewCompanyAsync(_db);
        await _db.AsAppAsync(ScopeState.None, async (c, t) =>
        {
            await using var cmd = new Npgsql.NpgsqlCommand("INSERT INTO teas.users (id, email, display_name) VALUES (@u, 'tester@example.test', 'T')", c, t);
            cmd.Parameters.AddWithValue("u", PlatformTestHost.User);
            return await cmd.ExecuteNonQueryAsync();
        }, commit: true);
        await _db.AsAppAsync(new ScopeState(b, PlatformTestHost.User, false), async (c, t) =>
        {
            await using var cmd = new Npgsql.NpgsqlCommand("INSERT INTO teas.company_members (company_id, user_id, email, name, role_id) VALUES (@c, @u, 'tester@example.test', 'T', 'admin')", c, t);
            cmd.Parameters.AddWithValue("c", b);
            cmd.Parameters.AddWithValue("u", PlatformTestHost.User);
            return await cmd.ExecuteNonQueryAsync();
        }, commit: true);
        using var f = PlatformTestHost.Create(_db);
        var r = new HttpRequestMessage(HttpMethod.Put, $"/internal/v1/_t/company/{b}") { Content = JsonContent.Create(new { name = "x", version = 1 }) };
        r.Headers.Add("x-scope-company", a.ToString());
        var res = await f.CreateClient().SendAsync(r);   // scoped in A, B's row at its right version
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("record.not_found", await CodeAsync(res));
    }
}
