# SP1c group 03 — Purchases (PO, PB, PCN / PDN, PV + WT, EX, approval engine)

> Part of `docs/plans/2026-10-14-sp1c-all-screens.md`. Depends on group 02. Tasks P1 → P4 → gate GP.

**Parity coverage (Appendix C "Purchases")**

| Appendix C item | Task |
|---|---|
| PO create / edit / approve / mark sent / close / reopen / cancel | P1 (approve = issue or §7.6 approval; reopen = revision clears close) |
| vendor invoice with claim period, recoverable VAT, product type, PO link, completeness flag | P2 (PB) |
| vendor CN / DN, post-posting correction, draft edit for PV / VI | P2 (PCN / PDN), every type (L-class revise) |
| payment voucher with per-line WHT, gross-up modes, foreign vendor handling, cheque details, VI settlement, 50ทวิ at post | P3 |
| WHT certificate register and print | P3 (WT docs + view), TX2 (register list polish) |
| expense claim submit / approve / reject / pay with bank selection | P4 |
| fixed assets register, depreciation | AC5 |
| vendor quick-create | M2 |
| one PV settling several VIs | P3 (F5 allocations) |

---

### Task P1: Purchase order

**Depends on:** S6.

**Files:** Create `frontend/src/descriptors/purchase-order.ts`, `frontend/src/mocks/fixtures/specs/purchases.ts`,
`frontend/e2e/purchases-po.spec.ts`. Modify `descriptors/index.ts`, `mocks/engine/{marks,chain,paper}.ts`,
`kit/paper/registry.ts` (`PO: CommercialPaper`), `fixtures/index.ts`, permissions, messages, `screens.ts`, `ids.ts`.

**Interfaces:** purchaseOrder: `type 'PO'`, `correctionClass 'N'`, `vat 'both'`, `titleTh 'ใบสั่งซื้อ'`,
`titleEn 'Purchase order'`, `partyKind 'vendor'`, `lineEditor 'item'` (items with `usage.purchase`),
`basePath '/purchases/purchase-orders'`, `convertsTo ['PB','PV']`, listColumns `['number','date','party','total','progress','status','marks']`,
savedViews `['draft','cancelled']`, headerFields `['documentDate','dueDate','reference','notes']` (dueDate label
"กำหนดรับของ"). Marks: `sent` ("บันทึกว่าส่งให้ผู้ขายแล้ว"), `closed` (S2 close-remainder). Progress "รับวางบิลแล้ว x/y"
from PB conversions (strict remaining rule, D-29). Paper: CommercialPaper titled "ใบสั่งซื้อ / PURCHASE ORDER",
signatures ผู้สั่งซื้อ / ผู้อนุมัติ.

**Fixtures:** VAT: `po-d1` draft (pv-01); `po-1` issued + sent (pv-02, 3 lines); `po-part` issued, half billed by
`pb-po` (P2); `po-closed` closed-remainder. Non-VAT: `npo-1` issued (nv-01 ข้าวเปลือก 2,000 กก.). Keys `poDraft`,
`poSent`, `poPartlyBilled`, `npoIssued`.

**Permissions:** operator + `doc.PO.read/create/issue`; accountant + all `doc.PO.*`.

- [ ] **Step 1: Failing tests** — engine: PO → PB conversion over the remaining quantity refused (`doc.over_conversion`),
  `sent` mark only on live PO; e2e `purchases-po.spec.ts`: `screenContract` PO list (`company: 'both'`, operator /
  accountant, forbiddenRole admin) and PO view (`poSent`); flow "PO view → แปลงเป็น… → บันทึกซื้อ (PB) → qty 1 of line 1"
  lands on the PB editor with the vendor and line prefilled (the PB descriptor arrives in P2 — this e2e is added to
  P2's spec file instead; P1's flow test is "mark sent → chip ส่งแล้ว visible; activity lists it").
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(purchases): purchase orders`.

---

### Task P2: Purchase bill + purchase credit / debit notes (input VAT rules, claim period)

**Depends on:** P1. **Review:** Opus (money, tax).

**Files:** Create `frontend/src/descriptors/{purchase-bill,purchase-credit-note,purchase-debit-note}.ts`,
`frontend/src/mocks/engine/purchase-vat.ts` (+ test), `frontend/e2e/purchases-pb.spec.ts`. Modify
`mocks/engine/{commands,ledger,invariants}.ts` (PCN − / PDN + in `recomputeSettlement`, AP subledger rule active),
`kit/doc-editor/{HeaderFields,LineGrid}.tsx`, `domain/types.ts` (`DocHeader.claimPeriod`, `vendorDocNumber`,
`vendorDocDate`, `complete`), `app-shell/nav.ts` (`vendorNotes` item → `/purchases/vendor-notes` stays the PCN list; PDN list
at `/purchases/vendor-debit-notes` — add nav item `vendorDebitNotes` "ใบเพิ่มหนี้ผู้ขาย"), `specs/purchases.ts`,
permissions, messages, `screens.ts`, `ids.ts`.

**Interfaces:**
- purchaseBill: `type 'PB'`, `correctionClass 'L'`, `vat 'both'`, `titleTh 'บันทึกซื้อ/ค่าใช้จ่าย'`, `titleEn 'Purchase bill'`,
  `partyKind 'vendor'`, `lineEditor 'amount'`, `basePath '/purchases/bills'`, `convertsTo ['PCN','PDN','PV']`,
  listColumns `['number','date','party','reference','total','outstanding','status']`, savedViews
  `['draft','outstanding','overdue','cancelled']`, headerFields
  `['documentDate','vendorDocNumber','vendorDocDate','claimPeriod','dueDate','complete','notes']`.
- purchaseCreditNote: `type 'PCN'`, `adjusts 'PB'`, `titleTh 'ใบลดหนี้จากผู้ขาย'`, `basePath '/purchases/vendor-notes'`,
  headerFields `['documentDate','vendorDocNumber','refDoc','reason','claimPeriod','notes']`. purchaseDebitNote: `type 'PDN'`,
  `titleTh 'ใบเพิ่มหนี้จากผู้ขาย'`, `basePath '/purchases/vendor-debit-notes'`.
- Input VAT rules (`purchase-vat.ts`, cite in comments): vendor not VAT-registered → any line VAT > 0 refused
  `pb.vendor_not_vat_registered` (ม.82/5); category `recoverableVat: false` → that line's VAT posts to
  `InputVatUnclaimed` (ม.82/5); non-VAT company → every line's VAT posts to `InputVatUnclaimed` (A.4) — note: the VAT
  on a vendor's tax invoice still exists (it is part of the cost), unlike I1 for our sales; claim period
  `YYYY-MM` within document month … +6 (I6, `pb.claim_period_out_of_range`), default = document month; `complete`
  (เอกสารครบ) false → PB still issues but Home "PB เอกสารไม่ครบ" alert counts it (HC1).
- Posting PB: `[Expense(category) , net + unclaimed VAT, 0], [InputVat, recoverable VAT, 0], [AP, 0, total]`;
  capex category → `[FixedAsset(class), net, 0]` and AC5 creates the FA draft from that line.
- PB revise (L): reverse + repost; subject to filing lock (TX1 later) and settlement lock (cannot go below settled).

**Money invariants:** `PB outstanding = total − Σ PCN + Σ PDN − Σ settles`; `GL(2110) = Σ outstanding(PB)` per company;
`Σ input VAT posted to 1170 for a claim period = Σ recoverable VAT of PB / PCN / PDN with that claim period` (feeds TX1);
non-VAT company: `GL(1170) movement = 0`.

**Fixtures:** VAT: `pb-1` (pv-01, rent EXP-01, S7, complete), `pb-2` (pv-03, 2 lines services + entertainment
non-recoverable), `pb-po` (from `po-part`, half qty), `pb-capex` (EXP-08 notebook 32,000.00, capex), `pb-claim-late`
(claimPeriod = document month + 2), `pb-incomplete` (complete false), `pcn-1` (against `pb-1`, PRICE_REDUCTION),
`pdn-1` (against `pb-2`). Non-VAT: `npb-1` (nv-02, VAT 7 % folded into cost), `npb-2` (nv-01 rice, no VAT). Keys
`pbIssuedUnpaid`, `pbMixedVat`, `pbFromPo`, `pbCapex`, `pbIncomplete`, `pcnIssued`, `pdnIssued`, `npbVatToCost`.

**Permissions:** operator + `doc.PB.read/create/issue`, `doc.PCN.read`, `doc.PDN.read`; accountant + all `doc.PB/PCN/PDN.*`.

- [ ] **Step 1: Failing tests** (`purchase-vat.test.ts` + e2e)
```ts
it('vendor not VAT-registered + S7 line → pb.vendor_not_vat_registered', () => {});
it('entertainment line VAT posts to 5170, not 1170; journal balances', () => {});
it('non-VAT company PB: 1170 untouched, VAT inside the expense amount', () => {});
it('claim period outside month..+6 → pb.claim_period_out_of_range', () => {});
it('PCN reduces PB outstanding; PDN increases it; GL 2110 = Σ outstanding(PB)', () => {});
it('PO → PB beyond the remaining quantity is refused (D-29)', () => {});
```
e2e: `screenContract` PB list (`both`), PB view (`pbMixedVat`, states incl. `locked`), PCN list, PDN list; flow
"PO view → แปลงเป็น… → บันทึกซื้อ → lines prefilled → vendor document number + claim period → issue → PO progress
'รับวางบิลแล้ว'".
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS**; invariants `[]`.
- [ ] **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(purchases): purchase bills, vendor credit / debit notes and input VAT rules`.

---

### Task P3: Payment voucher + WHT certificates + the PV action count (S3)

**Depends on:** P2. **Review:** Opus (money, WHT).

**Files:** Create `frontend/src/descriptors/{payment-voucher,wht-certificate}.ts`, `frontend/src/kit/doc-editor/QuickBillDialog.tsx`
(+ test), `frontend/src/kit/paper/{PaymentVoucherPaper,WhtCertificatePaper}.tsx` (+ tests), `frontend/src/mocks/engine/wht-certificates.ts`
(+ test), `frontend/e2e/{purchases-pv,pv-action-count}.spec.ts`. Modify `mocks/engine/{commands,ledger,invariants,paper}.ts`,
`mocks/fixtures/parties.ts` (`pv-09`, `pv-10`), `kit/doc-editor/{SettlementPanel,DocEditor}.tsx`, `app/(app)/home-view.tsx`
(quick action "สร้างใบสำคัญจ่าย" for `doc.PV.create`), `app-shell/nav.ts` (tax group item `whtCertificates`
`/tax/wht-certificates`, permission `doc.WT.read`), `specs/purchases.ts`, permissions, messages, `screens.ts`, `ids.ts`.

**Interfaces:**
- paymentVoucher: `type 'PV'`, `correctionClass 'L'`, `vat 'both'`, `titleTh 'ใบสำคัญจ่าย'`, `titleEn 'Payment voucher'`,
  `partyKind 'vendor'`, `lineEditor 'amount'`, `settles ['PB','EX']`, `basePath '/purchases/payment-vouchers'`,
  listColumns `['number','date','party','total','status']`, savedViews `['draft','pending','cancelled']`,
  headerFields `['documentDate','bankAccount','paymentMethod','cheque','whtMode','reference','notes']`.
- whtCertificate: `type 'WT'`, `correctionClass 'T'`, `vat 'both'`, `titleTh 'หนังสือรับรองการหักภาษี ณ ที่จ่าย'`,
  `partyKind 'vendor'`, `lineEditor 'none'`, `basePath '/tax/wht-certificates'`, permissions `doc.WT.*` (only `read` granted
  to any role; create / issue / cancel / correct are system-only — ActionBar shows only print), listColumns
  `['number','date','party','total','status']`, savedViews `['cancelled']`, headerFields `[]`.
- Engine on PV issue: `computeWht` (F5) → one WT per WHT type: WT number allocated in the same command, WT `lines` =
  one per type `{ description: '<income type> <type name>', unitPrice: income, … }`, WT header carries `form`
  (`PND3`/`PND53`/`PND2`/`PND54`), `incomeType`, `tax`; link `issues` PV → WT. PV cancel → its WTs `cancelled`
  (reason "ยกเลิกตามใบสำคัญจ่าย"); PV revise with WHT changed → old WTs cancelled, new WTs issued (§7.3 L); unchanged
  WHT keeps the WTs. Standalone line with `S7` → `pv.input_vat_needs_bill` (D-16). Foreign vendor (`entityKind
  foreign`) + service line → line `pnd36: true` (feeds TX2) and WHT type defaults to `FOR-SVC` with mode
  `grossup_always` (A.5), editable.
- `QuickBillDialog`: vendor (from the PV), vendor document number, vendor document date, one amount + tax code (S7 /
  EX), category; "บันทึกและใช้กับใบสำคัญจ่ายนี้" creates + issues a PB through the API and appends an allocation of its
  total. Exit text on the refusal banner names this button.
- `WhtCertificatePaper` (React rendition of 50 ทวิ, D-21): payer (company TIN), payee (TIN, address), "ลำดับที่" box
  `[SP-R]`, form checkbox (ภ.ง.ด.1ก / 1ก พิเศษ / 2 / 3 / 2ก / 3ก / 53), income type rows with date / amount / tax,
  total in words (server), payer condition (หัก ณ ที่จ่าย / ออกให้ตลอดไป / ออกให้ครั้งเดียว), two copies (ฉบับที่ 1 / 2)
  on one print. Frozen at first render (I7): `PAPER_BUILDERS.WT` returns the stored snapshot after the first `/printed`.
- `PaymentVoucherPaper`: payee, settled documents, expense lines, WHT lines, net paid, payment method / bank / cheque,
  approval signatures (ผู้จัดทำ / ผู้ตรวจ / ผู้อนุมัติ / ผู้รับเงิน).

**Fixtures:** parties: `pv-09` "คุณอนันต์ ภาพดี (ช่างภาพอิสระ)" individual, not VAT-registered, TIN `tin('310060011122')`,
`usualItemIds ['EXP-05']`, `defaultWhtTypeCode 'SVC'`; `pv-12` foreign (M1). PVs: `pv-pay1` settles `pb-1` fully
(WHT RENT 5 % deduct); `pv-multi` settles `pb-2` + part of `pb-po` (two WHT types → two WTs); `pv-gross` to pv-09
grossup_always; `pv-foreign` to pv-12 FOR-SVC grossup_always, `pnd36` line; `pv-can` cancelled (its WT cancelled).
Non-VAT: `npv-1` settles `npb-1`. Keys `pvMultiWt`, `pvGrossUp`, `pvForeign`, `pvCancelled`, `wtIssued`, `wtCancelled`.

**Money invariants:** per PV `Σ alloc + line total + expense = cash + Σ tax` (Dr = Cr); `Σ WT tax (active, issues
links) = PV wht`; exactly one active WT per (PV, WHT type); `GL(2131…2135)` credit movement per form = Σ WT tax of that
form; PB outstanding after PV = `total − ΣPCN + ΣPDN − Σ settles`; cancel restores everything.

- [ ] **Step 1: Write the failing tests**

`e2e/pv-action-count.spec.ts` (SP0 S3, D-15)
```ts
import { expect, test } from '@playwright/test';
import { counted } from './helpers/count';

test('1-line PV with WHT for a known vendor takes <= 6 actions (SP0 S3)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const u = counted(page);
  await u.click(page.getByRole('link', { name: 'สร้างใบสำคัญจ่าย' }));   // Home quick action
  await u.type(page.getByRole('combobox', { name: 'ผู้ขาย' }), 'อนันต์');
  await u.press('Enter');                                                // vendor picked; usual line 5,000.00 with WHT SVC 3 %
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  const totals = page.getByRole('region', { name: 'ยอดรวม' });
  await expect(totals).toContainText('150.00');                          // WHT = round(5,000.00 × 3 %)
  await expect(totals).toContainText('4,850.00');                        // paid = total − WHT (deduct)
  await u.press('Control+Enter');                                        // open confirm
  await u.press('Enter');                                                // issue
  await expect(page).toHaveURL(/\/purchases\/payment-vouchers\/[^/]+$/);
  await expect(page.getByTestId('doc-number')).toHaveText(/^PV-\d{6}-\d{4}$/);
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByRole('link', { name: /WT-\d{6}-\d{4}/ })).toHaveCount(1);
  expect(u.count).toBeLessThanOrEqual(6);
});
```

`src/mocks/engine/wht-certificates.test.ts`
```ts
it('PV with two WHT types issues two WTs whose tax sums to the PV wht', () => {});
it('PV revise changing a WHT rate cancels the old WT and issues a new one; unchanged WHT keeps the WT', () => {});
it('PV cancel cancels its WTs and restores PB outstanding', () => {});
it('standalone S7 line → pv.input_vat_needs_bill; via QuickBill PB the same payment issues', () => {});
it('gross-up always: PV journal Dr = Cr with WhtExpense; cash = total', () => {});
it('WT paper is frozen after the first print (a later payee rename does not change it)', () => {});
```
`e2e/purchases-pv.spec.ts`: `screenContract` PV list (`both`; forbiddenRole admin), PV view (`pvMultiWt`, states incl.
`locked`), WT list `/tax/wht-certificates` (`both`; operator forbidden? no — operator lacks `doc.WT.read`: forbiddenRole
operator), WT view (`wtIssued`); flow "VAT vendor with S7 line → refusal banner → บันทึกซื้อ (มีใบกำกับภาษี) → dialog →
allocation appears → issue".
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS**; invariants `[]`.
- [ ] **Step 5: Full gate** (the TI and PV action-count specs both green).
- [ ] **Step 6: Controller commits** — `feat(purchases): payment vouchers, WHT certificates and the PV action count`.

---

### Task P4: Expense claims + the approval engine (§7.6)

**Depends on:** P3.

**Files:** Create `frontend/src/descriptors/expense-claim.ts`, `frontend/src/mocks/engine/approval.ts` (+ test),
`frontend/src/mocks/fixtures/{employees,approval-policy}.ts`, `frontend/src/kit/doc-view/ApprovalActions.tsx` (+ test),
`frontend/src/kit/paper/ExpenseClaimPaper.tsx`, `frontend/e2e/{purchases-ex,approval}.spec.ts`. Modify
`domain/types.ts` (`PartySummary.kind` + `'employee'`), `mocks/handlers/{parties,docs-write}.ts`
(`/submit`, `/approve`, `/send-back`), `mocks/engine/{commands,ledger,invariants}.ts`, `kit/doc-view/ActionBar.tsx`
(pending / approved branches use `ApprovalActions`), `kit/doc-editor/DocEditor.tsx` (when approval is on: primary
"ส่งอนุมัติ" instead of issue for users without `doc.<T>.approve`), `specs/purchases.ts`, permissions, messages,
`screens.ts`, `ids.ts`.

**Interfaces:**
- expenseClaim: `type 'EX'`, `correctionClass 'L'`, `vat 'both'`, `titleTh 'ใบเบิกค่าใช้จ่าย'`, `partyKind 'employee'`,
  `lineEditor 'amount'`, `convertsTo ['PV']`, `basePath '/purchases/expense-claims'`, listColumns
  `['number','date','party','total','outstanding','status']`, savedViews `['draft','pending','outstanding','cancelled']`,
  headerFields `['documentDate','reference','notes']`. Posting `[Expense(category), net + unclaimed VAT, 0],
  [InputVat, recoverable VAT, 0], [EmployeePayable, 0, total]`; pay = EX → PV (PV allocation to EX).
- Approval policy (`approval-policy.ts`, ST3 edits): `{ companyId, docType, enabled, minAmount?: Money, selfApproval: boolean }[]`;
  seed: VAT company EX enabled (no minimum), PV enabled above 50,000.00, self-approval on; non-VAT company all off.
- Commands: `submit` (draft → pending; refused when policy disabled or below the minimum: then issue directly),
  `approve` (pending → approved; needs `doc.<T>.approve`; creator refused when self-approval off:
  `approval.self_not_allowed`), `approveAndIssue` (one action when the actor holds approve + issue, §7.6),
  `sendBack` (pending / approved → draft with reason, activity "ส่งกลับแก้ไข: <reason>"); editing an approved
  document returns it to draft (§7.6). Every guard has an exit: pending → send back; approved → issue / send back.
- Mobile (§9.4): at 390 px, `/purchases/expense-claims/new` works with one amount line and a photo attachment
  (`<input type="file" accept="image/*" capture="environment">` inside `AttachmentsPanel`).

**Fixtures:** employees (`employees.ts`, both companies, `kind: 'employee'`): VAT `emp-01` สมศรี บัญชีดี (the mock
user), `emp-02` วิชาญ ขยันงาน (sales), `emp-03` มาลี ใจงาม (designer); non-VAT `nemp-01` บุญมา ทำดี, `nemp-02` สายใจ
รักงาน. EX: `ex-d1` draft (emp-02, taxi + meal), `ex-pend` pending (emp-03, photo attachment), `ex-appr` approved,
`ex-1` issued unpaid, `ex-paid` paid by `pv-ex`. Keys `exDraft`, `exPending`, `exApproved`, `exUnpaid`.

**Permissions:** operator + `doc.EX.read/create/issue`; accountant + all `doc.EX.*`, `doc.EX.approve`, `doc.PV.approve`;
admin none. (Approve codes added for the other types in their own tasks only when a policy enables them — the catalog
lists all now.)

- [ ] **Step 1: Failing tests** — `approval.test.ts`: submit below the minimum issues directly; self-approval off
  refuses the creator; approve-and-issue allocates the number once; editing an approved EX returns it to draft;
  `checkInvariants` (2180 subledger) holds. `ApprovalActions.test.tsx`: operator sees "ส่งอนุมัติ", accountant sees
  "อนุมัติและออก" and "ส่งกลับแก้ไข" (reason required). e2e: `screenContract` EX list (`both`), EX view (`exPending`);
  approval flow operator submits → accountant approves and issues → EX → PV conversion pays it (EX outstanding 0,
  status `settled`); mobile test at 390 × 844 creates an EX with a photo.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(purchases): expense claims and the approval engine`.

---

### Task GP: Ham gate — purchases

- [ ] Consolidated gate green (includes `e2e/pv-action-count.spec.ts`); production build / staging.
- [ ] Send Ham: URLs; the PV action count result (≤ 6, scenario D-15); G2 inline PB (D-16); WHT modes with WT papers
  (D-14, D-21, `[SP-R]` rates); PCN / PDN; claim period and non-recoverable VAT; EX + approval (D-18, D-19).
- [ ] AskUserQuestion "Purchases approve?" — approve / approve with changes / rework. Record in `STATUS.md`.
