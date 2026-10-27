using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Schema;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using Teas.Api.Routing;
using Teas.Domain;

namespace Teas.Api.Machine;

/// <summary>
/// A minimal MCP server over HTTP (SP3 4.6): one JSON-RPC 2.0 message per POST to /mcp (no batch, no SSE, no sessions), methods initialize, notifications/*, ping, tools/list, tools/call.
/// The tool list is generated from the endpoint table: every route with Agent = true and an McpTool attribute. A tool call runs the route itself: a sub-request carrying the arguments as its
/// JSON body goes through RouteAuthorization (agent and permission check, 'rejected' audit row) and then the route's own pipeline, in the same scope, actor and transaction rules as REST.
/// Tool arguments are the body of the route (path and query parameters are not supported; SP3 has only whoami). Input schema = System.Text.Json's schema of the route's body type.
/// </summary>
static class McpHost
{
    const string Latest = "2025-06-18";
    static readonly string[] Supported = [Latest, "2025-03-26", "2024-11-05"];

    sealed record Tool(string Name, string Description, RouteEndpoint Endpoint, RouteSpec Spec);

    public static async Task<IResult> HandleAsync(HttpContext h)
    {
        if (h.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit) limit.MaxRequestBodySize = 1_000_000;
        JsonDocument doc;
        try { doc = await JsonDocument.ParseAsync(h.Request.Body, cancellationToken: h.RequestAborted); }
        catch (JsonException) { return Failure(null, -32700, "Parse error", 400); }
        using var _ = doc;
        var root = doc.RootElement;
        JsonElement? id = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("id", out var i) ? i.Clone() : null;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("method", out var m) || m.ValueKind != JsonValueKind.String)
            return Failure(id, -32600, "Invalid Request", 400);   // includes a batch (an array): not supported
        var p = root.TryGetProperty("params", out var pp) ? pp : default;
        switch (m.GetString())
        {
            case "initialize":
                var asked = p.ValueKind == JsonValueKind.Object && p.TryGetProperty("protocolVersion", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                return Success(id, new
                {
                    protocolVersion = Supported.Contains(asked) ? asked : Latest,
                    capabilities = new { tools = new { listChanged = false } },
                    serverInfo = new { name = "teas", version = h.RequestServices.GetRequiredService<IConfiguration>()["TEAS_VERSION"] ?? "dev" },
                });
            case "ping": return Success(id, new { });
            case "tools/list":
                return Success(id, new { tools = Tools(h).Select(t => new { name = t.Name, description = t.Description, inputSchema = InputSchema(t.Endpoint) }).ToList() });
            case "tools/call": return await CallAsync(h, id, p);
            case { } method when id is null || method.StartsWith("notifications/", StringComparison.Ordinal): return Results.StatusCode(StatusCodes.Status202Accepted);
            default: return Failure(id, -32601, "Method not found");
        }
    }

    static List<Tool> Tools(HttpContext h) =>
        [.. h.RequestServices.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Select(e => (e, spec: e.Metadata.GetMetadata<RouteSpec>(), tool: e.Metadata.GetMetadata<McpToolAttribute>()))
            .Where(t => t.spec is { Agent: true, Auth: "key" } && t.tool is not null)
            .Select(t => new Tool(t.tool!.Name, t.tool.Description, t.e, t.spec!)).OrderBy(t => t.Name, StringComparer.Ordinal)];

    static JsonNode InputSchema(RouteEndpoint e) =>
        e.Metadata.GetMetadata<IAcceptsMetadata>()?.RequestType is { } body
            ? JsonSchemaExporter.GetJsonSchemaAsNode(JsonSerializerOptions.Web, body)
            : new JsonObject { ["type"] = "object", ["properties"] = new JsonObject() };

    static async Task<IResult> CallAsync(HttpContext h, JsonElement? id, JsonElement p)
    {
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("name", out var n) || n.ValueKind != JsonValueKind.String
            || Tools(h).FirstOrDefault(t => t.Name == n.GetString()) is not { } tool)
            return Failure(id, -32602, "Unknown tool");
        var args = p.TryGetProperty("arguments", out var a) ? a : default;
        if (args.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Object)) return Failure(id, -32602, "arguments must be an object");

        var sub = new DefaultHttpContext { RequestServices = h.RequestServices, RequestAborted = h.RequestAborted };
        sub.Request.Method = tool.Spec.Method;
        sub.Request.Path = tool.Spec.Path;
        if (tool.Spec.Method is not ("GET" or "HEAD" or "DELETE"))
        {
            sub.Request.ContentType = "application/json";
            sub.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(args.ValueKind == JsonValueKind.Object ? args.GetRawText() : "{}"));
        }
        if (h.Request.Headers.TryGetValue("Idempotency-Key", out var key)) sub.Request.Headers["Idempotency-Key"] = key;
        foreach (var (k, value) in h.Items) sub.Items[k] = value;
        sub.SetEndpoint(tool.Endpoint);
        var output = new MemoryStream();
        sub.Response.Body = output;
        string text;
        bool error;
        try
        {
            await new RouteAuthorization(tool.Endpoint.RequestDelegate!).InvokeAsync(sub);
            text = Encoding.UTF8.GetString(output.ToArray());
            error = sub.Response.StatusCode >= 400;
        }
        catch (TeasException e)
        {
            text = JsonSerializer.Serialize(new { code = e.Code, status = e.Status, title = ErrorCodes.All[e.Code].En, detail = e.Detail }, JsonSerializerOptions.Web);
            error = true;
        }
        var result = new Dictionary<string, object?> { ["content"] = new[] { new { type = "text", text } }, ["isError"] = error };
        if (!error && text.Length > 0 && TryParse(text) is { } structured) result["structuredContent"] = structured;
        return Success(id, result);
    }

    static JsonElement? TryParse(string text)
    {
        try { return JsonDocument.Parse(text).RootElement.Clone(); }
        catch (JsonException) { return null; }
    }

    static IResult Success(JsonElement? id, object result) => Results.Json(new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["id"] = id, ["result"] = result });

    static IResult Failure(JsonElement? id, int code, string message, int status = 200) =>
        Results.Json(new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["id"] = id, ["error"] = new { code, message } }, statusCode: status);
}
