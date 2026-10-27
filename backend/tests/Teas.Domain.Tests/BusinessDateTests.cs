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
}
