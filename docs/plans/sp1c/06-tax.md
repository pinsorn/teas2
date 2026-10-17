# SP1c group 06 — Tax (filing kit, ภ.พ.30 + registers, WHT returns, ภ.พ.36, CIT, summary, form catalogue)

> Part of `docs/plans/2026-10-14-sp1c-all-screens.md`. Depends on group 05. Tasks TX1 → TX3 → gate GTX.
> Every figure is a server model; every legal rule value is an `[SP-R]` fixture until SP-R rules (open item O-3).
> Official RD AcroForm PDFs are SP4.8 (D-21); TEAS 1 sample PDFs are open item O-1.

**Parity coverage (Appendix C "Tax filings", "Reports" tax items, gaps G1–G4)**

| Item | Task |
|---|---|
| ภ.พ.30 preview / finalise / PDF / `.txt`, VAT output / input registers, credit carry-forward (G2), tie-out (I12) | TX1 |
| ภ.ง.ด.2 / 3 / 53 / 54 (+ RD Prep `.txt`), ภ.พ.36 (PDF + JV, G2 input VAT), WHT register polish, WHT receivable, missing 50 ทวิ chase list | TX2 |
| tax summary (12 months), ภ.ง.ด.51 (+ estimate), ภ.ง.ด.50 + CIT year data and adjustments, ภ.พ.01 / 09, RD form catalogue, filing history, VAT threshold watch for non-VAT (G1) | TX3 |

---

### Task TX1: Filing kit + ภ.พ.30 and the VAT registers; filing lock

**Depends on:** AC6. **Review:** Opus (tax, locks).

**Files:** Create `frontend/src/domain/filings.ts`, `frontend/src/kit/filing/{FilingView,FilingBoxes,FinalizeDialog,FilingHistory}.tsx`
(+ `FilingView.test.tsx`), `frontend/src/mocks/engine/filings/{index,pp30}.ts` (+ `pp30.test.ts`),
`frontend/src/mocks/engine/reports/{vat-output-register,vat-input-register}.ts`, `frontend/src/mocks/handlers/filings.ts`,
`frontend/src/app/(app)/tax/vat/page.tsx` (tabs ภ.พ.30 / ทะเบียนภาษีขาย / ทะเบียนภาษีซื้อ), `frontend/e2e/tax-pp30.spec.ts`.
Modify `mocks/store.ts` (`filings`), `mocks/engine/locks.ts` (`derivedLocks` adds the filing lock — the GET handler
and `fixtureIds` already call it), `mocks/fixtures/documents.ts` (the SP1ab per-document `FILING_LOCK` literal is
removed; seeded finalized ภ.พ.30 for **2026-07 and 2026-08 only** — September is due 15 ต.ค. and still unfiled on the
2026-10-14 anchor, matching Home's deadline card; September documents therefore stay unlocked for the TI correction
e2e), `mocks/fixtures/ids.ts` (`tiFilingLocked` now resolves to an August TI with a derived filing lock; re-run
`e2e/ti-loop.spec.ts` and `e2e/foundation.spec.ts` — both must stay green), endpoints, keys, permissions, messages,
`app-shell/nav.ts` (tax items → `tax.read`), `screens.ts`.

**Interfaces:**
```ts
// src/domain/filings.ts
export type FilingForm = 'PP30' | 'PND1' | 'PND1A' | 'PND2' | 'PND3' | 'PND53' | 'PND54' | 'PP36' | 'PND50' | 'PND51' | 'SSO1-10';
export interface FilingBox { code: string; labelTh: string; amount: Money; source?: { reportKind: ReportKind; params: Record<string, string> } }
export interface FilingModel { form: FilingForm; period: string /* YYYY-MM or YYYY */; status: 'draft' | 'finalized';
  boxes: FilingBox[]; tieOuts: TieOut[]; blockers: { code: string; labelTh: string; href?: string }[]; warnings: string[];
  finalizedAt?: string; finalizedBy?: string; version: number; dueDate: IsoDate; exports: ('rdprep-txt' | 'pdf')[] }
// endpoints: getFiling(form, period), finalizeFiling(form, period, version), exportFiling(form, period, kind) → text
export function FilingView(p: { form: FilingForm; periodKind: 'month' | 'year' }): JSX.Element;
```
`FilingView`: period picker (URL `?period=`), boxes table (each box links to its register / report source), tie-outs
(amber banner when diff ≠ 0), blockers list (finalize disabled naming the first blocker), "ยืนยันยื่นแบบ (ปิดงวดภาษี)"
→ `FinalizeDialog` (ConfirmIssue anatomy: totals of the main boxes, text "เมื่อยืนยันแล้ว เอกสารที่อยู่ในแบบนี้จะแก้ไขตัวเลขไม่ได้
— แก้ได้ด้วยใบลดหนี้/ใบเพิ่มหนี้ในงวดถัดไป"), export buttons ("ไฟล์สำหรับ RD Prep (.txt)", "พิมพ์แบบ"), history list. Requires
`tax.read` to view, `tax.filing.preview` to compute, `tax.filing.finalize` to finalize. Remounts on company switch.

ภ.พ.30 (`pp30.ts`, VAT company only; non-VAT → not-available): source = **documents** (I12): output = issued TI /
CN / DN by document month bucketed by tax code (S7 base + VAT, Z0 base, EX base); CN / DN land in the month of the
note, signed; cancelled TI listed in the register as "ยกเลิก 0.00" (A.9); input = PB / PCN / PDN with `claimPeriod` =
period, recoverable VAT only; ภ.พ.36 VAT of the period's finalized PP36 added to input (G2, TX2 feeds it); carry-forward
= previous finalized PP30's excess input (G2; refund-vs-carry `[SP-R]`: carry by default with the note). Boxes
(`[SP-R]` layout): 1 ยอดขาย, 2 ยอดขายอัตรา 0, 3 ยอดขายยกเว้น, 4 ยอดขายที่ต้องเสียภาษี, 5 ภาษีขาย, 6 ยอดซื้อที่มีสิทธิ์นำภาษีซื้อ
มาหัก, 7 ภาษีซื้อ, 8 ภาษีที่ต้องชำระ, 9 ภาษีชำระเกิน, 10 ภาษีชำระเกินยกมา, 11 ภาษีสุทธิที่ต้องชำระ / ชำระเกิน. Tie-outs: output
VAT (box 5) = GL 2151 net movement for the month; input (box 7) = GL 1170 movement for the claim period; register
totals = boxes. Blockers: draft TI / CN / DN dated in the month; a previous month not finalized.
Finalize: stores a snapshot; derives `{ kind: 'filing', reason: 'ภ.พ.30 เดือน <BE month> ยื่นแล้ว', exits: ['ออกใบลดหนี้ /
ใบเพิ่มหนี้ในงวดถัดไป'] }` for every TI / CN / DN / PB / PCN / PDN that fed it (read-time, like the period lock); one
finalized filing per company × form × period (I10, `filing.already_finalized`); placeholder company TIN refused
(I10). `.txt` export: RD Prep "Format กลาง" — the mock emits a pipe-delimited sample per the TEAS 1 golden string shape
(`[SP-R]`; golden strings are SP-R / SP2), CRLF line ends.

**Money / tax invariants:** box 4 = box 1 − box 2 − box 3; box 5 = Σ VAT of the output register; box 8 / 9 = |box 5 −
box 7 − box 10| by sign; every tie-out diff = 0.00 on the seed; registers list every issued document of the month
exactly once.

**Fixtures:** finalized PP30 for 2026-07 and 2026-08 (VAT company); 2026-09 draft, finalizable (the gate demo);
2026-10 draft with blockers (October draft TIs exist in the SP1ab seed; September not finalized). Keys
`pp30Finalized` (`2026-08`), `pp30Due` (`2026-09`), `pp30Draft` (`2026-10`).

**Permissions:** accountant `tax.read`, `tax.filing.preview`, `tax.filing.finalize`; admin `tax.read`? no (admin has
no tax); operator none.

- [x] **Step 1: Failing tests** — `pp30.test.ts`: box identities above; CN in the month reduces output; cancelled TI
  appears as ยกเลิก 0.00; PB with claim period +2 lands two months later; non-recoverable VAT excluded; carry-forward;
  finalize derives filing locks and refuses a second finalize; tie-outs zero on the seed; a corrupted register
  (remove a TI's VAT line from 2151) produces a non-zero tie-out (can fail). `FilingView.test.tsx`: finalize disabled
  naming the blocker; error vs empty distinct. e2e: `screenContract` `/tax/vat?period=2026-10` (`company: 'vat'`,
  forbiddenRole operator, states `['empty','loading','error','forbidden']` — a filing page has no lock state; a
  finalized period shows the read-only "ยื่นแล้ว" banner instead);
  flow: 2026-10 shows its blockers with links; finalize 2026-09 (`pp30Due`) → then open a September TI → filing lock
  banner with the CN / DN exit (each test resets the mock state in `beforeEach`, so the finalize does not leak).
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS**; the full TI / PV e2e still green.
- [x] **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(tax): filing kit, ภ.พ.30 with VAT registers, tie-outs and filing locks`.

---

### Task TX2: WHT returns, ภ.พ.36, WT register, WHT receivable and the missing 50 ทวิ chase list

**Depends on:** TX1. **Review:** Opus (tax).

**Files:** Create `frontend/src/mocks/engine/filings/{pnd-wht,pp36}.ts` (+ tests), `frontend/src/mocks/engine/reports/{wht-receivable,missing-wht-cert}.ts`,
`frontend/src/app/(app)/tax/wht/page.tsx` (hub: tabs ภ.ง.ด.3 / 53 / 2 / 54 / ภ.พ.36 / ภาษีถูกหัก / ขาดหนังสือรับรอง),
`frontend/e2e/tax-wht.spec.ts`. Modify `mocks/handlers/filings.ts`, `descriptors/wht-certificate.ts` (list columns:
form, payee, income type), messages, `screens.ts`, `ids.ts`.

**Interfaces / rules:**
- ภ.ง.ด.3 / 53 / 2 / 54 per month (`pnd-wht.ts`): source = active WT documents of the month by form (`header.form`);
  boxes: number of payees, Σ income, Σ tax; attachment rows (payee TIN, name, address, income type, date, income, tax,
  condition); tie-out Σ tax = GL 2131 / 2132 / 2135 / 2134 credit movement of the month; blockers: a WT payee without a
  real TIN (I10, "ผู้รับเงิน <name> ไม่มีเลขประจำตัวผู้เสียภาษี"); ภ.ง.ด.2 needs an income code per WT (TEAS 1 parity,
  discovery 01 §2.10: `wht_batch.missing_income_code`); exports `rdprep-txt` for 3 / 53 / 2 (54: PDF only, A parity); finalize locks the WTs'
  PVs' WHT fields (filing lock on the PV with exit "แก้ไขด้วยการยกเลิกใบสำคัญจ่ายแล้วออกใหม่ในงวดถัดไป").
- ภ.พ.36 (`pp36.ts`): source = issued PVs with `pnd36` lines in the **payment month** (I8); VAT = round(Σ base × VAT rate
  from the rate table) half away from zero (G3); finalize posts `[InputVat (VAT co) or InputVatUnclaimed (non-VAT), vat, 0],
  [Pnd36VatPayable, 0, vat]` dated the payment month's last day (not finalize day, G3) and feeds PP30 input (G2);
  mandatory acknowledgement checkbox before finalize (parity).
- WHT receivable report (`wht-receivable`): RC allocations with WHT by month, customer, certificate number; aging of
  1180; tie-out Σ = GL 1180 balance. Missing 50 ทวิ (`missing-wht-cert`): RC allocations with WHT and no `certNumber`,
  row link to the RC (where the number is entered late, S4); count badge on the hub tab.
- WT list `/tax/wht-certificates`: columns number, date, payee, form, income, tax, status; saved view by form.

**Fixtures:** finalized ภ.ง.ด.3 / 53 for 2026-08 and 2026-09; October draft; a PP36 for 2026-09 from `pv-foreign`
(if its date is in October, the PP36 draft is October). Keys `pnd53Draft`, `pp36Draft`, `missingCertRc` (= `rcNoCert`).

- [x] **Step 1: Failing tests** — form routing totals; TIN blocker; tie-outs zero on the seed; PP36 VAT rounding vector
  (base 10,000.05 × 7 % = 700.0035 → 700.00) and journal date = month end; PP36 VAT appears in the next PP30 input
  (only once); missing-cert list shrinks after entering the number on `rcNoCert`. e2e: `screenContract` for the hub tabs
  (`both` for 3 / 53 / 54 / receivable / missing; PP36 `both`), WT list (`both`).
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(tax): WHT returns, ภ.พ.36, WHT receivable and the missing-certificate list`.

---

### Task TX3: Tax summary, CIT (ภ.ง.ด.50 / 51), form catalogue, filing history, VAT threshold watch (G1)

**Depends on:** TX2.

**Files:** Create `frontend/src/mocks/engine/filings/{cit,pnd51}.ts` (+ tests), `frontend/src/mocks/engine/reports/tax-summary.ts`,
`frontend/src/mocks/engine/vat-threshold.ts` (+ test), `frontend/src/app/(app)/tax/{summary,cit,forms}/page.tsx`,
`frontend/src/mocks/fixtures/cit-year.ts`, `frontend/e2e/tax-summary-cit.spec.ts`. Modify `app-shell/nav.ts` (tax group:
`taxSummary`, `vat`, `wht`, `whtCertificates`, `cit`, add `taxForms` "แบบฟอร์มและประวัติการยื่น" `/tax/forms`),
`mocks/handlers/filings.ts`, messages, `screens.ts`.

**Interfaces / rules:**
- Tax summary (`/tax/summary`, `ReportView` kind `tax-summary`): 12 months of the year × (sales, output VAT, input VAT,
  net VAT, WHT paid by form, WHT deducted from us, filing status chip per form); cells link to the filing / register.
  Non-VAT company: VAT columns absent; a **VAT threshold watch** card (G1): revenue of the last 12 months from all
  sales documents (IV + RC cash bills) vs the threshold fixture 1,800,000.00 `[SP-R]`, warning at ≥ 80 % ("ใกล้เกณฑ์
  ต้องจดทะเบียนภาษีมูลค่าเพิ่ม") — seed the non-VAT company to be at ~85 %.
- CIT (`/tax/cit`, year): year data form (paid-up capital, SME flag derived: capital ≤ 5 M and revenue ≤ 30 M `[SP-R]`),
  net profit from the GL (I12), adjustments table (ม.65 ทวิ / ตรี, signed, user-entered with reason), loss
  carry-forward (5 years, I11), ภ.ง.ด.51 prepaid, WHT credits (from RC certificates); CIT ladder `[SP-R]` fixture; result
  boxes from the server; FilingView for PND50 (year) and PND51 (half-year: estimate input or H1 profit × 2, tax =
  50 % × CIT(estimate) − H1 WHT, parity A); finalize as TX1.
- Form catalogue + history (`/tax/forms`): every form with its period kind, due day, last finalized period, link; ภ.พ.01
  / ภ.พ.09 "พิมพ์แบบพร้อมข้อมูลบริษัท" (React rendition from company data, D-21); filing history table (form, period,
  finalized at / by, export links) — immutable.

**Invariants:** CIT net profit = P&L net profit of the fiscal year (same engine function as RP1); SME ladder applied to
taxable profit after adjustments; history rows are never edited (a second finalize is refused).

- [x] **Step 1: Failing tests** — threshold watch fires at 80 % for the non-VAT seed and never for the VAT company;
  CIT ladder vectors (`[SP-R]` fixture values) including loss carry-forward expiry after 5 years; ภ.ง.ด.51 estimate
  path vs H1 × 2 path. e2e: `screenContract` summary (`both`), CIT (`both`, forbiddenRole operator), forms (`both`).
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [x] **Step 6: Controller commits** — `feat(tax): tax summary, CIT, form catalogue, filing history and the VAT threshold watch`.

---

### Task GTX: Ham gate — tax

- [x] Consolidated gate green; production build / staging.
- [ ] Send Ham: ภ.พ.30 with registers and tie-outs; filing lock + exit; WHT returns and the chase list; ภ.พ.36 at the
  payment month into ภ.พ.30 input (G2); CIT; threshold watch (G1); the `[SP-R]` status of every number (O-3) and the
  React-rendition forms (D-21, O-1).
- [ ] AskUserQuestion "Tax approve?" — approve / approve with changes / rework. Record in `STATUS.md`.
