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

---

# API staging runbook (SP3 P11a)

The staging stack is four Coolify resources on one host (**Postgres**, the **migrator** one-shot, the **API**, the **web** hybrid build) behind Coolify's own Traefik.
Docker is not available on the dev box: nothing below has run yet, the first staging deploy is its test. Every value in `<angle brackets>` is a placeholder;
**real values live only in Coolify's environment screens**, never in this repository, `STATUS.md`, a commit message or a report.

## 1. Resources

| Resource | Source | Notes |
|---|---|---|
| `teas-postgres` | Coolify PostgreSQL 18 | No public port. Persistent volume (Coolify default). Database `teas`, owner `teas_migrator` (section 2). |
| `teas-migrator` | Dockerfile `deploy/backend/Dockerfile`, **target `migrator`**, base directory `/` | One-shot: runs `migrate` and exits. Not routed, no domain, restart policy `no`. |
| `teas-api` | Dockerfile `deploy/backend/Dockerfile`, **target `api`**, base directory `/` | Port `8080` exposed to Traefik only. **No host port mapping.** Non-root image (`$APP_UID`). |
| `teas-web` | Dockerfile `deploy/frontend/Dockerfile`, base directory `/` | Port `3000`. The hybrid build (below): the SP1 preview plus the live routes through `proxy.ts`. |

The same Dockerfiles are built by the `compose` job of `.github/workflows/backend.yml`, which is the only place they have run so far.

## 2. One-time database setup (superuser, once per server)

From the Postgres resource's terminal, with the passwords in the environment, not on the command line (the file is `deploy/db/bootstrap-roles.sql`; copy it in or paste it):

```
export TEAS_MIGRATOR_PW='<generated>' TEAS_APP_PW='<generated>'
psql -U postgres -v ON_ERROR_STOP=1 -f bootstrap-roles.sql      # roles teas_migrator, teas_app (NOSUPERUSER NOBYPASSRLS)
psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE teas OWNER teas_migrator"
```

Never set `TEAS_TEST_ADMIN_PW` outside a dev box or CI.

## 3. Environment variables (names only; **S** = secret: a Coolify secret / hidden variable)

**teas-migrator** (runtime)

| Name | S | Value |
|---|---|---|
| `TEAS_MIGRATOR_CS` | S | `Host=<postgres-host>;Database=teas;Username=teas_migrator;Password=<TEAS_MIGRATOR_PW>` |
| `TEAS_PUBLIC_URL` | | The public https origin of the web (the base of the one-time links that `bootstrap-admin` / `reset-password` print). |

**teas-api** (runtime)

| Name | S | Value |
|---|---|---|
| `ASPNETCORE_ENVIRONMENT` | | `Production` (turns the startup guards and the Secure session cookie on). Never `Development`. |
| `ConnectionStrings__Teas` | S | `Host=<postgres-host>;Database=teas;Username=teas_app;Password=<TEAS_APP_PW>` |
| `TEAS_BFF_SECRET` | S | At least 32 random characters. **The same value as on teas-web.** |
| `TEAS_FILES_DIR` | | `/data/files` (the image default). A persistent volume (3.1). |
| `TEAS_DP_KEYS_DIR` | | `/data/dp-keys` (the image default). A persistent volume, backed up apart from the database (3.1). |
| `TEAS_PUBLIC_URL` | | Same as the migrator's. |
| `TEAS_VERSION` | | The build id shown by `/version` (e.g. the short commit). |
| `ASPNETCORE_FORWARDEDHEADERS_ENABLED` | | `true`. Without it every client is Traefik's address and the per-IP limits (`/auth/*` 20 / min, `/api/v1` + `/mcp` 300 / min) are one bucket for everybody. |
| `TEAS_FORWARDED_KNOWN_NETWORKS` | | Recommended: Traefik's address on the network it shares with the API, as CIDR (`<traefik-ip>/32`, or that network's CIDR), comma separated. Then only Traefik's `X-Forwarded-For` is believed. Unset = the framework trusts any peer (the API port must then be unreachable except through Traefik). A bad CIDR stops the start. It does not switch forwarded headers on by itself. |
| `TEAS_AUTH_RATE_LIMIT`, `TEAS_MACHINE_RATE_LIMIT` | | Optional overrides of 20 and 300 per minute per IP. |

`TEAS_JOBS_DISABLED` is for test hosts only: do not set it.

**teas-web** build arguments (mark them "Build Variable" in Coolify: `NEXT_PUBLIC_*` is fixed at build time)

| Name | Value |
|---|---|
| `NEXT_PUBLIC_API_MOCKING` | `enabled` (the mock worker answers every route that is not live yet) |
| `NEXT_PUBLIC_API_MODE` | `hybrid` (live routes 1-33 go to the API; `mock` is the default of the SP1 preview) |

**teas-web** (runtime)

| Name | S | Value |
|---|---|---|
| `TEAS_API_INTERNAL_URL` | | The API's address on the Docker network, e.g. `http://<api-container-name>:8080` (not the public domain). |
| `TEAS_BFF_SECRET` | S | Identical to the API's. |
| `TEAS_TRUSTED_PROXY_HOPS` | | The real number of proxies in front of the web that append to `X-Forwarded-For`: `1` = Traefik only (default); `2` when a CDN in front also appends. Wrong in either direction lets a client choose its own IP or merges everyone into one bucket. |

### 3.1 Volumes (teas-api)

| Mount | Why |
|---|---|
| `/data/files` | `TEAS_FILES_DIR`: stored images and attachments. Losing it loses every stored file. |
| `/data/dp-keys` | `TEAS_DP_KEYS_DIR`: the Data Protection key ring. Without it each restart makes every stored TOTP secret unreadable (users locked out of 2FA). |

A new named volume is created writable for the non-root user. An existing volume or a bind mount keeps its owner: `chown -R <APP_UID> <path>` once
(`docker run --rm --entrypoint sh <api-image> -c 'echo $APP_UID'` prints the id).

## 4. Order of a deploy

1. Deploy `teas-postgres`; section 2 the first time only.
2. Run `teas-migrator`. It prints `schema is at ...` and `catalog permissions=N roleTemplates=M`, then exits. **Write N and M down** (probe step 1).
3. Deploy `teas-api`, then `teas-web`. The API refuses to start on a schema other than its own, so a migrator run always precedes an API deploy.
4. First deploy only: create the first admin and give them a company (section 6).

## 5. Traefik routes (SP3 4.8)

One public host `<host>` (today `teas2-preview.kazaki-rio.com`):

| Path prefix | To | |
|---|---|---|
| `/api/v1`, `/mcp`, `/oauth`, `/.well-known`, `/health`, `/version` | **teas-api** (`:8080`) | machine and probe surface |
| everything else (including `/bff/v1`) | **teas-web** (`:3000`) | the BFF reaches the API on the internal network |
| `/internal/v1` | **not routed** | the BFF-only surface; it answers 404 from the public host |

In Coolify: on `teas-api` set Domains to the six prefixed URLs (`https://<host>/api/v1,https://<host>/mcp,https://<host>/oauth,https://<host>/.well-known,https://<host>/health,https://<host>/version`);
on `teas-web` set `https://<host>`. Traefik gives the longer path rules priority over the catch-all. If you write the labels by hand, the API router rule is
``Host(`<host>`) && (PathPrefix(`/api/v1`) || PathPrefix(`/mcp`) || PathPrefix(`/oauth`) || PathPrefix(`/.well-known`) || PathPrefix(`/health`) || PathPrefix(`/version`))``
with a higher `priority` than the web router. `/internal/v1` appears in no rule.

The binding deploy lines (P10a): the API and web ports are reachable **only** through Traefik (no host port mapping, no other published path);
`ASPNETCORE_FORWARDEDHEADERS_ENABLED=true` on the API; `TEAS_TRUSTED_PROXY_HOPS` equal to the real proxy count; both volumes persistent;
`TEAS_BFF_SECRET` on both services. Traefik's default overwrites a client-sent `X-Forwarded-For` unless told to trust the sender (`forwardedHeaders.trustedIPs`):
keep that default, and behind a CDN trust only the CDN's ranges. If the staging basic auth stays on, keep it on the **web** router only: machine clients cannot send it.

## 6. First admin (staging only, by hand)

`bootstrap-admin` creates the user with no company, and SP3 has no company-creation route, so the staging seed gives them companies (`deploy/db/seed-ci.sql` is the model:
run it as the Postgres superuser with `-v email=<admin email>`; it ends in a row-count probe that fails unless the admin is in exactly two companies).
The migrator's verbs run from the image Coolify built for `teas-migrator`, on the Coolify host:

```
docker run --rm -e TEAS_MIGRATOR_CS -e TEAS_PUBLIC_URL --network <postgres-network> <migrator-image> bootstrap-admin --email <admin email> --name '<admin name>'
```

It prints exactly one line on stdout, the set-password link; the database keeps only its hash. Open it once.

## 7. Deploy probe (SP3 section 8; row counts, not exit codes)

Run after every deploy. `H=https://<host>`; add `-u '<basic-auth user>:<password>'` to the curl lines for routes that sit behind the staging basic auth.

1. **Migrator**, in the Postgres terminal as the owner:
   ```
   psql -U teas_migrator -d teas -tAc 'SELECT count(*) FROM teas.permissions'        # = N printed by the migrator
   psql -U teas_migrator -d teas -tAc 'SELECT count(*) FROM teas.role_templates'     # = M printed by the migrator
   psql -U teas_migrator -d teas -tAc 'SELECT max("MigrationId") FROM teas."__EFMigrationsHistory"'   # = the `schema` of step 2
   ```
2. **API readiness through the public domain**:
   ```
   curl -fsS "$H/health/ready"   # {"db":"ok","schema":"<id>","catalog":{"permissions":N,"roleTemplates":M}} equal to step 1; 503 on a schema mismatch
   curl -fsS "$H/version"
   ```
3. **As `teas_app`** (`PGPASSWORD=<TEAS_APP_PW>`):
   ```
   psql -h <postgres-host> -U teas_app -d teas -tAc 'SELECT count(*) FROM teas.companies'                                     # 0 (no company set)
   psql -h <postgres-host> -U teas_app -d teas -tAc "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'teas_app'"  # f|f
   ```
4. **Public routes**:
   ```
   curl -s "$H/bff/v1/auth/session"                                       # 200 {"state":"out"}
   curl -s -o /dev/null -w '%{http_code}\n' "$H/internal/v1/me"           # 404 (not routed)
   curl -s -w '\n%{http_code}\n' "$H/api/v1/whoami"                       # 401, code connect.key_invalid
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -H 'origin: https://evil.example' -d '{}' "$H/bff/v1/auth/logout"   # 403
   ```
5. **Staging only, the first sign-in**: open the bootstrap link in a browser, set the password, sign in; `GET $H/bff/v1/me` (with the session cookie) returns the user, and
   ```
   psql -U postgres -d teas -tAc "SELECT count(*) FROM teas.audit_log WHERE command = 'auth.login'"   # >= 1
   ```
6. **Logs** (Coolify, both services): no `/auth/links/` token appears in the web or the API log.

A failed probe line is a failed deploy: do not hand the staging URL to anyone.
