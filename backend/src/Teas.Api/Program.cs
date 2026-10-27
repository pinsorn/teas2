using Npgsql;
using Teas.Api.OpenApi;
using Teas.Api.Problems;
using Teas.Api.Routing;
using Teas.Api.Startup;
using Teas.App;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddTeasOpenApi().AddTeasProblems();

#pragma warning disable RS0030 // composition root: the one place the real clock is created
builder.Services.AddSingleton(TimeProvider.System);
#pragma warning restore RS0030

// ConnectionStrings:Teas = the teas_app login. Without it only a Development host starts (health / version tests).
var cs = builder.Configuration.GetConnectionString("Teas");
if (!string.IsNullOrWhiteSpace(cs)) builder.Services.AddTeasData(cs);

var app = builder.Build();
// The build-time OpenAPI generator (ApiDescription.Server) runs this program past Build() with no configuration (tried: moving the
// guards does not help, it stops only at app.Run()), so it is the one caller allowed to skip them.
var generatingDocs = System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name == "GetDocument.Insider";
if (!app.Environment.IsDevelopment() && !generatingDocs)
{
    if (string.IsNullOrWhiteSpace(cs)) throw new StartupGuardException("ConnectionStrings:Teas is not set");
    if ((app.Configuration["TEAS_BFF_SECRET"]?.Length ?? 0) < BffSecretFilter.MinLength)
        throw new StartupGuardException($"TEAS_BFF_SECRET must be set and at least {BffSecretFilter.MinLength} characters");
}
app.UseTeasProblems();

if (!string.IsNullOrWhiteSpace(cs)) await StartupGuards.RunAsync(cs);
// SP3 4.5 / 4.6: every contract route is decided against its RouteSpec before it runs (authentication, from P7 / P8, goes in front of this line).
if (!string.IsNullOrWhiteSpace(cs)) app.UseMiddleware<RouteAuthorization>();

app.MapGet("/health/live", () => Results.Ok(new { status = "live" }));
app.MapGet("/health/ready", async (CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(cs)) return Results.Json(new { db = "unconfigured" }, statusCode: 503);
    await using var conn = new NpgsqlConnection(cs);
    await conn.OpenAsync(ct);
    var schema = await StartupGuards.SchemaIdAsync(conn, ct);
    return schema == TeasDbContext.ExpectedSchema
        ? Results.Ok(new { db = "ok", schema })
        : Results.Json(new { db = "schema-mismatch", schema }, statusCode: 503);
});
app.MapGet("/version", () => Results.Ok(new { version = app.Configuration["TEAS_VERSION"] ?? "dev" }));

// The BFF-only surface. `ping` is the P2 probe route for S8; real routes arrive from P8 on.
var internalV1 = app.MapGroup("/internal/v1").AddEndpointFilter<BffSecretFilter>();
internalV1.MapRoute(new RouteSpec("GET", "/ping", "public"), () => Results.Ok(new { ok = true })).ExcludeFromDescription(); // a probe, not a contract route

app.Run();

public partial class Program;
