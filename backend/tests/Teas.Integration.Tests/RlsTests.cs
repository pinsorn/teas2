using Microsoft.EntityFrameworkCore;
using Npgsql;
using Teas.Api.Startup;
using Teas.App;
using Teas.App.Platform;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

public sealed class RlsTests : IAsyncLifetime
{
    DbClone _db = null!;
    public async Task InitializeAsync() => _db = await TestDb.CloneAsync();
    public async Task DisposeAsync() => await _db.DisposeAsync();

    static ScopeState In(Guid company) => new(company, null, false);
    static readonly ScopeState System = new(null, null, true);

    static Func<NpgsqlConnection, NpgsqlTransaction, Task<int>> Insert(string table, Guid company) =>
        async (c, tx) => { await TenantRowFactory.Inserts[table](c, tx, company); return 0; };

    async Task<List<string>> TenantTablesAsync()
    {
        await using var c = await _db.OpenAppAsync();
        return await StartupGuardsTables(c);
    }

    // every table in schema teas that is not on the allow-list
    static async Task<List<string>> StartupGuardsTables(NpgsqlConnection c)
    {
        var allow = RlsAllowList.Parse(File.ReadAllLines(AllowListPath()));
        var names = new List<string>();
        await using var cmd = new NpgsqlCommand("SELECT relname FROM pg_class WHERE relnamespace = 'teas'::regnamespace AND relkind IN ('r','p') ORDER BY 1", c);
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync()) if (!allow.Contains(r.GetString(0))) names.Add(r.GetString(0));
        return names;
    }

    public static string AllowListPath()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "global.json"))) d = d.Parent;
        return Path.Combine(d!.FullName, "src", "Teas.Migrator", "rls-allowlist.txt");
    }

    static async Task<long> CountAsync(NpgsqlConnection c, NpgsqlTransaction t, string table, string? where = null, Guid? key = null)
    {
        await using var cmd = new NpgsqlCommand($"SELECT count(*) FROM teas.{table}" + (where is null ? "" : " WHERE " + where), c, t);
        if (key is { } k) cmd.Parameters.AddWithValue("k", k);
        return (long)(await cmd.ExecuteScalarAsync())!;
    }

    // S9: company B's rows are invisible under company A, a write for another company fails WITH CHECK, no GUC reads 0 rows,
    // system scope reads everything but writes nothing. Generated over every non-allow-listed table.
    [Fact]
    public async Task S9_EveryTenantTableIsIsolated()
    {
        var tables = await TenantTablesAsync();
        Assert.Contains("companies", tables);
        var missing = tables.Where(t => !TenantRowFactory.Inserts.ContainsKey(t)).ToList();
        Assert.True(missing.Count == 0, "tenant tables without a TenantRowFactory method: " + string.Join(", ", missing));

        Guid a = Guid.NewGuid(), b = Guid.NewGuid();
        foreach (var company in new[] { a, b })   // companies first (FK target), then every other table
            foreach (var t in tables.OrderBy(x => x == "companies" ? 0 : 1))
                await _db.AsAppAsync(In(company), Insert(t, company), commit: true);

        foreach (var table in tables)
        {
            var key = TenantRowFactory.KeyColumn(table);
            Assert.Equal(1, await _db.AsAppAsync(In(a), (c, tx) => CountAsync(c, tx, table)));
            Assert.Equal(0, await _db.AsAppAsync(In(a), (c, tx) => CountAsync(c, tx, table, $"{key} = @k", b)));
            Assert.Equal(2, await _db.AsAppAsync(System, (c, tx) => CountAsync(c, tx, table)));
            Assert.Equal(0, await _db.AsAppAsync(ScopeState.None, (c, tx) => CountAsync(c, tx, table)));

            var inB = await Assert.ThrowsAsync<PostgresException>(() =>
                _db.AsAppAsync(In(a), Insert(table, b)));
            Assert.True(inB.SqlState == "42501", $"{table}: write for another company gave {inB.SqlState} {inB.MessageText}");

            var asSystem = await Assert.ThrowsAsync<PostgresException>(() =>
                _db.AsAppAsync(System, Insert(table, Guid.NewGuid())));
            Assert.True(asSystem.SqlState == "42501", $"{table}: system scope write gave {asSystem.SqlState}");
        }
    }

    // F2 + F4: the GUC left over (as '') on a pooled connection after a scoped transaction must not break a no-GUC read.
    [Fact]
    public async Task F2_NoGucReadAfterAScopedTransactionOnTheSameConnectionReturnsZeroRowsWithoutError()
    {
        var a = Guid.NewGuid();
        await _db.AsAppAsync(In(a), Insert("companies", a), commit: true);
        await using var conn = await _db.OpenAppAsync();
        await using (var tx = await conn.BeginTransactionAsync())
        {
            await TenantScope.ApplyAsync(conn, tx, In(a));
            Assert.Equal(1, await CountAsync(conn, tx, "companies"));
            await tx.CommitAsync();
        }
        await using (var tx = await conn.BeginTransactionAsync())
            Assert.Equal(0, await CountAsync(conn, tx, "companies"));
        Assert.Equal(0, await CountAsync(conn, null!, "companies"));   // outside any transaction: also nothing, no error
    }

    // The allow-list guard: every table in teas is allow-listed or has forced RLS + a policy.
    [Fact]
    public async Task AllowList_FlagsATableWithoutRlsAndHasNoStaleEntries()
    {
        var allow = RlsAllowList.Parse(File.ReadAllLines(AllowListPath()));
        await using var app = await _db.OpenAppAsync();
        Assert.Empty(await StartupGuards.UnprotectedTablesAsync(app, allow));

        await using (var m = await _db.OpenMigratorAsync())
        await using (var cmd = new NpgsqlCommand("CREATE TABLE teas.zz_throwaway (id int)", m))
            await cmd.ExecuteNonQueryAsync();
        Assert.Equal(["zz_throwaway"], await StartupGuards.UnprotectedTablesAsync(app, allow));

        await using var all = new NpgsqlCommand("SELECT relname FROM pg_class WHERE relnamespace = 'teas'::regnamespace AND relkind = 'r'", app);
        var existing = new HashSet<string>();
        await using (var r = await all.ExecuteReaderAsync()) while (await r.ReadAsync()) existing.Add(r.GetString(0));
        foreach (var n in allow) Assert.Contains(n, existing);
    }

    // F5: FORCE RLS applies to the migrator: a plain UPDATE touches 0 tenant rows; ForEachCompany touches every company's.
    [Fact]
    public async Task F5_ForEachCompanyUpdatesBothCompaniesWhereAPlainMigratorUpdateUpdatesNone()
    {
        Guid a = Guid.NewGuid(), b = Guid.NewGuid();
        foreach (var company in new[] { a, b })
            await _db.AsAppAsync(In(company), Insert("companies", company), commit: true);

        await using var m = await _db.OpenMigratorAsync();
        await using (var plain = new NpgsqlCommand("UPDATE teas.companies SET name = name || '!'", m))
            Assert.Equal(0, await plain.ExecuteNonQueryAsync());

        var total = await TenantScope.ForEachCompanyAsync(m, async (_, tx) =>
        {
            await using var cmd = new NpgsqlCommand("UPDATE teas.companies SET name = name || '!'", m, tx);
            return await cmd.ExecuteNonQueryAsync();
        });
        Assert.Equal(2, total);
        Assert.Equal(2, await _db.AsAppAsync(System, (c, tx) => CountAsync(c, tx, "companies", "name LIKE '%!'")));
    }

    // The EF path: the interceptor applies the scope as the first statement of the transaction.
    [Fact]
    public async Task Interceptor_AppliesTheEnteredScopeToEfTransactions()
    {
        var a = Guid.NewGuid();
        await _db.AsAppAsync(In(a), Insert("companies", a), commit: true);
        var scope = new TenantScope();
        var options = new DbContextOptionsBuilder<TeasDbContext>();
        TeasDbContext.Configure(options, _db.AppCs);
        options.AddInterceptors(new TenantInterceptor(scope));
        await using var ctx = new TeasDbContext(options.Options);

        async Task<long> Visible()
        {
            await using var tx = await ctx.Database.BeginTransactionAsync();
            return (await ctx.Database.SqlQueryRaw<long>("SELECT count(*) AS \"Value\" FROM teas.companies").ToListAsync())[0];
        }
        Assert.Equal(0, await Visible());
        using (scope.Enter(a, null)) Assert.Equal(1, await Visible());
        using (scope.EnterSystem("test")) Assert.Equal(1, await Visible());
        Assert.Equal(0, await Visible());
    }
}
