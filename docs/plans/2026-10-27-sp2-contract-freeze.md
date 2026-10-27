# SP2 — Contract Freeze and Module Plans (master)

> **For agentic workers:** this master file holds what every SP2+ module shares: what "frozen" means, where the
> contract lives, how it changes, the module order, the per-module gate and the backlog carried from SP1c. Module
> work lives in one spec per module under `docs/specs/` (first: `docs/specs/SP3-platform.md`). An implementer reads
> THIS file (sections 2, 3, 5) plus exactly one task of one module spec.

| | |
|---|---|
| Status | Approved by Ham 2026-10-27 (rulings at the end) |
| Owner | Ham |
| Implements | `docs/specs/SP0-charter.md` §10.5 (OpenAPI → TS), §11.2 (SP2 row), §11.4 (module order), §11.5 (DoD), §11.6 (tiers); D-09 (mock replaced module by module) |
| Inputs | SP1c mock as approved by Ham 2026-10-26 (main 1a79dd8): `frontend/src/domain/**`, `frontend/src/lib/api/**`, `frontend/src/records/**`, `frontend/src/mocks/handlers/**`; `docs/specs/SP1c-parity-checklist.md`; SP-R `docs/research/tax/DECISIONS.md` (branch `docs/sp-r`) |
| Ham rulings 2026-10-27 | SP2 starts with the modules NOT blocked by SP-R: **SP3 Platform, SP4.1 Ledger, SP4.2 Masters + document engine**. Plan depth = "contract + task list" per module. Ham approves per module. |

---

## 1. Goal

Turn the approved mock into a **frozen, versioned wire contract per module**, so the .NET API (SP3, SP4.x) can be
built against it and replace the MSW mock module by module (D-09) with `tsc` catching every drift (§10.5, §12 risk
"mock drifting from the real API").

## 2. What "contract freeze" means

### 2.1 What is frozen — and what is not

| Frozen (changes need §2.4) | Not frozen (free to change) |
|---|---|
| Wire types: every request / response shape the frontend sends or reads | React components, pages, kit, styling |
| Route table: method + path + auth + permission + agent access + idempotency + concurrency + error codes + audit command | Mock engine internals (`frontend/src/mocks/engine/**`, `records/**`) — they must keep conforming |
| Cross-cutting conventions (§2.5) | Message wording (`th.json` / `en.json`), except error **codes** |
| Error codes (stable `code` strings) and their HTTP status | Fixture data |
| Permission codes, system role templates, the agent-forbidden rule | Test files |
| The frozen-figure list (§2.6): which fields are stored at issue / finalize / pay and never re-derived | |

### 2.2 Where the contract lives (decision)

**Phase A — now until a module goes live: hand-written TypeScript, one file per module, in the frontend.**
`frontend/src/contract/<module>.ts` (`platform.ts`, `ledger.ts`, `documents.ts`, then `sales.ts` …). Each file exports:
1. the module's wire types (moved out of `domain/types.ts`, `records/auth.ts`, `records/connect.ts`, `lib/api/endpoints.ts`
   inline types; the old files `export * from '@/contract/<module>'` so no import changes ripple through the app);
2. `ROUTES: RouteSpec[]` — the route table as typed data (`RouteSpec` is defined once in `frontend/src/contract/route-spec.ts`);
3. `CONTRACT_VERSION` (`'1.0'` at freeze).

Reasons (charter): §11.2 defines SP2 as "TypeScript types per module"; §10.5 makes OpenAPI **generated from .NET** —
a hand-written OpenAPI file would be a second source of truth that the generator later contradicts; the frontend,
the mock and `tsc` already compile against these types (the only drift gate that exists today is `pnpm typecheck`
in `.github/workflows/frontend.yml`); one TS toolchain, no new root folder (`tools/check-repo-layout.mjs` allows
`frontend/`, `backend/`, `docs/`, `tools/`).

**Phase B — from SP3 on, per module as it goes live (§10.5):** .NET emits `openapi.json` at build →
`openapi-typescript` (exact-pinned) generates `frontend/src/contract/generated/<module>.ts` (git-ignored, built by
`pnpm gen:api`) → a **conformance file** `frontend/src/contract/conformance/<module>.ts` asserts, per route, that the
generated request / response types and the frozen ones are mutually assignable, and that the OpenAPI path set equals
`ROUTES`. `pnpm typecheck` then fails on any drift. The generator, the conformance helper and the CI step are
**built by SP3 task P3** — they do not exist yet. Until a module's conformance file exists, only Phase A protects it.

`docs/api/openapi.v1.json` is committed as a generated doc (DoD "generated docs updated"), and CI regenerates it and
fails on a diff (built by SP3 P3). This is the one generated file allowed in the tree (§11.1 bans generated build
output; the DoD requires generated docs) — Ham confirms in Q-M6.

### 2.3 How the frontend's existing types map to modules

| Contract file | Owns (moved from) | Routes (from `endpoints.ts` / `authApi` / `connectApi` / MSW handlers) |
|---|---|---|
| `platform.ts` (SP3) | `Me`, `Membership`, `Actor`, `ApiProblem`, `Page<T>`, `Company`, `CompanySettings`, `StaffMember`, `UserRow`, `RoleRow`, `CustomRole`, `AuditEntry` (`domain/types.ts`); `SessionState`, `LoginResult`, `ProfileView`, `SessionRow` (`records/auth.ts`); `KeyKind`, `KeyStatus`, `ApiKeyRow`, `ApiKeysView`, `ApiKeyCreated`, `ApiKeyBody` (`records/connect.ts`); permission codes + role templates (`messages/*.json#permissions`, `mocks/permissions.ts`) | `/me*`, `/auth/*`, `/settings/companies/*`, `/settings/default-notes`, `/settings/users*`, `/settings/roles*`, `/connect/keys*` |
| `ledger.ts` (SP4.1) | `JournalLinePreview`, `JournalEntryPreview`, `JournalPreview`, `ChecklistItem`, `PeriodMonth`, `YearCloseView`, `PeriodsView`, `PostableAccount`; account / posting-rule / dimension / expense-category row shapes; `ReportModel` family (`domain/reports.ts`) for `trial-balance`, `general-ledger`, `general-journal` | `/records/account*`, `/accounting/journal-accounts`, `/finance/postable-accounts`, `/settings/posting/*`, `/settings/dimensions*`, `/settings/expense-categories*`, `/periods*`, `/reports/{trial-balance,general-ledger,general-journal}` |
| `documents.ts` (SP4.2) | `DocType`, `CorrectionClass`, `DocStatus`, `Doc` **core** (id, type, number, status, class, revision, version, header core, lines core, totals, locks, createdBy, issuedAt, cancel, replace links, marks, progress, printCount, approval, moneyBy, approvalRequired, sellerSnapshot, issueLook), `DocLine` core, `DocTotals`, `Lock`, `DocMarks`, `RemainingLine`, `ChainGraph`, `ActivityEntry`, `Revision`, `FieldChange`, `Attachment`, `DocSummary`, `ComputeResult` core, `CorrectionPlan` family, `PaperModel` core, `IssueLook`, `PrintTemplate`, `ApprovalPolicy`, `PartySummary`, `ItemSummary`, `SearchHit`, `DOC_TYPES` / `CONVERSIONS` / `SETTLES` / `GROUPS` / `MARKS` / `ADJUSTS` (`domain/doc-types.ts`), `DocDescriptor`, `RecordDescriptor` / `RecordRow` (typed per kind at freeze), JV fields of `DocLine` | `/docs/{type}*` generic routes, `/docs/open-items`, `/docs/by-party/*`, `/records/{customer,vendor,item,bank-account}*`, `/parties`, `/items`, `/search`, `/settings/numbering*`, `/settings/approvals*`, `/settings/templates*`, `/docs/{type}/{id}/public-links`, `/public/p/{token}` |
| later modules | type-specific `Doc` / `DocHeader` / `DocLine` extension fields (`allocations`, `whtFrozen`, `adjustSnapshot`, `opening`, `asset`, `dp`, `payroll`, …) are frozen **with the module that owns the type**; `documents.ts` lists them as "owned by SP4.x" | per module |

Mock-only surface — **never part of any contract**, and the real API answers 404: `GET /auth/demo`, `/mock/*`
(`mock-fixtures`), the `x-teas-actor` request header (agent identity comes only from an API key / OAuth token; the BFF
strips the header), `POST /settings/users/{id}/accept` (replaced by the invite link flow, SP3), and permissions taken
from the mock toolbar role.

### 2.4 The freeze rule and how a change is made afterwards

1. A module's contract is **frozen when Ham approves its spec**. The controller then adds an entry to
   `frontend/src/contract/FROZEN.json`: `{ "<module>": { "version": "1.0", "sha256": "<of contract/<module>.ts>",
   "approved": "YYYY-MM-DD", "adrs": [] } }`.
2. CI fails when a frozen file's hash differs from `FROZEN.json`, or when `FROZEN.json` changed but the new `version`
   is not higher or an ADR path in `adrs` does not exist. Script: `tools/check-contract-freeze.mjs` (+ `.test.mjs`),
   run in the `layout` job of `frontend.yml` — **built by task C0 below; it does not exist today.**
3. A change after freeze = **an ADR** (`docs/adr/NNNN-*.md`, template `_TEMPLATE.md`, "Spec changes" lists the routes /
   types touched) **+ Ham's approval + a version bump** in the same commit: additive and optional → minor (`1.1`);
   anything else (rename, removal, type narrowing, new required field, changed status / code / semantics) → major
   (`2.0`). The mock and, when live, the backend are updated in the same PR.
4. Before a module is live, a change found while building an earlier module (e.g. SP3 finds a `Me` field missing) is
   still a contract change: ADR + bump. No silent edits.

### 2.5 Cross-cutting contract conventions (frozen once, for every module)

| Concern | Rule (source) |
|---|---|
| Money | decimal **string**, exactly 2 dp, `"64200.00"`; negative with leading `-`; never a JSON number (`Money` in `domain/types.ts`; §5.2.2) |
| Quantity / rate | `Qty` string up to 4 dp; rates as strings (`"3.00"`) or basis-point integers where the mock already uses them (`rateBp`) |
| Dates | `IsoDate` `YYYY-MM-DD` (business date, Asia/Bangkok); instants ISO-8601 with offset; months `YYYY-MM`; "today" only from `Me.businessDate` (§6.3) |
| Ids | opaque strings on the wire (backend: UUID v7); never parsed by the frontend |
| Company | implicit: the session's active company (`POST /me/active-company`); never a path or body parameter except `/settings/companies/{id}` (must equal the active company → else 404 `company.not_found`) |
| Concurrency | every mutable resource carries `version: number`; PUT / POST commands send it in the body, DELETE as `?version=`; mismatch → 409 `record.version_conflict` (or the module's `*.version_conflict`); the check is **at the database** (`UPDATE … WHERE id = $1 AND version = $2`, rowcount 0 → 409), never read-then-compare (SP1c backlog B-2) |
| Idempotency | creates that the frontend retries send `Idempotency-Key` (UUID); the route table marks each route `required` / `none`; same key + same body → replay of the first response; same key + different body → 422 `idempotency.key_reused`; missing on a `required` route → 400 `idempotency.key_required` (§7.8, §10.5) |
| Errors | `application/problem+json`: `{ type, title, status, code, detail?, traceId, fieldErrors? }` (`ApiProblem`); `code` from the registry with Thai and English titles; a 403 for a missing right names the permission in `detail` (§1.6 ruling 2026-08-16) |
| Pagination | `Page<T> = { items, nextCursor?, total? }`; cursor opaque; `limit` ≤ 100 |
| Server-owned fields | the server computes and returns them; values sent by a client are ignored (I1). Marked `/** server-owned */` in the contract |
| Agents | identity from the credential only; agent-callable routes are an explicit allow-list in `ROUTES` (`agent: true`); everything else refuses an agent with 403 `agent.forbidden_action` / `agent.forbidden_setting` (§8.5, HC2b) |
| Base path | browser → `/bff/v1/*` (BFF) → API `/internal/v1/*`; machines → `/api/v1/*`, `/mcp` (§4, §10.5) |

### 2.6 The freeze principle for figures (cross-cutting, every module)

**Any figure or fact derived from editable data is stored on the document when it is issued / finalized / paid,
and every later reader (paper, ledger, register, report, invariant) reads the stored value — never re-derives it**
(CLAUDE.md routing rule 4; four money REJECTs in SP1c came from re-derivation). In the contract every such field
carries `/** @frozen <issue|finalize|pay|register|match|review> */`. Each module spec lists its frozen fields and has
a test per field: change the source data after the event → the stored value and every reader are unchanged.

Known frozen fields from the approved mock (each module spec inherits its rows):

| Field (type) | Frozen at | Source data it shields | Owner module |
|---|---|---|---|
| `sellerSnapshot`, `issueLook` (Doc) | issue and every revise | company identity, logo / stamp / signature | SP4.2 |
| `party` snapshot (Doc), `partyName` on OB items / schedule templates | issue / write | party master | SP4.2 / SP4.6 / SP4.11 |
| `postedAccount` (purchase DocLine) | issue / revise / reissue | posting rules, expense categories | SP4.1 (resolver) + SP4.4 |
| `JournalLinePreview.rule`, `partyId`, `openItemId` | posting | posting rules, party | SP4.1 |
| `bankSnapshot` (RC / PV header) | issue / revise | bank-account master | SP4.3 / SP4.4 |
| `whtFrozen` (PV), `WhtLine.rate` | issue / revise | WHT rate table | SP4.4 |
| `vendorVatRegistered`, `claimPeriod`, `inputVatForfeited` (PB / PCN / PDN) | issue / revise | vendor master, filings | SP4.4 |
| `adjustSnapshot` (CN / DN) | issue | original TI | SP4.3 |
| `approval.amount`; approval policy and settlement tolerance in force | submit / approve / issue | approval policy, tolerance settings | SP4.2 / SP4.5 |
| `BankMatch` (`docCash`, `accountId`, `docDate`) | match | the matched document | SP4.5 |
| `SettlementLeg` (`type`, `number`, `partyName`) | posting | the settled documents | SP4.5 |
| `AssetData` (cost, salvage, life, codes …), `Disposal`, `DpRow` | register / dispose / run | asset class, posting rules | SP4.6 |
| `ScheduleRecord.template`, amortisation plan, accounts | create / edit | templates, accounts | SP4.6 |
| `PayrollSlip` (items, employee, tables, prior YTD), `PayrollPayment.account` | issue / pay | employee master, PIT / SSO tables, bank account | SP4.7 |
| filing models: company block, fingerprint, figures; WT certificate model | finalize / first print | company, documents, rates | SP4.8 |
| numbering format per period | first number of the period | series settings | SP4.2 |
| `DocOpening.codes`, OB open items | issue / revise | posting rules, party | SP4.11 |
| `AgentReport` (totals, journal, checks, route, policy) | review | policy, party history | SP4.10 |
| `ApiKeyRow.scopes` (the grant; rights at use = scopes ∩ owner's current rights) | create / rotate | — (deliberately NOT frozen: owner rights are read live) | SP3 |

### 2.7 Contract smells to fix at each freeze (not later)

| Smell in the mock | Fix at freeze | Module |
|---|---|---|
| `Membership.role: Role` cannot express a custom role (ST1) | `roleId: string; roleName: string` | SP3 |
| settings PUT bodies typed `Record<string, unknown>` (`saveCompanySection`, `inviteStaff`, `updateStaff`, `createRole`, `updateRole`) | one typed body per section / command | SP3 |
| `RecordRow` = `{ [field]: unknown }` | a typed row per record kind | SP4.1 / SP4.2 |
| images and attachments travel as base64 data URLs (`logoDataUrl`, `stampDataUrl`, `signatureDataUrl`, `Attachment.dataUrl`) | SP3: keep data URLs for the three settings images (≤ 1 MB, png / jpeg / webp, ST1) — the API stores them through the file store; SP4.2 decides attachments (upload endpoint + file id) at its freeze | SP3 / SP4.2 |
| invite / reset links are minted (`https://app.teas.example/invite/<token>`) but nothing consumes them | `GET` / `POST /auth/links/{token}` + a set-password page (needs a mock screen first, S2) | SP3 |
| `Doc` is one wide interface for 21 types | `documents.ts` freezes the core; per-type fields frozen by their module (§2.3) | SP4.2+ |

---

## 3. Module order and dependencies

### 3.1 Now (Ham 2026-10-27): not blocked by SP-R research

| # | Module | Spec (to write) | Depends on | SP-R points that touch it — and why they do not block |
|---|---|---|---|---|
| 1 | **SP3 Platform** | `docs/specs/SP3-platform.md` (drafted with this plan) | — | **D-04-1** append-only for all tenants: recommendation A = charter §7.12 already; confirm. **D-04-2** retention: the app never purges (§7.12.4); a legal-hold flag is additive later. **D-04-3** hosting inside Thailand: an infrastructure decision for prod, not code — needed before SPz, asked in SP3 Q6 |
| 2 | **SP4.1 Ledger** | `docs/specs/SP4.1-ledger.md` | SP3 | **D-15-3** (is the 2566 DBD notice current) changes seeded mapping VALUES (`dbdLine`, `pnd50Box` on accounts), not the schema; values stay tagged `[SP-R]` (D-15-1 / D-15-2 are SP4.9 report scope). **Fiscal year** (not an SP-R point, but tagged `[SP-R]` in the mock): §5.8 says 12 months from the start month, the approved mock refuses any start month but January (`company.fiscal_year_unsupported`). SP4.1 stores the start month and derives periods from it, and keeps refusing ≠ 1 until Ham rules (Q-M3) |
| 3 | **SP4.2 Masters + document engine** | `docs/specs/SP4.2-masters-documents.md` | SP3, SP4.1 | **D-03-2** series per branch mandatory or default: the series key always includes the branch (default `00000`), so both answers are a setting, not a migration. **D-03-1** unexplained gap = error or warning: allocation is atomic at issue either way (§5.14); severity lives in the SP4.8 gap report |

**Order change proposed (Q-M2):** charter §11.4 puts "JV + reverse" in SP4.1, but a JV is a document (number series,
revisions, lifecycle, activity) and needs the SP4.2 engine. Proposal: SP4.1 ships the posting kernel with a
kernel-level journal command (used by its own tests and by period close / year-end); the **JV document type is the
first descriptor of SP4.2** (it has no tax, so it proves the engine). Reverse = SP4.2 (it is a JV command).

### 3.2 Later: blocked by SP-R decision points (`DECISIONS.md`, 56 points) — in charter order

| Module | Blocking SP-R points | Other inputs |
|---|---|---|
| SP4.3 Sales | D-01-1, D-01-2 (VAT rounding); D-02-1, D-02-2 (tax-invoice content); D-08-1..3 (cancel / reissue, CN / DN; also R-08 signed combined vs separate); D-09-1, D-09-2 (tax point); D-10-1 (registration status); D-11-1..3 (accrual / billing documents); D-17-1, D-17-2 (late invoice date); D-20-1, D-20-2 (VAT rate table) | ADR-0002; P-10 shared with SP4.5 |
| SP4.4 Purchase | D-05-1, D-05-2 (input VAT window); D-06-1..5 (WHT, 50 ทวิ, e-WHT); D-07-1 (ภ.พ.36 credit month); D-19-1..4 (foreign payments, ภ.ง.ด.54); interim P-01..P-07 | |
| SP4.5 Settlement and bank | interim P-08..P-11; D-09-1 / D-09-2 for deposits (shared with SP4.3); D-11-1 (advances) | D-13 settlement records (Ham 2026-10-16) |
| SP4.6 Assets and schedules | D-16-1..4 (depreciation methods, disposal year, day count, SME allowances) | |
| SP4.7 Payroll | D-13-1..4 (PIT / SSO); D-06-1 (employer-borne tax, shared with SP4.4); D-18-3 (SSO export) | ledger carries: OB 2153 / 2160, 2190, SSO floor per slip |
| SP4.8 Tax filings | D-01-3 (baht fraction); D-07-1; D-12-1 (excess input VAT); D-14-1..4 (CIT); D-18-1, D-18-2, D-18-4 (RD exports); D-03-1 (gap report severity) | |
| SP4.9 Reports | D-15-1, D-15-2 (P&L presentations, cash-flow); D-15-3 shared with SP4.1 (mapping values) | |
| SP4.10 Connect | none from SP-R; Ham product decision Q-M4 (agent cap per period) | OAuth 2.1 server, consent, agent policy + review protocol, REST v1 hardening |
| SP4.11 Onboarding and import | D-04-4 (ภ.อ.11 reminder); `[SP-R]` OB tax payables (2153 / 2160) from the 05 / 07 ledgers | FG-05c master-data import |

Count check: SP3 3 + SP4.2 2 + SP4.3 17 + SP4.4 12 + SP4.6 4 + SP4.7 4 + SP4.8 10 + SP4.9 3 + SP4.11 1 = 56
(secondary listings — D-06-1 in SP4.7, D-07-1 in SP4.8, D-09-x in SP4.5 — are not double-counted).

A later module's spec starts only when its blocking points are answered (ADR where SP0 changes), then it follows §4.

## 4. Per-module gate (every module from SP3 on)

| Step | Who | Output | Gate |
|---|---|---|---|
| 1. Design | Opus designer (footgun zone: schema, money, security) or Fable designer (hardest) | `docs/specs/<module>.md` from `_TEMPLATE.md`: frozen contract (types + `ROUTES`), schema sketch with RLS, endpoints, invariants, frozen-figure list, DoD, task list (SP1c group-plan shape) | — |
| 2. Review | Fable | money / invariant sections read in full | spec fixes |
| 3. **Ham approves** | Ham | ruling recorded in `STATUS.md` | contract frozen: `FROZEN.json` entry + commit (task C1..C3) |
| 4. Build | workers per task | code + tests | Tier 1 gates per task; Tier 2 Opus review for money / security / schema; Tier 3 consolidated gate |
| 5. Done | controller + Ham | DoD ticked, demo to Ham, Tier 4 live leg on staging for money / tax paths | SP0 §11.5 |

## 5. Backlog carried from SP1c

| ID | Item | Disposition (module, how) |
|---|---|---|
| B-1 | 9 deferred flexibility rows (Ham 2026-10-26) | FG-01b bell (inbox count in the Topbar) → SP4.10 Home wiring; FG-05c grid paste → SP4.2 kit, CSV import → SP4.11; FG-06a batch approve / print → SP4.2 (DocList bulk actions over the approval commands); FG-06b list CSV export → SP4.2, XLSX → SP4.9; FG-07b PO matching tolerance → SP4.4 (Ham rules on the setting); FG-10f units of measure → SP4.2 (masters); FG-10h custom fields → Ham: rule out (SP0 §1.4) or SP4.2; FG-11b more bank formats → SP4.5; FG-16 filing readiness checklist → SP4.8. **Each needs a mock screen approved by Ham before its backend (S2).** Confirm in Q-M5 |
| B-2 | Settings PUT reads state before awaiting the body → lost update | SP3: version check in the `UPDATE` statement + a two-writer race test (SP3 P4 primitive, P8 on company sections; invariant S17) |
| B-3 | Revision 0 carries no issue look (m4: the look is stamped after `revisions.push`) | SP4.2 engine rule: the issue / revise snapshot (seller, look, party) is written **before** the revision row is created, inside the issue transaction; test: revision 0 snapshot has `issueLook` |
| B-4 | Agent cap per document → running per-period total | SP4.10 (agent policy). Q-M4: replace the per-document cap or add a per-month cap beside it |
| B-5 | `MISSING_MESSAGE screens.name.*` noise in e2e logs | SP3 task P0 (frontend): every key listed in `app/mock/screens/screens.ts` exists in `th.json` / `en.json`; a unit test fails on a missing one |
| B-6 | Approval chains beyond one threshold (O-5) | SP4.2 freezes one threshold per type (as approved); chains need a mock screen and an ADR |
| B-7 | Agent allow-list is the only guard outside document writes (troubles-wiki, HC2 r4) | SP3 removes the class: agent routes exist only where `ROUTES.agent = true` (mapped on `/api/v1` and `/mcp` by construction) plus a runtime check |
| B-8 | Real-account go-live opening screen; in-transit at go-live (FN2/FN3 ledger, STATUS 2026-10-16) | SP4.11 |
| B-9 | ภ.พ.30 "เล่มที่" blank (TX4) | SP4.8 |

## 6. ADRs to write (listed here; not created by this plan)

| Proposed ADR | Decision | Needed before |
|---|---|---|
| ADR-0003 Contract freeze | §2.2 / §2.4 of this plan (TS-first, conformance bridge, FROZEN.json) | C0 |
| ADR-0004 Browser session model | opaque server-side session (cookie → `sessions` row) instead of §10.4 "compact access token + rotating refresh tokens" for the browser, because the approved mock's session list, revoke-one, revoke-others-on-password-change and instant logout need server-side state a self-contained token cannot give; OAuth clients keep tokens (SP4.10) | SP3 P7 |
| ADR-0005 Agent limits widened | agents never approve / cancel / correct any type (not only T-class); policy table limited to 15 types, JV / PR / OB / FA / DP / WT always Off (HC2c) — amends §8.4 / §8.5 | SP3 P9 |
| ADR-0006 Fiscal year interim | calendar year only until SP-R / Ham; amends §5.8 for now | SP4.1 |
| ADR-0007 SP4.1 / SP4.2 split of JV | §3.1 above; amends §11.4 | SP4.1 spec |
| ADR-0008 Mock-era rulings that amend SP0 | D-11 fourth line editor (§7.1); P-06 stricter self-approval (§7.6); D-13 settlement record without a legal series (§5.11); a cross-month revise keeps its number (§5.14, Ham 2026-10-18) | the owning module's spec |

## 7. SP2 tasks (controller-run; docs and the freeze tooling)

### Task C0: Contract scaffolding and the freeze guard

**Depends on:** Ham approves this plan. **Blast cap:** 8 files, no runtime behaviour change.
**Files:** Create `frontend/src/contract/route-spec.ts`, `frontend/src/contract/FROZEN.json` (`{}`),
`tools/check-contract-freeze.mjs`, `tools/check-contract-freeze.test.mjs`, `docs/adr/0003-contract-freeze.md`.
Modify `.github/workflows/frontend.yml` (layout job: `node --test tools/check-contract-freeze.test.mjs` and
`node tools/check-contract-freeze.mjs`).
**Rules:** `RouteSpec = { method: 'GET'|'POST'|'PUT'|'DELETE'; path: string /* BFF path, `{param}` style */; auth:
'public' | 'session' | 'session-or-expired'; permission?: string | ((p: Record<string,string>) => string); agent: boolean;
idempotency: 'required' | 'none'; concurrency: 'version-body' | 'version-query' | 'none'; request?: string; response:
string /* type names */; errors: string[]; audit?: string }`. The script: for each module in `FROZEN.json`, sha256 of
`frontend/src/contract/<module>.ts` (LF-normalised) must equal the recorded hash; if `FROZEN.json` changed against
`origin/main`, every changed entry's `version` must be higher and every `adrs` path must exist.
- [ ] **Step 1: Failing tests** (`node --test`): hash mismatch → exit 1; version not bumped → exit 1; missing ADR → exit 1;
  clean → prints `contract freeze ok`. **Step 2–4:** implement, PASS. **Step 5:** controller commits
  `chore(contract): route spec and the contract freeze guard`.

### Task C1: Freeze the SP3 platform contract

Executes `docs/specs/SP3-platform.md` task P0, then adds the `platform` entry to `FROZEN.json`. Runs after Ham approves
the SP3 spec.

### Task C2 / C3: SP4.1 and SP4.2 specs

Opus designer drafts `docs/specs/SP4.1-ledger.md`, then `docs/specs/SP4.2-masters-documents.md` (contract per §2.3,
schema with RLS per SP3 D2, invariants as formulas, frozen-figure tests, guards-with-exits table, task list). Fable
review → Ham approves → freeze as in C1. SP4.1 may start design while SP3 builds; it freezes only after the SP3
contract (it uses `Actor`, `ApiProblem`, `Page`, version and idempotency conventions).

---

## 8. Open questions for Ham

| # | Question | Recommendation |
|---|---|---|
| Q-M1 | Contract lives in `frontend/src/contract/<module>.ts` (TS-first), bridged to the charter's OpenAPI pipeline by a conformance check; changes by ADR + version (§2.2, §2.4) | Approve |
| Q-M2 | Move the JV document type (and reverse) from SP4.1 to SP4.2 as the engine's first descriptor (§3.1) | Approve |
| Q-M3 | Fiscal year: store the start month and derive periods from it, but keep refusing ≠ January until SP-R / your ruling (ADR-0006)? Or build any start month now (§5.8 as written)? | Keep calendar-only for now |
| Q-M4 | Agent cap: replace the per-document cap with a per-month running total, or keep both (per document AND per month)? | Both: per-document cap as approved + a per-month total per type |
| Q-M5 | Deferred flexibility rows: placement in §5 B-1 OK? FG-10h custom fields: drop (add to SP0 §1.4) or build in SP4.2? | Placement OK; drop custom fields |
| Q-M6 | Commit the generated `docs/api/openapi.v1.json` as a doc (CI checks it is current)? | Yes |
| Q-M7 | Approval chains (O-5): stay at one threshold per type through SP4.2? | Yes; chains later with a mock screen |
| Q-M8 | Write ADR-0008 to record the mock-era rulings that amend SP0 (§6)? | Yes |

## 9. Charter statements contradicted by the approved mock

| SP0 | Charter says | Approved mock does | Disposition |
|---|---|---|---|
| §8.4 | N- and L-class default Auto-if-clean | Only 15 policy types; JV, PR, OB, FA, DP, WT always Off, not settable (HC2c) | ADR-0005 |
| §8.5 | Agents need a human only to cancel / reissue T-class | Agents never approve, cancel or correct ANY type; those rights can never be a key scope | ADR-0005 |
| §8.2 | Agent calls `post(document, review_token)` | Agent calls the ordinary `issue`; the gate checks the document's current stored report (same version, unexpired, policy now); no token parameter | SP4.10 freeze decides; binding is equivalent |
| §8.4 | Cap per document | Ham: running per-period total | Q-M4 |
| §10.4 | Compact access token + rotating refresh tokens | Server-side sessions: list, revoke one, revoke others on password change, extend, expiring / expired states | ADR-0004 |
| §10.4 | One permission catalog **in code** generates frontend gates | The mock derives the catalog from the `th.json` message keys | SP3 inverts it (catalog authoritative, exported to the frontend) |
| §5.8 | Fiscal year = 12 months from the start month | Only January accepted | ADR-0006 / Q-M3 |
| §7.1 | Three line editors | Four plus `none` (payroll, D-11 ruled) | ADR-0008 |
| §7.6 | The creator may self-approve unless disabled | Off also blocks the submitter and the last money editor (P-06) | ADR-0008 (P-06 also with SP-R) |
| §5.11 | Netting "with a settlement document" (and §3.1 lists no such document type) | Settlement record, no legal series (D-13, Ham) — a terminology ruling, not a behaviour change | ADR-0008 records the wording |
| §5.14 / §6.3 | Series month from `document_date` | A cross-month revise keeps its number (Ham 2026-10-18) | ADR-0008 |
| §10.7 | Files behind a storage interface | Images and attachments inline as base64 data URLs | §2.7 smells |
| §11.4 | JV + reverse in SP4.1 | (plan conflict, not mock) JV needs the SP4.2 engine | Q-M2 / ADR-0007 |
| §7.12 | Audit `result` ok / rejected | Only successful commands are written | SP3 D10 writes refused 403s out-of-band |

## Ham rulings 2026-10-27

Approved as recommended: Q-M1 (TS-first contract in `frontend/src/contract/`, frozen by hash, changed by ADR + version; conformance with the generated OpenAPI), Q-M2 (JV moves to SP4.2), Q-M3 (store the fiscal-year start month, accept only January for now), Q-M4 (agent cap per document AND a per-month running total per type), Q-M5 (deferred rows placed as in §5; FG-10h custom fields DROPPED — add to SP0 §1.4 via ADR-0008), Q-M6 (commit `docs/api/openapi.v1.json` as a generated doc, CI checks it), Q-M7 (one approval threshold per type through SP4.2), Q-M8 (write ADR-0008).
