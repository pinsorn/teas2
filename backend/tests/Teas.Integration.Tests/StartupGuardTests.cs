using System.Net;
using System.Reflection;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using Teas.Api.Startup;
using Teas.App;
using Teas.App.Platform;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// S16: startup refuses a superuser / BYPASSRLS role, a schema mismatch and a failed RLS self-test.
public sealed class StartupGuardTests : IAsyncLifetime
{
    DbClone _db = null!;
    public async Task InitializeAsync() => _db = await TestDb.CloneAsync();
    public async Task DisposeAsync() => await _db.DisposeAsync();

    async Task AsMigrator(string sql)
    {
        await using var m = await _db.OpenMigratorAsync();
        await using var cmd = new NpgsqlCommand(sql, m);
        await cmd.ExecuteNonQueryAsync();
    }

    [Fact]
    public async Task CleanSchemaStarts() => await StartupGuards.RunAsync(_db.AppCs);

    [Fact]
    public void ExpectedSchemaIsTheMigratorsLastMigration()
    {
        var last = typeof(MigratorRunner).Assembly.GetTypes()
            .Select(t => t.GetCustomAttribute<MigrationAttribute>()?.Id).Where(id => id != null).Max();
        Assert.Equal(TeasDbContext.ExpectedSchema, last);
    }

    // S16 against a REAL BYPASSRLS login (CI creates teas_bypass_probe; locally it is skipped with a reason when absent).
    [RequiresBypassProbeFact]
    public async Task BypassRlsLoginIsRefused()
    {
        var cs = new NpgsqlConnectionStringBuilder(_db.AppCs) { Username = RequiresBypassProbeFactAttribute.Role }.ToString();
        var e = await Assert.ThrowsAsync<StartupGuardException>(() => StartupGuards.RunAsync(cs));
        Assert.Contains("BYPASSRLS", e.Message);
    }

    // L2: only teas_app may run the API (the migrator owns the tables and would pass every other check).
    [Fact]
    public async Task AnyRoleButTeasAppIsRefused()
    {
        var e = await Assert.ThrowsAsync<StartupGuardException>(() => StartupGuards.RunAsync(_db.MigratorCs));
        Assert.Contains("not teas_app", e.Message);
    }

    // L3: forced RLS and a policy are present, no-GUC reads 0, but system scope sees nothing although the table holds rows.
    [Fact]
    public async Task PolicyThatHidesEverythingFromSystemScopeIsRefused()
    {
        var a = Guid.NewGuid();
        await _db.AsAppAsync(new ScopeState(a, null, false), async (c, tx) => { await TenantRowFactory.Inserts["companies"](c, tx, a); return 0; }, commit: true);
        await AsMigrator("DROP POLICY tenant_select ON teas.companies; CREATE POLICY tenant_select ON teas.companies FOR SELECT USING (false); ANALYZE teas.companies");
        var e = await Assert.ThrowsAsync<StartupGuardException>(() => StartupGuards.RunAsync(_db.AppCs));
        Assert.Contains("hides everything", e.Message);
    }

    // R2-1: a tenant table that was emptied under system scope is not a hiding policy; startup still succeeds.
    [Fact]
    public async Task AnEmptiedCompaniesTableStillStarts()
    {
        var a = Guid.NewGuid();
        await _db.AsAppAsync(new ScopeState(a, null, false), async (c, tx) => { await TenantRowFactory.Inserts["companies"](c, tx, a); return 0; }, commit: true);
        await _db.AsAppAsync(new ScopeState(null, null, true), async (c, tx) =>
        {
            await using var cmd = new NpgsqlCommand("DELETE FROM teas.companies", c, tx);
            Assert.Equal(1, await cmd.ExecuteNonQueryAsync());
            return 0;
        }, commit: true);
        await AsMigrator("ANALYZE teas.companies");   // refresh n_live_tup deterministically
        await StartupGuards.RunAsync(_db.AppCs);
    }

    [Fact]
    public async Task WrongSchemaIsRefused()
    {
        await AsMigrator("INSERT INTO teas.\"__EFMigrationsHistory\" (\"MigrationId\", \"ProductVersion\") VALUES ('9999_from_the_future', '10.0.0')");
        var e = await Assert.ThrowsAsync<StartupGuardException>(() => StartupGuards.RunAsync(_db.AppCs));
        Assert.Contains("schema", e.Message);
    }

    [Fact]
    public async Task TableWithoutForcedRlsIsRefused()
    {
        await AsMigrator("ALTER TABLE teas.audit_log NO FORCE ROW LEVEL SECURITY");
        var e = await Assert.ThrowsAsync<StartupGuardException>(() => StartupGuards.RunAsync(_db.AppCs));
        Assert.Contains("audit_log", e.Message);
    }

    [Fact]
    public async Task FailedRlsSelfTestIsRefused()
    {
        var a = Guid.NewGuid();
        await _db.AsAppAsync(new ScopeState(a, null, false), async (c, tx) =>
        {
            await TenantRowFactory.Inserts["companies"](c, tx, a);
            return 0;
        }, commit: true);
        // forced RLS and a policy are both still there, but the policy leaks: only the count itself can catch this
        await AsMigrator("DROP POLICY tenant_select ON teas.companies; CREATE POLICY tenant_select ON teas.companies FOR SELECT USING (true)");
        var e = await Assert.ThrowsAsync<StartupGuardException>(() => StartupGuards.RunAsync(_db.AppCs));
        Assert.Contains("self-test", e.Message);
    }

    [Fact]
    public async Task ReadyReportsTheSchemaAndAHostOnABrokenDatabaseDoesNotStart()
    {
        using (var f = new WebApplicationFactory<Program>().WithWebHostBuilder(b => b.UseSetting("ConnectionStrings:Teas", _db.AppCs)))
        {
            var res = await f.CreateClient().GetAsync("/health/ready");
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            var body = System.Text.Json.JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement;
            Assert.Equal("ok", body.GetProperty("db").GetString());
            Assert.Equal(TeasDbContext.ExpectedSchema, body.GetProperty("schema").GetString());
            // SP3 8 step 2: the catalog size is what the migrator synced (and printed): the code catalog, row for row
            var catalog = body.GetProperty("catalog");
            Assert.Equal(Teas.Domain.Platform.PermissionCatalog.All.Count, catalog.GetProperty("permissions").GetInt32());
            Assert.Equal(Teas.Domain.Platform.PermissionCatalog.SystemRoles.Sum(r => r.Value.Count), catalog.GetProperty("roleTemplates").GetInt32());
        }
        await AsMigrator("ALTER TABLE teas.audit_log NO FORCE ROW LEVEL SECURITY");
        using var broken = new WebApplicationFactory<Program>().WithWebHostBuilder(b => b.UseSetting("ConnectionStrings:Teas", _db.AppCs));
        Assert.ThrowsAny<Exception>(() => broken.CreateClient());
    }
}

/// <summary>A fact that is skipped, with the reason shown, when the BYPASSRLS probe login does not exist on this server.</summary>
public sealed class RequiresBypassProbeFactAttribute : FactAttribute
{
    public const string Role = "teas_bypass_probe";

    public RequiresBypassProbeFactAttribute()
    {
        try
        {
            var cs = new NpgsqlConnectionStringBuilder(Environment.GetEnvironmentVariable("TEAS_TEST_APP_CS")) { Username = Role, Database = "postgres", Pooling = false }.ToString();
            using var c = new NpgsqlConnection(cs);
            c.Open();
        }
        catch (Exception e) when (e is NpgsqlException or ArgumentException or InvalidOperationException)
        {
            Skip = $"login role {Role} (BYPASSRLS) is absent: CI creates it; locally run: CREATE ROLE {Role} LOGIN BYPASSRLS PASSWORD '<same as teas_app>'";
        }
    }
}
