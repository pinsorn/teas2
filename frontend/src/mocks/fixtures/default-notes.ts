import type { DocType } from '@/domain/types';

/** Company default notes per document type (ST1 will edit them; until then a fixture). A blank new document starts with its type's note; a copy or a conversion keeps the source's. */
export const DEFAULT_NOTES: Partial<Record<DocType, string>> = {
  QT: 'ใบเสนอราคานี้ยืนราคาตามที่ระบุ ราคายังไม่รวมค่าขนส่งนอกพื้นที่',
  SO: 'กำหนดส่งตามที่ตกลง หากมีการเปลี่ยนแปลงจะแจ้งล่วงหน้า',
  IV: 'กรุณาชำระเงินภายในกำหนดและแจ้งหลักฐานการโอนทุกครั้ง',
};
