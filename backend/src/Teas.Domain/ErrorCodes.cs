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
        ["auth.locked"] = new(429, "บัญชีถูกล็อกชั่วคราว", "The account is temporarily locked"),
        ["auth.challenge_invalid"] = new(401, "คำขอยืนยันตัวตนไม่ถูกต้องหรือหมดอายุ", "The sign-in challenge is invalid or expired"),
        ["auth.totp_invalid"] = new(401, "รหัสยืนยันสองขั้นตอนไม่ถูกต้อง", "The verification code is incorrect"),
        ["auth.session_expired"] = new(401, "เซสชันหมดอายุ", "The session has expired"),
        ["auth.unauthenticated"] = new(401, "ยังไม่ได้เข้าสู่ระบบ", "Not signed in"),
        ["auth.not_expired"] = new(409, "เซสชันยังไม่หมดอายุ", "The session has not expired"),
        ["auth.current_password_invalid"] = new(422, "รหัสผ่านปัจจุบันไม่ถูกต้อง", "The current password is incorrect"),
        ["auth.password_mismatch"] = new(422, "รหัสผ่านและการยืนยันไม่ตรงกัน", "The password and its confirmation do not match"),
        ["auth.password_weak"] = new(422, "รหัสผ่านไม่ปลอดภัยพอ", "The password is too weak"),
        ["auth.password_reuse"] = new(422, "ห้ามใช้รหัสผ่านที่เคยใช้แล้ว", "The password was used before"),
        ["auth.enrol_not_started"] = new(409, "ยังไม่ได้เริ่มตั้งค่าการยืนยันสองขั้นตอน", "Two-step verification setup has not started"),
        ["auth.session_not_found"] = new(404, "ไม่พบเซสชัน", "Session not found"),
        ["auth.link_invalid"] = new(404, "ลิงก์ไม่ถูกต้องหรือหมดอายุ", "The link is invalid or has expired"),
        ["auth.forbidden"] = new(403, "ไม่มีสิทธิ์ทำรายการนี้", "You do not have permission for this action"),
        ["company.not_found"] = new(404, "ไม่พบบริษัท", "Company not found"),
        ["company.section_unknown"] = new(404, "ไม่พบหมวดข้อมูลบริษัท", "Unknown company section"),
        ["company.confirm_required"] = new(422, "ต้องยืนยันก่อนบันทึก", "Confirmation is required"),
        ["company.vat_readonly"] = new(422, "สถานะภาษีมูลค่าเพิ่มแก้ไขที่นี่ไม่ได้", "VAT registration cannot be changed here"),
        ["company.fiscal_year_unsupported"] = new(422, "ไม่รองรับรอบปีบัญชีนี้", "This fiscal year start is not supported"),
        ["company.fiscal_year_locked"] = new(409, "รอบปีบัญชีถูกล็อกแล้ว", "The fiscal year is locked"),
        ["record.invalid"] = new(422, "ข้อมูลไม่ถูกต้อง", "The data is invalid"),
        ["record.not_found"] = new(404, "ไม่พบข้อมูล", "Record not found"),
        ["record.version_conflict"] = new(409, "ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว โปรดโหลดใหม่", "The record was changed by someone else; reload"),
        ["user.last_admin"] = new(409, "ต้องมีผู้ดูแลระบบอย่างน้อยหนึ่งคน", "The company must keep at least one administrator"),
        ["user.inactive"] = new(409, "ผู้ใช้ถูกปิดใช้งาน", "The user is inactive"),
        ["user.invite_pending"] = new(409, "ผู้ใช้ยังไม่ตอบรับคำเชิญ", "The user has not accepted the invitation"),
        ["user.cross_company"] = new(403, "ผู้ใช้นี้อยู่ในบริษัทอื่นที่คุณไม่ได้ดูแล", "The user also belongs to a company you do not manage"),
        ["role.system_readonly"] = new(409, "แก้ไขบทบาทของระบบไม่ได้", "System roles cannot be changed"),
        ["role.in_use"] = new(409, "บทบาทนี้ยังมีผู้ใช้งานอยู่", "The role is still in use"),
        ["connect.not_member"] = new(403, "ไม่ได้เป็นสมาชิกของบริษัทนี้", "Not a member of this company"),
        ["connect.wrong_company"] = new(403, "คีย์นี้ใช้กับบริษัทอื่นไม่ได้", "This key cannot be used for another company"),
        ["connect.scope_forbidden"] = new(422, "ขอบเขตสิทธิ์นี้ให้คีย์ไม่ได้", "This scope cannot be granted to a key"),
        ["connect.scope_exceeds"] = new(422, "ขอบเขตสิทธิ์เกินกว่าสิทธิ์ของเจ้าของคีย์", "The scope exceeds the owner's rights"),
        ["connect.key_revoked"] = new(401, "คีย์ถูกเพิกถอนแล้ว", "The key has been revoked", 409),
        ["connect.key_expired"] = new(401, "คีย์หมดอายุแล้ว", "The key has expired", 409),
        ["connect.key_invalid"] = new(401, "คีย์ไม่ถูกต้อง", "The key is invalid"),
        ["connect.owner_inactive"] = new(409, "เจ้าของคีย์ถูกปิดใช้งาน", "The key owner is inactive"),
        ["connect.key_kind_mismatch"] = new(403, "คีย์ชนิดนี้ใช้กับช่องทางนี้ไม่ได้", "This kind of key cannot be used on this channel"),
        ["agent.forbidden_action"] = new(403, "ตัวแทนอัตโนมัติทำรายการนี้ไม่ได้", "An agent may not perform this action"),
        ["agent.forbidden_setting"] = new(403, "ตัวแทนอัตโนมัติเปลี่ยนการตั้งค่าไม่ได้", "An agent may not change settings"),
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

/// <summary>A domain failure with a registered code; the API renders it as ApiProblem.</summary>
public class TeasException : Exception
{
    public TeasException(string code, string? detail = null, IReadOnlyDictionary<string, string[]>? fieldErrors = null) : base(detail ?? code)
    {
        if (!ErrorCodes.All.ContainsKey(code)) throw new ArgumentException($"Unregistered error code '{code}'.", nameof(code));
        Code = code;
        Detail = detail;
        FieldErrors = fieldErrors;
    }

    public string Code { get; }
    public string? Detail { get; }
    public IReadOnlyDictionary<string, string[]>? FieldErrors { get; }
}
