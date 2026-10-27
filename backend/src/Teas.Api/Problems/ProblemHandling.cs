using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.Options;
using Teas.Domain;

namespace Teas.Api.Problems;

/// <summary>SP3 4.7 / 5.1 wire form of every error (frontend ApiProblem). Absent members are omitted, not null.</summary>
public sealed record ApiProblem(string Title, int Status, string Code, string? Detail = null, string? TraceId = null,
    Dictionary<string, string[]>? FieldErrors = null)
{
    public string? Type { get; init; } = "about:blank"; // a property, not a ctor default: a schema default would make it required in the generated types
}

public static class ProblemHandling
{
    public const string ContentType = "application/problem+json";

    /// <summary>Renders any exception: a TeasException by its registry row, a malformed body as record.invalid, the rest as 500 http.500 (no internals).</summary>
    public static IApplicationBuilder UseTeasProblems(this IApplicationBuilder app) =>
        app.UseExceptionHandler(new ExceptionHandlerOptions { ExceptionHandler = WriteAsync });

    static async Task WriteAsync(HttpContext ctx)
    {
        var ex = ctx.Features.Get<IExceptionHandlerFeature>()?.Error;
        var (code, detail, fields) = ex switch
        {
            TeasException t => (t.Code, t.Detail, t.FieldErrors),
            BadHttpRequestException or JsonException => ("record.invalid", null, null),
            _ => ("http.500", null, null),
        };
        if (code == "http.500")
            ctx.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Teas.Api.Problems").LogError(ex, "Unhandled exception");
        var entry = ErrorCodes.All[code];
        var english = ctx.Request.Cookies["locale"] == "en";
        var problem = new ApiProblem(english ? entry.En : entry.Th, entry.Status, code, detail,
            (Activity.Current?.TraceId ?? ActivityTraceId.CreateRandom()).ToString(),
            fields?.ToDictionary(kv => kv.Key, kv => kv.Value));
        ctx.Response.Clear();
        ctx.Response.StatusCode = entry.Status;
        ctx.Response.ContentType = ContentType;
        await JsonSerializer.SerializeAsync(ctx.Response.Body, problem,
            ctx.RequestServices.GetRequiredService<IOptions<JsonOptions>>().Value.SerializerOptions, ctx.RequestAborted);
    }
}
