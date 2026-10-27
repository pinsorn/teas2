using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Npgsql;
using NpgsqlTypes;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Auth;
using Teas.App.Platform.Companies;
using Teas.App.Platform.Concurrency;
using Teas.App.Platform.Files;
using Teas.App.Platform.Roles;
using Teas.Domain;

namespace Teas.App.Platform.Members;

/// <summary>The wire UserRow: a person's membership of one company. The login user id and the link hashes never leave the server.</summary>
public sealed record UserRowView(Guid Id, Guid CompanyId, string Name, string Email, string RoleId, bool Active, int Version, bool InvitePending, string RoleName,
    string? Position = null, string? SignatureDataUrl = null, DateTimeOffset? LastLoginAt = null);

/// <summary>Route 21's answer: the row plus the invite link (the only response in the system that carries it).</summary>
public sealed record InvitedUserView(Guid Id, Guid CompanyId, string Name, string Email, string RoleId, bool Active, int Version, bool InvitePending, string RoleName, string Link,
    string? Position = null, string? SignatureDataUrl = null, DateTimeOffset? LastLoginAt = null)
{
    public static InvitedUserView Of(UserRowView r, string link) => new(r.Id, r.CompanyId, r.Name, r.Email, r.RoleId, r.Active, r.Version, r.InvitePending, r.RoleName, link, r.Position, r.SignatureDataUrl, r.LastLoginAt);
}

/// <summary>Base address of the set-password pages (TEAS_PUBLIC_URL); links are <c>&lt;base&gt;/link/&lt;token&gt;</c>.</summary>
public sealed record PublicLinkBase(string Url)
{
    public string For(string token) => Url.TrimEnd('/') + "/link/" + token;
}

/// <summary>
/// SP3 P8 routes 20-25. One transaction per command: the company lock (so the last-admin rule cannot be raced), the checks, the guarded UPDATE (bumps version: the
/// rights cache trusts it), the audit row. A refusal writes nothing, except a 403, which leaves one 'rejected' row (S14).
/// </summary>
public sealed partial class MemberService(TeasDbContext db, TenantScope scope, IAudit audit, IFileStore files, LinkService links, SessionService sessions, TimeProvider clock, PublicLinkBase publicBase)
{
    sealed record M(Guid Id, Guid? UserId, string Email, string Name, string RoleId, string? Position, Guid? SignatureFileId, bool Active, bool Pending, DateTimeOffset? LastLogin, int Version);

    const string Cols = "id, user_id, email::text, name, role_id, position, signature_file_id, active, invite_pending, last_login_at, version";

    static M Read(NpgsqlDataReader r) => new(r.GetGuid(0), r.IsDBNull(1) ? null : r.GetGuid(1), r.GetString(2), r.GetString(3), r.GetString(4), r.IsDBNull(5) ? null : r.GetString(5),
        r.IsDBNull(6) ? null : r.GetGuid(6), r.GetBoolean(7), r.GetBoolean(8), r.IsDBNull(9) ? null : r.GetFieldValue<DateTimeOffset>(9), r.GetInt32(10));

    [GeneratedRegex(@"^[^\s@]+@[^\s@]+\.[^\s@]+$")] private static partial Regex EmailRule();

    Guid Company => scope.Current.CompanyId ?? throw new InvalidOperationException("members need a company scope");

    Task<M?> GetAsync(Guid id, CancellationToken ct) =>
        Q.OneAsync(db, $"SELECT {Cols} FROM teas.company_members WHERE company_id = @c AND id = @i", Read, ct, TxSql.P("c", Company), TxSql.P("i", id));

    static Guid IdOf(string id) => Guid.TryParse(id, out var g) ? g : throw new TeasException("record.not_found");

    (NpgsqlConnection, NpgsqlTransaction) Npg()
    {
        var tx = (NpgsqlTransaction)db.Database.CurrentTransaction!.GetDbTransaction();
        return (tx.Connection!, tx);
    }

    async Task<UserRowView> ViewAsync(M m, IEnumerable<CustomRole> customs, CancellationToken ct) =>
        new(m.Id, Company, m.Name, m.Email, m.RoleId, m.Active, m.Version, m.Pending, RoleDirectory.NameOf(m.RoleId, customs), m.Position,
            await DataUrls.ReadAsync(files, Company, m.SignatureFileId, ct), m.LastLogin);

    /// <summary>What the trail keeps: who and what, never a picture or a link.</summary>
    static object Shape(M m) => new { name = m.Name, email = m.Email, roleId = m.RoleId, position = m.Position, hasSignature = m.SignatureFileId is not null, active = m.Active };

    public async Task<IReadOnlyList<UserRowView>> ListAsync(CancellationToken ct = default)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var customs = await RoleDirectory.CustomAsync(db, Company, ct);
        var rows = await Q.ManyAsync(db, $"SELECT {Cols} FROM teas.company_members WHERE company_id = @c ORDER BY name, id", Read, ct, TxSql.P("c", Company));
        var list = new List<UserRowView>();
        foreach (var m in rows) list.Add(await ViewAsync(m, customs, ct));
        return list;
    }

    // ---------------------------------------------------------------- invite

    public async Task<InvitedUserView> InviteAsync(Guid actor, string? name, string? email, string? roleId, string? position, CancellationToken ct = default)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await RoleDirectory.LockAsync(db, Company, ct);
        var customs = await RoleDirectory.CustomAsync(db, Company, ct);
        var errors = new List<(string, string)>();
        var n = name?.Trim() ?? "";
        var e = email?.Trim().ToLowerInvariant() ?? "";
        if (n.Length == 0) errors.Add(("name", "ต้องระบุชื่อ"));
        if (!EmailRule().IsMatch(e)) errors.Add(("email", "อีเมลไม่ถูกต้อง"));
        else if (await Q.ScalarAsync<bool>(db, "SELECT EXISTS (SELECT 1 FROM teas.company_members WHERE company_id = @c AND email = @e::citext)", ct, TxSql.P("c", Company), TxSql.P("e", e)))
            errors.Add(("email", "อีเมลนี้เป็นสมาชิกของบริษัทอยู่แล้ว"));
        if (roleId is null || !RoleDirectory.Exists(roleId, customs)) errors.Add(("roleId", "ต้องเลือกบทบาทของบริษัทนี้"));
        if (errors.Count > 0) throw Invalid.Fields(errors);

        var pos = string.IsNullOrWhiteSpace(position) ? null : position.Trim();
        M m;
        try
        {
            var id = await Q.ScalarAsync<Guid>(db, "INSERT INTO teas.company_members (company_id, email, name, role_id, position, invite_pending) VALUES (@c, @e, @n, @r, @p, true) RETURNING id", ct,
                TxSql.P("c", Company), TxSql.P("e", e), TxSql.P("n", n), TxSql.P("r", roleId!), Q.N("p", NpgsqlDbType.Text, pos));
            m = new M(id, null, e, n, roleId!, pos, null, true, true, null, 1);
        }
        catch (PostgresException x) when (x.SqlState == PostgresErrorCodes.UniqueViolation) { throw Invalid.Fields(("email", "อีเมลนี้เป็นสมาชิกของบริษัทอยู่แล้ว")); }
        var (conn, npg) = Npg();
        var issued = await UserLinks.IssueAsync(conn, npg, UserLinks.Invite, null, Company, m.Id, actor.ToString(), clock.GetUtcNow(), ct);
        await audit.RecordAsync("user.invite", m.Id.ToString(), null, Shape(m), ct);   // no link in the trail
        var view = await ViewAsync(m, customs, ct);
        await tx.CommitAsync(ct);
        return InvitedUserView.Of(view, publicBase.For(issued.Token));
    }

    // ---------------------------------------------------------------- last admin (S15)

    /// <summary>The company keeps an active, accepted member with users.manage: refuses leaving it (409 user.last_admin) by deactivating or changing the role of its last one,
    /// and a person never takes users.manage off themselves. Inside the company lock.</summary>
    async Task KeepAnAdminAsync(M m, bool nextActive, string nextRole, Guid actor, IReadOnlyList<CustomRole> customs, CancellationToken ct)
    {
        var admins = await RoleDirectory.AdminsAsync(db, Company, customs, ct);
        if (admins.All(a => a.MemberId != m.Id)) return;                       // not an administrator now: nothing to lose
        if (nextActive && RoleDirectory.Manages(nextRole, customs)) return;   // stays one
        if (!admins.Any(a => a.MemberId != m.Id)) throw new TeasException("user.last_admin");
        if (m.UserId == actor) throw new TeasException("user.last_admin");
    }

    // ---------------------------------------------------------------- update, activate

    public async Task<UserRowView> UpdateAsync(Guid actor, string id, int version, string? name, string? roleId, string? position, ImageChange signature, CancellationToken ct = default)
    {
        var memberId = IdOf(id);
        Invalid.RequireVersion(version);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await RoleDirectory.LockAsync(db, Company, ct);
        var customs = await RoleDirectory.CustomAsync(db, Company, ct);
        var m = await GetAsync(memberId, ct) ?? throw new TeasException("record.not_found");
        if (version != m.Version) throw new TeasException("record.version_conflict");

        var errors = new List<(string, string)>();
        if (name is not null && name.Trim().Length == 0) errors.Add(("name", "ต้องระบุชื่อ"));
        if (roleId is not null && !RoleDirectory.Exists(roleId, customs)) errors.Add(("roleId", "ต้องเลือกบทบาทของบริษัทนี้"));
        if (errors.Count > 0) throw Invalid.Fields(errors);

        var nextRole = roleId ?? m.RoleId;
        if (nextRole != m.RoleId) await KeepAnAdminAsync(m, m.Active, nextRole, actor, customs, ct);
        var sig = !signature.IsSet ? m.SignatureFileId
            : string.IsNullOrEmpty(signature.DataUrl) ? null
            : await DataUrls.StoreAsync(files, Company, signature.DataUrl, "signature", "signatureDataUrl", ct);
        var next = m with
        {
            Name = name?.Trim() ?? m.Name, RoleId = nextRole, SignatureFileId = sig,
            Position = position is null ? m.Position : string.IsNullOrWhiteSpace(position) ? null : position.Trim(),
        };
        var v = await VersionedUpdate.UpdateAsync(db, "company_members", "name = @n, role_id = @r, position = @p, signature_file_id = @s", memberId, version,
            TxSql.P("n", next.Name), TxSql.P("r", next.RoleId), Q.N("p", NpgsqlDbType.Text, next.Position), Q.N("s", NpgsqlDbType.Uuid, next.SignatureFileId));
        next = next with { Version = v };
        await audit.RecordAsync("user.update", id, Shape(m), Shape(next), ct);
        var view = await ViewAsync(next, customs, ct);
        await tx.CommitAsync(ct);
        return view;
    }

    public async Task<UserRowView> SetActiveAsync(Guid actor, string id, bool active, int version, CancellationToken ct = default)
    {
        var memberId = IdOf(id);
        Invalid.RequireVersion(version);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await RoleDirectory.LockAsync(db, Company, ct);
        var customs = await RoleDirectory.CustomAsync(db, Company, ct);
        var m = await GetAsync(memberId, ct) ?? throw new TeasException("record.not_found");
        if (version != m.Version) throw new TeasException("record.version_conflict");
        if (m.Active == active) return await ViewAsync(m, customs, ct);   // already so: nothing to write

        if (!active) await KeepAnAdminAsync(m, false, m.RoleId, actor, customs, ct);
        var v = await VersionedUpdate.UpdateAsync(db, "company_members", "active = @a", memberId, version, TxSql.P("a", active));
        if (!active)   // a deactivated member's links end with the membership (user_links is global: the company is filtered explicitly)
            await Q.ExecAsync(db, "UPDATE teas.user_links SET superseded_at = @now WHERE company_id = @c AND member_id = @m AND used_at IS NULL AND superseded_at IS NULL", ct,
                TxSql.P("now", clock.GetUtcNow()), TxSql.P("c", Company), TxSql.P("m", memberId));
        var next = m with { Active = active, Version = v };
        await audit.RecordAsync(active ? "user.activate" : "user.deactivate", id, Shape(m), Shape(next), ct);
        var view = await ViewAsync(next, customs, ct);
        await tx.CommitAsync(ct);
        return view;
    }

    // ---------------------------------------------------------------- whole-account actions (P0c)

    /// <summary>A 403 refusal leaves one 'rejected' row, written after the command transaction ended.</summary>
    async Task<T> RefusingAsync<T>(string command, string target, Func<Task<T>> run, CancellationToken ct)
    {
        try { return await run(); }
        catch (TeasException e) when (e.Status == 403)
        {
            await audit.RecordRejectedAsync(command, target, ct);
            throw;
        }
    }

    /// <summary>The issuer must hold users.manage in EVERY company where this account has a membership of any state; otherwise 403 user.cross_company.</summary>
    async Task EnsureManagesAccountAsync(Guid actor, M m, CancellationToken ct)
    {
        if (!await links.IssuerManagesAccountAsync(actor, m.UserId, m.Email, ct)) throw new TeasException("user.cross_company");
    }

    public Task<string> ResetLinkAsync(Guid actor, string id, CancellationToken ct = default)
    {
        var memberId = IdOf(id);
        return RefusingAsync("user.reset_link", id, async () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            var m = await GetAsync(memberId, ct) ?? throw new TeasException("record.not_found");
            await EnsureManagesAccountAsync(actor, m, ct);
            if (!m.Active) throw new TeasException("user.inactive");
            if (m.Pending || m.UserId is null) throw new TeasException("user.invite_pending");
            var (conn, npg) = Npg();
            var issued = await UserLinks.IssueAsync(conn, npg, UserLinks.Reset, m.UserId, Company, m.Id, actor.ToString(), clock.GetUtcNow(), ct);
            await audit.RecordAsync("user.reset_link", id, null, new { linkIssued = true }, ct);   // the audit says a link was issued, not which
            await tx.CommitAsync(ct);
            return publicBase.For(issued.Token);
        }, ct);
    }

    public Task<UserRowView> TotpResetAsync(Guid actor, string id, int version, CancellationToken ct = default)
    {
        var memberId = IdOf(id);
        Invalid.RequireVersion(version);
        return RefusingAsync("user.totp_reset", id, async () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            var customs = await RoleDirectory.CustomAsync(db, Company, ct);
            var m = await GetAsync(memberId, ct) ?? throw new TeasException("record.not_found");
            if (m.UserId == actor) throw new TeasException("auth.forbidden", "cannot reset your own two-step verification");
            await EnsureManagesAccountAsync(actor, m, ct);
            if (version != m.Version) throw new TeasException("record.version_conflict");
            if (m.UserId is { } user)
            {
                await Q.ExecAsync(db, "UPDATE teas.users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_last_step = NULL, version = version + 1 WHERE id = @u", ct, TxSql.P("u", user));
                await Q.ExecAsync(db, "DELETE FROM teas.recovery_codes WHERE user_id = @u", ct, TxSql.P("u", user));
                await Q.ExecAsync(db, "DELETE FROM teas.login_challenges WHERE user_id = @u", ct, TxSql.P("u", user));
                await sessions.RevokeAllAsync(user, null, "totp_reset", ct);
            }
            var v = await VersionedUpdate.UpdateAsync(db, "company_members", "name = name", memberId, version);
            var next = m with { Version = v };
            await audit.RecordAsync("user.totp_reset", id, Shape(m), Shape(next), ct);
            var view = await ViewAsync(next, customs, ct);
            await tx.CommitAsync(ct);
            return view;
        }, ct);
    }
}
