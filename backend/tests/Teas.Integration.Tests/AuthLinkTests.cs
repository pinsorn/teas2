using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Npgsql;
using Teas.App.Platform;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// SP3 4.4 links (Q4) and the operator CLI (Q5): single use (race-safe), supersede, stored expiry, the one 404, issuer re-check on GET and POST,
// an invite never sets the password of an existing user, deactivated members, bootstrap-admin / reset-password / reset-mfa.
public sealed class AuthLinkTests(AuthFixture fx) : IClassFixture<AuthFixture>
{
    AuthHost H => fx.Host;
    const string NewPassword = "Brand#New2026x";
    static NpgsqlParameter P(string n, object? v) => new(n, v ?? DBNull.Value);
    static string Strip(Res r) => Regex.Replace(r.Raw, "\"traceId\":\"[0-9a-f]+\",?", "");

    Task<Res> Info(string token) => H.Get($"/auth/links/{token}");
    Task<Res> Accept(string token, string? session = null, string? password = NewPassword, string? confirm = null) =>
        H.Post($"/auth/links/{token}", new { password, confirm = confirm ?? password }, session);

    async Task<(Guid company, TestUser admin)> CompanyWithAdminAsync()
    {
        var company = await H.CreateCompanyAsync("บริษัท ทดสอบ จำกัด");
        var admin = await H.CreateUserAsync(name: "Admin");
        await H.AddMemberAsync(company, admin, "admin");
        return (company, admin);
    }

    async Task<(Guid member, string email)> PendingAsync(Guid company, string? email = null)
    {
        email ??= $"new-{Guid.NewGuid():N}@example.test";
        return (await H.AddMemberAsync(company, null, "operator", pending: true, email: email, name: "Newcomer"), email);
    }

    Task<string?> HashOf(Guid user) => H.ScalarAsync<string>("SELECT password_hash FROM teas.users WHERE id = @u", P("u", user));

    /// <summary>A fingerprint of everything an invalid link attempt could have written.</summary>
    Task<string?> Snapshot() => H.ScalarAsync<string>("""
        SELECT (SELECT count(*) FROM teas.users) || '/' || (SELECT count(*) FROM teas.auth_events) || '/' || (SELECT count(*) FROM teas.audit_log)
            || '/' || (SELECT count(*) FROM teas.sessions WHERE revoked_at IS NULL) || '/' || (SELECT count(*) FROM teas.auth_failures)
            || '/' || (SELECT count(*) FROM teas.user_links WHERE used_at IS NOT NULL) || '/' || (SELECT count(*) FROM teas.company_members WHERE invite_pending)
            || '/' || (SELECT coalesce(sum(version), 0) FROM teas.users) || '/' || (SELECT coalesce(sum(version), 0) FROM teas.company_members)
        """);

    // ---------------------------------------------------------------- invite, new account

    [Fact]
    public async Task AnInviteForANewAccountShowsItsInfoThenSetsThePasswordOnce()
    {
        var (company, admin) = await CompanyWithAdminAsync();
        var (member, email) = await PendingAsync(company);
        var token = await H.IssueLinkAsync("invite", admin.Id.ToString(), companyId: company, memberId: member);

        var info = await Info(token);
        Assert.Equal(HttpStatusCode.OK, info.Status);
        Assert.Equal("invite", info.Str("kind"));
        Assert.Equal(email, info.Str("email"));
        Assert.Equal("บริษัท ทดสอบ จำกัด", info.Str("companyName"));
        Assert.False(info.Json.GetProperty("existingAccount").GetBoolean());
        Assert.Equal(H.Now.AddDays(7), info.Json.GetProperty("expiresAt").GetDateTimeOffset());
        Assert.DoesNotContain(token, info.Raw);

        // a refused password consumes nothing and writes nothing
        var before = await Snapshot();
        var weak = await Accept(token, password: "weak");
        Assert.Equal((HttpStatusCode.UnprocessableEntity, "auth.password_weak"), (weak.Status, weak.Code));
        Assert.Equal("auth.password_mismatch", (await Accept(token, password: NewPassword, confirm: NewPassword + "x")).Code);
        Assert.Equal(before, await Snapshot());
        Assert.Equal(HttpStatusCode.OK, (await Info(token)).Status);

        var ok = await Accept(token);
        Assert.Equal("""{"status":"ok"}""", ok.Raw);
        var user = await H.QueryAsync("SELECT id, display_name FROM teas.users WHERE email = @e", r => (r.GetGuid(0), r.GetString(1)), P("e", email));
        Assert.Equal("Newcomer", user.Item2);
        Assert.NotNull(await HashOf(user.Item1));
        Assert.DoesNotContain(NewPassword, (await HashOf(user.Item1))!);
        var m = await H.QueryAsync("SELECT user_id, invite_pending, version FROM teas.company_members WHERE company_id = @c AND id = @m", r => (r.GetGuid(0), r.GetBoolean(1), r.GetInt32(2)), P("c", company), P("m", member));
        Assert.Equal((user.Item1, false, 2), m);
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND command = 'user.accept_invite' AND actor_id = @a AND result = 'ok'", P("c", company), P("a", user.Item1.ToString())));
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/login", new { email, password = NewPassword })).Status);

        var again = await Accept(token);
        Assert.Equal((HttpStatusCode.NotFound, "auth.link_invalid"), (again.Status, again.Code));
        Assert.Equal("auth.link_invalid", (await Info(token)).Code);
    }

    [Fact]
    public async Task EveryInvalidLinkIsTheSame404AndWritesNothing()
    {
        var (company, admin) = await CompanyWithAdminAsync();
        var issuer = admin.Id.ToString();
        var tokens = new Dictionary<string, string> { ["unknown"] = "no-such-token-" + Guid.NewGuid().ToString("N") };

        var (m1, _) = await PendingAsync(company);
        tokens["used"] = await H.IssueLinkAsync("invite", issuer, companyId: company, memberId: m1);
        var (m2, _) = await PendingAsync(company);
        tokens["superseded"] = await H.IssueLinkAsync("invite", issuer, companyId: company, memberId: m2);
        await H.IssueLinkAsync("invite", issuer, companyId: company, memberId: m2);
        var (m3, _) = await PendingAsync(company);
        tokens["expired"] = await H.IssueLinkAsync("invite", issuer, companyId: company, memberId: m3);
        var (m4, _) = await PendingAsync(company);
        tokens["inactive member"] = await H.IssueLinkAsync("invite", issuer, companyId: company, memberId: m4);
        await H.ExecAsync("UPDATE teas.company_members SET active = false WHERE company_id = @c AND id = @m", new ScopeState(company, null, false), P("c", company), P("m", m4));
        var (m5, _) = await PendingAsync(company);
        tokens["no issuer"] = await H.IssueLinkAsync("invite", "", companyId: company, memberId: m5);
        var (m6, _) = await PendingAsync(company);
        tokens["issuer not a user"] = await H.IssueLinkAsync("invite", "somebody", companyId: company, memberId: m6);
        var (m7, _) = await PendingAsync(company);
        tokens["already accepted"] = await H.IssueLinkAsync("invite", issuer, companyId: company, memberId: m7);
        await H.ExecAsync("UPDATE teas.company_members SET invite_pending = false WHERE company_id = @c AND id = @m", new ScopeState(company, null, false), P("c", company), P("m", m7));

        Assert.Equal(HttpStatusCode.OK, (await Accept(tokens["used"])).Status);
        await H.ExecGlobalAsync("UPDATE teas.user_links SET expires_at = @t WHERE token_hash = @h", P("t", H.Now.AddMinutes(-1)), P("h", SHA256.HashData(Encoding.UTF8.GetBytes(tokens["expired"]))));

        var before = await Snapshot();
        var bodies = new HashSet<string>();
        foreach (var (why, token) in tokens)
        {
            var g = await Info(token);
            var p = await Accept(token);
            Assert.True(g.Status == HttpStatusCode.NotFound && g.Code == "auth.link_invalid", $"GET {why}: {g.Status} {g.Raw}");
            Assert.True(p.Status == HttpStatusCode.NotFound && p.Code == "auth.link_invalid", $"POST {why}: {p.Status} {p.Raw}");
            bodies.Add(Strip(g));
            bodies.Add(Strip(p));
        }
        Assert.Single(bodies);
        Assert.Equal(before, await Snapshot());
    }

    [Fact]
    public async Task ANewerLinkOfTheSameKindSupersedesTheOlder()
    {
        var (company, admin) = await CompanyWithAdminAsync();
        var (member, _) = await PendingAsync(company);
        var first = await H.IssueLinkAsync("invite", admin.Id.ToString(), companyId: company, memberId: member);
        var second = await H.IssueLinkAsync("invite", admin.Id.ToString(), companyId: company, memberId: member);
        Assert.Equal("auth.link_invalid", (await Info(first)).Code);
        Assert.Equal(HttpStatusCode.OK, (await Info(second)).Status);

        var user = await H.CreateUserAsync();
        var r1 = await H.IssueLinkAsync("reset", "operator", userId: user.Id);
        var r2 = await H.IssueLinkAsync("reset", "operator", userId: user.Id);
        Assert.Equal("auth.link_invalid", (await Accept(r1)).Code);
        Assert.Equal(HttpStatusCode.OK, (await Accept(r2)).Status);
    }

    [Fact]
    public async Task TheExpiryIsStoredAtIssueAndInviteLastsSevenDaysResetOneDay()
    {
        var (company, admin) = await CompanyWithAdminAsync();
        var (member, _) = await PendingAsync(company);
        var invite = await H.IssueLinkAsync("invite", admin.Id.ToString(), companyId: company, memberId: member);
        var user = await H.CreateUserAsync();
        var reset = await H.IssueLinkAsync("reset", "operator", userId: user.Id);
        var issued = H.Now;
        Assert.Equal(issued.AddDays(7), await H.ScalarAsync<DateTimeOffset>("SELECT expires_at FROM teas.user_links WHERE token_hash = @h", P("h", SHA256.HashData(Encoding.UTF8.GetBytes(invite)))));
        Assert.Equal(issued.AddHours(24), await H.ScalarAsync<DateTimeOffset>("SELECT expires_at FROM teas.user_links WHERE token_hash = @h", P("h", SHA256.HashData(Encoding.UTF8.GetBytes(reset)))));

        H.Clock.Advance(TimeSpan.FromHours(24) - TimeSpan.FromSeconds(1));
        Assert.Equal(HttpStatusCode.OK, (await Info(reset)).Status);
        H.Clock.Advance(TimeSpan.FromSeconds(2));
        Assert.Equal("auth.link_invalid", (await Info(reset)).Code);
        Assert.Equal("auth.link_invalid", (await Accept(reset)).Code);
        H.Clock.Advance(TimeSpan.FromDays(6) - TimeSpan.FromSeconds(10));
        Assert.Equal(HttpStatusCode.OK, (await Info(invite)).Status);
        H.Clock.Advance(TimeSpan.FromSeconds(20));
        Assert.Equal("auth.link_invalid", (await Accept(invite)).Code);
    }

    [Fact]
    public async Task TwoConcurrentUsesOfOneLinkGiveExactlyOneSuccess()
    {
        var (company, admin) = await CompanyWithAdminAsync();
        var (member, email) = await PendingAsync(company);
        var token = await H.IssueLinkAsync("invite", admin.Id.ToString(), companyId: company, memberId: member);
        var rs = await Task.WhenAll(Accept(token), Accept(token), Accept(token));
        Assert.Equal(1, rs.Count(r => r.Status == HttpStatusCode.OK));
        Assert.Equal(2, rs.Count(r => r.Code == "auth.link_invalid"));
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.users WHERE email = @e", P("e", email)));

        var user = await H.CreateUserAsync();
        var reset = await H.IssueLinkAsync("reset", "operator", userId: user.Id);
        var rr = await Task.WhenAll(Accept(reset), Accept(reset));
        Assert.Equal(1, rr.Count(r => r.Status == HttpStatusCode.OK));
    }

    // ---------------------------------------------------------------- invite, existing account

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AnInviteNeverSetsThePasswordOfAnExistingUserAndNeedsThatUsersSession(bool hasPassword)
    {
        var (company, admin) = await CompanyWithAdminAsync();
        var existing = await H.CreateUserAsync(password: hasPassword);
        var stranger = await H.CreateUserAsync();
        var (member, _) = await PendingAsync(company, existing.Email.ToUpperInvariant());          // matched by email, whatever the case
        var token = await H.IssueLinkAsync("invite", admin.Id.ToString(), companyId: company, memberId: member);

        var info = await Info(token);
        Assert.True(info.Json.GetProperty("existingAccount").GetBoolean());
        var hash = await HashOf(existing.Id);

        var signedOut = await Accept(token);
        Assert.Equal((HttpStatusCode.NotFound, "auth.link_invalid"), (signedOut.Status, signedOut.Code));                                    // signed out
        var strangerToken = await H.LoginAsync(stranger);
        Assert.Equal("auth.link_invalid", (await Accept(token, strangerToken)).Code);                                                         // somebody else
        Assert.Equal("auth.link_invalid", (await Accept(token, "forged")).Code);
        Assert.Equal(hash, await HashOf(existing.Id));
        Assert.True(await H.ScalarAsync<bool>("SELECT invite_pending FROM teas.company_members WHERE company_id = @c AND id = @m", P("c", company), P("m", member)));

        if (!hasPassword) { Assert.Null(hash); return; }                                           // a never-set password cannot sign in; the user needs a reset link
        var mine = await H.LoginAsync(existing);
        var ok = await Accept(token, mine, password: NewPassword);                                  // a password in the body is never read
        Assert.Equal("""{"status":"ok"}""", ok.Raw);
        Assert.Equal(hash, await HashOf(existing.Id));
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/login", new { email = existing.Email, password = existing.Password })).Status);
        Assert.Equal("auth.invalid_credentials", (await H.Post("/auth/login", new { email = existing.Email, password = NewPassword })).Code);
        var m = await H.QueryAsync("SELECT user_id, invite_pending FROM teas.company_members WHERE company_id = @c AND id = @m", r => (r.GetGuid(0), r.GetBoolean(1)), P("c", company), P("m", member));
        Assert.Equal((existing.Id, false), m);
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND command = 'user.accept_invite' AND actor_id = @a", P("c", company), P("a", existing.Id.ToString())));
        Assert.Equal("auth.link_invalid", (await Accept(token, mine)).Code);
    }

    // ---------------------------------------------------------------- reset links

    [Fact]
    public async Task AResetLinkSetsThePasswordEndsEverySessionAndClearsTheLockout()
    {
        var (company, admin) = await CompanyWithAdminAsync();
        var user = await H.CreateUserAsync();
        var memberId = await H.AddMemberAsync(company, user, "operator");
        var s1 = await H.LoginAsync(user);
        var s2 = await H.LoginAsync(user);
        for (var i = 0; i < 5; i++) await H.Post("/auth/login", new { email = user.Email, password = "Wrong#Password1" });
        Assert.Equal("auth.locked", (await H.Post("/auth/login", new { email = user.Email, password = user.Password })).Code);

        var token = await H.IssueLinkAsync("reset", admin.Id.ToString(), userId: user.Id, companyId: company, memberId: memberId);
        var info = await Info(token);
        Assert.Equal(("reset", user.Email), (info.Str("kind"), info.Str("email")));
        Assert.False(info.Json.GetProperty("existingAccount").GetBoolean());
        Assert.Equal("auth.password_weak", (await Accept(token, password: "weak")).Code);
        Assert.Equal(HttpStatusCode.OK, (await Accept(token)).Status);

        Assert.Equal("auth.unauthenticated", (await H.Get("/auth/profile", s1)).Code);
        Assert.Equal("auth.unauthenticated", (await H.Get("/auth/profile", s2)).Code);
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/login", new { email = user.Email, password = NewPassword })).Status);   // the lock is gone
        Assert.Equal("auth.invalid_credentials", (await H.Post("/auth/login", new { email = user.Email, password = user.Password })).Code);
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND command = 'auth.password.reset' AND actor_id = @a", P("c", company), P("a", user.Id.ToString())));
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.auth_events WHERE kind = 'auth.password.reset' AND user_id = @u", P("u", user.Id)));
        Assert.Equal("auth.link_invalid", (await Accept(token)).Code);
    }

    [Fact]
    public async Task TheIssuerIsCheckedAgainOnGetAndPostWhenTheAccountGainedACompanyTheyDoNotManage()
    {
        var (companyA, issuer) = await CompanyWithAdminAsync();
        var (companyB, otherAdmin) = await CompanyWithAdminAsync();
        var user = await H.CreateUserAsync();
        var memberId = await H.AddMemberAsync(companyA, user, "operator");
        var session = await H.LoginAsync(user);
        var token = await H.IssueLinkAsync("reset", issuer.Id.ToString(), userId: user.Id, companyId: companyA, memberId: memberId);
        Assert.Equal(HttpStatusCode.OK, (await Info(token)).Status);

        var bMember = await H.AddMemberAsync(companyB, user, "operator");                    // the account joins a company the issuer does not manage
        var hash = await HashOf(user.Id);
        var before = await Snapshot();
        var get = await Info(token);
        Assert.Equal((HttpStatusCode.NotFound, "auth.link_invalid"), (get.Status, get.Code));
        var post = await Accept(token);
        Assert.Equal((HttpStatusCode.NotFound, "auth.link_invalid"), (post.Status, post.Code));
        Assert.Equal(hash, await HashOf(user.Id));                                               // the password was not taken over
        Assert.Equal(HttpStatusCode.OK, (await H.Get("/auth/profile", session)).Status);          // and the session is untouched
        Assert.Equal(before, await Snapshot());

        // any state counts: a deactivated membership in B still blocks, a pending invite by the login email too
        await H.ExecAsync("UPDATE teas.company_members SET active = false WHERE company_id = @c AND id = @m", new ScopeState(companyB, null, false), P("c", companyB), P("m", bMember));
        Assert.Equal("auth.link_invalid", (await Accept(token)).Code);
        await H.ExecAsync("DELETE FROM teas.company_members WHERE company_id = @c AND id = @m", new ScopeState(companyB, null, false), P("c", companyB), P("m", bMember));
        var pendingByEmail = await H.AddMemberAsync(companyB, null, "operator", pending: true, email: user.Email.ToUpperInvariant());
        Assert.Equal("auth.link_invalid", (await Info(token)).Code);

        // once the issuer manages B as well the same link works again
        await H.AddMemberAsync(companyB, issuer, "admin");
        Assert.Equal(HttpStatusCode.OK, (await Info(token)).Status);
        Assert.Equal(HttpStatusCode.OK, (await Accept(token)).Status);
        _ = pendingByEmail; _ = otherAdmin;
    }

    [Fact]
    public async Task ADemotedOrDeactivatedIssuerKillsTheirLinks()
    {
        var (company, issuer) = await CompanyWithAdminAsync();
        var issuerMember = await H.ScalarAsync<Guid>("SELECT id FROM teas.company_members WHERE company_id = @c AND user_id = @u", P("c", company), P("u", issuer.Id));
        var (member, _) = await PendingAsync(company);
        var invite = await H.IssueLinkAsync("invite", issuer.Id.ToString(), companyId: company, memberId: member);
        var user = await H.CreateUserAsync();
        var userMember = await H.AddMemberAsync(company, user, "operator");
        var reset = await H.IssueLinkAsync("reset", issuer.Id.ToString(), userId: user.Id, companyId: company, memberId: userMember);
        Assert.Equal(HttpStatusCode.OK, (await Info(invite)).Status);
        Assert.Equal(HttpStatusCode.OK, (await Info(reset)).Status);

        await H.ExecAsync("UPDATE teas.company_members SET role_id = 'operator' WHERE company_id = @c AND id = @m", new ScopeState(company, null, false), P("c", company), P("m", issuerMember));
        Assert.Equal("auth.link_invalid", (await Info(invite)).Code);
        Assert.Equal("auth.link_invalid", (await Accept(reset)).Code);
        await H.ExecAsync("UPDATE teas.company_members SET role_id = 'admin', active = false WHERE company_id = @c AND id = @m", new ScopeState(company, null, false), P("c", company), P("m", issuerMember));
        Assert.Equal("auth.link_invalid", (await Info(invite)).Code);
    }

    [Fact]
    public async Task AResetLinkOfADeactivatedOrNotYetAcceptedMemberIsDead()
    {
        var (company, admin) = await CompanyWithAdminAsync();
        var user = await H.CreateUserAsync();
        var member = await H.AddMemberAsync(company, user, "operator");
        var token = await H.IssueLinkAsync("reset", admin.Id.ToString(), userId: user.Id, companyId: company, memberId: member);
        Assert.Equal(HttpStatusCode.OK, (await Info(token)).Status);
        await H.ExecAsync("UPDATE teas.company_members SET active = false WHERE company_id = @c AND id = @m", new ScopeState(company, null, false), P("c", company), P("m", member));
        var hash = await HashOf(user.Id);
        Assert.Equal("auth.link_invalid", (await Info(token)).Code);
        Assert.Equal("auth.link_invalid", (await Accept(token)).Code);
        Assert.Equal(hash, await HashOf(user.Id));
    }

    [Fact]
    public async Task AnOperatorLinkNeedsNoIssuerCheck()
    {
        var (companyA, _) = await CompanyWithAdminAsync();
        var (companyB, _) = await CompanyWithAdminAsync();
        var user = await H.CreateUserAsync();
        await H.AddMemberAsync(companyA, user, "operator");
        await H.AddMemberAsync(companyB, user, "operator");
        var token = await H.IssueLinkAsync("reset", "operator", userId: user.Id);
        Assert.Equal(HttpStatusCode.OK, (await Accept(token)).Status);
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/login", new { email = user.Email, password = NewPassword })).Status);
    }

    // ---------------------------------------------------------------- CLI

    static async Task<(int exit, string stdout, string stderr)> Cli(AuthHost h, params string[] args)
    {
        var o = new StringWriter();
        var e = new StringWriter();
        var exit = await AuthCli.RunAsync(args, h.Db.MigratorCs, "https://teas.example.test", o, e);
        return (exit, o.ToString(), e.ToString());
    }

    [Fact]
    public async Task BootstrapAdminPrintsOneLinkStoresOnlyItsHashAndTheLinkSetsThePassword()
    {
        var email = $"boss-{Guid.NewGuid():N}@example.test";
        var (exit, stdout, _) = await Cli(H, "bootstrap-admin", "--email", email, "--name", "The Boss");
        Assert.Equal(0, exit);
        var line = Assert.Single(stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries));
        Assert.Matches("^https://teas.example.test/link/[A-Za-z0-9_-]{43}$", line);
        var token = line[(line.LastIndexOf('/') + 1)..];

        var user = await H.QueryAsync("SELECT id, display_name, password_hash FROM teas.users WHERE email = @e", r => (r.GetGuid(0), r.GetString(1), r.IsDBNull(2)), P("e", email));
        Assert.Equal(("The Boss", true), (user.Item2, user.Item3));                                          // no password yet
        var link = await H.QueryAsync("SELECT kind, user_id, created_by, token_hash, used_at, expires_at FROM teas.user_links WHERE user_id = @u",
            r => (r.GetString(0), r.GetGuid(1), r.GetString(2), r.GetFieldValue<byte[]>(3), r.IsDBNull(4)), P("u", user.Item1));
        Assert.Equal(("reset", user.Item1, "operator", true), (link.Item1, link.Item2, link.Item3, link.Item5));
        Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes(token)), link.Item4);
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.auth_events WHERE kind = 'cli.bootstrap_admin' AND user_id = @u AND email_hash = @h",
            P("u", user.Item1), P("h", SHA256.HashData(Encoding.UTF8.GetBytes(email)))));

        var info = await Info(token);
        Assert.Equal(("reset", email), (info.Str("kind"), info.Str("email")));
        Assert.Equal(HttpStatusCode.OK, (await Accept(token)).Status);
        var login = await H.Post("/auth/login", new { email, password = NewPassword });
        Assert.Equal(HttpStatusCode.OK, login.Status);
        Assert.Null(await H.ScalarAsync<Guid?>("SELECT active_company_id FROM teas.sessions WHERE user_id = @u", P("u", user.Item1)));   // no company yet: /onboarding
        Assert.Equal(email, (await H.Get("/auth/profile", login.Token)).Str("email"));

        var again = await Cli(H, "bootstrap-admin", "--email", email, "--name", "x");                     // never a second first user
        Assert.NotEqual(0, again.exit);
        Assert.Equal("", again.stdout);
    }

    [Fact]
    public async Task ResetPasswordPrintsAFreshLinkForAnExistingUserAndRefusesAnUnknownOne()
    {
        var u = await H.CreateUserAsync();
        var old = await H.IssueLinkAsync("reset", "operator", userId: u.Id);
        var (exit, stdout, _) = await Cli(H, "reset-password", "--email", u.Email);
        Assert.Equal(0, exit);
        var token = Regex.Match(stdout, "^https://teas.example.test/link/([A-Za-z0-9_-]{43})\n?$").Groups[1].Value;
        Assert.NotEmpty(token);
        Assert.Equal("auth.link_invalid", (await Info(old)).Code);                                        // the older link is superseded
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.auth_events WHERE kind = 'cli.reset_password' AND user_id = @u", P("u", u.Id)));
        Assert.Equal(HttpStatusCode.OK, (await Accept(token)).Status);
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/login", new { email = u.Email, password = NewPassword })).Status);

        var none = await Cli(H, "reset-password", "--email", "nobody@example.test");
        Assert.NotEqual(0, none.exit);
        Assert.Equal("", none.stdout);
    }

    [Fact]
    public async Task ResetMfaClearsTheSecondFactorAndRecoveryCodesAndEndsTheSessions()
    {
        var u = await H.CreateUserAsync(totp: true);
        await H.ExecGlobalAsync("UPDATE teas.users SET totp_pending_enc = totp_secret_enc, totp_last_step = 5 WHERE id = @u", P("u", u.Id));
        var login = await H.Post("/auth/login", new { email = u.Email, password = u.Password });
        var session = (await H.Post("/auth/totp", new { challenge = login.Str("challenge"), code = H.CodeOf(u) })).Token!;
        Assert.Equal(HttpStatusCode.OK, (await H.Get("/auth/profile", session)).Status);

        var (exit, stdout, _) = await Cli(H, "reset-mfa", "--email", u.Email);
        Assert.Equal(0, exit);
        Assert.DoesNotContain("/link/", stdout);
        var row = await H.QueryAsync("SELECT totp_secret_enc IS NULL, totp_pending_enc IS NULL, totp_last_step IS NULL, (SELECT count(*) FROM teas.recovery_codes WHERE user_id = @u) FROM teas.users WHERE id = @u",
            r => (r.GetBoolean(0), r.GetBoolean(1), r.GetBoolean(2), r.GetInt64(3)), P("u", u.Id));
        Assert.Equal((true, true, true, 0L), row);
        Assert.Equal("auth.unauthenticated", (await H.Get("/auth/profile", session)).Code);
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.auth_events WHERE kind = 'cli.reset_mfa' AND user_id = @u", P("u", u.Id)));
        Assert.Equal("ok", (await H.Post("/auth/login", new { email = u.Email, password = u.Password })).Str("status"));        // no second factor now

        Assert.NotEqual(0, (await Cli(H, "reset-mfa", "--email", "nobody@example.test")).exit);
        Assert.NotEqual(0, (await Cli(H, "frobnicate")).exit);
    }
}
