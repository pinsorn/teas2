using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Auth;
using Teas.App.Platform.Concurrency;
using Teas.App.Platform.Rights;
using Teas.App.Platform.Roles;
using Teas.Domain;
using Teas.Domain.Platform;

namespace Teas.App.Platform.Keys;

public enum KeyKind { [JsonStringEnumMemberName("rest")] Rest, [JsonStringEnumMemberName("mcp")] Mcp }
public enum KeyStatus { [JsonStringEnumMemberName("active")] Active, [JsonStringEnumMemberName("revoked")] Revoked, [JsonStringEnumMemberName("expired")] Expired }
public enum ActorKind { [JsonStringEnumMemberName("user")] User, [JsonStringEnumMemberName("agent")] Agent }

/// <summary>The wire ApiKeyRow (frozen 5.1): no hash and no secret, ever. expiresAt is the date text.</summary>
public sealed record ApiKeyRow(Guid Id, int Version, string Name, KeyKind Kind, string Prefix, string OwnerName, IReadOnlyList<string> Scopes, int ScopeCount, DateTimeOffset CreatedAt,
    KeyStatus Status, DateTimeOffset? LastUsedAt = null, string? ExpiresAt = null, DateTimeOffset? RevokedAt = null);
public sealed record ApiKeysView(IReadOnlyList<ApiKeyRow> Items, IReadOnlyList<string>? ScopeChoices = null);
/// <summary>Shown once, by create and by rotate; nothing else carries the secret.</summary>
public sealed record ApiKeyCreated(ApiKeyRow Key, string Secret);

public sealed record ActorView(ActorKind Kind, Guid Id, string Name, string? OwnerName = null);
public sealed record WhoAmI(ActorView Actor, Guid CompanyId, string CompanyName, IReadOnlyList<string> Rights);

/// <summary>Who a presented key is (resolved by its hash, before any company scope exists). Kind is the STORED kind.</summary>
public sealed record KeyIdentity(Guid Id, Guid CompanyId, string CompanyName, string Name, string Kind, IReadOnlyList<string> Scopes, Guid OwnerId, string OwnerName);

/// <summary>
/// SP3 P9 routes 30-33 and the use of a key (4.5 / 4.6). Keys are member-owned; connect.manage sees and revokes all; rotate is owner-only. The secret is `teas_&lt;kind&gt;_&lt;48 hex&gt;` from the OS random
/// generator, shown once; only its sha256 is stored. A key is found by that hash under system scope (the one read this table needs before a company is known), then the request
/// enters the key's company as the key's owner. Rights at use = scopes ∩ the owner's rights NOW minus AgentForbidden (AgentRules.AgentRights).
/// </summary>
public sealed partial class KeyService(TeasDbContext db, TenantScope scope, IAudit audit, EffectiveRights rights, TimeProvider clock)
{
    const int PrefixLength = 14;
    static readonly TimeSpan TouchEvery = TimeSpan.FromSeconds(60);

    [GeneratedRegex(@"^teas_(rest|mcp)_[0-9a-f]{48}\z")] private static partial Regex SecretFormat();
    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}\z")] private static partial Regex DateText();

    sealed record Rec(Guid Id, int Version, string Name, string Kind, string Prefix, string OwnerName, string[] Scopes, DateTimeOffset CreatedAt, DateTimeOffset? LastUsedAt, DateOnly? ExpiresOn,
        DateTimeOffset? RevokedAt, Guid Owner);

    const string Cols = "k.id, k.version, k.name, k.kind, k.prefix, u.display_name, k.scopes, k.created_at, k.last_used_at, k.expires_on, k.revoked_at, k.owner_user_id";
    const string From = "FROM teas.api_keys k JOIN teas.users u ON u.id = k.owner_user_id";

    static Rec Read(NpgsqlDataReader r) => new(r.GetGuid(0), r.GetInt32(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5), r.GetFieldValue<string[]>(6), r.GetFieldValue<DateTimeOffset>(7),
        r.IsDBNull(8) ? null : r.GetFieldValue<DateTimeOffset>(8), r.IsDBNull(9) ? null : r.GetFieldValue<DateOnly>(9), r.IsDBNull(10) ? null : r.GetFieldValue<DateTimeOffset>(10), r.GetGuid(11));

    Guid Company => scope.Current.CompanyId ?? throw new TeasException("connect.not_member");   // a session with no active company is no member of anything

    DateOnly Today => BusinessDate.Today(clock).Value;

    KeyStatus StatusOf(Rec k) => k.RevokedAt is not null ? KeyStatus.Revoked : k.ExpiresOn is { } e && e < Today ? KeyStatus.Expired : KeyStatus.Active;

    ApiKeyRow View(Rec k) => new(k.Id, k.Version, k.Name, k.Kind == "mcp" ? KeyKind.Mcp : KeyKind.Rest, k.Prefix, k.OwnerName, k.Scopes, k.Scopes.Length, k.CreatedAt, StatusOf(k), k.LastUsedAt,
        k.ExpiresOn?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), k.RevokedAt);

    /// <summary>What the trail keeps: the key as the list shows it, never the secret, the hash or the prefix.</summary>
    static Dictionary<string, object?> Shape(Rec k)
    {
        var d = new Dictionary<string, object?> { ["name"] = k.Name, ["kind"] = k.Kind, ["scopes"] = k.Scopes, ["owner"] = k.OwnerName };
        if (k.ExpiresOn is { } e) d["expiresAt"] = e.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (k.RevokedAt is { } r) d["revokedAt"] = r;
        return d;
    }

    Task<Rec?> GetAsync(Guid company, Guid id, CancellationToken ct) =>
        Q.OneAsync(db, $"SELECT {Cols} {From} WHERE k.company_id = @c AND k.id = @i", Read, ct, TxSql.P("c", company), TxSql.P("i", id));

    static Guid IdOf(string id) => Guid.TryParse(id, out var g) ? g : throw new TeasException("record.not_found");

    Task<bool> ActiveMemberAsync(Guid company, Guid user, CancellationToken ct) =>
        Q.ScalarAsync<bool>(db, "SELECT EXISTS (SELECT 1 FROM teas.company_members WHERE company_id = @c AND user_id = @u AND active AND NOT invite_pending)", ct, TxSql.P("c", company), TxSql.P("u", user));

    /// <summary>A 403 refusal leaves one 'rejected' row, written after the command transaction ended.</summary>
    async Task<T> RefusingAsync<T>(string command, string target, Func<Task<T>> run, CancellationToken ct)
    {
        try { return await run(); }
        catch (TeasException e) when (e.Status == 403) { await audit.RecordRejectedAsync(command, target, ct); throw; }
    }

    // ---------------------------------------------------------------- routes 30-33

    public async Task<ApiKeysView> ListAsync(Guid viewer, CancellationToken ct = default)
    {
        var company = Company;
        var held = await rights.ForUserAsync(viewer, ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        if (!await ActiveMemberAsync(company, viewer, ct)) throw new TeasException("connect.not_member");
        var all = held.Contains("connect.manage");
        var rows = await Q.ManyAsync(db, $"SELECT {Cols} {From} WHERE k.company_id = @c AND (@all OR k.owner_user_id = @u) ORDER BY k.created_at, k.id", Read, ct,
            TxSql.P("c", company), TxSql.P("all", all), TxSql.P("u", viewer));
        return new ApiKeysView([.. rows.Select(View)], [.. held.Where(c => !AgentRules.AgentForbidden(c)).Order(StringComparer.Ordinal)]);
    }

    public async Task<ApiKeyCreated> CreateAsync(Guid owner, string? name, KeyKind kind, IReadOnlyList<string>? scopes, string? expiresAt, CancellationToken ct = default)
    {
        var company = Company;
        var held = await rights.ForUserAsync(owner, ct);
        return await RefusingAsync("connect.key.create", "new", async () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            if (!await ActiveMemberAsync(company, owner, ct)) throw new TeasException("connect.not_member");
            var errors = new List<(string, string)>();
            var n = name?.Trim() ?? "";
            if (n.Length == 0 || n.Length > 60) errors.Add(("name", "ต้องระบุชื่อคีย์ (ไม่เกิน 60 ตัวอักษร)"));
            if (!Enum.IsDefined(kind)) errors.Add(("kind", "ต้องเลือกชนิดคีย์"));
            var wanted = (scopes ?? []).Distinct().Order(StringComparer.Ordinal).ToArray();
            if (wanted.Length == 0 || wanted.Any(s => s is null || !PermissionCatalog.CodeSet.Contains(s))) errors.Add(("scopes", "ต้องเลือกสิทธิ์อย่างน้อยหนึ่งรายการจากรายการที่มี"));
            DateOnly? expires = null;
            if (!string.IsNullOrEmpty(expiresAt))
            {
                if (DateText().IsMatch(expiresAt) && DateOnly.TryParseExact(expiresAt, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) && d > Today) expires = d;
                else errors.Add(("expiresAt", "วันหมดอายุต้องเป็นวันหลังวันนี้"));
            }
            if (errors.Count > 0) throw Invalid.Fields(errors);
            if (wanted.Where(AgentRules.AgentForbidden).ToArray() is { Length: > 0 } never)
                throw new TeasException("connect.scope_forbidden", "forbidden scope: " + string.Join(", ", never));
            if (wanted.Where(s => !held.Contains(s)).ToArray() is { Length: > 0 } over)
                throw new TeasException("connect.scope_exceeds", "beyond the owner's rights: " + string.Join(", ", over));
            var made = await InsertAsync(company, owner, n, kind == KeyKind.Mcp ? "mcp" : "rest", wanted, expires, null, "connect.key.create", ct);
            await tx.CommitAsync(ct);
            return made;
        }, ct);
    }

    /// <summary>Inserts the key and its audit row (inside the caller's transaction); the secret is made here and returned once.</summary>
    async Task<ApiKeyCreated> InsertAsync(Guid company, Guid owner, string name, string kind, string[] scopes, DateOnly? expires, Guid? rotatedFrom, string command, CancellationToken ct)
    {
        var secret = $"teas_{kind}_{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(24))}";
        var id = await Q.ScalarAsync<Guid>(db, """
            INSERT INTO teas.api_keys (company_id, name, kind, prefix, secret_hash, owner_user_id, scopes, expires_on, rotated_from)
            VALUES (@c, @n, @k, @p, @h, @o, @s, @e, @r) RETURNING id
            """, ct, TxSql.P("c", company), TxSql.P("n", name), TxSql.P("k", kind), TxSql.P("p", secret[..PrefixLength]), TxSql.P("h", Tokens.Hash(secret)), TxSql.P("o", owner),
            TxSql.P("s", scopes), Q.N("e", NpgsqlDbType.Date, expires), Q.N("r", NpgsqlDbType.Uuid, rotatedFrom));
        var rec = (await GetAsync(company, id, ct))!;
        await audit.RecordAsync(command, id.ToString(), null, Shape(rec), ct);
        return new ApiKeyCreated(View(rec), secret);
    }

    /// <summary>Owner only: anyone else, the manager included, gets 404. The new key carries the old one's name, kind, scopes, expiry and owner; the old one is revoked in the same transaction.</summary>
    public async Task<ApiKeyCreated> RotateAsync(Guid actor, string id, int version, CancellationToken ct = default)
    {
        var company = Company;
        var keyId = IdOf(id);
        Invalid.RequireVersion(version);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var old = await GetAsync(company, keyId, ct);
        if (old is null || old.Owner != actor) throw new TeasException("record.not_found");
        if (version != old.Version) throw new TeasException("record.version_conflict");
        if (old.RevokedAt is not null) throw new TeasException("connect.key_revoked", status: 409);
        if (StatusOf(old) == KeyStatus.Expired) throw new TeasException("connect.key_expired", status: 409);
        if (!await ActiveMemberAsync(company, old.Owner, ct)) throw new TeasException("connect.owner_inactive");
        var made = await InsertAsync(company, old.Owner, old.Name, old.Kind, [.. old.Scopes.Where(s => PermissionCatalog.CodeSet.Contains(s) && !AgentRules.AgentForbidden(s))], old.ExpiresOn, old.Id, "connect.key.rotate", ct);
        await RevokeRowAsync(old, ct);
        await tx.CommitAsync(ct);
        return made;
    }

    async Task<Rec> RevokeRowAsync(Rec k, CancellationToken ct)
    {
        var v = await VersionedUpdate.UpdateAsync(db, "api_keys", "revoked_at = @now", k.Id, k.Version, TxSql.P("now", clock.GetUtcNow()));
        var next = k with { RevokedAt = clock.GetUtcNow(), Version = v };
        await audit.RecordAsync("connect.key.revoke", k.Id.ToString(), Shape(k), Shape(next), ct);
        return next;
    }

    /// <summary>The owner, or connect.manage. Anyone else gets 404. Already revoked: the row comes back, nothing is written or audited.</summary>
    public async Task<ApiKeyRow> RevokeAsync(Guid actor, string id, int version, CancellationToken ct = default)
    {
        var company = Company;
        var keyId = IdOf(id);
        Invalid.RequireVersion(version);
        var manages = (await rights.ForUserAsync(actor, ct)).Contains("connect.manage");
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var k = await GetAsync(company, keyId, ct);
        if (k is null || (k.Owner != actor && !manages)) throw new TeasException("record.not_found");
        if (version != k.Version) throw new TeasException("record.version_conflict");
        if (k.RevokedAt is not null) return View(k);
        var next = await RevokeRowAsync(k, ct);
        await tx.CommitAsync(ct);
        return View(next);
    }

    // ---------------------------------------------------------------- use of a key

    /// <summary>
    /// The key behind a presented secret, or 401: connect.key_invalid (not a key we know), connect.key_revoked, connect.key_expired (expires_on before the business date; the day itself still works).
    /// The lookup is by sha256 under system scope (this method is the only reader of api_keys across companies); nothing is written here.
    /// </summary>
    public async Task<KeyIdentity> AuthenticateAsync(string secret, CancellationToken ct = default)
    {
        if (!SecretFormat().IsMatch(secret)) throw new TeasException("connect.key_invalid");
        using var _ = scope.EnterSystem("key-auth");
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var row = await Q.OneAsync(db, """
            SELECT k.id, k.company_id, c.name, k.name, k.kind, k.scopes, k.owner_user_id, u.display_name, k.expires_on, k.revoked_at
            FROM teas.api_keys k JOIN teas.companies c ON c.id = k.company_id JOIN teas.users u ON u.id = k.owner_user_id
            WHERE k.secret_hash = @h
            """, r => new
        {
            Id = r.GetGuid(0), Company = r.GetGuid(1), CompanyName = r.GetString(2), Name = r.GetString(3), Kind = r.GetString(4), Scopes = r.GetFieldValue<string[]>(5),
            Owner = r.GetGuid(6), OwnerName = r.GetString(7), Expires = r.IsDBNull(8) ? (DateOnly?)null : r.GetFieldValue<DateOnly>(8), Revoked = !r.IsDBNull(9),
        }, ct, TxSql.P("h", Tokens.Hash(secret)));
        if (row is null) throw new TeasException("connect.key_invalid");
        if (row.Revoked) throw new TeasException("connect.key_revoked");
        if (row.Expires is { } e && e < Today) throw new TeasException("connect.key_expired");
        return new KeyIdentity(row.Id, row.Company, row.CompanyName, row.Name, row.Kind, row.Scopes, row.Owner, row.OwnerName);
    }

    /// <summary>last_used_at, at most once a minute (a busy agent must not write on every call). Inside the key's company scope; the version is not touched (use is not an edit).</summary>
    public async Task TouchAsync(KeyIdentity key, CancellationToken ct = default)
    {
        var now = clock.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await Q.ExecAsync(db, "UPDATE teas.api_keys SET last_used_at = @now WHERE company_id = @c AND id = @i AND (last_used_at IS NULL OR last_used_at <= @before)", ct,
            TxSql.P("now", now), TxSql.P("c", key.CompanyId), TxSql.P("i", key.Id), TxSql.P("before", now - TouchEvery));
        await tx.CommitAsync(ct);
    }

    /// <summary>The key's rights right now (scopes ∩ the owner's current rights − AgentForbidden); an owner who is no longer an active member holds nothing, so neither does the key.</summary>
    public async Task<WhoAmI> WhoAmIAsync(KeyIdentity key, CancellationToken ct = default)
    {
        var held = AgentRules.AgentRights(key.Scopes, await rights.ForUserAsync(key.OwnerId, ct));
        return new WhoAmI(new ActorView(ActorKind.Agent, key.Id, key.Name, key.OwnerName), key.CompanyId, key.CompanyName, [.. held.Order(StringComparer.Ordinal)]);
    }
}
