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
    [InlineData("64200")]
    [InlineData("1.005")]
    [InlineData("1.0")]
    [InlineData(" 1.00")]
    [InlineData("1.00 ")]
    [InlineData("1.00\n")]
    [InlineData("")]
    [InlineData("-0.00")]
    [InlineData("0001.00")]
    [InlineData("+1.00")]
    [InlineData("1,000.00")]
    [InlineData("๑.๐๐")]            // Thai digits
    [InlineData("١.٠٠")]            // Arabic-Indic digits
    [InlineData("99999999999999999.00")]   // 17 integer digits
    [InlineData("99999999999999999999999999999999.00")] // decimal overflow
    public void RefusesAnyStringThatIsNotCanonical(string s)
    {
        Assert.False(Money.TryParse(s, out _));
        var json = JsonSerializer.Serialize(s);
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Money>(json));
    }

    [Theory]
    [InlineData("0.00")]
    [InlineData("-0.01")]
    [InlineData("9999999999999999.99")] // numeric(18,2) max
    [InlineData("-9999999999999999.99")]
    public void AcceptsCanonicalValues(string s)
    {
        Assert.True(Money.TryParse(s, out var m));
        Assert.Equal(s, m.ToString());
    }

    [Theory]
    [InlineData("1.005", "1.01")]
    [InlineData("1.004", "1.00")]
    [InlineData("-1.005", "-1.01")]
    [InlineData("0.125", "0.13")]
    [InlineData("2.5", "2.50")]
    public void RoundsHalfAwayFromZero(string input, string expected) =>
        Assert.Equal(expected, Money.Of(decimal.Parse(input, CultureInfo.InvariantCulture)).ToString());

    [Fact]
    public void ThreeSubCentAmountsSumToZeroAndScaleStaysAtMostTwo()
    {
        var sum = Money.Zero + Money.Of(0.004m) + Money.Of(0.004m) + Money.Of(0.004m);
        Assert.Equal("0.00", sum.ToString());
        Assert.True(decimal.GetBits(Money.Of(1.2345m).Value)[3] >> 16 <= 2);
        Assert.Equal(Money.Of(3m), Money.Of(5m) - Money.Of(2m));
        Assert.Equal(0.30m, (Money.Of(0.1m) + Money.Of(0.2m)).Value);
    }

    [Fact]
    public void OfRefusesMoreThanSixteenIntegerDigits()
    {
        Assert.Equal("9999999999999999.99", Money.Of(9999999999999999.99m).ToString());
        var e = Assert.Throws<MoneyOutOfRangeException>(() => Money.Of(10000000000000000m));
        Assert.Equal("money.out_of_range", e.Code);
        Assert.Throws<MoneyOutOfRangeException>(() => Money.Of(-10000000000000000m));
        Assert.Throws<MoneyOutOfRangeException>(() => Money.Of(9999999999999999.99m) + Money.Of(0.01m));
    }
}
