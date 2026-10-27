using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Builder;
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
    public static IApplicationBuilder UseTeasProblems(this IApplicationBuilder app)
    {
        // ASP.NET answers a body with the wrong Content-Type as a bare 415 (no exception); render it as the same record.invalid problem.
        app.UseStatusCodePages(ctx => ctx.HttpContext.Response.StatusCode == StatusCodes.Status415UnsupportedMediaType
            ? RenderAsync(ctx.HttpContext, "record.invalid", ErrorCodes.All["record.invalid"].Status, null, null)
            : Task.CompletedTask);
        return app.UseExceptionHandler(new ExceptionHandlerOptions { ExceptionHandler = WriteAsync });
    }

    /// <summary>A malformed body / binding failure throws (in every environment, not only Development) so it renders as 422 record.invalid.</summary>
    public static IServiceCollection AddTeasProblems(this IServiceCollection services) =>
        services.Configure<RouteHandlerOptions>(o => o.ThrowOnBadRequest = true);

    static async Task WriteAsync(HttpContext ctx)
    {
        var ex = ctx.Features.Get<IExceptionHandlerFeature>()?.Error;
        var log = ctx.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Teas.Api.Problems");
        if (ex is OperationCanceledException && ctx.RequestAborted.IsCancellationRequested)
        {
            log.LogInformation("Request cancelled by the client");
            ctx.Response.Clear();
            ctx.Response.StatusCode = 499;
            return;
        }
        // Every BadHttpRequestException (bad JSON, binding, and 415 unsupported content type) is record.invalid / 422: the frozen table has no 400 / 415 code.
        var (code, status, detail, fields) = ex switch
        {
            TeasException t => (t.Code, t.Status, t.Detail, t.FieldErrors),
            BadHttpRequestException or JsonException => ("record.invalid", ErrorCodes.All["record.invalid"].Status, null, null),
            _ => ("http.500", ErrorCodes.All["http.500"].Status, null, null),
        };
        if (code == "http.500") log.LogError(ex, "Unhandled exception");
        await RenderAsync(ctx, code, status, detail, fields);
    }

    static async Task RenderAsync(HttpContext ctx, string code, int status, string? detail, IReadOnlyDictionary<string, string[]>? fields)
    {
        var entry = ErrorCodes.All[code];
        var english = ctx.Request.Cookies["locale"] == "en";
        var problem = new ApiProblem(english ? entry.En : entry.Th, status, code, detail,
            (Activity.Current?.TraceId ?? ActivityTraceId.CreateRandom()).ToString(),
            fields?.ToDictionary(kv => kv.Key, kv => kv.Value));
        ctx.Response.Clear();
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = ContentType;
        await JsonSerializer.SerializeAsync(ctx.Response.Body, problem,
            ctx.RequestServices.GetRequiredService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>().Value.SerializerOptions, ctx.RequestAborted);
    }
}
