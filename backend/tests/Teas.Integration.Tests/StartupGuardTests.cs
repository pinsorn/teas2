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

    // The harness cannot create a BYPASSRLS login (needs a superuser), so it points the SAME check at the cluster's
    // superuser role: a role with rolsuper OR rolbypassrls is refused whatever the connection.
    [Fact]
    public async Task SuperuserOrBypassRlsRoleIsRefused()
    {
        await using var c = await _db.OpenAppAsync();
        await using var cmd = new NpgsqlCommand("SELECT rolname FROM pg_roles WHERE rolsuper OR rolbypassrls LIMIT 1", c);
        var role = (string)(await cmd.ExecuteScalarAsync())!;
        var e = await Assert.ThrowsAsync<StartupGuardException>(() => StartupGuards.RunAsync(_db.AppCs, role));
        Assert.Contains("BYPASSRLS", e.Message);
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
        await AsMigrator("DROP POLICY tenant ON teas.companies; CREATE POLICY tenant ON teas.companies USING (true)");
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
            Assert.Contains(TeasDbContext.ExpectedSchema, await res.Content.ReadAsStringAsync());
        }
        await AsMigrator("ALTER TABLE teas.audit_log NO FORCE ROW LEVEL SECURITY");
        using var broken = new WebApplicationFactory<Program>().WithWebHostBuilder(b => b.UseSetting("ConnectionStrings:Teas", _db.AppCs));
        Assert.ThrowsAny<Exception>(() => broken.CreateClient());
    }
}
