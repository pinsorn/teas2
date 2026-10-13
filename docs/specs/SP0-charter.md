# TEAS 2 — SP0: Charter & Cross-Cutting Design

| | |
|---|---|
| Status | **Draft — awaiting owner review** |
| Date | 2026-10-13 |
| Owner | Ham (product owner) |
| Author | Claude (orchestrator), from the SP0 brainstorm with Ham, 2026-10-13 |
| Inputs | `docs/discovery/01`–`04` (read-only discovery of TEAS 1 v2.5.0) |
| Next step | Owner review → `writing-plans` produces the SP1 + SP-R plans and the program roadmap |

## 0. Purpose and reading rules

TEAS 2 is a ground-up re-plan of TEAS 1 (Thailand Enterprise Accounting System). This spec fixes the
decisions that every later sub-project depends on: scope, the accounting engine, the tax-compliance
core, the document framework (including editing after approval), agent posting, information architecture,
platform, and the delivery process.

- Module-level detail (tables, endpoints, screen specs) belongs to the SP2 module plans.
- **[SP-R]** marks a behaviour whose exact legal rule is confirmed by the tri-model tax research (§6.4)
  before its module freezes. The direction is decided here; the precise rule is not invented here.
- "TEAS 1 evidence" references point into `docs/discovery/`. TEAS 1 itself lives at
  `Y:\ClaudePlayground\TEAS-Project` and stays untouched.
- Changing a decision in §2 requires an ADR in `docs/adr/` and Ham's approval.

---

## 1. Charter

### 1.1 Goal

Ham, 2026-10-13: "ทุกอย่างจะยังเป็น Feature เดิม … แต่ให้มันมีความยืดหยุ่นทางบัญชี และ UX ที่ดีมากกว่านี้ …
วางแผนทุกอย่างใหม่หมด ทำ Mockup ให้เสร็จ (Mockup เหมือนจริง 100%) … Execute อย่างเป็นระบบที่สุด"

TEAS 2 = TEAS 1's feature set, rebuilt on a design that:
1. gives accountants real flexibility (chart of accounts, posting rules, dimensions, adjustments, settlement);
2. makes daily document work fast, consistent and correctable — including after approval; and
3. is delivered through a gated, spec-first process instead of ad-hoc growth.

### 1.2 Success criteria (all must hold at launch)

| # | Criterion | How it is checked |
|---|---|---|
| S1 | **Feature parity** — every item in `docs/discovery/01-ui-feature-inventory.md` Appendix C is built, or listed as dropped in §1.4 | Parity checklist ticked per module DoD |
| S2 | **Mockup fidelity** — every screen was approved by Ham as a mockup (SP1) before its backend was built; the shipped screen matches the approved mockup | Screenshot comparison in the module DoD |
| S3 | **Speed** — 1-line tax invoice for a known customer + product ≤ **5** user actions; 1-line payment voucher with WHT ≤ **6** (TEAS 1: 9 and 16) | Action-counting Playwright scripts |
| S4 | **Consistency** — every document type is rendered by the one List / Editor / View kit | Zero per-document page shells (lint/review) |
| S5 | **Correctability** — every document type has a documented correction path after issue (§7.4); no dead-end state | Correction matrix tests |
| S6 | **Compliance** — every invariant in §6.2 has a test citing its legal source; every gap fix in §6.5 has a research note with three-model agreement or Ham's ruling | Test names + `docs/research/tax/` |
| S7 | **Ledger integrity** — property tests prove Dr = Cr, subledger = GL control account, gap-free legal series, period respected, for every posting path | Property-test suite in CI |
| S8 | **Process hygiene** — one status board, one living spec per capability, no generated artifacts or debris at the repo root | Repo-layout check in CI |

### 1.3 In scope

- **Parity** with TEAS 1 v2.5.0: sales chain, purchase + WHT, expense claims, fixed assets + depreciation,
  bank statement import + reconciliation, payroll (PIT, SSO, ภ.ง.ด.1/1ก, สปส.1-10), general ledger +
  financial reports, Revenue Department (RD) PDF forms + RD Prep "Format กลาง" exports, multi-tenancy + RBAC,
  TEAS Connect (MCP / REST / OAuth / API keys), onboarding.
- **Accounting flexibility** (§5): editable chart of accounts, posting profiles, dimensions and party on
  journal lines, reversal / accrual / recurring / prepaid tooling, opening balances, flexible settlement.
- **UX** (§7, §9): fast entry, one consistent kit, correction by class after approval.
- **Tax gap fixes** G1–G4 (§6.5).
- **Agent posting** with hybrid, risk-based review (§8).
- **Multi-company membership** for every user, with per-company roles (§10.4).

### 1.4 Out of scope (Ham decisions)

| Item | Decision |
|---|---|
| Direct RD integration — e-Tax Invoice, e-Filing submission | Out (D-02). TEAS 1's inert e-Tax scaffolding is not ported. Paper forms + RD Prep exports stay. |
| Migration of TEAS 1 data | Out (D-03). Companies onboard fresh with opening balances. |
| Multi-currency / FX | Out. Currency columns exist but are THB-only. |
| Inventory, costing, COGS-on-sale | Out |
| Budgets, cash-flow statement, statement of changes in equity | Out |
| Amended returns (ยื่นเพิ่มเติม), multi-establishment VAT (ภ.พ.30.2), simplified tax invoice (ม.86/6), shared-input VAT apportionment (ม.82/6) | Out (same as TEAS 1) |
| Email sending, dark mode, LINE notifications | Out (D-13) |

### 1.5 Users

| Persona | Typical work | What they see |
|---|---|---|
| **Operator** — owner or staff, not an accountant | Sales and purchase documents, receipts and payments, expense claims, approvals | No debit/credit. Posting profiles decide the accounts. |
| **Accountant** — in-house | Journals, adjustments, period close, bank reconciliation, tax filings, posting settings | "ดู JE" (journal preview) everywhere; all accounting tools |
| **Admin** | Users, roles, company settings, numbering, agent policy | Settings |
| **Agent** — MCP / API client | Drafts documents; posts them when policy allows (§8) | Limited to its owner's permissions |

Not targeted: accounting-firm multi-client workflows, self-serve SaaS signup.

### 1.6 Owner rulings carried over from TEAS 1

| Date | Ruling | Used in |
|---|---|---|
| 2026-05-30 | "ยึดสรรพากร ไม่ใช่ admin เพิ่มมั่ว" — tax rules follow the RD; admins do not invent them | §6.6 |
| 2026-08-06 | Posted invoices, receipts and tax invoices must be correctable; cancel-and-reissue is acceptable; it must be traceable; a receipt is the only proof of payment | §7.3–7.4 |
| 2026-08-12 | A document date can be set only inside an open period, never in the future; a reissue may not change the total | §6.3, §7.3 |
| 2026-08-16 | Unavailable actions are shown disabled with the missing permission named, not hidden | §9.4 |

---

## 2. Decision log

| ID | Decision | Source |
|---|---|---|
| D-01 | Scope = feature parity with TEAS 1 v2.5.0 | Ham, 2026-10-13 |
| D-02 | No direct RD integration (no e-Tax Invoice, no e-Filing submission); keep PDF forms + RD Prep exports | Ham, 2026-10-13 |
| D-03 | Start empty — no TEAS 1 data migration; onboarding + opening-balance import | Ham, 2026-10-13 |
| D-04 | Accounting flexibility = COA + posting mapping, dimensions, adjustments + periods, flexible settlement | Ham, 2026-10-13 |
| D-05 | UX priorities = fast document creation, consistent pages, edit after approval | Ham, 2026-10-13 |
| D-06 | Users = non-accountant operators + in-house accountants | Ham, 2026-10-13 |
| D-07 | Stack = .NET 10 + PostgreSQL + Next.js 16 (16.4.0 is npm `latest` on 2026-10-13) | Ham, 2026-10-13 |
| D-08 | Every user can belong to several companies, with a role per company, and switch between them | Ham, 2026-10-13 |
| D-09 | Approach A: the mockup is the real frontend running on mock data; the .NET API replaces the mocks module by module | Ham, 2026-10-13 |
| D-10 | Fix TEAS 1 tax gaps G1–G4 (§6.5) | Ham, 2026-10-13 |
| D-11 | No CPA available: the tax oracle = tri-model research (Claude + Codex + AGY) on primary sources + golden fixtures from TEAS 1 | Ham, 2026-10-13 |
| D-12 | Approval before issue is OFF by default; a company enables it per document type | Ham, 2026-10-13 |
| D-13 | No extras beyond parity, pains and discovered smells (no email, dark mode, LINE) | Ham, 2026-10-13 |
| D-14 | Agents may post, subject to hybrid risk-based review (§8) | Ham, 2026-10-13 |
| D-15 | Accounting engine design (§5) | Ham approved section 1, 2026-10-13 |
| D-16 | Tax core, date model and oracle (§6) | Ham approved section 2, 2026-10-13 |
| D-17 | Document framework and correction classes N / L / T, filing lock (§7) | Ham approved section 3, 2026-10-13 |
| D-18 | IA and UX rules (§9) | Ham approved section 4, 2026-10-13 |
| D-19 | Platform and technology (§10), amended by D-14 | Ham approved section 5, 2026-10-13 |
| D-20 | Delivery system (§11), including `/minions` orchestrator setup in TEAS2 and a mockup preview on a Coolify staging subdomain | Ham approved section 6, 2026-10-13 |
| D-21 | License AGPL-3.0 (same as TEAS 1) | Default, not objected |

---

## 3. Glossary — canonical names

TEAS 1 suffered from one concept carrying several names (`BillingNote` = ใบแจ้งหนี้ = `/invoices` =
"INVOICE"). In TEAS 2 the names below are canonical in code, API, UI and docs. Renaming one needs an ADR.

### 3.1 Document types

| Code | Thai | English | Class (§7.3) | Ledger effect | Who uses it |
|---|---|---|---|---|---|
| QT | ใบเสนอราคา | Quotation | N | none | all |
| SO | ใบสั่งขาย | Sales order | N | none | all |
| DO | ใบส่งของ | Delivery order | N | none | all |
| BL | ใบวางบิล | Billing statement (groups invoices for collection) | N | none | all |
| IV | ใบแจ้งหนี้ | Invoice — the revenue document of a **non-VAT** company | L | AR / revenue (accrual) | non-VAT |
| TI | ใบกำกับภาษี | Tax invoice — the revenue document of a **VAT** company | T | AR / revenue / output VAT | VAT |
| RC | ใบเสร็จรับเงิน | Receipt | T | cash / AR / WHT receivable | all |
| CN, DN | ใบลดหนี้, ใบเพิ่มหนี้ | Credit note, debit note (sales) | T | reverses / adds revenue + VAT | VAT |
| PO | ใบสั่งซื้อ | Purchase order | N | none | all |
| PB | บันทึกซื้อ/ค่าใช้จ่าย | Purchase bill — our record of a vendor's invoice or tax invoice | L | expense or asset / input VAT / AP | all |
| PCN, PDN | บันทึกใบลดหนี้/ใบเพิ่มหนี้จากผู้ขาย | Purchase credit / debit note (new; TEAS 1 had none) | L | reverses / adds the purchase | all |
| PV | ใบสำคัญจ่าย | Payment voucher | L | AP or expense / cash / WHT payable | all |
| WT | หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) | WHT certificate (issued by the system on payment) | T | none (follows its PV / payslip) | all |
| EX | ใบเบิกค่าใช้จ่าย | Employee expense claim | L | expense / payable to employee | all |
| JV | สมุดรายวันทั่วไป | Journal voucher | L | any (subject to §5.2 rules) | accountants |
| FA | ทะเบียนสินทรัพย์ | Fixed-asset register entry (acquire / dispose / write-off) | L | asset / accumulated depreciation / gain-loss | accountants |
| DP | ค่าเสื่อมราคาประจำงวด | Depreciation run | L | depreciation expense / accumulated depreciation | accountants |
| PR | รอบเงินเดือน | Payroll run (with payslips) | L | salary expense / PIT / SSO / cash | accountants |
| OB | ยอดยกมา | Opening-balance batch | L | balance-sheet accounts / opening-balance equity | accountants |

Codes are document-type identifiers; the printed number format is configured per series (§5.14).

### 3.2 Terms

| Term | Meaning |
|---|---|
| Issue / post | The command that gives a document its legal number and its effects (ledger, tax, links). Used for every class. |
| Revision | A new version of an already-issued N- or L-class document, created by "แก้ไข". The number stays; the history keeps every version and the differences between them. |
| Cancel | Voids an issued document. The number is kept and never reused; ledger effects are reversed. |
| Reissue | Cancel plus a replacement document that references the original ("ยกเลิกและออกแทนฉบับเดิม …"). T-class only. |
| Correction class | N, L or T (§7.3) — decides what "แก้ไข" does after issue. |
| Posting intent | What a document asks the ledger to record: amounts tagged with accounting roles, party, dimensions, dates. Never account ids. |
| Accounting role | A semantic slot such as `AR`, `OutputVat`, `Revenue`, `Cash[bank account]` (§5.5). |
| Posting profile | Per-company rules that resolve accounting roles to accounts. |
| Party | Customer, vendor or employee, carried on journal lines. |
| Dimension | Analytic tag on documents and journal lines (e.g., แผนก, โปรเจกต์). |
| Series | A legal numbering sequence: company × document type × period scope (× branch when configured). |
| Tax point | The date the tax liability arises; for a tax invoice it equals the document date. |
| Period lock / filing lock | Closed accounting month / finalized tax return that limits what may change (§7.5). |
| Review token | Proof that an agent reviewed an exact document version before posting it (§8). |

---

## 4. Architecture overview

```
Browser ─► Next.js 16 (UI, BFF via proxy.ts, httpOnly session cookie)
              │                                   ┌──────────────┐
              ├─► /bff/* ─────────────────────────►│  Teas.Api    │◄── MCP / REST / OAuth clients
              │                                   │  (.NET 10)   │     (Traefik routes /api/v1, /mcp,
              └─► paper routes (document HTML) ◄──│              │      /oauth, /.well-known directly)
                       │                          └──────┬───────┘
                       └─► Gotenberg (Chromium) ─► PDF   │
                                                         ▼
Teas.Migrator (separate pre-deploy step) ───────► PostgreSQL 18
                                                  roles: teas_migrator (owner), teas_app (NOBYPASSRLS)
```

The exact paper-to-PDF wiring is decided by the SP1b rendering spike (§10.6); the invariant is one paper
component per document type, used for both the screen and the PDF.

Backend modules (feature folders, one owner each): **Platform** (tenancy, auth, membership, permissions,
audit, idempotency, jobs, files, clock), **Ledger** (COA, posting kernel, periods, journals, schedules,
opening balances), **Documents** (engine + descriptors + numbering), **Sales**, **Purchase**,
**Settlement & Bank**, **Assets**, **Expense**, **Payroll**, **Tax** (engines, registers, filings, RD forms,
exports), **Reports**, **Connect** (MCP, REST, OAuth, agent policy).

---

## 5. Accounting engine

### 5.1 Principle

**Documents describe business events; the ledger decides accounts.** A document never names a GL account.
It emits a posting intent; the ledger kernel resolves accounts through posting profiles, checks every
invariant, and writes the journal entry.

### 5.2 Ledger kernel — the only writer of journal entries

Every posting path (documents, journals, depreciation, payroll, bank adjustments, opening balances, closing)
calls one kernel, which enforces, inside the same transaction:

1. Σ debit = Σ credit, per entry.
2. Money at 2 decimal places; no sub-satang amount reaches the ledger.
3. The posting date's period is open (§5.8) — no caller-side checks.
4. Every account is active, postable (not a header), owned by the company, and of a class allowed for the role.
5. VAT and WHT control accounts accept postings only from tax documents and filings — a manual journal cannot
   touch them (G4). AR, AP and employee-payable control accounts accept manual journals only with a party, so the
   subledgers stay complete.
6. Dimension rules of each account (required / optional / forbidden) are satisfied.
7. Tenant: every row carries `company_id`; RLS enforces it (§10.3).

Journal entries are immutable. Correction = a reversing entry (available for **every** entry) plus, where
needed, a new entry. TEAS 1 evidence: invariants enforced on one path only (04 §0.5); reversal existed for
three document types only (02 §0.3).

### 5.3 Journal line

`account`, `debit`, `credit`, `party` (customer / vendor / employee), `dimensions` (up to 4 values),
`tax_code`, `source_document` + `source_line`, `description`, `posting_profile_rule` (which rule chose the
account). AR/AP subledgers, aging and statements are derived from the GL by party, with a true as-of date,
so they always tie out to the control accounts. TEAS 1 evidence: no party on journal lines made per-party
tie-out impossible (04 lesson 7).

### 5.4 Chart of accounts

- Per company, created from a **Thai SME template** at company creation; the same path is used by onboarding,
  tests and demo data.
- Hierarchy: header accounts (for roll-up) and postable accounts.
- Every account has a **class** and **sub-class**: current asset, non-current asset, current liability,
  non-current liability, equity, revenue from sales / services, other income, cost of sales, selling and
  administrative expense, other expense, finance cost, income tax. Financial statements are built from classes.
- **Statutory mapping as data**: each account maps to its line in the DBD financial-statement format and to the
  ภ.ง.ด.50 schedule boxes [SP-R]. TEAS 1 classified ภ.ง.ด.50 boxes by hard-coded account-code ranges (02 §0.2).
- Editing: add, rename, move, deactivate. The code and class are editable until the account is first used.
  Accounts mapped by a posting profile cannot be deactivated until unmapped.

### 5.5 Posting profiles (account determination)

Documents emit amounts tagged with accounting roles. Initial role set (module specs extend it): `AR`, `AP`,
`Revenue` (goods / services / other), `SalesDiscount`, `SalesReturn`, `OutputVat`, `InputVat`,
`InputVatUnclaimed`, `WhtReceivable`, `WhtPayable` (per form), `Pnd36VatPayable`, `Cash` (per bank account /
cash box), `CustomerDeposit`, `VendorPrepayment`, `Expense` (per category), `FixedAsset` (per asset class),
`AccumulatedDepreciation`, `DepreciationExpense`, `DisposalGainLoss`, `SalaryExpense`, `PitPayable`,
`SsoPayable`, `SsoExpense`, `SalaryPayable`, `EmployeePayable`, `BankFee`, `RoundingDifference`,
`SmallWriteOff`, `RetainedEarnings`, `OpeningBalanceEquity`.

Resolution order (first match wins): **product/service → expense category or asset class → party group →
document type → company default**. Rules are validated when saved (account class fits the role, active,
postable). Every document shows a **"ดู JE" preview before issue**, with the rule that chose each account.
TEAS 1 evidence: 23 role codes in appsettings and six string-literal bypasses (02 §0.1, A5).

### 5.6 Dimensions

- A company defines up to **4 dimension types** (defaults created: แผนก, โปรเจกต์) and their values.
- Set on the document header (default for all lines), overridable per line; values flow to journal lines.
- Account-level rules: required / optional / forbidden.
- Trial balance, P&L and GL filter and group by dimension.
- Dimensions never appear in document numbers (TEAS 1 embedded the business unit in the number and split
  legal series, 02 B1).
- Branch (สาขา, 5-digit RD branch code) remains a legal attribute of documents and is also reportable.

### 5.7 Parties and subledgers

Customers, vendors and employees are parties. Party groups feed posting profiles. Subledgers (AR, AP,
employee payables, deposits) are views over party-tagged GL lines plus open-item links from settlement (§5.11).

### 5.8 Periods and year-end

- Monthly periods per company: **Open → Closed**. Fiscal year = 12 months from the company's start month.
- Closing a month runs a checklist: unissued drafts dated in the month, unreconciled bank lines, depreciation
  not run, scheduled entries not generated, filings not finalized. Items are warnings unless a module marks
  them blocking.
- Reopen: permission `ledger.period.reopen`, mandatory reason, audited.
- Year-end close generates a closing entry into retained earnings; reopening the year reverses it.
- A correction to a document dated in a closed period posts its reversal and new entry in the current open
  period, labelled "แก้ไขย้อนหลัง" (§7.5), unless the period is reopened.

### 5.9 Adjustment tooling

| Tool | Behaviour |
|---|---|
| Journal voucher | Draft → issue; optional approval (§7.6); party and dimensions per line |
| Reverse | One click on any journal entry; choose the reversal date (default: same date if open, else first open date) |
| Auto-reversing accrual | A JV flagged "กลับรายการอัตโนมัติ" reverses on day 1 of the next period |
| Recurring | Templates for JVs and documents (monthly / quarterly / yearly); the scheduler creates **drafts** for review |
| Prepaid / deferred schedule | From a PB line or a JV: amortise over N months; the scheduler generates the monthly entries |

### 5.10 Opening balances

A wizard creates one auditable OB batch as of a cut-off date: trial balance by account; AR and AP **open items
per document** (so later receipts and payments can settle them); fixed-asset register with cost and accumulated
depreciation; payroll year-to-date per employee. The batch must balance; differences go to
`OpeningBalanceEquity` and are shown until cleared. Critical because TEAS 2 starts empty (D-03).

### 5.11 Settlement engine

- One receipt or payment can settle **many** open items (IV, TI, PB, deposits, credit notes), fully or partly.
- **Deposits and advances**: unapplied receipts and payments become `CustomerDeposit` / `VendorPrepayment`
  and are applied later. The VAT treatment of deposits follows the tax-point rules [SP-R].
- **Netting**: AR and AP of the same party can be offset (หักกลบ) with a settlement document.
- **Differences**: bank fees, satang rounding within a company tolerance, and small write-offs post to their
  roles; anything beyond tolerance needs a decision.
- **WHT at settlement**: WHT deducted by the customer (receivable, with the customer's certificate) and WHT
  we withhold (payable, issuing WT) are part of the settlement.
- Settlement status of a document is derived from settlements only — no "mark as paid" flag (Ham 2026-08-06).

### 5.12 Non-VAT companies

Same engine, same documents, **accrual always**: IV recognises revenue and AR when issued. VAT registration
changes tax codes, labels, available documents (TI / CN / DN) and filings — not the accounting model.
TEAS 1 evidence: two parallel models and cash-basis revenue paths (02 K1, 04 lesson 13).

### 5.13 Bank and cash accounts

Every bank account and cash box has its **own GL account**. Receipts, payments and bank adjustments post to
the selected account. TEAS 1 evidence: all documents posted to two global cash/bank accounts (02 A4).

### 5.14 Numbering series

- A series = company × document type × period scope (monthly or yearly) × optional branch.
- Format is configurable per series within rules: the printed number must include every scope token so that it
  is unique company-wide. Default: `{PREFIX}-{YYYYMM}-{####}`.
- Numbers are allocated at issue inside the issue transaction; cancelled documents keep their numbers; numbers
  are never reused. Gap and duplicate audit covers **every** legal series (TEAS 1 covered three).

---

## 6. Tax-compliance core

### 6.1 Boundary

The core is everything whose output is a legal document, a legal number, a statutory amount or a statutory
return. It consumes master data, tax reference data and commands; it emits documents, certificates, tax
amounts, registers, filings and **posting intents tagged with roles** — never account ids. Account choice
lives outside the core (§5.5). TEAS 1 evidence: 02 §7.

### 6.2 Invariants (each is a test that cites its source)

| # | Invariant | Source |
|---|---|---|
| I1 | VAT rate and code are derived on the server from company status, tax code and product; client values are ignored. Non-VAT company ⇒ zero VAT and no TI / CN / DN | ม.86/4, ม.85 |
| I2 | Rounding: per line, half away from zero, 2 decimals; header = Σ lines | TEAS 1 behaviour; [SP-R] confirm |
| I3 | Tax invoice contains the ม.86/4 elements; supplier and buyer snapshots are frozen at issue; buyer TIN + branch required when the buyer is VAT-registered; VAT shown separately; the label "ใบกำกับภาษี" only for VAT-registered companies | ม.86/4 |
| I4 | Legal series are sequential and gap-free; numbers allocated at issue in the issue transaction; cancelled numbers kept, never reused; gap and duplicate audit for all legal series | ม.86/4 (serial), RD practice |
| I5 | Issued legal documents are immutable (DB trigger + application); the only legal transition after issue is to Cancelled; the audit log is append-only and covers every command | ม.86/4, ม.86/9–10, Accounting Act retention [SP-R] |
| I6 | Input VAT: claim window of 6 months; vendor not VAT-registered ⇒ no input VAT; non-recoverable VAT is added to cost | ม.82/4, ม.82/5, ม.82/3 [SP-R] |
| I7 | WHT: three payer modes (deduct, gross-up once, gross-up always); one WT per income type per payment; routing to ภ.ง.ด.2 / 3 / 53 / 54; payer TIN must be real; WT PDF frozen at first render | ม.50, ม.69 ทวิ, ม.70 [SP-R] |
| I8 | Reverse charge: ภ.พ.36 at the payment month; self-assessed VAT is claimable input VAT in ภ.พ.30 (G2) | ม.83/6 [SP-R] |
| I9 | Cancel + reissue for TI and RC: the replacement keeps the original date and total and references the original. A different total requires CN / DN for a TI, or cancelling the receipt and issuing a new one for an RC. (IV is class L and is corrected by revision, §7.3) | Ham 2026-08-06, 2026-08-12; ม.86/9–10 [SP-R] |
| I10 | One finalized filing per company × form × period; every form and export refuses a placeholder TIN | TEAS 1 behaviour |
| I11 | Payroll: PIT by the ม.50(1) projected method with day proration; SSO with ceiling; filing month = pay-date month. CIT: ภ.ง.ด.50/51 ladder, SME relief, 5-year loss carry-forward | ม.50(1), ม.65, ม.65 ทวิ [SP-R] |
| I12 | Source of truth: VAT, WHT and payroll returns read **documents**; CIT and financial statements read the **GL**. A tie-out screen compares each register with its GL control account | 02 §7.3 |

### 6.3 Date model

| Field | Meaning | Rule |
|---|---|---|
| `document_date` | Date printed on the document | Settable by the user **inside an open period, never in the future** (Ham 2026-08-12) |
| `tax_point_date` | When the tax liability arises | TI: equals `document_date`. Other cases [SP-R] |
| `posting_date` | Date of the journal entry | Defaults to `document_date`; corrections in closed periods use the current open period (§5.8) |
| `due_date` | Payment due | From party payment terms; editable |
| `payment_date` | Date money moved | On RC / PV / settlement |
| `vat_claim_period` | Month in which input VAT is claimed | Within the ม.82/4 window [SP-R] |

The series month comes from `document_date`. One `IClock` / `BusinessDate` (Asia/Bangkok) is used everywhere;
direct `DateTime.Now` / `UtcNow` / `Today` is banned by an analyzer. TEAS 1 evidence: 41 "today" pins
(04 lesson 4).

### 6.4 The oracle: how tax behaviour is proven without a CPA (D-11)

1. **Tri-model research** — every legal rule the core depends on gets a note in `docs/research/tax/<rule>.md`.
   Claude, Codex and AGY research it **independently** from primary sources (ประมวลรัษฎากร, RD orders and
   rulings, the Accounting Act, DBD notifications) and record their conclusion with citations. All three agree
   → accepted. Any disagreement → Ham decides with the evidence, and the note records the ruling. Notes from
   TEAS 1 marked "UNVERIFIED" are re-researched, not copied.
2. **Golden fixtures** — a scenario set is run on a local TEAS 1 instance; outputs (journal lines, VAT and WHT
   amounts, ภ.พ.30 / ภ.ง.ด. figures) are stored as fixtures. TEAS 2 must reproduce them exactly, **except** where
   §6.5 deliberately changes behaviour — those cases carry new expected values from the research notes.
3. Research items are listed in the SP-R plan; at minimum: every [SP-R] in this spec, G1–G4, cancel and reissue,
   deposit tax point, ภ.พ.36 tax point, the 50 ทวิ "ลำดับที่" box, DBD statement format, ภ.ง.ด.50 schedule
   mapping.

### 6.5 Gap fixes (D-10)

| Group | TEAS 1 behaviour (evidence) | TEAS 2 behaviour |
|---|---|---|
| **G1** Non-VAT correct | K1: some non-VAT paths recognise revenue only on receipt. C-4: the ม.85 threshold watch counts tax invoices only, so it never fires for non-VAT companies (02 §8.C) | Accrual always (§5.12). The threshold watch counts revenue from all sales documents and warns a non-VAT company approaching the registration threshold [SP-R: threshold amount] |
| **G2** Complete ภ.พ.30 | C-1: a standalone PV with input VAT posts to the GL but never reaches ภ.พ.30. C-2: ภ.พ.36 self-assessed VAT never becomes input VAT. C-3: no credit carry-forward | A payment with input VAT must carry a purchase bill (PB) — created inline from the PV editor — so the tax invoice enters the input register. ภ.พ.36 VAT enters ภ.พ.30 input VAT. Excess input VAT carries forward [SP-R: carry-forward vs refund choice] |
| **G3** Precision | C-5: CN / DN have no cap against the original TI and use a lump amount. C-6: PV WHT rate is free-typed. C-7: ภ.พ.36 uses a literal 7 %, banker's rounding, and dates the journal at finalize day | CN / DN reference the original lines; Σ credit notes ≤ original. WHT rate comes from the WHT type in force on the payment date. ภ.พ.36 uses the VAT-rate table, half-away-from-zero rounding, and the payment month |
| **G4** Audit and GL match the returns | C-9: output VAT from asset disposals and manual journals bypasses the returns. C-10: partial audit coverage, no DB freeze for PV / WT. C-11: a draft TI cannot be deleted and blocks month close | Selling an asset issues a TI. Manual journals cannot touch VAT / WHT control accounts. Every command is audited; every issued legal document is DB-frozen. Drafts of every type can be deleted |

### 6.6 Tax reference data

VAT rates, WHT types and rates, PIT bands and deductions, SSO rate and ceiling, CIT bands, SME and VAT thresholds
are **effective-dated data**, seeded by the migrator from versioned files with source citations. Changes are
audited and permission-gated (Ham 2026-05-30: admins do not invent rules). No literals in code.

### 6.7 Statutory forms and exports

- Port the TEAS 1 RD AcroForm engine and its 17 official templates (ภ.พ.30, ภ.ง.ด.1, 1ก, 2, 3, 53, 54, ภ.พ.36,
  ภ.พ.01, ภ.พ.09, ภ.ง.ด.50, 51, 50 ทวิ, สปส.1-10 …) with template-drift detection (hash of template + widget list).
- Port RD Prep "Format กลาง" exports (ภ.ง.ด.3, ภ.ง.ด.53, ภ.พ.30) and the SSO e-Service file, with golden-string tests.
- Print-first: forms open ready to print (Ham 2026-05-31: "เมนูปริ้น ไม่ใช่ดาวน์โหลด").

---

## 7. Document framework

### 7.1 One engine, one kit; document types are descriptors

A document type is declared, not hand-built. A **descriptor** defines: header and line schema (one of three
line editors: item lines, amount lines, account lines), numbering series, lifecycle, approval policy,
correction class, posting rule (→ posting intent), tax behaviour, paper template, allowed conversions, required
permissions, MCP tool exposure and agent policy defaults. Adding a type means adding a descriptor and its paper
template — not copying a service. TEAS 1 evidence: the lifecycle was re-implemented 11 times (04 §4.4).

### 7.2 Lifecycle

`Draft → [Pending approval → Approved] → Issued → [Partly settled → Settled] → Cancelled | Replaced`

| Command | From | Effect |
|---|---|---|
| Create / edit draft | — / Draft | No number; autosaved; idempotent create |
| Delete draft | Draft | Allowed for **every** type (no number was consumed) |
| Submit / approve / send back | Draft / Pending | Only when approval is enabled for the type (§7.6) |
| Issue (บันทึกและออก) | Draft or Approved | Number + effects in one transaction; one step from the editor; never leaves an orphan draft |
| Edit (แก้ไข) | Issued | Behaviour by class (§7.3) |
| Cancel | Issued | Reason code + text; reversal; number kept |
| Reissue | Issued (T) | Cancel + replacement referencing the original |
| Convert | per descriptor | Creates the target document carrying **all** applicable data and the link |
| Duplicate (คัดลอกเป็นใบใหม่) | any | New draft from an existing document |

### 7.3 Correction classes — one "แก้ไข" button, three behaviours

| Class | Documents | "แก้ไข" after issue |
|---|---|---|
| **N** — commercial, no ledger effect | QT, SO, DO, BL, PO | Edit in place → new revision with a visible diff; the print shows "ฉบับแก้ไขครั้งที่ n". If downstream documents exist, warn and list them. Number unchanged. |
| **L** — ledger effect, not a statutory tax document | IV, PB, PCN, PDN, PV, EX, JV, FA, DP, PR, OB | Edit → new revision → the engine **reverses the previous journal entry and posts the new one** (in the original period if open, otherwise in the current open period labelled "แก้ไขย้อนหลัง"). Number unchanged. If WHT changed, the old WT is cancelled and a new WT issued automatically. |
| **T** — statutory tax / legal document | TI, RC, CN, DN, WT | **Non-fiscal fields** (notes, attachments, internal reference, dimensions, due date, payment terms) edit in place with audit. **Fiscal fields** (party tax identity, lines, amounts, date): same total → guided cancel + reissue; different total → the engine proposes CN / DN with a reason code. All from the same "แก้ไข" button, with a panel explaining what will happen. |

### 7.4 Correction matrix (minimum guarantee per type)

| Type | Draft | After issue: edit | Cancel | Other exits |
|---|---|---|---|---|
| QT, SO, DO, BL, PO | edit / delete | revision (N) | yes, with reason | convert, duplicate, close (PO) |
| IV | edit / delete | revision (L) | yes; blocked while settlements exist → exit: un-apply them first | duplicate |
| TI | edit / delete | non-fiscal edit; reissue; CN / DN | yes; blocked while a receipt is applied → exit: cancel / reissue the receipt first | duplicate |
| RC | edit / delete | non-fiscal edit; reissue | yes; blocked when bank-reconciled → exit: unmatch first | — |
| CN, DN | edit / delete | non-fiscal edit; reissue | yes | — |
| PB, PCN, PDN | edit / delete | revision (L), subject to filing lock | yes | PCN / PDN for vendor-issued corrections |
| PV | edit / delete | revision (L), WT re-issued if WHT changed | yes (reversal; WT cancelled) | — |
| EX | edit / delete | revision (L) | yes | send back |
| JV | edit / delete | revision (L) or reverse | reverse | duplicate |
| FA, DP | edit / delete | revision (L) | reverse run (DP) / cancel (FA) | dispose, write-off |
| PR | edit / delete | revision (L); payslips regenerated | yes | — |
| OB | edit / delete | revision (L) | reverse the batch | — |
| WT | n/a (system) | follows its PV / PR | follows its PV / PR | reprint |

### 7.5 Locks — always shown, always with an exit

| Lock | Trigger | Effect | Exit shown to the user |
|---|---|---|---|
| Period lock | Month closed | Corrections post in the current open period | Reopen (permission + reason) or post as "แก้ไขย้อนหลัง" |
| **Filing lock** | ภ.พ.30 / ภ.ง.ด.1 / 2 / 3 / 53 / 54 / ภ.พ.36 finalized for the period | Fiscal fields of the documents feeding that filing are locked | CN / DN or PCN / PDN in a later period |
| Settlement lock | Document has settlements applied | Amount cannot drop below the settled amount | Un-apply the settlement first |
| Reconciliation lock | Payment matched to a bank line | Amount / date / account locked | Unmatch first |

The UI never hides a blocked action: it shows "🔒 ล็อกเพราะ … — ทำได้: …" with permission-aware actions; an
action the user lacks permission for is disabled with the missing permission named.

### 7.6 Approval policy

Off by default for every type (D-12). A company enables approval per document type, optionally above an amount.
When enabled: an **approval inbox** on Home; a user holding both approve and issue permissions can approve and
issue in one action; the creator may approve their own document unless the company disables self-approval.
Editing an approved, not-yet-issued document sends it back to Draft.

### 7.7 Conversions

QT → SO → DO → TI / IV; QT → TI / IV; SO → TI / IV; TI / IV → BL; TI / IV → RC; TI → CN / DN;
PO → PB → PV; PO → PV; PB → PCN / PDN; EX → PV. Conversions carry party, lines, prices, tax codes, dimensions,
notes, WHT defaults and the link; partial conversions track remaining quantities.

### 7.8 Command pipeline (backend)

Authorize → validate → idempotency claim → row lock / version check → state transition → numbering → posting
intent → ledger kernel → audit record → outbox, all in **one transaction**. Concurrency: version tokens on every
document, advisory locks on series allocation, typed 409 responses. TEAS 1 evidence: idempotency redesigned three
times; save and audit in separate transactions on three paths (04 §3 #7, §7.5).

### 7.9 UI kit (one of each)

| Component | Behaviour |
|---|---|
| **DocList** | Server-side paging, filters, saved views, bulk actions (approve, print, export XLSX), status chips; an error is never shown as "no data" |
| **DocEditor** | Party and item **type-ahead in the field** (no modal); keyboard line grid (Tab / Enter, paste from spreadsheet); live totals and tax; "ยังขาดอะไร" summary; attachments while creating; autosave + unsaved-changes guard; paper preview as a toggle drawer (closed by default below 1700 px); "ดู JE" drawer |
| **DocView** | Paper view (identical to the print); status timeline; related-document chain; ledger effect; activity and notes; attachments; one action bar: primary action + "แก้ไข" + more |
| **ConfirmIssue** | One dialog for every number-consuming or irreversible action, showing the totals |
| **LockBanner** | §7.5 |

### 7.10 Fast entry

- Targets: §1.2 S3.
- Keyboard: `Ctrl+Enter` issue; `Ctrl+S` save draft; `/` focus search; `N` new document on list pages; `⌘K` /
  `Ctrl+K` command menu.
- Defaults chain: party (payment terms, WHT type, dimensions, usual items) → item (price, unit, tax code, WHT type,
  posting role) → the party's last document.
- Reuse: duplicate, recurring documents (§5.9), complete conversions (§7.7).
- Approval inbox and inline approve-and-issue (§7.6).

---

## 8. Agent posting — hybrid risk-based review (D-14)

### 8.1 Identity and scope

An agent connects with an API key or an OAuth 2.1 client, bound to one owner user and one company. Its scopes are
a subset of the owner's permissions on that company. Every action records the agent identity and its owner.

### 8.2 Review → token → post

1. The agent creates or edits a draft.
2. The agent calls `review(document)`. The server returns: computed totals and tax, the journal preview with the
   rules that chose each account, the check results (§8.3), the policy route (§8.4) and a **review token** bound
   to (document id, document version, report hash, 15-minute expiry).
3. The agent calls `post(document, review_token)`. The server re-runs every check; if the document changed, the
   token expired, or a check now fails, the post is refused.
4. Route `auto` → the document is issued, attributed to the agent and its owner. Route `human` → the document moves
   to "รออนุมัติจาก agent" in the approval inbox with the review report attached; a human approves (and issues) in
   one action.

### 8.3 Checks (initial catalogue; module specs extend it)

| Severity | Examples |
|---|---|
| Error — blocks posting | Period closed; filing lock; missing buyer TIN / branch for a VAT buyer; WHT type missing where WHT applies; posting-profile resolution failed; any §5.2 invariant |
| Warning — routes to a human | Possible duplicate (same party and amount within ±7 days, or same vendor document number); amount above the party's usual range (> 3× the party's 90-day maximum); first document for a new party; posting profile fell back to the company default; document date not in the current month |
| Info | Totals, tax, journal preview |

### 8.4 Policy

Per company, per document type: **Off | Human | Auto-if-clean (with amount cap)**.
Defaults: T-class documents (TI, RC, CN, DN) → **Human**; N- and L-class → **Auto-if-clean, cap 50,000 THB per
document**; any warning or a cap breach → Human. The policy and the cap are company settings (ตั้งค่า → บริษัท →
Agent policy), changed by an admin per company; 50,000 THB is only the starting value (Ham, 2026-10-13).

### 8.5 Hard limits — agents never

Close or reopen periods; finalize tax filings; change settings, permissions, posting profiles, numbering or agent
policy; cancel or reissue T-class documents without a human; act on another company.

### 8.6 Oversight

A "posted by agent" filter on every list and a daily digest on Home. A company switch disables agent posting
instantly; revoking a key stops the agent. Every agent-posted document can be corrected with the normal correction
tools (§7.3).

---

## 9. Information architecture and UX

### 9.1 Navigation

| Group | Items |
|---|---|
| **หน้าหลัก** | "งานของฉัน": approval inbox, my drafts, overdue items, tax deadlines, unreconciled bank lines, agent digest; KPI strip (cash, AR, AP, VAT this month) |
| **ขาย** | ใบเสนอราคา · ใบสั่งขาย · ใบส่งของ · ใบแจ้งหนี้ / ใบวางบิล · ใบกำกับภาษี · ใบเสร็จรับเงิน · ใบลดหนี้ / ใบเพิ่มหนี้ |
| **ซื้อ** | ใบสั่งซื้อ · บันทึกซื้อ/ค่าใช้จ่าย · ใบสำคัญจ่าย · ใบลด/เพิ่มหนี้ผู้ขาย · ใบเบิกค่าใช้จ่าย |
| **การเงิน** | บัญชีธนาคาร (import statement + reconcile from one place) · มัดจำ / เงินล่วงหน้า |
| **บัญชี** | สมุดรายวัน · ผังบัญชี · ยอดยกมา · รายการซ้ำ / ตัดจ่าย · สินทรัพย์และค่าเสื่อม · ปิดงวด / ปิดปี |
| **ภาษี** | สรุปภาษีรายเดือน · ภ.พ.30 + ทะเบียนภาษีซื้อ/ขาย · หัก ณ ที่จ่าย (50 ทวิ, ภ.ง.ด.2/3/53/54, ภ.พ.36) · ภ.ง.ด.50/51 |
| **เงินเดือน** | พนักงาน · รอบเงินเดือน · ภ.ง.ด.1/1ก · สปส.1-10 |
| **รายงาน** | งบการเงิน (TB / P&L / BS / GL, by dimension) · ลูกหนี้ / เจ้าหนี้ (aging, statements) · สรุปขาย / ซื้อ · ตรวจสอบ (number gaps, audit log) |
| **ข้อมูลหลัก** | ลูกค้า · ผู้ขาย · สินค้า/บริการ |
| **ตั้งค่า** | บริษัท · ผู้ใช้และสิทธิ์ · การลงบัญชี · มิติ · ภาษี · เลขที่เอกสาร · การอนุมัติ · แม่แบบเอกสาร · TEAS Connect |

Items the user has no permission for are hidden; VAT-only items are hidden for non-VAT companies.
TEAS 1 evidence: 51 flat items and a 20-item "Reports" group mixing five kinds of things (01 §1.2).

### 9.2 Shell

Company switcher at the top of the sidebar for every user; `⌘K` command menu (find a document by number or party,
create a document, go to a page); breadcrumbs that show document numbers and are links; a distinct page title per
tab; no notification bell — work arrives in the Home inbox.

### 9.3 UX rules

1. Never show what is not wired.
2. A disabled action says why (missing permission, lock, missing data).
3. Every number-consuming or irreversible action is confirmed with its totals.
4. One intent, one button.
5. Suggest; do not make users classify.
6. Screen = paper.
7. Every mistake has a way back (§7.3–7.5).
8. Errors are Thai, specific, and say how to fix them — never raw keys or empty toasts.
9. Non-VAT is a complete product, not VAT with parts hidden.
10. Every screen designs loading, empty, error, forbidden and locked states, distinct from each other.
11. Daily documents are fully keyboard-operable.
12. Thai first: Buddhist-era dates, baht in words ("…บาทถ้วน"), Thai number formats; English as second language.

### 9.4 Responsive

Desktop first. At ≥ 390 px wide: view documents, approve, and create an expense claim with a photo of the receipt.

### 9.5 Visual direction

Not decided here. SP1a presents 2–3 style tiles; Ham picks one before screen work starts.

---

## 10. Platform and technology

### 10.1 Pinned stack

| Layer | Choice |
|---|---|
| Backend | .NET 10 (SDK 10.0.x), ASP.NET Core Minimal APIs, EF Core 10 + Npgsql |
| Database | PostgreSQL 18 |
| Frontend | Next.js 16.4 (App Router, Turbopack, `proxy.ts` as BFF), React 19.2, TypeScript, Tailwind CSS v4, shadcn/ui (Radix), TanStack Query + Table (server-side), React Hook Form + Zod, next-intl |
| AI tooling for workers | Next.js `AGENTS.md` (bundled docs under `node_modules/next/dist/docs/`), `next-devtools-mcp` |
| Mock layer (SP1) | MSW + typed fixtures |
| PDF | Gotenberg (Chromium) for documents [spike-gated]; ported RD AcroForm engine for statutory forms |
| Auth server | OpenIddict (OAuth 2.1 + PKCE) |
| MCP | ModelContextProtocol.AspNetCore |
| Tests | xUnit, Vitest, Playwright |

Exact package versions are pinned when each part is scaffolded: the frontend in SP1b, the backend in SP3.

### 10.2 Solution layout

`Teas.Domain` (pure: money, tax engines, document rules — ported calculators keep their tests) · `Teas.App`
(modules: commands, queries, EF mappings) · `Teas.Api` (host, endpoints, auth, MCP) · `Teas.Migrator`
(migrations + catalog sync). No file above ~600 lines without a reason recorded in review. TEAS 1 evidence:
2,244-line MCP file, 2,378-line FE query file (04 §4.4).

### 10.3 Data and tenancy

- Roles: `teas_migrator` owns the schema; `teas_app` (NOBYPASSRLS) is used by the app, **the tests and CI**.
- `company_id` on every tenant row, including line tables; FORCE RLS policies generated by one helper; a CI check
  fails if a table is neither tenant-scoped nor on an explicit allow-list.
- `TenantScope.Enter(companyId)` / `EnterSystem(reason)` for jobs and system work; raw `set_config` is banned.
- Schema changes only through EF migrations; catalogs (permissions, role templates, tax reference data, COA
  templates) are synced idempotently by the migrator; the API refuses to start on a schema-version mismatch.

TEAS 1 evidence: ≥ 11 prod-only RLS incidents because dev and tests ran as superuser; 111 SQL scripts run at
every boot (03 §0.1, 04 lesson 1–2).

### 10.4 Auth, membership, permissions

- BFF session cookie (httpOnly); the browser never holds a token.
- Compact access token: user, active company, permission version. Permissions resolved on the server and cached.
- Rotating refresh tokens; logout revokes.
- **Membership**: a user has a role per company; any member switches companies (audited); the token carries the
  active company.
- Self-service password change; TOTP MFA with enrolment and recovery codes.
- **One permission catalog in code** generates DB rows, frontend gates, MCP scopes and documentation; the Cartesian
  role × endpoint test is kept.

### 10.5 API conventions

One error contract (problem+json with a stable `code`, `traceId`, `fieldErrors`; codes in a registry with Thai and
English messages); cursor pagination; camelCase; **OpenAPI generated from .NET → TypeScript client generated from
it → `tsc` catches contract drift**; generic idempotency records written inside the command transaction. Browser
traffic goes through the BFF (`/bff/*`); Traefik routes the public machine surface — `/api/v1`, `/mcp`, `/oauth`,
`/.well-known` — straight to the API. Internal API routes are not exposed publicly.

### 10.6 Rendering

One paper component per document type renders the screen view and, through Gotenberg, the PDF. The SP1b spike must
prove, before mockup sign-off: a multi-page Thai tax invoice with the table header repeated on every page,
"หน้า x/y", and the signature block on the last page. If the spike fails, the fallback is QuestPDF with an image
preview, and §7.9 "screen = paper" is met by showing the rendered image.

### 10.7 Jobs, files, observability, clock

- Jobs: a Postgres job table with advisory-lock leadership; every job is tenant-scoped and its result is visible.
  Uses: recurring documents and journals, accrual reversals, prepaid schedules, inbox deadline items,
  idempotency-record cleanup.
- Files: storage interface; Coolify volume with backup (ponytail: local volume; object storage when instances > 1).
- OpenTelemetry logs and traces; `/health/live`, `/health/ready` (DB), unauthenticated `/version`.
- `IClock` / `BusinessDate` (Asia/Bangkok) everywhere (§6.3).

### 10.8 Testing

| Layer | What |
|---|---|
| Domain unit | Tax engines, money, rounding, document rules — fast, no DB |
| Integration | Each test class gets a clone of a migrated template database, as `teas_app`; parallel; a missing database **fails** the run (no silent skips) |
| Golden fixtures | §6.4 |
| Property tests | Dr = Cr, subledger = GL, gap-free series, period respected, for every posting path |
| Blind acceptance | Written from the spec by a separate worker for money modules |
| E2E | Playwright against the composed stack in CI, including the action-count scripts of S3 |
| RBAC | Cartesian role × endpoint matrix generated from the catalog |

Locally the template database lives on the developer PostgreSQL 18; in CI it is a service container.

### 10.9 CI/CD and environments

GitHub Actions on Linux: build, unit + integration, contract check, lint, compose smoke (migrator → api → web), e2e.
Environments: local → CI → **staging** (Coolify, also hosts the SP1 mockup preview) → prod (Coolify, new app and
database). release-please + conventional commits; one version source stamped by CI. `.gitattributes` enforces LF.
Scheduled off-box database backups and a restore drill before launch.

---

## 11. Delivery system

### 11.1 Repository layout and hygiene

```
README.md  CLAUDE.md  STATUS.md  CHANGELOG.md (generated)  LICENSE
docs/discovery/     TEAS 1 discovery (frozen)
docs/specs/         one living spec per capability (template: status, blast cap, DoD)
docs/plans/         implementation plans
docs/adr/           one short file per decision after SP0
docs/research/tax/  tri-model research notes
troubles-wiki.md    symptom → cause → fix (starts empty)
backend/  frontend/  deploy/  .github/
```

Never committed: screenshots, logs, generated sites, build output, local env files. TEAS 1 evidence: ~60 % of
tracked files were docs or test evidence, plus root debris (04 §4.1).

### 11.2 Sub-projects and gates

| SP | Work | Gate |
|---|---|---|
| **SP0** | This spec | Ham approves the spec |
| **SP1a** | 2–3 style tiles | Ham picks one |
| **SP1b** | Design system, app shell, DocList / DocEditor / DocView kit, **TI end-to-end** on mock data, rendering spike | Ham approves the pattern; spike passes |
| **SP1c** | Every screen from the parity checklist plus the new screens (posting profiles, dimensions, opening balances, schedules, settlement, approval inbox, agent policy), for a VAT and a non-VAT company, every state, every role | Ham approves per module group |
| **SP-R** | Tri-model tax research + golden fixtures from TEAS 1 — runs **in parallel with SP1** (research, no product code) | Three-model agreement or Ham's ruling per rule |
| **SP2** | Contract freeze (TypeScript types per module) + detailed implementation plan per module | Ham approves the plans |
| **SP3** | Platform foundation | CI gates |
| **SP4.x** | Modules in dependency order (§11.4) | DoD (§11.5) + verification tiers (§11.6) + demo to Ham |
| **SPz** | Hardening, Tier-4 live acceptance on staging with realistic data, launch | Ham's go |

### 11.3 Mockup specifics (SP1)

- Built in `frontend/` as the real application; data from MSW handlers over typed fixtures.
- Fixtures: two fictional companies — one VAT-registered, one non-VAT — with realistic Thai data (customers,
  vendors, items, a year of documents). Names are fictional; TINs are checksum-valid fictional numbers; no real
  people or businesses.
- A mockup toolbar switches company (VAT / non-VAT), role (operator / accountant / admin) and screen state (normal,
  empty, loading, error, forbidden, locked).
- A screen index page lists every screen and state for review.
- Deployed to a Coolify staging subdomain so Ham can review on desktop and phone.
- RD form previews use real PDFs generated by a local TEAS 1 instance from fixture data.

### 11.4 Module order

1. **SP3 Platform** — repo + CI, tenancy and RLS harness, migrator, auth + membership, permission catalog, error
   contract, idempotency, audit, clock, files, job skeleton, OpenAPI → TS pipeline, API keys + MCP host + tool
   generator.
2. **SP4.1 Ledger** — COA + template, posting kernel, posting profiles, dimensions, party, periods, JV + reverse,
   TB / GL basics.
3. **SP4.2 Masters + document engine** — customers, vendors, items, bank accounts, numbering series, descriptor
   engine, UI kit wiring, attachments, notes, activity.
4. **SP4.3 Sales** — QT, SO, DO, IV, TI, BL, RC, CN / DN, cancel / reissue, AR settlement, VAT output engine.
5. **SP4.4 Purchase** — PO, PB, PCN / PDN, PV, WHT engine + WT, ภ.พ.36, AP settlement, expense claims.
6. **SP4.5 Settlement and bank** — deposits and advances, netting, differences, bank import (KBank CSV, K-Plus PDF),
   reconciliation.
7. **SP4.6 Assets and schedules** — fixed assets, depreciation, disposal (with TI), recurring documents and
   journals, accruals, prepaid schedules.
8. **SP4.7 Payroll** — employees, runs, payslips, PIT, SSO, ภ.ง.ด.1 / 1ก, สปส.1-10, employee WT.
9. **SP4.8 Tax filings** — ภ.พ.30 + registers, ภ.ง.ด.2 / 3 / 53 / 54, ภ.พ.36, ภ.ง.ด.50 / 51, RD Prep exports,
   filing locks, tax summary, tie-out, number-gap audit.
10. **SP4.9 Reports** — financial statements by dimension, AR / AP aging and statements, sales and purchase
    summaries, audit log, XLSX exports.
11. **SP4.10 Connect** — OAuth 2.1 server, agent policy and review protocol (§8), REST v1 hardening.
12. **SP4.11 Onboarding and import** — company wizard, opening-balance wizard, master-data CSV import.

MCP tools for each module are generated from its descriptors and ship with the module.

### 11.5 Definition of Done (every module)

- [ ] Descriptors complete: lifecycle, every guard has an exit, correction policy (§7.3–7.5)
- [ ] Date model and period gate applied
- [ ] Permissions in the catalog; frontend gating; MCP tools and agent-policy defaults
- [ ] Error codes registered in Thai and English
- [ ] Every screen state implemented (loading, empty, error, forbidden, locked; VAT and non-VAT)
- [ ] Screen = paper for every document
- [ ] Opening-balance support where the module holds balances
- [ ] Tests: domain unit, integration as `teas_app`, blind acceptance (money modules), e2e, golden fixtures (tax),
      RBAC matrix
- [ ] Generated docs updated (OpenAPI, MCP catalog, permission map)
- [ ] Shipped screens match the approved mockups (screenshot comparison)
- [ ] Parity checklist items for the module ticked

### 11.6 Verification tiers

Tier 1 — the worker self-verifies against the spec's gates. Tier 2 — a fresh reviewer (Opus for money, security,
schema); escalated multi-agent review for releases at extreme blast radius. Tier 3 — the consolidated gate run.
Tier 4 — live acceptance on staging with realistic data before each release; mandatory for money and tax paths.
The orchestrator reads every diff before commit.

### 11.7 Orchestration

TEAS2 runs in orchestrator mode, installed with `/minions` and trimmed: one status board (`STATUS.md`), a routing
log, the spec template, the ADR log, `troubles-wiki.md`. Workers: Sonnet implements; Opus designs and reviews money,
security and schema work; Haiku runs gates; Codex and AGY do tax research (with Claude) and cross-model review.
Two workers run in parallel only on disjoint files and separate build systems / databases.

### 11.8 Git and release

Trunk-based: protected `main`; one branch per work package; a PR needs green CI and the required review;
conventional commits; release-please. Staging deploys from `main`; production deploys on a release.

### 11.9 Launch and coexistence with TEAS 1

TEAS 1 keeps running unchanged. Each company moves to TEAS 2 when ready: onboarding + opening balances at a cut-off
date. TEAS 1 remains available read-only for history (statutory retention).

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Scope size (~108 TEAS 1 screens plus new ones) | Descriptor-driven kit; gated sub-projects; parity checklist as the scope fence |
| Rendering fidelity with Chromium | SP1b spike before mockup sign-off; QuestPDF fallback |
| Tax correctness without a CPA | Tri-model research on primary sources; golden fixtures; Tier-4 live legs; disagreements escalate to Ham |
| Agent posting mistakes | Review token, checks, policy defaults, amount cap, hard limits, oversight, normal correction tools |
| Mock layer drifting from the real API | Typed contract; generated client; `tsc` gate; contract freeze in SP2 |
| Quota and cost of multi-agent work | Quota ladder in `CLAUDE.md`; Codex / AGY for research and review |
| Windows development friction | Short repo path; `.gitattributes` LF; Linux CI as the source of truth |
| Developer machine without Docker | Template-database clones on the local PostgreSQL 18 |

## 13. Deferred decisions (owner and place)

| Decision | Decided in |
|---|---|
| Visual direction | SP1a — Ham picks a style tile |
| PDF renderer (Gotenberg vs QuestPDF fallback) | SP1b spike |
| Line-grid implementation (custom on TanStack vs a grid library) | SP1b |
| Exact legal rules marked [SP-R] | SP-R research notes |
| Module schemas, endpoints, screen details | SP2 module plans |
| Job platform implementation details | SP3 plan |

## 14. Traceability

| Ham's requirement | Where it is met |
|---|---|
| Same features as TEAS 1 | §1.3, §1.2 S1, §11.5 parity item |
| No RD integration | §1.4, D-02 |
| Start empty | §5.10, §11.4 item 12, D-03 |
| COA + posting mapping | §5.4, §5.5 |
| Dimensions | §5.6 |
| Adjustments and periods | §5.8, §5.9 |
| Flexible receipts and payments | §5.11 |
| Fast document creation | §7.9, §7.10, S3 |
| Consistent pages | §7.1, §7.9, S4 |
| Edit after approval | §7.3–7.5, S5 |
| Multi-company for every user | §10.4 |
| Agents may post with review | §8 |
| Mockup 100% real | D-09, §11.3, S2 |
| Detailed plan, systematic execution | §11 |
