using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Teas.Api.OpenApi;
using Teas.Domain;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// SP3 P3: a thrown TeasException renders ApiProblem; Money / enums / optional members reach the OpenAPI document as the contract says.
public sealed class ErrorContractTests
{
    public enum Step { [JsonStringEnumMemberName("totp_required")] TotpRequired, Done }
    // Convention (SP3 4.8): a mandatory member is `required` (always written, null as null); any other nullable member is omitted when null;
    // an optional member whose null means "remove" is Optional<T> (absent / null / value).
    public sealed record Probe
    {
        public required Money Amount { get; init; }
        public Money? Maybe { get; init; }
        public string? Note { get; init; }
        public required string? Label { get; init; }
        public Optional<string?> Logo { get; init; }
        public required Step Step { get; init; }
    }
    public sealed record Patch { public Optional<string?> Logo { get; init; } }


    static readonly Action<IEndpointRouteBuilder> Routes = e =>
    {
        e.MapGet("/internal/v1/_t/throw/{code}", (string code) => { throw new TeasException(code, "why", new Dictionary<string, string[]> { ["name"] = ["required"] }); });
        e.MapGet("/internal/v1/_t/throw/{code}/{status:int}", (string code, int status) => { throw new TeasException(code, status: status); });
        e.MapGet("/internal/v1/_t/boom", () => { throw new InvalidOperationException("secret connection string"); });
        e.MapGet("/internal/v1/_t/money", () => new Probe { Amount = Money.Of(12), Label = null, Step = Step.TotpRequired });
        e.MapGet("/internal/v1/_t/logo", () => new Probe { Amount = Money.Of(12), Label = "x", Logo = new Optional<string?>(null), Step = Step.Done });
        e.MapPost("/internal/v1/_t/patch", (Patch p) => p.Logo.IsSet ? (p.Logo.Value is null ? "null" : "value:" + p.Logo.Value) : "absent");
        e.MapGet("/internal/v1/_t/overflow", () => Money.Of(10000000000000000m));
        e.MapOpenApi("/_t/openapi.json");
    };

    // The test host's own routes (the P4 test-only endpoint pattern): added after the app pipeline, never in Program.cs.
    sealed class TestRoutes(Action<IEndpointRouteBuilder> map) : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            next(app);
            app.UseRouting();
            app.UseEndpoints(map);
        };
    }

    static WebApplicationFactory<Program> Host() => new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        b.ConfigureServices(s => s.AddSingleton<IStartupFilter>(new TestRoutes(Routes))));

    // A non-Development host (Staging): the config guards run and ASP.NET's own "throw on bad request" default (Development only) is off.
    static WebApplicationFactory<Program> StagingHost(DbClone db) => new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
    {
        b.UseEnvironment("Staging");
        b.UseSetting("ConnectionStrings:Teas", db.AppCs);
        b.UseSetting("TEAS_BFF_SECRET", "0123456789abcdef0123456789abcdef");
        b.ConfigureServices(s => s.AddSingleton<IStartupFilter>(new TestRoutes(Routes)));
    });

    static async Task<JsonElement> Problem(HttpResponseMessage res)
    {
        Assert.StartsWith("application/problem+json", res.Content.Headers.ContentType?.MediaType ?? "");
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task ATeasExceptionRendersApiProblemInThaiByDefault()
    {
        using var f = Host();
        var res = await f.CreateClient().GetAsync("/internal/v1/_t/throw/record.not_found");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        var p = await Problem(res);
        Assert.Equal("about:blank", p.GetProperty("type").GetString());
        Assert.Equal("record.not_found", p.GetProperty("code").GetString());
        Assert.Equal(404, p.GetProperty("status").GetInt32());
        Assert.Equal(ErrorCodes.All["record.not_found"].Th, p.GetProperty("title").GetString());
        Assert.Equal("why", p.GetProperty("detail").GetString());
        Assert.Equal("required", p.GetProperty("fieldErrors").GetProperty("name")[0].GetString());
        Assert.Matches("^[0-9a-f]{32}$", p.GetProperty("traceId").GetString());
    }

    [Fact]
    public async Task TheLocaleCookieSelectsTheEnglishTitle()
    {
        using var f = Host();
        var req = new HttpRequestMessage(HttpMethod.Get, "/internal/v1/_t/throw/record.version_conflict");
        req.Headers.Add("Cookie", "locale=en");
        var res = await f.CreateClient().SendAsync(req);
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal(ErrorCodes.All["record.version_conflict"].En, (await Problem(res)).GetProperty("title").GetString());
    }

    [Fact]
    public async Task AnUnknownExceptionIsA500WithNoInternals()
    {
        using var f = Host();
        var res = await f.CreateClient().GetAsync("/internal/v1/_t/boom");
        Assert.Equal(HttpStatusCode.InternalServerError, res.StatusCode);
        var body = await res.Content.ReadAsStringAsync();
        Assert.DoesNotContain("secret", body);
        Assert.DoesNotContain("InvalidOperation", body);
        Assert.Equal("http.500", JsonDocument.Parse(body).RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task MoneyOverflowIs422MoneyOutOfRange()
    {
        using var f = Host();
        var res = await f.CreateClient().GetAsync("/internal/v1/_t/overflow");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
        Assert.Equal("money.out_of_range", (await Problem(res)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task WireFormRequiredNullIsWrittenOptionalNullIsOmittedEnumsUseTheirContractName()
    {
        using var f = Host();
        var c = f.CreateClient();
        // maybe / note (not required, null) are omitted; label (required, null) is written as null; logo (Optional, unset) is omitted
        Assert.Equal("""{"amount":"12.00","label":null,"step":"totp_required"}""", await c.GetStringAsync("/internal/v1/_t/money"));
        Assert.Equal("""{"amount":"12.00","label":"x","logo":null,"step":"Done"}""", await c.GetStringAsync("/internal/v1/_t/logo"));
    }

    [Theory]
    [InlineData("{}", "absent")]
    [InlineData("""{"logo":null}""", "null")]
    [InlineData("""{"logo":"data:abc"}""", "value:data:abc")]
    public async Task OptionalDistinguishesAbsentNullAndValue(string body, string expected)
    {
        using var f = Host();
        var res = await f.CreateClient().PostAsync("/internal/v1/_t/patch", new StringContent(body, System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(expected, (await res.Content.ReadAsStringAsync()).Trim('"'));
    }

    [Fact]
    public async Task AMalformedBodyOrWrongContentTypeIs422RecordInvalidOutsideDevelopment()
    {
        await using var db = await TestDb.CloneAsync();
        using var f = StagingHost(db);
        var c = f.CreateClient();
        foreach (var req in new[]
        {
            new StringContent("{ not json", System.Text.Encoding.UTF8, "application/json"),
            new StringContent("{}", System.Text.Encoding.UTF8, "text/plain"), // 415 in ASP.NET; rendered as the same ApiProblem
        })
        {
            var res = await c.PostAsync("/internal/v1/_t/patch", req);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
            var p = await Problem(res);
            Assert.Equal("record.invalid", p.GetProperty("code").GetString());
            Assert.Equal(422, p.GetProperty("status").GetInt32());
        }
    }

    [Fact]
    public async Task ATeasExceptionMayUseTheRowsAlternativeStatusOnly()
    {
        using var f = Host();
        var c = f.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/internal/v1/_t/throw/connect.key_revoked")).StatusCode);
        var res = await c.GetAsync("/internal/v1/_t/throw/connect.key_revoked/409");
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        var p = await Problem(res);
        Assert.Equal(409, p.GetProperty("status").GetInt32());
        Assert.Equal("connect.key_revoked", p.GetProperty("code").GetString());
        Assert.Throws<ArgumentException>(() => new TeasException("connect.key_revoked", status: 422));
        Assert.Throws<ArgumentException>(() => new TeasException("record.not_found", status: 409)); // a row without an alternative
    }

    [Fact]
    public async Task OpenApiDeclaresMoneyAsThePatternStringAndStripsTheInternalPrefix()
    {
        using var f = Host();
        var doc = JsonDocument.Parse(await f.CreateClient().GetStringAsync("/_t/openapi.json")).RootElement;
        const string pattern = @"^-?(0|[1-9][0-9]{0,15})\.[0-9]{2}$";
        var money = doc.GetProperty("components").GetProperty("schemas").GetProperty("Money");
        Assert.Equal("string", money.GetProperty("type").GetString());
        Assert.Equal(pattern, money.GetProperty("pattern").GetString());

        Assert.True(doc.GetProperty("paths").TryGetProperty("/_t/money", out var op), "path without /internal/v1");
        var probe = Resolve(doc, op.GetProperty("get").GetProperty("responses").GetProperty("200").GetProperty("content").GetProperty("application/json").GetProperty("schema"));
        var props = probe.GetProperty("properties");
        Assert.Equal(pattern, Resolve(doc, props.GetProperty("amount")).GetProperty("pattern").GetString());
        Assert.Equal(pattern, Resolve(doc, props.GetProperty("maybe")).GetProperty("pattern").GetString()); // not oneOf [null, Money]
        var step = Resolve(doc, props.GetProperty("step"));
        Assert.Equal(["totp_required", "Done"], step.GetProperty("enum").EnumerateArray().Select(x => x.GetString()!).ToArray());
        // a not-required member is omitted when null, so its schema has no "null" (generated `note?: string`)
        Assert.Equal(["amount", "label", "step"], probe.GetProperty("required").EnumerateArray().Select(x => x.GetString()!).Order().ToArray());
        Assert.Equal("string", props.GetProperty("note").GetProperty("type").GetString());
        // a required-nullable member keeps null and stays required (generated `label: string | null`)
        Assert.Equal(["null", "string"], props.GetProperty("label").GetProperty("type").EnumerateArray().Select(x => x.GetString()!).Order().ToArray());
        // Optional<string?>: [null, string], not required (generated `logo?: string | null`)
        Assert.Equal(["null", "string"], Resolve(doc, props.GetProperty("logo")).GetProperty("type").EnumerateArray().Select(x => x.GetString()!).Order().ToArray());
    }

    static JsonElement Resolve(JsonElement doc, JsonElement schema)
    {
        while (true)
        {
            if (schema.TryGetProperty("$ref", out var r))
            {
                schema = doc;
                foreach (var part in r.GetString()!.TrimStart('#', '/').Split('/')) schema = schema.GetProperty(part);
            }
            else if (schema.TryGetProperty("oneOf", out var one) && one.GetArrayLength() == 1) schema = one[0];
            else return schema;
        }
    }
}
