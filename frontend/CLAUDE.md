@AGENTS.md

- SP1 runs on mock data: `NEXT_PUBLIC_API_MOCKING=enabled` starts the MSW worker (`src/mocks/`).
- Commands: `corepack pnpm dev | lint | typecheck | test | e2e`.
- Production code never computes tax or totals — call the compute endpoint.
- UI strings live in `src/messages/th.json` and `en.json`.
