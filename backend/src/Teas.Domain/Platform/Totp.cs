using System.Security.Cryptography;
using System.Text;

namespace Teas.Domain.Platform;

/// <summary>SP3 4.4 TOTP: RFC 6238, HMAC-SHA1, 6 digits, 30 s steps, window +-1 step; a step at or before the last used one is refused.</summary>
public static class Totp
{
    public const int Digits = 6;
    public const int PeriodSeconds = 30;
    const string Base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    public static long StepOf(DateTimeOffset t) => Math.DivRem(t.ToUnixTimeSeconds(), PeriodSeconds).Quotient;

    /// <summary>RFC 4226 dynamic truncation of HMAC-SHA1(secret, step as 8 big-endian bytes).</summary>
    public static string Code(byte[] secret, long step)
    {
        var msg = new byte[8];
        for (var i = 7; i >= 0; i--) { msg[i] = (byte)(step & 0xff); step >>= 8; }
        var h = HMACSHA1.HashData(secret, msg);
        var o = h[^1] & 0x0f;
        var bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
        return (bin % 1_000_000).ToString("D6", System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>The step whose code is <paramref name="code"/>, among now-1, now, now+1 and strictly after <paramref name="lastStep"/>; null = refuse.
    /// All three candidates are compared (fixed time), so the answer does not depend on which one matched.</summary>
    public static long? Match(byte[] secret, string code, DateTimeOffset now, long? lastStep)
    {
        if (code is not { Length: Digits } || !code.All(c => c is >= '0' and <= '9')) return null;
        var given = Encoding.ASCII.GetBytes(code);
        var current = StepOf(now);
        long? hit = null;
        for (var d = -1L; d <= 1; d++)
        {
            var step = current + d;
            if (CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Code(secret, step)), given) && (lastStep is null || step > lastStep)) hit ??= step;
        }
        return hit;
    }

    /// <summary>160-bit random secret.</summary>
    public static byte[] NewSecret() => RandomNumberGenerator.GetBytes(20);

    public static string ToBase32(byte[] data)
    {
        var sb = new StringBuilder((data.Length * 8 + 4) / 5);
        int buffer = 0, bits = 0;
        foreach (var b in data)
        {
            buffer = (buffer << 8) | b;
            bits += 8;
            while (bits >= 5) { sb.Append(Base32Alphabet[(buffer >> (bits - 5)) & 31]); bits -= 5; }
        }
        if (bits > 0) sb.Append(Base32Alphabet[(buffer << (5 - bits)) & 31]);
        return sb.ToString();
    }

    public static byte[] FromBase32(string text)
    {
        var bytes = new List<byte>(text.Length * 5 / 8);
        int buffer = 0, bits = 0;
        foreach (var c in text.TrimEnd('='))
        {
            var v = Base32Alphabet.IndexOf(char.ToUpperInvariant(c));
            if (v < 0) throw new FormatException("not base32");
            buffer = (buffer << 5) | v;
            bits += 5;
            if (bits >= 8) { bytes.Add((byte)((buffer >> (bits - 8)) & 0xff)); bits -= 8; }
        }
        return [.. bytes];
    }

    /// <summary>The otpauth:// URI an authenticator app scans (the QR is drawn by the browser).</summary>
    public static string Uri(string issuer, string email, string base32Secret) =>
        $"otpauth://totp/{System.Uri.EscapeDataString(issuer)}:{System.Uri.EscapeDataString(email)}?secret={base32Secret}&issuer={System.Uri.EscapeDataString(issuer)}&algorithm=SHA1&digits={Digits}&period={PeriodSeconds}";
}
