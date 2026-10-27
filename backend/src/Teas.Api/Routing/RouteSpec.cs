namespace Teas.Api.Routing;

/// <summary>SP3 4.6 route metadata (mirror of the frozen frontend RouteSpec). Enforcement arrives with P5 / P8; P3 carries it.</summary>
public sealed record RouteSpec(string Method, string Path, string Auth, string? Permission = null, bool Agent = false,
    bool IdempotencyRequired = false, string Concurrency = "none", string? Audit = null);

public static class RouteBuilder
{
    /// <summary>The one way a route is registered under the internal group: path is the contract path, the group adds /internal/v1.</summary>
    public static RouteHandlerBuilder MapRoute(this IEndpointRouteBuilder group, RouteSpec spec, Delegate handler) =>
        group.MapMethods(spec.Path, [spec.Method], handler).WithMetadata(spec);
}
