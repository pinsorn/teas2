# SP4.2 — Masters and the document engine

| | |
|---|---|
| Status | Draft for Ham, 2026-10-27 |
| Owner | Ham |
| Implements | `docs/specs/SP0-charter.md` §3.1–3.2, §5.14, §6.2 I4 / I5 (engine side), §6.3, §7.1–7.12 (engine; type-specific parts stay with their modules), §9.3, §11.4 item 3; master plan `docs/plans/2026-10-27-sp2-contract-freeze.md` §2.3 (`documents.ts`), §2.6, §2.7, §3.1 row 3, §5 B-1 / B-3 / B-6, Ham rulings 2026-10-27 (Q-M2 JV is the first descriptor, Q-M4 agent caps, Q-M5 custom fields dropped, Q-M7 one approval threshold per type) |
| Depends on | SP3 (built), SP4.1 (built: kernel, resolver, `DimensionJudge`, periods, `parties` core). D0 may run while SP4.1 builds (frontend only) |
| Blast cap | Per task (each names its own; hitting it = stop and re-spec). Spec-wide: `backend/src/Teas.Domain/Documents/**`, `backend/src/Teas.App/{Documents,Masters,Numbering}/**`, `backend/src/Teas.Api/Endpoints/{Documents,Masters,Settings}/**`, `backend/src/Teas.Migrator/**` (SP4.2 migrations), `backend/tests/**/{Documents,Masters,Numbering}/**`, `frontend/src/contract/documents.ts` + its conformance / test files, the frontend files named in D0. **API changes:** exactly the documents contract of §5 (frozen at Ham's approval); anything else = ADR + version |

## 1. Goal

Build the masters (customers, vendors, items, bank / cash accounts), the legal numbering series, and the ONE document
engine every type runs on: descriptors, the lifecycle (draft → [pending → approved] → issued → [partly settled →
settled] → cancelled | replaced), the three correction classes with revise / reissue / cancel and the correction plan,
conversions and the document chain, the approval policy, the snapshots taken at issue (seller, issue look, party,
policy), activity / revision history / audit, the print log, attachments, notes and public links — and prove it with the
first real descriptor, the journal voucher (JV). Behaviour is what the approved mock does (SP1c groups 00, 01, 02
engine rulings, 05 AC1, 09 ST1–ST4 and their Opus reviews), hardened where a database must differ.

## 2. Scope

| In SP4.2 | Not in SP4.2 (owner) |
|---|---|
| Customers, vendors (the master columns of SP4.1's `parties`), items, bank / cash accounts (+ the Cash rule through SP4.1), `/parties`, `/items`, `/search`, bank GL list | Employees (SP4.7); `linkedPartyId` netting pairs (SP4.5); bank imports, go-live, reconciliation (SP4.5) |
| Numbering series: config, allocation, the one parser, frozen format per series key, one scope per year | The number-gap report (SP4.8 / SP4.9 read the same parser) |
| Descriptor registry + generic routes `/docs/{type}*`; lifecycle; N / L / T correction framework (revise, reissue, cancel, plan + execute); conversions, remaining quantities, marks, close remainder, chain; derived locks registry | Every type except JV: their posting builders, tax rules, plan steps for fiscal T-class corrections, paper builders (SP4.3 sales, SP4.4 purchase, SP4.5 settlement types, SP4.6 FA / DP, SP4.7 PR, SP4.11 OB) |
| Approval: policy per type (one threshold, Q-M7), self-approval incl. P-06, the policy snapshot, approve-and-issue, send back, revise above the approved amount; settlement tolerance setting (stored here, read by SP4.5) | Approval chains (B-6, needs a mock screen + ADR) |
| Seller snapshot, issue look (files), party snapshot, print templates, paper route, print log (original / copy), revision 0 look (B-3) | RD statutory forms (SP4.8) |
| Attachments (upload + content), notes (= `header.notes`), activity, revisions + diff, audit of every command | An internal notes / comments thread (not in the approved mock — Q-D7) |
| Public links (rules frozen in SP3 S13) | Agent review, policy table, caps (SP4.10) — SP4.2 ships the hooks |
| The JV document: account lines, Dr = Cr, control-account refusal, reverse, auto-reversing accrual, paper, approval | Recurring / amortisation JVs (SP4.6 uses the JV through hooks) |
| UI kit wiring: the existing DocList / DocEditor / DocView / record kit switch to the real API route by route (SP3 live-route switch, hybrid mode); no kit rewrite — the only kit change is the attachment download link (§5.1) | New kit components |
| Deferred flexibility rows FG-05c grid paste, FG-06a bulk approve / print, FG-06b list CSV export, FG-10f units of measure — **only after Ham approves their mock screens (S2)**; they are NOT in this freeze (added later as ADR + minor version) | FG-10h custom fields — dropped (Ham Q-M5, recorded in ADR-0008) |

## 3. Context and footguns (read before any task)

| # | Footgun | Where it bites | Rule |
|---|---|---|---|
| D-F1 | SP3 F1–F14 and SP4.1 L-F1–L-F16 | all | apply verbatim; every new tenant table through `RlsSql.TenantTable` + a `TenantRowFactory` method in the same task |
| D-F2 | PostgreSQL SEQUENCES are not transactional: a rolled-back issue would burn a number → a gap (I4) | numbering | never a sequence: the counter is a row (`series_counters`) updated under `SELECT … FOR UPDATE` inside the issue transaction; a refused or rolled-back issue leaves the counter unchanged (test: a refusal after allocation leaves no gap) |
| D-F3 | B-3: the mock pushes the revision-0 snapshot BEFORE `logActivity('issue')` stamps `sellerSnapshot` / `issueLook`, so revision 0 has no look | issue, revise, reissue | order inside the transaction: snapshots (seller, look, party, policy) → number → posting → links → revision row → activity → audit (§4.3). Test: revision 0's snapshot has `issueLook` |
| D-F4 | troubles-wiki "`revise()` silently moved a receipt to the company default bank when the proposal left the field out" | revise, plan, reissue | an absent or `null` `bankAccountId` / `dimensions` in a proposal means "unchanged" (`keepOmitted`), in the plan AND in execute (one function) |
| D-F5 | Server-owned fields arrive in bodies (mock `stripOverrides`: `vatOverride`, `targetNumber`, allocation `partyId`, `reversalOf`, `autoReversal`, `ob*`, `opening.codes`, `payroll`, `disposal`, `bankSnapshot`, `postedAccount`) | every body | request DTOs simply do not contain them (minimal-API binding ignores unknown JSON members); a test per field posts it and asserts it is not stored (SP2 I1 "server-owned fields") |
| D-F6 | Mock correction plans run on a `structuredClone` and commit at the end | plan execute | one DB transaction: every step's writes, numbers and postings roll back together on any failure; the stored plan stays for a retry, is single-use on success |
| D-F7 | troubles-wiki "Agent requests: the allowlist in `mocks/handlers/me.ts` is the only guard outside document writes" | agents | SP3 builds the surface by construction (`agent: true` only on the routes of §5.4); the engine's own agent refusals stay as defence |
| D-F8 | Mock idempotency key = `company\|type\|key`; SP3's = `(company, actor, key)` | create | SP3's record is the only one (route-level, `required` on `POST /docs/{type}` and `POST /records/{kind}`); same key + different body → 422 `idempotency.key_reused` |
| D-F9 | Mock images are hashes into `st.images` (never removed) | issue look | `issue_look` stores SP3 `files` ids; no route deletes a file referenced by any `issue_look` / `print_templates` / company image (SP3 has no file-delete route; an architecture test forbids `DELETE FROM teas.files` outside the migrator) |
| D-F10 | Mock document links of a deleted DRAFT are deleted, while charter §7.11 says links are append-only | draft delete | links whose `from` is a draft are deleted with the draft (a draft has no legal standing; mock S1); every other link row only ever changes `active` true → false (trigger) — an amount change is deactivate + insert |
| D-F11 | troubles-wiki "A credit / debit note without `refDocId` …", "Fixture predicates …", "seed documents" | SP4.3+ | not SP4.2's; the engine's tests use TEST descriptors (§4.2) so no sales fixture is needed |
| D-F12 | Mock `numbering.ambiguous` / `numbering.collision` answer 409 at allocate and 422 at save / preview; SP3 maps one code → one status | errors | split: allocate-time codes become `numbering.allocation_ambiguous` / `numbering.allocation_collision` (409); save / preview keep the old codes (422) — contract delta, mock conforms in D0 |
| D-F13 | Mock `/settings/default-notes` is SP3's (route 19) | notes | SP4.2 adds no notes route; "notes" = `header.notes` (printed; a T-class non-fiscal field) and the per-type default note SP3 serves |
| D-F14 | troubles-wiki "print: two tabs both think they print the original" (S6) | print log | `POST …/printed` takes the document row `FOR UPDATE` before counting prints |
| D-F15 | SP3 audit coverage: "every non-GET route declares an audit command" | compute, previews | read-only POSTs (`/docs/{type}/compute`, `/settings/numbering/preview`) go on the coverage test's read-only allow-list (SP4.1 L4 creates it) with a "writes nothing" row-count test |

SP-R points touching SP4.2 (master plan §3.1): **D-03-2** (series per branch mandatory or default) — the series key
always carries a branch column, constant `00000` in SP4.2 (§4.5), so either answer is a setting later; **D-03-1** (gap =
error or warning) — allocation is atomic at issue either way; severity is the SP4.8 report's.

## 4. Design

### 4.1 Code layout

```
backend/src/Teas.Domain/Documents/  DocTypeInfo (DOC_TYPES), CorrectionClass, Lifecycle (status transitions), FieldDiff,
                                    NumberTemplate (format, parse, validate), ApprovalPolicyMath, Q4 (qty)
backend/src/Teas.App/Masters/       Parties (customer / vendor), Items, BankAccounts, Search
backend/src/Teas.App/Numbering/     NumberingConfigs, SeriesAllocator
backend/src/Teas.App/Documents/     DescriptorRegistry, DocumentEngine (commands), CorrectionPlans, Conversions, Marks, Chain,
                                    Locks (derived-lock registry), Approval, Snapshots (seller, look, party, policy),
                                    Activity, Revisions, Prints, Attachments, PublicLinks, Papers, Hooks (agent, finality)
backend/src/Teas.App/Documents/Types/Jv/   JvDescriptor, JvPosting, JvReversal, JvPaper
backend/src/Teas.Api/Endpoints/{Documents,Masters,Settings}/
```

### 4.2 Descriptor registry

A type is declared, never hand-built (§7.1). `IDocDescriptor` (C#) carries: `Type` (string code), `Class`, `VatScope`,
`Ledger`, `Outstanding`, `Printable` (each must equal the contract's `DOC_TYPES` — contract test), `PartyKind`,
`LineEditor`, `Conversions` ⊆ `CONVERSIONS`, `Settles`, `Groups`, `Adjusts`, `Marks`, `Closeable`, and hooks:
`Missing(company, body)` (what blocks issue), `Problems(company, body, before?)` (type refusals), `Totals(body)`,
`Posting(doc) → PostingIntent` (SP4.1 kernel), `FiscalChange(old, proposed)` (T-class), `PlanSteps(old, proposed)`
(T-class fiscal corrections; the engine builds the rest), `Paper(doc, copy)`, `ApprovalAmount(doc)` (default: total;
SP4.4 overrides with the payout), `Signatures`, `IssuerLine`, `AgentDefault` (Off / Human / Auto — SP4.10 reads it).

- The production registry contains exactly the LIVE types (SP4.2: `JV`). Any other code on `/docs/{type}*` → 404
  `doc.type_not_available` from the real API (in hybrid mode those routes stay on MSW until their module).
- The TEST host registers three test descriptors, `XN` (N-class), `XL` (L-class, posts one fixed role pair), `XT` (T-class
  with a reissue-only plan step), used by every engine test — so SP4.2 proves revise / reissue / convert / marks /
  cancel without any sales or purchase code (they are compiled only into `Teas.Integration.Tests`).

### 4.3 Commands and their order (the §7.8 pipeline)

Every write: authorize (route permission + agent) → bind body (before any read) → idempotency claim (create) →
`SELECT … FROM documents WHERE id = $1 FOR UPDATE` → version compare (`doc.version_conflict` 409) → transition → … →
`UPDATE … SET version = version + 1 WHERE id = $1 AND version = $v` → activity + audit, in ONE transaction.

| Command | From | Effect (mock function) |
|---|---|---|
| create (`createDraft`) | — | draft, `revision 0`, `version 1`, `createdBy`; party snapshot from the master; `moneyBy` unset; activity `create`, audit `doc.create` |
| update draft (`updateDraft`) | draft, approved | an agent only its own draft; `pending` → 409 `approval.pending`; `approved` → back to draft (approval and policy dropped, activity `send_back` "แก้ไขหลังอนุมัติ ต้องส่งอนุมัติใหม่"); `moneyBy` = the actor when the total / lines / allocations changed; the agent report id dropped |
| delete draft (`deleteDraft`) | draft only (pending / approved → 409 with the exit "send back first") | deletes the row, its draft links and attachments; activity `delete`; audit `doc.delete` |
| compute (`compute`) | — | read-only; `journal` only with `ledger.read`; `approvalRequired` per §4.6; with `?docId` (revise mode) the document's own settlements are given back |
| submit (`submitForApproval`) | draft | only a complete document (missing / type problems refuse); 422 `approval.not_required` when the policy does not want it; status pending; `approval.submittedBy/At`; policy snapshot frozen |
| approve | pending | 403 `approval.self_not_allowed` per §4.6; `approval.approvedBy/At`, `amount` = `ApprovalAmount`; status approved (no number) |
| approve-and-issue | draft, pending | needs approve AND issue rights; a draft whose policy needs nothing simply issues; else self-approval check, then issue with `approver` |
| send back | pending, approved | reason required (`approval.reason_required`); back to draft; approval + policy dropped |
| issue (`issue`) | draft, approved (pending → 409 `approval.pending`) | §4.3.1 |
| revise (via plan step) | live | N: new revision, diff, label "ฉบับแก้ไขครั้งที่ n"; L: new revision + kernel `Reverse(last live entry, Original)` + `Post(Correction, Late)`; T: only non-fiscal changes (`doc.revise_not_allowed` otherwise); refusals in mock `revise` order |
| reissue (via plan step) | live T | new document (new number at the original date for TI / RC / notes, I9), old one `replaced` + reversal (`Original`), links carried, `replaces` link; total must be equal (`doc.reissue_total_changed`) |
| cancel | live | refusals in mock `cancel` order (§7); reason code + text; status cancelled, outstanding cleared; kernel `Reverse(last, Today)` (user) or `Original` (plan step / system); links from it deactivated; targets recomputed |
| correction plan / execute | live | §4.4 |
| convert | live source | §4.7 |
| marks / close remainder | live | §4.7 |
| reverse (JV only) | live JV | §4.11 |
| printed | issued, cancelled, replaced | §4.8 |

#### 4.3.1 Issue, step by step (mock `issue`, with B-3 fixed)

1. status ∈ {draft, approved} (pending → 409 `approval.pending`; else 409 `doc.not_draft`); version.
2. agent gate (`IAgentIssueGate`, §4.13); approval gate (§4.6) — before anything is computed.
3. `Missing` → 422 `doc.incomplete` (messages joined); date guards: `documentDate > businessDate` → 422
   `doc.future_date`; the kernel's `Strict` placement refuses a closed month / year (`period.closed`,
   `period.year_closed`) — called here in a dry run so nothing is written yet.
4. type `Problems`; `DimensionJudge.Problems(company, intent, before: null)` (SP4.1) → 422 `doc.incomplete`
   (code `dimension.rule` on the missing item) — all BEFORE the number.
5. snapshots: party (from the master now), seller (`sellerSnapshot`), issue look (§4.9), policy (if none frozen yet).
6. number: `SeriesAllocator.Allocate(company, type, documentDate)` (§4.5).
7. posting: `Kernel.Post(Posting(doc), Original, Strict)`; the returned `AccountBySourceLine` is stamped by the type
   (SP4.4 `postedAccount`).
8. links (settles / groups / adjusts by the type), targets recomputed.
9. revision row 0 (snapshot = the document as now stored, look included), activity `issue` (+ `submit` / `approve` for
   approve-and-issue), audit `doc.issue` `{status → issued, number}`; `issuedAt` = now; `issuedBy` = the actor (stored,
   not on the wire — SP4.10's per-month agent cap sums it).

A refusal at any step writes nothing (no number, link, journal, revision, activity or audit row) — the transaction
rolls back; the idempotency claim of a create is separate (issue has none).

### 4.4 Correction classes and the correction plan (§7.3, §7.11)

- `POST …/correction-plan` with the proposed body (omitted bank account / dimensions = unchanged, D-F4) builds the plan
  from the CURRENT state and stores it (`correction_plans`, single use): unchanged body → 0 steps
  ("ไม่มีการเปลี่ยนแปลง"); N / L, or T without a fiscal change → one `revise` step (permission `doc.<T>.correct`),
  after every refusal the revise would raise (party lock, non-positive, below settled, the type's problems, approval
  above the approved amount without the approve right → 422 `approval.required_on_revise`, dimension judge with
  `before` = the live document); T with a fiscal change → the type's `PlanSteps` (SP4.3: cancel receipts → reissue →
  reissue receipts → CN / DN). `planId` = stable hash of `(docId, proposed, rights)`; `planHash` = hash of
  `(steps, document version)`; `missingPermissions` lists what the caller lacks.
- `POST /corrections {planId, planHash}`: rebuild the plan (a rebuild that throws → 409 `correction.plan_stale`, except
  a reconciliation refusal which passes through — mock M7); hash or steps differ → 409 `correction.plan_stale`; any step
  permission missing → 403 naming it; 0 steps → 422 `correction.empty_plan`; run every step in ONE transaction (D-F6);
  delete the plan; answer `CorrectionResult.affected`.
- The plan's revise step runs with reason "แก้ไขตามแผนการแก้ไข" and, when the runner holds `doc.<T>.approve`, approves
  the raise in the same command (C1).
- **What a revise may not do** (refusal order = mock `revise`): not live → 409 `doc.not_revisable`; version; closed
  year (`period.year_closed`); T + fiscal → 422 `doc.revise_not_allowed`; L + blocking lock (any lock but settlement /
  period) → 409 `doc.locked`; `Missing`; a moved date → `Strict` placement + future-date guard; party change while a
  `settles` / `groups` / `adjusts` link points at it → 422 `doc.party_locked`; non-positive total; below settled;
  type problems; a converted line below its converted quantity → 422 `doc.below_converted`; derived-lock refusals of
  later modules; approval above the approved amount.

### 4.5 Numbering series (§5.14; ST3 / ST3a / ST3b rulings)

- **Config** per company × type: `prefix` (`^[A-Za-z0-9-]{1,10}$`), `scope` monthly | yearly, `branch?`
  (`^[A-Za-z0-9]{1,6}$`, a format value only), `format` (tokens `{PREFIX}` `{BRANCH}` `{YYYY}` `{YY}` `{MM}` `{#…#}`
  3–8; constant text `[A-Za-z0-9\-/_.]`; exactly one counter; one year token; monthly needs `{MM}` + a year; yearly a
  year and no `{MM}`; `{BRANCH}` only with a branch). Absent config = `{PREFIX}-{YYYY}{MM}-{####}`, monthly, prefix = the
  type code. OB is numbered but not configurable (not listed); a type the company cannot issue is not listed.
- **Series key** = `(company, type, branch_code, period)`; `branch_code` is `00000` in SP4.2 for every number (D-03-2
  stays a later setting); `period` = `YYYY-MM` (monthly) or `YYYY` (yearly) of the document date at issue.
- **Format frozen per key**: the first allocation of a key stores the resolved template on the key's counter row; every
  later number of that key uses it; a key with no stored template reads as `TYPE-{YYYY}{MM}-{####}` (the seed's).
  A config change therefore applies from the first period with no numbers: the save answers its row plus `notice`
  `numbering.in_use` naming the period it takes effect.
- **One scope per year**: if the date's year already has numbers in one scope (any monthly key of the year, or the
  yearly key), every date of that year keeps it; a new key in a kept-scope year takes the format of that year's latest
  key; a switch starts in the first year without numbers.
- **One parser** (`NumberTemplate.Parse`, Domain): candidate templates = the legacy one + every template stored on a key of
  that company × type; a number parses to a key iff exactly ONE (template, key) matches and that key's stored template is
  the matching one; else it is the number of no series ("malformed"). Allocation, the numbering invariant and the
  gap report (SP4.8) all use it.
- **Allocate** (inside issue / reissue / reversal, D-F2): lock the key's counter row (`INSERT … ON CONFLICT DO NOTHING`,
  then `SELECT … FOR UPDATE`); next = counter + 1 formatted by the key's template; refuse 409
  `numbering.allocation_ambiguous` unless the new number parses back to exactly its own key and sequence AND storing a
  new key's template leaves every existing number of the type parsing as before; refuse 409
  `numbering.allocation_collision` if another document of the type holds the number; then store the template (first
  number) and the counter. Exit for both: "แก้รูปแบบเลขที่ในหน้าตั้งค่าเลขที่เอกสาร".
- **Save / preview** (`settings.manage`, agent refused): validate → the first number the config would give (today's period
  if it has no numbers, else the next period; the switch year rule) → 422 `numbering.ambiguous` if it would not parse
  back to its own key → (save only) 422 `numbering.collision` if a document holds it → store, `version + 1`, audit
  `numbering.update` before / after.
- A revise keeps its number across months (Ham 2026-10-18); a reissue takes a new number in the NEW document's period;
  cancelled / replaced numbers stay and are never reused.

### 4.6 Approval policy (§7.6; ST3 rulings, P-06)

- Rule per company × type: `enabled`, `minAmount?` (approval only ABOVE it; one threshold per type, Q-M7),
  `selfApproval` (set company-wide: one save rewrites every rule's flag and gives all one version). Rows exist per
  approvable type (Q-D2 decides which types get a row at company creation).
- **Needs approval now** (`approvalRequired`) = live rule enabled and `ApprovalAmount > minAmount` (or no min).
  A draft is judged by the live rule; a submitted / pending / approved / issued document by its frozen `policy`
  snapshot `{enabled, minAmount?, selfApproval}` (frozen at submit, and at issue if none; dropped on send back).
- **Issue gate**: pending → 409 `approval.pending`; a draft that needs approval → 422 `approval.required` (exits:
  submit, or approve-and-issue with the right).
- **Self-approval off** (P-06, stricter than §7.6): the creator, `moneyBy` (the last person who changed the money) and
  the submitter cannot approve → 403 `approval.self_not_allowed`. `moneyBy` moves only on a real money change.
- **Revise above the approved amount** (C1): needed when the new amount is above both the old amount and what was
  approved (0 when nothing was) and the STRICTER of the frozen and the live policy wants approval at that figure, or —
  for an approved document — when its allocation targets change at all; the revise then needs an approver in the same
  command (the self-approval check uses the LIVE setting; the approval and the policy snapshot are re-stamped) else 422
  `approval.required_on_revise`. A reissue is an issue path: a new total that needs approval → 422 `approval.required`.
- **Settlement tolerance** (`{rounding, smallWriteOff}` ≥ 0, 2 dp, versioned, `settings.manage`) is stored and served
  here (`/settings/approvals`); SP4.5 freezes it on each settlement.

### 4.7 Conversions, chain, marks, locks (§7.7, §7.11)

- `convert(source, target, lines[])`: source live; QT rejected → 409 `qt.rejected` (SP4.3's mark, engine check);
  closed remainder → 409 `doc.closed`; pair not in `CONVERSIONS` / a settle-type target (RC, PV) / unavailable type →
  422 `doc.conversion_not_allowed` / `doc.type_not_available`; needs `doc.<target>.create`; per source line qty > 0
  (`doc.invalid_qty`) and ≤ remaining (`doc.over_conversion`, naming the line and what is left). Creates the target
  DRAFT (lines copied with `sourceLineId`, party, price basis, reference = source number, date = business date) and
  ONE active `converted_from` link (`qty` = Σ). A QT converted gets its `accepted` mark (activity `accept`, audit
  `doc.mark`). BL / EX → PV special cases are SP4.3 / SP4.4 hooks.
- **Remaining** = source qty − Σ quantities on lines of ACTIVE conversions (drafts included — they reserve), by
  `sourceLineId`; `closed` → remaining 0. **Progress** (derived on every read, never stored) counts only LIVE targets
  (mock `progressOf`).
- **Marks** (per type: QT accepted / rejected (reason), DO delivered, PO sent): live only (`doc.not_live`), not allowed
  (`mark.not_allowed`), already set (`mark.already_set`), reason (`mark.reason_required`); no revision, no totals change;
  version + 1; activity + audit `doc.mark`. An N-class revision voids accepted / rejected on a QT, `sent` on a PO, and
  reopens a closed remainder.
- **Close remainder** (SO / DO / PO): live, reason, not already closed (`doc.already_closed`), something remaining
  (`doc.nothing_remaining`); a draft target that reserved quantity before still issues.
- **Chain** = every document connected by links, both directions, inactive edges kept and flagged; settlement records /
  payroll payments appear as nodes `STL` / `PRP` (SP4.5 / SP4.7 node providers).
- **Locks** are derived at read (`ILockProvider` registry: period (SP4.1 state), reconciliation SP4.5, settlement SP4.5,
  JV finality D7, schedule SP4.6, asset SP4.6, filing SP4.8, payroll SP4.7, OB SP4.11) and never stored, except the
  settlement / filing locks the mock stores (they move to derived when their module lands). A period lock never blocks a
  correction or a cancel; `blockingLocks` = every lock except `settlement` and `period`.
- **Outstanding** (types with `Outstanding`) = total − Σ active credit adjustments + Σ debit adjustments − Σ active
  settlements; status `settled` ⇔ an active settlement exists and outstanding ≤ 0; `partly_settled` ⇔ something paid;
  negative outstanding is shown, never clamped. Recomputed in the same transaction as any link change.

### 4.8 Activity, revisions, audit, print log (§7.12)

- **Activity** (append-only): `{id, at, actor, action, detail?, reportId?}` written in the command transaction; actions
  as the mock (`create`, `update`, `delete`, `submit`, `approve`, `send_back`, `issue`, `revise`, `reissue`, `cancel`,
  `convert`, `accept`, `reject`, `deliver`, `send`, `close`, `reverse`, `แนบไฟล์`, `ลบไฟล์แนบ`, `พิมพ์ต้นฉบับ`,
  `พิมพ์สำเนา`, `พิมพ์เอกสารที่ยกเลิกแล้ว`). Activity of a deleted draft stays (no foreign key on `doc_id`).
- **Revisions** (append-only): one row per issued revision `{revision, at, actor, reason?, snapshot (the full Doc as
  stored, look included), diff}`; diff = changed leaves as `header.<k>`, `lines.<id>.<k>` (a line added / removed:
  `lines.<id>` with its description), `allocations.<target>.<k>`; engine-set fields (`postedAccount`, `vatOverride`,
  `targetNumber`) never appear.
- **Audit**: every command writes one `ok` row (SP3 §4.7) — commands of §5.3 column "Audit". Hardening vs the mock: an
  attachment added or removed is audited on every status (the mock audits only a removal from an issued document);
  `printed` is audited `doc.print`.
- **Print log** (`doc_prints`): `POST …/printed {copy, employee?}` on an issued / cancelled / replaced document (draft /
  pending / approved → 409 `doc.not_printable`) takes the row lock (D-F14); the first print of a live document is the
  original, every later one — and every print of a cancelled / replaced one — a copy, whatever was asked; answers `{copy,
  printCount}`. The slot `paper jsonb` stores the paper at the first print when a type asks for it (SP4.4 WT, I7).
  `printCount` on a read is derived from the log.

### 4.9 Snapshots at issue and the paper (I3; ST1 / ST4 rulings, B-3)

- **Seller** = `PaperParty` of the company now (`legalNameTh`, `legalNameEn`, `address`, `phone`, `taxId`, branch label
  "สำนักงานใหญ่ (00000)" / "สาขา nnnnn").
- **Issue look** = `{logo?, stamp?}` = the company's SP3 image file ids now; `signature?` = the issuing member's signature
  file id; `issuerName` = the member's name (else the actor's), `issuerPosition?`. An agent or the system actor has no
  signature (by construction). Only printable types get seller + look.
- Taken at issue, reissue (the new document) and every N / L revise, in that command, BEFORE the revision row (B-3).
  For a T-class document the in-place non-fiscal revise keeps the issue-time seller, look AND party snapshot (Q-D3 — the
  mock re-takes all three at a revise, `stampIssue` and `revise … party: partyOf(…)`; I3 freezes supplier and buyer at
  issue; the D1 trigger enforces it).
- **Paper** (`GET …/paper?copy=1`): built ONLY from stored values (lines, totals, party snapshot, seller snapshot,
  look); issued only (else 409 `doc.not_printable`; no builder / not printable → 404 `doc.paper_not_available`);
  `copyLabel`; N-class `revisionLabel`; `replacementNote` on a replacement; `voidMark` on cancelled / replaced; then the
  print template (display options read at print time; never changes a frozen figure): logo / stamp / signature on or off,
  signature labels (1–4 from the fixed list, unique), the signature only on the type's issuer line, the stamp on
  "ผู้มีอำนาจลงนาม" else the issuer line else beside the block; image file ids resolved to data URLs (a missing file shows
  nothing, never a broken image). A draft's paper (template preview only) shows the live logo, no signature, no stamp.
- **Template preview** builds the type's real paper from a sample document in a discarded state (writes nothing).

### 4.10 Attachments, notes, public links

- **Attachments**: upload body `{category, name, mime, dataUrl}` (categories = the 11 of D-30 [O-6 open]); decoded bytes
  ≤ 1 MB, MIME by magic bytes ∈ pdf / png / jpeg / webp and equal to the declared one (`attachment.type_not_allowed`,
  `attachment.too_large`, `attachment.category_invalid`, `attachment.name_required`); stored through SP3 `IFileStore`;
  a draft's attachments follow it into issue (same ids) and go with a deleted draft. Responses carry `contentUrl` instead
  of the bytes (§5.1 delta); `GET …/attachments/{attId}/content` streams the file with its stored MIME,
  `Content-Disposition: attachment; filename*=UTF-8''…`, `X-Content-Type-Options: nosniff`.
- **Notes** = `header.notes` (printed). Editable on a draft; after issue a non-fiscal field for every class (T: in-place
  revise). The per-type default note (SP3 route 19) is filled by the editor on a NEW blank document only (a copy or a
  conversion keeps the source's) — no server rule.
- **Public links** (SP3 S13 verbatim): only types QT SO DO IV TI BL RC CN DN PO WT, only a live document
  (`public.not_shareable` 422, `public.not_issued` 409); token 160-bit random, stored as SHA-256; create / count /
  revoke-all need `doc.<T>.read` of THAT type; agents refused; `GET /public/p/{token}` is sessionless, rate-limited per IP,
  and answers ONE identical 404 `public.link_invalid` for unknown, revoked and no-longer-live; the page is the
  document's paper as a copy built for the document's own company, nothing else of the company. Audit
  `public_link.create` / `public_link.revoke` (never the token).

### 4.11 The JV — first descriptor (AC1 rulings)

- Descriptor: `JV`, class L, VAT both, ledger, not outstanding, printable, `partyKind null`, `lineEditor account`, header
  fields `documentDate`, `reference`, `autoReverse`, `notes` (+ header `dimensions`), no conversions, `AgentDefault` Off
  (always Off — ADR-0005), approval possible (`doc.JV.approve`).
- **Lines**: a used line (account or an amount) has an account and exactly ONE side > 0; ≥ 2 used lines; 2-dp
  non-negative money; Σ debit = Σ credit else `doc.incomplete` "ยอดเดบิตและเครดิตไม่เท่ากัน (ต่าง x.xx)". `compute`
  returns `balance {debit, credit, diff}` (the grid never sums) and `totals.total` = Σ debit.
- **Accounts**: postable, active, of the company (`ledger.account_invalid`); not controlled for scope `jv`
  (`ledger.control_account`, the owner text) — checked at compute, issue, revise and in the kernel (`ManualScope.Jv`);
  a line party must be a party of the company (`ledger.party_invalid`).
- **Posting**: the lines verbatim as `AccountLine`s, rule "ใบสำคัญทั่วไป" or "ใบสำคัญทั่วไป: <description>", the
  header's dimensions as the lines' default (a line's own value wins).
- **Reverse** (`POST /docs/JV/{id}/reverse {date?, reason?}`, `doc.JV.issue`): only a JV (`ledger.reverse_document` with
  the exit "ยกเลิกหรือแก้ไขเอกสาร <number>"), live (`doc.not_reversible`), not an auto-reversal, not already reversed
  (`ledger.already_reversed`), no finality hook refusing (SP4.6 schedule runs), not in a closed year; date default =
  `max(original date, FirstOpenDate)`, an earlier one → 422 `ledger.reverse_date`, future → `doc.future_date`, closed →
  `period.closed`. Writes a NEW issued JV: number at its date, lines mirrored (description "กลับรายการ: …"), header
  `reversalOf`, reference "กลับรายการ <number>", notes = reason, one active `adjusts` link to the original, revision 0,
  activity on both, audit `doc.reverse`.
- **Auto-reversing accrual**: issuing with `autoReverse` also writes, in the same command, the system's reversing JV
  dated day 1 of the next month (the only future-dated entry; refused up front with 422 `ledger.auto_reverse_closed` if
  that month is closed); revise / cancel of the accrual keeps it in step (turned off or cancelled → the auto-reversal is
  cancelled with `Original` date; date or lines changed → it is revised in place: reverse + repost, revision + 1, actor
  system). Audit `doc.auto_reverse`.
- **Finality**: a reversal JV cannot be revised or cancelled (`ledger.reversal_final`; a person's reversal can itself be
  reversed once); a JV a person reversed is final (`ledger.reversed_final`); the auto-reversal is edited only through its
  accrual. These read as the JV lock (`kind: 'reversal'`) with their exits; a JV lock hides the period lock banner.
- **Paper**: ใบสำคัญทั่วไป / JOURNAL VOUCHER, the account lines as posted, the server's two totals, "กลับรายการอัตโนมัติ
  วันที่ …" in the notes for an accrual; signatures ผู้จัดทำ / ผู้ตรวจ / ผู้อนุมัติ, issuer line ผู้จัดทำ.
- **System actor**: on the wire `{kind: 'user', id: 'system', name: 'ระบบ (กลับรายการอัตโนมัติ)'}` (the mock's); in
  `audit_log.actor_kind` the value `system` (D1 widens SP3's check if P4 constrained it).

### 4.12 Masters (01-master-data, FN1 rulings)

- **Record routes** (`/records/{kind}`, kind ∈ customer | vendor | item | bank-account): order 404 kind / not available
  → 403 → (PUT) 404 → 409 version → 422 `record.invalid` with `fieldErrors`; only the named fields of a typed body are
  read; create is idempotent (D-F8); every write audited `record.<kind>.<create|update|activate|deactivate>` with
  before / after rows; deactivating a used record is allowed (old documents keep their snapshot; it is no longer offered);
  `already in that state` → no write, no audit.
- **Customer / vendor**: mock `mocks/records/parties.ts` rules verbatim: `entityKind` required; `code` required, unique per
  kind in the company, read-only once a document names the party; `name` required; `taxId` checksum (13 digits) and
  required when VAT-registered or juristic; `branchCode` 5 digits with a taxId (default 00000); `address` required when
  VAT-registered; `paymentTermDays` integer ≥ 0; `partyGroup` ∈ the four; `defaultWhtTypeCode` must exist (SP4.4 table;
  until SP4.4 the mock list `[SP-R]`); vendor adds `vatDRegistered` (only when foreign), remittance bank fields,
  `usualItemIds` (items of the company).
- **Item**: mock `mocks/records/items.ts` verbatim (kind, code unique + locked once used, name, unit, price ≥ 0 2 dp,
  tax code S7 / Z0 / EX — stored EX for a non-VAT company, WHT type only for a service, expense category only with
  purchase usage and from SP4.1's categories, ≥ 1 usage). `/items?usage=` sales | purchase (else 422
  `items.invalid_usage`); inactive items never offered.
- **Bank / cash account**: mock `mocks/records/bank-accounts.ts` verbatim: kind bank | cash; bank needs a bank from the
  list and an account number of 10–15 digits (dashes allowed), unique; the GL account must be postable, active, class
  current-asset, sub-class `bank` / `cash` matching the kind, bound to no other bank account, claimed by no other rule or
  posted line (`glClaim`), and unchangeable once it holds postings; create / update writes the bank's keyed `Cash` rule
  through SP4.1 (`PostingRules.BindBank(bankId, accountCode)`), which runs `RoleProblem(Cash)` — closing the 09-settings
  open gap (a bank could be created on 1130). The `default` flag is server-owned; the default bank account cannot be
  deactivated (`record.in_use`). SP4.2 registers the `IAccountClaim` "bound to a bank account" (SP4.1 §4.8).
- **Search** (`/search?q`): documents whose number starts with `q` (readable types, max 5), parties by name (with
  `party.read`, max 5), pages from a fixed list linked through the registry (a hit with no href is shown disabled).

### 4.13 Agent rules (SP3 §4.6 as they apply here; ADR-0005; Ham Q-M4)

- Agent-mapped routes (`agent: true`): every GET of §5.3 except the public-link ones and settings GETs whose permission
  is AgentForbidden; `POST /docs/{type}`, `POST /docs/{type}/compute`, `PUT` / `DELETE /docs/{type}/{id}` (own drafts),
  `POST /docs/{type}/{id}/issue` (through the review gate). Every other write → 403 `agent.forbidden_action`
  (`/settings/*` → `agent.forbidden_setting`) before the body is read.
- Engine checks (defence): create refused when `IAgentPolicy.ModeOf(company, type)` is Off (JV, PR, OB, FA, DP, WT are
  always Off — so in SP4.2 no agent can create any document); update / delete only a draft the agent created
  (`agent.forbidden_action`); approve, cancel, revise, reissue, correction plans, reverse, marks, conversions — never
  (`refuseAgentAction`); issue only through `IAgentIssueGate` — SP4.2's default refuses every agent issue with 409
  `agent.review_required`; SP4.10 replaces it with the review report check (same version, unexpired, route auto, no error,
  policy NOW auto, total ≤ the per-document cap AND the running per-month total per type ≤ the monthly cap — Q-M4;
  the monthly sum reads `documents.issued_by` of live documents of the type in the month).
- Masters are read-only for agents.

### 4.14 Database (SP3 §4.2 conventions)

| Table | Scope | Key columns |
|---|---|---|
| `parties` (SP4.1 core + D1 columns) | tenant | + `entity_kind`, `name_en`, `tax_id`, `branch_code`, `vat_registered`, `address`, `phone`, `email`, `payment_term_days`, `default_wht_type_code`, `notes`, `vat_d_registered`, `bank_name`, `bank_account_no`, `bank_account_name`, `usual_item_ids uuid[]`; later `linked_party_id` (SP4.5), `payroll jsonb` (SP4.7) |
| `items` | tenant | `company_id`, `id`, `code` (`UNIQUE (company_id, code)`), `kind`, `name`, `unit`, `unit_price`, `tax_code`, `wht_type_code`, `usage_sales`, `usage_purchase`, `expense_category`, `active`, `version` |
| `bank_accounts` | tenant | `company_id`, `id`, `kind`, `bank_name`, `name_th`, `account_no`, `account_id` (→ `accounts`, `UNIQUE (company_id, account_id)`), `is_default`, `active`, `version`; later `reconciled_to`, `go_live`, `go_live_by` (SP4.5 / SP4.11) |
| `numbering_configs` | tenant | `(company_id, doc_type) PK`, `prefix`, `scope`, `branch`, `format`, `version` |
| `series_counters` | tenant | `(company_id, doc_type, branch_code, period) PK`, `counter int`, `template text` (frozen at the first number) |
| `approval_rules` | tenant | `(company_id, doc_type) PK`, `enabled`, `min_amount NULL`, `self_approval`, `version` |
| `settlement_tolerance` | tenant | `company_id PK`, `rounding`, `small_write_off`, `version` |
| `print_templates` | tenant | `(company_id, doc_type) PK`, `show_logo`, `show_stamp`, `show_signature`, `signature_labels text[] NULL`, `version` |
| `documents` | tenant | `company_id`, `id`, `type`, `number NULL`, `status`, `correction_class`, `revision`, `version`; query columns written by the engine: `document_date`, `due_date`, `party_id`, `total numeric(18,2)`, `outstanding NULL`, `created_by_kind`; bodies: `header jsonb`, `lines jsonb`, `totals jsonb`, `party jsonb` (snapshot), `seller_snapshot jsonb`, `issue_look jsonb`, `policy jsonb`, `approval jsonb`, `money_by jsonb`, `created_by jsonb`, `issued_at`, `issued_by jsonb`, `cancel jsonb`, `replaced_by_id`, `replaces_id`, `marks jsonb`, `stored_locks jsonb`, `ext jsonb` (type extension fields, §5.2); `UNIQUE (company_id, type, number) WHERE number IS NOT NULL AND header->>'obBatchId' IS NULL` (an opening-balance item carries its OLD document's number, which may repeat — SP4.11; the numbering invariant skips them too) |
| `doc_links` | tenant | `company_id`, `id`, `from_id` (a document, or a settlement record / payroll payment — no FK), `to_id` (FK documents), `kind`, `amount NULL`, `qty NULL`, `wht NULL`, `active`, `created_at`, `deactivated_at NULL` |
| `doc_revisions` | tenant, append-only | `company_id`, `doc_id`, `revision` (PK with doc), `at`, `actor jsonb`, `reason NULL`, `snapshot jsonb`, `diff jsonb` |
| `doc_activity` | tenant, append-only | `company_id`, `id`, `doc_id` (no FK), `at`, `actor jsonb`, `action`, `detail NULL`, `report_id NULL` |
| `doc_prints` | tenant, append-only | `company_id`, `id`, `doc_id`, `at`, `by`, `copy`, `employee NULL`, `paper jsonb NULL` |
| `doc_attachments` | tenant | `company_id`, `id`, `doc_id`, `file_id` (SP3 `files`), `category`, `name`, `size_bytes`, `mime`, `at`, `by` |
| `correction_plans` | tenant | `company_id`, `plan_id` (PK with company), `doc_id`, `proposed jsonb`, `rights text[]`, `plan jsonb`, `created_by jsonb`, `created_at` (deleted on successful execute) |
| `public_links` | tenant | `company_id`, `id`, `doc_id`, `token_hash bytea UNIQUE`, `created_at`, `created_by`, `revoked_at NULL` |

Triggers (D1): `documents` — `number` is set once (NULL → value) and never changed; `type`, `company_id`,
`correction_class` never change; status transitions limited to the lifecycle graph (`teas.doc_status_guard`); for a
T-class document whose OLD status is live: `number`, `document_date`, `party_id`, `lines`, `totals`, `party`,
`seller_snapshot`, `issue_look` never change, and `header` may change only in the keys `notes`, `reference`, `dueDate`
(+ keys a later type adds to its allow-list, ADR per type) — I5 at the database. `doc_links`: UPDATE only `active` true →
false with `deactivated_at`. `doc_revisions`, `doc_activity`, `doc_prints`: the SP3 append-only treatment.

### 4.15 Runtime security context (SP3 §4.3 extended)

| Process | DB role | GUCs | Reads | Writes | How each satisfies RLS |
|---|---|---|---|---|---|
| Company creation (`CompanyFactory`, after SP4.1's initializer) → `DocumentsCompanyInitializer` | `teas_app` | `Enter(newCompanyId, adminUserId)` (set before the `companies` insert) | — | `approval_rules` (per Q-D2), `settlement_tolerance` (0.00 / 0.00) | `company_id` = GUC; a test asserts the rows after `Create` |
| API request (session or agent key) | `teas_app` | session / key company | tenant tables | as the command | standard |
| `GET /public/p/{token}` (sessionless) | `teas_app` | `EnterSystem("public-link")` for the hash lookup only, then `Enter(link.company_id, null)` | `public_links` by `token_hash`; then the document, its company row, files | none (rate limit is in memory) | system scope reads one row; everything else inside the link's company. The architecture allow-list of `EnterSystem` call sites (SP3 §4.3) gains `Documents/PublicLinks` |
| Migrator verb `seed-documents --all-missing` (only for a company created before SP4.2 deployed) | `teas_migrator` | `ForEachCompany` | `approval_rules` count | the initializer's rows if 0 | per-company GUC, asserts counts |

## 5. Frozen contract — `frontend/src/contract/documents.ts` (CONTRACT_VERSION `1.0`)

### 5.1 Core types

Imported from `platform.ts`: `Money`, `IsoDate`, `Actor`, `Page`, `ApiProblem` (and `Qty` if SP3 P0 placed it there —
else D0 defines `Qty` here). Imported from `ledger.ts`: `JournalPreview`, `RecordActiveBody`.

Moved verbatim (the old modules re-export): `DocType`, `CorrectionClass`, `DocStatus`, `TaxCode`, `Lock`, `MarkKey`,
`DocMarks`, `RemainingLine`, `LinkKind`, `ChainNode`, `ChainEdge`, `ChainGraph`, `ActivityEntry`, `FieldChange`,
`Revision`, `AttachmentCategory`, `DocSummary`, `PartySummary`, `ItemSummary`, `SearchHit`, `PaperParty`, `PrintTemplate`,
`ApprovalPolicy`, `CorrectionStep`, `CorrectionPlan`, `CorrectionResult`, `OpenItem`, `MissingItem` (`domain/types.ts`);
`LIVE`, `VatScope`, `DocTypeInfo`, `DOC_TYPES`, `carriesBalance`, `CLASS`, `isTypeAvailable`, `CONVERSIONS`, `SETTLES`,
`GROUPS`, `MARKS`, `convertTargets`, `CLOSEABLE`, `ADJUSTS`, `CREDIT_NOTES` (`domain/doc-types.ts`); `LineEditorKind`,
`ListColumnKey`, `SavedViewKey`, `HeaderFieldKey`, `DocDescriptor`, `routesOf` (`domain/descriptors.ts`);
`DocInput`, `ListDocsParams`, `BankGlAccount` (`lib/api/endpoints.ts`); `NumberingScope`, `NumberingRow`,
`NumberingBody`, `NumberingPreview`, `ApprovalRuleRow`, `ApprovalsView` (`records/tax-numbering-approvals.ts`;
`taxApi` stays for SP4.8); `PublicLink` wire shapes of `records/auth.ts` (`{active}`, `{token}`, `{revoked}`,
`{type, paper}`). `REASON_CODES` stays in `domain/doc-types.ts` (`[SP-R]`, SP4.3 / SP4.4 freeze it).

`Doc`, `DocHeader`, `DocLine`, `DocTotals`, `ComputeResult`, `PaperModel`, `IssueLook`, `Attachment` are frozen as
CORE + named extension fields (§5.2): the core is written below; the extension fields stay in the type (optional,
documented with their owner) so no import changes ripple — each owner freezes its fields' meaning with its module.

```ts
export interface DocHeader { partyId?: string; documentDate: IsoDate; dueDate?: IsoDate; reference?: string; notes?: string;
  dimensions?: Record<string, string>; priceIncludesVat?: boolean;
  /** JV (SP4.2) */ autoReverse?: boolean; /** server-owned */ reversalOf?: string; /** server-owned */ autoReversal?: true;
  /* + extension fields, §5.2 */ }
export interface DocLine { id: string; itemId?: string; description: string; qty: Qty; unit: string; unitPrice: Money; discountPct?: string;
  taxCode: TaxCode; dimensions?: Record<string, string>; sourceLineId?: string;
  /** JV (SP4.2) */ accountCode?: string; debit?: Money; credit?: Money; partyId?: string; /* + extension fields, §5.2 */ }
export interface DocTotals { gross: Money; discount: Money; net: Money; vat: Money; total: Money; amountInWords: string; /* + wht?, cash? (§5.2) */ }
export interface Doc { id: string; type: DocType; number?: string; status: DocStatus; correctionClass: CorrectionClass; revision: number; version: number;
  header: DocHeader; party?: PartySummary /** @frozen issue — snapshot */; lines: DocLine[]; totals: DocTotals; outstanding?: Money /** server-owned */;
  locks: Lock[] /** derived at read */; createdBy: Actor; issuedAt?: string; cancel?: { reasonCode: string; reasonText: string; at: string };
  replacedById?: string; replacesId?: string; marks?: DocMarks; progress?: string /** derived */; printCount?: number /** derived */;
  approval?: { submittedBy: Actor; submittedAt: string; approvedBy?: Actor; approvedAt?: string; amount?: Money /** @frozen approve */ };
  moneyBy?: Actor; approvalRequired?: boolean /** derived */;
  sellerSnapshot?: PaperParty /** @frozen issue */; issueLook?: IssueLook /** @frozen issue */; /* + extension fields, §5.2 */ }
/** ST4 (I3), DELTA: `logo` / `stamp` / `signature` are opaque SP3 file ids (the mock keeps its image hashes) */
export interface IssueLook { logo?: string; stamp?: string; signature?: string; issuerName?: string; issuerPosition?: string }
/** DELTA (master plan §2.7): no bytes in responses; `contentUrl` streams the file */
export interface Attachment { id: string; docId: string; category: AttachmentCategory; name: string; size: number; mime: string; contentUrl: string; at: string; by: string }
export interface AttachmentBody { category: AttachmentCategory; name: string; mime: string; dataUrl: string }   // ≤ 1 MB decoded
export interface ComputeResult { lines: { id: string; net: Money; vat: Money; total: Money }[]; totals: DocTotals; missing: MissingItem[];
  journal?: JournalPreview /** omitted without ledger.read */; approvalRequired?: boolean;
  /** JV / OB (SP4.2) */ balance?: { debit: Money; credit: Money; diff: Money }; /* + whtLines, opening, allocation, payroll (§5.2) */ }
// PaperModel: core = titleTh, titleEn, copyLabel, number, documentDate, dueDate?, reference?, dueLabel?, revisionLabel?, seller, buyer,
// lines, totals, notes?, partyLabel?, replacementNote?, voidMark?, signatures, images?, issuer?, journal? (JV, SP4.2); extension §5.2.

// RecordRow typed per kind (master plan §2.7). TYPE ALIASES (assignable to the kit's RecordRow index signature).
export type CustomerRow = { id: string; version: number; active: boolean; inUse: boolean; entityKind: 'individual' | 'juristic' | 'foreign';
  code: string; name: string; nameEn?: string; taxId?: string; branchCode?: string; vatRegistered: boolean; address?: string; phone?: string;
  email?: string; paymentTermDays: number; partyGroup?: string; defaultWhtTypeCode?: string; notes?: string };
export type VendorRow = CustomerRow & { vatDRegistered: boolean; bankName?: string; bankAccountNo?: string; bankAccountName?: string; usualItemIds: string[] };
export type ItemRow = { id: string; version: number; active: boolean; inUse: boolean; kind: 'good' | 'service'; code: string; name: string; unit: string;
  unitPrice: Money; taxCode: TaxCode; whtTypeCode?: string; usage: 'sales' | 'purchase' | 'both'; usageSales: boolean; usagePurchase: boolean; expenseCategory?: string };
export type BankAccountRow = { id: string; version: number; active: boolean; inUse: boolean; code: string; name: string; kind: 'bank' | 'cash';
  accountName: string; accountCode: string; default: boolean; bankName?: string; accountNo?: string };
export interface CustomerBody { entityKind: CustomerRow['entityKind']; code: string; name: string; nameEn?: string; taxId?: string; branchCode?: string;
  vatRegistered?: boolean; address?: string; phone?: string; email?: string; paymentTermDays?: number; partyGroup?: string; defaultWhtTypeCode?: string; notes?: string }
export interface VendorBody extends CustomerBody { vatDRegistered?: boolean; bankName?: string; bankAccountNo?: string; bankAccountName?: string; usualItemIds?: string[] }
export interface ItemBody { kind: ItemRow['kind']; code: string; name: string; unit: string; unitPrice?: Money; taxCode?: TaxCode; whtTypeCode?: string;
  usageSales?: boolean; usagePurchase?: boolean; expenseCategory?: string }
export interface BankAccountBody { kind: 'bank' | 'cash'; bankName?: string; accountNo?: string; accountName: string; accountCode: string }
export type Versioned<T> = T & { version: number };
export interface ApprovalRuleBody { enabled: boolean; minAmount?: Money; version: number }
export interface SelfApprovalBody { selfApproval: boolean; version: number }
export interface ToleranceBody { rounding: Money; smallWriteOff: Money; version: number }
export interface TemplateRow { type: DocType; showLogo: boolean; showStamp: boolean; showSignature: boolean; signatureLabels: string[]; issuerLine?: string; version: number }
export interface TemplatesView { items: TemplateRow[]; labels: string[] }
export interface TemplateBody { showLogo: boolean; showStamp: boolean; showSignature: boolean; signatureLabels?: string[]; version: number }
export interface CancelBody { version: number; reasonCode: string; reasonText: string }
export interface VersionBody { version: number }
export interface SendBackBody { version: number; reason: string }
export interface ConvertBody { targetType: DocType; lines: { sourceLineId: string; qty: Qty }[] }
export interface MarkBody { mark: MarkKey; version: number; reason?: string }
export interface CloseRemainderBody { version: number; reason: string }
export interface ExecuteCorrectionBody { planId: string; planHash: string }
export interface ReverseBody { date?: IsoDate; reason?: string }
export interface PrintedBody { copy: boolean; employee?: string }
```
`RecordKind` (`domain/records.ts`) is NOT narrowed — it also keys `RECORDS`, `RECORD_IMPLS` and the metadata of kinds
without routes yet (employee, schedule, dimension …). The contract adds `export type WireRecordKind = 'customer' |
'vendor' | 'item' | 'bank-account' | 'account'` for `ROUTES` and the typed `endpoints` overloads. `RecordRow` stays the
kit's generic row.

### 5.2 Extension fields — present in the types, frozen by their owner

| Field | On | Owner |
|---|---|---|
| `allocations`, `Allocation` | Doc | SP4.5 (RC / PV), SP4.3 (BL groups) |
| `whtFrozen`, `WhtFrozen`, `WhtLine`; `totals.wht`; `whtLines` (compute, paper); `certificate` (paper) | Doc / ComputeResult / PaperModel | SP4.4 |
| `totals.cash`; `payment` (paper); header `bankAccountId`, `paymentMethod`, `bankSnapshot` (@frozen issue), `cheque`, `depositAmount`; `allocation` (compute) | | SP4.5 |
| `adjustSnapshot` (@frozen issue); header `refDocId`, `reasonCode`, `reasonText`; line `vatOverride`; `adjusts`, `vatLines` (paper); `CorrectionNote` | | SP4.3 (CN / DN), SP4.4 (PCN / PDN) |
| header `vendorDocNumber`, `vendorDocDate`, `claimPeriod`, `inputVatForfeited`, `vendorVatRegistered` (@frozen issue), `complete`; header `whtMode`, WT header fields; line `whtTypeCode`, `expenseCategory`, `postedAccount` (@frozen issue), `pnd36`, `vendorInvoice` | | SP4.4 |
| `opening`, `DocOpening` family; header `obBatchId`, `obSide`, `obKind` | | SP4.11 |
| `asset`, `AssetData`, `dp`, `DpData`, `DpRow`, `Disposal`; header `disposal`, `scheduleId`, `scheduleMonth` | | SP4.6 |
| `payroll`, `PayrollData`, `PayrollSlip` family; line `employeeId`, `pay`; `payslips` (paper); `PartySummary.payroll` | | SP4.7 |
| `agentReportId`; `DocSummary.createdByAgent` filter semantics | | SP4.10 |
| `DocSummary.wht`; `PartySummary.linkedPartyId`, `defaultWhtTypeCode` meaning | | SP4.4 / SP4.5 |

### 5.3 Routes (`ROUTES`; BFF `/bff/v1` + path → API `/internal/v1` + path)

`{kind}` ∈ customer | vendor | item | bank-account; its read / manage permission: customer, vendor → `party.read` /
`party.manage`; item → `item.read` / `item.manage`; bank-account → `bank.read` / `bank.manage`. `{type}` = a LIVE type
(SP4.2: `JV`); `P(verb)` = `doc.<type>.<verb>`.

| # | Method · path | Auth | Permission | Agent | Idem / conc. | Request → response | Errors (besides 401 / 403 / rate) | Audit | Task |
|---|---|---|---|---|---|---|---|---|---|
| 1 | GET `/records/{kind}?q&active&limit&cursor` | session | kind read | yes | — | → `Page<CustomerRow \| VendorRow \| ItemRow \| BankAccountRow>` | record.kind_unknown, record.not_available | — | D2 |
| 2 | GET `/records/{kind}/{id}` | session | kind read | yes | — | → row | record.not_found | — | D2 |
| 3 | POST `/records/{kind}` | session | kind manage | no | required / — | kind body → row (201) | record.invalid (+fieldErrors), posting.* (bank: Cash rule) | `record.<kind>.create` | D2 |
| 4 | PUT `/records/{kind}/{id}` | session | kind manage | no | — / version-body | `Versioned<body>` → row | not_found, version_conflict, record.invalid | `record.<kind>.update` | D2 |
| 5 | POST `/records/{kind}/{id}/active` | session | kind manage | no | — / version-body | `RecordActiveBody` → row | not_found, version_conflict, record.in_use (default bank) | `record.<kind>.activate` / `.deactivate` | D2 |
| 6 | GET `/parties?kind&q&limit` | session | `party.read` | yes | — | → `Page<PartySummary>` (active only) | — | — | D2 |
| 7 | GET `/items?q&usage&limit` | session | `item.read` | yes | — | → `Page<ItemSummary>` (active only) | items.invalid_usage | — | D2 |
| 8 | GET `/search?q` | session | member | yes | — | → `{items: SearchHit[]}` | — | — | D2 |
| 9 | GET `/finance/bank-gl-accounts` | session | `bank.read` | yes | — | → `BankGlAccount[]` (`taken` = bound or claimed) | — | — | D2 |
| 10 | GET `/docs/by-party/{partyId}` | session | member (rows filtered by `doc.<T>.read`) | yes | — | → `Page<DocSummary>` | record.not_found | — | D4 |
| 11 | GET `/settings/numbering` | session | `settings.manage` | no | — | → `{items: NumberingRow[]}` | — | — | D3 |
| 12 | POST `/settings/numbering/preview` | session | `settings.manage` | no | — | `NumberingBody & {docType}` → `NumberingPreview` (read-only POST) | numbering.not_found, bad_*, missing_token, ambiguous | — (read-only allow-list) | D3 |
| 13 | PUT `/settings/numbering/{type}` | session | `settings.manage` | no | — / version-body | `Versioned<NumberingBody>` → `NumberingRow & {notice?}` | not_found, version_conflict, bad_*, missing_token, ambiguous, collision | `numbering.update` | D3 |
| 14 | GET `/settings/approvals` | session | `settings.manage` | no | — | → `ApprovalsView` | — | — | D5 |
| 15 | PUT `/settings/approvals/self-approval` | session | `settings.manage` | no | — / version-body (group version) | `SelfApprovalBody` → `ApprovalsView` | version_conflict, record.invalid | `approval.self.update` | D5 |
| 16 | PUT `/settings/approvals/tolerance` | session | `settings.manage` | no | — / version-body | `ToleranceBody` → `ApprovalsView['tolerance']` | version_conflict, approval.invalid_amount | `settlement.tolerance.update` | D5 |
| 17 | PUT `/settings/approvals/{type}` | session | `settings.manage` | no | — / version-body | `ApprovalRuleBody` → `ApprovalRuleRow` | approval.not_found, version_conflict, record.invalid, invalid_amount | `approval.rule.update` | D5 |
| 18 | GET `/settings/templates` | session | `settings.manage` | no | — | → `TemplatesView` | — | — | D8 |
| 19 | GET `/settings/templates/{type}/preview` | session | `settings.manage` | no | — | → `PaperModel` (sample, writes nothing) | template.unknown_type | — | D8 |
| 20 | PUT `/settings/templates/{type}` | session | `settings.manage` | no | — / version-body | `TemplateBody` (labels absent = keep; `null` → 422) → `TemplatesView` | unknown_type, version_conflict, record.invalid, bad_label | `template.update` | D8 |
| 21 | GET `/docs/{type}?status&from&to&q&outstanding&overdue&agent&form&limit&cursor` | session | P(read) | yes | — | → `Page<DocSummary>` (filters server-side before paging; newest first) | doc.type_not_available | — | D4 |
| 22 | GET `/docs/{type}/{id}` | session | P(read) | yes | — | → `Doc` (locks derived, `printCount`, `progress`, `approvalRequired`) | type_not_available, doc.not_found | — | D4 |
| 23 | POST `/docs/{type}/compute?docId` | session | P(read) | yes | — | `DocInput` → `ComputeResult` (read-only POST) | type_not_available, doc.not_found | — (read-only allow-list) | D4 |
| 24 | POST `/docs/{type}` | session | P(create) | yes (policy) | required / — | `DocInput` → `Doc` (201) | type_not_available, doc.invalid_line, agent.forbidden_action | `doc.create` | D4 |
| 25 | PUT `/docs/{type}/{id}` | session | P(create) | yes (own draft) | — / version-body | `DocInput & {version}` → `Doc` | not_found, version_conflict, doc.not_draft, approval.pending, agent.forbidden_action | `doc.update` | D4 |
| 26 | DELETE `/docs/{type}/{id}?version=` | session | P(create) | yes (own draft) | — / version-query | → 204 | not_found, version_conflict, not_draft, agent.forbidden_action | `doc.delete` | D4 |
| 27 | POST `/docs/{type}/{id}/issue` | session | P(issue) | yes (review gate) | — / version-body | `VersionBody` → `Doc` | not_draft, version_conflict, approval.pending, approval.required, doc.incomplete, doc.future_date, period.closed, period.year_closed, numbering.allocation_*, type codes, agent.review_required | `doc.issue` | D4 |
| 28 | POST `/docs/{type}/{id}/submit` | session | P(create) | no | — / version-body | `VersionBody` → `Doc` | not_draft, version_conflict, doc.incomplete, approval.not_required | `doc.submit` | D5 |
| 29 | POST `/docs/{type}/{id}/approve` | session | P(approve) | no | — / version-body | `VersionBody` → `Doc` | approval.not_pending, version_conflict, approval.self_not_allowed | `doc.approve` | D5 |
| 30 | POST `/docs/{type}/{id}/approve-and-issue` | session | P(approve) + P(issue) | no | — / version-body | `VersionBody` → `Doc` | approval.not_approvable, self_not_allowed, + route 27's | `doc.approve` + `doc.issue` | D5 |
| 31 | POST `/docs/{type}/{id}/send-back` | session | P(approve) | no | — / version-body | `SendBackBody` → `Doc` | approval.not_sendable, version_conflict, approval.reason_required | `doc.send_back` | D5 |
| 32 | POST `/docs/{type}/{id}/cancel` | session | P(cancel) | no | — / version-body | `CancelBody` → `Doc` | doc.not_cancellable, version_conflict, doc.locked, doc.has_dependents, period.year_closed, lock-provider codes | `doc.cancel` | D4 |
| 33 | POST `/docs/{type}/{id}/correction-plan` | session | P(create) | no | — | `DocInput` → `CorrectionPlan` | doc.not_correctable, revise refusals (§4.4), approval.required_on_revise | `doc.correction_plan` | D6 |
| 34 | POST `/corrections` | session | every step's permission | no | — (single-use plan) | `ExecuteCorrectionBody` → `CorrectionResult` | correction.plan_not_found, plan_stale, empty_plan, step refusals | `doc.revise` / `doc.cancel` / `doc.reissue` / `doc.issue` per step | D6 |
| 35 | POST `/docs/{type}/{id}/convert` | session | P(read) + `doc.<target>.create` | no | — | `ConvertBody` → `Doc` (201, the target draft) | doc.not_convertible, conversion_not_allowed, type_not_available, invalid_qty, over_conversion, line_not_found, doc.closed, qt.rejected | `doc.convert` | D6 |
| 36 | POST `/docs/{type}/{id}/marks` | session | P(issue) | no | — / version-body | `MarkBody` → `Doc` | mark.not_allowed, doc.not_live, version_conflict, mark.already_set, mark.reason_required | `doc.mark` | D6 |
| 37 | POST `/docs/{type}/{id}/close-remainder` | session | P(issue) | no | — / version-body | `CloseRemainderBody` → `Doc` | mark.not_allowed, doc.not_live, version_conflict, mark.reason_required, doc.already_closed, doc.nothing_remaining | `doc.mark` | D6 |
| 38 | GET `/docs/{type}/{id}/remaining` | session | P(read) | yes | — | → `RemainingLine[]` | not_found | — | D6 |
| 39 | GET `/docs/{type}/{id}/chain` | session | P(read) | yes | — | → `ChainGraph` | not_found | — | D6 |
| 40 | GET `/docs/{type}/{id}/activity` | session | P(read) | yes | — | → `ActivityEntry[]` (newest first) | not_found | — | D4 |
| 41 | GET `/docs/{type}/{id}/revisions` | session | P(read) | yes | — | → `Revision[]` (newest first) | not_found | — | D4 |
| 42 | GET `/docs/{type}/{id}/ledger` | session | P(read) + `ledger.read` (in that order) | yes | — | → `JournalPreview` (stored entries in `seq` order) | not_found | — | D4 |
| 43 | GET `/docs/{type}/{id}/attachments` | session | P(read) | yes | — | → `Attachment[]` | not_found | — | D8 |
| 44 | POST `/docs/{type}/{id}/attachments` | session | P(create) | no | — | `AttachmentBody` → `Attachment` (201) | attachment.category_invalid, name_required, type_not_allowed, too_large, storage.full | `attachment.add` | D8 |
| 45 | DELETE `/docs/{type}/{id}/attachments/{attId}` | session | P(create) | no | — | → 204 | attachment.not_found | `attachment.remove` | D8 |
| 46 | GET `/docs/{type}/{id}/attachments/{attId}/content` (new) | session | P(read) | yes | — | → the file bytes (stored MIME) | attachment.not_found | — | D8 |
| 47 | POST `/docs/{type}/{id}/printed` | session | P(read) | no | — | `PrintedBody` → `{copy, printCount}` | doc.not_printable | `doc.print` | D8 |
| 48 | GET `/docs/{type}/{id}/paper?copy=1` | session | P(read) | yes | — | → `PaperModel` | doc.paper_not_available, doc.not_printable | — | D8 |
| 49 | GET `/docs/{type}/{id}/public-links` | session | P(read) | no | — | → `{active: number}` | doc.not_found | — | D8 |
| 50 | POST `/docs/{type}/{id}/public-links` | session | P(read) | no | — | `{}` → `{token}` (201; the only response with the token) | public.not_shareable, public.not_issued | `public_link.create` | D8 |
| 51 | DELETE `/docs/{type}/{id}/public-links` | session | P(read) | no | — | → `{revoked: number}` (0: no write, no audit) | doc.not_found | `public_link.revoke` | D8 |
| 52 | GET `/public/p/{token}` | public (rate-limited per IP) | — | no | — | → `{type, paper}` (copy) | public.link_invalid (one answer) | — | D8 |
| 53 | GET `/docs/open-items?partyId&types` | session | `doc.<T>.read` per requested available type | yes | — | → `{items: OpenItem[], total}` (server sum) | doc.open_items_query | — | D6 (answers from SP4.3) |
| 54 | POST `/docs/{type}/{id}/reverse` | session | P(issue) | no | — | `ReverseBody` → `Doc` (201, the reversing JV) | ledger.reverse_document, doc.not_reversible, ledger.already_reversed, ledger.reverse_date, doc.future_date, period.closed, period.year_closed, finality hooks | `doc.reverse` | D7 |

Mock routes not in the contract: none new; `POST /docs/{type}/{id}/agent-review`, `/agent-reports/{id}` are SP4.10's.

### 5.4 Error codes (SP3 registry; status)

`doc.not_found` 404 · `doc.type_not_available` 404 · `doc.version_conflict` 409 · `doc.version_required` 422 ·
`doc.not_draft` 409 · `doc.incomplete` 422 · `doc.future_date` 422 · `doc.invalid_line` 422 · `doc.not_cancellable` 409 ·
`doc.locked` 409 · `doc.has_dependents` 409 · `doc.not_revisable` 409 · `doc.revise_not_allowed` 422 ·
`doc.not_correctable` 409 · `doc.reissue_total_changed` 422 · `doc.conversion_not_allowed` 422 · `doc.over_conversion`
422 · `doc.below_converted` 422 · `doc.line_not_found` 422 · `doc.invalid_qty` 422 · `doc.not_convertible` 409 ·
`doc.closed` 409 · `doc.already_closed` 409 · `doc.nothing_remaining` 409 · `doc.not_live` 409 · `doc.party_locked` 422 ·
`doc.total_not_positive` 422 · `doc.paper_not_available` 404 · `doc.not_printable` 409 · `doc.not_reversible` 409 ·
`doc.open_items_query` 422 · `approval.pending` 409 · `approval.required` 422 · `approval.required_on_revise` 422 ·
`approval.not_required` 422 · `approval.not_pending` 409 · `approval.not_approvable` 409 · `approval.not_sendable` 409 ·
`approval.reason_required` 422 · `approval.self_not_allowed` 403 · `approval.invalid_amount` 422 · `approval.not_found`
404 · `correction.plan_not_found` 404 · `correction.plan_stale` 409 · `correction.empty_plan` 422 · `mark.not_allowed` 422 ·
`mark.reason_required` 422 · `mark.already_set` 409 · `qt.rejected` 409 · `numbering.not_found` 404 ·
`numbering.bad_prefix` · `bad_scope` · `bad_branch` · `bad_token` · `missing_token` · `ambiguous` · `collision` 422 ·
`numbering.allocation_ambiguous` 409 (new, D-F12) · `numbering.allocation_collision` 409 (new) · `numbering.in_use`
(notice, never an error) · `template.unknown_type` 404 · `template.bad_label` 422 · `attachment.category_invalid` ·
`name_required` · `type_not_allowed` · `too_large` 422 · `attachment.not_found` 404 · `public.not_shareable` 422 ·
`public.not_issued` 409 · `public.link_invalid` 404 · `record.kind_unknown` 404 (reclaimed from SP3) ·
`record.not_available` 404 · `record.in_use` 409 · `items.invalid_usage` 422 · `ledger.reverse_document` 422 ·
`ledger.reverse_date` 422 · `ledger.already_reversed` 409 · `ledger.reversed_final` 409 · `ledger.reversal_final` 409 ·
`ledger.auto_reverse_closed` 422 · `agent.review_required` 409. Retired with the mock: `attachment.storage_full` (→ SP3
`storage.full` 507), `doc.id_exists` (seed only).

### 5.5 Permissions (no additions — SP3 catalog)

`party.read`, `party.manage`, `item.read`, `item.manage`, `bank.read`, `bank.manage`, `settings.manage`, `ledger.read`,
`doc.<T>.{read,create,issue,cancel,correct}` for every type (WT: read only), `doc.<T>.approve` for the 16 types of the
catalog (QT SO DO BL IV TI RC CN DN PO PB PCN PDN PV EX JV — FA, DP, PR, OB, WT have none). AgentForbidden:
`doc.<T>.approve|cancel|correct`, `settings.manage`.

## 6. Invariants — each a named test (owner SP4.2 unless noted)

| # | Invariant (mock #) | Test (task) |
|---|---|---|
| D-I1 | Numbering: per series key the issued numbers are gap-free from 1, the counter equals their count, every number parses to exactly its own key under the key's stored template, and a number is unique per company × type (numbering block of `checkInvariants`) | `NumberingInvariantTests` + barrier race (two issues of one key → 1, 2, never a duplicate or a gap) + a refusal after allocation leaves no gap (D3, D4) |
| D-I2 | A pending / approved document has no number, no journal, no active link, and an approval record (who sent; approved: who approved); an issued one never carries an approval nobody gave; a live document the policy (frozen, else live) wants approved at its CURRENT amount carries an approval covering it (#12) | `ApprovalInvariantTests` (D5) |
| D-I3 | Converted quantity per source line ≤ the source quantity (#5); progress counts live targets only | `ConversionTests` (D6) |
| D-I4 | Links join documents of one company; every non-draft ledger document (total ≠ 0) has a journal; cancelled / replaced ends with a reversal (#6); a link row only goes active → inactive | `LinkInvariantTests` (D1, D6) |
| D-I5 | Outstanding and status follow the active links (#2, #3) — generic formula; the types' own ties are their owners' | `OutstandingTests` with `XL` (D6) |
| D-I6 | Every issued printable document carries `sellerSnapshot` AND `issueLook`; every file id it names exists; revision 0's snapshot carries them (look invariant, B-3) | `SnapshotTests` (D4, D8) |
| D-I7 | Locks with kind `period` / `reconciliation` are never stored (derived at read) | `LockTests` (D4) |
| D-I8 | I5 at the database: a live T-class document's fiscal columns and snapshots cannot change (trigger), its number never changes for any class | `DocTriggerTests` (D1) |
| D-I9 | A refused command writes nothing (no row in any table — row counts before = after) — tested per refusal code of routes 24–37, 54 | `RefusalWritesNothingTests` (D4–D7) |
| D-I10 | JV (#15): no line on a `ControlExit(jv)` account; the stored journal IS its used lines (party ignored, F1b); a reversal is the exact mirror of a live JV of its company with exactly one active `adjusts` link; one live reversal per JV; an accrual with `autoReverse` has exactly one live system reversal dated day 1 of the next month | `JvInvariantTests` (D7) |
| D-I11 | Public links: unknown / revoked / not-live give byte-identical 404 bodies (except `traceId`); a token is never stored, logged or audited | `PublicLinkTests` (D8) |
| D-I12 | Print log: exactly one original per live document across concurrent prints (barrier) | `PrintLogTests` (D8) |

Owned by later modules (the engine provides the hooks): #4 / 4b / 4c / 4e / 24 control ties (SP4.3 / 4.4 / 4.5 /
4.11), #8–#11b (SP4.3 / 4.4 / 4.5), #13 / #14 (SP4.5), #16–#21 (SP4.11, 4.6, 4.8, 4.7), #26 `postedAccount` (SP4.4 on
SP4.1's API).

## 7. Guards and their exits

| Guard | State when it fires | Exit in the app (no DBA) |
|---|---|---|
| `doc.version_conflict` | stale form | reload and re-apply (the editor keeps typed values) |
| `doc.not_draft` / `approval.pending` (update, delete) | pending or approved | the approver sends it back (route 31), then edit / delete |
| `approval.required` | issue of a draft the policy wants approved | submit (route 28), or approve-and-issue with both rights (route 30) |
| `approval.self_not_allowed` | self-approval off; the actor created / last changed the money / submitted | another holder of `doc.<T>.approve` approves; a company with one approver turns self-approval on (route 15) |
| `approval.required_on_revise` | a revise above the approved amount, actor without approve | a holder of the approve right runs the correction; or cancel and create a new draft for approval |
| `doc.future_date` / `period.closed` / `period.year_closed` | issue / date move | change the date (the message names the first open date); reopen the month / year (SP4.1 §7) |
| `doc.locked` | a blocking derived lock | the lock's own `exits` / `href` (each provider names one) |
| `doc.has_dependents` (cancel) | an active settles / adjusts link points at it | cancel the receipt / payment / note first (named) |
| `doc.party_locked` | a settles / groups / adjusts link points at it | cancel the linked document first, or cancel this one and create anew |
| `doc.revise_not_allowed` | a fiscal change on a T-class document in place | the correction plan (route 33) |
| `doc.reissue_total_changed` | a reissue with another total | a CN / DN (TI, SP4.3) or cancel the receipt and issue a new one (RC) |
| `doc.below_converted` | revise a source line below its converted quantity | close the remainder (route 37) or cancel the dependent |
| `doc.over_conversion` | convert more than remains | revise the source (raises the quantity) or reduce the conversion |
| `doc.closed` | convert from a closed remainder | revise the source (an N-class revision reopens it) |
| `doc.nothing_remaining` / `doc.already_closed` / `mark.already_set` | nothing to do | none needed (state already reached) |
| `qt.rejected` | convert a rejected quotation | revise it (a new offer) or duplicate it |
| `correction.plan_stale` | the document changed since the plan | build a new plan (route 33) |
| `numbering.allocation_ambiguous` / `numbering.allocation_collision` (issue refused) | the config would produce an ambiguous / held number | change the format or prefix (route 13) — the message says so; the draft is unchanged and can be issued after |
| `numbering.ambiguous` / `numbering.collision` (save) | as above, before saving | change the format / prefix |
| `ledger.reverse_document` | reverse on a non-JV | cancel or correct the document itself (named) |
| `ledger.already_reversed` | a JV already reversed / with a live auto-reversal | cancel or revise the accrual (auto-reversal); else none needed |
| `ledger.reversed_final` | revise / cancel a JV a person reversed | none — final by design (AC1 ruling 5–7); its reversal can be reversed once to restore the effect |
| `ledger.reversal_final` | revise / cancel a reversal JV | reverse it once ("กลับรายการใบนี้"); an auto-reversal: edit its accrual |
| `ledger.auto_reverse_closed` | the next month is closed | turn off auto-reverse, or reopen that month |
| `ledger.reverse_date` | a date before `max(original, first open date)` | pick that date or later (named) |
| `record.in_use` (default bank) | deactivate the company's default bank account | none in SP4.2 (the default is server-owned; Q-D5) |
| `public.not_issued` / `public.not_shareable` | draft / cancelled / internal type | issue it / share the paper another way |
| `agent.forbidden_action` / `agent.review_required` | an agent write outside its rules | a person does it; SP4.10 opens the review path |
| `attachment.too_large` / `type_not_allowed` | file > 1 MB / not pdf, png, jpeg, webp | compress / convert, then attach |

## 8. Freeze at issue / revise (never re-derived)

| Field | Frozen at | Source data it shields | Test (change the source after the event → stored value and every reader unchanged) |
|---|---|---|---|
| `sellerSnapshot` | issue, N / L revise, reissue (T non-fiscal revise: Q-D3) | company identity | edit the company's legal name → old paper / public link / revision unchanged |
| `issueLook` (file ids, issuer name, position) | the same | company logo / stamp, member signature / name / position | replace the logo, change the issuer's signature and position, deactivate the issuer → old paper unchanged |
| `party` (snapshot) | create, update, issue, revise | party master | rename the customer, change its TIN → the issued document and its paper unchanged |
| `policy` `{enabled, minAmount?, selfApproval}` | submit; issue (if none); a re-approved revise | approval rules | raise the threshold after submit → the pending document still needs approval; turn self-approval off → not applied to an approved one |
| `approval.amount`, `approval.*By/At` | approve, approve-and-issue, a re-approved revise | the document's later money | revise below the amount → no new approval; above → refused without approver |
| `moneyBy` | a save / revise that changed the money | — | a notes-only revise keeps it |
| `number`, the series template | first number of the series key | numbering config | change the format mid-period → later numbers of that key keep the old format; numbers never change |
| `revision` snapshots + `diff` | every issued revision | the document's later state | revise twice → revision 0 and 1 snapshots unchanged, each with its look |
| `issuedAt`, `issuedBy` | issue | — | — |
| `doc_prints.paper` | first print (types that ask: SP4.4 WT) | the document's later state | slot only in SP4.2 (test with `XT`) |
| JV journal lines (SP4.1 §8) | issue / revise | rules, account names, party names | inherits SP4.1 `FrozenAfterPostingTests` |

## 9. Charter statements contradicted or extended by the approved mock (for ADR-0008)

| # | SP0 | Charter says | Approved mock (ruling) | Disposition |
|---|---|---|---|---|
| CD-1 | §7.6 | the creator may self-approve unless disabled | off also blocks the submitter and the last money editor (P-06); the policy is frozen per document; a raise above the approved amount needs a new approval (C1) | ADR-0008 |
| CD-2 | §5.14 / §6.3 | the series month comes from `document_date` | a cross-month revise keeps its number (Ham 2026-10-18); the period check judges revision 0's date | ADR-0008 |
| CD-3 | §5.14 | a series includes the branch when configured | the series key is company × type × period; branch only a `{BRANCH}` token. Backend key carries `branch_code` = `00000` (D-03-2 later) | this spec §4.5 |
| CD-4 | §5.14 | the number is unique company-wide | unique per company × type (prefixes may repeat across types) | ADR-0008 |
| CD-5 | §7.3 | T-class non-fiscal fields: notes, attachments, internal reference, dimensions, due date, payment terms | dimensions and cheque are fiscal (a dimension change reissues); in place only notes, reference, due date (+ RC certificate numbers) | ADR-0008 |
| CD-6 | §7.11 | links are append-only | a deleted draft's links are deleted with it (S1); every other link only deactivates | this spec D-F10 |
| CD-7 | §7.12 | a reason is mandatory after issue | revisions run through the correction plan with the fixed reason "แก้ไขตามแผนการแก้ไข"; the user is never asked; `Revision.reason` optional | Q-D4 |
| CD-8 | §7.7 | conversions include TI / IV → RC, PO / EX → PV | receipts / vouchers are built from open items (allocations), never by conversion; `CONVERSIONS` keeps PO → PB / PV, PB → PV, EX → PV as allocation-creating special cases (SP4.4) | ADR-0008 |
| CD-9 | §7.12 | activity = created … notes, attachments | marks and close-remainder add activity + audit with no revision row | this spec (extension) |
| CD-10 | §7.1 | three line editors | four plus `none` (payroll, D-11) | ADR-0008 (already listed in the master plan §9) |
| CD-11 | §7.2 | cancel posts a reversal | a user cancel reverses TODAY (late if the original month is closed); only corrections / plan steps reverse on the original date | ADR-0008 |
| CD-12 | §3.2 / §7.12 "notes" | activity lists "notes" | the approved mock has no notes thread: notes = the printed `header.notes` | Q-D7 |

## 10. Definition of Done (SP0 §11.5)

- [ ] Descriptors complete: lifecycle, every guard has an exit (§7 tests), correction policy — the JV descriptor + the
  three test descriptors; the contract test `descriptor ⇔ DOC_TYPES` on the backend registry
- [ ] Date model and period gate applied — `doc.future_date`, SP4.1 `Strict` / `Late` placement on every path
- [ ] Permissions in the catalog; frontend gating; MCP tools and agent-policy defaults — no new codes; agent column of §5.3;
  `AgentDefault` Off for JV; no MCP document tool yet (JV is Off; SP4.10 generates tools from descriptors)
- [ ] Error codes registered in Thai and English (§5.4), the numbering splits done in the mock too
- [ ] Every screen state implemented — masters, numbering, approvals, templates, JV list / editor / view, attachments,
  public page in hybrid mode: loading, empty, error, forbidden, locked; VAT and non-VAT
- [ ] Screen = paper for every document — JV paper = view (one builder, SP1b)
- [ ] Opening-balance support where the module holds balances — n/a (masters hold none; SP4.11 imports masters)
- [ ] Tests: domain unit (number template, lifecycle graph, diff, approval math, Q4), integration as `teas_app`,
  blind acceptance (numbering + JV — money), e2e, RBAC matrix rows for routes 1–54
- [ ] Generated docs updated — OpenAPI, conformance `contract/conformance/documents.ts`
- [ ] Shipped screens match the approved mockups — masters, numbering / approvals / templates settings, JV list / editor /
  view / print, public page vs SP1c screenshots
- [ ] Parity rows ticked: M-01 customers, M-02 vendors, M-03 items, P-08 vendor quick-create, M-09 bank accounts,
  FG-10b numbering series, FG-10c branches (PARTIAL by design: D-03-2), FG-02 back-dating, FG-10g approvals (PARTIAL:
  one threshold, B-6), FG-01a inbox (data side), FG-03a / FG-03b / FG-03c drafts / send back / delete, FG-10i print
  templates, FG-05b duplicate, S-08 original / copy, S-09 chain, S-10 activity + attachments, S-11 default notes, L-01
  journal vouchers, FG-04 reversal + auto-reversing accrual
- [ ] §6 invariants have their named tests; §12 probe passes on staging

## 11. Verification gates (exact commands)

| Gate | Command |
|---|---|
| backend build | `dotnet build backend/Teas.sln -c Release -warnaserror` |
| unit | `dotnet test backend/tests/Teas.Domain.Tests -c Release --filter "FullyQualifiedName~Documents\|FullyQualifiedName~Numbering"` |
| architecture | `dotnet test backend/tests/Teas.Architecture.Tests -c Release` |
| integration | `dotnet test backend/tests/Teas.Integration.Tests -c Release --filter "FullyQualifiedName~Documents\|FullyQualifiedName~Masters\|FullyQualifiedName~Numbering"` |
| OpenAPI current | `dotnet build backend/src/Teas.Api -c Release` then `git diff --exit-code docs/api/openapi.v1.json` |
| frontend | from `frontend/`: `corepack pnpm gen:api` · `typecheck` · `lint` · `test` · `corepack pnpm e2e master settings-numbering settings-approvals settings-templates accounting-jv public-link --workers=1` (nothing on :3100 first) |
| contract freeze | `node tools/check-contract-freeze.mjs` |

Sequential from D1 (shared integration DB; never beside an SP4.1 task that runs integration tests). D0 is frontend-only:
it runs after SP4.1 L0 (both edit `domain/types.ts` re-exports) and may run beside SP4.1 L1–L7.

## 12. Deploy probe (staging, then prod) — row counts, not exit codes

1. As `teas_migrator` with `app.system = on` (read only): companies without `approval_rules` rows → 0 (else
   `Teas.Migrator seed-documents --all-missing`, which prints per company the rows inserted).
2. Public domain: create a customer, an item and a bank account in a staging company → `GET /bff/v1/records/customer`
   lists it; the bank's `Cash` rule exists (`GET /bff/v1/settings/posting/rules` shows `default · <bankId> · Cash`).
3. Public domain: create a 2-line JV, issue it → number `JV-YYYYMM-0001` (default format); `GET …/ledger` shows the
   entry; SP4.1 TB tie-out diff `0.00`; reverse it → `JV-YYYYMM-0002`, TB unchanged in total, both accounts back to 0.
4. Public domain: create a public link on an issued JV → refused `public.not_shareable` (JV is internal); on staging
   only, the sessionless `/bff/v1/public/p/<random>` answers 404 `public.link_invalid`.
5. As `teas_app`, no GUC: `SELECT count(*) FROM teas.documents` → 0; under a company GUC, `UPDATE teas.documents SET number
   = 'X' WHERE number IS NOT NULL` → error from the trigger.

## 13. Tasks

Order: D0 → D1 → D2 → D3 → D4 → D5 → D6 → D7 → D8 → D9 (D10 only after Ham's mock-screen approvals). From D1 every task
runs integration tests on the shared local DB — sequential only.

### Task D0: Freeze the documents contract (frontend; master plan C3)

**Depends on:** SP4.1 L0; Ham approves this spec (incl. Q-D1 attachments, Q-D2 approval rows). **Blast cap:** 30 files;
API changes: §5.1 deltas only.
**Files:** Create `frontend/src/contract/documents.ts`, `documents.contract.test.ts`. Modify (re-export / conform):
`domain/types.ts`, `domain/doc-types.ts`, `domain/descriptors.ts`, `domain/records.ts` (re-export only; `WireRecordKind` lives in the contract),
`lib/api/endpoints.ts` (typed bodies; `addAttachment` body; `Attachment.contentUrl`), `records/tax-numbering-approvals.ts`,
`records/auth.ts` (public-link shapes from the contract), `kit/doc-view/AttachmentsPanel.tsx` (`href={a.contentUrl}`),
`mocks/engine/attachments.ts` (`contentUrl`), `mocks/handlers/docs-write.ts` (content route `…/attachments/{attId}/content`
serving the stored blob; read-only POST list), `mocks/engine/numbering.ts` (allocate-time codes split),
`mocks/records/{parties,items,bank-accounts}.ts` (`toRow` returns the typed rows), `mocks/engine/look.ts` comment
(`IssueLook` refs are opaque), `mocks/engine/bank-import.ts` + `mocks/fixtures/specs/purchases.ts` (internal callers of the
attachment store keep working), the record-form callers of the typed bodies, approval rows per Q-D2 (fixture + the
settings page if it changes — Ham screenshot first), `th.json` / `en.json` only if a test maps a new code.
**Rules:** move, do not retype; old import paths keep working; `ROUTES` = §5.3 rows 1–54 exactly; typed rows are `type`
aliases. No other behaviour change.
- [ ] **Step 1: Failing tests** — every `ROUTES` entry has an MSW handler and every MSW handler under `/records/{customer,
  vendor,item,bank-account}`, `/parties`, `/items`, `/search`, `/finance/bank-gl-accounts`, `/docs`, `/corrections`,
  `/settings/{numbering,approvals,templates}`, `/public` has a `ROUTES` entry (generic `{type}` rows count once); an
  attachment list item has `contentUrl` and no `dataUrl`; the content route returns the uploaded bytes; allocate-time
  numbering refusals carry the new codes; descriptors ⇔ `DOC_TYPES` unchanged.
- [ ] **Steps 2–5**, gates: `typecheck`, `lint`, focused `test`, e2e `master settings-numbering settings-approvals
  settings-templates accounting-jv public-link --workers=1`. Controller runs the full unit suite.
- [ ] **Step 6: Controller commits** `feat(contract): freeze the documents contract v1.0`, then the `FROZEN.json` entry.

### Task D1: Schema, triggers, RLS, company initializer

**Depends on:** D0; SP4.1 L7. **Blast cap:** 20 files. **Tier 2:** Opus review (schema / RLS / runtime security).
**Files:** migration `0201_documents` (§4.14 tables, the `parties` columns, triggers incl. `teas.doc_status_guard` and the
T-class guard, grants, indexes `documents (company_id, type, document_date DESC)`, `(company_id, party_id)`,
`doc_links (company_id, to_id) WHERE active`, `(company_id, from_id)`), `DocumentsCompanyInitializer`, verb
`seed-documents`, `TenantRowFactory` methods, EF mappings, `rls-allowlist.txt` unchanged (no global table), the
`EnterSystem` allow-list entry `Documents/PublicLinks`, tests.
**Rules:** §4.14, §4.15; the T-class guard's allow-list is a SQL array per type, empty for every type in SP4.2 except the
test type `XT` (`notes`, `reference`, `dueDate`); on a live T-class row the columns that MAY change are `status`,
`version`, `revision`, `outstanding`, `stored_locks`, `marks`, `cancel`, `replaced_by_id`, `replaces_id` (a replacement
receipt is linked after its issue — mock `markReplaced`), `approval`, `policy`, `money_by`, `ext` keys a type lists, and
`header` in its allow-list. Status graph (`teas.doc_status_guard`, UPDATE only; an engine-made row may be INSERTed
issued): draft → pending | approved | issued; pending → draft | approved | issued; approved → draft | issued; issued ↔
partly_settled ↔ settled (any order among the three); issued | partly_settled | settled → cancelled | replaced;
cancelled → replaced (a receipt cancelled by a plan step, then replaced by its reissue).
- [ ] **Step 1: Failing tests** — generated RLS test covers every new tenant table; `number` set once, never changed;
  illegal status transitions raise (draft → cancelled, issued → draft, cancelled → issued); `XT` live: lines / totals /
  party / seller / look / date changes raise, notes / reference / dueDate pass; `doc_links` UPDATE other than
  active → inactive raises; append-only tables refuse UPDATE / DELETE / TRUNCATE as both roles; `CompanyFactory.Create`
  → the initializer's rows; `seed-documents --all-missing` idempotent.
- [ ] **Steps 2–5**, gates: build, architecture, integration (focused). **Step 6:** `feat(documents): schema, triggers and row-level security`.

### Task D2: Masters, parties / items lookups, search, bank GL list

**Depends on:** D1. **Blast cap:** 16 files. **Files:** `Teas.App/Masters/**`, `Endpoints/Masters/**` (routes 1–9),
`IAccountClaim` (bank-bound) + `IPostingKeyDirectory` (items, bank accounts) registrations for SP4.1, conformance lines,
tests.
**Rules:** §4.12 (mock record impls verbatim, the Cash rule through SP4.1 with `RoleProblem`).
- [ ] **Step 1: Failing tests** — every field rule of M1 / M2 / FN1 with its Thai field error; code locked once used
  (a document naming the party / item — test with an `XN` draft); idempotent create (same key → same row, 201; different
  body → 422); a bank account on 1130 refused (`posting.control_account`); bank GL rules (sub-class matches kind, one per
  account, claimed, frozen once posted); default bank not deactivatable; `/parties` and `/items` exclude inactive;
  `/items?usage=x` 422; search mixes docs / parties / pages with hrefs from the registry; agent refused on writes;
  item-level and bank-keyed posting rules now validate (SP4.1 `posting.key_invalid` gone for a real item).
- [ ] **Steps 2–5**, gates as D1 + conformance. **Step 6:** `feat(masters): customers, vendors, items and bank accounts`.

### Task D3: Numbering series

**Depends on:** D2. **Blast cap:** 10 files. **Tier 2:** Opus review (legal series) + blind acceptance tester (§4.5, D-I1).
**Files:** `Teas.Domain/Documents/NumberTemplate.cs` (+ tests), `Teas.App/Numbering/**`, `Endpoints/Settings/NumberingEndpoints.cs`
(routes 11–13), tests.
**Rules:** §4.5; mock `engine/numbering.ts` vectors verbatim (incl. ST3a M1 ambiguity, R2-m1 "storing a new key must not
make an issued number lose its key", the scope-per-year switch notice).
- [ ] **Step 1: Failing tests** — template validate / format / parse round trip for every token mix; default format
  reproduces `JV-202610-0001`; format frozen per key across a config change; scope kept for the year, switch next year
  with the notice; ambiguity refused at preview / save (422) and allocate (409, new code); collision both ways; a revise
  across months keeps its number; barrier race (20 parallel issues of one key → 1..20); a refused issue after allocation
  (forced failure in the posting step) leaves the counter unchanged.
- [ ] **Steps 2–5**, gates as D2. **Step 6:** `feat(numbering): legal series with frozen formats`.

### Task D4: Document engine core (draft → issue, cancel, revise for N / L, reads)

**Depends on:** D3. **Blast cap:** 26 files. **Tier 2:** Opus review (money / lifecycle) + blind acceptance tester (§4.3,
D-I4, D-I6, D-I7, D-I9).
**Files:** `Teas.App/Documents/{DescriptorRegistry,DocumentEngine,Snapshots,Activity,Revisions,Locks}/**`,
`Teas.Domain/Documents/{Lifecycle,FieldDiff}.cs`, `Endpoints/Documents/DocumentsEndpoints.cs` (routes 10, 21–27, 32,
40–42), the three test descriptors (test project), the `drafts_in_month` checklist provider for SP4.1 (counts draft /
pending / approved documents dated in the month; warning; href = the first such type's list), agent hooks
(`IAgentPolicy` Off, `IAgentIssueGate` refusing), conformance lines, tests.
**Rules:** §4.2, §4.3, §4.4 (revise for N / L via the engine's revise step; the plan route is D6), §4.8 (activity,
revisions, audit), §4.9 snapshots, §4.13.
- [ ] **Step 1: Failing tests** — the §4.3.1 order (B-3: revision 0 has the look; the snapshot precedes the number); every
  refusal of issue / cancel / update / delete writes nothing (D-I9); `XL` cancel posts `Reverse(Today)`, a closed month
  shifts it late; an `XL` revise posts reverse + correction at the original date while open, late when closed; `XN`
  revise: no journal, label "ฉบับแก้ไขครั้งที่ 1", diff paths; omitted bank / dimensions = unchanged (D-F4); server-owned
  fields in bodies ignored (D-F5); version conflicts at the DB (two parallel issues of one draft → one 200, one 409);
  compute omits `journal` without `ledger.read`; `/ledger` checks read then `ledger.read`; list filters before paging;
  `drafts_in_month` counts; agent create refused (policy Off), agent issue refused `agent.review_required`.
- [ ] **Steps 2–5**, gates as D2. **Step 6:** `feat(documents): descriptor engine, lifecycle and history`.

### Task D5: Approval

**Depends on:** D4. **Blast cap:** 10 files. **Tier 2:** Opus review. **Files:** `Teas.App/Documents/Approval/**`,
`Endpoints/Settings/ApprovalsEndpoints.cs` (routes 14–17), routes 28–31, tests.
**Rules:** §4.6 (mock `engine/approval.ts` verbatim incl. P-06 and C1; tolerance setting).
- [ ] **Step 1: Failing tests** — every §4.6 rule; snapshot frozen at submit (raise the threshold after → still needs
  approval); self-approval off blocks creator / money editor / submitter, not a notes-only editor; approve-and-issue
  allocates one number; send back drops approval + policy; editing an approved draft returns it to draft; revise above
  approved without the right → 422; with the right → re-stamped approval + policy; D-I2 with single-fault tampers;
  settings versioning (self-approval group version) and audit.
- [ ] **Steps 2–5**, gates as D2. **Step 6:** `feat(documents): approval policy`.

### Task D6: Correction plans, reissue, conversions, marks, chain, open items

**Depends on:** D5. **Blast cap:** 16 files. **Tier 2:** Opus review. **Files:**
`Teas.App/Documents/{CorrectionPlans,Conversions,Marks,Chain,Outstanding}/**`, routes 33–39, 53, tests (with `XN`, `XL`,
`XT`).
**Rules:** §4.4, §4.7; mock `engine/{corrections,chain,marks}.ts` generic parts verbatim; T-class fiscal steps come
from the descriptor hook (`XT` = reissue only).
- [ ] **Step 1: Failing tests** — plan: unchanged → 0 steps; N / L → one revise; `XT` fiscal → reissue (new number at
  the original date, old `replaced` + reversal, `replaces` link, links carried); execute rebuilds and compares
  (stale → 409); a step failing mid-plan rolls back every write and number (D-F6) and the plan stays for retry; single
  use; missing step permission → 403 naming it; conversions (remaining, over-conversion, drafts reserve, cancel
  releases, progress counts live only); marks and close remainder rules; chain both directions with inactive edges; D-I3,
  D-I4, D-I5 (`XL` outstanding with a test settles link); open items: no registered outstanding type → 422
  `doc.open_items_query`.
- [ ] **Steps 2–5**, gates as D2. **Step 6:** `feat(documents): corrections, conversions and the document chain`.

### Task D7: The journal voucher

**Depends on:** D6. **Blast cap:** 12 files. **Tier 2:** Opus review (money) + blind acceptance tester (§4.11, D-I10).
**Files:** `Teas.App/Documents/Types/Jv/**` (descriptor, posting, reversal, auto-reversal, finality lock + the
`IJvFinality` hook SP4.6 uses, paper), route 54, conformance lines, tests.
**Rules:** §4.11; mock `engine/journal.ts` + `paper.ts journalPaper` verbatim; the descriptor registered in production.
- [ ] **Step 1: Failing tests** — unbalanced refused with the difference; one side per line; control accounts (1130,
  2110, 2140, 1140, 2180, 1170, 2151, 2131, 1121, 1110, 1210, 1211, 2160, 2170, 3300, 3900) refused with their owner
  text at compute and issue; 5120 / 2120 / 3200 / 4100 / 5170 allowed; journal = lines (party ignored); reverse: default
  date, earlier date refused, a TI-type id on `/docs/JV/{id}/reverse` → 404, reversal of a reversal once, a reversed JV
  final; auto-reverse created in the same command (day 1 next month), refused when that month is closed, kept in step by
  revise (date / lines) and cancel / turn-off; the JV paper (lines, two totals, accrual note, signatures, issuer line);
  approval on JV (enable a rule → submit / approve path works); D-I10 single-fault tampers; agent create refused.
- [ ] **Steps 2–5**, gates as D2. **Step 6:** `feat(documents): journal vouchers, reversal and auto-reversing accruals`.

### Task D8: Attachments, print log, paper and templates, public links

**Depends on:** D7. **Blast cap:** 16 files. **Tier 2:** Opus review (security: public links, file handling).
**Files:** `Teas.App/Documents/{Attachments,Prints,Papers,PublicLinks}/**`, `Endpoints/Settings/TemplatesEndpoints.cs`
(routes 18–20), routes 43–52, tests.
**Rules:** §4.8 print log, §4.9 paper + templates, §4.10 (SP3 S13 verbatim; magic bytes; 1 MB; nosniff).
- [ ] **Step 1: Failing tests** — attachment MIME by magic bytes (a PNG renamed `.pdf` with PDF mime → refused; SVG
  refused), > 1 MB refused, content route streams the bytes with nosniff, another company's attachment id → 404, a draft's
  attachments survive issue and go with a deleted draft, add / remove audited; print: first live print original, later
  copies, cancelled always copy, draft 409, barrier race → one original (D-I12); paper from stored values only (rename
  the company / replace the logo after issue → same paper), template toggles applied at print, signature only on the
  issuer line, stamp placement, missing file → no image; template preview writes nothing; public links: type list,
  live only, token never stored / logged / audited, one identical 404 for unknown / revoked / cancelled (D-I11),
  sessionless page is a copy of the document's own company only, rate limit per IP, agent refused.
- [ ] **Steps 2–5**, gates as D2. **Step 6:** `feat(documents): attachments, print log, papers and public links`.

### Task D9: Live switch, e2e, SP4.2 gate

- [ ] `live-routes.ts` += routes 1–52, 54 (route 53 stays on MSW until SP4.3 registers an outstanding type; the generic
  `/docs/{type}*` routes go live for `JV` only — the live-route switch matches `{type}` = `JV`; every other type stays on
  MSW).
- [ ] e2e in hybrid on the composed stack (CI): create / edit / deactivate a customer, vendor, item, bank account; change a
  numbering format (notice), approvals rule + self-approval; JV: keyboard entry, control-account refusal, issue, print
  original then copy, reverse from the ledger tab, auto-reversing accrual; attach a file, download it; templates toggle.
- [ ] Consolidated gate (Haiku): §11 green on CI. Tier 2 escalated review (`tier2-review.js`, lenses: lifecycle / money,
  numbering legal series, tenancy / RLS, security (files, public links), contract conformance).
- [ ] Staging deploy + §12 probe through the public domain; DoD §10 ticked with evidence; demo to Ham.

### Task D10: Deferred flexibility rows (only after Ham approves their mock screens — S2)

FG-05c grid paste (frontend kit only), FG-06a bulk approve / print (client loop over routes 29 / 47 — no new route),
FG-06b list CSV export (new route `GET /docs/{type}/export`, contract 1.1 by ADR), FG-10f units of measure (new record
kind `unit`, contract 1.1 by ADR). Each: mock screen → Ham screenshot approval → ADR + minor version → task brief. Not
part of the 1.0 freeze.

## 14. Open questions for Ham

| # | Question | Recommendation |
|---|---|---|
| Q-D1 | Attachments: keep the upload as a base64 data URL in JSON (≤ 1 MB, as approved for the company images in SP3 Q7), but stop sending the bytes back in lists — each attachment gets a download link (`contentUrl`) instead (master plan §2.7 asked SP4.2 to decide) | Approve |
| Q-D2 | Approval rules exist today only for EX and PV (the settings page edits only rows that exist), so approval cannot be switched on for a JV or any other type although 16 types have an approve right. Give every company one row per approvable type it can use, all OFF (D-12), so the page lists them — a visible change to the approvals page (mock screenshot first)? Or keep EX / PV only | One row per approvable type, all off (screenshot first) |
| Q-D3 | A tax invoice / receipt edited in place for a non-fiscal field (notes, reference, due date): the mock re-takes the seller name, the logo / signature AND the customer's details from the master at that moment; charter I3 says supplier and buyer snapshots are frozen at issue. Keep the issue-time seller, look and customer on T-class documents (proposed, enforced by a DB trigger), re-take only on N / L revisions | Keep issue-time for T-class |
| Q-D4 | Charter §7.12 says a reason is mandatory after issue; the approved flow never asks — every revise is recorded with "แก้ไขตามแผนการแก้ไข". Add a reason box to the correction panel (mock screen first), or record the fixed text (ADR-0008)? | Record the fixed text now; reason box later with a mock screen |
| Q-D5 | Which bank account is the company default is only set by the seed / onboarding; no screen changes it and it cannot be deactivated. Add "set as default" to the bank account screen (mock first), or leave to SP4.11 onboarding? | Leave to SP4.11 |
| Q-D6 | Series per branch (D-03-2): the series key carries a branch column fixed at `00000` until SP-R rules (both answers then become a setting, no migration). Confirm | Confirm |
| Q-D7 | The approved mock has no internal notes / comments thread on a document ("notes" = the printed note). Leave it out (a feature would need a mock screen first)? | Leave out |
| Q-D8 | FG-05c / FG-06a / FG-06b / FG-10f (B-1 rows placed in SP4.2) need mock screens before their backend; schedule them as D10 after the 1.0 freeze (each an ADR + minor version)? | Yes |
| Q-D9 | Record every row of §9 (CD-1 … CD-12) in ADR-0008 | Yes |

## 15. Attempt log

- 2026-10-27 — drafted (opus designer) from SP0, the master plan, SP3, SP4.1 (this session), the SP1c mock at main c4843dd
  (`domain/**`, `lib/api/**`, `records/**`, `descriptors/**`, `mocks/engine/{commands,corrections,numbering,approval,look,
  paper,attachments,chain,marks,locks,journal,log}.ts`, `mocks/records/{parties,items,bank-accounts,registry}.ts`,
  `mocks/handlers/**`, `mocks/store.ts`), the 00 / 01 / 02 (engine) / 05 AC1 / 09 group plans, briefs, reports and Opus
  reviews (digested), the parity checklist and troubles-wiki. Docs only; nothing built or run.

## Ham rulings 2026-10-27

Approved as recommended: Q-D1 (attachments as download links in lists), Q-D2 (one approval row per approvable type for every company, all OFF — the approvals page changes: mock screenshot to Ham before the freeze), Q-D3 (tax documents keep issue-time seller / look / customer; notes-only edits never re-take them), Q-D4 (fixed reason text after issue for now), Q-D5 (default bank account → SP4.11), Q-D6 (branch column fixed 00000), Q-D7 (no internal notes thread), Q-D8 (FG-05c / 06a / 06b / 10f after the freeze, once their mock screens are approved), Q-D9 (§9 into ADR-0008).
