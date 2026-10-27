using System.Net;
using Npgsql;
using Teas.App.Platform;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// S14 (P4): audit is append-only for everyone, written in the command transaction, and a refused 403 leaves one 'rejected' row.
public sealed class AuditTests : IAsyncLifetime
{
    DbClone _db = null!;
    public async Task InitializeAsync() => _db = await TestDb.CloneAsync();
    public async Task DisposeAsync() => await _db.DisposeAsync();

    public static TheoryData<string, string> Statements() => new()
    {
        { "audit_log", "UPDATE teas.audit_log SET target = 'x'" },
        { "audit_log", "DELETE FROM teas.audit_log" },
        { "audit_log", "TRUNCATE teas.audit_log" },
        { "auth_events", "UPDATE teas.auth_events SET kind = 'x'" },
        { "auth_events", "DELETE FROM teas.auth_events" },
        { "auth_events", "TRUNCATE teas.auth_events" },
    };

    async Task<Guid> SeedAsync()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        await _db.AsAppAsync(new ScopeState(company, null, false), async (c, t) =>
        {
            await TenantRowFactory.Inserts["audit_log"](c, t, company);
            await using var cmd = new NpgsqlCommand("INSERT INTO teas.auth_events (kind) VALUES ('login')", c, t);
            await cmd.ExecuteNonQueryAsync();
            return 0;
        }, commit: true);
        return company;
    }

    static async Task<string> SqlStateOfAsync(NpgsqlConnection c, NpgsqlTransaction t, string sql)
    {
        var e = await Assert.ThrowsAsync<PostgresException>(async () =>
        {
            await using var cmd = new NpgsqlCommand(sql, c, t);
            await cmd.ExecuteNonQueryAsync();
        });
        return e.SqlState;
    }

    [Theory]
    [MemberData(nameof(Statements))]
    public async Task S14_UpdateDeleteTruncateAreRefusedForTheAppRole(string table, string sql)
    {
        var company = await SeedAsync();
        var state = await _db.AsAppAsync(new ScopeState(company, null, false), (c, t) => SqlStateOfAsync(c, t, sql));
        Assert.Equal("42501", state);   // no UPDATE / DELETE / TRUNCATE grant
        Assert.True(await PlatformTestHost.CountAsync(_db, table) >= 1);
    }

    [Theory]
    [MemberData(nameof(Statements))]
    public async Task S14_UpdateDeleteTruncateRaiseForTheOwnerToo(string table, string sql)
    {
        Assert.Contains(table, sql);
        var company = await SeedAsync();
        await using var c = await _db.OpenMigratorAsync();
        await using var tx = await c.BeginTransactionAsync();
        await TenantScope.ApplyAsync(c, tx, new ScopeState(company, null, false));   // FORCE RLS applies to the owner: without the scope no row is visible
        Assert.Equal("23001", await SqlStateOfAsync(c, tx, sql));   // restrict_violation from teas.forbid_modify()
    }

    [Fact]
    public async Task ARefused403WritesOneRejectedRowWithNoBeforeOrAfter()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        using var f = PlatformTestHost.Create(_db);
        var res = await f.CreateClient().PostAsync($"/internal/v1/_t/forbidden/{company}", null);
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "audit_log"));
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "audit_log",
            $"result = 'rejected' AND command = 'test.forbidden' AND before IS NULL AND after IS NULL AND actor_kind = 'user' AND actor_name = 'Tester' AND company_id = '{company}' AND trace_id IS NOT NULL"));
    }
}
