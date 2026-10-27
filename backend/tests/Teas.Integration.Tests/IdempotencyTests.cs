using System.Net;
using System.Text;
using System.Text.Json;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// SP3 4.7 Idempotency (P4): the claim is the first statement of the command transaction; a concurrent duplicate blocks on it.
public sealed class IdempotencyTests : IAsyncLifetime
{
    DbClone _db = null!;
    public async Task InitializeAsync() => _db = await TestDb.CloneAsync();
    public async Task DisposeAsync() => await _db.DisposeAsync();

    static HttpRequestMessage Post(Guid company, string? key, string body, bool barrier = false, string query = "", Guid? actor = null)
    {
        var r = new HttpRequestMessage(HttpMethod.Post, $"/internal/v1/_t/cmd/{company}{query}") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        if (key is not null) r.Headers.Add("Idempotency-Key", key);
        if (barrier) r.Headers.Add("x-barrier", "1");
        if (actor is { } a) r.Headers.Add("x-actor", a.ToString());
        return r;
    }

    static async Task<string> CodeAsync(HttpResponseMessage r) => JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement.GetProperty("code").GetString()!;

    [Fact]
    public async Task TheSameKeyTwiceSequentiallyHasOneEffectAndAnIdenticalReplay()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        var c = f.CreateClient();
        var key = Guid.NewGuid().ToString();
        var first = await c.SendAsync(Post(company, key, """{"data":"a"}"""));
        var second = await c.SendAsync(Post(company, key, """{"data":"a"}"""));
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);
        Assert.Equal(await first.Content.ReadAsStringAsync(), await second.Content.ReadAsStringAsync());   // same effect guid, byte for byte
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "audit_log", "command = 'test.effect'"));
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "idempotency_records", "status_code = 201"));
    }

    [Fact]
    public async Task TheSameKeyInParallelHasOneEffectAndBothGetTheSameAnswer()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        var key = Guid.NewGuid().ToString();
        var a = f.CreateClient().SendAsync(Post(company, key, """{"data":"a"}""", barrier: true));
        var b = f.CreateClient().SendAsync(Post(company, key, """{"data":"a"}""", barrier: true));
        var res = await Task.WhenAll(a, b);
        Assert.All(res, r => Assert.Equal(HttpStatusCode.Created, r.StatusCode));
        Assert.Equal(await res[0].Content.ReadAsStringAsync(), await res[1].Content.ReadAsStringAsync());
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "audit_log", "command = 'test.effect'"));
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "idempotency_records"));
    }

    [Fact]
    public async Task TheSameKeyWithADifferentBodyIs422KeyReused()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        var c = f.CreateClient();
        var key = Guid.NewGuid().ToString();
        Assert.Equal(HttpStatusCode.Created, (await c.SendAsync(Post(company, key, """{"data":"a"}"""))).StatusCode);
        var res = await c.SendAsync(Post(company, key, """{"data":"b"}"""));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
        Assert.Equal("idempotency.key_reused", await CodeAsync(res));
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "audit_log", "command = 'test.effect'"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("not-a-uuid")]
    public async Task AMissingOrMalformedKeyIs400KeyRequired(string? key)
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        var res = await f.CreateClient().SendAsync(Post(company, key, "{}"));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("idempotency.key_required", await CodeAsync(res));
    }

    [Fact]
    public async Task ACommandThatThrowsAfterTheClaimLeavesNoIdempotencyRowAndNoAuditRowAndTheKeyIsReusable()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        var c = f.CreateClient();
        var key = Guid.NewGuid().ToString();
        var bad = await c.SendAsync(Post(company, key, """{"fail":true}"""));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bad.StatusCode);
        Assert.Equal(0, await PlatformTestHost.CountAsync(_db, "idempotency_records"));
        Assert.Equal(0, await PlatformTestHost.CountAsync(_db, "audit_log"));
        var ok = await c.SendAsync(Post(company, key, """{"fail":false}"""));   // the failed attempt did not consume the key (even with another body)
        Assert.Equal(HttpStatusCode.Created, ok.StatusCode);
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "audit_log", "command = 'test.effect' AND idempotency_key IS NOT NULL"));
    }

    [Fact]
    public async Task TheSameKeyAndBodyOnADifferentConcretePathIs422KeyReused()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        var c = f.CreateClient();
        var key = Guid.NewGuid().ToString();
        Assert.Equal(HttpStatusCode.Created, (await c.SendAsync(Post(company, key, """{"data":"a"}""", query: "?x=1"))).StatusCode);
        var res = await c.SendAsync(Post(company, key, """{"data":"a"}""", query: "?x=2"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
        Assert.Equal("idempotency.key_reused", await CodeAsync(res));
    }

    [Fact]
    public async Task AnEmptyBodyCommandStoresNullAndReplaysAs204Empty()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        var c = f.CreateClient();
        var key = Guid.NewGuid().ToString();
        var first = await c.SendAsync(Post(company, key, """{"status":204}"""));
        var second = await c.SendAsync(Post(company, key, """{"status":204}"""));
        Assert.Equal(HttpStatusCode.NoContent, first.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, second.StatusCode);
        Assert.Equal("", await second.Content.ReadAsStringAsync());
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "idempotency_records", "status_code = 204 AND response IS NULL"));
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "audit_log", "command = 'test.effect'"));
    }

    [Fact]
    public async Task ACommandReturningANon2xxThrowsAndRollsBack()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        var res = await f.CreateClient().SendAsync(Post(company, Guid.NewGuid().ToString(), """{"status":400}"""));
        Assert.Equal(HttpStatusCode.InternalServerError, res.StatusCode);   // InvalidOperationException, not a stored 400
        Assert.Equal(0, await PlatformTestHost.CountAsync(_db, "idempotency_records"));
        Assert.Equal(0, await PlatformTestHost.CountAsync(_db, "audit_log"));
    }

    [Fact]
    public async Task ASecondRequestBlockedBehindAFailingFirstRunsOnceTheFirstRollsBack()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        var key = Guid.NewGuid().ToString();
        var a = f.CreateClient().SendAsync(Post(company, key, """{"fail":true,"holdMs":2500}"""));   // claims, holds, then fails
        await Task.Delay(900);
        var b = f.CreateClient().SendAsync(Post(company, key, """{"fail":false}"""));
        await Task.Delay(700);
        Assert.False(a.IsCompleted);
        Assert.False(b.IsCompleted);   // B is blocked on A's claim
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await a).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await b).StatusCode);
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "audit_log", "command = 'test.effect'"));
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "idempotency_records", "status_code = 201"));
    }

    [Fact]
    public async Task TheSameKeyFromTwoActorsOrTwoCompaniesRunsIndependently()
    {
        var c1 = await PlatformTestHost.NewCompanyAsync(_db);
        var c2 = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        var c = f.CreateClient();
        var key = Guid.NewGuid().ToString();
        Assert.Equal(HttpStatusCode.Created, (await c.SendAsync(Post(c1, key, """{"data":"a"}"""))).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await c.SendAsync(Post(c1, key, """{"data":"a"}""", actor: Guid.NewGuid()))).StatusCode);   // another actor, same company
        Assert.Equal(2, await PlatformTestHost.CountAsync(_db, "audit_log", "command = 'test.effect'"));
        Assert.Equal(HttpStatusCode.Created, (await c.SendAsync(Post(c2, key, """{"data":"a"}"""))).StatusCode);   // another company
        Assert.Equal(3, await PlatformTestHost.CountAsync(_db, "audit_log", "command = 'test.effect'"));
        Assert.Equal(3, await PlatformTestHost.CountAsync(_db, "idempotency_records", "status_code = 201"));
    }
}
