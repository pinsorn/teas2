'use client';
import type { PaperModel } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';
import { Paper, PaperPage } from './Paper';

type Cert = NonNullable<PaperModel['certificate']>;

// TX4: the 50 ทวิ is RECREATED from the Revenue Department's approved form (https://www.rd.go.th/fileadmin/tax_pdf/withhold/approve_wh3_081156.pdf, แบบ หนังสือรับรองการหักภาษี ณ ที่จ่าย ตามมาตรา 50 ทวิ):
// its boxes, rows and captions, laid out in React and filled from the WT's stored snapshot. The PDF itself is never shipped. Thai legal form (D-21): the labels stay Thai whatever the UI language is.
const COPIES = ['ฉบับที่ 1 (สำหรับผู้ถูกหักภาษี ณ ที่จ่าย ใช้แนบพร้อมกับแบบแสดงรายการภาษี)', 'ฉบับที่ 2 (สำหรับผู้ถูกหักภาษี ณ ที่จ่าย เก็บไว้เป็นหลักฐาน)'];
const FORMS: { key: Cert['form'] | 'x'; label: string }[] = [
  { key: 'x', label: '(1) ภ.ง.ด.1ก' }, { key: 'x', label: '(2) ภ.ง.ด.1ก พิเศษ' }, { key: 'PND2', label: '(3) ภ.ง.ด.2' }, { key: 'PND3', label: '(4) ภ.ง.ด.3' },
  { key: 'x', label: '(5) ภ.ง.ด.2ก' }, { key: 'x', label: '(6) ภ.ง.ด.3ก' }, { key: 'PND53', label: '(7) ภ.ง.ด.53' }, { key: 'PND54', label: 'ภ.ง.ด.54 (จ่ายต่างประเทศ)' }, // 54 is not on the RD form; it is kept so a foreign payment is not printed with no return ticked
];
const CONDITIONS: { key: Cert['condition'] | 'x'; label: string }[] = [
  { key: 'withhold', label: '(1) หัก ณ ที่จ่าย' }, { key: 'forever', label: '(2) ออกให้ตลอดไป' }, { key: 'once', label: '(3) ออกให้ครั้งเดียว' }, { key: 'x', label: '(4) อื่น ๆ (ระบุ)' },
];
/** The income rows of the form. A certificate carries one income type: see `rowOfIncome` for the row it fills. */
const ROWS: { key: string; label: string; ind?: number }[] = [
  { key: '1', label: '1. เงินเดือน ค่าจ้าง เบี้ยเลี้ยง โบนัส ฯลฯ ตามมาตรา 40 (1)' }, { key: '2', label: '2. ค่าธรรมเนียม ค่านายหน้า ฯลฯ ตามมาตรา 40 (2)' }, { key: '3', label: '3. ค่าแห่งลิขสิทธิ์ ฯลฯ ตามมาตรา 40 (3)' },
  { key: '4a', label: '4. (ก) ดอกเบี้ย ฯลฯ ตามมาตรา 40 (4) (ก)' }, { key: '4b', label: '(ข) เงินปันผล เงินส่วนแบ่งกำไร ฯลฯ ตามมาตรา 40 (4) (ข)', ind: 1 },
  { key: 'b1', label: '(1) กรณีผู้ได้รับเงินปันผลได้รับเครดิตภาษี โดยจ่ายจากกำไรสุทธิของกิจการที่ต้องเสียภาษีเงินได้นิติบุคคลในอัตราดังนี้', ind: 2 },
  { key: 'b11', label: '(1.1) อัตราร้อยละ 30 ของกำไรสุทธิ', ind: 3 }, { key: 'b12', label: '(1.2) อัตราร้อยละ 25 ของกำไรสุทธิ', ind: 3 }, { key: 'b13', label: '(1.3) อัตราร้อยละ 20 ของกำไรสุทธิ', ind: 3 }, { key: 'b14', label: '(1.4) อัตราอื่น ๆ (ระบุ)............ ของกำไรสุทธิ', ind: 3 },
  { key: 'b2', label: '(2) กรณีผู้ได้รับเงินปันผลไม่ได้รับเครดิตภาษี เนื่องจากจ่ายจาก', ind: 2 },
  { key: 'b21', label: '(2.1) กำไรสุทธิของกิจการที่ได้รับยกเว้นภาษีเงินได้นิติบุคคล', ind: 3 }, { key: 'b22', label: '(2.2) เงินปันผลหรือเงินส่วนแบ่งของกำไรที่ได้รับยกเว้นไม่ต้องนำมารวมคำนวณเป็นรายได้เพื่อเสียภาษีเงินได้นิติบุคคล', ind: 3 },
  { key: 'b23', label: '(2.3) กำไรสุทธิส่วนที่ได้หักผลขาดทุนสุทธิยกมาไม่เกิน 5 ปี ก่อนรอบระยะเวลาบัญชีปีปัจจุบัน', ind: 3 }, { key: 'b24', label: '(2.4) กำไรที่รับรู้ทางบัญชีโดยวิธีส่วนได้เสีย (equity method)', ind: 3 }, { key: 'b25', label: '(2.5) อื่น ๆ (ระบุ)............', ind: 3 },
  { key: '5', label: '5. การจ่ายเงินได้ที่ต้องหักภาษี ณ ที่จ่าย ตามคำสั่งกรมสรรพากรที่ออกตามมาตรา 3 เตรส เช่น รางวัล ส่วนลดหรือประโยชน์ใด ๆ เนื่องจากการส่งเสริมการขาย รางวัลในการประกวด การแข่งขัน การชิงโชค ค่าแสดงของนักแสดงสาธารณะ ค่าจ้างทำของ ค่าโฆษณา ค่าเช่า ค่าขนส่ง ค่าบริการ ค่าเบี้ยประกันวินาศภัย ฯลฯ' },
  { key: '6', label: '6. อื่น ๆ (ระบุ)' },
];
export const rowOfIncome = (incomeType: string, form: Cert['form']): string =>
  incomeType.startsWith('40(1)') ? '1' : incomeType.startsWith('40(2)') ? '2' : incomeType.startsWith('40(3)') ? '3' : incomeType.startsWith('40(4)ก') ? '4a' : incomeType.startsWith('40(4)ข') ? '4b'
    : form !== 'PND54' && /^40\([5-8]\)/.test(incomeType) ? '5' : '6'; // a domestic 40(5)-(8) payment is withheld under the ม.3 เตรส orders (row 5); a foreign one (ภ.ง.ด.54, ม.70) and anything else is row 6
const TIN_GROUPS = [1, 4, 5, 2, 1];

function Check({ on }: { on: boolean }) {
  return <span className="paper-check" data-checked={on ? 'true' : 'false'} aria-hidden="true">{on ? '✓' : ''}</span>;
}
/** The 13-digit number in the form's boxes (1-4-5-2-1). A number that is not 13 digits is printed as it is. */
function Tin({ id }: { id?: string }) {
  const d = (id ?? '').replace(/\D/g, '');
  if (d.length !== 13) return <span className="paper-rd-tin" data-field="tin">{id ?? ''}</span>;
  const groups = TIN_GROUPS.map((n, g) => d.slice(TIN_GROUPS.slice(0, g).reduce((x, y) => x + y, 0), TIN_GROUPS.slice(0, g + 1).reduce((x, y) => x + y, 0)));
  return <span className="paper-rd-tin" data-field="tin" aria-label={d}>{groups.map((s, g) => <span key={g} className="paper-rd-tin-g">{[...s].map((c, k) => <i key={k}>{c}</i>)}</span>)}</span>;
}
function Party({ title, name, taxId, address, kind }: { title: string; name: string; taxId?: string; address: string; kind: 'payer' | 'payee' }) {
  return (
    <section className="paper-rd-party" aria-label={title} data-field={kind}>
      <div className="paper-rd-row"><b>{title}</b><span className="paper-rd-tinl">เลขประจำตัวผู้เสียภาษีอากร (13 หลัก)*</span><Tin id={taxId} /></div>
      <div className="paper-rd-row"><b>ชื่อ</b><span className="paper-rd-fill">{name}</span></div>
      <div className="paper-rd-row"><b>ที่อยู่</b><span className="paper-rd-fill">{address}</span></div>
    </section>
  );
}

function Sheet({ m, copy }: { m: PaperModel; copy: number }) {
  const c = m.certificate!, row = rowOfIncome(c.incomeType, c.form);
  return (
    <PaperPage stamp={m.voidMark}>
      <div className="paper-rd-copy">{COPIES[copy]}</div>
      <div className="paper-rd-box paper-rd-head">
        <div className="paper-rd-no"><span>เล่มที่ <u /></span><span>เลขที่ <b data-field="number">{m.number}</b></span></div>
        <h2>{m.titleTh}</h2><p>ตามมาตรา 50 ทวิ แห่งประมวลรัษฎากร</p>
      </div>
      <Party kind="payer" title="ผู้มีหน้าที่หักภาษี ณ ที่จ่าย :" name={m.seller.name} taxId={m.seller.taxId} address={m.seller.address} />
      <Party kind="payee" title="ผู้ถูกหักภาษี ณ ที่จ่าย :" name={m.buyer.name} taxId={m.buyer.taxId} address={m.buyer.address} />
      <div className="paper-rd-seq" data-field="sequence">
        <span>ลำดับที่ <i className="paper-rd-seqbox">{c.sequence ?? ''}</i> ในแบบ</span>
        <ul aria-label="แบบแสดงรายการภาษี">{FORMS.map((f) => <li key={f.label}><Check on={f.key === c.form} /> {f.label}</li>)}</ul>
      </div>
      <table className="paper-rd-table">
        <colgroup><col /><col style={{ width: 92 }} /><col style={{ width: 96 }} /><col style={{ width: 88 }} /></colgroup>
        <thead><tr><th>ประเภทเงินได้พึงประเมินที่จ่าย</th><th>วัน เดือน หรือปีภาษี ที่จ่าย</th><th>จำนวนเงินที่จ่าย</th><th>ภาษีที่หักและนำส่งไว้</th></tr></thead>
        <tbody>
          {ROWS.map((r) => {
            const on = r.key === row;
            return (
              <tr key={r.key} data-row={r.key} {...(on ? { 'data-field': 'income-row' } : {})} className={r.ind ? `paper-rd-ind${r.ind}` : undefined}>
                <td>{r.label}{on && (r.key === '5' || r.key === '6') ? ` ${c.incomeLabel}` : ''}</td>
                <td className="c">{on ? formatDateBE(c.paidOn) : ''}</td><td className="r">{on ? formatMoney(c.income) : ''}</td><td className="r">{on ? formatMoney(c.tax) : ''}</td>
              </tr>
            );
          })}
          <tr className="paper-rd-total"><td colSpan={2}>รวมเงินที่จ่ายและภาษีที่หักนำส่ง</td><td className="r">{formatMoney(c.income)}</td><td className="r" data-field="tax-total">{formatMoney(c.tax)}</td></tr>
        </tbody>
      </table>
      <div className="paper-rd-words"><b>รวมเงินภาษีที่หักนำส่ง (ตัวอักษร)</b><span>({c.taxInWords})</span></div>
      <div className="paper-rd-box paper-rd-funds">เงินที่จ่ายเข้า กบข./กสจ./กองทุนสงเคราะห์ครูโรงเรียนเอกชน........................บาท กองทุนประกันสังคม........................บาท กองทุนสำรองเลี้ยงชีพ........................บาท</div>
      <div className="paper-rd-box paper-rd-cond"><b>ผู้จ่ายเงิน</b>{CONDITIONS.map((x) => <span key={x.label}><Check on={x.key === c.condition} /> {x.label}</span>)}</div>
      <div className="paper-rd-foot">
        <div className="paper-rd-box paper-rd-warn"><b>คำเตือน</b> ผู้มีหน้าที่ออกหนังสือรับรองการหักภาษี ณ ที่จ่าย ฝ่าฝืนไม่ปฏิบัติตามมาตรา 50 ทวิ แห่งประมวลรัษฎากร ต้องรับโทษทางอาญาตามมาตรา 35 แห่งประมวลรัษฎากร</div>
        <div className="paper-rd-box paper-rd-sign">
          <p>ขอรับรองว่าข้อความและตัวเลขดังกล่าวข้างต้นถูกต้องตรงกับความจริงทุกประการ</p>
          <div className="paper-rd-signrow"><div><div className="paper-rd-sigline">ลงชื่อ ................................................ ผู้จ่ายเงิน</div><div className="paper-rd-date" data-field="issued">{formatDateBE(m.documentDate)}<br />(วัน เดือน ปี ที่ออกหนังสือรับรองฯ)</div></div><div className="paper-rd-seal">ประทับตรา<br />นิติบุคคล<br />(ถ้ามี)</div></div>
        </div>
      </div>
      <p className="paper-rd-note">หมายเหตุ เลขประจำตัวผู้เสียภาษีอากร (13 หลัก)* หมายถึง 1. กรณีบุคคลธรรมดา ให้ใช้เลขประจำตัวประชาชนของกรมการปกครอง 2. กรณีนิติบุคคล ให้ใช้เลขทะเบียนนิติบุคคลของกรมพัฒนาธุรกิจการค้า 3. กรณีอื่น ๆ นอกเหนือจาก 1. และ 2. ให้ใช้เลขประจำตัวผู้เสียภาษีอากร (13 หลัก) ของกรมสรรพากร</p>
    </PaperPage>
  );
}

/** WT (50 ทวิ, D-21): payer = the company (the paper freezes at the first print, I7), payee = the voucher's stored party, the return ticked, the income row with date / amount / tax, the total in words from the server, the payer's condition, the date of issue,
 *  and TWO copies (ฉบับที่ 1 / 2) on one print. The "ลำดับที่" box is `[SP-R]` (the line number in the return is not known when the certificate is issued) and stays empty; the book number (เล่มที่) has no counterpart in TEAS numbering (WT-YYYYMM-NNNN) and stays blank.
 *  The paper is the server's frozen snapshot (I7). */
export function WhtCertificatePaper({ model }: { model: PaperModel; /** Tests only; the certificate is one fixed sheet, nothing is measured. */ measure?: (rowIndex: number) => number }) {
  if (!model.certificate) return null;
  return (
    <Paper ready>
      <div className="paper-stack paper-rd"><Sheet m={model} copy={0} /><Sheet m={model} copy={1} /></div>
    </Paper>
  );
}
