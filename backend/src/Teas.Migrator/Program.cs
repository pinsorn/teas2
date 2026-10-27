using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;
using Teas.App;
using Teas.Domain.Platform;

// Verbs: migrate (P2; P5 also syncs the permission catalog) | export-permissions <file> (P5, run by the build) | bootstrap-admin | reset-mfa | reset-password (P7). Connects as teas_migrator.
var verb = args.FirstOrDefault();
if (verb == "migrate")
{
    var cs = Environment.GetEnvironmentVariable("TEAS_MIGRATOR_CS");
    if (string.IsNullOrWhiteSpace(cs)) { Console.Error.WriteLine("teas-migrator: set TEAS_MIGRATOR_CS"); return 2; }
    await MigratorRunner.MigrateAsync(cs);
    Console.WriteLine("teas-migrator: schema is at " + TeasDbContext.ExpectedSchema);
    return 0;
}
if (verb == "export-permissions" && args.Length == 2)
{
    CatalogSync.Export(args[1]);
    return 0;
}
Console.Error.WriteLine("teas-migrator: unknown or not yet available verb '" + verb + "' (migrate, export-permissions <file>)");
return 2;

/// <summary>Also called by the integration-test harness to build the template database.</summary>
public static class MigratorRunner
{
    public static async Task MigrateAsync(string migratorConnectionString)
    {
        var options = new DbContextOptionsBuilder<TeasDbContext>();
        TeasDbContext.Configure(options, migratorConnectionString);
        await using var db = new TeasDbContext(options.Options);
        await db.Database.MigrateAsync();
        await CatalogSync.SyncAsync(migratorConnectionString);
    }
}

/// <summary>SP3 4.5: makes teas.permissions / teas.role_templates equal the code catalog. Idempotent; a code removed from the catalog is deleted.</summary>
public static class CatalogSync
{
    public static Task<(int permissions, int templates)> SyncAsync(string migratorConnectionString) =>
        SyncAsync(migratorConnectionString, PermissionCatalog.All, PermissionCatalog.SystemRoles);

    public static async Task<(int permissions, int templates)> SyncAsync(string migratorConnectionString,
        IReadOnlyList<PermissionDef> catalog, IReadOnlyDictionary<string, IReadOnlyList<string>> roles)
    {
        await using var conn = new NpgsqlConnection(migratorConnectionString);
        await conn.OpenAsync();
        await using var tx = await conn.BeginTransactionAsync();
        var pairs = roles.SelectMany(r => r.Value.Select(c => (role: r.Key, code: c))).ToList();
        var codes = catalog.Select(p => p.Code).ToArray();
        // templates first (they reference permissions), then drop codes the catalog no longer has, then upsert, then refill the templates
        await Run(conn, tx, "DELETE FROM teas.role_templates");
        await Run(conn, tx, "DELETE FROM teas.permissions WHERE code <> ALL(@codes)", P("codes", codes));
        await Run(conn, tx, """
            INSERT INTO teas.permissions (code, area, agent_forbidden) SELECT * FROM unnest(@codes, @areas, @flags)
            ON CONFLICT (code) DO UPDATE SET area = EXCLUDED.area, agent_forbidden = EXCLUDED.agent_forbidden
            """, P("codes", codes), P("areas", catalog.Select(p => p.Area).ToArray()), P("flags", catalog.Select(p => p.AgentForbidden).ToArray()));
        await Run(conn, tx, "INSERT INTO teas.role_templates (role_id, permission_code) SELECT * FROM unnest(@roles, @pcodes)",
            P("roles", pairs.Select(p => p.role).ToArray()), P("pcodes", pairs.Select(p => p.code).ToArray()));
        await tx.CommitAsync();
        return (catalog.Count, pairs.Count);
    }

    /// <summary>backend/artifacts/permissions.json: what the frontend vitest compares with the frozen contract.</summary>
    public static void Export(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        File.WriteAllText(path, JsonSerializer.Serialize(new
        {
            permissions = PermissionCatalog.All.Select(p => new { code = p.Code, area = p.Area, agentForbidden = p.AgentForbidden }),
            roles = PermissionCatalog.SystemRoles,
        }, JsonSerializerOptions.Web));
    }

    static NpgsqlParameter P<T>(string name, T value) => new NpgsqlParameter<T>(name, value);

    static async Task Run(NpgsqlConnection c, NpgsqlTransaction t, string sql, params NpgsqlParameter[] ps)
    {
        await using var cmd = new NpgsqlCommand(sql, c, t);
        cmd.Parameters.AddRange(ps);
        await cmd.ExecuteNonQueryAsync();
    }
}
