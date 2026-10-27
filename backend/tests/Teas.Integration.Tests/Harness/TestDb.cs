using Npgsql;
using Teas.App.Platform;

namespace Teas.Integration.Tests.Harness;

/// <summary>
/// One migrated template database per test run, one clone per test class (SP3 4.3 "Integration tests").
/// Needs TEAS_TEST_ADMIN_CS (teas_test_admin) and TEAS_TEST_APP_CS (teas_app). A missing variable FAILS the run, never skips.
/// F6: the admin connection never pools, and the pools are cleared after migrating, or CREATE DATABASE ... TEMPLATE refuses.
/// </summary>
public static class TestDb
{
    static readonly Lazy<Task<string>> Template = new(CreateTemplateAsync);
    static readonly SemaphoreSlim CloneLock = new(1, 1);   // concurrent CREATE DATABASE from one template collide

    static string Env(string name) => Environment.GetEnvironmentVariable(name)
        ?? throw new InvalidOperationException($"{name} is not set; integration tests need the local PostgreSQL (see tools/db/setup-local.ps1)");

    static string Admin(string db) => new NpgsqlConnectionStringBuilder(Env("TEAS_TEST_ADMIN_CS")) { Database = db, Pooling = false }.ToString();
    static string AdminMaintenance => Admin("postgres");
    public static string AdminMaintenanceCs => AdminMaintenance;

    /// <summary>teas_test_admin is a member of teas_migrator; SET ROLE at connect makes it BE the owner (FORCE RLS applies to it).</summary>
    public static string MigratorCs(string db) =>
        new NpgsqlConnectionStringBuilder(Env("TEAS_TEST_ADMIN_CS")) { Database = db, Options = "-c role=teas_migrator" }.ToString();

    public static string AppCs(string db) => new NpgsqlConnectionStringBuilder(Env("TEAS_TEST_APP_CS")) { Database = db }.ToString();

    static async Task ExecAsync(string cs, string sql)
    {
        await using var c = new NpgsqlConnection(cs);
        await c.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, c);
        await cmd.ExecuteNonQueryAsync();
    }

    static async Task<string> CreateTemplateAsync()
    {
        var name = "teas_tpl_" + Guid.NewGuid().ToString("N")[..12];
        await ExecAsync(AdminMaintenance, $"CREATE DATABASE {name} OWNER teas_migrator");
        AppDomain.CurrentDomain.ProcessExit += (_, _) =>
        {
            NpgsqlConnection.ClearAllPools();
            try { ExecAsync(AdminMaintenance, $"DROP DATABASE IF EXISTS {name} WITH (FORCE)").GetAwaiter().GetResult(); } catch (NpgsqlException) { }
        };
        await MigratorRunner.MigrateAsync(MigratorCs(name));
        NpgsqlConnection.ClearAllPools();
        return name;
    }

    public static async Task<DbClone> CloneAsync()
    {
        var template = await Template.Value;
        var name = "teas_t_" + Guid.NewGuid().ToString("N")[..12];
        await CloneLock.WaitAsync();
        try { await ExecAsync(AdminMaintenance, $"CREATE DATABASE {name} TEMPLATE {template} OWNER teas_migrator"); }
        finally { CloneLock.Release(); }
        var clone = new DbClone(name);
        try { await clone.AssertAppRoleAsync(); }
        catch { await clone.DisposeAsync(); throw; }
        return clone;
    }
}

public sealed class DbClone(string name) : IAsyncDisposable
{
    public string Name { get; } = name;
    public string AppCs => TestDb.AppCs(Name);
    public string MigratorCs => TestDb.MigratorCs(Name);

    public async Task<NpgsqlConnection> OpenAppAsync()
    {
        var c = new NpgsqlConnection(AppCs);
        await c.OpenAsync();
        return c;
    }

    public async Task<NpgsqlConnection> OpenMigratorAsync()
    {
        var c = new NpgsqlConnection(MigratorCs);
        await c.OpenAsync();
        return c;
    }

    /// <summary>F1: tests run as teas_app, never a superuser / BYPASSRLS role, or a green run proves nothing.</summary>
    public async Task AssertAppRoleAsync()
    {
        await using var c = await OpenAppAsync();
        await using var cmd = new NpgsqlCommand("SELECT current_user = 'teas_app' AND NOT r.rolsuper AND NOT r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user", c);
        if ((bool?)await cmd.ExecuteScalarAsync() != true)
            throw new InvalidOperationException("TEAS_TEST_APP_CS must connect as teas_app (NOSUPERUSER, NOBYPASSRLS)");
    }

    /// <summary>Runs <paramref name="work"/> in one transaction under <paramref name="scope"/> on a fresh pooled app connection; rolls back.</summary>
    internal async Task<T> AsAppAsync<T>(ScopeState scope, Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> work, bool commit = false)
    {
        await using var c = await OpenAppAsync();
        await using var tx = await c.BeginTransactionAsync();
        await TenantScope.ApplyAsync(c, tx, scope);
        var result = await work(c, tx);
        if (commit) await tx.CommitAsync(); else await tx.RollbackAsync();
        return result;
    }

    public async ValueTask DisposeAsync()
    {
        NpgsqlConnection.ClearAllPools();
        await using var a = new NpgsqlConnection(TestDb.AdminMaintenanceCs);
        await a.OpenAsync();
        // a just-closed teas_app backend is still exiting and teas_test_admin cannot signal another role's backend (42501 / 55006): retry
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await using var cmd = new NpgsqlCommand($"DROP DATABASE IF EXISTS {Name} WITH (FORCE)", a);
                await cmd.ExecuteNonQueryAsync();
                return;
            }
            catch (PostgresException e) when (e.SqlState is "42501" or "55006" && attempt < 20) { await Task.Delay(250); }
        }
    }
}
