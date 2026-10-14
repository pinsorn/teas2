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
  vatRegistered: boolean; permissions: string[] }
export interface Actor { kind: 'user' | 'agent'; id: string; name: string; ownerName?: string }

export interface PartySummary { id: string; kind: 'customer' | 'vendor'; code: string; name: string; taxId?: string;
  branchCode?: string; vatRegistered: boolean; address?: string; paymentTermDays: number; defaultWhtTypeCode?: string;
  usualItemIds?: string[]; entityKind: 'individual' | 'juristic' | 'foreign' }
export interface ItemSummary { id: string; code: string; name: string; kind: 'good' | 'service'; unit: string;
  unitPrice: Money; taxCode: TaxCode; whtTypeCode?: string }

export interface DocLine { id: string; itemId?: string; description: string; qty: Qty; unit: string; unitPrice: Money;
  discountPct?: string; taxCode: TaxCode; dimensions?: Record<string, string>; sourceLineId?: string;
  /** Engine-set only (CN / DN from a correction): this signed amount IS the line's VAT instead of rate x net. Stripped from API input. */
  vatOverride?: Money;
  /** PV lines: the WHT type of this line's income (fixture `[SP-R]`); `expenseCategory` picks the expense account (SP0 5.5). */
  whtTypeCode?: string; expenseCategory?: string }
export type WhtMode = 'deduct' | 'grossup_once' | 'grossup_always';
/** One settled open item of an RC / PV: `amount` clears the target, `wht` is what the customer withheld (RC) on that part. */
export interface Allocation { targetId: string; targetType: DocType; targetNumber?: string; amount: Money; wht?: Money;
  whtTypeCode?: string; certNumber?: string }
export interface DocHeader { partyId?: string; documentDate: IsoDate; dueDate?: IsoDate; reference?: string;
  notes?: string; dimensions?: Record<string, string>; priceIncludesVat?: boolean;
  whtMode?: WhtMode; bankAccountId?: string; paymentMethod?: 'transfer' | 'cash' | 'cheque';
  cheque?: { number: string; date: IsoDate; bank: string };
  /** RC: the unallocated remainder kept as a customer deposit (Cr CustomerDeposit); S4 owns the editor field. */ depositAmount?: Money }
/** `cash` = money that moves: received (RC) / paid (PV). `wht` = withholding tax of the document. */
export interface DocTotals { gross: Money; discount: Money; net: Money; vat: Money; total: Money; wht?: Money; cash?: Money;
  amountInWords: string }
export interface Lock { kind: 'period' | 'filing' | 'settlement' | 'reconciliation'; reason: string; exits: string[] }
export interface Doc { id: string; type: DocType; number?: string; status: DocStatus; correctionClass: CorrectionClass;
  revision: number; version: number; header: DocHeader; party?: PartySummary; lines: DocLine[]; totals: DocTotals;
  outstanding?: Money; locks: Lock[]; createdBy: Actor; issuedAt?: string; allocations?: Allocation[];
  cancel?: { reasonCode: string; reasonText: string; at: string }; replacedById?: string; replacesId?: string }
export interface DocSummary { id: string; type: DocType; number?: string; status: DocStatus; documentDate: IsoDate;
  partyName: string; total: Money; outstanding?: Money; dueDate?: IsoDate; reference?: string; createdByAgent: boolean }
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
  /** Posted into the first open period because the original sits in a closed one ("แก้ไขย้อนหลัง"). */ late?: boolean;
  lines: JournalLinePreview[] }
export interface JournalPreview { entries: JournalEntryPreview[] }

export interface MissingItem { field: string; message: string }
export interface WhtLine { code: string; nameTh: string; form: 'PND2' | 'PND3' | 'PND53' | 'PND54'; base: Money; rate: string; tax: Money; income: Money }
export interface OpenItem { id: string; type: DocType; number: string; documentDate: IsoDate; dueDate?: IsoDate; total: Money; outstanding: Money }
export interface ComputeResult { lines: { id: string; net: Money; vat: Money; total: Money }[]; totals: DocTotals;
  missing: MissingItem[]; /** Omitted without ledger.read (D-09). */ journal?: JournalPreview; whtLines?: WhtLine[];
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
  seller: PaperParty; buyer: PaperParty;
  lines: { no: number; description: string; qty: Qty; unit: string; unitPrice: Money; amount: Money; taxCode: TaxCode; discountPct?: string }[];
  totals: DocTotals; notes?: string;
  /** VAT presentation supplied by the server, printed in order after the net row: zero-rated / exempt sales bases, then the VAT line. */
  vatLines: { label: string; amount: Money }[];
  replacementNote?: string;                    // 'ยกเลิกและออกแทนฉบับเดิม เลขที่ … ลงวันที่ …' (on the NEW document)
  voidMark?: { label: string; note?: string }; // cancelled / replaced originals: diagonal stamp on every page
  signatures: string[];                        // ['ผู้รับสินค้า/บริการ', 'ผู้รับเงิน', 'ผู้มีอำนาจลงนาม']
}
