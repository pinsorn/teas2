# ADR-0003: Module contracts are frozen TypeScript, guarded by hash

| Date | Status | Deciders |
|---|---|---|
| 2026-10-27 | Accepted | Ham, orchestrator |

## Context
SP0 §11.2 makes SP2 a contract freeze ("TypeScript types per module") and §10.5 generates OpenAPI from the .NET API.
The SP1c mock, approved by Ham, is the only source of the wire shapes today. Without a guard, the mock, the frontend
and the coming .NET API drift apart silently (SP0 §12 risk "mock drifting from the real API").

## Decision
- Each module's wire contract lives in `frontend/src/contract/<module>.ts` (types, `ROUTES`, `CONTRACT_VERSION`); the
  old `domain/` / `records/` files re-export it (master plan §2.2).
- A module is frozen when Ham approves its spec: `frontend/src/contract/FROZEN.json` records its version and a sha256
  over the contract file and its guarded dependencies (`route-spec.ts`, `scalars.ts`, the `DocType` declaration),
  LF-normalised.
- `tools/check-contract-freeze.mjs` runs on every PR (layout job). A hash change passes only with a higher
  `CONTRACT_VERSION`, the updated `FROZEN.json` entry and an ADR under `docs/adr/` naming the module and the new version.
- From SP3 P3 on, the .NET-generated OpenAPI types must conform to the frozen ones (`pnpm typecheck`).

## Consequences
- Changing a frozen contract is deliberate and recorded; the mock must keep conforming (table-driven contract test).
- Hashing only the `DocType` declaration of `domain/types.ts` leaves the rest of that file free (P8 edits `Me`).
- First frozen module: `platform` 1.0 (SP3 P0, approved 2026-10-27).

## Spec changes
`docs/plans/2026-10-27-sp2-contract-freeze.md` §2.2, §2.4; `docs/specs/SP3-platform.md` §11 P0 (contract frozen: platform 1.0).
