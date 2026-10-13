import type { Money, Qty } from '@/domain/types';

export function toSatang(m: Money): number {
  if (!/^-?\d+(\.\d{1,2})?$/.test(m)) throw new Error(`bad money: ${m}`);
  const neg = m.startsWith('-');
  const [i, f = ''] = m.replace('-', '').split('.');
  const v = Number(i) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -v : v;
}

export function fromSatang(s: number): Money {
  const neg = s < 0;
  const a = Math.abs(s);
  return `${neg ? '-' : ''}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

export function divRoundHalfAway(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n - q * d;
  const abs = (x: bigint) => (x < 0n ? -x : x);
  if (abs(r) * 2n >= abs(d)) return q + ((n < 0n) !== (d < 0n) ? -1n : 1n);
  return q;
}

export function mulQtyPrice(qty: Qty, priceSatang: number): bigint {
  if (!/^\d+(\.\d{1,4})?$/.test(qty)) throw new Error(`bad qty: ${qty}`);
  const [i, f = ''] = qty.split('.');
  const scaled = BigInt(i + (f + '0000').slice(0, 4)); // qty x 10^4
  return divRoundHalfAway(scaled * BigInt(priceSatang), 10000n);
}
