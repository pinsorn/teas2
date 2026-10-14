# SP1c — All Screens on the Mock Backend Implementation Plan (master)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> This master file holds everything every task shares. The tasks live in one file per module group under
> `docs/plans/sp1c/`. An implementer reads THIS file (Global Constraints, Design decisions, shared contracts) plus
> exactly one task in one group file.

**Goal:** Build every TEAS 2 screen as the real frontend on mock data — every item of
`docs/discovery/01-ui-feature-inventory.md` Appendix C plus the SP0 §11.2 new screens (posting profiles, dimensions,
opening balances, schedules, settlement, approval inbox, agent policy) — each from descriptors and the SP1b kit, each
with loading / empty / error / forbidden / locked states, every role, and VAT / non-VAT variants, with a Ham gate per
module group.

**Architecture:** SP1b proved the pattern on the tax invoice: a `DocDescriptor`, the kit (`DocList` / `DocEditor` /
`DocView` / paper), and an MSW mock engine that owns all money (satang, `Dr = Cr`, §7.11 outstanding, locks,
correction plans). SP1c first generalises that pattern (group 00: descriptor registry, generic document routes,
role-based ledger with a chart of accounts, settlement + WHT engine, record and report kits), then adds module groups
in SP0 §11.4 order. Document types become registry entries rendered by generic routes; master data and settings
become record descriptors rendered by `RecordList` / `RecordForm`; reports and filings become server-computed models
rendered by `ReportView` / `FilingView`. The frontend never computes tax, totals, WHT, payroll or report figures.

**Tech Stack:** as SP1ab (pinned in `frontend/package.json`): Next.js 16.4.0 App Router, React 19, TypeScript strict,
Tailwind v4, shadcn/ui (Radix), TanStack Query 5 + Table, React Hook Form + Zod, next-intl 4, MSW 3, Vitest,
Playwright + axe. pnpm via `corepack pnpm`. No new runtime dependency without a recorded reason in the task report.

**Spec:** `docs/specs/SP0-charter.md` (§1.2 S1–S5, §3.1, §5, §6.2–6.7, §7, §8, §9, §11.2–11.5);
`docs/specs/SP1-design-system.md`; `docs/adr/0001-document-rendering.md`;
`docs/discovery/01-ui-feature-inventory.md` Appendix A (rules) and Appendix C (parity list);
SP1ab plan `docs/plans/2026-10-14-sp1ab-design-system-kit.md` (Task 17 Step 3 is the source of this plan) and its SDD
ledger `.superpowers/sdd/2026-10-14-sp1ab-design-system-kit/{progress.md,final-review.md}` (rulings and carry-overs).

---

## Module groups, files, gates

| # | Group | File | Tasks | Ham gate | Depends on |
|---|---|---|---|---|---|
| 00 | Foundation (kit, engine, harnesses) | `docs/plans/sp1c/00-foundation.md` | F1–F6 | none (controller gate G00; TI loop regression only) | — |
| 01 | Master data | `docs/plans/sp1c/01-master-data.md` | M1–M2, GM | GM | 00 |
| 02 | Sales | `docs/plans/sp1c/02-sales.md` | S1–S6, GS | GS | 00, 01 |
| 03 | Purchases | `docs/plans/sp1c/03-purchases.md` | P1–P4, GP | GP (includes the PV action count, S3) | 02 |
| 04 | Finance (bank, deposits, settlement) | `docs/plans/sp1c/04-finance.md` | FN1–FN3, GFN | GFN | 03 |
| 05 | Accounting (ledger, COA, OB, schedules, assets, close) | `docs/plans/sp1c/05-accounting.md` | AC1–AC6, GAC | GAC | 04 |
| 06 | Tax | `docs/plans/sp1c/06-tax.md` | TX1–TX3, GTX | GTX | 05 |
| 07 | Payroll | `docs/plans/sp1c/07-payroll.md` | PY1–PY3, GPY | GPY | 06 (FilingView) |
| 08 | Reports | `docs/plans/sp1c/08-reports.md` | RP1–RP3, GRP | GRP | 07 |
| 09 | Settings | `docs/plans/sp1c/09-settings.md` | ST1–ST3, GST | GST | 08 |
| 10 | Home / TEAS Connect / platform | `docs/plans/sp1c/10-home-connect.md` | HC1–HC3, GHC | GHC (final SP1c gate) | 09 |

Implementation tasks: 42 (F 6, M 2, S 6, P 4, FN 3, AC 6, TX 3, PY 3, RP 3, ST 3, HC 3). Gate tasks: 10 Ham gates +
1 controller gate (G00).

Sequencing: tasks run **in order inside a group** (they share `mocks/store`, fixtures and the seed). Groups run in the
order above; the arrows in "Depends on" are real interface dependencies (named in each task's Interfaces block).
Two tasks may run in parallel only in separate worktrees with separate dev servers (port) — the controller decides;
this plan does not assume parallelism.

---

## Global Constraints

Every task's requirements implicitly include this section. Copied from the SP1ab plan (binding) and extended with the
SP1ab lessons and rulings.

**Binding from SP1ab**
- Versions: `next@16.4.0`; every dependency pinned exactly (`--save-exact`); Node 24; pnpm via `corepack pnpm`.
- Frontend production code never computes tax, totals, WHT, payroll, depreciation, outstanding or report figures.
  Only formatting, the TIN checksum, calendar date arithmetic for a due date (named exception in `DocEditor`), and
  copying a server-supplied string into an input (e.g. "pay the outstanding amount") run client-side.
- API base path `/bff/v1`. Every TanStack Query key starts with the active `companyId` (only `qk.me()` is exempt).
- Every screen has distinct loading, empty, error, forbidden and locked states; **an error is never shown as "no
  data"** (an empty list and an error banner never render together).
- Thai first: Buddhist-era dates (`14 ต.ค. 2569`); amounts in words come from the server; UI strings live in
  `src/messages/th.json` / `en.json` (no hard-coded UI strings in components; Thai literals are allowed only in
  paper components — legal document labels — and in mock fixtures / mock engine messages).
- Accessibility: dialogs are shadcn/Radix (focus trap, Escape); every Playwright page check runs `axeClean(page)`
  (`e2e/helpers/axe.ts`) with zero `serious` / `critical` violations.
- No dark mode (D-13); colours only through tokens (`src/styles/tokens.css`); typography classes `text-title`,
  `text-section`, `text-body`, `text-small` (never Tailwind `text-sm/base/xl` in new code).
- Document numbers `{PREFIX}-{YYYYMM}-{####}` (D-24), allocated at issue, gap-free per company × type × month.
- Fixtures are fictional; every TIN passes the checksum (`tinCheckDigit`); no real people or businesses.
- Never commit screenshots, PDFs or generated files; Playwright output stays in ignored folders or the scratchpad.
- UI work loads the `impeccable` skill and follows `docs/specs/SP1-design-system.md` (direction B, Continuity).
- Workers never commit. Each task ends with "controller commits"; the worker reports evidence only.

**Lessons from the SP1ab ledger (now binding)**
- Radix state styling uses `data-[state=…]` variants (e.g. `data-[state=checked]:`), never `data-checked:`.
- Keyboard shortcuts match on `event.code` (`KeyN`, `Enter`, `Slash`), never `event.key` (Thai keyboard layout).
- Components that hold company data in local state remount on company switch: wrap them with
  `key={useCompanyEpoch()}` (`src/app-shell/useCompanyEpoch.ts`) exactly like `DocEditor` / `DocView`. A record from
  another company renders the not-found state.
- Tests must be able to fail: no dependence on seed row order (use named fixture ids, Task F2), no assertion that is
  true for any input (e.g. "toHaveCount(≥0)", "text matches /.*/"), and every new invariant checker has a test that
  feeds it a corrupted state and expects a reported violation.
- Money is specified as **invariants** (formulas that must hold for every document), never only as observed values.
  The invariant property suite (Task F4, `mocks/engine/invariants.ts`) runs over the whole seed and must stay green.
- Mock engine money is integer satang (`toSatang` / `fromSatang`, `bigint` for products); rounding is half away from
  zero per line, header = Σ lines (SP0 I2). New engine code reuses `src/mocks/engine/money.ts`.
- Unit tests that render components use the real next-intl translator (Task F2 replaces the shim): a missing message
  key throws.
- Mock reference data that SP-R has not ruled on (WHT rates, PIT bands, SSO ceiling, VAT threshold, CN/DN reason
  codes, ภ.พ.30 box layout, CIT ladder) is a **fixture tagged `[SP-R]`** in a code comment and in the screen index;
  no screen or test text calls it "the rule".

**Ham rulings to respect**
- Visual direction B (Continuity) tokens.
- CN/DN rounding rule B: each per-tax-code note line carries VAT = that code's actual VAT change; note total = |delta|.
- A TI credited to zero by credit notes without any receipt stays `issued` with outstanding 0.00 (`settled` needs a
  settlement). The same rule applies to every type with an outstanding balance (IV, PB, EX).
- Negative outstanding (credit after full payment) is shown, never clamped (SP1ab T5 ruling).
- Green + reviewed PRs merge without asking.
- Parked, do not decide in SP1c: signed combined CN vs separate CN + DN (R-08). CN / DN screens render whatever lines
  the engine produced and must work for both answers.

**Repo facts implementers need**
- Run all frontend commands from `Y:\ClaudePlayground\T2-sp1ab\frontend` (or the worktree the controller names).
  PowerShell 5.1 has no `&&`: run gates as separate commands, or in the Bash tool.
- Gates: `corepack pnpm lint` · `corepack pnpm typecheck` · `corepack pnpm test` (Vitest) ·
  `corepack pnpm e2e` (Playwright, starts `next dev -p 3100`). A focused run: `corepack pnpm test <path>` /
  `corepack pnpm e2e <spec>`. Long full e2e: report code-complete with focused evidence; the controller runs the full
  suite once.
- Next.js docs for this exact version are bundled at `frontend/node_modules/next/dist/docs/` — read them before
  using a routing / data API you have not used in this repo.
- `troubles-wiki.md` (repo root): grep it first on any unexpected error.
- Root layout is policed by `node tools/check-repo-layout.mjs` (CI job `layout`).

## Review Focus

The five input classes the spec implies but no single task's happy path exercises, most likely first. Each line names
the task that owns its pinning test.

1. **Partial and multi-target settlement** — one receipt / payment applied to several invoices, partly, with WHT,
   then one of those invoices corrected or cancelled: every target's outstanding must still equal
   `total − ΣCN + ΣDN − Σ active settles`, and no settlement amount may be duplicated or dropped
   (pinned in F5 engine vectors, S4 RC e2e, P3 PV e2e, FN3 netting).
2. **The non-VAT company everywhere** — a non-VAT company must see a complete product: IV not TI, no VAT columns /
   rows / filings, purchase VAT folded into cost, VAT-only routes rendering "not available" (not 404, not a crash)
   (pinned by the screen-contract `company: 'nonvat'` rows in every task, F1 type gate, S3 IV, P2 PB).
3. **Locks and their exits** — period closed, filing finalized, settlement applied, bank line matched: every blocked
   action shows why and offers a working exit; no state a user cannot leave in the app
   (pinned in F4 period lock, FN2 reconciliation lock, TX1 filing lock, AC6 close / reopen).
4. **Role switches and forbidden permissions on every new screen** — operator / accountant / admin each see the
   right actions, disabled actions name the permission, forbidden screens say which permission is missing
   (pinned by `forbiddenRole` rows of the screen contract in every task).
5. **Company switch with a page open** — editors, record forms, report parameters and filing previews never show or
   save company A's data in company B (pinned in F6 ReportView, M1 RecordForm, PY1 payroll editor tests).

---

## Shared contracts (every group uses these names)

### Permission catalog

One catalog in code (SP0 §10.4): `frontend/src/domain/permissions.ts` (created in F1) exports `PERMISSIONS` — every
code below with a Thai label — and the mock role table `frontend/src/mocks/permissions.ts` is built only from codes in
that catalog (a unit test fails on an unknown code). Each task adds its rows to both files.

| Area | Codes | Introduced in |
|---|---|---|
| Documents | `doc.<T>.read`, `doc.<T>.create`, `doc.<T>.issue`, `doc.<T>.cancel`, `doc.<T>.correct` for every `DocType`; `doc.<T>.approve` for types with approval (QT SO DO BL IV TI RC CN DN PO PB PCN PDN PV EX JV) | F1 (TI exists), each type's task |
| WT | `doc.WT.read` only (WT follows its PV / PR) | P3 |
| Parties / items | `party.read`, `party.manage`, `item.read`, `item.manage` | M1, M2 |
| Bank | `bank.read`, `bank.manage`, `bank.reconcile` | FN1, FN2 |
| Ledger | `ledger.read` (journals, GL, "ดู JE", ledger tab), `ledger.coa.manage`, `ledger.posting.manage`, `ledger.schedule.manage`, `ledger.period.close`, `ledger.period.reopen` | F3 (`ledger.read` gating), AC1–AC6, ST2 |
| Tax | `tax.read`, `tax.filing.preview`, `tax.filing.finalize`, `tax.settings.manage` | TX1–TX3, ST3 |
| Payroll | `payroll.read` (exists), `employee.read`, `employee.manage`, `doc.PR.*` | PY1–PY3 |
| Reports | `report.read` (financial statements), `report.arap.read`, `audit.read` (exists) | F6, RP1–RP3 |
| Settings | `settings.manage` (company, numbering, templates, approvals, dimensions), `users.manage` (exists), `connect.manage` (API keys, OAuth apps, agent policy) | ST1–ST3, HC2 |

Role intent (mock `PERMISSIONS_BY_ROLE`; each task lists its exact additions):
- **operator** — creates and issues daily documents (QT SO DO BL IV TI RC PO PB PV EX), reads CN DN PCN PDN WT, quick-
  creates parties (`party.manage`), reads items and bank accounts; no `ledger.read` (SP0 §1.5: operators see no
  debit / credit), no tax, payroll, reports, settings.
- **accountant** — everything in documents incl. cancel / correct / approve, all ledger, tax (incl. finalize),
  payroll, reports, `ledger.posting.manage`, `audit.read`; not `settings.manage`, `users.manage`, `connect.manage`.
- **admin** — `settings.manage`, `users.manage`, `connect.manage`, `audit.read`, `party.read`, `item.read`,
  `bank.read`, `report.read`; no document authoring.

### Contract types added across SP1c (each owned by the named task; `src/domain/types.ts`)

| Addition | Shape | Owner |
|---|---|---|
| `DocTypeInfo`, `DOC_TYPES` | `src/domain/doc-types.ts` (class, vat scope, ledger, outstanding, printable per type) | F1 |
| `DocMarks` on `Doc` / `DocSummary` | `{ accepted?, rejected?, delivered?, sent?, closed? }` — attributes, **not** new `DocStatus` values | S1 |
| `DocHeader` optional fields | `whtMode`, `bankAccountId`, `paymentMethod`, `cheque`, `depositAmount`, `claimPeriod`, `vendorDocNumber`, `vendorDocDate`, `reasonCode`, `reasonText`, `refDocId`, `autoReverse`, `complete` | F5 (payment fields), S4 / FN3 (`depositAmount`), S5, P2, AC1 |
| `Doc.opening`, `Doc.asset`, `DocLine.pay` | OB sub-items, asset header, payroll pay items | AC3, AC5, PY1 |
| `DocLine` optional fields | `whtTypeCode`, `expenseCategory`, `accountCode`, `debit`, `credit`, `partyId`, `employeeId`, `pnd36` | F5, P2, AC1, PY1 |
| `Allocation`, `Doc.allocations`, `DocInput.allocations` | `{ targetId, targetType, targetNumber?, amount, wht?, whtTypeCode?, certNumber? }` | F5 |
| `ComputeResult` extras | `whtLines`, `allocation: { allocated, unallocated, suggestedWht }`, `balance` (account lines) | F5, AC1 |
| `PartySummary.kind` gains `'employee'`; `PartySummary.entityKind` | `'individual' \| 'juristic' \| 'foreign'` | F5 (entityKind), P4 (employee) |
| `RecordDescriptor`, `RecordRow`, `FieldSpec` | `src/domain/records.ts` | M1 |
| `ReportModel` | `src/domain/reports.ts` | F6 |
| `FilingModel` | `src/domain/filings.ts` | TX1 |
| `JournalLinePreview.rule` | becomes the posting-profile rule text (`"<level>: <role> → <code>"`) | F3 |

`DocStatus` is **not** widened in SP1c (see Design decision D-05).

### Mock API surface added across SP1c (all under `/bff/v1`, all behind `screenGate`)

| Endpoint | Purpose | Owner |
|---|---|---|
| `GET /mock/fixtures` | named fixture ids for tests and the screen index (no `screenGate`) | F2 |
| `GET /docs/open-items?partyId=&types=` | live documents with outstanding ≠ 0 for a party | F5 |
| `GET /docs/:type/:id/remaining` | per-line ordered / converted / remaining quantities | S1 |
| `POST /docs/:type/:id/marks` | `{ mark, reason? }` accept / reject / delivered / sent | S1 |
| `POST /docs/:type/:id/close-remainder` | `{ reason, version }` | S2 |
| `POST /docs/:type/:id/printed` | `{ copy }` print tracking | S6 |
| `GET/POST/DELETE /docs/:type/:id/attachments` | attachment metadata (≤ 1 MB data URL) | S6 |
| `POST /docs/:type/:id/{submit,approve,send-back}` | approval policy §7.6 | P4 |
| `GET/POST/PUT /records/:kind[/:id]`, `POST /records/:kind/:id/active` | generic record CRUD | M1 |
| `GET /reports/:kind?…` | `ReportModel` | F6 |
| `GET /filings/:form?period=`, `POST /filings/:form/finalize`, `GET /filings/:form/export?period=` | `FilingModel`, finalize, RD Prep text | TX1 |
| `POST /bank/:accountId/imports`, `GET /bank/:accountId/lines`, `POST /bank/lines/:id/{match,unmatch,ignore,post}` | bank import + reconciliation | FN1, FN2 |
| `POST /periods/:month/{close,reopen}`, `GET /periods/checklist?month=` | period close | AC6 |
| `POST /schedules/:id/run` | scheduler "run now" in the mock | AC4 |

### Test harnesses (built once in group 00; every later task adds rows, never copies)

- **Screen contract** — `frontend/e2e/helpers/screen-contract.ts` (F2): `screenContract(spec)` generates, per company
  in scope: normal render + heading + axe; each listed state renders its `data-screen-state` pattern and never the
  empty pattern alongside error; out-of-scope company renders `not-available`; `forbiddenRole` renders `forbidden`.
- **Descriptor contract** — `frontend/src/descriptors/descriptors.contract.test.ts` (F1) iterates `DESCRIPTORS`;
  `frontend/src/domain/records.contract.test.ts` (M1) iterates `RECORDS`.
- **Invariant property suite** — `frontend/src/mocks/engine/invariants.ts` + `.test.ts` (F4) runs over the whole seed
  for both companies and every role seed.
- **Fixture ids** — `frontend/src/mocks/fixtures/ids.ts` (F2): every e2e and the screen index address fixtures by
  key, e.g. `await fixtureId(page, 'tiIssuedUnpaid')`.

## Design decisions (for orchestrator review)

Where the sources do not determine a choice, this plan made one. Each line: decision — why. Items marked **Ham** must
be shown at the named gate.

| ID | Decision | Why |
|---|---|---|
| D-01 | A **Foundation group (00)** precedes the module groups the brief listed. | Every carry-over from the SP1ab final review (M5 docHref, M11, DocView 'TI' paper tab, error boundary, strict i18n shim, seed-order e2e) and the engine generalisation (roles, settlement, WHT) is consumed by every group; doing it inside "sales" would make sales un-reviewable. |
| D-02 | Group order = SP0 §11.4 adapted: master data → sales → purchases → finance → accounting → tax → payroll → reports → settings → home / connect. Tax precedes payroll; the ledger engine core lands in 00. | §11.4 is the module order. Payroll filings reuse `FilingView` built in tax. Settings screens are late because the mock carries working defaults from 00. |
| D-03 | Document screens use **generic routes** `app/(app)/[group]/[slug]/{page,new/page,[id]/page,[id]/edit/page}.tsx` resolving the descriptor registry; the `[...slug]` catch-all and the static `sales/tax-invoices/**` routes are deleted. | S4 "zero per-document page shells". Next.js refuses `[group]` next to `[...slug]` at one level, so the catch-all's job ("coming in SP1c" for a nav route not built yet) moves into `[group]/[slug]/page.tsx`. Static routes (e.g. `/finance/bank-accounts/[id]`) still win where a screen is custom. |
| D-04 | One descriptor registry (`src/descriptors/index.ts`) and one doc-type table (`src/domain/doc-types.ts`) shared by the frontend AND the mock; `docHref` exists once; `issueLabelTh` is removed in favour of `messages docTypes.<T>.*`. | Resolves M5 / M11; the VAT-only lists that were hand-copied in two handlers become one table. |
| D-05 | **No new `DocStatus` values.** QT accepted / rejected, DO delivered, PO sent and "ปิดยอดคงเหลือ" are `DocMarks` attributes shown as secondary chips. | SP0 §7.2 lifecycle has none of them; widening `DocStatus` would sweep StatusChip, tokens, DocList filters, messages and every status switch. |
| D-06 | QT: conversion is allowed from any live QT that is not rejected; converting stamps `accepted`; an N-class revision clears accepted / rejected; a rejected QT's exits are "แก้ไข" (revision) and "คัดลอกเป็นใบใหม่". | TEAS 1 required "Accepted" before converting (Appendix A.2); SP0 §7.10 wants fewer steps. Every guard keeps an exit. |
| D-07 | `CONVERT_TO.DO` loses `BL`. | SP0 §7.7: BL groups TI / IV; DO → BL is not in the conversion list. |
| D-08 | IV has its own permissions `doc.IV.*`; the nav item "ใบแจ้งหนี้" is keyed on `doc.IV.read`. | Today IV reuses `doc.TI.read` (a hack noted in `nav.ts`); the descriptor contract requires `doc.<T>.*`. |
| D-09 | Journals, the ledger tab, the editor's "ดู JE" drawer and the `/ledger` endpoint require `ledger.read`. Operators see the tab / button disabled with the permission named. | SP0 §1.5 (operators see no debit / credit). Resolves final-review M1. |
| D-10 | Seed: months up to **2026-06 are closed** for both companies. A period lock never blocks a correction: reversal + new entry post on the first open date, labelled "แก้ไขย้อนหลัง"; issuing a new document dated in a closed month or in the future is refused with an exit. | SP0 §5.8 / §7.5; Ham 2026-08-12. Makes final-review M2 reachable, so it is fixed in F4, not SP2. |
| D-11 | Line editors: `item`, `amount`, `account`, **`payroll`**, `none`. **Ham (GPY):** `payroll` is a fourth editor although SP0 §7.1 names three; `none` is for documents without own lines (BL, WT). | A payroll run (employee × pay items, engine-computed PIT / SSO) fits none of the three; faking it with amount lines would put payroll maths in the client. |
| D-12 | Settlement is **allocations** on RC / PV (and the grouping list of BL), not lines. RC shows an amount line grid only for a non-VAT company (cash bill); a VAT company's RC must allocate to TI / IV or become a deposit. | §5.11 (one receipt settles many open items); Appendix A.4 (non-VAT cash bill); I3 (VAT sales need a TI). |
| D-13 | **Ham (GFN):** netting (หักกลบ), applying a deposit and settlement differences are a record kind `settlement` at `/finance/settlements` that posts through the ledger; it is not a new `DocType`. | §5.11 calls it "a settlement document" but §3.1 has no code and adding a type needs an ADR; SP2 decides whether it needs a legal series. |
| D-14 | WHT is computed **per WHT type per document**: base = Σ net of the lines carrying that type, tax = round-half-away(base × rate); payer modes per Appendix A.5; a new accounting role `WhtExpense` takes the tax borne in gross-up modes; one WT per type. | I7 ("one WT per income type per payment"); rounding per WT keeps Σ WT = PV WHT exactly. Rates are `[SP-R]` fixtures. |
| D-15 | **S3 PV scenario:** VAT company, vendor "คุณอนันต์ ภาพดี (ช่างภาพอิสระ)" (individual, not VAT-registered, new fixture `pv-09`) with a usual service line 5,000.00 and WHT type `SVC` 3 % deduct → Home quick action, type vendor, Enter, Ctrl+Enter, Enter = **5 actions** (≤ 6); asserts WHT 150.00, paid 4,850.00, a WT in the chain. | G2 forbids a standalone PV carrying input VAT, so a VAT vendor's invoice must go through a PB; the classic 1-line PV with WHT is a payment to an individual. |
| D-16 | G2: a standalone PV line with tax code `S7` is refused (`pv.input_vat_needs_bill`); the editor's exit is "บันทึกซื้อ (มีใบกำกับภาษี)", a quick dialog that creates + issues a PB and allocates the PV to it. | SP0 §6.5 G2 ("created inline from the PV editor"). |
| D-17 | PDN adds to its PB's outstanding (as DN does to a TI); PV settles PB and EX only. | Keeps one outstanding per payable; §7.11's "PV → PDN" is met by settling the adjusted PB. |
| D-18 | EX: issue = submit (posts expense / payable to the employee); approval follows D-12 (off by default) but the **VAT company seed enables approval for EX and PV** so the inbox has content; pay = EX → PV conversion; reject = send back. | D-12 + §7.4 ("send back") + §7.7 (EX → PV) cover TEAS 1's submit / approve / reject / pay without a separate lifecycle. |
| D-19 | The approval engine (submit / approve / send back, `pending` / `approved`, self-approval toggle, approve-and-issue) lands in P4 with EX as its first consumer; Home inbox in HC1; policy UI in ST3. | First consumer owns the primitive; later groups only render it. |
| D-20 | The WT register lives at `/tax/wht-certificates` (new nav item under ภาษี); the WT descriptor is created in P3 because PV chains link to it. | §9.1 places 50 ทวิ under ภาษี; P3 needs a view route for the chain. |
| D-21 | SP1c WT, ภ.พ.30, ภ.ง.ด.* "form" views are **React renditions** of the form boxes; the official RD AcroForm overlay is SP4.8. A form-preview slot shows the TEAS 1 PDF only when the controller has supplied it (open item O-1). | §6.7 ports the AcroForm engine in the backend; §11.3's TEAS 1 PDFs need a running TEAS 1 the implementer does not have. |
| D-22 | Papers: a paper registry (`kit/paper/registry.ts`) maps type → component. QT SO DO BL IV PO share `CommercialPaper` with per-type config; TI keeps `TaxInvoicePaper`; RC, CN / DN, PV, WT, EX, JV and the payslip get their own components. | ADR-0001 (one React paper per document form) without six copies of the same layout. |
| D-23 | New fixtures are produced **through the engine** by a seed runner (`fixtures/seed-runner.ts`) with a pinned clock and explicit ids; the SP1ab TI seed is left as it is. | "Fixtures through the engine" + determinism (the seed never reads the clock); keeps every SP1ab id stable. |
| D-24 | Tests and the screen index address fixtures by **named keys** served by `GET /bff/v1/mock/fixtures` (computed by predicates over the seed). | Removes seed-order dependence (T14 deferred, T16 hard-coded ids) before any new fixture lands. |
| D-25 | The engine's compute is company-aware: a non-VAT company's documents carry VAT 0 whatever the line tax code (I1); purchase VAT on a non-VAT company's PB folds into cost. | SP0 I1, Appendix A.4. |
| D-26 | Mock chart of accounts = a Thai SME template keeping every code the SP1ab ledger used (1120, 1130, 1170, 1180, 2110, 2151, 4100, 5100); posting profiles resolve roles in the §5.5 order and write the rule into each journal line. | §5.4 / §5.5; existing journal tests keep their codes. |
| D-27 | Master data and settings screens are **record descriptors** rendered by `RecordList` / `RecordForm` over a generic `/records/:kind` API with a per-kind registry in the mock. | Same "declare, don't hand-build" principle as §7.1 for ~20 non-document screens. |
| D-28 | Reports and filings are server-computed models (`ReportModel`, `FilingModel`): VAT / WHT / payroll returns read documents, CIT and financial statements read the mock GL, and every register shows a tie-out row against its control account. | SP0 I12; frontend never sums. |
| D-29 | PO → PB conversion uses the strict remaining-quantity rule (no 105 % tolerance). | §7.11 refuses over-conversion; the tolerance is a flexibility gap, not parity. Exit: revise the PO or close the remainder. |
| D-30 | Attachment categories (11): ใบเสนอราคา/ใบสั่งซื้อของลูกค้า, ใบสั่งซื้อ, ใบส่งของ, ใบกำกับภาษีผู้ขาย, ใบเสร็จ, สลิปโอนเงิน, สัญญา, ภาพถ่ายสินค้า/งาน, หนังสือรับรองหัก ณ ที่จ่าย, เอกสารราชการ, อื่น ๆ. | Appendix C says "11 categories" without naming them; TEAS 1's exact list was not re-verified. |
| D-31 | Gates run on a **local production build** (`corepack pnpm build`, then `corepack pnpm start -p 3100`) when the Coolify preview is not up, as the SP1b gate did. | STATUS: Coolify app not created; SP1ab Task 16 step 4 still open. |
| D-32 | Login, TOTP, onboarding, session-expiry and profile screens are mock UI driven by mock state; real auth is SP3. | Parity list (Appendix C Platform) needs the screens approved as mockups (S2). |
| D-33 | `Company` gains `fiscalYearStartMonth` (typed; the T2 deferred item) in ST1. | Needed by period close, CIT and settings. |
| D-34 | WHT type codes follow Appendix A.5 (`RENT`, `SVC`, `SVC-IND`, `ADS`, `PROF`, `TRANS`, `COMM`, `ROYAL`, `INT`, `INT-IND`, `PRIZE`, `AGRI`, `ENTERTAIN`, `CONTRACT`, `FOR-SVC`, `FOR-ROYAL`); the seed's `PND3-40` / `PND53-3` become `SVC`; the form (ภ.ง.ด.2 / 3 / 53 / 54) is chosen from the payee's `entityKind` and the type's flags. | A.5 routing rule; one type per income kind. |
| D-35 | CN / DN reason codes are a fixture list tagged `[SP-R]`, printed in Thai, never as a raw code. | Appendix A.9; legal wording awaits SP-R. |
| D-36 | Approving requires `doc.<T>.approve`; the creator may approve their own document unless the company turns self-approval off (default on). | SP0 §7.6 + D-24 (self-approval allowed by default). |
| D-37 | **Ham (GAC):** opening-balance AR / AP open items are settleable sub-items of the OB batch (open-items type `OB`), not documents of a new type; RC / PV may allocate to them. | §5.10 needs per-document open items that later receipts settle; §3.1 has no type for an imported invoice. |
| D-38 | The SP1ab per-document `FILING_LOCK` seed literal is replaced in TX1 by seeded finalized ภ.พ.30 filings for **2026-07 and 2026-08 only**; filing (and period) locks are derived at read time by one function `derivedLocks` used by the GET handler and the fixture predicates. | One source of truth for locks (§7.5). September stays unfiled (due 15 ต.ค. on the 14 ต.ค. anchor): the SP1ab seed has only one non-draft October TI, so filing September would lock every settled / partly-paid TI the correction e2e needs. |
| D-39 | Report and filing pages use static routes (`/reports/*`, `/tax/*`, `/payroll/filings`, `/finance/*`, `/accounting/*` custom pages); only document and record screens use the generic `[group]/[slug]` routes. | Reports and filings are one-of-a-kind layouts; the generic routes stay small. |

## Carry-over assignment (SP1ab ledger → SP1c task or SP2)

Every item the SP1ab final review triaged "SP1c", every item the brief listed, and the parked money paths. Nothing
here is dropped silently.

| Source | Item | Owner |
|---|---|---|
| Brief | RC screens must use the fixed multi-invoice receipt settlement (M3 fixed on direct reissue; the correction-plan RC path still re-creates only the last link) | F5 (engine + vector), S4 (screens + e2e) |
| Brief / T14 | Mobile paper-tab clipping | F2 |
| Brief / T14 | Breadcrumb raw ids | F2 |
| Brief / M5 | `docHref` duplication (`nav.ts` vs `ChainPanel.tsx`) | F1 |
| Brief / M5 | `DocView` hard-coded `'TI'` paper tab | F1 |
| Brief / M7 | No `app/error.tsx` / `global-error.tsx` | F2 |
| Brief / M8 | next-intl test shim returns keys for missing messages | F2 |
| M1 | Operators see journals via `doc.<T>.read` | F3 (D-09) |
| M2 | Period lock treated as blocking by `reissue()` / `buildPlan` | F4 (D-10) |
| M4 | CN-only correction plan lands on a stub | S5 (CN route exists) |
| M6 | Home uses Tailwind default type scale | HC1 |
| M9 | Pasted prices via `Number().toFixed(2)` vs typed `moneyText` | F3 |
| M10 | Saved view status not an `<option>` (select shows "ทั้งหมด") | F3 |
| M11 | `issueLabelTh` unused | F1 |
| M12 | `qk.chain/activity/revisions/ledger` omit the type | F1 |
| T2 | `companies.json` `fiscalYearStartMonth` untyped | ST1 (D-33) |
| T4 / T7 | Home KPIs hand-typed constants; Home status-only SO/CN check; one query → six identical retry alerts | HC1 |
| T5 | No settlement lock on IV revise (amount may not drop below settled) | S3 |
| T5 | PV ignores WHT | F5 (engine), P3 (screen) |
| T5 | Changed-total RC not checked against the TI balance; no test for RC-own changed-total plan | F5 |
| T5 | `reissue()` has no date / total guard for CN / DN | S5 |
| T6 | Untested QueryProvider retry rule / idempotency header / version conflict / toolbar refresh | F3 |
| T7 | cmdk fuzzy filter may drop server hits | F3 |
| T9 | Table rules `--color-rule` vs `--color-rule-soft`; unlayered `:focus-visible` box-shadow; input-group box-in-box; tailwind-merge custom groups note | F3 |
| T10 | Debounced search stale filters / back-forward; overdue view needs a server filter; date range unvalidated; `NotAvailableState` VAT-specific strings; bulk invalidation / failure / live region / `KeyN` test debt | F3 (NotAvailableState in F1) |
| T11 | Fast Enter on an unmatched description loses the next-cell action | F3 |
| T12 | Chain tab no forbidden branch; revision diffs show raw paths; cancel dialog has no totals block; confirm re-enabled on an old plan while a new one loads | F3 |
| T13 | `PaperView` ready flag not reset on model change | F2 |
| T14 | e2e depend on seed row order | F2 (D-24) |
| T16 | Screen index hard-codes seed ids | F2 |
| Ledger 184 | Settlement lock not enforced against a CN (paid TI can go negative); a second correction ignores existing CN / DN | **SP2** (Ham-approved carry as test vectors); S5 adds both as `it.todo` entries named in the SP2 vector list so they are visible, not silently passing |
| Ledger 186 | Confirm endpoint's pre-execute `buildPlan` throws bypass `plan_stale`; plan dialog amounts unformatted | F3 |
| Ledger 193 | API-level correction of an issued CN / DN drops header edits; `vatOverride` wrong for VAT-inclusive prices | S5 (refuse header-drop: 422 `doc.revise_not_allowed` for fiscal CN / DN changes outside a plan); inclusive-price note stays **SP2** (unreachable: notes are exclusive) |
| T3 / T4 / T6 / T13 items triaged SP2 | discountPct float, safe-int parse, no If-Match, unencoded ids, empty buyer address refusal, golden vectors | **SP2** (unchanged) |

## Consumer sweep — the seams SP1c widens

SP1c widens three seams: the set of **built document types** (from TI only to all 21), the **VAT scope** of a type,
and **document fields** (`DocHeader` / `DocLine` / `allocations` / `marks`). Every hand-enumerated consumer found on
main (617b256) gets a disposition. A task that touches one of these files must keep its row true.

| Consumer (file:line on main) | Enumerates | Disposition | Task |
|---|---|---|---|
| `mocks/handlers/docs-read.ts:7` `VAT_ONLY = ['TI']` | VAT-only types | **Move** to `DOC_TYPES[t].vat` via `isTypeAvailable(t, vat)`; non-VAT-only (IV) also refused for a VAT company | F1 |
| `mocks/handlers/docs-write.ts:16` `VAT_ONLY = ['TI']` | same, second copy | **Move** (same helper) | F1 |
| `mocks/engine/commands.ts:17` `HAS_OUT = ['TI','IV']` | types with outstanding | **Move** to `DOC_TYPES[t].outstanding` (TI IV PB EX) | F5 |
| `commands.ts:18` `TAX_BUYER = ['TI','CN','DN']` | buyer TIN + branch required | **Keep**, add comment citing I3 | — |
| `commands.ts:19` `CONVERT_TO` | conversions | **Move** to descriptors' `convertsTo` read by the engine through `DOC_TYPES`-side table `CONVERSIONS` in `domain/doc-types.ts` (§7.7: QT→SO/TI/IV; SO→DO/TI/IV; DO→TI/IV; TI/IV→BL/RC; TI→CN/DN; PO→PB/PV; PB→PCN/PDN/PV; EX→PV) | F1 (table), each type task (enables its row) |
| `commands.ts:67` `missingOf` TI non-VAT check | VAT gating | **Replace** with `isTypeAvailable` | F1 |
| `commands.ts:297` `convert` TI-on-non-VAT check | VAT gating | **Replace** with `isTypeAvailable` | F1 |
| `commands.ts:96-99` `recomputeSettlement` adjusts CN/DN | adjusting types | **Extend** PCN (−) / PDN (+) | P2 |
| `mocks/engine/ledger.ts:18` `POST` table | per-type posting, fixed accounts | **Rewrite** to role-based postings resolved by posting profiles; every ledger type gets a row as its task lands | F4 (TI IV CN DN RC PB PCN PDN PV), later tasks add EX JV FA DP PR OB, settlement |
| `mocks/fixtures/documents.ts:22` `CLASS` | correction class | **Move** to `domain/doc-types.ts`; `documents.ts` re-exports it | F1 |
| `mocks/handlers/docs-write.ts:paperOf` + `/paper` `t !== 'TI'` | printable types, title | **Move** to `mocks/engine/paper.ts` `PAPER_BUILDERS` registry | F1 (TI), each printable type's task |
| `kit/doc-view/DocView.tsx:104` `doc.type === 'TI'` | paper tab | **Replace** with paper registry lookup | F1 |
| `kit/doc-view/ChainPanel.tsx:23` `docHref` | doc routes | **Delete**; use `docViewHref` from the registry | F1 |
| `app-shell/nav.ts:88` `docHref` + `DOC_ITEM` | doc list routes | **Delete**; nav stays the menu; routes come from the registry | F1 |
| `app-shell/nav.ts` `invoices` item → `doc.TI.read` | IV permission | **Change** to `doc.IV.read` (D-08) | F1 |
| `nav.ts` `vatOnly` / `nonVatOnly` flags | VAT scope | **Keep** for non-document items; document items derive their flag from `DOC_TYPES` in `nav.test.ts` (test asserts agreement) | F1 |
| `mocks/handlers/home.ts:22,29,32` `d.type === 'TI'` | AR / VAT KPIs | **Replace** with engine KPI functions (AR = Σ outstanding of TI + IV, AP = Σ of PB + EX, cash = Σ bank GL balances) | HC1 |
| `app/mock/screens/page.tsx:BUILT, BUILT_HREFS` | built screens | **Replace** with `SCREENS` list + registries + fixture keys | F2, every task appends |
| `mocks/permissions.ts` `PERMISSIONS_BY_ROLE` | role grants | **Extend** per task from the catalog | every task |
| `kit/doc-list/DocList.tsx:STATUSES`, `StatusChip.TONE` | statuses | **Unchanged** (D-05: no new status) | — |
| `commands.ts:81` `isFiscalChange` | fiscal fields of T-class | **Extend**: RC allocations (amount, wht, target) are fiscal, `certNumber` is not; CN / DN `refDocId` and `reasonCode` are fiscal | F5, S5 |
| `mocks/engine/log.ts:diffBody` | header + lines diff | **Extend** with `allocations` and `marks` (marks are not revisions: excluded) | F5 |
| `handlers/docs-write.ts:stripOverrides` | client-forbidden fields | **Extend**: strip `allocations[].suggestedWht` and any engine-only field | F5 |
| `kit/doc-editor/DocEditor.tsx` header block (date, due, reference, notes) | header fields | **Replace** with `HeaderFields` driven by `descriptor.headerFields` | F1 (TI keys), each type task adds its keys |
| `kit/doc-editor/LineGrid.tsx` (item columns) | line editor | **Extend** by `descriptor.lineEditor` | F5 (`amount`), AC1 (`account`), PY1 (`payroll`) |
| `kit/doc-view/ActionBar.tsx` convert menu (`convertsTo`) | conversions | **Replace** menu with `ConvertDialog` (partial quantities) | S1 |
| `src/lib/query/keys.ts` | key shapes | **Extend** (type in chain/activity/revisions/ledger; records, reports, filings, open items) | F1, F5, F6, M1, TX1 |

## Open items (cannot be resolved from the sources)

| ID | Item | Needed from | Effect if unresolved |
|---|---|---|---|
| O-1 | §11.3: RD form previews "use real PDFs generated by a local TEAS 1 instance from fixture data" — an implementer cannot produce them | Controller / Ham: run TEAS 1 locally with the SP1c fixture parties, export the PDFs into an ignored folder, or waive for SP1c | TX / PY form views show the React rendition (D-21) with a "ตัวอย่างแบบฟอร์มจริงจาก TEAS 1: ยังไม่ได้แนบ" note |
| O-2 | Coolify staging still not created (SP1ab Task 16 step 4) | Ham | Gates use local production builds (D-31); §11.3 phone review needs the preview |
| O-3 | SP-R rulings (WHT rates, PIT bands, SSO ceiling, VAT threshold, carry-forward vs refund, CN reason wording, deposit tax point) are still Partial / Disagree | SP-R Task 6 (Ham) | Values are `[SP-R]` fixtures; screens unaffected; SP2 replaces them |
| O-4 | R-08 signed combined CN vs separate CN + DN | Ham with SP-R | Screens render either (Global Constraints) |
| O-5 | Approval chains and thresholds beyond one amount threshold (Appendix C flex gap "approval chains") | Ham at GST | ST3 builds one threshold per type (§7.6); chains deferred to SP2 if wanted |
| O-6 | The 11 attachment categories of TEAS 1 were not re-verified | Ham at GS | D-30 list is used |
| O-7 | Email / send and e-Tax are out (D-02, D-13) but Appendix C flex gaps list them | — | Not built (SP0 §1.4 wins) |
| O-8 | Multi-currency appears in Appendix C flex gaps | — | Not built (SP0 §1.4: out) |

## Self-review record

- Spec coverage: Appendix C rows are mapped to tasks in each group file's "Parity coverage" table; the SP0 §11.2 new
  screens map as: posting profiles → ST2, dimensions → ST2, opening balances → AC3, schedules → AC4, settlement →
  F5 + S4 + P3 + FN3, approval inbox → HC1 (engine P4), agent policy → HC2.
- PV action count (S3) → P3 Step 1 (`e2e/pv-action-count.spec.ts`), gate GP.
- **Test-body density (deliberate deviation from the writing-plans skill):** full test code is written out in group
  00 (F1, F2, F4, F5 core vectors), for both action counts (TI, PV), and for every money-invariant vector named as a
  formula. Most later tasks give **named assertions** (`it('…', () => {})` titles that state the exact expected value or
  behaviour) plus `screenContract` rows; the implementer writes those bodies in the owning test file's existing style,
  and each must fail before its fix. Steps 2–5 of later tasks are compressed to one line because the commands are the
  ones in Global Constraints. The controller may ask for a group file to be expanded before dispatching it.
- Fixture facts verified against the SP1ab seed: one non-draft October TI (6 Oct, issued, unpaid); September has issued,
  partly settled and settled TIs; the non-VAT company has no documents until group 02 seeds them.
