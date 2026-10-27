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
}

public static class RouteGuards
{
    /// <summary>The BFF secret check, then RouteAuthorization. Both are decided by endpoint metadata, never by path.</summary>
    public static IApplicationBuilder UseTeasRouteGuards(this IApplicationBuilder app) =>
        app.UseMiddleware<BffSecretMiddleware>().UseMiddleware<RouteAuthorization>();
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
        if (http.GetEndpoint() is not { } endpoint) { await next(http); return; }
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
            await RefuseAsync(spec, scope, audit, spec.Path.StartsWith("/settings", StringComparison.Ordinal) ? "agent.forbidden_setting" : "agent.forbidden_action", null);
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
            if (!held.Contains(needed)) await RefuseAsync(spec, scope, audit, "auth.forbidden", needed);
        }
        await next(http);
    }

    static async Task RefuseAsync(RouteSpec spec, TenantScope scope, IAudit audit, string code, string? missing)
    {
        // a row needs a company; a request with none (no membership yet) is refused without one
        if (scope.Current.CompanyId is not null) await audit.RecordRejectedAsync(spec.Audit ?? $"{spec.Method} {spec.Path}", spec.Path);
        throw new TeasException(code, missing is null ? null : $"missing permission: {missing}");
    }
}
