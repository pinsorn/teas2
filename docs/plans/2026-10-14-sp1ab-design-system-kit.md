# SP1a + SP1b — Design System, Document Kit and Tax-Invoice Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the real TEAS 2 frontend on mock data up to the SP1b gate: scaffold + mock API, app shell and IA,
three style tiles for Ham to choose from (SP1a), the chosen design system, the one document kit
(DocList / DocEditor / DocView / Paper), the full tax-invoice loop including edit-after-issue and chain-aware
corrections, a print-fidelity spike, and a staging preview.

**Architecture:** Next.js 16.4 App Router in `frontend/`. All data comes from `/bff/v1/*`; in SP1 an MSW browser
worker answers those calls from an in-memory mock store with a mock engine that behaves like the future server
(numbering, totals, links, logs, correction plans). Production frontend code contains no tax or money arithmetic —
totals come from the compute endpoint. Document types are descriptors; the kit renders every type. SP1c (all other
screens) gets its own plan after the SP1b gate, because its tasks consume this plan's kit interfaces.

**Tech Stack:** Next.js 16.4.0, React 19.2, TypeScript (strict), Tailwind CSS v4, shadcn/ui (Radix), TanStack Query 5,
TanStack Table 8, React Hook Form + Zod, next-intl, MSW 2, Vitest + Testing Library, Playwright (+ axe), pnpm via
corepack, Node 24.

**Spec:** `docs/specs/SP0-charter.md` — §7 (document framework, chain, logs), §9 (IA/UX), §10.1/§10.6 (stack,
rendering), §11.2–11.3 (SP1 gates and mockup rules), §1.2 S2–S5.

## Global Constraints

- Versions: `next@16.4.0`; every other dependency pinned exactly (`--save-exact`); Node 24; pnpm via `corepack pnpm`.
- Frontend production code never computes tax or totals. Only formatting and the TIN checksum run client-side.
- API base path `/bff/v1`. Every TanStack Query key starts with the active `companyId`.
- Every screen has distinct loading, empty, error, forbidden and locked states; an error is never shown as "no data".
- Thai first: Buddhist-era dates (`14 ต.ค. 2569`), amounts in words come from the server, UI strings live in
  `src/messages/th.json` / `en.json` (no hard-coded UI strings in components).
- Accessibility: dialogs are shadcn/Radix (focus trap, Escape); every Playwright page check runs axe with zero
  `serious` / `critical` violations.
- No dark mode (D-13); colours only through tokens.
- Document numbers: `{PREFIX}-{YYYYMM}-{####}` (D-24), e.g. `TI-202610-0001`.
- Fixtures are fictional; every TIN passes the checksum; no real people or businesses.
- Never commit screenshots or generated files; Playwright output and spike PDFs stay in ignored folders or the
  scratchpad.
- UI tasks give exact interfaces, behaviour lists and full tests; visual styling follows
  `docs/specs/SP1-design-system.md` (written in Task 9). Implementers load the `impeccable` skill for UI work.

## Review Focus

1. **Money edge cases in compute** — credit lines, half-satang VAT, very large amounts, mixed standard / zero /
   exempt lines, VAT-inclusive prices: totals must follow SP0 I2 exactly (Task 3 tests).
2. **Long Thai text and many lines on paper** — a row is never split across pages, the table header repeats, the
   signature block stays on the last page (Task 13 tests, Task 15 spike with 300-character descriptions).
3. **Keyboard flow edge cases** — no match, several matches, Enter during text composition: Enter while composing does
   nothing; no match keeps free text (Task 11 tests).
4. **Reload or close mid-edit** — autosave restores the draft and one editor session never creates two drafts
   (Task 11 tests).
5. **Company or role switch with a page open** — no data from the previous company is shown and the forbidden state
   appears where the new role lacks permission (Task 6 and Task 7 tests).

---

### Task 1: Scaffold the frontend, tooling and CI

**Files:**
- Create: `frontend/` (create-next-app 16.4.0), `frontend/vitest.config.ts`, `frontend/src/test/setup.ts`,
  `frontend/playwright.config.ts`, `frontend/.env.example`, `frontend/CLAUDE.md`, `frontend/e2e/smoke.spec.ts`,
  `frontend/src/lib/utils.test.ts`, `.mcp.json`, `.github/workflows/frontend.yml`
- Modify: `frontend/package.json` (scripts), `frontend/next.config.ts`

**Interfaces:**
- Produces: scripts `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `e2e`; env flag
  `NEXT_PUBLIC_API_MOCKING=enabled`; CI jobs `layout` and `web` (required checks for later PRs).

- [ ] **Step 1: Scaffold**

```bash
cd "Y:/ClaudePlayground/TEAS2"
corepack pnpm@10 dlx create-next-app@16.4.0 frontend --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-pnpm --skip-install --yes
cd frontend && corepack pnpm install
```
`--skip-install` because create-next-app would spawn a bare `pnpm`, which is not on PATH here; every install runs
through `corepack pnpm`. Expected: `frontend/` with `src/app`, `AGENTS.md`, `pnpm-lock.yaml`; no nested `.git`
(the tool skips git inside a repo).

- [ ] **Step 2: Add dependencies (exact versions)**

```bash
cd frontend
corepack pnpm add --save-exact @tanstack/react-query @tanstack/react-table react-hook-form zod @hookform/resolvers next-intl lucide-react clsx tailwind-merge sonner cmdk
corepack pnpm add --save-exact -D msw vitest @vitejs/plugin-react vite-tsconfig-paths jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom @playwright/test @axe-core/playwright pdfjs-dist
corepack pnpm dlx shadcn@latest init -d
corepack pnpm dlx shadcn@latest add button input label textarea select checkbox dialog alert-dialog sheet popover command table badge tabs tooltip dropdown-menu separator scroll-area skeleton alert sonner
corepack pnpm dlx msw init public --save
```

- [ ] **Step 3: Configure**

`frontend/next.config.ts`
```ts
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const nextConfig: NextConfig = { output: 'standalone' };
export default withNextIntl(nextConfig);
```
(No `typedRoutes`: the kit builds hrefs from descriptors at runtime, which typed routes would reject.)

`frontend/vitest.config.ts`
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
});
```

`frontend/src/test/setup.ts`
```ts
import '@testing-library/jest-dom/vitest';
```

`frontend/playwright.config.ts`
```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:3100', locale: 'th-TH', timezoneId: 'Asia/Bangkok' },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: process.env.CI ? undefined : 'chrome' } }],
  webServer: {
    command: 'corepack pnpm build && corepack pnpm start -p 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    env: { NEXT_PUBLIC_API_MOCKING: 'enabled' },
    timeout: 240_000,
  },
});
```

`frontend/package.json` scripts:
```json
{
  "dev": "next dev -p 3100",
  "build": "next build",
  "start": "next start",
  "lint": "eslint .",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "e2e": "playwright test"
}
```

`frontend/.env.example`
```
NEXT_PUBLIC_API_MOCKING=enabled
```

`frontend/CLAUDE.md`
```markdown
@AGENTS.md

- SP1 runs on mock data: `NEXT_PUBLIC_API_MOCKING=enabled` starts the MSW worker (`src/mocks/`).
- Commands: `corepack pnpm dev | lint | typecheck | test | e2e`.
- Production code never computes tax or totals — call the compute endpoint.
- UI strings live in `src/messages/th.json` and `en.json`.
```

`.mcp.json` (repo root) — pin the current version from `npm view next-devtools-mcp version`:
```json
{ "mcpServers": { "next-devtools": { "command": "npx", "args": ["-y", "next-devtools-mcp@<version from npm view>"] } } }
```

- [ ] **Step 4: Write the smoke tests**

`frontend/src/lib/utils.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('joins truthy classes and lets later Tailwind classes win', () => {
    expect(cn('px-2', false && 'hidden', 'px-4')).toBe('px-4');
  });
});
```

`frontend/e2e/smoke.spec.ts`
```ts
import { expect, test } from '@playwright/test';

test('home page loads', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/TEAS/);
});
```
Set `metadata.title = 'TEAS 2'` in `src/app/layout.tsx` so the title assertion holds.

- [ ] **Step 5: Run everything locally**

Run: `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm e2e`
Expected: all green; 1 unit test, 1 e2e test.

- [ ] **Step 6: Add CI**

`.github/workflows/frontend.yml`
```yaml
name: frontend
on:
  pull_request:
  push:
    branches: [main]
jobs:
  layout:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: node --test tools/check-repo-layout.test.mjs && node tools/check-repo-layout.mjs
  web:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: corepack enable && pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm e2e
        env: { CI: 'true' }
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: frontend/playwright-report }
```

- [ ] **Step 7: Commit; require the checks**

```bash
git add frontend .mcp.json .github/workflows/frontend.yml
git commit -m "feat(frontend): scaffold Next.js 16.4 app with test tooling and CI"
```
If `main` is protected (P0 Task 5), add `layout` and `web` as required status checks.

---

### Task 2: Contract types, descriptors, TIN checksum, shared companies

**Files:**
- Create: `frontend/src/domain/types.ts`, `frontend/src/domain/descriptors.ts`, `frontend/src/domain/tin.ts`,
  `frontend/src/domain/tin.test.ts`, `frontend/src/mocks/fixtures/companies.json`

**Interfaces:**
- Produces: every type below (later tasks import them from `@/domain/types`); `isValidTin(tin: string): boolean`,
  `tinCheckDigit(first12: string): number`; `DocDescriptor`; `frontend/src/mocks/fixtures/companies.json` — the one
  source of the two fictional companies, also read by SP-R Task 7 (kept inside `frontend/` so the Docker build and
  Turbopack never import outside the app root).

- [ ] **Step 1: Write the contract types**

`frontend/src/domain/types.ts`
```ts
export type Money = string;   // decimal string, 2 dp: "64200.00"
export type Qty = string;     // decimal string, up to 4 dp
export type IsoDate = string; // "2026-10-14"
export type DocType = 'QT' | 'SO' | 'DO' | 'BL' | 'IV' | 'TI' | 'RC' | 'CN' | 'DN' | 'PO' | 'PB' | 'PCN' | 'PDN'
  | 'PV' | 'WT' | 'EX' | 'JV' | 'FA' | 'DP' | 'PR' | 'OB';
export type CorrectionClass = 'N' | 'L' | 'T';
export type DocStatus = 'draft' | 'pending' | 'approved' | 'issued' | 'partly_settled' | 'settled' | 'cancelled' | 'replaced';
export type Role = 'operator' | 'accountant' | 'admin';
export type TaxCode = 'S7' | 'Z0' | 'EX'; // standard 7 %, zero-rated, exempt

export interface Company { id: string; legalNameTh: string; legalNameEn?: string; taxId: string; branchCode: string;
  vatRegistered: boolean; address: string; phone?: string }
export interface Membership { companyId: string; companyName: string; role: Role }
export interface Me { userId: string; displayName: string; memberships: Membership[]; activeCompanyId: string;
  permissions: string[] }
export interface Actor { kind: 'user' | 'agent'; id: string; name: string; ownerName?: string }

export interface PartySummary { id: string; kind: 'customer' | 'vendor'; code: string; name: string; taxId?: string;
  branchCode?: string; vatRegistered: boolean; address?: string; paymentTermDays: number; defaultWhtTypeCode?: string;
  usualItemIds?: string[] }
export interface ItemSummary { id: string; code: string; name: string; kind: 'good' | 'service'; unit: string;
  unitPrice: Money; taxCode: TaxCode; whtTypeCode?: string }

export interface DocLine { id: string; itemId?: string; description: string; qty: Qty; unit: string; unitPrice: Money;
  discountPct?: string; taxCode: TaxCode; dimensions?: Record<string, string>; sourceLineId?: string }
export interface DocHeader { partyId?: string; documentDate: IsoDate; dueDate?: IsoDate; reference?: string;
  notes?: string; dimensions?: Record<string, string>; priceIncludesVat?: boolean }
export interface DocTotals { gross: Money; discount: Money; net: Money; vat: Money; total: Money; wht?: Money;
  amountInWords: string }
export interface Lock { kind: 'period' | 'filing' | 'settlement' | 'reconciliation'; reason: string; exits: string[] }
export interface Doc { id: string; type: DocType; number?: string; status: DocStatus; correctionClass: CorrectionClass;
  revision: number; version: number; header: DocHeader; party?: PartySummary; lines: DocLine[]; totals: DocTotals;
  outstanding?: Money; locks: Lock[]; createdBy: Actor; issuedAt?: string;
  cancel?: { reasonCode: string; reasonText: string; at: string }; replacedById?: string; replacesId?: string }
export interface DocSummary { id: string; type: DocType; number?: string; status: DocStatus; documentDate: IsoDate;
  partyName: string; total: Money; outstanding?: Money; dueDate?: IsoDate; createdByAgent: boolean }
export interface Page<T> { items: T[]; nextCursor?: string; total?: number }

export type LinkKind = 'converted_from' | 'settles' | 'adjusts' | 'groups' | 'replaces' | 'issues';
export interface ChainNode { id: string; type: DocType; number?: string; status: DocStatus; total: Money; progress?: string }
/** `from` = the document whose command created the link (DO→SO converted_from, RC→TI settles, CN→TI adjusts,
 *  BL→TI groups, new TI→old TI replaces, PV→WT issues); `to` = the document it refers to. */
export interface ChainEdge { from: string; to: string; kind: LinkKind; amount?: Money; qty?: Qty; active: boolean }
export interface ChainGraph { rootId: string; nodes: ChainNode[]; edges: ChainEdge[] }

export interface ActivityEntry { id: string; at: string; actor: Actor; action: string; detail?: string; reportId?: string }
export interface FieldChange { path: string; before: string | null; after: string | null }
export interface Revision { revision: number; at: string; actor: Actor; reason?: string; snapshot: Doc; diff: FieldChange[] }
export interface AuditEntry { id: string; at: string; actor: Actor; companyId: string; command: string; target?: string;
  before?: unknown; after?: unknown; result: 'ok' | 'rejected' }

export interface JournalLinePreview { accountCode: string; accountName: string; debit: Money; credit: Money;
  partyName?: string; dimensions?: Record<string, string>; rule: string }
export interface JournalEntryPreview { number?: string; date: IsoDate; kind: 'original' | 'reversal' | 'correction';
  lines: JournalLinePreview[] }
export interface JournalPreview { entries: JournalEntryPreview[] }

export interface MissingItem { field: string; message: string }
export interface ComputeResult { lines: { id: string; net: Money; vat: Money; total: Money }[]; totals: DocTotals;
  missing: MissingItem[]; journal: JournalPreview }

export interface CorrectionStep { order: number; action: 'revise' | 'cancel' | 'reissue' | 'issue_cn' | 'issue_dn';
  docId: string; docType: DocType; number?: string; summary: string; permission: string }
export interface CorrectionPlan { planId: string; planHash: string; steps: CorrectionStep[]; missingPermissions: string[];
  explanation: string }
export interface CorrectionResult { affected: { docId: string; type: DocType; number?: string; status: DocStatus }[] }

export interface HomeInbox { approvals: DocSummary[]; myDrafts: DocSummary[]; overdue: DocSummary[];
  deadlines: { form: string; due: IsoDate }[]; unreconciledLines: number; agentDigest: { posted: number; waiting: number };
  kpis: { cash: Money; ar: Money; ap: Money; vatThisMonth: Money | null } }
export interface SearchHit { kind: 'doc' | 'party' | 'page'; id: string; label: string; href: string }

export interface ApiProblem { type?: string; title: string; status: number; code: string; detail?: string;
  traceId?: string; fieldErrors?: Record<string, string[]> }
```

- [ ] **Step 2: Write the descriptor type**

`frontend/src/domain/descriptors.ts`
```ts
import type { CorrectionClass, DocType } from './types';

export interface DocDescriptor {
  type: DocType;
  correctionClass: CorrectionClass;
  titleTh: string;
  titleEn: string;
  partyKind: 'customer' | 'vendor' | 'employee' | null;
  lineEditor: 'item' | 'amount' | 'account';
  vat: 'vat-only' | 'non-vat-only' | 'both';
  issueLabelTh: string;
  basePath: string; // list route, e.g. '/sales/tax-invoices'
  permissions: { read: string; create: string; issue: string; cancel: string; correct: string };
}

export const routesOf = (d: DocDescriptor) => ({
  list: d.basePath,
  create: `${d.basePath}/new`,
  view: (id: string) => `${d.basePath}/${id}`,
  edit: (id: string) => `${d.basePath}/${id}/edit`,
  print: (id: string) => `/print/${d.type}/${id}`,
});
```

- [ ] **Step 3: Write the failing TIN test**

`frontend/src/domain/tin.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { isValidTin, tinCheckDigit } from './tin';

describe('Thai 13-digit tax id', () => {
  it.each(['1234567890121', '0105569012345', '0105569056784', '0105568024684', '3100600123450'])('accepts %s', (t) => {
    expect(isValidTin(t)).toBe(true);
  });
  it.each(['1234567890122', '010556901234', 'abcdefghijklm', ''])('rejects %s', (t) => {
    expect(isValidTin(t)).toBe(false);
  });
  it('computes the check digit', () => {
    expect(tinCheckDigit('123456789012')).toBe(1);
    expect(() => tinCheckDigit('12')).toThrow();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `corepack pnpm vitest run src/domain/tin.test.ts`
Expected: FAIL — cannot resolve `./tin`.

- [ ] **Step 5: Implement**

`frontend/src/domain/tin.ts`
```ts
export function tinCheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error('first12 must be 12 digits');
  const sum = [...first12].reduce((acc, d, i) => acc + Number(d) * (13 - i), 0);
  return (11 - (sum % 11)) % 10;
}

export function isValidTin(tin: string): boolean {
  return /^\d{13}$/.test(tin) && tinCheckDigit(tin.slice(0, 12)) === Number(tin[12]);
}
```

- [ ] **Step 6: Run the test**

Run: `corepack pnpm vitest run src/domain/tin.test.ts`
Expected: PASS (10 cases).

- [ ] **Step 7: Write the shared companies file**

`frontend/src/mocks/fixtures/companies.json`
```json
{
  "companies": [
    {
      "key": "vat",
      "legalNameTh": "บริษัท มะลิวัลย์ ดีไซน์ เวิร์คส์ จำกัด",
      "legalNameEn": "Maliwan Design Works Co., Ltd.",
      "taxId": "0105569012345",
      "branchCode": "00000",
      "vatRegistered": true,
      "address": "88/12 ถนนประดิพัทธ์ แขวงพญาไท เขตพญาไท กรุงเทพมหานคร 10400",
      "phone": "02-000-1234",
      "fiscalYearStartMonth": 1
    },
    {
      "key": "nonvat",
      "legalNameTh": "บริษัท บ้านต้นข้าว ฟู้ดส์ จำกัด",
      "legalNameEn": "Baan Ton Khao Foods Co., Ltd.",
      "taxId": "0105569056784",
      "branchCode": "00000",
      "vatRegistered": false,
      "address": "215 หมู่ 4 ตำบลบางกระสอ อำเภอเมืองนนทบุรี จังหวัดนนทบุรี 11000",
      "phone": "02-000-5678",
      "fiscalYearStartMonth": 1
    }
  ]
}
```

- [ ] **Step 7b: Type-check and commit**

Run: `corepack pnpm typecheck` — Expected: no errors.

```bash
git add frontend/src/domain frontend/src/mocks/fixtures/companies.json
git commit -m "feat(frontend): contract types, document descriptor and TIN checksum"
```

---

### Task 3: Mock engine — money, VAT compute, amount in words, numbering

**Files:**
- Create: `frontend/src/mocks/engine/money.ts`, `vat.ts`, `bahtText.ts`, `numbering.ts` and a `*.test.ts` beside each

**Interfaces:**
- Produces:
  - `toSatang(m: Money): number`, `fromSatang(s: number): Money`, `mulQtyPrice(qty: Qty, priceSatang: number): number`,
    `divRoundHalfAway(n: bigint, d: bigint): bigint`
  - `computeLine(line: DocLine, priceIncludesVat: boolean): { id; gross; discount; net; vat; total }` (satang numbers)
  - `computeDoc(lines: DocLine[], priceIncludesVat: boolean): { lines: {id; net; vat; total}[]; totals: DocTotals }`
  - `bahtText(m: Money): string`
  - `formatDocNumber(prefix: DocType, date: IsoDate, seq: number): string`;
    `class SeriesAllocator { next(companyId: string, type: DocType, date: IsoDate): string; toJSON(): Record<string, number> }`

- [ ] **Step 1: Write the failing tests**

`frontend/src/mocks/engine/money.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { divRoundHalfAway, fromSatang, mulQtyPrice, toSatang } from './money';

describe('money', () => {
  it('parses and prints satang', () => {
    expect(toSatang('64200.00')).toBe(6420000);
    expect(toSatang('-0.5')).toBe(-50);
    expect(fromSatang(6420000)).toBe('64200.00');
    expect(fromSatang(-5)).toBe('-0.05');
    expect(() => toSatang('1.234')).toThrow();
  });
  it('rounds half away from zero', () => {
    expect(divRoundHalfAway(315n, 100n)).toBe(3n);
    expect(divRoundHalfAway(350n, 100n)).toBe(4n);
    expect(divRoundHalfAway(-350n, 100n)).toBe(-4n);
    expect(divRoundHalfAway(-315n, 100n)).toBe(-3n);
  });
  it('multiplies quantity by price exactly (bigint), even beyond 2^53', () => {
    expect(mulQtyPrice('3', 15)).toBe(45n);
    expect(mulQtyPrice('2.5', 1999)).toBe(4998n); // 49.975 baht -> 49.98
    expect(mulQtyPrice('1000000', 99_999_999_999)).toBe(99_999_999_999_000_000n);
  });
});
```

`frontend/src/mocks/engine/vat.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import type { DocLine } from '@/domain/types';
import { computeDoc, computeLine } from './vat';

const line = (p: Partial<DocLine>): DocLine => ({ id: 'l', description: 'x', qty: '1', unit: 'งาน', unitPrice: '0.00', taxCode: 'S7', ...p });

describe('VAT per line, half away from zero (SP0 I2)', () => {
  it('standard rate, exclusive', () => {
    expect(computeLine(line({ unitPrice: '60000.00' }), false)).toMatchObject({ net: 6000000, vat: 420000, total: 6420000 });
  });
  it('half-satang edge: 3 x 0.15', () => {
    expect(computeLine(line({ qty: '3', unitPrice: '0.15' }), false)).toMatchObject({ net: 45, vat: 3, total: 48 });
  });
  it('thirds: 33.33', () => {
    expect(computeLine(line({ unitPrice: '33.33' }), false)).toMatchObject({ net: 3333, vat: 233, total: 3566 });
  });
  it('line discount 12.5 %', () => {
    expect(computeLine(line({ qty: '7', unitPrice: '12.35', discountPct: '12.5' }), false))
      .toMatchObject({ gross: 8645, discount: 1081, net: 7564, vat: 529, total: 8093 });
  });
  it('VAT-inclusive price', () => {
    expect(computeLine(line({ unitPrice: '100.00' }), true)).toMatchObject({ net: 9346, vat: 654, total: 10000 });
  });
  it('credit-side (negative) amounts round half away from zero', () => {
    expect(computeLine(line({ qty: '3', unitPrice: '-0.15' }), false)).toMatchObject({ net: -45, vat: -3, total: -48 });
  });
  it('refuses amounts beyond safe integer satang', () => {
    expect(() => computeLine(line({ qty: '1000000', unitPrice: '99999999999.99' }), false)).toThrow('amount too large');
  });
  it('zero-rated and exempt lines carry no VAT', () => {
    expect(computeLine(line({ unitPrice: '25000.00', taxCode: 'Z0' }), false)).toMatchObject({ vat: 0, total: 2500000 });
    expect(computeLine(line({ unitPrice: '350.00', qty: '10', taxCode: 'EX' }), false)).toMatchObject({ vat: 0, total: 350000 });
  });
  it('header totals are sums of lines and carry the amount in words', () => {
    const r = computeDoc([line({ id: 'a', unitPrice: '60000.00' }), line({ id: 'b', unitPrice: '0.15', qty: '3' })], false);
    expect(r.totals).toMatchObject({ gross: '60000.45', discount: '0.00', net: '60000.45', vat: '4200.03', total: '64200.48' });
    expect(r.totals.amountInWords).toBe('หกหมื่นสี่พันสองร้อยบาทสี่สิบแปดสตางค์');
  });
});
```

`frontend/src/mocks/engine/bahtText.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { bahtText } from './bahtText';

describe('bahtText', () => {
  it.each([
    ['0.00', 'ศูนย์บาทถ้วน'],
    ['1.00', 'หนึ่งบาทถ้วน'],
    ['11.00', 'สิบเอ็ดบาทถ้วน'],
    ['21.00', 'ยี่สิบเอ็ดบาทถ้วน'],
    ['101.00', 'หนึ่งร้อยเอ็ดบาทถ้วน'],
    ['64200.00', 'หกหมื่นสี่พันสองร้อยบาทถ้วน'],
    ['1234.50', 'หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบสตางค์'],
    ['0.25', 'ยี่สิบห้าสตางค์'],
    ['1000001.00', 'หนึ่งล้านเอ็ดบาทถ้วน'],
    ['11000000.00', 'สิบเอ็ดล้านบาทถ้วน'],
    ['21000021.21', 'ยี่สิบเอ็ดล้านยี่สิบเอ็ดบาทยี่สิบเอ็ดสตางค์'],
    ['-5.00', 'ลบห้าบาทถ้วน'],
  ])('%s -> %s', (amount, words) => expect(bahtText(amount)).toBe(words));
});
```
Also port every vector from TEAS 1's tests (`grep -rniE "BahtText|ThaiBaht" Y:/ClaudePlayground/TEAS-Project/backend/tests`).
If a TEAS 1 vector disagrees with one above, stop and report the pair.

`frontend/src/mocks/engine/numbering.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { SeriesAllocator, formatDocNumber } from './numbering';

describe('numbering', () => {
  it('formats PREFIX-YYYYMM-####', () => expect(formatDocNumber('TI', '2026-10-14', 7)).toBe('TI-202610-0007'));
  it('is sequential per company, type and month, and never reuses a number', () => {
    const s = new SeriesAllocator();
    expect(s.next('c1', 'TI', '2026-10-01')).toBe('TI-202610-0001');
    expect(s.next('c1', 'TI', '2026-10-20')).toBe('TI-202610-0002');
    expect(s.next('c1', 'TI', '2026-11-02')).toBe('TI-202611-0001');
    expect(s.next('c2', 'TI', '2026-10-02')).toBe('TI-202610-0001');
    expect(s.next('c1', 'RC', '2026-10-03')).toBe('RC-202610-0001');
    expect(s.next('c1', 'TI', '2026-10-31')).toBe('TI-202610-0003');
  });
  it('round-trips through JSON', () => {
    const s = new SeriesAllocator(); s.next('c1', 'TI', '2026-10-01');
    const t = new SeriesAllocator(s.toJSON());
    expect(t.next('c1', 'TI', '2026-10-02')).toBe('TI-202610-0002');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `corepack pnpm vitest run src/mocks/engine`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`frontend/src/mocks/engine/money.ts`
```ts
import type { Money, Qty } from '@/domain/types';

export function toSatang(m: Money): number {
  if (!/^-?\d+(\.\d{1,2})?$/.test(m)) throw new Error(`bad money: ${m}`);
  const neg = m.startsWith('-');
  const [i, f = ''] = m.replace('-', '').split('.');
  const v = Number(i) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -v : v;
}

export function fromSatang(s: number): Money {
  const neg = s < 0;
  const a = Math.abs(s);
  return `${neg ? '-' : ''}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

export function divRoundHalfAway(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n - q * d;
  const abs = (x: bigint) => (x < 0n ? -x : x);
  if (abs(r) * 2n >= abs(d)) return q + ((n < 0n) !== (d < 0n) ? -1n : 1n);
  return q;
}

export function mulQtyPrice(qty: Qty, priceSatang: number): bigint {
  if (!/^\d+(\.\d{1,4})?$/.test(qty)) throw new Error(`bad qty: ${qty}`);
  const [i, f = ''] = qty.split('.');
  const scaled = BigInt(i + (f + '0000').slice(0, 4)); // qty x 10^4
  return divRoundHalfAway(scaled * BigInt(priceSatang), 10000n);
}
```

`frontend/src/mocks/engine/vat.ts`
```ts
import type { DocLine, DocTotals, TaxCode } from '@/domain/types';
import { bahtText } from './bahtText';
import { divRoundHalfAway, fromSatang, mulQtyPrice, toSatang } from './money';

export const RATE_BP: Record<TaxCode, bigint> = { S7: 700n, Z0: 0n, EX: 0n };

export interface LineResult { id: string; gross: number; discount: number; net: number; vat: number; total: number }

export function computeLine(l: DocLine, priceIncludesVat: boolean): LineResult {
  const gross = mulQtyPrice(l.qty, toSatang(l.unitPrice));
  const pctBp = l.discountPct ? BigInt(Math.round(Number(l.discountPct) * 100)) : 0n; // 12.5 % -> 1250
  const discount = divRoundHalfAway(gross * pctBp, 10000n);
  const after = gross - discount;
  const bp = RATE_BP[l.taxCode];
  let net: bigint, vat: bigint;
  if (priceIncludesVat) { vat = divRoundHalfAway(after * bp, 10000n + bp); net = after - vat; }
  else { net = after; vat = divRoundHalfAway(net * bp, 10000n); }
  const n = (x: bigint) => { const v = Number(x); if (!Number.isSafeInteger(v)) throw new Error('amount too large'); return v; };
  return { id: l.id, gross: n(gross), discount: n(discount), net: n(net), vat: n(vat), total: n(net + vat) };
}

export function computeDoc(lines: DocLine[], priceIncludesVat: boolean) {
  const rs = lines.map((l) => computeLine(l, priceIncludesVat));
  const sum = (k: keyof Omit<LineResult, 'id'>) => rs.reduce((a, r) => a + r[k], 0);
  const totals: DocTotals = {
    gross: fromSatang(sum('gross')), discount: fromSatang(sum('discount')), net: fromSatang(sum('net')),
    vat: fromSatang(sum('vat')), total: fromSatang(sum('total')), amountInWords: bahtText(fromSatang(sum('total'))),
  };
  return { lines: rs.map((r) => ({ id: r.id, net: fromSatang(r.net), vat: fromSatang(r.vat), total: fromSatang(r.total) })), totals };
}
```

`frontend/src/mocks/engine/bahtText.ts`
```ts
import { toSatang } from './money';

const DIGIT = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const POS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

function groupText(g: number, hasHigher: boolean): string {
  const s = String(g);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]);
    const p = s.length - 1 - i;
    if (d === 0) continue;
    if (p === 1) out += d === 1 ? 'สิบ' : d === 2 ? 'ยี่สิบ' : DIGIT[d] + 'สิบ';
    else if (p === 0 && d === 1 && (s.length > 1 || hasHigher)) out += 'เอ็ด';
    else out += DIGIT[d] + POS[p];
  }
  return out;
}

export function integerText(n: number): string {
  if (n === 0) return 'ศูนย์';
  const groups: number[] = [];
  for (let r = n; r > 0; r = Math.floor(r / 1_000_000)) groups.unshift(r % 1_000_000);
  return groups.map((g, i) => (g ? groupText(g, i > 0) : '') + (i < groups.length - 1 ? 'ล้าน' : '')).join('');
}

export function bahtText(amount: string): string {
  const s = toSatang(amount);
  const a = Math.abs(s);
  const baht = Math.trunc(a / 100);
  const satang = a % 100;
  let out = baht > 0 ? integerText(baht) + 'บาท' : '';
  out += satang === 0 ? (baht === 0 ? 'ศูนย์บาท' : '') + 'ถ้วน' : integerText(satang) + 'สตางค์';
  return (s < 0 ? 'ลบ' : '') + out;
}
```

`frontend/src/mocks/engine/numbering.ts`
```ts
import type { DocType, IsoDate } from '@/domain/types';

export const formatDocNumber = (prefix: DocType, date: IsoDate, seq: number) =>
  `${prefix}-${date.slice(0, 4)}${date.slice(5, 7)}-${String(seq).padStart(4, '0')}`;

export class SeriesAllocator {
  private counters: Map<string, number>;
  constructor(init: Record<string, number> = {}) { this.counters = new Map(Object.entries(init)); }
  next(companyId: string, type: DocType, date: IsoDate): string {
    const key = `${companyId}|${type}|${date.slice(0, 7)}`;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return formatDocNumber(type, date, n);
  }
  toJSON(): Record<string, number> { return Object.fromEntries(this.counters); }
}
```

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm vitest run src/mocks/engine`
Expected: all pass (adjust only the `mulQtyPrice` huge-value assertion to `bigint` as noted in Step 1).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/mocks/engine
git commit -m "feat(mock): money, per-line VAT compute, amount in words and numbering"
```

---

### Task 4: Mock store, fixtures, permissions and read handlers

**Files:**
- Create: `frontend/src/mocks/store.ts`, `frontend/src/mocks/settings.ts`, `frontend/src/mocks/permissions.ts`,
  `frontend/src/mocks/fixtures/{parties,items,documents,index}.ts`, `frontend/src/mocks/handlers/{me,home,parties,items,docs-read,search,index}.ts`,
  `frontend/src/mocks/browser.ts`, `frontend/src/mocks/MockProvider.tsx`, `frontend/src/mocks/test-server.ts`,
  `frontend/src/mocks/store.test.ts`, `frontend/src/mocks/handlers/docs-read.test.ts`

**Interfaces:**
- Consumes: Task 2 types, Task 3 engine.
- Produces:
  - `interface MockState { version: 1; companies: Company[]; memberships: (Membership & {userId: string})[];
    parties: (PartySummary & {companyId: string})[]; items: (ItemSummary & {companyId: string})[];
    docs: (Doc & {companyId: string})[]; links: (ChainEdge & {companyId: string})[];
    activity: (ActivityEntry & {docId: string})[]; revisions: (Revision & {docId: string})[];
    journals: {docId: string; preview: JournalPreview}[]; audit: AuditEntry[]; series: Record<string, number> }`
  - `loadState(): MockState`, `saveState(s: MockState): void`, `resetState(): MockState`, `seed(): MockState`
  - `interface MockSettings { companyKey: 'vat' | 'nonvat'; role: Role; screenState: 'normal' | 'empty' | 'loading' | 'error' | 'forbidden' | 'locked' }`,
    `getSettings()`, `setSettings(p: Partial<MockSettings>)`
  - `PERMISSIONS_BY_ROLE: Record<Role, string[]>`
  - `handlers` (MSW) for: `GET /bff/v1/me`, `POST /bff/v1/me/active-company`, `GET /bff/v1/home`,
    `GET /bff/v1/parties`, `GET /bff/v1/items`, `GET /bff/v1/docs/:type`, `GET /bff/v1/docs/:type/:id`,
    `GET /bff/v1/search`
  - `<MockProvider>` — starts the worker when `NEXT_PUBLIC_API_MOCKING === 'enabled'`, renders children after start
  - `testServer` (msw/node) for Vitest

- [ ] **Step 1: Write the failing tests**

`frontend/src/mocks/store.test.ts`
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { isValidTin } from '@/domain/tin';
import { loadState, resetState, saveState, seed } from './store';

describe('mock store', () => {
  beforeEach(() => localStorage.clear());
  it('seeds two companies from fixtures/companies.json with valid TINs', () => {
    const s = seed();
    expect(s.companies.map((c) => c.vatRegistered)).toEqual([true, false]);
    for (const p of s.parties) if (p.taxId) expect(isValidTin(p.taxId)).toBe(true);
  });
  it('seed is deterministic', () => {
    expect(JSON.stringify(seed())).toBe(JSON.stringify(seed()));
  });
  it('persists and resets through localStorage', () => {
    const s = loadState();
    s.docs = s.docs.slice(0, 1);
    saveState(s);
    expect(loadState().docs).toHaveLength(1);
    expect(resetState().docs.length).toBeGreaterThan(1);
  });
  it('has the TI mix the screens need', () => {
    const tis = seed().docs.filter((d) => d.type === 'TI');
    const by = (st: string) => tis.filter((d) => d.status === st).length;
    expect(by('draft')).toBeGreaterThanOrEqual(3);
    expect(by('issued')).toBeGreaterThanOrEqual(5);
    expect(by('settled')).toBeGreaterThanOrEqual(10);
    expect(by('replaced')).toBeGreaterThanOrEqual(1);
    expect(tis.some((d) => d.createdBy.kind === 'agent')).toBe(true);
  });
});
```

`frontend/src/mocks/handlers/docs-read.test.ts`
```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setSettings } from '../settings';
import { resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const get = (p: string) => fetch(`http://localhost/bff/v1${p}`);

describe('read handlers', () => {
  it('lists TIs of the active company only, newest first, with a cursor', async () => {
    const r = await (await get('/docs/TI?limit=10')).json();
    expect(r.items).toHaveLength(10);
    expect(r.nextCursor).toBeTruthy();
    expect(r.items[0].documentDate >= r.items[9].documentDate).toBe(true);
  });
  it('filters by status', async () => {
    const r = await (await get('/docs/TI?status=draft&limit=50')).json();
    expect(r.items.every((d: { status: string }) => d.status === 'draft')).toBe(true);
  });
  it('screen state "error" returns problem+json 500, "empty" returns no rows, "forbidden" returns 403', async () => {
    setSettings({ screenState: 'error' });
    const e = await get('/docs/TI');
    expect(e.status).toBe(500);
    expect((await e.json()).code).toBe('mock.server_error');
    setSettings({ screenState: 'empty' });
    expect((await (await get('/docs/TI')).json()).items).toEqual([]);
    setSettings({ screenState: 'forbidden' });
    expect((await get('/docs/TI')).status).toBe(403);
  });
  it('non-VAT company has no TI list', async () => {
    setSettings({ companyKey: 'nonvat' });
    const r = await get('/docs/TI');
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe('doc.type_not_available');
  });
  it('a role without doc.TI.read is refused', async () => {
    setSettings({ role: 'admin' });
    expect((await get('/docs/TI')).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `corepack pnpm vitest run src/mocks/store.test.ts src/mocks/handlers`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the store, settings and permissions**

`frontend/src/mocks/permissions.ts`
```ts
import type { Role } from '@/domain/types';

const TI = ['doc.TI.read', 'doc.TI.create', 'doc.TI.issue'];
export const PERMISSIONS_BY_ROLE: Record<Role, string[]> = {
  operator: [...TI, 'doc.RC.read', 'doc.RC.create', 'doc.RC.issue', 'doc.QT.read', 'doc.QT.create', 'party.read', 'item.read'],
  accountant: [...TI, 'doc.TI.cancel', 'doc.TI.correct', 'doc.RC.read', 'doc.RC.create', 'doc.RC.issue', 'doc.RC.cancel',
    'doc.RC.correct', 'doc.CN.create', 'doc.CN.issue', 'doc.DN.create', 'doc.DN.issue', 'doc.QT.read', 'doc.QT.create',
    'party.read', 'item.read', 'ledger.read', 'audit.read'],
  admin: ['settings.manage', 'users.manage', 'party.read', 'item.read', 'audit.read'],
};
```

`frontend/src/mocks/settings.ts`
```ts
import type { Role } from '@/domain/types';

export type ScreenState = 'normal' | 'empty' | 'loading' | 'error' | 'forbidden' | 'locked';
export interface MockSettings { companyKey: 'vat' | 'nonvat'; role: Role; screenState: ScreenState }
const KEY = 'teas2.mock.settings.v1';
const DEFAULTS: MockSettings = { companyKey: 'vat', role: 'accountant', screenState: 'normal' };

export function getSettings(): MockSettings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULTS; }
}
export function setSettings(p: Partial<MockSettings>): MockSettings {
  const next = { ...getSettings(), ...p };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: settings stay default */ }
  return next;
}
```

`frontend/src/mocks/store.ts` — `seed()` builds the state deterministically (no `Math.random`, no `Date.now`;
dates count back from the fixed anchor `2026-10-14`):
- companies from `./fixtures/companies.json` (ids `co-vat` and `co-nonvat`);
- one user `u-1` "สมศรี บัญชีดี" with memberships: `co-vat` (role from settings), `co-nonvat` (operator);
- VAT company: 12 customers (8 VAT-registered companies, 2 individuals, 1 foreign, 1 government agency), 10 vendors,
  20 items (services and goods, codes `SV-xx` / `GD-xx`, `usualItemIds` set on customers). These customers are
  required by later tests: "บริษัท นาวาพาณิชย์ จำกัด" (TIN `0105568024684`, branch `00000`, `usualItemIds` =
  [`SV-01` "ออกแบบอัตลักษณ์องค์กร", 60,000.00, S7]); "บริษัท ปิ่นทองการพิมพ์ จำกัด" (TIN `0105565077124`, branch
  `00000`); "ห้างหุ้นส่วนจำกัด สมบูรณ์ค้าไม้"
  (VAT-registered, **no TIN entered** — the data-entry gap the missing-check catches);
- non-VAT company: 8 customers, 6 vendors, 12 items;
- VAT company TIs over the last 12 months: 6 draft, 12 issued (some overdue), 6 partly settled, 30 settled,
  3 cancelled-and-replaced pairs, 2 created by an agent; exactly one receipt (RC, `settles`) per settled or partly
  settled TI; 4 QT→SO→DO→TI chains with `converted_from` links; 2 issued SOs with nothing delivered yet; 2 CNs with
  `adjusts`; one issued QT already revised once (`revision: 1`, notes changed); one TI in a month whose ภ.พ.30 is
  finalized (filing lock);
- numbers from `SeriesAllocator` in document-date order; totals from `computeDoc`; one activity entry per event;
  revision 0 snapshot for every issued document; `journals: []` (Task 5 fills them).

`loadState()` reads `localStorage['teas2.mock.state.v1']` (falls back to `seed()` on missing or parse error);
`saveState` writes it; `resetState` clears and re-seeds.

- [ ] **Step 4: Implement the read handlers**

Every handler path uses the any-origin form `*/bff/v1/...` so it matches the browser worker and the Node test server
alike.

Shared helpers in `handlers/index.ts`:
```ts
import { HttpResponse, delay } from 'msw';
import type { ApiProblem } from '@/domain/types';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import { getSettings } from '../settings';
import { loadState } from '../store';

export const problem = (status: number, code: string, title: string, extra: Partial<ApiProblem> = {}) =>
  HttpResponse.json({ type: 'about:blank', status, code, title, traceId: `mock-${code}`, ...extra } satisfies ApiProblem,
    { status, headers: { 'content-type': 'application/problem+json' } });

export function ctx() {
  const st = loadState();
  const s = getSettings();
  const company = st.companies.find((c) => (s.companyKey === 'vat' ? c.vatRegistered : !c.vatRegistered))!;
  return { st, s, company, perms: PERMISSIONS_BY_ROLE[s.role] };
}

/** Applies the toolbar's screen state. Returns a response to short-circuit, or null to continue. */
export async function screenGate(kind: 'list' | 'item') {
  const { s } = ctx();
  if (s.screenState === 'loading') { await delay('infinite'); }
  if (s.screenState === 'error') return problem(500, 'mock.server_error', 'ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้ง');
  if (s.screenState === 'forbidden') return problem(403, 'auth.forbidden', 'คุณไม่มีสิทธิ์ดูข้อมูลนี้');
  if (s.screenState === 'empty' && kind === 'list') return HttpResponse.json({ items: [] });
  return null;
}
```
`docs-read.ts`: `GET /bff/v1/docs/:type` — screen gate; VAT-only type on a non-VAT company → 404
`doc.type_not_available`; missing `doc.<type>.read` → 403 `auth.forbidden` with `detail` naming the permission;
filters `status`, `q` (number or party name, case-insensitive), `from`, `to`; sort `documentDate` desc then number;
cursor = base64 of the offset; `limit` default 25, max 100. `GET /bff/v1/docs/:type/:id` → the doc (404
`doc.not_found` if another company's). With screen state `locked`, every issued document of the response carries
`locks: [{ kind: 'filing', reason: 'ภ.พ.30 เดือน ก.ย. 2569 ยื่นแล้ว', exits: ['ออกใบลดหนี้ / ใบเพิ่มหนี้ในงวดถัดไป'] }]`.

`me.ts`, `home.ts`, `parties.ts` (`?kind=&q=&limit=`), `items.ts` (`?q=&limit=`), `search.ts` (documents by
number prefix, parties by name, nav pages by label) follow the same gate and company scoping.

`browser.ts`:
```ts
import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
export const worker = setupWorker(...handlers);
```

`MockProvider.tsx`:
```tsx
'use client';
import { useEffect, useState, type ReactNode } from 'react';

export function MockProvider({ children }: { children: ReactNode }) {
  const enabled = process.env.NEXT_PUBLIC_API_MOCKING === 'enabled';
  const [ready, setReady] = useState(!enabled);
  useEffect(() => {
    if (!enabled) return;
    import('./browser').then(({ worker }) => worker.start({ onUnhandledRequest: 'bypass', quiet: true })).then(() => setReady(true));
  }, [enabled]);
  return ready ? children : null;
}
```

`test-server.ts`:
```ts
import { setupServer } from 'msw/node';
import { handlers } from './handlers';
export const testServer = setupServer(...handlers);
```

- [ ] **Step 5: Run the tests**

Run: `corepack pnpm vitest run src/mocks`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/mocks
git commit -m "feat(mock): deterministic store, fixtures, permissions and read handlers"
```

---

### Task 5: Mock engine commands — drafts, issue, cancel, revise, convert, chain, logs, corrections

**Files:**
- Create: `frontend/src/mocks/engine/commands.ts`, `chain.ts`, `ledger.ts`, `log.ts`, `corrections.ts`,
  `frontend/src/mocks/handlers/docs-write.ts`, `frontend/src/mocks/engine/commands.test.ts`,
  `frontend/src/mocks/engine/corrections.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces (all pure over `MockState`, returning the new state and a result; handlers persist it):
  - `createDraft(st, companyId, type, body: { header: DocHeader; lines: DocLine[] }, actor, idempotencyKey) → Doc`
    (same key returns the same draft)
  - `updateDraft(st, id, body, version, actor) → Doc` (409 `doc.version_conflict` on stale version)
  - `deleteDraft(st, id, version, actor) → void` (drafts only)
  - `compute(st, companyId, type, body) → ComputeResult`
  - `issue(st, id, version, actor) → Doc` (validates `missing` is empty; allocates the number; writes links, journal,
    revision 0, activity, audit)
  - `cancel(st, id, version, reasonCode, reasonText, actor) → Doc`
  - `revise(st, id, body, version, reason, actor) → Doc` (N and L classes; L writes reversal + new journal entry)
  - `convert(st, id, targetType, lines: { sourceLineId: string; qty: Qty }[], actor) → Doc` (remaining-quantity rule)
  - `buildChain(st, id) → ChainGraph`; `ledgerFor(st, doc) → JournalPreview`
  - `correctionPlan(st, id, proposed: { header: DocHeader; lines: DocLine[] }, role) → CorrectionPlan`
  - `executePlan(st, planId, planHash, actor) → CorrectionResult` — all or nothing
  - write handlers: `POST /docs/:type`, `PUT /docs/:type/:id`, `DELETE /docs/:type/:id`, `POST /docs/:type/compute`,
    `POST /docs/:type/:id/issue`, `POST /docs/:type/:id/cancel`, `POST /docs/:type/:id/correction-plan`,
    `POST /corrections`, `POST /docs/:type/:id/convert`, `GET /docs/:type/:id/chain|activity|revisions|ledger|paper`

- [ ] **Step 1: Write the failing command tests**

`frontend/src/mocks/engine/commands.test.ts`
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DocLine, MockStateLike } from './test-helpers';
import { seed } from '../store';
import { cancel, compute, convert, createDraft, issue, revise, updateDraft } from './commands';

const me: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const line = (p: Partial<DocLine> = {}): DocLine => ({ id: 'l1', description: 'ออกแบบ', qty: '1', unit: 'งาน', unitPrice: '1000.00', taxCode: 'S7', ...p });
let st: MockStateLike;
let vatCo: string;
let vatCustomer: string;

beforeEach(() => {
  st = seed();
  vatCo = st.companies.find((c) => c.vatRegistered)!.id;
  vatCustomer = st.parties.find((p) => p.companyId === vatCo && p.kind === 'customer' && p.vatRegistered && p.taxId)!.id;
});

describe('drafts and issue', () => {
  it('one idempotency key = one draft', () => {
    const a = createDraft(st, vatCo, 'TI', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k1');
    const b = createDraft(st, vatCo, 'TI', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k1');
    expect(b.id).toBe(a.id);
  });
  it('stale version is refused', () => {
    const d = createDraft(st, vatCo, 'TI', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k2');
    updateDraft(st, d.id, { header: d.header, lines: [line({ qty: '2' })] }, d.version, me);
    expect(() => updateDraft(st, d.id, { header: d.header, lines: [line()] }, d.version, me)).toThrow(/doc.version_conflict/);
  });
  it('issue allocates the next number, writes journal, revision 0, activity and audit', () => {
    const d = createDraft(st, vatCo, 'TI', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k3');
    const before = { act: st.activity.length, aud: st.audit.length };
    const done = issue(st, d.id, d.version, me);
    expect(done.number).toMatch(/^TI-202610-\d{4}$/);
    expect(done.status).toBe('issued');
    expect(st.journals.find((j) => j.docId === d.id)?.preview.entries[0].lines.length).toBeGreaterThan(0);
    expect(st.revisions.filter((r) => r.docId === d.id).map((r) => r.revision)).toEqual([0]);
    expect(st.activity.length).toBe(before.act + 1);
    expect(st.audit.length).toBe(before.aud + 1);
  });
  it('issue is refused while something is missing (VAT buyer without TIN)', () => {
    const noTin = st.parties.find((p) => p.companyId === vatCo && p.kind === 'customer' && p.vatRegistered && !p.taxId)!.id;
    const d = createDraft(st, vatCo, 'TI', { header: { partyId: noTin, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k4');
    expect(compute(st, vatCo, 'TI', { header: d.header, lines: d.lines }).missing.length).toBeGreaterThan(0);
  });
  it('cancel keeps the number and the next issue never reuses it', () => {
    const d = createDraft(st, vatCo, 'TI', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k5');
    const a = issue(st, d.id, d.version, me);
    const c = cancel(st, a.id, a.version, 'WRONG_PARTY', 'ออกผิดราย', me);
    expect(c.number).toBe(a.number);
    expect(c.status).toBe('cancelled');
    const e = createDraft(st, vatCo, 'TI', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k6');
    expect(issue(st, e.id, e.version, me).number).not.toBe(a.number);
  });
});

describe('revisions (classes N and L)', () => {
  it('an N-class revision keeps the number, bumps the revision and records a diff', () => {
    const qt = st.docs.find((d) => d.companyId === vatCo && d.type === 'QT' && d.status === 'issued')!;
    const r = revise(st, qt.id, { header: { ...qt.header, notes: 'ยืนราคา 45 วัน' }, lines: qt.lines }, qt.version, 'ลูกค้าขอขยายเวลา', me);
    expect(r.number).toBe(qt.number);
    expect(r.revision).toBe(qt.revision + 1);
    const rev = st.revisions.find((x) => x.docId === qt.id && x.revision === r.revision)!;
    expect(rev.diff).toContainEqual({ path: 'header.notes', before: qt.header.notes ?? null, after: 'ยืนราคา 45 วัน' });
  });
});

describe('convert', () => {
  it('refuses more than the remaining quantity and returns quantity when the target is cancelled', () => {
    const so = st.docs.find((d) => d.companyId === vatCo && d.type === 'SO' && d.status === 'issued'
      && !st.links.some((l) => l.kind === 'converted_from' && l.to === d.id && l.active))!; // an undelivered SO
    const l = so.lines[0];
    const half = String(Number(l.qty) / 2);
    const do1 = convert(st, so.id, 'DO', [{ sourceLineId: l.id, qty: half }], me);
    expect(() => convert(st, so.id, 'DO', [{ sourceLineId: l.id, qty: l.qty }], me)).toThrow(/doc.over_conversion/);
    const issued = issue(st, do1.id, do1.version, me);
    cancel(st, issued.id, issued.version, 'OTHER', 'ทดสอบ', me);
    expect(() => convert(st, so.id, 'DO', [{ sourceLineId: l.id, qty: l.qty }], me)).not.toThrow();
  });
});
```
Create `frontend/src/mocks/engine/test-helpers.ts` re-exporting `Actor`, `DocLine` from `@/domain/types` and
`type MockStateLike = MockState` from `../store`.

- [ ] **Step 2: Write the failing correction tests**

`frontend/src/mocks/engine/corrections.test.ts`
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { seed } from '../store';
import { correctionPlan, executePlan } from './corrections';
import type { MockStateLike } from './test-helpers';

const me = { kind: 'user' as const, id: 'u-1', name: 'สมศรี บัญชีดี' };
let st: MockStateLike;
let paidTi: MockStateLike['docs'][number];

beforeEach(() => {
  st = seed();
  paidTi = st.docs.find((d) => d.type === 'TI' && d.status === 'settled' && !d.locks.length)!;
});

describe('chain-aware corrections (SP0 §7.11)', () => {
  it('non-fiscal change on an issued TI = one revise step', () => {
    const plan = correctionPlan(st, paidTi.id, { header: { ...paidTi.header, notes: 'อ้างอิง PO 4471' }, lines: paidTi.lines }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['revise']);
  });
  it('customer change on a paid TI = cancel RC, reissue TI, reissue RC', () => {
    const other = st.parties.find((p) => p.kind === 'customer' && p.id !== paidTi.header.partyId && p.vatRegistered && p.taxId)!;
    const plan = correctionPlan(st, paidTi.id, { header: { ...paidTi.header, partyId: other.id }, lines: paidTi.lines }, 'accountant');
    expect(plan.steps.map((s) => [s.action, s.docType])).toEqual([['cancel', 'RC'], ['reissue', 'TI'], ['reissue', 'RC']]);
    expect(plan.missingPermissions).toEqual([]);
  });
  it('lower total = propose a credit note for the difference', () => {
    const lines = paidTi.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: '1.00' } : l));
    const plan = correctionPlan(st, paidTi.id, { header: paidTi.header, lines }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['issue_cn']);
  });
  it('an operator sees the missing permissions', () => {
    const other = st.parties.find((p) => p.kind === 'customer' && p.id !== paidTi.header.partyId && p.vatRegistered && p.taxId)!;
    const plan = correctionPlan(st, paidTi.id, { header: { ...paidTi.header, partyId: other.id }, lines: paidTi.lines }, 'operator');
    expect(plan.missingPermissions).toEqual(expect.arrayContaining(['doc.RC.cancel', 'doc.TI.correct']));
  });
  it('executing the plan is all-or-nothing and keeps date and total', () => {
    const other = st.parties.find((p) => p.kind === 'customer' && p.id !== paidTi.header.partyId && p.vatRegistered && p.taxId)!;
    const plan = correctionPlan(st, paidTi.id, { header: { ...paidTi.header, partyId: other.id }, lines: paidTi.lines }, 'accountant');
    const result = executePlan(st, plan.planId, plan.planHash, me);
    const newTi = result.affected.find((a) => a.type === 'TI' && a.status === 'settled')!;
    const doc = st.docs.find((d) => d.id === newTi.docId)!;
    expect(doc.header.documentDate).toBe(paidTi.header.documentDate);
    expect(doc.totals.total).toBe(paidTi.totals.total);
    expect(doc.replacesId).toBe(paidTi.id);
    expect(st.docs.find((d) => d.id === paidTi.id)!.status).toBe('replaced');
  });
  it('a stale plan hash is refused and nothing changes', () => {
    const plan = correctionPlan(st, paidTi.id, { header: { ...paidTi.header, notes: 'x' }, lines: paidTi.lines }, 'accountant');
    const snapshot = JSON.stringify(st);
    expect(() => executePlan(st, plan.planId, 'stale', me)).toThrow(/correction.plan_stale/);
    expect(JSON.stringify(st)).toBe(snapshot);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `corepack pnpm vitest run src/mocks/engine/commands.test.ts src/mocks/engine/corrections.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

Rules the implementation must follow (each covered by a test above or in Step 1/2):
- Errors are thrown as `new MockError(status, code, title)`; handlers map them to `problem(...)`.
- `issue` validates with `compute(...).missing`: no party; no lines; VAT-registered buyer without TIN or branch
  (`ผู้ซื้อจดทะเบียน VAT ต้องมีเลขผู้เสียภาษีและสาขา`); TI on a non-VAT company.
- `ledgerFor` posting rules for the mock (company-default profile): TI → Dr `1130 ลูกหนี้การค้า` total / Cr `4100
  รายได้จากการขายและบริการ` net / Cr `2151 ภาษีขาย` vat, `rule` = `company default`; RC → Dr `1120 เงินฝากธนาคาร`
  received / Dr `1180 ภาษีถูกหัก ณ ที่จ่าย` WHT / Cr `1130` total; CN → mirror of TI for its amount; reversal entries
  swap debit and credit and carry `kind: 'reversal'`.
- `revise` on class L writes `[reversal of previous entry, new entry]` with `kind: 'correction'`.
- `executePlan` recomputes the plan from current state and compares `planHash`
  (`hash = sha256(JSON.stringify(steps))` via `crypto.subtle` is async — use a small sync FNV-1a over the JSON
  instead); runs every step against `structuredClone(st)`; only on success copies the clone back into `st`.
- Every command appends exactly one `AuditEntry` and at least one `ActivityEntry`; revisions are written on issue
  (revision 0) and on every revise / reissue.
- `buildChain` walks links in both directions from the document; `progress` for SO/DO = `delivered/ordered`, for TI
  = `ชำระแล้ว x / y`.
- `seed()` (Task 4) now fills `journals` with `ledgerFor` for every issued, settled or cancelled document
  (cancelled ones get their reversal entry too).

- [ ] **Step 5: Wire the write handlers**

`handlers/docs-write.ts` maps each route to the command, persists with `saveState`, honours `Idempotency-Key` on
`POST /docs/:type`, and checks permissions: create → `doc.<type>.create`; issue → `.issue`; cancel → `.cancel`;
correction-plan → read; `/corrections` → every permission named in the plan's steps.

`GET /docs/:type/:id/paper` returns `PaperModel` (defined in Task 13; until then return `{}` and let Task 13 replace
it).

- [ ] **Step 6: Run the tests**

Run: `corepack pnpm vitest run src/mocks`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/mocks
git commit -m "feat(mock): document commands, chain, journal preview, logs and chain-aware corrections"
```

---

### Task 6: API client, query keys, mock toolbar

**Files:**
- Create: `frontend/src/lib/api/client.ts`, `client.test.ts`, `frontend/src/lib/api/endpoints.ts`,
  `frontend/src/lib/query/keys.ts`, `keys.test.ts`, `frontend/src/lib/query/QueryProvider.tsx`,
  `frontend/src/mocks/MockToolbar.tsx`, `frontend/src/mocks/MockToolbar.test.tsx`,
  `frontend/src/test/next-navigation.ts` (router stand-in for unit tests)

**Interfaces:**
- Produces:
  - `class ApiError extends Error { problem: ApiProblem; code: string }`
  - `api<T>(method, path, body?, opts?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<T>`
  - `normalizeProblem(status: number, body: unknown): ApiProblem`
  - `endpoints` — one typed function per route of Tasks 4–5 (e.g. `listDocs(type, params)`, `getDoc(type, id)`,
    `createDoc`, `updateDoc`, `deleteDoc`, `computeDocument`, `issueDoc`, `cancelDoc`, `getCorrectionPlan`,
    `executeCorrection`, `convertDoc`, `getChain`, `getActivity`, `getRevisions`, `getLedger`, `getPaper`, `getMe`,
    `setActiveCompany`, `getHome`, `searchParties`, `searchItems`, `search`)
  - `qk` — query keys, each starting with `companyId`: `qk.docs(c, type, params)`, `qk.doc(c, type, id)`,
    `qk.chain(c, id)`, `qk.activity(c, id)`, `qk.revisions(c, id)`, `qk.ledger(c, id)`, `qk.home(c)`, `qk.me()`
  - `<MockToolbar>` — company, role, screen state, "รีเซ็ตข้อมูลตัวอย่าง"; mock mode only

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/api/client.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { normalizeProblem } from './client';

describe('normalizeProblem', () => {
  it('keeps a problem+json body', () => {
    expect(normalizeProblem(409, { title: 'มีคนแก้เอกสารนี้ก่อนคุณ', code: 'doc.version_conflict', status: 409 }))
      .toMatchObject({ code: 'doc.version_conflict', status: 409 });
  });
  it('fills code and title for an empty or non-JSON body', () => {
    expect(normalizeProblem(502, undefined)).toMatchObject({ code: 'http.502', status: 502 });
    expect(normalizeProblem(500, '<html>')).toMatchObject({ code: 'http.500' });
  });
  it('never returns an empty title', () => {
    expect(normalizeProblem(418, {}).title.length).toBeGreaterThan(0);
  });
});
```

`frontend/src/test/next-navigation.ts` (used by every component test through
`vi.mock('next/navigation', () => import('@/test/next-navigation'))`)
```ts
import { vi } from 'vitest';

let params = new URLSearchParams();
const go = (u: string) => { params = new URL(u, 'http://localhost').searchParams; };
const router = { push: vi.fn(go), replace: vi.fn(go), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
export const useRouter = () => router;
export const useSearchParams = () => params;
export const usePathname = () => '/';
export const notFound = () => { throw new Error('notFound'); };
export const __setSearch = (s: string) => { params = new URLSearchParams(s); };
```

`frontend/src/lib/query/keys.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { qk } from './keys';

describe('query keys', () => {
  it('every company-scoped key starts with the company id (no cross-company cache hits)', () => {
    expect(qk.docs('co-vat', 'TI', { status: 'issued' })[0]).toBe('co-vat');
    expect(qk.doc('co-vat', 'TI', 'd1')[0]).toBe('co-vat');
    expect(qk.home('co-nonvat')[0]).toBe('co-nonvat');
    expect(qk.docs('a', 'TI', {})).not.toEqual(qk.docs('b', 'TI', {}));
  });
});
```

`frontend/src/mocks/MockToolbar.test.tsx`
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MockToolbar } from './MockToolbar';
import { getSettings } from './settings';

vi.mock('next/navigation', () => import('@/test/next-navigation'));

describe('MockToolbar', () => {
  it('switching company stores it and invalidates every query', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    render(<QueryClientProvider client={qc}><MockToolbar defaultOpen /></QueryClientProvider>);
    await userEvent.selectOptions(screen.getByLabelText('บริษัท'), 'nonvat');
    expect(getSettings().companyKey).toBe('nonvat');
    expect(spy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `corepack pnpm vitest run src/lib src/mocks/MockToolbar.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the client**

`frontend/src/lib/api/client.ts`
```ts
import type { ApiProblem } from '@/domain/types';

export class ApiError extends Error {
  constructor(public problem: ApiProblem) { super(problem.title); }
  get code() { return this.problem.code; }
}

const FALLBACK: Record<number, string> = {
  400: 'ข้อมูลไม่ถูกต้อง', 401: 'กรุณาเข้าสู่ระบบอีกครั้ง', 403: 'คุณไม่มีสิทธิ์ทำรายการนี้',
  404: 'ไม่พบข้อมูลที่ต้องการ', 409: 'ข้อมูลถูกแก้ไขโดยผู้อื่น โหลดใหม่แล้วลองอีกครั้ง',
};

export function normalizeProblem(status: number, body: unknown): ApiProblem {
  const b = body && typeof body === 'object' ? (body as Partial<ApiProblem>) : {};
  return {
    ...b,
    status,
    code: b.code ?? `http.${status}`,
    title: b.title || FALLBACK[status] || 'เชื่อมต่อระบบไม่สำเร็จ ลองใหม่อีกครั้ง',
  };
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown,
  opts: { idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
  // absolute URL: same origin in the browser; jsdom's http://localhost:3000 in Vitest (undici rejects relative URLs)
  const res = await fetch(new URL(`/bff/v1${path}`, window.location.origin), {
    method,
    headers: { 'content-type': 'application/json', ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  if (!res.ok) throw new ApiError(normalizeProblem(res.status, json));
  return json as T;
}
```

- [ ] **Step 4: Implement keys, endpoints, provider and toolbar**

`keys.ts` — every key is `[companyId, ...]` except `qk.me()`. `QueryProvider` — `staleTime: 30_000`, no retry on
4xx, one retry otherwise. `MockToolbar` — a small fixed panel bottom-left, collapsed to a button "โหมดตัวอย่าง";
three labelled `<select>`s (บริษัท / บทบาท / สถานะหน้าจอ) and the reset button; every change calls `setSettings`,
`queryClient.invalidateQueries()` and `router.refresh()`; rendered only when mocks are enabled.

- [ ] **Step 5: Run the tests and commit**

Run: `corepack pnpm vitest run src/lib src/mocks/MockToolbar.test.tsx` — Expected: PASS.

```bash
git add frontend/src/lib frontend/src/test/next-navigation.ts frontend/src/mocks/MockToolbar.tsx frontend/src/mocks/MockToolbar.test.tsx
git commit -m "feat(frontend): typed API client, company-scoped query keys, mock toolbar"
```

---

### Task 7: App shell, navigation, i18n, formatting, Home

**Files:**
- Create: `frontend/src/i18n/request.ts`, `frontend/src/messages/th.json`, `frontend/src/messages/en.json`,
  `frontend/src/lib/format.ts`, `format.test.ts`, `frontend/src/app-shell/nav.ts`, `nav.test.ts`,
  `frontend/src/app-shell/{Sidebar,CompanySwitcher,Topbar,Breadcrumbs,CommandMenu,ComingInSp1c}.tsx`,
  `frontend/src/app/(app)/layout.tsx`, `frontend/src/app/(app)/page.tsx`, `frontend/src/app/(app)/[...slug]/page.tsx`,
  `frontend/e2e/shell.spec.ts`
- Modify: `frontend/src/app/layout.tsx` (fonts, providers)

**Interfaces:**
- Produces:
  - `formatDateBE(d: IsoDate): string`, `formatMoney(m: Money): string`, `formatTHB(m: Money): string`
  - `interface NavItem { key: string; labelKey: string; href: string; permission?: string; vatOnly?: boolean; nonVatOnly?: boolean }`,
    `interface NavGroup { key: string; labelKey: string; items: NavItem[] }`, `NAV: NavGroup[]`,
    `visibleNav(nav, ctx: { permissions: string[]; vatRegistered: boolean }): NavGroup[]`
  - Shell layout used by every `(app)` page; `<ComingInSp1c title />` for nav routes not built yet

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/format.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { formatDateBE, formatMoney, formatTHB } from './format';

describe('format', () => {
  it('Buddhist-era date', () => expect(formatDateBE('2026-10-14')).toBe('14 ต.ค. 2569'));
  it('money with grouping, 2 dp, from a string (no float)', () => {
    expect(formatMoney('64200')).toBe('64,200.00');
    expect(formatMoney('-1234567.5')).toBe('-1,234,567.50');
    expect(formatMoney('99999999999999.99')).toBe('99,999,999,999,999.99');
  });
  it('THB', () => expect(formatTHB('64200.00')).toBe('฿64,200.00'));
});
```

`frontend/src/app-shell/nav.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { PERMISSIONS_BY_ROLE } from '@/mocks/permissions';
import { NAV, visibleNav } from './nav';

const labels = (g: ReturnType<typeof visibleNav>) => g.flatMap((x) => x.items.map((i) => i.key));

describe('navigation', () => {
  it('has the ten groups of SP0 §9.1 in order', () => {
    expect(NAV.map((g) => g.key)).toEqual(['home', 'sales', 'purchases', 'finance', 'accounting', 'tax', 'payroll', 'reports', 'master', 'settings']);
  });
  it('hides VAT-only items for a non-VAT company and shows the invoice instead', () => {
    const v = labels(visibleNav(NAV, { permissions: PERMISSIONS_BY_ROLE.accountant, vatRegistered: false }));
    expect(v).not.toContain('taxInvoices');
    expect(v).toContain('invoices');
  });
  it('hides items the role cannot read', () => {
    const v = labels(visibleNav(NAV, { permissions: PERMISSIONS_BY_ROLE.admin, vatRegistered: true }));
    expect(v).not.toContain('taxInvoices');
  });
  it('drops a group with no visible item', () => {
    const g = visibleNav(NAV, { permissions: [], vatRegistered: true }).map((x) => x.key);
    expect(g).toEqual(['home']);
  });
});
```

`frontend/e2e/shell.spec.ts`
```ts
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

test('accountant on the VAT company sees ขาย > ใบกำกับภาษี', async ({ page }) => {
  await expect(page.getByRole('navigation').getByRole('link', { name: 'ใบกำกับภาษี' })).toBeVisible();
});

test('switching to the non-VAT company hides ใบกำกับภาษี without a stale flash', async ({ page }) => {
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByLabel('บริษัท').selectOption('nonvat');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'ใบกำกับภาษี' })).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'ใบแจ้งหนี้' })).toBeVisible();
});

test('Ctrl+K opens the command menu', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('home has no serious accessibility violations', async ({ page }) => {
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `corepack pnpm vitest run src/lib/format.test.ts src/app-shell` — Expected: FAIL.

- [ ] **Step 3: Implement `format.ts`**

```ts
import type { IsoDate, Money } from '@/domain/types';

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

export function formatDateBE(iso: IsoDate): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}

export function formatMoney(m: Money): string {
  const neg = m.startsWith('-');
  const [i, f = ''] = m.replace('-', '').split('.');
  return `${neg ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(f + '00').slice(0, 2)}`;
}

export const formatTHB = (m: Money) => `฿${formatMoney(m)}`;
```

- [ ] **Step 4: Implement `nav.ts`**

Groups and items exactly as SP0 §9.1 (keys in English, labels via `th.json`). Item routes:
`/` · `/sales/{quotations,sales-orders,delivery-orders,invoices,billing-statements,tax-invoices,receipts,credit-notes,debit-notes}`
· `/purchases/{purchase-orders,bills,payment-vouchers,vendor-notes,expense-claims}` · `/finance/{bank-accounts,deposits}`
· `/accounting/{journals,chart-of-accounts,opening-balances,schedules,fixed-assets,period-close}`
· `/tax/{summary,vat,wht,cit}` · `/payroll/{employees,runs,filings}`
· `/reports/{financial-statements,receivables-payables,sales-purchases,audit}` · `/master/{customers,vendors,items}`
· `/settings/{company,users,posting,dimensions,tax,numbering,approvals,templates,connect}`.
`taxInvoices`, `creditNotes`, `debitNotes`, `vat` → `vatOnly`; `invoices` → `nonVatOnly`. Permissions:
`doc.<TYPE>.read` for document lists, `party.read`/`item.read` for master data, `settings.manage` for settings,
`ledger.read` for accounting, `audit.read` for the audit report. `visibleNav` filters items and drops empty groups;
Home has no permission.

- [ ] **Step 5: Implement the shell**

- Root `layout.tsx`: `next/font/google` for the UI font (the chosen direction replaces it in Task 9; use
  `IBM_Plex_Sans_Thai` now) and `Sarabun` (paper), `NextIntlClientProvider` (locale from cookie, default `th`),
  `QueryProvider`, `MockProvider`, `Toaster`, `MockToolbar`.
- `(app)/layout.tsx`: sidebar (company switcher at the top for every member; groups from `visibleNav`; active item
  by longest matching href), topbar with breadcrumbs (document numbers as links) and the `⌘K` hint.
- `CommandMenu`: shadcn `CommandDialog` on Ctrl/⌘+K; groups "สร้าง" (create actions for wired descriptors),
  "ไปที่" (visible nav items), "เอกสาร" (results of `search`); Enter navigates.
- Home: `getHome()` → approval inbox, my drafts, overdue, tax deadlines, unreconciled bank lines, agent digest, KPI
  strip; each section with its own loading, empty and error state.
- `(app)/[...slug]/page.tsx`: renders `<ComingInSp1c>` for paths in `NAV`, `notFound()` otherwise.
- Page titles: `<title>` = `{page} · TEAS 2`.

- [ ] **Step 6: Run unit and e2e tests**

Run: `corepack pnpm vitest run && corepack pnpm e2e e2e/shell.spec.ts`
Expected: all pass, axe clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src frontend/e2e/shell.spec.ts
git commit -m "feat(frontend): app shell, navigation by role and VAT status, command menu, Home inbox"
```

---

### Task 8: SP1a — three style tiles, then Ham picks one (GATE)

**Files:**
- Create: `frontend/src/app/style-tiles/page.tsx`, `frontend/src/style-tiles/{tokens-a.css,tokens-b.css,tokens-c.css,TileSurfaces.tsx}`,
  `docs/specs/SP1a-style-tiles.md`, `frontend/e2e/style-tiles.spec.ts`

**Interfaces:**
- Produces: the chosen tile id (`a` | `b` | `c`) recorded in `docs/specs/SP1a-style-tiles.md`; Task 9 consumes its
  tokens.

- [ ] **Step 1: Research and write the direction brief**

Load the `impeccable` skill. Use `lazyweb` quick search for "accounting app invoice editor", "Thai accounting
software" (FlowAccount, PEAK) and Xero / QuickBooks list and invoice screens. Write
`docs/specs/SP1a-style-tiles.md` with three directions:
- **A — บัญชีแยกประเภท (Ledger):** paper-white surfaces, deep green ink and accent, hairline rules, IBM Plex Sans
  Thai, compact density (36 px table rows, radius 6).
- **B — TEAS ต่อเนื่อง (Continuity):** TEAS 1's warm peach accent and ink neutrals, modernised (accent darkened until
  white text passes WCAG AA), Noto Sans Thai, 40 px rows, radius 10.
- **C — Designer's proposal:** must differ clearly from A and B; justify it from the research.
Each direction lists: font pair (UI + paper; paper stays Sarabun unless argued), type scale, 6–8 colour tokens with
contrast ratios, radius, row height, focus ring, status-chip palette.

- [ ] **Step 2: Build the tiles**

`/style-tiles` shows a switch A / B / C; each tile scopes its tokens with `[data-tile="a|b|c"]` and renders the
same four surfaces with real shadcn components and fixture data: (1) type and colour sheet; (2) tax-invoice list
(10 rows, status chips, outstanding column); (3) new tax invoice editor (party chip, 3 lines, totals panel);
(4) A4 tax-invoice paper preview (static composition, Sarabun).

- [ ] **Step 3: Test**

`frontend/e2e/style-tiles.spec.ts`
```ts
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const tile of ['a', 'b', 'c']) {
  test(`tile ${tile} renders four surfaces and passes axe`, async ({ page }) => {
    await page.goto(`/style-tiles#${tile}`);
    for (const name of ['ตัวอักษรและสี', 'รายการใบกำกับภาษี', 'สร้างใบกำกับภาษี', 'ตัวอย่างกระดาษ A4']) {
      await expect(page.getByRole('heading', { name })).toBeVisible();
    }
    const r = await new AxeBuilder({ page }).include(`[data-tile="${tile}"]`).analyze();
    expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);
  });
}
```
Run: `corepack pnpm e2e e2e/style-tiles.spec.ts` — Expected: 3 pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/style-tiles frontend/src/style-tiles frontend/e2e/style-tiles.spec.ts docs/specs/SP1a-style-tiles.md
git commit -m "feat(frontend): SP1a style tiles A/B/C"
```

- [ ] **Step 5: GATE — Ham picks**

Capture each tile at 1440×900 with Playwright into the scratchpad (not the repo), send the three images with
SendUserFile, and ask with AskUserQuestion: "เลือก visual direction" — options A / B / C (+ notes). Record the pick
and notes in `docs/specs/SP1a-style-tiles.md` (Status: Approved, date) and in `STATUS.md`; commit
`docs: SP1a direction chosen`. Do not start Task 9 before the answer.

---

### Task 9: Apply the chosen direction — tokens, style guide, design-system doc

**Files:**
- Create: `frontend/src/styles/tokens.css`, `frontend/src/app/style-guide/page.tsx`, `docs/specs/SP1-design-system.md`,
  `frontend/e2e/style-guide.spec.ts`
- Modify: `frontend/src/app/globals.css` (Tailwind v4 `@theme` mapped to tokens), `frontend/src/app/layout.tsx` (fonts),
  shadcn component variants where the direction needs it
- Delete: `frontend/src/app/style-tiles/`, `frontend/src/style-tiles/`, `frontend/e2e/style-tiles.spec.ts`

**Interfaces:**
- Produces: CSS custom properties `--color-*`, `--font-ui`, `--font-paper`, `--radius-*`, `--row-h`, `--focus-ring`;
  `docs/specs/SP1-design-system.md` — the reference every later UI task follows.

- [ ] **Step 1: Write the design-system doc**

Sections: tokens (table: name, value, use, contrast); typography scale (Thai body line-height ≥ 1.6); density; the
five state patterns (loading skeleton, empty with next step, error with retry and trace id, forbidden naming the
permission, locked banner with exits); action hierarchy (one primary per screen); confirm-dialog anatomy; the 12 UX
rules of SP0 §9.3 mapped to the component that enforces each.

- [ ] **Step 2: Implement tokens and the style guide**

`/style-guide` shows tokens, type scale, buttons (all states), inputs (error, disabled), chips for every
`DocStatus`, the five state patterns, a sample table and the confirm dialog.

- [ ] **Step 3: Test**

`frontend/e2e/style-guide.spec.ts`
```ts
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('style guide shows every status chip and passes axe', async ({ page }) => {
  await page.goto('/style-guide');
  for (const s of ['ร่าง', 'รออนุมัติ', 'อนุมัติแล้ว', 'ออกแล้ว', 'ชำระบางส่วน', 'ชำระครบ', 'ยกเลิก', 'ถูกแทนที่']) {
    await expect(page.getByText(s, { exact: true }).first()).toBeVisible();
  }
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);
});
```
Run: `corepack pnpm e2e e2e/style-guide.spec.ts e2e/shell.spec.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A frontend/src frontend/e2e docs/specs/SP1-design-system.md
git status --short   # check the list: only frontend/src, frontend/e2e and the doc
git commit -m "feat(frontend): design tokens, style guide and design-system reference"
```

---

### Task 10: Kit — DocList

**Files:**
- Create: `frontend/src/kit/states/{LoadingState,EmptyState,ErrorState,ForbiddenState,NotAvailableState}.tsx`,
  `frontend/src/kit/doc-list/{DocList,useDocListParams,SavedViews,BulkBar,StatusChip}.tsx`,
  `frontend/src/kit/doc-list/DocList.test.tsx`

**Interfaces:**
- Consumes: `endpoints.listDocs`, `qk.docs`, `DocDescriptor`, `routesOf`.
- Produces:
```ts
export interface DocListColumn { key: string; header: string; align?: 'start' | 'end'; cell: (row: DocSummary) => React.ReactNode }
export interface BulkAction { key: string; label: string; permission: string; run: (ids: string[]) => Promise<void> }
export interface SavedView { key: string; label: string; params: Record<string, string> }
export interface DocListProps { descriptor: DocDescriptor; columns: DocListColumn[]; savedViews: SavedView[]; bulkActions: BulkAction[] }
export function DocList(props: DocListProps): JSX.Element
export function StatusChip(props: { status: DocStatus }): JSX.Element
```

- [ ] **Step 1: Write the failing tests**

`frontend/src/kit/doc-list/DocList.test.tsx`
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { taxInvoice } from '@/descriptors/tax-invoice';
import { DocList } from './DocList';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const ui = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <DocList descriptor={taxInvoice} columns={[{ key: 'number', header: 'เลขที่', cell: (r) => r.number ?? 'ร่าง' }]}
      savedViews={[{ key: 'overdue', label: 'เกินกำหนด', params: { status: 'issued', overdue: '1' } }]} bulkActions={[]} />
  </QueryClientProvider>);

describe('DocList', () => {
  it('shows rows from the server', async () => {
    ui();
    expect(await screen.findAllByRole('row')).not.toHaveLength(0);
  });
  it('an error is an error state, never "no data" (TEAS 1 XC-01)', async () => {
    setSettings({ screenState: 'error' });
    ui();
    expect(await screen.findByRole('alert')).toHaveTextContent('ระบบขัดข้องชั่วคราว');
    expect(screen.queryByText(/ยังไม่มี/)).toBeNull();
    expect(screen.getByRole('button', { name: 'ลองใหม่' })).toBeVisible();
  });
  it('forbidden names the permission', async () => {
    setSettings({ screenState: 'forbidden' });
    ui();
    expect(await screen.findByText(/ไม่มีสิทธิ์/)).toBeVisible();
  });
  it('empty state offers the next step', async () => {
    setSettings({ screenState: 'empty' });
    ui();
    expect(await screen.findByRole('link', { name: /สร้างใบกำกับภาษี/ })).toBeVisible();
  });
  it('"/" focuses search', async () => {
    ui();
    await screen.findAllByRole('row');
    await userEvent.keyboard('/');
    expect(screen.getByRole('searchbox')).toHaveFocus();
  });
  it('selecting rows shows the bulk bar with the count', async () => {
    ui();
    const rows = await screen.findAllByRole('row');
    await userEvent.click(within(rows[1]).getByRole('checkbox'));
    expect(screen.getByText('เลือก 1 รายการ')).toBeVisible();
  });
});
```
(`@/descriptors/tax-invoice` is created in Task 14 Step 3; create it now with the values listed there so this test
compiles.)

- [ ] **Step 2: Run to verify they fail** — `corepack pnpm vitest run src/kit/doc-list` → FAIL.

- [ ] **Step 3: Implement**

Behaviour list:
- `useDocListParams` reads `useSearchParams`, so every page that renders `DocList` wraps it in
  `<Suspense fallback={<LoadingState />}>` — without it `next build` fails (and the Playwright web server with it).
  The same applies to any other client component that reads search params (`/mock/screens`, the editor's `?from=`).
- Server-side paging with "โหลดเพิ่ม" (cursor); 25 rows per page.
- Filters in the URL: `status`, `q`, `from`, `to`, `view`; changing a filter resets the cursor.
- Saved views: descriptor presets + user views kept in `localStorage['teas2.views.<type>']` (try/catch).
- Row checkboxes; bulk bar with count and the actions the user holds permission for (disabled actions show the
  missing permission in a tooltip).
- Keyboard: `/` focuses search, `N` opens `routesOf(d).create` when the user may create.
- States: loading → `LoadingState` (skeleton rows); error → `ErrorState` (`role="alert"`, title from the problem,
  "ลองใหม่", trace id); 403 → `ForbiddenState` (names `detail` permission); 404 `doc.type_not_available` →
  `NotAvailableState` ("ใช้ได้เฉพาะบริษัทที่จดทะเบียน VAT"); empty → `EmptyState` with the create link.
- Agent-created rows show an "agent" chip; overdue rows show days overdue.

- [ ] **Step 4: Run tests** — `corepack pnpm vitest run src/kit/doc-list` → PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/kit/states frontend/src/kit/doc-list frontend/src/descriptors/tax-invoice.ts
git commit -m "feat(kit): DocList with server paging, saved views, bulk bar and the five states"
```

---

### Task 11: Kit — DocEditor (keyboard-first)

**Files:**
- Create: `frontend/src/kit/doc-editor/{DocEditor,PartyField,ItemField,LineGrid,useLineGridKeys,TotalsPanel,MissingSummary,useCompute,useAutosave,PreviewDrawer,JournalDrawer}.tsx`,
  `frontend/src/kit/dialogs/ConfirmIssueDialog.tsx`, `frontend/src/kit/doc-editor/DocEditor.test.tsx`,
  `frontend/src/kit/doc-editor/LineGrid.test.tsx`

**Interfaces:**
- Consumes: endpoints `createDoc`, `updateDoc`, `computeDoc`, `issueDoc`, `searchParties`, `searchItems`.
- Produces:
```ts
export interface DocEditorProps {
  descriptor: DocDescriptor;
  mode: 'create' | 'edit-draft' | 'revise';
  initial?: Doc;
  onIssued: (doc: Doc) => void;
  onRevisionRequested?: (proposed: { header: DocHeader; lines: DocLine[] }) => void; // revise mode: hands off to the correction plan
}
export function DocEditor(props: DocEditorProps): JSX.Element
export function ConfirmIssueDialog(props: { open: boolean; title: string; totals: DocTotals; onConfirm: () => void; onCancel: () => void }): JSX.Element
```

- [ ] **Step 1: Write the failing tests**

`frontend/src/kit/doc-editor/DocEditor.test.tsx`
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { taxInvoice } from '@/descriptors/tax-invoice';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { DocEditor } from './DocEditor';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
const calls: string[] = [];
beforeAll(() => testServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { testServer.resetHandlers(); testServer.events.removeAllListeners(); });
afterAll(() => testServer.close());
beforeEach(() => {
  localStorage.clear(); resetState(); calls.length = 0;
  setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' });
  testServer.events.on('request:start', ({ request }) => calls.push(`${request.method} ${new URL(request.url).pathname}`));
});

const ui = (onIssued = vi.fn()) => {
  render(<QueryClientProvider client={new QueryClient()}><DocEditor descriptor={taxInvoice} mode="create" onIssued={onIssued} /></QueryClientProvider>);
  return onIssued;
};

describe('DocEditor', () => {
  it('Enter picks the highlighted customer and prefills the usual item', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText(/0105568024684/)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'รายการ 1' })).toHaveValue('ออกแบบอัตลักษณ์องค์กร');
  });
  it('Enter while composing text does nothing', async () => {
    ui();
    const box = screen.getByRole('combobox', { name: 'ลูกค้า' });
    await userEvent.type(box, 'นาวา');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    expect(screen.queryByText(/0105568024684/)).toBeNull();
  });
  it('no match keeps the typed text and lists the gap in "ยังขาดอะไร"', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'ไม่มีชื่อนี้{Enter}');
    expect(screen.getByRole('combobox', { name: 'ลูกค้า' })).toHaveValue('ไม่มีชื่อนี้');
    expect(await screen.findByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('เลือกลูกค้า');
  });
  it('totals come from the compute endpoint, not the browser', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await waitFor(() => expect(calls).toContain('POST /bff/v1/docs/TI/compute'));
    expect(screen.getByRole('region', { name: 'ยอดรวม' })).toHaveTextContent(/บาท/);
  });
  it('autosave creates one draft per editor session and updates it afterwards', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await waitFor(() => expect(calls.filter((c) => c === 'POST /bff/v1/docs/TI')).toHaveLength(1), { timeout: 4000 });
    await userEvent.type(screen.getByRole('textbox', { name: 'หมายเหตุ' }), 'ส่งภายในวันศุกร์');
    await waitFor(() => expect(calls.some((c) => c.startsWith('PUT /bff/v1/docs/TI/'))).toBe(true), { timeout: 4000 });
    expect(calls.filter((c) => c === 'POST /bff/v1/docs/TI')).toHaveLength(1);
  });
  it('Ctrl+Enter opens the confirm dialog with totals; Enter issues', async () => {
    const onIssued = ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await waitFor(() => expect(screen.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('ครบแล้ว'));
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('รวมทั้งสิ้น');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onIssued).toHaveBeenCalledWith(expect.objectContaining({ status: 'issued' })));
  });
  it('a 409 on save tells the user and keeps their input', async () => {
    testServer.use(http.put('*/bff/v1/docs/TI/:id', () => new Response(JSON.stringify({ title: 'มีคนแก้เอกสารนี้ก่อนคุณ', code: 'doc.version_conflict', status: 409 }), { status: 409, headers: { 'content-type': 'application/problem+json' } })));
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await userEvent.type(screen.getByRole('textbox', { name: 'หมายเหตุ' }), 'x');
    expect(await screen.findByText('มีคนแก้เอกสารนี้ก่อนคุณ', {}, { timeout: 4000 })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'หมายเหตุ' })).toHaveValue('x');
  });
});
```

`frontend/src/kit/doc-editor/LineGrid.test.tsx`
```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DocLine } from '@/domain/types';
import { LineGrid } from './LineGrid';

const empty: DocLine = { id: 'l1', description: '', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'S7' };

describe('LineGrid keyboard', () => {
  it('Tab walks description → qty → price; Enter on the last cell adds a row', async () => {
    const onChange = vi.fn();
    render(<LineGrid lines={[empty]} onChange={onChange} searchItems={async () => []} />);
    await userEvent.click(screen.getByRole('textbox', { name: 'รายการ 1' }));
    await userEvent.tab();
    expect(screen.getByRole('textbox', { name: 'จำนวน 1' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('textbox', { name: 'ราคาต่อหน่วย 1' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'l1' }), expect.objectContaining({ description: '' })]));
  });
  it('pasting rows from a spreadsheet creates lines', () => {
    const onChange = vi.fn();
    render(<LineGrid lines={[empty]} onChange={onChange} searchItems={async () => []} />);
    fireEvent.paste(screen.getByRole('textbox', { name: 'รายการ 1' }), {
      clipboardData: { getData: () => 'ค่าออกแบบ\t2\t1500\nค่าพิมพ์\t100\t8.50' },
    });
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ description: 'ค่าออกแบบ', qty: '2', unitPrice: '1500.00' }),
      expect.objectContaining({ description: 'ค่าพิมพ์', qty: '100', unitPrice: '8.50' }),
    ]);
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `corepack pnpm vitest run src/kit/doc-editor` → FAIL.

- [ ] **Step 3: Implement**

Key logic to implement exactly:

`useLineGridKeys.ts`
```ts
import type { KeyboardEvent } from 'react';

export type Cell = 'description' | 'qty' | 'unitPrice';
const ORDER: Cell[] = ['description', 'qty', 'unitPrice'];

export function nextCell(row: number, cell: Cell, rows: number, back = false): { row: number; cell: Cell } | 'add-row' | null {
  const i = ORDER.indexOf(cell) + (back ? -1 : 1);
  if (i >= 0 && i < ORDER.length) return { row, cell: ORDER[i] };
  if (!back && row + 1 < rows) return { row: row + 1, cell: ORDER[0] };
  if (!back) return 'add-row';
  return row > 0 ? { row: row - 1, cell: ORDER[ORDER.length - 1] } : null;
}

export const isComposing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

export function parseClipboardRows(text: string): { description: string; qty: string; unitPrice: string }[] {
  return text.trim().split(/\r?\n/).map((row) => {
    const [description = '', qty = '1', price = '0'] = row.split('\t');
    const n = Number(price.replace(/,/g, ''));
    return { description: description.trim(), qty: qty.trim() || '1', unitPrice: Number.isFinite(n) ? n.toFixed(2) : '0.00' };
  }).filter((r) => r.description);
}
```
Behaviour list:
- `PartyField` / `ItemField`: shadcn `Command` in a popover anchored to the input; debounced search (150 ms);
  `aria-activedescendant` highlighting; Enter accepts the highlighted match (ignored while `isComposing`); no match
  keeps free text; picking a customer applies payment terms (due date), dimensions and the first `usualItemIds` item
  to line 1 when line 1 is empty.
- `useCompute`: debounced 250 ms `POST /docs/:type/compute`; stale responses ignored (request id); while pending the
  totals panel shows "กำลังคำนวณ…" and the issue action waits.
- `MissingSummary`: region "ยังขาดอะไร" listing `missing[]`, or "ครบแล้ว".
- `useAutosave`: first change → `POST` with one idempotency key per editor session; later changes → `PUT` with the
  current `version`; every 2 s after the last change; flush on `visibilitychange: hidden`; a 409 shows the problem
  title and keeps local input; `beforeunload` warns only while a save is pending. After the first successful `POST`,
  `router.replace(routesOf(d).edit(id))` so a reload reopens the same draft.
- Shortcuts `Ctrl+Enter` (issue) and `Ctrl+S` (save) are handled by a capture-phase `keydown` listener on the editor
  root, so they work from any focused field (and are ignored while composing).
- Issue: `Ctrl+Enter` or the primary button opens `ConfirmIssueDialog` (shadcn `AlertDialog`, totals, Enter
  confirms, Escape cancels); confirm → flush autosave → `POST /issue` with the version → `onIssued(doc)`. Radix
  `AlertDialog` focuses Cancel on open — override with
  `onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus(); }}` so Enter confirms.
- `Ctrl+S` flushes the draft; the paper preview is a right-side `Sheet`, closed by default under 1700 px wide;
  `JournalDrawer` shows `compute.journal`.
- Revise mode: the primary action is "บันทึกการแก้ไข", which calls `onRevisionRequested` instead of issuing.

- [ ] **Step 4: Run tests** — `corepack pnpm vitest run src/kit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/kit/doc-editor frontend/src/kit/dialogs
git commit -m "feat(kit): keyboard-first DocEditor with server compute, autosave and confirm-issue"
```

---

### Task 12: Kit — DocView, chain, logs, locks, corrections

**Files:**
- Create: `frontend/src/kit/doc-view/{DocView,ActionBar,ChainPanel,LedgerTab,ActivityTimeline,RevisionHistory,LockBanner}.tsx`,
  `frontend/src/kit/dialogs/{CancelDialog,CorrectionPlanDialog}.tsx`, `frontend/src/kit/doc-view/DocView.test.tsx`

**Interfaces:**
- Consumes: endpoints `getDoc`, `getChain`, `getActivity`, `getRevisions`, `getLedger`, `cancelDoc`,
  `getCorrectionPlan`, `executeCorrection`; `Paper` (Task 13) inside the paper tab (stub until Task 13).
- Produces:
```ts
export interface DocViewProps { descriptor: DocDescriptor; id: string }
export function DocView(props: DocViewProps): JSX.Element
export function CorrectionPlanDialog(props: { plan: CorrectionPlan; onConfirm: () => void; onSendToApprover: () => void; onCancel: () => void }): JSX.Element
export function LockBanner(props: { locks: Lock[] }): JSX.Element | null
```

- [ ] **Step 1: Write the failing tests**

`frontend/src/kit/doc-view/DocView.test.tsx`
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { taxInvoice } from '@/descriptors/tax-invoice';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { DocView } from './DocView';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const ui = (id: string) => render(<QueryClientProvider client={new QueryClient()}><DocView descriptor={taxInvoice} id={id} /></QueryClientProvider>);
const find = (pred: (d: ReturnType<typeof loadState>['docs'][number]) => boolean) => loadState().docs.find(pred)!;

describe('DocView', () => {
  it('a replaced TI shows the pointer to its replacement in the chain', async () => {
    const replaced = find((d) => d.type === 'TI' && d.status === 'replaced');
    ui(replaced.id);
    const chain = await screen.findByRole('region', { name: 'เอกสารที่เกี่ยวข้อง' });
    expect(within(chain).getByText(/ออกแทนโดย/)).toBeVisible();
  });
  it('the filing lock is shown with its exit, and fiscal edit is disabled with the reason', async () => {
    setSettings({ screenState: 'locked' });
    const issued = find((d) => d.type === 'TI' && d.status === 'issued');
    ui(issued.id);
    expect(await screen.findByRole('status', { name: 'ล็อก' })).toHaveTextContent('ภ.พ.30');
    expect(screen.getByText(/ออกใบลดหนี้/)).toBeVisible();
  });
  it('cancel needs a reason code', async () => {
    const issued = find((d) => d.type === 'TI' && d.status === 'issued' && !d.locks.length);
    ui(issued.id);
    await userEvent.click(await screen.findByRole('button', { name: 'ยกเลิกเอกสาร' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'ยืนยันยกเลิก' })).toBeDisabled();
  });
  it('an operator sees disabled cancel with the missing permission', async () => {
    setSettings({ role: 'operator' });
    const issued = find((d) => d.type === 'TI' && d.status === 'issued' && !d.locks.length);
    ui(issued.id);
    const btn = await screen.findByRole('button', { name: 'ยกเลิกเอกสาร' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(/doc\.TI\.cancel/);
  });
  it('revision history shows the diff of a revised document', async () => {
    const revised = find((d) => d.type === 'QT' && d.revision > 0);
    render(<QueryClientProvider client={new QueryClient()}><DocView descriptor={{ ...taxInvoice, type: 'QT', correctionClass: 'N', basePath: '/sales/quotations' }} id={revised.id} /></QueryClientProvider>);
    await userEvent.click(await screen.findByRole('tab', { name: 'ประวัติการแก้ไข' }));
    expect(screen.getByText(/ฉบับแก้ไขครั้งที่ 1/)).toBeVisible();
  });
});
```
(Seed at least one QT with `revision ≥ 1` in Task 4's fixtures; add it there if missing.)

- [ ] **Step 2: Run to verify they fail** — `corepack pnpm vitest run src/kit/doc-view` → FAIL.

- [ ] **Step 3: Implement**

Behaviour list:
- Header: number (or "ร่าง"), status chip, party, document date (BE), total, outstanding; `LockBanner` under it
  (`role="status"`, `aria-label="ล็อก"`, reason + exits; lucide `Lock` icon, no emoji).
- Tabs: กระดาษ (paper) · เอกสารที่เกี่ยวข้อง (chain) · ผลต่อบัญชี (ledger) · กิจกรรม (activity) ·
  ประวัติการแก้ไข (revisions with field diffs; "ดูฉบับนี้" renders that snapshot's paper).
- `ActionBar`: one primary action by status (draft: "บันทึกและออก…"; issued: "แก้ไข"); secondary: พิมพ์, คัดลอกเป็นใบใหม่,
  ยกเลิกเอกสาร, แปลงเป็น… (only conversions the descriptor allows). A missing permission or a lock disables the
  action and sets `aria-describedby` to the reason (tooltip shows it).
- "แก้ไข" on an issued T-class document opens the editor in revise mode
  (`routesOf(d).edit(id)`); its `onRevisionRequested` calls `getCorrectionPlan` and opens `CorrectionPlanDialog`:
  explanation, ordered steps (action, document, amount), missing permissions; "ยืนยันทั้งหมด" executes the plan;
  missing permissions → the confirm button is disabled and "ส่งให้ผู้มีสิทธิ์อนุมัติ" adds the plan to the approval
  inbox (mock: an inbox entry); after execution, navigate to the newest affected document of the same type.
- `CancelDialog`: reason code select (`WRONG_PARTY`, `WRONG_AMOUNT`, `WRONG_ITEMS`, `DUPLICATE`, `OTHER`) + text;
  confirm disabled until a code is chosen (and text when `OTHER`).
- Chain panel: tree from `rootId`; cancelled/replaced nodes struck through with "ออกแทนโดย {number}"; each node links
  to its document (non-TI types go to their routes, which show "SP1c" placeholders for now).

- [ ] **Step 4: Run tests** — `corepack pnpm vitest run src/kit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/kit/doc-view frontend/src/kit/dialogs
git commit -m "feat(kit): DocView with chain, ledger, activity, revisions, locks and correction plans"
```

---

### Task 13: Paper — tax-invoice paper, pagination, print route

**Files:**
- Create: `frontend/src/kit/paper/{Paper,TaxInvoicePaper}.tsx`, `frontend/src/kit/paper/paginate.ts`,
  `paginate.test.ts`, `frontend/src/kit/paper/TaxInvoicePaper.test.tsx`, `frontend/src/kit/paper/paper.css`,
  `frontend/src/app/print/[type]/[id]/page.tsx`
- Modify: `frontend/src/domain/types.ts` (add `PaperModel`), `frontend/src/mocks/handlers/docs-write.ts`
  (`GET /docs/:type/:id/paper`)

**Interfaces:**
- Produces:
```ts
export interface PaperParty { name: string; address: string; taxId?: string; branchLabel?: string }
export interface PaperModel {
  titleTh: string; titleEn: string;            // 'ใบกำกับภาษี' / 'TAX INVOICE'
  copyLabel: 'ต้นฉบับ' | 'สำเนา';
  number: string; documentDate: IsoDate; dueDate?: IsoDate;
  seller: PaperParty; buyer: PaperParty;
  lines: { no: number; description: string; qty: Qty; unit: string; unitPrice: Money; amount: Money; taxCode: TaxCode }[];
  totals: DocTotals; notes?: string;
  replacementNote?: string;                    // 'ยกเลิกและออกแทนฉบับเดิม เลขที่ … ลงวันที่ …'
  signatures: string[];                        // ['ผู้รับสินค้า/บริการ', 'ผู้รับเงิน', 'ผู้มีอำนาจลงนาม']
}
export interface PageCapacity { first: number; next: number; lastReserve: number } // px heights
export function paginate(rowHeights: number[], cap: PageCapacity): number[][]       // row indexes per page
export function TaxInvoicePaper(props: { model: PaperModel; measure?: (rowIndex: number) => number }): JSX.Element
```

- [ ] **Step 1: Write the failing tests**

`frontend/src/kit/paper/paginate.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { paginate } from './paginate';

const cap = { first: 300, next: 500, lastReserve: 120 };

describe('paginate', () => {
  it('one page when rows + reserve fit', () => {
    expect(paginate([50, 50, 50], cap)).toEqual([[0, 1, 2]]);
  });
  it('never splits a row and fills continuation pages', () => {
    const pages = paginate(Array(20).fill(40), cap);
    expect(pages.flat()).toEqual([...Array(20).keys()]);
    expect(pages[0].length).toBe(7); // 7 x 40 = 280 <= 300
  });
  it('keeps room for totals + signatures on the last page', () => {
    const pages = paginate([100, 100, 90], cap); // 290 fits the first page, but 290 + 120 > 300
    expect(pages.length).toBe(2);
    const last = pages[pages.length - 1].reduce((a, i) => a + [100, 100, 90][i], 0);
    expect(last + cap.lastReserve).toBeLessThanOrEqual(cap.next);
  });
  it('a single row taller than a page gets a page of its own', () => {
    expect(paginate([600], cap)).toEqual([[0], []]);
  });
});
```
(The last case: the oversized row occupies a page, and the reserve goes to an extra page that holds only totals and
signatures.)

`frontend/src/kit/paper/TaxInvoicePaper.test.tsx`
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PaperModel } from '@/domain/types';
import { TaxInvoicePaper } from './TaxInvoicePaper';

const model = (n: number): PaperModel => ({
  titleTh: 'ใบกำกับภาษี', titleEn: 'TAX INVOICE', copyLabel: 'ต้นฉบับ', number: 'TI-202610-0001', documentDate: '2026-10-14',
  seller: { name: 'บริษัท มะลิวัลย์ ดีไซน์ เวิร์คส์ จำกัด', address: '88/12 ถนนประดิพัทธ์ …', taxId: '0105569012345', branchLabel: 'สำนักงานใหญ่' },
  buyer: { name: 'บริษัท นาวาพาณิชย์ จำกัด', address: '…', taxId: '0105568024684', branchLabel: 'สำนักงานใหญ่' },
  lines: Array.from({ length: n }, (_, i) => ({ no: i + 1, description: `รายการ ${i + 1}`, qty: '1', unit: 'งาน', unitPrice: '100.00', amount: '100.00', taxCode: 'S7' as const })),
  totals: { gross: '100.00', discount: '0.00', net: '100.00', vat: '7.00', total: '107.00', amountInWords: 'หนึ่งร้อยเจ็ดบาทถ้วน' },
  signatures: ['ผู้รับสินค้า/บริการ', 'ผู้รับเงิน', 'ผู้มีอำนาจลงนาม'],
});

describe('TaxInvoicePaper (ม.86/4)', () => {
  it('shows the statutory elements', () => {
    render(<TaxInvoicePaper model={model(1)} measure={() => 30} />);
    for (const t of ['ใบกำกับภาษี', '0105569012345', '0105568024684', 'สำนักงานใหญ่', 'TI-202610-0001', '14 ต.ค. 2569', 'ภาษีมูลค่าเพิ่ม', 'หนึ่งร้อยเจ็ดบาทถ้วน']) {
      expect(screen.getAllByText(new RegExp(t)).length).toBeGreaterThan(0);
    }
  });
  it('60 lines: several pages, header on every page, signatures only on the last, page x/y', () => {
    const { container } = render(<TaxInvoicePaper model={model(60)} measure={() => 30} />);
    const pages = container.querySelectorAll('[data-paper-page]');
    expect(pages.length).toBeGreaterThanOrEqual(3);
    pages.forEach((p, i) => {
      expect(p.textContent).toContain('ใบกำกับภาษี');
      expect(p.textContent).toContain(`หน้า ${i + 1}/${pages.length}`);
      expect(p.textContent?.includes('ผู้มีอำนาจลงนาม')).toBe(i === pages.length - 1);
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `corepack pnpm vitest run src/kit/paper` → FAIL.

- [ ] **Step 3: Implement**

`frontend/src/kit/paper/paginate.ts`
```ts
export interface PageCapacity { first: number; next: number; lastReserve: number }

export function paginate(rowHeights: number[], cap: PageCapacity): number[][] {
  const pages: number[][] = [[]];
  let used = 0;
  const capOf = (p: number) => (p === 0 ? cap.first : cap.next);
  rowHeights.forEach((h, i) => {
    const p = pages.length - 1;
    if (used + h > capOf(p) && pages[p].length > 0) { pages.push([]); used = 0; }
    pages[pages.length - 1].push(i);
    used += h;
  });
  if (used + cap.lastReserve > capOf(pages.length - 1)) pages.push([]);
  return pages;
}
```
Component rules: rows are measured once off-screen (real layout in the browser; `measure` overrides in tests);
every page repeats the header block (seller, buyer, title, copy label, number, date) and the table header; the last
page carries totals, amount in words, notes, replacement note and signatures; each page shows `หน้า x/y`; page box
794 × 1123 px (A4 at 96 dpi) with print CSS `@page { size: A4; margin: 0 }` and `break-after: page`; font
`--font-paper` (Sarabun). The `/print/[type]/[id]` route renders only the paper (no shell) for printing and the
spike.

- [ ] **Step 4: Serve `PaperModel` from the mock** — build it from the document, company and party snapshots; copy
  label from a query `?copy=1`.

- [ ] **Step 5: Run tests and commit**

Run: `corepack pnpm vitest run src/kit/paper` — Expected: PASS.

```bash
git add frontend/src/kit/paper frontend/src/app/print frontend/src/domain/types.ts frontend/src/mocks/handlers/docs-write.ts
git commit -m "feat(kit): tax-invoice paper with measured pagination and print route"
```

---

### Task 14: Tax-invoice loop end to end + action count

**Files:**
- Create: `frontend/src/app/(app)/sales/tax-invoices/{page,new/page,[id]/page,[id]/edit/page}.tsx`,
  `frontend/e2e/helpers/count.ts`, `frontend/e2e/ti-loop.spec.ts`, `frontend/e2e/ti-action-count.spec.ts`
- Modify: `frontend/src/descriptors/tax-invoice.ts` (created in Task 10 — confirm values below)

**Interfaces:**
- Consumes: DocList, DocEditor, DocView, Paper.
- Produces: the descriptor pattern every SP1c screen follows:

```ts
// frontend/src/descriptors/tax-invoice.ts
import type { DocDescriptor } from '@/domain/descriptors';

export const taxInvoice: DocDescriptor = {
  type: 'TI', correctionClass: 'T', titleTh: 'ใบกำกับภาษี', titleEn: 'Tax invoice',
  partyKind: 'customer', lineEditor: 'item', vat: 'vat-only', issueLabelTh: 'บันทึกและออกใบกำกับภาษี',
  basePath: '/sales/tax-invoices',
  permissions: { read: 'doc.TI.read', create: 'doc.TI.create', issue: 'doc.TI.issue', cancel: 'doc.TI.cancel', correct: 'doc.TI.correct' },
};
```

- [ ] **Step 1: Write the action counter**

`frontend/e2e/helpers/count.ts`
```ts
import type { Page } from '@playwright/test';

/** Counts user actions the way TEAS 1's audit did: a click, a typed entry, or a key press = 1. */
export function counted(page: Page) {
  let n = 0;
  return {
    get count() { return n; },
    click: async (l: ReturnType<Page['getByRole']>) => { n++; await l.click(); },
    type: async (l: ReturnType<Page['getByRole']>, text: string) => { n++; await l.pressSequentially(text); },
    press: async (key: string) => { n++; await page.keyboard.press(key); },
  };
}
```

- [ ] **Step 2: Write the failing e2e tests**

`frontend/e2e/ti-action-count.spec.ts`
```ts
import { expect, test } from '@playwright/test';
import { counted } from './helpers/count';

test('1-line TI for a known customer with a usual item takes <= 5 actions (SP0 S3)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const u = counted(page);
  await u.click(page.getByRole('link', { name: 'สร้างใบกำกับภาษี' }));   // Home quick action
  await u.type(page.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา');
  await u.press('Enter');                                                 // pick customer, usual item prefilled
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await u.press('Control+Enter');                                         // open confirm
  await u.press('Enter');                                                 // issue
  await expect(page.getByText(/TI-\d{6}-\d{4}/).first()).toBeVisible();
  expect(u.count).toBeLessThanOrEqual(5);
});
```

`frontend/e2e/ti-loop.spec.ts`
```ts
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

const axeClean = async (page: import('@playwright/test').Page) => {
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);
};

test('list → view → paper', async ({ page }) => {
  await page.goto('/sales/tax-invoices');
  await axeClean(page);
  await page.getByRole('row').nth(1).getByRole('link').first().click();
  await expect(page.getByRole('tab', { name: 'กระดาษ' })).toBeVisible();
  await axeClean(page);
});

test('non-fiscal edit after issue → revision 1, same number', async ({ page }) => {
  await page.goto('/sales/tax-invoices?status=issued');
  await page.getByRole('row').nth(1).getByRole('link').first().click();
  const number = await page.getByTestId('doc-number').textContent();
  await page.getByRole('button', { name: 'แก้ไข' }).click();
  await page.getByRole('textbox', { name: 'หมายเหตุ' }).fill('อ้างอิงใบสั่งซื้อ 4471');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await page.getByRole('button', { name: 'ยืนยันทั้งหมด' }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(number!);
  await page.getByRole('tab', { name: 'ประวัติการแก้ไข' }).click();
  await expect(page.getByText(/ฉบับแก้ไขครั้งที่ 1/)).toBeVisible();
});

test('change customer on a paid TI → plan of 3 steps → replacement chain', async ({ page }) => {
  await page.goto('/sales/tax-invoices?status=settled');
  await page.getByRole('row').nth(1).getByRole('link').first().click();
  await page.getByRole('button', { name: 'แก้ไข' }).click();
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill('ปิ่นทอง');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  const dialog = page.getByRole('dialog', { name: /แผนการแก้ไข/ });
  await expect(dialog.getByRole('listitem')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'ยืนยันทั้งหมด' }).click();
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByText(/ออกแทนโดย/)).toBeVisible();
});

test('lower amount → plan proposes a credit note', async ({ page }) => {
  await page.goto('/sales/tax-invoices?status=issued');
  await page.getByRole('row').nth(1).getByRole('link').first().click();
  await page.getByRole('button', { name: 'แก้ไข' }).click();
  await page.getByRole('textbox', { name: 'ราคาต่อหน่วย 1' }).fill('1.00');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await expect(page.getByRole('dialog', { name: /แผนการแก้ไข/ })).toContainText('ใบลดหนี้');
});

test('operator: correction shows missing permissions and the send-to-approver path', async ({ page }) => {
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByLabel('บทบาท').selectOption('operator');
  await page.goto('/sales/tax-invoices?status=settled');
  await page.getByRole('row').nth(1).getByRole('link').first().click();
  await page.getByRole('button', { name: 'แก้ไข' }).click();
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill('ปิ่นทอง');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  const dialog = page.getByRole('dialog', { name: /แผนการแก้ไข/ });
  await expect(dialog.getByRole('button', { name: 'ยืนยันทั้งหมด' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'ส่งให้ผู้มีสิทธิ์อนุมัติ' })).toBeEnabled();
});

test('non-VAT company: TI is not available', async ({ page }) => {
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByLabel('บริษัท').selectOption('nonvat');
  await page.goto('/sales/tax-invoices');
  await expect(page.getByText('ใช้ได้เฉพาะบริษัทที่จดทะเบียน VAT')).toBeVisible();
});

for (const state of ['empty', 'error', 'forbidden'] as const) {
  test(`screen state ${state} renders its own pattern on the list`, async ({ page }) => {
    await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
    await page.getByLabel('สถานะหน้าจอ').selectOption(state);
    await page.goto('/sales/tax-invoices');
    const expected = { empty: /สร้างใบกำกับภาษี/, error: /ระบบขัดข้องชั่วคราว/, forbidden: /ไม่มีสิทธิ์/ }[state];
    await expect(page.getByText(expected).first()).toBeVisible();
  });
}

test('screen state locked shows the lock banner with its exit on an issued TI', async ({ page }) => {
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByLabel('สถานะหน้าจอ').selectOption('locked');
  await page.goto('/sales/tax-invoices?status=issued');
  await page.getByRole('row').nth(1).getByRole('link').first().click();
  await expect(page.getByRole('status', { name: 'ล็อก' })).toContainText('ภ.พ.30');
});

test('reload mid-edit reopens the same draft (Review Focus 4)', async ({ page }) => {
  await page.goto('/sales/tax-invoices/new');
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill('นาวา');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/sales\/tax-invoices\/[^/]+\/edit$/, { timeout: 5000 });
  await page.reload();
  await expect(page.getByText('0105568024684')).toBeVisible();
});
```
The customers these tests use ("บริษัท นาวาพาณิชย์ จำกัด" with a usual item, "บริษัท ปิ่นทองการพิมพ์ จำกัด") are seeded
in Task 4.

- [ ] **Step 3: Run to verify they fail** — `corepack pnpm e2e e2e/ti-loop.spec.ts e2e/ti-action-count.spec.ts` → FAIL.

- [ ] **Step 4: Implement the routes**

- `page.tsx` — `DocList` with columns เลขที่, วันที่, ลูกค้า, ยอดรวม, ค้างชำระ, สถานะ; saved views ทั้งหมด / ร่าง /
  ค้างชำระ / เกินกำหนด / ยกเลิก.
- `new/page.tsx` — `DocEditor mode="create"`; `onIssued` → `router.replace(view(id))`.
- `[id]/page.tsx` — `DocView`.
- `[id]/edit/page.tsx` — draft → `DocEditor mode="edit-draft"`; issued → `DocEditor mode="revise"` wired to
  `CorrectionPlanDialog`.
- Home quick action "สร้างใบกำกับภาษี" (VAT companies with `doc.TI.create`).
- VAT gate: on a non-VAT company every `/sales/tax-invoices/**` route renders `NotAvailableState`.

- [ ] **Step 5: Run everything**

Run: `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm e2e`
Expected: all green; action count ≤ 5.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app frontend/src/descriptors frontend/e2e
git commit -m "feat(frontend): tax-invoice loop end to end with corrections and action-count check"
```

---

### Task 15: Rendering spike — screen = paper in Chromium print (ADR-0001)

**Files:**
- Create: `frontend/e2e/render-spike.spec.ts`, `docs/adr/0001-document-rendering.md`
- Modify: `frontend/src/mocks/fixtures/documents.ts` (3 spike TIs: 1 line; 25 lines; 60 lines with descriptions up to
  300 Thai characters)

**Interfaces:**
- Produces: ADR-0001 deciding the renderer; SP1c and SP3 follow it.

- [ ] **Step 1: Write the spike test**

`frontend/e2e/render-spike.spec.ts`
```ts
import { expect, test } from '@playwright/test';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const SPIKE = [{ id: 'spike-1', minPages: 1 }, { id: 'spike-25', minPages: 2 }, { id: 'spike-60', minPages: 3 }];

async function pdfPages(buf: Buffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    texts.push(c.items.map((x) => ('str' in x ? x.str : '')).join(' '));
  }
  return texts;
}

for (const s of SPIKE) {
  test(`${s.id}: PDF pages = screen pages, header repeats, page x/y, signatures last`, async ({ page }) => {
    await page.goto(`/print/TI/${s.id}`);
    await page.waitForSelector('[data-paper-ready]');
    const screenPages = await page.locator('[data-paper-page]').count();
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    const pages = await pdfPages(pdf);
    expect(pages.length).toBe(screenPages);
    expect(pages.length).toBeGreaterThanOrEqual(s.minPages);
    pages.forEach((t, i) => {
      expect(t).toContain('ใบกำกับภาษี');
      expect(t).toContain(`${i + 1}/${pages.length}`);
      expect(t.includes('ผู้มีอำนาจลงนาม')).toBe(i === pages.length - 1);
    });
    expect(pages.at(-1)).toMatch(/บาท/);
  });
}
```
Thai text extraction from a PDF may split or reorder combining marks; if `toContain('ใบกำกับภาษี')` fails while the
PDF looks right when opened, normalise both sides with `.normalize('NFC').replace(/\s/g, '')` before comparing, and
record that in the ADR.

- [ ] **Step 2: Run the spike**

Run: `corepack pnpm e2e e2e/render-spike.spec.ts`
Also save the three PDFs to the scratchpad and open them once to confirm Thai shaping (tone marks, sara am,
line breaks) by eye.

- [ ] **Step 3: Write ADR-0001**

`docs/adr/0001-document-rendering.md` (from `_TEMPLATE.md`): Context (SP0 §10.6); what was tested (three documents,
local Chrome print engine = the engine Gotenberg uses); results per assertion; Decision — **pass:** "One React
paper component renders screen and PDF; deployed environments convert the print route to PDF with Gotenberg
(Chromium); the Gotenberg wiring is verified in SP3" — **fail:** "Fallback: QuestPDF renders the PDF; the screen
shows the server-rendered page images; SP1c and SP3 plans adjust"; Consequences.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/render-spike.spec.ts frontend/src/mocks/fixtures/documents.ts docs/adr/0001-document-rendering.md
git commit -m "test(spike): print fidelity of the paper component; ADR-0001 rendering decision"
```

---

### Task 16: Screen index + staging preview on Coolify

**Files:**
- Create: `frontend/src/app/mock/screens/page.tsx`, `deploy/frontend/Dockerfile`, `deploy/README.md`,
  `frontend/e2e/screens.spec.ts`

**Interfaces:**
- Produces: `/mock/screens` (every built screen and state, plus the SP1c screen list marked "รอ SP1c"); a container
  image that serves the mockup; the staging URL recorded in `STATUS.md`.

- [ ] **Step 1: Screen index + test**

The index lists, per screen: route, states (links that set the toolbar state through `?state=` before navigating),
roles to try, VAT / non-VAT. It reads the list of SP1c screens from `NAV`.

`frontend/e2e/screens.spec.ts`
```ts
import { expect, test } from '@playwright/test';

test('every built screen in the index opens without an error boundary', async ({ page }) => {
  await page.goto('/mock/screens');
  const links = await page.getByRole('link', { name: /^เปิด/ }).evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(links.length).toBeGreaterThan(5);
  for (const href of links) {
    await page.goto(href);
    await expect(page.getByText('Application error')).toHaveCount(0);
  }
});
```

- [ ] **Step 2: Dockerfile**

`deploy/frontend/Dockerfile`
```dockerfile
FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY frontend/ .
ENV NEXT_PUBLIC_API_MOCKING=enabled
RUN pnpm build

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```
Docker is not available on the dev box: the image is built by Coolify (and optionally by a CI job using
`docker/build-push-action` without pushing, to catch Dockerfile errors on PRs).

- [ ] **Step 3: Write `deploy/README.md` and ask Ham to create the Coolify app**

`deploy/README.md` lists the exact Coolify settings: source = GitHub `pinsorn/teas2` branch `main`; build pack =
Dockerfile; Dockerfile = `deploy/frontend/Dockerfile`; base directory = repo root; port 3000; domain = the subdomain
Ham chooses; optional HTTP basic auth (Traefik middleware) — Ham decides. Ask Ham with AskUserQuestion for the
subdomain and basic-auth choice; Ham creates the app (Coolify UI) or authorises the orchestrator to do it.

- [ ] **Step 4: Verify through the public URL**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<staging-subdomain>/            # expected 200 (or 401 with basic auth)
curl -s https://<staging-subdomain>/ | grep -o "<title>[^<]*</title>"            # expected: TEAS 2
```
Open `/mock/screens` on a phone-width viewport (Playwright `devices['iPhone 13']` against the staging URL) to confirm
the ≥ 390 px rules of SP0 §9.4 for view and approve.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/mock frontend/e2e/screens.spec.ts deploy
git commit -m "feat(frontend): screen index and staging image for the mockup preview"
```
Record the staging URL in `STATUS.md`.

---

### Task 17: SP1b gate — Ham reviews the pattern; write the SP1c plan

**Files:**
- Modify: `STATUS.md`
- Create (after approval): `docs/plans/<date>-sp1c-all-screens.md`

- [ ] **Step 1: Present the gate**

Send Ham: staging URL and `/mock/screens`; ADR-0001 result; action count of the TI loop; the correction-plan flow;
known gaps. Ask with AskUserQuestion: "SP1b pattern approve?" — options: approve / approve with changes (notes) /
rework. Record the answer in `STATUS.md`.

- [ ] **Step 2: Apply requested changes**

Each requested change becomes a task appended to this plan (same structure), executed and re-presented.

- [ ] **Step 3: Write the SP1c plan**

Invoke `superpowers:writing-plans` for SP1c: one task group per module group (sales, purchases, finance, accounting,
tax, payroll, reports, master data, settings, Home / TEAS Connect), every screen from
`docs/discovery/01-ui-feature-inventory.md` Appendix C plus the new screens of SP0 §11.2 (posting profiles,
dimensions, opening balances, schedules, settlement, approval inbox, agent policy), each built from descriptors and
the kit, each with its states, roles and VAT / non-VAT variants, and a Ham gate per module group. Include the PV
action-count check (≤ 6 actions, SP0 S3).
