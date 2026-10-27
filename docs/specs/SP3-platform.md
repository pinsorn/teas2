# SP3 — Platform foundation

| | |
|---|---|
| Status | Draft for Ham, 2026-10-27 |
| Owner | Ham |
| Implements | `docs/specs/SP0-charter.md` §4, §7.8 (pipeline primitives), §7.12, §8.1, §8.5, §10.1–10.9, §11.4 item 1; master plan `docs/plans/2026-10-27-sp2-contract-freeze.md` |
| Blast cap | Per task (each task names its own; hitting it = stop and re-spec). Spec-wide: new tree `backend/**`; frontend limited to `frontend/src/contract/**`, the files named in P0 / P10, `frontend/src/proxy.ts`; `deploy/**` (P10, P11); `.github/workflows/**`. **API changes:** exactly the platform contract in §5 (frozen at Ham's approval); anything else = ADR + version (master plan §2.4) |

## 1. Goal

Build the platform every module stands on: repo + CI for the backend, the tenancy and RLS harness, the migrator,
auth + membership, the permission catalog, the error contract, idempotency, concurrency, audit, clock, files, the job
skeleton, the OpenAPI → TypeScript pipeline with the contract-conformance gate, API keys + the agent surface (REST v1 +
MCP host + tool generator) and the BFF switch that lets the real API replace the MSW mock route by route (D-09).
Behaviour is what the approved mock does (SP1c HC2 / HC3 / ST1 rulings and reviews), hardened where a real server must
differ (secrets, sessions, RLS).

## 2. Scope

| In SP3 | Not in SP3 (owner) |
|---|---|
| Platform routes of §5.3 | OAuth 2.1 server, consent page, connected apps, agent policy, agent review protocol (SP4.10) — they stay on MSW |
| `companies`, members, custom roles, users, sessions, API keys | Company onboarding wizard + COA template at company creation (SP4.11 / SP4.1); SP3 has a system `CompanyFactory` used by tests and the bootstrap CLI |
| Agent surface by construction (`/api/v1`, `/mcp`), tool generator, `whoami` tool | Document tools (each SP4 module ships its tools from its descriptors) |
| Public-link **rules** (§6 S13) frozen here | Public-link routes and table (SP4.2, they need documents and the paper) |
| File store + `files` table | Attachments (SP4.2), statutory PDFs (SP4.8) |
| Audit write side, append-only, coverage test | Audit log viewer report (SP4.9) |
| Job platform + one job (idempotency cleanup) | Recurring / accrual / schedule jobs (SP4.6) |

## 3. Context and footguns (read before any task)

| # | Footgun | Where it bites | Rule |
|---|---|---|---|
| F1 | TEAS 1: ≥ 11 prod-only RLS incidents because dev and tests ran as superuser (SP0 §10.3) | every DB test | tests connect as `teas_app` only; the harness asserts `current_user = 'teas_app'` and `NOT rolsuper AND NOT rolbypassrls` before the first test, else the run fails |
| F2 | `current_setting('app.company_id', true)` returns `''` (not NULL) once the GUC was set earlier in the session; `''::uuid` raises | every policy | policies read `NULLIF(current_setting('app.company_id', true), '')::uuid` through `teas.current_company()` only (§4.2) |
| F3 | `set_config(..., false)` leaks a company into the next pooled request | TenantScope | only `set_config(name, value, true)` (transaction-local), only in `TenantScope.cs`; an architecture test greps the repo for `set_config` / `SET app.` elsewhere and fails |
| F4 | A query outside a transaction has no GUC → RLS returns 0 rows silently | reads | every request runs in one transaction (fail closed is intended); an integration test proves a no-GUC read returns 0 rows |
| F5 | `FORCE ROW LEVEL SECURITY` applies to the table owner `teas_migrator`: a data migration touching tenant rows silently updates 0 rows | migrator | schema migrations never write tenant rows; a future data migration uses `ForEachCompany` (§4.3) and asserts the affected row count |
| F6 | `CREATE DATABASE … TEMPLATE` fails while any connection to the template is open (Npgsql pooling keeps one) | test harness | the harness admin connection uses `Pooling=false`; after migrating the template, `NpgsqlConnection.ClearAllPools()` |
| F7 | `teas_app` cannot read `__EFMigrationsHistory` (owned by the migrator) → the startup schema check throws | API startup | the migrator `GRANT SELECT ON "__EFMigrationsHistory" TO teas_app` |
| F8 | troubles-wiki "Agent requests: the allowlist in `mocks/handlers/me.ts` is the only guard outside document writes": handlers passed the fixed user, so a widened regex let an agent in dressed as a person | agent surface | an agent can only reach routes MAPPED for it (`/api/v1`, `/mcp` groups contain only `agent: true` routes); the actor comes from the credential, never a header; runtime check as backstop (§4.6) |
| F9 | troubles-wiki "StringBuilder.AppendLine breaks cross-platform text snapshots (.NET)" | any text / CSV / snapshot | append `"\n"` (or the format's delimiter) explicitly |
| F10 | troubles-wiki "A new permission code fails `permissions.test.ts`" | P0, P5 | a new code enters the catalog (and `th.json` / `en.json` labels) in the same change |
| F11 | Mock-only behaviour that must NOT be ported: `x-teas-actor` header, `/auth/demo`, `/mock/*`, toolbar role, `POST /settings/users/{id}/accept`, the TOTP code derived from a hash (`codeFor(secretHash)`) | P7, P10 | real TOTP needs the secret → stored **encrypted**, not hashed (§4.4) |
| F12 | ST1 / HC3 reviews: last-admin holes (role edit, pending invite, self-demotion); unanchored session-gate regex; `extend` reviving an expired session; `relogin` falling back to a default user; public-link type check missing | P7, P8 | each is a named test in §6 |
| F13 | Dev box: Windows 11, PowerShell 5.1 (no `&&`), no Docker; local PostgreSQL 18 at `S:\Program Files\PostgreSQL\18`, port 5432; CI is Linux (`.gitattributes` LF) | all | compose smoke runs in CI only; local integration tests use the local PG 18 |
| F14 | Workers never run `git worktree add/remove` (troubles-wiki "`git worktree remove --force` deletes the main worktree's `node_modules`") and never commit | all | controller commits |

SP-R points touching SP3 (master plan §3.1): D-04-1 (append-only for all tenants — built that way), D-04-2 (no purge;
legal hold later), D-04-3 (hosting in Thailand — Q6, before production).

## 4. Design

### 4.1 Solution layout (SP0 §10.2)

```
backend/
  Teas.sln  Directory.Build.props  Directory.Packages.props (central, exact versions)  BannedSymbols.txt  .editorconfig
  src/Teas.Domain/        pure: Money, BusinessDate, Totp (RFC 6238), PermissionCatalog, AgentRules, ErrorCodes
  src/Teas.App/           Platform module: commands/queries, EF Core DbContext + mappings, TenantScope, Audit, Idempotency, Files, Jobs
  src/Teas.Api/           host: endpoint registration (RouteSpec metadata), auth handlers, problem mapping, OpenAPI, MCP host, rate limits, health
  src/Teas.Migrator/      EF migrations, SQL helpers (RLS), catalog sync, CLI verbs (migrate | bootstrap-admin | reset-mfa | reset-password)
  tests/Teas.Domain.Tests/        unit, no DB
  tests/Teas.Integration.Tests/   DB as teas_app (template clones), HTTP via WebApplicationFactory
  tests/Teas.Architecture.Tests/  registry, RLS allow-list, banned APIs, set_config grep, file size (> 600 lines needs a recorded reason)
```
Pinned by P1: .NET SDK 10.0.x (`global.json`), EF Core 10 + Npgsql, `Microsoft.AspNetCore.OpenApi`,
`Microsoft.Extensions.ApiDescription.Server` (build-time document), `ModelContextProtocol.AspNetCore`,
`Microsoft.CodeAnalysis.BannedApiAnalyzers`, `Microsoft.Extensions.Identity.Core` (PasswordHasher only), xUnit,
OpenTelemetry. Each task pins the packages it first uses (exact versions) in `Directory.Packages.props`; no floating versions.
P1 pins only what it uses: SDK, BannedApiAnalyzers, xUnit, Mvc.Testing, TimeProvider.Testing.

### 4.2 Database: roles, schema, RLS

- Roles (created once by `deploy/db/bootstrap-roles.sql`, run as the PostgreSQL superuser; idempotent):
  `teas_migrator` LOGIN, owns schema `teas`, NOSUPERUSER, NOBYPASSRLS; `teas_app` LOGIN, NOSUPERUSER, NOBYPASSRLS,
  no ownership; `teas_test_admin` LOGIN CREATEDB (local + CI only, never in prod).
- Grants: `teas_app` gets SELECT / INSERT / UPDATE / DELETE on tenant and global tables, except: `audit_log`,
  `auth_events` → INSERT, SELECT only; `permissions`, `role_templates` → SELECT only; `__EFMigrationsHistory` → SELECT.
- Helper functions (migration `0001_platform_base`):

```sql
CREATE SCHEMA IF NOT EXISTS teas AUTHORIZATION teas_migrator;
CREATE FUNCTION teas.current_company() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.company_id', true), '')::uuid $$;
CREATE FUNCTION teas.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION teas.is_system() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT current_setting('app.system', true) = 'on' $$;
```

- One helper generates every tenant policy (`RlsSql.TenantTable(table)` in the migrator; hand-written policies are
  only the two exceptions below):

```sql
ALTER TABLE teas.<t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE teas.<t> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON teas.<t>
  USING (company_id = teas.current_company() OR teas.is_system())
  WITH CHECK (company_id = teas.current_company());          -- system scope may read / delete, never write a row
```
  Exceptions: `companies` (key `id`): `USING (id = teas.current_company() OR teas.is_system() OR EXISTS (SELECT 1 FROM
  teas.company_members m WHERE m.company_id = companies.id AND m.user_id = teas.current_user_id() AND m.active AND NOT
  m.invite_pending)) WITH CHECK (id = teas.current_company())`; `company_members`: `USING (company_id =
  teas.current_company() OR user_id = teas.current_user_id() OR teas.is_system()) WITH CHECK (company_id =
  teas.current_company())` (the company switcher lists a user's memberships across companies). **P2a ruling (M2):** the widening
  is SELECT-only. For these two tables the policy is split: `tenant_select` carries the widened USING; `tenant_insert`
  (WITH CHECK), `tenant_update` (USING `id`/`company_id = current_company() OR is_system()`, same WITH CHECK) and
  `tenant_delete` (same USING) use the narrow predicate. Reason: one FOR ALL policy would let company A's session UPDATE or
  DELETE a row it may merely see (its own membership row in B, company B itself).
- Global tables (no RLS) are listed in `backend/src/Teas.Migrator/rls-allowlist.txt`, one per line with a reason. An
  architecture test queries `pg_class` / `pg_policy` on the migrated template: every table in schema `teas` is either
  on the allow-list, or has `relrowsecurity AND relforcerowsecurity` and ≥ 1 policy (SP0 §10.3).
- Append-only: `audit_log`, `auth_events` carry `BEFORE UPDATE OR DELETE` row triggers and a `BEFORE TRUNCATE`
  statement trigger that raise; `teas_app` has no UPDATE / DELETE / TRUNCATE grant on them either.

Schema sketch (P2 creates the base, later tasks add their tables; types: ids `uuid`, money `numeric(18,2)`, instants
`timestamptz`, dates `date`):

| Table | Scope | Key columns |
|---|---|---|
| `users` | global (identity across companies) | `id`, `email citext UNIQUE`, `display_name`, `password_hash NULL` (NULL = must set via a link), `password_changed_at`, `totp_secret_enc bytea NULL`, `totp_pending_enc bytea NULL`, `totp_last_step bigint NULL`, `last_company_id uuid NULL`, `locale`, `created_at`, `version` |
| `recovery_codes` | global | `id`, `user_id`, `code_hash`, `used_at NULL` |
| `sessions` | global | `id`, `user_id`, `token_hash bytea UNIQUE`, `active_company_id NULL`, `device`, `ip inet`, `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at NULL`, `revoke_reason NULL` |
| `login_challenges` | global | `token_hash PK`, `user_id`, `expires_at` (5 min) |
| `auth_failures` | global | `key_hash PK` (sha256 of lower-cased trimmed email), `failures`, `locked_until NULL`, `updated_at` |
| `auth_events` | global, append-only | `id`, `at`, `kind`, `email_hash NULL`, `user_id NULL`, `ip`, `user_agent` |
| `user_links` | global (resolved before any session) | `id`, `kind ('invite'\|'reset')`, `token_hash UNIQUE`, `user_id NULL`, `company_id NULL`, `member_id NULL`, `expires_at`, `used_at NULL`, `superseded_at NULL`, `created_by` |
| `permissions` | global catalog | `code PK`, `area`, `agent_forbidden bool`, `sort` |
| `role_templates` | global catalog | `(role_id, permission_code) PK` |
| `companies` | tenant (by `id`) | identity / contact / payroll / fiscal fields of `Company`, `logo_file_id`, `stamp_file_id`, `default_notes jsonb`, `version` |
| `company_members` | tenant | `company_id`, `id`, `user_id NULL` (pending invite), `email citext`, `name`, `role_id text` (system role or custom role id), `position`, `signature_file_id`, `active`, `invite_pending`, `last_login_at`, `version`; `UNIQUE (company_id, email)`, `UNIQUE (company_id, user_id)` |
| `custom_roles` | tenant | `company_id`, `id`, `name`, `description`, `permissions text[]`, `version`; `UNIQUE (company_id, name)` |
| `api_keys` | tenant | `company_id`, `id`, `name`, `kind ('rest'\|'mcp')`, `prefix` (display only), `secret_hash bytea UNIQUE`, `owner_user_id`, `scopes text[]`, `created_at`, `expires_on date NULL`, `last_used_at`, `revoked_at NULL`, `rotated_from NULL`, `version` |
| `audit_log` | tenant, append-only | `company_id`, `id bigint identity`, `at`, `actor_kind`, `actor_id`, `actor_name`, `owner_id NULL`, `owner_name NULL`, `command`, `target`, `before jsonb`, `after jsonb`, `result ('ok'\|'rejected')`, `ip`, `trace_id`, `client ('web'\|'mcp'\|'api')`, `idempotency_key NULL` |
| `idempotency_records` | tenant | `(company_id, actor_id, key) PK`, `route`, `request_hash`, `status_code`, `response jsonb`, `created_at` |
| `files` | tenant | `company_id`, `id`, `sha256`, `mime`, `size_bytes`, `name`, `created_at`, `created_by` |
| `jobs` | tenant | `company_id`, `id`, `kind`, `payload jsonb`, `run_at`, `status`, `attempts`, `last_error`, `result jsonb`, `started_at`, `finished_at`, `created_at` |

### 4.3 Runtime security context (who runs what, under which policies)

| Process | DB role | GUCs at that moment | Reads | Writes | How each satisfies RLS |
|---|---|---|---|---|---|
| Migrator `migrate` (deploy step, before the API) | `teas_migrator` (owner, FORCE applies) | none | `__EFMigrationsHistory`, catalog tables | DDL; catalog sync into `permissions`, `role_templates` (global, no RLS) — idempotent upsert + delete of codes no longer in the catalog | catalog tables are global → not filtered. Any future tenant data migration must call `ForEachCompany(conn, c => …)` (lists companies with `app.system = on`, then per company `set_config('app.company_id', c, true)` in its own transaction) and assert row counts |
| Migrator `bootstrap-admin --email` / `reset-mfa --email` / `reset-password --email` (server operator) | `teas_migrator` | none | `users` | `users`, `user_links`, `recovery_codes` (global) | global tables. Prints the one-time set-password link once to stdout; stores only its hash |
| API startup | `teas_app` | none | `__EFMigrationsHistory` (granted), `permissions` (global), `pg_roles` | none | refuses to start (exit ≠ 0, logged reason) when: the schema version ≠ the build's; `rolsuper OR rolbypassrls` for `current_user`; `relforcerowsecurity` is false on any non-allow-listed table; or the RLS self-test fails: `SELECT count(*) FROM teas.companies` with no GUC must be 0 (on a non-empty DB, the same count under `app.system = 'on'` is > 0, proving the policy — not an empty table — gave 0) |
| API request with a session | `teas_app` | `app.user_id`, `app.company_id` = session's active company, set as the first statement of the request transaction | tenant tables of the active company; own memberships across companies | same | `TenantScope.Enter(companyId, userId)` |
| Login / TOTP / relogin / link | `teas_app` | none, then `Enter` for the audit row | `users`, `sessions`, `login_challenges`, `auth_failures`, `user_links` (global) | same + `auth_events`; tenant `audit_log` row inside `Enter(company)` (login: the session's active company) | global tables unfiltered; the tenant audit write sets the company first |
| API key / MCP request | `teas_app` | `EnterSystem("key-auth")` for the hash lookup only, then `Enter(key.company_id, owner)` for the rest | `api_keys` by `secret_hash` | `api_keys.last_used_at` (inside `Enter`) | system scope reads; the write happens after `Enter` (WITH CHECK passes) |
| Job runner (leader) | `teas_app` | pick: `EnterSystem("jobs")`; run: `Enter(job.company_id)` | `jobs` due | claim `UPDATE jobs SET status='running' WHERE id=$1 AND status='queued'` inside `Enter` (rowcount 1 = claimed); results | system scope reads only; every write inside the job's company |
| Idempotency cleanup job | `teas_app` | `EnterSystem("idem-cleanup")` | — | `DELETE FROM idempotency_records WHERE created_at < now() - interval '7 days'` (USING allows system; DELETE has no WITH CHECK) | allowed by USING |
| Integration tests | harness: `teas_test_admin` clones; tests: `teas_app` | as the code under test | — | — | harness asserts the role (F1) |

`TenantScope` API: `Enter(Guid companyId, Guid? userId)`, `EnterSystem(string reason)` (reason logged with the trace;
an architecture test allows `EnterSystem(`, `ScopeState(`, `ApplyAsync(` and `ForEachCompanyAsync(` only in `Platform/Auth`, `Platform/Jobs`, `Platform/Keys`, `Migrator` and `Teas.Api/Startup/StartupGuards` (the startup RLS self-test needs system scope); `ScopeState`, `ApplyAsync`, `ForEachCompanyAsync` are internal to `Teas.App`; a scope change while a transaction is open is applied to it at once and restored on dispose),
`ForEachCompany`. Implementation: an EF Core `DbTransactionInterceptor` issues `SELECT set_config('app.company_id',
$1, true), set_config('app.user_id', $2, true), set_config('app.system', $3, true)` on `TransactionStarted`.

### 4.4 Auth and sessions (browser)

- **Model (ADR-0004, Q1):** opaque server-side session. Login creates a `sessions` row and a 256-bit random token; the
  API sets `__Host-teas_session=<token>; Path=/; HttpOnly; Secure; SameSite=Lax` (dev over http: `teas_session`, no
  `Secure`); the BFF passes `Set-Cookie` through unchanged and forwards `Cookie` to the API. The DB keeps
  `sha256(token)`. This is what the mock models (sessions list, revoke one, revoke others on password change, extend,
  expiring / expired) and what §10.4's intent needs (logout revokes instantly).
- **Timeouts (Q2):** idle 60 min, absolute 12 h. `GET /auth/session` does NOT extend (the expiry dialog polls it); every other
  authenticated request — GETs included (reading a report is activity) — extends the idle expiry (written at most once
  per 60 s). State: `active` (> 120 s left), `expiring` (≤ 120 s, with
  `expiresInSec`), `expired` (idle passed, row not revoked, absolute not passed — relogin allowed), `out` (no cookie,
  revoked, unknown, or absolute passed).
- **Passwords:** `PasswordHasher<T>` (PBKDF2-HMAC-SHA512, ASP.NET Identity v3 format) — stdlib-first (no Argon2
  package); rule `^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$` (mock `STRENGTH`); new ≠ current.
- **TOTP:** RFC 6238, HMAC-SHA1, 6 digits, 30 s, window ±1 step; a step already used (`totp_last_step`) is refused;
  secret 160-bit random, Base32; stored encrypted with ASP.NET Data Protection (purpose `teas.totp.v1`), key ring on
  the volume `TEAS_DP_KEYS_DIR` (backed up separately from the DB). Enrolment: `pending` secret until a correct code;
  then 8 recovery codes `RCV-XXXX-XXXX` (alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`) returned once, stored with
  `PasswordHasher`, each usable once. **P7a:** when two-step is already on, routes 9 and 10 need a sign-in from the last 10 minutes (`sessions.created_at`), else 403 `auth.forbidden`; a successful re-enrolment revokes every other session of the user.
- **Login failures:** unknown email and wrong password give the same 401 `auth.invalid_credentials` and run one dummy
  hash verification (timing). Counter per `sha256(lower(trim(email)))` over login, TOTP step, relogin and the
  current-password check: 5 consecutive → `locked_until = now + 15 min`, answer 429 `auth.locked` (the failure that
  locks already says so); success clears it. **P7a:** the attempt is RESERVED before it is checked (one atomic upsert returns its number n; n above 5 = locked, nothing is verified), so a parallel burst buys at most 5 checks; a right password whose second factor is still to come is refunded, and a right current password clears the counter. Plus ASP.NET rate limiter: 20 / min per IP on `/auth/*` (after the BFF-secret check; `GET /auth/session`, the public poll, is exempt).
- **Links (new, Q4; amended P0a):** invite (7 days) and reset (24 h): 256-bit token, stored hashed with its kind and
  `expires_at` **stored at issue** (never recomputed on read), single use; a newer link of the SAME kind for the same
  member supersedes the older. `GET /auth/links/{token}` → `LinkInfo` (with `existingAccount`).
  - **New account** (an invite whose email has no user row; and every reset: only a link issued FOR a user, i.e. reset or bootstrap, may set the password of an existing user): `POST` sets the
    password. For an invite it finds or creates the `users` row by email, sets `company_members.user_id`, clears
    `invite_pending`, audited `user.accept_invite` in that company. For a reset it clears the lockout counter, **revokes
    every session of that user** and is audited `auth.password.reset`.
  - **Existing account** (an invite whose email already has a user row, WHATEVER its password state, with or without two-step; `existingAccount: true`; an invite never sets a password for an existing user): the page
    shows "sign in to accept" and NO password form. `POST` accepts only from a signed-in session of THAT user (links
    the membership, clears `invite_pending`, `user.accept_invite`; no password is read or changed); from anyone else
    (signed out, or another user) it is the one 404. A link must never set the password of an account that already
    has one: an invite is not proof of owning the email.
  - **Whole-account actions (P0c):** reset-link (route 24) and totp-reset (route 25) take over an ACCOUNT, not a
    membership, so the issuer must hold `users.manage` in EVERY company where the account has a membership, of ANY state
    (active, deactivated or pending; matched by `user_id`, by a pending invite of the account's LOGIN email, or by the membership email); otherwise 403 `user.cross_company`. A reset / link resolves the account by `users.id` (the member's
    `user_id`), never by the membership email, and a membership email never creates a login for an existing user.
    The issuer's user id is stored on the link at issue and the same check is **re-checked when the link is used** (GET info
    and POST): if it now fails (the account gained a membership the issuer does not manage) the answer is the one 404
    `auth.link_invalid` and nothing is written.
  - **Known limitation (Ham 2026-10-27):** TEAS sends no email (SP0 section 1.4), so the inviting admin receives the
    link and can pre-claim an email that has no account yet. Accepted until email delivery exists. Exit: the server
    operator runs the CLI `reset-password --email` after verifying the owner's identity out of band; it writes an
    `auth_events` row and prints a one-time reset link, which is a link issued FOR that user and so may set the password.
  - Unknown / used / expired / superseded / **of an inactive member** (deactivating a member clears their links; a
    revoked membership likewise) → one answer 404 `auth.link_invalid`. A reset for a member who has not accepted the
    invite is refused (`user.invite_pending` 409): the invite link stays the way in.
- **Lost second factor (Q3):** `POST /settings/users/{id}/totp-reset` (`users.manage`, not on yourself) clears the
  member's user TOTP + recovery codes + revokes their sessions; the last admin's exit is the server CLI `reset-mfa`.
- **Bootstrap (Q5):** `Teas.Migrator bootstrap-admin --email <e> --name <n>` creates the first user with
  `password_hash NULL` and prints a reset link once. No company: `Me.activeCompanyId = null`, `memberships = []`; the
  frontend routes such a user to `/onboarding` (SP4.11 builds the real wizard).

### 4.5 Membership, roles, permission catalog

- **Catalog in code (§10.4):** `Teas.Domain/Platform/PermissionCatalog.cs` holds every code (every key of
  `frontend/src/messages/th.json#permissions` at main 1a79dd8, `_` → `.`; no additions in SP3), its area and `AgentForbidden`. System role
  templates = `frontend/src/mocks/permissions.ts` `PERMISSIONS_BY_ROLE` at 1a79dd8, verbatim. The migrator syncs both
  into `permissions` / `role_templates`. P5 exports `backend/artifacts/permissions.json` at build; a frontend vitest
  asserts set-equality with `frontend/src/contract/platform.ts` `PERMISSION_CODES` and `SYSTEM_ROLES`. Labels stay in
  `th.json` / `en.json`; a vitest asserts every catalog code has both labels.
- **Agent-forbidden rule (§8.5 widened, ADR-0005):** `AgentForbidden(code) = code ∈ { settings.manage, users.manage,
  connect.manage, ledger.period.close, ledger.period.reopen, tax.filing.finalize, tax.settings.manage,
  ledger.posting.manage, ledger.coa.manage, ledger.schedule.manage } OR code matches ^doc\.[A-Z]+\.(approve|cancel|correct)$`
  (mock `agentForbidden`).
- **Effective rights of a person** in company C = role permissions of their `company_members` row in C when `active
  AND NOT invite_pending`, else ∅; role = system template or `custom_roles.permissions`; ∩ catalog. Cached per
  `(company, user, member.version, role.version)`; `Me.permissions` returns it.
- **Effective rights of an agent** (API key) = `scopes ∩ owner's effective rights in key.company_id NOW − AgentForbidden`
  (an owner demoted or deactivated loses them at once).
- **Last admin (ST1 rulings):** the company always keeps ≥ 1 member that is `active AND NOT invite_pending` and holds
  `users.manage`. Checked on: role change of a member, deactivation, a custom-role edit that drops `users.manage`;
  nobody may demote or deactivate themselves out of `users.manage`. 409 `user.last_admin`.

### 4.6 Agent surface (by construction)

- Every endpoint registers through one builder carrying its `RouteSpec` metadata (auth, permission, agent,
  idempotency, concurrency, errors, audit command). The internal group `/internal/v1` maps all routes and requires the
  BFF header (§4.8). The machine groups `/api/v1` (REST key) and `/mcp` (MCP key) map **only** routes with
  `agent: true`. Runtime backstop: an agent actor reaching a route without `agent: true` gets 403
  `agent.forbidden_action` (`/settings/*` → `agent.forbidden_setting`) **before the body is read**.
- Credential → actor: `Authorization: Bearer teas_<kind>_<48 hex>`; lookup by `sha256(secret)`; revoked → 401
  `connect.key_revoked`; expired (`expires_on < business date`) → 401 `connect.key_expired`; unknown → 401
  `connect.key_invalid`; a REST key on `/mcp` or an MCP key on `/api/v1` → 403 `connect.key_kind_mismatch` (new).
  Actor = `{ kind: 'agent', id: key.id, name: key.name, ownerName }`; audit `client` = `api` or `mcp`.
- SP3's only agent route: `GET /api/v1/whoami` (MCP tool `whoami`). The frozen rule for later modules (mock
  `AGENT_ALLOWED`): agents may create / compute / update / delete their **own** drafts, request a review, issue through
  the review gate, and GET reads except `/connect/*`, `/oauth/*`, `/auth/*`. "Own draft" is enforced in SP4.2.
- **Tool generator:** routes with `agent: true` and an `McpTool(name, description)` attribute become MCP tools whose
  input schema is the route's OpenAPI request schema; the tool call runs the same handler pipeline (authorize,
  idempotency, audit). A test asserts the tool list = routes with `agent: true` + `McpTool`.

### 4.7 Errors, idempotency, concurrency, audit, clock, files, jobs

- **Errors:** `ErrorCodes` registry (`Teas.Domain`): code → HTTP status, Thai title, English title. Every thrown
  `TeasException(code, detail?, fieldErrors?)` maps to `ApiProblem` (`type: about:blank`, `traceId` =
  `Activity.Current.TraceId`); the language follows the `locale` cookie (default Thai). Unknown exceptions → 500
  `http.500` with no internals. A test enumerates every `ErrorCodes` entry (both titles non-empty) and greps the
  source: every code literal thrown exists in the registry.
- **Idempotency:** routes with `idempotency: 'required'` read `Idempotency-Key` (UUID; missing → 400
  `idempotency.key_required`). Inside the command transaction, first statement after TenantScope:
  `INSERT INTO idempotency_records (company_id, actor_id, key, route, request_hash, status_code) VALUES (…, 0)
  ON CONFLICT DO NOTHING` — a concurrent duplicate blocks on the unique index until the first commits; 0 rows
  inserted → read the row: same `request_hash` → replay stored status + body; different → 422
  `idempotency.key_reused`. On success the row is updated with the response in the same transaction; on failure the
  whole transaction (claim included) rolls back. Cleanup job after 7 days.
- **Concurrency (backlog B-2):** every mutable row has `version int`; updates are
  `UPDATE … SET …, version = version + 1 WHERE id = $id AND version = $expected` (EF: `version` as concurrency token);
  rowcount 0 → 409 `record.version_conflict`. The body is bound before any state is read (minimal-API binding), so
  the mock's read-before-await race cannot occur.
- **Audit (§7.12):** `IAudit.Record(command, target, before, after)` writes in the command's transaction (rule 1).
  `before` / `after` never contain secrets, hashes, images or links (images → `"set"` / `"none"`, mock `audited`).
  A refused 403 (`auth.forbidden`, `agent.*`) is written with `result = 'rejected'` in a separate short transaction
  (no before / after). Coverage test: every route with a non-GET method declares an `audit` command, and an
  integration test per route asserts exactly one `ok` row after success and none after a 4xx (except the 403 rows).
- **Clock (§6.3):** `TimeProvider` injected; `BusinessDate.Today(TimeProvider)` in Asia/Bangkok. `BannedSymbols.txt`
  bans `DateTime.Now`, `DateTime.UtcNow`, `DateTime.Today`, `DateTimeOffset.Now`, `DateTimeOffset.UtcNow`,
  `TimeProvider.System` (allowed only in `Program.cs` via a `#pragma` with a comment). Tests use `FakeTimeProvider`.
- **Files (§10.7):** `IFileStore { PutAsync(companyId, stream, name) → FileRef; OpenAsync(companyId, id) }` (no mime parameter: the type is decided by the content's structure, never by a name or a claimed content type); local volume
  `TEAS_FILES_DIR/<company>/<sha256>`; MIME decided from magic bytes (png / jpeg / webp; svg never); company images ≤
  1 MB (mock `MAX_IMAGE_BYTES`). Settings images stay data URLs on the wire (master plan §2.7): the API decodes,
  stores, and returns a data URL built from the stored file.
- **Jobs (§10.7):** `jobs` table; one leader per cluster by `pg_try_advisory_lock(<const>)` on a dedicated connection;
  poll every 30 s; claim as in §4.3; retry with backoff 3 times, then `failed` with `last_error`; result visible.
  A `running` job older than the 15-minute lease is claimed again (one runner wins, guarded on `started_at`); one that already used its last attempt becomes `failed` (`lease expired`). **Handlers must be idempotent** (a job may run twice after a lease expiry). Shutdown mid-handler requeues the job without counting the attempt; a non-JSON result is a failed attempt.
  P6 ships the idempotency cleanup job only.

### 4.8 BFF, OpenAPI → TypeScript, live-route switch

- **BFF (`frontend/src/proxy.ts`, Next.js 16 — read `node_modules/next/dist/docs/` first):** `/bff/v1/:path*` →
  `${TEAS_API_INTERNAL_URL}/internal/v1/:path*` when the route is live (below), adding `X-Teas-Bff: ${TEAS_BFF_SECRET}`,
  stripping any incoming `X-Teas-Bff` and `x-teas-actor`; mutating methods require `content-type: application/json` and
  `Origin` = the app origin (else 403 `http.403`). The API's internal group refuses a request without the right
  `X-Teas-Bff` (401). Traefik routes only `/api/v1`, `/mcp`, `/oauth`, `/.well-known`, `/health`, `/version` to the API.
- **Live-route switch (D-09):** `frontend/src/contract/live-routes.ts` lists `{ method, path }` served by the real API
  (empty until P10). In `NEXT_PUBLIC_API_MODE=hybrid`, MSW handlers of live routes `passthrough()` and `proxy.ts`
  forwards them; `mock` (default, today's behaviour) keeps everything on MSW; `live` sends everything to the API.
- **OpenAPI → TS (§10.5):** the build emits `backend/artifacts/openapi.json` (internal group; the generator forbids a dot in the file name); CI diffs it against
  the committed `docs/api/openapi.v1.json` and fails on a diff. `pnpm gen:api` runs `openapi-typescript` (exact-pinned) into
  `frontend/src/contract/generated/openapi.ts` (git-ignored; `typecheck` depends on it). `Money` is a C# value type
  serialised as the 2-dp string with a schema transformer `{ type: string, pattern: '^-?(0|[1-9][0-9]{0,15})\.[0-9]{2}$' }`
  (= `Money.TryParse`); enums serialise as their exact contract strings (`JsonStringEnumConverter` +
  `[JsonStringEnumMemberName]`, verified on net10, no custom converter). Serialization follows the contract and the document is not
  rewritten: a `required` member is always written (null as `null`) and stays required (`T | null` when nullable); any
  other nullable member is omitted when null (not required, no `null` in its schema, `?: T`); a member whose null means
  "remove" (absent = unchanged) is `Optional<T>` (not required, `?: T | null`: type `[null, T]` for a primitive, `oneOf [null, T]`
  for an enum, object or `$ref`). The omitted-when-null rule is one function used by the serializer and the schema, for value types,
  enums, `Money`, objects and positional-record defaults alike. An explicit `null` in a request for a `?: T` member is accepted as
  absent. `Optional<T>` on a `required` member is refused (the type info throws at first use).
- **Conformance:** `frontend/src/contract/conformance/platform.ts`:

```ts
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
// one line per route: frozen response / request vs the generated operation types, e.g.
type _me = Assert<Same<Me, Gen.paths['/me']['get']['responses'][200]['content']['application/json']>>;
```
  plus a vitest (routes go live one by one): documented path + method set ⊆ the module's `ROUTES`, `LIVE_ROUTES` ⊆ documented,
  and every documented route has an uncommented conformance line. No normaliser type exists or is needed.
  Errors: `ThrowOnBadRequest = true` in every environment; a malformed body, a binding failure and a wrong Content-Type (415)
  all render 422 `record.invalid` (the frozen table has no 400 / 415 code). `TeasException` may pick the registry row's
  alternative status (`connect.key_revoked` 409). The first route that can emit `money.out_of_range` adds it to its module
  contract (ADR + version).

## 5. Frozen contract — `frontend/src/contract/platform.ts` (CONTRACT_VERSION `1.0`)

### 5.1 Types

Moved verbatim from the mock (names unchanged): `Actor`, `ApiProblem`, `Page<T>`, `Company`, `CompanySettings`,
`StaffMember` (internal: never on the wire), `UserRow`, `RoleRow`, `AuditEntry`, `SessionState`, `LoginResult`,
`ProfileView`, `SessionRow`, `KeyKind`, `KeyStatus`, `ApiKeyRow`, `ApiKeysView`, `ApiKeyCreated`, `ApiKeyBody`.

Deltas from the mock (P0 makes the mock conform):

```ts
export interface Membership { companyId: string; companyName: string; roleId: string; roleName: string } // was role: Role
export interface Me { userId: string; displayName: string; memberships: Membership[];
  activeCompanyId: string | null;            // null = no membership yet (bootstrap admin) → /onboarding
  vatRegistered: boolean; permissions: string[]; businessDate: IsoDate }
export interface LinkInfo { kind: 'invite' | 'reset'; email: string; companyName?: string; expiresAt: string; existingAccount: boolean } // existingAccount: sign in to accept, no password form (§4.4)
export interface SetPasswordBody { password: string; confirm: string }
export interface WhoAmI { actor: Actor; companyId: string; companyName: string; rights: string[] }
export type CompanySection = 'identity' | 'contact' | 'payroll' | 'fiscal' | 'images' | 'notes';
export interface CompanyIdentityBody { version: number; confirm: true; legalNameTh: string; legalNameEn?: string; taxId: string;
  branchCode: string; registrationNo?: string; address: string; paidUpCapital?: Money }
export interface CompanyContactBody { version: number; tradeName?: string; phone?: string; email?: string; website?: string }
export interface CompanyPayrollBody { version: number; ssoEmployerAccountNo?: string }
export interface CompanyFiscalBody { version: number; fiscalYearStartMonth: number }
export interface CompanyImagesBody { version: number; logoDataUrl?: string | null; stampDataUrl?: string | null } // absent = keep, '' / null = remove
export interface CompanyNotesBody { version: number; defaultNotes: Partial<Record<DocType, string>> }
export interface InviteBody { name: string; email: string; roleId: string; position?: string }
export interface UpdateMemberBody { version: number; name?: string; roleId?: string; position?: string; signatureDataUrl?: string | null }
export interface RoleBody { name: string; description?: string; permissions: string[] }
export interface UpdateRoleBody extends Partial<RoleBody> { version: number }
export const PERMISSION_CODES: readonly string[];                        // = catalog (§4.5)
export const SYSTEM_ROLES: Record<'operator' | 'accountant' | 'admin', readonly string[]>;
export const agentForbidden: (code: string) => boolean;                  // §4.5
```
`AuditEntry` gains `idempotencyKey?: string`. `ApiKeyRow` unchanged (no hash, no secret ever).

### 5.2 Error codes (registry; HTTP status)

`auth.invalid_credentials` 401 · `auth.locked` 429 · `auth.challenge_invalid` 401 · `auth.totp_invalid` 401 ·
`auth.session_expired` 401 · `auth.unauthenticated` 401 · `auth.not_expired` 409 · `auth.current_password_invalid` 422 ·
`auth.password_mismatch` 422 · `auth.password_weak` 422 · `auth.password_reuse` 422 · `auth.enrol_not_started` 409 ·
`auth.session_not_found` 404 · `auth.link_invalid` 404 (new) · `auth.forbidden` 403 · `company.not_found` 404 ·
`company.section_unknown` 404 · `company.confirm_required` 422 · `company.vat_readonly` 422 ·
`company.fiscal_year_unsupported` 422 · `company.fiscal_year_locked` 409 · `record.invalid` 422 (+ `fieldErrors`) ·
`record.not_found` 404 · `record.version_conflict` 409 · `user.last_admin` 409 · `user.inactive` 409 ·
`role.system_readonly` 409 · `role.in_use` 409 · `connect.not_member` 403 · `connect.scope_forbidden` 422 ·
`connect.scope_exceeds` 422 · `connect.key_revoked` 401/409 (auth / rotate) · `connect.key_expired` 401/409 ·
`connect.key_invalid` 401 · `connect.owner_inactive` 409 · `connect.key_kind_mismatch` 403 (new) ·
`agent.forbidden_action` 403 · `agent.forbidden_setting` 403 · `idempotency.key_required` 400 (new) ·
`idempotency.key_reused` 422 (new) · `http.rate_limited` 429 (new) · `storage.full` 507 · `http.500`. Added in P0a: `http.403` 403 (CSRF, S7) · `user.invite_pending` 409 (reset link for a
member who has not accepted the invite) · `connect.wrong_company` 403 (a key used on another company: the mock's code, kept). Added in P0c: `user.cross_company` 403 (reset-link / totp-reset on a user who is also a member of a company the issuer does not manage).
Retired with the mock: `user.not_pending`, `record.kind_unknown` (SP4.2 reclaims it), `mock.server_error`.

### 5.3 Routes (`ROUTES`; BFF path `/bff/v1` + path → API `/internal/v1` + path)

Agent column: "no" means the route is not mapped on `/api/v1` / `/mcp`; an agent reaching it anyway gets 403
`agent.forbidden_setting` for `/settings/*` and `agent.forbidden_action` for everything else (mock `agentGate`).

| # | Method · path | Auth | Permission | Agent | Idem / conc. | Request → response | Errors (besides 401 / 403 / rate) | Audit | Task |
|---|---|---|---|---|---|---|---|---|---|
| 1 | POST `/auth/login` | public | — | no | — | `{email,password}` → `LoginResult` | invalid_credentials, locked | `auth.login` + auth_events | P7 |
| 2 | POST `/auth/totp` | public | — | no | — | `{challenge, code \| recoveryCode}` → `{status:'ok'}` | challenge_invalid, totp_invalid, locked | `auth.login` | P7 |
| 3 | GET `/auth/session` | public | — | no | — | → `{state, email?, expiresInSec?}` (email only for a session that is not `out`: active, expiring or expired) | — | — | P7 |
| 4 | POST `/auth/session/extend` | session (active / expiring) | — | no | — | → `{state:'active'}` | session_expired, unauthenticated | — | P7 |
| 5 | POST `/auth/logout` | public | — | no | — | → `{state:'out'}` | — | `auth.logout` | P7 |
| 6 | POST `/auth/relogin` | session-or-expired (expired only) | — | no | — | `{password, code?, recoveryCode?}` → `{status:'ok'\|'totp_required'}` | unauthenticated, not_expired, invalid_credentials, totp_invalid, locked | `auth.login` | P7 |
| 7 | GET `/auth/profile` | session | — | no | — | → `ProfileView` | — | — | P7 |
| 8 | POST `/auth/password` | session | — | no | — | `{current,next,confirm}` → `{status:'ok'}` | current_password_invalid, password_mismatch, password_weak, password_reuse, locked | `auth.password.change` | P7 |
| 9 | POST `/auth/totp/enrol` | session | — | no | — | → `{secret, uri}` | — | `auth.totp.enrol_start` | P7 |
| 10 | POST `/auth/totp/enrol/verify` | session | — | no | — | `{code}` → `{recoveryCodes}` | enrol_not_started, totp_invalid | `auth.totp.enable` | P7 |
| 11 | GET `/auth/sessions` | session | — | no | — | → `{items: SessionRow[]}` | — | — | P7 |
| 12 | POST `/auth/sessions/{id}/revoke` | session | own sessions | no | — | → `{signedOut}` | session_not_found | `auth.session.revoke` | P7 |
| 13 | GET `/auth/links/{token}` | public | — | no | — | → `LinkInfo` | link_invalid | — | P7 |
| 14 | POST `/auth/links/{token}` | public (an existing-account invite needs the signed-in user, §4.4) | — | no | — | `SetPasswordBody` (ignored for an existing account) → `{status:'ok'}` | link_invalid, password_mismatch, password_weak | `user.accept_invite` / `auth.password.reset` | P7 |
| 15 | GET `/me` | session | — | no | — | → `Me` | — | — | P8 |
| 16 | POST `/me/active-company` | session | member of target | no | — | `{companyId}` → `Me` | company.not_found | `company.switch` | P8 |
| 17 | GET `/settings/companies/{id}` | session | `settings.manage` | no | — | → `CompanySettings` | company.not_found | — | P8 |
| 18 | PUT `/settings/companies/{id}/{section}` | session | `settings.manage` | no | — / version-body | `Company<Section>Body` → `CompanySettings` | not_found, section_unknown, confirm_required, vat_readonly, fiscal_year_unsupported, fiscal_year_locked, record.invalid, version_conflict | `company.update.<section>` | P8 |
| 19 | GET `/settings/default-notes` | session | any member | yes (GET) | — | → `Partial<Record<DocType,string>>` | — | — | P8 |
| 20 | GET `/settings/users` | session | `users.manage` | no | — | → `{items: UserRow[]}` | — | — | P8 |
| 21 | POST `/settings/users` | session | `users.manage` | no | — | `InviteBody` → `UserRow & {link}` (201; the only response with the link) | record.invalid | `user.invite` | P8 |
| 22 | PUT `/settings/users/{id}` | session | `users.manage` | no | — / version-body | `UpdateMemberBody` → `UserRow` | not_found, last_admin, record.invalid, version_conflict | `user.update` | P8 |
| 23 | POST `/settings/users/{id}/active` | session | `users.manage` | no | — / version-body | `{active, version}` → `UserRow` | not_found, last_admin, version_conflict | `user.activate` / `user.deactivate` | P8 |
| 24 | POST `/settings/users/{id}/reset-link` | session | `users.manage` | no | — | → `{link}` | not_found, user.inactive, user.invite_pending, user.cross_company | `user.reset_link` | P8 |
| 25 | POST `/settings/users/{id}/totp-reset` (Q3) | session | `users.manage`, not self | no | — / version-body | `{version}` → `UserRow` | not_found, version_conflict, user.cross_company | `user.totp_reset` | P8 |
| 26 | GET `/settings/roles` | session | `users.manage` | no | — | → `{items: RoleRow[]}` | — | — | P8 |
| 27 | POST `/settings/roles` | session | `users.manage` | no | — | `RoleBody` → `RoleRow` (201) | record.invalid | `role.create` | P8 |
| 28 | PUT `/settings/roles/{id}` | session | `users.manage` | no | — / version-body | `UpdateRoleBody` → `RoleRow` | system_readonly, not_found, last_admin, record.invalid, version_conflict | `role.update` | P8 |
| 29 | DELETE `/settings/roles/{id}?version=` | session | `users.manage` | no | — / version-query (new) | → `{ok:true}` | system_readonly, in_use, not_found, version_conflict | `role.delete` | P8 |
| 30 | GET `/connect/keys` | session | member (own); `connect.manage` (all) | no | — | → `ApiKeysView` (`scopeChoices` = own rights − forbidden) | — | — | P9 |
| 31 | POST `/connect/keys` | session | active member | no | — | `ApiKeyBody` → `ApiKeyCreated` (201) | not_member, record.invalid, scope_forbidden, scope_exceeds | `connect.key.create` | P9 |
| 32 | POST `/connect/keys/{id}/rotate` | session | the key's owner only | no | — / version-body | `{version}` → `ApiKeyCreated` (201) | not_found, version_conflict, key_revoked, key_expired, owner_inactive | `connect.key.rotate` + `connect.key.revoke` | P9 |
| 33 | POST `/connect/keys/{id}/revoke` | session | owner, or `connect.manage` | no | — / version-body | `{version}` → `ApiKeyRow` (already revoked: no write, no audit) | not_found, version_conflict | `connect.key.revoke` | P9 |
| 34 | GET `/api/v1/whoami` (machine; MCP tool `whoami`) | key | — | yes | — | → `WhoAmI` | key_invalid, key_revoked, key_expired, key_kind_mismatch | — | P9 |
| 35 | GET `/health/live`, `/health/ready`, `/version` (not under `/bff`) | public | — | — | — | `/ready`: DB + schema version + catalog counts; `/version`: build stamp | — | — | P1 / P2 |

Mock routes removed: `GET /auth/demo`, `POST /settings/users/{id}/accept`, `/mock/*`.

## 6. Security invariants (each one is a named test)

| # | Invariant | Test (task) |
|---|---|---|
| S1 | No secret is stored in clear: password and recovery codes (PasswordHasher), session token, link token, login challenge, API key secret (SHA-256), TOTP secret (encrypted). A DB dump of the test DB after every flow contains none of the plaintexts | `SecretsAtRestTests` (P7, P9) |
| S2 | Each secret is on the wire once: API key secret (create / rotate), recovery codes (enrol verify), invite / reset link (invite / reset-link), TOTP secret (enrol start). No GET, list, audit row, log line or activity contains it (log capture asserted) | `SecretOnceTests` (P7, P8, P9) |
| S3 | Login failure never names the field: unknown email = wrong password (status, code, title); a dummy hash runs for unknown emails | `LoginGenericErrorTests` (P7) |
| S4 | 5 consecutive failures → 429 `auth.locked` for 15 min, across login / TOTP / relogin / current-password; success resets; unknown emails count too | `LockoutTests` (P7) |
| S5 | TOTP: RFC 6238 Appendix B vectors pass; ±1 step accepted, ±2 refused; a used step refused; a recovery code works once | `TotpTests` (P7) |
| S6 | Session: cookie flags; new token on login and relogin; logout and revoke end it at once; password change revokes every other session; extend refuses expired / out; relogin only from expired, same user, second factor when enrolled; `GET /auth/session` names nobody when out | `SessionTests` (P7) |
| S7 | CSRF: a mutating BFF request without JSON content type or with a foreign `Origin` → 403 | `proxy.test.ts` (P10) |
| S8 | Internal surface: `/internal/v1/*` without the BFF secret → 401; through the public domain it is not routed | `BffSecretTests` (P2), deploy probe (P11) |
| S9 | Tenant isolation: as `teas_app`, company B's rows are invisible under company A (every tenant table, generated per table), a write with another `company_id` fails WITH CHECK, a no-GUC read returns 0 rows; HTTP: another company's id → 404 | `RlsTests` (P2), per-route (P8, P9) |
| S10 | Agent choke point: every non-`agent` route is absent from `/api/v1` and `/mcp`; the runtime check refuses before body binding (a malformed body still gives 403, never 422); `x-teas-actor` has no effect | `AgentSurfaceTests` (P9) |
| S11 | Key scopes: create refuses forbidden (`connect.scope_forbidden`) and > owner rights (`connect.scope_exceeds`); at use rights = scopes ∩ owner's current rights − forbidden: demote / deactivate the owner → the key loses the rights on the next request; rotate is owner-only (the manager gets 404) and revokes the old key in the same transaction; rotate of a revoked / expired key or of an inactive owner's key is refused | `KeyScopeTests` (P9) |
| S12 | §8.5 widened (ADR-0005): no key can ever hold an `AgentForbidden` code; the catalog flag and `agentForbidden()` in TS agree | `AgentForbiddenTests` (P5, frontend vitest P0) |
| S13 | Public links (rules frozen here, built in SP4.2): only types QT SO DO IV TI BL RC CN DN PO WT; only a live document (issued / partly settled / settled); token ≥ 160 bits random, stored hashed; unknown, revoked and no-longer-live give one identical 404 `public.link_invalid`; the page is the document's frozen paper as a copy, sessionless, no other company data; create / revoke need `doc.<T>.read` of THAT type; agents refused; rate-limited per IP | SP4.2 spec copies this row |
| S14 | Audit: append-only (UPDATE / DELETE / TRUNCATE raise, even as `teas_migrator`); written in the command transaction (a rolled-back command leaves no row); refused 403s leave one `rejected` row (exception: a refusal with no company scope, e.g. a user with no membership yet, writes no audit row: there is no company to attribute it to) | `AuditTests` (P4) |
| S15 | Last admin: no sequence of member edit, deactivation, role edit or self-action leaves a company without an active, accepted `users.manage` member; a pending invite never counts | `LastAdminTests` (P8) |
| S16 | Startup refuses a superuser / BYPASSRLS role, a schema mismatch and a failed RLS self-test | `StartupGuardTests` (P2) |
| S17 | Lost update: two concurrent PUTs with the same `version` → exactly one 200 and one 409 (barrier-synchronised, real parallel connections) | `ConcurrencyTests` (P4, P8) |

## 7. Guards and their exits

| Guard | State when it fires | Exit in the app (no DBA) |
|---|---|---|
| `auth.locked` | 5 failures on an email | wait 15 min; or an admin reset link → setting a password clears the counter |
| `user.last_admin` | the change would leave no admin | invite another admin, they accept the link, then retry |
| `role.in_use` / `role.system_readonly` | role assigned / system role | move members to another role / copy as a new role |
| rotate refused (revoked, expired, owner inactive) | key unusable | create a new key (an active member) |
| `auth.not_expired` (relogin) | session still alive | keep working |
| second factor lost + recovery codes used up | cannot sign in | an admin runs `totp-reset` (route 25); the last admin: operator CLI `reset-mfa` (Q3) |
| password forgotten | cannot sign in | admin reset link (route 24); the last admin: operator CLI `reset-password` |
| invite pre-claimed by an admin (email had no account; no email is sent) | the real owner cannot set their own password | KNOWN LIMITATION: operator CLI `reset-password --email` after out-of-band identity check; writes `auth_events`, prints a one-time reset link (§4.4) |
| `user.cross_company` | reset-link / totp-reset on a user who is also a member of a company the issuer does not manage | server operator CLI `reset-password --email` / `reset-mfa` after identity verification out of band | A stray invite of the email by another company also triggers it (the safe direction): the exit is that company deactivating the invite, or the operator CLI.
| Data-protection key ring lost | TOTP secrets undecryptable | recovery codes (hashed, independent of the key ring) sign in, then re-enrol; else admin `totp-reset` |
| member deactivated in their active company | `Me.permissions = []` | switch company (the switcher lists active memberships only); none left = removed by design |
| `idempotency.key_reused` | client reused a key with a new body | send a new key |
| `record.version_conflict` | stale form | reload and re-apply |
| session expired | 401 on every call | relogin dialog keeps the page and the autosaved draft (HC3 ruling 3) |

## 8. Deploy probe (staging, then prod) — row counts, not exit codes

1. Migrator: `SELECT count(*) FROM teas.permissions` = catalog size (printed by the migrator); `role_templates` = Σ
   template sizes; `__EFMigrationsHistory` last id = build's.
2. API `/health/ready` through the **public domain** returns `{ db: 'ok', schema: '<id>', catalog: { permissions: N,
   roleTemplates: M } }` equal to step 1.
3. As `teas_app` via `psql`: `SELECT count(*) FROM teas.companies;` → 0 (no GUC); `SELECT rolsuper, rolbypassrls FROM
   pg_roles WHERE rolname = 'teas_app'` → `f, f`.
4. Public domain: `GET /bff/v1/auth/session` → 200 `{"state":"out"}`; `GET /internal/v1/me` → not routed (404 from the
   proxy); `GET /api/v1/whoami` without a key → 401 `connect.key_invalid`.
5. Staging only: bootstrap admin link → set password → login → `/bff/v1/me` returns the user; audit has `auth.login`.

## 9. Definition of Done (SP0 §11.5)

- [ ] Descriptors complete: lifecycle, every guard has an exit, correction policy — n/a (no document types); §7 exits table implemented and tested
- [ ] Date model and period gate applied — `BusinessDate` / `TimeProvider` only (banned-API analyzer green); period gate n/a
- [ ] Permissions in the catalog; frontend gating; MCP tools and agent-policy defaults — catalog + role templates synced; `whoami` tool; agent policy n/a (SP4.10)
- [ ] Error codes registered in Thai and English (§5.2)
- [ ] Every screen state implemented (loading, empty, error, forbidden, locked; VAT and non-VAT) — existing mock screens unchanged; new set-password page (Q4) has its states
- [ ] Screen = paper for every document — n/a
- [ ] Opening-balance support where the module holds balances — n/a
- [ ] Tests: domain unit, integration as `teas_app`, blind acceptance (money), e2e, golden fixtures (tax), RBAC — unit + integration as `teas_app` + RBAC matrix + e2e (platform screens in hybrid mode); blind acceptance and golden fixtures n/a (no money / tax)
- [ ] Generated docs updated (OpenAPI, MCP catalog, permission map) — `docs/api/openapi.v1.json`, MCP tool list, `permissions.json`
- [ ] Shipped screens match the approved mockups — login, TOTP, profile, settings users / roles / company, TEAS Connect keys in hybrid mode vs the SP1c screenshots
- [ ] Parity checklist items ticked — platform rows of `docs/specs/SP1c-parity-checklist.md` (login, TOTP, multi-company switching, session keep-alive, TH / EN, self password change, TOTP enrolment, session list / revoke, API keys)
- [ ] Every §6 invariant has its named test; §8 probe passes on staging

## 10. Verification gates (exact commands; each is CREATED by the task named, none exists today)

Today the only CI is `.github/workflows/frontend.yml` (layout + web jobs). From PowerShell (no `&&`), each line alone:

| Gate | Command | Created by |
|---|---|---|
| backend build | `dotnet build backend/Teas.sln -c Release -warnaserror` | P1 |
| unit | `dotnet test backend/tests/Teas.Domain.Tests -c Release` | P1 |
| architecture | `dotnet test backend/tests/Teas.Architecture.Tests -c Release` | P1 (grows per task) |
| integration (needs `$env:TEAS_TEST_ADMIN_CS` and `$env:TEAS_TEST_APP_CS` to the local PG 18) | `dotnet test backend/tests/Teas.Integration.Tests -c Release` · focused: `--filter "FullyQualifiedName~Rls"` | P2 |
| OpenAPI current | `dotnet build backend/src/Teas.Api -c Release` then `git diff --exit-code docs/api/openapi.v1.json` | P3 |
| frontend | `corepack pnpm gen:api` · `corepack pnpm typecheck` · `corepack pnpm lint` · `corepack pnpm test` · `corepack pnpm e2e` (from `frontend/`) | existing; `gen:api` by P3 |
| contract freeze | `node tools/check-contract-freeze.mjs` | master plan C0 |
| CI | `.github/workflows/backend.yml` (build, unit, architecture, integration with a `postgres:18` service, OpenAPI diff), `compose` job (migrator → api → web smoke) | P1, P2, P3, P10 |

The orchestrator runs the full suites (Tier 1 rule); a worker reports build + focused evidence.

## 11. Tasks

Order: P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9 → P10 → P11. P0 is frontend-only and may run beside P1
(different build systems, no shared DB). From P2 on every task runs integration tests on the shared local DB —
sequential only.

### Task P0: Freeze the platform contract (frontend; master plan C1)

**Depends on:** master plan C0; Ham approves this spec. **Blast cap:** 22 files; API changes: §5 deltas only.
**Files:** Create `frontend/src/contract/platform.ts`, `frontend/src/contract/live-routes.ts` (empty list),
`frontend/src/contract/platform.contract.test.ts`, `frontend/src/app/(auth)/link/[token]/page.tsx` (set-password page,
Q4) + test. Modify `domain/types.ts`, `records/auth.ts`, `records/connect.ts` (re-export from the contract),
`lib/api/endpoints.ts` (typed bodies; `deleteRole(id, version)`; `linkInfo`, `setPassword`, `totpReset`), mock
`handlers/me.ts` (`Membership.roleId/roleName`, nullable `activeCompanyId` path), `handlers/auth.ts` (link routes),
`handlers/settings.ts` (role DELETE `?version=`, `totp-reset`), `mocks/records/roles.ts`, `mocks/records/users.ts`,
`app-shell/CompanySwitcher.tsx` (role name), `kit/settings/PeopleRoles.tsx` (totp-reset action, delete version),
messages `th.json` / `en.json` (new codes, `screens.name.*` gaps — backlog B-5), `app/mock/screens/screens.ts` (new page).
`frontend/src/contract/FROZEN.json` entry is added by the controller after review.
**Rules:** move types, do not retype them; old import paths keep working through re-exports. `ROUTES` = §5.3 rows 1–34
exactly. The set-password page follows the existing auth pages (no shell, axe clean, loading / error / invalid-link
states). `PERMISSION_CODES` / `SYSTEM_ROLES` / `agentForbidden` move from the mock into the contract and the mock
imports them.
**P0a (Opus review of P0, orchestrator rulings 2026-10-27):** existing-account invites (§4.4), links die with the member,
stored expiry, reset revokes sessions, a table-driven test over `ROUTES` (agent / auth / permission per row; the mock's
agent gate follows `ROUTES.agent` on platform paths), `IsoDate` / `Money` moved to `contract/scalars.ts`,
`LIVE_ROUTES: { method, path }[]`. **Freeze guard (C0):** it hashes `contract/platform.ts` AND every local file it
imports: `route-spec.ts`, `scalars.ts`, and `DocType` from `domain/types.ts` (listed as a guarded dependency until
`documents.ts` owns it).
- [x] **Step 1: Failing tests** — every `ROUTES` entry has an MSW handler and every MSW handler under `/auth`, `/me`,
  `/settings/companies`, `/settings/users`, `/settings/roles`, `/settings/default-notes`, `/connect/keys` has a `ROUTES`
  entry (parse `handler.info.method` / `.path`); `PERMISSION_CODES` = the `th.json#permissions` keys; every code in
  `SYSTEM_ROLES` is in the catalog; `agentForbidden` = §4.5; `Membership` carries `roleName` for a custom role; every
  `screens.ts` name key exists in both message files; set-password page: invalid link → the one Thai message.
  e2e: `/link/<fixture-token>` sets a password; axe clean.
- [x] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS. Step 5:** `corepack pnpm typecheck`, `lint`, focused
  `test`, `e2e platform shell screens --workers=1` (nothing on :3100 first). Controller runs the full unit suite.
- [x] **Step 6: Controller commits** `feat(contract): freeze the platform contract v1.0`, then the `FROZEN.json` entry.
  **Contract frozen: platform 1.0** (C0 guard `tools/check-contract-freeze.mjs`; `FROZEN.json` sha256 `0e97e488...` over `platform.ts` + `route-spec.ts` + `scalars.ts` + `DocType` in `domain/types.ts`); commit: the C0 commit on `feat/sp3-platform` (ADR-0003).

### Task P1: Backend scaffold and CI

**Depends on:** — (may run beside P0). **Blast cap:** 24 files under `backend/**` + `.github/workflows/backend.yml` + `.gitignore`.
**Files:** `backend/global.json`, `Teas.sln`, `Directory.Build.props` (nullable, warnings as errors, analyzers),
`Directory.Packages.props`, `BannedSymbols.txt`, `.editorconfig`, the four `src` and three `tests` projects (§4.1),
`src/Teas.Api/Program.cs` (`/health/live`, `/version` from `TEAS_VERSION`), `src/Teas.Domain/Money.cs` (+ JSON
converter, 2-dp string, half away from zero), `src/Teas.Domain/BusinessDate.cs`, `.github/workflows/backend.yml`.
**Rules:** exact package versions (each task pins the packages it first uses); `TimeProvider` only (§4.7 Clock); architecture tests: banned APIs enforced, no source
file > 600 lines without `// size-reason:` on line 1.
- [ ] **Step 1: Failing tests** — `Money` round-trips `"64200.00"`, refuses `64200` (number) and `"1.005"`; rounding
  half away from zero; `BusinessDate` at 2026-10-27T17:30Z is 2026-10-28 (Bangkok); a planted `DateTime.Now` fails the
  build (analyzer test project); `/health/live` 200.
- [ ] **Steps 2–5** as P0, gates: backend build, unit, architecture. **Step 6: Controller commits**
  `feat(backend): solution scaffold, money, business date and CI`.

### Task P2: Roles, migrator, RLS harness, TenantScope, startup guards

**Depends on:** P1. **Blast cap:** 26 files. **Tier 2:** Opus review (schema / security).
**Files:** `deploy/db/bootstrap-roles.sql`, `tools/db/setup-local.ps1` (runs it against `S:\Program Files\PostgreSQL\18`
as `postgres`, creates `teas_dev` owned by `teas_migrator`), `src/Teas.Migrator/**` (Program with verbs, `RlsSql.cs`,
`rls-allowlist.txt`, migration `0001_platform_base`: schema, helper functions, `companies`, `company_members`, `users`,
`sessions`, `audit_log` + triggers, grants incl. F7), `src/Teas.App/Platform/TenantScope.cs` + interceptor,
`src/Teas.App/TeasDbContext.cs`, `src/Teas.Api/Startup/StartupGuards.cs`, `/health/ready`, internal-group BFF-secret
filter, `tests/Teas.Integration.Tests/Harness/**` (template DB, per-class clone, role assertion), `RlsTests`,
`StartupGuardTests`, `BffSecretTests`, architecture tests (allow-list, `set_config` grep, `EnterSystem` call sites).
**Rules:** §4.2, §4.3 exactly; the policy text is the fragment in §4.2; F1–F7. The S9 test is generated over every
non-allow-listed table, so P2 ships `TenantRowFactory` (test project) with one method per tenant table that inserts a
valid row with its foreign keys for a given company; a tenant table without a factory method fails the generated test
(every later task that adds a tenant table adds its factory method).
- [x] **Step 1: Failing tests** (done 2026-10-27; mutation-checked, see task-P2-report.md) — S8 (secret header), S9 (two companies; read / write / no-GUC per tenant table,
  generated from the allow-list complement), S16 (start as a role with BYPASSRLS → refuses; wrong schema → refuses);
  allow-list test fails when a new table lacks RLS (feed it a throwaway table in the test); `ForEachCompany` updates
  rows in two companies and a plain `UPDATE` under the migrator role updates 0 (documents F5).
- [~] **Steps 2–5**, gates: build, architecture, integration. (worker: all green on a scratch PG 18 at port 5433; NOT yet run on the dev box PG at 5432, which needs the postgres password; step 6 is the controller) **Step 6: Controller commits**
  `feat(platform): roles, migrator, row-level security harness and startup guards`.

### Task P3: Error contract and the OpenAPI → TypeScript pipeline

**Depends on:** P2. **Blast cap:** 18 files.
**Files:** `src/Teas.Domain/ErrorCodes.cs` (§5.2), `src/Teas.Api/Problems/**`, `src/Teas.Api/OpenApi/**` (Money and
enum transformers), `src/Teas.Api/Routing/RouteSpec.cs` (builder + metadata; §4.6), `backend/artifacts/` (git-ignored),
`docs/api/openapi.v1.json`, `frontend/package.json` (`openapi-typescript` exact, `gen:api` script, `typecheck` runs it
first), `frontend/.gitignore` (`src/contract/generated/`), `frontend/src/contract/conformance/platform.ts`,
`frontend/src/contract/conformance/routes.test.ts`, CI OpenAPI-diff step.
**Rules:** §4.7 Errors, §4.8 OpenAPI / conformance; a conformance line is added for each route as its task makes it live.
- [x] **Step 1: Failing tests** — every registry code has th + en titles (the registry test lists `money.out_of_range` → 422, thrown by `Money.Of`); an unregistered code literal in source fails
  the architecture test; a thrown `TeasException` renders `ApiProblem` with `traceId`; `Money` appears in OpenAPI as the
  pattern string; a deliberately wrong DTO (`Money` as number) makes `pnpm typecheck` fail through the conformance file
  (prove with a scratch DTO in the test project, then remove).
- [x] **Steps 2–5** (worker done 2026-10-27, see task-P3-report.md), gates: build, unit, architecture, OpenAPI diff, `gen:api` + `typecheck`. **Step 6: Controller
  commits** `feat(platform): error contract and OpenAPI to TypeScript conformance`.

### Task P4: Idempotency, concurrency and audit primitives

**Depends on:** P3. **Blast cap:** 16 files. **Tier 2:** Opus review.
**Files:** migration `0002_idempotency_audit` (`idempotency_records`, `auth_events` + triggers),
`src/Teas.App/Platform/Idempotency/**`, `src/Teas.App/Platform/Concurrency/VersionedUpdate.cs`,
`src/Teas.App/Platform/Audit/**`, a test-only command endpoint (registered only in the test host) to exercise them,
`AuditTests`, `IdempotencyTests`, `ConcurrencyTests`.
**Rules:** §4.7 Idempotency / Concurrency / Audit; S14, S17. Never `ROLLBACK TO SAVEPOINT` a savepoint taken inside a `TenantScope` after leaving that scope (GUCs follow savepoints); re-enter the scope after any manual savepoint rollback (P2 review R3-2).
- [x] **Step 1: Failing tests** — same key twice (sequential) → one effect, identical replay; same key twice
  (parallel, barrier) → one effect; same key, different body → 422 `idempotency.key_reused`; missing key → 400; a
  command that throws after the claim leaves no idempotency row and no audit row; two parallel updates at the same
  version → one 200 one 409; UPDATE / DELETE / TRUNCATE on `audit_log` raise as `teas_app` and as `teas_migrator`; a 403
  writes one `rejected` row.
- [x] **Steps 2–5** (worker done 2026-10-27, see task-P4-report.md; review fixes P4a, see task-P4a-report.md), gates: build, architecture, integration. **Step 6: Controller commits**
  `feat(platform): idempotency, versioned updates and append-only audit`.

### Task P5: Permission catalog, route metadata enforcement, RBAC matrix

**Depends on:** P4. **Blast cap:** 14 files.
**Files:** `src/Teas.Domain/Platform/PermissionCatalog.cs`, `AgentRules.cs`, migrator catalog sync, migration
`0003_catalog` (`permissions`, `role_templates`, `custom_roles`), `src/Teas.App/Platform/Rights/**` (effective rights,
cache), `src/Teas.Api/Routing/Authorization.cs`, `backend/artifacts/permissions.json` export, `RbacMatrixTests`
(generated: every registered route × the three system roles + a custom role → 403 iff the right is missing; 403 detail
names the permission), `frontend/src/contract/permissions.backend.test.ts` (set-equality with `permissions.json`).
**Rules:** §4.5; every route declares exactly one of `public` / `session` / a permission (an undeclared route fails the
architecture test). Permission and agent refusals are decided before `IdempotencyRunner.RunAsync` and inside the company scope: `IAudit.RecordRejectedAsync` refuses to run inside an open transaction and needs a company scope (P4 review #7).
- [x] **Step 1: Failing tests** (done 2026-10-27; mutation-checked, see task-P5-report.md) — catalog = frozen codes; templates = frozen `SYSTEM_ROLES`; `AgentForbidden` matches
  the TS rule on every code; migrator sync is idempotent (run twice → same counts) and deletes a code removed from the
  catalog; RBAC matrix.
- [x] **Steps 2–5** (worker done 2026-10-27, see task-P5-report.md), gates: build, architecture, integration, frontend focused test. **Step 6: Controller commits**
  `feat(platform): permission catalog, role templates and the RBAC matrix`.

### Task P6: File store and job platform

**Depends on:** P5. **Blast cap:** 14 files.
**Files:** migration `0004_files_jobs`, `src/Teas.App/Platform/Files/**`, `src/Teas.App/Platform/Jobs/**`
(leader, poller, claim, retry), `IdempotencyCleanupJob`, tests.
**Rules:** §4.7 Files / Jobs, §4.3 job rows.
- [x] **Step 1: Failing tests** (done 2026-10-27; red = missing types, then green + mutation-checked, see task-P6-report.md) — PNG / JPEG / WebP accepted by magic bytes, SVG and a PNG renamed `.svg` with wrong
  bytes refused, > 1 MB refused; a file of company A cannot be opened under company B; two runner instances → one
  leader; a job claimed twice runs once; a failing job retries 3 times then `failed` with its error; cleanup deletes
  records older than 7 days in two companies and keeps newer ones (`FakeTimeProvider`).
- [x] **Steps 2–5** (worker done 2026-10-27: build -warnaserror 0/0, Integration 131/131 twice, Architecture 25/25, Domain 43/43, OpenAPI identical, freeze + layout ok; see task-P6-report.md), gates as P4. **Step 6: Controller commits** `feat(platform): file store and job runner`.

### Task P7: Auth, sessions, TOTP, links, bootstrap CLI

**Depends on:** P6; ADR-0004 accepted (Q1, Q2, Q4, Q5 answered). **Blast cap:** 26 files. **Tier 2:** Opus review (security).
**Files:** migration `0005_auth` (`recovery_codes`, `login_challenges`, `auth_failures`, `user_links`, user columns),
`src/Teas.Domain/Platform/Totp.cs`, `src/Teas.App/Platform/Auth/**`, `src/Teas.Api/Endpoints/AuthEndpoints.cs` (routes
1–14), session authentication handler, rate limiter config, Data Protection setup (`TEAS_DP_KEYS_DIR`), migrator verbs
`bootstrap-admin`, `reset-mfa`, `reset-password`, tests S1–S6, conformance lines for routes 1–14.
**Rules:** §4.4; the reset-link issuer is mandatory: a link without a stored issuer is the single 404 (it cannot be re-checked at use); HC3 rulings 1, 3, 4 and the HC3 review items (F12); the auth audit company rule: the session's active
company, else the user's first active membership, else only `auth_events`.
- [x] **Step 1: Failing tests** (done 2026-10-27; red = missing `Totp` / `AuthCli` / `UserLinks` types, then green + mutation-checked, see task-P7-report.md) — S1–S6; relogin keeps nothing of another user; a link works once, a superseded link
  fails, an expired link fails, all with the same 404; bootstrap CLI prints one link and stores only its hash;
  `reset-mfa` clears TOTP + recovery codes and revokes sessions.
- [x] **Steps 2–5** (worker done 2026-10-27: build -warnaserror 0/0, Integration 195/195 twice, Architecture 25/25, Domain 58/58, OpenAPI artifact identical to docs/api/openapi.v1.json, typecheck + lint + vitest 2877, freeze + layout ok; 25 of 26 files; see task-P7-report.md), gates as P4 + conformance. **Step 6: Controller commits**
  `feat(platform): sign-in, sessions, two-step verification and set-password links`.
- **Built as (later tasks rely on it):** `UserLinks.IssueAsync(conn, tx, kind, userId, companyId, memberId, createdBy, now)` issues invite / reset links (P8 calls it inside its transaction); `user_links.created_by` is the issuing user's id or `operator` (the CLI), anything else is the single 404; the use-time issuer check covers an invite (issuer holds `users.manage` in the issuing company) and a reset (issuer holds it in every company of the account); a deactivated member's invite / reset link is refused at use (P8 should still supersede the rows on deactivate). New env: `TEAS_DP_KEYS_DIR` (required outside Development), `TEAS_PUBLIC_URL` (CLI link base, default `http://localhost:3000`; link path `/link/<token>`), `TEAS_AUTH_RATE_LIMIT` (default 20, tests only).

### Task P8: Me, company switch, company settings, users and roles

**Depends on:** P7. **Blast cap:** 20 files. **Tier 2:** Opus review.
**Files:** `src/Teas.App/Platform/Companies/**` (incl. system `CompanyFactory`), `Members/**`, `Roles/**`,
`src/Teas.Api/Endpoints/{Me,CompanySettings,Users,Roles}Endpoints.cs` (routes 15–29), tests, conformance lines.
**Rules:** every write to `company_members` (`role_id`, `active`, `invite_pending`) and `custom_roles` (`permissions`) bumps `version`: the rights cache trusts it (P5 review #8); at link use (route 14 and GET info) also re-check that the issuer still holds `users.manage` in the issuing company (a demoted or deactivated issuer's links die with the single 404); §4.5 (last admin, effective rights); ST1 rulings: identity edit needs `confirm: true`; VAT status read-only
here (`company.vat_readonly`); fiscal start month ≠ 1 → `company.fiscal_year_unsupported` (ADR-0006 interim); images per
§4.7 Files; company sections share `companies.version` (one save bumps it; a stale section save → 409); a refusal writes
nothing; invites create a pending member + an invite link (route 14 accepts it); reset-link refused for an inactive
member; `totp-reset` refused on yourself. `CompanyFactory.Create` runs `TenantScope.Enter(newId, adminUserId)` BEFORE
inserting the `companies` row (its policy is `WITH CHECK (id = teas.current_company())`) and the admin member in the same
transaction; a test asserts both rows exist afterwards (a factory that inserts first would fail WITH CHECK, not no-op).
- [ ] **Step 1: Failing tests** — S15 (all ST1 review probes: role edit removing the last admin, pending invite not
  counted, self-demotion via user and via role edit), S17 on company sections (backlog B-2), `Me` for a user with two
  memberships and a custom role (`roleName`), `Me.activeCompanyId = null` without membership, switch to a company you
  are not an active member of → 404, `company.switch` audited, every write audited with `before` / `after` without
  pictures, agent refused with `agent.forbidden_setting` before the body is read.
- [ ] **Drop the P0 `Me` narrowing:** `domain/types.ts` re-exports `Me` with `activeCompanyId: string` (an exception to
  "old files re-export verbatim", master plan §2.2). P8 removes it, makes `useMe` handle `activeCompanyId === null`
  (`router.replace('/onboarding')`, no company screens mounted); drop the narrowed `Me.activeCompanyId` and handle null (to /onboarding), and fixes the ~100 call sites that then need a string.
- [ ] **Steps 2–5**, gates as P4 + conformance. **Step 6: Controller commits**
  `feat(platform): me, company switch, company settings, users and roles`.

### Task P9: API keys, agent surface, MCP host, tool generator

**Depends on:** P8; ADR-0005 accepted. **Blast cap:** 20 files. **Tier 2:** Opus review (security).
**Files:** migration `0006_api_keys`, `src/Teas.App/Platform/Keys/**`, `src/Teas.Api/Auth/ApiKeyHandler.cs`,
`src/Teas.Api/Endpoints/KeysEndpoints.cs` (routes 30–33), `src/Teas.Api/Machine/**` (`/api/v1` and `/mcp` groups,
`whoami`, tool generator), tests S10–S12, conformance lines.
**Rules:** §4.6, HC2 rulings 1–2 and the HC2 review rounds (member-owned keys; `connect.manage` sees and revokes all;
rotate owner-only; consent / apps / policy are SP4.10). Secret format `teas_<kind>_<48 hex>`, display prefix = first 14
characters.
- [ ] **Step 1: Failing tests** — S10, S11, S12; the tool list equals `agent` + `McpTool` routes; an MCP `whoami` call
  writes no audit row (GETs are not audited) and moves the key's `last_used_at`; a REST key on `/mcp` → 403
  `connect.key_kind_mismatch`.
- [ ] **Steps 2–5**, gates as P4 + conformance. **Step 6: Controller commits**
  `feat(platform): API keys, agent surface and MCP host`.

### Task P10: BFF proxy, live-route switch, compose smoke

**Depends on:** P9. **Blast cap:** 14 files.
**Files:** `frontend/src/proxy.ts` (+ `proxy.test.ts`), `frontend/src/contract/live-routes.ts` (routes 1–33),
`frontend/src/mocks/browser.ts` / handler wrapper (passthrough of live routes in `hybrid`), `kit/auth/TotpEnrol.tsx`
(QR from `uri`; one exact-pinned QR dependency with its reason in the report), `deploy/compose.ci.yml`,
`.github/workflows/backend.yml` `compose` job, `frontend/e2e/platform-live.spec.ts`.
**Rules:** §4.8; S7; `mock` stays the default build (the mockup preview is unchanged). `TEAS_FILES_DIR` is required outside Development, on a persistent volume (P6); so is `TEAS_DP_KEYS_DIR` (P7: without the key ring every restart makes the stored TOTP secrets unreadable). The API sees the BFF's address for every user: the BFF must forward the client IP and the API must trust it only after the BFF-secret check, or the per-IP `/auth/*` limit (20 / min) is one bucket for everybody (P7 open question 1). The production logger must not include request-path scopes, or must redact `/auth/links/` paths (a link token travels in the path).
- [ ] **Step 1: Failing tests** — proxy (`proxy.test.ts` names `POST /auth/links/{token}` explicitly in the cross-site check, JSON content type + Origin, even though route 14 is `auth: public`): strips `x-teas-actor` and a forged `X-Teas-Bff`, adds the secret, refuses a
  cross-origin POST; hybrid e2e on the composed stack (CI): log in, see memberships, switch company, change password,
  enrol TOTP, invite a user and set their password through the link, create / rotate / revoke a key; the rest of the
  app still renders on MSW.
- [ ] **Steps 2–5**, gates: frontend all, compose job in CI. **Step 6: Controller commits**
  `feat(platform): BFF proxy and the live-route switch`.

### Task P11: SP3 gate

- [ ] Consolidated gate (Haiku): §10 table, all green on CI.
- [ ] Tier 2 escalated review (`.claude/workflows/tier2-review.js`, lenses: security, tenancy / RLS, contract
  conformance, audit) — platform is extreme blast radius.
- [ ] Staging deploy + §8 probe through the public domain (Coolify, O-2).
- [ ] DoD §9 ticked with evidence; parity rows ticked; demo to Ham.

## 12. Open questions for Ham

| # | Question | Recommendation |
|---|---|---|
| Q1 | Browser sessions: opaque server-side session (cookie → session row) instead of §10.4's access + refresh tokens (ADR-0004). OAuth clients keep tokens (SP4.10) | Approve |
| Q2 | Session lifetime: idle 60 min, absolute 12 h, warning 2 min before | Approve, or give your numbers |
| Q3 | Lost phone + recovery codes: an admin "reset two-step" for another member (new route 25 and a button on the users page) and a server-operator command for the last admin | Approve |
| Q4 | Invite / reset links need a "set your password" page that the mock never had (S2: mock screen first). Build it in P0 for your screenshot review before the backend | Approve |
| Q5 | First user on a fresh server: created by a server command that prints a one-time link (no self-signup, §1.5) | Approve |
| Q6 | D-04-3: must production data be hosted in Thailand (ม.13 ว.3)? Decides the Coolify server before launch, not SP3 code | Your ruling |
| Q7 | Logo / stamp / signature stay base64 data URLs on the wire (≤ 1 MB, as approved in ST1); the server stores them as files | Approve |
| Q8 | Lockout per email lets anyone lock a known user out for 15 min; keep (as approved in HC3) plus the per-IP limit | Keep |
| Q9 | Agents never approve, cancel or correct any document type (HC2, stricter than §8.5) — record in ADR-0005 | Approve |

**Backlog (SP4.6 jobs):** prune `auth_failures` (rows not locked and older than 24 h) and revoked / absolute-expired `sessions` rows.

## 13. Attempt log

- 2026-10-27 — drafted (opus designer) from SP0, the SP1c mock at 1a79dd8 (handlers auth / connect / settings / me /
  records / common; engines auth, connect, users, roles, company, agent-review, log), the HC2 / HC3 / ST1 briefs and
  Opus reviews, troubles-wiki, and SP-R `DECISIONS.md`. Docs only; nothing built or run.

## Ham rulings 2026-10-27

SP3 approved — contract frozen at `1.0` when task P0 lands. Q1 server-side sessions (ADR-0004), Q2 idle 60 min / absolute 12 h / warning 2 min, Q3 admin "reset two-step" + operator CLI for the last admin, Q4 set-password page built in P0 for Ham screenshot review first, Q5 first user via the server command, Q7 images as data URLs on the wire, Q8 per-email lockout 15 min + per-IP limit, Q9 agents never approve / cancel / correct any type (ADR-0005). **Q6 (D-04-3 Thailand hosting) still open** — decides the server before launch, not SP3 code.
