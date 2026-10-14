import { toSatang } from './money';

const DIGIT = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const POS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

function groupText(g: number, hasHigher: boolean): string {
  const s = String(g);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]);
    const p = s.length - 1 - i;
    if (d === 0) continue;
    if (p === 1) out += d === 1 ? 'สิบ' : d === 2 ? 'ยี่สิบ' : DIGIT[d] + 'สิบ';
    else if (p === 0 && d === 1 && (s.length > 1 || hasHigher)) out += 'เอ็ด';
    else out += DIGIT[d] + POS[p];
  }
  return out;
}

export function integerText(n: number): string {
  if (n === 0) return 'ศูนย์';
  const groups: number[] = [];
  for (let r = n; r > 0; r = Math.floor(r / 1_000_000)) groups.unshift(r % 1_000_000);
  return groups.map((g, i) => (g ? groupText(g, i > 0) : '') + (i < groups.length - 1 ? 'ล้าน' : '')).join('');
}

export function bahtText(amount: string): string {
  const s = toSatang(amount);
  const a = Math.abs(s);
  const baht = Math.trunc(a / 100);
  const satang = a % 100;
  let out = baht > 0 ? integerText(baht) + 'บาท' : '';
  out += satang === 0 ? (baht === 0 ? 'ศูนย์บาท' : '') + 'ถ้วน' : integerText(satang) + 'สตางค์';
  return (s < 0 ? 'ลบ' : '') + out;
}
