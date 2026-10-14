# SP1c group 10 — Home, TEAS Connect, platform screens

> Part of `docs/plans/2026-10-14-sp1c-all-screens.md`. Depends on group 09. Tasks HC1 → HC3 → gate GHC (the final
> SP1c gate: Ham approves the whole mockup).

**Parity coverage (Appendix C "Platform" + flex gaps + SP0 §11.2 new screens "approval inbox", "agent policy")**

| Item | Task |
|---|---|
| role-aware home page; approval inbox (waiting for me: age, requester, amount, party); dashboard alerts (number gaps, duplicates, VAT threshold, incomplete PBs, agent drafts); agent digest; KPIs | HC1 |
| API keys + MCP + OAuth consent ("TEAS Connect"); agent policy; agent review report view | HC2 |
| login + TOTP, first-run bootstrap / company onboarding wizard, multi-company switching, session keep-alive + expiry, TH / EN, self password change, TOTP enrolment, session list / revoke, per-document PDF via public token link | HC3 |

---

### Task HC1: Role-aware Home with the approval inbox and engine KPIs

**Depends on:** ST3.

**Files:** Create `frontend/src/mocks/engine/home.ts` (+ test), `frontend/src/kit/home/{InboxSection,KpiStrip,AlertsPanel,AgentDigest}.tsx`
(+ tests), `frontend/e2e/home.spec.ts`. Modify `app/(app)/home-view.tsx` (rebuilt from sections; typography scale —
M6), `mocks/handlers/home.ts` (engine-backed; the `d.type === 'TI'` filters removed), `domain/types.ts` (`HomeInbox`
gains `alerts`, `approvals` items gain `requester`, `ageDays`, `reason?`, `agentReportId?`), messages, `screens.ts`.

**Rules:**
- Sections by permission (role-aware, no query fired for a section the role cannot see): งานรออนุมัติ (pending documents
  the user may approve — `doc.<T>.approve`; each row: type, number / draft, party, amount, requester, age in days, and
  actions "อนุมัติและออก" / "อนุมัติ" / "ส่งกลับแก้ไข" inline, §7.6; agent-routed items show "รออนุมัติจาก agent" with the
  review report link), ร่างของฉัน, เกินกำหนด (TI / IV / PB / EX with outstanding > 0 and due < today), กำหนดยื่นภาษี (from
  `FilingModel.dueDate` of unfinalized periods), รายการเดินบัญชีที่ยังไม่กระทบยอด (count from FN2), agent digest (posted
  today / waiting), quick actions (create TI or IV per VAT status, RC, PV, EX).
- KPI strip from the engine: cash = Σ balances of bank / cash GL accounts; AR = Σ outstanding TI + IV (+ OB AR items);
  AP = Σ outstanding PB + EX; VAT this month = output − input of the current month (VAT company only; non-VAT: card
  absent, not "0").
- Alerts: number gaps / duplicates (RP3 engine), VAT threshold (TX3, non-VAT), PB เอกสารไม่ครบ (P2), drafts older than
  30 days, depreciation due (AC6 checklist).
- One query per section (fixes "six identical retry alerts", T7): each section has its own loading / error / empty
  state; an error in one section never blanks the others.

**Invariant:** KPI AR = AR aging total at today (RP2 function), KPI AP = AP aging total; both asserted in `home.test.ts`.

- [ ] **Step 1: Failing tests** — KPI identities above; sections absent (and not queried) without permission; inline
  approve-and-issue from Home allocates a number once; one failing section shows its own error with retry while others
  render. e2e: `screenContract` Home (`both`, roles operator / accountant / admin, states empty / loading / error);
  accountant approves `exPending` from Home → it disappears from the inbox and appears issued.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(home): role-aware home with the approval inbox, alerts and engine KPIs`.

---

### Task HC2: TEAS Connect — API keys, OAuth apps, agent policy, agent review reports

**Depends on:** HC1.

**Files:** Create `frontend/src/app/(app)/settings/connect/page.tsx` (tabs คีย์ API / แอปที่เชื่อมต่อ / นโยบาย agent),
`frontend/src/records/{api-keys,oauth-apps,agent-policy}.ts`, `frontend/src/mocks/records/{api-keys,oauth-apps,agent-policy}.ts`
(+ tests), `frontend/src/mocks/engine/agent-review.ts` (+ test), `frontend/src/kit/connect/{SecretOnceDialog,AgentReportView}.tsx`,
`frontend/src/app/(app)/agent-reports/[id]/page.tsx`, `frontend/src/app/oauth/consent/page.tsx` (outside the app shell),
`frontend/e2e/connect.spec.ts`. Modify `app-shell/nav.ts` (settingsConnect → `connect.manage`), permissions
(`connect.manage` admin), messages, `screens.ts`.

**Rules:**
- API keys: create (name, kind REST / MCP, scopes = subset of the owner's permissions on this company, §8.1; expiry),
  secret shown once in `SecretOnceDialog` (copy button; never retrievable), rotate (confirm dialog; old key revoked),
  revoke (destructive confirm); list shows prefix, owner, last used, scopes count.
- OAuth apps: connected clients (name, owner, scopes, connected at), revoke; consent screen `/oauth/consent?client=…`
  (mock: fixture client "ผู้ช่วยบัญชี (AI)" requesting scopes; Approve / Deny; shows company and the owner's permissions
  the agent will be limited to).
- Agent policy (§8.4): per document type Off / Human / Auto-if-clean with amount cap (default cap 50,000.00, D-22);
  defaults T-class (TI RC CN DN) Human, N / L Auto-if-clean; a T-class type can never be set to Auto for cancel /
  reissue (§8.5 hard limits are shown read-only as a list "agent ทำไม่ได้: ปิด/เปิดงวด, ยื่นแบบภาษี, แก้การตั้งค่า …").
  Changing policy requires `connect.manage`; an agent actor is refused.
- Agent review report (§8.2): `/agent-reports/<id>` shows totals and tax (server), journal preview with rules, check
  results by severity (error / warning / info, §8.3 catalogue: duplicate within ±7 days, > 3× the party's 90-day max,
  first document for a party, posting fell back to default, date not in current month), route (auto / human), token
  expiry; linked from the agent-routed inbox items and the document's activity. The mock engine `agent-review.ts`
  computes the checks for fixture agent drafts (SP1ab `ti-002`, `ti-004` + one PV draft by the agent).

- [ ] **Step 1: Failing tests** — scopes cannot exceed the owner's permissions; secret never returned after creation;
  T-class Auto refused; review checks fire for the fixture vectors (duplicate party + amount within 7 days; 3× rule;
  first document); "posted by agent" filter (S6) still works. e2e: `screenContract` connect tabs (`both`, forbiddenRole
  accountant), agent report page (`vat`), consent page (no shell; axe clean).
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(connect): API keys, OAuth apps, agent policy and agent review reports`.

---

### Task HC3: Platform screens — login, TOTP, onboarding wizard, session expiry, profile, public PDF link

**Depends on:** HC2.

**Files:** Create `frontend/src/app/(auth)/{login,login/totp,onboarding}/page.tsx` (no app shell; D-32 mock-only),
`frontend/src/app/(app)/profile/page.tsx` (รหัสผ่าน / ยืนยันตัวตนสองขั้น / อุปกรณ์ที่เข้าสู่ระบบ / ภาษา),
`frontend/src/app/p/[token]/page.tsx` (public document link: paper only, no shell), `frontend/src/kit/auth/{SessionExpiryDialog,TotpEnrol}.tsx`
(+ tests), `frontend/src/mocks/engine/auth.ts` (+ test), `frontend/src/mocks/handlers/auth.ts`, `frontend/e2e/platform.spec.ts`.
Modify `mocks/settings.ts` (mock toolbar gains "signed out" and "session expiring" toggles), `app-shell/Topbar.tsx` (profile
link, language switch TH / EN persisted in the `locale` cookie), `kit/doc-view/ActionBar.tsx` ("คัดลอกลิงก์สาธารณะ" for
issued printable documents, `doc.<T>.read`), messages, `screens.ts`.

**Rules:**
- Login (email + password; wrong → "อีเมลหรือรหัสผ่านไม่ถูกต้อง", never which one), TOTP step (6 digits; recovery code
  link), lockout message after 5 failures (mock counter). First-run onboarding wizard (D-03): company legal identity
  (TIN checksum), VAT status, fiscal year start, chart template choice (Thai SME), first bank account, opening balance
  cut-off date → finishes on the OB wizard (AC3) — mock creates a third company `co-new` in the store and switches to
  it (removed by "รีเซ็ตข้อมูลตัวอย่าง").
- Session expiry: the toolbar toggle simulates "expiring in 2 minutes" → `SessionExpiryDialog` (stay signed in /
  sign out); expired → re-login dialog that keeps the current page and the editor's autosaved draft (no data loss).
- Profile: change password (current + new + confirm; strength rule message), TOTP enrolment (QR placeholder from a
  fixture secret + verify code + recovery codes shown once), sessions list with revoke (current session marked),
  language preference.
- Public link: `/p/<token>` renders the document paper (fixture tokens for `tiIssuedUnpaid` and `qtIssued`); unknown /
  revoked token → a plain Thai "ลิงก์นี้ใช้ไม่ได้แล้ว" page; no shell, no mock toolbar except in dev; tokens revocable from the
  document's ActionBar.

- [ ] **Step 1: Failing tests** — login error never names the wrong field; TOTP wrong code message; recovery codes
  shown once; onboarding creates a company and lands on OB; expiry dialog keeps the draft; revoked public token page.
  e2e: axe on login, TOTP, onboarding (each step), profile, public page; company switch from the switcher with a draft
  open (Review Focus 5) keeps no company-A data in company B.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(platform): login, TOTP, onboarding, session expiry, profile and public links`.

---

### Task GHC: Ham gate — Home / Connect / platform, and SP1c sign-off

- [ ] Consolidated gate green (full e2e incl. both action counts); production build / staging (O-2).
- [ ] Parity audit: walk Appendix C line by line against the group files' "Parity coverage" tables; every row is built
  or listed as dropped in SP0 §1.4 (S1). Record the ticked list in `docs/specs/` as the SP1c parity checklist (one
  file, from `_TEMPLATE.md`).
- [ ] Send Ham: Home inbox and KPIs, TEAS Connect and agent policy, platform screens, the parity checklist, open items
  O-1 … O-8, and every **Ham**-marked design decision not yet ruled (D-11, D-13 if still open).
- [ ] AskUserQuestion "SP1c mockup approve (all screens)?" — approve / approve with changes / rework. Record in
  `STATUS.md`; on approval SP1c is done and SP2 (contract freeze) starts.
