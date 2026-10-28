using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Teas.App.Platform;
using Teas.App.Platform.Auth;
using Teas.Domain.Platform;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// SP3 S3 (generic login error), S4 (lockout), S5 (TOTP, integration half), enrolment, the auth audit company rule, the per-IP rate limit.
public sealed class AuthLoginTests(AuthFixture fx) : IClassFixture<AuthFixture>
{
    AuthHost H => fx.Host;
    static readonly TimeSpan Min = TimeSpan.FromMinutes(1);
    static NpgsqlParameter P(string n, object? v) => new(n, v ?? DBNull.Value);

    Task<Res> Login(string email, string password) => H.Post("/auth/login", new { email, password });
    long Verifications => H.Factory.Services.GetRequiredService<PasswordService>().Verifications;

    static string Strip(Res r) => Regex.Replace(r.Raw, "\"traceId\":\"[0-9a-f]+\",?", "");

    // ---------------------------------------------------------------- S3

    [Fact]
    public async Task UnknownEmailAndWrongPasswordAreTheSameAnswerAndEachRunsOneHashVerification()
    {
        var known = await H.CreateUserAsync();
        var nopass = await H.CreateUserAsync(password: false);

        var before = Verifications;
        var unknown = await Login($"nobody-{Guid.NewGuid():N}@example.test", AuthHost.Password);
        Assert.Equal(before + 1, Verifications);                      // the dummy verification (timing)
        before = Verifications;
        var wrong = await Login(known.Email, "Wrong#Password1");
        Assert.Equal(before + 1, Verifications);
        before = Verifications;
        var noPassword = await Login(nopass.Email, AuthHost.Password);   // an account that must set its password via a link
        Assert.Equal(before + 1, Verifications);

        foreach (var r in new[] { unknown, wrong, noPassword })
            Assert.Equal((HttpStatusCode.Unauthorized, "auth.invalid_credentials"), (r.Status, r.Code));
        Assert.Equal(Strip(unknown), Strip(wrong));
        Assert.Equal(Strip(unknown), Strip(noPassword));
        Assert.DoesNotContain("email", Strip(wrong), StringComparison.OrdinalIgnoreCase);
        Assert.Null(wrong.Token);
    }

    // Wall-clock evidence for the same rule (the counter above proves the verification ran; this proves it costs what a real one costs).
    [Fact]
    public async Task AnUnknownEmailTakesAboutAsLongAsAWrongPassword()
    {
        var known = await H.CreateUserAsync();
        static double Median(List<double> xs) { xs.Sort(); return (xs[xs.Count / 2 - 1] + xs[xs.Count / 2]) / 2; }
        var unknown = new List<double>();
        var wrong = new List<double>();
        for (var i = 0; i < 4; i++)   // 4 failures on the known email: one short of the lock
        {
            var t0 = System.Diagnostics.Stopwatch.GetTimestamp();
            await Login($"ghost-{Guid.NewGuid():N}@example.test", "Wrong#Password1");
            unknown.Add(System.Diagnostics.Stopwatch.GetElapsedTime(t0).TotalMilliseconds);
            t0 = System.Diagnostics.Stopwatch.GetTimestamp();
            await Login(known.Email, "Wrong#Password2");
            wrong.Add(System.Diagnostics.Stopwatch.GetElapsedTime(t0).TotalMilliseconds);
        }
        Assert.True(Median(unknown) > 0.5 * Median(wrong), $"unknown email {Median(unknown):F0} ms vs wrong password {Median(wrong):F0} ms: an unknown email must run the dummy hash");
    }

    [Fact]
    public async Task AGiantPasswordIsRefusedWithoutBeingHashed()
    {
        var u = await H.CreateUserAsync();
        var giant = new string('A', 5000) + "a1";
        var before = Verifications;
        var r = await Login(u.Email, giant);
        Assert.Equal("auth.invalid_credentials", r.Code);
        Assert.Equal(before + 1, Verifications);
        var t = await H.LoginAsync(u);
        Assert.Equal("auth.password_weak", (await H.Post("/auth/password", new { current = u.Password, next = giant, confirm = giant }, t)).Code);
    }

    // ---------------------------------------------------------------- S4

    [Fact]
    public async Task TheFifthConsecutiveFailureItselfAnswers429AndTheLockHoldsFor15Minutes()
    {
        var u = await H.CreateUserAsync();
        for (var i = 1; i <= 4; i++) Assert.Equal("auth.invalid_credentials", (await Login(u.Email, "Wrong#Password" + i)).Code);
        var fifth = await Login(u.Email, "Wrong#Password5");
        Assert.Equal((HttpStatusCode)429, fifth.Status);
        Assert.Equal("auth.locked", fifth.Code);

        var right = await Login(u.Email, u.Password);                  // the right password is refused while locked
        Assert.Equal("auth.locked", right.Code);
        Assert.Null(right.Token);
        H.Clock.Advance(14 * Min);
        Assert.Equal("auth.locked", (await Login(u.Email, u.Password)).Code);
        H.Clock.Advance(2 * Min);
        Assert.Equal(HttpStatusCode.OK, (await Login(u.Email, u.Password)).Status);
    }

    [Fact]
    public async Task AnUnknownEmailLocksTooSoItIsNoOracle()
    {
        var email = $"ghost-{Guid.NewGuid():N}@example.test";
        for (var i = 0; i < 4; i++) Assert.Equal("auth.invalid_credentials", (await Login(email, "Wrong#Password1")).Code);
        Assert.Equal("auth.locked", (await Login(email, "Wrong#Password1")).Code);
    }

    [Fact]
    public async Task ASuccessClearsTheCounterAndTheKeyIgnoresCaseAndSpaces()
    {
        var u = await H.CreateUserAsync();
        for (var i = 0; i < 4; i++) await Login(u.Email, "Wrong#Password1");
        Assert.Equal(HttpStatusCode.OK, (await Login(u.Email, u.Password)).Status);
        for (var i = 0; i < 4; i++) Assert.Equal("auth.invalid_credentials", (await Login(u.Email, "Wrong#Password1")).Code);   // 4 again: not locked
        Assert.Equal("auth.locked", (await Login("  " + u.Email.ToUpperInvariant() + " ", "Wrong#Password1")).Code);           // the 5th, written differently
    }

    [Fact]
    public async Task TheCounterIsSharedWithTheCurrentPasswordCheck()
    {
        var u = await H.CreateUserAsync();
        var t = await H.LoginAsync(u);
        await Login(u.Email, "Wrong#Password1");
        await Login(u.Email, "Wrong#Password2");
        const string next = "Another#Pass42";
        var codes = new List<string?>();
        for (var i = 0; i < 3; i++) codes.Add((await H.Post("/auth/password", new { current = "Wrong#Password9", next, confirm = next }, t)).Code);
        Assert.Equal(["auth.current_password_invalid", "auth.current_password_invalid", "auth.locked"], codes);
        var locked = await H.Post("/auth/password", new { current = u.Password, next, confirm = next }, t);
        Assert.Equal((HttpStatusCode)429, locked.Status);
    }

    [Fact]
    public async Task TheCounterIsSharedWithRelogin()
    {
        var u = await H.CreateUserAsync();
        var t = await H.LoginAsync(u);
        H.Clock.Advance(61 * Min);
        var codes = new List<string?>();
        for (var i = 0; i < 5; i++) codes.Add((await H.Post("/auth/relogin", new { password = "Wrong#Password9" }, t)).Code);
        Assert.Equal(["auth.invalid_credentials", "auth.invalid_credentials", "auth.invalid_credentials", "auth.invalid_credentials", "auth.locked"], codes);
    }

    [Fact]
    public async Task TheSecondFactorStepCountsAndThePasswordStepDoesNotResetIt()
    {
        var u = await H.CreateUserAsync(totp: true);
        async Task<string> Challenge() => (await Login(u.Email, u.Password)).Str("challenge")!;
        var c = await Challenge();
        for (var i = 0; i < 3; i++) Assert.Equal("auth.totp_invalid", (await H.Post("/auth/totp", new { challenge = c, code = "000000" })).Code);
        // signing in with the password again must not wipe the three failures (or an attacker who knows the password could guess forever)
        c = await Challenge();
        Assert.Equal("auth.totp_invalid", (await H.Post("/auth/totp", new { challenge = c, code = "000000" })).Code);
        var fifth = await H.Post("/auth/totp", new { challenge = c, code = "000000" });
        Assert.Equal((HttpStatusCode)429, fifth.Status);
        Assert.Equal("auth.locked", fifth.Code);
        Assert.Equal("auth.locked", (await Login(u.Email, u.Password)).Code);
    }

    // ---------------------------------------------------------------- S5 integration half

    [Fact]
    public async Task TwoStepLoginNeedsTheCodeAndSetsTheCookieOnlyAfterIt()
    {
        var u = await H.CreateUserAsync(totp: true);
        var first = await Login(u.Email, u.Password);
        Assert.Equal(HttpStatusCode.OK, first.Status);
        Assert.Equal("totp_required", first.Str("status"));
        Assert.Empty(first.SetCookies);
        var challenge = first.Str("challenge")!;
        Assert.Matches("^[A-Za-z0-9_-]{43}$", challenge);

        var bad = await H.Post("/auth/totp", new { challenge, code = "000000" });
        Assert.Equal((HttpStatusCode.Unauthorized, "auth.totp_invalid"), (bad.Status, bad.Code));
        var ok = await H.Post("/auth/totp", new { challenge, code = H.CodeOf(u) });
        Assert.Equal("""{"status":"ok"}""", ok.Raw);
        Assert.NotNull(ok.Token);
        // the challenge is single use
        H.Clock.Advance(TimeSpan.FromSeconds(30));
        Assert.Equal("auth.challenge_invalid", (await H.Post("/auth/totp", new { challenge, code = H.CodeOf(u) })).Code);
    }

    [Fact]
    public async Task AUsedStepIsRefusedAndTheNextOneWorks()
    {
        var u = await H.CreateUserAsync(totp: true);
        var code = H.CodeOf(u);
        var a = (await Login(u.Email, u.Password)).Str("challenge");
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/totp", new { challenge = a, code })).Status);
        var b = (await Login(u.Email, u.Password)).Str("challenge");
        var replay = await H.Post("/auth/totp", new { challenge = b, code });
        Assert.Equal((HttpStatusCode.Unauthorized, "auth.totp_invalid"), (replay.Status, replay.Code));
        H.Clock.Advance(TimeSpan.FromSeconds(30));
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/totp", new { challenge = b, code = H.CodeOf(u) })).Status);
    }

    [Fact]
    public async Task OneStepEitherSideIsAcceptedTwoAreNot()
    {
        var u = await H.CreateUserAsync(totp: true);
        async Task<Res> Try(int offset) => await H.Post("/auth/totp", new { challenge = (await Login(u.Email, u.Password)).Str("challenge"), code = H.CodeOf(u, offset) });
        Assert.Equal("auth.totp_invalid", (await Try(-2)).Code);
        Assert.Equal("auth.totp_invalid", (await Try(2)).Code);
        Assert.Equal(HttpStatusCode.OK, (await Try(-1)).Status);
        H.Clock.Advance(TimeSpan.FromSeconds(60));                      // the step after the one just used, at the far edge
        Assert.Equal(HttpStatusCode.OK, (await Try(1)).Status);
    }

    [Fact]
    public async Task TwoConcurrentSubmissionsOfTheSameCodeGiveExactlyOneSession()
    {
        var u = await H.CreateUserAsync(totp: true);
        var code = H.CodeOf(u);
        var c1 = (await Login(u.Email, u.Password)).Str("challenge");
        var c2 = (await Login(u.Email, u.Password)).Str("challenge");
        H.Gate.Barrier = new AsyncBarrier(2);   // both requests have read the user (last step unset) before either claims the step: only the guarded UPDATE can tell them apart
        Res[] rs;
        try { rs = await Task.WhenAll(H.Post("/auth/totp", new { challenge = c1, code }), H.Post("/auth/totp", new { challenge = c2, code })); }
        finally { H.Gate.Barrier = null; }
        Assert.Equal(1, rs.Count(r => r.Status == HttpStatusCode.OK));
        Assert.Equal(1, rs.Count(r => r.Code == "auth.totp_invalid"));
    }

    [Fact]
    public async Task AChallengeExpiresAfterFiveMinutes()
    {
        var u = await H.CreateUserAsync(totp: true);
        var c = (await Login(u.Email, u.Password)).Str("challenge");
        H.Clock.Advance(5 * Min + TimeSpan.FromSeconds(1));
        var r = await H.Post("/auth/totp", new { challenge = c, code = H.CodeOf(u) });
        Assert.Equal((HttpStatusCode.Unauthorized, "auth.challenge_invalid"), (r.Status, r.Code));
        Assert.Equal("auth.challenge_invalid", (await H.Post("/auth/totp", new { challenge = "nope", code = "123456" })).Code);
    }

    [Fact]
    public async Task ARecoveryCodeWorksOnceEvenWhenRaced()
    {
        var u = await H.CreateUserAsync(totp: true);
        var code = u.RecoveryCodes![0];
        var ok = await H.Post("/auth/totp", new { challenge = (await Login(u.Email, u.Password)).Str("challenge"), recoveryCode = " " + code.ToLowerInvariant() + " " });
        Assert.Equal(HttpStatusCode.OK, ok.Status);
        var profile = await H.Get("/auth/profile", ok.Token);
        Assert.Equal(7, profile.Json.GetProperty("recoveryRemaining").GetInt32());
        var again = await H.Post("/auth/totp", new { challenge = (await Login(u.Email, u.Password)).Str("challenge"), recoveryCode = code });
        Assert.Equal("auth.totp_invalid", again.Code);

        var race = u.RecoveryCodes![1];
        var c1 = (await Login(u.Email, u.Password)).Str("challenge");
        var c2 = (await Login(u.Email, u.Password)).Str("challenge");
        var rs = await Task.WhenAll(H.Post("/auth/totp", new { challenge = c1, recoveryCode = race }), H.Post("/auth/totp", new { challenge = c2, recoveryCode = race }));
        Assert.Equal(1, rs.Count(r => r.Status == HttpStatusCode.OK));
    }

    // ---------------------------------------------------------------- enrolment

    [Fact]
    public async Task EnrolmentStaysPendingUntilACorrectCodeThenReturnsEightRecoveryCodesOnce()
    {
        var u = await H.CreateUserAsync();
        var t = await H.LoginAsync(u);

        var early = await H.Post("/auth/totp/enrol/verify", new { code = "123456" }, t);
        Assert.Equal((HttpStatusCode.Conflict, "auth.enrol_not_started"), (early.Status, early.Code));

        var start = await H.Post("/auth/totp/enrol", token: t);
        var secret = start.Str("secret")!;
        Assert.Matches("^[A-Z2-7]{32}$", secret);
        Assert.Equal($"otpauth://totp/TEAS:{Uri.EscapeDataString(u.Email)}?secret={secret}&issuer=TEAS&algorithm=SHA1&digits=6&period=30", start.Str("uri"));
        Assert.False((await H.Get("/auth/profile", t)).Json.GetProperty("totpEnabled").GetBoolean());
        Assert.NotNull(await H.ScalarAsync<byte[]>("SELECT totp_pending_enc FROM teas.users WHERE id = @u", P("u", u.Id)));
        Assert.Null(await H.ScalarAsync<byte[]>("SELECT totp_secret_enc FROM teas.users WHERE id = @u", P("u", u.Id)));

        var wrong = await H.Post("/auth/totp/enrol/verify", new { code = "000000" }, t);
        Assert.Equal((HttpStatusCode.Unauthorized, "auth.totp_invalid"), (wrong.Status, wrong.Code));
        Assert.False((await H.Get("/auth/profile", t)).Json.GetProperty("totpEnabled").GetBoolean());

        var raw = Totp.FromBase32(secret);
        var code = Totp.Code(raw, Totp.StepOf(H.Now));
        var done = await H.Post("/auth/totp/enrol/verify", new { code }, t);
        Assert.Equal(HttpStatusCode.OK, done.Status);
        var codes = done.Json.GetProperty("recoveryCodes").EnumerateArray().Select(e => e.GetString()!).ToList();
        Assert.Equal(8, codes.Count);
        Assert.Equal(8, codes.Distinct().Count());
        Assert.All(codes, c => Assert.Matches("^RCV-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$", c));
        var profile = await H.Get("/auth/profile", t);
        Assert.True(profile.Json.GetProperty("totpEnabled").GetBoolean());
        Assert.Equal(8, profile.Json.GetProperty("recoveryRemaining").GetInt32());
        Assert.Null(await H.ScalarAsync<byte[]>("SELECT totp_pending_enc FROM teas.users WHERE id = @u", P("u", u.Id)));
        Assert.NotNull(await H.ScalarAsync<byte[]>("SELECT totp_secret_enc FROM teas.users WHERE id = @u", P("u", u.Id)));

        // the code that proved the enrolment is spent; the next step's code signs in; a recovery code from the list signs in once
        var c1 = (await Login(u.Email, u.Password)).Str("challenge");
        Assert.Equal("auth.totp_invalid", (await H.Post("/auth/totp", new { challenge = c1, code })).Code);
        H.Clock.Advance(TimeSpan.FromSeconds(30));
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/totp", new { challenge = c1, code = Totp.Code(raw, Totp.StepOf(H.Now)) })).Status);
        var c2 = (await Login(u.Email, u.Password)).Str("challenge");
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/totp", new { challenge = c2, recoveryCode = codes[3] })).Status);
    }

    [Fact]
    public async Task TheSecretIsStoredEncryptedNotAsTheBase32Text()
    {
        var u = await H.CreateUserAsync();
        var t = await H.LoginAsync(u);
        var start = await H.Post("/auth/totp/enrol", token: t);
        var stored = await H.ScalarAsync<byte[]>("SELECT totp_pending_enc FROM teas.users WHERE id = @u", new NpgsqlParameter("u", u.Id));
        var raw = Totp.FromBase32(start.Str("secret")!);
        Assert.NotNull(stored);
        Assert.False(stored.AsSpan().IndexOf(raw) >= 0);
        Assert.DoesNotContain(start.Str("secret")!, Encoding.ASCII.GetString(stored));
        var plain = H.Factory.Services.GetRequiredService<ISecretProtector>().Unprotect(stored);
        Assert.Equal(raw, plain);
    }

    // ---------------------------------------------------------------- audit company rule + auth_events

    [Fact]
    public async Task AuthIsAuditedInTheSessionsCompanyElseTheFirstActiveMembershipElseOnlyInAuthEvents()
    {
        var u = await H.CreateUserAsync();
        var a = await H.CreateCompanyAsync();
        var b = await H.CreateCompanyAsync();
        var gone = await H.CreateCompanyAsync();
        var pending = await H.CreateCompanyAsync();
        await H.AddMemberAsync(gone, u, active: false);                           // deactivated: never eligible
        await H.AddMemberAsync(pending, u, pending: true);                        // a pending invitation: never eligible
        await H.AddMemberAsync(a, u);
        await H.AddMemberAsync(b, u);
        Task<long> Rows(Guid c, string cmd) => H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND command = @k", P("c", c), P("k", cmd));

        var t = await H.LoginAsync(u);                                             // no last company: the first active membership (a is older)
        Assert.Equal(1, await Rows(a, "auth.login"));
        Assert.Equal(0, await Rows(b, "auth.login"));
        Assert.Equal(a, await H.ScalarAsync<Guid>("SELECT active_company_id FROM teas.sessions WHERE user_id = @u", P("u", u.Id)));

        await H.ExecGlobalAsync("UPDATE teas.users SET last_company_id = @c WHERE id = @u", P("c", b), P("u", u.Id));
        var t2 = await H.LoginAsync(u);                                            // the user's last company wins when still valid
        Assert.Equal(1, await Rows(b, "auth.login"));
        await H.Post("/auth/logout", token: t2);
        Assert.Equal(1, await Rows(b, "auth.logout"));                                   // logout: the session's company

        await H.Post("/auth/totp/enrol", token: t);
        Assert.Equal(1, await Rows(a, "auth.totp.enrol_start"));
        var audit = await H.QueryAsync("SELECT actor_kind, actor_id, target, before::text, after::text, result, client FROM teas.audit_log WHERE command = 'auth.totp.enrol_start' AND actor_id = @u",
            r => (r.GetString(0), r.GetString(1), r.GetString(2), r.IsDBNull(3), r.IsDBNull(4), r.GetString(5), r.GetString(6)), P("u", u.Id.ToString()));
        Assert.Equal(("user", u.Id.ToString(), u.Id.ToString(), true, true, "ok", "web"), audit);

        var loner = await H.CreateUserAsync();                                     // no membership at all: auth_events only
        await H.LoginAsync(loner);
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE actor_id = @u", P("u", loner.Id.ToString())));
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.auth_events WHERE kind = 'auth.login' AND user_id = @u", P("u", loner.Id)));
        Assert.Null(await H.ScalarAsync<Guid?>("SELECT active_company_id FROM teas.sessions WHERE user_id = @u", P("u", loner.Id)));
    }

    [Fact]
    public async Task EveryAttemptLeavesAnAuthEventWithTheEmailOnlyAsAHash()
    {
        var u = await H.CreateUserAsync();
        await H.AddMemberAsync(await H.CreateCompanyAsync(), u);          // a company exists, so a failed sign-in COULD be audited there: it must not be
        await Login(u.Email, "Wrong#Password1");
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE actor_id = @u", P("u", u.Id.ToString())));   // a 4xx leaves no audit_log row (only a 403 does)
        await H.LoginAsync(u);
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE actor_id = @u AND command = 'auth.login' AND result = 'ok'", P("u", u.Id.ToString())));
        var key = SHA256.HashData(Encoding.UTF8.GetBytes(u.Email.ToLowerInvariant()));
        var kinds = new List<string>();
        await H.Db.AsAppAsync(new ScopeState(null, null, true), async (c, tx) =>
        {
            await using var cmd = new NpgsqlCommand("SELECT kind FROM teas.auth_events WHERE email_hash = @h ORDER BY id", c, tx);
            cmd.Parameters.AddWithValue("h", key);
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync()) kinds.Add(r.GetString(0));
            return 0;
        });
        Assert.Equal(["auth.login.failed", "auth.login"], kinds);
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.auth_events WHERE user_agent ILIKE '%' || @e || '%'", P("e", u.Email)));
    }

    // ---------------------------------------------------------------- rate limit

    [Fact]
    public async Task TheAuthRoutesAreLimitedTo20PerMinutePerIpExceptTheSessionPollAndNothingElseIs()
    {
        await using var limited = await AuthHost.StartAsync(rateLimit: 20);
        using var noSecret = limited.Factory.Server.CreateClient();                      // no X-Teas-Bff: refused BEFORE the limiter, so it uses none of the 20
        for (var i = 0; i < 30; i++) Assert.Equal(HttpStatusCode.Unauthorized, (await noSecret.PostAsync("/internal/v1/auth/logout", null)).StatusCode);
        for (var i = 0; i < 20; i++) Assert.Equal(HttpStatusCode.OK, (await limited.Post("/auth/logout")).Status);
        var over = await limited.Post("/auth/logout");
        Assert.Equal((HttpStatusCode)429, over.Status);
        Assert.Equal("http.rate_limited", over.Code);
        Assert.Equal((HttpStatusCode)429, (await limited.Post("/auth/login", new { email = "a@b.test", password = "x" })).Status);
        for (var i = 0; i < 40; i++) Assert.Equal(HttpStatusCode.OK, (await limited.Get("/auth/session")).Status);   // the expiry dialog's poll is not limited
        Assert.Equal(HttpStatusCode.OK, (await limited.Get("/ping")).Status);
    }

    // ---------------------------------------------------------------- P7a: the attempt is reserved BEFORE it is checked

    [Fact]
    public async Task AParallelBurstOfWrongPasswordsBuysAtMostFiveChecks()
    {
        var u = await H.CreateUserAsync();
        var before = Verifications;
        var rs = await Task.WhenAll(Enumerable.Range(0, 30).Select(i => Login(u.Email, "Wrong#Password" + i)));
        Assert.Equal(before + 5, Verifications);                                          // attempts 1-5 were checked, 25 were refused unchecked
        Assert.Equal(4, rs.Count(r => r.Code == "auth.invalid_credentials"));
        Assert.Equal(26, rs.Count(r => r.Code == "auth.locked"));

        // after 4 failures a burst gets exactly one more check, and the right password is then refused: no session beyond the 5th attempt
        var v = await H.CreateUserAsync();
        for (var i = 0; i < 4; i++) await Login(v.Email, "Wrong#Password1");
        before = Verifications;
        var burst = await Task.WhenAll(Enumerable.Range(0, 12).Select(i => Login(v.Email, "Wrong#Password" + i)));
        Assert.Equal(before + 1, Verifications);
        Assert.All(burst, r => Assert.Equal("auth.locked", r.Code));
        var right = await Login(v.Email, v.Password);
        Assert.Equal("auth.locked", right.Code);
        Assert.Null(right.Token);
    }

    [Fact]
    public async Task AParallelBurstOfWrongCodesBuysAtMostFiveCodeChecks()
    {
        var u = await H.CreateUserAsync(totp: true);
        var challenges = new List<string>();
        for (var i = 0; i < 12; i++) challenges.Add((await Login(u.Email, u.Password)).Str("challenge")!);   // a right password costs no attempt
        var gate = H.Factory.Services.GetRequiredService<GatedProtector>();
        var before = gate.Calls;
        var rs = await Task.WhenAll(challenges.Select(c => H.Post("/auth/totp", new { challenge = c, code = "000000" })));
        Assert.Equal(before + 5, gate.Calls);
        Assert.Equal(4, rs.Count(r => r.Code == "auth.totp_invalid"));
        Assert.Equal(8, rs.Count(r => r.Code == "auth.locked"));
    }

    [Fact]
    public async Task AnExpectedFailureWritesNoErrorLog()
    {
        var u = await H.CreateUserAsync();
        await Login(u.Email, "Wrong#Password1");
        Assert.DoesNotContain(H.Logs.Lines, l => l.Contains("ExceptionHandlerMiddleware"));
    }

    // ---------------------------------------------------------------- P7a: changing the authenticator needs a fresh sign-in

    async Task<string> TwoStepSignInAsync(TestUser u)
    {
        var step = await Login(u.Email, u.Password);
        var ok = await H.Post("/auth/totp", new { challenge = step.Str("challenge"), code = H.CodeOf(u) });
        Assert.Equal(HttpStatusCode.OK, ok.Status);
        H.Clock.Advance(TimeSpan.FromSeconds(30));                                       // the next sign-in needs the next step's code
        return ok.Token!;
    }

    [Fact]
    public async Task ChangingTheAuthenticatorNeedsASignInFromTheLast10MinutesAndEndsTheOtherSessions()
    {
        var u = await H.CreateUserAsync(totp: true);
        var old = await TwoStepSignInAsync(u);
        var other = await TwoStepSignInAsync(u);
        H.Clock.Advance(11 * Min);
        var start = await H.Post("/auth/totp/enrol", token: old);
        Assert.Equal((HttpStatusCode.Forbidden, "auth.forbidden"), (start.Status, start.Code));
        var verify = await H.Post("/auth/totp/enrol/verify", new { code = "123456" }, old);
        Assert.Equal((HttpStatusCode.Forbidden, "auth.forbidden"), (verify.Status, verify.Code));

        var fresh = await TwoStepSignInAsync(u);
        var begun = await H.Post("/auth/totp/enrol", token: fresh);
        Assert.Equal(HttpStatusCode.OK, begun.Status);
        var code = Totp.Code(Totp.FromBase32(begun.Str("secret")!), Totp.StepOf(H.Now));
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/totp/enrol/verify", new { code }, fresh)).Status);
        Assert.Equal("auth.unauthenticated", (await H.Get("/auth/profile", old)).Code);     // every other session ended
        Assert.Equal("auth.unauthenticated", (await H.Get("/auth/profile", other)).Code);
        Assert.Equal(HttpStatusCode.OK, (await H.Get("/auth/profile", fresh)).Status);
    }

    [Fact]
    public async Task EvenAFirstEnrolmentNeedsASignInFromTheLast10Minutes()
    {
        var u = await H.CreateUserAsync();
        var t = await H.LoginAsync(u);
        H.Clock.Advance(11 * Min);
        var start = await H.Post("/auth/totp/enrol", token: t);
        Assert.Equal((HttpStatusCode.Forbidden, "auth.forbidden"), (start.Status, start.Code));
        Assert.Equal("auth.forbidden", (await H.Post("/auth/totp/enrol/verify", new { code = "123456" }, t)).Code);
        Assert.Null(await H.ScalarAsync<byte[]>("SELECT totp_pending_enc FROM teas.users WHERE id = @u", P("u", u.Id)));   // nothing was written
        var fresh = await H.LoginAsync(u);
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/totp/enrol", token: fresh)).Status);
    }

    [Fact]
    public async Task AStaleSessionRefusedAtEnrolmentLeavesOneRejectedRowPerRefusalOnlyWhenItHasACompany()
    {
        var withCompany = await H.CreateUserAsync();
        var company = await H.CreateCompanyAsync();
        await H.AddMemberAsync(company, withCompany);
        var alone = await H.CreateUserAsync();
        var t1 = await H.LoginAsync(withCompany);
        var t2 = await H.LoginAsync(alone);
        H.Clock.Advance(11 * Min);
        Assert.Equal("auth.forbidden", (await H.Post("/auth/totp/enrol", token: t1)).Code);
        Assert.Equal("auth.forbidden", (await H.Post("/auth/totp/enrol/verify", new { code = "123456" }, t1)).Code);
        Assert.Equal("auth.forbidden", (await H.Post("/auth/totp/enrol", token: t2)).Code);   // no company scope: no row (auth_events is the global log)

        Assert.Equal(1, await P8.AuditCount(H, company, "auth.totp.enrol_start", "rejected"));
        Assert.Equal(1, await P8.AuditCount(H, company, "auth.totp.enable", "rejected"));
        Assert.Equal(2, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE result = 'rejected' AND target = @t AND actor_id = @t AND before IS NULL AND after IS NULL", P("t", withCompany.Id.ToString())));
        Assert.Equal(2, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE result = 'rejected' AND actor_id IN (@a, @b)", P("a", withCompany.Id.ToString()), P("b", alone.Id.ToString())));
    }

    [Fact]
    public async Task ASessionOfADeactivatedMemberHasNoCompany()
    {
        var u = await H.CreateUserAsync();
        var company = await H.CreateCompanyAsync();
        var member = await H.AddMemberAsync(company, u);
        var t = await H.LoginAsync(u);
        await H.Post("/auth/totp/enrol", token: t);
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND command = 'auth.totp.enrol_start'", P("c", company)));
        await H.ExecAsync("UPDATE teas.company_members SET active = false WHERE company_id = @c AND id = @m", new ScopeState(company, null, false), P("c", company), P("m", member));
        await H.Post("/auth/totp/enrol", token: t);                                         // still signed in, but the company is no scope and no audit target
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND command = 'auth.totp.enrol_start'", P("c", company)));
    }

    [Fact]
    public async Task APasswordChangeEndsHalfFinishedTwoStepSignIns()
    {
        var u = await H.CreateUserAsync(totp: true);
        var pending = (await Login(u.Email, u.Password)).Str("challenge");
        var session = await TwoStepSignInAsync(u);
        const string next = "Another#Pass42";
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/password", new { current = u.Password, next, confirm = next }, session)).Status);
        var late = await H.Post("/auth/totp", new { challenge = pending, code = H.CodeOf(u) });
        Assert.Equal("auth.challenge_invalid", late.Code);
    }
}
