# TEAS 1 -- History Lessons: Defect Patterns, Retrofits and What TEAS 2 Must Do From Day One (discovery 04)

> Purpose: the HISTORY lens for the TEAS 2 re-plan (same features and tax-posting behaviour, more accounting flexibility, much better UX). What went wrong in TEAS 1, what was retrofitted late, what the owner (Ham) asked for, what is still open, and the lessons that should shape TEAS 2 architecture and process.
> Method: read-only reading of TEAS 1 history records -- `STATUS.md`, `troubles-wiki.md` (all 103 entries), `CHANGELOG.md` (73 releases), `ROUTING-LOG.md`, `docs/archive/*` (PLAN / PROGRESS / VERDICT / REPORT records, `progress.md`, `plan.md`), `specs/*` (94 files: headers, checklists, attempt logs), `docs/code-review-*`, `_review/`, `findings-r2/`, `swarm-findings/`, root `PLAN-*` / `PROGRESS-*`, `git log` (1,023 commits), plus structural counts (file listings, line counts, grep) and a few spot-checks in `backend/src`. No builds, tests, servers or DB connections.
> Repo state analysed: branch `chore/release-2.5.0` (backend 2.5.0, 2026-10-05). `STATUS.md`'s "Now" block stops at 2026-09-05; 2.5.0 is not on the board (itself a finding, section 4).
> Paths are relative to `Y:\ClaudePlayground\TEAS-Project` unless stated. Thai quotes are Ham's words as recorded in repo docs. No secrets copied: credentials, test-account conventions, server addresses / SSH key names, real-tenant amounts and bank-statement file names are omitted or `[REDACTED]`.
> Counting caveat: counts marked "keyword" are regex hits over prose and overlap heavily; counts marked "primary" are hand-assigned (one class per entry); everything else is a direct count (`git`, `ls`, `grep -c`, `wc`).

<!-- SECTION-EXEC -->

---

## 0. Executive summary

1. **Shape.** About 20 weeks (2026-05-15 -> 2026-10-05), built by an AI-agent pipeline under one owner. 1,023 commits (429 are `docs:`), 73 tagged releases in 109 days (v1.4.0 2026-06-18 -> v2.5.0 2026-10-05), backend ~56K LOC + ~59K LOC tests (~1,650 tests), frontend ~37K LOC / 108 pages, 337 endpoints, 87 MCP tools, 111 SQL scripts + 22 EF migrations. Domain, RLS, immutability triggers, GL auto-posting and TI / Receipt / CN / PV / WHT existed within the first two days (`docs/archive/progress.md`, 2026-05-16); everything after was added "as we went".
2. **The arithmetic held; the controls around it did not.** The v1.27.1 break-it verdict: Dr = Cr in every scenario, no cross-tenant leak, numbering survived a 20-wide burst -- yet 6 CRITICAL (one later retracted) and 17 HIGH defects were live behind 1,073 green tests (`docs/archive/VERDICT-breakit-v1271.md`).
3. **Rank-1 root cause: environments that lie.** Dev/test DB roles were superusers (BYPASSRLS); Ham accepted that on 2026-06-11 (commit `aab2617`). At least 11 prod-only RLS/tenant incidents followed, and 3 deploys auto-rolled-back on seed scripts (v1.15.0, v1.22.0, v1.24.0). Add one shared, mutable, never-reset test DB and same-author tests. Thirteen adversarial review rounds in eleven weeks found what the suite could not.
4. **Rank-2: lifecycle shortcuts became the biggest retrofits.** DocDate pinned to "today" (41 pins remain in `backend/src`; a settable date was approved 2026-08-12 and is still unbuilt), no void / reissue (cancel+reissue shipped in 2.5.0 under an 84-file cap), no draft edit / delete for TI and Receipt (2.5.0), a "customer has paid" button that bypassed the ledger (deleted in 2.0.0, a breaking change).
5. **Rank-3: invariants enforced on one code path only.** Five break-it findings were "the correct implementation sat a few lines away and was not called". The posting seam did not check period, precision or account type; payroll was the only GL writer with no period check; sub-satang money reached the immutable ledger by three independent paths.
6. **Flexibility ceiling is structural.** 23 GL account codes pinned in appsettings (`GlAccountsOptions`), no party or dimension column on journal lines (per-party AR/AP tie-out "impossible without schema change"), no manual JV / CoA management until 1.25.0 (2026-07-29), no GL opening balances, no vendor credit notes / purchase returns / prepayments / petty cash / AR-AP netting, THB only, no inventory, and VAT mode implemented as two parallel accounting models (non-VAT ran cash-basis on the sales side until 1.28.0).
7. **Real-world validation is thin.** Both real tenants are small and non-VAT. The VAT chain, payroll, ภ.พ.30 / ภ.พ.36 / ภ.ง.ด. filings were validated on dummy companies and hand calculation; ภ.พ.36 had never been finalized by any company as of 2026-08-13. Real tenant data now lives only on the old VPS database; the new prod does not hold it.
8. **Process cost was high but bought real catches.** The multi-model pipeline (spec -> Opus design -> Sonnet implement -> Opus Tier-2 review -> Tier-3 gate -> Tier-4 live) caught money bugs at review time (several REJECT rounds). The price: 94 specs (3.3 MB), a 207 KB wiki, 8 overlapping tracking surfaces, ~60% of tracked files being docs / test evidence rather than code.
9. **The wiki is mostly friction.** 54 of 103 entries are tooling, deploy or test-environment friction, not product logic (section 2.4). Removing that friction at source is a TEAS 2 design goal, not a documentation task.
10. **Owner voice (section 5).** Fewer and clearer buttons, no dead UI, suggestions instead of choices, screen == print, hide what does not apply, edit / cancel posted documents traceably, "a complete webapp". Ham's own meta-question: why do bugs sleep in a 100% AI-built system?
11. **Open items that are not code** (section 7, first): real-tenant data stranded on the old VPS; the real tenant's amended ภ.ง.ด.50 track with เงินเพิ่ม accruing; CPA sign-offs still outstanding.
12. **Keep list** (section 8.2): two-layer tenant isolation, immutability triggers, gap-free numbering, server-side VAT derivation, the agent "draft, human posts" model, RD form fillers, Cartesian RBAC test, blind acceptance tests, Tier-4 live acceptance.

---

## 1. Release timeline

| Phase | Dates | Versions | Headline features and events |
|---|---|---|---|
| A. Foundation sprints | 2026-05-15 .. 05-19 | pre-1.0 (no tags kept) | Domain / EF / RLS / JWT+RBAC; TI, Receipt, CN/DN, PV + WHT 50ทวิ; GL auto-post; period close; e-Tax XAdES skeleton (inert from day one). Sprints 1-14 (numbered non-linearly: 13c-13k): Business Units (S8), AR-side WHT (8.6), foreign vendor (8.7), reports + tax filings (S9), product master + quotation chain (S10), attachments (S11), internal PO (S12), e-Tax tier infra (13c), external API + API keys + Idempotency-Key (S14), shared test-id fix (14.5). First git commit is "Phase 1 baseline -- post Sprint 13c" (2026-05-18). Early process used an external reviewer persona ("Sana") via Question-/Answer-/Report-Backend files; 109 such files were purged 2026-06-17. |
| B. Breadth | 05-22 .. 06-16 | pre-1.0 | UI redesign + TanStack DataTable on 17 list pages; non-VAT mode (3 phases); invoice flow + universal print; purchase phase 1; 50ทวิ AcroForm fill; payroll (PIT, SSO, ภ.ง.ด.1 / 1ก, สปส.1-10); CIT (ภ.ง.ด.50 / 51); per-company VAT mode (06-11, moved off instance config); per-company RBAC + Cartesian audit (06-14); onboarding wizard + company switcher; 46-chapter manual; **EF migration squash 41 -> 1 (06-16)**; MinVer + release-please (06-16). |
| C. Hardening + first prod | 06-17 .. 06-22 | v1.0 pointer .. v1.8.5 | As-built spec rewrite and purge of 109 stale docs (06-17); 9-lens whole-codebase review (06-17/18); in-process MCP server (06-18); **git history scrub + v1.4.0 (06-18)** after a committed MFA key; 1.5.0 review fixes; 1.6.0 RD Prep exports; **1.7.0 prod live (06-21)** -- first boot hit RLS 42501 on seeds; **1.8.1 (06-22): non-super users logged in with an empty token** (RLS hid roles/perms during anonymous login). |
| D. Agent surface + review-driven fixes | 07-02 .. 07-12 | 1.9.0 .. 1.19.0 | Canonical paper DTO (screen == print) 1.9.0; OAuth 2.1 authorization server 1.10.0; full-codebase review fixes (10 HIGH / 12 MED / 7 LOW) 1.10.3; Workers project deleted 1.10.4; DCR 1.11.0; GL report 1.12; MCP expansion 1.13; AR/AP subledgers + balance sheet 1.14; super-admin tenant scoping 1.14.1; year-end close 1.15 (**rolled back**, hotfix 1.15.1); bank reconciliation 1.16; expense claims + fixed assets 1.17; MCP v2 + Codex cross-family fixes 1.18. |
| E. Swarm era | 07-13 .. 07-31 | 1.20.0 .. 1.27.1 | MCP document chain 1.20; purchase UX F1-F29 1.21; 13 releases of 1.22.x in 8 days (company-create atomic, payroll opening YTD, two more seed rollbacks, CRIT-1 numbering collision, RBAC splits, army fixes); payroll proration 1.23; payroll deductions / monthly period reopen / on-screen SSO schedule 1.24; **manual JV + CoA management 1.25 (07-29)**; ภ.ง.ด.2 1.26; signature / stamp / foot layout 1.26.1; MCP manual-journal draft 1.27. |
| F. Break-it remediation | 08-12 .. 08-14 | 1.28.0, 2.0.0, 2.1.0, 2.2.0 | R1 ledger integrity (sub-satang guard, non-VAT AR accrual, expense account type, payroll period guard); **2.0.0 BREAKING** (mark-settled deleted, ภ.พ.36 once at payment tax point, filings need Posted payroll); 2.1.0 (attachment IDOR, per-company numbering); **2.2.0 BREAKING** (duplicate document numbers made structurally impossible; 11 prod duplicates renumbered). **08-14: prod server crisis (disk 96%), prod deliberately down.** |
| G. External reviews + cleanup | 08-15 .. 09-05 | 2.3.0 .. 2.4.0 | Local hard-test round (14 findings), swarm round 2, cleanup batch, Codex review (12 findings) -> 2.3.x (08-20); **prod re-launched on Coolify (08-22)**; GPT-5.6 review remediation + document-level idempotency fence 2.4.0 (09-05). |
| H. Lifecycle retrofit | 10-04 .. 10-05 | 2.5.0 | Draft edit for Receipt / TI, notes field, **cancel + reissue** of TI / Receipt / Invoice (schema, triggers v3, permissions, reports). |

Cadence note: 73 releases in 109 days is ~1 per 1.5 days; 13 of them (1.22.x) landed in 8 days, mostly hotfix chains. The release unit was "whatever the last review round found", not a planned increment.

Production history: live from 2026-06-21; Cloudflare 503-but-applied writes seen 07-16; hosting crisis 08-14 -> down until 08-22 on a new host; the only two real tenants (co2, co3; both non-VAT) are small (dozens of documents each).

---

## 2. Recurring defect classes

### 2.1 How to read this section
The ranking is by frequency x cost, using the evidence that exists: incidents that reached prod or forced a rollback, counts of distinct findings, spec size and blast-radius caps, and release count. Keyword counts over the wiki are given only as "entries mentioning" because they overlap (an entry saying "permission" in passing lands in the auth bucket).

### 2.2 Ranked table

| Rank | Class | Frequency (evidence) | Cost (evidence) |
|---|---|---|---|
| 1 | **Environment-masked defects**: tests green, prod or adversarial pass red (RLS under superuser, shared mutable test DB, same-author tests, Windows-vs-Linux) | >= 11 prod-only RLS / tenant incidents (list in 2.3.1); 16 test-environment wiki entries (primary); 13 adversarial rounds | 3 rolled-back deploys (v1.15.0, v1.22.0, v1.24.0); login outage v1.8.1; first-boot failure v1.7.0; 1,243-test suite caught none of the 14 hard-test findings (5 money / tax); Codex found 11 issues (2 blocking) that three Claude-family review layers missed; `teas_test` reset cut the suite from 17-21 min to 9m49s and ended "five false alarms in one session" |
| 2 | **Document-lifecycle model gaps** (pinned DocDate, no void, no draft edit / delete, side-door settlement) | 7 distinct retrofits (section 3); 41 `TodayInBangkok` pins remain; Feature B still unbuilt | Cancel+reissue spec 83 KB, 84-file cap, 5 WPs + a Tier-2 REJECT + 12-file remediation; draft-edit 30-file cap; 2.0.0 breaking change; TI with no DELETE route could block period close forever; stuck PV and payroll-run dead ends |
| 3 | **Posting-seam invariants enforced on one path only** ("second code path never adopted the fix") | VERDICT table: 5 findings of this exact shape; sub-satang by 3 paths; payroll the only GL writer without `EnsureOpenAsync`; H3 conversion routes check source scope, not target scope (systemic) | 1.28.0 + 2.0.0 (breaking) releases; co5 trial balance permanently `822801.785`; PV with self-withhold failed `gl.unbalanced` for every VI-linked voucher (CRITICAL, ภ.ง.ด.54 printed 0) |
| 4 | **Document numbering** | 7 CHANGELOG fix bullets; 2 primary wiki entries (6 mention it); SQL 613, 626, 634, 635, 644; releases 1.22.6, 1.22.7, 2.1.0, 2.2.0 | 11 duplicate numbers on prod (one on a real tenant), 7 unique indexes rebuilt behind 4 preconditions (a bad index = API restart-loop); permanent poisoning of the shared test DB by one malformed `doc_no` |
| 5 | **Period / date / timezone semantics** | ~8 primary wiki entries; C3, H10, H11, H12, L1, O14 in specs; 2 UTC-vs-Bangkok incidents (night-time test failures; report default as-of) plus a month-end-dated JE that "disappears" from an as-of-today TB | A company "bricked" until the calendar moved (no monthly reopen until 1.24.0); ภ.พ.36 filed in the wrong month (เงินเพิ่ม 1.5%/month); 3-way year-close deadlock; back-dated JEs after reopen left no readable audit trail |
| 6 | **Money precision / arithmetic / sign on documents** | ~12 distinct incidents (2.3.3) | CRITICAL VI-linked PV; conversions losing discount (฿401.25 overstated, immutable legal document); `V7` vs `VAT7` orphan tax codes; a spec-level sign flip caught only by the orchestrator's diff read |
| 7 | **Idempotency and concurrency** | Idempotency designed 3 times (S14 -> claim-first -> document fence); H2 raw 500s on double-post; inert concurrency tokens; I10 un-transacted saves | Two Codex P1 rounds; blast caps 14 + 20 files; DDL migrations; `Version` token on PV configured but never bumped, so a cancel-vs-post race could void a posted voucher |
| 8 | **Auth / OAuth / MCP / RBAC scope** | ~32 security / auth CHANGELOG bullets (keyword); F5, H3, H4, MCP `.post` denylist, OpenIddict handler order, consent gating | A key scoped for billing notes could mint a Tax Invoice (F5, live exploit); attachment IDOR (H4); undeletable tax invoice drafts created by agents |
| 9 | **Apply-once SQL seed / migration mechanics** | 111 scripts; by file name: 62 "seed", 18 RLS, 12 immutability, 17 repair / reconcile (categories overlap); 4 duplicate numeric prefixes | Braces in a *comment* broke every DB test; an ordering bug silently left core perms super-admin-only; the same repair was needed twice (637 then 638); deploy probes mis-read the script ledger (false rollbacks) |
| 10 | **PDF / RD forms / Thai text** | dozens of coordinate-fix commits 06-09 .. 06-15; 6 primary wiki entries | A false CRITICAL (C4) from `pdftotext -layout`; SSO files silently turned unencodable names into `?`; Bengali look-alike of Thai ม kept re-entering legal citations (every gate greps for it) |
| 11 | **Deploy / ops / topology** | 18 primary wiki entries; 6 rollbacks; BFF passthrough per public route | 3 probe-caused false rollbacks (v1.17.0, v2.0.0, v2.1.0); `sudo` deploy chowned the source tree; Cloudflare 503-but-applied; real data stranded on old host after migration |
| 12 | **FE consistency and UX defects** | 54 UI/i18n CHANGELOG bullets (keyword); 9 list pages with a byte-identical stale-cache bug; 16 `/new` routes rendering write forms to unauthorised roles | A stale edit modal silently overwrote new values; white-screen ChunkLoadError with no error boundary; raw i18n keys on screen |
| 13 | **Tooling friction (Windows / Git-Bash / sandbox)** | 20 primary wiki entries | Agent time, not product defects: MSBuild DLL locks, `subst` drives, PowerShell mangling Thai, pnpm / vitest quirks |

### 2.3 Representative examples by class (evidence)

**2.3.1 Environment-masked defects (rank 1)**
- Root decision: `NEXT-SESSION.md` note recorded in commit `aab2617` (2026-06-11) -- "BYPASSRLS on dev accepted". A NOBYPASSRLS test role (`teas_rls_test`) was added 2026-06-22 (progress cont. 113) but the dev DB user lacks CREATEROLE, so the RLS test **skips** locally (wiki: "New RLS test SKIPs ..."). `STATUS.md` 2026-08-15: "RLS is not exercised locally -- both PG roles are BYPASSRLS". `docs/archive/PLAN-test-hardening.md` WS-3 (NOBYPASSRLS lane + seed-runner gate, 2026-07-30) is Phase 2; no commit implementing it was found.
- Prod-only RLS / tenant incidents (each invisible on the superuser test DB): v1.7.0 first boot 42501 on seeds (progress.md 2026-06-21); v1.8.1 empty token at login; H5 api-key lookup 401 under RLS (1.10.3); H2 Workers ran tenant-blind (1.10.3 / 1.10.4); v1.15.0 seeds 610/611 (rollback); v1.21.6 company creation not atomic / RLS-incorrect; v1.22.0 seed 625 (rollback); v1.22.11 super-admin cross-company update 500; v1.24.0 seed 630 (rollback); seed 181 left `ap_clerk` / `sales_staff` with zero roles on every fresh install (fixed 2.3.0 via 641); `IdempotencyCleanupHostedService` purges 0 rows under NOBYPASSRLS (wiki entry 2026-09-04; still unfixed in source -- `IdempotencyStore.PurgeExpiredAsync` is a bare `ExecuteDeleteAsync`).
- Shared mutable test DB: ~1,650 tests, one `teas_test`, random-year / random-id helpers that collide as it grows (`RandPeriod`, `FreshYearAsync`, `FreshJeYearAsync`, `Random.Shared.Next(500_000, 699_999)` company ids). One malformed posted `doc_no` poisoned the DB permanently because triggers forbid cleanup (wiki: `tax.v_number_gaps` int overflow). A leaked fixture with 4-dp salary made 17 payroll tests fail after an unrelated guard landed. "A green suite can be evidence a security hole is OPEN": the test for `create_invoice_draft` asserted the vulnerable behaviour.
- Same-author bias and no oracle: `PLAN-test-hardening.md` section 0 names six classes the suite is structurally blind to (self-testing bias, oracle problem, environment lies, seed / data bugs, FE-BE mirror drift, real-screen integration). Example of the oracle problem: director interest was filed on ภ.ง.ด.3 at 1% for the system's whole life (ภ.ง.ด.2 at 15% shipped only in 1.26.0).
- Windows-vs-Linux: 351 backend tests failed on Linux CI only after an eager `Directory.CreateDirectory("/var/teas")` (wiki, 2026-09-05); CSV `AppendLine` CRLF vs LF (v1.12.0).

**2.3.2 Document-lifecycle gaps (rank 2)**
- `CLAUDE.md.bak` section 10: "trust user input for doc_date" forbidden; every create path pins DocDate to `TodayInBangkok()`; PV re-pins a second time at POST (`PaymentVoucherService.cs` ~496-498). Consequence chain: no back-dating (Ham 2026-08-06), ภ.พ.36 lands in the posting month not the payment month (wiki "L1"), replacement documents need an explicit exception to keep the original date (cancel+reissue spec 8.2), `CreateDraftAsync` silently discards its own `docDate` argument (wiki, 2026-07-29).
- No void: "Same-day void and reissue -- corrections are Credit Notes, not voids" was a stated non-goal in the as-built spec (section 8). `DocumentStatus.Voided` existed but nothing wrote it (cancel spec F1); a first writer of a status value required a consumer sweep (number-gap view F16, VAT queries F17, watermarks).
- No draft delete / edit: "A draft tax invoice created from a quotation cannot be edited or deleted from the browser" (wiki, resolved for edit in 2.5.0; delete route for TI still absent except replacement drafts). Agent-created TI drafts could not be removed and blocked month close (F5, 2026-08-15).
- Side-door settlement: `MarkSettledAsync` ("customer has paid") settled invoices without crediting AR or debiting cash; Ham ordered it deleted (2026-08-12 answer 3), shipped as breaking 2.0.0.
- Guards without exits (wiki, "A payroll run with a pay date before its own period start can never be posted, deleted, or replaced"; "period.closed ... company looks permanently bricked"; stuck Approved PV with no cancel; poisoned expense category with no delete route; H10 year-close three-way deadlock). Lesson recorded by the team: "a guard is only safe if the state behind it has an exit".

**2.3.3 Money / precision / sign (rank 6)**
- C1: sub-satang amounts reached the immutable ledger by three paths (journal draft + MCP, expense claims rounding to 4 dp, payroll deduction 100.129); money columns are `numeric(19,4)` while legal amounts are satang (VERDICT C1; fix at `JournalEntry.MarkPosted` in 1.28.0).
- Self-withhold gross-up debit never booked on VI-linked PV: every such voucher 422'd `gl.unbalanced`, so ภ.ง.ด.54 printed 0 (army B-rc F1, 1.22.11).
- Conversions lost the line discount and invented a tax code (`V7` vs master `VAT7`): F8 / F8b / F13 / F14 (unit A, 2.3.0). The shared `ChainLineDto` carried no `lineId`, `discountPercent` or `taxCode`; Tier-2 REJECTed the first cut because *edit forms* re-hydrated from the same thin DTO while the suite stayed green at 1,241.
- Unit confusion: the FE sends VAT rate as a fraction (0.07) while a test script sent 7, producing ฿70,000 VAT on a ฿10,000 line (progress.md, 2026-05-22); later a "percent-UI conversion" was needed (purchase WP1).
- `year * 100 + month` aliasing: `month=-88` returned December 2025 data labelled August 2026 (wiki).
- Spec-level errors: a sign-flipped bank-rec tie-out in the *spec* (caught by the orchestrator's diff read, 2026-07-09); a money spec that stated observable values ("VAT totals are 0") instead of the invariant shipped a voucher that under-paid the vendor and stranded AP (2026-07-25). Both are now rules in the project `CLAUDE.md`.
- Printed-document foot errors: non-VAT PV prints a grand total its lines do not add up to (H15); PV preview overstated Net by the WHT (F9).

**2.3.4 Numbering (rank 4)**
- The "branch" scoping of the sequence was "an accident of who is logged in" (web UI = branch 0, API key / MCP = real branch), so one company ran two counters into one visible number space (`specs/fix-duplicate-tax-doc-numbers.md`, H1). Fixed in 2.1.0 (allocator) and 2.2.0 (unique `(company_id, doc_no)` indexes; BREAKING flag).
- CRIT-1: retry cap was off by one, so a collision on the final attempt escaped as a raw 500 deterministically (v1.22.6 shipped with it; 1.22.7 fixed). `NumberedDocumentWriter` now takes a per-attempt savepoint.
- Drift reconciliation needed three scripts (626, 634, 635); `tax.v_number_gaps` cast the digit run to `int` and overflowed (613 bigint fix; 644 for voids); the gap report reported "no gaps" over duplicate numbers (it detects missing, not reused).
- Document number = `MM-YYYY-PREFIX[-BU]-NNNN`, monthly reset, number derived from DocDate -- which is exactly why back-dating (Feature B) and cross-month replacement are hard.

**2.3.5 Period / date / timezone (rank 5)**
- Missing period row defaulted to OPEN (code review 2026-06-17); payroll `PostAsync` / `PayAsync` never called `EnsureOpenAsync` (C3) -- posted into explicitly closed June and into period `209912`.
- UTC vs Bangkok: tests using `DateTime.UtcNow` fail only 00:00-07:00 ICT (wiki 2026-07-26); Trial Balance and Balance Sheet default `asOf` to UTC while AR / AP aging use Bangkok (H12) -- **still present**: `backend/src/Accounting.Api/Endpoints/ReportEndpoints.cs` lines ~70 and ~78 use `DateTime.UtcNow`, lines ~180 and ~193 use `UtcNow.AddHours(7)`.
- Depreciation JE is dated month-end, so TB "as of today" hides it (wiki, 2026-07-22).

**2.3.6 Idempotency and concurrency (rank 7)**
- Sprint 14 P4 (2026-05-18) middleware arbitrated *after* the business operation; GPT-5.6 review CRITICAL-01 (2026-09-04) -> claim-first (2.3.3) -> Codex P1 F1/F2 -> document-level fence with partial unique index and advisory lock (2.4.0). Three designs for one concept in 3.5 months.
- Double-post race returned raw 500 on TI / Receipt / JV (H2); only PV mapped the concurrency exception. A cancel-vs-receipt-post race was found by Tier-2 on the 2.5.0 work (R1 F1).
- I10 (doc save and activity-row save as two separate `SaveChangesAsync` calls) is still visible in `backend/src/Accounting.Infrastructure/Sales/TaxInvoiceService.cs` (pairs at ~145-148 and ~465-467); WP-J moved keyed creates into an owned transaction, but no commit closing WP-H / I10 was found.

**2.3.7 Auth / OAuth / MCP / RBAC (rank 8)**
- F5: MCP `create_invoice_draft` is polymorphic (Tax Invoice on a VAT company, billing note on non-VAT) but was gated only by `sales.billing_note.manage` -- a live exploit; H3: every convert route checked the *source* document's scope, not the target's; H4: attachment download skipped the parent permission guard.
- The MCP "never post" invariant was a *denylist* (`EndsWith(".post")` after `Trim()`), bypassable with a zero-width space; the allowlist (`McpScopes.Normalize`) already existed. The denylist is still the mechanism in `ApiKeyService.EnforceMcpNoPostGuard` (now a wider suffix list, still `Trim()`-based).
- Two different permission checks (JWT claims vs fresh DB lookup) made synthetic-token RBAC tests prove the wrong thing (wiki). OpenIddict custom handler used the same `Order` as a built-in handler and silently never saw `AuthorizationEndpoint`.

**2.3.8 Seed / migration mechanics (rank 9)**
- Startup `SqlScripts/*.sql` run as the app role with **no tenant GUC set**; G1 tables fail 42501, G3 tables silently return zero rows (so a per-company fan-out "succeeds" and inserts nothing). The fix pattern (per-company `DO` loop with `set_config('app.company_id', ...)`) had to be rediscovered three times (610/611, 625, 630) plus 181.
- `ExecuteSqlRawAsync` treats the whole file as a `string.Format` template: a regex quantifier in a *comment* (`{13}`) failed every DB test at fixture init.
- RBAC seed ordering: a grant script silently no-ops if the permission code is inserted by a later-numbered script (Cartesian audit found core perms super-admin-only; 530 reconcile; wiki "RBAC seed-ordering footgun").
- Deploy probes compared prod's `applied_sql_scripts` count to the repo file count (prod had 68, repo 88 after the squash) and rolled back a healthy release.

**2.3.9 PDF / RD forms / Thai (rank 10)**
- Filled official RD AcroForms with hand-measured coordinates: ภ.ง.ด.54 combs, ภ.ง.ด.3/53 decimal totals, ภ.ง.ด.51 page 2, ภ.ง.ด.50 7 pages / 478 widgets; "ไม่ตรงช่อง" feedback; Ham validates positions from a rendered image (cancel/backdate spec 6 Q4). A swarm "CRITICAL" (C4: totals on the wrong row) was retracted after the render was *looked at*: `pdftotext -layout` had misattributed row 6 to row 5.
- Thai corruption vectors: PowerShell and Git-Bash `curl -d` turn Thai into `?`; `Encoding.GetEncoding(874)` default fallback silently writes `?` into the สปส.1-10 file (H9); PDF text extraction drops tone marks and is not stable run to run; re-rendering the same RD PDF is not byte-deterministic.

### 2.4 Wiki tally -- primary class of all 103 entries

| Primary class | Entries |
|---|---|
| Tooling / Windows / sandbox / build | 20 |
| Deploy / release / CI / infra | 18 |
| Shared test environment / flake / false-green | 16 |
| RLS / tenant isolation (prod-only) | 8 |
| Period / date / time | 8 |
| Tax-compliance semantics (ภ.พ.36, WHT forms, e-filing) | 7 |
| Auth / OAuth / MCP / RBAC | 6 |
| PDF / Thai / encoding | 6 |
| SQL script / migration / seed mechanics | 3 |
| Secrets / git hygiene | 3 |
| Numbering | 2 |
| Money / validation / API contract | 2 |
| Immutability / state-machine dead ends | 2 |
| FE / UX | 2 |
| **Total** | **103** |

Reading: 54 of 103 (52%) are environment or process friction. The wiki is worker-facing (symptom -> fix), so it over-represents friction; product defects live in `specs/`, the VERDICT / PROGRESS records and `CHANGELOG.md` (219 fix bullets). Keyword view of the same wiki (entries mentioning, overlapping): auth/permission 32, tooling 32, deploy 27, shared-test 26, SQL/seed 25, PDF/Thai 24, concurrency 23, tax 16, RLS 13, period/date 7, numbering 6, immutability 5.

### 2.5 Adversarial rounds -- what found the defects the suite did not

| Date | Round | Result |
|---|---|---|
| 06-17/18 | 9-lens whole-codebase review (`docs/code-review-2026-06-17`) | raw 7 Critical / ~17 High; after gating 2 true compliance Criticals (doc_date taken from request; FX summed unconverted into ภ.พ.30) + RLS gap on sales chain |
| 06-19 | dual review Claude + AGY (`docs/code-review-2026-06-19`) | fixes in 1.5.0 |
| 07-04 | full-codebase review (Opus verify) | 10 HIGH + 12 MED + 7 LOW (1.10.3) |
| 07-10 | Codex cross-family review of v1.14-1.17 | 11 findings (2 blocking) that three Claude layers missed |
| 07-19..21 | 10-role UX swarm rounds 2-5 on a dummy company | CRIT-1 numbering collision, CRIT-2 role grant, RBAC holes, raw 500s |
| 07-22..25 | "army" -- 11 never-tested areas, VAT and non-VAT | 1 CRITICAL, 6+ HIGH, 14 owner scope decisions |
| 07-31 | break-it swarm, 17 agents on v1.27.1 | 6 CRITICAL (C4 later retracted), ~17 HIGH, 11 MED, ~10 LOW |
| 08-15 | local hard test (browser-first) | 14 findings in sales + purchase chains alone, 5 money / tax; 1,243 tests had caught none |
| 08-17 | ChatGPT review | N1-N3 (+ E1-E5): resolver ladder, quotation double-invoice, ... |
| 08-18/19 | swarm round 2 | 5 red / 4 orange / 5 yellow |
| 08-20 | Codex external review (code + UI) | 12 findings |
| 09-04 | GPT-5.6 Sol review | 8 findings, 1 CRITICAL (idempotency arbitration) |
| 09-05 | Codex re-review of the fix | 4 more incl. two P1 windows |

Lesson in one line: the *method* that worked was adversarial, outside-the-author, against a running system with a real DB role -- not more unit tests.

### 2.6 Production cost ledger
- 6 auto-rollbacks: v1.15.0 / v1.22.0 / v1.24.0 (RLS seed scripts) and v1.17.0 / v2.0.0 / v2.1.0 (probe bugs: wrong expectation of script count, HTTP 404-vs-401 on a removed route, UTF-16 vs UTF-8 .NET string heaps). Plus the v1.22.4 `sudo` FE deploy that chowned the source tree to root.
- 17 of 111 SQL scripts are repair / reconcile / backfill; 4 numeric prefixes are duplicated.
- 11 duplicate document numbers existed on prod; 7 unique indexes replaced in 2.2.0.
- Prod down 2026-08-14 -> 08-22 (hosting), then data re-entry required for the real tenants.
- Shared-DB flake families: 5+ named (`RandPeriod`, `FreshYearAsync`, `FreshJeYearAsync`, random company ids, autovacuum race).

---

## 3. Retrofits -- late features and constraints, and the day-one design they imply

| # | Capability | Added when (evidence) | What the late add forced | Day-one design for TEAS 2 |
|---|---|---|---|---|
| 1 | **Database-level tenant isolation** | Sales chain tables had no RLS until 570-573 / 581 (2026-06-18); audit-log RLS 585; super-admin "union of all companies" fixed 1.14.1 (07-08) by rewriting every policy (600); Workers tenant-blind (H2, deleted 1.10.4) | Policy rewrites on every table, `WITH CHECK` side effects (seeds, background jobs, super-admin writes all broke), a "Family B" inventory that still missed `CompanyService.CreateAsync` | One generator creates each tenant table + FORCE RLS policy + isolation test; app and tests connect as a non-superuser; super-admin = explicit "act as company" session pin, never a union; background jobs run per-tenant with a pinned context |
| 2 | **Settable document date** (Feature B) | Ham /goal 2026-08-06; binding rules 08-12; **unbuilt in 2.5.0** | Number derives from DocDate; PV re-pin at POST; ภ.พ.36 tax point; replacement-document exception; 41 pins to remove | Explicit date model from day one: document date, posting date, tax-point date, payment date as separate fields with separate validation; period gate on posting date; number allocated from the document's own period |
| 3 | **Void / cancel / reissue with reversal** | 2.5.0 (10-05); spec 83 KB, cap 84 files, WP-1..5 + REJECT round + 12-file remediation; triggers v3; perms; reports | Consumer sweep of every query that filters `Status == Posted`; number-gap view; trigger transition rules; receipt/BN/TI interlocks; FE for cancel-and-reissue | Lifecycle states (Draft, Approved, Posted, Voided, Replaced) and reversing-entry posting designed with the first document type; replacement link columns; every report built on one "effective document" view |
| 4 | **Draft edit / delete for TI and Receipt** | Service methods existed but only MCP reached them; web edit 2.5.0 (cap 30 files) | Edit-vs-post race (`SELECT ... FOR UPDATE`, Version), settlement applications rebuilt, idempotency-fence interactions | Every document type gets the same command set (create, edit-draft, delete-draft, post, cancel) from one document engine |
| 5 | **Settlement truth** (receipt is the only proof of payment) | `MarkSettled` deleted in 2.0.0 (breaking) after R1 made invoices accrue AR | Breaking API removal; pre-flight report of settled-without-receipt rows | One settlement/allocation engine (receipts and payments applied to documents); no status flag that can be set without a ledger entry |
| 6 | **Numbering model** | 2.1.0 / 2.2.0; 11 prod duplicates; 4-precondition deploy; scripts 626/634/635 | Renumbering posted documents and their JEs (reference/description denormalised) | Series = (company, document type, period) with a company-wide unique index from the first migration; every scoping dimension appears in the printed string; allocation inside the posting transaction |
| 7 | **Idempotency** | S14 (05-18) -> claim-first (2.3.3) -> document fence (2.4.0) | 2 external reviews, DDL migrations, middleware + 3 services + schema | Client key stored on the document row (partial unique index) and checked inside the create transaction; one command pipeline |
| 8 | **Period control** | default-open period row (fixed 06-18); payroll bypass (1.28.0); monthly reopen O14 (1.24.0); year-close interlocks | Companies bricked until reopen existed; reopen unauditable (H11) | Period service called by the single posting seam, never by callers; reopen/close are audited commands; every guard has a documented exit |
| 9 | **VAT mode and non-VAT accrual** | Instance-wide `Tax:VatMode` -> per-company 06-11; non-VAT phases 05-23; AR accrual for non-VAT (C6) only in 1.28.0 plus a backfill endpoint and prior-period research | Two parallel accounting models; real tenant (non-VAT) had cash-basis sales; AR aging "empty" read as "nothing outstanding" | One accrual engine; VAT registration is tax-code configuration, not a parallel document model; non-VAT companies still have AR / AP |
| 10 | **Manual JV + CoA management** | 1.25.0 (07-29), triggered by Ham's director-loan question | Manual-JV backend existed but `PostAsync` had no period gate and never validated `AccountId`; `journal_lines` has no `company_id` and no FK to the CoA | General ledger entry, CoA editing and account validation in the first ledger milestone |
| 11 | **Screen == print** (canonical paper DTO) | Ham demanded identical text 2026-05-22; structural fix only in 1.9.0 (07-02); signature / foot layout spec 139 KB (07-29); mirror pair `PaperFootPlan.cs` vs `PaperFoot.tsx` still exists | 9 `/paper` endpoints; FE assembly deleted; two-implementation drift (700 vs 850 total) | One rendering model for preview and PDF; a single foot-math implementation or generated shared fixtures |
| 12 | **Per-company RBAC, read/manage split, FE route guards** | Per-company roles 06-14; Cartesian audit found a seed-ordering bug; read/manage split + route guards 1.22.8 (07-21); TAX_OFFICER / AUDITOR grants 1.22.6-1.22.12 | 16 `/new` routes rendered write forms to roles with zero write perms; endpoint inventory hand-curated | Permission catalogue in code, roles as data; FE derives visibility from the same catalogue; Cartesian test from day one |
| 13 | **Agent / MCP surface** | In-process MCP 06-18; OAuth AS 1.10.0; DCR 1.11.0; error surfacing 1.19; doc chain 1.20; manual-journal draft 1.27 | 87 tools in one 2,244-line file; scope escapes (F5, H3); denylist bug; 2.5 months of OAuth plumbing fixes | Agent API as a first-class client of the same command layer; scopes = subset of RBAC on the *target* operation; allowlist; "draft by agent, post by human" enforced structurally |
| 14 | **Payroll completeness** | Proration O8 (1.23), termination date O9, deductions O10 (1.24), SSO account O12, on-screen SSO schedule (O11-alt), opening YTD (1.22.0) | Army found a mid-month hire and leaver each got a full month of salary + PIT in the JE and the printed ภ.ง.ด.1 | Module "definition of done" checklist before declaring a module built (hire / leave dates, deductions, opening balances, filings' required fields) |
| 15 | **Money precision at the seam** | R1 WP-3 (1.28.0) | Sub-satang rows already immutable in dev companies; false-positive hunt (a company's whole payroll would have been refused) | Money stored and validated at its legal precision (2 dp) with explicit per-line rounding policy |
| 16 | **Fixed assets / depreciation** | Cycle D 1.17 (07-10); day-prorated redesign C4/C7 in 2.3.0 | Activation posted no GL (O1 warning added 1.23); `MonthsDepreciated` units schedule; period-close / depreciation deadlock (H10) | Asset register tied to acquisition document and ledger from the start |
| 17 | **Release engineering** | MinVer + release-please (06-16, after v1.0 work); Coolify version stamp via `backend/VERSION` (08-22); CI got vitest + lint + build only in 2.3.3 (09-05) | Stale-version footers; release-please PRs get no CI under the bot token (admin-merge rule) | CI parity with prod from commit one (Linux container), version stamped by CI, required checks for every PR type |
| 18 | **e-Tax** | Built 05-16..18 as scaffolding; never activated | ~1,160 LOC + 3 skipped round-trip tests + FE buttons removed 07-03 (Ham: "why show buttons when e-Filing isn't connected") | Either design e-Tax properly behind an interface with a conformance suite or keep it out of v1 |

---

## 4. Structural mess -- concrete evidence

### 4.1 Repo root and artifacts
- Tracked at root: `STATUS.md` (34 KB), `ROUTING-LOG.md` (35 KB), `troubles-wiki.md` (207 KB), `README.md` (32 KB, Thai), `CHANGELOG.md` (53 KB), `PLAN-gpt56-review-2026-09-04.md`, `PROGRESS-cancel-reissue.md`, `MIGRATION-CUTOVER-CHECKLIST.md`, `STATUS-TEMPLATE.md`, plus a stray `bp08-vi10-chain.png`.
- Untracked or ignored debris at root: 22 PNG mock-ups / screenshots (`mockup-*`, `pilot-*`, `rollout-*`), a file literally named `nul`, an ~8 MB `backend-dev-repro.log`, four `scratchpad_full_test_run*.log`, two gitignored bank-statement CSV/PDF exports, `CLAUDE.md.bak`, `graphify-out/` (45 MB, 488 files), `agy-out/`, `videos/`, `quota-guard/`, `.superpowers/`, `.playwright-mcp/`.
- Of 3,580 tracked files, ~2,150 (60%) are docs or test evidence (`docs` 991, `swarm-findings` 680 of which 528 PNG, `shots` 345, `specs` 94, `findings-r2` 42) versus ~1,350 (38%) code (`backend` 909, `frontend` 441). Generated artifacts are committed: `docs/_site` (359 files, 29 MB built manual), `docs/manual` (317 files, 24 MB), `docs/RD-Forms` (163 tracked files; 94 MB on disk).
- A `git add -f -A publish/` once staged 14,730 files including DLLs (wiki, 2026-08-13). History was rewritten on 2026-06-18 to purge a committed MFA key.

### 4.2 Knowledge and planning sprawl (>= 8 overlapping surfaces)
`STATUS.md`; root and archived `PLAN-*` / `PROGRESS-*` (~55 files in `docs/archive`, incl. `progress.md` 710 KB / 4,471 lines / 166 entries and `plan.md` 126 KB); `specs/` (94 files, 3.3 MB; the largest are `fix-breakit-r1-ledger-integrity` 173 KB, `fix-breakit-r2-compliance` 165 KB, `doc-signature-and-foot-layout` 139 KB); `docs/superpowers/{plans,specs}` (~46 more); `ROUTING-LOG.md` (~80 dispatch justifications); `troubles-wiki.md` (103 entries, no stable ordering) + `docs/runtime-gotchas.md` (38 gotchas, 66 KB); `CLAUDE.md` + `CLAUDE.md.bak` + user-level memory; `CHANGELOG.md`. Original design docs contradict reality: `docs/Design(Architect).md` specifies microservices on MS SQL Server while the built system is a modular monolith on PostgreSQL (the as-built spec lists MS SQL as "forbidden by policy"); the cost estimate assumes a 4-person team for 12-15 months.
- Spec hygiene: 1,201 ticked checkboxes vs 15 open + 3 partial, but `specs/TRIAGE-backlog-2026-08-19.md` found that of 65 then-open items 48 were already DEAD and 8 OBSOLETE (74% of "open" was stale); ~50 of 94 specs carry no "Status" string at all.
- 429 of 1,023 commits (42%) are `docs:`; 69 are `cont.NN` progress-log commits; 107 commits have no conventional-commit type; `STATUS.md` stops at 2026-09-05.

### 4.3 SQL / migration sprawl
- 111 numbered scripts in `backend/src/Accounting.Infrastructure/Migrations/SqlScripts/` plus 22 EF migrations (after squashing 41 into one `InitialCreate` on 2026-06-16, which is why prod's applied-script ledger shows 68 vs 88 in the repo at v1.17).
- Mix in one folder and one ordering: schema / extensions, RLS (18), immutability triggers (12), permission and role seeds (~27), demo-company data seeds (~12), views (4), and 17 repair / reconcile / backfill scripts. Apply-once-by-name semantics forced v2 / v3 chains (582 v2, 583 v2, 643 v3) and repeated repairs (626 -> 634; 637 -> 638; 636 / 641 role reconcile).
- Duplicate prefixes: 240 (x2), 430 (x2), 440 (x3), 450 (x2). Startup DML runs as the app role with no tenant context (section 2.3.8).
- Reference-only duplicates: `db/schema.sql`, `infra/db/schema.sql`.

### 4.4 Code-level inconsistency and duplication
- **One service per document type, re-implementing the same lifecycle.** Create / update / post / cancel / numbering / activity are re-written for Quotation, SO, DO, BillingNote, TI, Receipt, CN/DN, PO, VI, PV, expense claim. Consequences: the idempotency fence touched 3 services; draft-edit touched 2 plus MCP; cancel touched TI / RC / BN; 12 conversion paths were audited and 10 were already correct while 2 invented data (unit A).
- **"The second path never adopted the fix"** (VERDICT pattern table): `CreateJournalValidator` vs `CreateManualJournalValidator` 20 lines apart; `PaymentVoucherService.Read.cs` hard-coding "ต้นฉบับ" while `PaperDocConfig.Watermark` already maps cancelled; `ArAgingAsync` filtering no `asOf` while the reconcile query a few lines below does; SSO exporter with no mandatory-field refusal while the ภ.พ.30 exporter has one.
- **Giant files:** `Mcp/TeasMcpTools.cs` 2,244 lines (87 tools); `frontend/lib/queries.ts` 2,378 and `lib/types.ts` 1,769; `MasterDataServices.cs` 801 (several services in one file); `TaxInvoiceService` 904 + `.Read` + `.Cancel`; `ReceiptService` 836 + partials.
- **Frontend copy-paste:** the stale-cache BU column bug was byte-identical on 9 list pages; write-form route guards had to be added to 16 `/new` routes and several finalize buttons; PV and VI forms derived VAT separately (WP-F fixed the second path).
- **Mirrors:** FE foot math vs `PaperFootPlan.cs`; Zod vs FluentValidation; th / en message parity; error-code strings mapped by hand into `lib/i18n/problems.ts`; `RbacEndpointInventory` hand-curated overrides.
- **Two permission mechanisms** (JWT claims vs fresh DB lookup) behind different endpoints.
- **Config as code in appsettings:** `GlAccountsOptions` (23 account codes), `VatModeOptions` remnants, e-Tax / `RdApi` switches, non-VAT labels "instance-wide cosmetic".

### 4.5 Domain naming and model confusion
- `BillingNote` entity = Thai ใบแจ้งหนี้ (an "Invoice", route `/invoices`) and also the ใบวางบิล that sums linked tax invoices (the O2 / O2b ruling saga); Ham: "ต้องเป็น Invoice สิ" (2026-06-12). `create_invoice_draft` is polymorphic over TI vs BN (the F5 hole).
- CN and DN share one table (`sales.tax_adjustment_notes`); WHT certificates carry a Direction R/P; DB schema names differ from domain folder names (`Ledger` -> `gl`, `Sys` -> `sys`); phantom tax codes `V7` and `VAT0` existed in documents but in no tenant's master.
- Every internal term of art needs a glossary before TEAS 2 reuses names.

### 4.6 Stubs and dead weight
`JournalLine.DimensionsJson` (always `null` outside tests); `BusinessUnit.DefaultRevenueAccountId` (stored, never read by posting); `ExpenseCategory.IsCogs` with no COGS reporting; `Payslip.OtherDeductions` was a dead stub until O10; the separate `Accounting.Workers` host was never deployed and was deleted (1.10.4); e-Tax pipeline (~1,160 LOC, 14 files) inert for five months with an HTTP e-Filing client that is only a skeleton; `Design(Architect).md` / `Design(UI).md` describe a different system.

### 4.7 Test sprawl
241 test files / ~59K LOC share one `teas_test`; 14 baseline skips (a changed skip count is the only signal that an env var died); the 24 vitest files entered CI only with the 2.3.3 / 2.4.0 remediation and the 44 Playwright specs are still outside CI (`.github/workflows/ci.yml` has no e2e job); `purchase-chain.spec.ts` test #1 still sends `taxId: null` for a VAT vendor (line 38), which the vendor validator rejects, so it is red; env vars (`TEAS_TEST_PG`, `TEAS_REPO_ROOT`) must be re-set per shell; `PostgresFixture` locates SQL by a hard-coded five-level relative climb.

### 4.8 Environment and toolchain fragility
Windows dev with Linux prod / CI: `subst U:` / `W:` drives because the real path (~230 chars) broke `csc.exe`; a retired Y:-mirror workflow; `-m:1` builds; no psql / docker on the dev box; pnpm not on PATH; `next dev` and `next build` corrupt each other; PowerShell and Git-Bash mangle Thai; testhost locks DLLs; editing source while a suite runs invalidates the green result.

---

## 5. Owner UX / usability feedback

### 5.1 Largest single ask -- the 2026-08-06 /goal (flexibility + UX, still half delivered)
> "ต้องการให้มันแก้ invoice ใบเสร็จ ใบกำกับภาษี ที่ Post ไปแล้วได้ อาจจะเป็นการยกเลิกแล้ว Reissue ใหม่ก็ได้ (พร้อมทำให้มัน Tracable) พร้อมทำให้เอกสารทุกอย่างสามารถกำหนดวันที่ก่อน Post ได้ แล้วก็ Invoice อะ เอาปุ่มลูกค้าจ่ายแล้วออกไปเลย แล้วไปใช้ใบเสร็จเป็นตัวระบุว่าชำระแล้ว"
(`specs/doc-lifecycle-cancel-reissue-backdate.md`). Delivered: cancel + reissue with traceability (2.5.0), receipt as the only proof of settlement (2.0.0). **Not delivered:** settable document date before posting (rules fixed 2026-08-12: only inside an open period, no future dates, reissue may not change the total amount; zero commits since). 2026-10-05 follow-up: Invoice cancellable; Receipt and TI cancellable after post; notes on all three; an "ออกใบใหม่" button that prints "ยกเลิกและออกแทนฉบับเดิม เล่มที่… เลขที่… ลงวันที่…".

### 5.2 Ham's recorded UX statements (chronological)

| Date | Quote | Meaning | Outcome / evidence |
|---|---|---|---|
| 2026-05-22 | "เอารายการมาให้เลือกประเภท อย่าให้ user เลือกเอง" | Offer a suggested list; do not make users classify | WHT per-line category table, suggestions from the product (progress cont. 66) |
| 2026-05-22 | "ข้อความทั้งหมดต้อง Identical" | Screen text must equal the printed document | Six weeks later fixed structurally by the canonical paper DTO (1.9.0, 2026-07-02); mirror drift still existed in July (700 vs 850) |
| 2026-05-23 | "ซ่อนทั้งหมด + route guard" | Hide every VAT-only feature for non-VAT companies and guard the routes | NonVatGuard; later extended to buttons / PV form (WP-G) |
| 2026-05-30 | "ซ่อนใน UX + เพิ่มปุ่ม PV→VI" | Hide the standalone VI create; add PV -> VI shortcut | purchase completeness work |
| 2026-05-30 | "ยึดสรรพากร ไม่ใช่ admin เพิ่มมั่ว" | Follow the Revenue Dept rules, do not invent admin-made rules | WHT types kept admin-editable but permission-gated; every consumer reads the master |
| 2026-05-31 | "เมนูปริ้น ไม่ใช่ดาวน์โหลด" | A print menu, not a download | `printPdf` on ภ.ง.ด.1 / payslips |
| 2026-06-12 | "ต้องเป็น Invoice สิ" | The billing note is an Invoice | PDF label renamed |
| 2026-06-13 | "มีหน้าสรุปภาษีไหม -- เสีย/คืน/หักเท่าไหร่ + รายได้รายจ่ายรายเดือน" | One page: VAT payable / WHT / monthly income and expense | Tax-summary dashboard spec (2026-06-13) |
| 2026-06-15 | "ไม่ตรงช่อง" / "ขอเนียบ" | Printed RD forms not aligned to the boxes | Several alignment rounds; Ham validates from a rendered image |
| 2026-06-21 | "เข้า ... แล้วยังไป onboard อยู่" | Re-login looped to "create first company" | 1.7.2 |
| 2026-06-21 | wrong data typed at onboarding; wants "แก้ไขข้อมูลบริษัท" editing everything with a big warning; drop the redundant Logo URL field | Mistakes must be recoverable | 1.7.1 |
| 2026-06-22 | "ใน FE จะลงทะเบียน user ใหม่ยังไง" | No visible way to add a user | 1.8.0 admin user management |
| 2026-06-22 | "ตอน Select/Hover มันขาวเลย ทั้งเว็บ" / "toggle ... ต้อง toggle ก่อนถึงขาว" | Global styling regressions (checkbox / toggle states) | 1.8.2-1.8.5 UI fixes (four releases on 2026-06-22) |
| 2026-07-03 | "งง มีสองปุ่ม" | Approve banner plus normal action button duplicated | PR #34: duplicate action hidden while banner shows |
| 2026-07-03 | "ยังไม่ได้ต่อ e-Filing ทำไมปุ่มโผล่" | Do not show features that are not wired | e-Tax buttons removed (1.10.1) |
| 2026-07-19 | "แก้สิ เราต้องการ Webapp สมบูรณ์" | Wants a complete web app, not partial flows | usage-drive fix list |
| 2026-07-22 | "บางเอกสารฝั่งซื้อไม่มีที่อยู่ Vendor"; "อ่านไม่เข้าใจ" for the label "VAT เครดิตได้"; screenshot showing mismatched row control heights | Missing data on printed docs; unclear labels; visual polish | `specs/fix-purchase-nonvat-ux.md` |
| 2026-07-29 | page 2 should repeat the header ("ส่วนหัวเหมือนหน้าแรก") | Multi-page document layout | doc-signature spec |
| 2026-08-16 | Convert buttons: show **disabled with a tooltip naming the permission**, do not hide | Explain unavailability | F6 fix, shipped in 2.3.0 |

Also: Ham asked the VI list "settled" column be removed ("อาจไม่จำเป็น"); approved the demo with "รอบนี้ดูดี ผ่าน"; asked how to record a director loan and non-sales income (-> manual JV, section 6).

### 5.3 Owner meta-feedback on quality and process
- "AI 100% ทั้งโปรเจกต์ แต่บั๊กนอนในระบบได้นาน = ระบบเทสห่วยใช่ไหม, implementer เทสแบบ bias ไหม, ควรมี agent เทสแยกไหม" (2026-07-30, `PLAN-test-hardening.md`) -> blind acceptance-tester role, Tier-4 live acceptance, mutation-lite checks.
- "ไม่รู้เหมือนกัน ไปหามา" (2026-07-31): the owner cannot answer accounting-policy questions; research + CPA must supply the oracle (prior-period correction).
- Autonomy style: "ทำทั้งหมดยกเว้น server migration", "ช่างมัน Merge ไปก่อนได้เลย", overnight hand-offs ("ฝากทำต่อและเทสหน่อยนะ") -- the owner tolerates a lot of autonomous work but the project rules still demand his explicit go for prod deploy and tax-rule changes.

### 5.4 AI-tester UX findings that Ham approved for fixing (corroboration -- not Ham's words)
From the prod UX tests (`docs/archive/REPORT-sales-uxtest.md`, `REPORT-payroll-reports-uxtest.md`, `PROGRESS-purchase-uxtest.md`) and swarm rounds:
- S11: number-consuming and immutable actions (send quotation, post SO, issue invoice) fired on a single click with no confirm dialog; only Receipt had one.
- S12: side panels (references, activity) did not live-refresh; "ส่งแล้ว -> ส่งแล้ว" duplicate wording.
- S15: converted drafts (SO from QT, INV from SO) had no edit button.
- S16: receipt from an invoice did not prefill the Business Unit (data-entry risk); S9: agent drafts without BU passed API validation that the FE enforced.
- P1/P2/P5: empty error toasts for every PDF failure (HTTP/2 `statusText`); stale edit modal silently overwrote new values; zero-salary employees silently pulled into a payroll run and an all-zero run approvable.
- White-screen ChunkLoadError with no error boundary; dev notes leaked to prod; raw i18n keys (`common.deleted`, `status.Paid`); forms rendered to roles without permission; links that 403 on click.
- Business Unit column stuck on `#id` on 9 list pages (TanStack `_valuesCache` plus memo deps).

### 5.5 UX principles implied for TEAS 2
Do not show unwired features; explain disabled actions; confirm every number-consuming or immutable action with a totals dialog; one action per intent (no duplicate banner + button); suggest, do not make users classify; print == screen from one model; recoverable mistakes everywhere (edit company data, edit/delete drafts, cancel with trace); thai-first typed errors (no raw keys, no empty toasts); permission-aware navigation and routes (no forms for roles that cannot submit); refresh related panels after every mutation; print-first affordances for government forms.

---

## 6. Accounting-flexibility requests, gaps and decisions

| Request / gap | Source | Status at 2.5.0 | TEAS 2 implication |
|---|---|---|---|
| Edit / cancel posted TI, Receipt, Invoice; reissue traceably | Ham 2026-08-06 / 10-05 | Shipped 2.5.0; total locked on reissue (Ham 08-12 Q1) | Void / replace as core lifecycle; amount change only via CN/DN |
| Settable document date inside an open period | Ham 2026-08-06; rules 08-12 | **Not built** | Separate document / posting / tax-point / payment dates from day one |
| Director / shareholder loan; non-sales income (interest, rent, scrap) | Ham 2026-07-29 | Manual JV + CoA management 1.25.0; accounts 2190 / interest seeds (631-633); ภ.ง.ด.2 1.26.0 | General JV and CoA editing first; posting profiles configurable |
| Business Unit as analytical dimension | Sprint 8 (05-17); Ham 05-30 | BU on documents, numbering sub-prefix, GL lines; `requires_business_unit` company flag; P&L by BU | Dimensions as first-class, multiple, on journal lines and documents; not embedded in the number |
| Free-form dimensions (project, department, cost centre) | `JournalLine.DimensionsJson` | Field exists, never used | Real dimension model with validation and reporting |
| Per-party AR / AP tie-out | `specs/subledgers.md` | Impossible: "journal lines carry NO customer/vendor/party tag"; reconciliation only company-wide; manual JVs to 1130 / 2110 break the tie | Party column on journal lines; subledgers derived from GL |
| Account mapping per company / product / category | `GlAccountsOptions` (23 codes); `BusinessUnit.DefaultRevenueAccountId` unused; products carry no GL account | Fixed global roles; expense categories have default accounts | Posting profiles per company (role -> account) with CoA templates; per-product / category / BU overrides |
| Opening balances (GL, AR, AP, assets) | specs: fixed-assets, subledgers, fix-army O1 | Only payroll YTD opening (1.22.0); otherwise a manual JE; FA activation posts no GL (warning only); subledger cannot hold opening documents | Opening-balance import as a first-class, auditable mechanism |
| Prior-period error correction | Ham "ไม่รู้เหมือนกัน ไปหามา" | Research: correct in the current open period against retained earnings; `NonVatArBackfillService` + endpoint | Current-period correction entries with a reason code; no reopening of closed periods |
| Period control | O14 | Monthly reopen 1.24.0; year reopen; interlock with depreciation (H10 re-assessed softer) | Audited close / reopen commands; clear exits |
| Multi-currency | code review 2026-06-17 05-C1 | Deferred repo-wide: `ThbOnly` validators; FX summed unconverted into ภ.พ.30 was the finding | Decide now: THB-only v1 with schema ready for currency + rate, or full FX |
| Inventory, COGS, gross profit | as-built spec section 8 | Out of scope; `IsCogs` flag; "flat Revenue - Expense, no GP/COGS" | Decide scope; if later, stock and cost layers must hang off the same posting kernel |
| Vendor credit / debit notes, purchase returns, AP write-off, petty cash, vendor prepayment, AR-AP netting | `specs/fix-pnd36-payment-detection.md` C15 | "DO NOT EXIST" (verified absent) | Symmetric AR / AP adjustment model |
| Cash-flow statement, budget vs actual, equity statement | as-built spec section 8 | Not implemented | Reports derived from GL with dimensions |
| Non-VAT companies' accrual accounting | Break-it C6 | AR / revenue accrual added 1.28.0 plus backfill | One accrual engine for all companies |
| Payroll flexibility | army O8-O12 | Proration, termination date, deductions with GL counterpart, SSO account no., on-screen SSO schedule, opening YTD | Employee lifecycle dates, deductions, opening YTD in the first payroll design |
| Foreign vendor / reverse charge / self-withhold gross-up | Sprint 8.7; ภ.พ.36 specs | ภ.พ.36 at payment tax point; detector for AP cleared by manual JV | Tax event model keyed on the real-world event, not a column |
| Bank reconciliation formats | Cycle B | KBiz CSV + K-Plus PDF (password) parsers; matching engine | Import adapters behind an interface; matching on GL cash lines |
| Configurable document prefixes / numbering formats | `sys.document_prefixes` | Fixed `MM-YYYY-PREFIX[-BU]-NNNN`, monthly reset | Series as data, with the compliance invariants (gap-free, unique) enforced by the engine |
| Editable tax master data | Ham 05-30 | WHT types admin-editable with permission; tax config of a company is super-admin-only | Tax tables versioned with effective dates; changes audited |

---

## 7. Open / unfinished items TEAS 2 must decide or inherit

### 7.1 Not code -- read these first
1. **Real tenant data exists only on the old VPS database.** The two real companies (co2, co3; both non-VAT) are not in the new Coolify prod or local dev. `MIGRATION-CUTOVER-CHECKLIST.md` section 3.5: an extract was taken 2026-08-21 and "re-enter documents via UI/API and tie out against the bank statement" is unticked. Source of truth for real history is therefore a read-only SELECT on the old host and local CSV extracts. TEAS 2 needs an import / migration path (see lesson 14).
2. **Real-tenant tax track still running.** `specs/doc-lifecycle-cancel-reissue-backdate.md` section 7: an amended ภ.ง.ด.50 for the understated years of a real company; voluntary filing before an RD summons waives เบี้ยปรับ, เงินเพิ่ม 1.5%/month accrues until filed. No later record of completion.
3. **Professional sign-offs outstanding:** E1 (CPA on the ม.83/6 ภ.พ.36 rule -- the code implements it, confirmation never recorded); E2 (is the company the ผู้จ่ายเงิน when an employee pays an overseas provider personally -- a known UNCOVERED liability); G-CPA for cancel + reissue (research claims 1, 2, 5 and the reason-code list; Ham authorised merge without it); cancel-reissue O4 (warn-only vs block when that month's ภ.พ.30 is finalized) and O8 (cross-month memo rows); ภ.พ.30 treatment of a cancelled TI; army O6 (the "ลำดับที่ ... ในแบบ ภ.ง.ด.53" box on the 50ทวิ is always blank because the certificate is issued before the monthly filing -- research was requested, outcome not confirmed). Note the O-numbers belong to different specs; do not conflate them.

### 7.2 Product decisions and unbuilt features
- Feature B (settable DocDate) -- approved rules, no code; 41 `TodayInBangkok` pins remain; PV POST-time re-pin is the hard part.
- Items explicitly out of scope today: inventory, multi-currency, cash-flow, vendor credit notes, petty cash, prepayments (section 6).
- Break-it R4 (documents / reports + the LOW cluster) -- `STATUS.md` 2026-08-13 says "not designed yet"; no later record. Spot-checks of the source on this branch: **H12 still present** (TB / BS default as-of is UTC), **H7 still present** (`SubledgerReportService.ArAgingAsync` filters `Posted` and unpaid only, no `DocDate <= asOf`), MCP `.post` guard is still `Trim()`-based denylist. Remaining R4 items (payslip YTD frozen at creation H6, reopen unauditable H11, line numbers >= 10 wrapping, sales-summary excluding CN/DN, expense-claim amount cap, PO -> VI over-billing to ~200%) -- status unverified.
- O5 (no FE page for the sales-tax register; voided TIs appear only at API level).
- O2b follow-on: billing-note totals semantics (block-on-mismatch shipped, manual lines authoritative).

### 7.3 Cancel + reissue follow-ups (2.5.0, spec `specs/cancel-reissue-sales-docs.md`)
FU1 (discard refuses on link rows of a cancelled Invoice -> replacement draft stuck); FU2 (BN create / update vs TI cancel race, no lock); FU3 (reversal date fallback when original JE month closed); FU4 (F1 test ordering via `Task.Delay(800)`); FU5 (FE "เอกสารอ้างอิง" panel stale on a just-posted replacement); G-CPA. Also O10 known divergence: `FinancialReportService` sales reports drop a cross-month standalone-cancelled TI from its original month while the GL carries it until the reversal month.

### 7.4 Verification debt (Tier-4 live legs and cutover)
- 2.4.0 idempotency fence: live prod leg deferred by Ham on 2026-09-05 ("ข้ามไปก่อน เดี๋ยวค่อยทำ"); the leg recipe is in memory `teas-wpj-tier4-deferred`.
- 2.5.0 cancel + reissue: `PROGRESS-cancel-reissue.md` resume step 7 (Tier-4 on a sandbox tenant, with the irreversible-write resume protocol) is unticked; STATUS never records 2.5.0.
- `MIGRATION-CUTOVER-CHECKLIST.md` is unticked except the old-server extract, although prod went live on Coolify 2026-08-22 (last edit 2026-08-21): public-edge super-admin scope verify, MCP chain E2E, non-VAT AR backfill APPLY (money, posts real JVs), co2-style real-volume battery, seed 638 / 639 pre-probes.
- Test debt: lint baseline 17 warnings; Playwright still not in CI; random-id test helpers still in use (WP-G); `purchase-chain.spec.ts` #1 red.

### 7.5 Known unfixed defects recorded in the wiki or plans
- PND54 not accepted by the `WhtType` form-type validators / UI (FOR-SVC / FOR-ROYAL uneditable).
- `TaxFilingStore.FinalizeAsync` never checks `res.Submitted` / `res.Error` before recording "Submitted" (matters only if a real RD client is wired).
- `CreateDraftAsync` discards `docDate` (the ภ.พ.36 reverse-charge JV lands on today).
- `PUT /company-profile/soft` whole-overwrites every field while docs promise "omitted fields unchanged".
- WP-H / I10: document save and activity save not in one transaction on three create paths (still visible in `TaxInvoiceService.cs`).
- WP-I: idempotency purge worker blind under RLS (table grows forever on prod).
- Uncovered ภ.พ.36 channels: payments that never touch AP (`Dr expense / Cr bank`), employee reimbursements.
- `docs/rbac` endpoint inventory still hand-curated; `RbacAuthMap` needs `TEAS_REPO_ROOT` outside the standard path.

### 7.6 e-Tax / e-Filing status
Phase-1 scaffolding only (signer, XML builder, retry worker with dead-letter, append-only submissions table, mock RD client, HTTP client skeleton), default `Enabled = false`, `RdApi:Provider` normalised to Mock (fail-closed since 2.3.3). Activation plan `docs/superpowers/plans/etax-xades-production-plan.md` is **GATED by Ham's 2026-06-12 directive** until company revenue approaches ฿30M. Blockers in order: B1 inclusive-C14N self-verify cannot pass under .NET `SignedXml` (3 tests skipped; needs ETDA validator or Ham + ETDA ruling); B2 CA-issued signing certificate (~1 month lead); B3 ETDA sandbox UAT; B4 prod cutover. The FE buttons were removed in 1.10.1 and must be restored behind an `etaxEnabled` flag plus a confirm dialog. ภ.พ.30 / ภ.ง.ด. are print-and-file or RD-Prep "Format กลาง" text exports; **no automatic RD submission exists**.

### 7.7 Hygiene
- Test-account credentials are recorded in prose inside tracked `swarm-findings/*` reports (the wiki even advises searching them); rotate or purge before reuse.
- `STATUS.md` is stale after 2026-09-05; the root board and `docs/archive` cross-links point at pre-move paths.

---

## 8. Top 15 lessons for TEAS 2

Each lesson: what to do, the evidence, and the TEAS 2 implication.

1. **Run every environment as the production privilege level.** Dev, CI and tests connect as a non-superuser, NOBYPASSRLS role with FORCE RLS; seeds and background jobs run under that role. *Evidence:* >= 11 prod-only RLS incidents, 3 rolled-back deploys, Ham's 2026-06-11 acceptance of dev BYPASSRLS as the root decision, a skipped RLS test lane on the dev box, `STATUS.md` 2026-08-15 "RLS is not exercised locally". *TEAS 2:* the test database role is created by the bootstrap itself; a CI gate fails if any test connection is a superuser.
2. **One migration mechanism, no startup DML, catalogues in code.** Schema through migrations; permissions, roles, tax codes and CoA templates as versioned code or data applied by an idempotent per-tenant bootstrap (with explicit tenant context), not ordered apply-once SQL files. *Evidence:* 111 scripts (62 seeds, 17 repairs), brace-in-comment failure, seed-ordering silent no-ops, probes counting the script ledger, squash side effects. *TEAS 2:* one "create company from template" path used by onboarding, tests and demo data.
3. **Ephemeral, hermetic test data.** Per-class isolated database or schema, sequence-based ids, no random-id helpers, no shared mutable fixture, Linux CI as the gate. *Evidence:* 16 test-environment wiki entries, a permanently poisoned DB, five flake families, 17-21 min vs 9m49s suite, Windows-only green vs Linux-CI red. *TEAS 2:* the full suite must be runnable in parallel from a cold container.
4. **Model dates explicitly.** Document date, posting date, tax-point date and payment date are different things; periods gate the posting date; numbers come from the document's period. *Evidence:* the "always today" pin (41 sites) that produced Feature B, O14, L1 (ภ.พ.36 in the wrong month), PV double re-pin, UTC-vs-Bangkok night failures, back-dating Ham asked for on 2026-08-06. *TEAS 2:* a clock abstraction (Asia/Bangkok) used everywhere and a date-model table in the first spec.
5. **Design the full lifecycle and every exit on day one.** States Draft -> Approved -> Posted -> Voided -> Replaced, draft edit and delete, reversing entries, replacement links, and an escape for every guard. *Evidence:* the 84-file cancel+reissue retrofit and its consumer sweep (F15 / F16 / F17), stuck PVs, un-postable payroll runs, poisoned categories, H10 deadlock; "a guard is only safe if the state behind it has an exit". *TEAS 2:* a state-machine table per document type that lists each guard with its exit.
6. **One posting kernel that enforces all ledger invariants.** Balanced, 2-dp precision, open period, account active / non-header / right type / owned by the company, control-account rules, currency, tenant -- at the seam, not in callers or validators. *Evidence:* C1 by three paths, C3 payroll the only GL writer without a period check, C5 expense posted to bank, five "second path never adopted the fix" findings, `journal_lines` with no `company_id` and no FK. *TEAS 2:* every module posts through the kernel; invariants live in a property-test suite (Dr = Cr, subledger = GL, no gaps, period respected).
7. **Subledger and dimensions on the journal line.** Party (customer / vendor / employee), business unit and further dimensions, document link, tax code and WHT info stored per line; subledgers and aging derived from the GL with a true `asOf`. *Evidence:* "journal lines carry NO customer/vendor/party tag" (per-party tie-out impossible), unused `DimensionsJson`, H7 aging ignoring `asOf`, ภ.พ.36 detector built on AP because no party column exists. *TEAS 2:* the flexibility the owner wants is mostly this schema decision.
8. **Posting profiles per company, not appsettings.** A role -> account mapping table with CoA templates, overridable by product, category, BU and document type. *Evidence:* `GlAccountsOptions` 23 codes; every new account needed a per-company seed with RLS handling (610/611, 621, 625, 630, 631); `BusinessUnit.DefaultRevenueAccountId` stub; wrong default for the interest category (INTR -> 5200 instead of 5500); account-type validation missing (C5). *TEAS 2:* mapping validated at save (type, active, leaf) and snapshotted into the journal for audit.
9. **Numbering as a first-class series model.** Unique `(company, doc_no)` from the first migration; every scoping dimension appears in the printed number; allocation inside the posting transaction; gap report that also detects duplicates and voids. *Evidence:* H1 (11 prod duplicates, one on a real tenant), CRIT-1, 626 / 634 / 635 / 644, 2.1.0 + 2.2.0 breaking release, `v_number_gaps` overflow. *TEAS 2:* keep monthly gap-free series (a Thai compliance behaviour) but build the allocator and its concurrency tests first.
10. **Idempotency and concurrency belong to the command pipeline.** The client key is stored on the document and enforced by a partial unique index inside the create transaction; version tokens that are actually bumped; typed 409s; advisory locks where sequences are involved. *Evidence:* three designs in 3.5 months, two Codex P1 windows, inert `Version` on PV, raw 500 on double-post, I10. *TEAS 2:* one command bus with these properties and a real-concurrency test per command.
11. **One rendering model and one rules implementation for screen and print.** Preview, PDF and API read the same document model; foot math exists once (or is generated for both sides). *Evidence:* Ham's 2026-05-22 "Identical" demand fixed only on 2026-07-02, mirror drift 700 vs 850, H15, the 9-page BU bug, the 139 KB signature / foot-layout spec. *TEAS 2:* a "MIRRORS" count of zero is the target.
12. **Tax rules as data, with primary-source golden fixtures and CPA sign-off as a tracked gate.** Cite the law / RD format version; test against official samples and an RD-form render checked by eye; treat tax point and period as explicit event attributes. *Evidence:* director interest filed at the wrong rate for the system's life, L1, E1 / E2 / G-CPA open, C4 retracted after a render check, zero real filings, owner "ไม่รู้เหมือนกัน ไปหามา". *TEAS 2:* build the golden corpus with the owner's CPA before re-implementing the posting behaviour; "same tax-posting behaviour" is currently validated only against TEAS 1's own output.
13. **One accrual engine; VAT status is configuration.** All companies (VAT and non-VAT) use the same ledger, AR / AP and document engine; VAT registration changes tax codes, labels and filings. *Evidence:* non-VAT ran cash-basis on sales until 1.28.0 (C6); instance config -> per-company VAT mode retrofit; two document chains; empty AR aging read as "nothing outstanding". *TEAS 2:* the two real tenants are non-VAT, so this is the production-critical path.
14. **Own the data-in and data-out story from the start.** Import (opening balances, historical documents, bank statements), export / backup / restore, a migration runbook and a probe that asserts on state, not on file counts. *Evidence:* real data stranded on the old VPS, "re-enter via UI", opening balances done by manual JE, six probe-related or RLS rollbacks, prod-down week. *TEAS 2:* the cut-over from TEAS 1 data should be designed with the schema (documents, JEs, numbering continuity).
15. **Treat the agent surface and the review pipeline as part of the architecture, and scale ceremony to risk.** Agent API = same command layer, scopes defined on the target operation as an allowlist; module "definition of done" checklist (hire / leave dates, opening balances, filings' required fields, confirm dialogs, error codes, route guards, i18n) so features are not discovered missing by swarms; keep spec-first invariants, blind acceptance tests and Tier-4 live acceptance for money paths but cut the paperwork (one living spec per capability, generated docs). *Evidence:* F5 / H3 / zero-width bypass; unbuilt payroll proration, termination date, SSO part 2, FA acquisition GL found by the army; 94 specs / 8 tracking surfaces / 207 KB wiki / 42% docs commits; Tier-2 REJECT rounds that caught what green suites did not. *TEAS 2:* a short, enforced spec template and a single status board.

### 8.2 Keep list -- what held under attack (do not throw away)
- Money arithmetic: Dr = Cr held in every posted scenario; VAT rounding and 7/107 math; WHT on the pre-VAT base; payroll PIT / SSO ties to the satang; AR / AP subledgers reconciled to control accounts with difference 0.0000 (hard-test round).
- Two-layer tenant isolation (EF filter + RLS FORCE): no cross-tenant leak found in any swarm; cross-company ids 404 without existence leaks.
- Posted-document immutability by trigger plus no application mutate path; append-only audit log; number gaps never reused.
- Gap-free numbering under 20-wide concurrency (posting path), server-side VAT-rate derivation (`SalesLineBackstop`), per-line input-VAT guards (ม.82/5, ม.81).
- The agent model: MCP tools cannot post, draft-by-agent / approve-by-human with actor identity, cross-company drafts refused.
- RD form fillers and the discipline of rendering and looking at the output; official templates under version control.
- Test and review practices that earned their cost: Cartesian role x endpoint RBAC test, blind acceptance tester, Tier-2 reviews with named lenses (false-positive / dead-end lens first), Tier-4 live acceptance on real data, `git worktree` trick to prove a failure is pre-existing, "assert rowcount of every DB-mutating test setup".
- Domain knowledge assets: the 103-entry wiki and the research notes (ภ.พ.36 tax point, prior-period correction, cancel / reissue) are the best requirement sources for TEAS 2.

---

## Appendix A -- Key numbers

| Item | Value |
|---|---|
| Calendar | 2026-05-15 first work; first commit 05-18; prod live 06-21; latest release v2.5.0 on 10-05 |
| Commits | 1,023 (docs 429, fix 166, feat 147, chore 137, test 34, no-type 107) |
| Releases | 73 tags v1.4.0 .. v2.5.0; 219 fix bullets in CHANGELOG |
| Backend | ~56K LOC across 474 files (non-generated); tests ~59K LOC across 241 files; ~1,650 tests (Api 1,461 + Domain 188) with 14 baseline skips |
| Frontend | ~37K LOC across 249 files; 108 pages; 44 Playwright specs; 24 vitest files |
| API surface | 337 routes (8 anonymous, 17 authn-only, 312 permission-gated); 91 permission constants; 12 role templates; 87 MCP tools |
| Database | 9 schemas; 111 SQL scripts; 22 EF migrations after a 41 -> 1 squash |
| Documents | 94 specs (3.3 MB); 207 KB wiki (103 entries); 66 KB runtime-gotchas (38); `progress.md` 710 KB; 469 tracked `.md` |
| Review rounds | 13 adversarial rounds 06-17 .. 09-05; 6 auto-rollbacks; 11 prod duplicate numbers |
| Real usage | 2 real tenants on prod (co2, co3; non-VAT per project notes), small (dozens of documents each); prod dummy playgrounds co5 (VAT), co6 / co7 (non-VAT); local demo companies |

## Appendix B -- Evidence index (where to read more)
- Break-it verdict and fix arc: `docs/archive/VERDICT-breakit-v1271.md`, `docs/archive/PLAN-fix-breakit-v1271.md`, `specs/fix-breakit-r1-ledger-integrity.md`, `specs/fix-breakit-r2-compliance.md`.
- Test-system diagnosis: `docs/archive/PLAN-test-hardening.md`.
- Lifecycle retrofits: `specs/doc-lifecycle-cancel-reissue-backdate.md`, `specs/cancel-reissue-sales-docs.md`, `specs/draft-edit-receipt-taxinvoice.md`, `PROGRESS-cancel-reissue.md`.
- Numbering: `specs/fix-duplicate-tax-doc-numbers.md`, `specs/fix-swarm-crit-numbering-rbac.md`.
- Idempotency: `PLAN-gpt56-review-2026-09-04.md`, `specs/fix-idempotency-claim-first.md`, `specs/fix-idempotency-document-fence.md`, `_review/GPT-5.6-Sol-codebase-review-2026-09-04.md`.
- Tax-point / ภ.พ.36: `specs/fix-pnd36-payment-detection.md` (payment-channel table C1-C16).
- Subledger and flexibility limits: `specs/subledgers.md`, `specs/manual-jv-and-coa-management.md`.
- Owner decisions: `docs/archive/DECISIONS-army-2026-07-25.md`, `docs/archive/progress.md` (Ham quotes), `STATUS.md`.
- Original rules vs reality: `CLAUDE.md.bak` (old rulebook), `docs/accounting-system-plan.md` (as-built), `docs/archive/plan.md`.
- Cutover and open ops items: `MIGRATION-CUTOVER-CHECKLIST.md`, `specs/TRIAGE-backlog-2026-08-19.md`.
- Pipeline costs: `ROUTING-LOG.md`, `CLAUDE.md` (orchestrator rules).

## Appendix C -- Limits of this analysis
- Read-only; nothing was executed. Source spot-checks (H7, H12, I10, MCP denylist, purge worker, e2e red spec, CI coverage) were made by reading code on the `chore/release-2.5.0` working tree.
- Wiki class counts are my manual assignment of one primary class per entry; keyword counts overlap.
- Several "status unknown" items (break-it R4, Tier-4 legs, whether the NOBYPASSRLS lane shipped) reflect missing records, not necessarily missing work.
- Real-tenant facts (non-VAT status, size) come from project docs and a user-level memory note, not from querying any database.
