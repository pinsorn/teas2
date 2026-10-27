// SP3 4.5: the backend catalog (backend/artifacts/permissions.json, exported by every backend build) equals the frozen contract:
// the same codes, the same agent-forbidden flags, the same system role templates, and a Thai and an English label for every code.
// The web CI job does not build the backend, so there the file is absent and this skips; the backend integration test
// PermissionCatalogTests.TheExportedArtifactIsTheCatalog compares the same artifact with platform.ts where it exists.
// Skipping in CI is accepted (controller ruling): TheExportedArtifactIsTheCatalog covers the same equality in the backend job.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import th from '@/messages/th.json';
import { PERMISSION_CODES, SYSTEM_ROLES, agentForbidden } from './platform';

const file = join(process.cwd(), '..', 'backend', 'artifacts', 'permissions.json');

describe.skipIf(!existsSync(file))('backend permission catalog vs the frozen contract', () => {
  // read lazily: a skipped describe body still runs at collection time
  const backend = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { permissions: [], roles: {} }) as {
    permissions: { code: string; area: string; agentForbidden: boolean }[];
    roles: Record<string, string[]>;
  };

  it('has exactly the frozen codes', () => {
    expect(backend.permissions.map((p) => p.code).sort()).toEqual([...PERMISSION_CODES].sort());
  });
  it('flags AgentForbidden exactly as the TS rule does, on every code', () => {
    for (const p of backend.permissions) expect(p.agentForbidden, p.code).toBe(agentForbidden(p.code));
  });
  it('has exactly the frozen system role templates', () => {
    expect(Object.keys(backend.roles).sort()).toEqual(Object.keys(SYSTEM_ROLES).sort());
    for (const [role, codes] of Object.entries(SYSTEM_ROLES)) expect([...backend.roles[role]].sort(), role).toEqual([...codes].sort());
  });
  it('has a Thai and an English label for every code', () => {
    const label = (m: { permissions: Record<string, string> }, code: string) => m.permissions[code.replace(/\./g, '_')];
    for (const p of backend.permissions) {
      expect(label(th, p.code), `th ${p.code}`).toBeTruthy();
      expect(label(en, p.code), `en ${p.code}`).toBeTruthy();
    }
  });
});
