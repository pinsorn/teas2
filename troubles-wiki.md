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
