# Staging preview (Coolify)

The mock-backed frontend (SP1: Next.js + MSW in the browser, no backend) is built and served by Coolify from
`deploy/frontend/Dockerfile`. Docker is not available on the dev box, so the image is only ever built by Coolify.

## Coolify application settings

| Setting | Value |
|---|---|
| Source | GitHub `pinsorn/teas2` |
| Branch | `main` |
| Build pack | Dockerfile |
| Dockerfile location | `deploy/frontend/Dockerfile` |
| Base directory | `/` (repo root; the Dockerfile copies `frontend/`) |
| Port | `3000` |
| Domain | `https://teas2-preview.kazaki-rio.com` |
| Access control | HTTP basic auth through a Traefik middleware |

Domain and basic auth were chosen by Ham on 2026-10-14.

**Basic auth credentials live only in Coolify** (the middleware label / Coolify's basic-auth setting). Never write them
in this repository, in `STATUS.md`, or in a commit message.

The image sets `NEXT_PUBLIC_API_MOCKING=enabled` at build time; no runtime environment variables are needed.

## Verify after a deploy

1. The public URL answers: `https://teas2-preview.kazaki-rio.com/` returns 401 without credentials (basic auth) and
   200 with them.
2. The browser shows the basic-auth prompt; after signing in the title is "TEAS 2".
3. `/mock/screens` loads and every "เปิด ..." link opens without an error page.
4. A print route renders: `/print/TI/ti-007` shows the tax invoice paper (and `/print/TI/spike-60` runs to 3 pages).
5. On a 390 px wide viewport `/mock/screens` has no horizontal scrolling.
