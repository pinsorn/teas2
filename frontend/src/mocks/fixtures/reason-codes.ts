import type { DocHeader } from '@/domain/types';

/** `[SP-R]` CN / DN reason wording (D-35): printed in Thai, never as a raw code. OTHER prints the text the user typed. */
export const REASON_TH: Record<string, string> = {
  RETURN: 'รับคืนสินค้า / สินค้าชำรุด',
  PRICE_REDUCTION: 'ลดราคาสินค้าหรือบริการ',
  DISCOUNT: 'ส่วนลดที่ให้ภายหลัง',
  SERVICE_SHORT: 'บริการไม่ครบตามสัญญา',
  OTHER: 'อื่น ๆ',
  PRICE_INCREASE: 'เพิ่มราคาสินค้าหรือบริการ',
  QTY_EXCESS: 'ส่งสินค้าเกินจำนวน',
};

/** The reason of a note as the paper prints it. */
export const reasonTh = (header: Pick<DocHeader, 'reasonCode' | 'reasonText'>): string => {
  const text = header.reasonText?.trim();
  const label = header.reasonCode ? REASON_TH[header.reasonCode] ?? '' : '';
  return header.reasonCode === 'OTHER' ? text || label : text ? `${label} (${text})` : label;
};
