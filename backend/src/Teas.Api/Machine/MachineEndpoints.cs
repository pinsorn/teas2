using Teas.Api.Auth;
using Teas.Api.Endpoints;
using Teas.Api.Routing;
using Teas.App.Platform.Keys;
using Teas.Domain;

namespace Teas.Api.Machine;

/// <summary>Endpoint metadata of the machine surface: the endpoint is reached with an API key of this kind ("rest" on /api/v1, "mcp" on /mcp).</summary>
public sealed record MachineChannel(string Kind);

/// <summary>Marks an agent route as an MCP tool (SP3 4.6): the tool generator lists exactly the routes with Agent = true that carry it.</summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Delegate)]
public sealed class McpToolAttribute(string name, string description) : Attribute
{
    public string Name { get; } = name;
    public string Description { get; } = description;
}

/// <summary>
/// The machine surface (SP3 4.6): /api/v1 (REST key) and /mcp (MCP key). The ONE way a route is put there is <see cref="MapMachine"/>, which refuses at startup anything that is not an
/// agent route declared "key" on its channel's path; RouteAuthorization still refuses an agent on a non-agent route at run time, before the body is read.
/// </summary>
public static class MachineEndpoints
{
    /// <summary>SP3's only agent route is whoami (also the MCP tool of that name); /mcp is the JSON-RPC host.</summary>
    public static void MapMachineRoutes(this IEndpointRouteBuilder app)
    {
        app.MapMachine("rest", new RouteSpec("GET", "/api/v1/whoami", "key", Agent: true),
            [McpTool("whoami", "Who this key is: the agent, its owner, the company, and the rights the key holds right now.")] (HttpContext h) =>
                Ep.Svc<KeyService>(h).WhoAmIAsync(ApiKeyAuthentication.Of(h) ?? throw new TeasException("auth.unauthenticated"), Ep.Ct(h)));

        app.MapMachine("mcp", new RouteSpec("POST", "/mcp", "key", Agent: true), McpHost.HandleAsync).ExcludeFromDescription();
    }
}
