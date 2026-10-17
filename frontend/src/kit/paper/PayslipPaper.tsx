'use client';
import { useSearchParams } from 'next/navigation';
import type { PaperModel, PayslipPaperModel } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';
import { Paper } from './Paper';

// A payslip is an internal record: its labels stay Thai whatever the UI language is, so they are not in messages. Every figure is the model's (the server's frozen slip); nothing is summed or derived here.
const L = { phone: 'โทร', taxId: 'เลขประจำตัวผู้เสียภาษี', no: 'เลขที่รอบ', payDate: 'วันที่จ่าย', period: 'งวดค่าจ้าง', employee: 'พนักงาน', nid: 'เลขประจำตัวประชาชน', income: 'รายได้', deductions: 'รายการหัก', gross: 'รวมรายได้', totalDed: 'รวมรายการหัก',
  net: 'เงินได้สุทธิ', words: 'จำนวนเงินตัวอักษร', ssoEr: 'ประกันสังคมส่วนนายจ้าง (ไม่หักจากพนักงาน)', ytd: 'ยอดสะสมตั้งแต่ต้นปี', ytdIncome: 'รายได้สะสม', ytdPit: 'ภาษีสะสม', ytdSso: 'ประกันสังคมสะสม', baht: 'บาท' };
const mark = (name: string) => name.replace(/^(บริษัท|ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|หจก\.|บจก\.)\s*/, '').charAt(0);

/** A5 on paper (a named page: the rest of the app prints A4), one sheet per slip. On a narrow screen the sheets scroll sideways inside their own container. */
const CSS = `
@page payslip { size: A5; margin: 0; }
.payslip-stack { display: grid; justify-content: center; gap: 20px; padding: 20px 12px; }
.paper-root .payslip-page { width: 559px; height: 794px; padding: 30px 34px; font-size: 8.4pt; line-height: 1.35; page: payslip; }
.payslip-page header { display: flex; justify-content: space-between; gap: 12px; padding-bottom: 8px; border-bottom: 2pt solid var(--paper-accent); }
.payslip-page .ps-seller { display: flex; gap: 10px; }
.payslip-page .ps-logo { flex: none; width: 40px; height: 40px; border-radius: 50%; border: 1.6pt solid var(--paper-accent); display: grid; place-items: center; font-weight: 700; font-size: 17pt; color: var(--paper-accent-text); line-height: 1; }
.payslip-page h2 { font-size: 10.5pt; font-weight: 700; line-height: 1.25; }
.payslip-page .ps-title { text-align: right; flex: none; }
.payslip-page .ps-title h2 { font-size: 15pt; color: var(--paper-accent); }
.payslip-page .ps-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
.payslip-page .ps-box { border: 0.75pt solid var(--paper-rule); border-radius: 6px; padding: 6px 9px; }
.payslip-page .ps-box dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin: 0; }
.payslip-page .ps-box dt { color: var(--paper-muted); }
.payslip-page .ps-box dd { margin: 0; text-align: right; font-weight: 600; }
.payslip-page .ps-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; flex: 1; align-content: start; }
.payslip-page table { width: 100%; border-collapse: collapse; }
.payslip-page th { text-align: left; font-weight: 600; color: var(--paper-accent-text); background: var(--paper-tint); padding: 4px 6px; border-bottom: 1.2pt solid var(--paper-accent); }
.payslip-page td { padding: 3px 6px; border-bottom: 0.5pt solid var(--paper-hair); vertical-align: top; }
.payslip-page td.r, .payslip-page th.r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.payslip-page tr.ps-sum td { font-weight: 700; border-top: 0.75pt solid var(--paper-ink); border-bottom: 0; }
.payslip-page .ps-net { margin-top: 8px; background: var(--paper-accent); color: var(--paper-accent-contrast); border-radius: 6px; padding: 7px 10px; display: flex; justify-content: space-between; align-items: baseline; }
.payslip-page .ps-net b { font-size: 14pt; }
.payslip-page .ps-words { margin-top: 5px; background: var(--paper-tint); border-radius: 6px; padding: 5px 9px; font-weight: 600; color: var(--paper-accent-text); }
.payslip-page .ps-ytd { margin-top: 8px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.payslip-page .ps-ytd div { border: 0.75pt solid var(--paper-hair); border-radius: 6px; padding: 4px 8px; }
.payslip-page .ps-ytd span { display: block; color: var(--paper-muted); font-size: 7.6pt; }
.payslip-page .ps-ytd b { font-variant-numeric: tabular-nums; }
.payslip-page .ps-note { margin-top: 8px; font-size: 7.6pt; color: var(--paper-muted); }
.payslip-page .ps-sign { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 18px; }
.payslip-page .ps-sig { text-align: center; }
.payslip-page .ps-sig .line { border-bottom: 0.75pt solid var(--paper-ink); height: 22px; }
.payslip-page .ps-sig .who { margin-top: 3px; font-weight: 600; }
@media print {
  .payslip-stack { display: block; padding: 0; background: none; }
  .paper-root .payslip-page { height: 793px; box-shadow: none; break-after: page; break-inside: avoid; }
  .paper-root .payslip-page:last-child { break-after: auto; }
}
`;

function Slip({ m, s }: { m: PaperModel; s: PayslipPaperModel }) {
  const co = m.seller;
  return (
    <section className="paper-page payslip-page" data-paper-page data-payslip={s.employeeId}>
      <header>
        <div className="ps-seller">
          <div className="ps-logo" aria-hidden="true">{mark(co.name)}</div>
          <div>
            <h2>{co.name}</h2>
            <p>{co.address}</p>
            <p>{[co.phone ? `${L.phone} ${co.phone}` : '', co.taxId ? `${L.taxId} ${co.taxId}` : '', co.branchLabel ?? ''].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
        <div className="ps-title"><h2>{m.titleTh}</h2><span className="paper-en">{m.titleEn}</span><br /><span className="paper-pill">{m.copyLabel}</span></div>
      </header>
      <div className="ps-meta">
        <section className="ps-box" aria-label={L.employee}>
          <dl>
            <dt>{L.employee}</dt><dd>{s.name}</dd>
            {s.nationalId ? <><dt>{L.nid}</dt><dd className="tabular-nums">{s.nationalId}</dd></> : null}
          </dl>
        </section>
        <section className="ps-box">
          <dl>
            <dt>{L.no}</dt><dd>{m.number}</dd>
            <dt>{L.period}</dt><dd>{s.period}</dd>
            <dt>{L.payDate}</dt><dd>{formatDateBE(s.payDate)}</dd>
          </dl>
        </section>
      </div>
      <div className="ps-cols">
        <table>
          <thead><tr><th>{L.income}</th><th className="r">{L.baht}</th></tr></thead>
          <tbody>
            {s.income.map((x) => <tr key={x.label}><td>{x.label}</td><td className="r">{formatMoney(x.amount)}</td></tr>)}
            <tr className="ps-sum"><td>{L.gross}</td><td className="r">{formatMoney(s.gross)}</td></tr>
          </tbody>
        </table>
        <table>
          <thead><tr><th>{L.deductions}</th><th className="r">{L.baht}</th></tr></thead>
          <tbody>
            {s.deductions.map((x) => <tr key={x.label}><td>{x.label}</td><td className="r">{formatMoney(x.amount)}</td></tr>)}
            <tr className="ps-sum"><td>{L.totalDed}</td><td className="r">{formatMoney(s.totalDeductions)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="ps-net"><span>{L.net}</span><b className="tabular-nums">{formatMoney(s.net)}</b></div>
      <div className="ps-words"><span>{L.words}: </span>({s.netInWords})</div>
      <div className="ps-ytd" aria-label={L.ytd}>
        <div><span>{L.ytdIncome}</span><b>{formatMoney(s.ytd.income)}</b></div>
        <div><span>{L.ytdPit}</span><b>{formatMoney(s.ytd.pit)}</b></div>
        <div><span>{L.ytdSso}</span><b>{formatMoney(s.ytd.sso)}</b></div>
      </div>
      <p className="ps-note">{L.ssoEr}: {formatMoney(s.ssoEmployer)} · {s.note}</p>
      <div className="ps-sign">{m.signatures.map((x) => <div className="ps-sig" key={x}><div className="line" /><div className="who">{x}</div></div>)}</div>
      {m.voidMark ? <div className="paper-void" data-paper-void><div><b>{m.voidMark.label}</b>{m.voidMark.note ? <span>{m.voidMark.note}</span> : null}</div></div> : null}
    </section>
  );
}

/** Payslips of a run: one A5 slip per employee (`only` = one employee's slip, for the drawer's print). Page break between slips at print. */
export function PayslipPaper({ model: m, only }: { model: PaperModel; only?: string }) {
  const slips = (m.payslips ?? []).filter((s) => !only || s.employeeId === only);
  return (
    <Paper ready>
      <style>{CSS}</style>
      <div className="overflow-x-auto">
        <div className="paper-stack payslip-stack">{slips.map((s) => <Slip key={s.employeeId} m={m} s={s} />)}</div>
      </div>
    </Paper>
  );
}

/** The print route's paper for a run: `?employee=<id>` prints that employee's slip alone. */
export function PayslipPrint({ model }: { model: PaperModel }) {
  return <PayslipPaper model={model} only={useSearchParams().get('employee') ?? undefined} />;
}
