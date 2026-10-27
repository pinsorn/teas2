using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using Npgsql;
using Microsoft.AspNetCore.DataProtection;
using Teas.Api.Endpoints;
using Teas.App.Platform;
using Teas.App.Platform.Auth;
using Teas.Domain.Platform;

namespace Teas.Integration.Tests.Harness;

/// <summary>A reply of the API: status, parsed JSON (null for an empty body), the raw text and the session cookie it set (if any).</summary>
public sealed class Res(HttpResponseMessage message, string raw)
{
    public HttpStatusCode Status => message.StatusCode;
    public string Raw => raw;
    public HttpResponseMessage Message => message;
    public JsonElement Json => raw.Length == 0 ? default : JsonDocument.Parse(raw).RootElement;
    public string? Code => Json.ValueKind == JsonValueKind.Object && Json.TryGetProperty("code", out var c) ? c.GetString() : null;
    public string? Str(string name) => Json.ValueKind == JsonValueKind.Object && Json.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    public IReadOnlyList<string> SetCookies => message.Headers.TryGetValues("Set-Cookie", out var v) ? [.. v] : [];
    /// <summary>The token of the session cookie this reply set; null when it set none or cleared it.</summary>
    public string? Token
    {
        get
        {
            var c = SetCookies.FirstOrDefault(x => x.StartsWith(AuthHost.CookieName + "=", StringComparison.Ordinal));
            var v = c?[(AuthHost.CookieName.Length + 1)..].Split(';')[0];
            return string.IsNullOrEmpty(v) ? null : v;
        }
    }
}

/// <summary>The real protector, plus an optional barrier in Unprotect: the race tests use it to make two requests overlap exactly where the guarded UPDATE decides.</summary>
public sealed class GatedProtector(ISecretProtector inner) : ISecretProtector
{
    public AsyncBarrier? Barrier { get; set; }
    public byte[] Protect(byte[] plain) => inner.Protect(plain);
    public byte[] Unprotect(byte[] cipher)
    {
        Barrier?.ArriveAsync().GetAwaiter().GetResult();
        return inner.Unprotect(cipher);
    }
}

public sealed record TestUser(Guid Id, string Email, string Password, byte[]? TotpSecret = null, IReadOnlyList<string>? RecoveryCodes = null);

public sealed class LogCapture : ILoggerProvider
{
    public ConcurrentQueue<string> Lines { get; } = new();
    public ILogger CreateLogger(string categoryName) => new L(this, categoryName);
    public void Dispose() { }
    sealed class L(LogCapture o, string cat) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            o.Lines.Enqueue($"{cat} {logLevel}: {formatter(state, exception)} {exception}");
    }
}

/// <summary>
/// SP3 P7: the real API host (Staging, the BFF secret, a FakeTimeProvider) on a template clone, plus helpers to create users, companies,
/// members and links directly in the database. The rate limit is high unless a test asks for the real 20 / min.
/// </summary>
public sealed class AuthHost : IAsyncDisposable
{
    public const string CookieName = "__Host-teas_session";
    public const string Password = "Correct#Horse9";
    public static readonly PasswordService Hasher = new();
    static readonly string PasswordHash = Hasher.Hash(Password);

    public DbClone Db { get; }
    public WebApplicationFactory<Program> Factory { get; }
    public FakeTimeProvider Clock { get; } = new(DateTimeOffset.Parse("2026-10-27T03:00:00Z"));
    public LogCapture Logs { get; } = new();
    public HttpClient Client { get; }
    /// <summary>Makes the next requests that decrypt a TOTP secret meet at a barrier first, i.e. after they both read the user and before either claims the step.</summary>
    public GatedProtector Gate { get; private set; } = null!;

    AuthHost(DbClone db, int rateLimit, string environment)
    {
        Db = db;
        Factory = PlatformTestHost.Create(db).WithWebHostBuilder(b =>
        {
            b.UseEnvironment(environment);
            b.UseSetting("TEAS_AUTH_RATE_LIMIT", rateLimit.ToString());
            b.ConfigureLogging(l => l.AddProvider(Logs));
            b.ConfigureTestServices(s =>
            {
                s.RemoveAll<TimeProvider>();
                s.AddSingleton<TimeProvider>(Clock);
                s.RemoveAll<ISecretProtector>();
                s.AddSingleton(sp => Gate = new GatedProtector(new DataProtectionSecretProtector(sp.GetRequiredService<IDataProtectionProvider>())));
                s.AddSingleton<ISecretProtector>(sp => sp.GetRequiredService<GatedProtector>());
            });
        });
        Client = Factory.CreateClient();
    }

    public static async Task<AuthHost> StartAsync(int rateLimit = 100_000, string environment = "Staging") => new(await TestDb.CloneAsync(), rateLimit, environment);

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await Factory.DisposeAsync();
        await Db.DisposeAsync();
    }

    public DateTimeOffset Now => Clock.GetUtcNow();

    // ---------------------------------------------------------------- HTTP

    public async Task<Res> SendAsync(HttpMethod method, string path, object? body = null, string? token = null, string? userAgent = null)
    {
        using var req = new HttpRequestMessage(method, "/internal/v1" + path);
        if (body is not null) req.Content = JsonContent.Create(body);
        if (token is not null) req.Headers.Add("Cookie", $"{CookieName}={token}");
        if (userAgent is not null) req.Headers.TryAddWithoutValidation("User-Agent", userAgent);
        using var message = await Client.SendAsync(req);
        return new Res(message, await message.Content.ReadAsStringAsync());
    }

    public Task<Res> Get(string path, string? token = null) => SendAsync(HttpMethod.Get, path, null, token);
    public Task<Res> Post(string path, object? body = null, string? token = null) => SendAsync(HttpMethod.Post, path, body ?? new { }, token);

    /// <summary>A password sign-in that must end in a session (no second factor); returns the session token.</summary>
    public async Task<string> LoginAsync(TestUser u)
    {
        var r = await Post("/auth/login", new { email = u.Email, password = u.Password });
        Assert.True(r.Status == HttpStatusCode.OK, $"login {r.Status}: {r.Raw}");
        return r.Token ?? throw new InvalidOperationException("login set no cookie: " + r.Raw);
    }

    // ---------------------------------------------------------------- database

    static NpgsqlParameter P(string n, object? v) => new(n, v ?? DBNull.Value);

    public Task<T> QueryAsync<T>(string sql, Func<NpgsqlDataReader, T> read, params NpgsqlParameter[] ps) =>
        Db.AsAppAsync(new ScopeState(null, null, true), async (c, t) =>
        {
            await using var cmd = new NpgsqlCommand(sql, c, t);
            cmd.Parameters.AddRange(ps);
            await using var r = await cmd.ExecuteReaderAsync();
            await r.ReadAsync();
            return read(r);
        });

    public async Task<T?> ScalarAsync<T>(string sql, params NpgsqlParameter[] ps)
    {
        var v = await QueryAsync(sql, r => r.IsDBNull(0) ? default : r.GetFieldValue<T>(0), ps);
        return v;
    }

    /// <summary>A write as teas_app in the given scope, committed.</summary>
    internal Task ExecAsync(string sql, ScopeState scope, params NpgsqlParameter[] ps) =>
        Db.AsAppAsync(scope, async (c, t) =>
        {
            await using var cmd = new NpgsqlCommand(sql, c, t);
            cmd.Parameters.AddRange(ps);
            await cmd.ExecuteNonQueryAsync();
            return 0;
        }, commit: true);

    public Task ExecGlobalAsync(string sql, params NpgsqlParameter[] ps) => ExecAsync(sql, ScopeState.None, ps);

    public async Task<TestUser> CreateUserAsync(string? email = null, string name = "Test User", bool password = true, bool totp = false)
    {
        var id = Guid.NewGuid();
        email ??= $"u-{id:N}@example.test";
        await ExecGlobalAsync("INSERT INTO teas.users (id, email, display_name, password_hash, password_changed_at) VALUES (@i, @e, @n, @h, now())",
            P("i", id), P("e", email), P("n", name), P("h", password ? PasswordHash : null));
        if (!totp) return new TestUser(id, email, Password);
        var secret = Totp.NewSecret();
        var enc = Factory.Services.GetRequiredService<ISecretProtector>().Protect(secret);
        await ExecGlobalAsync("UPDATE teas.users SET totp_secret_enc = @s WHERE id = @i", P("s", enc), P("i", id));
        var codes = Enumerable.Range(0, 8).Select(_ => RecoveryCodes.New()).ToList();
        foreach (var c in codes)
            await ExecGlobalAsync("INSERT INTO teas.recovery_codes (user_id, code_hash) VALUES (@u, @h)", P("u", id), P("h", Hasher.Hash(c)));
        return new TestUser(id, email, Password, secret, codes);
    }

    /// <summary>The current valid code of a user with two-step on, at the fake clock.</summary>
    public string CodeOf(TestUser u, int stepOffset = 0) => Totp.Code(u.TotpSecret!, Totp.StepOf(Now) + stepOffset);

    public async Task<Guid> CreateCompanyAsync(string? name = null)
    {
        var id = await PlatformTestHost.NewCompanyAsync(Db);
        if (name is not null) await ExecAsync("UPDATE teas.companies SET name = @n WHERE id = @c", new ScopeState(id, null, false), P("n", name), P("c", id));
        return id;
    }

    /// <summary>A member row of the company. pending = an invitation not accepted yet (no user).</summary>
    public async Task<Guid> AddMemberAsync(Guid company, TestUser? user, string role = "admin", bool pending = false, bool active = true, string? email = null, string name = "Member")
    {
        var id = Guid.NewGuid();
        await ExecAsync("INSERT INTO teas.company_members (company_id, id, user_id, email, name, role_id, active, invite_pending) VALUES (@c, @i, @u, @e, @n, @r, @a, @p)",
            new ScopeState(company, null, false), P("c", company), P("i", id), P("u", user?.Id), P("e", email ?? user?.Email ?? $"m-{id:N}@example.test"), P("n", name), P("r", role), P("a", active), P("p", pending));
        return id;
    }

    /// <summary>A link issued the way P8 / the CLI issue them (UserLinks.IssueAsync on the migrator connection). createdBy: a user id, or "operator".</summary>
    public async Task<string> IssueLinkAsync(string kind, string createdBy, Guid? userId = null, Guid? companyId = null, Guid? memberId = null)
    {
        await using var conn = await Db.OpenMigratorAsync();
        await using var tx = await conn.BeginTransactionAsync();
        var issued = await UserLinks.IssueAsync(conn, tx, kind, userId, companyId, memberId, createdBy, Now);
        await tx.CommitAsync();
        return issued.Token;
    }
}

/// <summary>One host per test class (xUnit class fixture): tests make their own users, so they do not interfere; the fake clock only moves forward.</summary>
public sealed class AuthFixture : IAsyncLifetime
{
    public AuthHost Host { get; private set; } = null!;
    public async Task InitializeAsync() => Host = await AuthHost.StartAsync();
    public async Task DisposeAsync() => await Host.DisposeAsync();
}
