using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Teas.Integration.Tests;

public class HealthTests
{
    [Fact]
    public async Task LiveIs200()
    {
        using var f = new WebApplicationFactory<Program>();
        var res = await f.CreateClient().GetAsync("/health/live");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task VersionComesFromConfiguration()
    {
        using var f = new WebApplicationFactory<Program>().WithWebHostBuilder(b => b.UseSetting("TEAS_VERSION", "9.9.9-test"));
        var body = await f.CreateClient().GetStringAsync("/version");
        Assert.Contains("9.9.9-test", body);
    }
}
