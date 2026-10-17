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
