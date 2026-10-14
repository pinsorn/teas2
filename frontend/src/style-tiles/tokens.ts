/** Single source for the numbers shown on the colour sheet. tokens.test.ts checks every hex also exists in tokens-<id>.css. */
export type TileId = 'a' | 'b' | 'c';
export interface Swatch { name: string; label: string; hex: string }
export interface TileSpec {
  id: TileId;
  title: string;
  tagline: string;
  fonts: string;
  radius: string;
  rowHeight: string;
  swatches: Swatch[];
  /** [foreground swatch name, background swatch name, min ratio] */
  pairs: [string, string, number][];
  chips: Record<'draft' | 'issued' | 'partly' | 'settled' | 'overdue' | 'cancelled', [string, string]>;
  focus: string;
  scale: { role: string; size: string; line: string; weight: string; sample: string }[];
}

const SCALE_SAMPLE = 'ใบกำกับภาษีเลขที่ 2026-0042';
const mkScale = (px: number[], w: string[]): TileSpec['scale'] =>
  ['หัวเรื่องหน้า', 'หัวข้อส่วน', 'เนื้อหา', 'ข้อความรอง'].map((role, i) => ({
    role, size: `${px[i]}px`, line: `${Math.round(px[i] * (i === 0 ? 1.3 : 1.55))}px`, weight: w[i], sample: SCALE_SAMPLE,
  }));

export const TILES: TileSpec[] = [
  {
    id: 'a', title: 'A · บัญชีแยกประเภท (Ledger)', tagline: 'กระดาษขาว หมึกเขียวเข้ม เส้นบาง แน่น อ่านเป็นตารางบัญชี',
    fonts: 'IBM Plex Sans Thai (UI) + Sarabun (กระดาษ)', radius: '6px', rowHeight: '36px',
    swatches: [
      { name: 'bg', label: 'พื้นกระดาษ', hex: '#FFFFFF' }, { name: 'sub', label: 'พื้นรอง', hex: '#F4F6F4' },
      { name: 'ink', label: 'หมึก', hex: '#14211B' }, { name: 'muted', label: 'หมึกจาง', hex: '#4A5A52' },
      { name: 'rule', label: 'เส้นบาง', hex: '#D3DAD5' }, { name: 'accent', label: 'เขียวบัญชี', hex: '#0F5B3F' },
      { name: 'soft', label: 'เขียวอ่อน', hex: '#E1F0E8' }, { name: 'input', label: 'ขอบช่องกรอก', hex: '#788880' },
    ],
    pairs: [['ink', 'bg', 4.5], ['ink', 'sub', 4.5], ['muted', 'bg', 4.5], ['muted', 'sub', 4.5], ['bg', 'accent', 4.5], ['accent', 'bg', 4.5],
      ['accent', 'soft', 4.5], ['muted', 'soft', 4.5], ['input', 'bg', 3]],
    chips: { draft: ['#3F4A44', '#E9ECEA'], issued: ['#17497A', '#E1ECF7'], partly: ['#7A4A00', '#FBEBCB'], settled: ['#0B5A3A', '#DDF1E6'],
      overdue: ['#9B1C1C', '#FBE3E1'], cancelled: ['#4A4A4A', '#E6E6E6'] },
    focus: 'เส้นเขียว 2px ห่าง 2px ไม่มีเงา',
    scale: mkScale([22, 16, 14, 12.5], ['600', '600', '400', '400']),
  },
  {
    id: 'b', title: 'B · TEAS ต่อเนื่อง (Continuity)', tagline: 'พีชอุ่นกับหมึกเทาอุ่นของ TEAS 1 ปรับพีชให้เข้มจนตัวอักษรขาวผ่าน AA',
    fonts: 'Noto Sans Thai (UI) + Sarabun (กระดาษ)', radius: '10px', rowHeight: '40px',
    swatches: [
      { name: 'bg', label: 'พื้นหน้า', hex: '#FAF8F5' }, { name: 'surface', label: 'พื้นการ์ด', hex: '#FFFFFF' },
      { name: 'ink', label: 'หมึก', hex: '#1A1816' }, { name: 'muted', label: 'หมึกจาง', hex: '#5F5A54' },
      { name: 'rule', label: 'เส้น', hex: '#D7D1C7' }, { name: 'accent', label: 'พีชเข้ม', hex: '#9E5C34' },
      { name: 'soft', label: 'พีชอ่อน', hex: '#F8E3D0' }, { name: 'accentInk', label: 'พีชตัวอักษร', hex: '#86492A' },
    ],
    pairs: [['ink', 'bg', 4.5], ['ink', 'surface', 4.5], ['muted', 'bg', 4.5], ['muted', 'surface', 4.5], ['surface', 'accent', 4.5],
      ['accent', 'bg', 4.5], ['accentInk', 'soft', 4.5], ['ink', 'soft', 4.5], ['accent', 'surface', 3]],
    chips: { draft: ['#4D4943', '#ECE7DF'], issued: ['#3E5F80', '#E5ECF2'], partly: ['#80580F', '#FBEFD7'], settled: ['#3A6347', '#E6EFE7'],
      overdue: ['#9B3F38', '#FBE4E1'], cancelled: ['#5F5A54', '#E4DFD6'] },
    focus: 'วงแหวนพีช 3px + เส้นขอบพีช ห่าง 2px',
    scale: mkScale([24, 17, 15, 13], ['600', '600', '400', '400']),
  },
  {
    id: 'c', title: 'C · สตูดิโอแยกจอ (Studio)', tagline: 'เทาคราม-อินดิโก ตัวเลขเว้นระยะเท่ากันแบบโมโน แผงลอยด้วยเงา แถวโปร่ง',
    fonts: 'Anuphan (UI) + JetBrains Mono (ตัวเลข) + Sarabun (กระดาษ)', radius: '12px', rowHeight: '48px',
    swatches: [
      { name: 'bg', label: 'พื้นหน้า', hex: '#F3F4F8' }, { name: 'surface', label: 'พื้นแผง', hex: '#FFFFFF' },
      { name: 'ink', label: 'หมึก', hex: '#151A2C' }, { name: 'muted', label: 'หมึกจาง', hex: '#4C5470' },
      { name: 'rule', label: 'เส้น', hex: '#D5D9E6' }, { name: 'accent', label: 'อินดิโก', hex: '#4338CA' },
      { name: 'soft', label: 'อินดิโกอ่อน', hex: '#E6E7FB' }, { name: 'input', label: 'ขอบช่องกรอก', hex: '#7C86A6' },
    ],
    pairs: [['ink', 'bg', 4.5], ['ink', 'surface', 4.5], ['muted', 'bg', 4.5], ['muted', 'surface', 4.5], ['surface', 'accent', 4.5],
      ['accent', 'surface', 4.5], ['accent', 'soft', 4.5], ['input', 'surface', 3], ['accent', 'bg', 3]],
    chips: { draft: ['#454C66', '#E9EBF3'], issued: ['#1D4E9E', '#E0EAFB'], partly: ['#7A4B00', '#FBEBCB'], settled: ['#0D6140', '#DAF1E5'],
      overdue: ['#A11B2E', '#FCE3E6'], cancelled: ['#4B4B55', '#E7E7EC'] },
    focus: 'เส้นอินดิโก 2px + ฮาโลอ่อน 4px',
    scale: mkScale([26, 18, 15, 13], ['600', '600', '400', '400']),
  },
];

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
export const hexOf = (t: TileSpec, name: string) => t.swatches.find((s) => s.name === name)!.hex;
