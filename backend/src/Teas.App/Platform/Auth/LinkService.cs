using Npgsql;
using NpgsqlTypes;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Concurrency;
using Teas.Domain;
using Teas.Domain.Platform;

namespace Teas.App.Platform.Auth;

public sealed record IssuedLink(string Token, DateTimeOffset ExpiresAt);

public sealed record LinkInfoView(string Kind, string Email, string? CompanyName, DateTimeOffset ExpiresAt, bool ExistingAccount);

/// <summary>Issuing a set-password link. Used by the API (P8: invite, reset-link) inside its transaction and by the operator CLI on its own connection.</summary>
public static class UserLinks
{
    public const string Invite = "invite";
    public const string Reset = "reset";
    /// <summary>created_by of a link the server operator issued (the CLI); a person's link carries their user id.</summary>
    public const string Operator = "operator";

    public static readonly TimeSpan InviteTtl = TimeSpan.FromDays(7);
    public static readonly TimeSpan ResetTtl = TimeSpan.FromHours(24);

    /// <summary>
    /// A new single-use link; the token is returned once and only its hash is stored, with the kind and the expiry (fixed here, never recomputed on read).
    /// A newer link of the same kind for the same member (invite) / user (reset) supersedes the older one in the same transaction.
    /// <paramref name="createdBy"/>: the issuing user's id, or <see cref="Operator"/>; the issuer is re-checked every time the link is used.
    /// </summary>
    public static async Task<IssuedLink> IssueAsync(NpgsqlConnection conn, NpgsqlTransaction tx, string kind, Guid? userId, Guid? companyId, Guid? memberId,
        string createdBy, DateTimeOffset now, CancellationToken ct = default)
    {
        if (kind == Invite && (companyId is null || memberId is null)) throw new ArgumentException("an invite needs a company and a member", nameof(memberId));
        if (kind == Reset && userId is null) throw new ArgumentException("a reset link needs a user", nameof(userId));
        if (kind is not (Invite or Reset)) throw new ArgumentException("unknown kind", nameof(kind));

        var token = Tokens.New();
        var expires = now + (kind == Invite ? InviteTtl : ResetTtl);
        await using (var sup = new NpgsqlCommand(kind == Invite
            ? "UPDATE teas.user_links SET superseded_at = @now WHERE kind = 'invite' AND company_id = @c AND member_id = @m AND used_at IS NULL AND superseded_at IS NULL"
            : "UPDATE teas.user_links SET superseded_at = @now WHERE kind = 'reset' AND user_id = @u AND used_at IS NULL AND superseded_at IS NULL", conn, tx))
        {
            sup.Parameters.AddWithValue("now", now);
            if (kind == Invite) { sup.Parameters.AddWithValue("c", companyId!.Value); sup.Parameters.AddWithValue("m", memberId!.Value); }
            else sup.Parameters.AddWithValue("u", userId!.Value);
            await sup.ExecuteNonQueryAsync(ct);
        }
        await using var ins = new NpgsqlCommand("""
            INSERT INTO teas.user_links (kind, token_hash, user_id, company_id, member_id, expires_at, created_by, created_at)
            VALUES (@k, @h, @u, @c, @m, @exp, @by, @now)
            """, conn, tx);
        ins.Parameters.AddWithValue("k", kind);
        ins.Parameters.AddWithValue("h", Tokens.Hash(token));
        ins.Parameters.Add(new NpgsqlParameter("u", NpgsqlDbType.Uuid) { Value = (object?)userId ?? DBNull.Value });
        ins.Parameters.Add(new NpgsqlParameter("c", NpgsqlDbType.Uuid) { Value = (object?)companyId ?? DBNull.Value });
        ins.Parameters.Add(new NpgsqlParameter("m", NpgsqlDbType.Uuid) { Value = (object?)memberId ?? DBNull.Value });
        ins.Parameters.AddWithValue("exp", expires);
        ins.Parameters.AddWithValue("by", createdBy);
        ins.Parameters.AddWithValue("now", now);
        await ins.ExecuteNonQueryAsync(ct);
        return new IssuedLink(token, expires);
    }
}

/// <summary>
/// SP3 4.4 links (routes 13 / 14). Every way a link can be unusable (unknown, used, expired, superseded, an inactive or already-accepted member, an issuer who
/// can no longer vouch, no stored issuer) is ONE answer, 404 auth.link_invalid, and writes nothing. POST claims the link with a guarded UPDATE first, so of two
/// racing requests one wins; every later refusal rolls the claim back. An invite never sets the password of an existing user: it is accepted only from that
/// user's own live session. A reset link is issued FOR a user and is the only thing that may set the password of an existing account.
/// </summary>
public sealed class LinkService(TeasDbContext db, TenantScope scope, TimeProvider clock, PasswordService passwords, SessionService sessions, AuthAudit authAudit)
{
    sealed record Link(Guid Id, string Kind, Guid? UserId, Guid? CompanyId, Guid? MemberId, DateTimeOffset ExpiresAt, string CreatedBy);

    /// <summary>What a usable link points at. ExistingUserId: the user row of an invite's email (an existing account).</summary>
    sealed record Target(string Email, string Name, string? CompanyName, Guid? UserId, Guid? ExistingUserId);

    const string LinkCols = "id, kind, user_id, company_id, member_id, expires_at, created_by";
    static Link ReadLink(NpgsqlDataReader r) => new(r.GetGuid(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetGuid(2), r.IsDBNull(3) ? null : r.GetGuid(3),
        r.IsDBNull(4) ? null : r.GetGuid(4), r.GetFieldValue<DateTimeOffset>(5), r.GetString(6));

    static TeasException Invalid() => new("auth.link_invalid");

    // ---------------------------------------------------------------- resolve

    /// <summary>The companies where the user holds users.manage as an active, accepted member (system scope: memberships across companies are read, never written).</summary>
    async Task<HashSet<Guid>> ManagedByAsync(Guid user, CancellationToken ct)
    {
        var rows = await Q.ManyAsync(db, """
            SELECT m.company_id, m.role_id, r.permissions FROM teas.company_members m
            LEFT JOIN teas.custom_roles r ON r.company_id = m.company_id AND r.id::text = m.role_id
            WHERE m.user_id = @u AND m.active AND NOT m.invite_pending
            """, r => (Company: r.GetGuid(0), Role: r.GetString(1), Custom: r.IsDBNull(2) ? null : r.GetFieldValue<string[]>(2)), ct, TxSql.P("u", user));
        return rows.Where(x => Held(x.Role, x.Custom).Contains("users.manage")).Select(x => x.Company).ToHashSet();
    }

    static IEnumerable<string> Held(string role, string[]? custom) => PermissionCatalog.SystemRoles.TryGetValue(role, out var template) ? template : custom ?? [];

    /// <summary>
    /// The issuer vouches again NOW. An invite: the issuer holds users.manage in the issuing company. A reset (whole-account takeover): the issuer holds it in EVERY
    /// company where the account has a membership of any state (by user id, or by the login email as a pending invite or as the membership email). The CLI is trusted;
    /// a link whose stored issuer is neither the operator nor a user id cannot be re-checked and is invalid.
    /// </summary>
    async Task<bool> IssuerStillVouchesAsync(Link l, string? loginEmail, string? memberEmail, CancellationToken ct)
    {
        if (l.CreatedBy == UserLinks.Operator) return true;
        if (!Guid.TryParse(l.CreatedBy, out var issuer)) return false;
        if (l.Kind == UserLinks.Invite) return l.CompanyId is { } c && (await ManagedByAsync(issuer, ct)).Contains(c);
        return await ManagesAccountAsync(issuer, l.UserId!.Value, loginEmail, memberEmail, ct);
    }

    /// <summary>The P0c whole-account rule: the issuer holds users.manage in EVERY company where the account has a membership of any state (by user id, by the login email as a pending invite, or by the membership email). Needs a transaction; reads under system scope.</summary>
    async Task<bool> ManagesAccountAsync(Guid issuer, Guid? user, string? loginEmail, string? memberEmail, CancellationToken ct)
    {
        var managed = await ManagedByAsync(issuer, ct);
        var theirs = await Q.ManyAsync(db, "SELECT DISTINCT company_id FROM teas.company_members WHERE user_id = @u OR email = @e::citext OR email = @m::citext",
            r => r.GetGuid(0), ct, Q.N("u", NpgsqlDbType.Uuid, user), TxSql.P("e", loginEmail ?? ""), TxSql.P("m", memberEmail ?? ""));
        return theirs.All(managed.Contains);
    }

    /// <summary>At ISSUE of a reset link or a two-step reset (routes 24 / 25): the same rule that is re-checked when the link is used. Call inside the command transaction.</summary>
    public async Task<bool> IssuerManagesAccountAsync(Guid issuer, Guid? accountUser, string memberEmail, CancellationToken ct = default)
    {
        using var _ = scope.EnterSystem("link-issue");
        var loginEmail = accountUser is { } u ? await Q.ScalarAsync<string>(db, "SELECT email::text FROM teas.users WHERE id = @u", ct, TxSql.P("u", u)) : null;
        return await ManagesAccountAsync(issuer, accountUser, loginEmail, memberEmail, ct);
    }

    /// <summary>Null = invalid, whatever the reason. Reads only. Call inside a transaction.</summary>
    async Task<Target?> ResolveAsync(Link l, CancellationToken ct)
    {
        using var _ = scope.EnterSystem("link");
        if (l.Kind == UserLinks.Invite)
        {
            if (l.CompanyId is null || l.MemberId is null) return null;
            var m = await Q.OneAsync(db, """
                SELECT m.email::text, m.name, c.name, m.active AND m.invite_pending FROM teas.company_members m JOIN teas.companies c ON c.id = m.company_id
                WHERE m.company_id = @c AND m.id = @m
                """, r => new { Email = r.GetString(0), Name = r.GetString(1), Company = r.GetString(2), Open = r.GetBoolean(3) }, ct, TxSql.P("c", l.CompanyId.Value), TxSql.P("m", l.MemberId.Value));
            if (m is not { Open: true } || !await IssuerStillVouchesAsync(l, null, null, ct)) return null;
            var existing = await Q.ScalarAsync<Guid?>(db, "SELECT id FROM teas.users WHERE email = @e::citext", ct, TxSql.P("e", m.Email));
            return new Target(m.Email, m.Name, m.Company, null, existing);
        }
        if (l.UserId is null) return null;
        var u = await Q.OneAsync(db, "SELECT email::text, display_name FROM teas.users WHERE id = @u", r => new { Email = r.GetString(0), Name = r.GetString(1) }, ct, TxSql.P("u", l.UserId.Value));
        if (u is null) return null;
        string? memberEmail = null;
        if (l.CompanyId is { } company && l.MemberId is { } member)   // a deactivated (or not yet accepted) member's reset link is dead
        {
            var row = await Q.OneAsync(db, "SELECT active AND NOT invite_pending, email::text FROM teas.company_members WHERE company_id = @c AND id = @m",
                r => new { Live = r.GetBoolean(0), Email = r.GetString(1) }, ct, TxSql.P("c", company), TxSql.P("m", member));
            if (row is not { Live: true }) return null;
            memberEmail = row.Email;   // as at issue: a pending invite under the member row's own email counts too
        }
        return await IssuerStillVouchesAsync(l, u.Email, memberEmail, ct) ? new Target(u.Email, u.Name, null, l.UserId, null) : null;
    }

    // ---------------------------------------------------------------- route 13

    public async Task<LinkInfoView> InfoAsync(string token, CancellationToken ct = default)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var link = await Q.OneAsync(db, $"SELECT {LinkCols} FROM teas.user_links WHERE token_hash = @h AND used_at IS NULL AND superseded_at IS NULL AND expires_at > @now",
            ReadLink, ct, TxSql.P("h", Tokens.Hash(token)), TxSql.P("now", clock.GetUtcNow())) ?? throw Invalid();
        var t = await ResolveAsync(link, ct) ?? throw Invalid();
        var invite = link.Kind == UserLinks.Invite;
        return new LinkInfoView(link.Kind, t.Email, invite ? t.CompanyName : null, link.ExpiresAt, invite && t.ExistingUserId is not null);
    }

    // ---------------------------------------------------------------- route 14

    public async Task AcceptAsync(string token, string? password, string? confirm, SessionInfo? signedIn, RequestInfo req, CancellationToken ct = default)
    {
        var now = clock.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        // The claim IS the single-use guard: a racing request waits on this row, then finds it used. Anything below that refuses rolls it back.
        var link = await Q.OneAsync(db, $"UPDATE teas.user_links SET used_at = @now WHERE token_hash = @h AND used_at IS NULL AND superseded_at IS NULL AND expires_at > @now RETURNING {LinkCols}",
            ReadLink, ct, TxSql.P("h", Tokens.Hash(token)), TxSql.P("now", now)) ?? throw Invalid();
        var t = await ResolveAsync(link, ct) ?? throw Invalid();

        if (link.Kind == UserLinks.Invite && t.ExistingUserId is { } existing)
        {
            // an existing account: no password is read or changed; only that user, signed in, may accept
            if (signedIn is not { State: SessionState.Active or SessionState.Expiring } || signedIn.UserId != existing) throw Invalid();
            await JoinAsync(link, existing, signedIn.DisplayName, signedIn.Email, req, now, ct);
        }
        else
        {
            if (password != confirm) throw new TeasException("auth.password_mismatch");
            if (!PasswordService.IsStrong(password)) throw new TeasException("auth.password_weak");
            var hash = passwords.Hash(password!);
            if (link.Kind == UserLinks.Invite)
            {
                // a user row that appeared since the page was read makes this an existing account: the invite must not touch it
                var created = await Q.ScalarAsync<Guid?>(db, """
                    INSERT INTO teas.users (email, display_name, password_hash, password_changed_at, created_at) VALUES (@e, @n, @h, @now, @now)
                    ON CONFLICT (email) DO NOTHING RETURNING id
                    """, ct, TxSql.P("e", t.Email), TxSql.P("n", t.Name), TxSql.P("h", hash), TxSql.P("now", now));
                await JoinAsync(link, created ?? throw Invalid(), t.Name, t.Email, req, now, ct);
            }
            else await ResetAsync(link.UserId!.Value, t, hash, req, now, ct);
        }
        await tx.CommitAsync(ct);
    }

    async Task JoinAsync(Link link, Guid userId, string name, string email, RequestInfo req, DateTimeOffset now, CancellationToken ct)
    {
        using (scope.Enter(link.CompanyId!.Value, userId))
        {
            int n;
            try
            {
                n = await Q.ExecAsync(db, "UPDATE teas.company_members SET user_id = @u, invite_pending = false, version = version + 1 WHERE company_id = @c AND id = @m AND invite_pending AND active", ct,
                    TxSql.P("u", userId), TxSql.P("c", link.CompanyId.Value), TxSql.P("m", link.MemberId!.Value));
            }
            catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation) { throw Invalid(); }   // that user is already a member under another row
            if (n != 1) throw Invalid();
            await Q.EventAsync(db, now, "user.accept_invite", Tokens.EmailKey(email), userId, req, ct);
            await authAudit.RecordAsync(userId, name, link.CompanyId, req, "user.accept_invite", link.MemberId.Value.ToString(), ct);
        }
    }

    async Task ResetAsync(Guid userId, Target t, string hash, RequestInfo req, DateTimeOffset now, CancellationToken ct)
    {
        await Q.ExecAsync(db, "UPDATE teas.users SET password_hash = @h, password_changed_at = @now, version = version + 1 WHERE id = @u", ct, TxSql.P("h", hash), TxSql.P("now", now), TxSql.P("u", userId));
        var key = Tokens.EmailKey(t.Email);
        await Q.ExecAsync(db, "DELETE FROM teas.auth_failures WHERE key_hash = @k", ct, TxSql.P("k", key));
        await sessions.RevokeAllAsync(userId, null, "password_reset", ct);   // a reset ends every sign-in of that user
        await Q.ExecAsync(db, "DELETE FROM teas.login_challenges WHERE user_id = @u", ct, TxSql.P("u", userId));   // and every half-finished two-step sign-in
        await Q.EventAsync(db, now, "auth.password.reset", key, userId, req, ct);
        await authAudit.RecordAsync(userId, t.Name, null, req, "auth.password.reset", userId.ToString(), ct);
    }
}
