# SP1c group 05 — Accounting (journals, COA, opening balances, schedules, fixed assets, period close)

> Part of `docs/plans/2026-10-14-sp1c-all-screens.md`. Depends on group 04. Tasks AC1 → AC6 → gate GAC.
> All six are money / ledger tasks: Opus review for each.

**Parity coverage (Appendix C "Money and ledger", Purchases assets, flexibility gaps, SP0 §11.2 new screens)**

| Item | Task |
|---|---|
| manual journals, reverse, drafts, auto-reversing accruals, copy-as-new | AC1 |
| COA management, hierarchy | AC2 |
| opening balances (§5.10, new screen) | AC3 |
| recurring documents / templates, prepaid schedules (§5.9, new "schedules" screen) | AC4 |
| fixed-asset register, activate, dispose (issues TI for VAT co, G4), write-off; monthly depreciation with day-proration | AC5 |
| period and fiscal-year close / reopen, reopen history with reason | AC6 |

---

### Task AC1: Journal vouchers (account-line editor), reverse, accruals; journal list

**Depends on:** FN3.

**Files:** Create `frontend/src/descriptors/journal-voucher.ts`, `frontend/src/kit/doc-editor/AccountLineGrid.tsx`
(+ test), `frontend/src/kit/paper/JournalVoucherPaper.tsx`, `frontend/src/mocks/engine/journal.ts` (+ test),
`frontend/src/app/(app)/accounting/journals/page.tsx` (custom: all GL entries, not only JV), `frontend/e2e/accounting-jv.spec.ts`.
Modify `descriptors/index.ts`, `domain/types.ts` (`DocLine.accountCode/debit/credit/partyId`, `DocHeader.autoReverse`,
`ComputeResult.balance?: { debit: Money; credit: Money; diff: Money }`), `mocks/engine/{commands,ledger,invariants}.ts`,
`kit/doc-editor/{DocEditor,LineGrid}.tsx` (route `lineEditor 'account'` to `AccountLineGrid`), `kit/doc-view/LedgerTab.tsx`
("กลับรายการ" action on an entry), permissions, messages, `screens.ts`, `ids.ts`.

**Interfaces:**
- journalVoucher: `type 'JV'`, `correctionClass 'L'`, `vat 'both'`, `titleTh 'สมุดรายวันทั่วไป'`, `titleEn 'Journal voucher'`,
  `partyKind null`, `lineEditor 'account'`, `basePath '/accounting/journal-vouchers'` (nav item `journals` stays
  `/accounting/journals` = all entries; add nav item `journalVouchers` "ใบสำคัญทั่วไป" → `/accounting/journal-vouchers`,
  `doc.JV.read`), listColumns `['number','date','reference','total','status']`, savedViews `['draft','pending','cancelled']`,
  headerFields `['documentDate','reference','autoReverse','notes']`.
- Engine rules (§5.2): Σ debit = Σ credit else `doc.incomplete` "ยอดเดบิตและเครดิตไม่เท่ากัน (ต่าง x.xx)"; account postable,
  active, owned (`ledger.account_invalid`); VAT / WHT control accounts (1170, 1171, 1180, 2131–2135, 2151, 2152)
  refused (`ledger.control_account`, G4); AR / AP / employee payable (1130, 2110, 2180) need `partyId`
  (`ledger.party_required`); dimension rules per account (ST2 adds rules; until then none); period open; not future.
  JV journal = its lines verbatim; revise (L) reverses + reposts; "กลับรายการ" on any entry (JV or document) creates a
  reversing JV dated `max(original date, firstOpenDate)` (user may choose a later open date) linked `adjusts`.
  `autoReverse`: on issue also creates a draft-free reversing entry dated day 1 of next month (scheduled; the mock
  creates it immediately with `kind: 'reversal'` and date in the future month — allowed for system reversals only).
- `/accounting/journals` (custom page using `ReportView` kind `general-journal` — add to `ReportKind`): every journal
  entry of the company (documents, JV, settlements, depreciation…) with date, source document link, lines, rule; filters
  date range, account, source type; requires `ledger.read`.
- `AccountLineGrid`: columns บัญชี (account type-ahead from `/records/account`), คำอธิบาย, เดบิต, เครดิต, คู่ค้า (shown
  when the account needs a party), มิติ; balance shown from `compute.balance` (server), never summed client-side.
- `JournalVoucherPaper`: ใบสำคัญทั่วไป with lines, totals from the model, signatures ผู้จัดทำ / ผู้ตรวจ / ผู้อนุมัติ.

**Fixtures:** VAT: `jv-d1` draft unbalanced (validation fixture), `jv-1` accrued expense (Dr 5120 / Cr 2120) with
`autoReverse`, `jv-2` reclass between 5110 and 5160, `jv-rev` reversal of `jv-2`; non-VAT `njv-1`. Keys `jvDraftUnbalanced`,
`jvAccrual`, `jvIssued`.

**Permissions:** accountant + all `doc.JV.*`, `doc.JV.approve`; operator / admin none (JV is accountant-only, §3.1).

- [ ] **Step 1: Failing tests** — `journal.test.ts`: unbalanced refused with the difference; control account refused;
  AR without party refused; reverse of a TI entry creates a balanced reversing JV and does not change the TI's
  outstanding (subledger rule still holds only if the reversal carries the party — assert the reversal lines carry the
  party); auto-reverse creates the next-month reversal; `checkInvariants` `[]`. `AccountLineGrid.test.tsx`: balance
  text comes from compute. e2e: `screenContract` JV list (forbiddenRole operator), JV view (`jvAccrual`), journals page
  (`both`, forbiddenRole operator); flow create a 2-line JV with Tab / Enter only, issue, then "กลับรายการ" from the
  ledger tab.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(accounting): journal vouchers, reversals and the general journal`.

---

### Task AC2: Chart of accounts management

**Depends on:** AC1.

**Files:** Create `frontend/src/records/accounts.ts`, `frontend/src/mocks/records/accounts.ts` (+ test),
`frontend/src/kit/record-list/TreeRecordList.tsx` (+ test), `frontend/e2e/accounting-coa.spec.ts`. Modify
`records/index.ts`, `mocks/records/registry.ts`, `app-shell/nav.ts` (chartOfAccounts → `ledger.read`), permissions,
messages, `screens.ts`.

**Interfaces:** record kind `account`, `basePath '/accounting/chart-of-accounts'`, perms `ledger.read` /
`ledger.coa.manage`, `detail: false`; rendered as a tree (`TreeRecordList`: indent by `parent`, header rows bold,
collapse / expand, search keeps ancestors). Fields: `code` (4–6 digits, unique, `readOnlyAfterUse`), `nameTh`, `nameEn`,
`parent` (header accounts only), `postable` (bool), `class` (select: the 12 §5.4 classes), `subClass`,
`dbdLine` (`[SP-R]` DBD statement line code, select from fixture), `pnd50Box` (`[SP-R]`), `dimensionRules`
(per dimension type: required / optional / forbidden — read-only here, edited in ST2), `active`.
Rules (mock): class / code editable until first use (`account.in_use`); deactivate refused while a posting rule maps
it (`account.mapped`, detail names the rule and the exit "แก้ที่ ตั้งค่า → การลงบัญชี"); deactivate refused with a
non-zero balance (`account.has_balance`, exit "โอนยอดออกด้วยสมุดรายวันก่อน"); header accounts cannot be posted to;
moving an account under a header of a different class refused.

**Permissions:** accountant `ledger.coa.manage`.

- [x] **Step 1: Failing tests** — every rule above with its exit message; tree order and search keeping ancestors.
  e2e: `screenContract` COA (`both`, forbiddenRole operator); add account 5190 "ค่าใช้จ่ายเบ็ดเตล็ด" under 5000; try to
  deactivate 1130 → refusal names the posting rule.
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(accounting): chart of accounts management`.

---

### Task AC3: Opening balances wizard (OB batch)

**Depends on:** AC2.

**Files:** Create `frontend/src/descriptors/opening-balance.ts`, `frontend/src/app/(app)/accounting/opening-balances/{page,new/page}.tsx`
(custom wizard; view uses `DocViewPage`), `frontend/src/kit/opening/{ObWizard,ObTrialBalanceStep,ObOpenItemsStep,ObAssetsStep,ObPayrollYtdStep}.tsx`
(+ test), `frontend/src/mocks/engine/opening.ts` (+ test), `frontend/e2e/accounting-ob.spec.ts`. Modify descriptors,
`mocks/engine/{commands,ledger,invariants,periods}.ts`, `app-shell/nav.ts` (item `openingBalances` permission
`ledger.read` → `doc.OB.read`, required by the descriptor contract), permissions, messages, `screens.ts`, `ids.ts`.

**Period exemption (only OB):** the OB batch's date *defines* the opening, so `issue` / `revise` / `cancel` of an OB
bypass the closed-period refusal of F4 (D-10) — and no other type does (test: a JV dated 2025-12-31 is still refused).

**Interfaces:**
- openingBalance: `type 'OB'`, `correctionClass 'L'`, `vat 'both'`, `titleTh 'ยอดยกมา'`, `partyKind null`,
  `lineEditor 'account'`, `basePath '/accounting/opening-balances'`, listColumns `['number','date','total','status']`,
  savedViews `['draft']`, headerFields `['documentDate','notes']` (documentDate = cut-off).
- `Doc.opening?: { openItems: { side: 'AR' | 'AP'; partyId: string; docNumber: string; docDate: IsoDate; dueDate?: IsoDate; amount: Money }[];
  assets: { name: string; assetClass: string; cost: Money; accumulated: Money; acquired: IsoDate; lifeMonths: number }[];
  payrollYtd: { employeeId: string; income: Money; pit: Money; sso: Money }[] }`.
- Wizard steps (one page, stepper, autosaved draft): 1 งบทดลอง ณ วันตัดยอด (account lines), 2 ลูกหนี้/เจ้าหนี้คงค้างรายฉบับ,
  3 ทะเบียนสินทรัพย์, 4 ข้อมูลเงินเดือนสะสมของปี, 5 ตรวจสอบและบันทึก. Server checks (compute): Σ AR open items =
  1130 line, Σ AP = 2110 line (`ob.subledger_mismatch` showing both), Σ asset cost / accumulated = their account
  lines; any Dr ≠ Cr difference goes to `OpeningBalanceEquity` (3900) and is shown as "ผลต่างยกไปส่วนเกินทุนยอดยกมา" until
  cleared (§5.10).
- Issue: posts the batch (dated cut-off, which must be ≤ the first open month start; periods before it are closed);
  creates open-item documents of a synthetic type? → **No new type**: AR / AP open items become `IV`-like settleable
  rows: the engine stores them as `OB` sub-items with `outstanding` and the open-items endpoint returns them with
  `type: 'OB'`, `number: '<docNumber> (ยกมา)'`; RC / PV can allocate to them (`settles` gains `'OB'` for RC / PV:
  update the RC / PV descriptors and the allocation rule to accept `OB` items carrying the party). Assets create FA
  records (AC5 consumes; until AC5 the FA list is ComingInSp1c and the step stores them). Payroll YTD stored for PY2.
- Revise (L) reverses and reposts; "reverse the batch" = cancel.

**Money invariants:** OB journal Dr = Cr after the 3900 plug; `Σ AR open items = OB 1130 debit`; after a later RC
settles an OB open item, `GL(1130) = Σ outstanding(TI ∪ IV ∪ OB AR items)` (update invariant rule 4).

**Fixtures:** non-VAT company gets an issued OB at 2025-12-31 (it "started" in 2026): TB of 12 accounts, 2 AR items,
1 AP item, 1 asset, payroll YTD for 2 employees. VAT company: an OB draft (for the wizard demo) only. Keys `obIssued`
(non-VAT), `obDraft` (VAT).

**Permissions:** accountant `doc.OB.*`.

- [x] **Step 1: Failing tests** — subledger mismatch refused with both numbers; 3900 plug equals the imbalance; RC
  settling an OB AR item reduces it and keeps the AR identity; cancel reverses. e2e: `screenContract` OB list
  (`both`, forbiddenRole operator); wizard walk-through on the VAT draft ending at step 5 showing the 3900 difference.
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.** (AC3: engine written before `opening.test.ts` for the first slice - not red-first; the tests were then mutation-checked, see task-AC3-report.md)
- [ ] **Step 6: Controller commits** — `feat(accounting): opening balances wizard`.

---

### Task AC4: Schedules — recurring templates and prepaid / deferred amortisation

**Depends on:** AC3.

**Files:** Create `frontend/src/records/schedules.ts`, `frontend/src/mocks/records/schedules.ts`,
`frontend/src/mocks/engine/schedules.ts` (+ test), `frontend/src/app/(app)/accounting/schedules/[id]/page.tsx`,
`frontend/e2e/accounting-schedules.spec.ts`. Modify registry, `mocks/handlers` (`POST /schedules/:id/run`),
`kit/doc-view/ActionBar.tsx` ("ตั้งเป็นรายการซ้ำ" on QT TI IV PB JV; "ตั้งตัดจ่าย" on a PB line / JV), permissions
(`ledger.schedule.manage` accountant), messages, `screens.ts`, `ids.ts`.

**Interfaces:**
```ts
export interface ScheduleRecord { id: string; kind: 'recurring' | 'amortisation'; name: string; active: boolean;
  frequency: 'monthly' | 'quarterly' | 'yearly'; nextRun: IsoDate; endAfter?: number;          // recurring
  template?: { type: DocType; header: DocHeader; lines: DocLine[] };                           // recurring: creates DRAFTS (§5.9)
  source?: { docId: string; lineId?: string }; total?: Money; months?: number; startMonth?: string; // amortisation
  expenseAccount?: string; prepaidAccount?: string; runs: { at: IsoDate; resultDocId?: string; amount?: Money }[] }
```
Recurring: "รันตอนนี้" (mock scheduler) creates a draft of the template's type dated `nextRun` (never issues; §5.9) and
advances `nextRun`; the draft appears in Home "ร่างของฉัน". Amortisation: plan table (month, amount) from the server —
`amount_m = round(total / months)` for months 1…n−1, last month = total − Σ previous (residue in the last month);
"รันตอนนี้" posts that month's entry `[Expense, amt, 0], [prepaid account 1150, 0, amt]` as a JV-like system entry.
Missing runs show on the period-close checklist (AC6).

**Money invariants:** Σ amortisation plan = total exactly; after all runs `GL(1150)` contribution of the schedule = 0.

**Fixtures:** VAT: recurring monthly TI to pc-04 "ดูแลเว็บไซต์รายเดือน" (next run 2026-11-01); recurring JV accrual;
amortisation of an annual insurance PB line 12,000.00 over 12 months from 2026-07 (3 runs done). Non-VAT: recurring IV.
Keys `schedRecurringTi`, `schedAmortisation`.

- [ ] **Step 1: Failing tests** — plan residue in the last month; run creates a draft (not issued); amortisation run
  balances; double run in the same month refused (`schedule.already_run`). e2e: `screenContract` schedules list
  (`both`, forbiddenRole operator) and detail; run-now → a draft TI appears in the TI list's draft view.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(accounting): recurring templates and amortisation schedules`.

---

### Task AC5: Fixed assets + depreciation runs

**Depends on:** AC4.

**Files:** Create `frontend/src/descriptors/{fixed-asset,depreciation-run}.ts`, `frontend/src/mocks/engine/assets.ts`
(+ test), `frontend/src/kit/assets/{DisposeDialog,DepreciationPreview}.tsx`, `frontend/e2e/accounting-assets.spec.ts`.
Modify descriptors, `mocks/engine/{commands,ledger,invariants}.ts`, `mocks/engine/reports/` (`asset-register`),
`app-shell/nav.ts` (item `fixedAssets` stays `/accounting/fixed-assets`, permission `ledger.read` → `doc.FA.read`; add `depreciation` "ค่าเสื่อมราคา"
`/accounting/depreciation-runs` `doc.DP.read`), permissions, messages, `screens.ts`, `ids.ts`.

**Interfaces:**
- fixedAsset: `type 'FA'`, `correctionClass 'L'`, `vat 'both'`, `titleTh 'ทะเบียนสินทรัพย์'`, `partyKind 'vendor'`
  (optional), `lineEditor 'none'`, `basePath '/accounting/fixed-assets'`, listColumns `['number','date','party','total','status','marks']`,
  headerFields `['documentDate','reference','notes']` + asset header `Doc.asset?: { name; assetClass; cost: Money; salvage: Money;
  lifeMonths: number; method: 'straight_line'; startDate: IsoDate; accumulated: Money /* server */; nbv: Money /* server */;
  disposed?: { date; kind: 'sale' | 'write_off'; proceeds?: Money; tiId?: string } }`.
  Created from a PB capex line ("บันทึกเป็นสินทรัพย์") or manually; issue = activate (no journal when from a PB: the
  PB already debited FixedAsset; manual → `[FixedAsset, cost, 0], [AP or Cash per header, 0, cost]`).
- Dispose (sale, VAT company) issues a **TI** to the buyer for the proceeds (G4) through the same command:
  `[Cash/AR, proceeds + vat, 0], [AccumulatedDepreciation, acc, 0], [FixedAsset, 0, cost], [OutputVat, 0, vat],
  [DisposalGainLoss, gain or loss]`; non-VAT company: an IV. Write-off: `[AccumulatedDepreciation, acc, 0],
  [DisposalGainLoss (loss), nbv, 0], [FixedAsset, 0, cost]`. Exit for a wrong disposal: cancel the TI / IV via the
  normal flow, which reverses the disposal.
- depreciationRun: `type 'DP'`, `titleTh 'ค่าเสื่อมราคาประจำงวด'`, `lineEditor 'none'`, `basePath '/accounting/depreciation-runs'`;
  one per company-month (`dp.already_run`); content = per-asset amounts from the server: monthly =
  `round((cost − salvage) / lifeMonths)`, day-proration in the start and disposal months (`× days used / days in month`,
  half away from zero), never beyond `cost − salvage` (last run takes the remainder); posts
  `[DepreciationExpense, Σ, 0], [AccumulatedDepreciation per class, 0, …]` dated month-end; month must be open; revise
  / cancel reverses (reverse run). `DepreciationPreview` shows the table before issuing.

**Money invariants:** `accumulated ≤ cost − salvage` for every asset; `GL(1211) = Σ accumulated(equipment)`;
disposal entry balances and removes the asset's cost and accumulated exactly; the disposal TI's VAT appears in the
output VAT register (TX1).

**Fixtures:** VAT: `fa-nb` notebook from `pb-capex` (start 2026-08-15, 36 months), `fa-car` vehicle 850,000.00
(start 2025-01-01, 60 months, salvage 1.00), `fa-sold` disposed by sale 2026-09-20 (TI issued); DP runs for 2026-07,
2026-08, 2026-09. Non-VAT: the OB asset + DP runs. Keys `faActive`, `faDisposed`, `dpRun`, `dpDue` (2026-10 not run).

**Permissions:** accountant `doc.FA.*`, `doc.DP.*`.

- [ ] **Step 1: Failing tests** — proration vectors (start 15 Aug 2026 of 31 days: `round(monthly × 17/31)`), cap at
  cost − salvage, one run per month, disposal-by-sale TI totals and journal balance, write-off journal,
  `checkInvariants` `[]`. e2e: `screenContract` FA list / view, DP list (`both`, forbiddenRole operator); flow run
  October depreciation → preview → issue → FA view shows the new accumulated value.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(accounting): fixed assets, disposals with tax invoices and depreciation runs`.

---

### Task AC6: Period close / reopen and year-end close

**Depends on:** AC5.

**Carried from F4 review:** the posted-at part is **delivered in SP1c S3 fix round 3** — every journal entry now carries
`postedAt` (mock clock, set once at write, a reversal has its own), invariant 7 requires `postedAt <= closedAt` for every
entry dated in a closed period (no issuedAt / cancel / revision inference), and the L-class revise correction honours the
pinned clock like `reverseEntry`; corrupted-state tests per entry kind exist. **Remaining here:** closing a month that holds
late entries must keep `assertBalanced` green (re-verify once this task's close action exists), and `MockState.version` is
now 10.

**Files:** Create `frontend/src/mocks/engine/close.ts` (+ test), `frontend/src/app/(app)/accounting/period-close/page.tsx`,
`frontend/src/kit/close/{PeriodGrid,ChecklistPanel,ReopenDialog}.tsx` (+ tests), `frontend/e2e/accounting-close.spec.ts`.
Modify `mocks/engine/periods.ts`, `mocks/handlers` (`/periods/*`), permissions (`ledger.period.close`,
`ledger.period.reopen` accountant), messages, `screens.ts`, `ids.ts`.

**Interfaces:**
- `GET /periods?year=` → months with status, closedAt, reopen history; `GET /periods/checklist?month=` →
  `{ items: { code; severity: 'blocking' | 'warning'; count: number; labelTh: string; href: string }[] }` — codes:
  `drafts_in_month` (warning; list link), `unreconciled_bank_lines` (warning), `depreciation_not_run` (**blocking**
  when active assets exist — A.2 parity), `schedules_not_run` (warning), `filings_not_finalized` (warning; ภ.พ.30 /
  ภ.ง.ด.* of the month, TX1), `ob_difference_open` (warning).
- Close: refused while blocking items exist (`period.blocked`, exits = the items' links); closes months in order (an
  earlier open month must close first, `period.order`). Reopen: `ledger.period.reopen` + mandatory reason, audited,
  appended to the month's reopen history; reopening a month of a closed year refused until the year is reopened.
- Year-end close (all 12 months of the fiscal year closed): closing entry sweeps revenue / expense classes into
  `RetainedEarnings` (3200) via 3300 per TEAS 1 (`[revenue accounts, balance, 0] … [3200, …]`), dated the last day;
  reopening the year reverses it.

**Money invariants:** after year-end close, every revenue / expense account balance for the year = 0 and
`Δ GL(3200) = net profit of the year`; reopen restores exactly.

- [ ] **Step 1: Failing tests** — blocking checklist refuses close with exits; order rule; reopen needs reason and
  appears in history and audit; year close sweep identity; corrections in a closed month post "แก้ไขย้อนหลัง" (F4 rule
  re-checked through a UI flow). e2e: `screenContract` period close (`both`, forbiddenRole operator); close 2026-07
  with warnings acknowledged; try 2026-10 with `dpDue` → refusal with link to depreciation.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(accounting): period close checklist, reopen with reason and year-end close`.

---

### Task GAC: Ham gate — accounting

- [ ] Consolidated gate green; production build / staging.
- [ ] Send Ham: JV keyboard entry and control-account refusal (G4); reverse any entry; COA rules with exits; OB wizard
  (and the decision that OB open items are settleable OB sub-items, not a new type); schedules (drafts only, §5.9);
  assets with disposal-by-TI (G4) and proration; period close checklist + reopen history.
- [ ] AskUserQuestion "Accounting approve?" — approve / approve with changes / rework. Record in `STATUS.md`.
