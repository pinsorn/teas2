# STATUS — TEAS 2

**Goal:** TEAS 1 feature parity, rebuilt with accounting flexibility, better UX and a systematic, gated delivery
(`docs/specs/SP0-charter.md` §1). Run every session from `Y:\ClaudePlayground\TEAS2` (TEAS-Project is read-only reference).

## Now — 2026-10-14 15:30
- **SP1ab merged** to main (PR #4, 724fad6): kit + tax-invoice loop on the mock backend, direction **B — Continuity**, ADR-0001 (React paper + Gotenberg). Required checks `layout` + `web` on main.
- **SP1b gate change** (branch `feat/sp1b-gate`, worktree `Y:\ClaudePlayground\T2-sp1ab`): Task 18 CN/DN rounding rule B done (PR open).
- **SP-R** (worktree `Y:\ClaudePlayground\T2-spr`, branch `docs/sp-r`): B1 836b8a3, B2 65ce2d9, B3 ba23385 — every rule Partial/Disagree → Ham (Task 6). B4: gemini + claude in; Codex run after 16:20.
- Execution: subagent-driven; the controller commits; quota pools Claude / Codex / Gemini (Ham) tracked in `docs/plans/progress/`.

## Resume checklist (next session)
0. Invoke `superpowers:subagent-driven-development`; the ledgers are the source of truth:
   `T2-sp1ab\.superpowers\sdd\2026-10-14-sp1ab-design-system-kit\progress.md`, `T2-spr\.superpowers\sdd\2026-10-14-sp-r-tax-research\progress.md`.
1. Arm the quota self-wake monitor (`node ~/.claude/quota-guard/wake-watch.mjs`).
2. SP1ab: after Coolify is up → Task 16 step 4 public probe → Task 17 gate (Ham approves the pattern) → SP1c plan.
3. SP-R: B4 Codex run → B4 consolidation → Task 6 (Ham rulings on all Partial/Disagree notes) → Task 7+.

## Waiting on Ham
- Create the Coolify app per `deploy/README.md` (`teas2-preview.kazaki-rio.com`, basic auth).
- SP1b gate questions: credited-to-zero unpaid TI status (provisional: stays issued, outstanding 0.00); signed combined CN vs separate CN + DN (with R-08); two mock-only money paths carried to SP2 as test vectors.

## Decisions 2026-10-14
- SP1a visual direction: **B — Continuity** (Ham). PR #4 merge approved (Ham). CN/DN rounding: **rule B** — note VAT per tax code = actual VAT change (Ham).
- Plans approved; execution = subagent-driven. Repo public (AGPL). Staging = `teas2-preview.kazaki-rio.com` + basic auth.
- Gemini research seat = Ham in the Gemini app.

## Done
- TEAS 1 v2.5.0 discovery: `docs/discovery/01`–`04`.
- SP0 charter + diagrams (approved 2026-10-14) — diagrams page https://claude.ai/artifact/9BMzT5Jupxa3emA6kQf4q6
- Plans P0, SP1ab, SP-R (`docs/plans/`). P0 executed.
