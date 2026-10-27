using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;
using Teas.App;
using Teas.App.Platform.Auth;
using Teas.Domain.Platform;

// Verbs: migrate (P2; P5 also syncs the permission catalog) | export-permissions <file> (P5, run by the build) | bootstrap-admin | reset-mfa | reset-password (P7). Connects as teas_migrator.
var verb = args.FirstOrDefault();
if (verb == "migrate")
{
    var cs = Environment.GetEnvironmentVariable("TEAS_MIGRATOR_CS");
    if (string.IsNullOrWhiteSpace(cs)) { Console.Error.WriteLine("teas-migrator: set TEAS_MIGRATOR_CS"); return 2; }
    var (permissions, roleTemplates) = await MigratorRunner.MigrateAsync(cs);
    Console.WriteLine("teas-migrator: schema is at " + TeasDbContext.ExpectedSchema);
    Console.WriteLine($"teas-migrator: catalog permissions={permissions} roleTemplates={roleTemplates}");   // SP3 8 step 1: /health/ready must report the same two numbers
    return 0;
}
if (verb == "export-permissions" && args.Length == 2)
{
    CatalogSync.Export(args[1]);
    return 0;
}
if (verb is "bootstrap-admin" or "reset-mfa" or "reset-password")
{
    var cs = Environment.GetEnvironmentVariable("TEAS_MIGRATOR_CS");
    if (string.IsNullOrWhiteSpace(cs)) { Console.Error.WriteLine("teas-migrator: set TEAS_MIGRATOR_CS"); return 2; }
    return await AuthCli.RunAsync(args, cs, Environment.GetEnvironmentVariable("TEAS_PUBLIC_URL") ?? "http://localhost:3000", Console.Out, Console.Error);
}
Console.Error.WriteLine("teas-migrator: unknown verb '" + verb + "' (migrate, export-permissions <file>, bootstrap-admin --email <e> --name <n>, reset-mfa --email <e>, reset-password --email <e>)");
return 2;

/// <summary>Also called by the integration-test harness to build the template database.</summary>
public static class MigratorRunner
{
    public static async Task<(int permissions, int templates)> MigrateAsync(string migratorConnectionString)
    {
        var options = new DbContextOptionsBuilder<TeasDbContext>();
        TeasDbContext.Configure(options, migratorConnectionString);
        await using var db = new TeasDbContext(options.Options);
        await db.Database.MigrateAsync();
        return await CatalogSync.SyncAsync(migratorConnectionString);
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
        await Run(conn, tx, "SELECT pg_advisory_xact_lock(5430003)");   // two migrators syncing at once queue here
        var pairs = roles.SelectMany(r => r.Value.Select(c => (role: r.Key, code: c))).ToList();
        var codes = catalog.Select(p => p.Code).ToArray();
        // templates first (they reference permissions), then drop codes the catalog no longer has, then upsert, then refill the templates
        await Run(conn, tx, "DELETE FROM teas.role_templates");
        await Run(conn, tx, "DELETE FROM teas.permissions WHERE code <> ALL(@codes)", P("codes", codes));
        await Run(conn, tx, """
            INSERT INTO teas.permissions (code, area, agent_forbidden, sort) SELECT * FROM unnest(@codes, @areas, @flags, @sorts)
            ON CONFLICT (code) DO UPDATE SET area = EXCLUDED.area, agent_forbidden = EXCLUDED.agent_forbidden, sort = EXCLUDED.sort
            """, P("codes", codes), P("areas", catalog.Select(p => p.Area).ToArray()), P("flags", catalog.Select(p => p.AgentForbidden).ToArray()),
            P("sorts", Enumerable.Range(0, catalog.Count).ToArray()));
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

/// <summary>
/// SP3 4.4 / Q3 / Q5, the server operator's verbs. They run as teas_migrator and touch only global tables (users, user_links, recovery_codes, sessions, auth_events).
/// A verb that issues a link prints exactly ONE line to stdout, the link (everything else goes to stderr), only after its transaction committed; the database keeps
/// only the link's hash. Every verb writes an auth_events row (the email as a hash).
/// </summary>
public static class AuthCli
{
    public static async Task<int> RunAsync(string[] args, string connectionString, string publicUrl, TextWriter output, TextWriter error)
    {
        var verb = args.FirstOrDefault();
        string? Opt(string name) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1].Trim() : null; }
        if (verb is not ("bootstrap-admin" or "reset-mfa" or "reset-password")) { error.WriteLine("unknown verb '" + verb + "'"); return 2; }
        var email = Opt("--email");
        if (string.IsNullOrEmpty(email)) { error.WriteLine(verb + ": --email is required"); return 2; }
        var name = Opt("--name");
        if (verb == "bootstrap-admin" && string.IsNullOrEmpty(name)) { error.WriteLine("bootstrap-admin: --name is required"); return 2; }

        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync();
        await using var tx = await conn.BeginTransactionAsync();
        var now = (DateTimeOffset)(await Scalar(conn, tx, "SELECT now()"))!;   // the database clock: the CLI has no TimeProvider
        Guid user;
        if (verb == "bootstrap-admin")
        {
            if (await Scalar(conn, tx, "INSERT INTO teas.users (email, display_name) VALUES (@e, @n) ON CONFLICT (email) DO NOTHING RETURNING id", ("e", email), ("n", name!)) is not Guid created)
            {
                error.WriteLine("bootstrap-admin: " + email + " already exists (use reset-password to give them a new link)");
                return 1;
            }
            user = created;
        }
        else if (await Scalar(conn, tx, "SELECT id FROM teas.users WHERE email = @e::citext", ("e", email)) is Guid found) user = found;
        else { error.WriteLine(verb + ": no user " + email); return 1; }

        string? link = null;
        if (verb == "reset-mfa")
        {
            await Run(conn, tx, "UPDATE teas.users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_last_step = NULL, version = version + 1 WHERE id = @u", ("u", user));
            await Run(conn, tx, "DELETE FROM teas.recovery_codes WHERE user_id = @u", ("u", user));
            var ended = await Run(conn, tx, "UPDATE teas.sessions SET revoked_at = @now, revoke_reason = 'reset_mfa' WHERE user_id = @u AND revoked_at IS NULL", ("u", user), ("now", now));
            error.WriteLine($"reset-mfa: two-step verification and recovery codes cleared for {email}; {ended} session(s) ended");
        }
        else
        {
            var issued = await UserLinks.IssueAsync(conn, tx, UserLinks.Reset, user, null, null, UserLinks.Operator, now);
            link = publicUrl.TrimEnd('/') + "/link/" + issued.Token;
        }
        await Run(conn, tx, "INSERT INTO teas.auth_events (at, kind, email_hash, user_id, user_agent) VALUES (@now, @k, @h, @u, 'cli')",
            ("now", now), ("k", "cli." + verb.Replace('-', '_')), ("h", Tokens.EmailKey(email)), ("u", user));
        await tx.CommitAsync();
        if (link is not null) output.Write(link + '\n');   // LF on every platform: one line, parsed by scripts
        return 0;
    }

    static async Task<object?> Scalar(NpgsqlConnection c, NpgsqlTransaction t, string sql, params (string, object)[] ps)
    {
        await using var cmd = new NpgsqlCommand(sql, c, t);
        foreach (var (n, v) in ps) cmd.Parameters.AddWithValue(n, v);
        var v2 = await cmd.ExecuteScalarAsync();
        return v2 is DateTime d ? new DateTimeOffset(d.ToUniversalTime()) : v2;
    }

    static async Task<int> Run(NpgsqlConnection c, NpgsqlTransaction t, string sql, params (string, object)[] ps)
    {
        await using var cmd = new NpgsqlCommand(sql, c, t);
        foreach (var (n, v) in ps) cmd.Parameters.AddWithValue(n, v);
        return await cmd.ExecuteNonQueryAsync();
    }
}
