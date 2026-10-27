using System.Threading.RateLimiting;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.RateLimiting;
using Npgsql;
using Teas.Api.Endpoints;
using Teas.Api.OpenApi;
using Teas.Api.Problems;
using Teas.Api.Routing;
using Teas.Api.Startup;
using Teas.App;
using Teas.App.Platform.Auth;
using Teas.Domain;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddTeasOpenApi().AddTeasProblems();
// A link token travels in the request path: the hosting "Request starting" line would write it to the log (SP3 S2).
builder.Logging.AddFilter("Microsoft.AspNetCore.Hosting.Diagnostics", LogLevel.Warning);
// An expected failure (a TeasException: 401 / 404 / 429 ...) is not an Error log with a stack trace; a real 500 is logged by ProblemHandling.
builder.Logging.AddFilter("Microsoft.AspNetCore.Diagnostics.ExceptionHandlerMiddleware", LogLevel.None);

// SP3 4.4: TOTP secrets are encrypted with Data Protection (purpose teas.totp.v1); the key ring is on the volume TEAS_DP_KEYS_DIR, backed up apart from the database.
var dataProtection = builder.Services.AddDataProtection().SetApplicationName("teas");
if (!string.IsNullOrWhiteSpace(builder.Configuration["TEAS_DP_KEYS_DIR"])) dataProtection.PersistKeysToFileSystem(new DirectoryInfo(builder.Configuration["TEAS_DP_KEYS_DIR"]!));
builder.Services.AddSingleton<ISecretProtector, DataProtectionSecretProtector>();

// SP3 4.4: 20 requests / minute per IP on /auth/* (TEAS_AUTH_RATE_LIMIT overrides the number; tests only). Over the limit = 429 http.rate_limited.
var authLimit = int.TryParse(builder.Configuration["TEAS_AUTH_RATE_LIMIT"], out var configured) && configured > 0 ? configured : 20;
builder.Services.AddRateLimiter(o =>
{
    o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(http =>
        http.Request.Path.StartsWithSegments("/internal/v1/auth") && !(HttpMethods.IsGet(http.Request.Method) && http.Request.Path.Value!.TrimEnd('/').Equals("/internal/v1/auth/session", StringComparison.OrdinalIgnoreCase))   // the expiry dialog polls GET /auth/session
            ? RateLimitPartition.GetFixedWindowLimiter(http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions { PermitLimit = authLimit, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 })
            : RateLimitPartition.GetNoLimiter("none"));
    o.OnRejected = (_, _) => throw new TeasException("http.rate_limited");   // rendered by UseTeasProblems, which is earlier in the pipeline
});

#pragma warning disable RS0030 // composition root: the one place the real clock is created
builder.Services.AddSingleton(TimeProvider.System);
#pragma warning restore RS0030

// ConnectionStrings:Teas = the teas_app login. Without it only a Development host starts (health / version tests).
var cs = builder.Configuration.GetConnectionString("Teas");
if (!string.IsNullOrWhiteSpace(cs))
{
    builder.Services.AddTeasData(cs);
    builder.Services.AddSingleton(new Teas.App.Platform.Files.FileStoreOptions(builder.Configuration["TEAS_FILES_DIR"] ?? "files"));
    if (builder.Configuration["TEAS_JOBS_DISABLED"] != "true") builder.Services.AddHostedService<JobRunnerService>();   // test hosts switch it off
}

var app = builder.Build();
// The build-time OpenAPI generator (ApiDescription.Server) runs this program past Build() with no configuration (tried: moving the
// guards does not help, it stops only at app.Run()), so it is the one caller allowed to skip them.
var generatingDocs = System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name == "GetDocument.Insider";
if (!app.Environment.IsDevelopment() && !generatingDocs)
{
    if (string.IsNullOrWhiteSpace(cs)) throw new StartupGuardException("ConnectionStrings:Teas is not set");
    if ((app.Configuration["TEAS_BFF_SECRET"]?.Length ?? 0) < BffSecretMiddleware.MinLength)
        throw new StartupGuardException($"TEAS_BFF_SECRET must be set and at least {BffSecretMiddleware.MinLength} characters");
    if (string.IsNullOrWhiteSpace(app.Configuration["TEAS_FILES_DIR"]))
        throw new StartupGuardException("TEAS_FILES_DIR must be set (the file volume); a relative default would lose files on redeploy");
    if (string.IsNullOrWhiteSpace(app.Configuration["TEAS_DP_KEYS_DIR"]))
        throw new StartupGuardException("TEAS_DP_KEYS_DIR must be set (the Data Protection key ring); without it every restart makes the stored TOTP secrets unreadable");
}
app.UseTeasProblems();

if (!string.IsNullOrWhiteSpace(cs)) await StartupGuards.RunAsync(cs);
// SP3 4.5 / 4.6 / S8: the BFF secret, then every endpoint decided against its RouteSpec before it runs. Unconditional: with no connection string it
// refuses every non-public endpoint. Authentication (P7 / P8) goes between these and this line is the one it is added in front of.
app.UseTeasRouteGuards();

app.MapGet("/health/live", () => Results.Ok(new { status = "live" })).WithMetadata(Probe.Marker);
app.MapGet("/health/ready", async (CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(cs)) return Results.Json(new { db = "unconfigured" }, statusCode: 503);
    await using var conn = new NpgsqlConnection(cs);
    await conn.OpenAsync(ct);
    var schema = await StartupGuards.SchemaIdAsync(conn, ct);
    return schema == TeasDbContext.ExpectedSchema
        ? Results.Ok(new { db = "ok", schema })
        : Results.Json(new { db = "schema-mismatch", schema }, statusCode: 503);
}).WithMetadata(Probe.Marker);
app.MapGet("/version", () => Results.Ok(new { version = app.Configuration["TEAS_VERSION"] ?? "dev" })).WithMetadata(Probe.Marker);

// The BFF-only surface. `ping` is the P2 probe route for S8; the auth routes (1-14) come from P7, the rest from P8 on.
var internalV1 = app.MapGroup("/internal/v1").WithMetadata(BffOnly.Instance);
internalV1.MapRoute(new RouteSpec("GET", "/ping", "public"), () => Results.Ok(new { ok = true })).ExcludeFromDescription(); // a probe, not a contract route
internalV1.MapAuthRoutes();

app.Run();

public partial class Program;
