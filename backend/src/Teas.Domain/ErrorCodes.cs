namespace Teas.Domain;

/// <summary>One registry row: HTTP status (AltStatus = the second status of a code that differs by route), Thai and English title.</summary>
public sealed record ErrorEntry(int Status, string Th, string En, int? AltStatus = null);

/// <summary>
/// SP3 5.2 error-code registry. Must equal the frozen frontend ERROR_CODES (test) plus the backend-only codes at the end.
/// A code literal anywhere in source that is not a key here fails the architecture test.
/// </summary>
public static class ErrorCodes
{
    public static IReadOnlyDictionary<string, ErrorEntry> All { get; } = new Dictionary<string, ErrorEntry>
    {
        ["auth.invalid_credentials"] = new(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง", "Email or password is incorrect"),
        ["auth.locked"] = new(429, "พยายามเข้าสู่ระบบผิดหลายครั้ง บัญชีถูกล็อกชั่วคราว 15 นาที ลองใหม่ภายหลัง", "The account is temporarily locked"),
        ["auth.challenge_invalid"] = new(401, "การเข้าสู่ระบบหมดอายุ กรอกอีเมลและรหัสผ่านใหม่อีกครั้ง", "The sign-in challenge is invalid or expired"),
        ["auth.totp_invalid"] = new(401, "รหัสยืนยันไม่ถูกต้อง", "The verification code is incorrect"),
        ["auth.session_expired"] = new(401, "เซสชันหมดอายุ กรอกรหัสผ่านเพื่อดำเนินการต่อ", "The session has expired"),
        ["auth.unauthenticated"] = new(401, "ยังไม่ได้เข้าสู่ระบบ", "Not signed in"),
        ["auth.not_expired"] = new(409, "เซสชันยังไม่หมดอายุ", "The session has not expired"),
        ["auth.current_password_invalid"] = new(422, "รหัสผ่านปัจจุบันไม่ถูกต้อง", "The current password is incorrect"),
        ["auth.password_mismatch"] = new(422, "รหัสผ่านใหม่และการยืนยันไม่ตรงกัน", "The password and its confirmation do not match"),
        ["auth.password_weak"] = new(422, "รหัสผ่านใหม่ต้องยาวอย่างน้อย 10 ตัวอักษร และมีตัวพิมพ์เล็ก ตัวพิมพ์ใหญ่ และตัวเลข", "The password is too weak"),
        ["auth.password_reuse"] = new(422, "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม", "The password was used before"),
        ["auth.enrol_not_started"] = new(409, "ยังไม่ได้เริ่มตั้งค่ารหัสยืนยันสองขั้น เริ่มใหม่อีกครั้ง", "Two-step verification setup has not started"),
        ["auth.session_not_found"] = new(404, "ไม่พบอุปกรณ์ที่เข้าสู่ระบบนี้", "Session not found"),
        ["auth.link_invalid"] = new(404, "ลิงก์นี้ใช้ไม่ได้แล้วหรือหมดอายุ ขอลิงก์ใหม่จากผู้ดูแลระบบ", "The link is invalid or has expired"),
        ["auth.forbidden"] = new(403, "คุณไม่มีสิทธิ์ดูข้อมูลนี้", "You do not have permission for this action"),
        ["company.not_found"] = new(404, "ไม่พบบริษัท", "Company not found"),
        ["company.section_unknown"] = new(404, "ไม่รู้จักส่วนของข้อมูลบริษัท", "Unknown company section"),
        ["company.confirm_required"] = new(422, "ต้องยืนยันก่อนแก้ไขข้อมูลตามทะเบียน เอกสารที่ออกแล้วยังคงแสดงข้อมูลเดิม", "Confirmation is required"),
        ["company.vat_readonly"] = new(422, "เปลี่ยนสถานะ VAT ที่นี่ไม่ได้ การเปลี่ยนสถานะ VAT ทำผ่านการตั้งค่าภาษี", "VAT registration cannot be changed here"),
        ["company.fiscal_year_unsupported"] = new(422, "ระบบรองรับเฉพาะปีบัญชีตามปีปฏิทินในขณะนี้", "This fiscal year start is not supported"),
        ["company.fiscal_year_locked"] = new(409, "แก้ไขเดือนเริ่มต้นปีบัญชีไม่ได้ เพราะมีงวดที่ปิดแล้ว ทางออก: ติดต่อผู้ดูแลระบบเพื่อเปิดงวดก่อน", "The fiscal year is locked"),
        ["record.invalid"] = new(422, "ข้อมูลไม่ถูกต้อง", "The data is invalid"),
        ["record.not_found"] = new(404, "ไม่พบข้อมูลนี้", "Record not found"),
        ["record.version_conflict"] = new(409, "ข้อมูลนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก", "The record was changed by someone else; reload"),
        ["user.last_admin"] = new(409, "ผู้ดูแลระบบคนสุดท้ายของบริษัท ปิดใช้งานหรือลดสิทธิ์ไม่ได้ ทางออก: เพิ่มผู้ดูแลอีกคนก่อน", "The company must keep at least one administrator"),
        ["user.inactive"] = new(409, "ผู้ใช้นี้ถูกปิดใช้งานอยู่ เปิดใช้งานก่อนจึงจะออกลิงก์ได้", "The user is inactive"),
        ["user.invite_pending"] = new(409, "ผู้ใช้นี้ยังไม่ได้รับคำเชิญ ใช้ลิงก์เชิญที่ออกไว้ (ออกคำเชิญใหม่ได้ทางการแก้ไข)", "The user has not accepted the invitation"),
        ["user.cross_company"] = new(403, "ผู้ใช้นี้เป็นสมาชิกบริษัทอื่นด้วย ทางออก: ให้ผู้ดูแลเซิร์ฟเวอร์รีเซ็ตด้วยคำสั่ง reset-password / reset-mfa หลังยืนยันตัวตน", "The user also belongs to a company you do not manage"),
        ["role.system_readonly"] = new(409, "บทบาทของระบบแก้ไขไม่ได้ ใช้ “คัดลอกเป็นบทบาทใหม่”", "System roles cannot be changed"),
        ["role.in_use"] = new(409, "ลบบทบาทนี้ไม่ได้ เพราะมีผู้ใช้ใช้อยู่ เปลี่ยนบทบาทของผู้ใช้ก่อน", "The role is still in use"),
        ["connect.not_member"] = new(403, "ต้องเป็นสมาชิกที่ใช้งานอยู่ของบริษัทนี้", "Not a member of this company"),
        ["connect.wrong_company"] = new(403, "คีย์นี้ใช้กับบริษัทอื่นไม่ได้", "This key cannot be used for another company"),
        ["connect.scope_forbidden"] = new(422, "ขอบเขตสิทธิ์นี้ให้คีย์ไม่ได้", "This scope cannot be granted to a key"),
        ["connect.scope_exceeds"] = new(422, "ขอบเขตสิทธิ์เกินกว่าสิทธิ์ของเจ้าของคีย์", "The scope exceeds the owner's rights"),
        ["connect.key_revoked"] = new(401, "คีย์ API นี้ถูกเพิกถอนแล้ว", "The key has been revoked", 409),
        ["connect.key_expired"] = new(401, "คีย์ API นี้หมดอายุแล้ว", "The key has expired", 409),
        ["connect.key_invalid"] = new(401, "คีย์ API ไม่ถูกต้อง", "The key is invalid"),
        ["connect.owner_inactive"] = new(409, "เจ้าของคีย์ไม่ได้ใช้งานในบริษัทนี้แล้ว หมุนเวียนคีย์ไม่ได้ เพิกถอนคีย์แทน", "The key owner is inactive"),
        ["connect.key_kind_mismatch"] = new(403, "คีย์ชนิดนี้ใช้กับช่องทางนี้ไม่ได้", "This kind of key cannot be used on this channel"),
        ["agent.forbidden_action"] = new(403, "ตัวแทน (agent) ทำรายการนี้ไม่ได้ ต้องให้ผู้ใช้ทำเอง", "An agent may not perform this action"),
        ["agent.forbidden_setting"] = new(403, "ตัวแทน (agent) เปลี่ยนการตั้งค่าไม่ได้ ต้องให้ผู้ใช้ทำเอง", "An agent may not change settings"),
        ["idempotency.key_required"] = new(400, "ต้องระบุ Idempotency-Key", "The Idempotency-Key header is required"),
        ["idempotency.key_reused"] = new(422, "Idempotency-Key นี้เคยใช้กับคำขออื่นแล้ว", "The Idempotency-Key was used with a different request"),
        ["http.rate_limited"] = new(429, "ส่งคำขอถี่เกินไป โปรดลองใหม่ภายหลัง", "Too many requests; try again later"),
        ["http.403"] = new(403, "คำขอถูกปฏิเสธ", "The request was refused"),
        ["storage.full"] = new(507, "พื้นที่จัดเก็บเต็ม", "Storage is full"),
        ["http.500"] = new(500, "เกิดข้อผิดพลาดภายในระบบ", "Internal server error"),
        // backend-only (not in the frozen frontend table): thrown by Money.Of
        ["money.out_of_range"] = new(422, "จำนวนเงินเกินช่วงที่รองรับ", "The amount is out of range"),
    };
}

/// <summary>A domain failure with a registered code; the API renders it as ApiProblem. <paramref name="status"/> may only be the row's
/// Status or AltStatus (a code with two statuses, e.g. connect.key_revoked 401 on use / 409 on rotate); default = the row's Status.</summary>
public class TeasException : Exception
{
    public TeasException(string code, string? detail = null, IReadOnlyDictionary<string, string[]>? fieldErrors = null, int? status = null) : base(detail ?? code)
    {
        if (!ErrorCodes.All.TryGetValue(code, out var entry)) throw new ArgumentException($"Unregistered error code '{code}'.", nameof(code));
        if (status is { } s && s != entry.Status && s != entry.AltStatus) throw new ArgumentException($"{code} has no status {s}.", nameof(status));
        Code = code;
        Status = status ?? entry.Status;
        Detail = detail;
        FieldErrors = fieldErrors;
    }

    public string Code { get; }
    public int Status { get; }
    public string? Detail { get; }
    public IReadOnlyDictionary<string, string[]>? FieldErrors { get; }
}
