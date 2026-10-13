# STATUS — TEAS 2

**Goal:** TEAS 1 feature parity, rebuilt with accounting flexibility, better UX and a systematic, gated delivery
(`docs/specs/SP0-charter.md` §1).

## Now — 2026-10-14
- **SP0 approved by Ham** (`docs/specs/SP0-charter.md`, D-01…D-24).
- Plans written, **waiting for Ham's review and choice of execution method**:
  - `docs/plans/2026-10-14-p0-repo-setup.md` — orchestrator setup, hygiene, templates, GitHub remote (5 tasks)
  - `docs/plans/2026-10-14-sp1ab-design-system-kit.md` — scaffold, mock API, shell, style tiles (gate),
    kit, TI loop, render spike, staging (17 tasks)
  - `docs/plans/2026-10-14-sp-r-tax-research.md` — R-01…R-20 tri-model research, golden fixtures (11 tasks)
- Diagrams: `docs/specs/SP0-diagrams.md` · rendered page https://claude.ai/artifact/9BMzT5Jupxa3emA6kQf4q6

## Decisions 2026-10-14
- Plans approved; execution = **subagent-driven**.
- GitHub repo `pinsorn/teas2` = **public** (AGPL).
- Mockup staging = **`teas2-preview.kazaki-rio.com` + basic auth**.

## Next
1. P0 Tasks 1–4 done and reviewed; Task 5 (public GitHub repo + branch protection) next.
2. Then SP1ab and SP-R in parallel (disjoint files: `frontend/` vs `docs/research/`, `fixtures/`, `tools/golden-capture/`);
   SP-R Task 7+ waits for SP1ab Task 2 (`frontend/src/mocks/fixtures/companies.json`).

## Done
- TEAS 1 v2.5.0 discovery: `docs/discovery/01`–`04`.
- SP0 charter + diagrams (approved 2026-10-14).
