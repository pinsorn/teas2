using System.Reflection;
using Npgsql;
using Teas.App;
using Teas.App.Platform;

namespace Teas.Api.Startup;

public sealed class StartupGuardException(string reason) : Exception(reason);

/// <summary>The table names (first token per line) that are exempt from row-level security; the file is shared with the migrator.</summary>
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

/// <summary>Refuses to start (SP3 4.3, S16) on: a superuser / BYPASSRLS role, a schema that is not this build's, a table without
/// forced RLS and a policy, or a failed RLS self-test.</summary>
public static class StartupGuards
{
    /// <param name="roleToCheck">null = the connected role. Tests pass another role's name to prove the refusal path.</param>
    public static async Task RunAsync(string connectionString, string? roleToCheck = null, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync(ct);

        await using (var cmd = new NpgsqlCommand("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = COALESCE(@r, current_user)", conn))
        {
            cmd.Parameters.AddWithValue("r", (object?)roleToCheck ?? DBNull.Value);
            await using var r = await cmd.ExecuteReaderAsync(ct);
            if (!await r.ReadAsync(ct)) throw new StartupGuardException("database role not found");
            if (r.GetBoolean(1) || r.GetBoolean(2))
                throw new StartupGuardException($"role '{r.GetString(0)}' is a superuser or has BYPASSRLS; the API must run as teas_app");
        }

        var schema = await SchemaIdAsync(conn, ct);
        if (schema != TeasDbContext.ExpectedSchema)
            throw new StartupGuardException($"schema is at '{schema ?? "(none)"}', this build expects '{TeasDbContext.ExpectedSchema}'");

        var bare = await UnprotectedTablesAsync(conn, RlsAllowList.Embedded(), ct);
        if (bare.Count > 0)
            throw new StartupGuardException("tables without forced row-level security and a policy: " + string.Join(", ", bare));

        var (noGuc, system) = await TenantScope.CountCompaniesAsync(conn, ct);
        if (noGuc != 0)
            throw new StartupGuardException($"RLS self-test failed: teas.companies shows {noGuc} rows with no company set");
        // system = 0 means an empty database: the 0 above proves nothing, but there is nothing to leak either.
        _ = system;
    }

    public static async Task<string?> SchemaIdAsync(NpgsqlConnection conn, CancellationToken ct = default)
    {
        await using var cmd = new NpgsqlCommand("SELECT max(\"MigrationId\") FROM teas.\"__EFMigrationsHistory\"", conn);
        return await cmd.ExecuteScalarAsync(ct) as string;
    }

    /// <summary>Tables in schema teas that are not allow-listed and lack ENABLE + FORCE row-level security or any policy.</summary>
    public static async Task<List<string>> UnprotectedTablesAsync(NpgsqlConnection conn, IReadOnlySet<string> allowList, CancellationToken ct = default)
    {
        const string sql = """
            SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'teas' AND c.relkind IN ('r', 'p')
              AND NOT (c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
            ORDER BY 1
            """;
        var bad = new List<string>();
        await using var cmd = new NpgsqlCommand(sql, conn);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) if (!allowList.Contains(r.GetString(0))) bad.Add(r.GetString(0));
        return bad;
    }
}
