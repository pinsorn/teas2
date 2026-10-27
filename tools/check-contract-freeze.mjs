// tools/check-contract-freeze.mjs - the contract freeze guard (master plan 2026-10-27-sp2-contract-freeze.md section 2.4).
// FROZEN.json: { "<module>": { version, sha256, files, approved, adrs } }. `files` are relative to frontend/src/contract/;
// "../domain/types.ts#DocType" hashes only that `export type DocType = ...;` declaration (a guarded dependency).
// Canonical content: each file's text with CRLF -> LF (and no BOM), hashed as "<entry>\n<text>\n" per entry, in `files` order.
// `node tools/check-contract-freeze.mjs --hash <module>` prints the current hash (for updating FROZEN.json).
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACT_DIR = 'frontend/src/contract';

export function canonicalHash(root, entries) {
  const h = createHash('sha256');
  const missing = [];
  for (const entry of entries) {
    const [rel, sym] = entry.split('#');
    const p = join(root, CONTRACT_DIR, rel);
    if (!existsSync(p)) { missing.push(entry); continue; }
    let text = readFileSync(p, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (sym) {
      const m = text.match(new RegExp(`^export type ${sym}\\s*=[^;]*;`, 'm'));
      if (!m) { missing.push(entry); continue; }
      text = m[0];
    }
    h.update(`${entry}\n${text}\n`);
  }
  return { sha256: h.digest('hex'), missing };
}

const cmp = (a, b) => { const [x, y] = [a, b].map((v) => v.split('.').map(Number)); return (x[0] - y[0]) || (x[1] - y[1]); };

/** Returns an array of failure messages (empty = ok). baseline = FROZEN.json at origin/main, or null when unavailable. */
export function check({ root, frozen, baseline = null }) {
  const errs = [];
  const exit = (m) => `  To change a frozen contract: bump CONTRACT_VERSION in ${CONTRACT_DIR}/${m}.ts, update its FROZEN.json entry (version + sha256 via "node tools/check-contract-freeze.mjs --hash ${m}"), and add an ADR under docs/adr/ naming "${m}" and the new version.`;
  for (const [m, e] of Object.entries(frozen)) {
    const { sha256, missing } = canonicalHash(root, e.files);
    if (missing.length) { errs.push(`${m}: guarded file(s) missing: ${missing.join(', ')}`); continue; }
    if (sha256 !== e.sha256) {
      errs.push(`${m}: frozen contract changed (guarded files hash ${sha256.slice(0, 12)}..., FROZEN.json has ${e.sha256.slice(0, 12)}...).\n${exit(m)}`);
      continue;
    }
    const src = readFileSync(join(root, CONTRACT_DIR, `${m}.ts`), 'utf8');
    const v = src.match(/CONTRACT_VERSION\s*=\s*'([^']+)'/)?.[1];
    if (v !== e.version) { errs.push(`${m}: CONTRACT_VERSION in ${m}.ts is ${v ?? 'missing'} but FROZEN.json says ${e.version}.`); continue; }
    const b = baseline?.[m];
    if (b && b.sha256 !== e.sha256) {
      if (cmp(e.version, b.version) <= 0) { errs.push(`${m}: contract changed since the baseline but the version is not higher (${b.version} -> ${e.version}).\n${exit(m)}`); continue; }
      const dir = join(root, 'docs/adr');
      const adrs = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-.*\.md$/.test(f)) : [];
      const named = adrs.some((f) => { const t = readFileSync(join(dir, f), 'utf8'); return t.includes(m) && t.includes(e.version); });
      if (!named) errs.push(`${m}: version bumped to ${e.version} but no ADR in docs/adr/ names "${m}" and ${e.version}.\n${exit(m)}`);
    }
  }
  return errs;
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const frozen = JSON.parse(readFileSync(join(root, CONTRACT_DIR, 'FROZEN.json'), 'utf8'));
  const i = process.argv.indexOf('--hash');
  if (i > 0) { console.log(canonicalHash(root, frozen[process.argv[i + 1]].files).sha256); process.exit(0); }
  let baseline = null;
  try { baseline = JSON.parse(execSync(`git show origin/main:${CONTRACT_DIR}/FROZEN.json`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { console.warn('baseline origin/main:FROZEN.json unavailable - version-bump/ADR comparison skipped'); }
  const errs = check({ root, frozen, baseline });
  if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
  console.log('contract freeze ok');
}
