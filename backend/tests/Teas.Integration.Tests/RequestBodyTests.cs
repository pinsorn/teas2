using System.Net;
using System.Text.Json;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// SP3 P11b #1: a request body with a missing / null required member is a binding failure (422 record.invalid), never a 500, and an auth route
// refuses it BEFORE an attempt is counted.
public sealed class RequestBodyTests(AuthFixture fx) : IClassFixture<AuthFixture>
{
    AuthHost H => fx.Host;
    static JsonElement J(string json) => JsonDocument.Parse(json).RootElement;

    public static TheoryData<string, string, string> Bodies() => new()
    {
        { "POST", "/auth/login", "{}" },
        { "POST", "/auth/login", """{"email":"x"}""" },
        { "POST", "/auth/login", """{"password":"x"}""" },
        { "POST", "/auth/login", """{"email":null,"password":"x"}""" },
        { "POST", "/auth/login", """{"email":"x","password":null}""" },
        { "POST", "/auth/totp", "{}" },
        { "POST", "/auth/totp", """{"challenge":null,"code":"123456"}""" },
        { "POST", "/auth/relogin", "{}" },
        { "POST", "/auth/relogin", """{"password":null}""" },
        { "POST", "/auth/password", "{}" },
        { "POST", "/auth/password", """{"current":"a","next":"b"}""" },
        { "POST", "/auth/totp/enrol/verify", "{}" },
        { "POST", "/auth/links/not-a-token", "{}" },
        { "POST", "/auth/links/not-a-token", """{"password":"x"}""" },
        { "POST", "/me/active-company", "{}" },
        { "POST", "/settings/roles", "{}" },
        { "POST", "/settings/roles", """{"name":"r"}""" },
        { "PUT", "/settings/roles/x", "{}" },
        { "POST", "/settings/users", "{}" },
        { "POST", "/settings/users", """{"name":"n","email":"e@example.test"}""" },
        { "PUT", "/settings/users/x", "{}" },
        { "POST", "/settings/users/x/active", "{}" },
        { "POST", "/settings/users/x/totp-reset", "{}" },
        { "POST", "/connect/keys", "{}" },
        { "POST", "/connect/keys/x/rotate", "{}" },
        { "POST", "/connect/keys/x/revoke", "{}" },
    };

    [Theory]
    [MemberData(nameof(Bodies))]
    public async Task AMissingOrNullRequiredMemberIs422AndCountsNoAttempt(string method, string path, string body)
    {
        var admin = await H.CreateUserAsync();
        var company = await H.CreateCompanyAsync();
        await H.AddMemberAsync(company, admin);
        var token = await H.LoginAsync(admin);
        var failures = await H.ScalarAsync<long>("SELECT count(*) FROM teas.auth_failures");
        var events = await H.ScalarAsync<long>("SELECT count(*) FROM teas.auth_events");
        var audit = await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log");

        var r = await H.SendAsync(new HttpMethod(method), path, J(body), token);

        Assert.True(r.Status == HttpStatusCode.UnprocessableEntity, $"{method} {path} {body} -> {(int)r.Status}: {r.Raw}");
        Assert.Equal("record.invalid", r.Code);
        Assert.Equal(failures, await H.ScalarAsync<long>("SELECT count(*) FROM teas.auth_failures"));
        Assert.Equal(events, await H.ScalarAsync<long>("SELECT count(*) FROM teas.auth_events"));
        Assert.Equal(audit, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log"));
    }
}
