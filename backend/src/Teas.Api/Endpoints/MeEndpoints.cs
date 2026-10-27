using Teas.Api.Routing;
using Teas.App.Platform.Auth;
using Teas.App.Platform.Companies;
using Teas.Domain;

namespace Teas.Api.Endpoints;

/// <summary>Small helpers the P8 endpoint files share.</summary>
internal static class Ep
{
    public static T Svc<T>(HttpContext h) where T : notnull => h.RequestServices.GetRequiredService<T>();
    public static CancellationToken Ct(HttpContext h) => h.RequestAborted;
    public static SessionInfo Session(HttpContext h) => h.Items[SessionAuthentication.ItemKey] as SessionInfo ?? throw new TeasException("auth.unauthenticated");

    /// <summary>An answer that carries a secret (an invite / reset link) is never cached.</summary>
    public static RouteHandlerBuilder NoStore(this RouteHandlerBuilder b) =>
        b.AddEndpointFilter(async (ctx, next) => { ctx.HttpContext.Response.Headers.CacheControl = "no-store"; return await next(ctx); });
}

public sealed record ActiveCompanyBody(string CompanyId);

/// <summary>Routes 15-16. Handlers only translate HTTP to CompanyService.</summary>
public static class MeEndpoints
{
    public static void MapMeRoutes(this IEndpointRouteBuilder g)
    {
        g.MapRoute(new RouteSpec("GET", "/me", "session"), (HttpContext h) => Ep.Svc<CompanyService>(h).MeAsync(Ep.Session(h), Ep.Ct(h)));

        g.MapRoute(new RouteSpec("POST", "/me/active-company", "session", Audit: "company.switch"),
            (ActiveCompanyBody b, HttpContext h) => Ep.Svc<CompanyService>(h).SwitchAsync(Ep.Session(h), b.CompanyId, Ep.Ct(h)));
    }
}
