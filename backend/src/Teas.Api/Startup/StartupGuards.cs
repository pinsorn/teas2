using System.Reflection;
using Npgsql;
using Teas.App;
using Teas.App.Platform;

namespace Teas.Api.Startup;

public sealed class StartupGuardException(string reason) : Exception(reason);

/// <summary>The relations (<c>schema.table</c>, first token per line) exempt from row-level security; the file is shared with the migrator.</summary>
public static class RlsAllowList
{
    public static IReadOnlySet<string> Parse(IEnumerable<string> lines) =>
        lines.Select(l => l.Trim()).Where(l => l.Length > 0 && l[0] != '#')
            .Select(l => l.Split((char[]?)null, 2, StringSplitOptions.RemoveEmptyEntries)[0])
            .ToHashSet(StringComparer.Ordinal);

    public static IReadOnlySet<string> Embedded()
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("rls-allowlist.txt")
            ?? throw new InvalidOperationException("rls-allowlist.txt is not embedded");
        using var r = new StreamReader(s);
        return Parse(r.ReadToEnd().Split('\n'));
    }
}

/// <summary>One relation of a non-system schema, as the catalog sees it.</summary>
public sealed record RelationInfo(string Schema, string Name, char Kind, bool Protected, bool HasRows, bool OwnedByCurrentUser)
{
    public string Qualified => Schema + "." + Name;
    public string Quoted => "\"" + Schema.Replace("\"", "\"\"") + "\".\"" + Name.Replace("\"", "\"\"") + "\"";
}

/// <summary>Refuses to start (SP3 4.3, S16) on: a superuser / BYPASSRLS role or one that is not teas_app, a role that owns tables,
/// a schema that is not this build's, a table without forced RLS and a policy (or an un-listed materialized view), or a failed RLS self-test.</summary>
public static class StartupGuards
{
    public const string AppRole = "teas_app";

    public static async Task RunAsync(string connectionString, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync(ct);

        await using (var cmd = new NpgsqlCommand("SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user", conn))
        {
            await using var r = await cmd.ExecuteReaderAsync(ct);
            if (!await r.ReadAsync(ct)) throw new StartupGuardException("database role not found");
            if (r.GetBoolean(1) || r.GetBoolean(2))
                throw new StartupGuardException($"role '{r.GetString(0)}' is a superuser or has BYPASSRLS; the API must run as {AppRole}");
            if (r.GetString(0) != AppRole)
                throw new StartupGuardException($"role '{r.GetString(0)}' is not {AppRole}");
        }

        var schema = await SchemaIdAsync(conn, ct);
        if (schema != TeasDbContext.ExpectedSchema)
            throw new StartupGuardException($"schema is at '{schema ?? "(none)"}', this build expects '{TeasDbContext.ExpectedSchema}'");

        var allow = RlsAllowList.Embedded();
        var relations = await ScanAsync(conn, ct);
        var owned = relations.Where(r => r.OwnedByCurrentUser).Select(r => r.Qualified).ToList();
        if (owned.Count > 0)
            throw new StartupGuardException($"{AppRole} must own no tables, owns: " + string.Join(", ", owned));
        var bare = Unprotected(relations, allow);
        if (bare.Count > 0)
            throw new StartupGuardException("relations without forced row-level security and a policy: " + string.Join(", ", bare));

        var tenant = relations.Where(r => !allow.Contains(r.Qualified)).ToList();
        var counts = await TenantScope.SelfTestAsync(conn, tenant.Select(r => r.Quoted).ToList(), ct);
        foreach (var t in tenant)
        {
            var (noGuc, system) = counts[t.Quoted];
            if (noGuc != 0)
                throw new StartupGuardException($"RLS self-test failed: {t.Qualified} shows {noGuc} rows with no company set");
            // system = 0 on a table the statistics say holds rows: a policy hides everything (an empty table proves nothing, a full one must show)
            if (t.HasRows && system == 0)
                throw new StartupGuardException($"RLS self-test failed: {t.Qualified} holds rows but system scope sees none; a policy hides everything");
        }
    }

    public static async Task<string?> SchemaIdAsync(NpgsqlConnection conn, CancellationToken ct = default)
    {
        await using var cmd = new NpgsqlCommand("SELECT max(\"MigrationId\") FROM teas.\"__EFMigrationsHistory\"", conn);
        return await cmd.ExecuteScalarAsync(ct) as string;
    }

    /// <summary>Every table, partitioned table and materialized view in every non-system schema (M4).</summary>
    public static async Task<List<RelationInfo>> ScanAsync(NpgsqlConnection conn, CancellationToken ct = default)
    {
        const string sql = """
            SELECT n.nspname, c.relname, c.relkind::text,
                   c.relkind IN ('r', 'p') AND c.relrowsecurity AND c.relforcerowsecurity
                     AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid),
                   c.reltuples > 0 OR COALESCE(s.n_live_tup, 0) > 0,
                   pg_get_userbyid(c.relowner) = current_user
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
            WHERE c.relkind IN ('r', 'p', 'm') AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
            ORDER BY 1, 2
            """;
        var list = new List<RelationInfo>();
        await using var cmd = new NpgsqlCommand(sql, conn);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            list.Add(new RelationInfo(r.GetString(0), r.GetString(1), r.GetString(2)[0], r.GetBoolean(3), r.GetBoolean(4), r.GetBoolean(5)));
        return list;
    }

    public static List<string> Unprotected(IEnumerable<RelationInfo> relations, IReadOnlySet<string> allowList) =>
        relations.Where(r => !r.Protected && !allowList.Contains(r.Qualified)).Select(r => r.Qualified).ToList();

    /// <summary>Relations in any non-system schema that are not allow-listed and lack ENABLE + FORCE row-level security or any policy.</summary>
    public static async Task<List<string>> UnprotectedTablesAsync(NpgsqlConnection conn, IReadOnlySet<string> allowList, CancellationToken ct = default) =>
        Unprotected(await ScanAsync(conn, ct), allowList);
}
