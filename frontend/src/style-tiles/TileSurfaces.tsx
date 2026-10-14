import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateBE, formatMoney } from "@/lib/format";
import { CHIP_LABEL, type ChipStatus, type Sample } from "./sample";
import { contrast, hexOf, type TileSpec } from "./tokens";

const Chip = ({ status }: { status: ChipStatus }) => (
  <Badge variant="secondary" className="chip" data-status={status}>{CHIP_LABEL[status]}</Badge>
);

function Surface({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-4">
      <h3 id={id} className="tile-h2">{title}</h3>
      {children}
    </section>
  );
}

/** (1) type and colour sheet */
function Sheet({ t }: { t: TileSpec }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="panel space-y-4 p-5">
        <dl className="small grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="muted">ฟอนต์</dt><dd>{t.fonts}</dd>
          <dt className="muted">มุมโค้ง</dt><dd className="num">{t.radius}</dd>
          <dt className="muted">ความสูงแถว</dt><dd className="num">{t.rowHeight}</dd>
          <dt className="muted">โฟกัส</dt><dd>{t.focus}</dd>
        </dl>
        <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
          {t.scale.map((s) => (
            <li key={s.role} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2" style={{ borderColor: "var(--border)" }}>
              <span style={{ fontSize: s.size, lineHeight: s.line, fontWeight: Number(s.weight) }}>{s.sample}</span>
              <span className="small muted num shrink-0">{s.role} · {s.size}/{s.line} · {s.weight}</span>
            </li>
          ))}
        </ul>
        <p className="small muted num">ตัวเลข 1,234,567.89 · ฿60,000.00 · 14 ต.ค. 2569</p>
      </div>
      <div className="panel space-y-4 p-5">
        <ul className="grid grid-cols-4 gap-3">
          {t.swatches.map((s) => (
            <li key={s.name} className="space-y-1">
              <div className="h-10 rounded-md" style={{ background: s.hex, border: "1px solid var(--border)" }} aria-hidden />
              <p className="small leading-tight">{s.label}</p>
              <p className="small muted num leading-tight">{s.hex}</p>
            </li>
          ))}
        </ul>
        <table className="small w-full">
          <caption className="sr-only">อัตราส่วนความต่างสี</caption>
          <thead><tr className="muted"><th scope="col" className="py-1 text-left font-medium">คู่สี</th><th scope="col" className="py-1 text-right font-medium">อัตราส่วน</th></tr></thead>
          <tbody>
            {t.pairs.map(([f, b, min]) => {
              const r = contrast(hexOf(t, f), hexOf(t, b));
              return (
                <tr key={`${f}-${b}-${min}`}>
                  <td className="py-0.5">{f} / {b}{min === 3 ? " (ส่วนประกอบ UI)" : ""}</td>
                  <td className="num py-0.5 text-right">{r.toFixed(2)} : 1 · ผ่าน {min === 3 ? "3:1" : "AA"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <ul className="flex flex-wrap gap-2">
          {(Object.keys(t.chips) as ChipStatus[]).map((k) => <li key={k}><Chip status={k} /></li>)}
        </ul>
      </div>
    </div>
  );
}

/** (2) tax-invoice list */
function InvoiceList({ id, s }: { id: string; s: Sample }) {
  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <Label htmlFor={`${id}-q`} className="sr-only">ค้นหาใบกำกับภาษี</Label>
        <Input id={`${id}-q`} className="max-w-72" placeholder="ค้นหาเลขที่หรือชื่อลูกค้า" />
        <Button variant="outline">ทุกสถานะ</Button>
        <Button variant="outline">เกินกำหนดชำระ</Button>
        <span className="flex-1" />
        <Button><Plus aria-hidden /> สร้างใบกำกับภาษี</Button>
      </div>
      <Table className="tile-table">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="w-10"><Checkbox aria-label="เลือกทั้งหมด" /></TableHead>
            <TableHead scope="col">เลขที่</TableHead><TableHead scope="col">ลูกค้า</TableHead>
            <TableHead scope="col">วันที่</TableHead><TableHead scope="col">ครบกำหนด</TableHead>
            <TableHead scope="col">สถานะ</TableHead>
            <TableHead scope="col" className="r">ยอดรวม (บาท)</TableHead><TableHead scope="col" className="r">ค้างชำระ (บาท)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.rows.map((r) => (
            <TableRow key={r.id} className="hover:bg-transparent">
              <TableCell><Checkbox aria-label={`เลือก ${r.number}`} /></TableCell>
              <TableCell className="num">{r.number}</TableCell>
              <TableCell className="max-w-64 truncate">{r.party}</TableCell>
              <TableCell className="num">{formatDateBE(r.date)}</TableCell>
              <TableCell className="num">{r.due ? formatDateBE(r.due) : "-"}</TableCell>
              <TableCell><Chip status={r.status} /></TableCell>
              <TableCell className="num r">{formatMoney(r.total)}</TableCell>
              <TableCell className="num r font-medium">{formatMoney(r.outstanding)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** (3) new tax invoice editor */
function Editor({ id, s }: { id: string; s: Sample }) {
  const { calc, party, lines } = s;
  const t = calc.totals;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="panel space-y-5 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm muted">ลูกค้า</span>
          <span className="inline-flex items-center gap-3 rounded-full py-1 pr-4 pl-1" style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}>
            <span aria-hidden className="grid size-8 place-items-center rounded-full text-sm font-semibold" style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}>{party.name.replace("บริษัท", "").trim().charAt(0)}</span>
            <span><span className="font-medium">{party.name}</span> <span className="small num">{party.taxId} · สาขา {party.branchCode ?? "00000"}</span></span>
          </span>
          <Button variant="ghost">เปลี่ยนลูกค้า</Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5"><Label htmlFor={`${id}-d`}>วันที่ออก</Label><Input id={`${id}-d`} className="num" defaultValue={formatDateBE(s.date)} /></div>
          <div className="space-y-1.5"><Label htmlFor={`${id}-due`}>ครบกำหนดชำระ</Label><Input id={`${id}-due`} className="num" defaultValue={formatDateBE(s.due)} /></div>
          <div className="space-y-1.5"><Label htmlFor={`${id}-ref`}>เลขที่อ้างอิง</Label><Input id={`${id}-ref`} placeholder="เช่น เลขที่ใบสั่งซื้อ" /></div>
        </div>
        <div role="group" aria-label="รายการสินค้าและบริการ" className="space-y-2">
          <div className="small muted hidden grid-cols-[1fr_70px_120px_70px_130px] gap-2 sm:grid" aria-hidden>
            <span>รายการ</span><span className="text-right">จำนวน</span><span className="text-right">ราคา/หน่วย</span><span className="text-right">ส่วนลด %</span><span className="text-right">มูลค่า (ไม่รวม VAT)</span>
          </div>
          {lines.map((l, i) => (
            <div key={l.id} className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[1fr_70px_120px_70px_130px]">
              <Input aria-label={`รายการที่ ${i + 1}`} defaultValue={l.description} className="col-span-2 sm:col-span-1" />
              <Input aria-label={`จำนวน รายการที่ ${i + 1}`} defaultValue={l.qty} className="num text-right" inputMode="decimal" />
              <Input aria-label={`ราคาต่อหน่วย รายการที่ ${i + 1}`} defaultValue={formatMoney(l.unitPrice)} className="num text-right" inputMode="decimal" />
              <Input aria-label={`ส่วนลดเปอร์เซ็นต์ รายการที่ ${i + 1}`} defaultValue={l.discountPct ?? ""} className="num text-right" inputMode="decimal" />
              <output aria-label={`มูลค่า รายการที่ ${i + 1}`} className="num px-1 text-right font-medium">{formatMoney(calc.lines[i].net)}</output>
            </div>
          ))}
          <Button variant="outline"><Plus aria-hidden /> เพิ่มรายการ</Button>
        </div>
      </div>
      <aside aria-label="สรุปยอด" className="panel h-fit space-y-3 p-5">
        <h4 className="tile-h2">สรุปยอด</h4>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
          <dt className="muted">รวมเป็นเงิน</dt><dd className="num text-right">{formatMoney(t.gross)}</dd>
          <dt className="muted">ส่วนลด</dt><dd className="num text-right">-{formatMoney(t.discount)}</dd>
          <dt className="muted">มูลค่าก่อนภาษี</dt><dd className="num text-right">{formatMoney(t.net)}</dd>
          <dt className="muted">ภาษีมูลค่าเพิ่ม 7%</dt><dd className="num text-right">{formatMoney(t.vat)}</dd>
        </dl>
        <div className="grand flex items-baseline justify-between pt-3">
          <span className="font-semibold">ยอดรวมทั้งสิ้น</span>
          <span className="num text-xl font-semibold">฿{formatMoney(t.total)}</span>
        </div>
        <p className="small muted">({t.amountInWords})</p>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button variant="outline">บันทึกร่าง</Button>
          <Button>ออกใบกำกับภาษี</Button>
        </div>
      </aside>
    </div>
  );
}

/** (4) A4 tax-invoice paper (static; Sarabun; identical on every tile) */
function Paper({ s }: { s: Sample }) {
  const { company, party, calc, lines } = s;
  const t = calc.totals;
  return (
    <div className="overflow-x-auto py-2">
      <article className="paper mx-auto" aria-label="ตัวอย่างใบกำกับภาษีบนกระดาษ A4">
        <header className="flex justify-between gap-6">
          <div>
            <p className="text-xl font-semibold">{company.legalNameTh}</p>
            <p>{company.address}</p>
            <p>เลขประจำตัวผู้เสียภาษี {company.taxId} · สำนักงานใหญ่ · โทร {company.phone}</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold">ใบกำกับภาษี</p>
            <p>TAX INVOICE (ต้นฉบับ)</p>
          </div>
        </header>
        <div className="mt-5 grid grid-cols-[1fr_auto] gap-6 border-y py-3" style={{ borderColor: "#555" }}>
          <div>
            <p className="font-semibold">ลูกค้า</p>
            <p>{party.name}</p>
            <p>{party.address}</p>
            <p>เลขประจำตัวผู้เสียภาษี {party.taxId} · สาขา {party.branchCode ?? "00000"}</p>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 text-right">
            <dt>เลขที่</dt><dd>{s.number}</dd>
            <dt>วันที่</dt><dd>{formatDateBE(s.date)}</dd>
            <dt>ครบกำหนด</dt><dd>{formatDateBE(s.due)}</dd>
          </dl>
        </div>
        <table className="mt-5">
          <thead>
            <tr><th scope="col" style={{ width: 40 }}>ที่</th><th scope="col" className="text-left">รายการ</th><th scope="col">จำนวน</th><th scope="col">หน่วย</th><th scope="col">ราคา/หน่วย</th><th scope="col">ส่วนลด</th><th scope="col">จำนวนเงิน</th></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id}>
                <td className="text-center">{i + 1}</td><td>{l.description}</td><td className="text-right">{l.qty}</td><td className="text-center">{l.unit}</td>
                <td className="text-right">{formatMoney(l.unitPrice)}</td><td className="text-right">{l.discountPct ? `${l.discountPct}%` : "-"}</td>
                <td className="text-right">{formatMoney(calc.lines[i].net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-4 ml-auto w-72">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4">
            <dt>รวมเป็นเงิน</dt><dd className="text-right">{formatMoney(t.gross)}</dd>
            <dt>ส่วนลด</dt><dd className="text-right">{formatMoney(t.discount)}</dd>
            <dt>มูลค่าก่อนภาษี</dt><dd className="text-right">{formatMoney(t.net)}</dd>
            <dt>ภาษีมูลค่าเพิ่ม 7%</dt><dd className="text-right">{formatMoney(t.vat)}</dd>
            <dt className="mt-1 border-t pt-1 font-semibold" style={{ borderColor: "#111" }}>ยอดรวมทั้งสิ้น</dt>
            <dd className="mt-1 border-t pt-1 text-right font-semibold" style={{ borderColor: "#111" }}>{formatMoney(t.total)}</dd>
          </dl>
        </div>
        <p className="mt-3">({t.amountInWords})</p>
        <div className="mt-24 grid grid-cols-2 gap-16 text-center">
          <p className="border-t pt-1" style={{ borderColor: "#555" }}>ผู้รับสินค้า / บริการ</p>
          <p className="border-t pt-1" style={{ borderColor: "#555" }}>ผู้มีอำนาจลงนาม</p>
        </div>
      </article>
    </div>
  );
}

export function TileSurfaces({ t, s }: { t: TileSpec; s: Sample }) {
  const id = t.id;
  return (
    <div data-tile={id} id={id} className="min-h-screen pb-16">
      <div className="tile-band">
        <div className="mx-auto max-w-[1180px] px-6 py-5">
          <h2 className="tile-h1">{t.title}</h2>
          <p className="small mt-1 opacity-100">{t.tagline}</p>
        </div>
      </div>
      <div className="mx-auto max-w-[1180px] space-y-10 px-6 pt-8">
        <Surface id={`${id}-s1`} title="ตัวอักษรและสี"><Sheet t={t} /></Surface>
        <Surface id={`${id}-s2`} title="รายการใบกำกับภาษี"><InvoiceList id={id} s={s} /></Surface>
        <Surface id={`${id}-s3`} title="สร้างใบกำกับภาษี"><Editor id={id} s={s} /></Surface>
        <Surface id={`${id}-s4`} title="ตัวอย่างกระดาษ A4"><Paper s={s} /></Surface>
      </div>
    </div>
  );
}
