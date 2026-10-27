using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;

namespace Teas.App.Platform.Auth;

/// <summary>256-bit random tokens (session, login challenge, link) and the hashes the database keeps. Only sha256 of a token is ever stored.</summary>
public static class Tokens
{
    public static string New() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] Hash(string token) => SHA256.HashData(Encoding.UTF8.GetBytes(token));

    /// <summary>The lockout / event key: sha256(lower(trim(email))). The email itself is never written to auth_failures or auth_events.</summary>
    public static byte[] EmailKey(string email) => SHA256.HashData(Encoding.UTF8.GetBytes(email.Trim().ToLowerInvariant()));
}

/// <summary>SP3 4.4 passwords: ASP.NET Identity's PasswordHasher (PBKDF2-HMAC-SHA512, v3 format), the strength rule of the mock, and the dummy verification
/// that makes an unknown email cost what a wrong password costs. A singleton so the dummy hash is made once, at startup.</summary>
public sealed partial class PasswordService
{
    readonly PasswordHasher<object> _hasher = new();
    readonly string _dummy;
    long _verifications;

    public PasswordService() => _dummy = _hasher.HashPassword(null!, Convert.ToHexString(RandomNumberGenerator.GetBytes(16)));

    /// <summary>How many hash verifications ran (a test reads it: unknown email and wrong password must each cost exactly one).</summary>
    public long Verifications => Interlocked.Read(ref _verifications);

    /// <summary>A longer string is never hashed (a request body may be 30 MB); it is refused as too weak / as a wrong password.</summary>
    public const int MaxLength = 1024;

    public string Hash(string password) => _hasher.HashPassword(null!, password);

    /// <summary>With no hash (unknown user, or an account that must set its password via a link) it verifies against a dummy and answers false.</summary>
    public bool Verify(string? hash, string password)
    {
        Interlocked.Increment(ref _verifications);
        var result = _hasher.VerifyHashedPassword(null!, hash ?? _dummy, password.Length > MaxLength ? "" : password);   // still exactly one verification
        return hash is not null && password.Length <= MaxLength && result != PasswordVerificationResult.Failed;
    }

    [GeneratedRegex(@"^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).{10,}\z", RegexOptions.CultureInvariant)]
    private static partial Regex Strength();

    public static bool IsStrong(string? password) => password is { Length: <= MaxLength } && Strength().IsMatch(password);
}

/// <summary>RCV-XXXX-XXXX from the alphabet that leaves out the look-alikes (0 O 1 I).</summary>
public static class RecoveryCodes
{
    const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    public static string New()
    {
        static string Pick() => string.Create(4, 0, (span, _) => { for (var i = 0; i < span.Length; i++) span[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)]; });
        return $"RCV-{Pick()}-{Pick()}";
    }

    public static string Normalize(string input) => input.Trim().ToUpperInvariant();
}

/// <summary>Encrypts what must be recoverable (the TOTP secret). The host implements it with ASP.NET Data Protection, purpose teas.totp.v1, key ring on TEAS_DP_KEYS_DIR.</summary>
public interface ISecretProtector
{
    byte[] Protect(byte[] plain);

    /// <summary>Throws CryptographicException when the key ring is gone or the data was tampered with.</summary>
    byte[] Unprotect(byte[] cipher);
}
