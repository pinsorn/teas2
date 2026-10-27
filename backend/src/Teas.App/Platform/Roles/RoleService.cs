using Npgsql;
using NpgsqlTypes;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Auth;
using Teas.App.Platform.Concurrency;
using Teas.Domain;
using Teas.Domain.Platform;

namespace Teas.App.Platform.Roles;

/// <summary>The document types of the contract (wire values are the names themselves). Used by RoleRow.approvalTypes / sodTypes.</summary>
public enum DocType { QT, SO, DO, BL, IV, TI, RC, CN, DN, PO, PB, PCN, PDN, PV, WT, EX, JV, FA, DP, PR, OB }

/// <summary>The schema of this member is the boolean literal <c>true</c> (the frozen contract says <c>active: true</c>, <c>confirm: true</c>); the serializer is unchanged.</summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class LiteralTrueAttribute : Attribute;

/// <summary>The wire RoleRow (frozen contract 5.1). approvalTypes / sodTypes stay empty until the approval settings exist (SP4).</summary>
public sealed record RoleView(string Id, int Version, [property: LiteralTrue] bool Active, bool System, string Name, IReadOnlyList<string> Permissions, bool InUse,
    IReadOnlyList<DocType> ApprovalTypes, IReadOnlyList<DocType> SodTypes, string? Description = null);

internal sealed record CustomRole(Guid Id, string Name, string? Description, string[] Permissions, int Version);

internal sealed record AdminRef(Guid MemberId, Guid? UserId, string RoleId);

/// <summary>422 record.invalid naming the fields (the forms put each message under its field).</summary>
internal static class Invalid
{
    public static TeasException Fields(params (string Field, string Message)[] errors) =>
        new("record.invalid", null, errors.GroupBy(e => e.Field).ToDictionary(g => g.Key, g => g.Select(e => e.Message).ToArray()));

    public static TeasException Fields(IEnumerable<(string Field, string Message)> errors) => Fields(errors.ToArray());

    /// <summary>A version-body command without its version (the binder reads a missing number as 0) is a 422, not a stale-version 409.</summary>
    public static void RequireVersion(int version)
    {
        if (version < 1) throw Fields(("version", "ต้องระบุเวอร์ชันของข้อมูลที่แก้ไข"));
    }
}

/// <summary>Roles of the CURRENT company: the three system roles (code), and the custom roles table. Also the last-admin rule (SP3 4.5, S15).</summary>
internal static class RoleDirectory
{
    public static readonly IReadOnlyDictionary<string, string> SystemNames = new Dictionary<string, string>
    {
        ["operator"] = "พนักงานคีย์ข้อมูล", ["accountant"] = "นักบัญชี", ["admin"] = "ผู้ดูแลระบบ",
    };

    public static Task<List<CustomRole>> CustomAsync(TeasDbContext db, Guid company, CancellationToken ct) =>
        Q.ManyAsync(db, "SELECT id, name, description, permissions, version FROM teas.custom_roles WHERE company_id = @c ORDER BY name, id",
            r => new CustomRole(r.GetGuid(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetFieldValue<string[]>(3), r.GetInt32(4)), ct, TxSql.P("c", company));

    public static bool Exists(string roleId, IEnumerable<CustomRole> customs) => SystemNames.ContainsKey(roleId) || customs.Any(r => r.Id.ToString() == roleId);

    public static string NameOf(string roleId, IEnumerable<CustomRole> customs) =>
        SystemNames.TryGetValue(roleId, out var n) ? n : customs.FirstOrDefault(r => r.Id.ToString() == roleId)?.Name ?? roleId;

    /// <summary>The rights of a role: the system template, or the custom role's permissions, both intersected with the catalog.</summary>
    public static IReadOnlySet<string> PermissionsOf(string roleId, IEnumerable<CustomRole> customs) =>
        (PermissionCatalog.SystemRoles.TryGetValue(roleId, out var t) ? t : customs.FirstOrDefault(r => r.Id.ToString() == roleId)?.Permissions ?? [])
        .Where(PermissionCatalog.CodeSet.Contains).ToHashSet();

    public static bool Manages(string roleId, IEnumerable<CustomRole> customs) => PermissionsOf(roleId, customs).Contains("users.manage");

    /// <summary>Serializes every change that can touch who is an administrator or which roles exist (taken first in the command transaction; released at its end).</summary>
    public static async Task LockAsync(TeasDbContext db, Guid company, CancellationToken ct)
    {
        await using var cmd = TxSql.Cmd(db, "SELECT pg_advisory_xact_lock(hashtextextended(@k, 0))", TxSql.P("k", "company-roles:" + company));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>The members that count as administrators: active, accepted (a pending invite never counts) and holding users.manage.</summary>
    public static async Task<List<AdminRef>> AdminsAsync(TeasDbContext db, Guid company, IEnumerable<CustomRole> customs, CancellationToken ct)
    {
        var all = await Q.ManyAsync(db, "SELECT id, user_id, role_id FROM teas.company_members WHERE company_id = @c AND active AND NOT invite_pending",
            r => new AdminRef(r.GetGuid(0), r.IsDBNull(1) ? null : r.GetGuid(1), r.GetString(2)), ct, TxSql.P("c", company));
        var list = customs.ToList();
        return all.Where(a => Manages(a.RoleId, list)).ToList();
    }
}

/// <summary>SP3 P8 routes 26-29. Every write is one transaction: lock, check, guarded UPDATE (bumps version: the rights cache trusts it), audit.</summary>
public sealed class RoleService(TeasDbContext db, TenantScope scope, IAudit audit)
{
    Guid Company => scope.Current.CompanyId ?? throw new InvalidOperationException("roles need a company scope");

    static RoleView View(CustomRole r, bool inUse) => new(r.Id.ToString(), r.Version, true, false, r.Name, r.Permissions.Where(PermissionCatalog.CodeSet.Contains).ToList(), inUse, [], [], r.Description);

    static object Shape(string name, string? description, IEnumerable<string> permissions) => new { name, description, permissions };

    public async Task<IReadOnlyList<RoleView>> ListAsync(CancellationToken ct = default)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var customs = await RoleDirectory.CustomAsync(db, Company, ct);
        var used = (await Q.ManyAsync(db, "SELECT DISTINCT role_id FROM teas.company_members WHERE company_id = @c", r => r.GetString(0), ct, TxSql.P("c", Company))).ToHashSet();
        var system = PermissionCatalog.SystemRoles.Select(kv => new RoleView(kv.Key, 1, true, true, RoleDirectory.SystemNames[kv.Key], kv.Value, used.Contains(kv.Key), [], []));
        return [.. system, .. customs.Select(r => View(r, used.Contains(r.Id.ToString())))];
    }

    /// <summary>Name, description and permission list of a custom role, validated (the unknown-code rule is the catalog's).</summary>
    static (string Name, string? Description, string[] Permissions) Validate(string? name, string? description, IReadOnlyList<string>? permissions, IEnumerable<CustomRole> customs, Guid? self)
    {
        var errors = new List<(string, string)>();
        var n = name?.Trim() ?? "";
        if (n.Length == 0) errors.Add(("name", "ต้องระบุชื่อบทบาท"));
        else if (RoleDirectory.SystemNames.Values.Contains(n) || customs.Any(r => r.Name == n && r.Id != self)) errors.Add(("name", "ชื่อนี้ใช้แล้ว"));
        if (permissions is null || permissions.Any(p => p is null || !PermissionCatalog.CodeSet.Contains(p))) errors.Add(("permissions", "มีรหัสสิทธิ์ที่ไม่อยู่ในรายการ"));
        if (errors.Count > 0) throw Invalid.Fields(errors);
        return (n, string.IsNullOrWhiteSpace(description) ? null : description.Trim(), permissions!.Distinct().ToArray());
    }

    public async Task<RoleView> CreateAsync(string? name, string? description, IReadOnlyList<string>? permissions, CancellationToken ct = default)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await RoleDirectory.LockAsync(db, Company, ct);
        var clean = Validate(name, description, permissions, await RoleDirectory.CustomAsync(db, Company, ct), null);
        Guid id;
        try
        {
            id = await Q.ScalarAsync<Guid>(db, "INSERT INTO teas.custom_roles (company_id, name, description, permissions) VALUES (@c, @n, @d, @p) RETURNING id", ct,
                TxSql.P("c", Company), TxSql.P("n", clean.Name), Q.N("d", NpgsqlDbType.Text, clean.Description), TxSql.P("p", clean.Permissions));
        }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation) { throw Invalid.Fields(("name", "ชื่อนี้ใช้แล้ว")); }
        var view = View(new CustomRole(id, clean.Name, clean.Description, clean.Permissions, 1), false);
        await audit.RecordAsync("role.create", id.ToString(), null, Shape(clean.Name, clean.Description, view.Permissions), ct);
        await tx.CommitAsync(ct);
        return view;
    }

    static Guid ParseCustom(string id)
    {
        if (RoleDirectory.SystemNames.ContainsKey(id)) throw new TeasException("role.system_readonly");
        return Guid.TryParse(id, out var g) ? g : throw new TeasException("record.not_found");
    }

    public async Task<RoleView> UpdateAsync(string id, int version, string? name, string? description, IReadOnlyList<string>? permissions, Guid actorUser, CancellationToken ct = default)
    {
        var roleId = ParseCustom(id);
        Invalid.RequireVersion(version);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await RoleDirectory.LockAsync(db, Company, ct);
        var customs = await RoleDirectory.CustomAsync(db, Company, ct);
        var role = customs.FirstOrDefault(r => r.Id == roleId) ?? throw new TeasException("record.not_found");
        if (version != role.Version) throw new TeasException("record.version_conflict");
        var clean = Validate(name ?? role.Name, description is null ? role.Description : description, permissions ?? role.Permissions, customs, roleId);

        // taking users.manage off a role demotes everyone who holds it: the company must keep another administrator, and nobody demotes themselves this way
        if (RoleDirectory.Manages(id, customs) && !clean.Permissions.Contains("users.manage"))
        {
            var admins = await RoleDirectory.AdminsAsync(db, Company, customs, ct);
            var holders = admins.Where(a => a.RoleId == id).ToList();
            if (holders.Count > 0 && (!admins.Any(a => a.RoleId != id) || holders.Any(h => h.UserId == actorUser))) throw new TeasException("user.last_admin");
        }

        var newVersion = await VersionedUpdate.UpdateAsync(db, "custom_roles", "name = @n, description = @d, permissions = @p", roleId, version,
            TxSql.P("n", clean.Name), Q.N("d", NpgsqlDbType.Text, clean.Description), TxSql.P("p", clean.Permissions));
        var view = View(new CustomRole(roleId, clean.Name, clean.Description, clean.Permissions, newVersion), await InUseAsync(id, ct));
        await audit.RecordAsync("role.update", id, Shape(role.Name, role.Description, role.Permissions), Shape(clean.Name, clean.Description, view.Permissions), ct);
        await tx.CommitAsync(ct);
        return view;
    }

    Task<bool> InUseAsync(string roleId, CancellationToken ct) =>
        Q.ScalarAsync<bool>(db, "SELECT EXISTS (SELECT 1 FROM teas.company_members WHERE company_id = @c AND role_id = @r)", ct, TxSql.P("c", Company), TxSql.P("r", roleId));

    public async Task DeleteAsync(string id, int version, CancellationToken ct = default)
    {
        var roleId = ParseCustom(id);
        Invalid.RequireVersion(version);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await RoleDirectory.LockAsync(db, Company, ct);
        var role = (await RoleDirectory.CustomAsync(db, Company, ct)).FirstOrDefault(r => r.Id == roleId) ?? throw new TeasException("record.not_found");
        if (version != role.Version) throw new TeasException("record.version_conflict");
        if (await InUseAsync(id, ct)) throw new TeasException("role.in_use");
        if (await Q.ExecAsync(db, "DELETE FROM teas.custom_roles WHERE company_id = @c AND id = @i AND version = @v", ct, TxSql.P("c", Company), TxSql.P("i", roleId), TxSql.P("v", version)) != 1)
            throw new TeasException("record.version_conflict");
        await audit.RecordAsync("role.delete", id, Shape(role.Name, role.Description, role.Permissions), null, ct);
        await tx.CommitAsync(ct);
    }
}
