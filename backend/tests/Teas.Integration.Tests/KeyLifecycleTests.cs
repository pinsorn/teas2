using System.Net;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Teas.App;
using Teas.App.Platform;
using Teas.App.Platform.Keys;
using Teas.Domain;
using Teas.Domain.Platform;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// SP3 P9 routes 30-33: list, create, rotate, revoke. Keys are member-owned; connect.manage sees and revokes all; rotate is owner-only (a manager gets 404);
// every write audited once, a refusal writes nothing (a 403 leaves one 'rejected' row); S9: another company's key is a 404.
public sealed class KeyLifecycleTests(AuthFixture fx) : IClassFixture<AuthFixture>
{
    AuthHost H => fx.Host;
    static NpgsqlParameter P(string n, object? v) => P8.P(n, v);

    static void Is(HttpStatusCode status, string? code, Res r) => Assert.True((status, code) == (r.Status, r.Code), $"expected {status} {code}, got {r.Status} {r.Raw}");

    Task<int> Version(string id) => H.ScalarAsync<int>("SELECT version FROM teas.api_keys WHERE id = @i", P("i", Guid.Parse(id)));
    Task<string?> Str(string col, string id) => H.ScalarAsync<string>($"SELECT {col}::text FROM teas.api_keys WHERE id = @i", P("i", Guid.Parse(id)));
    Task<Res> Rotate(string token, string id, int version) => H.Post($"/connect/keys/{id}/rotate", new { version }, token);
    Task<Res> Revoke(string token, string id, int version) => H.Post($"/connect/keys/{id}/revoke", new { version }, token);

    [Fact]
    public async Task ListShowsOwnKeysToAMemberAndEveryKeyToConnectManage_WithScopeChoicesOfTheViewer()
    {
        var (company, _, admin, _) = await P8.AdminAsync(H);
        var (_, op1, _) = await P8.MemberAsync(H, company, "operator");
        var (_, op2, _) = await P8.MemberAsync(H, company, "operator");
        var k1 = await K.CreateAsync(H, op1, "rest", ["party.read"], "op1");
        var k2 = await K.CreateAsync(H, op2, "mcp", ["item.read"], "op2");
        var ka = await K.CreateAsync(H, admin, "rest", ["report.read"], "adm");

        var own = await H.Get("/connect/keys", op1);
        Assert.Equal([k1.Id], K.Ids(own));
        Assert.Equal(new[] { ka.Id, k1.Id, k2.Id }.Order(), K.Ids(await H.Get("/connect/keys", admin)).Order());
        // scopeChoices = the viewer's own rights without the agent-forbidden codes (sorted)
        var choices = own.Json.GetProperty("scopeChoices").EnumerateArray().Select(x => x.GetString()!).ToList();
        Assert.Equal(choices.Order(StringComparer.Ordinal), choices);
        Assert.Equal(FrozenContract.Role("operator").Where(c => !AgentRules.AgentForbidden(c)).Order(StringComparer.Ordinal), choices);
        Assert.DoesNotContain(K.Ids(await H.Get("/connect/keys", op1)), id => id == k2.Id);
        var adminChoices = (await H.Get("/connect/keys", admin)).Json.GetProperty("scopeChoices").EnumerateArray().Select(x => x.GetString()!).ToList();
        Assert.DoesNotContain(adminChoices, AgentRules.AgentForbidden);
        Assert.Contains("report.read", adminChoices);

        // a row: no hash, no secret, the status computed
        var row = own.Json.GetProperty("items")[0];
        Assert.Equal(("active", "party.read"), (row.GetProperty("status").GetString(), row.GetProperty("scopes")[0].GetString()));
        Assert.DoesNotContain(k1.Secret, own.Raw);
        Assert.DoesNotContain("hash", own.Raw, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(3, await P8.AuditAll(H, company));   // the three creates only: a list is not audited
    }

    [Fact]
    public async Task AKeyShowsExpiredInTheListOnceItsDateHasPassed_AndLastUsedAtAfterUse()
    {
        var (company, admin, token, _) = await P8.AdminAsync(H);
        var (id, _) = await K.InsertAsync(H, company, admin.Id, "rest", ["party.read"], BusinessDate.Today(H.Clock).Value.AddDays(-1));
        var row = (await H.Get("/connect/keys", token)).Json.GetProperty("items")[0];
        Assert.Equal(("expired", id.ToString()), (row.GetProperty("status").GetString(), row.GetProperty("id").GetString()));
        Assert.False(row.TryGetProperty("lastUsedAt", out _));
        var live = await K.CreateAsync(H, token);
        await K.WhoAmI(H, live.Secret);
        var used = (await H.Get("/connect/keys", token)).Json.GetProperty("items").EnumerateArray().Single(x => x.GetProperty("id").GetString() == live.Id);
        Assert.True(used.TryGetProperty("lastUsedAt", out var at) && at.GetString()!.Length > 10);
    }

    [Fact]
    public async Task NoCompanyScopeOrNoActiveMembershipIsNotMember_AndLeavesNoAuditRow()
    {
        var (company, _, admin, _) = await P8.AdminAsync(H);
        var (u, off, member) = await P8.MemberAsync(H, company, "operator");
        var loner = await H.CreateUserAsync();
        var lonerToken = await H.LoginAsync(loner);   // a user with no membership at all: no company scope
        await H.ExecAsync("UPDATE teas.company_members SET active = false, version = version + 1 WHERE company_id = @c AND id = @m", new ScopeState(company, null, false), P("c", company), P("m", member));
        foreach (var t in new[] { lonerToken, off })
        {
            Is(HttpStatusCode.Forbidden, "connect.not_member", await H.Get("/connect/keys", t));
            Is(HttpStatusCode.Forbidden, "connect.not_member", await H.Post("/connect/keys", new { name = "k", kind = "rest", scopes = new[] { "party.read" } }, t));
            Is(HttpStatusCode.Forbidden, "connect.not_member", await Rotate(t, Guid.NewGuid().ToString(), 1));
            Is(HttpStatusCode.Forbidden, "connect.not_member", await Revoke(t, Guid.NewGuid().ToString(), 1));
        }
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.api_keys WHERE owner_user_id = @u", P("u", u.Id)));
        Assert.Equal(0, await P8.AuditAll(H, company));   // no company scope, so no row to attribute a refusal to
    }

    [Fact]
    public async Task RotateMakesAnEquivalentKeyAndRevokesTheOldOneInOneTransaction()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var old = await K.CreateAsync(H, token, "mcp", ["party.read", "item.read"], "Assistant", "2027-06-30");
        var r = await Rotate(token, old.Id, 1);
        Assert.Equal(HttpStatusCode.Created, r.Status);
        Assert.Equal("no-store", r.Message.Headers.CacheControl?.ToString());
        var key = r.Json.GetProperty("key");
        var fresh = key.GetProperty("id").GetString()!;
        Assert.NotEqual(old.Id, fresh);
        Assert.NotEqual(old.Secret, r.Str("secret"));
        Assert.Matches(@"^teas_mcp_[0-9a-f]{48}$", r.Str("secret")!);
        Assert.Equal(("Assistant", "mcp", 2, 1, "active", "2027-06-30"), (key.GetProperty("name").GetString(), key.GetProperty("kind").GetString(), key.GetProperty("scopeCount").GetInt32(),
            key.GetProperty("version").GetInt32(), key.GetProperty("status").GetString(), key.GetProperty("expiresAt").GetString()));
        Assert.Equal(old.Id, await Str("rotated_from", fresh));
        Assert.Equal((2, true), (await Version(old.Id), await Str("revoked_at", old.Id) is not null));
        Assert.Equal(K.HashHex(r.Str("secret")!), await Str("encode(secret_hash, 'hex')", fresh));
        // the old secret is dead at once, the new one works
        Is(HttpStatusCode.Unauthorized, "connect.key_revoked", await K.MachineAsync(H, HttpMethod.Post, "/mcp", old.Secret, new { }));
        Assert.Equal(HttpStatusCode.OK, (await K.RpcAsync(H, r.Str("secret"), "ping")).Status);
        // audited as two commands, one each; the trail has no secret
        Assert.Equal((1, 1), (await P8.AuditCount(H, company, "connect.key.rotate"), await P8.AuditCount(H, company, "connect.key.revoke")));
        var trail = await H.ScalarAsync<string>("SELECT string_agg(target || coalesce(before::text, '') || coalesce(after::text, ''), ' ') FROM teas.audit_log WHERE company_id = @c", P("c", company)) ?? "";
        Assert.DoesNotContain(r.Str("secret")!, trail);
        Assert.DoesNotContain(old.Secret, trail);
        Assert.DoesNotContain(K.HashHex(old.Secret), trail);
    }

    [Fact]
    public async Task S17TwoConcurrentRotatesOfOneKeyMakeExactlyOneNewKey()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var made = await K.CreateAsync(H, token);
        var results = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => Rotate(token, made.Id, 1)));
        Assert.Equal([HttpStatusCode.Created, HttpStatusCode.Conflict], results.Select(r => r.Status).Order());
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.api_keys WHERE company_id = @c AND rotated_from = @o", P("c", company), P("o", Guid.Parse(made.Id))));
        Assert.Equal(2, await H.ScalarAsync<long>("SELECT count(*) FROM teas.api_keys WHERE company_id = @c", P("c", company)));   // the loser's insert rolled back with it
        Assert.Equal((1, 1), (await P8.AuditCount(H, company, "connect.key.rotate"), await P8.AuditCount(H, company, "connect.key.revoke")));
    }

    [Fact]
    public async Task S11RotateIsOwnerOnly_TheManagerGetsA404_AndARefusalChangesNothing()
    {
        var (company, _, admin, _) = await P8.AdminAsync(H);
        var (_, op, _) = await P8.MemberAsync(H, company, "operator");
        var made = await K.CreateAsync(H, op, "rest", ["party.read"]);
        Is(HttpStatusCode.NotFound, "record.not_found", await Rotate(admin, made.Id, 1));   // connect.manage does not rotate
        Is(HttpStatusCode.NotFound, "record.not_found", await Rotate(admin, Guid.NewGuid().ToString(), 1));
        Is(HttpStatusCode.NotFound, "record.not_found", await Rotate(admin, "not-a-guid", 1));
        Assert.Equal((1, null), (await Version(made.Id), await Str("revoked_at", made.Id)));
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.api_keys WHERE company_id = @c", P("c", company)));
        Assert.Equal(HttpStatusCode.OK, (await K.WhoAmI(H, made.Secret)).Status);
        Assert.Equal(0, await P8.AuditCount(H, company, "connect.key.rotate"));
        // version: a stale number is a 409 and a missing one a 422
        Is(HttpStatusCode.Conflict, "record.version_conflict", await Rotate(op, made.Id, 7));
        Is(HttpStatusCode.UnprocessableEntity, "record.invalid", await H.Post($"/connect/keys/{made.Id}/rotate", new { }, op));
        Assert.Equal(1, await Version(made.Id));
    }

    [Fact]
    public async Task RotateRefusesARevokedAndAnExpiredKey_With409()
    {
        var (company, admin, token, _) = await P8.AdminAsync(H);
        var revoked = await K.CreateAsync(H, token);
        await Revoke(token, revoked.Id, 1);
        var r = await Rotate(token, revoked.Id, 2);
        Is(HttpStatusCode.Conflict, "connect.key_revoked", r);   // 409 here, 401 when the key is USED
        var (expiredId, _) = await K.InsertAsync(H, company, admin.Id, "rest", ["party.read"], BusinessDate.Today(H.Clock).Value.AddDays(-1));
        Is(HttpStatusCode.Conflict, "connect.key_expired", await Rotate(token, expiredId.ToString(), 1));
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.api_keys WHERE company_id = @c AND rotated_from IS NOT NULL", P("c", company)));
        Assert.Equal(0, await P8.AuditCount(H, company, "connect.key.rotate"));
    }

    [Fact]
    public async Task RotateOfAKeyWhoseOwnerIsInactiveIsRefused_ServiceLevel()
    {
        // Over HTTP this state is unreachable (an inactive owner's session has no company scope: connect.not_member), so the service is driven directly.
        var (company, owner, _, member) = await P8.AdminAsync(H);
        var (id, _) = await K.InsertAsync(H, company, owner.Id, "rest", ["party.read"]);
        await H.ExecAsync("UPDATE teas.company_members SET active = false, version = version + 1 WHERE company_id = @c AND id = @m", new ScopeState(company, null, false), P("c", company), P("m", member));
        using var scope = H.Factory.Services.CreateScope();
        var sp = scope.ServiceProvider;
        sp.GetRequiredService<Teas.App.Platform.Audit.AuditContext>().Actor = new("user", owner.Id.ToString(), "Owner");
        using var _ = sp.GetRequiredService<TenantScope>().Enter(company, owner.Id);
        var e = await Assert.ThrowsAsync<TeasException>(() => sp.GetRequiredService<KeyService>().RotateAsync(owner.Id, id.ToString(), 1));
        Assert.Equal(("connect.owner_inactive", 409), (e.Code, e.Status));
        Assert.Equal(0, await P8.AuditCount(H, company, "connect.key.rotate"));
    }

    [Fact]
    public async Task RevokeByTheOwnerOrByConnectManage_AnAlreadyRevokedKeyIsNotWrittenAgain()
    {
        var (company, _, admin, _) = await P8.AdminAsync(H);
        var (_, op, _) = await P8.MemberAsync(H, company, "operator");
        var (_, other, _) = await P8.MemberAsync(H, company, "operator");
        var mine = await K.CreateAsync(H, op, "rest", ["party.read"]);
        var theirs = await K.CreateAsync(H, other, "rest", ["party.read"]);

        Is(HttpStatusCode.NotFound, "record.not_found", await Revoke(op, theirs.Id, 1));   // a member cannot touch another member's key, nor learn it exists
        Assert.Equal((1, null), (await Version(theirs.Id), await Str("revoked_at", theirs.Id)));
        Is(HttpStatusCode.Conflict, "record.version_conflict", await Revoke(op, mine.Id, 9));
        Assert.Equal(1, await Version(mine.Id));

        var r = await Revoke(op, mine.Id, 1);
        Assert.Equal(HttpStatusCode.OK, r.Status);
        Assert.Equal(("revoked", 2, mine.Id), (r.Str("status"), r.Json.GetProperty("version").GetInt32(), r.Str("id")));
        Assert.True(r.Json.TryGetProperty("revokedAt", out _));
        Is(HttpStatusCode.Unauthorized, "connect.key_revoked", await K.WhoAmI(H, mine.Secret));   // at once
        Assert.Equal(1, await P8.AuditCount(H, company, "connect.key.revoke"));

        // again: the same row back, no write, no audit, no version bump
        var again = await Revoke(op, mine.Id, 2);
        Assert.Equal((HttpStatusCode.OK, "revoked", 2), (again.Status, again.Str("status"), again.Json.GetProperty("version").GetInt32()));
        Assert.Equal((1, 2), (await P8.AuditCount(H, company, "connect.key.revoke"), await Version(mine.Id)));

        // the manager revokes someone else's key
        Assert.Equal(HttpStatusCode.OK, (await Revoke(admin, theirs.Id, 1)).Status);
        Is(HttpStatusCode.Unauthorized, "connect.key_revoked", await K.WhoAmI(H, theirs.Secret));
        Assert.Equal(2, await P8.AuditCount(H, company, "connect.key.revoke"));
        var before = await H.ScalarAsync<string>("SELECT before::text FROM teas.audit_log WHERE company_id = @c AND command = 'connect.key.revoke' AND target = @t", P("c", company), P("t", theirs.Id));
        Assert.Contains("\"revokedAt\"", await H.ScalarAsync<string>("SELECT after::text FROM teas.audit_log WHERE company_id = @c AND command = 'connect.key.revoke' AND target = @t", P("c", company), P("t", theirs.Id)));
        Assert.DoesNotContain("\"revokedAt\"", before);
    }

    [Fact]
    public async Task S9AnotherCompanysKeyIsA404ForEveryRoute_EvenForItsAdmin()
    {
        var (a, _, adminA, _) = await P8.AdminAsync(H);
        var (b, _, adminB, _) = await P8.AdminAsync(H);
        var keyA = await K.CreateAsync(H, adminA);
        var keyB = await K.CreateAsync(H, adminB);
        Is(HttpStatusCode.NotFound, "record.not_found", await Revoke(adminB, keyA.Id, 1));
        Is(HttpStatusCode.NotFound, "record.not_found", await Rotate(adminB, keyA.Id, 1));
        Assert.Equal([keyB.Id], K.Ids(await H.Get("/connect/keys", adminB)));
        Assert.Equal([keyA.Id], K.Ids(await H.Get("/connect/keys", adminA)));
        // the key of A names A on use
        Assert.Equal(a.ToString(), (await K.WhoAmI(H, keyA.Secret)).Str("companyId"));
        Assert.Equal(b.ToString(), (await K.WhoAmI(H, keyB.Secret)).Str("companyId"));
    }

    // The real-session matrix for routes 30-33 (RbacMatrixTests sends every other permission route here): 5 principals x own / other's key.
    [Fact]
    public async Task TheRbacMatrixOfRoutes30To33_FiveRolesTimesOwnAndOthersKeys()
    {
        var (company, _, adminToken, _) = await P8.AdminAsync(H);
        var keysManager = await P8.RoleAsync(H, company, "Keys manager", "connect.manage", "party.read");
        var custom = await P8.RoleAsync(H, company, "Custom", "party.read", "doc.IV.issue");
        var who = new Dictionary<string, (string token, bool manager)> { ["admin"] = (adminToken, true) };
        foreach (var (name, role, manager) in new[] { ("operator", "operator", false), ("accountant", "accountant", false), ("custom", custom.ToString(), false), ("keysManager", keysManager.ToString(), true) })
            who[name] = ((await P8.MemberAsync(H, company, role)).token, manager);

        var failures = new List<string>();
        void Check(bool ok, string what) { if (!ok) failures.Add(what); }
        var own = new Dictionary<string, K.Made>();
        foreach (var (name, (token, manager)) in who)
        {
            // create: every active member, with a scope within their rights; one above their rights is refused
            var made = await H.Post("/connect/keys", new { name = name + "-key", kind = "rest", scopes = new[] { "party.read" } }, token);
            Check(made.Status == HttpStatusCode.Created, $"{name} create: {made.Status} {made.Raw}");
            own[name] = new(made.Json.GetProperty("key").GetProperty("id").GetString()!, made.Str("secret")!, made);
            var over = await H.Post("/connect/keys", new { name = "x", kind = "rest", scopes = new[] { "bank.manage" } }, token);
            var holdsBank = name is "admin" or "accountant";
            Check(holdsBank ? over.Status == HttpStatusCode.Created : (over.Status, over.Code) == (HttpStatusCode.UnprocessableEntity, "connect.scope_exceeds"), $"{name} over-scope: {over.Status} {over.Code}");
        }
        foreach (var (name, (token, manager)) in who)
        {
            var list = await H.Get("/connect/keys", token);
            Check(list.Status == HttpStatusCode.OK, $"{name} list: {list.Status}");
            var ids = K.Ids(list);
            Check(manager ? who.Keys.All(n => ids.Contains(own[n].Id)) : ids.Contains(own[name].Id) && ids.All(i => !own.Where(o => o.Key != name).Any(o => o.Value.Id == i)), $"{name} sees {ids.Length} keys");
        }
        // rotate someone else's key: always a 404 (the manager included); revoke: the owner or connect.manage
        foreach (var (actor, (token, manager)) in who)
            foreach (var owner in who.Keys)
            {
                var victim = actor == owner ? own[owner] : await K.CreateAsync(H, who[owner].token, "rest", ["party.read"], "victim");
                if (actor != owner)
                {
                    var rot = await Rotate(token, victim.Id, 1);
                    Check((rot.Status, rot.Code) == (HttpStatusCode.NotFound, "record.not_found"), $"{actor} rotate {owner}'s: {rot.Status}");
                }
                var rev = await Revoke(token, victim.Id, 1);
                var allowed = actor == owner || manager;
                Check(allowed ? rev.Status == HttpStatusCode.OK && rev.Str("status") == "revoked" : (rev.Status, rev.Code) == (HttpStatusCode.NotFound, "record.not_found"), $"{actor} revoke {owner}'s: {rev.Status} {rev.Code}");
                if (actor == owner)   // the owner's own key is gone now: make a fresh one so the owner can show a successful rotate
                {
                    var fresh = await K.CreateAsync(H, token, "rest", ["party.read"], "to-rotate");
                    var ok = await Rotate(token, fresh.Id, 1);
                    Check(ok.Status == HttpStatusCode.Created && ok.Str("secret") is not null, $"{actor} rotate own: {ok.Status} {ok.Raw}");
                }
            }
        Assert.Empty(failures);
        Assert.Equal(0, await P8.AuditCount(H, company, "connect.key.create", "rejected") + await P8.AuditCount(H, company, "connect.key.revoke", "rejected"));
    }
}
