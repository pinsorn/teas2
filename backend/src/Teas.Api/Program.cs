using Npgsql;
using Teas.Api.Startup;
using Teas.App;

var builder = WebApplication.CreateBuilder(args);

#pragma warning disable RS0030 // composition root: the one place the real clock is created
builder.Services.AddSingleton(TimeProvider.System);
#pragma warning restore RS0030

// ConnectionStrings:Teas = the teas_app login. Without it only a non-Production host starts (health / version tests).
var cs = builder.Configuration.GetConnectionString("Teas");
if (!string.IsNullOrWhiteSpace(cs)) builder.Services.AddTeasData(cs);
else if (builder.Environment.IsProduction()) throw new StartupGuardException("ConnectionStrings:Teas is not set");

var app = builder.Build();

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
internalV1.MapGet("/ping", () => Results.Ok(new { ok = true }));

app.Run();

public partial class Program;
