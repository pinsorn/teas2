# SP1c group 08 — Reports (financial statements, AR / AP, summaries, audit)

> Part of `docs/plans/2026-10-14-sp1c-all-screens.md`. Depends on group 07. Tasks RP1 → RP3 → gate GRP.
> Every report is a `ReportModel` from the mock engine rendered by `ReportView` (F6). Financial statements read the GL;
> AR / AP read party-tagged GL lines plus open items (§5.3, I12). Every report has CSV export and print.

**Parity coverage (Appendix C "Reports" + flex gaps)**

| Item | Task |
|---|---|
| trial balance | F6 (done) + RP1 (dimension grouping, comparatives) |
| balance sheet (classified), P&L by BU → by dimension with comparatives and drill-down, general ledger (+ PDF / CSV) | RP1 |
| AR / AP aging with tie-out, customer statement, vendor ledger, sales summary, purchase summary, outstanding PO | RP2 |
| asset register / accumulated depreciation report | RP2 |
| number-gap and duplicate audit for every legal series, global audit-log viewer, period-reopen history, readable auditor view | RP3 |
| tax summary, WHT receivable, missing 50 ทวิ, VAT registers | TX1–TX3 (done) |

---

### Task RP1: P&L, balance sheet, general ledger (by dimension, comparatives, drill-down)

**Depends on:** PY3.

**Files:** Create `frontend/src/mocks/engine/reports/{profit-loss,balance-sheet,general-ledger,statement-lines}.ts`
(+ tests), `frontend/e2e/reports-fs.spec.ts`. Modify `app/(app)/reports/financial-statements/page.tsx` (tabs live),
`mocks/engine/reports/trial-balance.ts` (dimension grouping columns), `domain/reports.ts`, messages, `screens.ts`.

**Rules:**
- P&L (params `from`, `to`, `compare`: none / previous period / same period last year, `dimension` type to group by
  as columns): rows by class from the COA (§5.4: revenue from sales / services, other income, cost of sales, selling
  and admin, other expense, finance cost, income tax) with account rows under each, subtotals, gross profit, net
  profit; comparatives as extra columns with difference; each account row drills to GL with the same range.
  **Invariant:** net profit = Σ revenue − Σ expense = the same function CIT uses (TX3) — call it, never duplicate.
- Balance sheet (param `asOf`, `compare`): classified current / non-current assets and liabilities, equity including
  current-year profit (3300 or computed), DBD line grouping `[SP-R]` toggle. **Invariant:** total assets = total
  liabilities + equity (tie-out row; diff must be 0.00 on the seed).
- General ledger (params `account` required, `from`, `to`, `party`, `dimension`): opening balance, each line (date,
  document number link, description, party, debit, credit, running balance — running balance computed server-side),
  closing balance. **Invariant:** opening + Σ debit − Σ credit = closing (for a debit-normal account).
- TB gains `groupBy dimension` (columns per dimension value) — still balanced per column.

**Permissions:** `report.read` (accountant, admin).

- [ ] **Step 1: Failing tests** — BS balances on the seed for both companies at 2026-06-30 and today; P&L net = CIT
  function result; GL running balance identity; dimension columns sum to the total column; comparatives differences.
  e2e: `screenContract` each tab (`both`, forbiddenRole operator); drill from P&L 5110 to GL with the same range.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(reports): profit and loss, balance sheet and general ledger`.

---

### Task RP2: Receivables / payables and business summaries

**Depends on:** RP1.

**Files:** Create `frontend/src/mocks/engine/reports/{ar-aging,ap-aging,customer-statement,vendor-ledger,sales-summary,purchase-summary,outstanding-po,asset-register}.ts`
(+ tests), `frontend/src/app/(app)/reports/{receivables-payables,sales-purchases}/page.tsx` (tabs), `frontend/e2e/reports-arap.spec.ts`.
Modify `app-shell/nav.ts` (receivablesPayables → `report.arap.read`; salesPurchases → `report.arap.read`), permissions
(`report.arap.read` accountant, admin; operator? no), messages, `screens.ts`.

**Rules:**
- AR aging (`asOf`, `basis`: due date / document date — TEAS 1 aged by document date, Appendix B; default due date,
  both offered), buckets ยังไม่ถึงกำหนด / 1–30 / 31–60 / 61–90 / > 90, per customer with drill to documents; true as-of
  (outstanding as of the date from links active at that date, §5.3). **Tie-out:** Σ aging = GL 1130 at asOf (plus
  2140 deposits shown as a separate negative column, not netted). AP aging mirrors with 2110 / 1140.
- Customer statement (`party` required, `from`, `to`): opening, documents and receipts, running balance, closing;
  printable (A4) and CSV. Vendor ledger mirrors.
- Sales summary (`from`, `to`, `groupBy`: customer / item / dimension / month): net, VAT (VAT company only), total;
  purchase summary mirrors from PB / PCN / PDN.
- Outstanding PO (`asOf`, `overdueOnly`): PO lines with remaining quantity > 0 and not closed, ordered vs billed.
- Asset register (`asOf`): cost, accumulated, NBV per asset and class; tie-out to 1210 / 1211 / 1220 / 1221.

- [ ] **Step 1: Failing tests** — aging tie-out zero on the seed; as-of before a receipt shows the larger outstanding;
  bucket boundaries (exactly 30 days → 1–30); statement running balance identity; summary group totals = grand total;
  asset register tie-out. e2e: `screenContract` each tab (`both`, forbiddenRole operator).
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(reports): aging, statements, summaries, outstanding PO and asset register`.

---

### Task RP3: Audit — number gaps and duplicates, audit-log viewer, period-reopen history

**Depends on:** RP2.

**Files:** Create `frontend/src/mocks/engine/reports/{number-gaps,audit-log}.ts` (+ tests),
`frontend/src/app/(app)/reports/audit/page.tsx` (tabs เลขที่เอกสาร / บันทึกการใช้งาน / ประวัติการเปิดงวด),
`frontend/e2e/reports-audit.spec.ts`. Modify `mocks/engine/log.ts` (audit entries gain `ip: '127.0.0.1'`, `traceId`,
`client: 'web' | 'mcp' | 'api'`), `mocks/fixtures` (seed audit entries for logins, company switches, posting-rule and
tax-table changes so the viewer has content), messages, `screens.ts`.

**Rules:**
- Number gaps (`year`, `month?`, `type?`): for **every** legal series (company × type × month), list gaps (a number
  never allocated) and duplicates; cancelled numbers listed with their reason (§7.12 rule 5), never reported as gaps.
  The seed has no gaps; the test corrupts a series to prove detection.
- Audit log (`from`, `to`, `actor`, `command`, `target`): every `st.audit` entry (actor incl. "agent ของ <owner>",
  command, target link, before / after diff rendered as a field table, result); CSV export; requires `audit.read`.
- Reopen history: from `periods[].reopened` (AC6) with reason, actor, time.

- [ ] **Step 1: Failing tests** — gap detection on a corrupted series (can fail); cancelled numbers not gaps; audit
  filter by actor kind agent. e2e: `screenContract` each tab (`both`; forbiddenRole operator).
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(reports): number-gap audit, audit-log viewer and reopen history`.

---

### Task GRP: Ham gate — reports

- [ ] Consolidated gate green; production build / staging.
- [ ] Send Ham: statements by dimension with comparatives and drill-down; tie-outs on every AR / AP / asset report;
  aging basis choice (TEAS 1 used document date — Appendix B); number-gap audit over every series; audit viewer.
- [ ] AskUserQuestion "Reports approve?" — approve / approve with changes / rework. Record in `STATUS.md`.
