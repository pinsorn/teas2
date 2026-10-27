using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Teas.App.Platform.Concurrency;
using Teas.Domain.Platform;

namespace Teas.App.Platform.Rights;

/// <summary>The key scopes of the agent behind this request; the key-auth middleware (P-keys) fills it, null for a person.</summary>
public sealed class ActorScopes
{
    public IReadOnlyCollection<string>? Values { get; set; }
}

/// <summary>Cached rights per (company, user), valid while the member row's version and the custom role's version are unchanged.</summary>
public sealed class RightsCache
{
    internal readonly ConcurrentDictionary<(Guid company, Guid user), (int member, int role, IReadOnlySet<string> rights)> Entries = new();
}

/// <summary>
/// SP3 4.5 effective rights of a person in the CURRENT company scope: the role permissions of their company_members row when it is
/// active and accepted, else nothing; the role is a system template or a custom_roles row; intersected with the catalog.
/// Runs its own short transaction, so call it outside the command transaction (it is the authorization step).
/// </summary>
public sealed class EffectiveRights(TeasDbContext db, TenantScope scope, RightsCache cache)
{
    static readonly IReadOnlySet<string> None = new HashSet<string>();

    public async Task<IReadOnlySet<string>> ForUserAsync(Guid user, CancellationToken ct = default)
    {
        var company = scope.Current.CompanyId ?? throw new InvalidOperationException("rights need a company scope (TenantScope.Enter)");
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await using var cmd = TxSql.Cmd(db, """
            SELECT m.version, m.role_id, m.active AND NOT m.invite_pending, r.version, r.permissions
            FROM teas.company_members m
            LEFT JOIN teas.custom_roles r ON r.company_id = m.company_id AND r.id::text = m.role_id
            WHERE m.company_id = @c AND m.user_id = @u
            """, TxSql.P("c", company), TxSql.P("u", user));
        await using var rd = await cmd.ExecuteReaderAsync(ct);
        if (!await rd.ReadAsync(ct) || !rd.GetBoolean(2)) return None;
        int memberVersion = rd.GetInt32(0), roleVersion = rd.IsDBNull(3) ? 0 : rd.GetInt32(3);
        if (cache.Entries.TryGetValue((company, user), out var hit) && hit.member == memberVersion && hit.role == roleVersion) return hit.rights;

        var roleId = rd.GetString(1);
        IEnumerable<string> held = PermissionCatalog.SystemRoles.TryGetValue(roleId, out var template) ? template
            : rd.IsDBNull(4) ? [] : rd.GetFieldValue<string[]>(4);
        var rights = held.Where(PermissionCatalog.CodeSet.Contains).ToHashSet();
        cache.Entries[(company, user)] = (memberVersion, roleVersion, rights);
        return rights;
    }
}
