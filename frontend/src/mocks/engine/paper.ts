import type { Company, Doc, DocType, PaperModel } from '@/domain/types';
import { formatDateBE } from '@/lib/format';
import type { ctx } from '../handlers/common';
import { compute } from './commands';
import { fromSatang, toSatang } from './money';
type Ctx = ReturnType<typeof ctx>;

const branchLabel = (code?: string) => (!code ? undefined : code === '00000' ? 'สำนักงานใหญ่ (00000)' : `สาขา ${code}`);

interface Look { titleTh: string; titleEn: string; signatures: string[]; dueLabel?: string }
const LOOK: Partial<Record<DocType, Look>> = {
  TI: { titleTh: 'ใบกำกับภาษี', titleEn: 'TAX INVOICE', signatures: ['ผู้รับสินค้า/บริการ', 'ผู้รับเงิน', 'ผู้มีอำนาจลงนาม'] },
  QT: { titleTh: 'ใบเสนอราคา', titleEn: 'QUOTATION', signatures: ['ผู้เสนอราคา', 'ผู้อนุมัติ', 'ลูกค้ายืนยันสั่งซื้อ'], dueLabel: 'ยืนราคาถึง' },
};

/** Paper from the stored snapshots; amounts and words are the engine's, never recomputed in the UI. A company outside VAT gets no VAT rows at all. */
function paperOf(c: Ctx, d: Doc, copy: boolean): PaperModel {
  const look = LOOK[d.type]!;
  const co: Company = c.company;
  const calc = compute(c.st, co.id, d.type, { header: d.header, lines: d.lines }).lines;
  const net = new Map(calc.map((l) => [l.id, l.net]));
  const sum = (code: string, k: 'net' | 'vat') => fromSatang(d.lines.reduce((a, l, i) => a + (l.taxCode === code ? toSatang(calc[i][k]) : 0), 0));
  const has = (code: string) => d.lines.some((l) => l.taxCode === code);
  const vatLines = [
    ...(has('Z0') ? [{ label: 'ยอดขายอัตราร้อยละ 0', amount: sum('Z0', 'net') }] : []),
    ...(has('EX') ? [{ label: 'ยอดขายที่ได้รับยกเว้น', amount: sum('EX', 'net') }] : []),
    has('S7') ? { label: 'ภาษีมูลค่าเพิ่ม 7%', amount: sum('S7', 'vat') } : { label: 'ภาษีมูลค่าเพิ่ม', amount: '0.00' },
  ];
  const other = (id?: string) => c.st.docs.find((x) => x.id === id);
  const old = other(d.replacesId), nw = other(d.replacedById);
  return {
    titleTh: look.titleTh, titleEn: look.titleEn, copyLabel: copy ? 'สำเนา' : 'ต้นฉบับ',
    number: d.number ?? '-', documentDate: d.header.documentDate, dueDate: d.header.dueDate, reference: d.header.reference,
    seller: { name: co.legalNameTh, nameEn: co.legalNameEn, address: co.address, phone: co.phone, taxId: co.taxId, branchLabel: branchLabel(co.branchCode) },
    buyer: { name: d.party?.name ?? '-', address: d.party?.address ?? '', taxId: d.party?.taxId, branchLabel: d.party?.taxId ? branchLabel(d.party.branchCode) : undefined },
    lines: d.lines.map((l, i) => ({ no: i + 1, description: l.description, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, amount: net.get(l.id) ?? '0.00', taxCode: l.taxCode, ...(l.discountPct ? { discountPct: l.discountPct } : {}) })),
    totals: d.totals, notes: d.header.notes, ...(co.vatRegistered ? { vatLines } : {}),
    ...(look.dueLabel ? { dueLabel: look.dueLabel } : {}),
    ...(d.correctionClass === 'N' && d.revision > 0 ? { revisionLabel: `ฉบับแก้ไขครั้งที่ ${d.revision}` } : {}),
    ...(old ? { replacementNote: `ยกเลิกและออกแทนฉบับเดิม เลขที่ ${old.number ?? '-'} ลงวันที่ ${formatDateBE(old.header.documentDate)}` } : {}),
    ...(d.status === 'replaced' ? { voidMark: { label: 'ถูกแทนที่', note: nw?.number ? `ออกแทนด้วยเลขที่ ${nw.number}` : undefined } }
      : d.status === 'cancelled' ? { voidMark: { label: 'ยกเลิก', note: d.cancel?.reasonText } } : {}),
    signatures: look.signatures,
  };
}

export const PAPER_BUILDERS: Partial<Record<DocType, (c: Ctx, d: Doc, copy: boolean) => PaperModel>> = { TI: paperOf, QT: paperOf };
