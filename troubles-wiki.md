# troubles-wiki.md — project-specific known issues

Workers: when you hit an unexpected error, **grep this file for the symptom
FIRST** — before debugging from scratch and before asking the orchestrator.
If your issue is here, apply the known fix and move on.

Adding entries: when you confirm a NEW root cause that future workers in
this repo could hit again, append an entry (worker appends, orchestrator
curates at diff review). Project-specific lessons live here; lessons that
apply to every project belong in the agent/template files instead.

Entry format — terse, greppable by symptom:

```
## <one-line symptom, as it appears in errors/logs>
- **Root cause:** <what actually broke>
- **Fix:** <what to do>
- **Seen:** <date, task>
```

---

<!-- entries below — newest on top -->

## An invariant "GL(account X) = Σ of the documents" goes red after an opening balance (GL 1180 ... but the live receipts withheld; WHT payable credit movement ...)
- **Root cause:** an issued OB posts plain trial-balance lines (VAT / WHT balances 1170, 2151, 2131-2135, 1180 have no sub-ledger yet [SP-R]) that no document owns, so the document-vs-GL ties see them as a difference.
- **Fix:** `checkInvariants` keeps `obGl` / `obCredit` (what OB batches posted) and subtracts them in 8b (1180) and 11 (WHT payable credit movement). A NEW document-vs-GL tie must do the same. Sub-ledger accounts (1130 / 2110 / 2180 / 2140 / 1140) need no exemption: the OB open items are sub-ledger rows (type OB with `header.obSide`, `carriesBalance`).
- **Seen:** 2026-10-17, SP1c AC3

## A seeded OB (or any seed doc with a frozen item) breaks a seed-wide test: "number matches `NUMBER-YYYYMM-NNNN` format", "every non-draft document passes missingOf", or GL(1130) = Σ outstanding(TI ∪ IV)
- **Root cause:** an OB batch creates item documents (type OB, `header.obBatchId`) numbered `<old number> (ยกมา)`, with no journal of their own; AR items are sub-ledger rows of 1130.
- **Fix:** skip `header.obBatchId` docs in tests that walk every document (numbering, journal presence, `missingOf`) and count `type === 'OB' && header.obSide === 'AR'` in the AR identity.
- **Seen:** 2026-10-17, SP1c AC3

## Component test: MISSING_MESSAGE for a key you just added to th.json (the key IS in the file)
- **Root cause:** the same key already exists LATER in the same JSON object (e.g. docEditor.account as a string); JSON allows duplicate keys and the last one wins, so your object is silently replaced.
- **Fix:** use a unique key (docEditor.accountGrid); detect with json.load(..., object_pairs_hook=) printing repeated keys per object.
- **Seen:** 2026-10-16, SP1c AC1

## e2e runs against a stale build: a leftover `next start -p 3100` answers (reuseExistingServer)
- **Root cause:** playwright.config reuses whatever listens on 3100; an earlier worker's server serves the OLD .next build.
- **Fix:** stop it, `NEXT_PUBLIC_API_MOCKING=enabled corepack pnpm build`, start `pnpm start -p 3100` yourself, run playwright, stop it after.
- **Seen:** 2026-10-16, SP1c AC1


## TypeError "Cannot read properties of undefined (reading 'type')" in a seed-wide test, or a GL figure that is short by a settlement's amount (FN3)
- **Root cause:** a `settles` link's `from` can be a SETTLEMENT RECORD id (`st.settlements`), not a document: `st.docs.find((d) => d.id === l.from)!.type` crashes, and a GL helper that sums only `st.journals` (+ `bankJournals`) misses the settlement journals.
- **Fix:** resolve `from` with `?.` (a settlement is not a document; invariant 6 resolves it through `st.settlements`), and sum GL through `companyEntries(st, companyId)` (documents + bank journals + settlements) or add `st.settlements[].journal` by hand as the trial-balance test does.
- **Seen:** 2026-10-16, SP1c FN3

## Netting fixture: customer pc-03 cannot get an issued tax invoice
- **Root cause:** pc-03 (ห้างหุ้นส่วนจำกัด สมบูรณ์ค้าไม้) is the one VAT customer with no TIN on purpose (the `tiDraftNoTin` fixture); `issue` refuses a TI to a VAT-registered buyer without a TIN, so it can never owe an invoice the netting could clear.
- **Fix:** the linked pair is pc-02 ⇄ pv-11 (`linkedPartyId` both ways, same company and TIN); the seed carries ti-net (10,700.00) and pb-net (4,280.00). Do not give pc-03 a TIN: it breaks the TIN-less buyer fixtures.
- **Seen:** 2026-10-16, SP1c FN3

## A new seed document breaks absolute-number assertions elsewhere (GL totals, an item "not in use", PO progress 0/140)
- **Root cause:** `runSeed` documents are part of every fixture state. P2's `pb-1` uses item EXP-01 (so `inUse` is true), `pb-po` takes 70 of `po-part`'s 140, and the seed now posts 2110 / 1170 in both companies.
- **Fix:** in new tests measure a DELTA (`gl(after) - gl(before)`) instead of an absolute GL figure; pick a still-unused fixture (EXP-04) when a test needs an unused item; when a seed spec consumes a fixture another test names, re-point that test in the same change.
- **Seen:** 2026-10-16, SP1c P2

## After issuing a draft from its edit page the view still shows "ฉบับร่าง" (cached draft)
- **Root cause:** `DocEditor.invalidate()` invalidated `[company, 'docs', type]` (the lists) but the document query is `qk.doc` = `[company, 'doc', type, id]`; the view mounted straight from the cached draft and never refetched. A NEW document (create flow) has no cache entry, so only edit-draft showed it.
- **Fix:** `invalidate()` also invalidates `[company, 'doc', type]`. e2e: `purchases-po.spec.ts` "PO draft" issues from the edit page and reads the numbered view.
- **Seen:** 2026-10-16, SP1c P1

## Unit: `DocEditor.settle.test.tsx` "a deposit alone completes a VAT-company receipt" fails at 5180 ms in the FULL `vitest run` only
- **Root cause:** NOT vitest's 5 s default (the `it` has an explicit 15 s timeout). The failure is `expect(element).toHaveTextContent()` from an inner `waitFor({ timeout: 4000 })` (the server total, or "ครบแล้ว") expiring while 79 test files run in parallel; alone the test takes ~1.2 s. A second cause showed under load once the timeouts were raised: the test moved focus to the deposit field while the customer pick (`{Enter}` on the combobox) was still pending, and a blur drops a pending Enter, so "เลือกลูกค้า" stayed missing. Pre-existing: it reproduces on the S4 base commit b514b87.
- **Fix:** done in S5 fix round 1 - the two inner `waitFor` timeouts are 12 s, the `it` timeout 30 s, and the test waits for the customer field to show the picked name before it continues. If another async test flakes only in the full run, look for a short inner `waitFor` timeout first. Never weaken the assertions.
- **Seen:** 2026-10-16, SP1c S5

## A credit / debit note without `refDocId` + a reason is `doc.incomplete`; a CN line without `sourceLineId` is `cn.line_not_referenced`
- **Symptom:** an older test (or a script) that creates a CN / DN with only a party and lines fails at `issue`, or its `addAdjustment(...)` import is gone.
- **Root cause:** S5 made the engine own the note's reference, customer, VAT and link: `issue` writes the one `adjusts` link itself (there is no `addAdjustment` any more).
- **Fix:** header `{ documentDate, refDocId: <TI id>, reasonCode: 'RETURN' | ... }`, each CN line `sourceLineId: <TI line id>`; drop the manual link call. A seeded fixture note goes through `SALES_SPECS` (runSeed), never straight into `st.docs`.
- **Seen:** 2026-10-16, SP1c S5

## e2e: after confirming a correction plan the page sometimes showed the ORIGINAL (replaced) document - FIXED in S6
- **Root cause:** `useCorrectionFlow.confirm` did `await invalidateQueries` then `router.push(new doc)`; the edit page's effect `router.replace(view(old doc))` (the old document stops being editable) raced with that push, and either could win.
- **Fix:** `useCorrectionFlow(d, doc, onLanding)` calls `onLanding` right after the plan ran, BEFORE the caches refresh; `DocEditPage` sets a ref there and its redirect effect skips while it is set, so the flow's push (the new document, or the CN / DN for a note-only plan; an in-place revise lands on the same document) is the only navigation. `sales-rc` and `ti-loop` e2e now assert the landing URL. Any new screen that hosts the flow must pass the same hook.
- **Seen:** 2026-10-15, SP1c S4; fixed 2026-10-16, S6

## `revise()` silently moved a receipt to the company default bank when the proposal left the bank field out
- **Symptom:** a notes-only API edit of a receipt posted to a non-default bank was planned as `revise`, then `executePlan` failed `doc.revise_not_allowed` (or, before S6, needlessly became cancel + reissue).
- **Root cause:** `stored()` -> `payDefaults()` fills `bankAccountId` with the company default when absent, so the in-place edit looked like a move to another bank. The plan compared the raw proposal, execute compared the defaulted one.
- **Fix:** an absent `bankAccountId` means "unchanged" in BOTH places (`isFiscalChange` and the start of `revise`). Test vector: move a receipt to a bank that is not the default first (a default-bank receipt cannot show it).
- **Seen:** 2026-10-16, SP1c S6

## e2e: "ยังขาดอะไร" still says เลือกลูกค้า / a panel has 0 checkboxes after `fill()` + `Enter` on the customer combobox
- **Root cause:** the party search is asynchronous; `Enter` pressed before the option list renders picks nothing (flaked `sales-iv-bl` once, bit two S4 tests).
- **Fix:** `await page.getByRole('option').first().waitFor()` between `fill()` and `Enter`.
- **Seen:** 2026-10-15, SP1c S4

## Fixture predicates (rcTargetsA / rcTargetsB) stop resolving after a seeded receipt touches them
- **Symptom:** `fixture ids unresolved: rcTargetsA, rcTargetsB` (every e2e and screens test fails).
- **Root cause:** the predicates pick pc-01's untouched invoices (no active link); a seed spec that settles or groups them removes them from the pool.
- **Fix:** seed receipts settle the OTHER open invoices (rc-multi pays ti-057 / spike-60, which a billing statement already groups), leaving spike-1 / spike-25 untouched.
- **Seen:** 2026-10-15, SP1c S4

## Playwright axe "color-contrast" fails ~50% of runs right after a dialog opens
- **Symptom:** `axeClean(page)` right after opening a Radix dialog / alertdialog reports a serious `color-contrast` on text inside it; re-running passes (`ti-loop` "non-fiscal edit" flaked 2/4 on the pre-fix baseline).
- **Root cause:** axe reads the colours mid fade-in animation (partial opacity blends).
- **Fix:** `e2e/helpers/axe.ts` awaits `document.getAnimations()` (finite ones) before analysing. Do not assert axe on a state that is still animating.

## React Query changes do not reach React inside a synchronous `act()` (Vitest)
- **Symptom:** a test does `act(() => qc.setQueryData(...))` then asserts the re-rendered UI synchronously; the assertion sees the old UI.
- **Root cause:** TanStack Query batches observer notifications on a macrotask (`setTimeout 0`), so `act` returns before components re-render.
- **Fix:** assert with `await waitFor(...)` / `findBy*` after the `setQueryData`.

## Editor unmount now flushes a pending save: stray POST leaks into the next Vitest test
- **Symptom:** after adding flush-on-unmount to `useAutosave`, a later test's call log / `waitFor(POST count === 1)` is satisfied (or broken) by a request the PREVIOUS test's cleanup sent.
- **Root cause:** RTL cleanup unmounts a dirty editor, which fires its save after the next `beforeEach` reset the store.
- **Fix:** `DocEditor.test.tsx` runs `cleanup()` and waits ~150 ms in `afterEach` before resetting handlers.


## gh pr checks --watch exit code is NOT a pass signal
- **Symptom:** `gh pr checks <n> --watch --fail-fast` exits 0 while a check has FAILED; an exit-code-gated merge proceeds on red (merged a red main, 2026-07-07).
- **Root cause:** the watch subcommand's exit status does not reflect the aggregate check conclusion.
- **Fix:** after any watch, re-run plain `gh pr checks <n>` and READ each line's pass/fail text before merging. Never gate a merge on watch's exit code.

## StringBuilder.AppendLine breaks cross-platform text snapshots (.NET)
- **Symptom:** CSV/text endpoint passes tests on Windows dev, fails on Linux CI ("expected N lines, found 1") or vice versa.
- **Root cause:** `AppendLine` emits `Environment.NewLine` — `\r\n` on Windows, `\n` on Linux. Fixed-delimiter consumers (RFC 4180 CSV, snapshot tests) break on the other OS.
- **Fix:** emit the delimiter explicitly: `sb.Append(x).Append("\r\n")`.

## notFound() cannot give an HTTP 404 in the mock build (frontend)
- **Symptom:** `page.goto('/unknown')` returns 200 even though the route calls `notFound()` (also true of `/print/ZZ/1`); the not-found UI is shown.
- **Root cause:** with `NEXT_PUBLIC_API_MOCKING=enabled`, `MockProvider` (client) renders `null` on the server until the worker starts, so the shell streams with 200 before the page's `notFound()` runs. Next only emits 404 if `notFound()` fires before streaming.
- **Fix:** assert the not-found content (and the `noindex` meta Next adds), not `response.status()`, in mock-mode e2e. A real 404 needs a Proxy check or mocking off.

## Scripted multi-line edits on Windows: heredoc abort, `/tmp` path, CRLF files (frontend)
- **Symptom:** a Bash-tool `cat <<'EOF'` / `node` edit script aborts with `unexpected EOF while looking for matching '` (long script with Thai text, quotes and backticks); `node -e "...readFileSync('/tmp/x')"` fails with `ENOENT Y:\tmp\x`; a multi-line `replace` silently does not match one file (`TotalsPanel.tsx`).
- **Root cause:** Git Bash cannot parse that heredoc; Git Bash translates `/tmp` only in command-line arguments (`node /tmp/x.mjs`), not inside a node string (it resolves to `Y:\tmp`); some repo files are CRLF (`file <path>` shows it), so `\n` patterns miss.
- **Fix:** write the edit script with the Write tool (scratchpad dir) and run `node <script>`; use drive-letter paths inside scripts; for a CRLF file use the Edit/Write tools or normalise `\r\n` before matching.

## Local production preview shows "โหลดข้อมูลไม่สำเร็จ" on every screen (frontend)
- **Symptom:** `corepack pnpm build && corepack pnpm start -p 3100` serves pages, but every screen shows the load error; the network tab shows `GET /bff/v1/me` → 404 from Next.
- **Root cause:** `NEXT_PUBLIC_API_MOCKING` is inlined at BUILD time; the worktree has no `.env` (only `.env.example`), so the build ships without the MSW worker. A stale `next start` can also keep holding the port after its shell is stopped (EADDRINUSE on restart).
- **Fix:** build and start with `NEXT_PUBLIC_API_MOCKING=enabled` in the environment (or copy `.env.example` to `.env.local`); free the port by PID first. The preview works on `http://localhost:3100` only — MSW service workers need a secure context, so a LAN IP over http stays broken.

## An e2e locator passes locally and hits "strict mode violation" on CI (2 elements)
- **Symptom:** `getByRole('heading', { level: 1 })` / `getByText('ส่งมอบแล้ว')` resolve to 2 elements on GitHub CI only; green locally.
- **Root cause:** a race, not an environment difference. Locally the second element (the paper's lazily fetched seller `h1`; the activity-tab entry) had not rendered yet when the assertion ran, so the locator matched one element and passed vacuously. Slower CI runners render both first. The paper seller name was also a real a11y defect (an extra `h1` per sheet).
- **Fix:** the paper seller name is an `h2`; scope text locators to their region (`getByRole('tabpanel', { name })`). Never `.first()`.

## An attachment test counts one file too many / an e2e option locator matches 12 elements (P4)
- **Symptom:** after P4 the attachment tests in `docs-write-s6.test.ts` see `teas2.mock.att.att-seed-ex-pend` and a metadata row they did not create; an e2e `getByRole('option')` for a party type-ahead resolves to 12 elements (or `toHaveCount(0)` never holds).
- **Root cause:** the seed now carries one real attachment (`ex-pend`, the receipt photo; bytes in localStorage, metadata in `st.attachments`). And a native `<select>` (category, tax code) exposes its `<option>`s with role `option` too, so an unscoped locator also counts those.
- **Fix:** attachment tests filter `att-seed-` (`userAtt()` / `attKeys()`); e2e type-ahead locators are `page.getByRole('listbox').getByRole('option')`. Also: `toHaveURL(//expense-claims/[^/]+$/)` matches `/new` itself - exclude it (`(?!new)`) before reading the id from the URL.

## Playwright "unknown fixture key" / every new screen 404s although the build is fresh (FN1)
- **Symptom:** a new e2e spec fails on `fixtureId(...)` with "unknown fixture key X (have: ...)" or a new route renders the old UI, while unit tests and `next build` are green.
- **Root cause:** `playwright.config.ts` has `reuseExistingServer: !CI`; a `next start -p 3100` left over from an earlier run (same worktree, OLD `.next` build) is reused, so the spec runs against stale code. `netstat -ano | findstr :3100` shows it.
- **Fix:** find the PID (`Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` shows the worktree in the command line), stop it and its parent cmd.exe, re-run: Playwright then builds and starts its own server and stops it at the end.

## A native `<select>` opened on a saved value shows blank once its options arrive (FN1)
- **Symptom:** an edit form whose `<select>` options load asynchronously (GL account picker) opens on the placeholder instead of the stored value.
- **Root cause:** react-hook-form sets the select's value at mount; a fallback `<option value={current}>` that is later replaced by the real option (different element) drops the selection.
- **Fix:** render ONE keyed list that always contains the current value (real option when known, bare code otherwise), so the DOM option is never swapped out (`kit/record-form/fields.tsx`, kind `account`).

## A new seed document breaks older hand-checked tests: account 1150 "unused", AP total (AC4)
- **Symptom:** after seeding the insurance bill `pb-ins`, `accounts.test.ts` ("1150 is not in use", "code 1150 -> 1140 is taken") and `purchase-vat.test.ts` (GL 2110 = -64,484.00) fail; the item form test lists one category fewer than `EXPENSE_CATEGORIES`.
- **Root cause:** `pb-ins` (12,000.00 on the new `prepaid` expense category -> 1150, AP 12,000.00) is the first seed line on 1150 for the VAT company, and `records/items.ts` keeps its own copy of the category codes (`EXPENSE_CATEGORY_CODES`) next to `fixtures/expense-categories.ts`.
- **Fix:** hand-checked totals carry the new bill (76,484.00); tests that need an UNUSED account use 1171; a new expense category is added in BOTH lists (and `th/en.json` `records.options.expenseCategory`). The category is the one balance-sheet category: `items.test.ts` exempts it from the "expense group" check.

## `new Date("2026-13-01T00:00:00Z").toISOString()` throws RangeError, it does not return a different date (AC4)
- **Symptom:** a record `validate()` that checks a date string by round-tripping through `Date` answers 500 / an unhandled MSW exception for `2026-13-01` instead of a field error.
- **Root cause:** an out-of-range month gives an Invalid Date, and `toISOString()` throws on it; the round-trip trick only catches days that roll over (`02-30`).
- **Fix:** guard with `!Number.isNaN(Date.parse(...))` first (`validDate` in `engine/schedules.ts`).

## A new permission code fails `permissions.test.ts` ("every code a mock role holds ... is in the catalogue") (AC6)
- **Symptom:** after giving a role `ledger.period.close` in `mocks/permissions.ts`, the catalogue test fails with `PERMISSIONS[code]` undefined.
- **Root cause:** the catalogue (`domain/permissions.ts`) is built from the `permissions` section of `messages/{th,en}.json` (key `ledger_period_close` = code with `.` -> `_`), and the "is exactly the master catalog" test lists every non-document code in `NON_DOC`.
- **Fix:** add the key to both message files and the code to `NON_DOC` in `domain/permissions.test.ts` (3 files besides the role list).

## `seed()` dies with `ledger.account_invalid: 2160` right after adding an account to `fixtures/coa.ts` (TX2c)
- **Symptom:** every seeded test fails with `seed spec nob-1: ledger.account_invalid: บัญชี 2160 ... ไม่มีในผังบัญชี` after adding a chart row.
- **Root cause:** `POSTABLE` packs several rows per source line; a trailing `// comment` placed after a new row swallowed the rest of that line (`2160` and the others on it), so those accounts silently vanished from the chart.
- **Fix:** put the comment on its own line (or after the last row of the line); check the chart row count / `seed()` right after editing the array.

## A test that issues a PV dated before the bank's go-live fails with `bank.before_go_live` (TX2c)
- **Symptom:** a unit test issuing a PV in 2026-08 (to build a ภ.พ.36 month) throws `bank.before_go_live` (ba-kbank starts reconciling 2026-09-01).
- **Root cause:** a PV resolves to the default bank account, whose go-live date refuses earlier document dates.
- **Fix:** give the PV `header.bankAccountId: 'ba-cash'` (the cash box has no go-live).

## A report tie-out is red after cancelling a document on the real clock, green under `withFixedClock` (TX2c review)
- **Symptom:** `wht-receivable` (or any report that decides whether a cancelled document counts at an as-of date) ties in a pinned-clock test but shows a false diff in the running app / an unpinned test after a cancel.
- **Root cause:** `ledger.ts withReversal` (the computed preview) dates a reversal at `doc.cancel.at` (wall clock), while the entry actually STORED in `st.journals` (`commands.ts reverseEntry` / `correctionReversal`) is dated `today()` (the mock anchor), the first open date (closed month) or the original date. `companyEntries` (the GL side of every tie-out) reads the stored entry. They coincide only under `withFixedClock`.
- **Fix:** anything that needs "when did this document's reversal hit the GL" reads the stored entry (`st.journals.find(j => j.docId === id)?.preview.entries`, kind `reversal` -> `date`), never `cancel.at` or `withReversal` (`whtAllocations` does this). Test it with an UNPINNED cancel and a closed-month (late) reversal.

## `git worktree remove --force` deletes the main worktree's `node_modules` contents (Windows, TX3a review)
- **Symptom:** after removing a probe worktree, `vitest` / `tsc` in the MAIN worktree fail with "not found" / ENOENT; `.bin` and some `node_modules/.pnpm` files are gone.
- **Root cause:** the probe worktree's `node_modules` was a junction to the main one; `--force` follows the junction and deletes the target's contents.
- **Fix:** remove the junction first with `cmd /c rmdir <worktree>\node_modules` (no `/s`), THEN `git worktree remove`. Recovery: `corepack pnpm install --frozen-lockfile --offline --force`.

## A test that closes FY2026 fails with `period.year_not_ended` (TX3a fix1)
- **Symptom:** `closeYear(st, co, 2026, ...)` throws `period.year_not_ended`; once forced past that, the seed invariants report "posted after it closed" for every 2026 entry.
- **Root cause:** the mock world's today is the fixed `ANCHOR` (2026-10-17, `engine/log.ts`), and months set `status: 'closed'` by hand have no `closedAt`.
- **Fix:** in the test, `vi.mock('../log')` to return a settable `today`, set the months `closed` WITH `closedAt` in the far future, and close FY2025 first (`period.year_order`). See `close2026` in `filings/cit-engine.test.ts`.

## `seed spec nob-1: ob.payroll_invalid` in a later test's `buildSeedState`
- **Symptom:** after a test pushed a row into a seeded opening balance's `payrollYtd` (e.g. `doc('nob-1').opening!.payrollYtd.push(...)`), the NEXT `buildSeedState()` throws `seed spec nob-1: ob.payroll_invalid`.
- **Root cause:** `freezeOpening` spread `...op`, so the issued batch shared its `payrollYtd` array (and rows) with the seed spec's literal; a mutation of the state mutated the fixture.
- **Fix:** `freezeOpening` copies the rows (`payrollYtd: op.payrollYtd.map((y) => ({ ...y }))`). Same shape of bug for any array a seed spec hands to the engine: clone where the engine freezes it. Test: "PY2 N3" in `engine/payroll.test.ts`.

## axe color-contrast `.bg-primary` on a save button that just became enabled (CI only)
- **Symptom:** `axeClean` right after navigating to a document edit page fails `color-contrast: .bg-primary` on the Linux CI runner, passes locally (~1 in 8 under 4x CPU throttle).
- **Root cause:** the editor's save button is `disabled` while the document loads (axe skips disabled nodes), then enabled with a `transition-all` opacity fade 0.5 -> 1. If the flip lands between the helper's `getAnimations()` wait and axe's analysis, axe reads a half-faded enabled button.
- **Fix:** before `axeClean`, `await expect(<the button>).toBeEnabled()` (getAnimations then sees the transition and waits it out). Reproduce with CDP `Emulation.setCPUThrottlingRate` (rate 4-8) + `--repeat-each`.
- **Seen:** 2026-10-18, SP1c group 07 CI (ti-loop F4)

## e2e "every built screen" test times out on CI as `page.goto: net::ERR_ABORTED`
- **Symptom:** `screens.spec.ts` single walk fails on CI with `net::ERR_ABORTED; maybe frame was detached?` (or a 120s timeout) on a different URL each run; green locally.
- **Root cause:** not a race: one test navigates every index card (~180 gotos); the slow runner needs more than its 120s budget, and the timeout aborts whichever goto is in flight.
- **Fix:** the walk is split into chunks of 15 cards (one generated test per chunk, from `SCREENS`), so each stays well under its own timeout however large the index grows.
- **Seen:** 2026-10-18, SP1c group 07 CI

## Vitest: "Class extends value undefined is not a constructor" in engine/company.ts after numbering.ts gained an import
- **Symptom:** many suites (store, payroll, periods, ...) fail at import with `TypeError: Class extends value undefined` at `company.ts` (`class FieldErrors extends MockError`), stack through `numbering.ts` and `fixtures/documents.ts`.
- **Root cause:** import cycle `fixtures/documents.ts -> engine/numbering.ts -> engine/company.ts -> engine/log.ts -> fixtures/documents.ts` (log.ts reads `ANCHOR` from documents.ts). When log.ts is the entry, company.ts evaluates `extends MockError` before log.ts has defined it. `numbering.ts` is imported by the seed fixtures, so it may import `log.ts` (cycle is harmless: only used inside functions) but never `company.ts` or anything that extends a class at module load.
- **Fix:** numbering.ts keeps its own two-line agent refusal instead of importing `refuseAgent` from company.ts.
- **Seen:** 2026-10-19, SP1c ST3

## CI-only axe flakes: `color-contrast: .bg-primary` (payroll run new) and `document-title: html` (outstanding POs "overdue only") — ROOT-CAUSED
- Symptom: each failed once on PR #16 and again on PR #17 (run 40362220456); green locally and on rerun. The `axe.ts` waits (non-empty title, finite animations) did not help.
- Root cause 1 (`.bg-primary`): `ui/button.tsx` had `transition-all` + `disabled:opacity-50`. The DocEditor primary button is disabled until the data loads, then enabled: opacity fades 0.5 -> 1 over ~150 ms and axe reads the blend (reproduced deterministically by pausing the transition at 50 ms: `color-contrast: .bg-primary` at opacity 0.73; passes at 0.99). The flip lands after the helper's `getAnimations()` wait when the data arrives late. Fix: the button no longer transitions `opacity` (`transition-[color,background-color,border-color,box-shadow,translate]`), so there is no half-faded state to sample.
- Root cause 2 (`document-title`): `ReportView` wrote filter changes with a DEBOUNCED (300 ms) `router.replace`; the test's last step (a checkbox) ends just before `afterEach` axe, so the replace fires while axe is analysing. A Next `router.replace` re-commits the metadata and `document.title` is `""` for ~1-2 ms, visible to other tasks (a MessageChannel poller saw it on 3/3 runs). Fix: `window.history.replaceState` (Next syncs it into `useSearchParams`; no title blink, 0/3 polls). Tab switches still use `router.replace` (same blink, but a click is followed by an awaited UI change, not by a timer).
- General rule: any timer-driven `router.replace/push` can blank the title mid-axe; use `history.replaceState` for query-only state.
- Seen: 2026-10-26/27, PR #16 + #17 CI

## e2e: every test fails with "mock worker did not answer /bff/v1/mock/fixtures" / /me network error (manual build)
- Symptom: after `pnpm build` by hand + `pnpm start -p 3100`, specs fail instantly; Home shows "เชื่อมต่อระบบไม่สำเร็จ".
- Root cause: `NEXT_PUBLIC_API_MOCKING` is inlined at BUILD time; a manual build without it ships a mock-less app (playwright's webServer sets it for the build).
- Fix: `NEXT_PUBLIC_API_MOCKING=enabled corepack pnpm build`, then start with the same env. Separately, `next build` here intermittently ends with a SecurityFatalError upgrade nudge (alternates build to build): rerun the build.

## Agent requests: the allowlist in `mocks/handlers/me.ts` is the only guard outside document writes
- Fact (HC2 review r4): `docs-write.ts` passes `actorFor(request)`, so the engine also refuses an agent there; the bank, settlements, periods, filings, schedules, records and settings handlers still pass the fixed user to the engine.
- Consequence: widening an `AGENT_ALLOWED` regex lets an agent reach those engines dressed as the signed-in user. Any new agent route needs its handler to pass `actorFor(request)` first.

## Backend architecture tests rebuild real projects (canary)
- Fact: `CanaryClockCallFailsTheRealProjectBuild` builds each `Teas.*` project in Release with an injected `DateTime.Now` file (hook in `backend/Directory.Build.props`, file under `<project>/obj/teas-canary/`). The suite takes ~40–50 s and rewrites `obj/Release` intermediates while it runs.
- Consequence: on Windows, an IDE or a second `dotnet build` of the same project at the same moment can contend for files. Run the architecture tests alone (CI builds first, then tests with `--no-build`).

## Local PostgreSQL 18 needs the postgres password; integration tests can run on a scratch cluster
- Symptom: `psql -h localhost -U postgres -w` says `fe_sendauth: no password supplied`; `pg_hba.conf` is scram-sha-256 for every host, and no `PG*` / `TEAS*_PASSWORD` variable is set on the dev box.
- Fix: ask Ham for the password (never reset it), then `tools/db/setup-local.ps1`. Without it, a worker can verify on a private cluster: `initdb -D <scratch>/pgdata -U postgres -A trust`, `pg_ctl -D <scratch>/pgdata -o "-p 5433" -w start` (run it detached: from the Bash tool `pg_ctl ... -w start` never returns), then `psql -p 5433 -f deploy/db/bootstrap-roles.sql` with `-v migrator_pw= -v app_pw= -v test_admin_pw=` and point `TEAS_TEST_ADMIN_CS` / `TEAS_TEST_APP_CS` at port 5433.
- Harness note: a failing `InitializeAsync` in an xUnit fixture skips `DisposeAsync`, so a crashed run can leave `teas_t_*` clone databases behind; drop them by hand.

## OpenAPI build: NU1903 on Microsoft.OpenApi, file name, and `pnpm` inside scripts
- Symptom: `dotnet build -warnaserror` fails `NU1903 Microsoft.OpenApi 2.0.0 ... GHSA-v5pm-xwqc-g5wc`; or `FileName format invalid, only Alphanumeric and "_ -" authorized`; or a package.json script that calls `pnpm run x` says `'pnpm' is not recognized`.
- Root cause: `Microsoft.AspNetCore.OpenApi` 10.0.x pulls the vulnerable 2.0.0 transitively; `Microsoft.Extensions.ApiDescription.Server` refuses a `.` in `--file-name` (so the build emits `backend/artifacts/openapi.json`, CI copies it to `docs/api/openapi.v1.json`); under corepack `pnpm` is a shim that is not on PATH for child processes.
- Fix: direct `PackageReference` + central pin of `Microsoft.OpenApi` 2.7.5 in the Api project; `--file-name openapi`; chain scripts with `npm run -s <script>`.

## Architecture test `SystemScopeMachineryIsUsedOnlyFromTheAllowedPlaces` fails on an innocent method named `ApplyAsync`
- Symptom: Architecture test lists a new file in Teas.App outside Platform/Auth|Jobs|Keys.
- Root cause: it greps the whole `src` for the regex `\b(EnterSystem|ScopeState|ApplyAsync|ForEachCompanyAsync|SelfTestAsync|Attach)\s*\(`, so any method with one of those names trips it.
- Fix: name your method differently (P4 `VersionedUpdate.UpdateAsync`).

## Integration test fails on teardown: `42501: permission denied to terminate process`
- Symptom: a random integration test (any class, 1 run in 2-3) is red with `Npgsql.PostgresException 42501 permission denied to terminate process` thrown from `DbClone.DisposeAsync`; the next run is green. Reproduced on main without any P5 code (3 of 6 runs).
- Root cause: `DROP DATABASE ... WITH (FORCE)` runs as `teas_test_admin` right after `ClearAllPools()`; a `teas_app` backend whose socket was just closed has not exited yet, so FORCE tries to terminate a process it may not signal.
- Fix (done in P5): `DbClone.DisposeAsync` retries the DROP on 42501 / 55006 up to 20 times, 250 ms apart, then rethrows. 5 full integration runs in a row green afterwards.

## Route tests in the test host skip `RouteAuthorization` unless it is added after the host's own `UseRouting`
- Symptom: a permission-gated test route answers 200 / 422 to a caller without the right.
- Root cause: `Program.cs` adds `RouteAuthorization` before the test host's `IStartupFilter` routing runs, so at that point the test endpoint is not yet matched (`GetEndpoint()` is null) and the middleware passes through.
- Fix: `PlatformTestHost` adds `UseMiddleware<RouteAuthorization>()` right after its own `UseRouting()` (and its `TestAuth` before `next(app)` stands in for authentication).

## `citext = @param` is case-SENSITIVE (a lower-case lookup misses an upper-case email)
- Symptom: an invite / login for `USER@Example.Test` does not find the user row stored as `user@example.test`, although the column is `citext`.
- Root cause: Npgsql sends a `string` parameter as `text`; PostgreSQL resolves `citext = text` as `text = text` (citext -> text is the implicit cast), so the comparison loses its case-insensitivity.
- Fix: cast the parameter: `WHERE email = @e::citext` (done in AuthService / LinkService / the CLI, P7). `ON CONFLICT (email)` and column-to-column comparisons are unaffected.

## `ExecuteScalar` returns `DateTime` for `timestamptz`, not `DateTimeOffset` (InvalidCastException)
- Symptom: `(DateTimeOffset?)await cmd.ExecuteScalarAsync()` throws InvalidCastException on a timestamptz column.
- Fix: read through a reader with `GetFieldValue<DateTimeOffset>(i)` (P7 `Q.ScalarAsync`). Parameters must be UTC (`offset 0`; `TimeProvider.GetUtcNow()` is).

## A race test of two fast HTTP requests proves nothing unless something holds them at the decisive line
- Symptom: a mutation that removes the guarded `UPDATE` (e.g. the TOTP `totp_last_step < @s` predicate) leaves a "two concurrent requests, one winner" test green.
- Root cause: in-process requests take milliseconds; the second one reads the already-updated row, so the sequential check (`Totp.Match(..., lastStep)`) refuses it and the SQL guard is never exercised.
- Fix: park both requests at a barrier after they read and before they claim (P7 `GatedProtector` in `AuthHost`: a barrier inside `ISecretProtector.Unprotect`, which runs between the user read and the UPDATE). Then removing the SQL guard turns the test red.

## Architecture test `EveryErrorCodeLiteralInSourceIsInTheRegistry` flags `const string ItemKey = "teas.session"`
- Symptom: the scan lists a Teas.Api file with an "unregistered code".
- Root cause: any `const string X = "lower.dotted"` is taken for an error code (the regex `const string \w+ = "[a-z][a-z0-9_]*\.[a-z0-9_.]+"`).
- Fix: name such constants without the dotted lower-case shape (P7: `HttpContext.Items` key `TeasSession`).

## OpenAPI document build fails with "The JSON value could not be converted to Optional`1[System.String]"
- Symptom: `dotnet build backend/src/Teas.Api` (the build-time document) fails inside `JsonSchemaExporter` for a request DTO.
- Root cause: `Optional<T>` declared as a positional record parameter with a default (`Optional<string> X = default`): the schema exporter serializes the default value and cannot read it back.
- Fix: declare it as an init property, the shape ErrorContractTests uses: `public Optional<string?> X { get; init; }`, with `public required int Version { get; init; }` for the members that must stay required in the schema (P8 `UpdateMemberBody`, `CompanyImagesBody`).

## A derived record loses `required` on the inherited members in the OpenAPI schema
- Symptom: `Same<UserRow & { link: string }, ...>` in the conformance file is false: every inherited member comes out optional in the generated type.
- Root cause: the "required" rule reads the constructor parameter of the type being described (`AssociatedParameter`); a derived type's constructor does not carry the base record's parameters.
- Fix: a response that is "row plus one member" is a flat positional record with all members (P8 `InvitedUserView`), not `: UserRowView`.

## Test bodies: an anonymous object camel-cases a key that is data (`new { IV = "x" }` is sent as `iv`)
- Symptom: a 422 "unknown document type iv" for `defaultNotes = new { IV = ... }`.
- Fix: send data keys as a `Dictionary<string, string>` (dictionary keys are not renamed); anonymous objects are for property names.

## `pg_ctl start` from the Bash tool never returns / the scratch cluster does not come up
- Symptom: `pg_ctl -D <pgdata> -o "-p 5433" start` (with or without `-w`) hangs or silently leaves no server; `pg_isready -p 5433` says no response.
- Fix: start it from PowerShell with `Start-Process pg_ctl.exe -ArgumentList @('-D','"<pgdata>"','-o','"-p 5433"','-l','"<pgdata>\log.txt"','start') -RedirectStandardOutput o.txt -RedirectStandardError e.txt -NoNewWindow`, wait a few seconds, then `pg_isready`. Stop the same way with `stop -m fast -Wait`.

## A long heredoc with backticks, angle brackets and quotes aborts the whole Bash call
- Symptom: `unexpected EOF while looking for matching` and NOTHING of the command ran (both files of a two-file heredoc were missing).
- Fix: write source files with the Write tool; use Bash heredocs only for short, quote-free snippets (a node script file is fine for scripted edits).

## `next start` / the BFF: Next fills `x-forwarded-for` from the socket when the request has none
- Symptom: `proxy.ts` sees `x-forwarded-for: ::1` (the peer) on a request that carried none, so a "no header = no client IP" assumption is false.
- Fix: that is fine by design - `forwardHeaders` forwards the rightmost entry as `X-Teas-Client-Ip`, so a direct hit names the peer and Traefik's header (set, not appended, by default) names the client; `TEAS_TRUSTED_PROXY_HOPS` moves the hop when a CDN is in front. Probed with a stub upstream through a real `next start` (the vitest test only sees headers).

## A CI/dev SQL seed under `deploy/` cannot call `set_config` (architecture test F3)
- Symptom: `RlsContextIsSetOnlyInTenantScope` fails with the path of a new `.sql` file.
- Fix: do not exempt it. A CI-only seed runs as the Postgres superuser of the service container (bypasses RLS, needs no tenant scope) and ends with a row-count probe, e.g. `deploy/db/seed-ci.sql`.

## `fetch` to port 9 (or 1, 7, 19 ...) in a vitest test: "bad port"
- Symptom: every request fails with `TypeError: fetch failed ... bad port` before MSW or the network is involved.
- Fix: undici blocks the WHATWG "bad ports"; use an unused high port (e.g. 59999) as the "nothing listens here" target.

## `deploy/frontend/Dockerfile` failed `next build` since P3 (missing generated OpenAPI types)
- Symptom: type error on `src/contract/generated/openapi.ts` in the image build (git-ignored file, not in the `frontend/` context).
- Fix: copy `docs/api/openapi.v1.json` to `/docs/api/` and run `pnpm gen:api` before `pnpm build` (done in P10).

## Playwright mock suite: `settings-company-users` "state loading / error" x3 screens fail at HEAD (before P10)
- Symptom: 6 failures `data-screen-state="loading|error"` not found for company settings, users and roles (main renders empty); every other test in the spec passes.
- Root cause: not P10 - reproduced on a clean `git archive HEAD` of the stacked branch. Likely from the P8 frontend change (routes 17-29 are real-shaped; the screens no longer honour the toolbar `state`). Open for the controller.
