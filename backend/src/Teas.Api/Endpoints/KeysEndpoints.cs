using Teas.Api.Routing;
using Teas.App.Platform.Keys;

namespace Teas.Api.Endpoints;

/// <summary>`name`, `kind` and `scopes` are required: a body without them is a 422, never read as a default.</summary>
public sealed record ApiKeyBody
{
    public required string Name { get; init; }
    public required KeyKind Kind { get; init; }
    public required IReadOnlyList<string> Scopes { get; init; }
    public string? ExpiresAt { get; init; }
}

/// <summary>Routes 30-33. No route-level permission: every member has keys of their own; who may see, rotate or revoke which key is decided in KeyService (owner, or connect.manage).</summary>
public static class KeysEndpoints
{
    public static void MapKeysRoutes(this IEndpointRouteBuilder g)
    {
        g.MapRoute(new RouteSpec("GET", "/connect/keys", "session"), (HttpContext h) => Ep.Svc<KeyService>(h).ListAsync(Ep.Session(h).UserId, Ep.Ct(h))).NoStore();

        g.MapRoute(new RouteSpec("POST", "/connect/keys", "session", Audit: "connect.key.create"),
            async (ApiKeyBody b, HttpContext h) => Results.Json(await Ep.Svc<KeyService>(h).CreateAsync(Ep.Session(h).UserId, b.Name, b.Kind, b.Scopes, b.ExpiresAt, Ep.Ct(h)), statusCode: 201))
            .Produces<ApiKeyCreated>(201).NoStore();

        g.MapRoute(new RouteSpec("POST", "/connect/keys/{id}/rotate", "session", Concurrency: "version-body", Audit: "connect.key.rotate + connect.key.revoke"),
            async (string id, VersionBody b, HttpContext h) => Results.Json(await Ep.Svc<KeyService>(h).RotateAsync(Ep.Session(h).UserId, id, b.Version, Ep.Ct(h)), statusCode: 201))
            .Produces<ApiKeyCreated>(201).NoStore();

        g.MapRoute(new RouteSpec("POST", "/connect/keys/{id}/revoke", "session", Concurrency: "version-body", Audit: "connect.key.revoke"),
            (string id, VersionBody b, HttpContext h) => Ep.Svc<KeyService>(h).RevokeAsync(Ep.Session(h).UserId, id, b.Version, Ep.Ct(h)));
    }
}
