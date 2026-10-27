# ADR-0004: Browser sessions are opaque server-side sessions

| Date | Status | Deciders |
|---|---|---|
| 2026-10-27 | Accepted | Ham, orchestrator |

## Context
SP0 §10.4 sketched access + refresh tokens for the browser. The approved SP1c mock models something else: a list of
sessions, revoke one, revoke the others on a password change, extend, expiring / expired, and logout that takes effect
at once. Short-lived tokens cannot be revoked instantly without a server-side list anyway.

## Decision
- A browser session is a `sessions` row plus a 256-bit random token in `__Host-teas_session` (HttpOnly, Secure,
  SameSite=Lax; `teas_session` without Secure on dev http). The database keeps only `sha256(token)`. The BFF passes
  `Set-Cookie` / `Cookie` through unchanged (Q1).
- Idle 60 min, absolute 12 h, expiry warning 2 min before; `GET /auth/session` never extends, every other authenticated
  request does, written at most once per 60 s (Q2).
- Lost second factor: an admin resets another member's two-step; the last admin's exit is the operator CLI `reset-mfa` (Q3).
- Invite / reset links and the set-password page (Q4); the first user is created by `Teas.Migrator bootstrap-admin`,
  which prints a one-time link (Q5). Details: `docs/specs/SP3-platform.md` §4.4.
- OAuth clients (SP4.10) keep tokens; this ADR covers the browser only.

## Consequences
- Every authenticated request reads the session row (one indexed lookup); logout, password change and admin resets
  revoke at once.
- No refresh-token rotation or token store in the browser.
- Data Protection keys (`TEAS_DP_KEYS_DIR`) protect TOTP secrets and must be backed up separately from the database.

## Spec changes
`docs/specs/SP3-platform.md` §4.4 and the Ham rulings of 2026-10-27 (Q1–Q5); SP0 §10.4 browser tokens superseded.
