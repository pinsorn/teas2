'use client';
import { useSearchParams } from 'next/navigation';
import type { PaperModel, PayslipPaperModel } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';
import { Paper } from './Paper';
import { LogoMark, SigBlocks } from './TaxInvoicePaper';

// A payslip is an internal record: its labels stay Thai whatever the UI language is, so they are not in messages. Every figure is the model's (the server's frozen slip); nothing is summed or derived here.
const L = { phone: 'โทร', taxId: 'เลขประจำตัวผู้เสียภาษี', no: 'เลขที่รอบ', payDate: 'วันที่จ่าย', period: 'งวดค่าจ้าง', employee: 'พนักงาน', nid: 'เลขประจำตัวประชาชน', income: 'รายได้', deductions: 'รายการหัก', gross: 'รวมรายได้', totalDed: 'รวมรายการหัก',
  net: 'เงินได้สุทธิ', words: 'จำนวนเงินตัวอักษร', ssoEr: 'ประกันสังคมส่วนนายจ้าง (ไม่หักจากพนักงาน)', ytd: 'ยอดสะสมตั้งแต่ต้นปี', ytdIncome: 'รายได้สะสม', ytdPit: 'ภาษีสะสม', ytdSso: 'ประกันสังคมสะสม', baht: 'บาท' };


function Slip({ m, s }: { m: PaperModel; s: PayslipPaperModel }) {
  const co = m.seller;
  return (
    <section className="paper-page payslip-page" data-paper-page data-payslip={s.employeeId}>
      <header>
        <div className="ps-seller">
          <LogoMark m={m} height="40px" cls="ps-logo" />
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
      <div className="ps-sign"><SigBlocks m={m} box="ps-sig" /></div>
      {m.voidMark ? <div className="paper-void" data-paper-void><div><b>{m.voidMark.label}</b>{m.voidMark.note ? <span>{m.voidMark.note}</span> : null}</div></div> : null}
    </section>
  );
}

/** Payslips of a run: one A5 slip per employee (`only` = one employee's slip, for the drawer's print). Page break between slips at print. */
export function PayslipPaper({ model: m, only }: { model: PaperModel; only?: string }) {
  const slips = (m.payslips ?? []).filter((s) => !only || s.employeeId === only);
  return (
    <Paper ready>
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
