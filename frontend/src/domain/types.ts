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
  vatRegistered: boolean; permissions: string[];
  /** The server's business date ("today" for document dates, ageing, as-of defaults); the browser clock is never a business date. */ businessDate: IsoDate }
export interface Actor { kind: 'user' | 'agent'; id: string; name: string; ownerName?: string }

export interface PartySummary { id: string; kind: 'customer' | 'vendor' | 'employee'; code: string; name: string; taxId?: string;
  branchCode?: string; vatRegistered: boolean; address?: string; paymentTermDays: number; defaultWhtTypeCode?: string;
  usualItemIds?: string[]; entityKind: 'individual' | 'juristic' | 'foreign';
  nameEn?: string; notes?: string; partyGroup?: string; contact?: { phone?: string; email?: string };
  /** Vendor remittance details. */ bankAccount?: { bankName?: string; accountNo?: string; accountName?: string };
  /** Foreign vendor registered under VAT-D (PP.36 not filed). */ vatDRegistered?: boolean }
export interface ItemSummary { id: string; code: string; name: string; kind: 'good' | 'service'; unit: string;
  unitPrice: Money; taxCode: TaxCode; whtTypeCode?: string;
  /** Where the item is offered: sales documents, purchase documents, or both. */ usage: { sales: boolean; purchase: boolean };
  /** Purchase items: the expense category (fixture `expense-categories`) that picks the account. */ expenseCategory?: string;
  /** Default true; an inactive item is not offered in type-ahead (documents keep their line). */ active?: boolean }

export interface DocLine { id: string; itemId?: string; description: string; qty: Qty; unit: string; unitPrice: Money;
  discountPct?: string; taxCode: TaxCode; dimensions?: Record<string, string>; sourceLineId?: string;
  /** Engine-set only (CN / DN from a correction): this signed amount IS the line's VAT instead of rate x net. Stripped from API input. */
  vatOverride?: Money;
  /** PV lines: the WHT type of this line's income (fixture `[SP-R]`); `expenseCategory` picks the expense account (SP0 5.5). */
  whtTypeCode?: string; expenseCategory?: string;
  /** PV service line paid to a foreign payee: the service is used in Thailand, so PP.36 reverse-charge VAT applies (feeds TX2). Engine-defaulted for a foreign payee. */ pnd36?: boolean;
  /** EX line with VAT: the vendor's tax invoice behind it (ม.82/3, ม.86/4). Without all four details the line's VAT is cost (InputVatUnclaimed), never input VAT; with them the claim window of the invoice date applies, per line. */
  vendorInvoice?: VendorInvoice }
/** The vendor's tax invoice an expense-claim line carries: who issued it (name, TIN), its number and its date. */
export interface VendorInvoice { vendorName: string; vendorTin: string; number: string; date: IsoDate;
  /** The employee confirms it is a FULL tax invoice made out to the company (ม.86/4): only then is its VAT claimable; false or absent = cost. */ fullTaxInvoice?: boolean }
export type WhtMode = 'deduct' | 'grossup_once' | 'grossup_always';
/** One settled open item of an RC / PV: `amount` clears the target, `wht` is what the customer withheld (RC) on that part. */
export interface Allocation { targetId: string; targetType: DocType; targetNumber?: string; amount: Money; wht?: Money;
  whtTypeCode?: string; certNumber?: string;
  /** Engine-set: the party of the target document, i.e. the party who withheld (the 50 tawi belongs to them) and whose AR this clears. */ partyId?: string }
export interface DocHeader { partyId?: string; documentDate: IsoDate; dueDate?: IsoDate; reference?: string;
  notes?: string; dimensions?: Record<string, string>; priceIncludesVat?: boolean;
  whtMode?: WhtMode; bankAccountId?: string; paymentMethod?: 'transfer' | 'cash' | 'cheque';
  /** RC / PV: the account the money moved through, as it was when the document was issued / last revised (frozen at issue: a later rename or re-number of the account never changes a reprint). Server-owned; a draft has none and prints the live account. */
  bankSnapshot?: { kind: 'bank' | 'cash'; bankName?: string; accountNo?: string; accountName: string };
  cheque?: { number: string; date: IsoDate; bank: string };
  /** RC: the unallocated remainder kept as a customer deposit (Cr CustomerDeposit); S4 owns the editor field. */ depositAmount?: Money;
  /** CN / DN: the tax invoice this note adjusts. Server-owned: the note's customer and reference follow it. */ refDocId?: string;
  /** CN / DN: a code from REASON_CODES (reference data [SP-R]); OTHER needs reasonText. The paper prints the Thai wording, never the code. */ reasonCode?: string; reasonText?: string;
  /** PB / PCN / PDN: the number and date printed on the VENDOR's document (we record it, the vendor issued it). On a PB / PDN the date is the vendor's TAX INVOICE date (ม.82/3): the claim window starts at its month; absent = the document date, never after it. */ vendorDocNumber?: string; vendorDocDate?: IsoDate;
  /** PB / PCN / PDN (VAT company): the month 'YYYY-MM' the input VAT is claimed in, the month of the vendor's tax invoice .. +6 (I6, ม.82/3); the server fills that month at issue. A PCN has none: it is filed in the month of its document date. */ claimPeriod?: string;
  /** PB / PDN of a VAT company: the claim window of the vendor's tax invoice had closed when the document was recorded (ม.82/3), so its VAT is cost; a PCN follows its bill. Server-derived at issue and revise. */ inputVatForfeited?: boolean;
  /** PB / PCN / PDN: the vendor's VAT status when the document was ISSUED (M2; a PCN inherits its bill's). Server-owned: the ม.82/5 check judges against it, not the live party master. */ vendorVatRegistered?: boolean;
  /** WT (50 ทวิ, server-written when its PV is issued): the return the tax falls on, the WHT type, its income type and the tax withheld. */ whtForm?: 'PND2' | 'PND3' | 'PND53' | 'PND54'; whtTypeCode?: string; whtIncomeType?: string; whtTax?: Money;
  /** PB: the vendor paperwork is complete (เอกสารครบ). Absent = complete; `false` still issues but the Home inbox counts it (HC1). */ complete?: boolean }
/** `cash` = money that moves: received (RC) / paid (PV). `wht` = withholding tax of the document. */
export interface DocTotals { gross: Money; discount: Money; net: Money; vat: Money; total: Money; wht?: Money; cash?: Money;
  amountInWords: string }
/** `href`: where an exit button goes when the exit is a page elsewhere (the reconciliation lock: the bank line). */
export interface Lock { kind: 'period' | 'filing' | 'settlement' | 'reconciliation'; reason: string; exits: string[]; href?: string }
/** Document marks: facts about the document that are not status (customer accepted / rejected a QT, DO delivered, PO sent, SO closed). Never a revision. */
export type MarkKey = 'accepted' | 'rejected' | 'delivered' | 'sent';
export interface DocMarks { accepted?: { at: string; by: string }; rejected?: { at: string; by: string; reason: string };
  delivered?: { at: string; by: string }; sent?: { at: string; by: string }; closed?: { at: string; by: string; reason: string } }
/** One source line of a convertible document: what was ordered, taken by active conversions (drafts included) and left. */
export interface RemainingLine { lineId: string; description: string; unit: string; ordered: Qty; converted: Qty; remaining: Qty; closed: boolean }
/** PV: the withholding as it was when the voucher was issued / last changed by its own save (C1) - the ledger, the certificates, the paper and the invariants read this, never today's bills.
 *  `bases`: per settled bill and WHT type the base this voucher took (I1: cumulative per bill; `full` = the bill was paid up by this voucher, `billBase` = the bill's base of this type at that moment (B_paidUp, only with `full`), `clamped` = a later credit would have made it negative, so 0). `expense` / `cashDelta` are the gross-up figures (signed). */
export interface WhtFrozen { bases: { targetId: string; whtTypeCode: string; base: Money; clamped?: true; full?: true; billBase?: Money }[]; lines: WhtLine[]; expense: Money; cashDelta: Money }
export interface Doc { id: string; type: DocType; number?: string; status: DocStatus; correctionClass: CorrectionClass;
  revision: number; version: number; header: DocHeader; party?: PartySummary; lines: DocLine[]; totals: DocTotals;
  outstanding?: Money; locks: Lock[]; createdBy: Actor; issuedAt?: string; allocations?: Allocation[]; whtFrozen?: WhtFrozen;
  /** CN / DN (ม.86/10): the invoice's net, the correct value after this note, the difference and its VAT, taken when the note is issued; the paper prints these. Server-written. */
  adjustSnapshot?: { originalNet: Money; correctNet: Money; diffNet: Money; vat: Money };
  cancel?: { reasonCode: string; reasonText: string; at: string }; replacedById?: string; replacesId?: string; marks?: DocMarks;
  /** SO / DO / PO / QT: conversion progress text, derived on every read from the active links (never stored). */ progress?: string;
  /** How many times the print action was used on this issued document (derived from the print log on every read, never stored); 0 / absent = not printed yet, so the next print is the ต้นฉบับ. */ printCount?: number;
  /** An agent-created document: the id of the agent's check report ("ดูรายงานการตรวจ"). */ agentReportId?: string;
  /** Approval trail (§7.6), server-written: who sent the document for approval and who approved it. Gone when the document goes back to draft. */
  approval?: { submittedBy: Actor; submittedAt: string; approvedBy?: Actor; approvedAt?: string; /** The total the approver approved (server-written): a later revise above it needs approval again (C1). */ amount?: Money };
  /** Who last changed the money of this document (a draft save, a revise; server-written): with self-approval off this person cannot approve it either (I2). Absent = the creator. */
  moneyBy?: Actor;
  /** A DRAFT the approval policy wants approved before it can be issued (derived on every read from the policy and the total, never stored): the screen offers submit / approve-and-issue. */
  approvalRequired?: boolean }
/** One approval rule of a company (ST3 edits them): `minAmount` = approval is needed only ABOVE this total; `selfApproval` = the creator may approve their own document. */
export interface ApprovalPolicy { companyId: string; docType: DocType; enabled: boolean; minAmount?: Money; selfApproval: boolean }
/** D-30: what an attached file is evidence of. Labels live in messages (`attachments.category.*`). */
export type AttachmentCategory = 'customer_po' | 'purchase_order' | 'delivery' | 'vendor_tax_invoice' | 'receipt' | 'transfer_slip'
  | 'contract' | 'photo' | 'wht_certificate' | 'government' | 'other';
export interface Attachment { id: string; docId: string; category: AttachmentCategory; name: string; size: number; mime: string; dataUrl: string; at: string; by: string }
/** FN1: a bank statement line. `amount` is signed (+ in, - out); `balance` is the statement's running balance after the line. Importing never posts (FN2 matches / posts). */
/** FN2: what one document matched on one line, frozen at match time (CLAUDE.md money rule): `amount` = this line's share of the document's cash (positive), `docCash` / `accountId` / `docDate` = the document as it was matched. */
export interface BankMatch { docId: string; type: 'RC' | 'PV'; number: string; amount: Money; docCash: Money; accountId: string; docDate: IsoDate }
/** `matches` / `diff` (matched lines), `journalId` (a posted line), `locked` (derived at read: on or before the account's reconciled-to date).
 *  `diff.amount` is in the line's own sign: Σ matched cash (in the line's direction) + diff = line amount, so a bank fee is negative on a receipt and on a payment alike. */
export interface BankLine { id: string; accountId: string; importId: string; date: IsoDate; description: string; amount: Money; balance: Money;
  status: 'unmatched' | 'matched' | 'ignored' | 'posted'; matchedDocIds?: string[]; matches?: BankMatch[]; diff?: { role: 'BankFee' | 'RoundingDifference'; amount: Money; journalId: string };
  journalId?: string; locked?: boolean; note?: string;
  /** Matched to a transfer journal between two own accounts (instead of documents): `side` is this line's own side of it. */ transfer?: { journalId: string; side: 'out' | 'in' } }
/** A journal the reconciliation wrote (no document behind it): the fee / rounding difference of a match, an inline journal of a statement line, or the seeded opening balance. A reversal is appended, an entry is never edited. */
export interface BankJournal { id: string; companyId: string; accountId: string; lineId?: string; kind: 'fee' | 'inline' | 'opening' | 'transfer'; label: string; entries: JournalEntryPreview[];
  /** A transfer: the account on the other side (the journal is Dr receiving / Cr paying, `accountId` is the one whose line made it). */ otherAccountId?: string }
export interface BankImport { id: string; accountId: string; fileName: string; format: 'kbiz-csv' | 'kplus-pdf'; from: IsoDate; to: IsoDate;
  opening: Money; closing: Money; lines: number; at: string; warnings: string[] }
export interface DocSummary { id: string; type: DocType; number?: string; status: DocStatus; documentDate: IsoDate;
  partyName: string; total: Money; outstanding?: Money; dueDate?: IsoDate; reference?: string; createdByAgent: boolean; marks?: DocMarks; progress?: string }
export interface Page<T> { items: T[]; nextCursor?: string; total?: number }

export type LinkKind = 'converted_from' | 'settles' | 'adjusts' | 'groups' | 'replaces' | 'issues';
export interface ChainNode { id: string; type: DocType; number?: string; status: DocStatus; total: Money; progress?: string }
/** `from` = the document whose command created the link (DO→SO converted_from, RC→TI settles, CN→TI adjusts,
 *  BL→TI groups, new TI→old TI replaces, PV→WT issues); `to` = the document it refers to. */
export interface ChainEdge { from: string; to: string; kind: LinkKind; amount?: Money; qty?: Qty; active: boolean; wht?: Money }
export interface ChainGraph { rootId: string; nodes: ChainNode[]; edges: ChainEdge[] }

export interface ActivityEntry { id: string; at: string; actor: Actor; action: string; detail?: string; reportId?: string }
export interface FieldChange { path: string; before: string | null; after: string | null }
export interface Revision { revision: number; at: string; actor: Actor; reason?: string; snapshot: Doc; diff: FieldChange[] }
export interface AuditEntry { id: string; at: string; actor: Actor; companyId: string; command: string; target?: string;
  before?: unknown; after?: unknown; result: 'ok' | 'rejected' }

export interface JournalLinePreview { accountCode: string; accountName: string; debit: Money; credit: Money;
  partyName?: string; dimensions?: Record<string, string>; rule: string }
export interface JournalEntryPreview { number?: string; date: IsoDate; kind: 'original' | 'reversal' | 'correction';
  /** When the entry was written (mock clock); set once, never changed - a reversal has its own. Closed-period invariant 7 judges with it. */ postedAt?: string;
  /** Posted into the first open period because the original sits in a closed one ("แก้ไขย้อนหลัง"). */ late?: boolean;
  lines: JournalLinePreview[] }
export interface JournalPreview { entries: JournalEntryPreview[] }

export interface MissingItem { field: string; message: string; /** Set when the editor offers a specific exit for the refusal (`pv.input_vat_needs_bill` → the quick-bill dialog). */ code?: string }
export interface WhtLine { code: string; nameTh: string; form: 'PND2' | 'PND3' | 'PND53' | 'PND54'; base: Money; rate: string; tax: Money; income: Money; /** What the payee actually receives for this type: income - tax. */ net: Money }
export interface OpenItem { id: string; type: DocType; number: string; documentDate: IsoDate; dueDate?: IsoDate; total: Money; outstanding: Money }
export interface ComputeResult { lines: { id: string; net: Money; vat: Money; total: Money }[]; totals: DocTotals;
  missing: MissingItem[]; /** Omitted without ledger.read (D-09). */ journal?: JournalPreview; whtLines?: WhtLine[];
  /** The approval policy needs this document approved before it can be issued (server-decided on the computed total, §7.6). */ approvalRequired?: boolean;
  allocation?: { allocated: Money; unallocated: Money; suggestedWht: { targetId: string; wht: Money; whtTypeCode?: string }[] } }

export interface CorrectionNote { type: 'CN' | 'DN'; fullCredit: boolean; priceIncludesVat: boolean;
  lines: DocLine[]; total: Money;
  taxLines: { taxCode: TaxCode; net: Money; vat: Money; total: Money }[] }
export interface CorrectionStep { order: number; action: 'revise' | 'cancel' | 'reissue' | 'issue_cn' | 'issue_dn';
  docId: string; docType: DocType; number?: string; summary: string; permission: string; note?: CorrectionNote }
export interface CorrectionPlan { planId: string; planHash: string; steps: CorrectionStep[]; missingPermissions: string[];
  explanation: string }
export interface CorrectionResult { affected: { docId: string; type: DocType; number?: string; status: DocStatus }[] }

export interface HomeInbox { approvals: DocSummary[]; myDrafts: DocSummary[]; overdue: DocSummary[];
  deadlines: { form: string; due: IsoDate }[]; unreconciledLines: number; agentDigest: { posted: number; waiting: number };
  kpis: { cash: Money; ar: Money; ap: Money; vatThisMonth: Money | null } }
export interface SearchHit { kind: 'doc' | 'party' | 'page'; id: string; label: string; href?: string } // no href: the type's screens are not built yet (shown as text)

export interface ApiProblem { type?: string; title: string; status: number; code: string; detail?: string;
  traceId?: string; fieldErrors?: Record<string, string[]> }

/** Printed party block. phone / nameEn are optional extras for the seller header. */
export interface PaperParty { name: string; nameEn?: string; address: string; phone?: string; taxId?: string; branchLabel?: string }
/** Everything the printed document shows, ready-made by the server: the paper never computes tax or totals. */
export interface PaperModel {
  titleTh: string; titleEn: string;            // 'ใบกำกับภาษี' / 'TAX INVOICE'
  copyLabel: 'ต้นฉบับ' | 'สำเนา';
  number: string; documentDate: IsoDate; dueDate?: IsoDate; reference?: string;
  /** Label of the due date on this paper (QT: 'ยืนราคาถึง'); default 'ครบกำหนดชำระ'. */ dueLabel?: string;
  /** N-class revision of a quotation / order: 'ฉบับแก้ไขครั้งที่ n', printed on every page. */ revisionLabel?: string;
  seller: PaperParty; buyer: PaperParty;
  lines: { no: number; description: string; qty: Qty; unit: string; unitPrice: Money; amount: Money; taxCode: TaxCode; discountPct?: string;
    /** Receipt only: the tax the customer withheld on this settled document. */ wht?: Money }[];
  totals: DocTotals; notes?: string;
  /** VAT presentation supplied by the server, printed in order after the net row: zero-rated / exempt sales bases, then the VAT line. */
  vatLines?: { label: string; amount: Money }[]; // omitted for a non-VAT company: no VAT row, no net-before-tax row
  /** Receipt only: how the money came in (method, bank account or cheque), one line printed by the server. */ payment?: string;
  /** CN / DN (ม.86/10): the tax invoice adjusted, its value, the correct value and the difference (this note's net; its VAT is totals.vat), all server-computed. */
  adjusts?: { number: string; date: IsoDate; originalNet: Money; correctNet: Money; diffNet: Money; reason: string };
  /** PV: the tax withheld per WHT type (income type + rate, the base and the tax), as the server computed it. */ whtLines?: { label: string; base: Money; tax: Money }[];
  /** Label of the party block when it is not the customer (PV: 'ผู้รับเงิน'). */ partyLabel?: string;
  /** WT (50 ทวิ, D-21): everything the certificate prints, server-built and frozen at the first print (I7). */
  certificate?: { form: 'PND2' | 'PND3' | 'PND53' | 'PND54'; sequence?: string; incomeType: string; incomeLabel: string; paidOn: IsoDate; income: Money; tax: Money; taxInWords: string;
    condition: 'withhold' | 'forever' | 'once'; voucher?: string };
  replacementNote?: string;                    // 'ยกเลิกและออกแทนฉบับเดิม เลขที่ … ลงวันที่ …' (on the NEW document)
  voidMark?: { label: string; note?: string }; // cancelled / replaced originals: diagonal stamp on every page
  signatures: string[];                        // ['ผู้รับสินค้า/บริการ', 'ผู้รับเงิน', 'ผู้มีอำนาจลงนาม']
}
