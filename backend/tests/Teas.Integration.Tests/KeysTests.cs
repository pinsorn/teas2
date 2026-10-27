using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Teas.App.Platform;
using Teas.App.Platform.Keys;
using Teas.Domain;
using Teas.Domain.Platform;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

/// <summary>Helpers for the P9 test classes: keys made through the real route, rows inserted with a chosen secret, and raw machine requests (Bearer, no cookie, no BFF).</summary>
static class K
{
    static NpgsqlParameter P(string n, object? v) => P8.P(n, v);

    public sealed record Made(string Id, string Secret, Res Res);

    public static async Task<Made> CreateAsync(AuthHost h, string token, string kind = "rest", string[]? scopes = null, string name = "key", string? expiresAt = null)
    {
        var body = new Dictionary<string, object?> { ["name"] = name, ["kind"] = kind, ["scopes"] = scopes ?? ["party.read"] };
        if (expiresAt is not null) body["expiresAt"] = expiresAt;
        var r = await h.Post("/connect/keys", body, token);
        Assert.True(r.Status == HttpStatusCode.Created, $"create key: {r.Status} {r.Raw}");
        return new(r.Json.GetProperty("key").GetProperty("id").GetString()!, r.Str("secret")!, r);
    }

    public static string NewSecret(string kind = "rest") => $"teas_{kind}_{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(24))}";
    public static string HashHex(string secret) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(secret)));

    /// <summary>A key row written straight to the table (a state the create route would refuse, e.g. scopes beyond the owner).</summary>
    public static async Task<(Guid id, string secret)> InsertAsync(AuthHost h, Guid company, Guid owner, string kind, string[] scopes, DateOnly? expiresOn = null, bool revoked = false)
    {
        var secret = NewSecret(kind);
        var id = Guid.NewGuid();
        await h.ExecAsync("INSERT INTO teas.api_keys (company_id, id, name, kind, prefix, secret_hash, owner_user_id, scopes, expires_on, revoked_at) VALUES (@c, @i, 'direct', @k, @p, @h, @o, @s, @e, @r)",
            new ScopeState(company, null, false), P("c", company), P("i", id), P("k", kind), P("p", secret[..14]), P("h", SHA256.HashData(Encoding.UTF8.GetBytes(secret))), P("o", owner),
            P("s", scopes), new NpgsqlParameter("e", NpgsqlTypes.NpgsqlDbType.Date) { Value = (object?)expiresOn ?? DBNull.Value }, P("r", revoked ? new DateTimeOffset(2026, 10, 1, 0, 0, 0, TimeSpan.Zero) : null));
        return (id, secret);
    }

    /// <summary>A request on the machine surface: only Authorization: Bearer (no cookie), through the same client (the BFF header it adds is not read there).</summary>
    public static async Task<Res> MachineAsync(AuthHost h, HttpMethod method, string path, string? bearer, object? body = null, params (string, string)[] headers)
    {
        using var req = new HttpRequestMessage(method, path);
        if (bearer is not null) req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + bearer);
        if (body is not null) req.Content = JsonContent.Create(body);
        foreach (var (k, v) in headers) req.Headers.TryAddWithoutValidation(k, v);
        using var msg = await h.Client.SendAsync(req);
        return new Res(msg, await msg.Content.ReadAsStringAsync());
    }

    public static Task<Res> WhoAmI(AuthHost h, string? bearer, params (string, string)[] headers) => MachineAsync(h, HttpMethod.Get, "/api/v1/whoami", bearer, null, headers);

    public static Task<Res> RpcAsync(AuthHost h, string? bearer, string method, object? pars = null, bool notification = false, int id = 1)
    {
        var body = new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["method"] = method };
        if (!notification) body["id"] = id;
        if (pars is not null) body["params"] = pars;
        return MachineAsync(h, HttpMethod.Post, "/mcp", bearer, body);
    }

    public static string[] Rights(Res whoAmI) => [.. whoAmI.Json.GetProperty("rights").EnumerateArray().Select(x => x.GetString()!).Order()];
    public static string[] Ids(Res list) => [.. list.Json.GetProperty("items").EnumerateArray().Select(x => x.GetProperty("id").GetString()!)];
}

// SP3 S11 / S12 (P9): who may grant what, and what a key holds at the moment it is used.
public sealed class KeyScopeTests(AuthFixture fx) : IClassFixture<AuthFixture>
{
    AuthHost H => fx.Host;
    static NpgsqlParameter P(string n, object? v) => P8.P(n, v);

    Task Demote(Guid company, Guid member, string role) =>
        H.ExecAsync("UPDATE teas.company_members SET role_id = @r, version = version + 1 WHERE company_id = @c AND id = @m", new ScopeState(company, null, false), P("r", role), P("c", company), P("m", member));

    [Fact]
    public async Task CreateShowsTheSecretOnceAndStoresOnlyItsHashAndPrefix()
    {
        var (company, admin, token, _) = await P8.AdminAsync(H);
        var made = await K.CreateAsync(H, token, "rest", ["party.read", "item.read"], "Reports", "2026-12-31");
        var r = made.Res;
        Assert.Matches(@"^teas_rest_[0-9a-f]{48}$", made.Secret);
        var key = r.Json.GetProperty("key");
        Assert.Equal((made.Secret[..14], "rest", "Reports", 2, 1, "active", "2026-12-31"),
            (key.GetProperty("prefix").GetString(), key.GetProperty("kind").GetString(), key.GetProperty("name").GetString(), key.GetProperty("scopeCount").GetInt32(),
             key.GetProperty("version").GetInt32(), key.GetProperty("status").GetString(), key.GetProperty("expiresAt").GetString()));
        Assert.StartsWith("Admin ", key.GetProperty("ownerName").GetString());
        Assert.False(key.TryGetProperty("lastUsedAt", out _) || key.TryGetProperty("revokedAt", out _));
        Assert.False(key.TryGetProperty("hash", out _) || key.TryGetProperty("secretHash", out _));
        Assert.Equal("no-store", r.Message.Headers.CacheControl?.ToString());

        // at rest: only the sha256, 32 bytes; the prefix is display text
        Assert.Equal(K.HashHex(made.Secret), await H.ScalarAsync<string>("SELECT encode(secret_hash, 'hex') FROM teas.api_keys WHERE id = @i", P("i", Guid.Parse(made.Id))));
        Assert.Equal(made.Secret[..14], await H.ScalarAsync<string>("SELECT prefix FROM teas.api_keys WHERE id = @i", P("i", Guid.Parse(made.Id))));
        Assert.Equal(admin.Id, await H.ScalarAsync<Guid>("SELECT owner_user_id FROM teas.api_keys WHERE id = @i", P("i", Guid.Parse(made.Id))));
        Assert.Equal(1, await P8.AuditCount(H, company, "connect.key.create"));
        var trail = await H.ScalarAsync<string>("SELECT string_agg(target || coalesce(before::text, '') || coalesce(after::text, ''), ' ') FROM teas.audit_log WHERE company_id = @c AND command LIKE 'connect.key.%'", P("c", company)) ?? "";
        Assert.DoesNotContain(made.Secret, trail);
        Assert.DoesNotContain(K.HashHex(made.Secret), trail);
        Assert.Contains("Reports", trail);   // the trail names the key
        Assert.DoesNotContain(made.Secret, (await H.Get("/connect/keys", token)).Raw);
    }

    [Fact]
    public async Task CreateIsValidatedAndARefusalWritesNothing()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var yesterday = BusinessDate.Today(H.Clock).Value.AddDays(-1).ToString("yyyy-MM-dd");
        var today = BusinessDate.Today(H.Clock).Value.ToString("yyyy-MM-dd");
        async Task<Res> Try(object body) => await H.Post("/connect/keys", body, token);
        void Invalid(Res r, string field)
        {
            Assert.True(r.Status == HttpStatusCode.UnprocessableEntity && r.Code == "record.invalid", r.Raw);
            Assert.True(r.Json.GetProperty("fieldErrors").TryGetProperty(field, out _), $"{field}: {r.Raw}");
        }
        Invalid(await Try(new { name = "  ", kind = "rest", scopes = new[] { "party.read" } }), "name");
        Invalid(await Try(new { name = new string('x', 61), kind = "rest", scopes = new[] { "party.read" } }), "name");
        var soap = await Try(new { name = "k", kind = "soap", scopes = new[] { "party.read" } });   // an unknown enum value never binds: 422 without a field
        Assert.True(soap.Status == HttpStatusCode.UnprocessableEntity && soap.Code == "record.invalid", soap.Raw);
        var noKind = await Try(new { name = "k", scopes = new[] { "party.read" } });
        Assert.True(noKind.Status == HttpStatusCode.UnprocessableEntity && noKind.Code == "record.invalid", noKind.Raw);
        Invalid(await Try(new { name = "k", kind = "rest", scopes = Array.Empty<string>() }), "scopes");
        Invalid(await Try(new { name = "k", kind = "rest", scopes = new[] { "no.such_code" } }), "scopes");
        Invalid(await Try(new { name = "k", kind = "rest", scopes = new[] { "party.read" }, expiresAt = yesterday }), "expiresAt");
        Invalid(await Try(new { name = "k", kind = "rest", scopes = new[] { "party.read" }, expiresAt = today }), "expiresAt");   // after today, not today
        Invalid(await Try(new { name = "k", kind = "rest", scopes = new[] { "party.read" }, expiresAt = "31/12/2026" }), "expiresAt");
        Assert.Equal(422, (int)(await H.SendAsync(HttpMethod.Post, "/connect/keys", "{not json", token)).Status);
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.api_keys WHERE company_id = @c", P("c", company)));
        Assert.Equal(0, await P8.AuditAll(H, company));
        // duplicate scopes collapse; the key keeps the set
        var ok = await K.CreateAsync(H, token, "mcp", ["party.read", "party.read"]);
        Assert.Equal(1, ok.Res.Json.GetProperty("key").GetProperty("scopeCount").GetInt32());
    }

    [Fact]
    public async Task S11CreateRefusesForbiddenCodesAndCodesBeyondTheOwnersRights()
    {
        var (company, _, admin, _) = await P8.AdminAsync(H);
        var (_, op, _) = await P8.MemberAsync(H, company, "operator");
        async Task<Res> Try(string token, params string[] scopes) => await H.Post("/connect/keys", new { name = "k", kind = "rest", scopes }, token);
        void Is(string code, Res r) { Assert.True(r.Status == HttpStatusCode.UnprocessableEntity && r.Code == code, $"expected {code}: {r.Status} {r.Raw}"); }
        Is("connect.scope_forbidden", await Try(admin, "party.read", "users.manage"));      // the admin holds it; no key may
        Is("connect.scope_forbidden", await Try(admin, "doc.IV.approve"));
        Is("connect.scope_forbidden", await Try(op, "users.manage"));                       // forbidden wins over exceeds
        Is("connect.scope_exceeds", await Try(op, "party.read", "bank.manage"));            // an operator does not hold bank.manage
        Is("connect.scope_exceeds", await Try(op, "report.read"));
        Assert.Equal(HttpStatusCode.Created, (await Try(op, "party.read", "item.read")).Status);
        Assert.Equal(HttpStatusCode.Created, (await Try(admin, "bank.manage", "report.read")).Status);
        Assert.Equal(2, await H.ScalarAsync<long>("SELECT count(*) FROM teas.api_keys WHERE company_id = @c", P("c", company)));
        Assert.Equal(0, await P8.AuditCount(H, company, "connect.key.create", "rejected"));   // a 422 leaves nothing
    }

    [Fact]
    public async Task S12NoKeyCanHoldAnAgentForbiddenCode_TheCatalogFlagAndTheFrozenRuleAgree()
    {
        var (_, _, admin, _) = await P8.AdminAsync(H);
        var forbidden = PermissionCatalog.All.Where(p => p.AgentForbidden).Select(p => p.Code).ToList();
        Assert.Equal(PermissionCatalog.Codes.Where(c => FrozenContract.Never.Contains(c) || FrozenContract.DocVerbs.IsMatch(c)).Order(), forbidden.Order());   // flag == the TS rule
        Assert.True(forbidden.Count > 50);
        var failures = new List<string>();
        foreach (var code in forbidden)
        {
            var r = await H.Post("/connect/keys", new { name = "k", kind = "mcp", scopes = new[] { "party.read", code } }, admin);
            if (r.Status != HttpStatusCode.UnprocessableEntity || r.Code != "connect.scope_forbidden") failures.Add($"{code}: {r.Status} {r.Code}");
        }
        Assert.Empty(failures);
    }

    [Fact]
    public async Task S11AtUseTheKeyHoldsItsScopesWithinTheOwnersCurrentRightsMinusForbiddenCodes()
    {
        var (company, _, _, _) = await P8.AdminAsync(H);
        // a row the create route would refuse: scopes beyond what an operator owner holds, and two forbidden codes
        var (opUser, _, opMember) = await P8.MemberAsync(H, company, "operator");
        var (_, secret) = await K.InsertAsync(H, company, opUser.Id, "rest", ["party.read", "item.read", "bank.manage", "report.read", "users.manage", "doc.IV.approve"]);
        Assert.Equal(["item.read", "party.read"], K.Rights(await K.WhoAmI(H, secret)));   // scopes ∩ operator rights − forbidden

        // the owner promoted: the key gains what its scopes name, on the next request
        await Demote(company, opMember, "accountant");
        Assert.Equal(["bank.manage", "item.read", "party.read", "report.read"], K.Rights(await K.WhoAmI(H, secret)));
        // demoted: loses it on the next request
        await Demote(company, opMember, "operator");
        Assert.Equal(["item.read", "party.read"], K.Rights(await K.WhoAmI(H, secret)));
        // a custom role the owner holds, then edited: the same
        var role = await P8.RoleAsync(H, company, "Narrow", "party.read");
        await Demote(company, opMember, role.ToString());
        Assert.Equal(["party.read"], K.Rights(await K.WhoAmI(H, secret)));
        // deactivated: the key still authenticates (it is not revoked) but holds nothing
        await H.ExecAsync("UPDATE teas.company_members SET active = false, version = version + 1 WHERE company_id = @c AND id = @m", new ScopeState(company, null, false), P("c", company), P("m", opMember));
        var dead = await K.WhoAmI(H, secret);
        Assert.Equal(HttpStatusCode.OK, dead.Status);
        Assert.Empty(K.Rights(dead));
        // a pending-invite owner (never accepted) holds nothing either
        await H.ExecAsync("UPDATE teas.company_members SET active = true, invite_pending = true, version = version + 1 WHERE company_id = @c AND id = @m", new ScopeState(company, null, false), P("c", company), P("m", opMember));
        Assert.Empty(K.Rights(await K.WhoAmI(H, secret)));
    }

    [Fact]
    public async Task AKeyIsOnlyForItsOwnCompanyAndItsRightsComeFromThatCompanysMembership()
    {
        // one user, two companies: a key of company A is judged by the owner's membership in A, not B
        var (a, owner, tokenA, _) = await P8.AdminAsync(H);
        var b = await H.CreateCompanyAsync();
        await H.AddMemberAsync(b, owner, "operator");
        var made = await K.CreateAsync(H, tokenA, "rest", ["party.read", "bank.manage"]);
        var who = await K.WhoAmI(H, made.Secret);
        Assert.Equal((a.ToString(), 2), (who.Str("companyId"), K.Rights(who).Length));
    }

    [Fact]
    public async Task UnknownRevokedAndExpiredKeysAreRefusedWithTheirOwnCode_OnTheDayItExpiresItStillWorks()
    {
        var (company, admin, token, _) = await P8.AdminAsync(H);
        var today = BusinessDate.Today(H.Clock).Value;
        async Task Is(string? bearer, HttpStatusCode status, string code)
        {
            var r = await K.MachineAsync(H, HttpMethod.Get, "/api/v1/whoami", bearer);
            Assert.True(r.Status == status && r.Code == code, $"{bearer?[..Math.Min(bearer.Length, 20)]}: expected {status} {code}, got {r.Status} {r.Raw}");
        }
        // unknown: well-formed but not a key, and the shapes that are not keys at all
        await Is(K.NewSecret(), HttpStatusCode.Unauthorized, "connect.key_invalid");
        await Is("teas_rest_" + new string('a', 47), HttpStatusCode.Unauthorized, "connect.key_invalid");
        await Is("teas_rest_" + new string('A', 48), HttpStatusCode.Unauthorized, "connect.key_invalid");
        await Is("teas_sql_" + new string('a', 48), HttpStatusCode.Unauthorized, "connect.key_invalid");
        await Is("not-a-key", HttpStatusCode.Unauthorized, "connect.key_invalid");
        await Is(new string('x', 5000), HttpStatusCode.Unauthorized, "connect.key_invalid");
        await Is(null, HttpStatusCode.Unauthorized, "connect.key_invalid");   // no Bearer header at all (SP3 8 step 4)
        var basic = await K.MachineAsync(H, HttpMethod.Get, "/api/v1/whoami", null, null, ("Authorization", "Basic dXNlcjpwYXNz"));
        Assert.True((basic.Status, basic.Code) == (HttpStatusCode.Unauthorized, "connect.key_invalid"), basic.Raw);   // another scheme
        // a session cookie is no key
        var cookie = await H.Client.SendAsync(new HttpRequestMessage(HttpMethod.Get, "/api/v1/whoami") { Headers = { { "Cookie", $"{AuthHost.CookieName}={token}" } } });
        Assert.Equal(HttpStatusCode.Unauthorized, cookie.StatusCode);

        var live = await K.CreateAsync(H, token);
        await Is(live.Secret, HttpStatusCode.OK, null!);
        // the last day: expires_on = today still works; yesterday is expired
        var (_, lastDay) = await K.InsertAsync(H, company, admin.Id, "rest", ["party.read"], today);
        await Is(lastDay, HttpStatusCode.OK, null!);
        var (_, gone) = await K.InsertAsync(H, company, admin.Id, "rest", ["party.read"], today.AddDays(-1));
        await Is(gone, HttpStatusCode.Unauthorized, "connect.key_expired");
        // revoked beats expired and live
        var (_, revoked) = await K.InsertAsync(H, company, admin.Id, "rest", ["party.read"], today.AddDays(-1), revoked: true);
        await Is(revoked, HttpStatusCode.Unauthorized, "connect.key_revoked");
        var viaRoute = await K.CreateAsync(H, token);
        Assert.Equal(HttpStatusCode.OK, (await H.Post($"/connect/keys/{viaRoute.Id}/revoke", new { version = 1 }, token)).Status);
        await Is(viaRoute.Secret, HttpStatusCode.Unauthorized, "connect.key_revoked");   // at once
        // a revoked / expired key of the wrong kind says it is dead first (it reveals nothing about kinds)
        var onMcp = await K.MachineAsync(H, HttpMethod.Post, "/mcp", revoked, new { });
        Assert.True(onMcp.Status == HttpStatusCode.Unauthorized && onMcp.Code == "connect.key_revoked", onMcp.Raw);
    }

    [Fact]
    public async Task P9aRotateDropsCopiedScopesThatAreForbiddenOrNotInTheCatalog()
    {
        var (company, owner, token, _) = await P8.AdminAsync(H);
        var (id, _) = await K.InsertAsync(H, company, owner.Id, "rest", ["party.read", "users.manage", "doc.IV.approve", "no.such_code"]);
        var r = await H.Post($"/connect/keys/{id}/rotate", new { version = 1 }, token);
        Assert.Equal(HttpStatusCode.Created, r.Status);
        Assert.Equal(["party.read"], r.Json.GetProperty("key").GetProperty("scopes").EnumerateArray().Select(x => x.GetString()!));
        Assert.Equal(["party.read"], (await H.ScalarAsync<string[]>("SELECT scopes FROM teas.api_keys WHERE id = @i", P("i", Guid.Parse(r.Json.GetProperty("key").GetProperty("id").GetString()!))))!);
    }

    [Fact]
    public void TheKeyServiceIsRegistered() => Assert.NotNull(H.Factory.Services.CreateScope().ServiceProvider.GetService<KeyService>());
}
