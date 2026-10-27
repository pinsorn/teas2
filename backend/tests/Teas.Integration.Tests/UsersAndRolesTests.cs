// size-reason: one class holds the whole users / roles / S15 suite on a shared host fixture; splitting it would duplicate the helpers
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Teas.Api.Routing;
using Npgsql;
using Teas.App.Platform;
using Teas.Domain.Platform;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// SP3 P8 routes 20-29: users and roles. S15 (last admin), S2 (the link is on the wire once), S9 (another company is a 404), the rights cache trusts versions,
// links die with their issuer / member, every write audited once, a refusal writes nothing (a 403 leaves one 'rejected' row).
public sealed class UsersAndRolesTests(AuthFixture fx) : IClassFixture<AuthFixture>
{
    AuthHost H => fx.Host;
    static NpgsqlParameter P(string n, object? v) => P8.P(n, v);

    Task<int> Version(Guid company, Guid member) => H.ScalarAsync<int>("SELECT version FROM teas.company_members WHERE company_id = @c AND id = @m", P("c", company), P("m", member));
    Task<int> RoleVersion(Guid company, Guid role) => H.ScalarAsync<int>("SELECT version FROM teas.custom_roles WHERE company_id = @c AND id = @r", P("c", company), P("r", role));

    async Task<Res> SetRole(string token, Guid company, Guid member, string role) =>
        await P8.Put(H, $"/settings/users/{member}", new { version = await Version(company, member), roleId = role }, token);

    async Task<Res> SetActive(string token, Guid company, Guid member, bool active) =>
        await H.Post($"/settings/users/{member}/active", new { active, version = await Version(company, member) }, token);

    Task<Res> Invite(string token, string email, string role = "operator", string name = "ผู้ใช้ใหม่", string? position = null) =>
        H.Post("/settings/users", new { name, email, roleId = role, position }, token);

    static string TokenOf(string link) => link.Split("/link/")[1];

    /// <summary>A company with two signed-in admins.</summary>
    async Task<(Guid company, (TestUser u, string token, Guid member) a, (TestUser u, string token, Guid member) b)> TwoAdminsAsync()
    {
        var (company, admin, token, member) = await P8.AdminAsync(H);
        return (company, (admin, token, member), await P8.MemberAsync(H, company, "admin"));
    }

    static void Is(HttpStatusCode status, string? code, Res r) => Assert.True((status, code) == (r.Status, r.Code), $"expected {status} {code}, got {r.Status} {r.Raw}");

    // ---------------------------------------------------------------- list, invite

    [Fact]
    public async Task OnlyUsersManageListsAndARefusalLeavesOneRejectedRow()
    {
        var (company, _, admin, _) = await P8.AdminAsync(H);
        var (_, op, _) = await P8.MemberAsync(H, company, "operator");
        Is(HttpStatusCode.Forbidden, "auth.forbidden", await H.Get("/settings/users", op));
        Is(HttpStatusCode.Forbidden, "auth.forbidden", await H.Get("/settings/roles", op));
        Is(HttpStatusCode.Forbidden, "auth.forbidden", await H.Post("/settings/users", new { name = "x", email = "x@example.test", roleId = "admin" }, op));
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND result = 'rejected' AND command = 'user.invite'", P("c", company)));

        var list = await H.Get("/settings/users", admin);
        Assert.Equal(HttpStatusCode.OK, list.Status);
        var items = list.Json.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(2, items.Count);
        var row = items[0];
        foreach (var f in new[] { "id", "companyId", "name", "email", "roleId", "roleName", "active", "version", "invitePending" })
            Assert.True(row.TryGetProperty(f, out _), f);
        Assert.False(row.TryGetProperty("link", out _));
        Assert.False(row.TryGetProperty("userId", out _));   // internal, never on the wire
        Assert.False(row.TryGetProperty("signatureDataUrl", out _));
    }

    [Fact]
    public async Task AnInviteMakesAPendingMemberAndTheResponseIsTheOnlyPlaceTheLinkAppears()
    {
        var (company, _, token, _) = await P8.AdminAsync(H, "บริษัท เชิญ จำกัด");
        var email = $"new-{Guid.NewGuid():N}@example.test";
        var r = await Invite(token, email.ToUpperInvariant(), "accountant", "สมชาย ใจดี", "นักบัญชี");
        Assert.Equal(HttpStatusCode.Created, r.Status);
        Assert.Equal((email, "สมชาย ใจดี", "accountant", "นักบัญชี", true, true, 1), (r.Str("email"), r.Str("name"), r.Str("roleId"), r.Str("roleName"), r.Json.GetProperty("invitePending").GetBoolean(), r.Json.GetProperty("active").GetBoolean(), r.Json.GetProperty("version").GetInt32()));
        var link = r.Str("link")!;
        Assert.StartsWith("http://localhost:3000/link/", link);
        var secret = TokenOf(link);

        // S2: nowhere else
        Assert.DoesNotContain(secret, (await H.Get("/settings/users", token)).Raw);
        Assert.DoesNotContain(secret, await H.ScalarAsync<string>("SELECT string_agg(coalesce(before::text, '') || coalesce(after::text, '') || target, ' ') FROM teas.audit_log WHERE company_id = @c", P("c", company)) ?? "");
        Assert.DoesNotContain(H.Logs.Lines, l => l.Contains(secret));
        Assert.Equal(1, await P8.AuditCount(H, company, "user.invite"));
        Assert.DoesNotContain("link", await P8.AuditJson(H, company, "user.invite", "after") ?? "");

        // the link is the real thing: it shows the invite and a new password joins the company
        var info = await H.Get($"/auth/links/{secret}");
        Assert.Equal(("invite", email, "บริษัท เชิญ จำกัด", false), (info.Str("kind"), info.Str("email"), info.Str("companyName"), info.Json.GetProperty("existingAccount").GetBoolean()));
        Assert.Equal(HttpStatusCode.OK, (await H.Post($"/auth/links/{secret}", new { password = "Brand#New2026x", confirm = "Brand#New2026x" })).Status);
        var login = await H.Post("/auth/login", new { email, password = "Brand#New2026x" });
        var me = await H.Get("/me", login.Token);
        Assert.Equal(company.ToString(), me.Str("activeCompanyId"));
        Assert.Contains("doc.JV.read", me.Json.GetProperty("permissions").EnumerateArray().Select(x => x.GetString()));   // the accountant rights
        Assert.False((await H.Get("/settings/users", token)).Json.GetProperty("items").EnumerateArray().Single(x => x.GetProperty("email").GetString() == email).GetProperty("invitePending").GetBoolean());
    }

    [Fact]
    public async Task AnInviteIsValidatedAndARefusalWritesNothing()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var custom = await P8.RoleAsync(H, company, "ผู้ช่วย", "party.read");
        var other = await H.CreateCompanyAsync("Other");
        var foreign = await P8.RoleAsync(H, other, "ของบริษัทอื่น", "party.read");
        var (accepted, _, _) = await P8.MemberAsync(H, company, "operator", login: false);
        var taken = accepted.Email;   // an ACCEPTED member's email stays refused (a pending one is re-invited)
        Assert.Equal(HttpStatusCode.Created, (await Invite(token, $"c-{Guid.NewGuid():N}@example.test", custom.ToString())).Status);   // a custom role of THIS company is fine
        var before = await P8.AuditAll(H, company);

        foreach (var (field, res) in new[]
        {
            ("name", await Invite(token, "a@example.test", name: " ")),
            ("email", await Invite(token, "not-an-email")),
            ("email", await Invite(token, taken)),
            ("email", await Invite(token, taken.ToUpperInvariant())),
            ("roleId", await Invite(token, "b@example.test", "superuser")),
            ("roleId", await Invite(token, "c@example.test", foreign.ToString())),   // another company's role is not a role here
            ("roleId", await Invite(token, "d@example.test", Guid.NewGuid().ToString())),
        })
        {
            Is(HttpStatusCode.UnprocessableEntity, "record.invalid", res);
            Assert.Contains(field, res.Json.GetProperty("fieldErrors").EnumerateObject().Select(x => x.Name));
        }
        Assert.Equal(before, await P8.AuditAll(H, company));
        Assert.Equal(3, await H.ScalarAsync<long>("SELECT count(*) FROM teas.company_members WHERE company_id = @c", P("c", company)));
    }

    // ---------------------------------------------------------------- update, activate

    [Fact]
    public async Task UpdatingAMemberChangesTheFieldsBumpsTheVersionAuditsWithoutPicturesAndChecksVersionAndCompany()
    {
        var (company, admin, token, _) = await P8.AdminAsync(H);
        var (_, _, member) = await P8.MemberAsync(H, company, "operator", login: false);
        var path = $"/settings/users/{member}";
        var sig = P8.PngUrl(9);

        Is(HttpStatusCode.Conflict, "record.version_conflict", await P8.Put(H, path, new { version = 99, name = "ชื่อใหม่" }, token));
        Assert.Equal("record.invalid", (await P8.Put(H, path, new { version = 1, name = "  " }, token)).Code);
        Assert.Equal("record.invalid", (await P8.Put(H, path, new { version = 1, roleId = "nope" }, token)).Code);
        Assert.Equal("record.invalid", (await P8.Put(H, path, new { version = 1, signatureDataUrl = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }, token)).Code);
        Assert.Equal(0, await P8.AuditCount(H, company, "user.update"));

        var ok = await P8.Put(H, path, new { version = 1, name = "ชื่อใหม่", roleId = "accountant", position = "หัวหน้า", signatureDataUrl = sig }, token);
        Assert.Equal(HttpStatusCode.OK, ok.Status);
        Assert.Equal(("ชื่อใหม่", "accountant", "นักบัญชี", "หัวหน้า", sig, 2), (ok.Str("name"), ok.Str("roleId"), ok.Str("roleName"), ok.Str("position"), ok.Str("signatureDataUrl"), ok.Json.GetProperty("version").GetInt32()));
        Assert.Equal(sig, (await H.Get("/settings/users", token)).Json.GetProperty("items").EnumerateArray().Single(x => x.GetProperty("id").GetString() == member.ToString()).GetProperty("signatureDataUrl").GetString());
        Assert.Equal(1, await P8.AuditCount(H, company, "user.update"));
        var trail = (await P8.AuditJson(H, company, "user.update", "before")) + (await P8.AuditJson(H, company, "user.update", "after"));
        Assert.DoesNotContain("base64", trail);
        Assert.Contains("\"roleId\": \"accountant\"", trail);
        Assert.Contains("\"hasSignature\": true", trail);

        var clear = await P8.Put(H, path, new { version = 2, signatureDataUrl = (string?)null, position = "" }, token);   // null removes; absent keeps (name stays); an empty text clears the position
        Assert.Equal("ชื่อใหม่", clear.Str("name"));
        Assert.False(clear.Json.TryGetProperty("signatureDataUrl", out _));
        Assert.False(clear.Json.TryGetProperty("position", out _));

        // S9: a member of another company is not here
        var (_, other, _, otherMember) = await P8.AdminAsync(H, "Other");
        Is(HttpStatusCode.NotFound, "record.not_found", await P8.Put(H, $"/settings/users/{otherMember}", new { version = 1, name = "x" }, token));
        Is(HttpStatusCode.NotFound, "record.not_found", await H.Post($"/settings/users/{otherMember}/active", new { active = false, version = 1 }, token));
        Is(HttpStatusCode.NotFound, "record.not_found", await P8.Put(H, $"/settings/users/{Guid.NewGuid()}", new { version = 1, name = "x" }, token));
        Is(HttpStatusCode.NotFound, "record.not_found", await P8.Put(H, "/settings/users/not-a-guid", new { version = 1, name = "x" }, token));
        Assert.Equal(1, await Version(await H.ScalarAsync<Guid>("SELECT company_id FROM teas.company_members WHERE id = @m", P("m", otherMember)), otherMember));
    }

    [Fact]
    public async Task DeactivatingAMemberKillsTheirLinksSignsThemOutOfTheCompanyAndIsAuditedOnce()
    {
        var (company, admin, token, _) = await P8.AdminAsync(H);
        var pending = await Invite(token, $"p-{Guid.NewGuid():N}@example.test");
        var secret = TokenOf(pending.Str("link")!);
        var member = Guid.Parse(pending.Str("id")!);
        var (u, userToken, userMember) = await P8.MemberAsync(H, company, "operator");
        var resetLink = TokenOf((await H.Post($"/settings/users/{userMember}/reset-link", null, token)).Str("link")!);

        var off = await SetActive(token, company, member, false);
        Assert.Equal((HttpStatusCode.OK, false, 2), (off.Status, off.Json.GetProperty("active").GetBoolean(), off.Json.GetProperty("version").GetInt32()));
        Assert.Equal("auth.link_invalid", (await H.Get($"/auth/links/{secret}")).Code);
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.user_links WHERE company_id = @c AND member_id = @m AND superseded_at IS NULL AND used_at IS NULL", P("c", company), P("m", member)));
        Assert.Equal(1, await P8.AuditCount(H, company, "user.deactivate"));

        var again = await H.Post($"/settings/users/{member}/active", new { active = false, version = 2 }, token);   // already so: nothing to do, nothing written
        Assert.Equal((HttpStatusCode.OK, 2), (again.Status, again.Json.GetProperty("version").GetInt32()));
        Assert.Equal(1, await P8.AuditCount(H, company, "user.deactivate"));

        // an accepted member: deactivated at once for rights, links and the company scope of their session
        Assert.Equal(HttpStatusCode.OK, (await H.Get("/settings/default-notes", userToken)).Status);
        Assert.Equal(HttpStatusCode.OK, (await SetActive(token, company, userMember, false)).Status);
        Assert.Equal("auth.link_invalid", (await H.Get($"/auth/links/{resetLink}")).Code);
        Assert.Equal(HttpStatusCode.Forbidden, (await H.Get("/settings/default-notes", userToken)).Status);
        var me = await H.Get("/me", userToken);
        Assert.Equal(company.ToString(), me.Str("activeCompanyId"));   // still the company they are in (not /onboarding), with no rights
        Assert.Empty(me.Json.GetProperty("permissions").EnumerateArray());
        var on = await SetActive(token, company, userMember, true);
        Assert.Equal((true, 3), (on.Json.GetProperty("active").GetBoolean(), on.Json.GetProperty("version").GetInt32()));
        Assert.Equal(1, await P8.AuditCount(H, company, "user.activate"));
        Assert.Equal("record.invalid", (await H.Post($"/settings/users/{userMember}/active", new { version = 3 }, token)).Code);   // no `active`: never read as false
        Assert.True(await H.ScalarAsync<bool>("SELECT active FROM teas.company_members WHERE company_id = @c AND id = @m", P("c", company), P("m", userMember)));
    }

    // ---------------------------------------------------------------- S15

    [Fact]
    public async Task S15TheOnlyAdminCannotBeDemotedOrDeactivatedAndAPendingInviteDoesNotCount()
    {
        var (company, admin, token, member) = await P8.AdminAsync(H);
        Is(HttpStatusCode.Conflict, "user.last_admin", await SetRole(token, company, member, "operator"));
        Is(HttpStatusCode.Conflict, "user.last_admin", await SetActive(token, company, member, false));
        Assert.Equal("admin", await H.ScalarAsync<string>("SELECT role_id FROM teas.company_members WHERE id = @m", P("m", member)));

        // a pending admin invite is no administrator yet: it does not unlock anything
        var invite = await Invite(token, $"future-{Guid.NewGuid():N}@example.test", "admin");
        Is(HttpStatusCode.Conflict, "user.last_admin", await SetRole(token, company, member, "operator"));
        Is(HttpStatusCode.Conflict, "user.last_admin", await SetActive(token, company, member, false));
        // once they accept, they count: the other admin may demote the first (not the first themselves)
        var email = invite.Str("email")!;
        await H.Post($"/auth/links/{TokenOf(invite.Str("link")!)}", new { password = "Brand#New2026x", confirm = "Brand#New2026x" });
        var second = (await H.Post("/auth/login", new { email, password = "Brand#New2026x" })).Token!;
        Is(HttpStatusCode.Conflict, "user.last_admin", await SetRole(token, company, member, "operator"));   // self-demotion
        Assert.Equal(HttpStatusCode.OK, (await SetRole(second, company, member, "operator")).Status);
        Assert.Equal(0, await P8.AuditCount(H, company, "user.last_admin"));
        Assert.Equal(1, await P8.AuditCount(H, company, "user.update"));   // only the one that succeeded; 409s write no audit row
        // and now the new one is the last
        Is(HttpStatusCode.Conflict, "user.last_admin", await SetActive(second, company, Guid.Parse(invite.Str("id")!), false));
    }

    [Fact]
    public async Task S15NobodyDemotesOrDeactivatesThemselvesOutOfUsersManageEvenWithAnotherAdmin()
    {
        var (company, a, b) = await TwoAdminsAsync();
        Is(HttpStatusCode.Conflict, "user.last_admin", await SetRole(a.token, company, a.member, "accountant"));
        Is(HttpStatusCode.Conflict, "user.last_admin", await SetActive(a.token, company, a.member, false));
        var custom = await P8.RoleAsync(H, company, "ผู้จัดการ", "users.manage", "party.read");
        Assert.Equal(HttpStatusCode.OK, (await SetRole(a.token, company, a.member, custom.ToString())).Status);   // still holds users.manage: allowed
        Assert.Equal(HttpStatusCode.OK, (await SetRole(b.token, company, a.member, "operator")).Status);          // the other admin may
        Is(HttpStatusCode.Forbidden, "auth.forbidden", await H.Get("/settings/users", a.token));              // and the demotion is felt on A's very next request
    }

    [Fact]
    public async Task S15ADeactivatedAdminDoesNotCountAsAnotherAdmin()
    {
        var (company, a, b) = await TwoAdminsAsync();
        Assert.Equal(HttpStatusCode.OK, (await SetActive(a.token, company, b.member, false)).Status);
        Is(HttpStatusCode.Conflict, "user.last_admin", await SetRole(a.token, company, a.member, "operator"));
        Is(HttpStatusCode.Conflict, "user.last_admin", await SetActive(a.token, company, a.member, false));
        Assert.Equal(HttpStatusCode.OK, (await SetActive(a.token, company, b.member, true)).Status);
        Assert.Equal(HttpStatusCode.OK, (await SetRole(b.token, company, a.member, "operator")).Status);
    }

    [Fact]
    public async Task S15ARoleEditThatRemovesUsersManageIsRefusedWhenItEmptiesOrDemotesTheAdmins()
    {
        // d1: the only administrator holds the custom role; editing it out is refused (self and last)
        var (company, _, _, _) = await P8.AdminAsync(H);
        var boss = await P8.RoleAsync(H, company, "หัวหน้า", "users.manage", "party.read");
        var (_, bossToken, _) = await P8.MemberAsync(H, company, boss.ToString());
        await H.ExecAsync("UPDATE teas.company_members SET active = false, version = version + 1 WHERE company_id = @c AND role_id = 'admin'", new ScopeState(company, null, false), P("c", company));   // the system admin is gone
        string RolePath() => $"/settings/roles/{boss}";
        async Task<Res> Edit(string token, string[] perms) => await P8.Put(H, RolePath(), new { version = await RoleVersion(company, boss), permissions = perms }, token);

        Is(HttpStatusCode.Conflict, "user.last_admin", await Edit(bossToken, ["party.read"]));
        Assert.Equal(HttpStatusCode.OK, (await Edit(bossToken, ["users.manage", "party.read", "item.read"])).Status);   // keeping users.manage is fine
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.custom_roles WHERE id = @r AND 'users.manage' = ANY(permissions)", P("r", boss)));

        // d2: another administrator (a different role) exists, but the actor holds the role: self-demotion via role edit is refused
        var (_, adminToken, _) = await P8.MemberAsync(H, company, "admin");
        Is(HttpStatusCode.Conflict, "user.last_admin", await Edit(bossToken, ["party.read"]));
        // d3: the actor is the other administrator: allowed, the role's holders just lose the right
        Assert.Equal(HttpStatusCode.OK, (await Edit(adminToken, ["party.read"])).Status);
        Is(HttpStatusCode.Forbidden, "auth.forbidden", await H.Get("/settings/users", bossToken));
        Assert.Equal(HttpStatusCode.OK, (await H.Get("/settings/users", adminToken)).Status);
        // d4: two holders and no other administrator
        var boss2 = await P8.RoleAsync(H, company, "ทีมหัวหน้า", "users.manage");
        await H.ExecAsync("UPDATE teas.company_members SET active = false, version = version + 1 WHERE company_id = @c AND role_id = 'admin'", new ScopeState(company, null, false), P("c", company));
        var (_, t1, _) = await P8.MemberAsync(H, company, boss2.ToString());
        await P8.MemberAsync(H, company, boss2.ToString(), login: false);
        var r = await P8.Put(H, $"/settings/roles/{boss2}", new { version = 1, permissions = Array.Empty<string>() }, t1);
        Is(HttpStatusCode.Conflict, "user.last_admin", r);
        Assert.Equal(1, await RoleVersion(company, boss2));
    }

    [Fact]
    public async Task S15TwoAdminsDemotingEachOtherAtOnceNeverLeaveTheCompanyWithoutAnAdmin()
    {
        for (var i = 0; i < 3; i++)
        {
            var (company, a, b) = await TwoAdminsAsync();
            var va = await Version(company, a.member);
            var vb = await Version(company, b.member);
            var results = await Task.WhenAll(
                P8.Put(H, $"/settings/users/{b.member}", new { version = vb, roleId = "operator" }, a.token),
                P8.Put(H, $"/settings/users/{a.member}", new { version = va, roleId = "operator" }, b.token));
            Assert.Equal(1, results.Count(r => r.Status == HttpStatusCode.OK));
            Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.company_members WHERE company_id = @c AND role_id = 'admin' AND active AND NOT invite_pending", P("c", company)));
        }
    }

    // ---------------------------------------------------------------- rights cache, links, issuer

    [Fact]
    public async Task AChangeOfRoleIsFeltOnTheVeryNextRequestOfThatMember()
    {
        var (company, admin, token, _) = await P8.AdminAsync(H);
        var role = await P8.RoleAsync(H, company, "จัดการผู้ใช้", "users.manage");
        var (_, userToken, member) = await P8.MemberAsync(H, company, role.ToString());
        Assert.Equal(HttpStatusCode.OK, (await H.Get("/settings/users", userToken)).Status);   // the rights are now cached

        Assert.Equal(HttpStatusCode.OK, (await SetRole(token, company, member, "operator")).Status);   // member.version bumps
        Is(HttpStatusCode.Forbidden, "auth.forbidden", await H.Get("/settings/users", userToken));
        Assert.Equal(HttpStatusCode.OK, (await SetRole(token, company, member, role.ToString())).Status);
        Assert.Equal(HttpStatusCode.OK, (await H.Get("/settings/users", userToken)).Status);

        // a role edit: role.version bumps for every holder
        var edit = await P8.Put(H, $"/settings/roles/{role}", new { version = await RoleVersion(company, role), permissions = new[] { "party.read" } }, token);
        Assert.Equal(HttpStatusCode.OK, edit.Status);
        Is(HttpStatusCode.Forbidden, "auth.forbidden", await H.Get("/settings/users", userToken));
        // deactivation
        await P8.Put(H, $"/settings/roles/{role}", new { version = await RoleVersion(company, role), permissions = new[] { "users.manage" } }, token);
        Assert.Equal(HttpStatusCode.OK, (await H.Get("/settings/users", userToken)).Status);
        await SetActive(token, company, member, false);
        Assert.Equal(HttpStatusCode.Forbidden, (await H.Get("/settings/users", userToken)).Status);
    }

    [Fact]
    public async Task ADemotedOrDeactivatedIssuerKillsTheInviteLinksTheyIssued()
    {
        var (company, a, b) = await TwoAdminsAsync();
        var inviteA = TokenOf((await Invite(a.token, $"x-{Guid.NewGuid():N}@example.test")).Str("link")!);
        var inviteB = TokenOf((await Invite(b.token, $"y-{Guid.NewGuid():N}@example.test")).Str("link")!);
        Assert.Equal(HttpStatusCode.OK, (await H.Get($"/auth/links/{inviteA}")).Status);

        Assert.Equal(HttpStatusCode.OK, (await SetRole(b.token, company, a.member, "operator")).Status);   // A is demoted
        Is(HttpStatusCode.NotFound, "auth.link_invalid", await H.Get($"/auth/links/{inviteA}"));
        Is(HttpStatusCode.NotFound, "auth.link_invalid", await H.Post($"/auth/links/{inviteA}", new { password = "Brand#New2026x", confirm = "Brand#New2026x" }));
        Assert.Equal(HttpStatusCode.OK, (await H.Get($"/auth/links/{inviteB}")).Status);   // the other issuer's link is untouched

        Assert.Equal(HttpStatusCode.OK, (await SetRole(b.token, company, a.member, "admin")).Status);   // restored: the rights are checked NOW, so the link lives again
        Assert.Equal(HttpStatusCode.OK, (await H.Get($"/auth/links/{inviteA}")).Status);
        Assert.Equal(HttpStatusCode.OK, (await SetActive(b.token, company, a.member, false)).Status);
        Is(HttpStatusCode.NotFound, "auth.link_invalid", await H.Get($"/auth/links/{inviteA}"));
    }

    // ---------------------------------------------------------------- reset-link, totp-reset

    [Fact]
    public async Task AResetLinkIsIssuedForAnActiveAcceptedMemberOnceAndSupersedesTheOlderOne()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var (user, userToken, member) = await P8.MemberAsync(H, company, "operator");
        var first = await H.Post($"/settings/users/{member}/reset-link", null, token);
        Assert.Equal(HttpStatusCode.OK, first.Status);
        var one = TokenOf(first.Str("link")!);
        Assert.Equal(("reset", user.Email), ((await H.Get($"/auth/links/{one}")).Str("kind"), (await H.Get($"/auth/links/{one}")).Str("email")));
        var two = TokenOf((await H.Post($"/settings/users/{member}/reset-link", null, token)).Str("link")!);
        Is(HttpStatusCode.NotFound, "auth.link_invalid", await H.Get($"/auth/links/{one}"));

        // S2: only in its response; the audit says a link was issued, not which
        Assert.DoesNotContain(two, (await H.Get("/settings/users", token)).Raw);
        Assert.DoesNotContain(two, await H.ScalarAsync<string>("SELECT string_agg(coalesce(before::text, '') || coalesce(after::text, ''), ' ') FROM teas.audit_log WHERE company_id = @c", P("c", company)) ?? "");
        Assert.DoesNotContain(H.Logs.Lines, l => l.Contains(two));
        Assert.Equal(2, await P8.AuditCount(H, company, "user.reset_link"));

        // using it sets the password and ends the member's sessions (P7), then the member signs in with the new one
        Assert.Equal(HttpStatusCode.OK, (await H.Post($"/auth/links/{two}", new { password = "Reset#Pass2026x", confirm = "Reset#Pass2026x" })).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await H.Get("/me", userToken)).Status);
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/login", new { email = user.Email, password = "Reset#Pass2026x" })).Status);
    }

    [Fact]
    public async Task AResetLinkIsRefusedForAnInactiveOrPendingOrUnknownMember()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var (_, _, member) = await P8.MemberAsync(H, company, "operator", login: false);
        await SetActive(token, company, member, false);
        Is(HttpStatusCode.Conflict, "user.inactive", await H.Post($"/settings/users/{member}/reset-link", null, token));
        var pending = await Invite(token, $"p-{Guid.NewGuid():N}@example.test");
        Is(HttpStatusCode.Conflict, "user.invite_pending", await H.Post($"/settings/users/{pending.Str("id")}/reset-link", null, token));
        Is(HttpStatusCode.NotFound, "record.not_found", await H.Post($"/settings/users/{Guid.NewGuid()}/reset-link", null, token));
        Assert.Equal(0, await P8.AuditCount(H, company, "user.reset_link"));
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.user_links WHERE kind = 'reset' AND company_id = @c", P("c", company)));
    }

    [Fact]
    public async Task P0cWholeAccountActionsNeedUsersManageInEveryCompanyOfTheAccount()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var (user, _, member) = await P8.MemberAsync(H, company, "operator", login: false);
        var elsewhere = await H.CreateCompanyAsync("Elsewhere");
        var theirs = await H.AddMemberAsync(elsewhere, user, "operator", active: false);   // a DEACTIVATED membership elsewhere still counts

        async Task Both(HttpStatusCode status, string? code)
        {
            Is(status, code, await H.Post($"/settings/users/{member}/reset-link", null, token));
            Is(status, code, await H.Post($"/settings/users/{member}/totp-reset", new { version = await Version(company, member) }, token));
        }
        var before = await H.ScalarAsync<string>("SELECT totp_secret_enc IS NULL || '/' || version FROM teas.users WHERE id = @u", P("u", user.Id));
        await Both(HttpStatusCode.Forbidden, "user.cross_company");
        Assert.Equal(2, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND result = 'rejected' AND command IN ('user.reset_link', 'user.totp_reset')", P("c", company)));
        Assert.Equal(before, await H.ScalarAsync<string>("SELECT totp_secret_enc IS NULL || '/' || version FROM teas.users WHERE id = @u", P("u", user.Id)));
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.user_links WHERE kind = 'reset' AND user_id = @u", P("u", user.Id)));

        // a pending invite of the account's LOGIN email in a third company counts too
        var third = await H.CreateCompanyAsync("Third");
        await H.AddMemberAsync(third, null, "operator", pending: true, email: user.Email);
        await H.ExecAsync("DELETE FROM teas.company_members WHERE company_id = @c AND id = @m", new ScopeState(elsewhere, null, false), P("c", elsewhere), P("m", theirs));
        await Both(HttpStatusCode.Forbidden, "user.cross_company");

        // the issuer is an administrator of the third company as well: allowed
        var me = await H.ScalarAsync<Guid>("SELECT user_id FROM teas.company_members WHERE company_id = @c AND role_id = 'admin'", P("c", company));
        await H.AddMemberAsync(third, new TestUser(me, "", ""), "admin", email: $"a-{Guid.NewGuid():N}@example.test");
        Assert.Equal(HttpStatusCode.OK, (await H.Post($"/settings/users/{member}/reset-link", null, token)).Status);
        Assert.Equal(HttpStatusCode.OK, (await H.Post($"/settings/users/{member}/totp-reset", new { version = await Version(company, member) }, token)).Status);
    }

    [Fact]
    public async Task TotpResetClearsTheSecondFactorAndTheSessionsOfAnotherMemberOnly()
    {
        var (company, admin, token, adminMember) = await P8.AdminAsync(H);
        var target = await H.CreateUserAsync(totp: true);
        var member = await H.AddMemberAsync(company, target, "operator");
        var targetToken = (await H.Post("/auth/login", new { email = target.Email, password = target.Password })).Token;   // (two-step is on: this gives only a challenge)
        Assert.Null(targetToken);
        var login = await H.Post("/auth/login", new { email = target.Email, password = target.Password });
        var ok = await H.Post("/auth/totp", new { challenge = login.Str("challenge"), recoveryCode = target.RecoveryCodes![0] });
        var session = ok.Token!;
        Assert.Equal(HttpStatusCode.OK, (await H.Get("/auth/profile", session)).Status);

        // not yourself (auth.forbidden, one rejected row), not with an old version
        Is(HttpStatusCode.Forbidden, "auth.forbidden", await H.Post($"/settings/users/{adminMember}/totp-reset", new { version = 1 }, token));
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND result = 'rejected' AND command = 'user.totp_reset'", P("c", company)));
        Is(HttpStatusCode.Conflict, "record.version_conflict", await H.Post($"/settings/users/{member}/totp-reset", new { version = 7 }, token));
        Is(HttpStatusCode.NotFound, "record.not_found", await H.Post($"/settings/users/{Guid.NewGuid()}/totp-reset", new { version = 1 }, token));
        Assert.Equal(0, await P8.AuditCount(H, company, "user.totp_reset"));

        var r = await H.Post($"/settings/users/{member}/totp-reset", new { version = 1 }, token);
        Assert.Equal((HttpStatusCode.OK, 2), (r.Status, r.Json.GetProperty("version").GetInt32()));
        Assert.True(await H.ScalarAsync<bool>("SELECT totp_secret_enc IS NULL AND totp_pending_enc IS NULL FROM teas.users WHERE id = @u", P("u", target.Id)));
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.recovery_codes WHERE user_id = @u", P("u", target.Id)));
        Assert.Equal(HttpStatusCode.Unauthorized, (await H.Get("/auth/profile", session)).Status);   // their sessions ended
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/login", new { email = target.Email, password = target.Password })).Status);   // password only, no challenge
        Assert.Equal(1, await P8.AuditCount(H, company, "user.totp_reset"));
    }

    // ---------------------------------------------------------------- roles

    [Fact]
    public async Task TheRoleListHasTheThreeSystemRolesThenTheCustomOnesWithTheirUse()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var role = await P8.RoleAsync(H, company, "ผู้ช่วย", "party.read", "item.read");
        await P8.MemberAsync(H, company, role.ToString(), login: false);
        var list = await H.Get("/settings/roles", token);
        var items = list.Json.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(["operator", "accountant", "admin", role.ToString()], items.Select(x => x.GetProperty("id").GetString()!).ToArray());
        Assert.Equal(["พนักงานคีย์ข้อมูล", "นักบัญชี", "ผู้ดูแลระบบ", "ผู้ช่วย"], items.Select(x => x.GetProperty("name").GetString()!).ToArray());
        foreach (var sys in items.Take(3))
        {
            Assert.True(sys.GetProperty("system").GetBoolean());
            Assert.True(sys.GetProperty("active").GetBoolean());
            Assert.Equal(1, sys.GetProperty("version").GetInt32());
            Assert.Equal(PermissionCatalog.SystemRoles[sys.GetProperty("id").GetString()!].Order().ToArray(), sys.GetProperty("permissions").EnumerateArray().Select(x => x.GetString()!).Order().ToArray());
        }
        Assert.True(items[2].GetProperty("inUse").GetBoolean());    // the admin
        Assert.False(items[0].GetProperty("inUse").GetBoolean());
        Assert.False(items[3].GetProperty("system").GetBoolean());
        Assert.True(items[3].GetProperty("inUse").GetBoolean());
        Assert.Empty(items[3].GetProperty("approvalTypes").EnumerateArray());   // no approval settings exist until SP4: nothing is "on"
        Assert.Empty(items[3].GetProperty("sodTypes").EnumerateArray());
    }

    [Fact]
    public async Task CreatingUpdatingAndDeletingARoleValidatesVersionsAndAuditsEachSuccessOnce()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        foreach (var (field, body) in new (string?, object)[]
        {
            ("name", new { name = " ", permissions = new[] { "party.read" } }),
            ("name", new { name = "นักบัญชี", permissions = new[] { "party.read" } }),   // a system role's name
            ("permissions", new { name = "x", permissions = new[] { "party.read", "not.a.code" } }),
            (null, new { name = "x" }),   // a missing required member is a binding failure: 422 without field errors
        })
        {
            var bad = await H.Post("/settings/roles", body, token);
            Is(HttpStatusCode.UnprocessableEntity, "record.invalid", bad);
            if (field is not null) Assert.Contains(field, bad.Json.GetProperty("fieldErrors").EnumerateObject().Select(x => x.Name));
        }
        Assert.Equal(0, await P8.AuditAll(H, company));

        var created = await H.Post("/settings/roles", new { name = "ผู้ตรวจสอบ", description = "ดูอย่างเดียว", permissions = new[] { "audit.read", "audit.read", "report.read" } }, token);
        Assert.Equal(HttpStatusCode.Created, created.Status);
        Assert.Equal(("ผู้ตรวจสอบ", "ดูอย่างเดียว", 1, false, false), (created.Str("name"), created.Str("description"), created.Json.GetProperty("version").GetInt32(), created.Json.GetProperty("system").GetBoolean(), created.Json.GetProperty("inUse").GetBoolean()));
        Assert.Equal(["audit.read", "report.read"], created.Json.GetProperty("permissions").EnumerateArray().Select(x => x.GetString()!).Order().ToArray());   // duplicates fold
        var id = created.Str("id")!;
        Is(HttpStatusCode.UnprocessableEntity, "record.invalid", await H.Post("/settings/roles", new { name = "ผู้ตรวจสอบ", permissions = new[] { "audit.read" } }, token));   // the name is taken
        Assert.Equal(1, await P8.AuditCount(H, company, "role.create"));

        Is(HttpStatusCode.Conflict, "record.version_conflict", await P8.Put(H, $"/settings/roles/{id}", new { version = 5, name = "ใหม่" }, token));
        Is(HttpStatusCode.UnprocessableEntity, "record.invalid", await P8.Put(H, $"/settings/roles/{id}", new { version = 1, name = "ผู้ดูแลระบบ" }, token));
        var upd = await P8.Put(H, $"/settings/roles/{id}", new { version = 1, name = "ผู้ตรวจ", description = "", permissions = new[] { "audit.read" } }, token);
        Assert.Equal((HttpStatusCode.OK, "ผู้ตรวจ", 2), (upd.Status, upd.Str("name"), upd.Json.GetProperty("version").GetInt32()));
        Assert.False(upd.Json.TryGetProperty("description", out _));   // "" clears
        var part = await P8.Put(H, $"/settings/roles/{id}", new { version = 2, name = "ผู้ตรวจ 2" }, token);   // absent = unchanged
        Assert.Equal(["audit.read"], part.Json.GetProperty("permissions").EnumerateArray().Select(x => x.GetString()!).ToArray());
        Assert.Equal(2, await P8.AuditCount(H, company, "role.update"));
        Assert.Contains("ผู้ตรวจ 2", await P8.AuditJson(H, company, "role.update", "after"));
        Assert.Contains("\"ผู้ตรวจ\"", await P8.AuditJson(H, company, "role.update", "before"));

        Is(HttpStatusCode.NotFound, "record.not_found", await P8.Put(H, $"/settings/roles/{Guid.NewGuid()}", new { version = 1, name = "x" }, token));
        Is(HttpStatusCode.NotFound, "record.not_found", await P8.Put(H, "/settings/roles/not-a-guid", new { version = 1, name = "x" }, token));
        foreach (var sys in new[] { "operator", "accountant", "admin" })
        {
            Is(HttpStatusCode.Conflict, "role.system_readonly", await P8.Put(H, $"/settings/roles/{sys}", new { version = 1, name = "x" }, token));
            Is(HttpStatusCode.Conflict, "role.system_readonly", await P8.Delete(H, $"/settings/roles/{sys}?version=1", token));
        }

        Is(HttpStatusCode.UnprocessableEntity, "record.invalid", await P8.Delete(H, $"/settings/roles/{id}", token));   // ?version= is required
        Is(HttpStatusCode.Conflict, "record.version_conflict", await P8.Delete(H, $"/settings/roles/{id}?version=1", token));
        var (_, _, member) = await P8.MemberAsync(H, company, id, login: false);
        Is(HttpStatusCode.Conflict, "role.in_use", await P8.Delete(H, $"/settings/roles/{id}?version=3", token));
        await H.ExecAsync("UPDATE teas.company_members SET role_id = 'operator', version = version + 1 WHERE company_id = @c AND id = @m", new ScopeState(company, null, false), P("c", company), P("m", member));
        var del = await P8.Delete(H, $"/settings/roles/{id}?version=3", token);
        Assert.Equal((HttpStatusCode.OK, """{"ok":true}"""), (del.Status, del.Raw));
        Assert.Equal(1, await P8.AuditCount(H, company, "role.delete"));
        Is(HttpStatusCode.NotFound, "record.not_found", await P8.Delete(H, $"/settings/roles/{id}?version=3", token));
        Assert.Equal(1, await P8.AuditCount(H, company, "role.delete"));
    }

    [Fact]
    public async Task EveryPermissionRouteOfP8IsRefusedWith403ForARoleThatLacksTheRightAndLeavesOneRejectedRowEach()
    {
        var routes = H.Factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Select(e => (spec: e.Metadata.GetMetadata<RouteSpec>(), pattern: e.RoutePattern.RawText!))
            .Where(r => r.spec?.Permission is not null && r.pattern.StartsWith("/internal/v1/settings/", StringComparison.Ordinal) && !r.pattern.Contains("/_t/")).ToList();
        Assert.True(routes.Count >= 12, "settings routes with a permission: " + routes.Count);   // company 2, users 6, roles 4

        var (company, _, adminToken, _) = await P8.AdminAsync(H);
        var viewer = await P8.RoleAsync(H, company, "ดูอย่างเดียว", "party.read");
        var who = new (string Name, string Token, IReadOnlySet<string> Held)[]
        {
            ("admin", adminToken, PermissionCatalog.SystemRoles["admin"].ToHashSet()),
            ("operator", (await P8.MemberAsync(H, company, "operator")).token, PermissionCatalog.SystemRoles["operator"].ToHashSet()),
            ("accountant", (await P8.MemberAsync(H, company, "accountant")).token, PermissionCatalog.SystemRoles["accountant"].ToHashSet()),
            ("custom", (await P8.MemberAsync(H, company, viewer.ToString())).token, new HashSet<string> { "party.read" }),
        };
        var refused = 0;
        foreach (var (spec, pattern) in routes)
        {
            var path = Regex.Replace(pattern["/internal/v1".Length..].Replace("{section}", "contact"), @"\{[^}]+\}", Guid.NewGuid().ToString());
            foreach (var (name, token, held) in who)
            {
                var res = await H.SendAsync(new HttpMethod(spec!.Method), path, spec.Method == "GET" ? null : new { }, token);
                if (held.Contains(spec.Permission!))
                    Assert.True(res.Status is not (HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized), $"{name} {spec.Method} {path}: {res.Status} {res.Raw}");
                else
                {
                    refused++;
                    Assert.True((res.Status, res.Code) == (HttpStatusCode.Forbidden, "auth.forbidden") && res.Json.GetProperty("detail").GetString()!.Contains(spec.Permission!), $"{name} {spec.Method} {path}: {res.Status} {res.Raw}");
                }
            }
        }
        Assert.Equal(routes.Count * 3, refused);   // admin holds both rights; the other three roles lack both
        Assert.Equal(refused, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND result = 'rejected'", P("c", company)));
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.company_members WHERE company_id = @c AND role_id = 'admin'", P("c", company)));   // the admin's real requests with empty bodies changed nothing
    }

    // ---------------------------------------------------------------- P8a

    [Fact]
    public async Task P8aARoleIdInAnySpellingIsTheSameRoleForTheLastAdminAndInUseChecks()
    {
        var (company, _, _, _) = await P8.AdminAsync(H);
        var boss = await P8.RoleAsync(H, company, "หัวหน้า", "users.manage", "party.read");
        var (_, bossToken, bossMember) = await P8.MemberAsync(H, company, boss.ToString());
        await H.ExecAsync("UPDATE teas.company_members SET active = false, version = version + 1 WHERE company_id = @c AND role_id = 'admin'", new ScopeState(company, null, false), P("c", company));
        foreach (var spelling in new[] { boss.ToString().ToUpperInvariant(), boss.ToString("N"), "{" + boss.ToString().ToUpperInvariant() + "}" })
        {
            // the only administrator holds the role: taking users.manage off it leaves 0 admins, however the id is spelled
            var r = await P8.Put(H, $"/settings/roles/{spelling}", new { version = await RoleVersion(company, boss), permissions = new[] { "party.read" } }, bossToken);
            Is(HttpStatusCode.Conflict, "user.last_admin", r);
            Is(HttpStatusCode.Conflict, "role.in_use", await P8.Delete(H, $"/settings/roles/{spelling}?version={await RoleVersion(company, boss)}", bossToken));
        }
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.custom_roles WHERE id = @r AND 'users.manage' = ANY(permissions)", P("r", boss)));
    }

    [Fact]
    public async Task P8aInvitingAPendingMembersEmailAgainReissuesTheInviteAndAnAcceptedMembersEmailIsStillRefused()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var email = $"lost-{Guid.NewGuid():N}@example.test";
        var first = await Invite(token, email, "operator", "สมชาย");
        var oldSecret = TokenOf(first.Str("link")!);
        var member = first.Str("id");

        var again = await Invite(token, email, "ACCOUNTANT".ToLowerInvariant(), "สมชาย ใหม่", "หัวหน้า");   // the lost link: invite again
        Assert.Equal(HttpStatusCode.Created, again.Status);
        Assert.Equal((member, "สมชาย ใหม่", "accountant", "หัวหน้า", true, 2), (again.Str("id"), again.Str("name"), again.Str("roleId"), again.Str("position"), again.Json.GetProperty("invitePending").GetBoolean(), again.Json.GetProperty("version").GetInt32()));
        var secret = TokenOf(again.Str("link")!);
        Assert.NotEqual(oldSecret, secret);
        Is(HttpStatusCode.NotFound, "auth.link_invalid", await H.Get($"/auth/links/{oldSecret}"));   // the old link is dead
        Assert.Equal(HttpStatusCode.OK, (await H.Get($"/auth/links/{secret}")).Status);
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.company_members WHERE company_id = @c AND email = @e::citext", P("c", company), P("e", email)));
        Assert.Equal(2, await P8.AuditCount(H, company, "user.invite"));
        Is(HttpStatusCode.UnprocessableEntity, "record.invalid", await Invite(token, "x@example.test", "nope"));   // the role passes the same check

        // never accepted AND deactivated: the re-invite reactivates
        await SetActive(token, company, Guid.Parse(member!), false);
        Assert.Equal("auth.link_invalid", (await H.Get($"/auth/links/{secret}")).Code);
        var back = await Invite(token, email);
        Assert.Equal((HttpStatusCode.Created, true), (back.Status, back.Json.GetProperty("active").GetBoolean()));
        Assert.Equal(HttpStatusCode.OK, (await H.Get($"/auth/links/{TokenOf(back.Str("link")!)}")).Status);
        Assert.Equal(HttpStatusCode.OK, (await H.Post($"/auth/links/{TokenOf(back.Str("link")!)}", new { password = "Brand#New2026x", confirm = "Brand#New2026x" })).Status);

        // accepted now: the email is a member's, refused as before
        var r = await Invite(token, email);
        Is(HttpStatusCode.UnprocessableEntity, "record.invalid", r);
        Assert.Contains("email", r.Json.GetProperty("fieldErrors").EnumerateObject().Select(x => x.Name));
    }

    [Fact]
    public async Task ARoleOfAnotherCompanyIsA404()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var (other, _, _, _) = await P8.AdminAsync(H, "Other");
        var foreign = await P8.RoleAsync(H, other, "ของเขา", "party.read");
        Is(HttpStatusCode.NotFound, "record.not_found", await P8.Put(H, $"/settings/roles/{foreign}", new { version = 1, name = "x" }, token));
        Is(HttpStatusCode.NotFound, "record.not_found", await P8.Delete(H, $"/settings/roles/{foreign}?version=1", token));
        Assert.DoesNotContain(foreign.ToString(), (await H.Get("/settings/roles", token)).Raw);
        Assert.Equal(1, await RoleVersion(other, foreign));
    }
}
