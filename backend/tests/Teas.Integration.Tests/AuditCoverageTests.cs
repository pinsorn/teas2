using System.Net;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Teas.Api.Routing;
using Teas.App.Platform;
using Teas.Domain.Platform;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// SP3 4.7 (P11b #3, #4): every non-GET route declares an audit command; per route a success writes exactly the declared 'ok' rows and a 4xx (other than 403) writes none;
// a refused 403 names the concrete request path and ONE concrete command.
public sealed class AuditCoverageTests(AuthFixture fx) : IClassFixture<AuthFixture>
{
    AuthHost H => fx.Host;
    static readonly Guid Nobody = Guid.NewGuid();

    static List<RouteSpec> ProductionNonGetRoutes(AuthHost h) =>
        [.. h.Factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Select(e => e.Metadata.GetMetadata<RouteSpec>()).OfType<RouteSpec>()
            .Where(s => s.Method != "GET" && !s.Path.Contains("_t/") && !s.Path.StartsWith("/outside", StringComparison.Ordinal))];

    [Fact]
    public void EveryNonGetRouteDeclaresAnAuditCommand()
    {
        var routes = ProductionNonGetRoutes(H);
        Assert.True(routes.Count >= 20, "routes found: " + routes.Count);
        Assert.Empty(routes.Select(RouteDeclaration.AuditProblem).OfType<string>());
        Assert.Equal(1, routes.Count(r => r.Path == "/auth/session/extend"));   // the exemptions exist, so the list cannot rot silently
        Assert.Equal(1, routes.Count(r => r.Path == "/mcp"));
        Assert.NotNull(RouteDeclaration.AuditProblem(new RouteSpec("POST", "/x", "session")));   // the check itself bites
        Assert.Null(RouteDeclaration.AuditProblem(new RouteSpec("GET", "/x", "session")));
    }

    /// <summary>Commands: the 'ok' rows one success writes. Ok: the success call. Bad: a call that must be a 4xx other than 403 (null: the route has none).</summary>
    sealed record Case(string[] Commands, Func<Task<Res>> Ok, Func<Task<Res>>? Bad = null);

    static string Unique(string p) => p + Guid.NewGuid().ToString("N")[..8];

    Dictionary<string, Func<Task<Case>>> Cases() => new()
    {
        ["POST /auth/login"] = async () =>
        {
            var (_, a, _, _) = await P8.AdminAsync(H);
            return new(["auth.login"], () => H.Post("/auth/login", new { email = a.Email, password = a.Password }), () => H.Post("/auth/login", new { email = a.Email, password = "Wrong#Password1" }));
        },
        ["POST /auth/totp"] = async () =>
        {
            var u = await H.CreateUserAsync(totp: true);
            await H.AddMemberAsync(await H.CreateCompanyAsync(), u);
            return new(["auth.login"], async () =>
            {
                var step = await H.Post("/auth/login", new { email = u.Email, password = u.Password });
                return await H.Post("/auth/totp", new { challenge = step.Str("challenge"), code = H.CodeOf(u) });
            }, () => H.Post("/auth/totp", new { challenge = "not-a-challenge", code = "123456" }));
        },
        ["POST /auth/logout"] = async () =>
        {
            var (_, _, token, _) = await P8.AdminAsync(H);
            return new(["auth.logout"], () => H.Post("/auth/logout", null, token));   // logging out is idempotent: it has no 4xx
        },
        ["POST /auth/relogin"] = async () =>
        {
            var (_, a, token, _) = await P8.AdminAsync(H);
            H.Clock.Advance(TimeSpan.FromMinutes(61));   // idle-expired: only relogin may use the session
            return new(["auth.login"], () => H.Post("/auth/relogin", new { password = a.Password }, token), () => H.Post("/auth/relogin", new { password = "Wrong#Password1" }, token));
        },
        ["POST /auth/password"] = async () =>
        {
            var (_, a, token, _) = await P8.AdminAsync(H);
            return new(["auth.password.change"], () => H.Post("/auth/password", new { current = a.Password, next = "Another#Horse99", confirm = "Another#Horse99" }, token),
                () => H.Post("/auth/password", new { current = a.Password, next = "Another#Horse99", confirm = "Different#Horse99" }, token));
        },
        ["POST /auth/totp/enrol"] = async () =>
        {
            var (_, _, token, _) = await P8.AdminAsync(H);
            return new(["auth.totp.enrol_start"], () => H.Post("/auth/totp/enrol", null, token), () => H.Post("/auth/totp/enrol", null, null));   // no 4xx of its own: signed out
        },
        ["POST /auth/totp/enrol/verify"] = async () =>
        {
            var (_, _, token, _) = await P8.AdminAsync(H);
            var begun = await H.Post("/auth/totp/enrol", null, token);
            var code = Totp.Code(Totp.FromBase32(begun.Str("secret")!), Totp.StepOf(H.Now));
            var wrong = (code[0] == '0' ? "1" : "0") + code[1..];
            return new(["auth.totp.enable"], () => H.Post("/auth/totp/enrol/verify", new { code }, token), () => H.Post("/auth/totp/enrol/verify", new { code = wrong }, token));
        },
        ["POST /auth/sessions/{id}/revoke"] = async () =>
        {
            var (_, a, token, _) = await P8.AdminAsync(H);
            await H.LoginAsync(a);
            var other = (await H.Get("/auth/sessions", token)).Json.GetProperty("items").EnumerateArray().First(x => !x.GetProperty("current").GetBoolean()).GetProperty("id").GetString();
            return new(["auth.session.revoke"], () => H.Post($"/auth/sessions/{other}/revoke", null, token), () => H.Post($"/auth/sessions/{Nobody}/revoke", null, token));
        },
        ["POST /auth/links/{token}"] = async () =>
        {
            var u = await H.CreateUserAsync();
            await H.AddMemberAsync(await H.CreateCompanyAsync(), u);
            var link = await H.IssueLinkAsync("reset", "operator", userId: u.Id);
            return new(["auth.password.reset"], () => H.Post($"/auth/links/{link}", new { password = "Brand#New2026x", confirm = "Brand#New2026x" }),
                () => H.Post($"/auth/links/{link}", new { password = "weak", confirm = "weak" }));
        },
        ["POST /auth/links/{token}#invite"] = async () =>
        {
            var (company, admin, _, _) = await P8.AdminAsync(H);
            var member = await H.AddMemberAsync(company, null, "operator", pending: true);
            var link = await H.IssueLinkAsync("invite", admin.Id.ToString(), companyId: company, memberId: member);
            return new(["user.accept_invite"], () => H.Post($"/auth/links/{link}", new { password = "Brand#New2026x", confirm = "Brand#New2026x" }),
                () => H.Post($"/auth/links/{link}", new { password = "weak", confirm = "weak" }));
        },
        ["POST /me/active-company"] = async () =>
        {
            var a = await H.CreateCompanyAsync();
            var b = await H.CreateCompanyAsync();
            var u = await H.CreateUserAsync();
            await H.AddMemberAsync(a, u);
            await H.AddMemberAsync(b, u);
            var token = await H.LoginAsync(u);
            return new(["company.switch"], () => H.Post("/me/active-company", new { companyId = b }, token), () => H.Post("/me/active-company", new { companyId = Nobody }, token));
        },
        ["PUT /settings/companies/{id}/{section}"] = async () =>
        {
            var (company, _, token, _) = await P8.AdminAsync(H);
            return new(["company.update.contact"], () => P8.Put(H, $"/settings/companies/{company}/contact", new { version = 1, phone = "02-123" }, token),
                () => P8.Put(H, $"/settings/companies/{company}/vat", new { version = 1 }, token));
        },
        ["POST /settings/users"] = async () =>
        {
            var (_, _, token, _) = await P8.AdminAsync(H);
            return new(["user.invite"], () => H.Post("/settings/users", new { name = "Invitee", email = Unique("inv-") + "@example.test", roleId = "operator" }, token), () => H.Post("/settings/users", new { }, token));
        },
        ["PUT /settings/users/{id}"] = async () =>
        {
            var (company, _, token, _) = await P8.AdminAsync(H);
            var (_, _, m) = await P8.MemberAsync(H, company, "operator", login: false);
            return new(["user.update"], () => P8.Put(H, $"/settings/users/{m}", new { version = 1, name = "Renamed" }, token), () => P8.Put(H, $"/settings/users/{Nobody}", new { version = 1, name = "Renamed" }, token));
        },
        ["POST /settings/users/{id}/active"] = async () =>
        {
            var (company, _, token, _) = await P8.AdminAsync(H);
            var (_, _, m) = await P8.MemberAsync(H, company, "operator", login: false);
            return new(["user.deactivate"], () => H.Post($"/settings/users/{m}/active", new { active = false, version = 1 }, token), () => H.Post($"/settings/users/{Nobody}/active", new { active = false, version = 1 }, token));
        },
        ["POST /settings/users/{id}/reset-link"] = async () =>
        {
            var (company, _, token, _) = await P8.AdminAsync(H);
            var (_, _, m) = await P8.MemberAsync(H, company, "operator", login: false);
            return new(["user.reset_link"], () => H.Post($"/settings/users/{m}/reset-link", null, token), () => H.Post($"/settings/users/{Nobody}/reset-link", null, token));
        },
        ["POST /settings/users/{id}/totp-reset"] = async () =>
        {
            var (company, _, token, _) = await P8.AdminAsync(H);
            var (_, _, m) = await P8.MemberAsync(H, company, "operator", login: false);
            return new(["user.totp_reset"], () => H.Post($"/settings/users/{m}/totp-reset", new { version = 1 }, token), () => H.Post($"/settings/users/{Nobody}/totp-reset", new { version = 1 }, token));
        },
        ["POST /settings/roles"] = async () =>
        {
            var (_, _, token, _) = await P8.AdminAsync(H);
            return new(["role.create"], () => H.Post("/settings/roles", new { name = Unique("role-"), permissions = new[] { "party.read" } }, token), () => H.Post("/settings/roles", new { }, token));
        },
        ["PUT /settings/roles/{id}"] = async () =>
        {
            var (company, _, token, _) = await P8.AdminAsync(H);
            var role = await P8.RoleAsync(H, company, Unique("r-"), "party.read");
            return new(["role.update"], () => P8.Put(H, $"/settings/roles/{role}", new { version = 1, name = Unique("renamed-") }, token), () => P8.Put(H, $"/settings/roles/{Nobody}", new { version = 1, name = "x" }, token));
        },
        ["DELETE /settings/roles/{id}"] = async () =>
        {
            var (company, _, token, _) = await P8.AdminAsync(H);
            var role = await P8.RoleAsync(H, company, Unique("r-"), "party.read");
            return new(["role.delete"], () => P8.Delete(H, $"/settings/roles/{role}?version=1", token), () => P8.Delete(H, $"/settings/roles/{Nobody}?version=1", token));
        },
        ["POST /connect/keys"] = async () =>
        {
            var (_, _, token, _) = await P8.AdminAsync(H);
            return new(["connect.key.create"], () => H.Post("/connect/keys", new { name = "k", kind = "rest", scopes = new[] { "party.read" } }, token), () => H.Post("/connect/keys", new { }, token));
        },
        ["POST /connect/keys/{id}/rotate"] = async () =>
        {
            var (_, _, token, _) = await P8.AdminAsync(H);
            var key = await K.CreateAsync(H, token);
            return new(["connect.key.revoke", "connect.key.rotate"], () => H.Post($"/connect/keys/{key.Id}/rotate", new { version = 1 }, token), () => H.Post($"/connect/keys/{Nobody}/rotate", new { version = 1 }, token));   // the old key is revoked too: two rows
        },
        ["POST /connect/keys/{id}/revoke"] = async () =>
        {
            var (_, _, token, _) = await P8.AdminAsync(H);
            var key = await K.CreateAsync(H, token);
            return new(["connect.key.revoke"], () => H.Post($"/connect/keys/{key.Id}/revoke", new { version = 1 }, token), () => H.Post($"/connect/keys/{Nobody}/revoke", new { version = 1 }, token));
        },
    };

    static readonly string[] AllKeys =
    [
        "POST /auth/login", "POST /auth/totp", "POST /auth/logout", "POST /auth/relogin", "POST /auth/password", "POST /auth/totp/enrol", "POST /auth/totp/enrol/verify",
        "POST /auth/sessions/{id}/revoke", "POST /auth/links/{token}", "POST /auth/links/{token}#invite", "POST /me/active-company", "PUT /settings/companies/{id}/{section}",
        "POST /settings/users", "PUT /settings/users/{id}", "POST /settings/users/{id}/active", "POST /settings/users/{id}/reset-link", "POST /settings/users/{id}/totp-reset",
        "POST /settings/roles", "PUT /settings/roles/{id}", "DELETE /settings/roles/{id}", "POST /connect/keys", "POST /connect/keys/{id}/rotate", "POST /connect/keys/{id}/revoke",
    ];

    public static TheoryData<string> Keys() { var d = new TheoryData<string>(); foreach (var k in AllKeys) d.Add(k); return d; }

    [Fact]
    public void EveryAuditedRouteIsDrivenByACase()
    {
        var driven = Cases().Keys.Select(k => k.Split('#')[0]).ToHashSet();
        var routes = ProductionNonGetRoutes(H).Where(r => r.Audit is not null).Select(r => $"{r.Method} {r.Path}").ToHashSet();
        Assert.Equal(routes.Order(), driven.Order());   // a new audited route needs a case here
        Assert.Equal(Cases().Keys.Order(), AllKeys.Order());
    }

    async Task<List<(string Command, string Result, string Target)>> RowsAfterAsync(long id) =>
        await H.Db.AsAppAsync(new ScopeState(null, null, true), async (c, t) =>
        {
            await using var cmd = new NpgsqlCommand("SELECT command, result, target FROM teas.audit_log WHERE id > @i ORDER BY id", c, t);
            cmd.Parameters.AddWithValue("i", id);
            await using var r = await cmd.ExecuteReaderAsync();
            var rows = new List<(string, string, string)>();
            while (await r.ReadAsync()) rows.Add((r.GetString(0), r.GetString(1), r.GetString(2)));
            return rows;
        });

    Task<long> MaxIdAsync() => H.ScalarAsync<long>("SELECT coalesce(max(id), 0) FROM teas.audit_log");

    [Theory]
    [MemberData(nameof(Keys))]
    public async Task ASuccessWritesTheDeclaredOkRowsAndA4xxWritesNone(string key)
    {
        var c = await Cases()[key]();
        if (c.Bad is { } bad)
        {
            var mark = await MaxIdAsync();
            var refused = await bad();
            Assert.True((int)refused.Status is >= 400 and < 500 and not 403, $"{key} bad call: {(int)refused.Status} {refused.Raw}");
            Assert.Empty(await RowsAfterAsync(mark));
        }
        var before = await MaxIdAsync();
        var ok = await c.Ok();
        Assert.True((int)ok.Status is >= 200 and < 300, $"{key} ok call: {(int)ok.Status} {ok.Raw}");
        Assert.Equal(c.Commands.Select(x => (x, "ok")).Order(), (await RowsAfterAsync(before)).Select(r => (r.Command, r.Result)).Order());
    }

    [Fact]
    public async Task ARefusedRequestRecordsItsConcretePathAndOneConcreteCommand()
    {
        var (company, _, _, _) = await P8.AdminAsync(H);
        var (_, op, _) = await P8.MemberAsync(H, company, "operator");   // holds neither users.manage nor settings.manage
        var (_, _, target) = await P8.MemberAsync(H, company, "operator", login: false);
        var mark = await MaxIdAsync();
        Assert.Equal(HttpStatusCode.Forbidden, (await H.Post($"/settings/users/{target}/active", new { active = false, version = 1 }, op)).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await P8.Put(H, $"/settings/companies/{company}/contact", new { version = 1 }, op)).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await P8.Put(H, $"/settings/users/{target}", new { version = 1, name = "x" }, op)).Status);
        // what the caller typed is never copied into the log: an unknown section and a non-GUID id (with an encoded newline) keep the template's placeholders
        Assert.Equal(HttpStatusCode.Forbidden, (await P8.Put(H, $"/settings/companies/{company}/bogus%0Asection", new { version = 1 }, op)).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await H.Post("/settings/users/abc%0Adef/active", new { active = false, version = 1 }, op)).Status);
        Assert.Equal(
            [("user.activate | user.deactivate", "rejected", $"/settings/users/{target}/active"),   // the path cannot tell the two apart and the body is never read: both, verbatim
             ("company.update.contact", "rejected", $"/settings/companies/{company}/contact"),
             ("user.update", "rejected", $"/settings/users/{target}"),
             ("company.update.<section>", "rejected", $"/settings/companies/{company}/{{section}}"),
             ("user.activate | user.deactivate", "rejected", "/settings/users/{id}/active")],
            await RowsAfterAsync(mark));
    }
}
