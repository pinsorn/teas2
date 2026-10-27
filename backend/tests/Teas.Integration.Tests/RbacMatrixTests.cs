using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Teas.Api.Routing;
using Teas.App.Platform;
using Teas.Domain.Platform;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

/// <summary>The frozen TS contract, parsed: the catalog and the role templates are compared with it, never with themselves.</summary>
static class FrozenContract
{
    static readonly string Text = File.ReadAllText(Path.Combine(Root(), "frontend", "src", "contract", "platform.ts"));

    public static string Root()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "frontend", "src", "contract", "platform.ts"))) d = d.Parent;
        return d?.FullName ?? throw new InvalidOperationException("frontend/src/contract/platform.ts not found above " + AppContext.BaseDirectory);
    }

    static List<string> Quoted(string from)
    {
        var i = Text.IndexOf(from, StringComparison.Ordinal);
        Assert.True(i >= 0, from);
        var start = from.EndsWith('[') ? i : Text.IndexOf("= [", i, StringComparison.Ordinal);   // skip the `string[]` in a type annotation
        return Regex.Matches(Text[start..Text.IndexOf(']', start + 1)], "'([^']+)'").Select(m => m.Groups[1].Value).ToList();
    }

    public static List<string> Codes { get; } = Quoted("export const PERMISSION_CODES");
    public static List<string> Role(string name) => Quoted("  " + name + ": [");
    public static HashSet<string> Never { get; } = [.. Quoted("const NEVER_FOR_AGENT")];
    public static Regex DocVerbs { get; } = new(Regex.Match(Text, @"agentForbidden = .*?/(\^.+?)/\.test").Groups[1].Value.Replace("$", @"\z"));
}

// SP3 4.5 (P5): the catalog and the templates are the frozen contract; the sync keeps the tables equal to them.
public sealed class PermissionCatalogTests
{
    [Fact]
    public void TheCatalogIsTheFrozenCodeList()
    {
        Assert.True(FrozenContract.Codes.Count > 100);
        Assert.Equal(FrozenContract.Codes, PermissionCatalog.Codes);
        Assert.Equal(PermissionCatalog.Codes.Count, PermissionCatalog.Codes.Distinct().Count());
    }

    [Theory]
    [InlineData("operator")]
    [InlineData("accountant")]
    [InlineData("admin")]
    public void ASystemRoleTemplateIsTheFrozenOne(string role) =>
        Assert.Equal(FrozenContract.Role(role).Order(), PermissionCatalog.SystemRoles[role].Order());

    [Fact]
    public void AgentForbiddenMatchesTheTsRuleOnEveryCode()
    {
        Assert.Equal(10, FrozenContract.Never.Count);
        foreach (var code in FrozenContract.Codes.Concat(["doc.XX.approve", "doc.xx.approve", "doc.QT.read", "doc.QT.approve.x", "nope"]))
            Assert.True((FrozenContract.Never.Contains(code) || FrozenContract.DocVerbs.IsMatch(code)) == AgentRules.AgentForbidden(code), code);
        Assert.Contains(PermissionCatalog.All, p => p.AgentForbidden);
    }

    [Fact]
    public void AnAgentHoldsItsScopesWithinItsOwnersRightsMinusTheForbiddenCodes()
    {
        var owner = new HashSet<string> { "party.read", "users.manage", "doc.IV.approve", "doc.IV.issue" };
        Assert.True(AgentRules.AgentRights(["party.read", "users.manage", "doc.IV.approve", "doc.IV.issue", "item.read"], owner).SetEquals(["party.read", "doc.IV.issue"]));
    }

    [Fact]
    public async Task TheExportedArtifactIsTheCatalog()
    {
        var json = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(FrozenContract.Root(), "backend", "artifacts", "permissions.json"))).RootElement;
        Assert.Equal(PermissionCatalog.Codes, json.GetProperty("permissions").EnumerateArray().Select(p => p.GetProperty("code").GetString()!));
        Assert.All(json.GetProperty("permissions").EnumerateArray(), p => Assert.Equal(AgentRules.AgentForbidden(p.GetProperty("code").GetString()!), p.GetProperty("agentForbidden").GetBoolean()));
        foreach (var role in PermissionCatalog.SystemRoles.Keys)
            Assert.Equal(FrozenContract.Role(role).Order(), json.GetProperty("roles").GetProperty(role).EnumerateArray().Select(c => c.GetString()!).Order());
    }

}

// The migrator's catalog sync, against a migrated clone.
public sealed class CatalogSyncTests : IAsyncLifetime
{
    DbClone _db = null!;
    public async Task InitializeAsync() => _db = await TestDb.CloneAsync();
    public async Task DisposeAsync() => await _db.DisposeAsync();

    async Task<long> CountAsync(string sql)
    {
        await using var c = await _db.OpenMigratorAsync();
        await using var cmd = new NpgsqlCommand(sql, c);
        return (long)(await cmd.ExecuteScalarAsync())!;
    }

    long TemplateRows => PermissionCatalog.SystemRoles.Sum(r => r.Value.Count);

    [Fact]
    public async Task TheSyncIsIdempotent()
    {
        Assert.Equal(PermissionCatalog.Codes.Count, await CountAsync("SELECT count(*) FROM teas.permissions"));   // the harness migrate already synced once
        var first = await CatalogSync.SyncAsync(_db.MigratorCs);
        var second = await CatalogSync.SyncAsync(_db.MigratorCs);
        Assert.Equal(first, second);
        Assert.Equal((PermissionCatalog.Codes.Count, (int)TemplateRows), second);
        Assert.Equal(PermissionCatalog.Codes.Count, await CountAsync("SELECT count(*) FROM teas.permissions"));
        Assert.Equal(TemplateRows, await CountAsync("SELECT count(*) FROM teas.role_templates"));
        Assert.Equal(PermissionCatalog.All.Count(p => p.AgentForbidden), await CountAsync("SELECT count(*) FROM teas.permissions WHERE agent_forbidden"));
    }

    [Fact]
    public async Task ACodeRemovedFromTheCatalogIsDeletedWithItsTemplateRows()
    {
        const string gone = "party.read";   // held by all three templates
        var smaller = PermissionCatalog.All.Where(p => p.Code != gone).ToList();
        var templates = PermissionCatalog.SystemRoles.ToDictionary(r => r.Key, r => (IReadOnlyList<string>)r.Value.Where(c => c != gone).ToList());
        await CatalogSync.SyncAsync(_db.MigratorCs, smaller, templates);
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM teas.permissions WHERE code = '{gone}'"));
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM teas.role_templates WHERE permission_code = '{gone}'"));
        Assert.Equal(smaller.Count, await CountAsync("SELECT count(*) FROM teas.permissions"));
        await CatalogSync.SyncAsync(_db.MigratorCs);   // and putting it back restores it
        Assert.Equal(PermissionCatalog.Codes.Count, await CountAsync("SELECT count(*) FROM teas.permissions"));
    }

    [Fact]
    public async Task TheAppRoleReadsTheCatalogButCannotWriteIt()
    {
        await using var c = await _db.OpenAppAsync();
        await using (var read = new NpgsqlCommand("SELECT count(*) FROM teas.permissions", c))
            Assert.Equal((long)PermissionCatalog.Codes.Count, (long)(await read.ExecuteScalarAsync())!);
        var e = await Assert.ThrowsAsync<PostgresException>(async () =>
        {
            await using var w = new NpgsqlCommand("INSERT INTO teas.permissions (code, area, agent_forbidden) VALUES ('x.y', 'x', false)", c);
            await w.ExecuteNonQueryAsync();
        });
        Assert.Equal("42501", e.SqlState);
    }
}

public sealed class RouteDeclarationTests
{
    [Theory]
    [InlineData("public", null, false, true)]
    [InlineData("session", null, false, true)]
    [InlineData("session", "party.read", false, true)]
    [InlineData("key", "party.read", true, true)]
    [InlineData("public", "party.read", false, false)]    // two declarations
    [InlineData("public", null, true, false)]             // a public agent route
    [InlineData("session", "no.such_code", false, false)] // a permission the catalog does not have
    [InlineData("", null, false, false)]                  // declares nothing
    public void ARouteDeclaresExactlyOneThing(string auth, string? permission, bool agent, bool ok) =>
        Assert.Equal(ok, RouteDeclaration.Problem(new RouteSpec("GET", "/x", auth, permission, agent)) is null);

    [Fact]
    public void NoSpecIsAnUndeclaredRoute() => Assert.NotNull(RouteDeclaration.Problem(null));
}

// The RBAC matrix: every registered contract route that names a permission, x operator / accountant / admin / a custom role.
public sealed class RbacMatrixTests : IAsyncLifetime
{
    DbClone _db = null!;
    Guid _company;
    readonly Dictionary<string, Guid> _users = [];
    Guid _roleId;

    static readonly string[] CustomRights = ["party.read", "doc.IV.issue"];

    public async Task InitializeAsync()
    {
        _db = await TestDb.CloneAsync();
        _company = await PlatformTestHost.NewCompanyAsync(_db);
        _roleId = Guid.NewGuid();
        await Exec("INSERT INTO teas.custom_roles (company_id, id, name, permissions) VALUES (@c, @r, 'Custom', @p)",
            new NpgsqlParameter("r", _roleId), new NpgsqlParameter("p", CustomRights));
        foreach (var (name, role) in new[] { ("operator", "operator"), ("accountant", "accountant"), ("admin", "admin"), ("custom", _roleId.ToString()) })
            _users[name] = await AddMemberAsync(name, role);
    }

    public async Task DisposeAsync() => await _db.DisposeAsync();

    async Task Exec(string sql, params NpgsqlParameter[] ps)
    {
        await _db.AsAppAsync(new ScopeState(_company, null, false), async (c, t) =>
        {
            await using var cmd = new NpgsqlCommand(sql, c, t);
            cmd.Parameters.AddWithValue("c", _company);
            cmd.Parameters.AddRange(ps);
            return await cmd.ExecuteNonQueryAsync();
        }, commit: true);
    }

    async Task<Guid> AddMemberAsync(string name, string role, bool active = true, bool pending = false)
    {
        var user = Guid.NewGuid();
        await using (var c = await _db.OpenAppAsync())
        {
            await using var cmd = new NpgsqlCommand("INSERT INTO teas.users (id, email, display_name) VALUES (@u, @e, @n)", c);
            cmd.Parameters.AddWithValue("u", user);
            cmd.Parameters.AddWithValue("e", $"{name}-{user}@example.test");
            cmd.Parameters.AddWithValue("n", name);
            await cmd.ExecuteNonQueryAsync();
        }
        await Exec("INSERT INTO teas.company_members (company_id, user_id, email, name, role_id, active, invite_pending) VALUES (@c, @u, @e, 'M', @r, @a, @p)",
            new NpgsqlParameter("u", user), new NpgsqlParameter("e", $"{name}-{user}@example.test"), new NpgsqlParameter("r", role), new NpgsqlParameter("a", active), new NpgsqlParameter("p", pending));
        return user;
    }

    HttpRequestMessage Req(HttpMethod method, string path, Guid actor, string body = "{}", string? key = "new", params (string, string)[] headers)
    {
        var r = new HttpRequestMessage(method, path) { Content = method == HttpMethod.Get ? null : new StringContent(body, Encoding.UTF8, "application/json") };
        r.Headers.Add("x-company", _company.ToString());
        r.Headers.Add("x-actor", actor.ToString());
        if (key is not null && method != HttpMethod.Get) r.Headers.Add("Idempotency-Key", key == "new" ? Guid.NewGuid().ToString() : key);
        foreach (var (k, v) in headers) r.Headers.Add(k, v);
        return r;
    }

    static HashSet<string> Held(string who) => who == "custom" ? [.. CustomRights] : [.. FrozenContract.Role(who)];

    [Fact]
    public async Task EveryRouteWithAPermissionIs403IffTheRoleLacksIt_AndTheDetailNamesIt()
    {
        using var f = PlatformTestHost.Create(_db);
        var client = f.CreateClient();
        var routes = f.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(e => RouteDeclaration.IsContractPath(e.RoutePattern.RawText ?? ""))
            .Select(e => (spec: e.Metadata.GetMetadata<RouteSpec>(), path: Regex.Replace(e.RoutePattern.RawText!, @"\{[^}]+\}", Guid.NewGuid().ToString())))
            .Where(r => r.spec?.Permission is not null && !r.spec.Agent).ToList();
        Assert.True(routes.Count >= 5, "routes found: " + routes.Count);

        var failures = new List<string>();
        var refused = 0;
        foreach (var (spec, path) in routes)
            foreach (var (who, user) in _users)
            {
                var res = await client.SendAsync(Req(new HttpMethod(spec!.Method), path, user));
                var expected = Held(who).Contains(spec.Permission!) ? (spec.Method == "GET" ? HttpStatusCode.OK : HttpStatusCode.Created) : HttpStatusCode.Forbidden;
                if (res.StatusCode != expected) failures.Add($"{who} {spec.Method} {path} ({spec.Permission}): {(int)res.StatusCode}, expected {(int)expected}");
                if (expected != HttpStatusCode.Forbidden) continue;
                refused++;
                var problem = JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement;
                if (problem.GetProperty("code").GetString() != "auth.forbidden" || !problem.GetProperty("detail").GetString()!.Contains(spec.Permission!))
                    failures.Add($"{who} {path}: 403 without code auth.forbidden / detail naming {spec.Permission}: {problem}");
            }
        Assert.Empty(failures);
        Assert.True(refused > 0 && refused < routes.Count * _users.Count, "the matrix must contain both outcomes");
        Assert.Equal(refused, await PlatformTestHost.CountAsync(_db, "audit_log", "result = 'rejected'"));   // one rejected row per 403
    }

    [Fact]
    public void EveryRegisteredContractRouteIsDeclaredExactlyOnce()
    {
        using var f = PlatformTestHost.Create(_db);
        var endpoints = f.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(e => RouteDeclaration.IsContractPath(e.RoutePattern.RawText ?? "")).ToList();
        Assert.True(endpoints.Count >= 10, "endpoints found: " + endpoints.Count);
        Assert.Empty(endpoints.Where(e => RouteDeclaration.Problem(e.Metadata.GetMetadata<RouteSpec>()) is not null).Select(e => e.RoutePattern.RawText));
    }

    [Fact]
    public async Task ARefusalComesBeforeTheBodyAndBeforeIdempotency()
    {
        using var f = PlatformTestHost.Create(_db);
        var client = f.CreateClient();
        // operator lacks users.manage: no Idempotency-Key and an unparsable body are still a plain 403, and nothing is claimed
        var res = await client.SendAsync(Req(HttpMethod.Put, "/internal/v1/_t/rbac/users", _users["operator"], "{not json", key: null));
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        Assert.Equal(0, await PlatformTestHost.CountAsync(_db, "idempotency_records"));
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "audit_log", "result = 'rejected'"));
        // the same request as an admin gets past authorization and fails on the body / the key as before
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await client.SendAsync(Req(HttpMethod.Put, "/internal/v1/_t/rbac/users", _users["admin"], "{not json", key: null))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Req(HttpMethod.Put, "/internal/v1/_t/rbac/users", _users["admin"], "{}", key: null))).StatusCode);
    }

    [Fact]
    public async Task AnInactiveOrNotYetAcceptedMemberHoldsNothing_AndANonMemberToo()
    {
        using var f = PlatformTestHost.Create(_db);
        var client = f.CreateClient();
        foreach (var user in new[] { await AddMemberAsync("off", "admin", active: false), await AddMemberAsync("pending", "admin", pending: true), Guid.NewGuid() })
        {
            var res = await client.SendAsync(Req(HttpMethod.Get, "/internal/v1/_t/rbac/read", user));
            Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
            // a route that asks for no permission needs no rights
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Req(HttpMethod.Get, "/internal/v1/_t/rbac/any-member", user))).StatusCode);
        }
    }

    [Fact]
    public async Task ACustomRoleEditTakesEffectAtOnce_AndAMissingRoleHoldsNothing()
    {
        using var f = PlatformTestHost.Create(_db);
        var client = f.CreateClient();
        var read = () => client.SendAsync(Req(HttpMethod.Get, "/internal/v1/_t/rbac/read", _users["custom"]));
        Assert.Equal(HttpStatusCode.OK, (await read()).StatusCode);   // fills the cache
        await Exec("UPDATE teas.custom_roles SET permissions = '{}', version = version + 1 WHERE company_id = @c AND id = @r", new NpgsqlParameter("r", _roleId));
        Assert.Equal(HttpStatusCode.Forbidden, (await read()).StatusCode);
        var orphan = await AddMemberAsync("orphan", Guid.NewGuid().ToString());
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(Req(HttpMethod.Get, "/internal/v1/_t/rbac/read", orphan))).StatusCode);
    }

    [Fact]
    public async Task ADemotedMemberLosesTheRightsAtOnce()
    {
        using var f = PlatformTestHost.Create(_db);
        var client = f.CreateClient();
        var read = () => client.SendAsync(Req(HttpMethod.Get, "/internal/v1/_t/rbac/read", _users["operator"]));
        Assert.Equal(HttpStatusCode.OK, (await read()).StatusCode);
        await Exec("UPDATE teas.company_members SET active = false, version = version + 1 WHERE company_id = @c AND user_id = @u", new NpgsqlParameter("u", _users["operator"]));
        Assert.Equal(HttpStatusCode.Forbidden, (await read()).StatusCode);
    }

    static (string, string)[] AsAgent(Guid owner, string scopes) => [("x-agent-owner", owner.ToString()), ("x-agent-scopes", scopes)];

    [Fact]
    public async Task AnAgentOnARouteWithoutAgentTrueIs403ByActionOrBySetting_WithOneRejectedRow()
    {
        using var f = PlatformTestHost.Create(_db);
        var client = f.CreateClient();
        var agent = Guid.NewGuid();
        async Task<string> CodeOf(string path) =>
            JsonDocument.Parse(await (await client.SendAsync(Req(HttpMethod.Get, path, agent, headers: AsAgent(_users["admin"], "party.read")))).Content.ReadAsStringAsync()).RootElement.GetProperty("code").GetString()!;
        Assert.Equal("agent.forbidden_action", await CodeOf("/internal/v1/_t/rbac/read"));
        Assert.Equal("agent.forbidden_setting", await CodeOf("/internal/v1/settings/_t/probe"));
        Assert.Equal(2, await PlatformTestHost.CountAsync(_db, "audit_log", "result = 'rejected' AND actor_kind = 'agent' AND client = 'api'"));
    }

    [Fact]
    public async Task AnAgentHoldsScopesWithinItsOwnersRightsMinusForbiddenCodes()
    {
        using var f = PlatformTestHost.Create(_db);
        var client = f.CreateClient();
        var agent = Guid.NewGuid();
        async Task<HttpStatusCode> Call(string path, Guid owner, string scopes) =>
            (await client.SendAsync(Req(HttpMethod.Get, path, agent, headers: AsAgent(owner, scopes)))).StatusCode;
        const string read = "/internal/v1/_t/agent/read", admin = "/internal/v1/_t/agent/admin";
        Assert.Equal(HttpStatusCode.OK, await Call(read, _users["operator"], "party.read"));
        Assert.Equal(HttpStatusCode.Forbidden, await Call(read, _users["operator"], "item.read"));           // not in the key's scopes
        Assert.Equal(HttpStatusCode.Forbidden, await Call(read, _users["custom"], "bank.read"));             // scope the owner does not hold
        Assert.Equal(HttpStatusCode.Forbidden, await Call(admin, _users["admin"], "users.manage"));          // owner holds it, an agent never can
        await Exec("UPDATE teas.company_members SET active = false, version = version + 1 WHERE company_id = @c AND user_id = @u", new NpgsqlParameter("u", _users["operator"]));
        Assert.Equal(HttpStatusCode.Forbidden, await Call(read, _users["operator"], "party.read"));          // a deactivated owner takes the key's rights with it
    }
}
