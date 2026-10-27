using System.Net;
using System.Text.RegularExpressions;
using Npgsql;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// SP3 S6 (+ ADR-0004): cookie flags, states and timeouts, extension rules, logout / revoke / password change, relogin.
public sealed class SessionTests(AuthFixture fx) : IClassFixture<AuthFixture>
{
    AuthHost H => fx.Host;
    static readonly TimeSpan Min = TimeSpan.FromMinutes(1);

    async Task<(HttpStatusCode, string?, int?, string)> StateAsync(string? token)
    {
        var r = await H.Get("/auth/session", token);
        int? left = r.Json.TryGetProperty("expiresInSec", out var e) ? e.GetInt32() : null;
        return (r.Status, r.Json.GetProperty("state").GetString(), left, r.Raw);
    }

    [Fact]
    public async Task LoginSetsTheCookieExactlyAsTheSpecSays()
    {
        var u = await H.CreateUserAsync();
        var r = await H.Post("/auth/login", new { email = u.Email, password = u.Password });
        Assert.Equal(HttpStatusCode.OK, r.Status);
        Assert.Equal("""{"status":"ok"}""", r.Raw);
        Assert.True(r.Message.Headers.CacheControl?.NoStore);   // an answer that carries a session is never cached
        var cookie = Assert.Single(r.SetCookies);
        Assert.Matches("^__Host-teas_session=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Lax$", cookie);   // 256 bits, no Domain, no Max-Age
    }

    [Fact]
    public async Task OnDevelopmentOverHttpTheCookieIsTeasSessionWithoutSecure()
    {
        await using var dev = await AuthHost.StartAsync(environment: "Development");
        var u = await dev.CreateUserAsync();
        var r = await dev.Post("/auth/login", new { email = u.Email, password = u.Password });
        Assert.Equal(HttpStatusCode.OK, r.Status);
        Assert.Matches("^teas_session=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax$", Assert.Single(r.SetCookies));
    }

    [Fact]
    public async Task EveryLoginGetsANewTokenAndStoresOnlyItsHash()
    {
        var u = await H.CreateUserAsync();
        var a = await H.LoginAsync(u);
        var b = await H.LoginAsync(u);
        Assert.NotEqual(a, b);
        Assert.Equal(2, await H.ScalarAsync<long>("SELECT count(*) FROM teas.sessions WHERE user_id = @u", new NpgsqlParameter("u", u.Id)));
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.sessions WHERE token_hash = convert_to(@t, 'UTF8')", new NpgsqlParameter("t", a)));
    }

    [Fact]
    public async Task StatesFollowTheIdleClockExactly()
    {
        var u = await H.CreateUserAsync();
        var t = await H.LoginAsync(u);
        var (_, state, left, raw) = await StateAsync(t);
        Assert.Equal("active", state);
        Assert.Null(left);
        Assert.Contains(u.Email, raw);

        H.Clock.Advance(57 * Min);                                   // 3 min left
        Assert.Equal("active", (await StateAsync(t)).Item2);
        H.Clock.Advance(Min + TimeSpan.FromSeconds(50));              // 58 min 50 s in: 70 s left
        var (_, st2, left2, _) = await StateAsync(t);
        Assert.Equal("expiring", st2);
        Assert.Equal(70, left2);
        H.Clock.Advance(TimeSpan.FromSeconds(70));                    // exactly at the idle expiry
        var (_, st3, left3, raw3) = await StateAsync(t);
        Assert.Equal("expired", st3);
        Assert.Null(left3);
        Assert.Contains(u.Email, raw3);                               // the relogin dialog names the user
    }

    [Fact]
    public async Task OutNamesNobody()
    {
        var u = await H.CreateUserAsync();
        Assert.Equal("""{"state":"out"}""", (await H.Get("/auth/session")).Raw);
        Assert.Equal("""{"state":"out"}""", (await H.Get("/auth/session", "no-such-token")).Raw);
        var t = await H.LoginAsync(u);
        await H.Post("/auth/logout", token: t);
        Assert.Equal("""{"state":"out"}""", (await H.Get("/auth/session", t)).Raw);
    }

    [Fact]
    public async Task GetSessionNeverExtendsButEveryOtherRequestDoes()
    {
        var u = await H.CreateUserAsync();
        var polled = await H.LoginAsync(u);
        var working = await H.LoginAsync(u);
        H.Clock.Advance(50 * Min);
        await H.Get("/auth/session", polled);          // the expiry dialog polls: no extension
        Assert.Equal(HttpStatusCode.OK, (await H.Get("/auth/profile", working)).Status);   // a GET is activity
        H.Clock.Advance(11 * Min);
        Assert.Equal("expired", (await StateAsync(polled)).Item2);
        Assert.Equal("active", (await StateAsync(working)).Item2);
    }

    [Fact]
    public async Task TheIdleExpiryIsWrittenAtMostOncePer60Seconds()
    {
        var u = await H.CreateUserAsync();
        var t = await H.LoginAsync(u);
        var start = H.Now;
        Task<DateTimeOffset> LastSeen() => H.ScalarAsync<DateTimeOffset>("SELECT last_seen_at FROM teas.sessions WHERE user_id = @u", new NpgsqlParameter("u", u.Id));
        H.Clock.Advance(TimeSpan.FromSeconds(30));
        await H.Get("/auth/profile", t);
        Assert.Equal(start, await LastSeen());                         // 30 s: no write
        H.Clock.Advance(TimeSpan.FromSeconds(31));
        await H.Get("/auth/profile", t);
        Assert.Equal(start.AddSeconds(61), await LastSeen());          // 61 s: written
        H.Clock.Advance(TimeSpan.FromSeconds(10));
        await H.Get("/auth/profile", t);
        Assert.Equal(start.AddSeconds(61), await LastSeen());
    }

    [Fact]
    public async Task TheAbsoluteLimitOf12HoursEndsASessionThatIsKeptBusy()
    {
        var u = await H.CreateUserAsync();
        var t = await H.LoginAsync(u);
        for (var i = 0; i < 14; i++)                                   // 11 h 40 min of work, a request every 50 min
        {
            H.Clock.Advance(50 * Min);
            Assert.Equal(HttpStatusCode.OK, (await H.Get("/auth/profile", t)).Status);
        }
        Assert.Equal("active", (await StateAsync(t)).Item2);
        H.Clock.Advance(21 * Min);                                     // 12 h 01 min
        Assert.Equal("out", (await StateAsync(t)).Item2);
        var r = await H.Get("/auth/profile", t);
        Assert.Equal(HttpStatusCode.Unauthorized, r.Status);
        Assert.Equal("auth.unauthenticated", r.Code);
    }

    [Fact]
    public async Task ExtendKeepsALiveSessionAndRefusesExpiredAndOut()
    {
        var u = await H.CreateUserAsync();
        var t = await H.LoginAsync(u);
        H.Clock.Advance(59 * Min);
        Assert.Equal("expiring", (await StateAsync(t)).Item2);
        var r = await H.Post("/auth/session/extend", token: t);
        Assert.Equal(HttpStatusCode.OK, r.Status);
        Assert.Equal("""{"state":"active"}""", r.Raw);
        Assert.Equal("active", (await StateAsync(t)).Item2);

        H.Clock.Advance(61 * Min);
        var expired = await H.Post("/auth/session/extend", token: t);
        Assert.Equal((HttpStatusCode.Unauthorized, "auth.session_expired"), (expired.Status, expired.Code));
        Assert.Equal("expired", (await StateAsync(t)).Item2);          // and it did not revive it

        foreach (var token in new string?[] { null, "unknown" })
        {
            var out1 = await H.Post("/auth/session/extend", token: token);
            Assert.Equal((HttpStatusCode.Unauthorized, "auth.unauthenticated"), (out1.Status, out1.Code));
        }
        var t2 = await H.LoginAsync(u);
        await H.Post("/auth/logout", token: t2);
        Assert.Equal("auth.unauthenticated", (await H.Post("/auth/session/extend", token: t2)).Code);
    }

    [Fact]
    public async Task AnExpiredSessionIsA401SessionExpiredOnEveryOtherSessionRoute()
    {
        var u = await H.CreateUserAsync();
        var t = await H.LoginAsync(u);
        H.Clock.Advance(61 * Min);
        foreach (var r in new[] { await H.Get("/auth/profile", t), await H.Get("/auth/sessions", t), await H.Post("/auth/totp/enrol", token: t) })
            Assert.Equal((HttpStatusCode.Unauthorized, "auth.session_expired"), (r.Status, r.Code));
    }

    [Fact]
    public async Task LogoutEndsTheSessionAtOnceAndClearsTheCookie()
    {
        var u = await H.CreateUserAsync();
        var t = await H.LoginAsync(u);
        var r = await H.Post("/auth/logout", token: t);
        Assert.Equal("""{"state":"out"}""", r.Raw);
        Assert.Matches("^__Host-teas_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT$", Assert.Single(r.SetCookies));
        Assert.Equal("auth.unauthenticated", (await H.Get("/auth/profile", t)).Code);
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/logout", token: t)).Status);     // twice, and with no cookie, is fine
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/logout")).Status);
    }

    [Fact]
    public async Task SessionsListAndRevoke()
    {
        var u = await H.CreateUserAsync();
        var other = await H.CreateUserAsync();
        var a = await H.LoginAsync(u);
        var b = await H.LoginAsync(u);
        var strangers = await H.LoginAsync(other);

        var list = await H.Get("/auth/sessions", a);
        var items = list.Json.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(2, items.Count);
        Assert.Single(items, i => i.GetProperty("current").GetBoolean());
        var strangerId = await H.ScalarAsync<Guid>("SELECT id FROM teas.sessions WHERE user_id = @u", new NpgsqlParameter("u", other.Id));

        var nope = await H.Post($"/auth/sessions/{strangerId}/revoke", token: a);          // somebody else's: it does not exist for you
        Assert.Equal((HttpStatusCode.NotFound, "auth.session_not_found"), (nope.Status, nope.Code));
        Assert.Equal("auth.session_not_found", (await H.Post($"/auth/sessions/{Guid.NewGuid()}/revoke", token: a)).Code);
        Assert.Equal(HttpStatusCode.OK, (await H.Get("/auth/profile", strangers)).Status);

        var self = items.First(i => i.GetProperty("current").GetBoolean()).GetProperty("id").GetGuid();
        var otherSessionId = items.Select(i => i.GetProperty("id").GetGuid()).First(id => id != self);
        var rev = await H.Post($"/auth/sessions/{otherSessionId}/revoke", token: a);
        Assert.Equal("""{"signedOut":false}""", rev.Raw);
        Assert.Equal("auth.unauthenticated", (await H.Get("/auth/profile", b)).Code);          // b was the other session
        Assert.Equal("auth.session_not_found", (await H.Post($"/auth/sessions/{otherSessionId}/revoke", token: a)).Code);   // already revoked

        var gone = await H.Post($"/auth/sessions/{self}/revoke", token: a);
        Assert.Equal("""{"signedOut":true}""", gone.Raw);
        Assert.Equal("auth.unauthenticated", (await H.Get("/auth/profile", a)).Code);
    }

    [Fact]
    public async Task APasswordChangeEndsEveryOtherSessionAndKeepsThisOne()
    {
        var u = await H.CreateUserAsync();
        var a = await H.LoginAsync(u);
        var b = await H.LoginAsync(u);
        const string next = "Another#Pass42";

        var bad = await H.Post("/auth/password", new { current = "Wrong#Pass123", next, confirm = next }, a);
        Assert.Equal((HttpStatusCode.UnprocessableEntity, "auth.current_password_invalid"), (bad.Status, bad.Code));
        Assert.Equal("auth.password_mismatch", (await H.Post("/auth/password", new { current = u.Password, next, confirm = next + "x" }, a)).Code);
        Assert.Equal("auth.password_weak", (await H.Post("/auth/password", new { current = u.Password, next = "short", confirm = "short" }, a)).Code);
        Assert.Equal("auth.password_reuse", (await H.Post("/auth/password", new { current = u.Password, next = u.Password, confirm = u.Password }, a)).Code);
        Assert.Equal(HttpStatusCode.OK, (await H.Get("/auth/profile", b)).Status);      // nothing above changed anything

        var ok = await H.Post("/auth/password", new { current = u.Password, next, confirm = next }, a);
        Assert.Equal("""{"status":"ok"}""", ok.Raw);
        Assert.Equal(HttpStatusCode.OK, (await H.Get("/auth/profile", a)).Status);
        Assert.Equal("auth.unauthenticated", (await H.Get("/auth/profile", b)).Code);
        Assert.Equal("auth.invalid_credentials", (await H.Post("/auth/login", new { email = u.Email, password = u.Password })).Code);
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/login", new { email = u.Email, password = next })).Status);
    }

    // ---------------------------------------------------------------- relogin

    [Fact]
    public async Task ReloginOnlyFromAnExpiredSessionOfTheSameUser()
    {
        var u = await H.CreateUserAsync();
        var other = await H.CreateUserAsync();
        var t = await H.LoginAsync(u);
        var otherToken = await H.LoginAsync(other);

        var none = await H.Post("/auth/relogin", new { password = u.Password });
        Assert.Equal((HttpStatusCode.Unauthorized, "auth.unauthenticated"), (none.Status, none.Code));
        var live = await H.Post("/auth/relogin", new { password = u.Password }, t);
        Assert.Equal((HttpStatusCode.Conflict, "auth.not_expired"), (live.Status, live.Code));

        H.Clock.Advance(61 * Min);
        var wrong = await H.Post("/auth/relogin", new { password = other.Password + "x" }, t);
        Assert.Equal("auth.invalid_credentials", wrong.Code);
        var fresh = await H.Post("/auth/relogin", new { password = u.Password }, t);
        Assert.Equal("""{"status":"ok"}""", fresh.Raw);
        var newToken = fresh.Token;
        Assert.NotNull(newToken);
        Assert.NotEqual(t, newToken);
        Assert.Equal("out", (await StateAsync(t)).Item2);                                   // the old session ended
        var profile = await H.Get("/auth/profile", newToken);
        Assert.Equal(u.Email, profile.Str("email"));
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.sessions WHERE user_id = @u AND revoked_at IS NULL", new NpgsqlParameter("u", other.Id)));   // the other user's session is untouched
        Assert.NotNull(otherToken);
    }

    [Fact]
    public async Task ReloginCannotSignInAsAnotherUserEvenWithTheirPassword()
    {
        var u = await H.CreateUserAsync();
        var other = await H.CreateUserAsync();
        const string theirs = "Their#Password77";
        await H.ExecGlobalAsync("UPDATE teas.users SET password_hash = @h WHERE id = @i", new NpgsqlParameter("h", AuthHost.Hasher.Hash(theirs)), new NpgsqlParameter("i", other.Id));
        var t = await H.LoginAsync(u);
        H.Clock.Advance(61 * Min);
        var r = await H.Post("/auth/relogin", new { password = theirs }, t);
        Assert.Equal("auth.invalid_credentials", r.Code);
        Assert.Null(r.Token);
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.sessions WHERE user_id = @u AND revoked_at IS NULL AND created_at > @t", new NpgsqlParameter("u", other.Id), new NpgsqlParameter("t", H.Now.AddMinutes(-1))));
    }

    [Fact]
    public async Task ReloginAfterTheAbsoluteLimitIsOut()
    {
        var u = await H.CreateUserAsync();
        var t = await H.LoginAsync(u);
        H.Clock.Advance(TimeSpan.FromHours(12) + Min);
        var r = await H.Post("/auth/relogin", new { password = u.Password }, t);
        Assert.Equal((HttpStatusCode.Unauthorized, "auth.unauthenticated"), (r.Status, r.Code));
    }

    [Fact]
    public async Task ReloginAsksForTheSecondFactorWhenEnrolled()
    {
        var u = await H.CreateUserAsync(totp: true);
        var login = await H.Post("/auth/login", new { email = u.Email, password = u.Password });
        var step1 = await H.Post("/auth/totp", new { challenge = login.Str("challenge"), code = H.CodeOf(u) });
        var t = step1.Token!;
        H.Clock.Advance(61 * Min);

        var need = await H.Post("/auth/relogin", new { password = u.Password }, t);
        Assert.Equal("""{"status":"totp_required"}""", need.Raw);
        Assert.Null(need.Token);
        Assert.Equal("auth.totp_invalid", (await H.Post("/auth/relogin", new { password = u.Password, code = "000000" }, t)).Code);
        var done = await H.Post("/auth/relogin", new { password = u.Password, code = H.CodeOf(u) }, t);
        Assert.Equal("""{"status":"ok"}""", done.Raw);
        Assert.NotNull(done.Token);
        Assert.NotEqual(t, done.Token);
    }
}
