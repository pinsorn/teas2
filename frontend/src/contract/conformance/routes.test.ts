// SP3 4.8: the OpenAPI path + method set is a subset of the frozen ROUTES, every LIVE route is documented, and every documented
// route has a conformance line in platform.ts. Reads the committed document (docs/api/openapi.v1.json), not the generated types.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIVE_ROUTES } from '../live-routes';
import { ROUTES } from '../platform';

const doc = JSON.parse(readFileSync(join(process.cwd(), '..', 'docs', 'api', 'openapi.v1.json'), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { type?: string; pattern?: string }> };
};
// commented-out lines do not count as conformance lines
const conformance = readFileSync(join(__dirname, 'platform.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const documented = Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => ({ method: m.toUpperCase(), path })));
const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe('OpenAPI vs ROUTES', () => {
  it('every documented route is a contract route', () => {
    const routes = new Set(ROUTES.map(key));
    for (const r of documented) expect(routes, key(r)).toContain(key(r));
  });
  it('every live route is documented', () => {
    const docs = new Set(documented.map(key));
    for (const r of LIVE_ROUTES) expect(docs, key(r)).toContain(key(r));
  });
  it('every documented route has a conformance line', () => {
    for (const r of documented) expect(conformance, key(r)).toContain(`paths['${r.path}']['${r.method.toLowerCase()}']`);
  });
  it('Money is the two-decimal pattern string (Money.TryParse)', () => {
    expect(doc.components.schemas.Money).toEqual({ type: 'string', pattern: '^-?(0|[1-9][0-9]{0,15})\\.[0-9]{2}$' });
  });
});
