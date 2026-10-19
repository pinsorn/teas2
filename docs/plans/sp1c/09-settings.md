# SP1c group 09 — Settings (company, users and roles, posting profiles, dimensions, tax, numbering, approvals, templates)

> Part of `docs/plans/2026-10-14-sp1c-all-screens.md`. Depends on group 08. Tasks ST1 → ST3 → gate GST.
> SP0 §9.1 ตั้งค่า: บริษัท · ผู้ใช้และสิทธิ์ · การลงบัญชี · มิติ · ภาษี · เลขที่เอกสาร · การอนุมัติ · แม่แบบเอกสาร · TEAS Connect
> (TEAS Connect and agent policy are group 10). Agents may never change settings (§8.5) — every settings write in the
> mock refuses an agent actor (`agent.forbidden_setting`).

**Parity coverage (Appendix C "Platform" settings items, "Master data" WHT types / expense categories / BU, flex gaps "Configurable …")**

| Item | Task |
|---|---|
| company profile (legal identity, logo, stamp, SSO account, default notes), fiscal year start (D-33) | ST1 |
| users, roles, permissions, separation of duties; invite / reset links; position + signature | ST1 |
| posting profiles (new screen), expense categories (editable), dimensions (new screen; replaces business units + require-BU rule) | ST2 |
| WHT types with effective-dated rates, tax codes (view), VAT config (read-only), numbering series (prefixes / format / branch), approval policy, document templates (print options) | ST3 |

---

### Task ST1: Company settings, users and roles

**Depends on:** RP3.

**Files:** Create `frontend/src/app/(app)/settings/company/page.tsx` (custom form page: sections), `frontend/src/records/{users,roles}.ts`,
`frontend/src/mocks/records/{users,roles}.ts` (+ tests), `frontend/src/kit/settings/{SettingsSection,ImageUpload,PermissionMatrix}.tsx`
(+ tests), `frontend/src/mocks/engine/company.ts` (+ test), `frontend/e2e/settings-company-users.spec.ts`. Modify
`domain/types.ts` (`Company` + `fiscalYearStartMonth`, `registrationNo`, `tradeName`, `email`, `website`, `ssoEmployerAccount`,
`paidUpCapital`, `logoDataUrl?`, `stampDataUrl?`), `mocks/fixtures/companies.json` + `index.ts` (stop stripping
`fiscalYearStartMonth`), `mocks/fixtures/default-notes.ts` (editable), `app-shell/nav.ts` (settingsCompany →
`settings.manage`, settingsUsers → `users.manage`), permissions, messages, `screens.ts`.

**Rules:**
- Company page sections: ข้อมูลตามทะเบียน (legal name th / en, TIN, branch, registration no., registered address —
  **read-only with "แก้ไขข้อมูลตามทะเบียน" behind a confirm dialog explaining that issued documents keep their frozen
  snapshot (I3)**; VAT registration status shown read-only with "การเปลี่ยนสถานะ VAT ทำผ่านการตั้งค่าภาษี" — the change itself
  is ST3), ข้อมูลติดต่อ (trade name, phone, email, website), เงินเดือนและประกันสังคม (SSO employer account, 10 digits),
  ปีบัญชี (fiscal year start month — editable only while no period is closed: `company.fiscal_year_locked` with the
  exit text "ติดต่อผู้ดูแลระบบเพื่อเปิดงวดก่อน" pointing to period close), รูปภาพ (logo, stamp: png / jpeg / webp ≤ 1 MB,
  stamp no svg), หมายเหตุเริ่มต้นตามประเภทเอกสาร (one textarea per document type that has notes). One Save per section;
  each save audited.
- Users (record kind `user`, `basePath '/settings/users'`, perms `users.manage` / `users.manage`): per-company
  membership list (name, email, role, position, active, last login); invite (mock returns a one-time link text "ลิงก์เชิญ
  (ใช้ได้ 7 วัน)" shown once with a copy button), reset password link, change role, deactivate (refused for the last
  admin: `user.last_admin`, exit "เพิ่มผู้ดูแลอีกคนก่อน"), position + signature image.
- Roles (record kind `role`, `basePath '/settings/roles'` — add nav item `settingsRoles` "บทบาทและสิทธิ์"): system roles
  operator / accountant / admin (read-only, "คัดลอกเป็นบทบาทใหม่"), custom roles with a `PermissionMatrix` (rows =
  catalog permissions grouped by area with Thai labels from `domain/permissions.ts`; columns = granted); separation of
  duties warning when one role holds both `doc.<T>.create` and `doc.<T>.approve` for a type with approval enabled
  (warning only — self-approval is a company setting, D-36). Mock: custom roles are assignable; the mock toolbar's role
  switcher still offers only the three system roles (custom roles are visible, not simulated).

- [x] **Step 1: Failing tests** — fiscal year locked once a period is closed (seed: locked, exit shown); last-admin
  refusal; invite link shown once; permission matrix lists every catalog code exactly once; agent actor refused on a
  settings write. e2e: `screenContract` company (`both`, forbiddenRole accountant), users (`both`, forbiddenRole
  accountant), roles (`both`, forbiddenRole operator).
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(settings): company profile, users and roles`.

---

### Task ST2: Posting profiles, dimensions, expense categories

**Depends on:** ST1. **Review:** Opus (ledger rules).

**Files:** Create `frontend/src/app/(app)/settings/posting/page.tsx` (tabs กฎการลงบัญชี / หมวดค่าใช้จ่าย / ทดสอบการลงบัญชี),
`frontend/src/records/{posting-rules,expense-categories,dimensions}.ts`, `frontend/src/mocks/records/{posting-rules,expense-categories,dimensions}.ts`
(+ tests), `frontend/src/kit/settings/PostingPreview.tsx` (+ test), `frontend/e2e/settings-posting-dimensions.spec.ts`.
Modify `mocks/engine/{posting,journal}.ts` (dimension rules enforced: required / forbidden per account),
`kit/doc-editor/{HeaderFields,LineGrid}.tsx` (dimension pickers on header and lines, defaults header → lines, §5.6),
`mocks/engine/reports/*` (dimension filters already in RP1), `app-shell/nav.ts` (settingsPosting → `ledger.posting.manage`,
settingsDimensions → `settings.manage`), permissions (`ledger.posting.manage` accountant), messages, `screens.ts`.

**Rules:**
- Posting rules (record kind `posting-rule`): columns level (สินค้า/บริการ · หมวดค่าใช้จ่าย/ประเภทสินทรัพย์ · กลุ่มคู่ค้า ·
  ประเภทเอกสาร · ค่าเริ่มต้นบริษัท), key, role (Thai role label + code), account; validation on save (§5.5): account
  postable, active, class fits the role (`posting.class_mismatch`, e.g. Revenue → class revenue; OutputVat → current
  liability), one rule per (level, key, role); the company-default level must keep a rule for every role
  (`posting.default_required`, exit "แก้บัญชีแทนการลบ"); changes audited; agents refused.
- "ทดสอบการลงบัญชี" (`PostingPreview`): pick a document type, item / category / party → shows which rule wins per role
  and the resulting journal preview (server: `POST /posting/preview`), i.e. the resolution order made visible.
- Expense categories (record kind `expense-category`): code, name, account (Expense role target), recoverable VAT,
  capex + asset class, default WHT type, parent; editable (TEAS 1 was read-only — flex gap).
- Dimensions (record kind `dimension`, page `/settings/dimensions`): up to 4 types (`dimension.max_types`), defaults
  แผนก and โปรเจกต์ seeded with values (แผนก: ออกแบบ, การตลาด, บริหาร; โปรเจกต์: เว็บไซต์ลูกค้า A, งานบรรจุภัณฑ์ B);
  values with active flag; account rules matrix (per account: required / optional / forbidden per type); dimensions never
  in document numbers. Engine: issuing a document whose posting lines hit an account with a `required` rule and no
  value → `doc.incomplete` "บัญชี <code> ต้องระบุ<มิติ>"; forbidden → refused likewise.

- [x] **Step 1: Failing tests** — class mismatch refused; default rule cannot be deleted; preview shows the winning
  level; a required-dimension account blocks issue with the message and an exit (set the dimension on the header);
  a fifth dimension type refused. e2e: `screenContract` posting page (`both`, forbiddenRole operator), dimensions
  (`both`, forbiddenRole accountant); flow add an item-level Revenue rule for SV-02 → 4200 → TI preview shows the rule.
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS**; invariants `[]`.
- [x] **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(settings): posting profiles, dimensions and expense categories`.

---

### Task ST3: Tax settings, numbering series, approval policy, document templates

**Depends on:** ST2.

**Files:** Create `frontend/src/app/(app)/settings/{tax,numbering,approvals,templates}/page.tsx`,
`frontend/src/records/{wht-types,numbering-series,approval-rules}.ts`, `frontend/src/mocks/records/{wht-types,numbering-series,approval-rules}.ts`
(+ tests), `frontend/src/kit/settings/{RateHistory,NumberFormatPreview,TemplatePreview}.tsx`, `frontend/e2e/settings-tax-numbering-approvals.spec.ts`.
Modify `mocks/engine/{numbering,approval,wht}.ts`, `app-shell/nav.ts` (settingsTax → `tax.settings.manage`, settingsNumbering /
settingsApprovals / settingsTemplates → `settings.manage`), permissions (`tax.settings.manage` accountant + admin),
messages, `screens.ts`.

**Rules:**
- Tax (`/settings/tax`): VAT status and rate read-only with source citation `[SP-R]` (Ham 2026-05-30: admins do not
  invent rules); VAT registration change = a dated request record ("ขอเปลี่ยนสถานะ VAT ตั้งแต่วันที่ …") shown as pending
  — the switch itself is SP4 (the mock never flips a company's VAT flag); WHT types (record kind `wht-type`): list,
  "เปลี่ยนอัตรา" creates a new effective-dated row (never edits a rate; `RateHistory` shows all rows), deactivate;
  tax codes view-only (S7 / Z0 / EX). Every change audited and permission-gated.
- Numbering (`/settings/numbering`, record kind `numbering-series`): per document type: prefix, scope (monthly / yearly),
  branch (optional), format with tokens `{PREFIX}`, `{YYYY}`, `{YY}`, `{MM}`, `{####}`; validation: the format must
  contain every scope token (monthly needs `{MM}` and a year token) and a counter (`numbering.missing_token`, §5.14);
  changing a series with issued numbers applies from the next period only (`numbering.in_use` explains);
  `NumberFormatPreview` shows the next number from the server. Default `{PREFIX}-{YYYY}{MM}-{####}` (D-24).
- Approvals (`/settings/approvals`, record kind `approval-rule`): per type enabled, minimum amount, self-approval
  toggle (company-wide); the P4 engine reads these. One threshold per type (O-5: chains deferred).
- Templates (`/settings/templates`): per printable type: show logo / stamp / signature lines on / off, signature role
  labels (from a fixed list), default notes link to ST1; `TemplatePreview` renders the type's paper with a fixture
  document. Print options are read by `PAPER_BUILDERS`.
- Images on the paper (every printable type, via the shared paper header / signature block — added 2026-10-15 at
  Ham's question): the company logo (ST1 upload) replaces the text mark in the header; the issuer's signature image
  (ST1 user signature) sits on the line of the role that issued the document, with the issuer's name and position
  under it; the company stamp sits beside the authorised-signatory line. **Invariant: the paper shows the images as
  they were at issue** — issuing snapshots logo / stamp / signature references onto the document (a later upload or a
  deleted user never changes an issued paper; revisions re-snapshot). Drafts print without signature and stamp. A
  template toggle off hides the image; a missing image keeps the empty line (never a broken image).
  Scope includes papers built outside the shared header (PY2 review 2026-10-18): `PayslipPaper` (PR, own header and a
  two-line signature block without an authorised-signatory line), the employee 50 ทวิ (PY3) and the WT 50 ทวิ (TX4) —
  move them onto the shared header / signature block or snapshot them the same way.

- [x] **Step 1: Failing tests** — rate change creates a new effective row and the PV on a date before it keeps the old
  rate; numbering format without `{MM}` on a monthly series refused; a change to an in-use series applies next period;
  approval rule change alters `submit` behaviour; template toggles change the paper model; an issued TI keeps the old
  logo / signature after a new upload while a new TI shows the new one; a draft prints no signature or stamp. e2e: `screenContract` for the
  four pages (`both`; forbiddenRole operator for tax, accountant for numbering / approvals / templates).
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(settings): tax settings, numbering series, approval policy and templates`.

---

### Task GST: Ham gate — settings

- [x] Consolidated gate green; production build / staging.
- [x] Send Ham: company profile (registered identity behind a confirm), users / roles with the permission matrix,
  posting profiles with the visible resolution order and preview, dimensions with account rules, WHT effective-dated
  rates (no rate editing), numbering format rules, approval policy (one threshold per type — O-5), templates.
- [x] AskUserQuestion "Settings approve?" — approve / approve with changes / rework. Record in `STATUS.md`.
