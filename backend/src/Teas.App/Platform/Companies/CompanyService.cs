using System.Text.Json;
using System.Text.RegularExpressions;
using Npgsql;
using NpgsqlTypes;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Auth;
using Teas.App.Platform.Concurrency;
using Teas.App.Platform.Files;
using Teas.App.Platform.Rights;
using Teas.App.Platform.Roles;
using Teas.Domain;
using Teas.Domain.Platform;

namespace Teas.App.Platform.Companies;

// ---- wire types (frozen contract 5.1). Request bodies with an Optional<T> member (images) live in the API layer; the rest are used as they are. ----
public sealed record MembershipView(Guid CompanyId, string CompanyName, string RoleId, string RoleName);

public sealed record MeView(Guid UserId, string DisplayName, IReadOnlyList<MembershipView> Memberships, Guid? ActiveCompanyId, bool VatRegistered, IReadOnlyList<string> Permissions, string BusinessDate);

/// <summary>CompanySettings = Company + fiscalYearLocked. The legal Thai name is stored in companies.name.</summary>
public sealed record CompanySettingsView(Guid Id, string LegalNameTh, string TaxId, string BranchCode, bool VatRegistered, string Address, int FiscalYearStartMonth, bool FiscalYearLocked,
    string? LegalNameEn = null, string? Phone = null, string? SsoEmployerAccountNo = null, string? RegistrationNo = null, string? TradeName = null, string? Email = null,
    string? Website = null, Money? PaidUpCapital = null, string? LogoDataUrl = null, string? StampDataUrl = null, IReadOnlyDictionary<string, string>? DefaultNotes = null, int? Version = null);

public sealed record CompanyIdentityBody(int Version, [property: LiteralTrue] bool Confirm, string LegalNameTh, string TaxId, string BranchCode, string Address,
    string? LegalNameEn = null, string? RegistrationNo = null, Money? PaidUpCapital = null);

public sealed record CompanyContactBody(int Version, string? TradeName = null, string? Phone = null, string? Email = null, string? Website = null);

public sealed record CompanyPayrollBody(int Version, string? SsoEmployerAccountNo = null);

public sealed record CompanyFiscalBody(int Version, int FiscalYearStartMonth);

public sealed record CompanyNotesBody(int Version, IReadOnlyDictionary<string, string> DefaultNotes);

/// <summary>The images section after the wire's Optional&lt;string&gt; is read: not set = keep, set with null / "" = remove, else a data URL.</summary>
public readonly record struct ImageChange(bool IsSet, string? DataUrl);

public sealed record CompanyImagesChange(int Version, ImageChange Logo, ImageChange Stamp);

/// <summary>Images travel as data URLs (png / jpeg / webp, at most 1 MB, never svg) and are stored as files; the type is decided by the bytes (IFileStore), the header only has to be plausible.</summary>
internal static class DataUrls
{
    static readonly string[] Headers = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"];

    static (byte[]? Bytes, string? Error) Decode(string url)
    {
        var header = Headers.FirstOrDefault(h => url.StartsWith(h, StringComparison.Ordinal));
        if (header is null) return (null, "รองรับเฉพาะไฟล์ PNG, JPEG หรือ WebP");
        var payload = url.AsSpan(header.Length);
        if (payload.Length > FileStore.MaxBytes / 3 * 4 + 8) return (null, "ไฟล์ใหญ่เกิน 1 MB");
        var buf = new byte[payload.Length / 4 * 3 + 3];
        return Convert.TryFromBase64Chars(payload, buf, out var n) ? (buf[..n], null) : (null, "รูปภาพไม่ถูกต้อง");
    }

    public static async Task<Guid> StoreAsync(IFileStore files, Guid company, string url, string name, string field, CancellationToken ct)
    {
        var (bytes, error) = Decode(url);
        if (bytes is null) throw Invalid.Fields((field, error!));
        try { return (await files.PutAsync(company, new MemoryStream(bytes), name, ct)).Id; }
        catch (TeasException e) when (e.Code == "record.invalid") { throw Invalid.Fields((field, e.Detail!.Contains("1 MB") ? "ไฟล์ใหญ่เกิน 1 MB" : "รองรับเฉพาะไฟล์ PNG, JPEG หรือ WebP")); }
    }

    public static async Task<string?> ReadAsync(IFileStore files, Guid company, Guid? fileId, CancellationToken ct)
    {
        if (fileId is not { } id) return null;
        await using var file = await files.OpenAsync(company, id, ct);
        using var ms = new MemoryStream();
        await file.Content.CopyToAsync(ms, ct);
        return $"data:{file.File.Mime};base64,{Convert.ToBase64String(ms.ToArray())}";
    }
}

/// <summary>SP3 P8 routes 15-19: Me, the company switch, and the company's own settings (one version for every section).</summary>
public sealed partial class CompanyService(TeasDbContext db, TenantScope scope, IAudit audit, IFileStore files, SessionService sessions, EffectiveRights rights, TimeProvider clock)
{
    Guid? CompanyOrNull => scope.Current.CompanyId;
    Guid Company => scope.Current.CompanyId ?? throw new TeasException("auth.forbidden");

    // ---------------------------------------------------------------- Me, switch

    public async Task<MeView> MeAsync(SessionInfo s, CancellationToken ct = default)
    {
        var memberships = (await sessions.MembershipsAsync(s.UserId, ct))
            .Select(m => new MembershipView(m.CompanyId, m.CompanyName, m.RoleId, RoleDirectory.SystemNames.TryGetValue(m.RoleId, out var n) ? n : m.CustomRoleName ?? m.RoleId)).ToList();
        IReadOnlyList<string> permissions = [];
        var vat = false;
        if (s.ActiveCompanyId is { } active)
        {
            using var _ = scope.Enter(active, s.UserId);
            var held = await rights.ForUserAsync(s.UserId, ct);
            permissions = PermissionCatalog.Codes.Where(held.Contains).ToList();
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            vat = await Q.ScalarAsync<bool>(db, "SELECT vat_registered FROM teas.companies WHERE id = @c", ct, TxSql.P("c", active));
        }
        return new MeView(s.UserId, s.DisplayName, memberships, s.ActiveCompanyId, vat, permissions, BusinessDate.Today(clock).ToString());
    }

    /// <summary>Switch to a company the user is an active, accepted member of (anything else is the one 404). Audited in the company switched to.</summary>
    public async Task<MeView> SwitchAsync(SessionInfo s, string? companyId, CancellationToken ct = default)
    {
        if (!Guid.TryParse(companyId, out var target)) throw new TeasException("company.not_found");
        using (scope.Enter(target, s.UserId))
        {
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            if (!await Q.ScalarAsync<bool>(db, "SELECT EXISTS (SELECT 1 FROM teas.company_members WHERE company_id = @c AND user_id = @u AND active AND NOT invite_pending)", ct, TxSql.P("c", target), TxSql.P("u", s.UserId)))
                throw new TeasException("company.not_found");
            await Q.ExecAsync(db, "UPDATE teas.sessions SET active_company_id = @c WHERE id = @s AND user_id = @u AND revoked_at IS NULL", ct, TxSql.P("c", target), TxSql.P("s", s.Id), TxSql.P("u", s.UserId));
            await Q.ExecAsync(db, "UPDATE teas.users SET last_company_id = @c WHERE id = @u", ct, TxSql.P("c", target), TxSql.P("u", s.UserId));
            await audit.RecordAsync("company.switch", target.ToString(), new { companyId = s.ActiveCompanyId }, new { companyId = target }, ct);
            await tx.CommitAsync(ct);
        }
        return await MeAsync(s with { ActiveCompanyId = target }, ct);
    }

    // ---------------------------------------------------------------- settings

    sealed record Row(string Name, string? NameEn, string TaxId, string Branch, string? RegNo, string Address, decimal? Capital, string? Trade, string? Phone, string? Email, string? Website,
        string? Sso, bool Vat, int Month, Guid? Logo, Guid? Stamp, string Notes, int Version);

    const string Cols = "name, legal_name_en, tax_id, branch_code, registration_no, address, paid_up_capital, trade_name, phone, email, website, sso_employer_account_no, vat_registered, fiscal_year_start_month, logo_file_id, stamp_file_id, default_notes::text, version";

    static Row ReadRow(NpgsqlDataReader r)
    {
        string? S(int i) => r.IsDBNull(i) ? null : r.GetString(i);
        return new Row(r.GetString(0), S(1), r.GetString(2), r.GetString(3), S(4), r.GetString(5), r.IsDBNull(6) ? null : r.GetDecimal(6), S(7), S(8), S(9), S(10), S(11),
            r.GetBoolean(12), r.GetInt32(13), r.IsDBNull(14) ? null : r.GetGuid(14), r.IsDBNull(15) ? null : r.GetGuid(15), r.GetString(16), r.GetInt32(17));
    }

    /// <summary>The id in the path must be the active company: another company's id is a 404 even for one of its members (the widened SELECT policy would show it).</summary>
    Guid Own(string id) => Guid.TryParse(id, out var g) && g == Company ? g : throw new TeasException("company.not_found");

    async Task<Row> LoadAsync(Guid id, CancellationToken ct) =>
        await Q.OneAsync(db, $"SELECT {Cols} FROM teas.companies WHERE id = @i", ReadRow, ct, TxSql.P("i", id)) ?? throw new TeasException("company.not_found");

    static Dictionary<string, string> NotesOf(Row r) => JsonSerializer.Deserialize<Dictionary<string, string>>(r.Notes) ?? [];

    async Task<CompanySettingsView> ViewAsync(Guid id, Row r, CancellationToken ct) =>
        new(id, r.Name, r.TaxId, r.Branch, r.Vat, r.Address, r.Month, false, r.NameEn, r.Phone, r.Sso, r.RegNo, r.Trade, r.Email, r.Website,
            r.Capital is { } c ? Money.Of(c) : null, await DataUrls.ReadAsync(files, id, r.Logo, ct), await DataUrls.ReadAsync(files, id, r.Stamp, ct), NotesOf(r), r.Version);
    // fiscalYearLocked is false until periods exist (SP4.1 closes them); nothing in SP3 can lock the fiscal year

    public async Task<CompanySettingsView> GetAsync(string id, CancellationToken ct = default)
    {
        var company = Own(id);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        return await ViewAsync(company, await LoadAsync(company, ct), ct);
    }

    /// <summary>Route 19: the note a blank new document starts with. Any active member; no company scope (a member of nothing) is refused.</summary>
    public async Task<IReadOnlyDictionary<string, string>> DefaultNotesAsync(CancellationToken ct = default)
    {
        var company = Company;
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        return NotesOf(await LoadAsync(company, ct));
    }

    sealed record Plan(string Set, NpgsqlParameter[] Ps, object Before, object After);

    static readonly string[] NoteTypes = [.. Enum.GetNames<DocType>().Except(["WT", "JV", "FA", "DP", "PR", "OB"])];   // the types with a notes field on the paper

    [GeneratedRegex(@"^[^\s@]+@[^\s@]+\.[^\s@]+$")] private static partial Regex EmailRule();
    [GeneratedRegex(@"^https?://\S+$")] private static partial Regex WebsiteRule();

    /// <summary>Thai taxpayer id: 13 digits, check digit = (11 - sum(d[i] * (13 - i)) mod 11) mod 10 (the frontend's isValidTin).</summary>
    static bool ValidTin(string tin) => tin.Length == 13 && tin.All(char.IsAsciiDigit) && (11 - tin.Take(12).Select((d, i) => (d - '0') * (13 - i)).Sum() % 11) % 10 == tin[12] - '0';

    static string? Clean(string? v) => string.IsNullOrWhiteSpace(v) ? null : v.Trim();

    static NpgsqlParameter T(string n, string? v) => Q.N(n, NpgsqlDbType.Text, v);

    /// <summary>One Save of one section. Order: path company, section, version (409), then the section's own rules (422 / 409), then the guarded UPDATE and the audit row.</summary>
    public async Task<CompanySettingsView> UpdateAsync(string id, string section, object body, bool? vatRegisteredInBody, CancellationToken ct = default)
    {
        var company = Own(id);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var row = await LoadAsync(company, ct);
        var version = body switch
        {
            CompanyIdentityBody b => b.Version, CompanyContactBody b => b.Version, CompanyPayrollBody b => b.Version, CompanyFiscalBody b => b.Version,
            CompanyImagesChange b => b.Version, CompanyNotesBody b => b.Version, _ => throw new TeasException("company.section_unknown"),
        };
        Invalid.RequireVersion(version);
        if (version != row.Version) throw new TeasException("record.version_conflict");

        Plan? plan = body switch
        {
            CompanyIdentityBody b => Identity(row, b, vatRegisteredInBody),
            CompanyContactBody b => Contact(row, b),
            CompanyPayrollBody b => new Plan("sso_employer_account_no = @a", [T("a", Payroll(b))], new { ssoEmployerAccountNo = row.Sso }, new { ssoEmployerAccountNo = Clean(b.SsoEmployerAccountNo) }),
            CompanyFiscalBody b => Fiscal(row, b),
            CompanyNotesBody b => Notes(row, b),
            _ => await Images(company, row, (CompanyImagesChange)body, ct),
        };
        if (plan is null) return await ViewAsync(company, row, ct);   // nothing to change: no new version, no audit row

        await VersionedUpdate.UpdateAsync(db, "companies", plan.Set, company, row.Version, plan.Ps);
        await audit.RecordAsync($"company.update.{section}", company.ToString(), plan.Before, plan.After, ct);
        var view = await ViewAsync(company, await LoadAsync(company, ct), ct);
        await tx.CommitAsync(ct);
        return view;
    }

    static Plan Identity(Row row, CompanyIdentityBody b, bool? vatInBody)
    {
        if (vatInBody is { } v && v != row.Vat) throw new TeasException("company.vat_readonly");
        var errors = new List<(string, string)>();
        var (name, tax, branch, address) = (Clean(b.LegalNameTh), (b.TaxId ?? "").Trim(), (b.BranchCode ?? "").Trim(), Clean(b.Address));
        if (name is null) errors.Add(("legalNameTh", "ต้องระบุชื่อนิติบุคคล"));
        if (!ValidTin(tax)) errors.Add(("taxId", "เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (ตรวจสอบหลักสุดท้าย)"));
        if (branch.Length != 5 || !branch.All(char.IsAsciiDigit)) errors.Add(("branchCode", "ต้องระบุสาขา 5 หลัก"));
        if (address is null) errors.Add(("address", "ต้องระบุที่อยู่ตามทะเบียน"));
        if (errors.Count > 0) throw Invalid.Fields(errors);
        if (!b.Confirm) throw new TeasException("company.confirm_required");
        return new Plan("name = @n, legal_name_en = @en, tax_id = @t, branch_code = @b, registration_no = @r, address = @a, paid_up_capital = @cap",
            [T("n", name), T("en", Clean(b.LegalNameEn)), T("t", tax), T("b", branch), T("r", Clean(b.RegistrationNo)), T("a", address), Q.N("cap", NpgsqlDbType.Numeric, b.PaidUpCapital?.Value)],
            new { legalNameTh = row.Name, legalNameEn = row.NameEn, taxId = row.TaxId, branchCode = row.Branch, registrationNo = row.RegNo, address = row.Address, paidUpCapital = row.Capital is { } c ? Money.Of(c).ToString() : null },
            new { legalNameTh = name, legalNameEn = Clean(b.LegalNameEn), taxId = tax, branchCode = branch, registrationNo = Clean(b.RegistrationNo), address, paidUpCapital = b.PaidUpCapital?.ToString() });
    }

    static Plan Contact(Row row, CompanyContactBody b)
    {
        var (trade, phone, email, site) = (Clean(b.TradeName), Clean(b.Phone), Clean(b.Email), Clean(b.Website));
        var errors = new List<(string, string)>();
        if (email is not null && !EmailRule().IsMatch(email)) errors.Add(("email", "อีเมลไม่ถูกต้อง"));
        if (site is not null && !WebsiteRule().IsMatch(site)) errors.Add(("website", "เว็บไซต์ต้องขึ้นต้นด้วย http:// หรือ https://"));
        if (errors.Count > 0) throw Invalid.Fields(errors);
        return new Plan("trade_name = @a, phone = @b, email = @c, website = @d", [T("a", trade), T("b", phone), T("c", email), T("d", site)],
            new { tradeName = row.Trade, phone = row.Phone, email = row.Email, website = row.Website }, new { tradeName = trade, phone, email, website = site });
    }

    static string? Payroll(CompanyPayrollBody b)
    {
        var sso = Clean(b.SsoEmployerAccountNo);
        if (sso is not null && (sso.Length != 10 || !sso.All(char.IsAsciiDigit))) throw Invalid.Fields(("ssoEmployerAccountNo", "เลขที่บัญชีนายจ้างประกันสังคมต้องเป็นตัวเลข 10 หลัก"));
        return sso;
    }

    static Plan? Fiscal(Row row, CompanyFiscalBody b)
    {
        if (b.FiscalYearStartMonth is < 1 or > 12) throw Invalid.Fields(("fiscalYearStartMonth", "เดือนเริ่มต้นปีบัญชีต้องเป็น 1-12"));
        if (b.FiscalYearStartMonth == row.Month) return null;
        // company.fiscal_year_locked arrives with closed periods (SP4.1). The engine supports the calendar year only (ADR-0006 interim): a value it would ignore is never stored.
        if (b.FiscalYearStartMonth != 1) throw new TeasException("company.fiscal_year_unsupported");
        return new Plan("fiscal_year_start_month = @m", [TxSql.P("m", b.FiscalYearStartMonth)], new { fiscalYearStartMonth = row.Month }, new { fiscalYearStartMonth = b.FiscalYearStartMonth });
    }

    static Plan Notes(Row row, CompanyNotesBody b)
    {
        var errors = new List<(string, string)>();
        foreach (var (type, text) in b.DefaultNotes ?? new Dictionary<string, string>())
        {
            if (!NoteTypes.Contains(type)) errors.Add(("defaultNotes", $"ไม่รู้จักประเภทเอกสาร {type}"));
            else if (text is null || text.Length > 1000) errors.Add(($"defaultNotes.{type}", "หมายเหตุยาวเกิน 1,000 ตัวอักษร"));
        }
        if (b.DefaultNotes is null) errors.Add(("defaultNotes", "ข้อมูลไม่ถูกต้อง"));
        if (errors.Count > 0) throw Invalid.Fields(errors);
        var notes = NotesOf(row);
        foreach (var (type, text) in b.DefaultNotes!) { if (text.Trim().Length > 0) notes[type] = text; else notes.Remove(type); }
        return new Plan("default_notes = @n::jsonb", [T("n", JsonSerializer.Serialize(notes))], new { defaultNotes = NotesOf(row) }, new { defaultNotes = notes });
    }

    async Task<Plan?> Images(Guid company, Row row, CompanyImagesChange b, CancellationToken ct)
    {
        var sets = new List<string>();
        var ps = new List<NpgsqlParameter>();
        async Task Apply(ImageChange change, string column, string param, string field, string name)
        {
            if (!change.IsSet) return;
            var file = string.IsNullOrEmpty(change.DataUrl) ? (Guid?)null : await DataUrls.StoreAsync(files, company, change.DataUrl, name, field, ct);
            sets.Add($"{column} = @{param}");
            ps.Add(Q.N(param, NpgsqlDbType.Uuid, file));
        }
        await Apply(b.Logo, "logo_file_id", "l", "logoDataUrl", "logo");
        await Apply(b.Stamp, "stamp_file_id", "s", "stampDataUrl", "stamp");
        if (sets.Count == 0) return null;
        static string Mark(Guid? before, ImageChange change) => !change.IsSet ? (before is null ? "none" : "set") : string.IsNullOrEmpty(change.DataUrl) ? "none" : "set";
        return new Plan(string.Join(", ", sets), [.. ps],
            new { logoDataUrl = row.Logo is null ? "none" : "set", stampDataUrl = row.Stamp is null ? "none" : "set" },   // a picture is only set / none in the trail
            new { logoDataUrl = Mark(row.Logo, b.Logo), stampDataUrl = Mark(row.Stamp, b.Stamp) });
    }
}

/// <summary>
/// A system service for tests and the bootstrap CLI (no route): creates a company and its first administrator in ONE transaction. The company row is inserted
/// UNDER <c>TenantScope.Enter(newId, admin)</c> because its policy is <c>WITH CHECK (id = teas.current_company())</c>; a factory that inserted first would fail the check.
/// </summary>
public sealed class CompanyFactory(TeasDbContext db, TenantScope scope)
{
    public async Task<Guid> CreateAsync(string legalNameTh, Guid adminUserId, string taxId = "", string branchCode = "00000", string address = "", bool vatRegistered = false, CancellationToken ct = default)
    {
        var id = Guid.NewGuid();
        using var _ = scope.Enter(id, adminUserId);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await Q.ExecAsync(db, "INSERT INTO teas.companies (id, name, tax_id, branch_code, address, vat_registered) VALUES (@i, @n, @t, @b, @a, @v)", ct,
            TxSql.P("i", id), TxSql.P("n", legalNameTh), TxSql.P("t", taxId), TxSql.P("b", branchCode), TxSql.P("a", address), TxSql.P("v", vatRegistered));
        // the admin's login row is global; the member row is this company's
        if (await Q.ExecAsync(db, "INSERT INTO teas.company_members (company_id, user_id, email, name, role_id) SELECT @i, id, email, display_name, 'admin' FROM teas.users WHERE id = @u", ct,
                TxSql.P("i", id), TxSql.P("u", adminUserId)) != 1)
            throw new TeasException("record.not_found", "the administrator does not exist");
        await tx.CommitAsync(ct);
        return id;
    }
}
