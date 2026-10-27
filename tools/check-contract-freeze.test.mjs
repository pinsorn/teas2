// tools/check-contract-freeze.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalHash, check } from './check-contract-freeze.mjs';

const FILES = ['platform.ts', 'scalars.ts', '../domain/types.ts#DocType'];
const C = 'frontend/src/contract';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'freeze-'));
  mkdirSync(join(root, C), { recursive: true });
  mkdirSync(join(root, 'frontend/src/domain'), { recursive: true });
  mkdirSync(join(root, 'docs/adr'), { recursive: true });
  write(root, `${C}/platform.ts`, "export const CONTRACT_VERSION = '1.0';\nexport type A = string;\n");
  write(root, `${C}/scalars.ts`, 'export type Money = string;\n');
  write(root, 'frontend/src/domain/types.ts', "export type DocType = 'QT' | 'IV';\nexport interface Me { a: string }\n");
  const entry = (version) => ({ version, sha256: canonicalHash(root, FILES).sha256, files: FILES, approved: '2026-10-27', adrs: [] });
  return { root, entry, frozen: { platform: entry('1.0') } };
}
const write = (root, rel, text) => writeFileSync(join(root, rel), text);
const edit = (root, rel, from, to) => write(root, rel, readFileSync(join(root, rel), 'utf8').replace(from, to));

test('unchanged tree passes', () => {
  const { root, frozen } = fixture();
  assert.deepEqual(check({ root, frozen, baseline: frozen }), []);
});

test('editing a guarded file without updating FROZEN fails and says how to change it', () => {
  const { root, frozen } = fixture();
  edit(root, `${C}/scalars.ts`, 'string', 'number');
  const [msg, ...rest] = check({ root, frozen, baseline: frozen });
  assert.equal(rest.length, 0);
  assert.match(msg, /platform: frozen contract changed/);
  assert.match(msg, /bump CONTRACT_VERSION/);
  assert.match(msg, /ADR/);
});

test('DocType is guarded but the rest of domain/types.ts is free', () => {
  const { root, frozen } = fixture();
  edit(root, 'frontend/src/domain/types.ts', 'a: string', 'a: string | null');
  assert.deepEqual(check({ root, frozen, baseline: frozen }), []);
  edit(root, 'frontend/src/domain/types.ts', "'IV'", "'IV' | 'RC'");
  assert.match(check({ root, frozen, baseline: frozen })[0], /frozen contract changed/);
});

test('a missing guarded file fails', () => {
  const { root, frozen } = fixture();
  frozen.platform.files = [...FILES, 'route-spec.ts'];
  assert.match(check({ root, frozen })[0], /missing: route-spec\.ts/);
});

test('edit + version bump + FROZEN update + ADR naming module and version passes', () => {
  const { root, entry, frozen: baseline } = fixture();
  edit(root, `${C}/scalars.ts`, 'string', 'number');
  edit(root, `${C}/platform.ts`, "'1.0'", "'1.1'");
  const frozen = { platform: entry('1.1') };
  assert.match(check({ root, frozen, baseline })[0], /no ADR/);
  write(root, 'docs/adr/0007-x.md', '# ADR-0007\nplatform contract 1.1: Money widened.\n');
  assert.deepEqual(check({ root, frozen, baseline }), []);
});

test('FROZEN updated with the new hash but the version not bumped fails', () => {
  const { root, entry, frozen: baseline } = fixture();
  edit(root, `${C}/scalars.ts`, 'string', 'number');
  assert.match(check({ root, frozen: { platform: entry('1.0') }, baseline })[0], /not higher/);
});

test('CONTRACT_VERSION must match FROZEN.json', () => {
  const { root, entry } = fixture();
  assert.match(check({ root, frozen: { platform: entry('1.1') } })[0], /CONTRACT_VERSION .* is 1\.0 but FROZEN\.json says 1\.1/);
});

test('CRLF checkout hashes the same as LF', () => {
  const { root } = fixture();
  const lf = canonicalHash(root, FILES).sha256;
  for (const rel of [`${C}/platform.ts`, `${C}/scalars.ts`, 'frontend/src/domain/types.ts']) {
    write(root, rel, readFileSync(join(root, rel), 'utf8').replace(/\n/g, '\r\n'));
  }
  assert.equal(canonicalHash(root, FILES).sha256, lf);
});
