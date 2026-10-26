# SP1c — Parity checklist (Appendix C audit, gate GHC)

| | |
|---|---|
| Status | Draft (2026-10-26) — for the Ham gate GHC; nothing here is ticked by Ham yet |
| Owner | Ham |
| Implements | `docs/specs/SP0-charter.md` §1.4 (dropped list), §11.2 (SP1c: parity list + new screens); plan `docs/plans/sp1c/10-home-connect.md` Task GHC bullet 2 |
| Blast cap | docs only · 1 file · no source, test, API change |

## Goal

Walk `docs/discovery/01-ui-feature-inventory.md` Appendix C (the file the master plan cites; it sits at lines 1137–1167)
line by line against the "Parity coverage" table of every group file `docs/plans/sp1c/01…10-*.md` (group 00 has no
table), then confirm each row against `frontend/src/app`, `frontend/src/descriptors`, `frontend/src/records`.
Every row is **BUILT**, **DROPPED** (SP0 §1.4), **PARTIAL** (built in part; the rest is named) or **MISSING**
(not built and not dropped — Ham decides).

Legend: **Tbl** = the row appears in a group "Parity coverage" table (`Y`) or only in the task text / code (`N`).
A page path is under `frontend/src/app/(app)/`; `[group]/[slug]` is the generic route that resolves a descriptor
(`frontend/src/descriptors/<name>.ts`) or record (`frontend/src/records/<name>.ts`) by `basePath`. Existence was checked by Glob/Grep on the tree at
commit d802a13 (HC3). This audit did not run tests or a browser.

## Totals

| Class | Rows |
|---|---|
| BUILT | 104 |
| DROPPED | 3 (FG-08 multi-currency, FG-15a email, FG-15b e-Tax; TX-08 amendments noted inside a BUILT row) |
| PARTIAL | 3 (FG-10c branches, FG-10d tax codes, FG-10g approval chains) |
| MISSING | 9 (section 1) |
| **Total** | **119** (77 parity rows + 42 flexibility-gap rows) |

---|---|
| BUILT | 105 |
| DROPPED | 3 |
| PARTIAL | 3 |
| MISSING | 7 |
| **Total** | **118** (77 parity rows + 41 flexibility-gap rows) |

---

## 1. MISSING (decide at GHC: build, defer to SP2, or add to SP0 §1.4)

None is in any group Parity table and none is in SP0 §1.4.

| ID | Appendix C item | What exists | Why it is missing | Suggested ruling |
|---|---|---|---|---|
| FG-01b | Hand-off notification ("the bell is a stub") | Topbar has no bell / notification list; Home inbox (FG-01a) is built | HC1 built the inbox only; no task owns a notification surface | Add a bell that lists the inbox count, or defer to SP2 |
| FG-05c | Bulk import and paste-from-spreadsheet | `M9` only fixes a pasted price in one cell; no multi-row grid paste, no CSV import for parties / items | No task; SP0 §7 (DocEditor) promises "paste from spreadsheet" | Build grid paste in `LineGrid` (small) and defer master-data import to SP2, or rule both out |
| FG-06a | Bulk select, batch approve / post | `kit/doc-list/BulkBar.tsx` and the row selection exist; `kit/pages/DocListPage.tsx:16` passes `bulkActions={[]}`, so no list has a bulk action | The kit was built (F3) but no group wired an action | Wire approve / print per list, or defer |
| FG-06b | List export (CSV / XLSX) of document lists | Reports export CSV (`kit/report/ReportView.tsx`); `DocList` has no export | No task; SP0 §7 lists "export XLSX" for DocList | Add CSV export to `DocList`; XLSX to SP2 |
| FG-07b | Line-level PO matching **with tolerance** | Line-level remaining quantity and strict over-conversion refusal are built (P1/S1, D-29) | D-29 deliberately omits the 105 % tolerance ("a flexibility gap, not parity") — a plan decision, not an SP0 §1.4 drop | Ham rules: tolerance setting (ST3) or drop to §1.4 |
| FG-10f | Configurable units of measure | `records/items.ts` has `unit` as a free-text required field | No task creates a unit list | Add a small unit list to ST2/ST3, or defer |
| FG-10h | Custom fields | None | No task | Rule out (SP0 §1.4) or defer to SP2 |
| FG-11b | More bank statement formats | KBiz CSV + K PLUS PDF only (FN1) | Appendix C wants more formats; FN1 scopes the two TEAS 1 formats | Defer to SP2 (format adapters are backend work) |
| FG-16 | Setup-time readiness checklist for filings (registered address, SSO employer account, payee names) | Per-filing `blockers` list in TX1 (draft documents, unfinalised prior month) and a placeholder-TIN refusal; no setup-time checklist screen | No task owns a pre-filing readiness view | Add a "ready to file" card on Home or `/tax/summary`, or defer |

---

## 2. Parity rows (Appendix C category lines)

### Sales

| ID | Appendix C item | Status | Tbl | Group · Task | Route / page file |
|---|---|---|---|---|---|
| S-01 | Quotation create / edit draft / send / accept / reject / cancel / convert to SO and TI | BUILT | Y | 02 · S1 (send = issue) | `/sales/quotations` · `descriptors/quotation.ts` |
| S-02 | Sales order create / edit / post / auto-close on delivery | BUILT | Y | 02 · S2 | `/sales/sales-orders` · `descriptors/sales-order.ts` |
| S-03 | Delivery order issue / deliver (draft edit, entry point) | BUILT | Y | 02 · S2 | `/sales/delivery-orders` · `descriptors/delivery-order.ts` |
| S-04 | Billing note with grouped TIs, non-VAT accrual, cancel | BUILT | Y | 02 · S3 | `/sales/billing-statements`, `/sales/invoices` · `descriptors/billing-statement.ts`, `invoice.ts` |
| S-05 | Tax invoice draft / edit / post / cancel / cancel-and-reissue / replacement draft discard | BUILT | Y | SP1b (done) | `/sales/tax-invoices` · `descriptors/tax-invoice.ts` |
| S-06 | Receipt applied to TIs, BNs or standalone cash bill, customer WHT with late 50 ทวิ number, cancel / reissue | BUILT | Y | 02 · S4 | `/sales/receipts` · `descriptors/receipt.ts` |
| S-07 | Credit and debit notes with reason codes (line-based) | BUILT | Y | 02 · S5 | `/sales/credit-notes`, `/sales/debit-notes` · `descriptors/credit-note.ts`, `debit-note.ts` |
| S-08 | Original / copy print tracking and reprint confirm | BUILT | Y | 02 · S6 | `kit/doc-view/ReprintDialog.tsx`, `ActionBar.tsx` |
| S-09 | Document chain rail | BUILT | Y | SP1b ChainPanel + every type | `kit/doc-view/ChainPanel.tsx` |
| S-10 | Per-document activity log and attachments (11 categories) | BUILT | Y | SP1b (activity) + 02 · S6 (attachments); list = D-30, O-6 | `kit/doc-view/ActivityTimeline.tsx`, `AttachmentsPanel.tsx` |
| S-11 | Default notes per document type | BUILT | Y | 02 · S6 (applies) + 09 · ST1 (edits) | `/settings/company` · `settings/company/page.tsx` |
| S-12 | Agent-draft approval banner | BUILT | Y | 02 · S6 | `kit/doc-view/AgentBanner.tsx`, `/agent-reports/[id]` |

### Purchases

| ID | Appendix C item | Status | Tbl | Group · Task | Route / page file |
|---|---|---|---|---|---|
| P-01 | PO create / edit / approve / mark sent / close / reopen / cancel | BUILT | Y | 03 · P1 | `/purchases/purchase-orders` · `descriptors/purchase-order.ts` |
| P-02 | Vendor invoice with claim period, recoverable VAT, product type, PO link, completeness flag | BUILT | Y | 03 · P2 | `/purchases/bills` · `descriptors/purchase-bill.ts` |
| P-03 | Payment voucher with per-line WHT, gross-up modes, foreign vendor, cheque details, VI settlement, 50 ทวิ at post | BUILT | Y | 03 · P3 | `/purchases/payment-vouchers` · `descriptors/payment-voucher.ts` |
| P-04 | WHT certificate register and print | BUILT | Y | 03 · P3 (WT) + 06 · TX2 | `/tax/wht-certificates` · `descriptors/wht-certificate.ts`; `/tax/wht` |
| P-05 | Expense claim submit / approve / reject / pay with bank selection | BUILT | Y | 03 · P4 | `/purchases/expense-claims` · `descriptors/expense-claim.ts` |
| P-06 | Fixed assets register, activate, dispose, write-off | BUILT | Y | 05 · AC5 | `/accounting/fixed-assets` · `descriptors/fixed-asset.ts`; `accounting/fixed-assets/new/page.tsx` |
| P-07 | Monthly depreciation run (day-proration) | BUILT | Y | 05 · AC5 | `/accounting/depreciation-runs` · `descriptors/depreciation-run.ts` |
| P-08 | Vendor quick-create | BUILT | Y | 01 · M2 (+ 03 `QuickBillDialog`) | `kit/` quick-create from document editors; `records/vendors.ts` |
| P-09 | (x) Post-posting correction, draft edit for PV / VI, vendor CN / DN | BUILT | Y | 03 · P2 (PCN / PDN), L-class revise on every type | `/purchases/vendor-notes`, `/purchases/vendor-debit-notes` |

### Master data

| ID | Appendix C item | Status | Tbl | Group · Task | Route / page file |
|---|---|---|---|---|---|
| M-01 | Customers (individual / corporate, VAT flag, branch, credit terms) | BUILT | Y | 01 · M1 | `/master/customers` · `records/customers.ts` |
| M-02 | Vendors (foreign, VAT-D, remittance bank) | BUILT | Y | 01 · M1 | `/master/vendors` · `records/vendors.ts` |
| M-03 | Products / services (type → VAT treatment, WHT default, usage flags, BU scope) | BUILT | Y | 01 · M2 | `/master/items` · `records/items.ts` |
| M-04 | Employees | BUILT | Y | 07 · PY1 | `/payroll/employees` · `records/employees.ts` |
| M-05 | Business units (+ require-BU rule) | BUILT (replaced by dimensions, SP0 §11.2) | Y | 09 · ST2 | `/settings/dimensions` · `records/dimensions.ts` |
| M-06 | WHT types with effective-dated rates | BUILT | Y | 09 · ST3 | `/settings/tax` · `settings/tax/page.tsx` |
| M-07 | Expense categories (x editable) | BUILT | Y | 09 · ST2 | `/settings/posting` · `records/expense-categories.ts` |
| M-08 | Chart of accounts (x hierarchy) | BUILT | Y | 05 · AC2 | `/accounting/chart-of-accounts` · `records/accounts.ts` |
| M-09 | Bank accounts | BUILT | Y | 04 · FN1 | `/finance/bank-accounts`, `/finance/bank-accounts/[id]` · `records/bank-accounts.ts` |

### Money and ledger

| ID | Appendix C item | Status | Tbl | Group · Task | Route / page file |
|---|---|---|---|---|---|
| L-01 | Manual journals (x reverse / draft) | BUILT | Y | 05 · AC1 | `/accounting/journal-vouchers` · `descriptors/journal-voucher.ts`; `accounting/journals/page.tsx` |
| L-02 | COA management | BUILT | Y | 05 · AC2 | `/accounting/chart-of-accounts` |
| L-03 | Period and fiscal-year close / reopen | BUILT | Y | 05 · AC6 | `accounting/period-close/page.tsx` |
| L-04 | Number-gap and duplicate audit | BUILT | Y | 08 · RP3 | `reports/audit/page.tsx` (tab `number-gaps`); Home alerts |
| L-05 | Bank statement import (KBiz CSV, K PLUS PDF) | BUILT | Y | 04 · FN1 | `finance/bank-accounts/[id]/page.tsx` · `kit/bank/ImportDialog.tsx` |
| L-06 | Matching | BUILT | Y | 04 · FN2 | `kit/bank/ReconcileTab.tsx` |
| L-07 | Inline journal | BUILT | Y | 04 · FN2 | `kit/bank/InlineJournalDialog.tsx` |
| L-08 | Reconciliation report | BUILT | Y | 04 · FN2 | report `bank-reconciliation` (`domain/reports.ts`), `ReconcileTab.tsx` |

### Payroll

| ID | Appendix C item | Status | Tbl | Group · Task | Route / page file |
|---|---|---|---|---|---|
| PR-01 | Employee master | BUILT | Y | 07 · PY1 | `/payroll/employees` |
| PR-02 | Payroll run create / deductions / approve / post / pay | BUILT | Y | 07 · PY1, PY2 | `/payroll/runs` · `descriptors/payroll-run.ts` |
| PR-03 | PIT + SSO calculation | BUILT | Y | 07 · PY1 / PY2 | `mocks/engine/payroll.ts`; `kit/doc-editor/PayrollGrid.tsx` |
| PR-04 | Payslips | BUILT | Y | 07 · PY2 | `kit/paper/PayslipPaper.tsx` |
| PR-05 | ภ.ง.ด.1 | BUILT | Y | 07 · PY3 | `payroll/filings/page.tsx` |
| PR-06 | ภ.ง.ด.1ก | BUILT | Y | 07 · PY3 | `payroll/filings/page.tsx` |
| PR-07 | สปส.1-10 (file + PDF + on-screen) | BUILT | Y | 07 · PY3 | `payroll/filings/page.tsx` |
| PR-08 | Annual 50 ทวิ for employees | BUILT | Y | 07 · PY3 | `payroll/filings/page.tsx` / `/tax/wht-certificates` |

### Reports

| ID | Appendix C item | Status | Tbl | Group · Task | Route / page file |
|---|---|---|---|---|---|
| RP-01 | Tax summary | BUILT | Y | 06 · TX3 | `tax/summary/page.tsx` |
| RP-02 | Trial balance | BUILT | Y | 00 · F6 + 08 · RP1 | `reports/financial-statements/financial-statements-view.tsx` |
| RP-03 | Balance sheet (x classification) | BUILT | Y | 08 · RP1 | `reports/financial-statements/` |
| RP-04 | P&L by BU (→ dimension, comparatives, drill-down) | BUILT | Y | 08 · RP1 | `reports/financial-statements/` |
| RP-05 | General ledger (+ PDF / CSV) | BUILT | Y | 08 · RP1 | `reports/financial-statements/` |
| RP-06 | AR / AP aging with tie-out | BUILT | Y | 08 · RP2 | `reports/receivables-payables/page.tsx` (tabs `ar`, `ap`) |
| RP-07 | Customer statement | BUILT | Y | 08 · RP2 | `reports/receivables-payables/` (tab `cs`) |
| RP-08 | Vendor ledger | BUILT | Y | 08 · RP2 | `reports/receivables-payables/` (tab `vl`) |
| RP-09 | Sales summary | BUILT | Y | 08 · RP2 | `reports/sales-purchases/page.tsx` (tab `sales`) |
| RP-10 | Outstanding PO | BUILT | Y | 08 · RP2 | `reports/sales-purchases/` (tab `po`) |
| RP-11 | WHT receivable | BUILT | Y | 06 · TX2 | `tax/wht/page.tsx` |
| RP-12 | Missing 50 ทวิ chase list | BUILT | Y | 06 · TX2 | `tax/wht/page.tsx` |
| RP-13 | (x) Export, drill-down, classification | BUILT (report CSV; document-list export is FG-06b) | Y | 08 · RP1 | `kit/report/ReportView.tsx` |

### Tax filings

| ID | Appendix C item | Status | Tbl | Group · Task | Route / page file |
|---|---|---|---|---|---|
| TX-01 | ภ.พ.30 (preview / finalise / PDF / `.txt`) | BUILT | Y | 06 · TX1 | `tax/vat/page.tsx` |
| TX-02 | ภ.ง.ด.2 / 3 / 53 / 54 | BUILT | Y | 06 · TX2 | `tax/wht/page.tsx` |
| TX-03 | ภ.พ.36 (PDF + JV) | BUILT | Y | 06 · TX2 | `tax/wht/page.tsx`, `accounting/journals/page.tsx` |
| TX-04 | ภ.ง.ด.51 (+ estimate) | BUILT | Y | 06 · TX3 | `tax/cit/page.tsx` |
| TX-05 | ภ.ง.ด.50 + CIT year data and adjustments | BUILT | Y | 06 · TX3 | `tax/cit/page.tsx` · `kit/filing/CitYearPanel.tsx` |
| TX-06 | ภ.พ.01 / 09 | BUILT | Y | 06 · TX3 | `tax/forms/page.tsx` |
| TX-07 | RD form catalogue | BUILT (React rendition; real PDFs = O-1) | Y | 06 · TX3 | `tax/forms/page.tsx` |
| TX-08 | Filing history (x status; amendments dropped, §1.4) | BUILT | Y | 06 · TX1–TX3 | `kit/filing/FilingHistory.tsx` |

### Platform

| ID | Appendix C item | Status | Tbl | Group · Task | Route / page file |
|---|---|---|---|---|---|
| PL-01 | Login + TOTP | BUILT | Y | 10 · HC3 | `(auth)/login/page.tsx`, `(auth)/login/totp/page.tsx` |
| PL-02 | First-run bootstrap | BUILT | Y | 10 · HC3 | `(auth)/onboarding/page.tsx` |
| PL-03 | Multi-company switching | BUILT | Y | SP1b shell + 10 · HC3 | `app-shell/CompanySwitcher.tsx` |
| PL-04 | RBAC (roles, permissions, users, separation of duties) | BUILT | Y | 09 · ST1 | `/settings/users`, `/settings/roles` · `kit/settings/PeopleRoles.tsx` |
| PL-05 | API keys + MCP + OAuth consent ("TEAS Connect") | BUILT | Y | 10 · HC2 | `settings/connect/page.tsx`, `oauth/consent/page.tsx` |
| PL-06 | Session keep-alive + expiry | BUILT | Y | 10 · HC3 | `kit/auth/SessionExpiryDialog.tsx` |
| PL-07 | TH / EN | BUILT | Y | 10 · HC3 (language preference) + shell | `profile/page.tsx`; `messages/th.json`, `messages/en.json` |
| PL-08 | Dashboard alerts (number gaps, duplicates, VAT threshold, incomplete VIs, agent drafts) | BUILT | Y | 10 · HC1 | `page.tsx` → `home-view.tsx` · `kit/home/AlertsPanel.tsx` |
| PL-09 | Company profile (logo, stamp, SSO account, default notes) | BUILT | Y | 09 · ST1 | `settings/company/page.tsx` |
| PL-10 | Per-document PDF via public token link | BUILT | Y | 10 · HC3 | `p/[token]/page.tsx`; `print/[type]/[id]/page.tsx` |

---

## 3. Flexibility gaps (Appendix C "Flexibility gaps")

PARTIAL rows: FG-10c, FG-10d, FG-10g. MISSING rows are in section 1.

| ID | Appendix C item | Status | Tbl | Group · Task | Route / page file / note |
|---|---|---|---|---|---|
| FG-01a | Human approval inbox ("waiting for me": age, requester, amount, party) | BUILT | Y | 10 · HC1 | `kit/home/InboxSection.tsx` |
| FG-01b | Hand-off notification (bell) | **MISSING** | N | — | see section 1 |
| FG-02 | Back-dating inside an open period (no future dates), number from the document date | BUILT | N | 00 foundation / D-10 | `mocks/engine/commands.ts` (`doc.future_date`, `dateGuards`), `numbering.ts:allocateNumber(…, date)` |
| FG-03a | Edit while Draft for every document | BUILT | N | SP1b + every type task | `[group]/[slug]/[id]/edit/page.tsx` |
| FG-03b | Un-approve / send-back before posting | BUILT | N | 03 · P4 | `/send-back` handler; `kit/home/InboxSection.tsx` "ส่งกลับแก้ไข" |
| FG-03c | Delete ordinary TI / RC drafts | BUILT | N | SP1b / 00 | `deleteDraft` in `mocks/engine/commands.ts`, `handlers/docs-write.ts` |
| FG-03d | Cancel for SO / DO / CN-DN | BUILT | N | 02 · S2, S5 | `doc.<T>.cancel` on each descriptor |
| FG-03e | Purchase-side cancel / reissue and vendor credit / debit notes | BUILT | Y | 03 · P2 | `/purchases/vendor-notes`, `/purchases/vendor-debit-notes` |
| FG-04 | Reversing entries (user, auto-reversing accruals), copy-as-new, drafts, templates | BUILT | Y | 05 · AC1, AC4 | `descriptors/journal-voucher.ts`; `accounting/schedules/[id]/template/page.tsx` |
| FG-05a | Recurring documents / templates | BUILT | Y | 05 · AC4 | `/accounting/schedules` · `records/schedules.ts` |
| FG-05b | Duplicate (copy as new) | BUILT | N | SP1b | `kit/pages/DocNewPage.tsx` (`?copyFrom=`), `ActionBar.tsx` "คัดลอกเป็นใบใหม่" |
| FG-05c | Bulk import / paste-from-spreadsheet | **MISSING** | N | — | see section 1 |
| FG-06a | Bulk select, batch approve / post | **MISSING** | N | — | see section 1 |
| FG-06b | List export (CSV / XLSX) | **MISSING** | N | — | see section 1 |
| FG-06c | Saved views, server-side paging and search | BUILT | N | 00 · F3 | `kit/doc-list/SavedViews.tsx`, `DocList.tsx` |
| FG-07a | One PV settling several VIs | BUILT | Y | 03 · P3 (F5 allocations) | `/purchases/payment-vouchers` |
| FG-07b | Line-level PO matching with tolerance | **MISSING** | N | D-29 | see section 1 |
| FG-08 | Multi-currency | DROPPED | — | SP0 §1.4 "Multi-currency / FX" (O-8) | not built |
| FG-09a | VAT output / input register pages | BUILT | Y | 06 · TX1 | `tax/vat/page.tsx` |
| FG-09b | Classified balance sheet; account-level P&L with comparatives and drill-down | BUILT | Y | 08 · RP1 | `reports/financial-statements/` |
| FG-09c | Accumulated-depreciation and asset-register reports | BUILT | Y | 08 · RP2 (+ AC7a) | `reports/asset-register/page.tsx` |
| FG-10a | Configurable GL-account mapping | BUILT | Y | 09 · ST2 | `/settings/posting` · `records/posting-rules.ts` |
| FG-10b | Document prefixes / series | BUILT | Y | 09 · ST3 | `settings/numbering/page.tsx` |
| FG-10c | Branches | PARTIAL | Y | 09 · ST3 | numbering series take an optional branch; company `branchCode` on `settings/company`; no branch master record |
| FG-10d | Tax codes | PARTIAL | Y | 09 · ST3 | view-only list (`settings/tax/page.tsx` `TaxCodes`); editing deferred by design (SP0 §1.6 "ยึดสรรพากร") |
| FG-10e | Expense-category defaults | BUILT | Y | 09 · ST2 | `records/expense-categories.ts` |
| FG-10f | Units of measure | **MISSING** | N | — | see section 1 |
| FG-10g | Approval chains and thresholds | PARTIAL | Y | 09 · ST3 | one amount threshold per type built (`settings/approvals/page.tsx`); chains = open item O-5 (deferred to SP2) |
| FG-10h | Custom fields | **MISSING** | N | — | see section 1 |
| FG-10i | Print templates | BUILT | Y | 09 · ST3/ST4 | `settings/templates/page.tsx` |
| FG-11a | Reconciliation: document search, split / fee / batch matching, per-bank GL attribution, complete / lock | BUILT | Y | 04 · FN2 | `kit/bank/MatchPanel.tsx`, `ReconcileTab.tsx` |
| FG-11b | More bank formats | **MISSING** | N | — | see section 1 |
| FG-12 | Payroll: pay items, multiple runs per month, recompute, void | BUILT | Y | 07 · PY1 | `kit/doc-editor/PayrollGrid.tsx` |
| FG-13a | Auth: self password change, TOTP enrolment, session list and revoke | BUILT | Y | 10 · HC3 | `profile/page.tsx`, `kit/auth/TotpEnrol.tsx` |
| FG-13b | Auth: invite / reset links | BUILT | Y | 09 · ST1 | `kit/settings/PeopleRoles.tsx` (`staffResetLink`) |
| FG-14a | Audit: global audit-log viewer | BUILT | Y | 08 · RP3 | `reports/audit/page.tsx` (tab `audit-log`) |
| FG-14b | Audit: period-reopen history with reason | BUILT | Y | 05 · AC6 + 08 · RP3 | `reports/audit/` (tab `reopen-history`) |
| FG-14c | Audit: readable auditor view | BUILT | Y | 08 · RP3 | `reports/audit/page.tsx` (`audit.read`) |
| FG-15a | Email / send of documents | DROPPED | — | SP0 §1.4 "Email sending" (D-13 of SP0; O-7) | not built; status stamp only |
| FG-15b | e-Tax pipeline | DROPPED | — | SP0 §1.4 "Direct RD integration — e-Tax Invoice" (D-02; O-7) | not built |
| FG-16 | Setup-time readiness checklist for filings | **MISSING** | N | — | see section 1 (per-filing blockers exist) |
| FG-17 | Role-aware home page | BUILT | Y | 10 · HC1 | `page.tsx` → `home-view.tsx`; sections gated by permission |

---

## 4. SP0 §11.2 new screens and §1.4 cross-check

| New screen (SP0 §11.2) | Status | Group · Task | Route |
|---|---|---|---|
| Posting profiles | BUILT | 09 · ST2 | `/settings/posting` |
| Dimensions | BUILT | 09 · ST2 | `/settings/dimensions` |
| Opening balances | BUILT | 05 · AC3 | `/accounting/opening-balances`, `/new` |
| Schedules | BUILT | 05 · AC4 | `/accounting/schedules`, `/[id]` |
| Settlement | BUILT | 04 · FN3 | `/finance/settlements`, `/[id]`; `/finance/deposits` |
| Approval inbox | BUILT | 10 · HC1 | Home |
| Agent policy | BUILT | 10 · HC2 | `/settings/connect` |

| SP0 §1.4 dropped item | Appears in Appendix C? | Treatment |
|---|---|---|
| Direct RD integration (e-Tax, e-Filing) | Yes — FG-15b | DROPPED; paper forms + RD Prep exports are built (TX) |
| Migration of TEAS 1 data | No | n/a |
| Multi-currency / FX | Yes — FG-08 | DROPPED |
| Inventory, costing, COGS | No | n/a |
| Budgets, cash-flow, equity statement | No | n/a |
| Amended returns, ภ.พ.30.2, simplified TI, ม.82/6 | Yes — TX-08 "amendments" (x) | DROPPED (no amendment screen built) |
| Email sending, dark mode, LINE | Yes — FG-15a | DROPPED |

---

## 5. Tally

Counted by script from the row tables of sections 2 and 3 (one row = one ID):

| Class | Parity (sect. 2) | Flex gaps (sect. 3) | Total |
|---|---|---|---|
| BUILT | 77 | 27 | 104 |
| DROPPED | 0 | 3 | 3 |
| PARTIAL | 0 | 3 | 3 |
| MISSING | 0 | 9 | 9 |
| **Total** | **77** | **42** | **119** |

---

## 6. Open items O-1 … O-8 (master plan, "Open items")

| ID | Item | Status at 2026-10-26 | Decided where |
|---|---|---|---|
| O-1 | RD form previews: real PDFs from a local TEAS 1 instance (§11.3) | OPEN — forms show the React rendition (D-21); no PDFs attached | Ham / controller at GHC: run TEAS 1 with the SP1c fixture parties, or waive for SP1c |
| O-2 | Coolify staging not created (SP1ab Task 16 step 4) | OPEN — local production builds used (D-31) | `STATUS.md` "Waiting on Ham" (`deploy/README.md`, `teas2-preview.kazaki-rio.com`) |
| O-3 | SP-R rulings (WHT rates, PIT bands, SSO ceiling, VAT threshold, carry-forward, CN reason wording, deposit tax point) still Partial / Disagree | OPEN — 56 points in `DECISIONS.md` unanswered; values are `[SP-R]` fixtures | `docs/research/tax/DECISIONS.md` (file lives on branch `docs/sp-r`, worktree `T2-spr`); `STATUS.md` "Waiting on Ham"; ledger carries: PP36 gross-up base, donation base / line 17, OB tax payables, CIT journal, OB 2153 / 2160 (07-payroll), 3900 / 5100 / 5120 DBD placements (05-accounting) |
| O-4 | R-08: signed combined CN vs separate CN + DN | OPEN for the SP-R rule; ADR-0002 already has mixed-direction corrections issue a separate CN and DN (Ham, group 02) | `DECISIONS.md` R-08; `STATUS.md` |
| O-5 | Approval chains beyond one amount threshold | OPEN — group 09 approved with one threshold per type; chains deferred to SP2 | Ham (GST approved; no explicit chain ruling recorded) — `docs/plans/sp1c/09-settings.md` lines 121, 151 |
| O-6 | The 11 TEAS 1 attachment categories not re-verified | OPEN — D-30 list in use; group 02 approved with it | Ham at GS (approved "Approve ทั้งหมด" 2026-10-16, no list-specific ruling recorded) |
| O-7 | Email / send and e-Tax out but listed in Appendix C | CLOSED — not built, SP0 §1.4 wins | Master plan; this file FG-15a/b |
| O-8 | Multi-currency in Appendix C flex gaps | CLOSED — not built, SP0 §1.4 wins | Master plan; this file FG-08 |

## 7. Ham-marked design decisions (**Ham** in master plan "Design decisions")

| ID | Decision | Ruling status | Where recorded |
|---|---|---|---|
| D-11 | Fourth line editor `payroll` (SP0 §7.1 names three) | RULED — acknowledged at GPY 2026-10-18 | `.superpowers/sdd/07-payroll/progress.md` line 27 |
| D-13 | Netting / deposit application / settlement differences are record kind `settlement`, not a DocType | RULED — "D-13 settlements stay records without a legal series" (Ham, group 04, 2026-10-16). SP2 may still decide a legal series | `STATUS.md` decisions 2026-10-16 |
| D-37 | OB AR / AP open items are settleable sub-items of the OB batch (type `OB`), not a new document type | NOT RECORDED individually — group 05 was approved by Ham 2026-10-17 with before-merge items (A4 catch-up etc.) and no D-37 objection; confirm at GHC | `.superpowers/sdd/05-accounting/progress.md` line 37; plan table D-37 |

Other items parked "for Ham" in group ledgers and not recorded as ruled (pick up at GHC or pass to SP2):

| Item | Where |
|---|---|
| HC2: member-owned API keys / consent (plan said `connect.manage`) | `.superpowers/sdd/10-home-connect/progress.md` line 12 |
| HC2: agent cap per document is a running total → SP2 | same |
| P4: stricter self-approval (creator + last money editor); full-tax-invoice confirmation on EX lines `[SP-R]` | `.superpowers/sdd/03-purchases/progress.md` line 22 |
| FN2/FN3: real-account go-live opening screen (later group, STATUS 2026-10-16), BankFee tolerance 100.00, WHT-typed bills cannot be settled / written off, no EX targets, P3 prepayment WHT `[SP-R]` | `.superpowers/sdd/04-finance/progress.md` lines 14, 17 |
| TX4: ภ.พ.30 "เล่มที่" left blank | `.superpowers/sdd/06-tax/progress.md` line 35 |
| AC7c: 3900→5.3, 5100→PND50 3.2 stand-in, 5120→7.18, selling vs admin split; fold placements unverified | `.superpowers/sdd/05-accounting/progress.md` line 42 |
| S5: separate CN / DN vs signed combined (R-08) | `.superpowers/sdd/02-sales/progress.md` line 34 |

## Definition of Done (SP0 §11.5)

- [ ] Parity checklist items ticked — pending Ham at GHC: rule on the 9 MISSING rows (section 1) and the 3 PARTIAL rows (section 3)
- [ ] Open items O-1 … O-6 shown to Ham; D-37 confirmed

## Verification gates

Docs only. Existence of every cited route / file was checked by Glob / Grep; no tests, builds or browser were run for this file.

## Attempt log

- 2026-10-26 — drafted from Appendix C (`docs/discovery/01-ui-feature-inventory.md` 1137–1167) against group tables 01–10.
  Group 00 has no Parity table (it builds the kit / engine every row relies on).
