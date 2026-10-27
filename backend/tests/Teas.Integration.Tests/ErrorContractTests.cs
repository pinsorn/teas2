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
using Teas.Domain;

namespace Teas.Integration.Tests;

// SP3 P3: a thrown TeasException renders ApiProblem; Money / enums / optional members reach the OpenAPI document as the contract says.
public class ErrorContractTests
{
    public enum Step { [JsonStringEnumMemberName("totp_required")] TotpRequired, Done }
    // Convention (SP3 4.8): a mandatory member is `required`, an optional one is nullable and omitted when null.
    public sealed record Probe
    {
        public required Money Amount { get; init; }
        public Money? Maybe { get; init; }
        public string? Note { get; init; }
        public required Step Step { get; init; }
    }

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
        b.ConfigureServices(s => s.AddSingleton<IStartupFilter>(new TestRoutes(e =>
        {
            e.MapGet("/internal/v1/_t/throw/{code}", (string code) => { throw new TeasException(code, "why", new Dictionary<string, string[]> { ["name"] = ["required"] }); });
            e.MapGet("/internal/v1/_t/boom", () => { throw new InvalidOperationException("secret connection string"); });
            e.MapGet("/internal/v1/_t/money", () => new Probe { Amount = Money.Of(12), Step = Step.TotpRequired });
            e.MapGet("/internal/v1/_t/overflow", () => Money.Of(10000000000000000m));
            e.MapOpenApi("/_t/openapi.json");
        }))));

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
    public async Task WireFormMoneyIsAStringEnumsUseTheirContractNameAndNullsAreOmitted()
    {
        using var f = Host();
        var json = await f.CreateClient().GetStringAsync("/internal/v1/_t/money");
        Assert.Equal("""{"amount":"12.00","step":"totp_required"}""", json);
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
        // optional members: present, not required, and no "null" in the type (the frozen TS says `note?: string`)
        Assert.Equal(["amount", "step"], probe.GetProperty("required").EnumerateArray().Select(x => x.GetString()!).Order().ToArray());
        Assert.Equal("string", props.GetProperty("note").GetProperty("type").GetString());
    }

    static JsonElement Resolve(JsonElement doc, JsonElement schema)
    {
        while (schema.TryGetProperty("$ref", out var r))
        {
            schema = doc;
            foreach (var part in r.GetString()!.TrimStart('#', '/').Split('/')) schema = schema.GetProperty(part);
        }
        return schema;
    }
}
