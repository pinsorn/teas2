// SP3 P11a: the API's Thai error titles (backend/src/Teas.Domain/ErrorCodes.cs) are the Ham-approved mock copy. For each code the mock emits with a
// context-free title, the backend title must be one of the literals the mock writes next to that code in the named file. Where the mock has several
// variants per code (one per call site) the backend carries one of them. Not listed (the mock text is dynamic or mock-only, or the mock has none):
// role.in_use / connect.scope_* (mock interpolates a name / list), storage.full (demo data wording), http.* / idempotency.* / money.* (no mock copy).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cs = join(process.cwd(), '..', 'backend', 'src', 'Teas.Domain', 'ErrorCodes.cs');
const mock = (f: string) => join(process.cwd(), 'src', 'mocks', f);

const FILES: Record<string, string[]> = {
  'auth.invalid_credentials': ['engine/auth.ts'], 'auth.locked': ['engine/auth.ts'], 'auth.challenge_invalid': ['engine/auth.ts'],
  'auth.totp_invalid': ['engine/auth.ts'], 'auth.current_password_invalid': ['engine/auth.ts'], 'auth.password_mismatch': ['engine/auth.ts'],
  'auth.password_weak': ['engine/auth.ts'], 'auth.password_reuse': ['engine/auth.ts'], 'auth.enrol_not_started': ['engine/auth.ts'],
  'auth.session_not_found': ['engine/auth.ts'], 'auth.unauthenticated': ['engine/auth.ts'],
  'auth.session_expired': ['handlers/auth.ts'], 'auth.not_expired': ['handlers/auth.ts'], 'auth.forbidden': ['handlers/common.ts'],
  'company.not_found': ['engine/company.ts'], 'company.section_unknown': ['engine/company.ts'], 'company.confirm_required': ['engine/company.ts'],
  'company.vat_readonly': ['engine/company.ts'], 'company.fiscal_year_unsupported': ['engine/company.ts'], 'company.fiscal_year_locked': ['engine/company.ts'],
  'record.invalid': ['handlers/settings.ts'], 'record.not_found': ['handlers/records.ts'], 'record.version_conflict': ['handlers/records.ts'],
  'user.last_admin': ['records/users.ts'], 'user.inactive': ['records/users.ts'], 'user.invite_pending': ['records/users.ts'], 'user.cross_company': ['records/users.ts'],
  'role.system_readonly': ['records/roles.ts'],
  'connect.not_member': ['records/connect.ts'], 'connect.wrong_company': ['records/connect.ts'], 'connect.key_revoked': ['records/connect.ts'],
  'connect.key_expired': ['records/connect.ts'], 'connect.key_invalid': ['records/connect.ts'], 'connect.owner_inactive': ['records/connect.ts'],
  'agent.forbidden_action': ['handlers/me.ts'], 'agent.forbidden_setting': ['handlers/me.ts'],
};

const lits = (src: string, code: string) =>
  [...src.matchAll(new RegExp(`'${code.replace('.', '\\.')}',\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g'))].map((m) => m[1]);

describe.skipIf(!existsSync(cs))('backend Thai error titles equal the mock copy', () => {
  const backend = existsSync(cs) ? readFileSync(cs, 'utf8') : '';
  for (const [code, files] of Object.entries(FILES)) {
    it(code, () => {
      const th = new RegExp(`\\["${code.replace('.', '\\.')}"\\] = new\\(\\d+, "([^"]*)"`).exec(backend)?.[1];
      const mocked = files.flatMap((f) => lits(readFileSync(mock(f), 'utf8'), code));
      expect(mocked.length, `${code}: the mock writes no title literal in ${files.join(', ')}`).toBeGreaterThan(0);
      expect(mocked).toContain(th);
    });
  }
});
