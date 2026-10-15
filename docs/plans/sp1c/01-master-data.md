# SP1c group 01 — Master data (record kit, customers, vendors, items)

> Part of `docs/plans/2026-10-14-sp1c-all-screens.md`. Depends on group 00. Tasks M1 → M2 → gate GM.

**Parity coverage (Appendix C "Master data" + Purchases "vendor quick-create")**

| Appendix C item | Task |
|---|---|
| customers (individual / corporate, VAT flag, branch, credit terms) | M1 |
| vendors (foreign, VAT-D, remittance bank) | M1 |
| vendor quick-create from documents | M2 |
| products / services (type → VAT treatment, WHT default, usage flags, BU scope → dimensions) | M2 |
| employees, WHT types, expense categories, COA, bank accounts, business units | PY1, ST3, ST2, AC2, FN1, ST2 (dimensions) |

---

### Task M1: Record kit + customers and vendors

**Depends on:** F6.

**Files:**
- Create: `frontend/src/domain/records.ts`, `frontend/src/domain/records.contract.test.ts`,
  `frontend/src/records/{index,customers,vendors}.ts`, `frontend/src/kit/record-list/RecordList.tsx` (+ test),
  `frontend/src/kit/record-form/{RecordForm,fields}.tsx` (+ test), `frontend/src/kit/record-view/RecordView.tsx`,
  `frontend/src/kit/pages/{RecordListPage,RecordViewPage}.tsx`, `frontend/src/mocks/records/{registry,parties}.ts`
  (+ `registry.test.ts`), `frontend/src/mocks/handlers/records.ts`, `frontend/e2e/master-parties.spec.ts`
- Modify: `frontend/src/app/(app)/[group]/[slug]/page.tsx` and `[id]/page.tsx` (resolve record descriptors after doc
  descriptors), `frontend/src/lib/api/endpoints.ts`, `frontend/src/lib/query/keys.ts`, `frontend/src/domain/types.ts`
  (`PartySummary` + `partyGroup?`, `bankAccount?`, `contact?`), `frontend/src/domain/permissions.ts`,
  `frontend/src/mocks/permissions.ts`, `frontend/src/app-shell/nav.ts` (customers / vendors permission unchanged:
  `party.read`), `frontend/src/app/mock/screens/screens.ts`, messages.

**Interfaces:**

```ts
// src/domain/records.ts
export type RecordKind = 'customer' | 'vendor' | 'item' | 'bank-account' | 'employee' | 'account' | 'dimension'
  | 'wht-type' | 'expense-category' | 'posting-rule' | 'numbering-series' | 'approval-rule' | 'user' | 'role'
  | 'api-key' | 'oauth-app' | 'agent-policy' | 'settlement' | 'schedule';
export type FieldKind = 'text' | 'textarea' | 'tin' | 'branch' | 'select' | 'money' | 'percent' | 'int' | 'date' | 'bool' | 'account' | 'party' | 'item';
export interface FieldSpec { key: string; kind: FieldKind; labelKey: string; required?: boolean; options?: { value: string; labelKey: string }[];
  showWhen?: { key: string; equals: string | boolean }; readOnlyAfterUse?: boolean; vat?: VatScope }
export interface RecordColumn { key: string; labelKey: string; align?: 'start' | 'end'; kind?: 'text' | 'money' | 'bool' | 'date' }
export interface RecordDescriptor { kind: RecordKind; basePath: string; titleKey: string; permissions: { read: string; manage: string };
  columns: RecordColumn[]; fields: FieldSpec[]; detail: boolean; vat?: VatScope; searchPlaceholderKey: string }
export interface RecordRow { id: string; version: number; active: boolean; inUse?: boolean; [field: string]: unknown }

// src/records/index.ts
export const RECORDS: Partial<Record<RecordKind, RecordDescriptor>>; // M1: customer, vendor
export function recordByPath(path: string): RecordDescriptor | undefined;

// src/lib/api/endpoints.ts
listRecords: (kind: RecordKind, p: { q?: string; active?: 'true' | 'false' | 'all'; limit?: number; cursor?: string; [k: string]: string | number | undefined }) => api<Page<RecordRow>>('GET', `/records/${kind}${qs(p)}`),
getRecord: (kind: RecordKind, id: string) => api<RecordRow>('GET', `/records/${kind}/${encodeURIComponent(id)}`),
createRecord: (kind: RecordKind, values: Record<string, unknown>, idempotencyKey: string) => api<RecordRow>('POST', `/records/${kind}`, values, { idempotencyKey }),
updateRecord: (kind: RecordKind, id: string, values: Record<string, unknown>, version: number) => api<RecordRow>('PUT', `/records/${kind}/${encodeURIComponent(id)}`, { ...values, version }),
setRecordActive: (kind: RecordKind, id: string, active: boolean, version: number) => api<RecordRow>('POST', `/records/${kind}/${encodeURIComponent(id)}/active`, { active, version }),
// qk.records(c, kind, params) / qk.record(c, kind, id)

// src/mocks/records/registry.ts
export interface RecordKindImpl { perms: { read: string; manage: string }; vat?: VatScope;
  rows: (st: MockState, companyId: string) => RecordRow[];
  validate: (values: Record<string, unknown>, st: MockState, companyId: string, id?: string) => Record<string, string[]>; // fieldErrors, Thai
  create: (st: MockState, companyId: string, values: Record<string, unknown>) => RecordRow;
  update: (st: MockState, companyId: string, id: string, values: Record<string, unknown>) => RecordRow;
  canDeactivate?: (st: MockState, companyId: string, id: string) => string | undefined }  // reason when refused (with exit)
export const RECORD_IMPLS: Partial<Record<RecordKind, RecordKindImpl>>;
```

Handler rules (`handlers/records.ts`): `screenGate('list'|'item')`; 404 `record.kind_unknown`; VAT scope → 404
`record.not_available`; read → `perms.read`, write → `perms.manage` (403 names it); `validate` non-empty → 422
`record.invalid` with `fieldErrors`; version mismatch → 409 `record.version_conflict`; deactivation refused → 409
`record.in_use` with the reason as `detail` (e.g. "ใช้อยู่ในเอกสาร 12 ฉบับ — ปิดใช้งานได้ แต่เอกสารเดิมไม่เปลี่ยน" is NOT a
refusal; a refusal is only when a rule demands it, e.g. an account mapped by a posting rule). Every write appends
`logAudit(..., 'record.<kind>.<create|update|activate|deactivate>', id, before, after)`.

**Customer / vendor descriptors (exact):**
- customer: `basePath '/master/customers'`, `titleKey 'records.customer.title'` ("ลูกค้า"), perms `party.read` / `party.manage`,
  columns code, name, taxId, branch, vatRegistered (bool), paymentTermDays, active; fields: `entityKind` (select:
  individual / juristic / foreign, required), `code` (text, required, unique per kind within a company, `readOnlyAfterUse`), `name`
  (required), `nameEn`, `taxId` (tin; required when `vatRegistered` or juristic; checksum), `branchCode` (branch,
  5 digits, required with taxId; default 00000), `vatRegistered` (bool), `address` (textarea, required when
  `vatRegistered` — I3), `phone`, `email`, `paymentTermDays` (int ≥ 0), `partyGroup` (select from `party-groups`
  fixture: ทั่วไป / ลูกค้ารายใหญ่ / หน่วยงานรัฐ / ต่างประเทศ), `defaultWhtTypeCode` (select from WHT types — customer
  withholds), `notes`. `detail: true`.
- vendor: `basePath '/master/vendors'`, same perms, fields as customer plus `vatDRegistered` (bool, "จดทะเบียน VAT-D
  (ภ.พ.36 ไม่ต้องนำส่ง)", `showWhen entityKind = foreign`), `bankName`, `bankAccountNo`, `bankAccountName`
  (remittance), `defaultWhtTypeCode` (we withhold), `usualItemIds` (multi item picker, purchase usage). `detail: true`.
- Party detail (`RecordView`): header (name, TIN, branch, status chip active / inactive), tabs "ข้อมูล" (fields
  read-only + "แก้ไข" opening `RecordForm`), "เอกสาร" (a `DocList`-like table of this party's documents across types
  via `GET /docs/by-party/:partyId` — add the handler: summary rows of every type the role can read), "ยอดค้าง" (open
  items via `/docs/open-items`, with totals from the server: add `total` to that handler's response as
  `{ items, total }` — **change the F5 endpoint shape here and update `SettlementPanel`**).

Validation messages (mock, Thai): "เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (ตรวจสอบหลักสุดท้าย)", "ต้องระบุสาขา 5 หลัก",
"ผู้ซื้อที่จดทะเบียน VAT ต้องมีที่อยู่ตามทะเบียน", "รหัสนี้ใช้แล้ว", "รหัสแก้ไม่ได้หลังจากใช้ในเอกสารแล้ว".

**Fixtures:** existing parties gain `entityKind` (F5), `partyGroup`, `email`, vendor bank details for the 8 VAT
vendors and 5 non-VAT vendors (fictional banks/numbers), one inactive customer per company (`pc-13` "บริษัท เลิกกิจการ
ตัวอย่าง จำกัด", `nc-09` "ร้านปิดตัวชั่วคราว" — nc-08 already exists in the seed). Fixture keys: `customerVat` = `pc-01`, `customerIndividual` = `pc-09`,
`customerInactive` = `pc-13`, `vendorForeign` = (new) `pv-12` (pv-10 exists; pv-11 is reserved by plan 04) "Cloudberry Software Ltd. (ไอร์แลนด์)" entityKind foreign,
`vatDRegistered: false`.

**Permissions (mock roles):** operator + `party.manage`; accountant + `party.manage`; admin keeps `party.read`.

- [ ] **Step 1: Write the failing tests**

`src/domain/records.contract.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { NAV } from '@/app-shell/nav';
import { PERMISSIONS } from '@/domain/permissions';
import th from '@/messages/th.json';
import { RECORDS, recordByPath } from '@/records';
import type { RecordDescriptor } from './records';

export function checkRecord(r: RecordDescriptor): string[] {
  const e: string[] = [];
  if (!(r.permissions.read in PERMISSIONS)) e.push('read perm');
  if (!(r.permissions.manage in PERMISSIONS)) e.push('manage perm');
  const nav = NAV.flatMap((g) => g.items).find((i) => i.href === r.basePath);
  if (!nav || nav.permission !== r.permissions.read) e.push('nav');
  const get = (k: string) => k.split('.').reduce<unknown>((a, x) => (a as Record<string, unknown>)?.[x], th);
  for (const k of [r.titleKey, r.searchPlaceholderKey, ...r.columns.map((c) => c.labelKey), ...r.fields.map((f) => f.labelKey)]) if (typeof get(k) !== 'string') e.push(`msg:${k}`);
  for (const f of r.fields) if (f.showWhen && !r.fields.some((g) => g.key === f.showWhen!.key)) e.push(`showWhen:${f.key}`);
  return e;
}
describe('record registry', () => {
  for (const [kind, r] of Object.entries(RECORDS)) it(`${kind} satisfies the contract`, () => {
    expect(checkRecord(r!)).toEqual([]); expect(recordByPath(r!.basePath)).toBe(r);
  });
  it('the checker reports a broken record (can fail)', () => {
    expect(checkRecord({ ...RECORDS.customer!, permissions: { read: 'nope', manage: 'party.manage' }, titleKey: 'no.such' }))
      .toEqual(expect.arrayContaining(['read perm', 'msg:no.such']));
  });
});
```

`src/mocks/records/registry.test.ts`
```ts
it('customer: bad TIN checksum → fieldErrors.taxId', () => {});
it('customer: VAT-registered without address → fieldErrors.address (I3)', () => {});
it('customer: code is unique per kind within a company, and the same code is allowed in the other company', () => {});
it('customer: code is read-only once the party is used on a document', () => {});
it('update with a stale version → 409 record.version_conflict', () => {});
it('every write appends an audit entry with before/after', () => {});
it('vendor foreign: vatDRegistered allowed; taxId optional', () => {});
```

`src/kit/record-form/RecordForm.test.tsx`
```ts
it('maps server fieldErrors to the right inputs and focuses the first one', async () => {});
it('hides fields whose showWhen does not hold and does not send them', async () => {});
it('a 409 conflict shows the reload hint and keeps the typed values', async () => {});
it('remounts empty on company switch (no company-A values saved into B)', async () => {});
```

`src/kit/record-list/RecordList.test.tsx`
```ts
it('search, active filter and paging go to the server; empty vs error are distinct', async () => {});
it('create button is disabled with the manage permission named when missing', async () => {});
```

`e2e/master-parties.spec.ts`
```ts
import { expect, test } from '@playwright/test';
import { screenContract } from './helpers/screen-contract';
for (const [name, path, heading] of [['customers', '/master/customers', 'ลูกค้า'], ['vendors', '/master/vendors', 'ผู้ขาย']] as const) {
  screenContract({ name, path, heading, company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], roles: ['operator', 'accountant', 'admin'] });
}
test('create a customer with a bad TIN shows the checksum error; fix it and save', async ({ page }) => {
  await page.goto('/master/customers');
  await page.getByRole('button', { name: 'เพิ่มลูกค้า' }).click();
  const dialog = page.getByRole('dialog', { name: 'เพิ่มลูกค้า' });
  await dialog.getByLabel('ประเภท').selectOption('juristic');
  await dialog.getByLabel('รหัส').fill('C99');
  await dialog.getByLabel('ชื่อ', { exact: true }).fill('บริษัท ทดสอบระบบ จำกัด');
  await dialog.getByLabel('เลขประจำตัวผู้เสียภาษี').fill('0105500000001');
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog.getByText('เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง')).toBeVisible();
  // a valid fictional TIN: implementer computes it with tinCheckDigit('010550000000') in the test via page.evaluate-free constant
});
test('customer detail shows documents and open items from the server', async ({ page }) => {
  await page.goto('/master/customers/pc-01');
  await page.getByRole('tab', { name: 'ยอดค้าง' }).click();
  await expect(page.getByRole('row', { name: /TI-\d{6}-\d{4}/ }).first()).toBeVisible();
});
```

- [ ] **Step 2: Run → FAIL** (`corepack pnpm test src/domain/records.contract.test.ts src/mocks/records src/kit/record-form src/kit/record-list`; `corepack pnpm e2e e2e/master-parties.spec.ts`).
- [ ] **Step 3: Implement** — `RecordList` mirrors `DocList` states, search (server, debounced 300 ms, URL `?q=`),
  active filter (ใช้งาน / ปิดใช้งาน / ทั้งหมด), create button "เพิ่ม<title>" opening `RecordForm` in a Radix `Dialog`;
  rows link to `/<basePath>/<id>` when `detail`, else open the form. `RecordForm`: React Hook Form; Zod schema built
  from `FieldSpec` only for shape (required, digits, TIN checksum via `domain/tin.ts`); server `fieldErrors` mapped by
  key. `RecordView` for `detail: true` (tabs as above). Generic routes resolve `recordByPath` after
  `descriptorByPath`; `[id]` resolves `RecordViewPage`. All three remount on company switch.
- [ ] **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(frontend): record kit; customers and vendors`.

---

### Task M2: Items / services and quick-create from document editors

**Depends on:** M1.

**Files:**
- Create: `frontend/src/records/items.ts`, `frontend/src/mocks/records/items.ts`, `frontend/src/kit/doc-editor/QuickCreateParty.tsx` (+ test), `frontend/e2e/master-items.spec.ts`
- Modify: `frontend/src/records/index.ts`, `frontend/src/mocks/records/registry.ts`, `frontend/src/domain/types.ts`
  (`ItemSummary` + `usage: { sales: boolean; purchase: boolean }`, `expenseCategory?`, `active`),
  `frontend/src/mocks/fixtures/items.ts`, `frontend/src/mocks/handlers/items.ts` (`?usage=sales|purchase` filter),
  `frontend/src/kit/doc-editor/{PartyField,ItemField,DocEditor}.tsx`, `frontend/src/mocks/permissions.ts`, messages,
  `frontend/src/app/mock/screens/screens.ts`.

**Interfaces:**
- item record: `basePath '/master/items'`, perms `item.read` / `item.manage`, `detail: false`; columns code, name,
  kind (สินค้า / บริการ), unit, unitPrice, taxCode label, usage, active; fields `kind` (good / service), `code`
  (`readOnlyAfterUse`), `name`, `unit`, `unitPrice` (money), `taxCode` (select S7 / Z0 / EX, `vat: 'vat-only'`;
  non-VAT company: hidden, stored `EX`), `whtTypeCode` (select, `showWhen kind = service`), `usageSales`,
  `usagePurchase` (bool), `expenseCategory` (select from expense-category fixture, `showWhen usagePurchase = true`),
  `dimensionDefaults` (deferred to ST2: not in M2).
- `QuickCreateParty`: in `PartyField`, when the typed text has no match, the list's last option is
  "+ เพิ่ม<ลูกค้า|ผู้ขาย> “<text>”" (Enter on it opens the record form prefilled with the name, `entityKind`
  default juristic); on save the new party is picked and the editor continues (usual items none). Requires
  `party.manage`; without it the option is absent and the "ไม่พบ" hint names `party.manage`.
- `ItemField` searches with `usage` = `sales` when `partyKind === 'customer'`, `purchase` otherwise.

**Fixtures:** existing VAT items: services `usage {sales: true, purchase: false}`; add purchase items for the VAT
company: `EXP-01` ค่าเช่าสำนักงาน (service, RENT, category `rent`, 25,000.00), `EXP-02` ค่าบริการทำความสะอาด (service, SVC,
`services`, 8,500.00), `EXP-03` ค่าโฆษณาออนไลน์ (service, ADS, `advertising`, 12,000.00), `EXP-04` ค่าขนส่ง (TRANS,
`transport`, 1,800.00), `EXP-05` ค่าถ่ายภาพสินค้า (SVC, `services`, 5,000.00, used by the D-15 vendor), `EXP-06`
กระดาษ A4 (good, `supplies`, 115.00), `EXP-07` ค่ารับรองลูกค้า (`entertainment`, input VAT non-recoverable), `EXP-08`
เครื่องคอมพิวเตอร์โน้ตบุ๊ก (good, `capex-equipment`, 32,000.00). Non-VAT company: `nv-EXP-01` ค่าเช่าแผงตลาด (RENT,
3,000.00), `nv-EXP-02` ข้าวเปลือก (good, `cost-of-sales`, 12.00 / กก.), `nv-EXP-03` ค่าก๊าซหุงต้ม (good, 450.00).
Expense categories (`fixtures/expense-categories.ts`, read in M2; screen in ST2): `rent`→5110, `services`→5120 … per
F4 COA, `entertainment` (`recoverableVat: false`)→5150, `capex-equipment` (`capex: true`, asset class `equipment`),
`cost-of-sales`→5100, `supplies`→5160, `advertising`→5130, `transport`→5140.

**Permissions:** operator `item.read`; accountant `item.read`, `item.manage`; admin `item.read`, `item.manage`.

- [ ] **Step 1: Write the failing tests**

```ts
// mocks/records/items test
it('non-VAT company: taxCode is ignored on save and stored EX; the field is absent from its form', () => {});
it('an item used on a document keeps its code; deactivating it hides it from type-ahead but not from old documents', () => {});
// QuickCreateParty.test.tsx
it('no match → "+ เพิ่มผู้ขาย …" option → form prefilled → saved party is picked into the editor', async () => {});
it('without party.manage the option is absent and the hint names party.manage', async () => {});
```
`e2e/master-items.spec.ts`
```ts
import { screenContract } from './helpers/screen-contract';
screenContract({ name: 'items', path: '/master/items', heading: 'สินค้า/บริการ', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], roles: ['operator', 'accountant'] });
```
plus one e2e: on `/sales/tax-invoices/new`, type an unknown customer "บริษัท ลูกค้าใหม่ จำกัด", choose the add option,
fill a valid TIN + branch + address, save → the editor's party field shows the new name and "ยังขาดอะไร" no longer
lists the customer.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(frontend): items and services; quick-create parties from editors`.

---

### Task GM: Ham gate — master data

- [ ] Controller: consolidated gate green; production build (`corepack pnpm build`, `corepack pnpm start -p 3100`)
  or the staging URL; screen index lists customers, vendors, items, party detail with every state link.
- [ ] Send Ham: the URLs, the record-kit pattern (list + dialog form + detail), the validation messages, the quick-
  create flow, decisions D-27 and the role matrix for master data. AskUserQuestion "Master data approve?" — approve /
  approve with changes (notes) / rework.
- [ ] Record the answer in `STATUS.md`; each requested change becomes a task appended to this file (same structure).
