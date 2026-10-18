# SP1c group 07 — Payroll (employees, payroll runs, payslips, PIT / SSO, payroll filings)

> Part of `docs/plans/2026-10-14-sp1c-all-screens.md`. Depends on group 06 (`FilingView`). Tasks PY1 → PY3 → gate GPY.
> PIT bands, allowances, SSO rate / floor / ceiling are `[SP-R]` fixtures (values from discovery 01 Appendix A.7, which
> describes TEAS 1's code, not a ruling).

**Parity coverage (Appendix C "Payroll" + flex gaps)**

| Item | Task |
|---|---|
| employee master | PY1 |
| payroll run create / deductions / approve / post / pay; pay items (allowances, OT, bonus); multiple runs per month; recompute; void | PY1 (run + editor), PY2 (pay, payslips) |
| PIT + SSO calculation, payslips | PY2 |
| ภ.ง.ด.1, ภ.ง.ด.1ก, สปส.1-10 (file + PDF + on-screen), annual 50 ทวิ for employees | PY3 |

---

### Task PY1: Employees + payroll run editor (fourth line editor, D-11)

**Depends on:** TX3. **Review:** Opus (money).

**Files:** Create `frontend/src/records/employees.ts`, `frontend/src/mocks/records/employees.ts`,
`frontend/src/descriptors/payroll-run.ts`, `frontend/src/kit/doc-editor/PayrollGrid.tsx` (+ test),
`frontend/src/mocks/engine/payroll.ts` (+ `payroll.test.ts`), `frontend/src/mocks/fixtures/payroll-tables.ts`,
`frontend/e2e/payroll-runs.spec.ts`. Modify `records/index.ts`, `descriptors/index.ts`, `mocks/fixtures/employees.ts`
(payroll fields), `mocks/engine/{commands,ledger,vat}.ts` (PR compute path), `kit/doc-editor/{DocEditor,LineGrid}.tsx`,
`domain/types.ts` (`DocLine.employeeId`, `DocLine.pay?: PayItems`, `ComputeResult.payroll?`), `app-shell/nav.ts`
(employees → `employee.read`, payrollRuns → `doc.PR.read`), permissions, messages, `screens.ts`, `ids.ts`.

**Interfaces:**
```ts
// employee record: basePath '/payroll/employees', perms employee.read / employee.manage, detail: true
// fields: code, titleName, firstName, lastName, nationalId (tin kind: 13 digits + checksum), startDate, endDate?, salary (money),
//         bankName, bankAccountNo, ssoRegistered (bool), maritalStatus (single | married), spouseHasIncome (bool), children (int),
//         otherAllowances (money; [SP-R]), active
export interface PayItems { salary: Money; overtime?: Money; allowance?: Money; bonus?: Money; otherIncome?: Money; otherDeduction?: Money }
export interface PayslipLine { employeeId: string; name: string; gross: Money; pit: Money; sso: Money; ssoEmployer: Money;
  otherDeduction: Money; net: Money; proratedDays?: number; ytdIncome: Money; ytdPit: Money }
// ComputeResult += { payroll?: { slips: PayslipLine[]; totals: { gross: Money; pit: Money; sso: Money; ssoEmployer: Money; net: Money } } }
// payrollRun descriptor:
//   type 'PR', correctionClass 'L', vat 'both', titleTh 'รอบเงินเดือน', partyKind null, lineEditor 'payroll',
//   basePath '/payroll/runs', listColumns ['number','date','total','status'], savedViews ['draft','pending','cancelled'],
//   headerFields ['documentDate' /* pay date */, 'reference' /* period label, e.g. "ต.ค. 2569 รอบ 1" */, 'bankAccount', 'notes']
export function PayrollGrid(p: { lines: DocLine[]; onChange: (l: DocLine[]) => void; slips?: PayslipLine[] }): JSX.Element;
```
- `PayrollGrid`: one row per employee (add active employees by default when a run is created; remove / add rows),
  editable pay items; read-only server columns gross, PIT, SSO, net, YTD (from `compute.payroll`); keyboard as LineGrid.
- Engine (`payroll.ts`, A.7 `[SP-R]` values in `payroll-tables.ts`): SSO = 5 % of salary clamped to 1,650–17,500
  (max 875), employer equal; PIT ม.50(1) projected annual: projected income − 50 % expense (cap 100,000) − allowances
  (personal 60,000, spouse 60,000 when married and spouse without income, 30,000 per child, SSO paid capped 10,500) →
  bands 0 % to 150,000 then 5 / 10 / 15 / 20 / 25 / 30 / 35 %; monthly = (annual tax − YTD withheld) / remaining months
  of the year (incl. this one), half away from zero; calendar-day proration for joiners / leavers; other deductions
  capped at gross − PIT − SSO; YTD from issued runs of the year + OB payroll YTD (AC3) when the OB year = run year.
  Several runs per month allowed (flex gap); filing month = pay-date month (I11).
- Posting on issue: `[SalaryExpense, gross, 0], [SsoExpense, ssoEmployer, 0], [PitPayable, 0, pit],
  [SsoPayable, 0, sso + ssoEmployer], [SalaryPayable, 0, net]` (+ other deductions to a payable role `EmployeePayable`
  credit when used). Revise (L) regenerates payslips and reposts; cancel reverses.

**Money invariants:** per slip `net = gross − pit − sso − otherDeduction`; run journal Dr = Cr; `Σ slips = run totals`;
`GL(2170)` after pay (PY2) = Σ unpaid nets.

**Fixtures:** employees: VAT company 5 (emp-01..03 from P4 + `emp-04` พนักงานเริ่มงาน 15 ต.ค. 2569 for proration,
`emp-05` ลาออก 20 ก.ย. 2569); non-VAT 3. Runs: VAT `pr-2026-08`, `pr-2026-09` issued + paid, `pr-2026-10` draft;
`pr-bonus-09` second September run (bonus). Non-VAT `npr-2026-09` issued. Keys `prDraft`, `prIssued`, `prPaid`, `empJoiner`.

**Permissions:** accountant `employee.read`, `employee.manage`, `doc.PR.*`, `payroll.read` (no `doc.PR.approve`: PR is not in the master approval catalogue of 16 types — PY1 review 2026-10-18); operator /
admin none (admin `employee.read` only).

- [x] **Step 1: Failing tests** — `payroll.test.ts`: SSO vectors — salary 1,000.00 → base clamped to 1,650 → 82.50;
  salary 30,000.00 → base clamped to 17,500 → 875.00 (employer equal). PIT vector — single, no children, salary
  30,000.00 / month, January run, no YTD: projected 360,000 − expense 100,000 (cap) − personal 60,000 − SSO 10,500 =
  taxable 189,500 → tax (189,500 − 150,000) × 5 % = 1,975.00 → January PIT = 1,975.00 / 12 = 164.58; the same employee's
  October run with YTD PIT 1,481.22 (9 × 164.58) → (1,975.00 − 1,481.22) / 3 = 164.59 (half away from zero). Further
  vectors the implementer adds must show their derivation in a comment and assert exact satang; proration for `emp-04`
  (17 / 31 of the month); net identity per slip; second run in a month uses YTD including the first; journal balances.
  `PayrollGrid.test.tsx`: server columns never computed client-side (mocked compute values shown verbatim). e2e:
  `screenContract` employees (`both`, forbiddenRole operator), runs list / view (`both`, forbiddenRole operator); flow
  open `prDraft` → change OT of one employee → compute updates PIT / net from the server → issue.
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS**; invariants `[]`.
- [x] **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(payroll): employees and payroll runs with PIT and SSO`.

---

### Task PY2: Payslips, pay the run, payslip paper

**Depends on:** PY1.

**Files:** Create `frontend/src/kit/paper/PayslipPaper.tsx` (+ test), `frontend/src/kit/payroll/{PayRunDialog,PayslipDrawer}.tsx`,
`frontend/e2e/payroll-pay.spec.ts`. Modify `mocks/engine/{payroll,ledger,paper}.ts`, `mocks/handlers/docs-write.ts`
(`POST /docs/PR/:id/pay`), `kit/doc-view/ActionBar.tsx` (PR: "จ่ายเงินเดือน"), `kit/paper/registry.ts`, messages, `ids.ts`.

**Interfaces / rules:** pay: choose a bank / cash account (default the first active bank account; required when several
exist — parity), pay date ≥ run date in an open month; posts `[SalaryPayable, Σ net, 0], [Cash(account), 0, Σ net]`;
marks the run `settled` through a settlement link from a system "payroll payment" (link kind `settles`, `from` = a
generated payment id stored in `st.payrollPayments`); unpay = reverse (exit). Payslip drawer per row (six figures + YTD
income / PIT, ม.50(1) note). `PayslipPaper`: one A5 slip per employee (company, employee, period, items, deductions,
net, YTD), printed for all employees of a run or one.

**Money invariants:** after pay `GL(2170)` contribution of the run = 0; unpay restores.

- [x] **Step 1: Failing tests** — pay requires an account when several exist; pay journal balances; YTD on the slip =
  Σ issued runs of the year up to this one; paper prints every slip's net from the model. e2e: pay `prIssued` → status
  settled; print slips.
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(payroll): pay runs and payslips`.

---

### Task PY3: Payroll filings — ภ.ง.ด.1, ภ.ง.ด.1ก, สปส.1-10, annual 50 ทวิ

**Depends on:** PY2. **Review:** Opus (tax).

**Files:** Create `frontend/src/mocks/engine/filings/{pnd1,pnd1a,sso}.ts` (+ tests), `frontend/src/kit/paper/EmployeeWhtCertificatePaper.tsx`,
`frontend/src/app/(app)/payroll/filings/page.tsx` (tabs ภ.ง.ด.1 / ภ.ง.ด.1ก / สปส.1-10 / 50 ทวิ ประจำปี),
`frontend/e2e/payroll-filings.spec.ts`. Modify `mocks/handlers/filings.ts`, `app-shell/nav.ts` (payrollFilings →
`payroll.read`), messages, `screens.ts`.

**Interfaces / rules:** all through `FilingView` (TX1):
- ภ.ง.ด.1 (month = pay-date month, I11): per employee income + PIT from issued runs paid in the month; tie-out Σ PIT =
  GL 2153 credit movement; blocker: employee without a national id; finalize locks the month's runs' PIT fields
  (filing lock on PR with exit "แก้ไขในรอบถัดไป").
- ภ.ง.ด.1ก (year): Σ per employee for the calendar year of payment; ใบแนบ rows.
- สปส.1-10 (month): part 1 totals (employees, wages capped, employee + employer contributions), part 2 on-screen
  schedule; export "ไฟล์ส่งประกันสังคม" = fixed-width 135-char TIS-620 text per discovery 01 (the mock returns a text
  string built per the field layout `[SP-R]`; names that cannot encode → blocker naming the employee); blocker:
  company SSO employer account (10 digits) missing (ST1 field) — **the guard's exit is the link to ตั้งค่า → บริษัท**.
- Annual 50 ทวิ for employees (year): one certificate per employee (income 40(1), PIT withheld) printable
  (`EmployeeWhtCertificatePaper`, React rendition D-21).

**Invariants:** ภ.ง.ด.1ก Σ = Σ of the year's ภ.ง.ด.1 months; สปส contributions = Σ run SSO of the month.

**Fixtures:** finalized ภ.ง.ด.1 + สปส for 2026-08; 2026-09 draft; non-VAT company SSO account missing (blocker demo).
Keys `pnd1Draft`, `ssoBlocked` (non-VAT).

- [x] **Step 1: Failing tests** — tie-outs zero; 1ก = Σ months; missing SSO account blocker with exit link;
  unencodable name blocker. e2e: `screenContract` for each tab (`both`, forbiddenRole operator).
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(payroll): ภ.ง.ด.1, ภ.ง.ด.1ก, สปส.1-10 and employee 50 ทวิ`.

---

### Task GPY: Ham gate — payroll

- [x] Consolidated gate green; production build / staging.
- [x] Send Ham: employees; the payroll grid (**D-11: a fourth line editor — needs Ham's acknowledgement because SP0
  §7.1 names three**); PIT / SSO figures as `[SP-R]` fixtures; several runs per month; pay; payslips; filings.
- [x] AskUserQuestion "Payroll approve?" — approve / approve with changes / rework. Record in `STATUS.md`.
