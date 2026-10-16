# SP1c group 04 — Finance (bank and cash accounts, statement import, reconciliation, deposits, settlement)

> Part of `docs/plans/2026-10-14-sp1c-all-screens.md`. Depends on group 03. Tasks FN1 → FN3 → gate GFN.

**Parity coverage (Appendix C "Money and ledger" bank items + flexibility gaps "Reconciliation")**

| Item | Task |
|---|---|
| bank accounts (master, own GL account each §5.13) | FN1 |
| bank statement import (KBiz CSV, K PLUS PDF) with integrity checks | FN1 |
| matching, inline journal, reconciliation report | FN2 |
| document search, split / fee / batch matching, complete / lock action (flex gap) | FN2 |
| deposits and advances, netting, settlement differences (§5.11, SP0 §11.2 "settlement") | FN3 |

---

### Task FN1: Bank and cash accounts + statement import

**Depends on:** P4.

**Files:** Create `frontend/src/records/bank-accounts.ts`, `frontend/src/mocks/records/bank-accounts.ts`,
`frontend/src/mocks/engine/bank-import.ts` (+ test), `frontend/src/mocks/fixtures/statements/{kbiz-2026-10.csv.ts,kplus-2026-09.ts}`,
`frontend/src/app/(app)/finance/bank-accounts/[id]/page.tsx`, `frontend/src/kit/bank/{ImportDialog,StatementLines}.tsx`
(+ tests), `frontend/e2e/finance-bank.spec.ts`. Modify `records/index.ts`, `mocks/records/registry.ts`,
`mocks/store.ts` (`bankImports`, `bankLines`), `mocks/handlers/` (new `bank.ts`; **delete the F5 stopgap
`GET /bff/v1/bank-accounts` handler** and point `HeaderFields` `bankAccount` at `/records/bank-account`), `app-shell/nav.ts` (bankAccounts →
`bank.read`; deposits → `bank.read`), endpoints, keys, permissions, messages, `screens.ts`, `ids.ts`.

**Interfaces:**
```ts
// bank-account record: basePath '/finance/bank-accounts', perms bank.read / bank.manage, detail: true (custom static [id] page)
// fields: kind (bank | cash), bankName (select: กสิกรไทย / ไทยพาณิชย์ / กรุงเทพ / กรุงไทย / กรุงศรี / ทหารไทยธนชาต / ออมสิน), accountNo (digits, showWhen kind=bank),
//         accountName, accountCode (account picker: postable, class current asset, unique per bank account — §5.13), active
export interface BankLine { id: string; accountId: string; importId: string; date: IsoDate; description: string; amount: Money; // + in, − out
  balance: Money; status: 'unmatched' | 'matched' | 'ignored' | 'posted'; matchedDocIds?: string[]; journalId?: string }
export interface BankImport { id: string; accountId: string; fileName: string; format: 'kbiz-csv' | 'kplus-pdf'; from: IsoDate; to: IsoDate;
  opening: Money; closing: Money; lines: number; at: string; warnings: string[] }
// endpoints: importStatement(accountId, { fileName, format, content: string /* CSV text or base64 PDF */, password? }) → BankImport
//            listBankLines(accountId, { status?, from?, to? }) → Page<BankLine>
```
Import rules (`bank-import.ts`, Appendix A.8): KBiz CSV (UTF-8 BOM, metadata rows read by Thai label "เลขที่บัญชี",
dates `DD-MM-YY` CE) parsed by the mock; K PLUS PDF: the mock does not parse PDFs — the fixture `kplus-2026-09.ts`
supplies the extracted lines for the sample file name `KPLUS_Statement_Sep2026.pdf` (any other PDF → 422
`bank.pdf_unreadable` "อ่านไฟล์ PDF ไม่ได้ — ลองไฟล์ CSV จาก K BIZ"); password never stored. Integrity triple-check:
each line amount = balance delta (`bank.line_mismatch` naming the row), Σ in − Σ out = closing − opening, statement
account number (digits only) = the account's number (`bank.account_mismatch`); overlapping period → warning only;
size ≤ 2 MB; the raw file stored as an attachment of the import.

**Fixtures:** VAT company `ba-kbank` September lines (posted via fixture import, 18 lines: receipts matching seeded
RC totals, PV payments, a bank fee 25.00, an interest 3.12), October CSV sample text in `kbiz-2026-10.csv.ts` for the
e2e upload; `ba-scb` no imports; `ba-cash` cash box. Non-VAT `nba-kbank` 8 lines. Keys `bankKbank`, `bankEmpty`, `nbankKbank`.

**Permissions:** operator `bank.read`; accountant `bank.read`, `bank.manage`, `bank.reconcile`; admin `bank.read`, `bank.manage`.

- [x] **Step 1: Failing tests** — `bank-import.test.ts`: BOM + Thai labels parsed; a tampered balance row →
  `bank.line_mismatch` naming the row number; wrong account → `bank.account_mismatch`; overlap → warning, not error;
  totals check. e2e: `screenContract` bank list (`both`), bank detail (`bankKbank`, states incl. empty → `bankEmpty`
  shows "ยังไม่มีรายการเดินบัญชี — นำเข้า statement"); upload the October CSV via `setInputFiles` (Buffer from the
  fixture text) → "นำเข้าสำเร็จ 12 รายการ" and the lines table.
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.** (FN1 worker: tsc, eslint, unit 111 files / 1154 passed, e2e finance-bank + sales-rc + purchases-pv + screens + routes + 8 neighbouring specs green; full e2e run by the controller)
- [ ] **Step 6: Controller commits** — `feat(finance): bank and cash accounts with statement import`.

---

### Task FN2: Reconciliation workspace, inline journal, reconciliation lock, report

**Depends on:** FN1. **Review:** Opus (money, locks).

**Files:** Create `frontend/src/mocks/engine/reconcile.ts` (+ test), `frontend/src/kit/bank/{MatchPanel,InlineJournalDialog}.tsx`
(+ tests), `frontend/src/mocks/engine/reports/bank-reconciliation.ts`, `frontend/e2e/finance-reconcile.spec.ts`.
Modify `app/(app)/finance/bank-accounts/[id]/page.tsx` (tab "กระทบยอด"), `mocks/handlers/{bank,docs-read}.ts`
(reconciliation lock derived at read), `mocks/engine/{commands,ledger}.ts`, `domain/reports.ts`, messages, `screens.ts`, `ids.ts`.

**Interfaces:**
- `suggest(st, lineId)`: live RC (money in) / PV (money out) documents of the company, unmatched, `|date − line date| ≤ 7`,
  exact `cash` amount (RC `totals.cash`, PV `totals.cash`), ranked by same bank account then nearest date (A.8).
- `match(lineId, docIds[], diff?: { role: 'BankFee' | 'RoundingDifference', amount })`: one line ↔ one or several
  documents (batch) or several lines ↔ one document (split: `match` called per line with the same doc, Σ lines =
  doc cash); `Σ matched cash + diff = line amount` (`bank.match_amount`, message shows both sides); a fee difference
  posts a JV-like entry `[BankFee, fee, 0], [Cash(account), 0, fee]` labelled "ค่าธรรมเนียมจากการกระทบยอด".
- `post(lineId, { accountCode, description, partyId?, dimensions? })`: inline journal dated at the line, 2 lines
  (Cash account ↔ chosen account); refuses VAT / WHT control accounts (G4, `ledger.control_account`) and AR / AP
  without a party (§5.2.5).
- `unmatch`, `ignore`, `unignore`; posted lines are immutable (exit: reverse the journal in AC1).
- Reconciliation lock (§7.5): a matched RC / PV reads with `{ kind: 'reconciliation', reason: 'จับคู่กับรายการเดินบัญชี
  <date> <amount> แล้ว', exits: ['ยกเลิกการจับคู่'] }`; its cancel / fiscal correction is blocked; the exit button goes
  to the bank line (route `/finance/bank-accounts/<id>?line=<lineId>`).
- Report `bank-reconciliation` (`ReportView`): params account (required), to; `difference = statement closing − (GL
  balance − deposits in transit + outstanding payments + unmatched net)` (A.8), rows grouped; tie-out row.
- "ปิดการกระทบยอดถึงวันที่" (complete / lock, flex gap): marks lines ≤ date `locked`; unmatching a locked line needs
  `bank.reconcile` and a reason (exit, audited).

**Money invariants:** `GL(bank account) − Σ unmatched journal-side items = statement closing − Σ unmatched lines`
(reconciliation identity, asserted in `reconcile.test.ts` on the seed after matching all suggestions); every inline
journal Dr = Cr.

- [x] **Step 1: Failing tests** — suggestion window and ranking; batch match sum rule; fee difference journal balances;
  control-account refusal; matched RC shows the reconciliation lock and cancel is disabled naming the exit; unmatch
  removes the lock. e2e: `screenContract` for the reconcile tab (`both`; forbiddenRole operator); flow "unmatched
  money-in line → ค้นหารายการที่ตรงกัน → pick the RC → matched; open the RC → lock banner with ยกเลิกการจับคู่".
- [x] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS**; invariants `[]`.
- [x] **Step 5: Full gate.** (FN2 worker: tsc, eslint, unit 116 files / 1221 passed, e2e finance-reconcile + finance-bank + sales-rc + purchases-pv + screens + routes + reports-tb 134 passed; full e2e by the controller)
- [ ] **Step 6: Controller commits** — `feat(finance): bank reconciliation with matching, inline journals and locks`.

---

### Task FN3: Deposits, advances, netting and settlement differences (settlement records, D-13)

**Depends on:** FN2. **Review:** Opus (money).

**Files:** Create `frontend/src/records/settlements.ts`, `frontend/src/mocks/records/settlements.ts`,
`frontend/src/mocks/engine/settlement-records.ts` (+ test), `frontend/src/app/(app)/finance/deposits/page.tsx`,
`frontend/src/app/(app)/finance/settlements/[id]/page.tsx`, `frontend/e2e/finance-settlement.spec.ts`.
Modify `app-shell/nav.ts` (finance group: `settlements` "หักกลบ/ปรับปรุงการชำระ" `/finance/settlements`, `bank.read`),
`mocks/engine/{ledger,invariants,settlement}.ts`, `kit/doc-editor/SettlementPanel.tsx` (deposits offered as allocatable
credits), messages, `screens.ts`, `ids.ts`.

**Interfaces:**
```ts
export type SettlementKind = 'apply_deposit' | 'apply_prepayment' | 'netting' | 'write_off';
export interface SettlementRecord { id: string; companyId: string; kind: SettlementKind; date: IsoDate; partyId: string;
  sources: { docId: string; amount: Money }[];   // deposit RC / prepayment PV / AP side (netting)
  targets: { docId: string; amount: Money }[];   // TI / IV / PB / EX
  difference?: { role: 'RoundingDifference' | 'SmallWriteOff' | 'BankFee'; amount: Money };
  status: 'posted' | 'reversed'; journal: JournalEntryPreview[]; reason?: string }
```
- `/finance/deposits`: two tables (customer deposits = RC deposit remainders not yet applied; vendor prepayments = PV
  `depositAmount` not yet applied — this task extends the PV with `header.depositAmount` (S4 added the field for RC)
  posting `[VendorPrepayment, depositAmount, 0]` and adds `depositAmount` to the PV balance identity) with
  "นำไปหักกับใบแจ้งหนี้" opening a settlement form.
- Postings: apply_deposit `[CustomerDeposit, amt, 0], [AR, 0, amt]`; apply_prepayment `[AP, amt, 0],
  [VendorPrepayment, 0, amt]`; netting (same party is both customer and vendor — fixture party `pc-03` also vendor
  `pv-11` linked by `linkedPartyId`) `[AP, amt, 0], [AR, 0, amt]`; write_off within the company tolerance (fixture
  1.00 THB for rounding, 100.00 for small write-off; above → `settle.beyond_tolerance` "เกินเกณฑ์ที่กำหนด ต้องออกใบลดหนี้หรือ
  รับชำระเพิ่ม"). Targets get `settles` links from the settlement (link `from` = settlement id; the chain shows it as
  "หักกลบ / ใช้เงินมัดจำ"). Reverse = a reversing journal and inactive links (exit for every settlement).
- Deposit VAT tax point is `[SP-R]`: the screen shows a note "การคำนวณภาษีขายของเงินมัดจำรอผลวิจัย SP-R" and posts no VAT.

**Money invariants:** `netting: AR cleared = AP cleared`; each target's outstanding follows §7.11 including settlement
links; `GL(2140) = Σ unapplied customer deposits`; `GL(1140) = Σ unapplied vendor prepayments`; reversing restores all.

- [ ] **Step 1: Failing tests** — apply a deposit to a TI (outstanding drops, 2140 drops); netting clears equal AR /
  AP; write-off above tolerance refused; reverse restores; `checkInvariants` `[]`. e2e: `screenContract` deposits
  (`both`) and settlements list (`both`, forbiddenRole operator for create — list is read); flow apply `rcDeposit` to
  an unpaid TI of pc-08.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Full gate.**
- [ ] **Step 6: Controller commits** — `feat(finance): deposits, prepayments, netting and settlement differences`.

---

### Task GFN: Ham gate — finance

- [ ] Consolidated gate green; production build / staging.
- [ ] Send Ham: bank accounts with own GL accounts; CSV import with integrity checks (and the PDF limitation: mock
  reads one sample); reconciliation (batch / split / fee); reconciliation lock + exit; deposits / netting as
  settlement records (**D-13 needs Ham's ruling**: record kind vs a new document type with a legal series).
- [ ] AskUserQuestion "Finance approve?" — approve / approve with changes / rework. Record in `STATUS.md`.
