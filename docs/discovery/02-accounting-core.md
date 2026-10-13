# TEAS 1 — Accounting Core Discovery (input to the TEAS 2 re-plan)

| | |
|---|---|
| Subject | TEAS 1 @ `Y:\ClaudePlayground\TEAS-Project`, branch `chore/release-2.5.0`, HEAD `712db15` (backend 2.5.0) |
| Analysis date | 2026-10-13 |
| Method | Static read of C#, EF configurations, 111 SQL bootstrap scripts, specs and docs. **Nothing was built, run, or connected to.** Read-only. |
| Purpose | (a) draw the exact boundary of the tax-posting core that TEAS 2 must keep behaviourally identical; (b) catalogue every accounting rigidity TEAS 2 could relax |

## Conventions used in this report

**Path aliases (all repo-relative):**
`Dom/` = `backend/src/Accounting.Domain/` · `App/` = `backend/src/Accounting.Application/` · `Inf/` = `backend/src/Accounting.Infrastructure/` · `Api/` = `backend/src/Accounting.Api/` · `SQL/` = `backend/src/Accounting.Infrastructure/Migrations/SqlScripts/` · `specs/`, `docs/`, `troubles-wiki.md` at repo root.

**Evidence tags:** **[V]** read in code/SQL in this session · **[D]** stated only in a spec/doc (not re-verified in code) · **[I]** my inference from the code.

**Classification of rigidities (§8):**
- **L** = legally required, keep. A citation is given; where the citation comes from the repo itself (not independently verified) it is marked *(repo-cited)*.
- **L?** = probably legally grounded, but the repo's citation is thin/unverified (several repo research notes are explicitly marked *UNVERIFIED — agy/Gemini output*, e.g. `specs/research-ti-cancel-reissue.md`, `specs/research-thai-prior-period-correction.md`). **Needs CPA confirmation before TEAS 2 relies on it.**
- **D** = design choice, candidate for flexibility.
- **D\*** = design choice that *guards* a legal rule; relax only with an equivalent control.

**Source reliability (read this first):**
1. **The code is the source of truth.** `docs/accounting-system-plan.md` ("as-built", dated 2026-06-17) is stale: it lists 9 schemas (code now has ≥13: adds `bank`, `expense`, `fixedasset`, `oauth`), lists "same-day void & reissue" and "cash & bank reconciliation" under *Out of Scope / Not Built* (both since built), has no entry at all for year-end close, fixed assets, expense claims or manual JV, and quotes 146/385 tests (STATUS.md 2026-09-05: Domain 188, Api 1370/1384).
2. `docs/Design(Architect).md` describes **MS SQL Server + microservices + Azure** — a pre-build blueprint. As-built is a **PostgreSQL 16+ modular monolith** (`docs/accounting-system-plan.md` §8/§9 itself says MS SQL is "forbidden by policy"). It is **not** evidence of current behaviour.
3. `docs/Tax-Reference-TH.md` §15 (GL map) contradicts the code — see Appendix B.

---

## 0. Ten findings that matter most

1. **Account determination is instance-global configuration, not company data.** 23 role→account-code defaults live in `GlAccountsOptions` bound from appsettings (`Inf/DependencyInjection.cs:119`, `Inf/Ledger/GlAccountsOptions.cs`). Posting resolves *account codes* inside each company's CoA at post time (`GlPostingService.ResolveAccountIdAsync`). There is no per-company, per-product, per-tax-code, per-BU or per-bank mapping for documents. Several callers bypass even that with **string literals** (`"3300"`, `"2170"`, `"1120"`, `"1110"`, `"1170"`, `"2151"`).
2. **VAT/WHT registers and returns are derived from DOCUMENTS; CIT, P&L, Balance Sheet and year-close are derived from the GL by `AccountType` only.** That is a clean seam — *except* that the ภ.ง.ด.50 supporting schedules classify GL accounts into RD form boxes by **hard-coded numeric account-code ranges** (`Inf/Tax/Pnd50FilingService.cs` `BuildExpenseSchedule`, `MapBalanceSheet`). Account numbering is therefore silently load-bearing for a statutory return.
3. **Reversal tooling exists only for Tax Invoice, Receipt and (non-VAT) Invoice.** `IGlPostingService.PostReversalAsync` is called from exactly three places. A wrong Vendor Invoice, posted PV, CN/DN, payroll run, depreciation run, expense claim, bank-rec JE or manual JV can only be corrected by a hand-keyed counter-entry; there is no reverse endpoint.
4. **Every fiscal document's date is pinned to server-today (Asia/Bangkok)** for TI, RC, CN, DN, PV, VI(draft), manual-JV(draft). The statute requires issue-date = tax point (ม.86/4(7), ม.78); "today" is a stricter control. The replacement-TI path already proves the model can carry a non-today date.
5. **Non-VAT companies recognise revenue on cash receipt** when a Receipt is applied to a Delivery Order or is standalone (`PostReceiptAsync`: `Cr Sales "(non-VAT receipt)"`). Accrual at Invoice (BillingNote) issue exists (R1/C6) but is optional. For a juristic person this is a **legal-risk** path (ม.65 accrual basis — *L?*, repo research UNVERIFIED), not merely a design choice.
6. **Receipts and Payment Vouchers always post cash to `1110`/`1120`, ignoring the document's own `BankAccountId`.** `BankAccount.GlCashAccountId` is honoured only by expense-claim pay, payroll pay and bank-rec inline JEs. Multi-bank-account GL separation does not exist for documents (`Dom/Entities/Bank/BankAccount.cs` doc comment; `App/Bank/BankReconciliationReportDtos.cs` `DocReconciliationLimited`).
7. **Only one real dimension (Business Unit, flat).** `JournalLine.DimensionsJson` (jsonb) is writable but never set by any poster and never read by any report. There is no party (customer/vendor) tag on journal lines, so AR/AP subledgers are rebuilt from documents and manual JVs to AR/AP are invisible to them.
8. **THB-only is enforced by validators on every document create** (`App/Abstractions/CurrencyValidationExtensions.cs` `ThbOnly`). `CurrencyCode`/`ExchangeRate` columns exist on JE and documents but are inert.
9. **Not built:** recurring/auto-reversing/accrual/prepaid/deferred-revenue entries, GL opening-balance entry type, inventory/COGS-on-sale, cost centres/projects, FX, budgets, cash-flow statement, amended tax returns, ภ.พ.30 carry-forward, ม.82/6 shared-input apportionment, VAT advance/deposit receipts.
10. **Known compliance gaps TEAS 2 must decide to fix or copy** (§8.C): standalone-PV input VAT reaches GL `1170` but never ภ.พ.30; ภ.พ.36 self-assessed credit never reaches ภ.พ.30; ม.85 threshold watch reads Tax Invoices only (blind for the non-VAT companies it targets); CN/DN have no cap against the original TI; PV WHT rate is caller-supplied; audit-log coverage is partial; ภ.พ.36 uses literal `0.07m` twice.

---

## 1. Domain model

### 1.1 Persisted entities by module (66 EF entity sets — `Inf/Persistence/AccountingDbContext.cs`)

All `ITenantOwned` entities carry `company_id`, an EF global query filter (`ApplyTenantFilter`) and a Postgres RLS `company_isolation` policy (`SQL/010`, rewritten by `SQL/600` to drop the super-admin data-scope arm). Money = `decimal` stored `numeric(19,4)`; IDs `bigint`/`int`; dates `DateOnly`, instants `DateTimeOffset`.

| Schema | Tables (entity) | Key fields / relationships |
|---|---|---|
| `master` | `companies` (Company) | `TaxId` (13-digit checksum), `LegalEntityType`, `VatRegistered`, `VatRegisterDate`, `VatRate` (default 0.07), `Pnd30SubmissionMode` (manual/auto), `FiscalYearStartMonth` (1–12), `BaseCurrency`, `ReportingStandard` (TFRS_NPAE), `PaidUpCapital` (SME test), `RequiresBusinessUnit`. **No RLS** on this table. |
| | `company_profile` | granular registered address (`Reg*`), `BranchCode`, `LegalName` — read by every RD form filler |
| | `branches` | `BranchCode` (5-digit, `00000`=HQ), `IsHeadOffice` |
| | `business_units` | `Code`, `DefaultRevenueAccountId` (**dormant**, §8.B) |
| | `chart_of_accounts` | §4 |
| | `customers` | `CustomerType` Individual/Corporate, `TaxId`, `BranchCode`, `VatRegistered`, `CreditLimit` (stored, never enforced), `PaymentTermDays`, `DefaultWhtTypeId` |
| | `vendors` | `VendorType`, `VatRegistered`, `IsForeign`, `HasThaiVatDReg`, `CountryCode`, `DefaultWhtTypeCode`, bank details |
| | `products` | `ProductType` Good/Service/ExemptGood/ExemptService, `IsSaleable/IsPurchasable`, `DefaultOutputTaxCodeId`, `DefaultInputTaxCodeId`, `DefaultWhtTypeId` (service only). **No stock/cost/GL-account fields.** |
| | `employees` | payroll master, SSO flag, marital/children, `YtdOpening*` (payroll opening balances) |
| `sys` | `users`, `roles`, `permissions` (91 constants, `Api/Authorization/Permissions.cs`), `role_permissions`, `user_roles` | per-company roles cloned by `sys.seed_company_roles()`; `SUPER_ADMIN` is a user flag |
| | `api_keys`, `idempotency_keys` | MCP/external API keys (kind), BU binding, claim-first idempotency |
| | `number_sequences` | unique `(company, branch=0, prefix, sub_prefix, year, month)` → `current_value` |
| | `document_prefixes` | **global** registry (no company_id): QT SO DO TI RC CN DN BN RV PV WT JV VI PO PR EX FA. `IV` (used by `BillingNoteService`) is seeded by no script and `NumberSequenceConfiguration` defines no FK to the registry, so the registry is advisory metadata, not an enforced list |
| | `expense_categories` | `CategoryCode` (PV sub-prefix), `DefaultExpenseAccountId`, `DefaultTaxCodeId`, `DefaultIsRecoverableVat`, `DefaultWhtTypeId`, `IsCapex`, `IsCogs` |
| | `attachments` | evidence files (e.g. vendor tax-invoice scan) |
| `tax` | `tax_codes` (TaxCode) | `Direction` Input/Output, `IsExempt`, `IsZeroRated`, `IsRecoverable`, `IsReverseCharge`, `LegalRef` (ม.80, ม.80/1, ม.81(1)…) |
| | `tax_rates` (TaxRate) | effective-dated rate rows — **entity + table exist, never read** (§8.B) |
| | `wht_types` (WhtType) | `Code`, `IncomeTypeCode`, `FormType` (Pnd3/53/54/2/1), `Pnd2IncomeCode`, `Rate`, `EffectiveFrom/To`, `DefaultPayableAccountId` (**dormant**) |
| | `wht_certificates` (WhtCertificate) | `Direction` P (we withheld, our WT-NNNN) / R (customer withheld, customer's cert no), payer/payee snapshots, `FormType`, `IncomeAmount`, `WhtRate`, `WhtAmount`, `WhtCondition` 1/2/3, `PdfStoragePath` (frozen PDF) |
| | `tax_filings` | one row per `(company, form, period)` — unique, `PayloadJson`, status Finalized/Submitted |
| | `cit_year_summaries`, `cit_adjustments` | per-FY taxable P/L, override, ภ.ง.ด.51 estimate/prepaid; signed ม.65ทวิ/65ตรี adjustment lines |
| | views `tax.v_number_gaps`, `tax.v_duplicate_doc_numbers` | `SQL/050,613,644`; `SQL/635` |
| `sales` | `quotations`+lines, `sales_orders`+lines, `delivery_orders`+lines | non-fiscal chain; BU cascades |
| | `billing_notes`+lines+`billing_note_tax_invoices` | UI name "ใบแจ้งหนี้/Invoice"; VAT co.: groups TIs; non-VAT co.: **the** sales document and the accrual point |
| | `tax_invoices`+lines | ม.86/4 document; supplier+buyer snapshot; links to `QuotationId/BillingNoteId/SalesOrderId/DeliveryOrderId`; cancel columns; `ReplacesTaxInvoiceId` |
| | `receipts`+`receipt_applications`+`receipt_lines`+`receipt_wht_lines` | application targets: TI (VAT) / DO (non-VAT legacy) / BillingNote (non-VAT) |
| | `tax_adjustment_notes` | CN and DN in one table (`NoteType`), `OriginalTaxInvoiceId`, **single lump** `SubtotalAmount` (no lines) |
| `purchase` | `purchase_orders`+lines | internal PO, ≥95% → auto-close, >105% warn (`Dom/Entities/Purchase/PoSettlement.cs`) |
| | `vendor_invoices`+lines | AP accrual + ม.82/4 `VatClaimPeriod`; per-line recoverable/capex/COGS snapshots |
| | `payment_vouchers`+lines+`payment_voucher_applications` | WHT per line, `WhtPayerMode`, `SelfWithholdMode`, `RequiresPnd36ReverseCharge`, optional `VendorInvoiceId` |
| `gl` | `journal_entries`, `journal_lines` | §2/§3; `IsClosingEntry`, `ReversalOfId`, `CurrencyCode/ExchangeRate` (inert), line `BusinessUnitId`, `DimensionsJson` (dormant) |
| | `accounting_periods` | `(company, year, month)`, Open/Closed |
| | `fiscal_year_closes` | active (unreversed) row ⇔ "FY N closed" |
| `payroll` | `payroll_runs`, `payslips` | one run per `PeriodYearMonth`; `JournalId` |
| `expense` | `expense_claims`+lines | employee reimbursement |
| `fixedasset` | `fixed_assets`, `depreciation_runs`, `depreciation_run_lines` | straight-line only |
| `bank` | `bank_accounts`, `statement_imports`, `statement_lines` | `GlCashAccountId`; match status Unmatched/Matched/Posted/Ignored |
| `etax` | `submissions` | append-only e-Tax attempt log (feature default-inert) |
| `audit` | `activity_log` | append-only (trigger + truncate trigger + REVOKE) |
| `oauth` | OpenIddict stores (4) | MCP OAuth 2.1; not tenant-owned |

Key relationships: Quotation → SalesOrder → DeliveryOrder → (BillingNote) → TaxInvoice → Receipt(applications) ; CN/DN → TaxInvoice ; PurchaseOrder → VendorInvoice → PaymentVoucher (via `VendorInvoiceId` + `PaymentVoucherApplication`) → WhtCertificate(P) ; Receipt → WhtCertificate(R) ; VendorInvoice → FixedAsset ; Employee → ExpenseClaim / Payslip ; StatementLine → Receipt | PaymentVoucher | JournalEntry.

### 1.2 Document types, numbering point, status enum, GL effect

Number format: `MM-YYYY-PREFIX[-SUB]-NNNN` (`Dom/ValueObjects/DocumentNumber.cs`, regex `^(0[1-9]|1[0-2])-\d{4}-[A-Z]{2,5}(-SUB…)?-\d{4,6}$`). SUB = Business-Unit code (`TI`, `RC`, `CN`, `DN`, `QT`, `SO`, `DO`, `PO`, `VI`, `IV`, `EX`) or `{BU}-{ExpenseCategoryCode}` for PV. `WT`, `JV`, `PR`, `FA` have no sub-prefix. **[V]**

| Document | Entity / status enum | Number allocated at | Source of the month in the number | JE posted? | DB immutability trigger |
|---|---|---|---|---|---|
| Quotation (QT) | `QuotationStatus` Draft→Sent→Accepted / Rejected / Expired / Cancelled | `Send` (`QuotationService.SendAsync`) | `q.DocDate` | no | no |
| Sales Order (SO) | `SalesOrderStatus` Draft→Posted→Closed / Cancelled | `Post` | `so.DocDate` | no | no |
| Delivery Order (DO) | `DeliveryOrderStatus` Draft→Issued→Delivered / Cancelled | `Issue` | `dord.DocDate` | no | no |
| Invoice / Billing Note (IV; legacy BL) | `BillingNoteStatus` Draft→Issued→Settled / Cancelled | `Issue` | `bn.DocDate` | **non-VAT co. only** (accrual); VAT co. none | no (cancel is app-guarded) |
| **Tax Invoice (TI)** | `DocumentStatus` Draft→Posted→Voided | `Post` | **post date = today** (replacement: original date) | yes | **yes** `040/583/643` header + `580/582` lines |
| **Receipt (RC)** | Draft→Posted→Voided | `Post` | `rc.DocDate` (set at draft; **not** re-pinned at post) | yes | **yes** `570/643` + lines |
| **Credit/Debit Note (CN/DN)** | Draft→Posted (no void) | `Post` | `note.DocDate` (= draft date) | yes | **yes** `571` (no line table) |
| Purchase Order (PO) | `PurchaseOrderStatus` Draft→Approved→Closed / Cancelled | `Approve` | `po.DocDate` | no | no |
| **Vendor Invoice (VI)** | Draft→Posted (`Voided` enum value has no code path) | `Post` | `vi.DocDate` (set at create/edit = today; not re-pinned at post) | yes | **yes** `060` + `580/582` lines |
| **Payment Voucher (PV)** | Draft→Approved→Posted; Draft/Approved→Voided | `Post` | **post date = today** (re-pinned) | yes | **no DB trigger** (app-only) |
| WHT certificate (WT) | `Status` Posted/Voided | with PV post, **one per income-type group** (own `WT` sequence) | post date | no | **no DB trigger** |
| Expense Claim (EX) | `ExpenseClaimStatus` Draft→Submitted→Approved→Paid; Rejected; Cancelled | `Pay` | post date = today | yes (at Pay) | no |
| Payroll Run (PR) | `DocumentStatus` Draft→Approved→Posted (+`PaidAt` stamp) | `Post` | `run.PayDate` | yes at Post; second JE at Pay | no |
| Fixed Asset (FA) | `FixedAssetStatus` Draft→Active→Disposed / WrittenOff; Cancelled | `Activate` | activation date = today | **no JE at Activate**; JE at dispose/write-off | no |
| Depreciation Run | single state `Posted`, unique per `(company, year, month)` | none | run date = month-end | yes | no |
| Journal Voucher (JV) | `DocumentStatus` Draft→Posted | `Post` / create-and-post | JE `DocDate` | is itself the JE | **yes** `020` + lines `580/582` |
| Tax filing | Preview → Finalized / Submitted (immutable) | n/a | n/a | PND36 only (JV) | no (unique index only) |

### 1.3 Status state machines and guard rules

**Tax Invoice** (`Dom/Entities/Sales/TaxInvoice.cs`, `Inf/Sales/TaxInvoiceService*.cs`) **[V]**
- `Draft → Posted` guards: company must be VAT-registered (`ti.non_vat_blocked`); buyer must have TaxId+BranchCode if `VatRegistered` (`ti.customer_incomplete`, ม.86/4 #3); `DocDate == TaxPointDate` (`ti.tax_point_mismatch`); `TaxAmount ≥ 0`, `TotalAmount > 0`; at most one POSTED TI per Quotation (`quotation.already_invoiced`, unique `ix_tax_invoices_quotation_id`); posting period open; BU required if `Company.RequiresBusinessUnit`.
- `Posted → Voided` only via Cancel (guards in §2.6). `Voided` is terminal (trigger 643 allows only POSTED→VOIDED once out of DRAFT).
- Draft edit = delete-and-recreate lines under `SELECT … FOR UPDATE` + `Version++` (`UpdateDraftAsync`). An ordinary Draft TI **cannot be deleted** (only *replacement* drafts, `DiscardReplacementAsync`).

**Receipt** — Draft→Posted→Voided. Post guards: applied TIs POSTED, same customer, `applied ≤ outstanding`; non-VAT company cannot apply to TIs (`rc.non_vat_no_ti`); **VAT company cannot apply to a BillingNote** (`rc.vat_co_no_bn_settle`); DO already invoiced → refused (`rc.do_already_invoiced`); WHT ≤ amount; `Σ applications == Amount` (`Receipt.MarkPosted`).

**Credit/Debit Note** — Draft→Posted only. `OriginalTaxInvoiceId` must be POSTED at create *and* at post; reason mandatory (`note.reason_required`, ม.86/9–10); `DocDate == TaxPointDate`. Draft may be deleted. **No cap against the original TI total or prior notes.**

**Vendor Invoice** — Draft→Posted. Guards: `vat_claim_period` inside ม.82/4 window (TI month … +6, `EnsureClaimInWindow`); claim period's accounting period open (`EnsureClaimPeriodOpenAsync`); non-VAT company forces `HasInputVat=false` and every line non-recoverable (WP1.2); linked PO must be Approved at create and not Draft/Cancelled at post.

**Payment Voucher** — Draft→Approved (needs `purchase.payment_voucher.approve`; creator may self-approve, SoD removed cont.77) →Posted (`MarkPosted` requires Approved, `TotalPaid > 0`). Draft/Approved→Voided (`PaymentVoucher.Cancel`). Any line with `WhtRate>0` must resolve a WHT income type (`pv.wht_type_missing`, at create *and* approve). Posted PV: payer TaxId must be usable (`wht.payer_tax_id_missing`).

**Payroll Run** — Draft→Approved→Posted→(Paid stamp). One run per period (`payroll.duplicate_period`). Delete only Draft or Approved-and-unposted. Post/Pay need the **PayDate's month open** (`payroll.period_closed`).

**Expense Claim** — Draft/Rejected→Submitted→Approved→Paid; Reject only from Submitted; Cancel from Draft/Rejected/Approved (never Paid). Account re-validated at Submit, Approve and Pay (`RevalidateLineAccountsAsync`).

**Fixed Asset** — Draft(editable)→Active(frozen cost/base/monthly/3 accounts)→Disposed|WrittenOff; Cancel only from Draft. Disposal date ≥ acquire and depreciation-start dates.

**Period** — `Open`/`Closed` per `(year, month)`; **fiscal year** — closed ⇔ an unreversed `fiscal_year_closes` row exists (§5).

**Bank statement line** — Unmatched ↔ Matched (reversible), Unmatched → Posted (JE-backed; cannot be unmatched), Unmatched ↔ Ignored.

**Non-fiscal chain documents [V]** (`Inf/Sales/QuotationChainServices.cs`, `SalesOrderDeliveryServices.cs`, `BillingNoteService.cs`, `Inf/Purchase/PurchaseOrderService.cs`)
- *Quotation* — Draft→Sent (`SendAsync` allocates the `QT` number; BU required if the company flag is set) →Accepted | Rejected(reason) | Cancelled(reason; refused once converted, `quotation.converted`). Convert-to-SO requires Accepted (`quotation.not_accepted`). Edit/delete Draft only. `Expired` is declared in the enum but **no code assigns it**.
- *Sales Order* — Draft→Posted (`SO` number) →Closed (set when every line is delivered). DO creation requires Posted (`so.not_posted`) and rejects over-delivery (`do.over_delivered`); a service-only SO may go straight to a TI, goods lines force a DO first (`so.delivery_required`). `Cancelled` is declared but **never assigned**.
- *Delivery Order* — Draft→Issued (`DO` number) →Delivered. `CreateFromDeliveryOrderAsync` (draft-only TI) needs Issued|Delivered and one live TI per DO (`do.ti_exists`); the legacy `CreateTaxInvoiceAsync` needs Delivered and **creates and posts** a TI. `Cancelled` is declared but **never assigned** — there is no SO/DO cancel path.
- *Invoice (BillingNote)* — Draft→Issued→Settled (derived: linked TIs fully paid, or direct non-VAT applications cover the total) | Cancelled. Issue guard: if TIs are linked *and* own lines exist, `bn.TotalAmount` must equal Σ linked applied amounts (`billing_note.lines_not_reconciled`); a non-VAT issue needs an open period because it posts T2.
- *Purchase Order* — Draft→Approved (`PO` number; `DocDate` re-pinned to today at approval; approval is permission-only) →Closed (auto at ≥95% of PO total by posted VIs, or manual) →Approved again via `ReopenAsync` only while no POSTED VI is linked (`po.reopen_blocked`); Cancelled(reason). "Sent" is an audit label (`SentToVendorAt`), not a status.

---

## 2. Posting pipeline

### 2.1 Canonical sequence (Tax Invoice; every other poster is a variation) **[V]**
`Inf/Sales/TaxInvoiceService.cs` → `PostAsync`/`PostCoreAsync`:
1. `BeginTransaction`; `EnsureVatRegisteredAsync`; load TI+lines; quotation-uniqueness guard.
2. **Re-pin** `DocDate = TaxPointDate = TodayInBangkok()` (replacement TI keeps its original date); `IPeriodCloseService.EnsureOpenAsync(postDate)`.
3. Snapshot `Product.ProductCode` onto lines and **flush while still DRAFT** (so the lines-immutability trigger never blocks a legitimate write).
4. `NumberedDocumentWriter.AllocateAndSaveAsync(allocate: INumberSequenceService.NextAsync(company,"TI",subPrefix: BU code, postDate); assign: ti.MarkPosted(...))`.
5. `IActivityRecorder.Record("TaxInvoice", …, "Posted")` (added to the change tracker; commits with the tx).
6. `ti.JournalEntryId = IGlPostingService.PostTaxInvoiceAsync(...)` → private `GlPostingService.BuildAndPostAsync`: stamp BU on lines, `ΣDr == ΣCr && > 0` else `gl.unbalanced`, allocate a `JV` number by JE date, `JournalEntry.MarkPosted` (**rejects any amount with > 2 decimals — `je.precision`, never rounds**).
7. `CommitAsync`. Then, best-effort and **default-inert** (`ETax:Enabled=false`): e-Tax build→sign→validate→send pipeline; a failure never rolls back the posted TI.

Concurrency: draft edit and post race → `Version` (409 `ti.locked_mismatch`); double-post loser hits trigger 23514 → 409; deadlock 40P01 mapped likewise; API-key create path uses a claim-first idempotency fence (`pg_advisory_xact_lock` + partial unique `ux_<table>_idem`).

### 2.2 Document numbering (gap rules) **[V]**
- Allocator: `Inf/Numbering/NumberSequenceService.cs` — one `INSERT … ON CONFLICT (company_id, branch_id, prefix_code, sub_prefix, period_year, period_month) DO UPDATE SET current_value = current_value+1 RETURNING` on the **caller's transaction**. Concurrent posters serialize on the row lock; a rolled-back post never consumes a number.
- **Only at POST/Issue/Approve/Pay/Activate — never on Draft** (table in §1.2). A voided TI/RC keeps its number; numbers are never reused.
- **Scope = company-wide** since fix H1 (`branch_id` is always bound to 0) because the printed number has no branch segment. Series are split by **BU sub-prefix** (each BU = its own gap-free monthly series). Monthly reset (month in the number).
- Collision safety net: `NumberedDocumentWriter` (max 50 attempts) catches a `*doc_no*` unique violation, rolls back to an explicit savepoint taken **after** the allocation (so the counter bump survives) and re-allocates. Consequence: in the pathological "sequence bucket drifted below existing max" case, numbers are *deliberately burnt* to heal the bucket (`SQL/626`, `SQL/634` reconcile scripts are the data-layer backstop).
- DB uniqueness: 15 partial-unique indexes `(company_id, doc_no) WHERE doc_no IS NOT NULL` in the EF model (quotations, sales_orders, delivery_orders, billing_notes, tax_invoices, receipts, tax_adjustment_notes, purchase_orders, vendor_invoices, payment_vouchers, journal_entries, payroll_runs, expense_claims, fixed_assets; `wht_certificates` restricted to `direction='P'`); seven of them were converted from `(company, branch, doc_no)` by `20260814041822_H1_CompanyWideDocNoUniqueIndexes`.
- Audit views: `tax.v_number_gaps` covers **only TI (POSTED+VOIDED), JV, PV** (`SQL/644`); `tax.v_duplicate_doc_numbers` covers 15 tables (`SQL/635`). **Receipt, CN, DN, VI, WT, EX, PR, FA series are not gap-audited.** Neither view has RLS — `NumberGapReportService` must filter by company itself.

### 2.3 What each document does at post (files and effects) **[V]**

| Document | Entry point | Persisted effects besides the document row |
|---|---|---|
| TI | `Inf/Sales/TaxInvoiceService.cs` `PostCoreAsync` | JE (T1); `ti.JournalEntryId`; activity row. Tax-register effect: **none stored** — the output register / ภ.พ.30 are queries over POSTED TIs (and CN/DN) by `DocDate` |
| Receipt | `Inf/Sales/ReceiptService.cs` `PostCoreAsync` | locks applied TIs/BNs (ascending ids); `TaxInvoice.AmountPaid`/`PaymentStatus` (UNPAID/PARTIAL/PAID); BillingNote → Settled when covered; WHT Direction='R' certificates (only if customer cert no supplied; else "ขาดใบทวิ 50" and `SetWhtCertAsync` later); JE (T3) |
| CN/DN | `Inf/Sales/TaxAdjustmentNoteService.cs` `PostAsync` | JE (T4/T5). **Does not touch `TaxInvoice.AmountPaid`/status** |
| Invoice (non-VAT) | `Inf/Sales/BillingNoteService.cs` `IssueAsync` | JE (T2) only when `!VatMode`; `bn.JournalEntryId`; O2b reconcile of linked TI total vs lines |
| VI | `Inf/Purchase/VendorInvoiceService.cs` `PostAsync` | JE (T6); PO loose-match close (≥95%) / over-receipt warning (>105%). Input-VAT register effect: **none stored** (query by `VatClaimPeriod`) |
| PV | `Inf/Purchase/PaymentVoucherService.cs` `PostCoreAsync` | re-pin date; PV number; **one WHT certificate (P) per income type** with own `WT` number; `PaymentVoucherApplication` + `VendorInvoice.SettledAmount/SettlementStatus`; JE (T7/T8) |
| Expense Claim | `Inf/Expense/ExpenseClaimService.cs` `PayAsync` | `MarkPaid`; JE (T9); `claim.JournalEntryId` |
| Payroll | `Inf/Payroll/PayrollRunService.cs` `PostAsync` / `PayAsync` | accrual JE (T10) at Post; settlement JE (T11) at Pay |
| Fixed asset | `Inf/FixedAsset/FixedAssetService.cs` | Activate: number only. Depreciation run (T12). Dispose/WriteOff (T13) |
| Manual JV | `Inf/Ledger/JournalService.cs` `CreateAndPostManualAsync` | single call create+post; gates: date ≤ today, period open, FY not closed, accounts active/non-header/same-tenant, BU valid, BU required on Revenue/Expense lines if company flag; advisory `pnd36.ap_cleared_outside_pv` |
| Bank-rec inline JE | `Inf/Bank/BankReconciliationService.cs` `CreateJournalAsync` | JE (T15) + statement line → Posted |
| Year-end close | `Inf/Ledger/YearCloseService.cs` | closing JE (T17) via `PostClosingEntryAsync` (**no period gate by design**) + `fiscal_year_closes` row |
| Tax filing finalize | `Inf/TaxFilings/TaxFilingStore.cs` `FinalizeAsync` | immutable `tax.tax_filings` row (`PayloadJson`); PND36 additionally posts JV (T18) |

### 2.4 Immutability — application + database **[V]**

| Table | Trigger(s) (SQL) | Frozen once not-DRAFT | Allowed change |
|---|---|---|---|
| `sales.tax_invoices` | `trg_ti_immutable` (040→583→**643**), `trg_ti_no_delete_posted` | doc_no, doc_date, tax_point_date, supplier TIN/branch, customer_id, subtotal/tax/total, business_unit_id, company/branch, `replaces_tax_invoice_id`; `journal_entry_id` once non-null; after VOIDED also the 5 cancel columns + reversal JE id | only `POSTED→VOIDED`; print counters, payment status, e-Tax fields are NOT frozen |
| `sales.tax_invoice_lines` | `trg_ti_lines_immutable` (580→**582**) | any UPDATE/DELETE/re-parent when parent ≠ DRAFT | INSERT is deliberately unguarded (created-as-posted flows) |
| `sales.receipts` (+lines) | `tg_receipts_immutable_after_post` (570→**643**), `tg_receipts_no_delete_posted`, `trg_receipt_lines_immutable` | doc_no, date, customer, amount/total/wht/cash_received, currency, company/branch, `replaces_receipt_id`, JE id (once set) | `POSTED→VOIDED` |
| `sales.tax_adjustment_notes` | `tg_adjnote_immutable_after_post` (571) | doc_no, prefix, type, dates, original TI, reason, customer, amounts, tax_rate, currency | none (no void) |
| `purchase.vendor_invoices` (+lines) | `tg_vendor_invoices_immutable_after_post` (060), `trg_vi_lines_immutable` | doc_no/date, vendor TI no/date, `vat_claim_period`, amounts, vendor | `settled_amount`/`settlement_status` stay mutable (PV settlement) |
| `gl.journal_entries` | `trg_je_immutable` (020), `trg_je_no_delete_posted` | doc_no, doc_date, posting_date, totals, company/branch | status/PostedAt not in the list (reversal links are new rows) |
| `gl.journal_lines` | `trg_journal_lines_immutable` (580→582) | any change when parent ≠ DRAFT | — |
| `audit.activity_log` | `trg_audit_no_update/delete`, `trg_audit_no_truncate`, REVOKE (584) | everything | — |
| `etax.submissions` | `trg_etax_sub_no_update/delete` (300) | everything | — |

**Not DB-protected (application guard only):** `purchase.payment_vouchers` and lines, `tax.wht_certificates` (the 50ทวิ), `payroll.*`, `expense.*`, `fixedasset.*`, `tax.tax_filings`, `sys.number_sequences`, `billing_notes`.

**Un-post gap [V]:** only the TI and Receipt triggers (583/643) block a status change out of POSTED other than `POSTED→VOIDED`. The JE (020), VI (060) and CN/DN (571) triggers compare a field allow-list that does **not** include `status`, so a direct-SQL `UPDATE … SET status='DRAFT'` is not blocked by them — and once the parent is DRAFT, its lines become editable/deletable under 580/582 and the parent itself becomes deletable (the no-delete triggers test `OLD.status <> 'DRAFT'`). No application path does this; it matters only for TEAS 2's threat model for the "immutable ledger" claim.

### 2.5 Audit log **[V]**
`Inf/Audit/ActivityRecorder.cs` adds one `audit.activity_log` row (actor, module, entity, doc no, from/to status, note) to the caller's tx. It is invoked by: Quotation/SO/DO, TI (incl. cancel/replacement), Receipt, BillingNote, CN/DN, PO, VI, PV, Payroll, PeriodClose(reopen), CompanyService/CompanyProfile (`tax_config_change`), RBAC, OAuth. **It is NOT invoked by:** `JournalService` (manual JV), `YearCloseService`, `ExpenseClaimService`, `FixedAssetService`, `BankReconciliationService`, `TaxFilingStore`/filing services, `NonVatArBackfillService`, `PeriodCloseService.CloseAsync` (only `ReopenAsync` records). This contradicts the as-built plan §3.8 ("every state change writes activity_log").

### 2.6 Cancel / void / cancel+reissue / CN / DN flows

**Tax Invoice cancel** (`Inf/Sales/TaxInvoiceService.Cancel.cs`; spec `specs/cancel-reissue-sales-docs.md`) **[V]**
- Endpoints: `POST /tax-invoices/{id}/cancel | cancel-and-reissue | reissue`, `DELETE /{id}` (replacement draft only).
- Preconditions: status Posted; reason code ∈ `CancelReasonCodes` + free text ≤ 500; `ETaxSubmittedAt == null` (else "issue a credit/debit note instead"); no posted Receipt applied and `AmountPaid == 0`; no POSTED CN/DN against it; not referenced by a non-cancelled Invoice (BillingNote).
- Mechanics: `DocumentCancellation.LockTaxInvoicesAsync` (row locks, ascending id) → resolve the original JE (`JournalEntryId`, or legacy lookup `Reference == DocNo && Description == "TI "+DocNo`) → reversal date `ResolveReversalDateAsync` (= original DocDate if its month is open, else today; never before the original JE's date; must be open) → `PostReversalAsync` (exact mirror: every line's Dr/Cr swapped, same account, same BU, description prefixed "ยกเลิก ") **first**, then **one** `SaveChanges` sets `Status=Voided`, 5 cancel columns, `ReversalJournalEntryId`, `Version++` (because trigger 643 freezes the cancel columns once VOIDED).
- Replacement draft (`CreateReplacementDraftCoreAsync`): lines copied **verbatim, never recomputed**, `DocDate = original's`, buyer snapshot re-pulled from the customer master; amount lock `LockedTiDiffs` (replacement.locked_field); unique `ux_tax_invoices_replaces`. On post: number drawn from the **original's month sequence even if that month is closed** (allocator has no period check); GL date = original month if open else today; e-Tax auto-send skipped.
- Registers: a VOIDED TI stays in the output register at 0.00 with category `CANCELLED`, plus a cross-month memo row (`TaxFilingService.OutputVatRegisterAsync`, `VatReportService.MemoTisAsync`); ภ.พ.30 totals unaffected (`SalesCategorizer` counts POSTED only).

**Receipt cancel** (`ReceiptService.Cancel.cs`): Posted only; refused if matched to a bank statement line; unwinds each applied TI's `AmountPaid`/`PaymentStatus`; re-derives Settled→Issued on BNs; voids Direction='R' certificates; reversal JE; replacement retargets applications to the newest POSTED replacement TI ("O11").
**Invoice (BillingNote) cancel**: not when Settled; accrued (non-VAT) invoices refuse if posted receipts exist, else reversal JE.
**CN/DN**: they *are* the legal correction path for a posted TI (value changes, ม.86/9–10). A posted CN/DN cannot be cancelled; a CN is undone by a DN.
**Everything else:** see §8.D1 — no reversal path.

---

## 3. Account determination

### 3.1 Mechanism **[V]**
- `Inf/Ledger/GlAccountsOptions.cs` — sealed class with 23 string properties; defaults hard-coded in the class; optionally overridden by the `GlAccounts` appsettings section (dev file overrides only 9 of them). Bound once per instance: `services.AddOptions<GlAccountsOptions>().Bind(cfg.GetSection("GlAccounts"))`.
- `GlPostingService.ResolveAccountIdAsync(companyId, code)` = `ChartOfAccounts.FirstOrDefault(a => a.CompanyId==c && a.AccountCode==code)`; missing → `gl.account_missing` (422). One query per role per post; no cache across requests.
- `GlAccountsOptions.AllCodes()` (explicit list, pinned by a test) feeds `ChartOfAccountService.UpdateAsync`: a system account cannot be deactivated or made a header (`coa.system_account`).
- Per-company seeding of the codes: `CompanyService.CreateAsync` (`Inf/Master/MasterDataServices.cs`, static `DefaultChartOfAccounts` = 30 flat accounts, of which 23 are `GlAccountsOptions` codes and 7 are not: COGS 5000, rent 5100, service 5200, advertising 5300, director loan 2190, interest 5500, other income 4300) and SQL seeds `120/230/240/482/611/621/625/631/…`.

| Role (property) | Default | Used by |
|---|---|---|
| `ArAccount` | 1130 | TI, Invoice, Receipt, CN, DN, backfill, subledger control |
| `ApAccount` | 2110 | VI, PV(VI-linked), PND36 detection, JE advisory, subledger control |
| `CashAccount` / `BankAccount` | 1110 / 1120 | Receipt, PV, EC(cash), FA disposal(cash), bank-rec report |
| `SalesAccount` | 4000 | TI, Invoice, Receipt(non-VAT), backfill |
| `SalesReturnAccount` | 4100 | CN debit **and DN credit** |
| `OutputVatAccount` | 2151 | TI, CN, DN, FA disposal |
| `InputVatAccount` | 1170 | VI, PV(standalone), EC |
| `WhtPayableAccount` / `WhtReceivableAccount` | 2152 / 1180 | PV / Receipt |
| `RetainedEarningsAccount` | 3300 | backfill only (YearClose uses a literal) |
| `IrrecoverableVatExpenseAccount` | 5350 | ภ.พ.36 for non-VAT company |
| `SalaryExpense` / `EmployerSsoExpense` / `PitPayable` / `SsoPayable` / `NetWagesPayable` / `OtherDeductionsPayable` | 5400 / 5410 / 2153 / 2160 / 2170 / 2180 | payroll post |
| `FixedAssetCost` / `AccumulatedDepreciation` / `DepreciationExpense` / `GainOnAssetDisposal` / `LossOnAssetDisposal` | 1610 / 1690 / 5450 / 4200 / 5460 | FA (defaults for per-asset accounts; gain/loss at disposal) |

### 3.2 Where an account does NOT come from `GlAccountsOptions` **[V]**
- **Line-level expense/asset account:** VI/PV/EC lines carry `ExpenseAccountId` = line override ?? `ExpenseCategory.DefaultExpenseAccountId` (frozen at draft). EC lines are validated by `ExpenseAccountRule` (Expense accounts only, or the category's own capex asset account).
- **Fixed assets:** three per-asset account ids (cost, accumulated depreciation, depreciation expense) frozen at Activate.
- **Bank account:** `BankAccount.GlCashAccountId` — used by expense-claim pay (TRANSFER), payroll pay, bank-rec inline JE; **ignored** by Receipt/PV posting.
- **Manual JV / bank-rec contra / year-close:** caller-supplied or computed AccountIds.
- **Literal bypasses of the config (hard-coded strings):**
  - `Inf/Ledger/YearCloseService.cs:139` `"3300"`
  - `Inf/Payroll/PayrollRunService.cs` `PayAsync`: `"2170"`, fallback `"1120"`, `"1110"`
  - `Inf/TaxFilings/WhtFilingService.cs` `PostReverseChargeJvAsync`: `"1170"`, `"2151"`
  - `Inf/Master/MasterDataServices.cs` expense-category seeding fallback `"5200"`
  - `Inf/Sales/ReceiptService.Read.cs:412` WHT-base fallback `w.Code == "SVC"` (a **WHT-type code**, same class of bypass)
- **Dormant "config" columns that look like mappings but are never read:** `WhtType.DefaultPayableAccountId`, `BusinessUnit.DefaultRevenueAccountId`.

### 3.3 JE templates — one fixed table per document **[V]**
BU = `BusinessUnitId` snapshotted onto every line from the document (`BuildAndPostAsync`) unless stated. All amounts THB, 2 dp.

**T1 Tax Invoice** — `GlPostingService.PostTaxInvoiceAsync`; JE date = `glDate ?? ti.DocDate`; ref = DocNo

| Dr/Cr | Account source | Amount source |
|---|---|---|
| Dr | `ArAccount` | `TaxInvoice.TotalAmount` |
| Cr | `SalesAccount` (one account for **all** lines incl. exempt/zero-rated) | `TaxInvoice.SubtotalAmount` |
| Cr (if > 0) | `OutputVatAccount` | `TaxInvoice.TaxAmount` |

**T2 Non-VAT Invoice (BillingNote) issue** — `PostBillingNoteAsync` (throws `gl.bn_vat_unexpected` if `VatAmount≠0`)

| Dr/Cr | Account source | Amount source |
|---|---|---|
| Dr | `ArAccount` | `bn.TotalAmount` |
| Cr | `SalesAccount` | `bn.TotalAmount` |

**T3 Receipt** — `PostReceiptAsync`; date = `glDate ?? rc.DocDate`

| Dr/Cr | Account source | Amount source | BU |
|---|---|---|---|
| Dr | `CashAccount` if `PaymentMethod==Cash` else `BankAccount` (Transfer/Cheque/CreditCard/Other all → 1120) | `CashReceived` (= Amount − WHT) if WHT>0 else `Amount` | null |
| Dr (WHT>0) | `WhtReceivableAccount` | `Receipt.WhtAmount` (Σ `ReceiptWhtLine`) | header BU (null if cross-BU) |
| Cr per TI application | `ArAccount` | `AppliedAmount` | that TI's BU |
| Cr per BillingNote application with `JournalEntryId≠null` (accrued) | `ArAccount` | `AppliedAmount` | BN's BU |
| Cr per DO application or not-yet-accrued BN | `SalesAccount` ("Sales (non-VAT receipt)") — **cash-basis revenue** | `AppliedAmount` | header BU |
| Cr (no applications, standalone non-VAT) | `SalesAccount` | `Amount` | header BU |

**T4 Credit Note** — `PostTaxAdjustmentNoteAsync` (Credit)

| Dr/Cr | Account source | Amount source |
|---|---|---|
| Dr | `SalesReturnAccount` (4100) | `SubtotalAmount` |
| Dr (tax>0) | `OutputVatAccount` | `TaxAmount` |
| Cr | `ArAccount` | `TotalAmount` |

**T5 Debit Note** — same method (Debit)

| Dr/Cr | Account source | Amount source |
|---|---|---|
| Dr | `ArAccount` | `TotalAmount` |
| Cr | `SalesReturnAccount` (**4100 again** — a debit note credits the "sales return/discount" account) | `SubtotalAmount` |
| Cr (tax>0) | `OutputVatAccount` | `TaxAmount` |

**T6 Vendor Invoice** — `PostVendorInvoiceAsync`; date = `vi.DocDate`

| Dr/Cr | Account source | Amount source |
|---|---|---|
| Dr per line | `line.ExpenseAccountId` | `Amount` if (`vi.HasInputVat` ∧ `line.IsRecoverableVat`) else `Amount+VatAmount` |
| Dr per recoverable line (VAT>0) | `InputVatAccount` | `line.VatAmount` |
| Cr | `ApAccount` | Σ(`Amount+VatAmount`) |

**T7 Payment Voucher settling a VI** — `PostPaymentVoucherAsync` (`VendorInvoiceId≠null`)

| Dr/Cr | Account source | Amount source |
|---|---|---|
| Dr | `ApAccount` | `Subtotal + Vat` |
| Dr (self-withhold ∧ WHT>0) | `pv.Lines.First().ExpenseAccountId` (**always the first line**, whichever line carried the WHT) | `WhtAmount` (gross-up cost) |
| Cr (WHT>0) | `WhtPayableAccount` | `WhtAmount` |
| Cr | `CashAccount` if Cash else `BankAccount` | `TotalPaid` (= Subtotal+Vat−WHT under DEDUCT; = Subtotal+Vat under gross-up) |

**T8 Standalone PV** — same method (`VendorInvoiceId==null`)

| Dr/Cr | Account source | Amount source |
|---|---|---|
| Dr per line | `line.ExpenseAccountId` | `Amount` if recoverable else `Amount+VatAmount` |
| Dr per recoverable line | `InputVatAccount` | `VatAmount` |
| Dr (self-withhold) | first line's expense account | `WhtAmount` |
| Cr (WHT>0) | `WhtPayableAccount` | `WhtAmount` |
| Cr | cash/bank as T7 | `TotalPaid` |

**T9 Expense claim pay** — `PostExpenseClaimAsync`; date = server-today (claim has no DocDate); **no WHT line ever**

| Dr/Cr | Account source | Amount source |
|---|---|---|
| Dr per line | `line.ExpenseAccountId` | `Amount` if recoverable else `Amount+VatAmount` |
| Dr (one line) | `InputVatAccount` | Σ recoverable `VatAmount` |
| Cr | `CashAccount` if CASH, else **`BankAccount.GlCashAccountId`** of `claim.BankAccountId` | `claim.TotalAmount` |

**T10 Payroll run post** — `PostPayrollRunAsync`; date = `run.PayDate`; no BU

| Dr/Cr | Account source | Amount source |
|---|---|---|
| Dr | `SalaryExpenseAccount` | `TotalGrossTaxable + TotalGrossNonTaxable` |
| Dr (>0) | `EmployerSsoExpenseAccount` | `TotalSsoEmployer` |
| Cr (>0) | `PitPayableAccount` | `TotalPit` |
| Cr (>0) | `SsoPayableAccount` | `TotalSsoEmployee + TotalSsoEmployer` |
| Cr | `NetWagesPayableAccount` | `TotalNet` |
| Cr (>0) | `OtherDeductionsPayableAccount` | `TotalOtherDeductions` |

**T11 Payroll pay** — `PayrollRunService.PayAsync` → `PostManualEntryAsync`; date = PayDate

| Dr/Cr | Account source | Amount source |
|---|---|---|
| Dr | literal `"2170"` | `TotalNet` |
| Cr | selected active `BankAccount.GlCashAccountId` (literal `"1120"` if that id is 0; literal `"1110"` if no bank accounts exist) | `TotalNet` |

**T12 Depreciation run** — `FixedAssetService.GenerateDepreciationAsync`; date = month-end; ref `DEP-yyyymm`

| Dr/Cr | Account source | Amount source |
|---|---|---|
| Dr (grouped per account) | `asset.DepExpenseAccountId` | Σ charge |
| Cr (grouped per account) | `asset.AccumDepAccountId` | Σ charge |

Charge: first month day-prorated (ม.65ทวิ(2) / พรฎ.145 per code comment), then 1 unit/month, final charge = remaining.

**T13 Disposal / write-off** — `DisposeCoreAsync` (write-off: proceeds=VAT=0)

| Dr/Cr | Account source | Amount source |
|---|---|---|
| Dr (>0) | `CashAccount` (1110, never bank) | `proceeds + VAT` |
| Dr (>0) | `asset.AccumDepAccountId` | `AccumulatedDepreciation` |
| Cr | `asset.AssetCostAccountId` | `Cost` |
| Cr (>0) | `OutputVatAccount` | user-supplied `VatAmount` |
| Cr / Dr | `GainOnAssetDisposalAccount` / `LossOnAssetDisposalAccount` | `proceeds − NBV` (sign decides) |

**T14 Fixed-asset acquisition** — **no JE** (the linked VI booked cost; `IsCapex` category defaults to 1610).

**T15 Bank-rec inline JE** — `BankReconciliationService.CreateJournalAsync`; date = statement `TxnDate`; no BU

| Dr/Cr | Account source | Amount source |
|---|---|---|
| MoneyIn — Dr | `BankAccount.GlCashAccountId` of the statement line's bank account | `StatementLine.Amount` |
| MoneyIn — Cr | user-picked contra account (`req.ContraAccountId`; active, non-header, same tenant) | `StatementLine.Amount` |
| MoneyOut — Dr | user-picked contra account | `StatementLine.Amount` |
| MoneyOut — Cr | `BankAccount.GlCashAccountId` | `StatementLine.Amount` |

**T16 Manual JV** — `JournalService.CreateAndPostManualAsync`: caller's lines (any active, non-header, same-tenant account — **including AR/AP/VAT/WHT control accounts**), per-line description and BU.

**T17 Year-end close / reopen** — `YearCloseService`: for each Revenue/Expense account with non-zero net over the FY (excl. closing entries): reverse its balance; balancing line to literal `"3300"`; `IsClosingEntry=true`; date = FY end; posted via `PostClosingEntryAsync` (no period gate). Reopen posts the mirror (`ReversalOfId`).

**T18 ภ.พ.36 reverse charge (on finalize)** — `WhtFilingService.PostReverseChargeJvAsync` via `IJournalService.CreateDraftAsync`+`PostAsync`

| Dr/Cr | Account source | Amount source |
|---|---|---|
| Dr | literal `"1170"` (VAT co.) **or** `IrrecoverableVatExpenseAccount` 5350 (non-VAT co.) | Σ over PV rows of `decimal.Round(PV.SubtotalAmount × 0.07m, 2)` — literal rate **and banker's rounding** (`decimal.Round` without `MidpointRounding`) |
| Cr | literal `"2151"` | same |

Note: `CreateDraftAsync` ignores the requested dates and pins the JE to server-today (finalize day), not the filing month.

**T19 Non-VAT AR backfill** — `NonVatArBackfillService.ApplyAsync`: Dr `ArAccount` / Cr `SalesAccount` (current FY) or Cr `RetainedEarningsAccount` (invoice from a closed prior FY); amount = outstanding; dated original date if open else today.

**T20 Cancel/reissue reversal** — `GlPostingService.PostReversalAsync`: exact line-for-line mirror of the original JE (Dr↔Cr, same accounts and BU), `ReversalOfId` set; refuses non-Posted sources and closing entries. The replacement document then posts a normal T1/T3.

**T21 Gross-up / self-withhold WHT** — not a separate JE: the three PV modes alter `WhtAmount`, `TotalPaid` and the extra Dr in T7/T8 (formulas §6.3). **T22 ภ.ง.ด.54 foreign WHT** — no separate JE: a foreign vendor PV (T7/T8) with a `WhtType.FormType=Pnd54` certificate; default mode `GROSS_UP_FOREVER`.

**T23 What the system does NOT post (must be hand-keyed):** remittance of VAT / WHT / PIT / SSO / CIT to RD or SSO; month-end VAT netting (Dr 2151 / Cr 1170 / Cr payable); CIT expense/payable; sales discounts; bad-debt write-off & ม.82/11 VAT recovery; FX; accruals/prepaids; customer deposits.

### 3.4 Asymmetries visible in the tables
- Cash side: Receipt/PV → global `1110/1120`; EC/Payroll/Bank-rec → `BankAccount.GlCashAccountId`; FA disposal → `1110` only.
- Revenue side: one `4000`; returns and debit-notes share `4100`; exempt/zero-rated revenue is not separated in the GL (it is separated only in the document-derived ภ.พ.30).
- Input VAT is debited to `1170` at **VI post date**, not in the `vat_claim_period` month (no deferred-input-VAT account), so GL 1170 and the ภ.พ.30 claim can differ in time.
- Payroll pay and ภ.พ.36 use literals; year-close uses a literal; everything else uses options.

---

## 4. Chart of accounts

| Aspect | TEAS 1 behaviour **[V]** |
|---|---|
| Table | `master.chart_of_accounts`, per company; unique `(company_id, account_code)` (`Inf/Persistence/Configurations/Master/ChartOfAccountConfiguration.cs`) |
| Code format | free string, validator `^\d{2,10}$` (digits only), max length 20; entity comment says "5-digit hierarchical" but defaults are **4-digit** (`1110`, `4000`…). Code is **immutable** after create (`UpdateAccountRequest` has no code) |
| Classes | `AccountType` = Asset, Liability, Equity, Revenue, Expense (CHECK constraint). `NormalBalance` DR/CR (contra accounts: `1690` = Asset/CR, `4100` = Revenue/DR). **No account sub-type**; P&L spec comment defers COGS/OpEx split to a never-built "account_subtype" |
| Hierarchy | `ParentId` self-FK (Restrict), `IsHeader`; API requires parent to be a header; **no cycle/depth check**; **UI always sends `parentId:null, isHeader:false`**; reports ignore hierarchy (flat lists keyed by `AccountType`) |
| Seeding | New company: `CompanyService.CreateAsync` inserts 30 flat accounts (`DefaultChartOfAccounts`) + 16 WHT types + 12 tax codes + 19 expense categories + cloned roles, all in one tx with `app.company_id` re-pinned. Demo companies: SQL seeds (gated by `Database:SeedDemoData`) |
| Editability | API `POST/PUT /accounts` (`Api/Endpoints/MasterEndpoints.cs`) and UI `frontend/app/(dashboard)/settings/chart-of-accounts/page.tsx` (create + edit name/active; type/normal-balance chosen only at create). **No delete anywhere** (UI comment "INV-6"); deactivate is the only retire |
| Guards | header-flip refused if the account has POSTED lines (`coa.has_postings`); deactivate/header-flip refused for any code in `GlAccountsOptions.AllCodes()` (`coa.system_account`); posting requires active + non-header + same tenant (checked in app because `journal_lines.account_id` has no FK and RLS cannot see it) |
| Statutory coupling | ภ.ง.ด.50 schedules map GL accounts to RD boxes by **numeric code ranges** — 5100-5199 rent, 5200-5299 other fees, 5300-5349 marketing, 5350-5399 other taxes, 5400-5499 employee costs, 5500-5599 finance cost, else "other"; BS: 1110-1129 cash, 1130-1139 AR, 1140-1149 inventory, 1500-1999 non-current assets, 2110 AP, 2500-2999 non-current liabilities, 3100-3199 capital, 3200-3299 retained (the default retained-earnings account `3300` therefore lands in "other equity") — `Inf/Tax/Pnd50FilingService.cs:340-460`. A company that renumbers its CoA gets silently wrong return boxes. |
| Triggers | none specific to the CoA table (RLS only) |

---

## 5. Periods & closing

**Monthly periods** — `Inf/Ledger/PeriodCloseService.cs` **[V]**
- Row per `(company, year, month)`, calendar months only.
- `IsOpenAsync`: an explicit row is authoritative. **No row ⇒ open only for the current Asia/Bangkok month; every other missing month (past or future) is treated as CLOSED.** There is no "open period" endpoint: a never-opened past month can only be reached by `close` (creates a Closed row) then `reopen`.
- `CloseAsync` refuses when any **Draft TI / Draft PV / Draft JE / replacement-Receipt draft** has a DocDate in the month (`period.draft_present`) — *other* draft types are not checked; and when active fixed assets are due depreciation and no posted run exists for the month (`period.depreciation_required`).
- `ReopenAsync` (permission `gl.period.close`, audited) flips Closed→Open via a conditional `ExecuteUpdate`; refused inside a closed fiscal year (`period.year_closed`). Monthly close posts no JE, so reopen reverses nothing.
- Gate callers (`EnsureOpenAsync`): TI create/post, RC create/post, CN/DN create/post, VI create/post (+ claim-period gate), PV create/post, EC pay, BN issue (non-VAT only), manual JV, depreciation run, dispose/write-off, payroll post/pay (on **PayDate**), bank-rec JE, AR backfill. `PostClosingEntryAsync` deliberately has **no** gate. `PostManualEntryAsync` has no gate either — each *caller* owns it.

**Year-end** — `Inf/Ledger/YearCloseService.cs` **[V]**
- Fiscal year = `Company.FiscalYearStartMonth`, `FiscalYear` = start calendar year. Close requires **all 12 months explicitly Closed** (a missing row counts as not closed here, unlike `IsOpenAsync`).
- Sweep: per Revenue/Expense account over POSTED, non-closing lines in [FY start, FY end] (range, not cumulative), one JE to literal `3300`, `IsClosingEntry=true`, dated FY end; zero activity ⇒ no JE but still a `fiscal_year_closes` row. No income-tax provision, dividend, or appropriation lines.
- Reports: Trial Balance / Balance Sheet / GL **include** closing entries; P&L, CIT base, next-year sweep **exclude** them (`!IsClosingEntry`). Balance sheet computes "current-period earnings" as a single line.
- Reopen FY: conditional `ReversedAt` claim (double-reopen guard) then a mirror JE with `ReversalOfId`; the reversed row stays for audit; a re-close is allowed.
- Year-lock enforcement for ordinary posting: `JournalService.EnsurePostableDateAsync` checks open FY close rows; other posters rely on "FY closed ⇒ all 12 months Closed ⇒ `EnsureOpenAsync` fails".

---

## 6. Tax engine

### 6.1 Where each calculation lives

| Engine | Location | Pure? | Notes |
|---|---|---|---|
| VAT line math (sales) | `Inf/Sales/TaxInvoiceService.cs` `BuildLine` (inclusive+exclusive) and `Inf/Sales/QuotationChainServices.cs` `ChainMath.Line` (exclusive only; used by QT/SO/DO/BN/PO) | **No** — private statics in Infrastructure, duplicated | rule resolution in `Inf/Sales/SalesLineBackstop.cs` |
| VAT math (purchase) | inline in `VendorInvoiceService.BuildLinesAsync`, `PaymentVoucherService.CreateDraftAsync`, `ExpenseClaimService.BuildLinesAsync`; CN/DN inline in `TaxAdjustmentNoteService.CreateDraftAsync` | No | 22 files contain `MidpointRounding` (64 call sites) |
| WHT math | `Dom/Tax/WhtPayerModes.cs` (`Compute`, `Condition`), `App/Sales/ReceiptWhtAllocator.cs` | **Yes** | the rest of WHT (rate lookup, cert build) is in services |
| PIT / SSO / proration | `Dom/Payroll/ThaiPitCalculator.cs`, `PitSchedule.cs`, `PayrollMath.cs` | **Yes** | `PitSchedule.Current()` is code (not config); SSO/allowances come from `Payroll:*` options |
| CIT | `Dom/Tax/CitCalculator.cs`, `CitRateSchedule.cs`, `CitLossCarryForward.cs` | **Yes** | schedules are code ("a rate change is a code/seed edit, never a UI setting") |
| Number/ID rules | `Dom/ValueObjects/DocumentNumber.cs`, `ThaiTaxId.cs`, `BranchCode.cs`, `DocumentLabels.cs` | **Yes** | |
| Returns/registers | `Inf/TaxFilings/*`, `Inf/Reports/VatReportService.cs`, `Inf/Tax/Pnd50/51FilingService.cs`, `Inf/Payroll/Pnd1/SsoFilingService.cs` | No | derive from documents (VAT/WHT/payroll) or GL (CIT) — §6.6 |

### 6.2 VAT
- **Rate / registration:** per company on `master.companies` — `VatRegistered` (bool), `VatRate` (one scalar, default 0.07, validated 0..1), `Pnd30SubmissionMode`. Changeable only via super-admin `master.company.manage` (`PUT /companies`), every change audited as `tax_config_change`; no user-facing VAT settings UI (§4.6 decision). Served per request by `ICompanyTaxConfigService`. **Not effective-dated** (the `TaxRate` table is unused); statutory rate changes (the 7% reduction is renewed by decree — `Tax-Reference-TH.md` §1.1) are a manual master-data edit.
- **Server-side derivation (never trust the caller):** `SalesLineBackstop.Resolve` ladder — (1) non-VAT company ⇒ rate 0, code VAT0; (2) tax code found in the company master ⇒ rate = 0 if exempt/zero-rated else company rate, code casing taken from the master; (2c) a taxable/zero-rated code on an EXEMPT_GOOD/EXEMPT_SERVICE *product* is discarded (ม.81 is a property of the product master); (3) product's curated exempt output code; (4) company's lowest-id active exempt output code; (5) synthetic `("EXEMPT", id 0)`; (6) company standard output code; (7) synthetic `("VAT7", id 0)`. Product type is always overridden from the product master. Chain-copy paths into a Tax Invoice — `CreateFromBillingNoteAsync`, `CreateFromDeliveryOrderAsync`, `CreateFromSalesOrderAsync`, `CreateFromQuotationAsync` — pass `deriveLineTax:false`: they **inherit the source line's rate and copy its `TaxCodeId` verbatim** (no re-derivation). `SanitizeInheritedTaxCode` (re-maps a foreign/orphan tax-code id to this company's master) is called **only from the BillingNote line builders** (`BillingNoteService.cs:141,209,589`), not from the →TI builders. **There are two DO→TI paths with different derivation:** the draft-only `CreateFromDeliveryOrderAsync` (`deriveLineTax:false`) versus the legacy `DeliveryOrderService.CreateTaxInvoiceAsync`→`GenerateTiAsync`, which calls `TaxInvoiceService.CreateDraftAsync` (`deriveLineTax:true`, re-derives) and then **auto-posts**. Both paths yield the same rate because **every request-fed origin builder already calls `SalesLineBackstop.Resolve`** (QT `QuotationChainServices.cs:146,240`; SO/DO `SalesOrderDeliveryServices.cs:61,130,214,369`; BN `BillingNoteService.cs:542`; TI `TaxInvoiceService.cs:520`); the legacy path's extra re-derivation is idempotent. (The comment in `GenerateTiAsync` saying DO builders "store raw `l.TaxRate`" is stale.)
- **Inclusive vs exclusive:** `IsTaxInclusive` exists on the TI header only. Exclusive: `gross=round(qty×price,2); net=round(gross×(1−disc%/100),2); vat=round(net×rate,2); total=net+vat`. Inclusive: `total=afterDisc; vat=round(total×rate/(1+rate),2); net=total−vat`.
- **Rounding:** `MidpointRounding.AwayFromZero` (HALF_UP) to 2 dp, applied **per line**; header = Σ of rounded lines (`Taxable = Σ net where rate>0`, `NonTaxable = Subtotal − Taxable`). No header-level rounding mode. `Tax:VatRounding` / `Tax:VatDecimalPlaces` are bound (`Api/Program.cs` `TaxConfig`) but **never referenced**. The ledger rejects >2-dp amounts (`je.precision`) rather than rounding; there is no rounding-difference account.
- **Non-registered company:** TI creation/post/update blocked (`ti.non_vat_blocked`); neutral document labels (`DocumentLabels.TaxInvoiceHeader`, config `Tax:NonVatDocLabelTh/En`); CN/DN cite ม.82/9 instead of ม.86/9–10; ภ.พ.30 blocked (`pp30.non_vat_blocked`); VI/PV/EC force `IsRecoverableVat=false` (VAT folded into cost); ภ.พ.36 still applies (expense account 5350).
- **Input-VAT gate (purchases):** `vat_claim_period` default = vendor-TI month, allowed window TI month … +6 (`VendorInvoiceService.EnsureClaimInWindow`, cited ม.82/4), claim period must be an open accounting period; line `IsRecoverableVat` is **snapshotted from `ExpenseCategory.DefaultIsRecoverableVat` at draft and never re-resolved at post**; `HasInputVat = !(vendor not VAT-registered ∨ (foreign ∧ no Thai VAT-D))`; `VendorInvoice.VatAmount` = recoverable only, `NonRecoverableVatAmount` folded to expense.
- **PV guards (`CreateDraftAsync`):** vendor not VAT-registered ⇒ VAT must be 0 (ม.82/5); EXEMPT_* product ⇒ 0 (ม.81); otherwise rate ∈ {0, company standard} (`pv.vat_rate_invalid`).
- **Forbidden input VAT:** default expense categories mark entertainment (`ENT`) and passenger car (`VEHI`) non-recoverable (`DefaultExpenseCategorySpecs`); VAT is debited into the expense.
- **ภ.พ.30** (`TaxFilingService.GeneratePnd30Async`): output = `SalesCategorizer` over POSTED TI lines (taxable/zero-rated/exempt by tax-code flags, fallback `rate>0 ⇒ taxable`) ± CN/DN routed to the *original TI's* category; input = Σ `VendorInvoice.VatAmount` where `VatClaimPeriod==period ∧ HasInputVat ∧ VatAmount>0`; **shared-input apportionment `sharedInputVat = 0m` (Phase 1), credit carry-forward `0m`**; due day 15; finalize ⇒ immutable `tax.tax_filings`; filing company/branch printed as `"00000"`.

### 6.3 Withholding tax
- **Per line.** PV line carries `WhtTypeId` (default from category) and `WhtRate`; `WhtPayerModes.Compute(net, rate, mode)` (2-dp HALF_UP):
  - `DEDUCT` (50ทวิ เงื่อนไข 1): `wht = round(net×r,2)`; cert income = net; cash = subtotal+vat−wht.
  - `GROSS_UP_FOREVER` (เงื่อนไข 2): `income = round(net/(1−r),2)`; `wht = round(income×r,2)`.
  - `GROSS_UP_ONCE` (เงื่อนไข 3): `income = round(net×(1+r),2)`; `wht = round(income×r,2)`.
  Self-withhold ⇒ vendor paid in full, WHT is an extra expense to the *first* line's account, remitted separately. Foreign vendor without Thai VAT-D ⇒ `GROSS_UP_FOREVER` automatically + `RequiresPnd36ReverseCharge`.
- **Rate source:** *PV:* `WhtRate` is **caller-supplied**, only bounded to [0,1]; it is not cross-checked against `WhtType.Rate` (`WhtTypeService.ResolveAtDateAsync` exists but is not called by PV create). *Receipt side:* rate = `WhtType.Rate` read server-side per `ReceiptWhtLine` (`round(base×rate,2)`), base allocated by `ReceiptWhtAllocator` pro-rata to the paid fraction of each TI's service lines.
- **Rates / forms:** `wht_types` seeded per company (`CompanyService.DefaultWhtTypes`, 16 defaults = 13 domestic + 2 foreign + 1 Pnd2; rate %: SVC 3, RENT 5, ADS 2, PROF 3, TRANS 1, COMM 3, ROYAL 3, INT 1, PRIZE 5, AGRI 0.75, ENTERTAIN 5, CONTRACT 3, SVC-IND 3, FOR-SVC 15 and FOR-ROYAL 15 [Pnd54], INT-IND 15 [Pnd2]); effective-dated via `ChangeRateAsync` (close old row, open new); `FormType` routes the certificate: Pnd54 honoured as set; Pnd2 only for an Individual payee else falls back; otherwise Individual→Pnd3, Corporate→Pnd53 (`PaymentVoucherService.PostCoreAsync`).
- **Certificates:** one 50ทวิ per income type per PV, own `WT` sequence, payer TaxId must be non-blank/non-all-zero; PDF frozen on first render (`PdfStoragePath`). Receivable (Direction R) rows share the customer's single cert number.
- **Returns:** ภ.ง.ด.2/3/53/54 = `WhtCertificate` rows (Direction P, Posted) by `CertDate` month filtered **positively on FormType** (disjoint partition); due 7th; PND2 forced manual.
- **ภ.พ.36 reverse charge:** rows from POSTED PVs flagged `RequiresPnd36ReverseCharge` by **PV DocDate month** (payment is the tax point — rule recorded as confirmed by Ham 2026-08-20 on a practitioner guide; STATUS.md lists CPA sign-off as outstanding); `vat = round(subtotal×0.07m,2)` with a **literal** rate (twice: `GeneratePnd36Async`, `DetectUnreconciledAsync`); finalize posts T18 and is guarded by an "unexplained AP debit" acknowledgement bound to the figure the filer saw.

### 6.4 PIT (payroll) and SSO
`Inf/Payroll/PayrollRunService.CreateDraftAsync`: calendar-day proration (`SalaryProration.MonthlyGross`), projected-annual ม.50(1): `annual income = YTD + month×monthsRemaining(13−month)`, ม.42ทวิ expense = min(50%, 100,000), allowances personal 60,000 / spouse 60,000 / child 30,000 + SSO allowance (cap 10,500), progressive bands 0–150k 0%, 5/10/15/20/25/30/35%; monthly PIT = `round((annualTax − YTD PIT)/monthsRemaining, 2)`, floor 0. SSO = `round(clamp(salary, floor 1,650, ceiling 17,500) × 5%, 2)` employee = employer (config `Payroll:Sso`). ภ.ง.ด.1 follows **PayDate month**; ภ.ง.ด.1ก needs a posted run; SSO สปส.1-10 file/PDF.

### 6.5 CIT
`CitCalculator.Compute`: `taxable = accountingProfit + adjustments(signed)`; loss carry-in reduces the **base** (capped; 5-year pool, oldest first — ม.65ตรี(12)); `tax = band walk` (General 20% flat; SME 0/15/20 at 300k/3M); credits (ภ.ง.ด.51 prepay + WHT suffered) reduce the **tax**, floor 0, refund derivable. SME predicate `PaidUpCapital ≤ 5M ∧ revenue ≤ 30M` (null capital ⇒ General) in `CitYearDataService.ProfileAsync`. ภ.ง.ด.51 method A = half the CIT on the estimated full-year profit minus H1 WHT; ม.67ตรี penalty = 20% of shortfall when the estimate understates by >25%. **Accounting profit comes from `IFinancialReportService.ProfitLossAsync` (GL, Revenue/Expense by `AccountType`, excl. closing entries).** No CIT expense/payable is ever posted.

### 6.6 Source of each return (documents vs GL) **[V]**

| Output | Derived from | Entry |
|---|---|---|
| ภ.พ.30, output & input VAT registers (ม.87) | **documents**: POSTED TI lines, CN/DN, VI by `VatClaimPeriod` | `TaxFilingService`, `VatReportService` |
| 50ทวิ, ภ.ง.ด.2/3/53/54 | **documents**: `WhtCertificate` | `WhtFilingService.WhtAsync` |
| ภ.พ.36 | **documents**: PV flags (+ GL read only for the AP-debit advisory) | `WhtFilingService.GeneratePnd36Async` |
| ภ.ง.ด.1/1ก, SSO | **documents**: payroll runs/payslips | `Pnd1FilingService`, `SsoFilingService` |
| ภ.ง.ด.50/51 | **GL** (`AccountType`) + manual `CitAdjustment` + `CitYearSummary`; schedules by **code ranges** | `CitYearDataService`, `Pnd50FilingService` |
| TB, BS, GL, P&L, year-close | **GL** (`AccountType`, `IsClosingEntry`) | `FinancialReportService`, `YearCloseService` |
| AR aging / customer statement / vendor ledger | **documents**, reconciled to GL control accounts 1130/2110 | `SubledgerReportService` |
| ม.85 1.8M threshold | TI `TotalAmountThb` rolling 12 months | `VatThresholdService` |

The documented "3-way tie-out" (`Tax-Reference-TH.md` §1.7: ภ.พ.30 = register = GL) is true **by construction** of the posters, not by a runtime check; manual JVs, FA-disposal VAT, standalone-PV VAT and ภ.พ.36 can make the GL and the return diverge.

### 6.7 Rounding register (everything is `decimal`; storage `numeric(19,4)`; ledger accepts only 2 dp) **[V]**

| Calculation | Method | Where |
|---|---|---|
| Sales line gross, after-discount, VAT | `Math.Round(x, 2, AwayFromZero)` (HALF_UP) at each step; header = Σ rounded lines | `TaxInvoiceService.BuildLine`, `ChainMath.Line` |
| Inclusive VAT | `round(total × r / (1+r), 2)`, `net = total − vat` | `BuildLine` |
| CN/DN VAT | `round(AdjustmentSubtotal × effectiveRate, 2)` on one lump | `TaxAdjustmentNoteService.CreateDraftAsync` |
| VI / PV / EC line net and VAT | HALF_UP 2 dp (`net=round(amount,2)`, `vat=round(net×rate,2)`) | `VendorInvoiceService`, `PaymentVoucherService`, `ExpenseClaimService` |
| WHT (3 payer modes) | HALF_UP 2 dp (closed forms in §6.3) | `WhtPayerModes.Compute` |
| 50ทวิ effective rate | `round(wht/income, 6)` HALF_UP | `PaymentVoucherService.PostCoreAsync` |
| Receipt WHT base / amount | base `round(Σ line×paidFraction, 2)`, amount `round(base×rate, 2)` HALF_UP | `ReceiptWhtAllocator`, `ReceiptService` |
| `TotalAmountThb` | `round(total × fx, 4)` HALF_UP (dormant: fx = 1) | all documents |
| PIT, SSO, salary proration | HALF_UP 2 dp | `ThaiPitCalculator`, `SsoContribution`, `SalaryProration` |
| Depreciation | monthly `round(base/life, 2)`; first month day-fraction 4 dp; final charge = remaining balance | `FixedAssetService`, `FixedAsset.FirstMonthFraction` |
| CIT tax, ภ.ง.ด.51 half-year, ม.67ตรี penalty | HALF_UP 2 dp | `CitCalculator` |
| **ภ.พ.36 VAT per PV row** | `decimal.Round(x, 2)` ⇒ **banker's (ToEven)** — inconsistent | `WhtFilingService.cs:326,517` |
| Input-VAT claim ratio / claimable | `decimal.Round(…, 6)` / `(…, 4)` ⇒ banker's (value is 0 today) | `ProportionalInputVatService.cs:32`, `TaxFilingService.cs:59` |
| Ledger | **no rounding** — any amount with > 2 dp is rejected (`je.precision`); no rounding-difference account or line | `JournalEntry.MarkPosted` |

---

## 7. Tax-posting core boundary (proposal)

### 7.1 Principle
**Core = everything whose output is a legal document, a legal number, a statutory amount, or a statutory return.** It consumes master/tax configuration and commands, and emits (a) immutable documents and certificates, (b) tax amounts, (c) filings/registers, and (d) **posting intents expressed as role-tagged amounts — never GL account ids.** Everything about *which account* is outside the core.

```
 masters + tax config ─┐                              ┌──► documents / 50ทวิ / registers / RD forms
 commands (draft/post/ ├─►  TAX-POSTING CORE  ───────►│
  cancel/approve)      │   (C1…C9)                    └──► PostingIntent{doc, date, THB,
 clock (Bangkok) ──────┘        ▲   │                         lines[{role, side, amount, dims}]}
 period gate (port) ────────────┘   │                                  │
                                    │ (only CIT reads back)            ▼
                          GL P&L by statement class ◄──── LEDGER KERNEL: account resolver,
                                                           JE numbering, balance check, immutability
```

### 7.2 Components (TEAS 1 files) with inputs/outputs

| # | Component | TEAS 1 evidence | Inputs → outputs |
|---|---|---|---|
| C1 | **Numbering & issuance kernel** | `Dom/ValueObjects/DocumentNumber.cs`; `Inf/Numbering/NumberSequenceService.cs`, `NumberedDocumentWriter.cs`; each entity's `MarkPosted`; `SQL/050,613,626,634,635,644` | (company, prefix, sub, date) → gap-free number allocated inside the posting tx; collision-retry; gap & duplicate audit |
| C2 | **Immutability & audit kernel** | triggers in §2.4 (`SQL/020…643`); `Inf/Audit/ActivityRecorder.cs`; RLS `SQL/010,600`; `AccountingDbContext` tenant filter | state machine guards + DB freeze lists + append-only audit |
| C3 | **VAT output engine** | `Inf/Sales/SalesLineBackstop.cs`, `TaxInvoiceService.BuildLine`, `QuotationChainServices.cs ChainMath`, `TaxAdjustmentNoteService` VAT derivation, `Dom/ValueObjects/DocumentLabels.cs`, `Inf/Master/CompanyTaxConfigService.cs`, TaxCode master | (lines, company tax config, product master) → rate/code/net/vat/total; TI/CN/DN content (ม.86/4 8 items, snapshots); TI cancel/replace/amount-lock |
| C4 | **VAT input engine** | `VendorInvoiceService` (claim window, recoverable snapshot), `PaymentVoucherService` (ม.82/5, ม.81, rate guard), `ExpenseClaimService` non-VAT forcing | (vendor flags, category, company mode) → recoverable/non-recoverable VAT split, claim period |
| C5 | **VAT returns & registers** | `Inf/TaxFilings/{SalesCategorizer,ProportionalInputVatService,TaxFilingService,TaxFilingStore,Pp30Batch*}.cs`, `Inf/Reports/VatReportService.cs`, `Inf/Pdf/Pnd30FormFiller.cs`, `VatRegFormFillers.cs` | posted documents → ภ.พ.30, ม.87 registers, immutable filing row |
| C6 | **WHT engine** | `Dom/Tax/WhtPayerModes.cs`, `App/Sales/ReceiptWhtAllocator.cs`, `Dom/Entities/Tax/WhtType.cs`, cert build in `PaymentVoucherService.PostCoreAsync`, `Inf/TaxFilings/WhtFilingService.cs` (+ batch/PDF fillers), reverse-charge incl. `PostReverseChargeJvAsync` | (payment lines, payee kind, WHT type @ date, mode) → amounts, 50ทวิ rows, ภ.ง.ด.2/3/53/54, ภ.พ.36 |
| C7 | **Payroll tax** | `Dom/Payroll/*`, `Inf/Payroll/{PayrollRunService,Pnd1FilingService,SsoFilingService}.cs` | (employee master, YTD, config) → PIT, SSO, ภ.ง.ด.1/1ก, สปส.1-10 |
| C8 | **CIT** | `Dom/Tax/*`, `Inf/Tax/{CitYearDataService,Pnd50FilingService,Pnd51FilingService}.cs`, `Pnd50/51FormFiller.cs` | (GL P&L by statement class, adjustments, losses) → ภ.ง.ด.50/51 — **the only core component that reads the GL** |
| C9 | **Statutory artifacts (format-bound)** | `Inf/Pdf/*FormFiller.cs` + RD templates, `PaperDocumentPdf`/`PaperDocModel`, `Inf/ETax/*` (default-inert) | document/filing → RD PDF/XML |

### 7.3 Invariants the core must keep identical (each is testable from TEAS 1 behaviour)
1. **Server-derived VAT:** line rate/code from company master + tax-code flags + product master, never request input; exempt-product clamp; non-VAT company ⇒ zero VAT and TI blocked. (`SalesLineBackstop.Resolve`, `ti.non_vat_blocked`). *Property to preserve explicitly:* derivation runs at **every request-fed origin builder** (QT, SO, DO, BN, TI — call sites in §6.2); chain-copy →TI paths then inherit the already-derived rate/code verbatim (`deriveLineTax:false`), and the legacy DO→TI path re-derives idempotently.
2. **Money rounding:** per-line HALF_UP (away-from-zero) 2 dp; header = Σ lines; ledger rejects >2 dp and requires exact ΣDr=ΣCr. (`BuildLine`, `JournalEntry.MarkPosted`)
3. **ม.86/4 content:** supplier name/address/TIN/branch and buyer snapshot frozen at draft; buyer TIN+branch mandatory when VAT-registered; VAT shown separately; `DocDate == TaxPointDate`; "ใบกำกับภาษี" label only for VAT-registered companies; full TI only (ม.86/6 unsupported).
4. **Sequential numbering:** allocated only at post inside the same tx; unique `(company, prefix, sub, year, month)`; format `MM-YYYY-PREFIX[-SUB]-NNNN`; VOIDED keeps its number; company-wide unique `doc_no`; gap & duplicate audit views.
5. **Immutability:** DB triggers + app guards per §2.4; only legal transition `POSTED→VOIDED`; no delete of non-draft; audit append-only incl. TRUNCATE.
6. **Period discipline:** every posting path (except system closing) passes the period gate; VI claim period must be open; replacement documents use the original month's sequence but post to an open GL month.
7. **Input-VAT rules:** ม.82/4 window; recoverable flag snapshotted at draft; ม.82/5 non-registered vendor ⇒ 0; non-VAT company never claims; non-recoverable folded to expense.
8. **WHT rules:** 3 payer modes with the exact closed forms; one 50ทวิ per income type; form routing (Pnd2/3/53/54); payer TIN must be usable; frozen PDF; ภ.พ.36 once per service in the payment month.
9. **Cancel/reissue (TI & Receipt):** preconditions in §2.6; exact mirror reversal; replacement keeps original date & amounts; VOIDED rows listed at 0.00 in registers; no amended ภ.พ.30.
10. **Filing immutability:** one finalized filing per `(company, form, period)`; every RD form refuses a placeholder payer TIN.
11. **Payroll tax:** ม.50(1) projected method, calendar-day proration, SSO clamp, PayDate-month filing; **CIT:** ladder order (loss→base, credits→tax), SME predicate, 5-year loss pool.
12. **Source-of-truth rule:** VAT/WHT/payroll returns read **documents**; CIT/financial statements read the **GL by statement class**.
13. **Tenant isolation:** `company_id` + RLS + query filter on every tenant table (platform invariant that the core's claims depend on).

### 7.4 Couplings to the GL / rest of system that need an adapter once account determination is configurable

| # | Coupling (TEAS 1 evidence) | Proposed seam |
|---|---|---|
| S1 | `GlPostingService.Post*` — 8 document-specific posters (TI, Invoice, Receipt, VI, PV, CN/DN, Expense Claim, Payroll) plus reversal, closing and two manual overloads — resolve accounts by role code from `GlAccountsOptions` | core emits `PostingIntent`; a **posting-profile resolver** maps `(company, role, dimensions) → account` and validates the account class |
| S2 | Literal bypasses: `YearCloseService` `"3300"`; `PayrollRunService.PayAsync` `"2170"/"1120"/"1110"`; `WhtFilingService.PostReverseChargeJvAsync` `"1170"/"2151"`; `MasterDataServices` `"5200"`; `ReceiptService.Read` `"SVC"` | route through the same resolver / WHT-type lookup |
| S3 | `SubledgerReportService` control accounts (1130/2110 from options); `NonVatArBackfillService` | **control-account provider** (role→account set, possibly several per role) |
| S4 | `BankReconciliationReportService` (cash/bank GL ids from options), `BankAccount.GlCashAccountId` partial use | resolve cash/bank role **per BankAccount** for every cash-moving document |
| S5 | `WhtFilingService.DetectUnreconciledAsync` and `JournalService.Pnd36AdvisoryAsync` (AP code) | use S3; or replace with party-tagged AP lines |
| S6 | `ExpenseAccountRule` + `ExpenseCategoryService.EnsureDefaultAccountAsync` denylist built from `GlAccountsOptions` + `bank_accounts` | replace with account **class/usage flags** (postable-by-claim, control, system) |
| S7 | `ChartOfAccountService.UpdateAsync` system-account guard from `AllCodes()` | guard by "account is mapped to a role in any active profile" |
| S8 | `Pnd50FilingService` numeric code ranges | explicit **account → statutory line** mapping (CIT schedule 7, BS boxes) stored as data |
| S9 | `FinancialReportService`, `YearCloseService`, `CitYearDataService` use `AccountType` + `IsClosingEntry` only (clean) | keep `AccountType` (or an equivalent statement class) as a mandatory attribute |
| S10 | Period gate called inline by ~15 services | single `IPeriodGate` port, same semantics (incl. the "no row ⇒ current month only" rule or its replacement) |
| S11 | Doc-number sub-prefix = BU code (dimension leaks into a legal sequence) | make "series scope" an explicit numbering-policy attribute |
| S12 | JE numbering (`JV` prefix, monthly) shared by all posters; gap view covers JV | keep as ledger-kernel concern; extend gap audit to every legal series |
| S13 | Seeding: `CompanyService.CreateAsync` + SQL seeds must contain every mapped code | seed **profile + template CoA together** (`GlAccountsOptionsTests` pins today's list) |
| S14 | Documents↔GL reconciliation is implicit | add explicit tie-out checks (Σ output VAT register vs GL output-VAT role movement, etc.) |

### 7.5 What is outside the core and may change freely
CoA structure/numbering and templates, role→account mapping, dimensions, JV workflows and reversal tooling for *non-tax* documents, recurring/accrual/prepaid engines, opening balances, FX, statement layouts, subledger design, bank-account GL separation, approval workflows — **provided** S1–S14 are honoured and the invariants in §7.3 still hold.

### 7.6 How to prove "behaviourally identical" (characterization fixtures to freeze before rewriting)
Golden-master the *outputs*, not the code: (1) JE lines of T1–T20 for a fixed fixture set (VAT / zero-rated / exempt mix; inclusive vs exclusive; discount; BU on/off; non-VAT company; WHT DEDUCT / GROSS_UP_ONCE / GROSS_UP_FOREVER; foreign vendor; recoverable vs non-recoverable VAT); (2) rounding edge cases from §6.7 (half-satang cases, 1/3-split lines, header vs line sums, the banker's-rounding ภ.พ.36 case — decide whether to keep or fix); (3) numbering: concurrent-post storm ⇒ gap-free, VOIDED retention, collision-retry, BU series split, month rollover; (4) cancel/reissue matrix (§2.6 preconditions, cross-month reversal date, replacement amount lock, register 0.00 rows); (5) period-gate matrix per poster (§5); (6) ภ.พ.30 / ภ.ง.ด.3/53/54/2 / ภ.พ.36 / ภ.ง.ด.1 / ภ.ง.ด.50-51 numbers for a month of mixed documents, including CN/DN routed to the original category; (7) trigger behaviour (§2.4) via direct-SQL attempts. TEAS 1's own suite (Domain 188, Api ~1,384 cases — `STATUS.md`) is the natural seed; the Domain tests already pin the pure engines.

---

## 8. Accounting rigidities

### 8.A Catalogue (class legend in "Conventions")

| ID | Rigidity | Evidence | Class | Legal basis / note |
|---|---|---|---|---|
| **A1** | Role→account map is **instance-wide** (appsettings), not per company; defaults baked in class | `Inf/Ledger/GlAccountsOptions.cs`; `DependencyInjection.cs:119` | D | — |
| A2 | One revenue account for every TI line regardless of product, tax class (taxable/zero/exempt) or BU | `PostTaxInvoiceAsync` | D | ภ.พ.30 category split is document-derived, so GL could split without touching tax |
| A3 | CN/DN both post to `SalesReturnAccount 4100`; DN credits "sales return/discount"; no sales-discount account (line discount is netted into revenue) | `PostTaxAdjustmentNoteAsync` | D | — |
| A4 | Receipt/PV ignore `BankAccountId`; cash/bank are 2 global accounts; FA disposal cash is always 1110 | `PostReceiptAsync`, `PostPaymentVoucherAsync`, `DisposeCoreAsync` | D | known v1 limitation (`DocReconciliationLimited`) |
| A5 | String-literal account bypasses (`3300`, `2170/1120/1110`, `1170/2151`, `5200`, WHT code `SVC`) | §3.2 | D | defect-class; remove in TEAS 2 |
| A6 | Self-withhold gross-up cost debited to the **first** PV line's account | `PostPaymentVoucherAsync` | D | WHT cost should follow the line that carried it |
| A7 | One WHT-payable account for all WHT forms/types; one PIT, one SSO account | `GlAccountsOptions` | D | `WhtType.DefaultPayableAccountId` exists but is dead |
| A8 | Input VAT hits `1170` at VI **post date** irrespective of `vat_claim_period`; no deferred/"pending claim" account | `PostVendorInvoiceAsync` vs `TaxFilingService` | D | claim window itself is L (ม.82/3–82/4, repo-cited) |
| A9 | Account classes are only 5 `AccountType`s; no sub-type ⇒ no COGS/gross-profit/OpEx, no current/non-current split | `AccountType.cs`; `FinancialReportService.ProfitLossAsync` note | D | statutory statements (TFRS for NPAEs / DBD) need these; today approximated by code ranges (S8) |
| **B1** | Business Unit is the only wired dimension; flat; BU code is embedded in legal doc numbers (splits series) | `BusinessUnit.cs`, `NumberSequenceService` sub-prefix | D | each BU series must itself stay gap-free (ม.86/4(4) practice) |
| B2 | `JournalLine.DimensionsJson` writable but never populated/read; no cost centre/project/department; Branch not a report dimension | `JournalLine.cs`, grep: only `JournalService.cs:78` | D | — |
| B3 | No party (customer/vendor) tag on JE lines ⇒ AR/AP subledgers are document-derived; manual JV to 1130/2110 is invisible to aging; ภ.พ.36 payment detection is a heuristic | `SubledgerReportService` header; `DetectUnreconciledAsync` | D | — |
| B4 | Multi-branch VAT unsupported: company-wide counter (`branch_id=0`), ภ.พ.30 printed with branch `"00000"`, registers not per establishment, no ภ.พ.30.2 | `NumberSequenceService`; `TaxFilingService` line 98 | **L (conditional)** | ม.87 registers kept per สถานประกอบการ *(repo-cited, `Tax-Reference-TH.md` §1.10)*; fine for single-establishment SMEs |
| **C1** | THB only; `ThbOnly` on every create validator; JE/doc `CurrencyCode`/`ExchangeRate` inert; `TotalAmountThb = round(total×rate,4)` dormant | `CurrencyValidationExtensions.cs`; all `*Dtos.cs` | D | tax bases must be in THB (conversion rule not documented in repo — needs RD rate rule) |
| C2 | No FX revaluation, realised/unrealised gain-loss | — | D | required by TFRS once FX exists |
| **D1** | Reversal exists only for TI, Receipt, non-VAT Invoice; **no reverse for manual JV, VI, PV, CN/DN, payroll, depreciation, expense claim, bank-rec JE**; no `/journals/{id}/reverse`; CN is "undone" by DN | `PostReversalAsync` call sites (3); `JournalEndpoints.cs` (5 routes) | D | immutability itself: **L?** — accounting records may not be altered/erased, correct by reversing/adjusting entry (repo: `Tax-Reference-TH.md` §8.4 "standards + RD audit guidelines"; no section cited) |
| D2 | Posted PV cannot be voided (only Draft/Approved); posted VI has no cancel; payroll "reversing run" mentioned in comments but not implemented | `PaymentVoucher.Cancel`, `PayrollRun` | D | — |
| D3 | No recurring templates, auto-reversing accruals, prepaid amortisation, deferred revenue, provisions | grep: none | D | TFRS accrual practice |
| D4 | No opening-balance entry/wizard; GL opening is a hand JV in an open period; subledger cannot take opening open-items; only payroll has YTD opening | grep "opening" | D | — |
| D5 | Posting is synchronous inside each document's tx; no JE preview, no override of generated lines, no posting profile per doc type; manual JV has no draft state | `GlPostingService`; `JournalService` | D | — |
| D6 | Year-end sweep only Rev/Exp→`3300`; no tax provision, dividend, appropriation, no separate current-year-earnings account | `YearCloseService` | D | — |
| D7 | Manual JV may hit any control account (AR/AP/VAT/WHT) with no guard or party tag | `ValidatePostableAccountsAsync` | D\* | control accounts feed returns' reconciliation |
| **E1** | Past/future months with no period row are CLOSED by default; no "open period" operation (must close→reopen); future VAT claim periods cannot be pre-set | `PeriodCloseService.IsOpenAsync` | D\* | — |
| E2 | **DocDate pinned to server-today** for TI, RC, CN, DN, PV, VI, JV(draft), EC pay, FA activate; request dates rejected/ignored | `CreateDraftCoreAsync`, `PostCoreAsync`, `CreatePaymentVoucherValidator` (`validation.docDateNotToday`) | D\* | statute: TI date = issue/tax-point date (ม.86/4(7), ม.78/78-1). A real tax point can precede entry date (e.g. service paid earlier); the replacement-TI path already carries a non-today date |
| E3 | Draft→Post date handling is inconsistent: TI/PV re-pin at post; Receipt/VI/CN/DN keep the draft-time date | `ReceiptService.PostCoreAsync`, `VendorInvoiceService.PostAsync` | D | — |
| E4 | Month close ignores most draft types; ordinary Draft TI cannot be deleted (only edited/posted) and blocks the month's close | `PeriodCloseService.CloseAsync`; `DiscardReplacementAsync` | D | — |
| E5 | Calendar-month periods only; fiscal year = 12 contiguous months from a start month | `AccountingPeriod`, `Company.FiscalYearStartMonth` | D | — |
| **F1** | VAT regime = per-company bool + one scalar rate; not effective-dated; `TaxRate`, `Tax:VatRounding`, `Tax:VatDecimalPlaces`, `Tax:VatEffectiveFrom` dormant; no mid-year regime switch logic (`VatRegisterDate` not used as a gate) | `Company.cs`; grep §8.B | D\* | rate extension by decree is time-varying law *(repo-cited, `Tax-Reference-TH.md` §1.1)*; §4.6 decision to hide VAT config from UI guards misuse |
| F2 | Rounding mode fixed (HALF_UP, per line); no header-level or per-invoice option; no rounding adjustment line | §6.2 | D\* | statute fixes presentation to satang, not the method; keep identical in core |
| F3 | Tax-inclusive pricing only on TI; quotation→DO→BN chain is exclusive-only | `BuildLine` vs `ChainMath` | D | — |
| F4 | Not built: simplified TI (ม.86/6), SBT (ภ.ธ.40), stamp duty, bad-debt VAT recovery (ม.82/11), VAT refund (ม.84/1), ภ.พ.30.2/.3 | `docs/accounting-system-plan.md` §8; `Tax-Reference-TH.md` | D / L (SBT for liable businesses) | citations *(repo-cited)* |
| F5 | **Amended returns not supported** — finalized filing is immutable, "amendment = Phase 2" | `TaxFilingStore.FinalizeAsync` | D | RD supports ยื่นเพิ่มเติม; ภ.ง.ด.50 เพิ่มเติม cited ม.17 only in an UNVERIFIED research note |
| F6 | PV VAT rate must be 0 or company standard rate (no other rate allowed); ภ.พ.36 uses literal 7% | `PaymentVoucherService`; `WhtFilingService` | D | — |
| **G1** | Posting logic = one 661-line class with a method per document type; adding a document type edits `GlPostingService` + `IGlPostingService` | `GlPostingService.cs` | D | — |
| G2 | Two purchase paths (VI→AP→PV, or standalone PV booking expense+VAT) while ภ.พ.30 reads VI only | `PostPaymentVoucherAsync` else-branch vs `TaxFilingService` | D | produces gap C-1 below |
| G3 | One active TI per Quotation/DO/BN/SO; VAT company cannot settle a BillingNote; non-VAT cannot apply to TI | guards in §1.3 | D\* | prevents double revenue / under-reported VAT |
| G4 | Customer credit limit stored, never enforced; payment terms only default a due date | `CustomerService`, `BillingNoteService` | D | — |
| **H1** | Reports: TB, BS, GL, flat P&L (BU slice only); no comparative periods, cash-flow, budget-vs-actual, drill from statement line to box | `FinancialReportService` | D | — |
| H2 | ภ.ง.ด.50 schedules classify by account-code ranges | `Pnd50FilingService` | D | S8 |
| H3 | Gap audit covers only TI/JV/PV | `SQL/644` | D | extend to all legal series |
| **I1** | Numbering resets monthly and splits per BU | `NumberSequenceService` | D\* | ม.86/4(4) serial number (L); gap-free is RD practice *(repo-cited)* |
| I2 | Collision retry may burn numbers (counter survives savepoint rollback) | `NumberedDocumentWriter` | D | data-layer reconcile scripts exist |
| **J1** | CoA code immutable; type & normal balance immutable; no delete; hierarchy unused; one flat default CoA for every company | §4 | D | — |
| J2 | System-account guard by code list | `coa.system_account` | D\* | — |
| **K1** | **Revenue recognition for non-VAT companies is cash-basis on the DO/standalone receipt path** (Cr Sales at receipt); accrual only if an Invoice (BillingNote) is issued | `PostReceiptAsync`; `rc.do_already_invoiced` | **L? (risk)** | juristic persons must use accrual for CIT (ม.65, ท.ป.1/2528 — cited only in `specs/research-thai-prior-period-correction.md` §1f, **UNVERIFIED**); acceptable for sole proprietors. **Treat as a compliance risk, not a design option.** |
| K2 | Revenue is recognised at TI date (tax point); no performance-obligation / deferral model | `PostTaxInvoiceAsync` | D | TFRS 15 not modelled |
| **L1** | No inventory, costing method or COGS-on-sale; COGS is an expense category booked at purchase | `ExpenseCategory.IsCogs`; no stock entities | D | LIFO prohibited under TAS 2 *(repo-cited)* — any costing added must be FIFO/average |
| **M1** | Audit-log coverage partial (JV, year-close, EC, FA, bank-rec, filings, backfill not recorded) | §2.5 | D | the repo claims 5-year audit trail (`พ.ร.บ.การบัญชี ม.14` retention, *repo-cited*); coverage should be total |
| M2 | DB-level immutability missing for PV, WT certificate, payroll, EC, FA, filings; JE/VI/CN-DN triggers do not freeze `status` (un-post via SQL not blocked) | §2.4 | D\* | 50ทวิ is a statutory certificate; app-only freeze |
| **N1** | Approval is permission-only; creator may approve own PV/PO/EC (SoD removed by owner ruling cont.77); no multi-level approvals | `PaymentVoucher.MarkApproved`, `ExpenseClaim.Approve` | D | — |
| N2 | Statutory reference data is code, not data: PIT bands/standard expense (`PitSchedule.Current()`), CIT bands (`CitRateSchedule`), SME threshold literals, VAT threshold literals (1.5M/1.8M), PND36 7% | §6 | D\* | design intent: "git-audited code edit, never a UI setting" (CLAUDE.md §4.6) — effective-dated data tables would also satisfy auditability |

### 8.B Dormant extension points (exist in schema/code, wired to nothing) **[V by grep]**

| Item | Where | Evidence of non-use |
|---|---|---|
| `tax.tax_rates` + `TaxRate.IsEffectiveOn` | `Dom/Entities/Tax/TaxRate.cs` | `IsEffectiveOn` has no caller; `TaxRates` DbSet only referenced by its configuration |
| `WhtType.DefaultPayableAccountId` | `Dom/Entities/Tax/WhtType.cs:38` | no reader |
| `BusinessUnit.DefaultRevenueAccountId` | `BusinessUnit.cs`, DTO, service | stored/returned only, never used by posting |
| `JournalLine.DimensionsJson` | `JournalLine.cs`, `JournalLineConfiguration.cs` | written once in `JournalService.CreateDraftAsync`, never read |
| `JournalEntry.CurrencyCode/ExchangeRate`, `*.TotalAmountThb` | all docs | validators force THB/1 |
| `TaxConfig.VatRounding/VatDecimalPlaces/VatEffectiveFrom` | `Api/Program.cs:623-630` | bound, never referenced |
| `Customer.CreditLimit` | `Customer.cs` | never enforced |
| `TaxInvoice.InvoiceType/IsSubstitute/OriginalInvoiceId`, `TaxPointReason` | `TaxInvoice.cs` | legacy; replacement flow uses `ReplacesTaxInvoiceId` |
| `ChartOfAccount.ParentId/IsHeader` | CoA | API-only; no report rolls up |
| `Company.ReportingStandard`, `BaseCurrency` | `Company.cs` | informational (only echoed in a DTO projection, `MasterDataServices.cs:585`) |
| `Company.VatRegisterDate` | `Company.cs`, DTOs | stored/edited only; no service uses it to gate or date VAT behaviour |
| Enum values with no transition code | `QuotationStatus.Expired`, `SalesOrderStatus.Cancelled`, `DeliveryOrderStatus.Cancelled`, `DocumentStatus.Voided` for VI | grep: never assigned (SO/DO have no cancel path) |

### 8.C Compliance gaps and defects TEAS 2 should decide on explicitly (do not copy silently)

| ID | Gap | Evidence |
|---|---|---|
| C-1 | **Standalone PV with recoverable VAT** debits GL `1170` but never appears in ภ.พ.30 or the input register (documents = VendorInvoices only). The repo's own spec states "ภ.พ.30 reads only VendorInvoices, never PaymentVouchers" (said there to justify a non-VAT fix; the VAT-company consequence is not addressed) | `PostPaymentVoucherAsync` else-branch; `TaxFilingService.cs:50,158`; `specs/fix-army-findings-2026-07-22.md` (~line 720) |
| C-2 | **ภ.พ.36 self-assessed VAT** is posted Dr 1170/Cr 2151 but is never added to ภ.พ.30 input lines (VI for such vendors has `HasInputVat=false`) | `WhtFilingService.PostReverseChargeJvAsync`; `GeneratePnd30Async` |
| C-3 | Shared-input VAT apportionment (ม.82/6) forced to 0; credit carry-forward 0 (a refundable/negative month shows `NetVatPayable=0` with no carry) | `TaxFilingService.cs` `sharedInputVat = 0m`, `CreditCarryForward: 0m` |
| C-4 | ม.85 threshold watch sums `TaxInvoices` only; a non-VAT company cannot create TIs, so for the companies it targets it cannot reach Approaching/Exceeded | `Inf/Reports/VatThresholdService.cs` |
| C-5 | CN/DN: no cap against original TI total / prior notes; VAT = company rate × lump subtotal (not the original lines' rates) | `TaxAdjustmentNoteService.CreateDraftAsync` |
| C-6 | PV WHT rate not tied to `WhtType`/effective date; Receipt side is | `PaymentVoucherService.CreateDraftAsync` |
| C-7 | ภ.พ.36: rate literal `0.07m` ×2; per-row VAT uses `decimal.Round(x, 2)` = **banker's rounding**, the only money path in the filing code that is not HALF_UP; reverse-charge JV dated at finalize day not filing month | `WhtFilingService.cs:311,326,422,517`; `JournalService.CreateDraftAsync` |
| C-8 | Non-VAT cash-basis revenue (K1) | §3.3 T3 |
| C-9 | Output VAT in GL for FA disposal, manual JVs and standalone-PV input VAT are outside the document-derived returns → GL≠return | §6.6 |
| C-10 | Audit-log gaps (§2.5) vs. the "every state change" claim; no DB freeze for PV/WT | §2.4 |
| C-11 | Draft TI cannot be deleted; blocks month close | §1.3 |
| C-12 | Docs stale: as-built plan, `Tax-Reference-TH.md` §15, `Design(Architect).md` | Appendix B |

---

## 9. Metrics (static counts, 2026-10-13)

| Metric | Count | Source |
|---|---|---|
| Backend projects | 4 (`Domain`, `Application`, `Infrastructure`, `Api`) + tests (`Api.Tests`, `Domain.Tests`, `TestKit`) | `backend/` |
| C# source files (excl. Migrations/bin/obj) | Domain 97 · Application 97 · Infrastructure 186 · Api 72 = **452** | `find` |
| C# LOC (excl. Migrations/bin/obj) | Domain 4,517 · Application 6,014 · Infrastructure 30,560 · Api 9,747 = **50,838** | `cat \| wc -l` |
| EF entity sets / persistent entity classes | **66** `DbSet`s (66 classes under `Dom/Entities`, 59 files) + 4 OpenIddict tables | `AccountingDbContext.cs` |
| Enums | 29 | `Dom/` |
| DB schemas | ≥ 13 (`sys master tax sales purchase gl payroll expense fixedasset bank etax audit oauth`; `cash`,`notif`,`jobs` created empty by `SQL/001`) | snapshot, `SQL/001` |
| Application interfaces / FluentValidation validators | 71 `I*Service` interfaces · 52 validators | `App/` |
| Service classes (Infrastructure, class names ending `Service`, partial classes counted once) | **69** distinct | grep |
| Permission codes | 91 | `Api/Authorization/Permissions.cs` |
| REST route registrations | **350** `Map{Get,Post,Put,Delete,Patch}` calls (40 endpoint files + `Program.cs` + `OAuth`) | grep |
| MCP tools | 88 (`Api/Mcp/TeasMcpTools.cs`, 2,244 lines) | grep |
| Background jobs | 2 Quartz (`Pnd30DeadlineAlertJob`, `VatRegisterSnapshotJob`) + 2 hosted (`ETaxRetryHostedService`, `IdempotencyCleanupHostedService`) | `Api/` |
| EF migrations | **22** (squashed baseline `20260616130322_InitialCreate` + 21 incremental) + snapshot | `Inf/Migrations` |
| SQL bootstrap scripts | **111** files, 5,545 lines (RLS, triggers, views, seeds; applied once, tracked in `sys.applied_sql_scripts`; 20 are DEMO-gated) | `SQL/`, `Inf/Persistence/DbInitializer.cs` |
| DB triggers | 19 `CREATE TRIGGER` statements (immutability/no-delete/append-only) | `SQL/` |
| RLS enablement | 30 `ENABLE ROW LEVEL SECURITY` statements across scripts (several loop over many tables; `SQL/600` alone covers 31 tenant tables + 3 service-scanner + 3 system-global) | `SQL/` |
| Test projects LOC | `Api.Tests` 58,086 · `Domain.Tests` 1,313 | `find` |
| Test classes (named `*Tests`) | Api.Tests **214** · Domain.Tests **21** (235 total) | grep |
| Test methods — by attribute grep (undercount) | Api 261 `[Fact]` + 13 `[Theory]`; Domain 111 + 23 | grep |
| Test results — authoritative | Last recorded suite (`STATUS.md`, 2026-09-05): **Domain 188/188; Api 1370 pass / 0 fail / 14 baseline skips of 1384** (earlier note 1401 incl. Tier-3 runs) | `STATUS.md` |
| Frontend (context) | 108 `page.tsx` routes · 44 Playwright specs | `frontend/` |
| Docs of record | `docs/accounting-system-plan.md` 402 lines (stale) · `Design(Architect).md` 909 (blueprint) · `Tax-Reference-TH.md` 1,068 · 94 files in `specs/` | repo |

---

## Appendix A — Index of posting-related code (start here)

- Ledger kernel: `Inf/Ledger/{GlPostingService,JournalService,PeriodCloseService,YearCloseService,NonVatArBackfillService,GlAccountsOptions}.cs`; `App/Ledger/IGlPostingService.cs`
- Numbering: `Inf/Numbering/{NumberSequenceService,NumberedDocumentWriter}.cs`; `Dom/ValueObjects/DocumentNumber.cs`
- Sales: `Inf/Sales/{TaxInvoiceService(.Cancel,.Read),ReceiptService(.Cancel,.Read),TaxAdjustmentNoteService,BillingNoteService,DocumentCancellation,SalesLineBackstop,QuotationChainServices,SalesOrderDeliveryServices}.cs`
- Purchase: `Inf/Purchase/{VendorInvoiceService,PaymentVoucherService,PurchaseOrderService,WhtCertificateService}.cs`
- Other posters: `Inf/Expense/ExpenseClaimService.cs`, `Inf/Payroll/PayrollRunService.cs`, `Inf/FixedAsset/FixedAssetService.cs`, `Inf/Bank/BankReconciliationService.cs`
- Tax: `Inf/TaxFilings/*`, `Inf/Tax/*`, `Inf/Reports/{VatReportService,TaxSummaryService,SubledgerReportService,FinancialReportService,VatThresholdService}.cs`, `Dom/Tax/*`, `Dom/Payroll/*`
- DB: `SQL/{010,020,030,040,050,060,300,570,571,580,582,583,584,600,613,626,634,635,643,644}`; EF configs `Inf/Persistence/Configurations/*`
- Specs worth reading before TEAS 2 design: `specs/cancel-reissue-sales-docs.md`, `specs/year-end-closing.md`, `specs/manual-jv-and-coa-management.md`, `specs/subledgers.md`, `specs/fix-breakit-r1-ledger-integrity.md`, `specs/fix-breakit-r2-compliance.md`, `specs/fix-pnd36-payment-detection.md`, `specs/fixed-assets.md`, `specs/bank-reconciliation.md`, `docs/superpowers/specs/2026-06-12-wht-grossup-design.md`, `docs/superpowers/specs/2026-05-23-non-vat-mode-design.md`, `docs/superpowers/specs/per-company-vat-mode.md`

## Appendix B — Documentation vs code discrepancies (trust the code)

| Doc | Claim | Code reality |
|---|---|---|
| `docs/Tax-Reference-TH.md` §15 | Output VAT `2160`; WHT payable `2151`; WHT receivable `1175`; CIT payable `2240`; stamp duty `5410` | Output VAT **2151**, WHT payable **2152**, WHT receivable **1180**, **no CIT payable account**, `5410` = employer SSO expense (`GlAccountsOptions.cs`) |
| `docs/Tax-Reference-TH.md` §1.7, §2.4 | reconciliations to GL "2160"/"2151" | same as above; reconciliation is not enforced at runtime |
| `docs/Design(Architect).md` | MS SQL Server, microservices, Azure | PostgreSQL modular monolith (as-built plan §8: MS SQL "forbidden by policy") |
| `docs/accounting-system-plan.md` §3.8 | every state change writes `audit.activity_log` | 8+ services do not (§2.5) |
| same §5 | 9 DB schemas | ≥ 13 |
| same §8 | bank reconciliation, same-day void & reissue not built | both built (`Inf/Bank/*`, `TaxInvoiceService.Cancel.cs`) |
| same §7 | Domain 146 / Api 385 tests | Domain 188 / Api ~1384 (STATUS.md) |
| `Dom/Entities/Master/ChartOfAccount.cs` doc | "5-digit hierarchical" code convention | defaults are 4-digit, flat, `IsHeader=false` everywhere |
| `Dom/Entities/Sales/BillingNote.cs` doc | "non-fiscal"; numbering `BL` | for non-VAT companies it is the GL-posting sales document; prefix is now `IV` (legacy `BL` kept) |

## Appendix C — Open questions to settle with a Thai CPA / the owner before TEAS 2 freezes the core

1. Is cash-basis revenue on a non-VAT juristic person's Receipt (K1) acceptable? Decide: force accrual (Invoice mandatory) or restrict cash-basis to `SoleProprietor`.
2. Should TI/CN/DN dates become "tax point date" inputs with a late-issue warning (E2), or stay pinned to entry date?
3. Is per-line HALF_UP rounding the intended statutory method, and should an invoice-level rounding option exist (F2)?
4. ม.82/3 vs ม.82/4 for the 6-month input-VAT window; confirm the shared-input apportionment rules (ม.82/6) to implement C-3.
5. Multi-establishment VAT (B4): will TEAS 2 need per-branch registers/ภ.พ.30.2?
6. Which statute/ruling backs "no alteration of posted accounting entries" (D1) so the reversal-tooling relaxation is bounded correctly?
7. Amended returns (F5): which returns and which windows must be supported?
8. ภ.พ.36 tax point (payment month) — CPA sign-off still listed as outstanding in `STATUS.md` (2026-08-20).
9. Exchange-rate source for THB conversion of foreign-currency tax bases (C1).
10. Confirm that standalone PV input VAT (C-1) should (a) be blocked unless a VI exists, or (b) feed ภ.พ.30.
