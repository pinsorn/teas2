var builder = WebApplication.CreateBuilder(args);

#pragma warning disable RS0030 // composition root: the one place the real clock is created
builder.Services.AddSingleton(TimeProvider.System);
#pragma warning restore RS0030

var app = builder.Build();

app.MapGet("/health/live", () => Results.Ok(new { status = "live" }));
app.MapGet("/version", () => Results.Ok(new { version = Environment.GetEnvironmentVariable("TEAS_VERSION") ?? "dev" }));

app.Run();

public partial class Program;
