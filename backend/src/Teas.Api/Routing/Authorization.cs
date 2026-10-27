using Teas.App.Platform;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Rights;
using Teas.Domain;
using Teas.Domain.Platform;

namespace Teas.Api.Routing;

/// <summary>SP3 4.6 / 4.5: what a route must declare, and the check that decides a request against it.</summary>
public static class RouteDeclaration
{
    static readonly string[] Prefixes = ["/internal/v1", "/api/v1", "/mcp"];

    /// <summary>Contract routes live under the three groups; probes outside them (health, version) are not routes of the contract.</summary>
    public static bool IsContractPath(string pattern) => Prefixes.Any(p => pattern == p || pattern.StartsWith(p + "/", StringComparison.Ordinal));

    /// <summary>Exactly one of: public, session, a permission. Null = well declared, else why not.</summary>
    public static string? Problem(RouteSpec? spec) => spec switch
    {
        null => "no RouteSpec (an undeclared route)",
        { Auth: not ("public" or "session" or "session-or-expired" or "key") } => $"unknown auth '{spec.Auth}'",
        { Auth: "public", Permission: not null } => "public and a permission together",
        { Auth: "public", Agent: true } => "a public route cannot be an agent route",
        { Permission: not null } when !PermissionCatalog.CodeSet.Contains(spec.Permission) => $"permission '{spec.Permission}' is not in the catalog",
        _ => null,
    };
}

/// <summary>
/// Runs after authentication (which enters the company scope and fills <see cref="AuditContext.Actor"/>) and BEFORE the endpoint:
/// the body is not read, nothing is claimed in IdempotencyRunner. A refusal writes one 'rejected' audit row (inside the company scope,
/// outside any transaction) and answers 403; the detail names the missing permission.
/// </summary>
public sealed class RouteAuthorization(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext http, AuditContext actor, TenantScope scope, EffectiveRights rights, ActorScopes scopes, IAudit audit)
    {
        if (http.GetEndpoint() is not RouteEndpoint endpoint || !RouteDeclaration.IsContractPath(endpoint.RoutePattern.RawText ?? "")) { await next(http); return; }
        var spec = endpoint.Metadata.GetMetadata<RouteSpec>();
        if (RouteDeclaration.Problem(spec) is { } bad) throw new InvalidOperationException($"{endpoint.RoutePattern.RawText}: {bad}");
        if (spec!.Auth == "public") { await next(http); return; }

        var who = actor.Actor ?? throw new TeasException("auth.unauthenticated");
        var isAgent = who.Kind == "agent";
        if (isAgent && !spec.Agent)
            await RefuseAsync(spec, scope, audit, spec.Path.StartsWith("/settings", StringComparison.Ordinal) ? "agent.forbidden_setting" : "agent.forbidden_action", null);
        if (spec.Permission is { } needed)
        {
            IReadOnlySet<string> held = None;
            if (scope.Current.CompanyId is not null)
                held = isAgent
                    ? AgentRules.AgentRights(scopes.Values ?? [], Guid.TryParse(who.OwnerId, out var owner) ? await rights.ForUserAsync(owner, http.RequestAborted) : None)
                    : await rights.ForUserAsync(Guid.Parse(who.Id), http.RequestAborted);
            if (!held.Contains(needed)) await RefuseAsync(spec, scope, audit, "auth.forbidden", needed);
        }
        await next(http);
    }

    static readonly IReadOnlySet<string> None = new HashSet<string>();

    static async Task RefuseAsync(RouteSpec spec, TenantScope scope, IAudit audit, string code, string? missing)
    {
        // a row needs a company; a request with none (no membership yet) is refused without one
        if (scope.Current.CompanyId is not null) await audit.RecordRejectedAsync(spec.Audit ?? $"{spec.Method} {spec.Path}", spec.Path);
        throw new TeasException(code, missing is null ? null : $"missing permission: {missing}");
    }
}
