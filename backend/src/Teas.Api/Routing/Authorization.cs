using Microsoft.AspNetCore.RateLimiting;
using Teas.Api.Startup;
using Teas.App.Platform;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Rights;
using Teas.Domain;
using Teas.Domain.Platform;

namespace Teas.Api.Routing;

/// <summary>Endpoint metadata: a health / version probe, the only endpoints allowed to have no <see cref="RouteSpec"/>.</summary>
public sealed class Probe
{
    public static readonly Probe Marker = new();
}

/// <summary>SP3 4.6 / 4.5: what a route must declare.</summary>
public static class RouteDeclaration
{
    /// <summary>Exactly one of: public, session, a permission. Null = well declared, else why not.</summary>
    public static string? Problem(RouteSpec? spec) => spec switch
    {
        null => "no RouteSpec (an undeclared route)",
        { Auth: not ("public" or "session" or "session-or-expired" or "key") } => $"unknown auth '{spec.Auth}'",
        { Auth: "public", Permission: not null } => "public and a permission together",
        { Auth: "public", Agent: true } => "a public route cannot be an agent route",
        { Permission: not null } when !PermissionCatalog.CodeSet.Contains(spec.Permission) => $"permission '{spec.Permission}' is not in the catalog",
        { Agent: true, Permission: not null } when AgentRules.AgentForbidden(spec.Permission) => $"an agent route cannot require '{spec.Permission}': no agent ever holds it",
        _ => null,
    };

    /// <summary>Non-GET routes that write no audit row by design: a session heartbeat (the frozen contract has no audit command for it) and the MCP JSON-RPC transport (its tools are the audited routes).</summary>
    public static readonly IReadOnlySet<string> NotAudited = new HashSet<string> { "POST /auth/session/extend", "POST /mcp" };

    /// <summary>SP3 4.7 coverage: every route with a method other than GET declares the audit command it writes (checked over the registered routes by a test, not at request time).</summary>
    public static string? AuditProblem(RouteSpec spec) =>
        spec.Method != "GET" && spec.Audit is null && !NotAudited.Contains($"{spec.Method} {spec.Path}") ? $"{spec.Method} {spec.Path} declares no Audit command" : null;
}

public static class RouteGuards
{
    /// <summary>The BFF secret check, then the rate limiter (after the secret, so a client-IP header set by the BFF can be trusted: P10), then session authentication, then API-key authentication of the machine surface (each fills the actor and the company scope), then RouteAuthorization. All decided by endpoint metadata, never by path.</summary>
    public static IApplicationBuilder UseTeasRouteGuards(this IApplicationBuilder app) =>
        app.UseMiddleware<BffSecretMiddleware>().UseRateLimiter().UseMiddleware<Teas.Api.Endpoints.SessionAuthentication>().UseMiddleware<Teas.Api.Auth.ApiKeyAuthentication>().UseMiddleware<RouteAuthorization>();
}

/// <summary>
/// Runs after authentication (which enters the company scope and fills <see cref="AuditContext.Actor"/>) and BEFORE the endpoint:
/// the body is not read, nothing is claimed in IdempotencyRunner. Fails closed, by metadata: an endpoint with a <see cref="RouteSpec"/>
/// is enforced wherever it is mapped; an endpoint with none is refused (500, a programming error) unless it is a <see cref="Probe"/>.
/// A refusal writes one 'rejected' audit row (inside the company scope, outside any transaction) and answers 403, the detail naming the
/// missing permission. A caller that is neither a user nor an agent, or that cannot be told apart, is 401 auth.unauthenticated.
/// Without the rights services (no connection string) every non-public endpoint is 401.
/// </summary>
public sealed class RouteAuthorization(RequestDelegate next)
{
    static readonly IReadOnlySet<string> None = new HashSet<string>();

    public async Task InvokeAsync(HttpContext http)
    {
        // only routes are decided: the framework's own endpoints (405 for a wrong method, a CORS preflight) pass through, they run no handler
        if (http.GetEndpoint() is not RouteEndpoint endpoint) { await next(http); return; }
        if (endpoint.Metadata.GetMetadata<RouteSpec>() is not { } spec)
        {
            if (endpoint.Metadata.GetMetadata<Probe>() is not null) { await next(http); return; }
            throw new InvalidOperationException($"{endpoint.DisplayName}: no RouteSpec and not a probe (an undeclared route)");
        }
        if (RouteDeclaration.Problem(spec) is { } bad) throw new InvalidOperationException($"{endpoint.DisplayName}: {bad}");
        if (spec.Auth == "public") { await next(http); return; }

        var sp = http.RequestServices;
        if (sp.GetService<AuditContext>() is not { } actor || sp.GetService<TenantScope>() is not { } scope || sp.GetService<EffectiveRights>() is not { } rights
            || sp.GetService<ActorScopes>() is not { } scopes || sp.GetService<IAudit>() is not { } audit)
            throw new TeasException("auth.unauthenticated");

        var who = actor.Actor ?? throw new TeasException("auth.unauthenticated");
        if (who.Kind is not ("user" or "agent")) throw new TeasException("auth.unauthenticated");
        var isAgent = who.Kind == "agent";
        if (isAgent && !spec.Agent)
            await RefuseAsync(http, spec, scope, audit, spec.Path.StartsWith("/settings", StringComparison.Ordinal) ? "agent.forbidden_setting" : "agent.forbidden_action", null);
        if (spec.Permission is { } needed)
        {
            var held = None;
            if (scope.Current.CompanyId is not null)
            {
                if (isAgent)
                    held = AgentRules.AgentRights(scopes.Values ?? [], Guid.TryParse(who.OwnerId, out var owner) ? await rights.ForUserAsync(owner, http.RequestAborted) : None);
                else if (Guid.TryParse(who.Id, out var user))
                    held = await rights.ForUserAsync(user, http.RequestAborted);
            }
            if (!held.Contains(needed)) await RefuseAsync(http, spec, scope, audit, "auth.forbidden", needed);
        }
        await next(http);
    }

    static async Task RefuseAsync(HttpContext http, RouteSpec spec, TenantScope scope, IAudit audit, string code, string? missing)
    {
        // a row needs a company; a request with none (no membership yet) is refused without one
        if (scope.Current.CompanyId is not null) await audit.RecordRejectedAsync(AuditCommand(spec, http.Request.RouteValues), RequestTarget(http.Request.Path));
        throw new TeasException(code, missing is null ? null : $"missing permission: {missing}");
    }

    /// <summary>The path as the contract writes it (without the /internal/v1 group prefix), ids filled in: what the caller asked for, not the route template.</summary>
    internal static string RequestTarget(PathString path) =>
        path.Value is { } p && p.StartsWith(Teas.Api.OpenApi.OpenApiSetup.Prefix + "/", StringComparison.Ordinal) ? p[Teas.Api.OpenApi.OpenApiSetup.Prefix.Length..] : path.Value ?? "";

    /// <summary>
    /// The ONE command a rejected row carries. spec.Audit may hold a template ("company.update.&lt;section&gt;": filled from the route value) or alternatives
    /// ("a | b", "a + b"): the alternative whose last word is the request's last path segment (".../rotate"), else the first (a refused request's body is not
    /// read, so "user.activate | user.deactivate" cannot be told apart and records the first). No Audit: "METHOD path".
    /// </summary>
    internal static string AuditCommand(RouteSpec spec, RouteValueDictionary values)
    {
        if (spec.Audit is not { } audit) return $"{spec.Method} {spec.Path}";
        var last = spec.Path[(spec.Path.LastIndexOf('/') + 1)..];
        var alternatives = audit.Split([" | ", " + "], StringSplitOptions.TrimEntries);
        var one = alternatives.FirstOrDefault(a => a[(a.LastIndexOf('.') + 1)..] == last) ?? alternatives[0];
        return System.Text.RegularExpressions.Regex.Replace(one, @"<(\w+)>", m => values[m.Groups[1].Value] as string ?? m.Value);
    }
}
