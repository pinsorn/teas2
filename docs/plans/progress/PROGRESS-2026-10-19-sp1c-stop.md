# PROGRESS — 7-day quota STOP (2026-10-19 09:45, 7-day 85%)

Rule (Ham 2026-07-31): 7-day pool ≥ 85% → stop, no Codex / AGY fallback. 7-day window resets **2026-10-20 16:00**.

## State
- SP1c groups 00–09 merged. Group 09 Settings = PR #16 (merge 269a730), approved by Ham 2026-10-19 (control roles at company default
  only; numbering scope switch from the next year with numbers; kept: calendar fiscal year [SP-R], last-admin on stored roles, used WHT
  rate correctable when another row keeps it, signature only on the issuer line). STATUS.md on main records it.
- Worktree `Y:\ClaudePlayground\T2-sp1ab` is on a fresh branch `feat/sp1c-10-home` from origin/main (this file is its only commit).
- MockState version 61.

## Resume order (after 2026-10-20 16:00, re-check `~/.claude/quota-guard/state.json` seven_day < 85%)
1. Invoke `superpowers:subagent-driven-development`; create `.superpowers/sdd/10-home-connect/progress.md`.
2. Group 10: `docs/plans/sp1c/10-home-connect.md` (home / connect). Carries in:
   - CI flakiness: three different CI-only axe failures on PR #16 (payroll run new color-contrast mid-transition; reports-arap
     `document-title` during navigation). Make `e2e/helpers/axe.ts` `axeClean` wait for a settled page (document.title set, no running
     animations) — one small task first, so group 10's CI is stable. See `troubles-wiki.md`.
   - Group 09 notes for SP2: settings PUTs read state before awaiting the body (lost update under overlap); revision 0 carries no
     issue look (stamped after `revisions.push`).
3. Retro lessons from group 09 (apply in briefs): workers overran the blast cap twice (state "HARD stop" in every brief — worked after);
   never commit while a parallel worker edits the same file — verify the commit on a clean `git archive` export.
