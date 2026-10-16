# STATUS — TEAS 2

**Goal:** TEAS 1 feature parity, rebuilt with accounting flexibility, better UX and a systematic, gated delivery
(`docs/specs/SP0-charter.md` §1). Run every session from `Y:\ClaudePlayground\TEAS2` (TEAS-Project is read-only reference).

## Now — 2026-10-16 22:00
- **SP1c groups 00–03** merged (PR #7–#10).
- **SP1c group 04 Finance approved by Ham** (branch `feat/sp1c-04-finance`, worktree `Y:\ClaudePlayground\T2-sp1ab`): FN1 bank / cash accounts (own GL each, frozen once used; bank snapshot on issued RC / PV) + statement import (KBiz CSV, integrity triple-check), FN2 reconciliation (same-account matching, split / batch / fee, transfers between own accounts, reconciliation lock, lock-to-date, go-live boundary, report), FN3 settlement records (deposits, prepayments, netting, cumulative write-off tolerance). Money tasks Opus-reviewed to APPROVE. Gate: 1341 unit, 515 e2e (`--workers=1`). Interim rulings P-08..P-11 added to SP-R `DECISIONS.md`.
- **SP-R** (worktree `Y:\ClaudePlayground\T2-spr`, branch `docs/sp-r`): B1–B4 done; decision list `docs/research/tax/DECISIONS.md` (56 points) with Ham.
- Execution: subagent-driven; the controller commits; quota pools Claude / Codex / Gemini (Ham) tracked in `docs/plans/progress/`. Previews are local (Coolify later).

## Resume checklist (next session)
0. Invoke `superpowers:subagent-driven-development`; the ledgers are the source of truth:
   `T2-sp1ab\.superpowers\sdd\<group>\progress.md`, `T2-spr\.superpowers\sdd\2026-10-14-sp-r-tax-research\progress.md`.
1. SP1c: group 05 accounting (`docs/plans/sp1c/05-accounting.md`; master plan `docs/plans/2026-10-14-sp1c-all-screens.md`). Carries are in the group-02..04 ledgers (TX1 claim-period filing lock incl. date edits that flip forfeit; TX2 PP.36 self-assessed VAT + paying VAT / WHT to RD from a bank line; ST3 approval policy and write-off tolerance snapshot at issue; AC / closing: bank go-live opening screen + in-transit at go-live (Ham 2026-10-16); UI polish: PV list "ผู้ขาย" column shows employees, netting pairs listed one-way, single banner when a receipt lock also applies).
2. SP-R: record Ham's DECISIONS.md rulings → ADR for spec changes → Task 7+ golden fixtures.

## Waiting on Ham
- SP-R `DECISIONS.md` answers (incl. signed combined CN vs separate CN + DN with R-08; gross-up-once formula R-06; P-01..P-07 purchase-tax interim rulings).
- Coolify app per `deploy/README.md` (`teas2-preview.kazaki-rio.com`, basic auth) — not blocking; local preview used meanwhile.

## Decisions 2026-10-14
- SP1a visual direction: **B — Continuity** (Ham). PR #4 merge approved (Ham). CN/DN rounding: **rule B** — note VAT per tax code = actual VAT change (Ham).
- Plans approved; execution = subagent-driven. Repo public (AGPL). Staging = `teas2-preview.kazaki-rio.com` + basic auth.
- Gemini research seat = Ham in the Gemini app.
- SP1b pattern approved on local preview; credited-to-zero unpaid TI stays `issued`, outstanding 0.00; SP1c plan approved ("เริ่มเลย") (Ham).
- 2026-10-15: group 01 master data approved ("Approve แล้วเราลุยกันต่อ"); papers carry logo, issuer signature and company stamp, snapshotted at issue (ST3 spec, after Ham's question) (Ham).
- 2026-10-16: group 02 sales approved ("Approve ทั้งหมด"), incl. ADR-0002: TI cancel waits for its live CN / DN; mixed-direction corrections issue a separate CN and DN (Ham).
- 2026-10-16: group 03 purchases approved ("Approve"); interim purchase-tax rulings stay `[SP-R]` and are answered with `DECISIONS.md` (P-01..P-07) (Ham).
- 2026-10-16: group 04 finance approved ("Approve"); D-13 settlements stay records without a legal series; real bank accounts get a go-live opening screen (later group); P-08..P-11 answered with `DECISIONS.md` (Ham).

## Done
- TEAS 1 v2.5.0 discovery: `docs/discovery/01`–`04`.
- SP0 charter + diagrams (approved 2026-10-14) — diagrams page https://claude.ai/artifact/9BMzT5Jupxa3emA6kQf4q6
- Plans P0, SP1ab, SP-R (`docs/plans/`). P0 executed.
- SP1ab (PR #4), rule B (PR #5), SP1c plan (PR #6); SP1c group 00 Foundation (PR #7); group 01 Master data (PR #8); group 02 Sales (PR #9); group 03 Purchases (PR #10); group 04 Finance (this PR).
