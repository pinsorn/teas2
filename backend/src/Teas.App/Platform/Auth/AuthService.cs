using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Concurrency;
using Teas.Domain;
using Teas.Domain.Platform;

namespace Teas.App.Platform.Auth;

public sealed record LoginResult(IssuedSession? Session, string? Challenge);
public sealed record ReloginResult(IssuedSession? Session, bool TotpRequired);
public sealed record ProfileView(Guid UserId, string Email, string DisplayName, bool TotpEnabled, int RecoveryRemaining);

/// <summary>
/// SP3 4.4: sign-in, second factor, relogin, password change, enrolment, logout and the session list. Rules that are easy to get wrong:
/// - one hash verification on every password path (an unknown email verifies a dummy), the same 401 for both;
/// - the failure counter is per sha256(lower(trim(email))) over login, the second-factor step, relogin and the current-password check; the failure that
///   reaches 5 itself answers 429; the password step of a two-step login does NOT clear it (only a finished sign-in does);
/// - every single-use secret is claimed with a guarded UPDATE (a TOTP step, a recovery code, a challenge): two racing requests, one winner;
/// - a failure is written in its own committed transaction before the exception, so a refusal still counts;
/// - auth is audited in the session's company, else the user's first active membership, else only in auth_events.
/// </summary>
public sealed class AuthService(TeasDbContext db, TimeProvider clock, SessionService sessions, PasswordService passwords, ISecretProtector protector, AuthAudit authAudit)
{
    const int LockAfter = 5;
    static readonly TimeSpan LockFor = TimeSpan.FromMinutes(15);
    static readonly TimeSpan ChallengeTtl = TimeSpan.FromMinutes(5);

    sealed record U(Guid Id, string Email, string DisplayName, string? PasswordHash, byte[]? TotpSecretEnc, long? TotpLastStep, Guid? LastCompanyId);

    const string UserCols = "u.id, u.email::text, u.display_name, u.password_hash, u.totp_secret_enc, u.totp_last_step, u.last_company_id";
    static U ReadUser(NpgsqlDataReader r) => new(r.GetGuid(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3),
        r.IsDBNull(4) ? null : r.GetFieldValue<byte[]>(4), r.IsDBNull(5) ? null : r.GetInt64(5), r.IsDBNull(6) ? null : r.GetGuid(6));

    async Task<U?> UserByIdAsync(Guid id, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        return await Q.OneAsync(db, $"SELECT {UserCols} FROM teas.users u WHERE u.id = @i", ReadUser, ct, TxSql.P("i", id));
    }

    // ---------------------------------------------------------------- lockout and events

    /// <summary>
    /// RESERVES an attempt before anything is verified: one atomic upsert counts it and returns its number n (an expired lock starts the count again). n above 5
    /// means the key is locked (the lock is set when n reaches 5 and kept while it lasts): 429 auth.locked, nothing is verified. Attempts 1-5 are checked; the
    /// 5th that fails answers 429 too. Because the count is taken before the check, a burst cannot buy more than 5 checks. Own transaction, committed.
    /// </summary>
    async Task<int> ReserveAsync(byte[] key, Guid? userId, RequestInfo req, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        const string Next = "CASE WHEN f.locked_until IS NOT NULL AND f.locked_until <= @now THEN 1 ELSE f.failures + 1 END";
        var n = await Q.ScalarAsync<int>(db, $"""
            INSERT INTO teas.auth_failures AS f (key_hash, failures, locked_until, updated_at) VALUES (@k, 1, NULL, @now)
            ON CONFLICT (key_hash) DO UPDATE SET failures = {Next},
              locked_until = CASE WHEN {Next} >= @limit THEN CASE WHEN f.locked_until > @now THEN f.locked_until ELSE @until END ELSE NULL END, updated_at = @now
            RETURNING failures
            """, ct, TxSql.P("k", key), TxSql.P("now", now), TxSql.P("limit", LockAfter), TxSql.P("until", now + LockFor));
        if (n > LockAfter) await EventAsync("auth.locked", key, userId, req, ct);
        await tx.CommitAsync(ct);
        return n > LockAfter ? throw new TeasException("auth.locked") : n;
    }

    /// <summary>The reserved attempt did not count: the password was right and the second factor is still to come. (A lock set by this very attempt goes with it.)</summary>
    async Task RefundAsync(byte[] key, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await Q.ExecAsync(db, "UPDATE teas.auth_failures SET failures = failures - 1, locked_until = CASE WHEN failures - 1 >= @limit THEN locked_until ELSE NULL END WHERE key_hash = @k AND failures > 0",
            ct, TxSql.P("k", key), TxSql.P("limit", LockAfter));
        await tx.CommitAsync(ct);
    }

    async Task ClearFailuresAsync(byte[] key, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await Q.ExecAsync(db, "DELETE FROM teas.auth_failures WHERE key_hash = @k", ct, TxSql.P("k", key));
        await tx.CommitAsync(ct);
    }

    /// <summary>The reserved attempt <paramref name="n"/> failed: logs it and returns the exception to throw (auth.locked when it was the 5th).</summary>
    async Task<TeasException> FailAsync(byte[] key, string kind, Guid? userId, RequestInfo req, string code, int n, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var locked = n >= LockAfter;
        await EventAsync(locked ? "auth.locked" : kind, key, userId, req, ct);
        await tx.CommitAsync(ct);
        return new TeasException(locked ? "auth.locked" : code);
    }

    Task EventAsync(string kind, byte[]? emailKey, Guid? userId, RequestInfo req, CancellationToken ct) => Q.EventAsync(db, clock.GetUtcNow(), kind, emailKey, userId, req, ct);

    Task AuditAsync(Guid userId, string name, Guid? sessionCompany, RequestInfo req, string command, string target, CancellationToken ct, object? after = null) =>
        authAudit.RecordAsync(userId, name, sessionCompany, req, command, target, ct, after);

    Task<Guid?> FirstCompanyAsync(Guid userId, Guid? preferred, CancellationToken ct) => authAudit.FirstCompanyAsync(userId, preferred, ct);

    // ---------------------------------------------------------------- sign-in

    public async Task<LoginResult> LoginAsync(string email, string password, string? oldToken, RequestInfo req, CancellationToken ct = default)
    {
        email = email.Trim();
        var key = Tokens.EmailKey(email);
        var n = await ReserveAsync(key, null, req, ct);
        U? user;
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
            user = await Q.OneAsync(db, $"SELECT {UserCols} FROM teas.users u WHERE u.email = @e::citext", ReadUser, ct, TxSql.P("e", email));
        var ok = passwords.Verify(user?.PasswordHash, password);   // always exactly one verification, whatever the email was
        if (!ok || user is null) throw await FailAsync(key, "auth.login.failed", user?.Id, req, "auth.invalid_credentials", n, ct);

        if (user.TotpSecretEnc is not null)
        {
            await RefundAsync(key, ct);   // the password was right: this attempt is not a failure; the second-factor step reserves its own
            var challenge = Tokens.New();
            var now = clock.GetUtcNow();
            await using var challengeTx = await db.Database.BeginTransactionAsync(ct);
            await Q.ExecAsync(db, "DELETE FROM teas.login_challenges WHERE expires_at < @now", ct, TxSql.P("now", now));
            await Q.ExecAsync(db, "INSERT INTO teas.login_challenges (token_hash, user_id, expires_at) VALUES (@h, @u, @exp)", ct,
                TxSql.P("h", Tokens.Hash(challenge)), TxSql.P("u", user.Id), TxSql.P("exp", now + ChallengeTtl));
            await EventAsync("auth.login.password_ok", key, user.Id, req, ct);
            await challengeTx.CommitAsync(ct);
            return new LoginResult(null, challenge);
        }

        await using var tx2 = await db.Database.BeginTransactionAsync(ct);
        var issued = await FinishSignInAsync(user, key, req, user.LastCompanyId, ct);
        if (oldToken is not null) await sessions.RevokeByTokenAsync(oldToken, "replaced", ct);
        await tx2.CommitAsync(ct);
        return new LoginResult(issued, null);
    }

    /// <summary>The end of every sign-in (password, second factor, relogin): clears the counter, opens the session, logs and audits it. Inside the caller's transaction.</summary>
    async Task<IssuedSession> FinishSignInAsync(U user, byte[] key, RequestInfo req, Guid? preferredCompany, CancellationToken ct)
    {
        await Q.ExecAsync(db, "DELETE FROM teas.auth_failures WHERE key_hash = @k", ct, TxSql.P("k", key));
        var company = await FirstCompanyAsync(user.Id, preferredCompany, ct);
        var issued = await sessions.CreateAsync(user.Id, company, req, ct);
        await EventAsync("auth.login", key, user.Id, req, ct);
        await AuditAsync(user.Id, user.DisplayName, company, req, "auth.login", user.Id.ToString(), ct);
        return issued;
    }

    /// <summary>
    /// Spends the second factor in the current transaction: a TOTP code (the matching step must be newer than totp_last_step; the UPDATE that records it is the
    /// guard against a replay and against two requests racing with the same code) or an unused recovery code (marked used by a guarded UPDATE). False = refused.
    /// </summary>
    async Task<bool> ClaimSecondFactorAsync(U user, string? code, string? recoveryCode, CancellationToken ct)
    {
        if (code is not null)
        {
            byte[] secret;
            try { secret = protector.Unprotect(user.TotpSecretEnc!); }
            catch (CryptographicException) { return false; }   // the key ring is gone: only a recovery code can sign in (spec section 7)
            if (Totp.Match(secret, code, clock.GetUtcNow(), user.TotpLastStep) is not { } step) return false;
            return await Q.ExecAsync(db, "UPDATE teas.users SET totp_last_step = @s WHERE id = @u AND (totp_last_step IS NULL OR totp_last_step < @s)", ct,
                TxSql.P("s", step), TxSql.P("u", user.Id)) == 1;
        }
        if (recoveryCode is not { Length: <= 32 }) return false;
        var given = RecoveryCodes.Normalize(recoveryCode);
        var rows = await Q.ManyAsync(db, "SELECT id, code_hash FROM teas.recovery_codes WHERE user_id = @u AND used_at IS NULL ORDER BY id",
            r => (Id: r.GetGuid(0), Hash: r.GetString(1)), ct, TxSql.P("u", user.Id));
        foreach (var (id, hash) in rows)
            if (passwords.Verify(hash, given))
                return await Q.ExecAsync(db, "UPDATE teas.recovery_codes SET used_at = @now WHERE id = @i AND used_at IS NULL", ct, TxSql.P("now", clock.GetUtcNow()), TxSql.P("i", id)) == 1;
        return false;
    }

    public async Task<IssuedSession> VerifyTotpAsync(string challenge, string? code, string? recoveryCode, string? oldToken, RequestInfo req, CancellationToken ct = default)
    {
        var hash = Tokens.Hash(challenge);
        U? user;
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
            user = await Q.OneAsync(db, $"SELECT {UserCols} FROM teas.login_challenges c JOIN teas.users u ON u.id = c.user_id WHERE c.token_hash = @h AND c.expires_at > @now",
                ReadUser, ct, TxSql.P("h", hash), TxSql.P("now", clock.GetUtcNow()));
        if (user?.TotpSecretEnc is null) throw new TeasException("auth.challenge_invalid");
        var key = Tokens.EmailKey(user.Email);
        var n = await ReserveAsync(key, user.Id, req, ct);

        IssuedSession? issued = null;
        var spent = false;
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            if (await ClaimSecondFactorAsync(user, code, recoveryCode, ct))
            {
                if (await Q.ExecAsync(db, "DELETE FROM teas.login_challenges WHERE token_hash = @h", ct, TxSql.P("h", hash)) == 1)
                {
                    issued = await FinishSignInAsync(user, key, req, user.LastCompanyId, ct);
                    if (oldToken is not null) await sessions.RevokeByTokenAsync(oldToken, "replaced", ct);
                    await tx.CommitAsync(ct);
                }
                else spent = true;   // a racing request used this challenge first: the claim above rolls back with this transaction
            }
        }
        if (spent) throw new TeasException("auth.challenge_invalid");
        return issued ?? throw await FailAsync(key, "auth.totp.failed", user.Id, req, "auth.totp_invalid", n, ct);
    }

    /// <summary>The expired session's own user signs in again: same password check and counter as login, the second factor when enrolled, a new token, the old row ended.</summary>
    public async Task<ReloginResult> ReloginAsync(string? token, string password, string? code, string? recoveryCode, RequestInfo req, CancellationToken ct = default)
    {
        var old = await sessions.ResolveAsync(token, ct) ?? throw new TeasException("auth.unauthenticated");
        if (old.State != SessionState.Expired) throw new TeasException("auth.not_expired");
        var key = Tokens.EmailKey(old.Email);
        var n = await ReserveAsync(key, old.UserId, req, ct);
        var user = await UserByIdAsync(old.UserId, ct) ?? throw new TeasException("auth.unauthenticated");
        if (!passwords.Verify(user.PasswordHash, password)) throw await FailAsync(key, "auth.relogin.failed", user.Id, req, "auth.invalid_credentials", n, ct);
        var twoStep = user.TotpSecretEnc is not null;
        if (twoStep && code is null && recoveryCode is null) { await RefundAsync(key, ct); return new ReloginResult(null, true); }

        IssuedSession? issued = null;
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            if (!twoStep || await ClaimSecondFactorAsync(user, code, recoveryCode, ct))
            {
                if (await sessions.RevokeAsync(old.Id, "relogin", ct) != 1) throw new TeasException("auth.unauthenticated");   // used by a racing request: nothing is kept
                issued = await FinishSignInAsync(user, key, req, old.ActiveCompanyId, ct);
                await tx.CommitAsync(ct);
            }
        }
        return issued is null ? throw await FailAsync(key, "auth.totp.failed", user.Id, req, "auth.totp_invalid", n, ct) : new ReloginResult(issued, false);
    }

    public async Task ExtendAsync(SessionInfo s, CancellationToken ct = default)
    {
        if (!await sessions.TouchAsync(s, force: true, ct)) throw new TeasException("auth.session_expired");
    }

    public async Task LogoutAsync(string? token, RequestInfo req, CancellationToken ct = default)
    {
        if (await sessions.ResolveAsync(token, ct) is not { } s) return;   // no session, or already over: logging out is idempotent
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        if (await sessions.RevokeAsync(s.Id, "logout", ct) == 1)
        {
            await EventAsync("auth.logout", Tokens.EmailKey(s.Email), s.UserId, req, ct);
            await AuditAsync(s.UserId, s.DisplayName, s.ActiveCompanyId, req, "auth.logout", s.UserId.ToString(), ct);
        }
        await tx.CommitAsync(ct);
    }

    // ---------------------------------------------------------------- the signed-in user

    public async Task<ProfileView> ProfileAsync(SessionInfo s, CancellationToken ct = default)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        return await Q.OneAsync(db, """
            SELECT (u.totp_secret_enc IS NOT NULL), (SELECT count(*) FROM teas.recovery_codes c WHERE c.user_id = u.id AND c.used_at IS NULL)
            FROM teas.users u WHERE u.id = @i
            """, r => new ProfileView(s.UserId, s.Email, s.DisplayName, r.GetBoolean(0), (int)r.GetInt64(1)), ct, TxSql.P("i", s.UserId))
            ?? throw new TeasException("auth.unauthenticated");
    }

    public async Task ChangePasswordAsync(SessionInfo s, string current, string next, string confirm, RequestInfo req, CancellationToken ct = default)
    {
        var key = Tokens.EmailKey(s.Email);
        var n = await ReserveAsync(key, s.UserId, req, ct);
        var user = await UserByIdAsync(s.UserId, ct) ?? throw new TeasException("auth.unauthenticated");
        if (!passwords.Verify(user.PasswordHash, current)) throw await FailAsync(key, "auth.password.failed", user.Id, req, "auth.current_password_invalid", n, ct);
        await ClearFailuresAsync(key, ct);   // the current password was right, whatever is wrong with the new one
        if (next != confirm) throw new TeasException("auth.password_mismatch");
        if (!PasswordService.IsStrong(next)) throw new TeasException("auth.password_weak");
        if (passwords.Verify(user.PasswordHash, next)) throw new TeasException("auth.password_reuse");
        var hash = passwords.Hash(next);

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await Q.ExecAsync(db, "UPDATE teas.users SET password_hash = @h, password_changed_at = @now, version = version + 1 WHERE id = @u", ct,
            TxSql.P("h", hash), TxSql.P("now", clock.GetUtcNow()), TxSql.P("u", user.Id));
        await Q.ExecAsync(db, "DELETE FROM teas.auth_failures WHERE key_hash = @k", ct, TxSql.P("k", key));
        await sessions.RevokeAllAsync(user.Id, except: s.Id, "password_change", ct);   // a new password ends every other sign-in
        await Q.ExecAsync(db, "DELETE FROM teas.login_challenges WHERE user_id = @u", ct, TxSql.P("u", user.Id));   // and every half-finished two-step sign-in
        await EventAsync("auth.password.change", key, user.Id, req, ct);
        await AuditAsync(user.Id, user.DisplayName, s.ActiveCompanyId, req, "auth.password.change", user.Id.ToString(), ct);
        await tx.CommitAsync(ct);
    }

    /// <summary>When two-step is already on, (re)enrolling needs a sign-in from the last 10 minutes (a stolen session cannot swap the authenticator). True = it was on.</summary>
    async Task<bool> RequireFreshSignInIfEnrolledAsync(SessionInfo s, CancellationToken ct)
    {
        bool on;
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
            on = await Q.ScalarAsync<bool>(db, "SELECT totp_secret_enc IS NOT NULL FROM teas.users WHERE id = @u", ct, TxSql.P("u", s.UserId));
        if (on && clock.GetUtcNow() - s.CreatedAt > TimeSpan.FromMinutes(10)) throw new TeasException("auth.forbidden", "sign in again to change two-step verification");
        return on;
    }

    /// <summary>Step 1 of enrolment: a fresh 160-bit secret, kept encrypted as PENDING until a correct code proves the app has it.</summary>
    public async Task<(string Secret, string Uri)> StartEnrolAsync(SessionInfo s, RequestInfo req, CancellationToken ct = default)
    {
        await RequireFreshSignInIfEnrolledAsync(s, ct);
        var secret = Totp.NewSecret();
        var b32 = Totp.ToBase32(secret);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await Q.ExecAsync(db, "UPDATE teas.users SET totp_pending_enc = @e, version = version + 1 WHERE id = @u", ct, TxSql.P("e", protector.Protect(secret)), TxSql.P("u", s.UserId));
        await EventAsync("auth.totp.enrol_start", Tokens.EmailKey(s.Email), s.UserId, req, ct);
        await AuditAsync(s.UserId, s.DisplayName, s.ActiveCompanyId, req, "auth.totp.enrol_start", s.UserId.ToString(), ct);
        await tx.CommitAsync(ct);
        return (b32, Totp.Uri("TEAS", s.Email, b32));
    }

    /// <summary>Step 2: the right code turns two-step on, stores 8 recovery codes (hashed) and returns them. This return is the only time they exist in clear.</summary>
    public async Task<IReadOnlyList<string>> ConfirmEnrolAsync(SessionInfo s, string code, RequestInfo req, CancellationToken ct = default)
    {
        var replacing = await RequireFreshSignInIfEnrolledAsync(s, ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var pending = await Q.ScalarAsync<byte[]>(db, "SELECT totp_pending_enc FROM teas.users WHERE id = @u", ct, TxSql.P("u", s.UserId)) ?? throw new TeasException("auth.enrol_not_started");
        byte[] secret;
        try { secret = protector.Unprotect(pending); }
        catch (CryptographicException) { throw new TeasException("auth.enrol_not_started"); }
        var step = Totp.Match(secret, code, clock.GetUtcNow(), null) ?? throw new TeasException("auth.totp_invalid");
        var claimed = await Q.ExecAsync(db, """
            UPDATE teas.users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_last_step = @s, version = version + 1
            WHERE id = @u AND totp_pending_enc = @p
            """, ct, TxSql.P("s", step), TxSql.P("u", s.UserId), TxSql.P("p", pending));
        if (claimed != 1) throw new TeasException("auth.enrol_not_started");   // a racing verify won
        await Q.ExecAsync(db, "DELETE FROM teas.recovery_codes WHERE user_id = @u", ct, TxSql.P("u", s.UserId));
        if (replacing) await sessions.RevokeAllAsync(s.UserId, except: s.Id, "totp_reenrol", ct);   // a replaced authenticator ends every other sign-in
        var codes = Enumerable.Range(0, 8).Select(_ => RecoveryCodes.New()).ToList();
        foreach (var c in codes)
            await Q.ExecAsync(db, "INSERT INTO teas.recovery_codes (user_id, code_hash) VALUES (@u, @h)", ct, TxSql.P("u", s.UserId), TxSql.P("h", passwords.Hash(c)));
        await EventAsync("auth.totp.enable", Tokens.EmailKey(s.Email), s.UserId, req, ct);
        await AuditAsync(s.UserId, s.DisplayName, s.ActiveCompanyId, req, "auth.totp.enable", s.UserId.ToString(), ct, after: new { recoveryCodes = codes.Count });
        await tx.CommitAsync(ct);
        return codes;
    }

    /// <summary>Ends one of the user's own sessions. Returns whether it was the one making the request.</summary>
    public async Task<bool> RevokeSessionAsync(SessionInfo s, Guid id, RequestInfo req, CancellationToken ct = default)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var n = await Q.ExecAsync(db, "UPDATE teas.sessions SET revoked_at = @now, revoke_reason = 'user' WHERE id = @i AND user_id = @u AND revoked_at IS NULL", ct,
            TxSql.P("now", clock.GetUtcNow()), TxSql.P("i", id), TxSql.P("u", s.UserId));
        if (n == 0) throw new TeasException("auth.session_not_found");
        await EventAsync("auth.session.revoke", Tokens.EmailKey(s.Email), s.UserId, req, ct);
        await AuditAsync(s.UserId, s.DisplayName, s.ActiveCompanyId, req, "auth.session.revoke", id.ToString(), ct);
        await tx.CommitAsync(ct);
        return id == s.Id;
    }
}
