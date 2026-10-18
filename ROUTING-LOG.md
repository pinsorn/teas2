# ROUTING-LOG — TEAS 2

| Date | Task | Worker | Why this worker |
|---|---|---|---|
| 2026-10-14 | SP1c plan draft | opus-designer | plan for every remaining screen (Appendix C + SP0 §11.2) is architecture-level, large-context synthesis — design work, Fable reviews before execution |
| 2026-10-15 | SP1c S3 review (IV ledger, I1 company-aware VAT, BL) | opus-reviewer | money diff: posting, invariants, VAT across every calc caller — CLAUDE.md money → Opus review |
| 2026-10-16 | SP1c S4 review (receipts, WHT, deposits, reissue bank) | opus-reviewer | money diff — CLAUDE.md money → Opus |
| 2026-10-16 | SP1c S5 review (CN/DN, rule B, cap, ม.86/10) | opus-reviewer | money + tax compliance diff — CLAUDE.md money → Opus |
| 2026-10-16 | SP1c P2 review (PB / PCN / PDN, input VAT, claim period) | opus-reviewer | money + tax compliance diff — CLAUDE.md money → Opus |
| 2026-10-16 | SP1c P3 review (PV, WHT certificates, gross-up, settlement) | opus-reviewer | money + WHT compliance diff — CLAUDE.md money → Opus |
| 2026-10-16 | SP1c P4 review (EX posting, 2180, approval gate) | opus-reviewer | money + control (approval) diff — CLAUDE.md money → Opus; fresh reviewer (new area) |
| 2026-10-16 | SP1c FN2 review (reconciliation, inline journals, locks) | opus-reviewer | money + lock diff — plan marks Opus |
| 2026-10-16 | SP1c FN3 review (deposits, prepayments, netting, write-offs) | opus-reviewer | money diff — plan marks Opus |
| 2026-10-16 | SP1c AC1 review (JV, reversals, accruals) | opus-reviewer | money / ledger — plan marks Opus for all AC tasks |
| 2026-10-17 | SP1c AC3 review (opening balances, bank go-live) | opus-reviewer | money / ledger — plan marks Opus |
| 2026-10-17 | SP1c AC4 review (schedules, amortisation runs, source lock) | opus-reviewer | money diff (GL runs on prepaid) — plan marks Opus; warm reviewer |
| 2026-10-17 | SP1c AC5 review (fixed assets, disposals with TI, depreciation runs) | opus-reviewer | money + tax-invoice diff — plan marks Opus; warm reviewer |
| 2026-10-17 | SP1c AC6 review (period close / reopen, year-end close, closing entry) | opus-reviewer | money + control (period locks, closing entry) diff — plan marks Opus; warm reviewer |
| 2026-10-17 | SP1c AC7a review (late registration catch-up, fa-car, asset-register report) | opus-reviewer | money diff (depreciation math, invariants, GL tie) — warm reviewer |
| 2026-10-17 | SP1c AC7b review (recurring schedule template editor, template re-freeze) | opus-reviewer | frozen money data a run turns into a draft — warm reviewer |
| 2026-10-17 | SP1c TX1 review (PP30 filing kit, registers, frozen finalize, filing lock) | opus-reviewer (fresh) | tax + lock diff — plan marks Opus; warm reviewer context full, new area |
| 2026-10-17 | SP1c TX2 implement (WHT returns, PP36, WHT receivable, missing 50 ทวิ, pay-to-RD) | sonnet-implementer | default implementer; Opus review after |
| 2026-10-17 | SP1c TX2a review (PND returns, PP36, voucher filing lock) | opus-reviewer (warm TX1) | tax + lock diff; reviewer holds the TX1 filing kit |
| 2026-10-17 | SP1c TX2c design (pay finalized returns to RD; PP30 netting vs GL tie-outs) | opus-designer | footgun: ledger netting, liability clearing, invariants — design before Sonnet implements |
| 2026-10-17 | SP1c TX2b implement (WHT hub UI, PP36 screen, WHT receivable, missing 50 ทวิ, WT list) | sonnet-implementer | UI + reports on the approved TX2a engine |
| 2026-10-17 | SP1c TX2b review (WHT hub UI, receivable / missing-cert reports) | sonnet-reviewer | UI + read-only money reports; one small engine change (PP36 ack) |
| 2026-10-17 | SP1c TX2c implement (PP30 netting at finalize, pay tax from a bank line) | sonnet-implementer | airtight Opus design spec; Opus review after |
| 2026-10-17 | SP1c TX2c review (PP30 netting, payTax / reverse, payable invariants) | opus-reviewer (fresh) | money + ledger diff; warm reviewer context ~320k |
| 2026-10-17 | SP1c TX3a implement (CIT PND50/51 engine, adjustments, loss carry, credits) | sonnet-implementer | default implementer; Opus review after |
| 2026-10-17 | SP1c TX3a review (CIT PND50/51, profit-loss refactor of close.ts) | opus-reviewer (fresh) | tax + money; touches AC6 closing entry |
| 2026-10-17 | SP1c TX3b implement (tax summary, VAT threshold watch, forms catalogue + history) | sonnet-implementer | UI + read models |
| 2026-10-17 | SP1c TX3a fix1 (PND51 after PND50, loss used once, frozen mapping, tampers) | sonnet-implementer | fix round from Opus REJECT |
| 2026-10-17 | SP1c TX3b review (tax summary, VAT threshold, forms) | sonnet-reviewer | read models + UI |
| 2026-10-17 | SP1c GTX consolidated gate | haiku-gate-runner | Tier 3 run-and-report |
| 2026-10-17 | SP1c TX4 implement (50 ทวิ RD layout, PP30 official boxes 8-12) | sonnet-implementer | Ham gate follow-ups; Opus review after (filing kit) |
| 2026-10-17 | SP1c TX4 review (PP30 official boxes, 50 ทวิ layout) | opus-reviewer (fresh) | filing kit money: carry / cap / netting consumers |
| 2026-10-17 | SP1c PY1 implement (employees, payroll runs, PIT / SSO, posting) | sonnet-implementer | default implementer; Opus review after (money) |
| 2026-10-18 | SP1c PY1 review (payroll engine: PIT / SSO, frozen slips, YTD chain, posting) | opus-reviewer (fresh) | money + payroll tax engine; reviewer never touched it |
| 2026-10-18 | SP1c PY1a fix (Opus REJECT: freeze on revise, OB vs runs, whole-slip invariant, 2190 deductions) | sonnet-implementer (fresh) | fix round from a written brief; Opus re-review after |
| 2026-10-18 | SP1c PY1a re-review | opus-reviewer (warm) | round 2 of the PY1 money review |
| 2026-10-18 | SP1c PY1b fix (2190 clearable; plan refuses PR / OB problems up front) | sonnet-implementer (fresh) | small fix from a written brief; Opus round 3 after |
| 2026-10-18 | SP1c PY1b re-review | opus-reviewer (warm) | round 3 of the PY1 money review |
| 2026-10-18 | SP1c PY2 implement (pay the run, unpay, payslip drawer, payslip paper) | sonnet-implementer (fresh) | default implementer; Opus review after (money) |
| 2026-10-18 | SP1c PY2 review (pay / unpay, payslips) | opus-reviewer (fresh) | money: payment, reversal, settlement invariants |
| 2026-10-18 | SP1c PY3 implement (ภ.ง.ด.1, 1ก, สปส.1-10, employee 50 ทวิ, pay PND1 / SSO; PY2 minors) | sonnet-implementer (fresh) | default implementer; Opus review after (tax) |
| 2026-10-18 | SP1c PY3 review (PND1 / PND1A / SSO 1-10 filings, filing lock, payTax PND1 / SSO, employee 50 tawi, PY2 minors) | opus-reviewer | tax + money diff (frozen returns, payable clearing) — plan marks Opus; fresh reviewer |
| 2026-10-18 | SP1c PY3a fix round (1ก year-end blocker, filing fingerprint, OB lock by filed 1ก, SSO minors) | sonnet-implementer (warm, PY3 worker) | same-area follow-up after Opus REJECT; warm re-review after |
| 2026-10-18 | SP1c PY3b fix (SSO wage base ceiling, v49, fp required) | sonnet-implementer (warm, PY3 worker) | Opus round 2 REJECT on one major; warm re-review after |
| 2026-10-18 | SP1c GPY consolidated gate (typecheck, lint, unit, build, Playwright --workers=1) | haiku-gate-runner | Tier 3 run-and-report |
| 2026-10-18 | SP1c CI1: CI-only e2e reds (screens walk ERR_ABORTED/timeout, ti-loop F4 axe contrast) | sonnet-implementer (fresh) | blocks PR #14 merge; different area from payroll worker |
| 2026-10-18 | SP1c RP1 implement (P&L, balance sheet, GL, dimension columns, comparatives) | sonnet-implementer (fresh) | default implementer; Opus review after (financial statements) |
| 2026-10-18 | SP1c RP1 review (P&L, BS, GL, dimension columns, comparatives) | opus-reviewer | financial statements tie-outs; fresh reviewer |
| 2026-10-18 | SP1c RP1a fix round (partyId on posted lines, honest tie-outs, TB dimension drill) | sonnet-implementer (warm, RP1 worker) | Opus REJECT on M1; warm re-review after |
| 2026-10-18 | SP1c RP2 implement (AR/AP aging, statements, summaries, outstanding PO, asset register tab) | sonnet-implementer (fresh) | new area (RP1 worker context large); Opus review after |
| 2026-10-18 | SP1c RP2 review (aging as-of, tie-outs by partyId, statements, summaries, PO, asset register) | opus-reviewer | money reports with GL tie-outs; fresh reviewer |
| 2026-10-18 | SP1c RP2a design (item-tagged AR/AP control lines, journal-derived as-of aging) | opus-designer | posting-core change after Opus REJECT (B1/M1/M2); footgun zone -> Opus design, Sonnet implements |
| 2026-10-18 | SP1c RP2a implement (from task-RP2a-design.md) | sonnet-implementer (fresh) | spec airtight, Opus-designed; RP2 worker context too large to stay warm; Opus re-review after |
| 2026-10-18 | SP1c RP3 implement (number gaps, audit-log viewer, reopen history; RP2 minors) | sonnet-implementer (fresh) | new area; Opus review after (audit/compliance) |
