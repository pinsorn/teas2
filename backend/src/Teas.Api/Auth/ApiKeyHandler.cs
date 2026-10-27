using Teas.Api.Machine;
using Teas.Api.Routing;
using Teas.App.Platform;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Keys;
using Teas.App.Platform.Rights;
using Teas.Domain;

namespace Teas.Api.Auth;

/// <summary>
/// Authentication of the machine surface (/api/v1, /mcp), by endpoint metadata: a route carrying <see cref="MachineChannel"/> and declared "key". `Authorization: Bearer teas_&lt;kind&gt;_&lt;48 hex&gt;`
/// is looked up by its sha256 (KeyService), refused in order: unknown 401 connect.key_invalid, revoked 401, expired 401, a key of the other kind 403 connect.key_kind_mismatch. The channel's kind
/// is compared with the STORED kind of the key. On success the request runs in the key's company as the key's owner, and the actor is the agent (client api | mcp, the key's scopes in
/// <see cref="ActorScopes"/> for RouteAuthorization). No Bearer header (or another scheme) is 401 connect.key_invalid too; no header, cookie or query value ever names an actor.
/// </summary>
public sealed class ApiKeyAuthentication(RequestDelegate next)
{
    public const string ItemKey = "TeasKey";   // (not dotted lower-case: the error-code literal scan would take it for a code)

    public static KeyIdentity? Of(HttpContext http) => http.Items[ItemKey] as KeyIdentity;

    public async Task InvokeAsync(HttpContext http)
    {
        var sp = http.RequestServices;
        if (http.GetEndpoint()?.Metadata is not { } meta || meta.GetMetadata<MachineChannel>() is not { } channel || meta.GetMetadata<RouteSpec>() is not { Auth: "key" }
            || http.Items.ContainsKey(ItemKey)
            || sp.GetService<KeyService>() is not { } keys || sp.GetService<AuditContext>() is not { } actor || sp.GetService<TenantScope>() is not { } scope || sp.GetService<ActorScopes>() is not { } scopes)
        {
            await next(http);
            return;
        }
        var secret = Bearer(http) ?? throw new TeasException("connect.key_invalid");   // no Bearer header, or another scheme: no key was presented (SP3 8 step 4)
        var key = await keys.AuthenticateAsync(secret, http.RequestAborted);
        if (key.Kind != channel.Kind) throw new TeasException("connect.key_kind_mismatch");
        actor.Actor = new AuditActor("agent", key.Id.ToString(), key.Name, key.OwnerId.ToString(), key.OwnerName);
        actor.Client = key.Kind == "mcp" ? "mcp" : "api";
        actor.Ip = http.Connection.RemoteIpAddress;
        scopes.Values = key.Scopes;
        http.Items[ItemKey] = key;
        using var _ = scope.Enter(key.CompanyId, key.OwnerId);
        await keys.TouchAsync(key, http.RequestAborted);
        await next(http);
    }

    /// <summary>The token of a Bearer header; null when there is no Authorization header or it is another scheme. An empty token is "" (unknown).</summary>
    static string? Bearer(HttpContext http)
    {
        var h = http.Request.Headers.Authorization.ToString();
        if (!h.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return null;
        return h["Bearer ".Length..].Trim();
    }
}
