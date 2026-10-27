using System.Text.Json.Serialization;
using Microsoft.AspNetCore.DataProtection;
using Teas.Api.OpenApi;
using Teas.Api.Routing;
using Teas.App.Platform;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Auth;
using Teas.Domain;

namespace Teas.Api.Endpoints;

// ---- wire types (SP3 5.1 / 5.3 routes 1-14). A `{status:'ok'}` is a one-member enum so the generated TypeScript is the literal 'ok'. ----
public enum OkStatus { [JsonStringEnumMemberName("ok")] Ok }
public enum TotpRequiredStatus { [JsonStringEnumMemberName("totp_required")] TotpRequired }
public enum ReloginStatus { [JsonStringEnumMemberName("ok")] Ok, [JsonStringEnumMemberName("totp_required")] TotpRequired }
public enum ActiveState { [JsonStringEnumMemberName("active")] Active }
public enum OutState { [JsonStringEnumMemberName("out")] Out }
public enum LinkKind { [JsonStringEnumMemberName("invite")] Invite, [JsonStringEnumMemberName("reset")] Reset }

public sealed record StatusOk(OkStatus Status);
public sealed record LoginTotpRequired(TotpRequiredStatus Status, string Challenge);
/// <summary>Documents route 1's answer, LoginResult = {status:'ok'} | {status:'totp_required', challenge}; never instantiated.</summary>
[OneOf(typeof(StatusOk), typeof(LoginTotpRequired))]
public sealed class LoginResultBody;
public sealed record ReloginBody(ReloginStatus Status);
public sealed record SessionStatus(SessionState State, string? Email = null, int? ExpiresInSec = null);
public sealed record ExtendedBody(ActiveState State);
public sealed record LoggedOutBody(OutState State);
public sealed record EnrolStarted(string Secret, string Uri);
public sealed record RecoveryCodesBody(IReadOnlyList<string> RecoveryCodes);
public sealed record SessionsBody(IReadOnlyList<SessionRow> Items);
public sealed record SignedOutBody(bool SignedOut);
public sealed record LinkInfo(LinkKind Kind, string Email, DateTimeOffset ExpiresAt, bool ExistingAccount, string? CompanyName = null);

public sealed record LoginBody(string Email, string Password);
public sealed record TotpBody(string Challenge, string? Code = null, string? RecoveryCode = null);
public sealed record ReloginRequest(string Password, string? Code = null, string? RecoveryCode = null);
public sealed record PasswordBody(string Current, string Next, string Confirm);
public sealed record EnrolVerifyBody(string Code);
public sealed record SetPasswordBody(string Password, string Confirm);

/// <summary>Routes 1-14 of the frozen contract. Handlers only translate HTTP to the App services; every rule lives in AuthService / LinkService.</summary>
public static class AuthEndpoints
{
    static T Svc<T>(HttpContext h) where T : notnull => h.RequestServices.GetRequiredService<T>();
    static RequestInfo Req(HttpContext h) => new(h.Connection.RemoteIpAddress, h.Request.Headers.UserAgent.ToString());
    static string? Cookie(HttpContext h) => h.Request.Cookies[SessionCookie.NameFor(h.RequestServices.GetRequiredService<IHostEnvironment>())];
    static SessionInfo Me(HttpContext h) => h.Items[SessionAuthentication.ItemKey] as SessionInfo ?? throw new TeasException("auth.unauthenticated");
    static CancellationToken Ct(HttpContext h) => h.RequestAborted;

    /// <summary>Auth answers carry a session or a secret: never cached.</summary>
    static RouteHandlerBuilder R(this IEndpointRouteBuilder g, RouteSpec spec, Delegate handler) =>
        g.MapRoute(spec, handler).AddEndpointFilter(async (ctx, next) => { ctx.HttpContext.Response.Headers.CacheControl = "no-store"; return await next(ctx); });

    public static void MapAuthRoutes(this IEndpointRouteBuilder g)
    {
        g.R(new RouteSpec("POST", "/auth/login", "public", Audit: "auth.login"), async (LoginBody b, HttpContext h) =>
        {
            var r = await Svc<AuthService>(h).LoginAsync(b.Email, b.Password, Cookie(h), Req(h), Ct(h));
            if (r.Session is not { } s) return Results.Ok(new LoginTotpRequired(TotpRequiredStatus.TotpRequired, r.Challenge!));
            SessionCookie.Set(h, s.Token);
            return Results.Ok(new StatusOk(OkStatus.Ok));
        }).Produces<LoginResultBody>();

        g.R(new RouteSpec("POST", "/auth/totp", "public", Audit: "auth.login"), async (TotpBody b, HttpContext h) =>
        {
            var s = await Svc<AuthService>(h).VerifyTotpAsync(b.Challenge, b.Code, b.RecoveryCode, Cookie(h), Req(h), Ct(h));
            SessionCookie.Set(h, s.Token);
            return new StatusOk(OkStatus.Ok);
        });

        g.R(new RouteSpec("GET", "/auth/session", "public"), async (HttpContext h) =>
        {
            // never extends (the expiry dialog polls it); names nobody unless there is a session row to name (live or expired)
            var s = await Svc<SessionService>(h).ResolveAsync(Cookie(h), Ct(h));
            return s is null ? new SessionStatus(SessionState.Out) : new SessionStatus(s.State, s.Email, s.ExpiresInSec);
        });

        g.R(new RouteSpec("POST", "/auth/session/extend", "session"), async (HttpContext h) =>
        {
            await Svc<AuthService>(h).ExtendAsync(Me(h), Ct(h));
            return new ExtendedBody(ActiveState.Active);
        });

        g.R(new RouteSpec("POST", "/auth/logout", "public", Audit: "auth.logout"), async (HttpContext h) =>
        {
            await Svc<AuthService>(h).LogoutAsync(Cookie(h), Req(h), Ct(h));
            SessionCookie.Clear(h);
            return new LoggedOutBody(OutState.Out);
        });

        g.R(new RouteSpec("POST", "/auth/relogin", "session-or-expired", Audit: "auth.login"), async (ReloginRequest b, HttpContext h) =>
        {
            var r = await Svc<AuthService>(h).ReloginAsync(Cookie(h), b.Password, b.Code, b.RecoveryCode, Req(h), Ct(h));
            if (r.Session is { } s) SessionCookie.Set(h, s.Token);
            return new ReloginBody(r.Session is null ? ReloginStatus.TotpRequired : ReloginStatus.Ok);
        });

        g.R(new RouteSpec("GET", "/auth/profile", "session"), (HttpContext h) => Svc<AuthService>(h).ProfileAsync(Me(h), Ct(h)));

        g.R(new RouteSpec("POST", "/auth/password", "session", Audit: "auth.password.change"), async (PasswordBody b, HttpContext h) =>
        {
            await Svc<AuthService>(h).ChangePasswordAsync(Me(h), b.Current, b.Next, b.Confirm, Req(h), Ct(h));
            return new StatusOk(OkStatus.Ok);
        });

        g.R(new RouteSpec("POST", "/auth/totp/enrol", "session", Audit: "auth.totp.enrol_start"), async (HttpContext h) =>
        {
            var (secret, uri) = await Svc<AuthService>(h).StartEnrolAsync(Me(h), Req(h), Ct(h));
            return new EnrolStarted(secret, uri);
        });

        g.R(new RouteSpec("POST", "/auth/totp/enrol/verify", "session", Audit: "auth.totp.enable"), async (EnrolVerifyBody b, HttpContext h) =>
            new RecoveryCodesBody(await Svc<AuthService>(h).ConfirmEnrolAsync(Me(h), b.Code, Req(h), Ct(h))));

        g.R(new RouteSpec("GET", "/auth/sessions", "session"), async (HttpContext h) => new SessionsBody(await Svc<SessionService>(h).ListAsync(Me(h), Ct(h))));

        g.R(new RouteSpec("POST", "/auth/sessions/{id}/revoke", "session", Audit: "auth.session.revoke"), async (string id, HttpContext h) =>
        {
            var signedOut = await Svc<AuthService>(h).RevokeSessionAsync(Me(h), Guid.TryParse(id, out var sid) ? sid : throw new TeasException("auth.session_not_found"), Req(h), Ct(h));
            if (signedOut) SessionCookie.Clear(h);
            return new SignedOutBody(signedOut);
        });

        g.R(new RouteSpec("GET", "/auth/links/{token}", "public"), async (string token, HttpContext h) =>
        {
            var i = await Svc<LinkService>(h).InfoAsync(token, Ct(h));
            return new LinkInfo(i.Kind == UserLinks.Invite ? LinkKind.Invite : LinkKind.Reset, i.Email, i.ExpiresAt, i.ExistingAccount, i.CompanyName);
        });

        g.R(new RouteSpec("POST", "/auth/links/{token}", "public", Audit: "user.accept_invite | auth.password.reset"), async (string token, SetPasswordBody b, HttpContext h) =>
        {
            // an existing-account invite is accepted only from that user's own live session; the service decides, we only look the cookie up
            var signedIn = await Svc<SessionService>(h).ResolveAsync(Cookie(h), Ct(h));
            await Svc<LinkService>(h).AcceptAsync(token, b.Password, b.Confirm, signedIn, Req(h), Ct(h));
            return new StatusOk(OkStatus.Ok);
        });
    }
}

/// <summary>Cookie flags exactly per SP3 4.4: <c>__Host-teas_session=&lt;token&gt;; Path=/; HttpOnly; Secure; SameSite=Lax</c>; Development over http: <c>teas_session</c>, no Secure.</summary>
public static class SessionCookie
{
    public static string NameFor(IHostEnvironment env) => env.IsDevelopment() ? "teas_session" : "__Host-teas_session";

    static string Flags(IHostEnvironment env) => env.IsDevelopment() ? "; Path=/; HttpOnly; SameSite=Lax" : "; Path=/; HttpOnly; Secure; SameSite=Lax";

    public static void Set(HttpContext h, string token)
    {
        var env = h.RequestServices.GetRequiredService<IHostEnvironment>();
        h.Response.Headers.Append("Set-Cookie", NameFor(env) + "=" + token + Flags(env));
    }

    public static void Clear(HttpContext h)
    {
        var env = h.RequestServices.GetRequiredService<IHostEnvironment>();
        h.Response.Headers.Append("Set-Cookie", NameFor(env) + "=" + Flags(env) + "; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    }
}

/// <summary>
/// Authentication for routes declared "session" / "session-or-expired" (runs after the BFF secret and before RouteAuthorization; skips a request that already
/// has an actor). A live session fills AuditContext.Actor, extends the idle expiry (at most once per 60 s) and enters the company scope. An expired one is
/// 401 auth.session_expired, except on relogin, which may use it (the handler insists it is expired). No cookie / unknown / revoked: nothing is filled and
/// RouteAuthorization answers 401 auth.unauthenticated.
/// </summary>
public sealed class SessionAuthentication(RequestDelegate next, IHostEnvironment env)
{
    public const string ItemKey = "TeasSession";   // (not dotted lower-case: the error-code literal scan would take it for a code)

    public async Task InvokeAsync(HttpContext http)
    {
        var sp = http.RequestServices;
        if (http.GetEndpoint()?.Metadata.GetMetadata<RouteSpec>() is not { Auth: "session" or "session-or-expired" } spec
            || sp.GetService<AuditContext>() is not { Actor: null } actor
            || sp.GetService<SessionService>() is not { } sessions
            || sp.GetService<TenantScope>() is not { } scope
            || http.Request.Cookies[SessionCookie.NameFor(env)] is not { Length: > 0 } token)
        {
            await next(http);
            return;
        }
        var s = await sessions.ResolveAsync(token, http.RequestAborted);
        if (s is null) { await next(http); return; }
        if (s.State == SessionState.Expired)
        {
            if (spec.Auth != "session-or-expired") throw new TeasException("auth.session_expired");
            actor.Actor = new AuditActor("user", s.UserId.ToString(), s.DisplayName);
            await next(http);
            return;
        }
        await sessions.TouchAsync(s, force: false, http.RequestAborted);
        actor.Actor = new AuditActor("user", s.UserId.ToString(), s.DisplayName);
        actor.Client = "web";
        actor.Ip = http.Connection.RemoteIpAddress;
        http.Items[ItemKey] = s;
        using var _ = s.ActiveCompanyId is { } company ? scope.Enter(company, s.UserId) : null;
        await next(http);
    }
}

/// <summary>TOTP secrets are encrypted with ASP.NET Data Protection, purpose teas.totp.v1; the key ring lives on TEAS_DP_KEYS_DIR (SP3 4.4).</summary>
public sealed class DataProtectionSecretProtector(IDataProtectionProvider provider) : ISecretProtector
{
    readonly IDataProtector _protector = provider.CreateProtector("teas.totp.v1");
    public byte[] Protect(byte[] plain) => _protector.Protect(plain);
    public byte[] Unprotect(byte[] cipher) => _protector.Unprotect(cipher);
}
