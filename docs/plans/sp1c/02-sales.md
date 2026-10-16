# SP1c group 02 — Sales (QT, SO, DO, IV, BL, RC, CN, DN + document-wide parity)

> Part of `docs/plans/2026-10-14-sp1c-all-screens.md`. Depends on groups 00 and 01. Tasks S1 → S6 → gate GS.
> TI already exists (SP1b); this group adds the other eight sales types and the cross-cutting document features.

**Parity coverage (Appendix C "Sales")**

| Appendix C item | Task |
|---|---|
| quotation create / edit draft / send / accept / reject / cancel / convert to SO and TI | S1 (send = issue) |
| sales order create / edit / post / auto-close on delivery | S2 |
| delivery order issue / deliver; draft edit; entry point | S2 |
| billing note with grouped TIs, non-VAT accrual, cancel | S3 (IV = non-VAT accrual document; BL = grouping) |
| tax invoice draft / edit / post / cancel / cancel-and-reissue / replacement discard | SP1b (done) |
| receipt applied to TIs, BNs or standalone cash bill, customer WHT with late 50ทวิ number, cancel / reissue | S4 |
| credit and debit notes with reason codes, line-based | S5 |
| original / copy print tracking and reprint confirm | S6 |
| document chain rail | SP1b (ChainPanel) + every type's links |
| per-document activity log and attachments (11 categories) | SP1b (activity) + S6 (attachments) |
| default notes per document type | S6 (applies) + ST1 (edits) |
| agent-draft approval banner | S6 |

**Shared for every sales descriptor:** `partyKind: 'customer'`; permissions `doc.<T>.{read,create,issue,cancel,correct}`;
messages `docTypes.<T>.{title,issue,create,empty}`; fixtures through `runSeed` (file `src/mocks/fixtures/specs/sales.ts`,
imported by `fixtures/index.ts`); every new printable type registers a `PAPERS` component and a `PAPER_BUILDERS` entry;
every task appends its `SCREENS` rows and fixture keys.

---

### Task S1: Quotation + ConvertDialog + CommercialPaper + document marks

**Depends on:** M2.

**Files:**
- Create: `frontend/src/descriptors/quotation.ts`, `frontend/src/mocks/fixtures/specs/sales.ts`,
  `frontend/src/mocks/engine/marks.ts` (+ test), `frontend/src/kit/doc-view/{ConvertDialog,MarksChips}.tsx` (+ tests),
  `frontend/src/kit/paper/CommercialPaper.tsx` (+ test), `frontend/e2e/sales-qt.spec.ts`
- Modify: `frontend/src/descriptors/index.ts`, `frontend/src/domain/types.ts` (`DocMarks`, `Doc.marks`,
  `DocSummary.marks`, `PaperModel.revisionLabel?`, `PaperModel.vatLines` optional for non-VAT), `frontend/src/mocks/engine/commands.ts`
  (`convert` checks rejected, stamps accepted; `revise` clears accepted / rejected for QT),
  `frontend/src/mocks/handlers/docs-write.ts` (`/marks`, `/remaining`), `frontend/src/mocks/engine/paper.ts`,
  `frontend/src/kit/paper/registry.ts`, `frontend/src/kit/doc-view/{ActionBar,DocView}.tsx`, `frontend/src/kit/pages/columns.tsx`
  (`marks`), `frontend/src/mocks/permissions.ts`, `frontend/src/domain/permissions.ts`, `frontend/src/lib/api/endpoints.ts`, messages, `screens.ts`, `ids.ts`.

**Interfaces:**

```ts
// src/descriptors/quotation.ts
export const quotation: DocDescriptor = {
  type: 'QT', correctionClass: 'N', vat: 'both', titleTh: 'ใบเสนอราคา', titleEn: 'Quotation', partyKind: 'customer',
  lineEditor: 'item', basePath: '/sales/quotations',
  permissions: { read: 'doc.QT.read', create: 'doc.QT.create', issue: 'doc.QT.issue', cancel: 'doc.QT.cancel', correct: 'doc.QT.correct' },
  convertsTo: ['SO', 'TI', 'IV'], listColumns: ['number', 'date', 'party', 'total', 'status', 'marks'],
  savedViews: ['draft', 'cancelled'], headerFields: ['documentDate', 'dueDate', 'reference', 'notes'], // dueDate labelled "ยืนราคาถึง" for QT (message key docEditor.dueDate.QT)
};
// src/domain/types.ts
export interface DocMarks { accepted?: { at: string; by: string }; rejected?: { at: string; by: string; reason: string };
  delivered?: { at: string; by: string }; sent?: { at: string; by: string }; closed?: { at: string; by: string; reason: string } }
export interface RemainingLine { lineId: string; description: string; unit: string; ordered: Qty; converted: Qty; remaining: Qty; closed: boolean }
// endpoints
setMark: (type: DocType, id: string, mark: 'accepted' | 'rejected' | 'delivered' | 'sent', version: number, reason?: string) => api<Doc>('POST', `/docs/${type}/${id}/marks`, { mark, version, reason }),
getRemaining: (type: DocType, id: string) => api<RemainingLine[]>('GET', `/docs/${type}/${id}/remaining`),
// kit
export function ConvertDialog(p: { source: Doc; targets: DocType[]; onDone: (created: Doc) => void; onClose: () => void }): JSX.Element;
export function CommercialPaper(p: { model: PaperModel }): JSX.Element; // QT SO DO BL IV PO; titles from model
```

Mark rules (`marks.ts`): allowed marks per type — QT: accepted, rejected (reason required); DO: delivered; PO: sent.
Only on live documents; rejected → convert refused 409 `qt.rejected` ("ใบเสนอราคานี้ถูกปฏิเสธแล้ว — แก้ไขเป็นฉบับใหม่หรือคัดลอกเป็นใบใหม่");
setting accepted clears rejected and vice versa; an N-class revision of a QT clears both; converting a QT stamps
`accepted` if absent. Marks are logged in activity ("ลูกค้าตอบรับ", "ลูกค้าปฏิเสธ: <reason>") and audit, not revisions.

`ConvertDialog`: target select (only `convertsTo` ∩ `isTypeAvailable` ∩ `doc.<target>.create`), a table of
`getRemaining` lines with a qty input per line (default = remaining text; 0 removes the line), "สร้าง<target>" button;
server refusal `doc.over_conversion` shown inline on the dialog with the engine's message; success → navigate to the
new draft's edit route. Replaces the SP1b dropdown in `ActionBar` (the menu becomes one "แปลงเป็น…" button).

`CommercialPaper` (Sarabun, A4, same pagination helper as TI): title per type (`ใบเสนอราคา / QUOTATION`), seller
block (company), buyer block, lines (no, description, qty, unit, unit price, amount), totals (VAT rows only when the
model has `vatLines`; non-VAT company: no VAT row, no "ใบกำกับภาษี" wording, I3), notes, `revisionLabel`
("ฉบับแก้ไขครั้งที่ n", §7.3 N-class), signature row per type (QT: ผู้เสนอราคา / ผู้อนุมัติ / ลูกค้ายืนยันสั่งซื้อ).

**Fixtures (`specs/sales.ts`, ids explicit):**
- VAT: `qt-d1`, `qt-d2` drafts (pc-02, pc-05); `qt-acc` issued + accepted not converted (pc-03, 2 lines);
  `qt-rej` issued + rejected "ราคาสูงกว่างบประมาณ" (pc-06); `qt-can` cancelled (pc-07, reason "ลูกค้ายกเลิกโครงการ").
- Non-VAT (`co-nonvat`): `nqt-d1` draft (nc-01), `nqt-1` issued (nc-02), `nqt-2` issued + accepted (nc-05) — S2 converts it.
- Fixture keys: `qtDraft`, `qtIssued` (`qt-acc`), `qtRejected`, `qtCancelled`, `qtRevised` (SP1ab `qt-r1`), `nqtIssued`.

**Permissions:** operator + `doc.QT.issue`; accountant + `doc.QT.issue`, `doc.QT.cancel`, `doc.QT.correct`
(read / create already exist).

- [x] **Step 1: Write the failing tests**

`src/mocks/engine/marks.test.ts`
```ts
it('reject requires a reason; accepted clears rejected and vice versa', () => {});
it('converting a rejected QT is refused with qt.rejected; after a revision it converts and is stamped accepted', () => {});
it('marks never create a revision and never change totals', () => {});
it('a QT → SO conversion of 3 of 10 units leaves 7 remaining; a second conversion of 8 is refused (doc.over_conversion)', () => {});
```
`src/kit/doc-view/ConvertDialog.test.tsx`
```ts
it('offers only targets available to the company and permitted to the role (TI hidden on non-VAT, IV hidden on VAT)', async () => {});
it('qty defaults to the server remaining text; 0 drops the line; over-conversion error shown inline', async () => {});
```
`src/kit/paper/CommercialPaper.test.tsx`
```ts
it('non-VAT model renders no VAT row and never the word "ใบกำกับภาษี"', () => {});
it('revisionLabel prints on every page', () => {});
```
`e2e/sales-qt.spec.ts`
```ts
import { expect, test } from '@playwright/test';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';
screenContract({ name: 'QT list', path: '/sales/quotations', heading: 'ใบเสนอราคา', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'QT view', path: async (p) => `/sales/quotations/${await fixtureId(p, 'qtIssued')}`, heading: /QT-\d{6}-\d{4}/, company: 'vat', states: ['loading', 'error', 'forbidden'] });
test('accept → convert 1 of 2 lines to SO → remaining shown on the QT chain', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'qtIssued');
  await page.goto(`/sales/quotations/${id}`);
  await page.getByRole('button', { name: 'แปลงเป็น…' }).click();
  const dlg = page.getByRole('dialog', { name: /แปลงใบเสนอราคา/ });
  await dlg.getByLabel('เอกสารปลายทาง').selectOption('SO');
  await dlg.getByRole('spinbutton').nth(1).fill('0');
  await dlg.getByRole('button', { name: 'สร้างใบสั่งขาย' }).click();
  await expect(page).toHaveURL(/\/sales\/sales-orders\/[^/]+\/edit$/);
  await page.goto(`/sales/quotations/${id}`);
  await expect(page.locator('[data-mark="accepted"]')).toBeVisible();
});
test('reject needs a reason and blocks conversion with an exit', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'qtRejected');
  await page.goto(`/sales/quotations/${id}`);
  await expect(page.locator('[data-mark="rejected"]')).toContainText('ปฏิเสธ');
  await expect(page.getByRole('button', { name: 'แปลงเป็น…' })).toBeDisabled();
  await expect(page.getByText(/แก้ไขเป็นฉบับใหม่หรือคัดลอกเป็นใบใหม่/)).toBeVisible();
});
test('non-VAT QT prints without VAT', async ({ page }) => {
  await page.goto('/?company=nonvat'); const id = await fixtureId(page, 'nqtIssued');
  await page.goto(`/print/QT/${id}`);
  await expect(page.getByText('ภาษีมูลค่าเพิ่ม')).toHaveCount(0);
});
```
- [x] **Step 2: Run → FAIL** (`corepack pnpm test src/mocks/engine/marks.test.ts src/kit/doc-view src/kit/paper`; `corepack pnpm e2e e2e/sales-qt.spec.ts`).
- [x] **Step 3: Implement** as specified; `MarksChips` next to `StatusChip` in DocView header and the `marks` list
  column (`data-mark` attribute; chip tones reuse `--color-status-approved-*` for accepted / delivered / sent and
  `--color-status-overdue-*` for rejected; closed uses `cancelled` tones). ActionBar adds "ลูกค้าตอบรับ" /
  "ลูกค้าปฏิเสธ" for QT (`doc.QT.issue`), each behind a small dialog (reject: reason textarea required).
- [x] **Step 4: Run → PASS**; `checkInvariants` still `[]`.
- [x] **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(sales): quotations, conversion dialog, commercial paper and document marks`.

---

### Task S2: Sales order + delivery order, delivery progress, close remainder

**Depends on:** S1.

**Files:**
- Create: `frontend/src/descriptors/{sales-order,delivery-order}.ts`, `frontend/src/kit/dialogs/CloseRemainderDialog.tsx`, `frontend/e2e/sales-so-do.spec.ts`
- Modify: `descriptors/index.ts`, `mocks/engine/{commands,chain,marks}.ts` (`closeRemainder`, `consumed` honours closed lines, progress for SO/DO/PO),
  `mocks/handlers/docs-write.ts` (`/close-remainder`), `mocks/engine/paper.ts`, `kit/paper/registry.ts`, `kit/pages/columns.tsx` (`progress`), `specs/sales.ts`, permissions, messages, `screens.ts`, `ids.ts`.

**Interfaces:**
- salesOrder: `type 'SO'`, `basePath '/sales/sales-orders'`, `convertsTo ['DO','TI','IV']`, listColumns
  `['number','date','party','total','progress','status','marks']`, savedViews `['draft','cancelled']`, headerFields
  `['documentDate','dueDate','reference','notes']` (dueDate label "กำหนดส่ง").
- deliveryOrder: `type 'DO'`, `basePath '/sales/delivery-orders'`, `convertsTo ['TI','IV']`, same columns,
  headerFields `['documentDate','reference','notes']`.
- `closeRemainder(st, id, version, reason, actor)`: N-class live SO / DO / PO; marks `closed`; remaining of every line
  becomes 0 for conversion purposes (`RemainingLine.closed = true`), progress text appends "(ปิดยอดคงเหลือ)"; reversible
  by an N-class revision (clears `closed`) — the exit.
- Progress (derived, never stored): SO "ส่งแล้ว x/y" (Σ DO qty / Σ SO qty) and "ส่งครบ" when equal; DO "วางบิลแล้ว x/y".
- DO "ส่งของแล้ว" mark (`delivered`) is status-only (Appendix B: delivered no longer issues a TI).

**Fixtures:** VAT: `so-d1` draft; `so-part` issued (pc-04, 2 lines 20 + 10 units) with `do-part` issued for 10 + 0;
`so-closed` issued then close-remainder "ลูกค้าขอยกเลิกส่วนที่เหลือ"; `do-dlv` issued + delivered (from `so-u1`).
Non-VAT: `nso-1` converted from `nqt-2`, `ndo-1` from `nso-1` (delivered). Keys: `soPartlyDelivered`, `soClosed`,
`doDelivered`, `nsoIssued`, `ndoDelivered`.

**Permissions:** operator + `doc.SO.create/issue`, `doc.DO.create/issue`; accountant + SO/DO create/issue/cancel/correct.

- [x] **Step 1: Write the failing tests**
```ts
// commands / chain tests
it('SO progress = Σ active DO qty / Σ SO qty; cancelling the DO returns the quantity (§7.11)', () => {});
it('close-remainder sets remaining 0 for every line; a revision of the SO clears it (exit)', () => {});
it('DO → BL conversion is refused (D-07)', () => {});
```
`e2e/sales-so-do.spec.ts`: `screenContract` rows for SO list, SO view (`soPartlyDelivered`), DO list, DO view
(`doDelivered`) — both companies for lists; plus
```ts
test('SO partly delivered shows "ส่งแล้ว 10/30"; close remainder needs a reason; then convert is disabled with the exit', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'soPartlyDelivered');
  await page.goto(`/sales/sales-orders/${id}`);
  await expect(page.getByText('ส่งแล้ว 10/30')).toBeVisible();
  await page.getByRole('button', { name: 'ปิดยอดคงเหลือ' }).click();
  const dlg = page.getByRole('alertdialog', { name: 'ปิดยอดคงเหลือ' });
  await expect(dlg.getByRole('button', { name: 'ยืนยันปิดยอดคงเหลือ' })).toBeDisabled();
  await dlg.getByLabel('เหตุผล').fill('ลูกค้าไม่รับส่วนที่เหลือ');
  await dlg.getByRole('button', { name: 'ยืนยันปิดยอดคงเหลือ' }).click();
  await expect(page.locator('[data-mark="closed"]')).toBeVisible();
});
```
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(sales): sales orders and delivery orders with progress and close-remainder`.

---

### Task S3: Invoice (non-VAT) + billing statement; company-aware VAT (I1)

**Depends on:** S2. **Review:** Opus (money: IV ledger, I1).

**Files:**
- Create: `frontend/src/descriptors/{invoice,billing-statement}.ts`, `frontend/src/kit/doc-editor/GroupPanel.tsx` (+ test), `frontend/e2e/sales-iv-bl.spec.ts`
- Modify: `mocks/engine/{vat,commands,ledger,paper}.ts`, `mocks/engine/invariants.ts`, `mocks/handlers/docs-write.ts`,
  `kit/doc-editor/DocEditor.tsx` (render `GroupPanel` when `descriptor.groups`), `kit/paper/registry.ts`, `specs/sales.ts`, permissions, messages, `screens.ts`, `ids.ts`.

**Interfaces:**
- invoice: `type 'IV'`, `correctionClass 'L'`, `vat 'non-vat-only'`, `titleTh 'ใบแจ้งหนี้'`, `titleEn 'Invoice'`,
  `basePath '/sales/invoices'`, `convertsTo ['BL','RC']`, listColumns as TI, savedViews `['draft','outstanding','overdue','cancelled']`,
  headerFields `['documentDate','dueDate','reference','notes']`.
- billingStatement: `type 'BL'`, `correctionClass 'N'`, `vat 'both'`, `titleTh 'ใบวางบิล'`, `lineEditor 'none'`,
  `groups: ['TI','IV']` (only types available to the company), `basePath '/sales/billing-statements'`,
  listColumns `['number','date','party','total','dueDate','status']`, headerFields `['documentDate','dueDate','notes']`.
  BL content = `allocations` (amount = target outstanding at issue, informational) → `groups` links; total = Σ.
  No ledger. Cancel releases the links. "รับชำระ" action on BL → `/sales/receipts/new?fromBl=<id>` (S4 consumes).
- Engine `calc(body, vatRegistered)`: when `!vatRegistered`, every line's VAT = 0 regardless of tax code (I1);
  callers pass the company flag (consumer list: `compute`, `insertDraft`, `updateDraft`, `issue`, `revise`, `reissue`,
  `noteFor`, `PAPER_BUILDERS`). IV posting `[AR, total, 0], [Revenue, 0, net]`. IV revise (L): reverse + repost;
  refused when the new total is below Σ active settlements (`settle.below_settled`, exit "ยกเลิกหรือถอนการรับชำระก่อน")
  — T5 deferred item. IV cancel blocked while settled (SP1ab rule, now via `DOC_TYPES.outstanding`).

**Money invariants (tests):** for every non-VAT document `totals.vat = 0.00`; for IV `outstanding = total − Σ settles`;
`GL(1130) = Σ outstanding(TI ∪ IV)` per company; BL total = Σ grouped target outstanding at issue and BL has no journal.

**Fixtures:** non-VAT: `iv-d1` draft; `iv-1..3` issued (nc-01, nc-03, nc-06); `iv-p1`, `iv-p2` partly settled
(receipts in S4's spec file — add them there, or here as `RC` specs with allocations since F5 supports them);
`iv-s1`, `iv-s2` settled; `iv-can` cancelled. VAT: `bl-1` grouping two unpaid TIs of pc-01; non-VAT `nbl-1`
grouping `iv-1` + `iv-2`? (different parties are refused — group only same party: use `iv-1` and a second IV of nc-01,
`iv-4`). Keys: `ivDraft`, `ivIssuedUnpaid`, `ivPartly`, `ivSettled`, `blVat`, `blNonVat`.

**Permissions:** `doc.IV.*` and `doc.BL.*` as the SP0 role intent (operator create / issue; accountant all).

- [x] **Step 1: Write the failing tests**
```ts
it('non-VAT company: an S7 line computes VAT 0.00 and the IV journal has no 2151 line (I1)', () => {});
it('IV revise below the settled amount is refused with settle.below_settled; above it reverses and reposts (Dr = Cr)', () => {});
it('BL refuses a target of another party or another company; cancel releases the group links', () => {});
it('checkInvariants holds after seeding IV / BL', () => {});
// GroupPanel.test.tsx
it('lists only same-party open TI / IV, shows the server total, never sums', async () => {});
```
`e2e/sales-iv-bl.spec.ts`: `screenContract` IV list `company: 'nonvat'` (VAT company → not-available, "บริษัทที่จดทะเบียน
VAT ใช้ใบกำกับภาษีแทน"), IV view (`ivPartly`) with states incl. `locked`, BL list `company: 'both'`, BL view (`blVat`).
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(sales): non-VAT invoices and billing statements; company-aware VAT`.

---

### Task S4: Receipts — multi-invoice settlement, customer WHT, late 50 ทวิ, cash bill, cancel / reissue

**Depends on:** S3. **Review:** Opus (money).

**Files:**
- Create: `frontend/src/descriptors/receipt.ts`, `frontend/src/kit/paper/ReceiptPaper.tsx` (+ test), `frontend/e2e/sales-rc.spec.ts`
- Modify: `kit/pages/DocNewPage.tsx` (`?settle=<docId>` and `?fromBl=<id>` prefill), `kit/doc-view/ActionBar.tsx`
  ("รับชำระ" on TI / IV / BL), `kit/doc-editor/{DocEditor,SettlementPanel}.tsx` (`linesWhen`), `mocks/engine/{commands,paper}.ts`,
  `specs/sales.ts`, permissions, messages, `screens.ts`, `ids.ts`.

**Interfaces:**
- receipt: `type 'RC'`, `correctionClass 'T'`, `vat 'both'`, `titleTh 'ใบเสร็จรับเงิน'`, `titleEn 'Receipt'`,
  `lineEditor 'amount'`, `linesWhen 'non-vat'`, `settles ['TI','IV']`, `basePath '/sales/receipts'`,
  listColumns `['number','date','party','total','status']`, savedViews `['draft','cancelled']`,
  headerFields `['documentDate','bankAccount','paymentMethod','cheque','reference','notes']`.
- Engine: VAT company RC with lines → 422 `rc.lines_need_invoice` ("บริษัทที่จดทะเบียน VAT ต้องออกใบกำกับภาษีก่อนรับชำระ");
  RC with neither allocations nor lines nor a deposit amount → `doc.incomplete`. Deposit: header `depositAmount?: Money`
  (add to `DocHeader`) — the unallocated remainder; posting `CustomerDeposit` (F5). Late certificate: editing
  `allocations[].certNumber` on an issued RC is a non-fiscal in-place edit (T-class rule, §7.3) through the SP1b revise
  path; the activity says "บันทึกเลขที่หนังสือรับรองหัก ณ ที่จ่าย <no>".
- Correction: RC fiscal change → SP1b plan (cancel + reissue); with several targets the F5 multi-link re-creation applies.
- `ReceiptPaper`: title "ใบเสร็จรับเงิน / RECEIPT"; table of settled documents (number, date, amount, WHT); "รับเงินสุทธิ",
  "ภาษีถูกหัก ณ ที่จ่าย", "รวมรับชำระ", amount in words (server), payment method + bank / cheque; non-VAT cash bill
  prints its lines.

**Money invariants (tests, each a formula):** `cash + Σwht = Σ allocation amount + depositAmount + cash-bill net`;
every target's `outstanding = total − ΣCN + ΣDN − Σ active settles`; `GL(1180)` movement of the RC = `Σwht`;
cancelling the RC restores every target to its pre-RC outstanding; reissuing the RC (plan) keeps each target's settled
amount (multi-target vector from F5 repeated through the UI in e2e).

**Fixtures:** VAT: SP1ab receipts stay; add `rc-multi` (pc-01, settles `rcTargetsA` 1,000.00 with WHT SVC 30.00 cert
"ท.2569/0451" + `rcTargetsB` 500.00), `rc-nocert` (WHT without cert number — feeds TX2's chase list), `rc-dep` deposit
5,000.00 from pc-08 with no allocation. Non-VAT: receipts for `iv-p1`, `iv-p2` (partial), `iv-s1`, `iv-s2` (full), and
`nrc-cash` cash bill (nc-04, 2 lines). Keys: `rcMulti`, `rcNoCert`, `rcDeposit`, `nrcCashBill`.

**Permissions:** operator + RC create / issue (exists); accountant + cancel / correct (exist).

- [x] **Step 1: Write the failing tests**
```ts
it('RC paper lists each settled TI with its amount and WHT; totals come from the model', () => {});
it('VAT-company RC with cash-bill lines is refused rc.lines_need_invoice', () => {});
it('late cert number edit is non-fiscal: same number, revision +1, no journal change', () => {});
```
`e2e/sales-rc.spec.ts`
```ts
screenContract({ name: 'RC list', path: '/sales/receipts', heading: 'ใบเสร็จรับเงิน', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
test('receive one payment for two invoices with WHT from the first invoice view', async ({ page }) => {
  await page.goto('/'); const a = await fixtureId(page, 'rcTargetsA');
  await page.goto(`/sales/tax-invoices/${a}`);
  await page.getByRole('link', { name: 'รับชำระ' }).click();
  const panel = page.getByRole('region', { name: 'รายการที่รับชำระ' });
  await panel.getByRole('checkbox').nth(1).check();               // second open TI of the same customer
  await panel.getByLabel(/จำนวนรับชำระ/).first().fill('1000.00');
  await panel.getByLabel(/ภาษีถูกหัก/).first().fill('30.00');
  await expect(page.getByRole('region', { name: 'ยอดรวม' })).toContainText('หัก ณ ที่จ่าย');
  await page.keyboard.press('Control+Enter');
  await page.getByRole('alertdialog').getByRole('button', { name: /บันทึกและออก/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^RC-\d{6}-\d{4}$/);
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByRole('link', { name: /TI-\d{6}-\d{4}/ })).toHaveCount(2);
});
test('non-VAT cash bill: line grid visible; VAT company: line grid absent', async ({ page }) => {
  await page.goto('/sales/receipts/new?company=nonvat');
  await expect(page.getByRole('grid', { name: 'รายการ' })).toBeVisible();
  await page.goto('/sales/receipts/new?company=vat');
  await expect(page.getByRole('grid', { name: 'รายการ' })).toHaveCount(0);
});
```
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS**; invariants `[]`.
- [x] **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(sales): receipts with multi-invoice settlement, customer WHT and cash bills`.

---

### Task S5: Credit and debit notes (line-based, reason codes, cap)

**Depends on:** S4. **Review:** Opus (money, compliance).

**Files:**
- Create: `frontend/src/descriptors/{credit-note,debit-note}.ts`, `frontend/src/mocks/fixtures/reason-codes.ts`,
  `frontend/src/kit/paper/AdjustmentNotePaper.tsx` (+ test), `frontend/e2e/sales-cn-dn.spec.ts`
- Modify: `mocks/engine/{commands,corrections,paper}.ts`, `kit/doc-editor/HeaderFields.tsx` (`refDoc`, `reason`),
  `kit/pages/DocNewPage.tsx` (`?adjust=<tiId>` prefill from the TI's lines), `kit/doc-view/ActionBar.tsx`
  ("ออกใบลดหนี้" / "ออกใบเพิ่มหนี้" on a live TI), `kit/doc-view/useCorrectionFlow.tsx` (CN-only plan lands on the CN —
  M4), `specs/sales.ts`, permissions, messages, `screens.ts`, `ids.ts`.

**Interfaces:**
- creditNote: `type 'CN'`, `correctionClass 'T'`, `vat 'vat-only'`, `titleTh 'ใบลดหนี้'`, `adjusts 'TI'`,
  `basePath '/sales/credit-notes'`, `lineEditor 'item'`, listColumns `['number','date','party','total','reference','status']`,
  headerFields `['documentDate','refDoc','reason','notes']`. debitNote: same with `type 'DN'`, `titleTh 'ใบเพิ่มหนี้'`,
  `basePath '/sales/debit-notes'`.
- `DocHeader.refDocId` (original TI id), `reasonCode`, `reasonText`. Reason codes (`[SP-R]`): CN — `RETURN`
  "รับคืนสินค้า / สินค้าชำรุด", `PRICE_REDUCTION` "ลดราคาสินค้าหรือบริการ", `DISCOUNT` "ส่วนลดที่ให้ภายหลัง", `SERVICE_SHORT`
  "บริการไม่ครบตามสัญญา", `OTHER` "อื่น ๆ (ระบุ)"; DN — `PRICE_INCREASE` "เพิ่มราคาสินค้าหรือบริการ", `QTY_EXCESS`
  "ส่งสินค้าเกินจำนวน", `OTHER`. `OTHER` requires `reasonText`.
- Lines reference the original: `sourceLineId` = original TI line id; G3 cap: for each original line,
  Σ active CN line nets referencing it ≤ the original line net (`cn.exceeds_original`, message names the line and the
  remaining creditable amount); DN uncapped. A CN / DN without `refDocId` → `doc.incomplete` ("ต้องอ้างอิงใบกำกับภาษี").
- I9 guard for CN / DN reissue (T5 deferred): same date and total as the original note, else 422 `doc.reissue_total_changed`.
  Fiscal edits of an issued CN / DN outside a plan → 422 `doc.revise_not_allowed` (ledger 193).
- `AdjustmentNotePaper` (ม.86/10 elements): title, number, date, original TI number + date, original value,
  correct value, difference, VAT on the difference, reason (Thai text, never the code), buyer / seller tax identity.
  `PaperModel.adjusts?: { number: string; date: IsoDate; originalNet: Money; correctNet: Money; diffNet: Money }` (server).
- Ledger 184 vectors, as visible pending tests in `corrections.test.ts`:
  `it.todo('SP2 vector: settlement lock vs CN — a CN on a paid TI may not take outstanding below −(…) [ledger 184]')`,
  `it.todo('SP2 vector: second correction must account for existing CN/DN [ledger 184]')`.

**Money invariants:** `TI outstanding = total − Σ CN totals + Σ DN totals − Σ settles` after each note (credited-to-
zero unpaid TI stays `issued`, Ham ruling); CN journal = mirror of the sales posting on its own totals (`SalesReturn`,
`OutputVat` debit, `AR` credit); Σ CN net per original line ≤ original line net.

**Fixtures:** SP1ab `cn-1`, `cn-2` stay; add `cn-ret` (RETURN, 2 lines referencing a TI with 2 lines), `dn-1`
(PRICE_INCREASE), `cn-full` (full credit of an unpaid TI → TI stays `issued` with outstanding 0.00). Keys `cnIssued`,
`dnIssued`, `tiCreditedToZero`.

**Permissions:** operator reads CN / DN only; accountant + `doc.CN.*`, `doc.DN.*` (create / issue exist; add read,
cancel, correct).

- [x] **Step 1: Write the failing tests**
```ts
it('CN above the remaining creditable amount of a line → cn.exceeds_original naming the line', () => {});
it('CN without refDocId → doc.incomplete; reason OTHER without text → doc.incomplete', () => {});
it('full CN of an unpaid TI leaves it issued with outstanding 0.00 (Ham ruling)', () => {});
it('CN reissue with a different total → doc.reissue_total_changed', () => {});
it('paper prints the reason text, never the code, and the ม.86/10 original / correct / difference values', () => {});
```
`e2e/sales-cn-dn.spec.ts`: `screenContract` CN list / DN list `company: 'vat'` (non-VAT → not-available), CN view
(`cnIssued`); flow "TI view → ออกใบลดหนี้ → lines prefilled from the TI → reduce qty of line 1 → reason RETURN → issue →
TI outstanding drops by the CN total (read from the TI header before / after)".
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(sales): line-based credit and debit notes with reason codes`.

---

### Task S6: Document-wide parity — print tracking, attachments, default notes, agent drafts, agent filter

**Depends on:** S5.

**Files:**
- Create: `frontend/src/kit/doc-view/{AttachmentsPanel,AgentBanner,ReprintDialog}.tsx` (+ tests),
  `frontend/src/mocks/engine/attachments.ts`, `frontend/src/mocks/fixtures/default-notes.ts`, `frontend/e2e/sales-common.spec.ts`
- Modify: `kit/doc-view/{DocView,ActionBar}.tsx`, `kit/doc-editor/DocEditor.tsx` (attachments while creating; default
  notes prefill for a blank create), `kit/doc-list/DocList.tsx` (saved view `agent`, "สร้างโดย AI" chip), `mocks/handlers/docs-write.ts`
  (`/printed`, `/attachments`), `mocks/store.ts` (`attachments`, `prints`), `domain/types.ts` (`Attachment`,
  `Doc.printCount?`), messages.

**Interfaces:**
```ts
export type AttachmentCategory = 'customer_po' | 'purchase_order' | 'delivery' | 'vendor_tax_invoice' | 'receipt' | 'transfer_slip'
  | 'contract' | 'photo' | 'wht_certificate' | 'government' | 'other';   // D-30 (labels in messages)
export interface Attachment { id: string; docId: string; category: AttachmentCategory; name: string; size: number; mime: string; dataUrl: string; at: string; by: string }
// endpoints: listAttachments(type,id), addAttachment(type,id,{category,name,mime,dataUrl}), removeAttachment(type,id,attId), markPrinted(type,id,copy)
```
- Print tracking: first print of an issued document = "ต้นฉบับ"; afterwards the print action opens `ReprintDialog`
  ("พิมพ์ซ้ำจะพิมพ์เป็น 'สำเนา'") and prints `?copy=1`; every print logs activity "พิมพ์ต้นฉบับ" / "พิมพ์สำเนา".
- Storage: attachment **bytes are never put in the mock-state blob** — each data URL is stored under its own
  `localStorage` key `teas2.mock.att.<id>` and `MockState.attachments` keeps metadata only; a write that fails on quota
  returns 507 `attachment.storage_full` ("พื้นที่เก็บไฟล์ตัวอย่างเต็ม — ลบไฟล์แนบเก่าหรือรีเซ็ตข้อมูลตัวอย่าง") instead of
  silently not persisting (the state blob's `saveState` swallows quota errors). "รีเซ็ตข้อมูลตัวอย่าง" also clears the
  `teas2.mock.att.*` keys.
- Attachments: ≤ 1 MB per file (`attachment.too_large`), pdf / png / jpeg / webp (`attachment.type_not_allowed`);
  allowed while drafting (stored against the draft id; kept on issue); removal on issued documents allowed with audit.
- Default notes: `GET /settings/default-notes` → `Partial<Record<DocType, string>>` (fixture; ST1 edits it); a blank
  new document's notes are prefilled; copy / convert keep the source notes.
- Agent: documents with `createdBy.kind === 'agent'` show `AgentBanner` ("ร่างโดย ผู้ช่วยบัญชี (AI) ของ สมศรี บัญชีดี" +
  "ดูรายงานการตรวจ" when `reportId`) on view and editor; DocList saved view `agent` (`?agent=1`, F3 param).

- [x] **Step 1: Write the failing tests** — `ReprintDialog` appears only from the second print; attachment > 1 MB
  refused with the Thai message; default notes prefill only a blank create (not copy / convert); agent saved view
  filters server-side; banner absent on user documents.
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(frontend): print tracking, attachments, default notes and agent drafts`.

---

### Task GS: Ham gate — sales

- [x] Consolidated gate green; production build / staging; screen index lists every sales screen × states × roles ×
  both companies.
- [x] Send Ham: URLs; the QT accept / reject marks (D-05, D-06); ConvertDialog partial conversion; SO close-remainder;
  non-VAT IV + BL; RC multi-invoice with WHT and late certificate; CN / DN line-based with reason codes (`[SP-R]` list,
  R-08 still parked); print tracking; attachments (D-30 list — open item O-6); TI action count still ≤ 5.
- [x] AskUserQuestion "Sales approve?" — approve / approve with changes / rework. Record in `STATUS.md`; changes become
  appended tasks.
