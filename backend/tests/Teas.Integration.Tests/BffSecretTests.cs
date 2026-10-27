using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;

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
}
