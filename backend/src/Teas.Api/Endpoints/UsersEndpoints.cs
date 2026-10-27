using Teas.Api.OpenApi;
using Teas.Api.Routing;
using Teas.App.Platform.Companies;
using Teas.App.Platform.Members;

namespace Teas.Api.Endpoints;

public sealed record InviteBody(string Name, string Email, string RoleId, string? Position = null);
/// <summary>signatureDataUrl: absent = keep, null or "" = remove, else a data URL (png / jpeg / webp, at most 1 MB).</summary>
public sealed record UpdateMemberBody
{
    public required int Version { get; init; }
    public string? Name { get; init; }
    public string? RoleId { get; init; }
    public string? Position { get; init; }
    public Optional<string?> SignatureDataUrl { get; init; }
}
/// <summary>`active` is required: a body without it is a 422, never read as false.</summary>
public sealed record ActiveBody { public required bool Active { get; init; } public required int Version { get; init; } }
public sealed record VersionBody(int Version);
public sealed record UsersBody(IReadOnlyList<UserRowView> Items);
public sealed record LinkBody(string Link);

/// <summary>Routes 20-25.</summary>
public static class UsersEndpoints
{
    public static void MapUsersRoutes(this IEndpointRouteBuilder g)
    {
        g.MapRoute(new RouteSpec("GET", "/settings/users", "session", "users.manage"),
            async (HttpContext h) => new UsersBody(await Ep.Svc<MemberService>(h).ListAsync(Ep.Ct(h))));

        g.MapRoute(new RouteSpec("POST", "/settings/users", "session", "users.manage", Audit: "user.invite"),
            async (InviteBody b, HttpContext h) => Results.Json(await Ep.Svc<MemberService>(h).InviteAsync(Ep.Session(h).UserId, b.Name, b.Email, b.RoleId, b.Position, Ep.Ct(h)), statusCode: 201))
            .Produces<InvitedUserView>(201).NoStore();

        g.MapRoute(new RouteSpec("PUT", "/settings/users/{id}", "session", "users.manage", Concurrency: "version-body", Audit: "user.update"),
            (string id, UpdateMemberBody b, HttpContext h) => Ep.Svc<MemberService>(h).UpdateAsync(Ep.Session(h).UserId, id, b.Version, b.Name, b.RoleId, b.Position,
                new ImageChange(b.SignatureDataUrl.IsSet, b.SignatureDataUrl.Value), Ep.Ct(h)));

        g.MapRoute(new RouteSpec("POST", "/settings/users/{id}/active", "session", "users.manage", Concurrency: "version-body", Audit: "user.activate | user.deactivate"),
            (string id, ActiveBody b, HttpContext h) => Ep.Svc<MemberService>(h).SetActiveAsync(Ep.Session(h).UserId, id, b.Active, b.Version, Ep.Ct(h)));

        g.MapRoute(new RouteSpec("POST", "/settings/users/{id}/reset-link", "session", "users.manage", Audit: "user.reset_link"),
            async (string id, HttpContext h) => new LinkBody(await Ep.Svc<MemberService>(h).ResetLinkAsync(Ep.Session(h).UserId, id, Ep.Ct(h)))).NoStore();

        g.MapRoute(new RouteSpec("POST", "/settings/users/{id}/totp-reset", "session", "users.manage", Concurrency: "version-body", Audit: "user.totp_reset"),
            (string id, VersionBody b, HttpContext h) => Ep.Svc<MemberService>(h).TotpResetAsync(Ep.Session(h).UserId, id, b.Version, Ep.Ct(h)));
    }
}
