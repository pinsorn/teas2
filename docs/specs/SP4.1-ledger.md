# SP4.1 — Ledger

| | |
|---|---|
| Status | Draft for Ham, 2026-10-27 |
| Owner | Ham |
| Implements | `docs/specs/SP0-charter.md` §5.1–5.8 (§5.9 reverse / accrual: see §2), §5.13 (GL binding rule), §6.2 I12 (GL side), §10.3, §11.4 item 2; master plan `docs/plans/2026-10-27-sp2-contract-freeze.md` §2.3 (`ledger.ts`), §3.1 row 2, Ham rulings 2026-10-27 (Q-M2 JV → SP4.2, Q-M3 calendar year) |
| Depends on | SP3 (platform contract frozen; tasks P1–P6 built: tenancy / RLS harness, errors, idempotency, concurrency, audit, catalog). Builds beside SP3 P7–P11 only on a separate DB (see §11) |
| Blast cap | Per task (each names its own; hitting it = stop and re-spec). Spec-wide: `backend/src/Teas.Domain/Ledger/**`, `backend/src/Teas.App/Ledger/**`, `backend/src/Teas.Api/Endpoints/Ledger/**`, `backend/src/Teas.Migrator/**` (ledger migrations, catalog file), `backend/tests/**/Ledger/**`, `frontend/src/contract/ledger.ts` + its conformance / test files, the frontend files named in L0. **API changes:** exactly the ledger contract of §5 (frozen at Ham's approval); anything else = ADR + version (master plan §2.4) |

## 1. Goal

Build the one ledger every module posts through: the chart of accounts (created from the Thai SME template at company
creation), the posting kernel (the only writer of journal entries) with its one resolver (roles → accounts through
posting rules), posting rules and expense categories, dimensions and their account rules, the party identity journal
lines carry, monthly periods with close / reopen and the year-end close, and the trial balance / general ledger /
general journal. Behaviour is what the approved mock does (SP1c groups 00 F4, 05 AC1–AC7, 09 ST2, 08 RP1 and their
Opus reviews), hardened where a database must differ (locking, append-only storage, one status per error code).

## 2. Scope

| In SP4.1 | Not in SP4.1 (owner) |
|---|---|
| Kernel `Post` / `Preview` / `Reverse`, placement rules, period locks, the resolver, `postedAccount` resolution API | The posting builders of each document type (each SP4.x module that owns the type) |
| Chart of accounts + the `thai-sme` template, accounts routes, `journal-accounts`, `postable-accounts` lists | The JV **document** (number, revisions, reverse, auto-reverse, paper) — SP4.2 D7 (Ham Q-M2, ADR-0007) |
| Posting rules, posting preview engine (answers only for types whose builder is registered), expense categories | Opening-balance batch (SP4.11), fixed assets / depreciation / schedules (SP4.6), bank journals (SP4.5), filing entries (SP4.8), payroll payments (SP4.7) — they post through this kernel |
| Dimension types / values / account rules, the dimension-rule judge (`DimensionProblems`) | Party master maintenance — customers / vendors routes (SP4.2), employees (SP4.7) |
| `parties` core table (identity the ledger references) | `/reports/*` other than TB / GL / GJ (SP4.9); reopen-history and audit-log reports (SP4.9) |
| Periods, the checklist registry (all six codes), close / reopen of a month, year close / reopen | The six checklist providers (SP4.2 drafts, SP4.5 bank, SP4.6 depreciation + schedules, SP4.8 filings, SP4.11 OB) |
| Trial balance, general ledger, general journal + CSV export | Agent policy / review (SP4.10) |

Charter §5.9 (adjustment tooling) splits: the kernel-level reversal (`Reverse`) is here; "กลับรายการ" on a JV and the
auto-reversing accrual are JV-document commands in SP4.2 (mock: `reverseJv`, `postAutoReversal` only accept a JV).

## 3. Context and footguns (read before any task)

| # | Footgun | Where it bites | Rule |
|---|---|---|---|
| L-F1 | SP3 F1–F7 (superuser tests, `''::uuid`, leaked GUC, no-transaction reads, FORCE RLS on the migrator, template clone, `__EFMigrationsHistory`) | every DB task | SP3 §3 applies verbatim; every new tenant table goes through `RlsSql.TenantTable` and gets a `TenantRowFactory` method in the same task (SP3 P2 rule) |
| L-F2 | troubles-wiki "TypeError … `settles` link's `from` can be a SETTLEMENT RECORD" + "a GL helper that sums only `st.journals` misses settlement journals" | TB, GL, every GL tie | the mock has five journal stores unioned by `companyEntries`; the backend has ONE table pair (`journal_entries`, `journal_lines`) keyed by `source_kind` + `source_id`; every reader reads that table, never a per-module store |
| L-F3 | troubles-wiki "A report tie-out is red after cancelling a document on the real clock" | any "when did the reversal hit the GL" | there is no computed `withReversal` in the backend: a reversal exists only as a stored entry; readers read `journal_entries.date`, never `cancel.at` |
| L-F4 | troubles-wiki "An invariant GL(X) = Σ documents goes red after an opening balance" | every document-vs-GL tie (SP4.3+) | the property-test harness (L2) exposes `GlBySource(company, account, excludeSourceKinds)`; a tie subtracts what `source_kind = 'opening'` posted, as the mock's `obGl` / `obCredit` do |
| L-F5 | `numeric(18,2)` silently ROUNDS `1.005` to `1.01` on insert | kernel | sub-satang never reaches the DB: the kernel takes `Money` (SP3 P1, refuses 3 dp) and the domain test feeds `1.005` → refused before SQL |
| L-F6 | Invariants keyed on literal codes (`1130`, `2110`, `2180`, `1170`) in the mock's `checkInvariants` 4 / 4b / 4c / 4e, while `itemKinds` resolves by role | invariant tests, control-account checks | the backend resolves a control account by ROLE (`ControlAccounts(company)` = the keyless default rule of each item role ∪ accounts with `control_role`), never by code (a company may map AR elsewhere while unused) |
| L-F7 | `period.year_closed` is thrown with 409 (already closed, `closeYear`) AND 422 (posting into a closed year) in the mock; SP3's registry maps one code → one status | error registry | split: `period.year_already_closed` 409 for `closeYear`; `period.year_closed` stays 422 (contract delta §5.1; mock conforms in L0) |
| L-F8 | AC2 F1: renaming header 1100 emptied the bank GL list (engine code keyed on a header code) | any account lookup | find accounts by `class` + `sub_class` / role, never by a parent or header code |
| L-F9 | Mock `JSON.stringify(dims)` key order decides whether two journal lines merge | kernel merge | merge key uses canonical (sorted-key) dimensions; line order = first appearance of each merge key (readers compare in order) |
| L-F10 | A reader that re-derives an account from today's rules (AC4 carry, closed by ST2c) | SP4.4 / SP4.6 | `postedAccount` is the kernel's own resolution, returned by `Post` for every role line that carries a `sourceLineId`; no second resolver call exists (architecture test: `PostingResolver.Resolve` is called only from `LedgerKernel`) |
| L-F11 | Period close racing an issue in the same month (mock is single-threaded; invariant 7 `postedAt ≤ closedAt` would break) | kernel, close | advisory locks (§4.6): posters take SHARED year + month locks, closers take EXCLUSIVE; lock order year → month |
| L-F12 | troubles-wiki "StringBuilder.AppendLine breaks cross-platform text snapshots" | CSV export | append `"\r\n"` explicitly (RFC 4180, the mock's `reportCsv`) |
| L-F13 | troubles-wiki "A new permission code fails `permissions.test.ts`" | all | SP4.1 adds NO permission code (every code used is in SP3's frozen catalog — §5.4) |
| L-F14 | AC6 carry: invariant 7 never looked at year-close entries, and they post into closed months by design | invariants, kernel | `source_kind = 'year_close'` (and `'opening'`) is exempt from the closed-month posting check and from invariant L-I7 — by an explicit placement value, not by a type test |
| L-F15 | Mock `posted()` = "any line EVER on the account" (not balance ≠ 0) for `posting.control_in_use` | posting rules | kept (ST2b ruling 1); the guard's exit is restated honestly in §7 (the binding is permanent; rename / remap stay free) |
| L-F16 | Workers never `git worktree add/remove`, never commit (SP3 F14) | all | controller commits |

SP-R points touching SP4.1 (master plan §3.1): **D-15-3** (is the 2566 DBD notice current) changes the seeded VALUES of
`dbdLine` / `pnd50Box`, not the schema — the template file carries them tagged `[SP-R]`; **fiscal year** stays calendar
only (ADR-0006, Ham Q-M3).

## 4. Design

### 4.1 Code layout (inside SP3's solution)

```
backend/src/Teas.Domain/Ledger/   AccountClass, SubClass, AccountingRole, RoleFit (ROLE_FIT), ControlExit, ControlRoles,
                                  PostingLevel, Placement, JournalMath (merge, mirror, balance), RuleLabel (Thai rule text)
backend/src/Teas.App/Ledger/      LedgerKernel (+ PeriodGate), PostingResolver, Accounts, PostingRules, ExpenseCategories,
                                  Dimensions (+ DimensionJudge), Periods (+ ChecklistRegistry, YearClose), Reports (Tb, Gl, Gj),
                                  LedgerCompanyInitializer, Extension points (§4.8)
backend/src/Teas.Api/Endpoints/Ledger/  AccountsEndpoints, PostingEndpoints, DimensionEndpoints, PeriodEndpoints, LedgerReportEndpoints
backend/src/Teas.Migrator/        migrations 0101–0104, Catalog/ledger-template.thai-sme.v1.json, verb `seed-ledger`
```

### 4.2 The posting kernel — the only writer of journal entries (§5.2)

```csharp
public enum SourceKind { Document, Opening, YearClose, Settlement, BankJournal, Filing, PayrollPayment, Test }
public sealed record PostingSource(SourceKind Kind, Guid Id);
public enum EntryKind { Original, Reversal, Correction }
public enum Placement { Strict, Late, AtDate, YearClose }          // §4.3
public enum ManualScope { None, Jv, Inline }                        // which controlExit scope judges AccountLines
public abstract record IntentLine;
public sealed record RoleLine(AccountingRole Role, long DebitSatang, long CreditSatang, ResolveContext Ctx,
    Guid? PartyId, Guid? OpenItemId, IReadOnlyDictionary<string,string>? Dimensions, string? SourceLineId) : IntentLine;
public sealed record AccountLine(string AccountCode, long DebitSatang, long CreditSatang, string Rule,
    Guid? PartyId, Guid? OpenItemId, IReadOnlyDictionary<string,string>? Dimensions, string? SourceLineId, string? Description) : IntentLine;
public sealed record ResolveContext(DocType? DocType, string? ItemId, string? ExpenseCategory, string? AssetClass,
    string? PartyGroup, string? BankAccountId, WhtForm? WhtForm, DisposalOutcome? Outcome);
public sealed record PostingIntent(PostingSource Source, EntryKind Kind, BusinessDate Date, Placement Placement,
    int? Revision, ManualScope Manual, IReadOnlyList<IntentLine> Lines);
public sealed record PostedEntry(Guid EntryId, JournalEntryPreview Entry, IReadOnlyDictionary<string,string> AccountBySourceLine);

public interface ILedgerKernel {
  PostedEntry Post(PostingIntent intent);                    // validates, places, locks, writes, returns the stored entry
  JournalEntryPreview Preview(PostingIntent intent);         // the SAME pipeline without locks or writes ("ดู JE")
  PostedEntry Reverse(Guid entryId, ReversalWhen when);      // exact mirror of a stored entry (§4.3)
}
public enum ReversalWhen { Today, Original, AtOriginalExempt, YearEnd }   // user cancel | correction | OB | year reopen
```

Pipeline of `Post` (one transaction — the caller's command transaction; the kernel never opens its own):
1. **Resolve** every `RoleLine` through `PostingResolver.Resolve(role, ctx ∪ {companyId})` (§4.4). `AccountLine`s are
   taken as written. A role line with a `SourceLineId` records `AccountBySourceLine[sourceLineId] = code` — the ONE
   resolution `postedAccount` is stamped from (ST2c N1; SP4.4 stamps it, never resolves again).
2. **Party snapshot**: for a line with `PartyId`, `party_name` = the party's name NOW (frozen on the line); a party of
   another company → 500 `ledger.invariant` (bug, never user input).
3. **Merge** lines by key `(code, rule, partyId, openItemId, canonical(dimensions))`, summing `debit − credit`; a net 0
   line is dropped; a negative net posts on the credit side (never a negative amount); line order = first appearance.
4. **Place** the date (§4.3), taking the period locks (§4.6).
5. **Validate** (every check is a named test, §6): Σ debit = Σ credit (`ledger.invariant` 500 — a builder bug); each
   amount ≥ 0, 2 dp, one side only; every account exists in the company, is postable (`ledger.account_invalid` 422);
   active — except a `Reversal` (an exact mirror may hit an account deactivated since); a resolved role line's account fits
   the role (`posting.class_mismatch` 422 — hardening, see §9 C-5); an `AccountLine` with `Manual ≠ None` is not
   controlled for that scope (`ledger.control_account` 422, message = `ControlExit` text); a line on an ITEM control
   account (§4.4) carries `PartyId` + `OpenItemId` (`ledger.invariant`); every dimension tag names a type and value of
   the company, active or not (`ledger.invariant` — new tags are judged by `DimensionJudge` before the kernel); an
   entry with no line is refused except `SourceKind.YearClose` (AC6 ruling: an empty closing entry is allowed).
6. **Write** one `journal_entries` row (`seq` = next per source) and its `journal_lines`; `posted_at` = the clock now
   (`TimeProvider`, never caller-supplied); the deferred constraint trigger (§4.9) re-checks Dr = Cr at commit.

`Preview` runs steps 1–3 and the date part of 4 without locks; it may return a `missing` reason instead of throwing
(the editor's "ดู JE").

### 4.3 Placement and reversal dates (mock `dateGuards`, `placed`, `reverseEntry`, `correctionReversal`)

`FirstOpenDate(company)` = the first day of the earliest month ≥ the business date's month whose period row is not
`closed` (a month without a row is open). `YearClosed(company, y)` = a live `year_closes` row for `y`.

| Placement | Used by | Rule |
|---|---|---|
| `Strict` | issue; a revise that moves the date (SP4.2) | `YearClosed` → 422 `period.year_closed` (exit: reopen the year); month closed → 422 `period.closed` naming the month and `FirstOpenDate` (exit: change the date or reopen). The kernel never checks "future": the document engine does (`doc.future_date`), because the auto-reversal is a future-dated system entry |
| `Late` | correction entries, every reversal except the OB and year rows below | `YearClosed(date)` → 422 `period.year_closed`; month closed → date := `FirstOpenDate`, `late = true`; then every registered `IPlacementFloor` (SP4.5 bank go-live) may move the date later (sets `late`); then the closed-month shift again (the mock applies shift → floor → shift) |
| `AtDate` | opening balance (D-10 exemption, SP4.11) | any month state; `YearClosed` → 422 `period.year_closed` ("the D-10 exemption ends at a closed year", AC6) |
| `YearClose` | the closing entry and its reversal | the year's twelve months are closed by precondition; no month check; exempt from L-I7 |

`Reverse(entryId, when)` writes the exact mirror (debit ↔ credit, `rule` + `" (กลับรายการ)"`, every other column copied)
as a new entry of the same source with `kind = Reversal`, `reverses_entry_id = entryId`:

| `when` | Date asked | Then |
|---|---|---|
| `Today` (user cancel) | the business date, unless the original's month is closed → `FirstOpenDate`, late | `Late` placement |
| `Original` (correction, plan cancel, system cancel) | the original entry's date | `Late` placement |
| `AtOriginalExempt` (OB revise / cancel) | the original's date | `AtDate` placement |
| `YearEnd` (year reopen) | Dec 31 of the year | `YearClose` placement |

Every `when` except `YearEnd` first refuses an original dated in a closed year (422 `period.year_closed`, AC6 F4 — one
guard on every reversal path: settlement, transfer, fee, undispose, reissue). A second reversal of the same entry →
500 `ledger.invariant` (callers check finality first: SP4.2 `ledger.already_reversed` etc.).

### 4.4 Resolver, roles, control accounts (§5.5; ST2 / ST2b rulings)

- `AccountingRole` = the 34 roles of mock `engine/posting.ts` (contract §5.1). `ROLE_FIT` = mock table verbatim (Expense
  also accepts sub-class `prepayment`, AC4).
- **Resolution** (`PostingResolver.Resolve`, first match wins): `item` (key = item id) → `category` (key =
  expenseCategory, then assetClass) → `partyGroup` → `docType` → `default` with keys tried in order
  `whtForm`, `bankAccountId`, `outcome`, then keyless. A hit on a missing / non-postable account → 422
  `posting.invalid_rule` ("กฎบัญชี … ชี้ไปยังบัญชีที่ไม่มีหรือลงบัญชีไม่ได้"); no hit → 422 `posting.unresolved`.
  Result: `{ code, name, rule: "<level Thai>[ <key>]: <Role> → <code>", level, key? }`; the line stores `role`, `rule`,
  `rule_level`, `rule_key` as columns (nothing ever parses the Thai text — ST2b r8).
- **Rule save** (`RoleProblem`): account exists, postable, active (`posting.account_invalid`); class fits
  (`posting.class_mismatch`); an account whose `control_role` is set stands behind THAT role only
  (`posting.control_account`, ST2b M1).
- **Control roles** (`CONTROL_ROLES`, 20 roles, mock `mocks/records/posting-rules.ts` verbatim): default level only
  (`posting.control_level`); create of a keyed default refused while the keyless fall-through account OR the new account
  holds any posted line; update refused while the old OR the new account holds any posted line; delete of a keyed
  control default refused while its account holds any posted line (all `posting.control_in_use` 409). Free roles move at
  any level and apply to the next posting only.
- **Bank binding** (`PostingRules.BindBank(bankAccountId, accountCode)`, called by SP4.2's bank-account create / update in
  the same transaction): runs `RoleProblem(Cash, account)` (closes the 09-settings open gap — the mock let a bank be
  created on 1130), then upserts the `default`-level `Cash` rule keyed by the bank account id. Not a route; no audit row of
  its own (the record command's audit covers it).
- **Item control accounts** (open-item tag rule, invariant 23): `ITEM_ROLES = {AR, AP, CustomerDeposit, VendorPrepayment}`;
  `ControlAccounts(company)` = for each item role the account of its keyless default rule ∪ accounts whose
  `control_role` is an item role.
- **`ControlExit(company, code, scope)`** = mock `controlExit` verbatim (scopes `inline` / `jv`): derived from the account's
  `control_role` ∪ every role a rule points at it ∪ its sub-class. Its Thai texts are the exits users see.
- Every rule / category / dimension change applies to the NEXT posting only; nothing re-reads a stored line.

### 4.5 Chart of accounts (§5.4; AC2, AC7c rulings)

- Account = `code` (4–6 digits, unique per company), `name_th`, `name_en?`, `parent` (a header, same group), `postable`,
  `class` (12), `sub_class` (mock `SUB_CLASS_GROUP` keys), `control_role?` (template only; never from a body),
  `dbd_line?`, `pnd50_box?` (values `[SP-R]` D-15-3), `dimension_rules jsonb`, `active`, `version`.
- **Used** = any `journal_lines` row of the company on the account (any source). Once used: code, class, sub-class,
  postable and the class of the parent are read-only (`account.in_use`); the name and statutory mapping stay editable.
- A controlled account (`ControlExit` in either scope) never changes class / sub-class, used or not (`account.controlled`).
- Code change while unused is refused while anything claims the code (`IAccountClaim` providers, §4.8): a posting rule
  (`account.mapped`), a bank account (`account.bank_bound`, SP4.2), a control role (`account.mapped`), a live schedule
  (`account.scheduled`, SP4.6). Sub-accounts follow a header's new code.
- Parent / postable / group rules: mock `accountImpl.validate` verbatim (a postable account sits under a header; a header
  with children stays a header of its group; no cycle; a used account moves only under a header of its parent's class).
- **Deactivate** (refusal order, each with its exit, §7): claims → live children (`account.has_children`) → non-zero
  balance (`account.has_balance`, exit = `ControlExit` owner text or "โอนยอดออกด้วยสมุดรายวัน"). Being used alone is never
  a refusal.
- **Template**: `thai-sme` v1 = mock `fixtures/coa.ts` (8 headers + 58 postable accounts = 66, classes, sub-classes, control
  roles, statutory mapping) + mock `fixtures/posting-profiles.ts` minus the bank-keyed Cash rules + `EXPENSE_CATEGORIES`
  + dimension types `department` / `project` and their five values. Stored as ONE global catalog row (§4.9) synced by
  the migrator from `Catalog/ledger-template.thai-sme.v1.json`; a frontend vitest asserts the JSON equals the mock
  fixtures (parity gate, L1).

### 4.6 Periods, locks, close / reopen, year close (§5.8; AC6 rulings)

- A period row = `(company, month 'YYYY-MM')`, `status open|closed`, `closed_at`, `closed_by`, `acknowledged`, `version`.
  A month without a row is open. Rows of a calendar year are created idempotently (`INSERT … ON CONFLICT DO NOTHING`)
  by `EnsureYear(company, y)`: at company creation (the business date's year), by `GET /periods?year=y`, and by
  close / reopen. Posting never creates rows (mock: a month with no row is open and does not enter the close order).
- **Locks** (advisory, transaction-scoped; key = `hashtextextended(company_id::text || '|' || k, 0)`, `k` = `'Y'||year` or
  the month): the kernel takes `pg_advisory_xact_lock_shared` on the entry's year key, then its month key, before
  reading the period state; month close / reopen take the year key SHARED then the month key EXCLUSIVE; year close /
  reopen take the year key EXCLUSIVE. Always year → month (no lock cycle). A PG deadlock (`40P01`) maps to 409
  `record.version_conflict` (retry).
- **Close a month**: 404 `period.not_found` (malformed month or no row); 409 `period.already_closed`; 422 `period.order`
  if an earlier row is open (closed months are a prefix of the rows); checklist (§4.7) computed AFTER the lock:
  any blocking item with count > 0 → 422 `period.blocked` (title lists each item and its `href`); the request's
  `acknowledge` must equal the current warnings with count > 0 as a set of `code:count` (both empty is equal) else 422
  `period.warnings`; then `status = closed`, `closed_at = now`, `closed_by`, `acknowledged` = the warnings as they were
  (frozen). Audit `period.close` (before `{status:'open'}`, after `{status:'closed', acknowledged:['code:count']}`).
- **Reopen a month**: 409 `period.not_closed`; 422 `period.reason_required`; 422 `period.year_closed` if its year has a
  live close (exit: reopen the year); 422 `period.reopen_order` unless it is the latest closed row; then
  `status = open`, clear `closed_*` and `acknowledged`, append `period_reopens (at, reason, by)`. Audit `period.reopen`.
- **Close a year** `y` (calendar, ADR-0006): 404 `period.not_found` unless all twelve rows exist; 409
  `period.year_already_closed`; 422 `period.year_months_open` naming the first open month; 422 `period.year_not_ended`
  if `y-12-31` > business date; 422 `period.year_order` if an earlier year that has rows has no live close. Then build
  the closing entry from the balances of the year of every OTHER entry (year-close entries excluded):
  per revenue / expense account (group by class) with balance `v ≠ 0` a line of `−v` against the current-year account;
  `cr` (expenses closed) → Dr 3300 line, `dr` (revenue closed) → Cr 3300 line; net = dr − cr; if net ≠ 0 the transfer
  pair 3300 ↔ 3200. Rules (Thai) as mock `closingLines`. The current-year and retained accounts are the first postable
  accounts (by code) of sub-class `current-year` / `retained`. Post with `SourceKind.YearClose`, `Placement.YearClose`,
  date Dec 31; store `year_closes(net, entry_id, closed_*)`. Audit `period.year_close` `{id, net, lines}`.
- **Reopen a year**: 409 `period.year_not_closed`; 409 `filing.locked` if an `IYearReopenGuard` (SP4.8: ภ.พ.50 filed,
  TX3a ruling 7) refuses; 422 `period.reason_required`; 422 `period.year_order` if a later year is closed; then
  `Reverse(entry, YearEnd)` and set `reopened_*`. A re-close creates a new row; the old one stays reversed. Audit
  `period.year_reopen`.
- **Fiscal-year lock for SP3** (`CompanySettings.fiscalYearLocked`, `company.fiscal_year_locked`): `IFiscalYearLock` =
  any `closed` period row of the company (mock `fiscalYearLocked`); L5 registers it in place of SP3's interim `false`.

### 4.7 Checklist registry

`ChecklistItem.code` is a closed union of six (contract). `IChecklistProvider { Code; Severity; Count(company, month);
Href(company, month) }`; the registry ALWAYS returns all six in the mock's order. A code with no registered provider
answers `count: 0` and `note: "ยังไม่เปิดใช้ (SP4.x)"` (the mock's `note` field — "a check that waits for a later
group"). Severity is the provider's: `depreciation_not_run` is the only blocking one (SP4.6). SP4.1 registers none; the
owners: `drafts_in_month` SP4.2, `unreconciled_bank_lines` SP4.5, `depreciation_not_run` + `schedules_not_run` SP4.6,
`filings_not_finalized` SP4.8, `ob_difference_open` SP4.11.

### 4.8 Extension points SP4.1 owns (later modules plug in; none reaches into ledger tables)

| Interface | Purpose | First implementer |
|---|---|---|
| `IAccountClaim` | names who holds an account code (code change / deactivate refusals) | SP4.1 (rules, control role); SP4.2 bank accounts; SP4.6 schedules |
| `IPlacementFloor` | a later earliest date for an entry touching an account | SP4.5 bank go-live |
| `IChecklistProvider` | §4.7 | SP4.2, 4.5, 4.6, 4.8, 4.11 |
| `IYearReopenGuard` | refuses a year reopen | SP4.8 (ภ.พ.50) |
| `IPostingKeyDirectory` | validates `item` / `bankAccountId` keys of a rule | SP4.2 (items, bank accounts); until then those keys → `posting.key_invalid` |
| `IPostingPreviewBuilder` | builds the sample intent of a doc type for `/settings/posting/preview` | each type's module; no builder → 422 `posting.preview_type` |
| `IDimensionUsage` | "in use" for a dimension type / value (documents, schedule templates) | SP4.2, SP4.6 |
| `ICategoryUsage` | "in use" for an expense category (document lines, items) | SP4.2 (items), SP4.4 |

### 4.9 Database (SP3 §4.2 conventions: `uuid` ids, `numeric(18,2)` money, `timestamptz`, `date`)

| Table | Scope | Key columns |
|---|---|---|
| `ledger_templates` | global catalog (allow-list: "COA template, read-only reference") | `(code, version) PK`, `body jsonb`, `sha256 bytea` |
| `accounts` | tenant | `company_id`, `id`, `code text` (`UNIQUE (company_id, code)`), `name_th`, `name_en`, `parent_id NULL`, `postable`, `class`, `sub_class`, `control_role NULL`, `dbd_line NULL`, `pnd50_box NULL`, `dimension_rules jsonb NOT NULL DEFAULT '{}'`, `active`, `version` |
| `posting_rules` | tenant | `company_id`, `id`, `level`, `key text NULL`, `role`, `account_id`, `version`; `UNIQUE NULLS NOT DISTINCT (company_id, level, key, role)` |
| `expense_categories` | tenant | `company_id`, `code` (PK with company; immutable), `name_th`, `recoverable_vat`, `capex`, `asset_class NULL`, `default_wht_type NULL`, `parent_code NULL`, `active`, `version` (the account is the category-level Expense rule — one fact) |
| `dimension_types` | tenant | `company_id`, `key` (PK with company), `name_th` (`UNIQUE (company_id, name_th)`), `version` |
| `dimension_values` | tenant | `company_id`, `type_key`, `code`, `name_th`, `active`, `version`; PK `(company_id, type_key, code)` |
| `parties` (core; SP4.2 adds the master columns) | tenant | `company_id`, `id`, `kind ('customer'\|'vendor'\|'employee')`, `code`, `name`, `party_group NULL`, `active`, `version`; `UNIQUE (company_id, kind, code)` |
| `journal_entries` | tenant, append-only | `company_id`, `id`, `source_kind`, `source_id`, `seq int` (`UNIQUE (company_id, source_kind, source_id, seq)`), `kind`, `date`, `posted_at`, `late bool`, `revision int NULL`, `reverses_entry_id NULL` (`UNIQUE` where not null) |
| `journal_lines` | tenant, append-only | `company_id`, `entry_id`, `line_no` (PK with entry), `account_id`, `account_code`, `account_name` (snapshot), `debit`, `credit` (`CHECK (debit >= 0 AND credit >= 0 AND (debit > 0) <> (credit > 0))`), `role NULL`, `rule text`, `rule_level NULL`, `rule_key NULL`, `party_id NULL`, `party_name NULL`, `open_item_id NULL`, `dimensions jsonb NOT NULL DEFAULT '{}'`, `source_line_id NULL`, `description NULL` |
| `periods` | tenant | `(company_id, month char(7)) PK`, `status`, `closed_at NULL`, `closed_by jsonb NULL`, `acknowledged jsonb NOT NULL DEFAULT '[]'`, `version` |
| `period_reopens` | tenant, append-only | `company_id`, `id`, `month`, `at`, `reason`, `by jsonb` |
| `year_closes` | tenant | `company_id`, `id`, `year int`, `date`, `net numeric(18,2)`, `entry_id`, `closed_at`, `closed_by jsonb`, `reopened_at NULL`, `reopen_reason NULL`, `reopened_by jsonb NULL`, `reversal_entry_id NULL`; `UNIQUE (company_id, year) WHERE reopened_at IS NULL` |

Indexes: `journal_lines (company_id, account_code, entry_id)`, `journal_entries (company_id, date)`,
`journal_entries (company_id, source_kind, source_id)`, `journal_lines (company_id, open_item_id) WHERE open_item_id IS NOT NULL`,
`journal_lines (company_id, party_id) WHERE party_id IS NOT NULL`.

Grants: `teas_app` holds SELECT only on `ledger_templates` (a catalog, like SP3's `permissions`).
Append-only: `journal_entries`, `journal_lines`, `period_reopens` get the SP3 `audit_log` treatment (BEFORE UPDATE OR
DELETE row trigger and BEFORE TRUNCATE statement trigger that raise; `teas_app` holds INSERT, SELECT only).
`year_closes`: UPDATE allowed only from `reopened_at IS NULL` to setting the four `reopen*` / `reversal_entry_id`
columns (trigger compares every other column). Balance at commit:

```sql
CREATE FUNCTION teas.journal_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dr numeric(18,2); cr numeric(18,2);
BEGIN
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0) INTO dr, cr
    FROM teas.journal_lines WHERE company_id = NEW.company_id AND entry_id = NEW.id;
  IF dr <> cr THEN RAISE EXCEPTION 'ledger.invariant: entry % unbalanced (Dr % / Cr %)', NEW.id, dr, cr; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entry_balanced AFTER INSERT ON teas.journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION teas.journal_entry_balanced();
```
(It runs as `teas_app` under the inserting command's GUC, so RLS shows it exactly that company's lines.)

### 4.10 Runtime security context (SP3 §4.3 extended)

| Process | DB role | GUCs | Reads | Writes | How each satisfies RLS |
|---|---|---|---|---|---|
| Migrator `migrate` | `teas_migrator` | none | `ledger_templates` | DDL; catalog upsert of `ledger_templates` (global) | global → unfiltered; NO tenant rows written by a migration (SP3 F5) |
| Company creation (SP3 `CompanyFactory.Create`, onboarding SP4.11, tests) → `LedgerCompanyInitializer` | `teas_app` | `Enter(newCompanyId, adminUserId)` — set BEFORE the `companies` insert (SP3 P8), same transaction | `ledger_templates` (global) | `accounts`, `posting_rules`, `expense_categories`, `dimension_types`, `dimension_values`, `periods` (12 rows of the business date's year) | every insert carries `company_id = newCompanyId` = the GUC → WITH CHECK passes; a test asserts the counts after `Create` (an initializer that ran before `Enter` would fail WITH CHECK, not no-op) |
| Migrator verb `seed-ledger --company <id> \| --all-missing` (operator; only for a company created before SP4.1 deployed) | `teas_migrator` | `ForEachCompany` (SP3 §4.3): system read of `companies`, then per company `set_config('app.company_id', c, true)` in its own transaction | `accounts` count of the company | the same rows as the initializer, only if the company has 0 accounts | per-company GUC; prints and asserts the inserted counts; idempotent (a company with accounts is skipped) |
| API request (any ledger route, any kernel call from a module) | `teas_app` | session company (SP3 `TenantScope.Enter`) | tenant tables of the company | as the route | `company_id = current_company()` |
| Job runner (SP4.6 scheduled postings later) | `teas_app` | `Enter(job.company_id)` | — | kernel writes | inside the job's company (SP3 §4.3) |

### 4.11 Agent rules (SP3 §4.6 as they apply here)

- Every ledger write route is `agent: false`: `/settings/*` writes → 403 `agent.forbidden_setting`; account writes,
  period close / reopen, year close / reopen → 403 `agent.forbidden_action` — all refused before the body is read
  (SP3 S10). Their permissions are AgentForbidden anyway (`ledger.coa.manage`, `ledger.posting.manage`,
  `ledger.period.close`, `ledger.period.reopen`; `settings.manage` for dimensions — SP3 §4.5), so no key can carry them.
- GET routes are `agent: true` (mock `AGENT_ALLOWED`: every GET outside `/connect`, `/oauth`, `/auth`); the agent's
  effective rights decide (a GET whose permission is AgentForbidden — `/settings/posting/rules`,
  `/settings/dimensions/account-rules` — is mapped `agent: false`, since no key can ever pass it).
- No MCP tool in SP4.1 (tools ship with descriptors, SP4.2+). The kernel itself has no actor: it posts for whichever
  command called it; the caller's agent checks happen before.

## 5. Frozen contract — `frontend/src/contract/ledger.ts` (CONTRACT_VERSION `1.0`)

### 5.1 Types

Moved verbatim (names unchanged; the old modules `export * from '@/contract/ledger'`):
`JournalLinePreview`, `JournalEntryPreview`, `JournalPreview`, `ChecklistItem`, `PeriodMonth`, `YearCloseView`,
`PeriodsView` (`domain/types.ts`); `PostableAccount` (`lib/api/endpoints.ts`); `ACCOUNT_CLASSES`, `AccountClass`,
`AccountGroup`, `GROUP_OF`, `SUB_CLASS_GROUP`, `DBD_LINES`, `PND50_BOXES` (`records/accounts.ts`; the
`RecordDescriptor` stays there — UI metadata); `POSTING_LEVELS`, `PostingLevel`, `PostingRuleRow`, `PostingRulesView`,
`PostingPreviewRequest`, `PostingPreviewResult` (`records/posting-rules.ts`; `postingApi` stays); `DimensionRule`,
`DimensionValueRow`, `DimensionTypeRow`, `DimensionsView`, `AccountRuleRow` (`records/dimensions.ts`);
`ExpenseCategoryItem`, `ExpenseCategoriesView` (`records/expense-categories.ts`); `reportPermission`, `ReportKind`,
`ReportParamSpec`, `ReportColumn`, `ReportChip`, `ReportRow`, `TieOut`, `ReportModel` (`domain/reports.ts`; the tax /
catalogue types there stay for SP4.8).

Deltas from the mock (L0 makes the mock conform):

```ts
export type AccountingRole = 'AR' | 'AP' | 'Revenue' | 'SalesDiscount' | 'SalesReturn' | 'OutputVat' | 'InputVat'
  | 'InputVatUnclaimed' | 'WhtReceivable' | 'WhtPayable' | 'WhtExpense' | 'Pnd36VatPayable' | 'Cash' | 'CustomerDeposit'
  | 'VendorPrepayment' | 'Expense' | 'FixedAsset' | 'AccumulatedDepreciation' | 'DepreciationExpense' | 'DisposalGainLoss'
  | 'SalaryExpense' | 'PitPayable' | 'SsoPayable' | 'SsoExpense' | 'SalaryPayable' | 'EmployeePayable' | 'PayrollDeductionPayable'
  | 'BankFee' | 'RoundingDifference' | 'SmallWriteOff' | 'RetainedEarnings' | 'OpeningBalanceEquity' | 'VatPayable' | 'VatCarryForward';
export const ACCOUNTING_ROLES: readonly AccountingRole[];             // moved from mocks/engine/posting.ts (the engine imports it)
export const CONTROL_ROLES: readonly AccountingRole[];                // moved from mocks/records/posting-rules.ts, 20 roles
export type ChecklistCode = ChecklistItem['code'];
// RecordRow typed for kind 'account' (master plan §2.7). A TYPE ALIAS, not an interface: it must stay assignable to the
// kit's `RecordRow` index signature (an interface is not).
export type AccountRow = { id: string; version: number; active: boolean; inUse: boolean; code: string; name: string; nameTh: string;
  nameEn?: string; parent?: string; postable: boolean; class: AccountClass; subClass: string;
  dbdLine?: (typeof DBD_LINES)[number]; pnd50Box?: (typeof PND50_BOXES)[number];
  /** server-built display text ("แผนก: บังคับ, …"); the structured rules are `AccountRuleRow` */ dimensionRules?: string };
export interface AccountBody { code: string; nameTh: string; nameEn?: string; parent?: string; postable?: boolean; class: AccountClass;
  subClass: string; dbdLine?: string; pnd50Box?: string }
export type UpdateAccountBody = AccountBody & { version: number };
export interface RecordActiveBody { active: boolean; version: number }      // shared with documents.ts record routes
export interface PostingRuleBody { level: PostingLevel; key?: string; role: AccountingRole; accountCode: string }
export interface UpdatePostingRuleBody { accountCode: string; version: number }
export interface ExpenseCategoryBody { code: string; nameTh: string; accountCode?: string; recoverableVat: boolean; capex?: boolean;
  assetClass?: string; defaultWhtType?: string; parent?: string; active?: boolean }
export type UpdateExpenseCategoryBody = Omit<ExpenseCategoryBody, 'code'> & { version: number };
export interface DimensionTypeBody { key: string; nameTh: string }
export interface UpdateDimensionTypeBody { nameTh: string; version: number }
export interface DimensionValueBody { code: string; nameTh: string }
export interface UpdateDimensionValueBody { nameTh?: string; active?: boolean; version: number }
export interface AccountRulesBody { rules: Record<string, DimensionRule>; version: number }
export interface ClosePeriodBody { acknowledge: { code: ChecklistCode; count: number }[] }
export interface ReasonBody { reason: string }
export interface TbQuery { asOf?: IsoDate; dimension?: string /* type:value */; includeZero?: 'true'; groupBy?: string }
export interface GlQuery { account: string; from?: IsoDate; to?: IsoDate; party?: string /* party id */; dimension?: string }
export interface GjQuery { from?: IsoDate; to?: IsoDate; account?: string /* code prefix */; source?: string /* doc type | BANK | STL | YC | form */ }
```
`PostingRulesView.roles[].role` narrows to `AccountingRole`. `PostingRuleRow.id` stays `level|key|role` (opaque to the
frontend; URL-encoded in paths). `AccountRow.id` is opaque: the backend sends the account uuid, the mock keeps the code;
everything else on the wire names an account by `code` (rules, lines, `account-rules/{code}`).

### 5.2 Error codes (SP3 registry; status)

`ledger.account_invalid` 422 · `ledger.control_account` 422 · `ledger.party_invalid` 422 · `ledger.invariant` 500 (new;
builder bug, never user input) · `ledger.account_not_found` 404 · `posting.account_invalid` 422 ·
`posting.class_mismatch` 422 · `posting.control_account` 422 · `posting.control_level` 422 · `posting.control_in_use` 409 ·
`posting.key_invalid` 422 · `posting.duplicate` 422 · `posting.default_required` 409 · `posting.category_rule` 409 ·
`posting.rule_not_found` 404 · `posting.preview_type` 422 · `posting.unresolved` 422 · `posting.invalid_rule` 422 ·
`account.in_use` 422 · `account.controlled` 422 · `account.mapped` 409 · `account.bank_bound` 409 · `account.scheduled` 409 ·
`account.has_children` 409 · `account.has_balance` 409 · `category.not_found` 404 · `category.in_use` 409 ·
`category.cycle` 422 · `dimension.not_found` 404 · `dimension.duplicate` 422 · `dimension.max_types` 422 ·
`dimension.in_use` 409 · `dimension.rule_invalid` 422 · `period.not_found` 404 · `period.invalid` 422 ·
`period.already_closed` 409 · `period.order` 422 · `period.blocked` 422 · `period.warnings` 422 · `period.not_closed` 409 ·
`period.reason_required` 422 · `period.reopen_order` 422 · `period.closed` 422 · `period.year_closed` 422 ·
`period.year_already_closed` 409 (new, split from `period.year_closed`, L-F7) · `period.year_months_open` 422 ·
`period.year_not_ended` 422 · `period.year_order` 422 · `period.year_not_closed` 409 · `filing.locked` 409 (raised by
SP4.8's guard) · `report.not_built` 404 · `report.bad_param` 422 · `party.not_found` 404. Reused from SP3: `record.*`,
`auth.forbidden`, `agent.*`.

### 5.3 Routes (`ROUTES`; BFF `/bff/v1` + path → API `/internal/v1` + path)

| # | Method · path | Auth | Permission | Agent | Idem / conc. | Request → response | Errors (besides 401 / 403 / rate) | Audit | Task |
|---|---|---|---|---|---|---|---|---|---|
| 1 | GET `/records/account?q&active&limit&cursor` | session | `ledger.read` | yes | — | → `Page<AccountRow>` (sorted by code, numeric) | — | — | L3 |
| 2 | GET `/records/account/{id}` | session | `ledger.read` | yes | — | → `AccountRow` | record.not_found | — | L3 |
| 3 | POST `/records/account` | session | `ledger.coa.manage` | no | required / — | `AccountBody` → `AccountRow` (201) | record.invalid (+fieldErrors) | `record.account.create` | L3 |
| 4 | PUT `/records/account/{id}` | session | `ledger.coa.manage` | no | — / version-body | `UpdateAccountBody` → `AccountRow` | record.not_found, version_conflict, record.invalid, account.in_use, account.controlled | `record.account.update` | L3 |
| 5 | POST `/records/account/{id}/active` | session | `ledger.coa.manage` | no | — / version-body | `RecordActiveBody` → `AccountRow` (already there: no write, no audit) | not_found, version_conflict, account.mapped, account.bank_bound, account.scheduled, account.has_children, account.has_balance | `record.account.activate` / `.deactivate` | L3 |
| 6 | GET `/accounting/journal-accounts?for=JV\|OB` | session | `doc.JV.create` (`for=OB`: `doc.OB.create`) | yes | — | → `PostableAccount[]` (JV: postable, active, not `ControlExit(jv)`; OB: postable, active, sub-class ≠ `opening` / `current-year`) | — | — | L3 |
| 7 | GET `/finance/postable-accounts` | session | `bank.reconcile` | yes | — | → `PostableAccount[]` (postable, active, not `ControlExit(inline)`) | — | — | L3 |
| 8 | GET `/settings/posting/rules` | session | `ledger.posting.manage` | no | — | → `PostingRulesView` (`roles[].accountCodes` = the accounts `RoleProblem` accepts) | — | — | L4 |
| 9 | POST `/settings/posting/rules` | session | `ledger.posting.manage` | no | — | `PostingRuleBody` → `PostingRuleRow` (201) | record.invalid, key_invalid, account_invalid, class_mismatch, control_account, control_level, control_in_use, duplicate | `posting.rule.create` | L4 |
| 10 | PUT `/settings/posting/rules/{id}` | session | `ledger.posting.manage` | no | — / version-body | `UpdatePostingRuleBody` → `PostingRuleRow` (same account: no write) | rule_not_found, version_conflict, account_invalid, class_mismatch, control_account, control_in_use | `posting.rule.update` | L4 |
| 11 | DELETE `/settings/posting/rules/{id}?version=` | session | `ledger.posting.manage` | no | — / version-query | → `{ok:true}` | rule_not_found, version_conflict, default_required, control_in_use, category_rule | `posting.rule.delete` | L4 |
| 12 | POST `/settings/posting/preview` | session | `ledger.posting.manage` | no | — | `PostingPreviewRequest` → `PostingPreviewResult` (writes nothing; winners from the resolver trace) | preview_type | — | L4 (answers from SP4.3 / 4.4 builders) |
| 13 | GET `/settings/expense-categories` | session | any member | yes | — | → `ExpenseCategoriesView` (`assetClasses` = keys of category-level FixedAsset rules) | — | — | L4 |
| 14 | POST `/settings/expense-categories` | session | `ledger.posting.manage` | no | — | `ExpenseCategoryBody` → `ExpenseCategoryItem` (201) | record.invalid, posting.account_invalid / class_mismatch / control_account, category.cycle | `category.create` | L4 |
| 15 | PUT `/settings/expense-categories/{code}` | session | `ledger.posting.manage` | no | — / version-body | `UpdateExpenseCategoryBody` → `ExpenseCategoryItem` | category.not_found, version_conflict, record.invalid, posting.*, category.cycle | `category.update` | L4 |
| 16 | DELETE `/settings/expense-categories/{code}?version=` | session | `ledger.posting.manage` | no | — / version-query | → `{ok:true}` | not_found, version_conflict, category.in_use | `category.delete` | L4 |
| 17 | GET `/settings/dimensions` | session | any member | yes | — | → `DimensionsView` (`maxTypes: 4`) | — | — | L4 |
| 18 | POST `/settings/dimensions` | session | `settings.manage` | no | — | `DimensionTypeBody` → `DimensionTypeRow` (201) | record.invalid, duplicate, max_types | `dimension.type.create` | L4 |
| 19 | PUT `/settings/dimensions/{key}` | session | `settings.manage` | no | — / version-body | `UpdateDimensionTypeBody` → `DimensionTypeRow` | not_found, version_conflict, record.invalid, duplicate | `dimension.type.update` | L4 |
| 20 | DELETE `/settings/dimensions/{key}?version=` | session | `settings.manage` | no | — / version-query | → `{ok:true}` (its account rules go with it, kept in the audit `before`) | not_found, version_conflict, in_use | `dimension.type.delete` | L4 |
| 21 | POST `/settings/dimensions/{key}/values` | session | `settings.manage` | no | — | `DimensionValueBody` → `DimensionValueRow` (201) | not_found, record.invalid | `dimension.value.create` | L4 |
| 22 | PUT `/settings/dimensions/{key}/values/{code}` | session | `settings.manage` | no | — / version-body | `UpdateDimensionValueBody` → `DimensionValueRow` | not_found, version_conflict, record.invalid | `dimension.value.update` | L4 |
| 23 | DELETE `/settings/dimensions/{key}/values/{code}?version=` | session | `settings.manage` | no | — / version-query | → `{ok:true}` | not_found, version_conflict, in_use | `dimension.value.delete` | L4 |
| 24 | GET `/settings/dimensions/account-rules` | session | `settings.manage` | no | — | → `{items: AccountRuleRow[]}` (postable, active accounts) | — | — | L4 |
| 25 | PUT `/settings/dimensions/account-rules/{code}` | session | `settings.manage` | no | — / version-body (the account's `version`) | `AccountRulesBody` → `AccountRuleRow` (`optional` = no rule stored) | rule_invalid, version_conflict | `dimension.rules.update` | L4 |
| 26 | GET `/periods?year=` | session | `ledger.read` | yes | — | → `PeriodsView` (default year = year of the first open row) | — | — | L5 |
| 27 | GET `/periods/checklist?month=` | session | `ledger.read` | yes | — | → `{items: ChecklistItem[]}` (all six) | period.invalid | — | L5 |
| 28 | POST `/periods/{month}/close` | session | `ledger.period.close` | no | — / none (row lock, §4.6) | `ClosePeriodBody` → `PeriodsView` | not_found, already_closed, order, blocked, warnings | `period.close` | L5 |
| 29 | POST `/periods/{month}/reopen` | session | `ledger.period.reopen` | no | — / none (row lock) | `ReasonBody` → `PeriodsView` | not_found, not_closed, reason_required, year_closed, reopen_order | `period.reopen` | L5 |
| 30 | POST `/periods/year/{year}/close` | session | `ledger.period.close` | no | — / none (year lock) | `{}` → `PeriodsView` | not_found, year_already_closed, year_months_open, year_not_ended, year_order | `period.year_close` | L5 |
| 31 | POST `/periods/year/{year}/reopen` | session | `ledger.period.reopen` | no | — / none (year lock) | `ReasonBody` → `PeriodsView` | year_not_closed, filing.locked, reason_required, year_order | `period.year_reopen` | L5 |
| 32 | GET `/reports/trial-balance` | session | `report.read` | yes | — | `TbQuery` → `ReportModel` | report.bad_param | — | L6 |
| 33 | GET `/reports/general-ledger` | session | `report.read` | yes | — | `GlQuery` → `ReportModel` | bad_param, ledger.account_not_found, party.not_found | — | L6 |
| 34 | GET `/reports/general-journal` | session | `ledger.read` | yes | — | `GjQuery` → `ReportModel` | bad_param | — | L6 |
| 35 | GET `/reports/{trial-balance\|general-ledger\|general-journal}/export` | session | as 32–34 | yes | — | same query → `text/csv; charset=utf-8` (BOM, CRLF, headers in the `locale` cookie's language, formula cells prefixed `'`, plain negative money kept) | as 32–34 | — | L6 |

`/reports/{kind}` for any other kind stays on MSW (SP4.9); the real API answers it 404 `report.not_built`.

Routes 28–31 carry no `version` (a deliberate exception to master plan §2.5 "every mutable resource carries
`version`", as in the approved mock): they are state-guarded commands taken under the exclusive period / year lock of
§4.6, so a second caller sees the new state and gets its own conflict answer (`period.already_closed`,
`period.not_closed`, `period.year_already_closed`, `period.year_not_closed`, `period.reopen_order`) — never a lost update.
The `periods.version` column exists for the server only.

Route 12 is a read-only POST (a computation, nothing stored): SP3's audit-coverage test ("every non-GET route declares
an audit command") gets a named allow-list of read-only POSTs in L4 — this route, and SP4.2's `compute` /
`numbering/preview` — each with a test that the route writes no row anywhere (row counts of every tenant table before =
after).

### 5.4 Permissions (no additions — SP3 catalog)

`ledger.read`, `ledger.coa.manage`, `ledger.posting.manage`, `ledger.period.close`, `ledger.period.reopen`,
`settings.manage`, `report.read`, `bank.reconcile`, `doc.JV.create`, `doc.OB.create`. System role templates unchanged
(accountant holds all ledger codes; admin holds `settings.manage` — so dimensions are the admin's, as approved in ST2).

## 6. Invariants — each a named test; owner = the module whose code keeps it true

Ledger-owned (SP4.1 builds them as property tests over the kernel; later modules add their sources to the same suite):

| # | Invariant (mock `checkInvariants` #) | Test (task) |
|---|---|---|
| L-I1 | Every entry: Σ debit = Σ credit in satang; each amount ≥ 0, 2 dp, one side per line; every account exists in the entry's company and is postable (#1) — app check + the deferred DB trigger | `KernelBalanceTests` incl. a raw `INSERT` that bypasses the app and fails at COMMIT (L2) |
| L-I2 | A stored entry is never updated or deleted (UPDATE / DELETE / TRUNCATE raise as `teas_app` and `teas_migrator`); a correction is reversal + new entry | `JournalAppendOnlyTests` (L1) |
| L-I3 | A reversal is the exact mirror of its original (same lines, sides swapped, rule + " (กลับรายการ)"), same source, one per original | `ReversalMirrorTests` (L2) |
| L-I7 | Every entry has `posted_at`; an entry dated in a closed month was posted at or before that month's `closed_at` — except `source_kind ∈ {opening, year_close}` (#7, AC6 carry) | `ClosedPeriodPostingTests` incl. a barrier race close ∥ issue (L2, L5) |
| L-I8 | Placement: `Strict` never writes into a closed month or year; `Late` lands on `FirstOpenDate` (or a floor) with `late = true`; no `Late` / `AtDate` entry lands in a closed year | `PlacementTests` (L2) |
| L-I22 | A line naming a party carries `party_id` of a party of the same company (#22) | `PartyLineTests` (L2) |
| L-I23 | A line on an item control account (by role, L-F6) carries `party_id` and `open_item_id` (#23 shape); the fit of the item's type is the owner module's test | `OpenItemTagTests` (L2) |
| L-I25 | A dimension tag on a stored line names a type AND a value of that company, active or not (#25); account rules are NOT judged on stored lines | `DimensionTagTests` (L4) |
| L-I26 | `AccountBySourceLine` returned by `Post` equals the account the stored line of that source line carries (one resolution) | `PostedAccountTests` (L2; SP4.4 adds "issued purchase line has `postedAccount`") |
| L-I19 | Year close (#19): one live per company-year; dated Dec 31; its twelve months closed; per-account line = −(that account's year balance from the other entries); nothing else swept; 3200 line = Σ revenue − Σ expense = stored `net`; afterwards every revenue / expense account and 3300 is 0 for the year; a reopened one has exactly its mirror on Dec 31 | `YearCloseInvariantTests` with single-fault tampers (L5) |
| L-I27 | Closed months are a prefix of the company's period rows; `acknowledged` equals the warnings at close | `PeriodOrderTests` (L5) |
| L-I28 | TB: Σ debit column = Σ credit column computed separately, diff never forced (tie-out shows a corruption); GL closing (unfiltered) = TB of the account | `TbGlTieTests` (L6) |
| L-I29 | Changing a posting rule, category, dimension rule, account name or party name after posting leaves every stored line and every TB / GL / GJ figure unchanged | `FrozenAfterPostingTests` (L4, L6) |

Owned elsewhere, built on this kernel (listed so the owners inherit them; the harness `LedgerProperties` exposes
`GlBySource`, `ControlAccounts`, `TaggedBalance(openItemId)`):

| Mock # | Invariant | Owner |
|---|---|---|
| 2, 3 | outstanding = total − Σ active credit notes + Σ debit notes − Σ settlements; status from settlements | SP4.2 (engine) + SP4.3 / 4.4 / 4.5 |
| 4, 4b, 4c, 4e, 24 | control account (by role) = Σ open items of its kind, per party; tagged balance of an item = its stored balance | SP4.3 (AR), SP4.4 (AP, EmployeePayable), SP4.5 (deposits / prepayments), SP4.11 (OB items) |
| 4d | input VAT per claim period | SP4.4 |
| 5, 6, 12, numbering, look | conversions; links same company + journal presence; approval; gap-free series; seller / look snapshot | SP4.2 |
| 8, 8b, 13, 14 | receipts / vouchers, WHT receivable, bank reconciliation, settlement records | SP4.3 / 4.4 / 4.5 |
| 9, 10, 11, 11b | billing statements, notes, WT, paid-up records | SP4.3 / 4.4 |
| 15 | JV: no controlled account, journal = lines, reversal mirror, accrual pair nets to zero | SP4.2 (D7) — the kernel's `ManualScope.Jv` check is L-I's |
| 16, 17, 18, 20, 21 | OB, schedules, assets, filings, payroll | SP4.11, 4.6, 4.6, 4.8, 4.7 |

## 7. Guards and their exits

| Guard | State when it fires | Exit in the app (no DBA) |
|---|---|---|
| `period.closed` | issue / date move into a closed month | change the date to `FirstOpenDate` or later (named in the message); or reopen the month (`ledger.period.reopen` + reason) |
| `period.year_closed` | posting / correcting / reversing into a closed year | reopen the year (`ledger.period.reopen` + reason), then reopen the month |
| `filing.locked` on year reopen | ภ.พ.50 of the year finalized (SP4.8) | none in the app — **accepted dead-end, TX3a ruling 7** (amended return out of system, §1.4); the year's documents stay correctable only by later-period entries |
| `ledger.control_account` | a JV / inline line on an account a document or screen owns | the message names the owner: RC / PV / bank line / asset register / opening balances / payroll run / year close / tax payment |
| `ledger.account_invalid` | unknown, header or inactive account | pick a postable active account, or reactivate it (route 5) |
| `posting.unresolved` | no rule for a role | add a rule (route 9); every role except FixedAsset / AccumulatedDepreciation has a keyless default from the template and it can never be deleted; a capex category needs its asset class rule |
| `posting.invalid_rule` / `posting.class_mismatch` (kernel) | the rule's account became unusable / no longer fits | re-point the rule (route 10) or fix the account while unused (route 4) |
| `posting.control_level` | a control role at a non-default level | set it at the company default |
| `posting.control_in_use` | the account of a control role holds posted lines | the role → account binding is permanent once posted (ST2b ruling 1; readers resolve control accounts by role). What stays free: rename the account, change its statutory mapping (route 4). The mock's exit text "move with a JV" is false (a JV refuses control accounts) and is replaced by this text in L4 |
| `posting.default_required` / `posting.category_rule` | delete of a role's default / a category's rule | edit the account instead (route 10 / 15) |
| `account.in_use` | change of code / class / sub-class / postable / parent class of a used account | rename and remap stay free; else create a new account and move the balance by JV (non-controlled) or by the owning document |
| `account.controlled` | reclassify a controlled account | create a new account (a controlled account's class never moves) |
| `account.mapped` / `account.bank_bound` / `account.scheduled` | the code is claimed | re-point the rule (ตั้งค่า → การลงบัญชี) / re-bind the bank account (การเงิน → บัญชีธนาคาร) / stop the schedule (SP4.6) |
| `account.has_children` | live sub-accounts | deactivate or move them first |
| `account.has_balance` | non-zero balance | empty it through its owner (controlled) or a JV |
| `category.in_use` / `dimension.in_use` | referenced by documents, items, lines or templates | deactivate instead (category `active: false`; dimension value `active: false`) |
| `dimension.max_types` | four types exist | delete an unused type; a type in use cannot go — four is the charter's cap (§5.6) |
| `period.order` / `period.reopen_order` | closing out of order / reopening an earlier month | close the earlier month first / reopen the later month first |
| `period.blocked` | a blocking checklist item | the item's `href` (e.g. run depreciation) |
| `period.warnings` | the warnings changed since the user looked | reload the checklist and acknowledge again |
| `period.year_order` | close with an earlier year open / reopen with a later year closed | close / reopen that year first |
| `period.year_months_open` / `period.year_not_ended` | precondition | close the months / wait for Dec 31 |
| `company.fiscal_year_locked` (SP3 route 18) | a closed period exists | reopen the periods back to the first (reopen order; a closed year first) — only while no ภ.พ.50 blocks it |

## 8. Freeze at posting / close (never re-derived)

| Field | Frozen at | Source data it shields | Test (change the source after → stored value and every reader unchanged) |
|---|---|---|---|
| `journal_lines.account_code`, `account_name` | posting | account rename / code change before use | `FrozenAfterPostingTests` (TB rows show the LIVE account name — a label, not a figure; the GJ / GL line text keeps the stored one) |
| `journal_lines.role`, `rule`, `rule_level`, `rule_key` | posting | posting rules, categories | re-point the rule → old lines unchanged, next posting uses the new account |
| `journal_lines.party_id`, `party_name` | posting | party master (rename) | rename → GL by party (matched by id) unchanged, line shows the old name |
| `journal_lines.open_item_id`, `dimensions` | posting | the document's later revisions; dimension values (deactivation) | deactivate a value → stored tags valid (L-I25) |
| `AccountBySourceLine` → SP4.4 `postedAccount` | issue / revise / reissue | rules, categories | invariant L-I26; SP4.4 adds the document-side test |
| `journal_entries.posted_at`, `late`, `date` | write | the clock, period states | close a month afterwards → L-I7 still holds |
| `year_closes.net` + the closing entry's lines | year close | later entries, rules | a later JV on 3200 (dividend) does not change the closing entry or `net` |
| `periods.acknowledged`, `closed_by`, `period_reopens` | close / reopen | the checklist providers | a provider's count changes after close → the stored list unchanged |

## 9. Charter statements contradicted or extended by the approved mock (for ADR-0008)

| # | SP0 | Charter says | Approved mock (ruling) | Disposition |
|---|---|---|---|---|
| C-1 | §5.2 item 5 | AR / AP / employee-payable accept manual journals with a party | a JV refuses every account a document owns, AR / AP / 2180 included (AC1 R1); `ledger.party_required` never fires | ADR-0008 records the stricter rule |
| C-2 | §5.2, §5.9 | reversal "available for every entry"; "one click on any journal entry" | "กลับรายการ" only on a JV; a document's entry is corrected by its own cancel / correction plan (AC1 R2, `ledger.reverse_document`) | ADR-0008 |
| C-3 | §5.9 | reversal date default "same date if open, else first open date" | `max(original date, FirstOpenDate)` where `FirstOpenDate` ≥ the business month (AC1); causes the AC4 split carry | ADR-0008; Q-L4 |
| C-4 | §5.2 item 3 | the posting date's period is open | exceptions: OB at a closed cut-off (D-10), the year-close entry and its reversal (Dec 31 in closed months), the system auto-reversal dated next month | ADR-0008 |
| C-5 | §5.2 item 4 | "class allowed for the role" checked by the kernel | the mock checks fit only when a rule is saved; the kernel here re-checks (hardening, `posting.class_mismatch`) because a free-role account's class can still change while unused | this spec (no behaviour change for valid data) |
| C-6 | §5.4 | code and class editable until first used | also sub-class, postable, parent class; a controlled account's class never changes even unused; code changes refused while claimed (AC2) | ADR-0008 |
| C-7 | §5.5 | one resolution order for every role and level | 20 control roles only at company default, frozen once posted; a control account serves only its role (ST2b) | ADR-0008 |
| C-8 | §5.6 | account dimension rules (no exceptions) | not retroactive (only faults a change introduces, judged per line); CN / DN / PCN / PDN exempt from account rules (ST2b r4–r5) | ADR-0008 |
| C-9 | §5.8 | fiscal year = 12 months from the start month; year close into retained earnings | calendar only (ADR-0006); closes through 3300 (found by sub-class, not a §5.5 role) then 3200 | ADR-0006 / ADR-0008 |
| C-10 | §5.8 | a correction in a closed period posts in the current open period | not into a closed YEAR: refused (AC6 "final means final", notes-only edits included) | ADR-0008 |
| C-11 | §5.3 | journal line has `tax_code`, `source_line` | no tax code on lines (registers read documents, I12); source line kept as `source_line_id` | this spec |

## 10. Definition of Done (SP0 §11.5)

- [ ] Descriptors complete — n/a (no document type here; the JV is SP4.2); every guard of §7 has its exit and a test
- [ ] Date model and period gate applied — kernel placement §4.3, period locks §4.6; `BusinessDate` / `TimeProvider` only
- [ ] Permissions in the catalog; frontend gating; MCP tools and agent-policy defaults — no new codes; agent column of §5.3 enforced (SP3 S10 tests extended); no MCP tool (none ledger-level)
- [ ] Error codes registered in Thai and English (§5.2), `period.year_already_closed` split done in the mock too
- [ ] Every screen state implemented — chart of accounts, posting rules / categories / test, dimensions, period close, TB / GL / GJ in hybrid mode: loading, empty, error, forbidden, locked; VAT and non-VAT company
- [ ] Screen = paper — n/a
- [ ] Opening-balance support — the kernel's `AtDate` placement and `SourceKind.Opening`; the OB batch itself SP4.11
- [ ] Tests: domain unit (merge, mirror, placement, role fit, control exit, year-close builder), integration as `teas_app`, property tests §6, blind acceptance (kernel + year close — money), e2e (screens in hybrid), RBAC matrix rows for routes 1–35
- [ ] Generated docs updated — `docs/api/openapi.v1.json` (ledger routes), conformance file `contract/conformance/ledger.ts`
- [ ] Shipped screens match the approved mockups — COA, posting settings, dimensions, period close, TB / GL / GJ vs SP1c screenshots
- [ ] Parity checklist rows ticked: M-07 expense categories, M-08 / L-02 chart of accounts, FG-10a posting mapping, L-03 close / reopen, FG-14b reopen history (data side), RP-02 TB, RP-05 GL, RP-13 export (TB / GL / GJ)
- [ ] §6 invariants have their named tests; §12 deploy probe passes on staging

## 11. Verification gates (exact commands; SP3 §10 creates them)

From PowerShell, each line alone (no `&&`):

| Gate | Command |
|---|---|
| backend build | `dotnet build backend/Teas.sln -c Release -warnaserror` |
| unit | `dotnet test backend/tests/Teas.Domain.Tests -c Release --filter "FullyQualifiedName~Ledger"` |
| architecture | `dotnet test backend/tests/Teas.Architecture.Tests -c Release` |
| integration (local PG 18, `$env:TEAS_TEST_ADMIN_CS`, `$env:TEAS_TEST_APP_CS`) | `dotnet test backend/tests/Teas.Integration.Tests -c Release --filter "FullyQualifiedName~Ledger"` |
| OpenAPI current | `dotnet build backend/src/Teas.Api -c Release` then `git diff --exit-code docs/api/openapi.v1.json` |
| frontend | from `frontend/`: `corepack pnpm gen:api` · `corepack pnpm typecheck` · `corepack pnpm lint` · `corepack pnpm test` · `corepack pnpm e2e accounting settings-posting settings-dimensions reports --workers=1` (nothing on :3100 first) |
| contract freeze | `node tools/check-contract-freeze.mjs` |

Integration tests share the local DB: every task from L1 on runs them sequentially, never beside another dispatch
that runs integration tests (SP3 §11). L0 (frontend only) may run beside an SP3 or SP4.2 backend task. The orchestrator
runs the full suites (Tier 1 rule); a worker reports build + focused evidence.

## 12. Deploy probe (staging, then prod) — row counts, not exit codes

1. Migrator: `SELECT count(*) FROM teas.ledger_templates` = 1 and its `sha256` = the file's (printed by the migrator).
2. As `teas_migrator` with `app.system = on` (read only): `SELECT count(*) FROM teas.companies c WHERE NOT EXISTS
   (SELECT 1 FROM teas.accounts a WHERE a.company_id = c.id)` → 0. If not 0: run `Teas.Migrator seed-ledger
   --all-missing` and repeat; it prints per company the rows inserted (accounts 66, posting rules 49, categories 9,
   dimension types 2, values 5, periods 12).
3. Staging: create a company through the onboarding / factory path → the same five counts for it; `GET
   /bff/v1/records/account?limit=100` through the PUBLIC domain returns 66 rows; `GET /bff/v1/periods` returns 12 months.
4. Staging: post a test JV once SP4.2 is live → TB through the public domain shows Σ Dr = Σ Cr, tie-out diff `0.00`.
5. As `teas_app` via `psql`, no GUC: `SELECT count(*) FROM teas.journal_lines` → 0 (RLS); `UPDATE teas.journal_lines SET
   debit = debit` under a company GUC → error from the append-only trigger.

## 13. Tasks

Order: L0 → L1 → L2 → L3 → L4 → L5 → L6 → L7. L0 is frontend-only (may run beside SP3 backend tasks or SP4.2 D0 only if
their file sets are disjoint — they are not: both touch `domain/types.ts` re-exports → L0 before D0). From L1 every task
runs integration tests on the shared local DB — sequential only.

### Task L0: Freeze the ledger contract (frontend; master plan C2)

**Depends on:** SP3 P0 landed (platform contract frozen); Ham approves this spec. **Blast cap:** 24 files; API changes:
§5.1 deltas only.
**Files:** Create `frontend/src/contract/ledger.ts`, `frontend/src/contract/ledger.contract.test.ts`. Modify (re-export /
conform): `domain/types.ts`, `domain/reports.ts`, `lib/api/endpoints.ts` (`PostableAccount` import; typed
`createRecord`/`updateRecord` overloads for `'account'`), `records/accounts.ts`, `records/posting-rules.ts` (typed
`create` / `update` bodies), `records/dimensions.ts` (typed bodies), `records/expense-categories.ts` (typed bodies),
`mocks/engine/posting.ts` (import `AccountingRole`, `ACCOUNTING_ROLES`), `mocks/records/posting-rules.ts` (import
`CONTROL_ROLES`; the `posting.control_in_use` text per §7), `mocks/engine/close.ts` (`period.year_already_closed` 409),
`mocks/records/accounts.ts` (`toRow` returns `AccountRow`), the matching kit callers of the typed bodies, `th.json` /
`en.json` (new code titles if the frontend maps codes — it shows the server title; add only if a test needs it).
**Rules:** move, do not retype; old import paths keep working. `ROUTES` = §5.3 rows 1–35 exactly; route 35 is three
entries. `AccountRow` is a `type` alias (assignable to `RecordRow`). No behaviour change except the two named texts /
codes.
- [ ] **Step 1: Failing tests** — every `ROUTES` entry has an MSW handler and every MSW handler under `/records/account`,
  `/accounting/journal-accounts`, `/finance/postable-accounts`, `/settings/posting`, `/settings/expense-categories`,
  `/settings/dimensions`, `/periods`, `/reports/{trial-balance,general-ledger,general-journal}` has a `ROUTES` entry;
  `CONTROL_ROLES` has 20 roles, `ACCOUNTING_ROLES` 34; closing a closed year in the mock answers 409
  `period.year_already_closed`; `AccountRow` assignable to `RecordRow` (type test).
- [ ] **Steps 2–5**: run → FAIL → implement → PASS; `corepack pnpm typecheck`, `lint`, focused `test`, e2e `accounting
  settings-posting settings-dimensions reports --workers=1`. Controller runs the full unit suite.
- [ ] **Step 6: Controller commits** `feat(contract): freeze the ledger contract v1.0`, then the `FROZEN.json` entry.

### Task L1: Schema, RLS, append-only journal, template catalog, company initializer

**Depends on:** L0; SP3 P6. **Blast cap:** 22 files. **Tier 2:** Opus review (schema / RLS / runtime security).
**Files:** migrations `0101_ledger_core` (§4.9 tables, triggers, grants, indexes, the balance trigger),
`backend/src/Teas.Migrator/Catalog/ledger-template.thai-sme.v1.json` + catalog sync, `rls-allowlist.txt`
(`ledger_templates`), verb `seed-ledger`, `Teas.App/Ledger/LedgerCompanyInitializer.cs` (registered in SP3's
`CompanyFactory` hook list), `TenantRowFactory` methods for every new tenant table, EF mappings,
`frontend/src/contract/ledger-template.test.ts` (JSON = mock `chartOfAccounts()`, `postingRulesFor` minus bank keys,
`EXPENSE_CATEGORIES`, seed dimension types / values), tests.
**Rules:** §4.9, §4.10 exactly; the template JSON is the mock's data, no edits (D-15-3 values stay `[SP-R]`-tagged in a
`"sources"` field).
- [ ] **Step 1: Failing tests** — S9-style generated RLS test covers the eight new tenant tables; UPDATE / DELETE /
  TRUNCATE on `journal_entries` / `journal_lines` / `period_reopens` raise as `teas_app` and `teas_migrator`; a raw
  unbalanced insert fails at COMMIT; `year_closes` update of a non-reopen column raises; `CompanyFactory.Create` →
  counts 66 / 49 / 9 / 2 / 5 / 12; an initializer forced to run before `Enter` fails WITH CHECK (proves ordering);
  `seed-ledger --all-missing` twice → second run inserts 0; template parity vitest.
- [ ] **Steps 2–5**, gates: build, architecture, integration (focused `Ledger`), frontend focused test. **Step 6:**
  controller commits `feat(ledger): schema, append-only journal and the chart-of-accounts template`.

### Task L2: Posting kernel, resolver, placement, period locks

**Depends on:** L1. **Blast cap:** 18 files. **Tier 2:** Opus review (money) + blind acceptance tester (§6 L-I1 / I3 / I7 /
I8 / I22 / I23 / I26 from this spec only).
**Files:** `Teas.Domain/Ledger/**` (roles, fit, control exit, merge, mirror, rule label), `Teas.App/Ledger/LedgerKernel.cs`,
`PostingResolver.cs`, `PeriodGate.cs` (locks + placement), `LedgerProperties.cs` (test harness), a test-only
`SourceKind.Test` endpoint registered in the test host only (like SP3 P4), tests.
**Rules:** §4.2–§4.4, §4.6 locks; architecture test: only `LedgerKernel` calls `PostingResolver.Resolve`, only
`LedgerKernel` inserts into `journal_*`.
- [ ] **Step 1: Failing tests** — merge / drop-zero / opposite-side / order (mock `ledgerFor` vectors: a CN line with
  negative VAT posts credit-side); resolver precedence over all five levels + default keys (SV-02 item rule beats the
  default, ST2c r4); `posting.unresolved`, `posting.invalid_rule`, kernel `posting.class_mismatch`; `ManualScope.Jv` on
  1130, 2160, 3300, 3900, 1121, 1210 → `ledger.control_account` with the owner text; party / open-item tags; `1.005`
  refused before SQL; placement table §4.3 (Strict / Late / AtDate / YearClose; floor hook fed by a test floor; shift →
  floor → shift); reversal modes; closed-year refusal on every `ReversalWhen` except `YearEnd`; barrier race: close of
  month M ∥ post into M → either the post fails `period.closed` or it commits before `closed_at` (L-I7) — 50 runs;
  `AccountBySourceLine` = stored line account.
- [ ] **Steps 2–5**, gates: build, unit, architecture, integration. **Step 6:** `feat(ledger): posting kernel, resolver and period gate`.

### Task L3: Chart of accounts routes and account claims

**Depends on:** L2. **Blast cap:** 12 files. **Files:** `Teas.App/Ledger/Accounts/**` (validate, create, update,
setActive, claims: rules + control role), `Endpoints/Ledger/AccountsEndpoints.cs` (routes 1–7), conformance lines, tests.
**Rules:** §4.5; mock `mocks/records/accounts.ts` refusals and Thai texts verbatim; generic record handler order 404 →
409 → 422 (SP1c M1); `inUse` = any journal line.
- [ ] **Step 1: Failing tests** — every AC2 rule with its exit text (in-use freeze incl. parent class; controlled
  reclass refused unused; code change refused while a rule / control role claims it; sub-accounts follow a header's
  new code; deactivate order claims → children → balance with the owner text); header 1100 rename keeps the bank GL list
  (L-F8); `journal-accounts?for=JV` excludes every `ControlExit(jv)` account, `for=OB` excludes 3300 / 3900;
  `postable-accounts` excludes every `ControlExit(inline)` account; RBAC rows; agent refused before body.
- [ ] **Steps 2–5**, gates as L2 + conformance. **Step 6:** `feat(ledger): chart of accounts`.

### Task L4: Posting rules, expense categories, dimensions, account rules, preview engine

**Depends on:** L3. **Blast cap:** 20 files. **Tier 2:** Opus review.
**Files:** `Teas.App/Ledger/{PostingRules,ExpenseCategories,Dimensions}/**`, `DimensionJudge.cs`, `PostingPreview.cs`
(registry of `IPostingPreviewBuilder`), endpoints (routes 8–25), conformance lines, tests.
**Rules:** §4.4; mock `mocks/records/{posting-rules,expense-categories,dimensions}.ts` verbatim (category ↔ its
category-level Expense rule are one fact; a capex category has no Expense rule; dimension delete takes its account rules
into the audit `before`); `DimensionJudge.Problems(company, intentByLine, before?)` = mock `dimensionProblems` (keyed per
document line + content; unknown / inactive tags; required / forbidden; notes exempt from account rules; not
retroactive) — exposed for SP4.2, which calls it before number allocation.
- [ ] **Step 1: Failing tests** — every ST2 / ST2b / ST2c rule listed in §4.4 and §7 incl. the keyed control default
  create refused while the keyless account holds postings; the new `control_in_use` text; `L-I29` (re-point a rule →
  stored lines and TB / GL unchanged; next posting uses the new account); `DimensionJudge` vectors (stricter rule later
  never blocks an unchanged line; an edited line is judged in full; inactive value refused for new use only);
  preview: no builder → 422 `posting.preview_type`; a test builder → winners carry `level` / `key` from the trace;
  `L-I25`.
- [ ] **Steps 2–5**, gates as L3. **Step 6:** `feat(ledger): posting rules, categories and dimensions`.

### Task L5: Periods, checklist registry, close / reopen, year close / reopen

**Depends on:** L4. **Blast cap:** 14 files. **Tier 2:** Opus review (money) + blind acceptance tester (L-I19, L-I27, §7
period rows).
**Files:** `Teas.App/Ledger/Periods/**` (`EnsureYear`, close, reopen, `ChecklistRegistry`, `YearClose` builder,
`IYearReopenGuard`, `IFiscalYearLock` registration replacing SP3's interim), endpoints (routes 26–31), tests.
**Rules:** §4.6, §4.7; mock `engine/close.ts` texts; locks per §4.6.
- [ ] **Step 1: Failing tests** — order prefix; blocking refuses with each `href`; warnings must match exactly
  (appeared / changed / extra → `period.warnings`); acknowledged frozen; reopen only the latest closed of an open year;
  reason required; year close sweep identity incl. a dividend JV on 3200 (L-I19 stated on the entry, not Δ3200);
  empty closing entry allowed; year order both ways; `period.year_already_closed` 409; reopen year reverses on Dec 31 and
  restores every P&L balance; a test `IYearReopenGuard` → 409 `filing.locked`; checklist returns six codes with
  `note` for unregistered providers; `fiscalYearLocked` true after a close; race: close ∥ close of the same month →
  one 200, one 409.
- [ ] **Steps 2–5**, gates as L3. **Step 6:** `feat(ledger): period close, reopen and the year-end close`.

### Task L6: Trial balance, general ledger, general journal, CSV

**Depends on:** L5. **Blast cap:** 10 files. **Files:** `Teas.App/Ledger/Reports/{Tb,Gl,Gj,Csv}.cs`,
`LedgerReportEndpoints.cs` (routes 32–35), conformance, tests.
**Rules:** mock `engine/reports/{trial-balance,general-ledger}.ts`, `engine/journal.ts generalJournal`, `reportCsv`
verbatim (TB `dimension` `type:value`, `groupBy` columns + the second tie-out; GL natural side, opening from entries
before `from`, party by id, filter note; GJ source labels: a document's `number · titleTh`, `BANK`, `STL`, `YC`
"ปิดบัญชีสิ้นปี <BE year>", a filing form); dates validated as real calendar dates (`2026-02-30` → 422); CSV per L-F12.
- [ ] **Step 1: Failing tests** — golden models from the mock: seed a fixed set of entries through the kernel and compare
  the JSON model with the mock's output for the same entries (fixture exported once by a vitest helper,
  `frontend/src/mocks/engine/reports/ledger-golden.test.ts` writes `backend/tests/.../ledger-golden.json`); L-I28; CSV
  BOM + CRLF + formula guard; TB / GL `report.read`, GJ `ledger.read`; other kinds → 404 `report.not_built`.
- [ ] **Steps 2–5**, gates as L3. **Step 6:** `feat(ledger): trial balance, general ledger and general journal`.

### Task L7: Live switch, e2e, SP4.1 gate

- [ ] `frontend/src/contract/live-routes.ts` += routes 1–35 (hybrid mode) as LITERAL paths (`/records/account`,
  `/records/account/{id}`, …): the hybrid wrapper passes a request through only on an exact match, because MSW serves
  `/records/:kind` for every kind with one generic handler (customer / vendor / item stay on MSW until SP4.2 D9).
  MSW keeps every other route. Note: routes
  6 and 12 serve real data only for registered types (JV from SP4.2); until then `for=JV` lists accounts (works), preview
  answers 422 for every type — keep route 12 on MSW until SP4.3 (§5.3 "Task" column).
- [ ] e2e in hybrid on the composed stack (CI): COA add 5190 under 5000; deactivate 1130 refused naming the rule;
  posting rule re-point + preview (MSW); dimension type / value / rule; close 2026-07 with warnings acknowledged; TB /
  GL / GJ render and export.
- [ ] Consolidated gate (Haiku): §11 table green on CI. Tier 2 escalated review (`tier2-review.js`, lenses: money
  invariants, tenancy / RLS, concurrency, contract conformance) — the ledger is extreme blast radius.
- [ ] Staging deploy + §12 probe through the public domain. DoD §10 ticked with evidence; demo to Ham.

## 14. Open questions for Ham

| # | Question | Recommendation |
|---|---|---|
| Q-L1 | The control account of a role (AR, AP, Cash, VAT …) can never be changed once anything was posted to it (ST2b ruling 1). The mock's message tells users to "move the balance with a JV", which a JV refuses. Keep the permanence and say so plainly (rename / statutory remap stay free), or build an effective-dated change of a control account later (readers would resolve by date)? | Keep permanent; replace the message (L4) |
| Q-L2 | The kernel re-checks "account class fits the role" at every posting (charter §5.2 item 4); the mock checks only when a rule is saved. With valid data nothing changes; a free-role account reclassified while unused would now be refused at issue (exit: fix the rule). Approve the hardening? | Approve |
| Q-L3 | A posting into a month BEFORE the company's first period row is allowed (the mock treats a missing row as open; the OB batch is what defines the start). Should SP4.11 later refuse document dates before the opening-balance cut-off? (No change in SP4.1) | Decide in SP4.11 |
| Q-L4 | Reversal default date = `max(original date, first open month ≥ this month)` (AC1), not the charter's "same date if open" — so a JV reversed in a later month posts in the current month even when the original month is still open. Keep (approved mock) and record in ADR-0008? | Keep, ADR-0008 |
| Q-L5 | Checklist codes whose module is not live answer `count 0` with a "not active yet" note (mock pattern). OK, or hide them until their module ships? | Keep the note (all six always shown) |
| Q-L6 | Record every row of §9 (C-1 … C-11) in ADR-0008 (mock-era rulings that amend SP0) together with the master plan's list? | Yes |

## 15. Attempt log

- 2026-10-27 — drafted (opus designer) from SP0, the master plan (approved), SP3 (approved), the SP1c mock at main
  c4843dd (`domain/**`, `lib/api/**`, `records/**`, `descriptors/**`, `mocks/engine/{ledger,posting,journal,periods,close,commands,
  corrections,numbering,approval,invariants,log,look,paper,locks,reconcile}.ts`, `mocks/records/{accounts,posting-rules,
  dimensions,expense-categories,…}.ts`, `mocks/handlers/**`, `mocks/fixtures/{coa,posting-profiles,expense-categories}.ts`),
  the 00 / 01 / 05 / 09 group plans, briefs, reports and Opus reviews (digested), and troubles-wiki. Docs only;
  nothing built or run.
