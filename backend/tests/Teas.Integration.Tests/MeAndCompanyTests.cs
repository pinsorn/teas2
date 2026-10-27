using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;
using Teas.App.Platform;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Companies;
using Teas.App.Platform.Files;
using Teas.App.Platform.Rights;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

/// <summary>Shared by the P8 test classes: a company with an admin who is signed in, custom roles, audit reads.</summary>
static class P8
{
    public static NpgsqlParameter P(string n, object? v) => new(n, v ?? DBNull.Value);

    public static async Task<(Guid company, TestUser admin, string token, Guid member)> AdminAsync(AuthHost h, string name = "บริษัท ทดสอบ จำกัด")
    {
        var company = await h.CreateCompanyAsync(name);
        var admin = await h.CreateUserAsync(name: "Admin " + Guid.NewGuid().ToString("N")[..4]);
        var member = await h.AddMemberAsync(company, admin, "admin", name: admin.Email);
        return (company, admin, await h.LoginAsync(admin), member);
    }

    /// <summary>A signed-in member of the company with the given role (system role id or a custom role id).</summary>
    public static async Task<(TestUser user, string token, Guid member)> MemberAsync(AuthHost h, Guid company, string role, bool login = true)
    {
        var u = await h.CreateUserAsync(name: "Member " + Guid.NewGuid().ToString("N")[..4]);
        var m = await h.AddMemberAsync(company, u, role, name: u.Email);
        return (u, login ? await h.LoginAsync(u) : "", m);
    }

    public static async Task<Guid> RoleAsync(AuthHost h, Guid company, string name, params string[] permissions)
    {
        var id = Guid.NewGuid();
        await h.ExecAsync("INSERT INTO teas.custom_roles (company_id, id, name, permissions) VALUES (@c, @i, @n, @p)", new ScopeState(company, null, false),
            P("c", company), P("i", id), P("n", name), P("p", permissions));
        return id;
    }

    public static Task<long> AuditCount(AuthHost h, Guid company, string command, string result = "ok") =>
        h.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND command = @k AND result = @r", P("c", company), P("k", command), P("r", result));

    /// <summary>Every audit row of the company except the sign-in ones the helpers cause.</summary>
    public static Task<long> AuditAll(AuthHost h, Guid company) => h.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND command NOT LIKE 'auth.%'", P("c", company));

    public static Task<string?> AuditJson(AuthHost h, Guid company, string command, string column) =>
        h.ScalarAsync<string>($"SELECT {column}::text FROM teas.audit_log WHERE company_id = @c AND command = @k AND result = 'ok' ORDER BY id DESC LIMIT 1", P("c", company), P("k", command));

    public static Task<Res> Put(AuthHost h, string path, object body, string token) => h.SendAsync(HttpMethod.Put, path, body, token);
    public static Task<Res> Delete(AuthHost h, string path, string token) => h.SendAsync(HttpMethod.Delete, path, null, token);

    public static string Tin(string first12)
    {
        var sum = first12.Select((d, i) => (d - '0') * (13 - i)).Sum();
        return first12 + ((11 - sum % 11) % 10);
    }

    public static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, .. "IHDR"u8, 1, 2, 3, 4];
    public static string PngUrl(byte extra = 0) => "data:image/png;base64," + Convert.ToBase64String([.. Png, extra]);
}

// SP3 P8 routes 15-19: Me, the company switch, company settings (one version for every section), default notes, CompanyFactory.
public sealed class MeAndCompanyTests(AuthFixture fx) : IClassFixture<AuthFixture>
{
    AuthHost H => fx.Host;
    static NpgsqlParameter P(string n, object? v) => P8.P(n, v);

    // ---------------------------------------------------------------- Me

    [Fact]
    public async Task MeListsEveryActiveMembershipWithTheRoleNameAndTheActiveCompanyRights()
    {
        var a = await H.CreateCompanyAsync("บริษัท เอ จำกัด");      // created first: the sign-in opens it
        var b = await H.CreateCompanyAsync("บริษัท บี จำกัด");
        var gone = await H.CreateCompanyAsync("บริษัท ซี จำกัด");
        var u = await H.CreateUserAsync(name: "สมศรี");
        var cashier = await P8.RoleAsync(H, a, "แคชเชียร์", "party.read", "doc.IV.read", "not.a.code");
        await H.AddMemberAsync(a, u, cashier.ToString());
        await H.AddMemberAsync(b, u, "admin");
        await H.AddMemberAsync(gone, u, "admin", active: false);
        var token = await H.LoginAsync(u);

        var me = await H.Get("/me", token);
        Assert.Equal(HttpStatusCode.OK, me.Status);
        Assert.Equal(u.Id.ToString(), me.Str("userId"));
        Assert.Equal("สมศรี", me.Str("displayName"));
        Assert.Equal(a.ToString(), me.Str("activeCompanyId"));
        Assert.False(me.Json.GetProperty("vatRegistered").GetBoolean());
        Assert.Equal("2026-10-27", me.Str("businessDate"));
        Assert.Equal(["doc.IV.read", "party.read"], me.Json.GetProperty("permissions").EnumerateArray().Select(x => x.GetString()!).Order().ToArray());   // the catalog ∩ the role: an unknown code is never a right
        var ms = me.Json.GetProperty("memberships").EnumerateArray().ToList();
        Assert.Equal(2, ms.Count);   // the deactivated one is not listed
        var ma = ms.Single(x => x.GetProperty("companyId").GetString() == a.ToString());
        Assert.Equal((cashier.ToString(), "แคชเชียร์", "บริษัท เอ จำกัด"), (ma.GetProperty("roleId").GetString(), ma.GetProperty("roleName").GetString(), ma.GetProperty("companyName").GetString()));
        var mb = ms.Single(x => x.GetProperty("companyId").GetString() == b.ToString());
        Assert.Equal(("admin", "ผู้ดูแลระบบ"), (mb.GetProperty("roleId").GetString(), mb.GetProperty("roleName").GetString()));    }

    [Fact]
    public async Task ACustomRoleNameInTheOtherCompanyShowsToo()
    {
        var a = await H.CreateCompanyAsync("A");
        var b = await H.CreateCompanyAsync("B");
        var u = await H.CreateUserAsync();
        await H.AddMemberAsync(a, u, "admin");
        var boss = await P8.RoleAsync(H, b, "หัวหน้าบัญชี", "users.manage");
        await H.AddMemberAsync(b, u, boss.ToString());
        var me = await H.Get("/me", await H.LoginAsync(u));
        var mb = me.Json.GetProperty("memberships").EnumerateArray().Single(x => x.GetProperty("companyId").GetString() == b.ToString());
        Assert.Equal("หัวหน้าบัญชี", mb.GetProperty("roleName").GetString());
    }

    [Fact]
    public async Task MeOfAUserWithoutAnyMembershipHasANullActiveCompanyAndNothingElse()
    {
        var u = await H.CreateUserAsync(name: "Bootstrap");
        var me = await H.Get("/me", await H.LoginAsync(u));
        Assert.Equal(HttpStatusCode.OK, me.Status);
        Assert.Equal(JsonValueKind.Null, me.Json.GetProperty("activeCompanyId").ValueKind);   // present and null, never omitted
        Assert.Empty(me.Json.GetProperty("memberships").EnumerateArray());
        Assert.Empty(me.Json.GetProperty("permissions").EnumerateArray());
        Assert.False(me.Json.GetProperty("vatRegistered").GetBoolean());
        Assert.Equal("2026-10-27", me.Str("businessDate"));
        Assert.Equal((HttpStatusCode.Unauthorized, "auth.unauthenticated"), ((await H.Get("/me")).Status, (await H.Get("/me")).Code));
    }

    // ---------------------------------------------------------------- switch

    [Fact]
    public async Task SwitchingCompanyMovesTheSessionAuditsItAndReturnsTheNewMe()
    {
        var a = await H.CreateCompanyAsync("A");
        var b = await H.CreateCompanyAsync("B");
        var u = await H.CreateUserAsync(name: "Two Hats");
        await H.AddMemberAsync(a, u, "admin");
        await H.AddMemberAsync(b, u, "operator");
        var token = await H.LoginAsync(u);
        Assert.Equal(a.ToString(), (await H.Get("/me", token)).Str("activeCompanyId"));

        var sw = await H.Post("/me/active-company", new { companyId = b }, token);
        Assert.Equal(HttpStatusCode.OK, sw.Status);
        Assert.Equal(b.ToString(), sw.Str("activeCompanyId"));
        Assert.Contains("party.read", sw.Json.GetProperty("permissions").EnumerateArray().Select(x => x.GetString()));   // the operator's rights, not the admin's
        Assert.DoesNotContain("users.manage", sw.Json.GetProperty("permissions").EnumerateArray().Select(x => x.GetString()));
        Assert.Equal(b.ToString(), (await H.Get("/me", token)).Str("activeCompanyId"));   // the session keeps it
        Assert.Equal(b, await H.ScalarAsync<Guid>("SELECT last_company_id FROM teas.users WHERE id = @u", P("u", u.Id)));
        Assert.Equal(1, await P8.AuditCount(H, b, "company.switch"));   // in the company switched TO
        Assert.Equal(0, await P8.AuditCount(H, a, "company.switch"));
        var after = await P8.AuditJson(H, b, "company.switch", "after");
        Assert.Contains(b.ToString(), after);
        Assert.Equal((HttpStatusCode.Forbidden, "auth.forbidden"), ((await H.Get("/settings/users", token)).Status, (await H.Get("/settings/users", token)).Code));   // B's operator may not
    }

    [Fact]
    public async Task SwitchingToACompanyYouAreNotAnActiveMemberOfIsTheOne404AndWritesNothing()
    {
        var a = await H.CreateCompanyAsync("A");
        var stranger = await H.CreateCompanyAsync("Stranger");
        var left = await H.CreateCompanyAsync("Left");
        var invited = await H.CreateCompanyAsync("Invited");
        var u = await H.CreateUserAsync();
        await H.AddMemberAsync(a, u, "admin");
        await H.AddMemberAsync(left, u, "admin", active: false);
        await H.AddMemberAsync(invited, null, "admin", pending: true, email: u.Email);
        var token = await H.LoginAsync(u);
        var before = await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE command = 'company.switch'");
        foreach (var target in new object[] { stranger, left, invited, Guid.NewGuid(), "not-a-guid", "" })
        {
            var r = await H.Post("/me/active-company", new { companyId = target }, token);
            Assert.Equal((HttpStatusCode.NotFound, "company.not_found"), (r.Status, r.Code));
        }
        Assert.Equal(a.ToString(), (await H.Get("/me", token)).Str("activeCompanyId"));
        Assert.Equal(before, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE command = 'company.switch'"));
    }

    [Fact]
    public async Task ASessionWhoseCompanyWasLostStillSeesItsOtherMembershipsAndCanSwitch()
    {
        var a = await H.CreateCompanyAsync("A");
        var b = await H.CreateCompanyAsync("B");
        var u = await H.CreateUserAsync();
        var ma = await H.AddMemberAsync(a, u, "admin");
        await H.AddMemberAsync(b, u, "accountant");
        var token = await H.LoginAsync(u);
        await H.ExecAsync("UPDATE teas.company_members SET active = false, version = version + 1 WHERE company_id = @c AND id = @m", new ScopeState(a, null, false), P("c", a), P("m", ma));

        var me = await H.Get("/me", token);   // no company scope at all for this session
        Assert.Equal(JsonValueKind.Null, me.Json.GetProperty("activeCompanyId").ValueKind);
        Assert.Equal([b.ToString()], me.Json.GetProperty("memberships").EnumerateArray().Select(x => x.GetProperty("companyId").GetString()!).ToArray());
        Assert.Empty(me.Json.GetProperty("permissions").EnumerateArray());
        Assert.Equal(HttpStatusCode.Forbidden, (await H.Get("/settings/default-notes", token)).Status);   // "any member" of NO company
        var sw = await H.Post("/me/active-company", new { companyId = b }, token);
        Assert.Equal((HttpStatusCode.OK, b.ToString()), (sw.Status, sw.Str("activeCompanyId")));
        Assert.Equal(1, await P8.AuditCount(H, b, "company.switch"));
    }

    // ---------------------------------------------------------------- CompanyFactory

    [Fact]
    public async Task CompanyFactoryInsertsTheCompanyAndItsAdminMemberInOneTransaction()
    {
        var admin = await H.CreateUserAsync(name: "Founder");
        await using var sc = H.Factory.Services.CreateAsyncScope();
        var id = await sc.ServiceProvider.GetRequiredService<CompanyFactory>().CreateAsync("บริษัท ใหม่ จำกัด", admin.Id, taxId: P8.Tin("010555111111"), vatRegistered: true);

        Assert.Equal("บริษัท ใหม่ จำกัด", await H.ScalarAsync<string>("SELECT name FROM teas.companies WHERE id = @c", P("c", id)));
        Assert.True(await H.ScalarAsync<bool>("SELECT vat_registered FROM teas.companies WHERE id = @c", P("c", id)));
        Assert.Equal(1, await H.ScalarAsync<long>(
            "SELECT count(*) FROM teas.company_members WHERE company_id = @c AND user_id = @u AND role_id = 'admin' AND active AND NOT invite_pending AND email = @e", P("c", id), P("u", admin.Id), P("e", admin.Email)));
        // and the founder can use it at once
        var token = await H.LoginAsync(admin);
        Assert.Equal(id.ToString(), (await H.Get("/me", token)).Str("activeCompanyId"));
        Assert.Equal(HttpStatusCode.OK, (await H.Get($"/settings/companies/{id}", token)).Status);
        // an unknown admin makes the whole thing fail: no half-made company
        var before = await H.ScalarAsync<long>("SELECT count(*) FROM teas.companies");
        await Assert.ThrowsAnyAsync<Exception>(() => sc.ServiceProvider.GetRequiredService<CompanyFactory>().CreateAsync("ไม่ควรมี", Guid.NewGuid()));
        Assert.Equal(before, await H.ScalarAsync<long>("SELECT count(*) FROM teas.companies"));
    }

    // ---------------------------------------------------------------- settings

    async Task<(Guid company, string token)> SettingsAsync()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        return (company, token);
    }

    [Fact]
    public async Task OnlySettingsManageReadsAndAnotherCompanysIdIsA404EvenForItsMember()
    {
        var (company, _, token, _) = await P8.AdminAsync(H, "บริษัท ก จำกัด");
        var other = await H.CreateCompanyAsync("บริษัท ข จำกัด");
        var me = await H.CreateUserAsync();
        await H.AddMemberAsync(company, me, "operator");
        var user = await H.LoginAsync(me);
        var admin = await H.ScalarAsync<Guid>("SELECT user_id FROM teas.company_members WHERE company_id = @c AND role_id = 'admin'", P("c", company));
        await H.AddMemberAsync(other, new TestUser(admin, "", ""), "admin", email: "x-" + Guid.NewGuid().ToString("N") + "@example.test");   // the admin is a member of BOTH

        var ok = await H.Get($"/settings/companies/{company}", token);
        Assert.Equal(HttpStatusCode.OK, ok.Status);
        Assert.Equal("บริษัท ก จำกัด", ok.Str("legalNameTh"));
        Assert.Equal(company.ToString(), ok.Str("id"));
        Assert.False(ok.Json.GetProperty("fiscalYearLocked").GetBoolean());
        Assert.Equal(1, ok.Json.GetProperty("fiscalYearStartMonth").GetInt32());
        Assert.Equal(1, ok.Json.GetProperty("version").GetInt32());
        Assert.False(ok.Json.TryGetProperty("logoDataUrl", out _));   // omitted, not null
        Assert.Equal(("company.not_found", HttpStatusCode.NotFound), ((await H.Get($"/settings/companies/{other}", token)).Code, (await H.Get($"/settings/companies/{other}", token)).Status));
        var put = await P8.Put(H, $"/settings/companies/{other}/contact", new { version = 1, phone = "02" }, token);
        Assert.Equal("company.not_found", put.Code);
        Assert.Equal("auth.forbidden", (await H.Get($"/settings/companies/{company}", user)).Code);   // an operator
        Assert.Equal("company.not_found", (await H.Get($"/settings/companies/{Guid.NewGuid()}", token)).Code);
        Assert.Equal("company.not_found", (await H.Get("/settings/companies/not-a-guid", token)).Code);
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.companies WHERE id = @c AND phone IS NOT NULL", P("c", other)));
    }

    [Fact]
    public async Task IdentityNeedsConfirmAValidTinAndNeverChangesTheVatStatus()
    {
        var (company, token) = await SettingsAsync();
        var path = $"/settings/companies/{company}/identity";
        var body = new { version = 1, confirm = true, legalNameTh = "บริษัท ใหม่ จำกัด", legalNameEn = "New Co", taxId = P8.Tin("010555123456"), branchCode = "00000", registrationNo = "0105551234567", address = "99 ถนนตัวอย่าง", paidUpCapital = "1000000.00" };

        var noConfirm = await P8.Put(H, path, new { body.version, confirm = false, body.legalNameTh, body.taxId, body.branchCode, body.address }, token);
        Assert.Equal((HttpStatusCode.UnprocessableEntity, "company.confirm_required"), (noConfirm.Status, noConfirm.Code));
        var vat = await P8.Put(H, path, new { body.version, confirm = true, body.legalNameTh, body.taxId, body.branchCode, body.address, vatRegistered = true }, token);
        Assert.Equal((HttpStatusCode.UnprocessableEntity, "company.vat_readonly"), (vat.Status, vat.Code));
        var badTin = await P8.Put(H, path, new { body.version, confirm = true, body.legalNameTh, taxId = "1234567890123", body.branchCode, body.address }, token);
        Assert.Equal("record.invalid", badTin.Code);
        Assert.Contains("taxId", badTin.Json.GetProperty("fieldErrors").EnumerateObject().Select(x => x.Name));
        var blank = await P8.Put(H, path, new { body.version, confirm = true, legalNameTh = " ", body.taxId, branchCode = "1", address = "" }, token);
        Assert.Equal(["legalNameTh", "branchCode", "address"], blank.Json.GetProperty("fieldErrors").EnumerateObject().Select(x => x.Name).ToArray());
        Assert.Equal(0, await P8.AuditAll(H, company));   // refusals write nothing
        Assert.Equal(1, await H.ScalarAsync<int>("SELECT version FROM teas.companies WHERE id = @c", P("c", company)));

        var ok = await P8.Put(H, path, body, token);
        Assert.Equal(HttpStatusCode.OK, ok.Status);
        Assert.Equal(("บริษัท ใหม่ จำกัด", "New Co", "1000000.00", 2), (ok.Str("legalNameTh"), ok.Str("legalNameEn"), ok.Str("paidUpCapital"), ok.Json.GetProperty("version").GetInt32()));
        Assert.Equal("บริษัท ใหม่ จำกัด", await H.ScalarAsync<string>("SELECT name FROM teas.companies WHERE id = @c", P("c", company)));   // the switcher / links read name
        Assert.False(ok.Json.GetProperty("vatRegistered").GetBoolean());
        Assert.Equal(1, await P8.AuditCount(H, company, "company.update.identity"));
        var (before, after) = (await P8.AuditJson(H, company, "company.update.identity", "before"), await P8.AuditJson(H, company, "company.update.identity", "after"));
        Assert.Contains("บริษัท ใหม่ จำกัด", after);
        Assert.DoesNotContain("บริษัท ใหม่ จำกัด", before);
        Assert.Equal((HttpStatusCode.NotFound, "company.section_unknown"), ((await P8.Put(H, $"/settings/companies/{company}/vat", new { version = 2 }, token)).Status, (await P8.Put(H, $"/settings/companies/{company}/vat", new { version = 2 }, token)).Code));
    }

    [Fact]
    public async Task ContactPayrollFiscalAndNotesSectionsValidateAndShareOneVersion()
    {
        var (company, token) = await SettingsAsync();
        string Path(string s) => $"/settings/companies/{company}/{s}";

        Assert.Equal("record.invalid", (await P8.Put(H, Path("contact"), new { version = 1, email = "nope" }, token)).Code);
        Assert.Equal("record.invalid", (await P8.Put(H, Path("contact"), new { version = 1, website = "ftp://x" }, token)).Code);
        var contact = await P8.Put(H, Path("contact"), new { version = 1, tradeName = "ร้านเรา", phone = "02-123", email = "a@b.co", website = "https://b.co" }, token);
        Assert.Equal((2, "ร้านเรา", "02-123"), (contact.Json.GetProperty("version").GetInt32(), contact.Str("tradeName"), contact.Str("phone")));

        // the next section must carry the NEW version: one companies.version for every section
        var stale = await P8.Put(H, Path("payroll"), new { version = 1, ssoEmployerAccountNo = "1234567890" }, token);
        Assert.Equal((HttpStatusCode.Conflict, "record.version_conflict"), (stale.Status, stale.Code));
        Assert.Equal("record.invalid", (await P8.Put(H, Path("payroll"), new { version = 2, ssoEmployerAccountNo = "12" }, token)).Code);
        var payroll = await P8.Put(H, Path("payroll"), new { version = 2, ssoEmployerAccountNo = "1234567890" }, token);
        Assert.Equal((3, "1234567890"), (payroll.Json.GetProperty("version").GetInt32(), payroll.Str("ssoEmployerAccountNo")));
        var cleared = await P8.Put(H, Path("contact"), new { version = 3, tradeName = "" }, token);   // an empty text clears; an untouched member is cleared too (a section save replaces the section)
        Assert.False(cleared.Json.TryGetProperty("tradeName", out _));

        Assert.Equal("record.invalid", (await P8.Put(H, Path("fiscal"), new { version = 4, fiscalYearStartMonth = 13 }, token)).Code);
        var unsupported = await P8.Put(H, Path("fiscal"), new { version = 4, fiscalYearStartMonth = 4 }, token);
        Assert.Equal((HttpStatusCode.UnprocessableEntity, "company.fiscal_year_unsupported"), (unsupported.Status, unsupported.Code));
        var same = await P8.Put(H, Path("fiscal"), new { version = 4, fiscalYearStartMonth = 1 }, token);   // nothing to change: no bump, no audit
        Assert.Equal((HttpStatusCode.OK, 4), (same.Status, same.Json.GetProperty("version").GetInt32()));
        Assert.Equal(0, await P8.AuditCount(H, company, "company.update.fiscal"));

        Assert.Equal("record.invalid", (await P8.Put(H, Path("notes"), new { version = 4, defaultNotes = new Dictionary<string, string> { ["WT"] = "x" } }, token)).Code);   // no note on a certificate
        Assert.Equal("record.invalid", (await P8.Put(H, Path("notes"), new { version = 4, defaultNotes = new Dictionary<string, string> { ["IV"] = new string('x', 1001) } }, token)).Code);
        var notes = await P8.Put(H, Path("notes"), new { version = 4, defaultNotes = new Dictionary<string, string> { ["IV"] = "ขอบคุณ", ["QT"] = "ราคาไม่รวม VAT" } }, token);
        Assert.True(notes.Status == HttpStatusCode.OK, notes.Raw);
        Assert.Equal("ขอบคุณ", notes.Json.GetProperty("defaultNotes").GetProperty("IV").GetString());
        var dn = await H.Get("/settings/default-notes", token);
        Assert.Equal((HttpStatusCode.OK, "ขอบคุณ", "ราคาไม่รวม VAT"), (dn.Status, dn.Str("IV"), dn.Str("QT")));
        var cleared2 = await P8.Put(H, Path("notes"), new { version = 5, defaultNotes = new Dictionary<string, string> { ["IV"] = " " } }, token);   // blank removes that type only
        Assert.False(cleared2.Json.GetProperty("defaultNotes").TryGetProperty("IV", out _));
        Assert.Equal("ราคาไม่รวม VAT", cleared2.Json.GetProperty("defaultNotes").GetProperty("QT").GetString());

        foreach (var (cmd, n) in new[] { ("company.update.contact", 2), ("company.update.payroll", 1), ("company.update.notes", 2) })
            Assert.Equal(n, await P8.AuditCount(H, company, cmd));
        Assert.Equal(5, await P8.AuditAll(H, company));   // exactly the successful saves: contact x2, payroll, notes x2
    }

    [Fact]
    public async Task ImagesAreStoredAsFilesReturnedAsDataUrlsAndNeverEnterTheAudit()
    {
        var (company, token) = await SettingsAsync();
        var path = $"/settings/companies/{company}/images";
        var url = P8.PngUrl();

        foreach (var bad in new[] { "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "data:image/png;base64,PHN2Zz48L3N2Zz4=", "data:image/png;base64,@@@", "not a url", "data:image/png;base64," + Convert.ToBase64String(new byte[1_048_577]) })
        {
            var r = await P8.Put(H, path, new { version = 1, logoDataUrl = bad }, token);
            Assert.Equal((HttpStatusCode.UnprocessableEntity, "record.invalid"), (r.Status, r.Code));
            Assert.Contains("logoDataUrl", r.Json.GetProperty("fieldErrors").EnumerateObject().Select(x => x.Name));
        }
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.files WHERE company_id = @c", P("c", company)));

        var set = await P8.Put(H, path, new { version = 1, logoDataUrl = url, stampDataUrl = P8.PngUrl(7) }, token);
        Assert.Equal(HttpStatusCode.OK, set.Status);
        Assert.Equal(url, set.Str("logoDataUrl"));
        Assert.Equal(P8.PngUrl(7), set.Str("stampDataUrl"));
        Assert.Equal(2, await H.ScalarAsync<long>("SELECT count(*) FROM teas.files WHERE company_id = @c", P("c", company)));
        Assert.Equal(url, (await H.Get($"/settings/companies/{company}", token)).Str("logoDataUrl"));

        var keep = await P8.Put(H, path, new { version = 2, stampDataUrl = (string?)null }, token);   // logo absent = keep, stamp null = remove
        Assert.Equal(url, keep.Str("logoDataUrl"));
        Assert.False(keep.Json.TryGetProperty("stampDataUrl", out _));
        var empty = await P8.Put(H, path, new { version = 3, logoDataUrl = "" }, token);
        Assert.False(empty.Json.TryGetProperty("logoDataUrl", out _));

        var trail = await H.ScalarAsync<string>("SELECT string_agg(coalesce(before::text, '') || coalesce(after::text, ''), ' ') FROM teas.audit_log WHERE company_id = @c AND command = 'company.update.images'", P("c", company));
        Assert.DoesNotContain("base64", trail);
        Assert.DoesNotContain("data:", trail);
        Assert.Contains("\"set\"", trail);   // a picture is only set / none in the trail
        Assert.Contains("\"none\"", trail);
        Assert.Equal(3, await P8.AuditCount(H, company, "company.update.images"));
    }

    /// <summary>A file store whose Put waits for the twin request: both saves have then read the same version and meet right before the guarded UPDATE.</summary>
    sealed class GatedStore(IFileStore inner, AsyncBarrier barrier) : IFileStore
    {
        public async Task<FileRef> PutAsync(Guid companyId, Stream content, string name, CancellationToken ct = default)
        {
            await barrier.ArriveAsync();
            return await inner.PutAsync(companyId, content, name, ct);
        }

        public Task<OpenedFile> OpenAsync(Guid companyId, Guid id, CancellationToken ct = default) => inner.OpenAsync(companyId, id, ct);
    }

    [Fact]
    public async Task S17TwoConcurrentSectionSavesAtTheSameVersionGiveExactlyOne200AndOne409()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var barrier = new AsyncBarrier(2);
        await using var factory = H.Factory.WithWebHostBuilder(b => b.ConfigureTestServices(s =>
        {
            s.RemoveAll<IFileStore>();
            s.AddScoped<IFileStore>(sp => new GatedStore(ActivatorUtilities.CreateInstance<FileStore>(sp), barrier));
        }));
        using var client = factory.CreateClient();
        Task<HttpResponseMessage> Save(byte tag) => client.SendAsync(new HttpRequestMessage(HttpMethod.Put, $"/internal/v1/settings/companies/{company}/images")
        {
            Content = JsonContent.Create(new { version = 1, logoDataUrl = P8.PngUrl(tag) }),
            Headers = { { "Cookie", $"{AuthHost.CookieName}={token}" } },
        });

        var results = await Task.WhenAll(Save(1), Save(2));
        Assert.Equal([HttpStatusCode.OK, HttpStatusCode.Conflict], results.Select(r => r.StatusCode).Order().ToArray());
        Assert.Equal(2, await H.ScalarAsync<int>("SELECT version FROM teas.companies WHERE id = @c", P("c", company)));
        Assert.Equal(1, await P8.AuditCount(H, company, "company.update.images"));   // the loser rolled back whole
    }

    // ---------------------------------------------------------------- agents

    sealed class AgentHook : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use(async (http, go) =>
            {
                if (!http.Request.Headers.TryGetValue("x-test-agent", out var v)) { await go(); return; }
                var parts = v.ToString().Split(',');   // owner user id, company id
                var sp = http.RequestServices;
                var audit = sp.GetRequiredService<AuditContext>();
                audit.Actor = new AuditActor("agent", Guid.NewGuid().ToString(), "Agent", parts[0], "Owner");
                audit.Client = "api";
                sp.GetRequiredService<ActorScopes>().Values = ["party.read"];
                using var _ = sp.GetRequiredService<TenantScope>().Enter(Guid.Parse(parts[1]), Guid.Parse(parts[0]));
                await go();
            });
            next(app);
        };
    }

    [Fact]
    public async Task AnAgentIsRefusedOnEverySettingsRouteBeforeTheBodyIsReadAndOneRejectedRowIsWritten()
    {
        var (company, admin, _, _) = await P8.AdminAsync(H);
        await using var factory = H.Factory.WithWebHostBuilder(b => b.ConfigureServices(s => s.AddSingleton<IStartupFilter>(new AgentHook())));
        using var client = factory.CreateClient();
        async Task<Res> As(HttpMethod m, string path, string rawBody)
        {
            using var req = new HttpRequestMessage(m, "/internal/v1" + path) { Content = new StringContent(rawBody, System.Text.Encoding.UTF8, "application/json") };
            req.Headers.Add("x-test-agent", $"{admin.Id},{company}");
            using var res = await client.SendAsync(req);
            return new Res(res, await res.Content.ReadAsStringAsync());
        }

        var calls = new (HttpMethod, string)[]
        {
            (HttpMethod.Put, $"/settings/companies/{company}/identity"), (HttpMethod.Post, "/settings/users"), (HttpMethod.Put, $"/settings/users/{Guid.NewGuid()}"),
            (HttpMethod.Post, $"/settings/users/{Guid.NewGuid()}/active"), (HttpMethod.Post, $"/settings/users/{Guid.NewGuid()}/reset-link"),
            (HttpMethod.Post, $"/settings/users/{Guid.NewGuid()}/totp-reset"), (HttpMethod.Post, "/settings/roles"), (HttpMethod.Put, $"/settings/roles/{Guid.NewGuid()}"),
            (HttpMethod.Delete, $"/settings/roles/{Guid.NewGuid()}?version=1"), (HttpMethod.Get, "/settings/users"), (HttpMethod.Get, "/settings/roles"), (HttpMethod.Get, $"/settings/companies/{company}"),
        };
        foreach (var (method, path) in calls)
        {
            var r = await As(method, path, "{ this is not json");
            Assert.True((HttpStatusCode.Forbidden, "agent.forbidden_setting") == (r.Status, r.Code), $"{method} {path}: {r.Status} {r.Raw}");   // 403, never the 422 of a bad body
        }
        Assert.Equal(calls.Length, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND result = 'rejected' AND actor_kind = 'agent'", P("c", company)));
        Assert.Equal(0, await P8.AuditCount(H, company, "company.update.identity"));
        // outside /settings the code is the action one; the GET default-notes route is an agent route and is allowed
        Assert.Equal("agent.forbidden_action", (await As(HttpMethod.Get, "/me", "")).Code);
        Assert.Equal("agent.forbidden_action", (await As(HttpMethod.Post, "/me/active-company", "{")).Code);
        Assert.Equal(HttpStatusCode.OK, (await As(HttpMethod.Get, "/settings/default-notes", "")).Status);
    }

    [Fact]
    public async Task DefaultNotesAreReadableByAnyActiveMemberButNotByASignedOutCaller()
    {
        var (company, _, _, _) = await P8.AdminAsync(H);
        var (_, op, _) = await P8.MemberAsync(H, company, "operator");
        var r = await H.Get("/settings/default-notes", op);
        Assert.Equal(HttpStatusCode.OK, r.Status);
        Assert.Equal("{}", r.Raw);
        Assert.Equal(HttpStatusCode.Unauthorized, (await H.Get("/settings/default-notes")).Status);
    }
}
