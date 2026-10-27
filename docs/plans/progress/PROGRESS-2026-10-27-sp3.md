# PROGRESS — SP3 platform (2026-10-27 11:45)

Worktree `Y:\ClaudePlayground\T2-sp3`, branch `feat/sp3-platform` (pushed). Ledger `.superpowers/sdd/sp3/progress.md` (untracked here).

## Done
- SP2 master plan + SP3 / SP4.1 / SP4.2 specs approved by Ham and merged (PR #19, #20).
- P0 platform contract frozen in `frontend/src/contract/platform.ts` (+ route-spec, scalars, live-routes, table-driven contract test) and the set-password page (Ham approved its look). Review rounds P0a–P0e closed: invite never sets a password for an existing account; links die with the member / expire at issue / supersede by kind; reset revokes sessions; reset-link / totp-reset need users.manage in every company of the account (any state), re-checked at link use. Opus round 6 APPROVE (27096ff).

## Next (in order)
1. C0: `frontend/src/contract/FROZEN.json` + freeze guard script (hash contract file + route-spec + scalars + DocType dependency; CI step; version + ADR to change). Fold the P0 review notes into the spec: reset-link issuer mandatory (missing → 404); P8 re-check that the issuer still holds users.manage in the issuing company; P8 drop the narrowed `Me.activeCompanyId`; P10 cross-site check names `POST /auth/links/{token}`.
2. Open the SP3 PR after C0 (P0 + C0), CI green → merge.
3. P1 backend scaffold and CI; then P2 … P11 sequentially, Opus review each.
