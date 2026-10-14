# SP1c group 00 — Foundation (kit generalisation, ledger core, settlement + WHT, harnesses)

> Part of `docs/plans/2026-10-14-sp1c-all-screens.md` — read its Global Constraints, Design decisions and Shared
> contracts first. Tasks run in order F1 → F6. No Ham gate; G00 is a controller gate (the TI loop must stay green).

**Why first:** every later task consumes the registry, generic routes, fixture ids, screen contract, role-based
ledger, settlement / WHT engine, and the report kit built here.

---

### Task F1: Doc-type table, descriptor registry, generic document routes, paper registry

**Depends on:** main (SP1ab merged).

**Files:**
- Create: `frontend/src/domain/doc-types.ts`, `frontend/src/domain/doc-types.test.ts`,
  `frontend/src/domain/permissions.ts`, `frontend/src/descriptors/index.ts`,
  `frontend/src/descriptors/descriptors.contract.test.ts`,
  `frontend/src/kit/pages/{TypeGate,DocListPage,DocNewPage,DocViewPage,DocEditPage}.tsx`,
  `frontend/src/kit/pages/columns.tsx`, `frontend/src/kit/paper/registry.ts`, `frontend/src/mocks/engine/paper.ts`,
  `frontend/src/app/(app)/[group]/[slug]/page.tsx`, `.../[slug]/new/page.tsx`, `.../[slug]/[id]/page.tsx`,
  `.../[slug]/[id]/edit/page.tsx`, `frontend/e2e/routes.spec.ts`
- Delete: `frontend/src/app/(app)/[...slug]/page.tsx`, `frontend/src/app/(app)/sales/tax-invoices/**` (5 files)
- Modify: `frontend/src/domain/descriptors.ts`, `frontend/src/descriptors/tax-invoice.ts`,
  `frontend/src/mocks/fixtures/documents.ts` (CLASS re-export), `frontend/src/mocks/engine/commands.ts`
  (`missingOf`, `convert` VAT checks), `frontend/src/mocks/handlers/docs-read.ts`, `.../docs-write.ts`
  (VAT checks, `/paper` via registry), `frontend/src/kit/doc-view/{DocView,ChainPanel}.tsx`,
  `frontend/src/kit/paper/PaperView.tsx`, `frontend/src/app/print/[type]/[id]/page.tsx`,
  `frontend/src/app-shell/nav.ts` (+ `nav.test.ts`), `frontend/src/kit/states/NotAvailableState.tsx`,
  `frontend/src/kit/doc-editor/DocEditor.tsx` (`HeaderFields`), `frontend/src/lib/query/keys.ts` (+ test),
  `frontend/src/mocks/permissions.ts`, `frontend/src/messages/{th,en}.json`

**Interfaces:**
- Consumes: SP1ab kit (`DocList`, `DocEditor`, `DocView`, `PaperView`, `useCorrectionFlow`), `useMe`, `NAV`.
- Produces (exact):

```ts
// src/domain/doc-types.ts
import type { CorrectionClass, DocType } from './types';
export type VatScope = 'vat-only' | 'non-vat-only' | 'both';
export interface DocTypeInfo { class: CorrectionClass; vat: VatScope; ledger: boolean; outstanding: boolean; printable: boolean }
export const DOC_TYPES: Record<DocType, DocTypeInfo> = {
  QT: { class: 'N', vat: 'both', ledger: false, outstanding: false, printable: true },
  SO: { class: 'N', vat: 'both', ledger: false, outstanding: false, printable: true },
  DO: { class: 'N', vat: 'both', ledger: false, outstanding: false, printable: true },
  BL: { class: 'N', vat: 'both', ledger: false, outstanding: false, printable: true },
  IV: { class: 'L', vat: 'non-vat-only', ledger: true, outstanding: true, printable: true },
  TI: { class: 'T', vat: 'vat-only', ledger: true, outstanding: true, printable: true },
  RC: { class: 'T', vat: 'both', ledger: true, outstanding: false, printable: true },
  CN: { class: 'T', vat: 'vat-only', ledger: true, outstanding: false, printable: true },
  DN: { class: 'T', vat: 'vat-only', ledger: true, outstanding: false, printable: true },
  PO: { class: 'N', vat: 'both', ledger: false, outstanding: false, printable: true },
  PB: { class: 'L', vat: 'both', ledger: true, outstanding: true, printable: false },
  PCN: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: false },
  PDN: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: false },
  PV: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: true },
  WT: { class: 'T', vat: 'both', ledger: false, outstanding: false, printable: true },
  EX: { class: 'L', vat: 'both', ledger: true, outstanding: true, printable: true },
  JV: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: true },
  FA: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: false },
  DP: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: false },
  PR: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: true },
  OB: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: false },
};
export const CLASS = Object.fromEntries(Object.entries(DOC_TYPES).map(([t, i]) => [t, i.class])) as Record<DocType, CorrectionClass>;
export const isTypeAvailable = (t: DocType, vatRegistered: boolean) =>
  DOC_TYPES[t].vat === 'both' || (DOC_TYPES[t].vat === 'vat-only') === vatRegistered;
/** SP0 §7.7. The engine refuses any pair not listed; a type's task enables its row's UI. */
export const CONVERSIONS: Partial<Record<DocType, DocType[]>> = {
  QT: ['SO', 'TI', 'IV'], SO: ['DO', 'TI', 'IV'], DO: ['TI', 'IV'], TI: ['BL', 'RC', 'CN', 'DN'], IV: ['BL', 'RC'],
  PO: ['PB', 'PV'], PB: ['PCN', 'PDN', 'PV'], EX: ['PV'],
};

// src/domain/descriptors.ts
export type LineEditorKind = 'item' | 'amount' | 'account' | 'payroll' | 'none';
export type ListColumnKey = 'number' | 'date' | 'party' | 'total' | 'outstanding' | 'status' | 'dueDate' | 'reference' | 'progress' | 'marks';
export type SavedViewKey = 'draft' | 'pending' | 'outstanding' | 'overdue' | 'cancelled' | 'agent';
export type HeaderFieldKey = 'documentDate' | 'dueDate' | 'reference' | 'notes' | 'bankAccount' | 'paymentMethod'
  | 'cheque' | 'whtMode' | 'claimPeriod' | 'vendorDocNumber' | 'vendorDocDate' | 'reason' | 'refDoc' | 'autoReverse' | 'complete';
export interface DocDescriptor {
  type: DocType;
  correctionClass: CorrectionClass;           // must equal DOC_TYPES[type].class (contract test)
  vat: VatScope;                              // must equal DOC_TYPES[type].vat (contract test)
  titleTh: string; titleEn: string;
  partyKind: 'customer' | 'vendor' | 'employee' | null;
  lineEditor: LineEditorKind;
  linesWhen?: 'non-vat';                      // RC: line grid only for a non-VAT company (D-12)
  basePath: string;                           // two segments: '/<group>/<slug>'
  permissions: { read: string; create: string; issue: string; cancel: string; correct: string };
  convertsTo?: DocType[];                     // subset of CONVERSIONS[type]
  settles?: DocType[];                        // F5: open-item types this document allocates to
  groups?: DocType[];                         // BL: types it groups
  adjusts?: DocType;                          // CN/DN → TI, PCN/PDN → PB
  listColumns: ListColumnKey[];
  savedViews: SavedViewKey[];
  headerFields: HeaderFieldKey[];
}
export const routesOf = (d: DocDescriptor) => ({ /* unchanged from SP1ab */ });

// src/descriptors/index.ts
export const DESCRIPTORS: Partial<Record<DocType, DocDescriptor>>;    // F1: { TI: taxInvoice }; each type task adds one entry
export function descriptorByPath(path: string): DocDescriptor | undefined; // exact basePath match
export function docListHref(type: DocType, vatRegistered: boolean): string | undefined; // undefined: not built or not available
export function docViewHref(type: DocType, id: string): string | undefined;

// src/kit/paper/registry.ts
export const PAPERS: Partial<Record<DocType, ComponentType<{ model: PaperModel }>>>; // F1: { TI: TaxInvoicePaper }
// src/mocks/engine/paper.ts
export const PAPER_BUILDERS: Partial<Record<DocType, (c: Ctx, d: Doc, copy: boolean) => PaperModel>>; // F1: { TI: (moved paperOf) }

// src/kit/pages/*.tsx — each takes the doc type, looks the descriptor up, wraps in <TypeGate>
export function DocListPage(p: { type: DocType }): JSX.Element;   // columns from columnsFor(d), saved views from savedViewsFor(d)
export function DocNewPage(p: { type: DocType }): JSX.Element;    // ?copyFrom= as SP1ab; later ?convertFrom= etc.
export function DocViewPage(p: { type: DocType }): JSX.Element;
export function DocEditPage(p: { type: DocType }): JSX.Element;   // draft → edit-draft, live → revise + correction flow (SP1ab logic, moved)
export function TypeGate(p: { type: DocType; children: ReactNode }): JSX.Element; // NotAvailableState reason='vatOnly'|'nonVatOnly'
```

- `taxInvoice` gains `vat: 'vat-only'`, `listColumns: ['number','date','party','total','outstanding','status']`,
  `savedViews: ['draft','outstanding','overdue','cancelled']`, `headerFields: ['documentDate','dueDate','reference','notes']`,
  loses `issueLabelTh`. Messages: `docTypes.TI.{title,issue,create,empty}` in th / en (`"issue": "บันทึกและออกใบกำกับภาษี"`,
  `"create": "สร้างใบกำกับภาษี"`).
- `qk.chain/activity/revisions/ledger(c, type, id)` (M12).
- `NotAvailableState` props `{ reason: 'vatOnly' | 'nonVatOnly' }` → messages `state.notAvailable.vatOnly` ("ใช้ได้เฉพาะบริษัทที่จดทะเบียน VAT") and `.nonVatOnly` ("บริษัทที่จดทะเบียน VAT ใช้ใบกำกับภาษีแทน").
- `src/domain/permissions.ts`: `export const PERMISSIONS: Record<string, { th: string; en: string }>` holding every code
  currently in `mocks/permissions.ts` plus `doc.<T>.*` for all 21 types (labels "ดูใบเสนอราคา", "สร้างใบเสนอราคา",
  "ออกใบเสนอราคา", "ยกเลิกใบเสนอราคา", "แก้ไขใบเสนอราคาที่ออกแล้ว", …). `mocks/permissions.ts` unchanged in content.

Route files (exact; each ≤ 15 lines):

```tsx
// src/app/(app)/[group]/[slug]/page.tsx  (server component)
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ComingInSp1c } from '@/app-shell/ComingInSp1c';
import { matchNavItem } from '@/app-shell/nav';
import { descriptorByPath } from '@/descriptors';
import { DocListPage } from '@/kit/pages/DocListPage';

type P = PageProps<'/[group]/[slug]'>;
const pathOf = async (params: P['params']) => { const { group, slug } = await params; return `/${group}/${slug}`; };
export async function generateMetadata({ params }: P): Promise<Metadata> {
  const path = await pathOf(params); const d = descriptorByPath(path); const hit = matchNavItem(path);
  if (d) return { title: d.titleTh };
  return hit && hit.item.href === path ? { title: (await getTranslations())(hit.item.labelKey) } : {};
}
export default async function Page({ params }: P) {
  const path = await pathOf(params);
  const d = descriptorByPath(path);
  if (d) return <DocListPage type={d.type} />;
  const hit = matchNavItem(path);
  if (!hit || hit.item.href !== path) notFound();
  return <ComingInSp1c title={(await getTranslations())(hit.item.labelKey)} href={path} />;
}
```
`new/page.tsx`, `[id]/page.tsx`, `[id]/edit/page.tsx`: same resolution; `notFound()` when no descriptor; render
`DocNewPage` / `DocViewPage` / `DocEditPage`. Confirm the `PageProps<'/[group]/[slug]'>` helper and the static-beats-
dynamic precedence in `frontend/node_modules/next/dist/docs/` (routing → dynamic routes) before writing them.

- [ ] **Step 1: Write the failing tests**

`src/domain/doc-types.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { CLASS, CONVERSIONS, DOC_TYPES, isTypeAvailable } from './doc-types';

describe('doc types (SP0 §3.1, §7.3, §7.7)', () => {
  it('classes follow §7.3', () => {
    expect(Object.entries(CLASS).filter(([, c]) => c === 'T').map(([t]) => t).sort()).toEqual(['CN', 'DN', 'RC', 'TI', 'WT']);
    expect(Object.entries(CLASS).filter(([, c]) => c === 'N').map(([t]) => t).sort()).toEqual(['BL', 'DO', 'PO', 'QT', 'SO']);
  });
  it('VAT scope: TI/CN/DN VAT-only, IV non-VAT-only, the rest both', () => {
    expect(isTypeAvailable('TI', false)).toBe(false);
    expect(isTypeAvailable('IV', true)).toBe(false);
    expect(isTypeAvailable('IV', false)).toBe(true);
    expect(isTypeAvailable('RC', false)).toBe(true);
    expect(Object.keys(DOC_TYPES).filter((t) => DOC_TYPES[t as keyof typeof DOC_TYPES].vat === 'vat-only').sort()).toEqual(['CN', 'DN', 'TI']);
  });
  it('conversions never target a type outside the source company scope pair (DO → BL is gone, D-07)', () => {
    expect(CONVERSIONS.DO).toEqual(['TI', 'IV']);
  });
});
```

`src/descriptors/descriptors.contract.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { NAV } from '@/app-shell/nav';
import { CONVERSIONS, DOC_TYPES } from '@/domain/doc-types';
import type { DocDescriptor } from '@/domain/descriptors';
import { PERMISSIONS } from '@/domain/permissions';
import en from '@/messages/en.json';
import th from '@/messages/th.json';
import { DESCRIPTORS, descriptorByPath, docViewHref } from '.';

/** Returns every contract violation of one descriptor; [] = valid. Exported for later groups' negative tests. */
export function checkDescriptor(d: DocDescriptor): string[] {
  const e: string[] = [];
  const info = DOC_TYPES[d.type];
  if (d.correctionClass !== info.class) e.push('class');
  if (d.vat !== info.vat) e.push('vat');
  for (const [verb, code] of Object.entries(d.permissions)) {
    if (code !== `doc.${d.type}.${verb}`) e.push(`perm:${verb}`);
    if (!(code in PERMISSIONS)) e.push(`catalog:${code}`);
  }
  if (!/^\/[a-z-]+\/[a-z-]+$/.test(d.basePath)) e.push('basePath shape');
  const nav = NAV.flatMap((g) => g.items).find((i) => i.href === d.basePath);
  if (!nav || nav.permission !== d.permissions.read) e.push('nav');
  for (const t of d.convertsTo ?? []) if (!CONVERSIONS[d.type]?.includes(t)) e.push(`convert:${t}`);
  const msg = (m: unknown) => (m as Record<string, Record<string, Record<string, string>>>).docTypes?.[d.type];
  for (const k of ['title', 'issue', 'create', 'empty']) { if (!msg(th)?.[k]) e.push(`th:${k}`); if (!msg(en)?.[k]) e.push(`en:${k}`); }
  return e;
}

describe('descriptor registry', () => {
  for (const [type, d] of Object.entries(DESCRIPTORS)) {
    it(`${type} satisfies the contract`, () => {
      expect(d!.type).toBe(type);
      expect(checkDescriptor(d!)).toEqual([]);
      expect(descriptorByPath(d!.basePath)).toBe(d);
      expect(docViewHref(d!.type, 'x1')).toBe(`${d!.basePath}/x1`);
    });
  }
  it('the checker reports a broken descriptor (can fail)', () => {
    const bad = { ...DESCRIPTORS.TI!, correctionClass: 'N', vat: 'both', basePath: '/tax-invoices',
      permissions: { ...DESCRIPTORS.TI!.permissions, cancel: 'doc.TI.void' } } as DocDescriptor;
    expect(checkDescriptor(bad)).toEqual(expect.arrayContaining(['class', 'vat', 'perm:cancel', 'basePath shape']));
  });
  it('docViewHref is undefined for a type that is not built', () => { expect(docViewHref('OB', 'x')).toBeUndefined(); });
});
```

`e2e/routes.spec.ts`
```ts
import { expect, test } from '@playwright/test';
import { axeClean } from './helpers/axe';

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); });

test('the TI list renders through the generic route', async ({ page }) => {
  await page.goto('/sales/tax-invoices');
  await expect(page.getByRole('heading', { level: 1, name: 'ใบกำกับภาษี' })).toBeVisible();
  await expect(page).toHaveTitle(/ใบกำกับภาษี/);
  await axeClean(page);
});
test('a nav route not built yet shows the coming-in-SP1c panel, not a 404', async ({ page }) => {
  await page.goto('/accounting/opening-balances');
  await expect(page.getByRole('heading', { level: 1, name: 'ยอดยกมา' })).toBeVisible();
});
test('an unknown route is a 404', async ({ page }) => {
  const r = await page.goto('/sales/no-such-thing');
  expect(r?.status()).toBe(404);
});
test('non-VAT company: TI routes say why they are unavailable', async ({ page }) => {
  await page.goto('/sales/tax-invoices/new?company=nonvat');
  await expect(page.getByText('ใช้ได้เฉพาะบริษัทที่จดทะเบียน VAT')).toBeVisible();
});
```

- [ ] **Step 2: Run to verify they fail**
  `corepack pnpm test src/domain/doc-types.test.ts src/descriptors/descriptors.contract.test.ts` → FAIL (modules not
  found). `corepack pnpm e2e e2e/routes.spec.ts` → the 404 and non-VAT tests may pass already; the generic-route test
  must still pass after the static routes are deleted (that is the regression it pins).

- [ ] **Step 3: Implement**
  1. Create `doc-types.ts` exactly as above; make `fixtures/documents.ts` `export { CLASS } from '@/domain/doc-types'`
     and delete its local literal; replace `CONVERT_TO` in `commands.ts` with `CONVERSIONS` (engine refuses pairs not
     listed, code `doc.conversion_not_allowed`) and `missingOf` / `convert` VAT checks with `isTypeAvailable` using the
     company's `vatRegistered` (message for VAT-only: `บริษัทนี้ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม`; non-VAT-only:
     `บริษัทที่จดทะเบียน VAT ใช้ใบกำกับภาษีแทนใบแจ้งหนี้`).
  2. Both handlers: replace `VAT_ONLY` with `!isTypeAvailable(t, company.vatRegistered)` → 404
     `doc.type_not_available` (title per scope as above).
  3. Move `paperOf` from `docs-write.ts` into `mocks/engine/paper.ts` as `PAPER_BUILDERS.TI`; `/paper` returns 404
     `doc.paper_not_available` when `!DOC_TYPES[t].printable || !PAPER_BUILDERS[t]`.
  4. `PAPERS` registry; `PaperView` and `/print/[type]/[id]` look the component up; `DocView` shows `PaperView` when
     `PAPERS[type]` exists and `PaperStub` (message `docView.paper.notPrintable`) otherwise — no `'TI'` literal left
     in `kit/` (grep must print nothing: `rg -n "'TI'" frontend/src/kit`).
  5. Registry + `docListHref` / `docViewHref`; delete `nav.ts` `docHref` + `DOC_ITEM` and `ChainPanel.tsx`
     `listOf` / `docHref`; every former caller imports from `@/descriptors`. Nav item `invoices` permission →
     `doc.IV.read` (D-08); add `doc.IV.read` to operator and accountant in `mocks/permissions.ts`.
  6. Move the four TI page bodies into `kit/pages/*` parametrised by descriptor (logic unchanged: copy-as-new,
     draft vs revise edit, correction flow, `onIssued → router.replace(view)`); `TypeGate` replaces `VatGate`.
     `columns.tsx` maps `ListColumnKey` → `DocListColumn` (headers from `docList.columns.*` messages; `progress` and
     `marks` render `—` until S1/S2 fill them); saved-view keys map to the SP1ab TI params.
  7. `DocEditor`: replace the four hard-coded header inputs with `<HeaderFields keys={d.headerFields} … />`
     (`kit/doc-editor/HeaderFields.tsx`), rendering only the SP1ab four for now; unknown keys throw in dev.
  8. Delete the static TI routes and `[...slug]`; add the four generic route files.
  9. `qk` signatures gain `type` (update all callers; `keys.test.ts` asserts every key starts with the company id).
- [ ] **Step 4: Run to verify they pass** — the two unit files PASS; `corepack pnpm e2e e2e/routes.spec.ts e2e/ti-loop.spec.ts e2e/ti-action-count.spec.ts e2e/paper.spec.ts e2e/shell.spec.ts` PASS.
- [ ] **Step 5: Full gate** — `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm test` green; report e2e
  evidence for the specs above (controller runs the full e2e).
- [ ] **Step 6: Controller commits** — `refactor(frontend): descriptor registry, doc-type table and generic document routes`.

---

### Task F2: Shell hardening, strict i18n in tests, fixture ids, screen contract, screen index

**Depends on:** F1.

**Files:**
- Create: `frontend/src/app/error.tsx`, `frontend/src/app/global-error.tsx`, `frontend/src/mocks/fixtures/ids.ts`
  (+ `ids.test.ts`), `frontend/src/mocks/engine/locks.ts`, `frontend/src/mocks/handlers/mock-fixtures.ts`, `frontend/e2e/helpers/fixtures.ts`,
  `frontend/e2e/helpers/screen-contract.ts`, `frontend/e2e/foundation.spec.ts`, `frontend/src/app/mock/screens/screens.ts`
- Modify: `frontend/src/test/setup.ts`, `frontend/src/app-shell/Breadcrumbs.tsx` (+ test), `frontend/src/kit/states/*.tsx`
  (`data-screen-state`), `frontend/src/kit/doc-view/LockBanner.tsx` (`data-screen-state="locked"`),
  `frontend/src/kit/paper/PaperView.tsx`, `frontend/src/kit/doc-view/DocView.tsx` (paper tab container),
  `frontend/src/app/mock/screens/page.tsx`, `frontend/e2e/{ti-loop,screens}.spec.ts`, `frontend/src/mocks/handlers/index.ts`

**Interfaces:**
- Consumes: F1 registry, `seed()` / `loadState()`.
- Produces:

```ts
// src/mocks/fixtures/ids.ts
export type FixtureKey = 'tiDraft' | 'tiDraftNoTin' | 'tiIssuedUnpaid' | 'tiPartly' | 'tiSettled' | 'tiFilingLocked'
  | 'tiReplaced' | 'tiLong' | 'tiPeriodLocked'; // later tasks extend this union (one line each)
export const FIXTURE_PREDICATES: Record<FixtureKey, (d: MockState['docs'][number], st: MockState) => boolean>;
/** Lowest id (string order) matching each predicate in the active seed; throws listing every unresolved key. */
export function fixtureIds(st: MockState): Record<FixtureKey, string>;
// GET /bff/v1/mock/fixtures → Record<FixtureKey, string>   (no screenGate; reads the current mock state)

// e2e/helpers/fixtures.ts
export async function fixtureId(page: Page, key: string): Promise<string>; // fetches /bff/v1/mock/fixtures in the page

// e2e/helpers/screen-contract.ts
export type ScreenState = 'empty' | 'loading' | 'error' | 'forbidden' | 'locked';
export interface ScreenSpec {
  name: string;
  path: string | ((page: Page) => Promise<string>);   // async form resolves fixture ids
  heading: string | RegExp;                            // the h1 in the normal state
  company: 'vat' | 'nonvat' | 'both';                  // out-of-scope company must render data-screen-state="not-available"
  states: ScreenState[];                               // each must render its data-screen-state, never together with "empty" when "error"
  forbiddenRole?: 'operator' | 'accountant' | 'admin'; // renders data-screen-state="forbidden" (normal state)
  roles?: ('operator' | 'accountant' | 'admin')[];     // normal render + axe for each (default ['accountant'])
}
export function screenContract(spec: ScreenSpec): void; // declares a test.describe(spec.name, …)
```

Behaviour of `screenContract` (exact): for each company in scope × each role: `goto(path?company=&role=&state=normal)`,
heading visible, `axeClean`. For each state: `goto(path?…&state=<s>)`, then
`loading` → `[data-screen-state="loading"]` visible; `empty` → `[data-screen-state="empty"]` visible;
`error` → `[data-screen-state="error"]` visible AND `[data-screen-state="empty"]` count 0;
`forbidden` → `[data-screen-state="forbidden"]` visible; `locked` → `[data-screen-state="locked"]` visible.
Out-of-scope company → `[data-screen-state="not-available"]`. `forbiddenRole` → `forbidden`.
The kit state components get the attributes: `EmptyState` "empty", `ErrorState` "error", `ForbiddenState`
"forbidden", `LoadingState` "loading", `LockBanner` "locked", `NotAvailableState` "not-available",
`NotFoundState` "not-found", `ComingInSp1c` "coming".

- [ ] **Step 1: Write the failing tests**

`src/mocks/fixtures/ids.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { buildSeed } from '.';
import { seed } from '../store';
import { FIXTURE_PREDICATES, fixtureIds } from './ids';

describe('named fixture ids', () => {
  for (const role of ['operator', 'accountant', 'admin'] as const) {
    it(`every key resolves in the ${role} seed`, () => {
      const ids = fixtureIds(seed()); // seed() reads the toolbar role via getSettings; buildSeed(role) is checked below
      expect(Object.keys(ids).sort()).toEqual(Object.keys(FIXTURE_PREDICATES).sort());
      expect(buildSeed(role).docs.length).toBeGreaterThan(0);
    });
  }
  it('tiIssuedUnpaid is issued, unlocked, unpaid and dated in the current open month', () => {
    const st = seed(); const d = st.docs.find((x) => x.id === fixtureIds(st).tiIssuedUnpaid)!;
    expect([d.type, d.status, d.locks.length, d.outstanding === d.totals.total, d.header.documentDate >= '2026-10-01']).toEqual(['TI', 'issued', 0, true, true]);
  });
  it('fails loudly when a predicate matches nothing (can fail)', () => {
    const st = seed(); st.docs = st.docs.filter((d) => d.type !== 'TI');
    expect(() => fixtureIds(st)).toThrow(/tiDraft/);
  });
});
```

`src/test/setup.ts` change is pinned by `src/messages/messages.test.ts` (add):
```ts
it('the test translator throws on a missing key (no silent key echo)', async () => {
  const { useTranslations } = await import('next-intl');
  expect(() => useTranslations('docList')('no.such.key')).toThrow();
});
```

`e2e/foundation.spec.ts`
```ts
import { expect, test } from '@playwright/test';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

screenContract({ name: 'TI list', path: '/sales/tax-invoices', heading: 'ใบกำกับภาษี', company: 'vat',
  states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'TI view (filing lock)', path: async (p) => `/sales/tax-invoices/${await fixtureId(p, 'tiFilingLocked')}`,
  heading: /TI-\d{6}-\d{4}/, company: 'vat', states: ['loading', 'error', 'forbidden', 'locked'] });

test('a render error shows the app error state with retry, not the bare Next page', async ({ page }) => {
  await page.goto('/sales/tax-invoices/%zz');
  await expect(page.getByText('Application error')).toHaveCount(0);
});
test('breadcrumbs show the document number, never the raw id', async ({ page }) => {
  const id = await (async () => { await page.goto('/'); return fixtureId(page, 'tiIssuedUnpaid'); })();
  await page.goto(`/sales/tax-invoices/${id}`);
  const crumbs = page.getByRole('navigation', { name: 'breadcrumb' });
  await expect(crumbs).toContainText(/TI-\d{6}-\d{4}/);
  await expect(crumbs).not.toContainText(id);
});
test('390 px: the paper tab scrolls inside its container; the page itself never scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); const id = await fixtureId(page, 'tiIssuedUnpaid');
  await page.goto(`/sales/tax-invoices/${id}`);
  await expect(page.getByRole('tab', { name: 'กระดาษ' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const box = page.getByRole('region', { name: 'กระดาษ' });
  expect(await box.evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).overflowX === 'auto')).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail** — `corepack pnpm test src/mocks/fixtures/ids.test.ts src/messages/messages.test.ts`
  → FAIL; `corepack pnpm e2e e2e/foundation.spec.ts` → FAIL (no helpers / attributes).
- [ ] **Step 3: Implement**
  1. `setup.ts`: replace the hand-written shim with the real translator:
     `vi.mock('next-intl', async (orig) => { const m = await orig<typeof import('next-intl')>(); return { ...m,
     useTranslations: (ns?: string) => m.createTranslator({ locale: 'th', messages: th, namespace: ns as never,
     onError: (e) => { throw e; } }), useLocale: () => 'th', NextIntlClientProvider: ({ children }) => children }; })`.
     Fix every unit test that relied on key echo (add the missing messages, never weaken the throw).
  2. Predicates evaluate the **read model**, not the stored row: `fixtureIds` calls `derivedLocks(st, d)` (a function
     exported from `mocks/engine/locks.ts`; F2 creates it returning `d.locks`; F4 adds the period lock to it and TX1
     the filing lock; the GET doc handler calls the same function — never two derivations). Seed facts the predicates
     rely on (SP1ab `buildDocs`): issued TIs are dated `2026-10-14 − (8 + 7j)` days, so only ONE non-draft TI is dated
     in October (6 Oct, issued, unpaid); September holds issued, partly settled and settled TIs; there is no settled
     October TI. `ids.ts` predicates (TI): `tiDraft` draft by user; `tiDraftNoTin` draft whose VAT party lacks a TIN;
     `tiIssuedUnpaid` issued, no locks, outstanding = total, date ≥ 2026-10-01; `tiPartly` partly_settled;
     `tiSettled` settled, no filing lock; `tiFilingLocked` has a `filing` lock; `tiReplaced` replaced; `tiLong` id
     `spike-60`; `tiPeriodLocked` issued with document date ≤ 2026-06-30 (resolves after F4; until F4 lands this key
     is added in F4, not here). Handler `GET */bff/v1/mock/fixtures` in `mock-fixtures.ts`.
  3. Rewrite `ti-loop.spec.ts` to open documents via `fixtureId` (no `getByRole('row').nth(1)`); keep every
     assertion's intent.
  4. Screen index: `screens.ts` exports `SCREENS: { name; route: string | { fixture: FixtureKey; suffix?: string };
     company: 'vat'|'nonvat'|'both'; states: boolean }[]` (TI entries now use fixture keys); `page.tsx` resolves routes
     server-side with `fixtureIds(buildSeedState())` where `buildSeedState()` = the `seed()` body with role
     'accountant' (export it from `store.ts`); "pending" list = NAV items with no descriptor, no record descriptor
     and no `SCREENS` entry.
  5. `app/error.tsx` (client) renders `ErrorState` with `reset` as retry; `global-error.tsx` renders a minimal
     `<html><body>` with the same Thai message (messages cannot load there: literal Thai allowed in this one file,
     noted in a comment).
  6. Breadcrumbs: for a path matching a descriptor's `[id]` route, read `qk.doc(company, type, id)` with `useQuery`
     (same queryFn as DocView) and show `number ?? 'ร่าง'`; while loading show a `Skeleton` inline; never the id;
     `edit` segment label `แก้ไข`. Navigation landmark `aria-label="breadcrumb"`.
  7. Paper tab at narrow widths: the `TabsContent value="paper"` child becomes
     `<section role="region" aria-label={t('tabs.paper')} className="overflow-x-auto">`; no `overflow-hidden`
     ancestor between it and `main`; tab list wraps (already `flex-wrap`). `PaperView` resets its ready flag when
     the model id changes (T13 deferred).
- [ ] **Step 4: Run to verify they pass** — the unit files and `e2e/foundation.spec.ts`, `e2e/ti-loop.spec.ts`,
  `e2e/screens.spec.ts` PASS.
- [ ] **Step 5: Full gate** as F1.
- [ ] **Step 6: Controller commits** — `test(frontend): named fixture ids, screen contract, strict i18n shim; shell error boundary and breadcrumbs`.

---

### Task F3: Kit debt (SP1ab deferred minors) and the `ledger.read` rule

**Depends on:** F2.

**Files:**
- Modify: `frontend/src/kit/doc-list/{DocList,SavedViews,useDocListParams,BulkBar}.tsx|ts` (+ `DocList.test.tsx`),
  `frontend/src/kit/doc-editor/{useLineGridKeys,LineGrid,ItemField,JournalDrawer}.ts(x)` (+ tests),
  `frontend/src/kit/doc-view/{ChainPanel,RevisionHistory,LedgerTab,useCorrectionFlow}.tsx`,
  `frontend/src/kit/dialogs/{CancelDialog,CorrectionPlanDialog}.tsx`, `frontend/src/app-shell/CommandMenu.tsx`,
  `frontend/src/lib/query/QueryProvider.tsx` (+ new `QueryProvider.test.tsx`), `frontend/src/styles/tokens.css`,
  `frontend/src/app/globals.css`, `frontend/src/components/ui/input-group.tsx`, `docs/specs/SP1-design-system.md`
  (one paragraph: tailwind-merge custom groups), `frontend/src/mocks/handlers/{docs-read,docs-write}.ts`,
  `frontend/src/messages/{th,en}.json`

**Interfaces:**
- Consumes: F1, F2.
- Produces: `DocList` server-side overdue filter (`overdue=1` list param; mock filters `dueDate < today()` and
  outstanding > 0 before paging); `ListDocsParams.overdue?: '1'`; `ListDocsParams.agent?: '1'` (createdBy agent);
  `RevisionHistory` field labels map `FIELD_LABELS: Record<string, string>` (message keys `revisions.fields.*`,
  `lines.<id>.<field>` → "รายการที่ n · <field label>"); `/ledger` and the compute response's `journal` are gated on
  `ledger.read` (compute omits `journal` without it; `JournalDrawer` button disabled with "ต้องมีสิทธิ์ ดูบัญชี").

- [ ] **Step 1: Write the failing tests** (add to the named test files)

```ts
// DocList.test.tsx
it('saved view "ค้างชำระ" shows as selected in the status filter (M10)', async () => { /* render with ?status=issued,partly_settled&outstanding=positive; expect the status <select> to display "ค้างชำระ" (an option value 'issued,partly_settled' exists) */ });
it('retry after a failed page-1 refetch refetches page 1, not the next page (SP1ab I8 regression)', async () => { /* first GET 500 → retry → GET called again with no cursor */ });
it('from > to shows an inline error and does not query', async () => { /* type from 2026-10-10, to 2026-10-01 → text "วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด"; request count unchanged */ });
it('back-forward restores the search box text from the URL', async () => { /* push ?q=นาวา, then ?q= ; input value follows */ });
it('bulk action failure keeps the selection and announces the error in the live region', async () => { /* role=status contains the problem title */ });
it('KeyN on a list opens the create route; KeyN while typing in the search box does not', async () => {});

// useLineGridKeys / LineGrid tests
it('pasted "1.005" and typed "1.005" produce the same price text (M9)', () => { /* both → "1.00" via moneyText */ });
it('Enter on an unmatched description commits free text and moves to the qty cell (T11)', async () => {});

// QueryProvider.test.tsx
it('does not retry 4xx, retries 5xx once', async () => {});
it('a 409 version conflict surfaces doc.version_conflict to the caller', async () => {});

// CorrectionPlanDialog
it('confirm is disabled while a newer plan is loading (T12)', async () => {});
it('plan amounts are formatted as Thai baht', async () => { /* "1,070.00" not "1070.00" */ });

// ChainPanel / LedgerTab
it('chain 403 renders ForbiddenState naming doc.<T>.read', async () => {});
it('ledger tab without ledger.read is disabled with the permission named (D-09)', async () => {});

// CancelDialog
it('shows the document total and the reversal date before confirming (rule 3)', async () => {});
```
Each test body above is written in full by the implementer following the existing test file's helpers
(`renderWithClient`, the MSW `server.use(...)` overrides already used in `DocList.test.tsx` / `DocView.test.tsx`);
every listed assertion in the comment is mandatory and each test must fail before its fix.

- [ ] **Step 2: Run to verify they fail** — `corepack pnpm test src/kit src/lib/query` → the new tests FAIL.
- [ ] **Step 3: Implement** — one fix per test, plus (no test, visual): table row rules use `--color-rule-soft`;
  remove the unlayered `:focus-visible { box-shadow: none }` and re-check focus rings on `/style-guide`; input-group
  draws one outline; `CommandMenu` uses `shouldFilter={false}` (server results are already filtered);
  `/corrections` wraps the pre-execute `buildPlan` in the `plan_stale` handling (ledger 186). Mock: `/ledger` → 403
  `forbidden('ledger.read')` without the permission; compute omits `journal` without it.
- [ ] **Step 4: Run to verify they pass** — `corepack pnpm test` green; `corepack pnpm e2e e2e/ti-loop.spec.ts e2e/style-guide.spec.ts` green.
- [ ] **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `fix(frontend): SP1ab kit debt — list filters, paste, plan dialog, ledger.read gating`.

---

### Task F4: Ledger core — chart of accounts, posting profiles, periods, seed runner, invariant suite

**Depends on:** F3. **Review:** Opus (money, ledger).

**Files:**
- Create: `frontend/src/mocks/fixtures/coa.ts`, `frontend/src/mocks/fixtures/posting-profiles.ts`,
  `frontend/src/mocks/fixtures/bank-accounts.ts`, `frontend/src/mocks/fixtures/seed-runner.ts`,
  `frontend/src/mocks/engine/posting.ts` (+ `posting.test.ts`), `frontend/src/mocks/engine/periods.ts`
  (+ `periods.test.ts`), `frontend/src/mocks/engine/invariants.ts` (+ `invariants.test.ts`)
- Modify: `frontend/src/mocks/engine/ledger.ts`, `frontend/src/mocks/engine/log.ts` (clock),
  `frontend/src/mocks/engine/commands.ts` (`createDraft` seed id, period checks, `blockingLocks`),
  `frontend/src/mocks/engine/corrections.ts` (period lock not blocking), `frontend/src/mocks/store.ts`
  (`MockState` v3: `accounts`, `postingRules`, `periods`, `bankAccounts`; key `teas2.mock.state.v3`),
  `frontend/src/mocks/fixtures/index.ts`, `frontend/src/mocks/handlers/docs-read.ts` (derived period lock),
  `frontend/src/domain/types.ts` (`JournalEntryPreview.late?: boolean`), `frontend/src/kit/doc-view/LedgerTab.tsx`
  (label "แก้ไขย้อนหลัง"), `frontend/src/mocks/fixtures/ids.ts` (`tiPeriodLocked`), existing engine tests whose rule
  text changes.

**Interfaces:**
- Consumes: F1 `DOC_TYPES`, engine commands.
- Produces:

```ts
// src/mocks/engine/posting.ts
export type AccountingRole = 'AR' | 'AP' | 'Revenue' | 'SalesDiscount' | 'SalesReturn' | 'OutputVat' | 'InputVat'
  | 'InputVatUnclaimed' | 'WhtReceivable' | 'WhtPayable' | 'WhtExpense' | 'Pnd36VatPayable' | 'Cash' | 'CustomerDeposit'
  | 'VendorPrepayment' | 'Expense' | 'FixedAsset' | 'AccumulatedDepreciation' | 'DepreciationExpense' | 'DisposalGainLoss'
  | 'SalaryExpense' | 'PitPayable' | 'SsoPayable' | 'SsoExpense' | 'SalaryPayable' | 'EmployeePayable' | 'BankFee'
  | 'RoundingDifference' | 'SmallWriteOff' | 'RetainedEarnings' | 'OpeningBalanceEquity';
export interface PostingContext { companyId: string; docType: DocType; itemId?: string; expenseCategory?: string;
  assetClass?: string; partyGroup?: string; bankAccountId?: string; whtForm?: 'PND1' | 'PND2' | 'PND3' | 'PND53' | 'PND54' }
export interface Resolved { code: string; name: string; rule: string } // rule e.g. "ประเภทเอกสาร TI: Revenue → 4100"
/** SP0 §5.5: product/service → expense category or asset class → party group → document type → company default; first match wins. */
export function resolveRole(st: MockState, role: AccountingRole, ctx: PostingContext): Resolved; // throws MockError 422 'posting.unresolved'
export interface PostingRule { companyId: string; level: 'item' | 'category' | 'partyGroup' | 'docType' | 'default';
  key?: string; role: AccountingRole; accountCode: string }

// src/mocks/engine/ledger.ts — role-based
export type RolePosting = [AccountingRole, number, number, Partial<PostingContext>?][]; // [role, debit, credit] satang
export const POST: Partial<Record<DocType, (t: Totals, d: Doc, st: MockState) => RolePosting>>;
export function ledgerFor(st: MockState, doc: Doc): JournalPreview;   // signature unchanged
export const reversalOf: (e: JournalEntryPreview, date: string) => JournalEntryPreview; // unchanged

// src/mocks/engine/periods.ts
export interface Period { companyId: string; month: string; status: 'open' | 'closed'; closedAt?: string; reopened?: { at: string; reason: string }[] }
export const isClosed: (st: MockState, companyId: string, date: IsoDate) => boolean;
export const firstOpenDate: (st: MockState, companyId: string) => IsoDate;   // first day of the earliest open month ≥ today's month, or today
export function periodLock(st: MockState, companyId: string, date: IsoDate): Lock | undefined;

// src/mocks/engine/invariants.ts
/** Every violation in the state, as readable strings; [] = all hold. */
export function checkInvariants(st: MockState): string[];

// src/mocks/fixtures/seed-runner.ts
export interface SeedSpec { id: string; type: DocType; companyId: string; date: IsoDate; partyId?: string; lines: DocLine[];
  header?: Partial<DocHeader>; allocations?: Allocation[]; status: 'draft' | 'issued' | 'cancelled';
  convertFrom?: { id: string; lines: { sourceLineId: string; qty: Qty }[] }; by?: Actor; after?: (st: MockState) => void }
/** Executes specs in (date, list order) through createDraft / convert / issue / cancel with a pinned clock
 *  (`${date}T10:00:00+07:00` + n seconds). Throws on any engine error, naming the spec id. */
export function runSeed(st: MockState, specs: SeedSpec[]): void;

// src/mocks/engine/log.ts
export function withFixedClock<T>(iso: string, fn: () => T): T; // stamp() returns iso (+1 s per call) inside fn
```

**Chart of accounts (both companies, `fixtures/coa.ts`; `{ code, nameTh, class, subClass, parent?, postable, controlRole? }`):**
Headers (not postable): 1000 สินทรัพย์, 1100 สินทรัพย์หมุนเวียน, 1200 สินทรัพย์ไม่หมุนเวียน, 2000 หนี้สิน,
2100 หนี้สินหมุนเวียน, 3000 ส่วนของเจ้าของ, 4000 รายได้, 5000 ค่าใช้จ่าย.
Postable: 1110 เงินสด · 1120 เงินฝากธนาคาร (header for bank sub-accounts → make 1120 postable for the SP1ab seed AND add
1121 ธ.กสิกรไทย กระแสรายวัน, 1122 ธ.ไทยพาณิชย์ ออมทรัพย์) · 1130 ลูกหนี้การค้า (control AR) · 1140 เงินจ่ายล่วงหน้าผู้ขาย
(VendorPrepayment) · 1150 ค่าใช้จ่ายจ่ายล่วงหน้า · 1170 ภาษีซื้อ (control InputVat) · 1171 ภาษีซื้อยังไม่ถึงกำหนด ·
1180 ภาษีถูกหัก ณ ที่จ่าย (WhtReceivable) · 1210 อุปกรณ์สำนักงาน · 1211 ค่าเสื่อมราคาสะสม-อุปกรณ์ · 1220 ยานพาหนะ ·
1221 ค่าเสื่อมราคาสะสม-ยานพาหนะ · 2110 เจ้าหนี้การค้า (control AP) · 2120 ค่าใช้จ่ายค้างจ่าย · 2131 ภาษีหัก ณ ที่จ่ายค้างจ่าย
ภ.ง.ด.3 · 2132 ภ.ง.ด.53 · 2133 ภ.ง.ด.1 · 2134 ภ.ง.ด.54 · 2135 ภ.ง.ด.2 · 2140 เงินรับล่วงหน้าจากลูกค้า (CustomerDeposit) ·
2151 ภาษีขาย (control OutputVat) · 2152 ภาษีมูลค่าเพิ่มค้างจ่าย ภ.พ.36 · 2153 ภาษีเงินได้พนักงานค้างจ่าย · 2160 เงินประกันสังคม
ค้างจ่าย · 2170 เงินเดือนค้างจ่าย · 2180 เจ้าหนี้พนักงาน (EmployeePayable) · 3100 ทุนจดทะเบียน · 3200 กำไรสะสม ·
3300 กำไร(ขาดทุน)ปีปัจจุบัน · 3900 ส่วนเกินทุนยอดยกมา (OpeningBalanceEquity) · 4100 รายได้จากการขายและบริการ ·
4110 รับคืนสินค้า/ลดหนี้ (SalesReturn) · 4120 ส่วนลดจ่าย · 4200 รายได้อื่น · 4210 กำไรจากการจำหน่ายสินทรัพย์ ·
5100 ต้นทุนและค่าใช้จ่าย (SP1ab default Expense) · 5110 ค่าเช่า · 5120 ค่าบริการวิชาชีพ · 5130 ค่าโฆษณา · 5140 ค่าขนส่ง ·
5150 ค่ารับรอง · 5160 ค่าวัสดุสิ้นเปลือง · 5170 ภาษีซื้อที่ขอคืนไม่ได้ (InputVatUnclaimed) · 5180 ภาษีหัก ณ ที่จ่ายออกแทน
(WhtExpense) · 5200 ค่าธรรมเนียมธนาคาร (BankFee) · 5210 ผลต่างจากการปัดเศษ (RoundingDifference) · 5220 หนี้สูญ/ตัดจำหน่าย
เล็กน้อย (SmallWriteOff) · 5300 ค่าเสื่อมราคา · 5400 เงินเดือน · 5410 เงินสมทบประกันสังคม · 5500 ขาดทุนจากการจำหน่ายสินทรัพย์.

Company-default rules (`posting-profiles.ts`): AR→1130, AP→2110, Revenue→4100, SalesReturn→4110, SalesDiscount→4120,
OutputVat→2151, InputVat→1170, InputVatUnclaimed→5170, WhtReceivable→1180, WhtPayable→2131 (overridden per form by
docType-level rules: PND53→2132, PND1→2133, PND54→2134, PND2→2135 — `level: 'default', key: <form>`), WhtExpense→5180,
Pnd36VatPayable→2152, Cash→1120 (bank-account level overrides: `ba-kbank`→1121, `ba-scb`→1122, `ba-cash`→1110),
CustomerDeposit→2140, VendorPrepayment→1140, Expense→5100, BankFee→5200, RoundingDifference→5210, SmallWriteOff→5220,
DepreciationExpense→5300, SalaryExpense→5400, SsoExpense→5410, PitPayable→2153, SsoPayable→2160, SalaryPayable→2170,
EmployeePayable→2180, RetainedEarnings→3200, OpeningBalanceEquity→3900, DisposalGainLoss→4210 (gain) / 5500 (loss via
sign), FixedAsset / AccumulatedDepreciation per asset class (`equipment`→1210/1211, `vehicle`→1220/1221).
Bank accounts (`bank-accounts.ts`, both companies, ids prefixed `ba-` / `nba-`): กสิกรไทย กระแสรายวัน 012-3-45678-9
(1121), ไทยพาณิชย์ ออมทรัพย์ 405-2-11223-4 (1122), เงินสดย่อย (1110). Non-VAT company: `nba-kbank` (1121), `nba-cash` (1110).

**Money invariants (`checkInvariants`, all must hold for every company):**
1. Every journal entry: Σ debit = Σ credit (satang), every amount ≥ 0, every account code exists, is postable and owned
   by the company.
2. For every live document with `DOC_TYPES[type].outstanding`: `outstanding = total − Σ active CN/PCN adjusts + Σ active
   DN/PDN adjusts − Σ active settles amounts` (§7.11).
3. Status rule: `settled` ⇔ (has an active settlement AND outstanding ≤ 0); a document with outstanding ≤ 0 and no
   settlement is `issued` (Ham ruling).
4. Subledger = GL: per company, GL balance of 1130 (Dr − Cr over all entries) = Σ outstanding of live TI + IV;
   GL balance of 2110 (Cr − Dr) = Σ outstanding of live PB (from P2 on); GL 2180 = Σ outstanding of live EX (from P4).
5. Converted quantity per source line ≤ source quantity (active conversions).
6. Every link joins two documents of the same company; every non-draft document with `DOC_TYPES[type].ledger` has a
   journal (cancelled / replaced: original + reversal).
7. Every journal entry dated in a closed period was posted before the period closed (`kind: 'original'`) or is
   `late: true` dated on/after the first open date.

- [ ] **Step 1: Write the failing tests**

`src/mocks/engine/invariants.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { buildSeedState } from '../store';
import { checkInvariants } from './invariants';

describe('ledger invariants over the whole seed (S7)', () => {
  it('hold for the seed', () => { expect(checkInvariants(buildSeedState())).toEqual([]); });
  it('report an unbalanced entry (can fail)', () => {
    const st = buildSeedState(); const j = st.journals[0].preview.entries[0];
    j.lines[0] = { ...j.lines[0], debit: (Number(j.lines[0].debit) + 1).toFixed(2) };
    expect(checkInvariants(st).join('\n')).toMatch(/unbalanced/);
  });
  it('report an outstanding that disagrees with the links (can fail)', () => {
    const st = buildSeedState(); const l = st.links.find((x) => x.kind === 'settles' && x.active)!;
    l.amount = '1.00';
    expect(checkInvariants(st).join('\n')).toMatch(/outstanding/);
  });
  it('report AR subledger drift (can fail)', () => {
    const st = buildSeedState(); const d = st.docs.find((x) => x.type === 'TI' && x.status === 'issued')!;
    d.outstanding = '0.00';
    expect(checkInvariants(st).join('\n')).toMatch(/outstanding|1130/);
  });
});
```

`src/mocks/engine/posting.test.ts`
```ts
it('resolution order: item rule beats category, category beats docType, docType beats default', () => { /* add rules at each level for Revenue; resolveRole returns the item rule's account and its rule text names the level */ });
it('an unresolvable role throws posting.unresolved naming the role', () => {});
it('a TI journal names the rule that chose each account (§5.5 "ดู JE")', () => {
  // ledgerFor(seeded issued TI).entries[0].lines.map(l => l.rule) === ['ค่าเริ่มต้นบริษัท: AR → 1130', 'ค่าเริ่มต้นบริษัท: Revenue → 4100', 'ค่าเริ่มต้นบริษัท: OutputVat → 2151']
});
it('TI / CN / RC postings keep the SP1ab account codes (1130/4100/2151, 1120/1180/1130)', () => {});
```

`src/mocks/engine/periods.test.ts`
```ts
it('months ≤ 2026-06 are closed in the seed for both companies; 2026-07 onward open', () => {});
it('issue of a draft dated in a closed month → 422 period.closed with an exit message naming the month', () => {});
it('issue of a draft dated after today → 422 doc.future_date', () => {});
it('a TI dated in a closed month reads with a period lock whose exits are "แก้ไขย้อนหลัง" and reopen', () => {});
it('M2: correcting a period-locked TI (non-fiscal) revises; a fiscal change reissues — the lock never blocks', () => {
  // buildPlan(st, tiPeriodLocked, {party changed}) has a 'reissue' step (not "เอกสารถูกล็อก ทำไม่ได้");
  // after executePlan the reversal entry is dated firstOpenDate(st) with late: true; the replacement keeps the original date (I9).
});
```
Bodies follow `commands.test.ts` helpers (`test-helpers.ts`); every assertion named in a comment is mandatory.

- [ ] **Step 2: Run to verify they fail** — `corepack pnpm test src/mocks/engine` → FAIL.
- [ ] **Step 3: Implement**
  1. `log.ts`: module-level `let fixed: { base: number; n: number } | undefined`; `stamp()` returns
     `new Date(fixed.base + 1000 * fixed.n++).toISOString()` inside `withFixedClock`, else `new Date().toISOString()`.
  2. `createDraft(st, companyId, type, body, actor, key, opts?: { id?: string })` — `opts.id` is used verbatim (seed
     only; handlers never pass it). Throws if the id exists.
  3. COA, posting rules, bank accounts, periods into `MockState` (bump to v3 key; `loadState` ignores v2 blobs and
     reseeds). Periods: every month 2025-01 … 2026-06 `closed`, 2026-07 … 2026-12 `open`, both companies.
  4. `ledger.ts`: `POST` tables in roles (TI/IV: `[AR, total, 0], [Revenue, 0, net], [OutputVat, 0, vat]`; DN same;
     CN mirror with `SalesReturn` for the net; RC: `[Cash, total − wht, 0], [WhtReceivable, wht, 0], [AR, 0, total]`;
     PB/PDN: `[Expense, net, 0], [InputVat, vat, 0], [AP, 0, total]`; PCN mirror; PV: `[AP, total, 0], [Cash, 0, total]`
     (F5 replaces RC / PV with allocation-aware postings)). Each line resolved through `resolveRole` with the
     document's context; the rule string written into `rule`; dimensions copied from header / line.
  5. Corrections: `blockingLocks` = locks whose kind is neither `settlement` nor `period`. When the original entry's
     date is in a closed period, `reversalOf` and the correction entry use `firstOpenDate` and `late: true`.
  6. `mocks/engine/locks.ts` `derivedLocks(st, d)` (created in F2) gains the period lock for live documents; the GET
     doc handler and `fixtureIds` both call it (locks are added at read time, never stored).
  7. Seed runner as specified; `fixtures/index.ts` keeps the SP1ab TI seed, then calls `runSeed` with an empty list
     (later tasks append their specs to `fixtures/specs/<group>.ts` files imported here in group order).
  8. `invariants.ts` implements rules 1–7 (rule 4 for 1130 now; 2110 and 2180 activate when P2 / P4 seed PB / EX —
     write them now, they hold vacuously).
  9. `ids.ts`: add `tiPeriodLocked`.
- [ ] **Step 4: Run to verify they pass** — `corepack pnpm test src/mocks` green; `corepack pnpm e2e e2e/ti-loop.spec.ts` green.
- [ ] **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(mock): chart of accounts, posting profiles, periods and the ledger invariant suite`.

---

### Task F5: Settlement (allocations) and WHT engine; amount line editor; settlement panel

**Depends on:** F4. **Review:** Opus (money).

**Files:**
- Create: `frontend/src/mocks/fixtures/wht-types.ts`, `frontend/src/mocks/engine/wht.ts` (+ `wht.test.ts`),
  `frontend/src/mocks/engine/settlement.ts` (+ `settlement.test.ts`),
  `frontend/src/kit/doc-editor/{SettlementPanel,WhtSummary}.tsx` (+ `SettlementPanel.test.tsx`)
- Modify: `frontend/src/domain/types.ts`, `frontend/src/mocks/engine/{commands,corrections,ledger,vat,log}.ts`,
  `frontend/src/mocks/fixtures/{parties,items}.ts` (`entityKind`, WHT codes `SVC`), `frontend/src/mocks/handlers/{docs-read,docs-write}.ts`
  (`/docs/open-items`, allocations through create / update / compute / issue), `frontend/src/lib/api/endpoints.ts`,
  `frontend/src/lib/query/keys.ts`, `frontend/src/kit/doc-editor/{DocEditor,LineGrid,TotalsPanel,HeaderFields}.tsx`,
  `frontend/src/mocks/engine/invariants.ts` (RC / PV rules), messages.

**Interfaces:**

```ts
// src/domain/types.ts (additions)
export type WhtMode = 'deduct' | 'grossup_once' | 'grossup_always';
export interface Allocation { targetId: string; targetType: DocType; targetNumber?: string; amount: Money; wht?: Money;
  whtTypeCode?: string; certNumber?: string }
// DocHeader += { whtMode?: WhtMode; bankAccountId?: string; paymentMethod?: 'transfer' | 'cash' | 'cheque';
//                cheque?: { number: string; date: IsoDate; bank: string } }
// DocLine   += { whtTypeCode?: string; expenseCategory?: string }
// Doc       += { allocations?: Allocation[] }      DocInput (endpoints.ts) += { allocations?: Allocation[] }
// DocTotals += { cash?: Money }                    // money that moves: received (RC) / paid (PV)
// PartySummary += { entityKind: 'individual' | 'juristic' | 'foreign' }
// ChainEdge += { wht?: Money }
export interface WhtLine { code: string; nameTh: string; form: 'PND2' | 'PND3' | 'PND53' | 'PND54'; base: Money; rate: string; tax: Money; income: Money }
// ComputeResult += { whtLines?: WhtLine[]; allocation?: { allocated: Money; unallocated: Money; suggestedWht: { targetId: string; wht: Money; whtTypeCode?: string }[] } }
export interface OpenItem { id: string; type: DocType; number: string; documentDate: IsoDate; dueDate?: IsoDate; total: Money; outstanding: Money }

// src/lib/api/endpoints.ts
openItems: (p: { partyId: string; types: DocType[] }) => api<OpenItem[]>('GET', `/docs/open-items${qs({ partyId: p.partyId, types: p.types.join(',') })}`),
// src/lib/query/keys.ts
openItems: (c: string, partyId: string, types: string) => [c, 'open-items', partyId, types] as const,

// src/mocks/engine/wht.ts
export interface WhtType { code: string; nameTh: string; rateBp: number; incomeType: string; pnd2?: boolean; pnd54?: boolean; effectiveFrom: IsoDate }
export function formFor(t: WhtType, payee: PartySummary): WhtLine['form'];   // pnd54 → PND54; pnd2 && individual → PND2; individual → PND3; else PND53
export function computeWht(lines: { net: number; whtTypeCode?: string }[], mode: WhtMode, payee: PartySummary, date: IsoDate, st: MockState):
  { lines: WhtLine[]; tax: number; expense: number };  // satang; expense = tax borne by us (gross-up modes), 0 for deduct
// src/kit/doc-editor/SettlementPanel.tsx — props
export function SettlementPanel(p: { descriptor: DocDescriptor; partyId?: string; value: Allocation[]; onChange: (a: Allocation[]) => void;
  allocation?: ComputeResult['allocation']; readOnly?: boolean }): JSX.Element;
```

**WHT type fixtures (`wht-types.ts`, both companies, `effectiveFrom: '2020-01-01'`, `[SP-R]`):** RENT 5 % 40(5);
SVC 3 % 40(8); SVC-IND 3 % 40(8); ADS 2 % 40(8); PROF 3 % 40(6); TRANS 1 % 40(8); COMM 3 % 40(2); ROYAL 3 % 40(3);
INT 1 % 40(4)ก; INT-IND 15 % 40(4)ก pnd2; PRIZE 5 % 40(8); AGRI 0.75 % 40(8); ENTERTAIN 5 % 40(8); CONTRACT 3 % 40(7);
FOR-SVC 15 % pnd54; FOR-ROYAL 15 % pnd54.

**Formulas (satang, half away from zero; per WHT type `t` with base `B_t` = Σ net of lines with that type, rate `r`):**
- `deduct`: `tax_t = round(B_t × r)`; `income_t = B_t`; document `wht = Σ tax_t`; `cash = total − wht`; `expense = 0`.
- `grossup_always`: `income_t = round(B_t / (1 − r))`; `tax_t = round(income_t × r)`; `cash = total`; `expense = Σ tax_t`.
- `grossup_once`: `income_t = round(B_t × (1 + r))`; `tax_t = round(income_t × r)`; `cash = total`; `expense = Σ tax_t`.
- RC (customer withholds, per allocation): `suggestedWht = round(service net of the target × rate × amount / target total)`
  using the target's service lines' WHT type; the user may type the certificate's figure; engine refuses
  `Σ wht > Σ amount` (`rc.wht_exceeds_amount`).

**Allocation rules (engine, `settlement.ts`):** each target is live, same company, same party, of a type in the
descriptor's `settles`; `amount > 0`; `amount ≤ target outstanding` at issue time (`settle.over_allocation`, message
names the target number and its outstanding); a target appears once. RC total = Σ allocation amounts + deposit
remainder (lines total for a non-VAT cash bill); PV total = Σ allocation amounts + Σ line totals.
On issue: one `settles` link per allocation (`amount`, `wht`) and `recomputeSettlement` for each target; cancel
deactivates them (SP1ab behaviour); `reissue` carries each link with its own amount (M3 kept).

**Postings (replace F4's RC / PV rows):**
- RC: `[Cash, cash, 0], [WhtReceivable, Σwht, 0], [AR, 0, Σ amount], [CustomerDeposit, 0, remainder], [Revenue, 0, line net]` (cash bill lines, non-VAT only).
- PV: `[AP, Σ alloc to PB, 0], [EmployeePayable, Σ alloc to EX, 0], [Expense, line net, 0], [InputVat, line vat, 0] (only via PB, so 0 here), [WhtExpense, expense, 0], [WhtPayable per form, Σ tax, 0 → credit], [Cash, 0, cash]`.
  Balance check: `Σ alloc + line total + expense = cash + Σ tax` for each mode (deduct: `cash = total − tax`, expense 0;
  gross-up: `cash = total`, expense = tax).

**Correction plan RC path (brief + ledger 184):** `runStep` for an RC `reissue` re-creates **one settlement per link
the old receipt had active before the plan's cancel step** (captured into the plan context at plan build time, with
each link's `amount` and `wht`), re-targeting a link whose TI was reissued earlier in the plan to the new TI; the
RC-own changed-total plan checks each target's outstanding (`settle.over_allocation`).

- [ ] **Step 1: Write the failing tests**

`src/mocks/engine/settlement.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { checkInvariants } from './invariants';
import { buildSeedState } from '../store';
import { createDraft, issue, cancel } from './commands';
import { correctionPlan, executePlan } from './corrections';
import { toSatang } from './money';
import { USER } from '../fixtures/documents';

const out = (st: ReturnType<typeof buildSeedState>, id: string) => toSatang(st.docs.find((d) => d.id === id)!.outstanding!);

describe('multi-target receipt (§5.11, §7.11)', () => {
  it('one RC settles two TIs partly with WHT; cash + WHT receivable = Σ allocations; each outstanding follows the formula', () => {
    const st = buildSeedState();
    const [a, b] = st.docs.filter((d) => d.companyId === 'co-vat' && d.type === 'TI' && d.status === 'issued' && !d.locks.length
      && d.party?.id === 'pc-01').slice(0, 2); // fixture guarantee: pc-01 has ≥ 2 unpaid TIs (added to ids.ts as rcTargetsA/B)
    const before = [out(st, a.id), out(st, b.id)];
    const rc = createDraft(st, 'co-vat', 'RC', { header: { partyId: 'pc-01', documentDate: '2026-10-14', bankAccountId: 'ba-kbank' }, lines: [],
      allocations: [{ targetId: a.id, targetType: 'TI', amount: '1000.00', wht: '30.00', whtTypeCode: 'SVC' }, { targetId: b.id, targetType: 'TI', amount: '500.00' }] } as never, USER, 'k1');
    const done = issue(st, rc.id, rc.version, USER);
    expect(done.totals.total).toBe('1500.00');
    expect(done.totals.cash).toBe('1470.00');
    expect([out(st, a.id), out(st, b.id)]).toEqual([before[0] - 100000, before[1] - 50000]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('refuses an allocation above the outstanding (settle.over_allocation)', () => {});
  it('refuses Σ wht > Σ amount (rc.wht_exceeds_amount)', () => {});
  it('cancelling the RC restores both outstanding amounts exactly', () => {});
  it('correcting TI a (customer name) re-creates BOTH settlements: a′ gets 1000, b keeps 500 (brief: fixed multi-invoice settlement)', () => {
    // build the RC above; plan = correctionPlan(st, a.id, {party changed to pc-02 … same lines}, 'accountant');
    // executePlan; then: new RC links = [{to: a′, amount 1000, wht 30}, {to: b, amount 500}]; out(b) unchanged from after-RC value;
    // out(a′) = total − 1000; Σ new RC link amounts = new RC total; checkInvariants(st) = [].
  });
  it('an unallocated remainder becomes a customer deposit (Cr 2140) and is not an AR credit', () => {});
});
```

`src/mocks/engine/wht.test.ts`
```ts
it.each([
  // [mode, base satang, rate bp, tax, income, cashDelta]  (cash = total − tax for deduct; = total otherwise)
  ['deduct', 500000, 300, 15000, 500000],
  ['grossup_always', 500000, 300, 15464, 515464],   // income = round(5000 / 0.97) = 5154.64; tax = round(154.6392) = 154.64
  ['grossup_once', 500000, 300, 15450, 515000],     // income = 5150.00; tax = 154.50
])('%s: base %i at %i bp → tax %i, income %i', (mode, base, bp, tax, income) => { /* computeWht one line → lines[0].tax/income; expense = 0 for deduct else tax */ });
it('one WT line per WHT type; Σ lines tax = document wht (I7)', () => {});
it('form routing: SVC to an individual → PND3, to a juristic → PND53; INT-IND → PND2; FOR-SVC → PND54', () => {});
it('PV journal balances in all three modes (Dr = Cr)', () => {});
```

`src/kit/doc-editor/SettlementPanel.test.tsx`
```ts
it('lists the party open items with outstanding and prefills amount = outstanding when ticked (copy of a server string)', async () => {});
it('shows allocated / unallocated from the compute response, never sums in the client', async () => { /* mock compute returns allocated "1,500.00"; panel shows it even if rows sum differently */ });
it('error loading open items shows ErrorState, not "ไม่มีรายการค้าง"', async () => {});
it('re-mounts empty on company switch', async () => {});
```

- [ ] **Step 2: Run to verify they fail** — `corepack pnpm test src/mocks/engine src/kit/doc-editor/SettlementPanel.test.tsx` → FAIL.
- [ ] **Step 3: Implement** — types; `entityKind` on every seeded party (individuals: the four `คุณ…` customers and
  `pc-09/pc-10`; foreign: `Northwind Studio`; rest juristic); replace item / vendor WHT codes `PND3-40` / `PND53-3`
  with `SVC`; `computeWht`; allocations through `createDraft` / `updateDraft` / `compute` / `issue` / `cancel` /
  `reissue`; `isFiscalChange` includes allocations except `certNumber`; `diffBody` covers allocations;
  `stripOverrides` strips engine-only fields; `GET /docs/open-items`; `HAS_OUT` → `DOC_TYPES[t].outstanding`;
  invariants: RC `cash + Σwht = Σ amount + remainder + cash-bill net`; PV balance identity above.
  Kit: `LineGrid` gains the `amount` column set (รายการ / หมวดค่าใช้จ่าย / จำนวนเงิน / ภาษี / หัก ณ ที่จ่าย; the
  category column only when the descriptor's party is a vendor or employee); `SettlementPanel` rendered by `DocEditor`
  when `descriptor.settles`; `WhtSummary` inside `TotalsPanel` renders `whtLines` and `cash` (labels "หัก ณ ที่จ่าย",
  "ยอดชำระสุทธิ"); header defaults for every paying / receiving document (needed by the PV action count, D-15, and the
  RC flow): `paymentMethod = 'transfer'`, `bankAccountId` = the company's default bank account (fixture flag
  `default: true` on `ba-kbank` / `nba-kbank`), `whtMode = 'deduct'` — set by the engine when absent, so "ยังขาดอะไร"
  never asks for them; `HeaderFields` renders `bankAccount` (select from `/records/bank-account` once M1 exists — until
  then from `GET /bff/v1/bank-accounts`, a read handler added here over `st.bankAccounts`), `paymentMethod`,
  `cheque` (shown when method = cheque), `whtMode`. Add fixture keys `rcTargetsA`, `rcTargetsB` (two unpaid TIs of
  `pc-01`; add a seeded issued TI for `pc-01` in the TI seed only if the predicate finds fewer than two — prefer a
  runSeed spec so the SP1ab ids stay unchanged).
- [ ] **Step 4: Run to verify they pass**; `checkInvariants(buildSeedState())` still `[]`.
- [ ] **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(mock): allocations, multi-target settlement and the WHT engine; settlement panel`.

---

### Task F6: Report kit, reports API and the trial balance

**Depends on:** F5.

**Files:**
- Create: `frontend/src/domain/reports.ts`, `frontend/src/kit/report/{ReportView,ReportParams,ReportTable,TieOutBanner}.tsx`
  (+ `ReportView.test.tsx`), `frontend/src/mocks/engine/reports/{index,trial-balance}.ts` (+ `trial-balance.test.ts`),
  `frontend/src/mocks/handlers/reports.ts`, `frontend/src/app/(app)/reports/financial-statements/page.tsx`,
  `frontend/e2e/reports-tb.spec.ts`
- Modify: `frontend/src/lib/api/endpoints.ts`, `frontend/src/lib/query/keys.ts`, `frontend/src/mocks/handlers/index.ts`,
  `frontend/src/mocks/permissions.ts` (`report.read` → accountant, admin), `frontend/src/app-shell/nav.ts`
  (financialStatements → `report.read`), `frontend/src/app/mock/screens/screens.ts`, messages.

**Interfaces:**

```ts
// src/domain/reports.ts
export type ReportKind = 'trial-balance' | 'profit-loss' | 'balance-sheet' | 'general-ledger' | 'ar-aging' | 'ap-aging'
  | 'customer-statement' | 'vendor-ledger' | 'sales-summary' | 'purchase-summary' | 'outstanding-po' | 'vat-output-register'
  | 'vat-input-register' | 'wht-receivable' | 'missing-wht-cert' | 'number-gaps' | 'audit-log' | 'asset-register'
  | 'bank-reconciliation' | 'tax-summary';
export interface ReportParamSpec { key: string; kind: 'date' | 'month' | 'year' | 'range' | 'party' | 'account' | 'dimension' | 'select' | 'bool';
  labelKey: string; options?: { value: string; labelKey: string }[]; required?: boolean }
export interface ReportColumn { key: string; labelKey: string; align?: 'start' | 'end'; kind?: 'money' | 'date' | 'text' | 'qty' }
export interface ReportRow { level: 0 | 1 | 2; kind: 'group' | 'row' | 'subtotal' | 'total'; cells: Record<string, string>; href?: string }
export interface TieOut { labelKey: string; left: Money; right: Money; diff: Money } // diff computed by the server
export interface ReportModel { kind: ReportKind; titleKey: string; params: Record<string, string>; asOf?: IsoDate;
  columns: ReportColumn[]; rows: ReportRow[]; tieOuts?: TieOut[]; notes?: string[] }
// endpoints.getReport(kind, params) → ReportModel ; qk.report(c, kind, params) → [c, 'report', kind, params]
export function ReportView(p: { kind: ReportKind; params: ReportParamSpec[]; defaults: Record<string, string>; exportable?: boolean }): JSX.Element;
```
`ReportView` behaviour: parameters live in the URL (`useSearchParams`); the query runs only when every required
parameter is set ("แสดงรายงาน" is not needed — parameters apply on change, debounced 300 ms); states: loading (skeleton
rows), empty (no rows → `EmptyState` "ไม่มีรายการในช่วงที่เลือก"), error, forbidden (names the permission), and a
`TieOutBanner` (amber, `data-screen-state="locked"` is NOT used; it is `role="status"`) when any `tieOut.diff ≠ 0.00`.
Export: "ส่งออก CSV" downloads `GET /reports/:kind/export?…` (mock returns `text/csv` with BOM, CRLF); "พิมพ์" opens
the browser print of the report region. Remounts on company switch (`useCompanyEpoch`).

**Trial balance (`trial-balance.ts`):** params `asOf` (date, default today), `dimension` (optional `type:value`),
`includeZero` (bool). Rows: every postable account with movement up to `asOf` (or all with includeZero), columns
`code`, `name`, `debit`, `credit` (balance side); total row; **invariant: total debit = total credit** (computed in
satang, `tieOuts: [{ labelKey: 'reports.tb.balanced', left: Σdebit, right: Σcredit, diff }]`). Account rows link to
`/reports/general-ledger?account=<code>` (route built in RP1; until then the link target renders ComingInSp1c).
Route: `/reports/financial-statements` page renders tabs งบทดลอง / กำไรขาดทุน / งบแสดงฐานะการเงิน / บัญชีแยกประเภท; only
งบทดลอง is live in F6 (the others are RP1).

- [ ] **Step 1: Write the failing tests**

```ts
// src/mocks/engine/reports/trial-balance.test.ts
it('Σ debit = Σ credit on the seed for both companies, at today and at 2026-06-30', () => {});
it('balance of 1130 equals Σ outstanding of live TI + IV (subledger tie-out)', () => {});
it('an asOf before every entry returns no rows and zero totals', () => {});
it('the dimension filter keeps only lines carrying that value (and still balances when whole entries carry it)', () => {});

// src/kit/report/ReportView.test.tsx
it('does not query until required params are set', async () => {});
it('error shows ErrorState and never the empty state', async () => {});
it('tie-out diff ≠ 0 shows the amber banner naming both sides', async () => {});
it('company switch drops the previous company rows', async () => {});
```
`e2e/reports-tb.spec.ts`
```ts
import { expect, test } from '@playwright/test';
import { screenContract } from './helpers/screen-contract';
screenContract({ name: 'trial balance', path: '/reports/financial-statements?tab=tb', heading: 'งบการเงิน', company: 'both',
  states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
test('TB totals are equal and shown as baht', async ({ page }) => {
  await page.goto('/reports/financial-statements?tab=tb');
  const total = page.getByRole('row', { name: /รวม/ });
  const cells = await total.getByRole('cell').allTextContents();
  expect(cells.at(-1)).toBe(cells.at(-2));
  expect(cells.at(-1)).toMatch(/^\d{1,3}(,\d{3})*\.\d{2}$/);
});
```
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(frontend): report kit and trial balance`.

---

### Task G00: Controller gate (no Ham gate)

- [ ] Run the consolidated gate (Haiku gate runner): lint, typecheck, unit, full e2e.
- [ ] Personal diff read of F1–F6; confirm `rg -n "'TI'" frontend/src/kit` prints nothing and
  `rg -n "VAT_ONLY|HAS_OUT|CONVERT_TO" frontend/src` prints nothing.
- [ ] Update `STATUS.md`: "SP1c group 00 done; TI loop green on the generic routes".
