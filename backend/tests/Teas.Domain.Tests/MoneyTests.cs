using System.Globalization;
using System.Text.Json;
using Teas.Domain;

namespace Teas.Domain.Tests;

public class MoneyTests
{
    [Fact]
    public void RoundTripsTwoDecimalString()
    {
        var m = JsonSerializer.Deserialize<Money>("\"64200.00\"");
        Assert.Equal(64200.00m, m.Value);
        Assert.Equal("\"64200.00\"", JsonSerializer.Serialize(m));
    }

    [Fact]
    public void WritesTwoDecimalsEvenForWholeAndNegativeAmounts()
    {
        Assert.Equal("\"5.00\"", JsonSerializer.Serialize(Money.Of(5m)));
        Assert.Equal("\"-12.30\"", JsonSerializer.Serialize(Money.Of(-12.3m)));
    }

    [Fact]
    public void RefusesAJsonNumber() =>
        Assert.ThrowsAny<JsonException>(() => JsonSerializer.Deserialize<Money>("64200"));

    [Theory]
    [InlineData("\"64200\"")]
    [InlineData("\"1.005\"")]
    [InlineData("\"1.0\"")]
    [InlineData("\" 1.00\"")]
    [InlineData("\"\"")]
    public void RefusesAnyStringThatIsNotExactlyTwoDecimals(string json) =>
        Assert.ThrowsAny<JsonException>(() => JsonSerializer.Deserialize<Money>(json));

    [Theory]
    [InlineData("1.005", "1.01")]
    [InlineData("1.004", "1.00")]
    [InlineData("-1.005", "-1.01")]
    [InlineData("0.125", "0.13")]
    [InlineData("2.5", "2.50")]
    public void RoundsHalfAwayFromZero(string input, string expected) =>
        Assert.Equal(expected, Money.Of(decimal.Parse(input, CultureInfo.InvariantCulture)).ToString());
}
