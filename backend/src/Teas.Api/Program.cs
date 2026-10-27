using Npgsql;
using Teas.Api.OpenApi;
using Teas.Api.Problems;
using Teas.Api.Startup;
using Teas.App;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddTeasOpenApi();
// The build-time OpenAPI generator (Microsoft.Extensions.ApiDescription.Server) boots the app with no configuration at all.
var generatingDocs = System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name == "GetDocument.Insider";

#pragma warning disable RS0030 // composition root: the one place the real clock is created
builder.Services.AddSingleton(TimeProvider.System);
#pragma warning restore RS0030

// ConnectionStrings:Teas = the teas_app login. Without it only a non-Production host starts (health / version tests).
var cs = builder.Configuration.GetConnectionString("Teas");
if (!string.IsNullOrWhiteSpace(cs)) builder.Services.AddTeasData(cs);
else if (!builder.Environment.IsDevelopment() && !generatingDocs) throw new StartupGuardException("ConnectionStrings:Teas is not set");

if (!builder.Environment.IsDevelopment() && !generatingDocs && (builder.Configuration["TEAS_BFF_SECRET"]?.Length ?? 0) < BffSecretFilter.MinLength)
    throw new StartupGuardException($"TEAS_BFF_SECRET must be set and at least {BffSecretFilter.MinLength} characters");

var app = builder.Build();
app.UseTeasProblems();

if (!string.IsNullOrWhiteSpace(cs)) await StartupGuards.RunAsync(cs);

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
internalV1.MapGet("/ping", () => Results.Ok(new { ok = true })).ExcludeFromDescription(); // a probe, not a contract route

app.Run();

public partial class Program;
