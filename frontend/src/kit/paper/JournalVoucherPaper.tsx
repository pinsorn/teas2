'use client';
import type { PaperModel } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';
import { Paper, PaperPage } from './Paper';
import { LogoMark, SigBlocks } from './TaxInvoicePaper';

// A journal voucher is an internal accounting record: its labels stay Thai whatever the UI language is, so they are not in messages.
const L = { phone: 'โทร', taxId: 'เลขประจำตัวผู้เสียภาษี', no: 'เลขที่', date: 'วันที่', ref: 'เลขที่อ้างอิง', seq: 'ลำดับ', account: 'บัญชี', desc: 'คำอธิบาย', debit: 'เดบิต', credit: 'เครดิต', total: 'รวม', words: 'จำนวนเงินรวม (ตัวอักษร)', notes: 'หมายเหตุ', baht: 'บาท' };
const PER_PAGE = 22; // account lines on a sheet (a long voucher continues on the next one)

/** ใบสำคัญทั่วไป: the account lines (account, note, debit, credit) with the server's two totals, then the signatures ผู้จัดทำ / ผู้ตรวจ / ผู้อนุมัติ. Nothing is summed here. */
export function JournalVoucherPaper({ model: m }: { model: PaperModel }) {
  const j = m.journal ?? { lines: [], debit: '0.00', credit: '0.00' };
  const pages = Array.from({ length: Math.max(1, Math.ceil(j.lines.length / PER_PAGE)) }, (_, p) => j.lines.slice(p * PER_PAGE, (p + 1) * PER_PAGE));
  const s = m.seller;
  return (
    <Paper ready>
      <div className="paper-stack">
        {pages.map((rows, p) => (
          <PaperPage key={p} stamp={m.voidMark}>
            <header>
              <div className="paper-hd">
                <div className="paper-seller">
                  <LogoMark m={m} />
                  <div>
                    <h2>{s.name}</h2>
                    {s.nameEn ? <div className="paper-name-en">{s.nameEn}</div> : null}
                    <p>{s.address}</p>
                    {s.phone ? <p>{L.phone} {s.phone}</p> : null}
                    <p className="paper-tin">{[s.taxId ? `${L.taxId} ${s.taxId}` : '', s.branchLabel ?? ''].filter(Boolean).join(' · ')}</p>
                  </div>
                </div>
                <div className="paper-title">
                  <h2>{m.titleTh}</h2>
                  <span className="paper-en">{m.titleEn}</span>
                  <span className="paper-pill">{m.copyLabel}</span>
                </div>
              </div>
              <div className="paper-parties">
                <section className="paper-box paper-docbox">
                  <dl>
                    <dt>{L.no}</dt><dd className="paper-docno">{m.number}</dd>
                    <dt>{L.date}</dt><dd>{formatDateBE(m.documentDate)}</dd>
                    {m.reference ? <><dt>{L.ref}</dt><dd>{m.reference}</dd></> : null}
                  </dl>
                </section>
              </div>
            </header>
            <div className="paper-items">
              <table className="paper-lines">
                <colgroup><col style={{ width: 44 }} /><col style={{ width: 220 }} /><col /><col style={{ width: 112 }} /><col style={{ width: 112 }} /></colgroup>
                <thead><tr><th className="c">{L.seq}</th><th>{L.account}</th><th>{L.desc}</th><th className="r">{L.debit}</th><th className="r">{L.credit}</th></tr></thead>
                <tbody>
                  {rows.map((l) => (
                    <tr key={l.no}>
                      <td className="c paper-no">{l.no}</td>
                      <td className="paper-name"><span className="tabular-nums">{l.accountCode}</span> {l.accountName}</td>
                      <td>{l.description}</td>
                      <td className="r paper-amt">{l.debit !== '0.00' ? formatMoney(l.debit) : ''}</td>
                      <td className="r paper-amt">{l.credit !== '0.00' ? formatMoney(l.credit) : ''}</td>
                    </tr>
                  ))}
                  {p === pages.length - 1 ? <tr><td /><td /><td className="r"><b>{L.total}</b></td><td className="r paper-amt"><b>{formatMoney(j.debit)}</b></td><td className="r paper-amt"><b>{formatMoney(j.credit)}</b></td></tr> : null}
                </tbody>
              </table>
            </div>
            {p === pages.length - 1 ? (
              <footer className="paper-ft">
                <div className="paper-sum">
                  <div>
                    <div className="paper-words"><div className="l">{L.words}</div><div className="v">({m.totals.amountInWords})</div></div>
                    {m.notes ? <div className="paper-notes"><h4>{L.notes}</h4><p>{m.notes}</p></div> : null}
                  </div>
                  <div />
                </div>
                <div className="paper-sign">
                  <SigBlocks m={m} date={L.date} />
                </div>
              </footer>
            ) : null}
            <div className="paper-pg"><span>{L.no} {m.number} · {s.name}</span><span>{`หน้า ${p + 1}/${pages.length}`}</span></div>
          </PaperPage>
        ))}
      </div>
    </Paper>
  );
}
