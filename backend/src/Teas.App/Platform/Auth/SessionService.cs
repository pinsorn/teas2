using System.Net;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Concurrency;

namespace Teas.App.Platform.Auth;

/// <summary>The wire values are the frozen contract strings (active | expiring | expired | out).</summary>
public enum SessionState
{
    [JsonStringEnumMemberName("active")] Active,
    [JsonStringEnumMemberName("expiring")] Expiring,
    [JsonStringEnumMemberName("expired")] Expired,
    [JsonStringEnumMemberName("out")] Out,
}

/// <summary>What the host knows about the caller of a request (the IP of the audit row and the device of the session list).</summary>
public sealed record RequestInfo(IPAddress? Ip, string? UserAgent);

public sealed record SessionInfo(Guid Id, Guid UserId, string Email, string DisplayName, Guid? ActiveCompanyId, SessionState State, int? ExpiresInSec, DateTimeOffset LastSeenAt, DateTimeOffset CreatedAt, Guid? StoredActiveCompanyId = null);
// ActiveCompanyId = the company the caller may act in (validated: null once the member is out); StoredActiveCompanyId = what the session row holds, which Me reports so a deactivated member is not sent to /onboarding.

public sealed record SessionRow(Guid Id, string Device, string Ip, DateTimeOffset CreatedAt, DateTimeOffset LastSeenAt, bool Current);

/// <summary>
/// ADR-0004 / SP3 4.4: opaque server-side sessions. The token is 256 random bits; the row keeps sha256 of it. Idle 60 min, absolute 12 h.
/// States: active (more than 120 s left), expiring (120 s or less), expired (the idle time passed, the row is alive: only relogin may use it),
/// out (no token, unknown, revoked, or the absolute limit passed). Methods that write run inside the caller's transaction.
/// </summary>
public sealed class SessionService(TeasDbContext db, TenantScope scope, TimeProvider clock)
{
    public static readonly TimeSpan Idle = TimeSpan.FromMinutes(60);
    public static readonly TimeSpan Absolute = TimeSpan.FromHours(12);
    public static readonly TimeSpan Warning = TimeSpan.FromSeconds(120);
    public static readonly TimeSpan TouchEvery = TimeSpan.FromSeconds(60);

    /// <summary>Reads the session behind a cookie in its own transaction. Null = out. Never writes.</summary>
    public async Task<SessionInfo?> ResolveAsync(string? token, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 128) return null;
        var now = clock.GetUtcNow();
        using var _ = scope.EnterSystem("session");   // the membership of ANY company is read, never written
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var row = await Q.OneAsync(db, """
            SELECT s.id, s.user_id, u.email::text, u.display_name,
                   CASE WHEN EXISTS (SELECT 1 FROM teas.company_members m WHERE m.company_id = s.active_company_id AND m.user_id = s.user_id AND m.active AND NOT m.invite_pending)
                        THEN s.active_company_id END,   -- a company the user no longer works in is not a scope (no silent switch)
                   s.idle_expires_at, s.absolute_expires_at, s.last_seen_at, s.created_at, s.active_company_id
            FROM teas.sessions s JOIN teas.users u ON u.id = s.user_id
            WHERE s.token_hash = @h AND s.revoked_at IS NULL
            """, r => new
        {
            Id = r.GetGuid(0), User = r.GetGuid(1), Email = r.GetString(2), Name = r.GetString(3), Company = r.IsDBNull(4) ? (Guid?)null : r.GetGuid(4),
            Idle = r.GetFieldValue<DateTimeOffset>(5), Absolute = r.GetFieldValue<DateTimeOffset>(6), Seen = r.GetFieldValue<DateTimeOffset>(7), Created = r.GetFieldValue<DateTimeOffset>(8), Stored = r.IsDBNull(9) ? (Guid?)null : r.GetGuid(9),
        }, ct, TxSql.P("h", Tokens.Hash(token)));
        if (row is null || now >= row.Absolute) return null;
        var (state, left) = StateOf(now, row.Idle, row.Absolute);
        return new SessionInfo(row.Id, row.User, row.Email, row.Name, row.Company, state, left, row.Seen, row.Created, row.Stored);
    }

    static (SessionState, int?) StateOf(DateTimeOffset now, DateTimeOffset idle, DateTimeOffset absolute)
    {
        if (now >= idle) return (SessionState.Expired, null);
        var left = (int)Math.Ceiling((Min(idle, absolute) - now).TotalSeconds);
        return left <= Warning.TotalSeconds ? (SessionState.Expiring, left) : (SessionState.Active, null);
    }

    static DateTimeOffset Min(DateTimeOffset a, DateTimeOffset b) => a < b ? a : b;

    /// <summary>
    /// Pushes the idle expiry out to 60 minutes from now (never past the absolute limit) and stamps last_seen_at. Unless <paramref name="force"/>
    /// it writes at most once per 60 s. False = the session ended meanwhile. Its own transaction.
    /// </summary>
    public async Task<bool> TouchAsync(SessionInfo s, bool force, CancellationToken ct = default)
    {
        var now = clock.GetUtcNow();
        if (!force && now - s.LastSeenAt < TouchEvery) return true;
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var rows = await Q.ExecAsync(db, """
            UPDATE teas.sessions SET last_seen_at = @now, idle_expires_at = LEAST(@idle, absolute_expires_at)
            WHERE id = @id AND revoked_at IS NULL AND idle_expires_at > @now AND absolute_expires_at > @now
            """, ct, TxSql.P("now", now), TxSql.P("idle", now + Idle), TxSql.P("id", s.Id));
        await tx.CommitAsync(ct);
        return rows == 1;
    }

    /// <summary>A new session for the user; returns its id and the token (shown to the browser once, as the cookie). Inside the caller's transaction.</summary>
    internal async Task<IssuedSession> CreateAsync(Guid userId, Guid? activeCompany, RequestInfo req, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var token = Tokens.New();
        var device = string.IsNullOrWhiteSpace(req.UserAgent) ? "unknown" : req.UserAgent.Length > 200 ? req.UserAgent[..200] : req.UserAgent;
        var id = await Q.ScalarAsync<Guid>(db, """
            INSERT INTO teas.sessions (user_id, token_hash, active_company_id, device, ip, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
            VALUES (@u, @h, @c, @d, @ip, @now, @now, @idle, @abs) RETURNING id
            """, ct, TxSql.P("u", userId), TxSql.P("h", Tokens.Hash(token)), Q.N("c", NpgsqlDbType.Uuid, activeCompany), TxSql.P("d", device),
            Q.N("ip", NpgsqlDbType.Inet, req.Ip), TxSql.P("now", now), TxSql.P("idle", now + Idle), TxSql.P("abs", now + Absolute));
        return new IssuedSession(token, id);
    }

    /// <summary>Ends one session. Rows touched (0 = it was already over). Inside the caller's transaction.</summary>
    internal Task<int> RevokeAsync(Guid id, string reason, CancellationToken ct) =>
        Q.ExecAsync(db, "UPDATE teas.sessions SET revoked_at = @now, revoke_reason = @r WHERE id = @id AND revoked_at IS NULL", ct,
            TxSql.P("now", clock.GetUtcNow()), TxSql.P("r", reason), TxSql.P("id", id));

    internal Task<int> RevokeByTokenAsync(string token, string reason, CancellationToken ct) =>
        Q.ExecAsync(db, "UPDATE teas.sessions SET revoked_at = @now, revoke_reason = @r WHERE token_hash = @h AND revoked_at IS NULL", ct,
            TxSql.P("now", clock.GetUtcNow()), TxSql.P("r", reason), TxSql.P("h", Tokens.Hash(token)));

    /// <summary>Ends every live session of the user except <paramref name="except"/>. Inside the caller's transaction.</summary>
    internal Task<int> RevokeAllAsync(Guid userId, Guid? except, string reason, CancellationToken ct) =>
        Q.ExecAsync(db, "UPDATE teas.sessions SET revoked_at = @now, revoke_reason = @r WHERE user_id = @u AND revoked_at IS NULL AND id IS DISTINCT FROM @x", ct,
            TxSql.P("now", clock.GetUtcNow()), TxSql.P("r", reason), TxSql.P("u", userId), Q.N("x", NpgsqlDbType.Uuid, except));

    /// <summary>The user's sessions that are not over (not revoked, absolute limit not passed; an idle-expired one is listed: it can still relogin and be revoked), newest activity first. Its own transaction.</summary>
    public async Task<IReadOnlyList<SessionRow>> ListAsync(SessionInfo current, CancellationToken ct = default)
    {
        var now = clock.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        return await Q.ManyAsync(db, """
            SELECT id, device, coalesce(host(ip), ''), created_at, last_seen_at FROM teas.sessions
            WHERE user_id = @u AND revoked_at IS NULL AND absolute_expires_at > @now
            ORDER BY last_seen_at DESC, created_at DESC, id
            """, r => new SessionRow(r.GetGuid(0), r.IsDBNull(1) ? "" : r.GetString(1), r.GetString(2), r.GetFieldValue<DateTimeOffset>(3), r.GetFieldValue<DateTimeOffset>(4), r.GetGuid(0) == current.Id),
            ct, TxSql.P("u", current.UserId), TxSql.P("now", now));
    }

    /// <summary>The active, accepted memberships of a user across companies, with the custom role's name (a custom role is a row of ITS company, so the read is cross-company: system scope, reads only). Its own transaction.</summary>
    public async Task<IReadOnlyList<MembershipRow>> MembershipsAsync(Guid userId, CancellationToken ct = default)
    {
        using var _ = scope.EnterSystem("memberships");
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        return await Q.ManyAsync(db, """
            SELECT m.company_id, c.name, m.role_id, r.name FROM teas.company_members m
            JOIN teas.companies c ON c.id = m.company_id
            LEFT JOIN teas.custom_roles r ON r.company_id = m.company_id AND r.id::text = m.role_id
            WHERE m.user_id = @u AND m.active AND NOT m.invite_pending ORDER BY c.created_at, m.company_id
            """, r => new MembershipRow(r.GetGuid(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3)), ct, TxSql.P("u", userId));
    }
}

public sealed record MembershipRow(Guid CompanyId, string CompanyName, string RoleId, string? CustomRoleName);

public sealed record IssuedSession(string Token, Guid SessionId);

/// <summary>Small raw-SQL helpers on the current transaction (every auth statement runs through them; a transaction must be open).</summary>
internal static class Q
{
    public static NpgsqlParameter N(string name, NpgsqlDbType type, object? value) => new(name, type) { Value = value ?? DBNull.Value };

    /// <summary>One auth_events row (the global security log): the email only as its hash. Inside the caller's transaction.</summary>
    public static Task EventAsync(DbContext db, DateTimeOffset at, string kind, byte[]? emailKey, Guid? userId, RequestInfo req, CancellationToken ct) =>
        ExecAsync(db, "INSERT INTO teas.auth_events (at, kind, email_hash, user_id, ip, user_agent) VALUES (@at, @k, @e, @u, @ip, @ua)", ct,
            TxSql.P("at", at), TxSql.P("k", kind), N("e", NpgsqlDbType.Bytea, emailKey), N("u", NpgsqlDbType.Uuid, userId), N("ip", NpgsqlDbType.Inet, req.Ip),
            N("ua", NpgsqlDbType.Text, req.UserAgent is { Length: > 256 } ua ? ua[..256] : req.UserAgent));

    public static async Task<int> ExecAsync(DbContext db, string sql, CancellationToken ct, params NpgsqlParameter[] ps)
    {
        await using var cmd = TxSql.Cmd(db, sql, ps);
        return await cmd.ExecuteNonQueryAsync(ct);
    }

    public static async Task<T?> ScalarAsync<T>(DbContext db, string sql, CancellationToken ct, params NpgsqlParameter[] ps)
    {
        await using var cmd = TxSql.Cmd(db, sql, ps);
        await using var r = await cmd.ExecuteReaderAsync(ct);   // GetFieldValue, not ExecuteScalar: timestamptz comes back as DateTimeOffset, not DateTime
        return await r.ReadAsync(ct) && !r.IsDBNull(0) ? r.GetFieldValue<T>(0) : default;
    }

    public static async Task<T?> OneAsync<T>(DbContext db, string sql, Func<NpgsqlDataReader, T> map, CancellationToken ct, params NpgsqlParameter[] ps) where T : class
    {
        await using var cmd = TxSql.Cmd(db, sql, ps);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? map(r) : null;
    }

    public static async Task<List<T>> ManyAsync<T>(DbContext db, string sql, Func<NpgsqlDataReader, T> map, CancellationToken ct, params NpgsqlParameter[] ps)
    {
        await using var cmd = TxSql.Cmd(db, sql, ps);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<T>();
        while (await r.ReadAsync(ct)) list.Add(map(r));
        return list;
    }
}

/// <summary>The auth audit company rule (SP3 4.4): the session's active company, else the user's first active, accepted membership, else no audit_log row (auth_events still has the event).</summary>
public sealed class AuthAudit(TeasDbContext db, TenantScope scope, IAudit audit, AuditContext ctx)
{
    /// <summary>The company a sign-in opens (and the first-membership fallback): the preferred one when the user is still an active, accepted member, else the oldest such company.</summary>
    public async Task<Guid?> FirstCompanyAsync(Guid userId, Guid? preferred, CancellationToken ct)
    {
        using var _ = scope.EnterSystem("auth-company");   // memberships across companies are read, never written, under system scope
        return await Q.ScalarAsync<Guid?>(db, """
            SELECT m.company_id FROM teas.company_members m JOIN teas.companies c ON c.id = m.company_id
            WHERE m.user_id = @u AND m.active AND NOT m.invite_pending
            ORDER BY coalesce(m.company_id = @pref, false) DESC, c.created_at, m.company_id LIMIT 1
            """, ct, TxSql.P("u", userId), Q.N("pref", NpgsqlDbType.Uuid, preferred));
    }

    /// <summary>One audit_log row for the user, inside the caller's transaction (before / after never carry a secret, a hash or a link).</summary>
    public async Task RecordAsync(Guid userId, string name, Guid? sessionCompany, RequestInfo req, string command, string target, CancellationToken ct, object? after = null)
    {
        var company = sessionCompany ?? await FirstCompanyAsync(userId, null, ct);
        if (company is null) return;
        ctx.Actor = new AuditActor("user", userId.ToString(), name);
        ctx.Client = "web";
        ctx.Ip = req.Ip;
        using var _ = scope.Enter(company.Value, userId);
        await audit.RecordAsync(command, target, null, after, ct);
    }

    /// <summary>A refused 403 of a signed-in user: one 'rejected' row in the session's company, outside any transaction. A session with no valid company scope leaves none.</summary>
    public async Task RecordRejectedAsync(Guid userId, string name, Guid? sessionCompany, RequestInfo req, string command, string target, CancellationToken ct)
    {
        if (sessionCompany is not { } company) return;
        ctx.Actor = new AuditActor("user", userId.ToString(), name);
        ctx.Client = "web";
        ctx.Ip = req.Ip;
        using var _ = scope.Enter(company, userId);
        await audit.RecordRejectedAsync(command, target, ct);
    }
}
