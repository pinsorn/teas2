using Microsoft.AspNetCore.Mvc;
using Teas.Api.Routing;
using Teas.App.Platform.Roles;

namespace Teas.Api.Endpoints;

public sealed record RoleBody(string Name, IReadOnlyList<string> Permissions, string? Description = null);
/// <summary>Every member but version is optional: absent = unchanged; description "" clears it.</summary>
public sealed record UpdateRoleBody(int Version, string? Name = null, string? Description = null, IReadOnlyList<string>? Permissions = null);
public sealed record RolesBody(IReadOnlyList<RoleView> Items);
public sealed record OkTrueBody([property: LiteralTrue] bool Ok);

/// <summary>Routes 26-29.</summary>
public static class RolesEndpoints
{
    public static void MapRolesRoutes(this IEndpointRouteBuilder g)
    {
        g.MapRoute(new RouteSpec("GET", "/settings/roles", "session", "users.manage"),
            async (HttpContext h) => new RolesBody(await Ep.Svc<RoleService>(h).ListAsync(Ep.Ct(h))));

        g.MapRoute(new RouteSpec("POST", "/settings/roles", "session", "users.manage", Audit: "role.create"),
            async (RoleBody b, HttpContext h) => Results.Json(await Ep.Svc<RoleService>(h).CreateAsync(b.Name, b.Description, b.Permissions, Ep.Ct(h)), statusCode: 201))
            .Produces<RoleView>(201);

        g.MapRoute(new RouteSpec("PUT", "/settings/roles/{id}", "session", "users.manage", Concurrency: "version-body", Audit: "role.update"),
            (string id, UpdateRoleBody b, HttpContext h) => Ep.Svc<RoleService>(h).UpdateAsync(id, b.Version, b.Name, b.Description, b.Permissions, Ep.Session(h).UserId, Ep.Ct(h)));

        g.MapRoute(new RouteSpec("DELETE", "/settings/roles/{id}", "session", "users.manage", Concurrency: "version-query", Audit: "role.delete"),
            async (string id, [FromQuery] int version, HttpContext h) =>
            {
                await Ep.Svc<RoleService>(h).DeleteAsync(id, version, Ep.Ct(h));
                return new OkTrueBody(true);
            });
    }
}
