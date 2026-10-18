# STATUS — TEAS 2

**Goal:** TEAS 1 feature parity, rebuilt with accounting flexibility, better UX and a systematic, gated delivery
(`docs/specs/SP0-charter.md` §1). Run every session from `Y:\ClaudePlayground\TEAS2` (TEAS-Project is read-only reference).

## Now — 2026-10-18 15:30
- **SP1c group 08 Reports** at the Ham gate GRP (branch `feat/sp1c-08-reports`, worktree `Y:\ClaudePlayground\T2-sp1ab`): RP1 P&L / balance sheet / general ledger (dimension columns, comparatives, drill-down, DBD 2.7 toggle; posted party lines carry `partyId`), RP2 AR / AP aging read from the journal (control lines tagged with their open item; as-of ties to the GL on every date), statements, sales / purchase summaries, outstanding PO, asset register tab, RP3 number-gap audit over every series, audit-log viewer (real event times, append-only by id), reopen history. Each task Opus-reviewed to APPROVE. Gate at e198997: 2464 unit, typecheck / lint / build green, Playwright 1015/1017 (two stale expectations fixed after). Waiting on Ham: GRP list in the group-08 ledger.
- **SP1c groups 00–06** merged (PR #7–#13). Group 06 Tax approved by Ham 2026-10-17 ("โอเคแล้วแหละ"): ภ.พ.30 + registers + filing lock, ภ.ง.ด.2/3/53/54, ภ.พ.36, paying a filed return from a bank line, CIT ภ.ง.ด.50/51, tax summary, VAT threshold watch, form catalogue, 50 ทวิ on the RD layout (2 copies), ภ.พ.30 boxes as the official form. Still [SP-R]: ภ.พ.36 gross-up base, donation base / line 17, OB tax payables, CIT journal.
- **SP1c group 07 Payroll** merged (PR #14) (branch `feat/sp1c-07-payroll`, worktree `Y:\ClaudePlayground\T2-sp1ab`): PY1 employees + payroll runs (PIT / SSO engine, YTD chain, 2190 deductions), PY2 pay / unpay + payslip drawer + A5 payslip paper, PY3 ภ.ง.ด.1 / ภ.ง.ด.1ก / สปส.1-10 (frozen at finalize, filing lock, SSO file, pay PND1 / SSO from a bank line), employee 50 ทวิ; filing fingerprint on every return. Each task Opus-reviewed to APPROVE. Gate at f8294ec: 2246 unit, 885 e2e (`--workers=1`), typecheck / lint / build green. **Approved by Ham 2026-10-18** (D-11 fourth line editor acknowledged): work period = pay-date month (keep); OB balances on 2153 / 2160 deferred to SP-R (with group 06 OB tax payables); kept for now as [SP-R]: withholding method by issue order, 2190 deductions account, SSO floor per slip, live company details on papers until ST3.
- **SP1c group 05 Accounting approved by Ham 2026-10-17** (branch `feat/sp1c-05-accounting`, worktree `Y:\ClaudePlayground\T2-sp1ab`): AC1 journal vouchers / reverse / accruals, AC2 chart of accounts, AC3 opening balances wizard, AC4 recurring templates + amortisation schedules, AC5 fixed assets / depreciation runs / disposal by TI, AC6 period close + year-end closing entry, and Ham's pre-merge follow-ups AC7a (late registration catch-up, asset-register report, fa-car), AC7b (template editor), AC7c (real DBD แบบ 2 / P&L format 2.7 and ภ.ง.ด.50 ปี 2568 lines). Every money task Opus-reviewed to APPROVE. Gate at a6b5f95: 1719 unit, 691 e2e (`--workers=1`), build green.
- Ham rulings 2026-10-17: late asset registration = catch-up in the next run; DBD P&L format 2.7; ภ.ง.ด.50 mapped per `docs/research/tax/dbd-fs-lines-and-pnd50.md` (add-backs computed in group 06).
- **SP-R** (worktree `Y:\ClaudePlayground\T2-spr`, branch `docs/sp-r`): B1–B4 done; decision list `docs/research/tax/DECISIONS.md` (56 points) with Ham.
- Execution: subagent-driven; the controller commits; quota pools Claude / Codex / Gemini (Ham) tracked in `docs/plans/progress/`. Previews are local (Coolify later).

## Resume checklist (next session)
0. Invoke `superpowers:subagent-driven-development`; the ledgers are the source of truth:
   `T2-sp1ab\.superpowers\sdd\<group>\progress.md`, `T2-spr\.superpowers\sdd\2026-10-14-sp-r-tax-research\progress.md`.
1. SP1c: group 06 tax (`docs/plans/sp1c/06-tax.md`; master plan `docs/plans/2026-10-14-sp1c-all-screens.md`). Carries are in the group-02..05 ledgers (group 05: filings_not_finalized count from TX1; DEP/PRE opening items not applicable by FN3 yet; asset-command version optional; template history screen; fiscal-year definition for configurable calendars; TX1 claim-period filing lock incl. date edits that flip forfeit; TX2 PP.36 self-assessed VAT + paying VAT / WHT to RD from a bank line; ST3 approval policy and write-off tolerance snapshot at issue; AC / closing: bank go-live opening screen + in-transit at go-live (Ham 2026-10-16); UI polish: PV list "ผู้ขาย" column shows employees, netting pairs listed one-way, single banner when a receipt lock also applies).
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
