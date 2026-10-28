using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Teas.Integration.Tests;

// S8: /internal/v1/* without the BFF secret is 401. Needs no database.
public class BffSecretTests
{
    const string Secret = "0123456789abcdef0123456789abcdef";   // 32 chars, the minimum

    static WebApplicationFactory<Program> Host(string? secret) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b => { if (secret != null) b.UseSetting("TEAS_BFF_SECRET", secret); });

    static async Task<HttpStatusCode> Get(WebApplicationFactory<Program> f, string? header)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, "/internal/v1/ping");
        if (header != null) req.Headers.Add("X-Teas-Bff", header);
        return (await f.CreateClient().SendAsync(req)).StatusCode;
    }

    [Fact]
    public async Task MissingHeaderIs401()
    {
        using var f = Host(Secret);
        Assert.Equal(HttpStatusCode.Unauthorized, await Get(f, null));
    }

    [Fact]
    public async Task WrongSecretIs401()
    {
        using var f = Host(Secret);
        Assert.Equal(HttpStatusCode.Unauthorized, await Get(f, "nope"));
    }

    [Fact]
    public async Task RightSecretIs200()
    {
        using var f = Host(Secret);
        Assert.Equal(HttpStatusCode.OK, await Get(f, Secret));
    }

    [Fact]
    public async Task NoConfiguredSecretRefusesEverythingEvenAnEmptyHeader()
    {
        using var f = Host(null);
        Assert.Equal(HttpStatusCode.Unauthorized, await Get(f, ""));
        Assert.Equal(HttpStatusCode.Unauthorized, await Get(f, "anything"));
    }

    [Fact]
    public async Task ASecretShorterThanTheMinimumIsNeverAccepted()
    {
        const string shortSecret = "0123456789abcdef0123456789abcde";   // 31 chars
        using var f = Host(shortSecret);
        Assert.Equal(HttpStatusCode.Unauthorized, await Get(f, shortSecret));
    }

    // ------------------------------------------------------------------ P10: client IP, machine-route limit, logger (no database needed: the limiter runs before any handler)

    static WebApplicationFactory<Program> LimitedHost(string? authLimit, string? machineLimit, Action<ILoggingBuilder>? logging = null) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("TEAS_BFF_SECRET", Secret);
            if (authLimit != null) b.UseSetting("TEAS_AUTH_RATE_LIMIT", authLimit);
            if (machineLimit != null) b.UseSetting("TEAS_MACHINE_RATE_LIMIT", machineLimit);
            if (logging != null) b.ConfigureLogging(logging);
        });

    static async Task<HttpStatusCode> Send(WebApplicationFactory<Program> f, HttpMethod method, string path, string? secret, string? clientIp)
    {
        var req = new HttpRequestMessage(method, path);
        if (secret != null) req.Headers.Add("X-Teas-Bff", secret);
        if (clientIp != null) req.Headers.Add("X-Teas-Client-Ip", clientIp);
        if (method == HttpMethod.Post) req.Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
        return (await f.CreateClient().SendAsync(req)).StatusCode;
    }

    [Fact]
    public async Task TheClientIpTheBffForwardsIsTheAuthLimitPartition_OnceTheSecretPassed()
    {
        using var f = LimitedHost("2", null);
        const string login = "/internal/v1/auth/login";
        Assert.NotEqual(HttpStatusCode.TooManyRequests, await Send(f, HttpMethod.Post, login, Secret, "203.0.113.7"));
        Assert.NotEqual(HttpStatusCode.TooManyRequests, await Send(f, HttpMethod.Post, login, Secret, "203.0.113.7"));
        Assert.Equal(HttpStatusCode.TooManyRequests, await Send(f, HttpMethod.Post, login, Secret, "203.0.113.7"));   // that client is over its 2 / min
        Assert.NotEqual(HttpStatusCode.TooManyRequests, await Send(f, HttpMethod.Post, login, Secret, "203.0.113.8"));   // another client has its own bucket
        Assert.NotEqual(HttpStatusCode.TooManyRequests, await Send(f, HttpMethod.Post, login, Secret, "2001:db8::1"));   // IPv6 too
    }

    [Fact]
    public async Task ABadOrMissingClientIpFallsBackToThePeer_AndWithoutTheSecretTheHeaderIsNeverReached()
    {
        using var f = LimitedHost("2", null);
        const string login = "/internal/v1/auth/login";
        foreach (var junk in new[] { "not-an-ip", "1.2.3.4, 5.6.7.8" })   // one shared bucket: the test server has no peer address
            _ = await Send(f, HttpMethod.Post, login, Secret, junk);
        Assert.Equal(HttpStatusCode.TooManyRequests, await Send(f, HttpMethod.Post, login, Secret, "also-not-an-ip"));
        // a wrong secret is refused (401) before the limiter and before the header is read: it can neither be counted nor change a partition
        for (var i = 0; i < 5; i++) Assert.Equal(HttpStatusCode.Unauthorized, await Send(f, HttpMethod.Post, login, "wrong-secret", $"198.51.100.{i}"));
    }

    [Fact]
    public async Task TheMachineRoutesAreLimitedPerPeer_NeverPerForgedClientIp_EvenWithTheRightSecret()
    {
        using var f = LimitedHost(null, "2");
        // /api/v1 and /mcp share one bucket per peer; the X-Teas-Client-Ip header (a BFF-only contract) changes nothing there, whatever else is sent
        Assert.NotEqual(HttpStatusCode.TooManyRequests, await Send(f, HttpMethod.Get, "/api/v1/whoami", Secret, "203.0.113.1"));
        Assert.NotEqual(HttpStatusCode.TooManyRequests, await Send(f, HttpMethod.Post, "/mcp", Secret, "203.0.113.2"));
        Assert.Equal(HttpStatusCode.TooManyRequests, await Send(f, HttpMethod.Get, "/api/v1/whoami", null, "203.0.113.3"));
        Assert.Equal(HttpStatusCode.TooManyRequests, await Send(f, HttpMethod.Post, "/mcp", null, null));
        // the BFF surface is not in that bucket
        Assert.Equal(HttpStatusCode.OK, await Send(f, HttpMethod.Get, "/internal/v1/ping", Secret, null));
    }

    // P11a: TEAS_FORWARDED_KNOWN_NETWORKS. A machine route is limited per peer (1 / min here); behind a trusted proxy X-Forwarded-For names the client.
    static async Task<int> Forwarded(WebApplicationFactory<Program> f, string peer, string xff)
    {
        var ctx = await f.Server.SendAsync(c =>
        {
            c.Request.Method = "GET";
            c.Request.Path = "/api/v1/whoami";
            c.Connection.RemoteIpAddress = IPAddress.Parse(peer);
            c.Request.Headers["X-Forwarded-For"] = xff;
        });
        return ctx.Response.StatusCode;
    }

    static WebApplicationFactory<Program> ForwardedHost(string? networks) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("FORWARDEDHEADERS_ENABLED", "true");   // = ASPNETCORE_FORWARDEDHEADERS_ENABLED
            b.UseSetting("TEAS_MACHINE_RATE_LIMIT", "1");
            if (networks != null) b.UseSetting("TEAS_FORWARDED_KNOWN_NETWORKS", networks);
        });

    [Fact]
    public async Task ForwardedHeadersAreTrustedFromAnyPeerByDefault_AndOnlyFromTheKnownNetworksWhenSet()
    {
        using (var any = ForwardedHost(null))   // the framework default: whoever the peer is, X-Forwarded-For names the client
        {
            Assert.Equal(401, await Forwarded(any, "192.168.1.1", "203.0.113.1"));
            Assert.Equal(401, await Forwarded(any, "192.168.1.1", "203.0.113.2"));
        }
        using var known = ForwardedHost("10.0.0.0/8, fd00::/8");
        Assert.Equal(401, await Forwarded(known, "10.1.2.3", "203.0.113.1"));   // a peer inside: each forwarded client has its own bucket
        Assert.Equal(401, await Forwarded(known, "10.1.2.3", "203.0.113.2"));
        Assert.Equal(401, await Forwarded(known, "192.168.1.1", "203.0.113.1"));   // a peer outside: the header is ignored, the peer is the client
        Assert.Equal(429, await Forwarded(known, "192.168.1.1", "203.0.113.2"));
    }

    [Fact]
    public void ABadKnownNetworkFailsTheStart() =>
        Assert.ThrowsAny<Exception>(() => ForwardedHost("not-a-cidr").CreateClient());

    sealed class ScopeCapture : ILoggerProvider
    {
        public System.Collections.Concurrent.ConcurrentQueue<string> Seen { get; } = new();
        public ILogger CreateLogger(string categoryName) => new L(this);
        public void Dispose() { }
        sealed class L(ScopeCapture o) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull { o.Seen.Enqueue(state.ToString() ?? ""); return null; }
            public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;
            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) => o.Seen.Enqueue(formatter(state, exception));
        }
    }

    [Fact]
    public async Task NoLogScopeOrLineCarriesTheRequestPath_ALinkTokenTravelsInIt()
    {
        var capture = new ScopeCapture();
        using var f = LimitedHost(null, null, l => l.AddProvider(capture));
        var token = "tok-" + Guid.NewGuid().ToString("N");
        await Send(f, HttpMethod.Get, $"/internal/v1/auth/links/{token}", Secret, null);
        await Send(f, HttpMethod.Post, $"/internal/v1/auth/links/{token}", Secret, null);
        Assert.DoesNotContain(capture.Seen, l => l.Contains(token));
        // and what the production console prints can never include scopes, whatever the configuration says
        Assert.False(f.Services.GetRequiredService<IOptionsMonitor<Microsoft.Extensions.Logging.Console.SimpleConsoleFormatterOptions>>().CurrentValue.IncludeScopes);
        Assert.Equal("simple", f.Services.GetRequiredService<IOptionsMonitor<Microsoft.Extensions.Logging.Console.ConsoleLoggerOptions>>().CurrentValue.FormatterName);
    }
}

public class TraceIdTests
{
    sealed class Capture : IStartupFilter
    {
        public static string? TraceId, Source;
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use(async (ctx, n) => { TraceId = System.Diagnostics.Activity.Current?.TraceId.ToString(); Source = System.Diagnostics.Activity.Current?.Source.Name; await n(); });
            next(app);
        };
    }

    // P10a: silencing the hosting logger category once stopped the request Activity from being created, so every audit row got trace_id NULL
    // (AuditTests failed on CI, where no other listener exists). The API registers its own listener; this holds with no logging and no OpenTelemetry.
    [Fact]
    public async Task EveryRequestHasAnActivityWhateverTheHostingLogLevelIs()
    {
        Capture.TraceId = null;
        using var f = new WebApplicationFactory<Program>().WithWebHostBuilder(b => b.ConfigureServices(s => s.AddSingleton<IStartupFilter>(new Capture())));
        await f.CreateClient().GetAsync("/health/live");
        Assert.False(string.IsNullOrEmpty(Capture.TraceId));
        Assert.Equal("Microsoft.AspNetCore", Capture.Source);   // made by the hosting ActivitySource our listener samples, not by whatever ambient subscriber a dev box or test runner happens to have
    }
}
