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
