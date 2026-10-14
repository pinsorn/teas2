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
