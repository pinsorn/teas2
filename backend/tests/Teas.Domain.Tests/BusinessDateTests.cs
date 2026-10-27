using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Teas.Domain;

namespace Teas.Domain.Tests;

public class BusinessDateTests
{
    [Fact]
    public void Utc1730IsTheNextDayInBangkok()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.Parse("2026-10-27T17:30:00Z"));
        Assert.Equal(new DateOnly(2026, 10, 28), BusinessDate.Today(clock).Value);
    }

    [Fact]
    public void Utc1659IsStillTheSameDayInBangkok()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.Parse("2026-10-27T16:59:00Z"));
        Assert.Equal(new DateOnly(2026, 10, 27), BusinessDate.Today(clock).Value);
    }

    [Fact]
    public void JsonIsAStrictIsoDateString()
    {
        var d = new BusinessDate(new DateOnly(2026, 10, 28));
        Assert.Equal("\"2026-10-28\"", JsonSerializer.Serialize(d));
        Assert.Equal(d, JsonSerializer.Deserialize<BusinessDate>("\"2026-10-28\""));
    }

    [Theory]
    [InlineData("\"2026-10-28T00:00:00\"")]
    [InlineData("\"28/10/2026\"")]
    [InlineData("\"2026-1-8\"")]
    [InlineData("\" 2026-10-28\"")]
    [InlineData("\"2026-02-30\"")]
    [InlineData("\"๒๐๒๖-๑๐-๒๘\"")]
    [InlineData("20261028")]
    public void JsonRefusesAnythingElse(string json) =>
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<BusinessDate>(json));
}
