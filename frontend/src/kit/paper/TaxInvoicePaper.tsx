'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PaperModel, PaperParty } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';
import { Paper, PaperPage } from './Paper';
import { paginate } from './paginate';

// A tax invoice (ม.86/4) is a Thai legal document: its labels stay Thai whatever the UI language is, so they are not in messages.
const L = {
  customer: 'ลูกค้า', taxId: 'เลขประจำตัวผู้เสียภาษี', phone: 'โทร', no: 'เลขที่', date: 'วันที่', due: 'ครบกำหนดชำระ', ref: 'เลขที่อ้างอิง',
  seq: 'ลำดับ', desc: 'รายการ', qty: 'จำนวน', unit: 'หน่วย', price: 'ราคา/หน่วย', amount: 'จำนวนเงิน',
  words: 'จำนวนเงินรวมทั้งสิ้น (ตัวอักษร)', notes: 'หมายเหตุ', gross: 'รวมเป็นเงิน', discount: 'ส่วนลด', net: 'มูลค่าก่อนภาษี',
  total: 'จำนวนเงินรวมทั้งสิ้น', baht: 'บาท', discountOn: 'ส่วนลด', z0: 'อัตราภาษีร้อยละ 0', ex: 'ได้รับยกเว้นภาษี',
  adjRef: 'อ้างอิงใบกำกับภาษีเดิม', adjNo: 'เลขที่', adjReason: 'เหตุผล', adjOriginal: 'มูลค่าตามใบกำกับภาษีเดิม', adjCorrect: 'มูลค่าที่ถูกต้อง', adjDiff: 'ผลต่าง',
  wht: 'ภาษีถูกหัก ณ ที่จ่าย', cash: 'รับเงินสุทธิ', paid: 'รวมรับชำระ', payment: 'วิธีรับชำระ',
  vWht: 'ภาษีหัก ณ ที่จ่าย', vCash: 'จ่ายเงินสุทธิ', vPaid: 'รวมจ่ายชำระ', vPayment: 'วิธีจ่ายเงิน',
};

/** px; the real sheet (794 x 1123, 42 px top/bottom padding) minus a safety margin so print never clips a row. */
const INNER = 1123 - 2 * 42 - 8 - 42; // 42 = .paper-pg margin-top (6mm) + .paper-items padding-top (5mm), outside the measured blocks
/** Used where nothing can be measured (jsdom) or a block measures 0. */
const FALLBACK = { head: 230, thead: 38, pg: 34, foot: 330 };
interface Metrics { rows: number[]; head: number; thead: number; pg: number; foot: number }

const qtyOf = (q: string) => (q.includes('.') ? q.replace(/0+$/, '').replace(/\.$/, '') : q);
const mark = (name: string) => name.replace(/^(บริษัท|ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|หจก\.|บจก\.)\s*/, '').charAt(0);
const partyIds = (p: PaperParty) => [p.taxId ? `${L.taxId} ${p.taxId}` : '', p.branchLabel ?? ''].filter(Boolean).join(' · ');

function Head({ m }: { m: PaperModel }) {
  const s = m.seller;
  return (
    <header data-probe="head">
      <div className="paper-hd">
        <div className="paper-seller">
          <div className="paper-logo" aria-hidden="true">{mark(s.name)}</div>
          <div>
            <h2>{s.name}</h2>
            {s.nameEn ? <div className="paper-name-en">{s.nameEn}</div> : null}
            <p>{s.address}</p>
            {s.phone ? <p>{L.phone} {s.phone}</p> : null}
            <p className="paper-tin">{partyIds(s)}</p>
          </div>
        </div>
        <div className="paper-title">
          <h2>{m.titleTh}</h2>
          <span className="paper-en">{m.titleEn}</span>
          <span className="paper-pill">{m.copyLabel}</span>
          {m.revisionLabel ? <span className="paper-rev">{m.revisionLabel}</span> : null}
        </div>
      </div>
      <div className="paper-parties">
        <section className="paper-box paper-buyer">
          <div className="paper-box-h">{m.partyLabel ?? L.customer}</div>
          <h3>{m.buyer.name}</h3>
          {m.buyer.address ? <p>{m.buyer.address}</p> : null}
          {partyIds(m.buyer) ? <p>{partyIds(m.buyer)}</p> : null}
        </section>
        <section className="paper-box paper-docbox">
          <dl>
            <dt>{L.no}</dt><dd className="paper-docno">{m.number}</dd>
            <dt>{L.date}</dt><dd>{formatDateBE(m.documentDate)}</dd>
            {m.dueDate ? <><dt>{m.dueLabel ?? L.due}</dt><dd>{formatDateBE(m.dueDate)}</dd></> : null}
            {m.reference ? <><dt>{L.ref}</dt><dd>{m.reference}</dd></> : null}
          </dl>
        </section>
      </div>
      {m.adjusts ? ( // CN / DN (ม.86/10): the invoice adjusted, why, and the three values, as the server computed them
        <section className="paper-box paper-docbox paper-adjust" aria-label={L.adjRef}>
          <dl>
            <dt>{L.adjRef}</dt><dd>{L.adjNo} {m.adjusts.number} · {formatDateBE(m.adjusts.date)}</dd>
            <dt>{L.adjReason}</dt><dd>{m.adjusts.reason}</dd>
            <dt>{L.adjOriginal}</dt><dd>{formatMoney(m.adjusts.originalNet)}</dd>
            <dt>{L.adjCorrect}</dt><dd>{formatMoney(m.adjusts.correctNet)}</dd>
            <dt>{L.adjDiff}</dt><dd>{formatMoney(m.adjusts.diffNet)}</dd>
          </dl>
        </section>
      ) : null}
      {m.replacementNote ? <p className="paper-replace">{m.replacementNote}</p> : null}
    </header>
  );
}

const Cols = ({ receipt }: { receipt?: boolean }) => <colgroup><col style={{ width: 44 }} /><col /><col style={{ width: 62 }} /><col style={{ width: 62 }} /><col style={{ width: 100 }} /><col style={{ width: 112 }} />{receipt ? <col style={{ width: 128 }} /> : null}</colgroup>;

function Thead({ receipt }: { receipt?: boolean }) {
  return (
    <thead data-probe="thead">
      <tr>
        <th className="c">{L.seq}</th><th>{L.desc}</th><th className="r">{L.qty}</th><th className="c">{L.unit}</th>
        <th className="r">{L.price}</th><th className="r">{L.amount}</th>{receipt ? <th className="r">{L.wht}</th> : null}
      </tr>
    </thead>
  );
}

function Row({ l, receipt, plain }: { l: PaperModel['lines'][number]; receipt?: boolean; plain?: boolean }) {
  const sub = receipt || plain ? '' : [l.discountPct ? `${L.discountOn} ${l.discountPct}%` : '', l.taxCode === 'Z0' ? L.z0 : l.taxCode === 'EX' ? L.ex : ''].filter(Boolean).join(' · ');
  return (
    <tr data-probe="row">
      <td className="c paper-no">{l.no}</td>
      <td className="paper-name">{l.description}{sub ? <span className="paper-sub">{sub}</span> : null}</td>
      <td className="r">{qtyOf(l.qty)}</td><td className="c">{l.unit}</td>
      <td className="r">{l.unitPrice ? formatMoney(l.unitPrice) : ''}</td><td className="r paper-amt">{formatMoney(l.amount)}</td>
      {receipt ? <td className="r">{l.wht ? formatMoney(l.wht) : ''}</td> : null}
    </tr>
  );
}

function Foot({ m, receipt, voucher }: { m: PaperModel; receipt?: boolean; voucher?: boolean }) {
  const t = m.totals;
  return (
    <footer className="paper-ft" data-probe="foot">
      <div className="paper-sum">
        <div>
          <div className="paper-words"><div className="l">{L.words}</div><div className="v">({t.amountInWords})</div></div>
          {receipt && m.payment ? <div className="paper-notes"><h4>{voucher ? L.vPayment : L.payment}</h4><p>{m.payment}</p></div> : null}
          {m.notes ? <div className="paper-notes"><h4>{L.notes}</h4><p>{m.notes}</p></div> : null}
        </div>
        <div>
          <table className="paper-tot">
            <tbody>
              {voucher ? ( // the server's figures: the tax withheld per WHT type, then cash paid; cash + tax = what the voucher clears
                <>
                  {m.whtLines?.map((w) => <tr key={w.label}><td>{w.label}</td><td>{formatMoney(w.tax)}</td></tr>)}
                  <tr><td>{L.vWht}</td><td>{formatMoney(t.wht ?? '0.00')}</td></tr>
                  <tr><td>{L.vCash}</td><td>{formatMoney(t.cash ?? '0.00')}</td></tr>
                </>
              ) : receipt ? ( // the server's three figures: cash received + tax withheld = what the receipt clears
                <>
                  <tr><td>{L.cash}</td><td>{formatMoney(t.cash ?? '0.00')}</td></tr>
                  <tr><td>{L.wht}</td><td>{formatMoney(t.wht ?? '0.00')}</td></tr>
                </>
              ) : (
                <>
                  <tr><td>{L.gross}</td><td>{formatMoney(t.gross)}</td></tr>
                  {Number(t.discount) !== 0 ? <tr><td>{L.discount}</td><td>{formatMoney(t.discount)}</td></tr> : null}
                  {m.vatLines ? <tr className="sub"><td>{L.net}</td><td>{formatMoney(t.net)}</td></tr> : null}
                  {m.vatLines?.map((v) => <tr key={v.label}><td>{v.label}</td><td>{formatMoney(v.amount)}</td></tr>)}
                </>
              )}
            </tbody>
          </table>
          <div className="paper-grand"><span className="l">{voucher ? L.vPaid : receipt ? L.paid : L.total}<span className="paper-en">{L.baht}</span></span><span className="v">{formatMoney(t.total)}</span></div>
        </div>
      </div>
      <div className="paper-sign">
        {m.signatures.map((s) => <div className="paper-sig" key={s}><div className="line" /><div className="who">{s}</div><div className="date">{L.date} <i /></div></div>)}
      </div>
    </footer>
  );
}

function PageFoot({ m, n, total }: { m: PaperModel; n: number; total: number }) {
  return <div className="paper-pg" data-probe="pg"><span>{L.no} {m.number} · {m.seller.name}</span><span>{`หน้า ${n}/${total}`}</span></div>;
}

const fontsReady = () => (typeof document !== 'undefined' && document.fonts ? document.fonts.ready : Promise.resolve());
const h = (e: Element | null) => (e ? Math.ceil(e.getBoundingClientRect().height) : 0);

/** The printed tax invoice, and (via CommercialPaper) every other sales / purchase paper: the server-built model decides titles, VAT rows and revision wording. Rows are measured once in a hidden probe (real layout, after fonts load); `measure` replaces that in tests. */
export function TaxInvoicePaper({ model, measure, onReady, receipt, voucher }: { model: PaperModel; measure?: (rowIndex: number) => number; onReady?: () => void; /** The receipt layout (ReceiptPaper): a WHT column and the received / withheld / total footer. */ receipt?: boolean;
  /** The payment-voucher layout (PaymentVoucherPaper): the receipt footer reworded for money paid out, the WHT per type instead of a WHT column. */ voucher?: boolean }) {
  const wcol = receipt && !voucher; // the WHT column belongs to a receipt (the customer withheld per settled invoice)
  const probe = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  useEffect(() => {
    if (measure) return;
    let live = true;
    void fontsReady().then(() => {
      const el = probe.current;
      if (!live || !el) return;
      const one = (k: string) => h(el.querySelector(`[data-probe="${k}"]`)) || FALLBACK[k as keyof typeof FALLBACK];
      setMetrics({ rows: [...el.querySelectorAll('[data-probe="row"]')].map((r) => h(r) || 30), head: one('head'), thead: one('thead'), pg: one('pg'), foot: one('foot') });
    });
    return () => { live = false; };
  }, [model, measure]);

  const m: Metrics | null = useMemo(
    () => (measure ? { rows: model.lines.map((_, i) => measure(i)), ...FALLBACK } : metrics),
    [measure, model.lines, metrics],
  );
  const pages = useMemo(() => {
    if (!m) return null;
    const cap = INNER - m.head - m.thead - m.pg; // the header block and table header repeat on every sheet
    return paginate(m.rows, { first: cap, next: cap, lastReserve: m.foot });
  }, [m]);

  const ready = pages !== null;
  useEffect(() => { if (ready) onReady?.(); }, [ready, onReady]);
  const stamp = model.voidMark;
  return (
    <Paper ready={pages !== null}>
      {!measure ? (
        <div className="paper-probe" ref={probe} aria-hidden="true">
          <Head m={model} />
          <table className="paper-lines"><Cols receipt={wcol} /><Thead receipt={wcol} /><tbody>{model.lines.map((l) => <Row key={l.no} l={l} receipt={wcol} plain={voucher} />)}</tbody></table>
          <Foot m={model} receipt={receipt} voucher={voucher} />
          <PageFoot m={model} n={1} total={1} />
        </div>
      ) : null}
      {pages ? (
        <div className="paper-stack">
          {pages.map((rows, p) => (
            <PaperPage key={p} stamp={stamp}>
              <Head m={model} />
              <div className="paper-items">
                <table className="paper-lines"><Cols receipt={wcol} /><Thead receipt={wcol} /><tbody>{rows.map((i) => <Row key={model.lines[i].no} l={model.lines[i]} receipt={wcol} plain={voucher} />)}</tbody></table>
              </div>
              {p === pages.length - 1 ? <Foot m={model} receipt={receipt} voucher={voucher} /> : null}
              <PageFoot m={model} n={p + 1} total={pages.length} />
            </PaperPage>
          ))}
        </div>
      ) : null}
    </Paper>
  );
}
