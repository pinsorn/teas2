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
        while (await r.ReadAsync()) if (!allow.Contains("teas." + r.GetString(0))) names.Add(r.GetString(0));
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
        Assert.Equal(["teas.zz_throwaway"], await StartupGuards.UnprotectedTablesAsync(app, allow));

        var existing = (await StartupGuards.ScanAsync(app)).Select(r => r.Qualified).ToHashSet();
        foreach (var n in allow) Assert.Contains(n, existing);
    }

    // M4: tables outside schema teas and materialized views (which cannot have RLS) are refused unless allow-listed.
    [Fact]
    public async Task AllowList_FlagsOtherSchemasAndMaterializedViews()
    {
        var allow = RlsAllowList.Parse(File.ReadAllLines(AllowListPath()));
        await using var m = await _db.OpenMigratorAsync();
        foreach (var sql in new[] { "CREATE SCHEMA extra", "CREATE TABLE extra.t (id int)", "CREATE MATERIALIZED VIEW teas.mv AS SELECT 1 AS x" })
            await using (var cmd = new NpgsqlCommand(sql, m)) await cmd.ExecuteNonQueryAsync();
        Assert.Equal(["extra.t", "teas.mv"], await StartupGuards.UnprotectedTablesAsync(m, allow));
    }

    // M3: the two exception policies. user X is a member of B; the session is company A with user X.
    async Task<(Guid a, Guid b, Guid x, Guid y)> TwoCompaniesWithMembersAsync()
    {
        Guid a = Guid.NewGuid(), b = Guid.NewGuid();
        foreach (var company in new[] { a, b })
            await _db.AsAppAsync(In(company), Insert("companies", company), commit: true);
        async Task<Guid> User(string email) => await _db.AsAppAsync(ScopeState.None, async (c, tx) =>
        {
            await using var cmd = new NpgsqlCommand("INSERT INTO teas.users (email, display_name) VALUES (@e, 'U') RETURNING id", c, tx);
            cmd.Parameters.AddWithValue("e", email);
            return (Guid)(await cmd.ExecuteScalarAsync())!;
        }, commit: true);
        Guid x = await User($"x-{a}@example.test"), y = await User($"y-{a}@example.test");
        foreach (var (company, user) in new[] { (b, x), (b, y), (a, y) })
            await _db.AsAppAsync(In(company), (c, tx) => Sql(c, tx,
                "INSERT INTO teas.company_members (company_id, user_id, email, name, role_id) SELECT @c, @u, email, 'M', 'admin' FROM teas.users WHERE id = @u", ("c", company), ("u", user)), commit: true);
        return (a, b, x, y);
    }

    static async Task<int> Sql(NpgsqlConnection c, NpgsqlTransaction tx, string sql, params (string, object)[] ps)
    {
        await using var cmd = new NpgsqlCommand(sql, c, tx);
        foreach (var (n, v) in ps) cmd.Parameters.AddWithValue(n, v);
        return await cmd.ExecuteNonQueryAsync();
    }

    [Fact]
    public async Task M3_OwnMembershipInAnotherCompanyIsVisibleButOnlyThat()
    {
        var (a, b, x, _) = await TwoCompaniesWithMembersAsync();
        var asXInA = new ScopeState(a, x, false);
        Assert.Equal(1, await _db.AsAppAsync(asXInA, (c, tx) => CountAsync(c, tx, "company_members", "company_id = @k", b)));   // X's own row in B, not Y's
        Assert.Equal(1, await _db.AsAppAsync(asXInA, (c, tx) => CountAsync(c, tx, "company_members", "company_id = @k AND user_id = '" + x + "'", b)));
        Assert.Equal(2, await _db.AsAppAsync(asXInA, (c, tx) => CountAsync(c, tx, "company_members")));   // A's own row (Y) + X's row in B; B's Y stays hidden
    }

    [Fact]
    public async Task M3_CompanyBIsVisibleOnlyWhileTheMembershipIsActiveAndAccepted()
    {
        var (a, b, x, _) = await TwoCompaniesWithMembersAsync();
        var asXInA = new ScopeState(a, x, false);
        Task<long> BVisible() => _db.AsAppAsync(asXInA, (c, tx) => CountAsync(c, tx, "companies", "id = @k", b));
        Assert.Equal(1, await BVisible());

        await _db.AsAppAsync(In(b), (c, tx) => Sql(c, tx, "UPDATE teas.company_members SET invite_pending = true WHERE user_id = @u", ("u", x)), commit: true);
        Assert.Equal(0, await BVisible());   // pending invitee
        await _db.AsAppAsync(In(b), (c, tx) => Sql(c, tx, "UPDATE teas.company_members SET invite_pending = false, active = false WHERE user_id = @u", ("u", x)), commit: true);
        Assert.Equal(0, await BVisible());   // deactivated
        await _db.AsAppAsync(In(b), (c, tx) => Sql(c, tx, "UPDATE teas.company_members SET active = true WHERE user_id = @u", ("u", x)), commit: true);
        Assert.Equal(1, await BVisible());
    }

    // M2: what a session may SEE through the widened SELECT it may not UPDATE or DELETE (reviewer's probe: own membership in B under A).
    [Fact]
    public async Task M2_UpdateAndDeleteOfAnotherCompanysRowsAffectNothing()
    {
        var (a, b, x, _) = await TwoCompaniesWithMembersAsync();
        var asXInA = new ScopeState(a, x, false);
        Assert.Equal(0, await _db.AsAppAsync(asXInA, (c, tx) => Sql(c, tx, "DELETE FROM teas.company_members WHERE user_id = @u AND company_id = @b", ("u", x), ("b", b))));
        Assert.Equal(0, await _db.AsAppAsync(asXInA, (c, tx) => Sql(c, tx, "UPDATE teas.company_members SET name = 'hacked' WHERE company_id = @b", ("b", b))));
        Assert.Equal(0, await _db.AsAppAsync(asXInA, (c, tx) => Sql(c, tx, "UPDATE teas.companies SET name = 'hacked' WHERE id = @b", ("b", b))));
        Assert.Equal(0, await _db.AsAppAsync(asXInA, (c, tx) => Sql(c, tx, "DELETE FROM teas.companies WHERE id = @b", ("b", b))));
        // and the rows are intact (company B sees its own, X still visible in B's list)
        Assert.Equal(2, await _db.AsAppAsync(In(b), (c, tx) => CountAsync(c, tx, "company_members")));
        Assert.Equal(1, await _db.AsAppAsync(In(b), (c, tx) => CountAsync(c, tx, "companies", "name NOT LIKE 'hacked'")));
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

    // H1: Enter / EnterSystem while a transaction is already open reach the database at once; disposing restores the outer state.
    [Fact]
    public async Task H1_ScopeChangeInsideAnOpenTransactionReachesTheDatabase()
    {
        Guid a = Guid.NewGuid(), b = Guid.NewGuid();
        foreach (var company in new[] { a, b })
            await _db.AsAppAsync(In(company), Insert("companies", company), commit: true);
        var scope = new TenantScope();
        var options = new DbContextOptionsBuilder<TeasDbContext>();
        TeasDbContext.Configure(options, _db.AppCs);
        options.AddInterceptors(new TenantInterceptor(scope));
        await using var ctx = new TeasDbContext(options.Options);
        async Task<long> Count() => (await ctx.Database.SqlQueryRaw<long>("SELECT count(*) AS \"Value\" FROM teas.companies").ToListAsync())[0];

        using (scope.EnterSystem("outer"))
        {
            await using var tx = await ctx.Database.BeginTransactionAsync();
            Assert.Equal(2, await Count());
            using (scope.Enter(a, null)) Assert.Equal(1, await Count());   // narrowed inside the same transaction
            Assert.Equal(2, await Count());                                // dispose: back to the outer system scope
        }
        await using (var tx = await ctx.Database.BeginTransactionAsync())
        {
            Assert.Equal(0, await Count());                                // opened with no scope at all
            using (scope.EnterSystem("key-auth")) Assert.Equal(2, await Count());   // lookup sees rows
            Assert.Equal(0, await Count());                                // dispose: no scope again
        }
    }

    static PostgresException? FindPg(Exception? e) { while (e != null && e is not PostgresException) e = e.InnerException; return e as PostgresException; }

    TeasDbContext NewContext(TenantScope scope)
    {
        var options = new DbContextOptionsBuilder<TeasDbContext>();
        TeasDbContext.Configure(options, _db.AppCs);
        options.AddInterceptors(new TenantInterceptor(scope));
        return new TeasDbContext(options.Options);
    }

    // R2-2a: an error inside a scope must reach the caller as itself, not as the 25P02 of the scope's restore.
    [Fact]
    public async Task R2_ErrorInsideAScopeSurfacesAsItselfNotAsAbortedTransaction()
    {
        var scope = new TenantScope();
        await using var ctx = NewContext(scope);
        await using var tx = await ctx.Database.BeginTransactionAsync();
        var e = await Assert.ThrowsAnyAsync<Exception>(async () =>
        {
            using (scope.Enter(Guid.NewGuid(), null))
                await ctx.Database.SqlQueryRaw<int>("SELECT 1 / 0 AS \"Value\"").ToListAsync();
        });
        Assert.Equal("22012", FindPg(e)?.SqlState);
    }

    // R2-2b: a transaction disposed without commit / rollback must not be touched through a stale reference,
    // even when Npgsql hands the same transaction object to another context.
    [Fact]
    public async Task R2_StaleTransactionIsNeverReappliedToAnotherContext()
    {
        var a = Guid.NewGuid();
        await _db.AsAppAsync(In(a), Insert("companies", a), commit: true);
        var scope1 = new TenantScope();
        await using (var ctx1 = NewContext(scope1))
        {
            await using var tx1 = await ctx1.Database.BeginTransactionAsync();
        }   // disposed, never committed or rolled back explicitly
        var scope2 = new TenantScope();
        await using var ctx2 = NewContext(scope2);
        await using var tx2 = await ctx2.Database.BeginTransactionAsync();
        using (scope1.Enter(a, null))   // must neither throw nor leak company a into the other context's transaction
            Assert.Equal(0, (await ctx2.Database.SqlQueryRaw<long>("SELECT count(*) AS \"Value\" FROM teas.companies").ToListAsync())[0]);
    }

    // N2
    [Fact]
    public void N2_ScopesDisposedOutOfOrderThrow()
    {
        var scope = new TenantScope();
        var outer = scope.Enter(Guid.NewGuid(), null);
        var inner = scope.EnterSystem("inner");
        Assert.Throws<InvalidOperationException>(() => outer.Dispose());
        inner.Dispose();
        outer.Dispose();
    }
}
