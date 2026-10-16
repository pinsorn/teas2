'use client';
import type { PaperModel } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';
import { Paper, PaperPage } from './Paper';

type Cert = NonNullable<PaperModel['certificate']>;

// The 50 ทวิ is a Thai legal form (D-21): its labels stay Thai whatever the UI language is.
const L = {
  seq: 'ลำดับที่', inForm: 'ในแบบ', payer: 'ผู้มีหน้าที่หักภาษี ณ ที่จ่าย', payee: 'ผู้ถูกหักภาษี ณ ที่จ่าย', tin: 'เลขประจำตัวผู้เสียภาษีอากร', address: 'ที่อยู่',
  type: 'ประเภทเงินได้พึงประเมินที่จ่าย', paidOn: 'วัน เดือน หรือปีภาษี ที่จ่าย', amount: 'จำนวนเงินที่จ่าย', tax: 'ภาษีที่หักและนำส่งไว้', total: 'รวมเงินที่จ่ายและภาษีที่หักนำส่ง',
  words: 'รวมเงินภาษีที่หักนำส่ง (ตัวอักษร)', condition: 'ผู้จ่ายเงิน', no: 'เลขที่', voucher: 'ใบสำคัญจ่าย', sign: 'ลงชื่อ ผู้จ่ายเงิน', date: 'วันที่',
  cert: 'ขอรับรองว่าได้หักภาษี ณ ที่จ่ายและนำส่งภาษีตามรายละเอียดข้างต้นแล้ว',
};
const FORMS: { key: Cert['form'] | 'x'; label: string }[] = [
  { key: 'x', label: '(1) ภ.ง.ด.1ก' }, { key: 'x', label: '(2) ภ.ง.ด.1ก พิเศษ' }, { key: 'PND2', label: '(3) ภ.ง.ด.2' }, { key: 'PND3', label: '(4) ภ.ง.ด.3' },
  { key: 'x', label: '(5) ภ.ง.ด.2ก' }, { key: 'x', label: '(6) ภ.ง.ด.3ก' }, { key: 'PND53', label: '(7) ภ.ง.ด.53' }, { key: 'PND54', label: 'ภ.ง.ด.54 (จ่ายต่างประเทศ)' },
];
const CONDITIONS: { key: Cert['condition']; label: string }[] = [
  { key: 'withhold', label: '(1) หัก ณ ที่จ่าย' }, { key: 'forever', label: '(2) ออกให้ตลอดไป' }, { key: 'once', label: '(3) ออกให้ครั้งเดียว' },
];
const COPIES = ['ฉบับที่ 1 (สำหรับผู้ถูกหักภาษี ใช้แนบพร้อมกับแบบแสดงรายการภาษี)', 'ฉบับที่ 2 (สำหรับผู้ถูกหักภาษี เก็บไว้เป็นหลักฐาน)'];
const ids = (p: { taxId?: string; branchLabel?: string }) => [p.taxId ? `${L.tin} ${p.taxId}` : '', p.branchLabel ?? ''].filter(Boolean).join(' · ');

function Check({ on }: { on: boolean }) {
  return <span className="paper-check" data-checked={on ? 'true' : 'false'} aria-hidden="true">{on ? '✓' : ''}</span>;
}

function Sheet({ m, copy }: { m: PaperModel; copy: number }) {
  const c = m.certificate!;
  return (
    <PaperPage stamp={m.voidMark}>
      <header className="paper-hd">
        <div className="paper-seller"><div><h2>{m.titleTh}</h2><div className="paper-name-en">{m.titleEn} · ตามมาตรา 50 ทวิ แห่งประมวลรัษฎากร</div><p>{COPIES[copy]}</p></div></div>
        <div className="paper-title"><span className="paper-pill">{m.copyLabel}</span></div>
      </header>
      <div className="paper-wht-seq">
        <div className="paper-box paper-wht-seqbox" data-field="sequence"><span>{L.seq}</span><b>{c.sequence ?? ''}</b><span>{L.inForm}</span></div>
        <ul className="paper-wht-forms" aria-label="แบบแสดงรายการภาษี">
          {FORMS.map((f) => <li key={f.label}><Check on={f.key === c.form} /> {f.label}</li>)}
        </ul>
        <dl className="paper-wht-no"><dt>{L.no}</dt><dd className="paper-docno" data-field="number">{m.number}</dd>{c.voucher ? <><dt>{L.voucher}</dt><dd>{c.voucher}</dd></> : null}</dl>
      </div>
      <section className="paper-box paper-wht-party" aria-label={L.payer}>
        <div className="paper-box-h">{L.payer}</div>
        <h3>{m.seller.name}</h3><p>{ids(m.seller)}</p><p>{L.address} {m.seller.address}</p>
      </section>
      <section className="paper-box paper-wht-party" aria-label={L.payee}>
        <div className="paper-box-h">{m.partyLabel ?? L.payee}</div>
        <h3>{m.buyer.name}</h3><p>{ids(m.buyer)}</p>{m.buyer.address ? <p>{L.address} {m.buyer.address}</p> : null}
      </section>
      <table className="paper-lines paper-wht-table">
        <colgroup><col /><col style={{ width: 130 }} /><col style={{ width: 120 }} /><col style={{ width: 120 }} /></colgroup>
        <thead><tr><th>{L.type}</th><th className="c">{L.paidOn}</th><th className="r">{L.amount}</th><th className="r">{L.tax}</th></tr></thead>
        <tbody>
          <tr data-field="income-row"><td className="paper-name">{c.incomeLabel}</td><td className="c">{formatDateBE(c.paidOn)}</td><td className="r">{formatMoney(c.income)}</td><td className="r">{formatMoney(c.tax)}</td></tr>
          <tr className="paper-wht-total"><td colSpan={2}>{L.total}</td><td className="r">{formatMoney(c.income)}</td><td className="r" data-field="tax-total">{formatMoney(c.tax)}</td></tr>
        </tbody>
      </table>
      <div className="paper-words"><div className="l">{L.words}</div><div className="v">({c.taxInWords})</div></div>
      <ul className="paper-wht-forms paper-wht-cond" aria-label={L.condition}>
        <li>{L.condition}</li>
        {CONDITIONS.map((x) => <li key={x.key}><Check on={x.key === c.condition} /> {x.label}</li>)}
      </ul>
      <p className="paper-wht-cert">{L.cert}</p>
      <div className="paper-sign">
        <div className="paper-sig"><div className="line" /><div className="who">{L.sign}</div><div className="date">{L.date} {formatDateBE(c.paidOn)}</div></div>
      </div>
    </PaperPage>
  );
}

/** WT (50 ทวิ, D-21): payer = our company, payee, the return the tax falls on (checkbox), one income type with date / amount / tax, the total in words from the server, the payer's condition, and TWO copies
 *  (ฉบับที่ 1 / 2) on one print. The "ลำดับที่" box is `[SP-R]` (the line number in the return is not known when the certificate is issued) and stays empty. The paper is the server's frozen snapshot (I7). */
export function WhtCertificatePaper({ model }: { model: PaperModel; /** Tests only; the certificate is one fixed sheet, nothing is measured. */ measure?: (rowIndex: number) => number }) {
  if (!model.certificate) return null;
  return (
    <Paper ready>
      <div className="paper-stack"><Sheet m={model} copy={0} /><Sheet m={model} copy={1} /></div>
    </Paper>
  );
}
