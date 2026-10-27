using System.Text;
using Teas.Domain.Platform;

namespace Teas.Domain.Tests;

// SP3 S5 (domain half): RFC 6238 Appendix B (SHA1, secret "12345678901234567890"), the +-1 step window, a used step.
public class TotpTests
{
    static readonly byte[] Rfc = Encoding.ASCII.GetBytes("12345678901234567890");

    // RFC 6238 Appendix B gives 8 digits; the 6-digit code is the last six of them.
    [Theory]
    [InlineData(59L, "287082")]
    [InlineData(1111111109L, "081804")]
    [InlineData(1111111111L, "050471")]
    [InlineData(1234567890L, "005924")]
    [InlineData(2000000000L, "279037")]
    [InlineData(20000000000L, "353130")]
    public void Rfc6238VectorsPass(long unixSeconds, string code) =>
        Assert.Equal(code, Totp.Code(Rfc, Totp.StepOf(DateTimeOffset.FromUnixTimeSeconds(unixSeconds))));

    [Fact]
    public void TheCurrentPreviousAndNextStepAreAccepted()
    {
        var now = DateTimeOffset.FromUnixTimeSeconds(1111111111);
        var step = Totp.StepOf(now);
        foreach (var d in new long[] { -1, 0, 1 })
            Assert.Equal(step + d, Totp.Match(Rfc, Totp.Code(Rfc, step + d), now, null));
    }

    [Fact]
    public void TwoStepsAwayIsRefused()
    {
        var now = DateTimeOffset.FromUnixTimeSeconds(1111111111);
        var step = Totp.StepOf(now);
        Assert.Null(Totp.Match(Rfc, Totp.Code(Rfc, step - 2), now, null));
        Assert.Null(Totp.Match(Rfc, Totp.Code(Rfc, step + 2), now, null));
    }

    [Fact]
    public void AStepAtOrBeforeTheLastUsedOneIsRefused()
    {
        var now = DateTimeOffset.FromUnixTimeSeconds(1111111111);
        var step = Totp.StepOf(now);
        Assert.Null(Totp.Match(Rfc, Totp.Code(Rfc, step), now, step));        // the same step again
        Assert.Null(Totp.Match(Rfc, Totp.Code(Rfc, step - 1), now, step));    // an older one
        Assert.Equal(step + 1, Totp.Match(Rfc, Totp.Code(Rfc, step + 1), now, step));
    }

    [Theory]
    [InlineData("")]
    [InlineData("12345")]
    [InlineData("1234567")]
    [InlineData("12 456")]
    [InlineData("١٢٣٤٥٦")]   // Arabic-Indic digits are not digits here
    public void AMalformedCodeNeverMatches(string code) =>
        Assert.Null(Totp.Match(Rfc, code, DateTimeOffset.FromUnixTimeSeconds(59), null));

    [Fact]
    public void Base32RoundTripsAndTheUriCarriesTheSecret()
    {
        var secret = Totp.NewSecret();
        Assert.Equal(20, secret.Length);
        var text = Totp.ToBase32(secret);
        Assert.Matches("^[A-Z2-7]{32}$", text);
        Assert.Equal(secret, Totp.FromBase32(text));
        Assert.Equal("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", Totp.ToBase32(Rfc));   // RFC 4648 / RFC 6238 test secret
        var uri = Totp.Uri("TEAS", "a@b.test", text);
        Assert.Equal($"otpauth://totp/TEAS:a%40b.test?secret={text}&issuer=TEAS&algorithm=SHA1&digits=6&period=30", uri);
    }
}
