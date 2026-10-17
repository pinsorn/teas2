# R-NN: Official DBD statement lines (NPAE company) and ภ.ง.ด.50 boxes for the account mapping

| Status | Spec refs | Effective date checked |
|---|---|---|
| Partial → Ham (P&L format choice; ภ.ง.ด.50 mapping granularity) | SP0 §5.4 (AC2 chart of accounts: `dbdLine`, `pnd50Box`) | 2026-10-17 |

## Question
`frontend/src/records/accounts.ts` holds placeholder `DBD_LINES` (21 keys) and `PND50_BOXES` (5 keys). Labels are in `messages/th.json` under `records.options.dbdLine.*` and `pnd50Box.*`. This note answers three things:
1. What are the official balance-sheet and P&L lines for a non-listed company (NPAE), in print order?
2. Which ภ.ง.ด.50 boxes should an account mapping feed?
3. What should each placeholder key become?

### Primary sources (all opened and read for this note)

| ID | Document | Version / date | URL |
|---|---|---|---|
| S1 | ประกาศกรมพัฒนาธุรกิจการค้า เรื่อง กำหนดรายการย่อที่ต้องมีในงบการเงิน พ.ศ. 2566 + แบบ 1–5 attached | Signed 27 ต.ค. 2566. Published in ราชกิจจานุเบกษา เล่ม 140 ตอนพิเศษ 288 ง, หน้า 24–26, 17 พ.ย. 2566. Applies to periods starting on or after 1 ม.ค. 2567 (ข้อ 9). Repeals the 2554, 2559 (ฉบับที่ 2) and 2562 (ฉบับที่ 3) announcements (ข้อ 1). | https://www.dbd.go.th/storage/law/63ed8d68-5f29-46c3-94e8-669f0cea5438.pdf (156 pp.) |
| S2 | แบบ ภ.ง.ด.50 (form) | "ปี 2568" set, file `050369CIT50.pdf` (PDF modified 2026-04-01) | https://www.rd.go.th/fileadmin/tax_pdf/cit/2568/050369CIT50.pdf |
| S3 | วิธีกรอกแบบ ภ.ง.ด.50 (instructions) | `300169Ins50.pdf`, headed "สำหรับรอบระยะเวลาบัญชีที่เริ่มในหรือหลังวันที่ 1 มกราคม พ.ศ. 2568" | https://www.rd.go.th/fileadmin/tax_pdf/cit/2568/300169Ins50.pdf |
| S4 | RD download page "ปี 2568" that lists S2 and S3 | Last updated 23-06-2026 | https://www.rd.go.th/67858.html |

The secondary pointer that led to S1 was https://flowaccount.com/blog/financial-statement-fsli-changed-2567. It is not used as evidence.

**English labels are UNVERIFIED.** S1 is Thai only. The English labels in the DBD e-Filing XBRL taxonomy (the "DBD XBRL in Excel" v2.0 tool, https://efiling.dbd.go.th/efiling-documents/ExcelXBRLManual.pdf) are only reachable after a juristic-person login. No English column is given below. Getting them needs a DBD e-Filing login.

---

## 1. DBD lines for a บริษัทจำกัด (แบบ 2, NPAE), in print order

Which form applies: S1 ข้อ 2(2) says a บริษัทจำกัด uses แบบ 2. A ห้างหุ้นส่วนจดทะเบียน uses แบบ 1. Its asset and liability lines on pp. 1-1–1-2 match แบบ 2 line for line. I did not read แบบ 1's equity section, so that part is UNVERIFIED. ข้อ 3 says a company that does not qualify as an NPAE uses แบบ 3 instead.

**Which lines are required.** No single line is mandatory. The structure is.
- **ข้อ 7:** "ในกรณีที่ลักษณะหรือสภาพของธุรกิจไม่มีรายการที่ต้องแสดงรายการย่อครบตามแบบ … ให้งดเว้นไม่ต้องแสดงรายการย่อที่ไม่มี". In short, a line the business has nothing for is left out.
- **ข้อ 8:** if a TFRS needs a line the form does not have, the company either follows the standard or groups the item into the nearest form line, and adds detail in the notes.
- So the DBD list is **open**: grouping is allowed. The ภ.ง.ด.50 is **closed**. S3 p.1 says "ห้ามแก้ไขหรือเพิ่มเติมรายการขึ้นใหม่" (no editing or adding lines).

### 1a. งบฐานะการเงิน (S1 แบบ 2 pp. 2-1 – 2-3)

| No. | Official Thai label | Note |
|---|---|---|
| **1** | **สินทรัพย์หมุนเวียน** | |
| 1.1 | เงินสดและรายการเทียบเท่าเงินสด | |
| 1.2 | เงินลงทุนชั่วคราว | |
| 1.3 | ลูกหนี้การค้าและลูกหนี้หมุนเวียนอื่น | |
| 1.4 | มูลค่าของงานส่วนที่เสร็จแต่ยังไม่ถึงกำหนดเรียกชำระเงิน - หมุนเวียน | Construction contracts |
| 1.5 | เงินให้กู้ยืมระยะสั้น | |
| 1.6 | สินค้าคงเหลือ | |
| 1.7 | สินทรัพย์ภาษีเงินได้ของงวดปัจจุบัน | *2: only when the optional NPAE treatment is used |
| 1.8 | สินทรัพย์ชีวภาพหมุนเวียน | |
| 1.9 | สินทรัพย์หมุนเวียนอื่น | |
| 1.10 | สินทรัพย์ไม่หมุนเวียนที่ถือไว้เพื่อขาย - หมุนเวียน | |
| | รวมสินทรัพย์หมุนเวียน | Subtotal |
| **2** | **สินทรัพย์ไม่หมุนเวียน** | |
| 2.1 | เงินฝากธนาคารที่มีภาระค้ำประกัน | |
| 2.2 | เงินลงทุนในบริษัทย่อย | |
| 2.3 | เงินลงทุนในการร่วมค้า | |
| 2.4 | เงินลงทุนในบริษัทร่วม | |
| 2.5 | เงินลงทุนระยะยาวอื่น | |
| 2.6 | ลูกหนี้การค้าและลูกหนี้ไม่หมุนเวียนอื่น | |
| 2.7 | เงินให้กู้ยืมระยะยาว | |
| 2.8 | มูลค่าของงานส่วนที่เสร็จแต่ยังไม่ถึงกำหนดเรียกชำระเงิน - ไม่หมุนเวียน | |
| 2.9 | อสังหาริมทรัพย์เพื่อการลงทุน | Split out of 2.10 in 2566 |
| 2.10 | ที่ดิน อาคารและอุปกรณ์ | Shown **net**. The form has no separate accumulated-depreciation line. |
| 2.11 | ค่าความนิยม | |
| 2.12 | สินทรัพย์ไม่มีตัวตน | |
| 2.13 | สินทรัพย์ชีวภาพไม่หมุนเวียน | |
| 2.14 | สินทรัพย์ภาษีเงินได้รอการตัดบัญชี | *2 |
| 2.15 | สินทรัพย์ไม่หมุนเวียนอื่น | |
| 2.16 | สินทรัพย์ไม่หมุนเวียนที่ถือไว้เพื่อขาย - ไม่หมุนเวียน | |
| | รวมสินทรัพย์ไม่หมุนเวียน / รวมสินทรัพย์ | Subtotals |
| **3** | **หนี้สินหมุนเวียน** | |
| 3.1 | เงินเบิกเกินบัญชีและเงินกู้ยืมระยะสั้นจากสถาบันการเงิน | |
| 3.2 | เจ้าหนี้การค้าและเจ้าหนี้หมุนเวียนอื่น | |
| 3.3 | เงินรับล่วงหน้าส่วนที่เกินกว่างานส่วนที่เสร็จ - หมุนเวียน | Construction contracts only |
| 3.4 | ส่วนของหนี้สินระยะยาวที่ถึงกำหนดชำระภายในหนึ่งปี | |
| 3.5 | ส่วนของหนี้สินตามสัญญาเช่าเงินทุนที่ถึงกำหนดชำระภายในหนึ่งปี | |
| 3.6 | เงินกู้ยืมระยะสั้น | |
| 3.7 | ภาษีเงินได้นิติบุคคลค้างจ่าย | Corporate income tax only |
| 3.8 | ประมาณการหนี้สินหมุนเวียนสำหรับผลประโยชน์พนักงาน | |
| 3.9 | ประมาณการหนี้สินระยะสั้นอื่น | |
| 3.10 | หนี้สินหมุนเวียนอื่น | |
| **4** | **หนี้สินไม่หมุนเวียน** | |
| 4.1 | เงินกู้ยืมระยะยาว | |
| 4.2 | หนี้สินตามสัญญาเช่าเงินทุน | |
| 4.3 | เจ้าหนี้การค้าและเจ้าหนี้ไม่หมุนเวียนอื่น | |
| 4.4 | เงินรับล่วงหน้าส่วนที่เกินกว่างานส่วนที่เสร็จ – ไม่หมุนเวียน | |
| 4.5 | หนี้สินภาษีเงินได้รอการตัดบัญชี | *2 |
| 4.6 | ประมาณการหนี้สินไม่หมุนเวียนสำหรับผลประโยชน์พนักงาน | |
| 4.7 | ประมาณการหนี้สินระยะยาวอื่น | |
| 4.8 | หนี้สินไม่หมุนเวียนอื่น | |
| **5** | **ส่วนของผู้ถือหุ้น** | |
| 5.1 | ทุนเรือนหุ้น | |
| 5.1.1 | ทุนจดทะเบียน (5.1.1.1 หุ้นบุริมสิทธิ, 5.1.1.2 หุ้นสามัญ) | Shown for disclosure only. Not part of the equity total. |
| 5.1.2 | ทุนที่ชำระแล้ว (5.1.2.1 หุ้นบุริมสิทธิ, 5.1.2.2 หุ้นสามัญ) | |
| 5.2 | ส่วนเกินมูลค่าหุ้น (5.2.1 บุริมสิทธิ, 5.2.2 สามัญ) | |
| 5.3 | ส่วนเกิน (ต่ำกว่า) ทุนอื่น | |
| 5.4 | กำไร (ขาดทุน) สะสม | |
| 5.4.1.1 | จัดสรรแล้ว – ทุนสำรองตามกฎหมาย | |
| 5.4.1.2 | จัดสรรแล้ว – อื่น ๆ | |
| 5.4.2 | ยังไม่ได้จัดสรร | |
| 5.5 | ส่วนได้เสีย - ทุนอื่น | |
| 5.6 | องค์ประกอบอื่นของส่วนของผู้ถือหุ้น | |
| 5.7 | ส่วนได้เสียที่ไม่มีอำนาจควบคุม | *1: consolidated statements only |

### 1b. งบกำไรขาดทุน (S1 แบบ 2 pp. 2-4 – 2-15)

ข้อ 6 lets the company pick 1 of 9 formats. This matters for the mapping because the lines differ by format. The three plain งบกำไรขาดทุน formats are below. The other six add OCI items (S1 2.2/2.3/2.5/2.6/2.8/2.9).

| Format | Lines in print order |
|---|---|
| **2.1 By nature** (p. 2-5) | 1 รายได้จากการขายหรือการให้บริการ · 2 รายได้อื่น · รวมรายได้ · 3 การเปลี่ยนแปลงในสินค้าสำเร็จรูปและงานระหว่างทำ · 4 งานที่ทำโดยกิจการและบันทึกเป็นรายจ่ายฝ่ายทุน · 5 วัตถุดิบและวัสดุสิ้นเปลืองใช้ไป · 6 ค่าใช้จ่ายผลประโยชน์พนักงาน · 7 ค่าเสื่อมราคาและค่าตัดจำหน่าย · 8 ผลขาดทุน (กลับรายการ) จากการลดลงของมูลค่าสินทรัพย์ · 9 ค่าใช้จ่ายอื่น · รวมค่าใช้จ่าย · 10 ส่วนแบ่งกำไร (ขาดทุน) …ที่ใช้วิธีส่วนได้เสีย · 11 กำไร (ขาดทุน) ก่อนต้นทุนทางการเงินและภาษีเงินได้ · 12 ต้นทุนทางการเงิน · 13 กำไร (ขาดทุน) ก่อนภาษีเงินได้ · 14 ภาษีเงินได้ · 15 กำไร (ขาดทุน) สุทธิ |
| **2.4 By function, single-step** (p. 2-10) | 1 รายได้จากการขายหรือการให้บริการ · 2 รายได้อื่น · รวมรายได้ · 3 ต้นทุนขายหรือต้นทุนการให้บริการ · 4 ค่าใช้จ่ายในการขาย · 5 ค่าใช้จ่ายในการบริหาร · 6 ค่าใช้จ่ายอื่น · รวมค่าใช้จ่าย · 7 ส่วนแบ่งกำไร (ขาดทุน)… · 8 กำไร (ขาดทุน) ก่อนต้นทุนทางการเงินและภาษีเงินได้ · 9 ต้นทุนทางการเงิน · 10 กำไร (ขาดทุน) ก่อนภาษีเงินได้ · 11 ภาษีเงินได้ · 12 กำไร (ขาดทุน) สุทธิ (pp. 2-10 – 2-11) |
| **2.7 By function, multi-step** (p. 2-15) | **The line numbers are not in print order.** The form prints: 1 รายได้จากการขายหรือการให้บริการ · 3 ต้นทุนขายหรือต้นทุนการให้บริการ · กำไร (ขาดทุน) ขั้นต้น · 2 รายได้อื่น · กำไร (ขาดทุน) ก่อนค่าใช้จ่าย · 4 ค่าใช้จ่ายในการขาย · 5 ค่าใช้จ่ายในการบริหาร · 6 ค่าใช้จ่ายอื่น · รวมค่าใช้จ่าย · 7 ส่วนแบ่งกำไร (ขาดทุน)… · 8 กำไร (ขาดทุน) ก่อนต้นทุนทางการเงินและภาษีเงินได้ · 9 ต้นทุนทางการเงิน · 10 กำไร (ขาดทุน) ก่อนภาษีเงินได้ · 11 ภาษีเงินได้ · 12 กำไร (ขาดทุน) สุทธิ |

The form does not split ต้นทุนขาย from ต้นทุนการให้บริการ. The face of the statement has one line, "ต้นทุนขายหรือต้นทุนการให้บริการ". The secondary blog claimed a split, and S1 does not support it.

---

## 2. ภ.ง.ด.50 boxes an account mapping would feed (S2 pp. 3–6, S3 pp. 6–12)

The number in brackets is the e-filing field ID printed in the right margin of S2.

| รายการ | Line: official wording [field] | How it is filled |
|---|---|---|
| **2** รายได้ รายจ่าย กำไรหรือขาดทุนสุทธิ และการคำนวณภาษี… | 1 รายได้โดยตรงจากการประกอบกิจการ [63] · 2 หัก ต้นทุนขายหรือรายจ่ายเพื่อคำนวณกำไรขั้นต้น (จากรายการที่ 3 9.) [64] · 3 กำไรขั้นต้น/ขาดทุนขั้นต้น [65-66] · 4 บวก รายได้อื่น (จากรายการที่ 5 7.) [67] · 5 รวม · 6 หัก รายจ่ายอื่น (จากรายการที่ 6 5.) [68] · 7 รวม · 8 หัก รายจ่ายในการขายและบริหาร (จากรายการที่ 7 24.) [69] · 9 กำไรสุทธิ/ขาดทุนสุทธิ ตามบัญชีกำไรขาดทุน [70-71] · **10 บวก รายได้ที่ให้ถือเป็นรายได้ตามประมวลรัษฎากร [72]** · **11 บวก รายจ่ายที่ไม่ให้ถือเป็นรายจ่ายตามประมวลรัษฎากร (จากรายการที่ 8 7.) [73]** · 12 รวม · **13 หัก รายได้ที่ได้รับการยกเว้นภาษีเงินได้หรือรายจ่ายที่มีสิทธิหักได้เพิ่มขึ้น (จากใบแนบ… 5.) [74]** · 14 รวม · **15 หัก ขาดทุนสุทธิที่มีสิทธินำมาหักตามกฎหมาย [75]** · 16 รวม · **17 บวก รายจ่ายส่วนที่เกินร้อยละ 10 ของกำไรสุทธิ [75.1]** · **18 บวก รายจ่ายเพื่อการกุศลสาธารณะฯ ส่วนที่เกินร้อยละ 2 ของกำไรสุทธิ [76]** · **19 บวก รายจ่ายเพื่อการศึกษาหรือเพื่อการกีฬา ส่วนที่เกินร้อยละ 2 ของกำไรสุทธิ [77]** · 20 รวม [78] · 21 กำไรสุทธิที่ต้องเสียภาษี/ขาดทุนสุทธิ | Line 1 is mapped from accounts. Lines 2, 4, 6 and 8 are carried from the schedules below. The bold add-back and deduct lines (10, 11, 13, 15, 17–19) are **computed tax adjustments**, not account balances. |
| **3** ต้นทุนขายหรือรายจ่ายเพื่อคำนวณกำไรขั้นต้น | 1 สินค้าคงเหลือ ณ วันเริ่มรอบระยะเวลาบัญชี [79] · 2 ซื้อสินค้า [80] · 3 ต้นทุนผลิต/ต้นทุนการให้บริการ (จากรายการที่ 4 17.) [81] · 4 ค่าแห่งกู๊ดวิลล์ ค่าแห่งลิขสิทธิ์ หรือสิทธิอย่างอื่น [82] · 5 ค่าใช้จ่ายอื่นๆ ในการซื้อสินค้า [83] · 6 รวม 3.–5. · 7 รวม (1.+2.+6.) · 8 หัก สินค้าคงเหลือ ณ วันสุดท้ายของรอบระยะเวลาบัญชี [84] · 9 ต้นทุนขายหรือรายจ่ายเพื่อคำนวณกำไรขั้นต้น (7.–8.) [85] | Uses a **periodic** layout. See consequence C5. |
| **4** ต้นทุนผลิต/ต้นทุนการให้บริการ | 1 วัตถุดิบ และวัสดุคงเหลือ ณ วันเริ่มรอบฯ [86] · 2 ซื้อวัตถุดิบ และวัสดุ [87] · 3 ค่าใช้จ่ายอื่นๆ ในการซื้อวัตถุดิบ และวัสดุ [88] · 4 รวม · 5 หักวัตถุดิบ และวัสดุคงเหลือ ณ วันสุดท้ายฯ [89] · 6 ต้นทุนวัตถุดิบ และวัสดุใช้ไป [90] · 7 งานระหว่างทำ หรือสินค้าระหว่างผลิตคงเหลือ ณ วันเริ่มรอบฯ [91] · 8 เงินเดือน และค่าจ้างแรงงาน [92] · 9 ค่าแห่งกู๊ดวิลล์ ค่าแห่งลิขสิทธิ์ หรือสิทธิอย่างอื่น [93] · 10 ค่าเชื้อเพลิงหรือพลังงาน [94] · 11 ค่าภาชนะบรรจุ ค่าหีบห่อ [95] · 12 ค่าสึกหรอและค่าเสื่อมราคา [96] · 13 ค่าใช้จ่ายในการผลิต/การให้บริการ อื่นๆ [97] · 14–15 รวม · 16 หัก งานระหว่างทำ…คงเหลือ ณ วันสุดท้ายฯ [98] · 17 ต้นทุนผลิต/ต้นทุนการให้บริการ [99] | |
| **5** รายได้อื่น | 1 กำไรจากการจำหน่ายทรัพย์สิน [100] · 2 กำไรจากอัตราแลกเปลี่ยนเงินตรา [101] · 3 ดอกเบี้ยรับ [102] · 4 เงินปันผลหรือส่วนแบ่งกำไร [103] · 5 เงินชดเชยค่าภาษีอากร [104] · 6 รายได้อื่นที่นอกเหนือจาก 1. ถึง 5. [105] · 7 รวม | |
| **6** รายจ่ายอื่น (S3: "ไม่เกี่ยวเนื่องโดยตรงกับการประกอบกิจการ", i.e. not directly related to the business) | 1 ขาดทุนจากการจำหน่ายทรัพย์สิน [106] · 2 ขาดทุนจากอัตราแลกเปลี่ยนเงินตรา [107] · 3 ต้นทุนทางการเงิน [108] · 4 รายจ่ายอื่นที่นอกเหนือจาก 1. ถึง 3. [109] · 5 รวม | 6.3 finance cost is for money **not** directly related to the business (S3 p. 10). |
| **7** รายจ่ายในการขายและบริหาร | 1 รายจ่ายเกี่ยวกับพนักงาน [110] · 2 ค่าตอบแทนกรรมการ [111] · 3 ค่าไฟฟ้า ค่าประปา ค่าโทรศัพท์ [112] · 4 ค่าพาหนะ รายจ่ายในการเดินทาง ค่าที่พัก [113] · 5 ค่าระวาง ค่าขนส่ง [114] · 6 ค่าเช่า [115] · 7 ค่าซ่อมแซม [116] · 8 ค่ารับรอง [117] · 9 ค่านายหน้า ค่าโฆษณา ค่าส่งเสริมการขาย [118] · 10 ค่าภาษีธุรกิจเฉพาะ (รวมรายได้ส่วนท้องถิ่น) [119] · 11 ค่าภาษีอากรอื่นๆ [120] · 12 ต้นทุนทางการเงิน [121] · 13 ค่าทำบัญชี [121.1] · 14 ค่าสอบบัญชี [122] · 15 เงินที่บริจาคแก่พรรคการเมือง [122.1] · 16 รายจ่ายเพื่อการกุศลสาธารณะฯ [123] · 17 รายจ่ายเพื่อการศึกษาหรือเพื่อการกีฬา [124] · 18 ค่าธรรมเนียมในการให้คำแนะนำและปรึกษา [125] · 19 ค่าธรรมเนียมอื่นๆ [126] · 20 หนี้สูญ [127] · 21 ค่าสึกหรอและค่าเสื่อมราคาของทรัพย์สิน [128] · 22 รายจ่ายอื่นที่นอกเหนือจาก 1. ถึง 21. [129] · 23 รายจ่ายอื่นหักได้ 2 เท่าไม่เกินร้อยละ 10 ของกำไรสุทธิ [129.1] · 24 รวม | 7.12 finance cost is business-related interest (S3 p. 10). Lines 7.8, 7.16, 7.17 and 7.20 are entered at the **actual amount**. The excess over the legal limit goes to 8.2, 2.18, 2.19 and 8.3. |
| **8** รายจ่ายที่ไม่ให้ถือเป็นรายจ่ายตามประมวลรัษฎากร | 1 ภาษีเงินได้บริษัทหรือห้างหุ้นส่วนนิติบุคคล [130] · 2 ค่ารับรอง [131] · 3 หนี้สูญ [132] · 4 เงินสำรอง [133] · 5 รายจ่ายตามรายการที่ 7 23. [134] · 6 รายจ่ายที่ไม่ให้ถือเป็นรายจ่ายฯ อื่นๆ [134.1] · 7 รวม → รายการที่ 2 11. | 8.1 is the CIT expense account, under ม.65 ตรี (6). 8.2 is entertainment above the cap in กฎกระทรวง 143: 0.3% of revenue or paid-up capital, whichever is larger, max 10 MB. 8.3 is bad debt failing กฎกระทรวง 186. 8.4 is reserves under ม.65 ตรี (1). 8.6 covers, for example, depreciation above พ.ร.ฎ. 145 (S3 pp. 10–12). |
| **9** รายละเอียดสินทรัพย์ หนี้สิน และส่วนของผู้ถือหุ้น/ผู้เป็นหุ้นส่วน | Assets: 1(1) เงินสดและรายการเทียบเท่าเงินสด [140] · 1(2) ลูกหนี้การค้า - สุทธิ [141] · 1(3) สินค้าคงเหลือ [142] · 1(4) สินทรัพย์หมุนเวียนอื่น [143] · 2(1) เงินให้กู้ยืมระยะยาวแก่บุคคลหรือกิจการที่เกี่ยวข้องกัน/กรรมการ/ผู้ถือหุ้นและพนักงาน [144] · 2(2) ที่ดิน และอาคารซึ่งหักค่าสึกหรอและค่าเสื่อมราคาแล้ว [145] · 2(3) ทรัพย์สินอื่นซึ่งหักค่าสึกหรอและค่าเสื่อมราคาแล้ว [146] · 2(4) สิทธิการเช่าและหรือสิทธิการใช้ทรัพย์สิน [147] · 2(5) สินทรัพย์ไม่หมุนเวียนอื่น [148]. Liabilities: 1(1) เงินเบิกเกินบัญชีและเงินกู้ยืมระยะสั้นจากสถาบันการเงิน [149] · 1(2) เจ้าหนี้การค้า [150] · 1(3) เงินกู้ยืม [151] · 1(4) หนี้สินหมุนเวียนอื่น [152] · 2(1) เงินกู้ยืมระยะยาว [153] · 2(2) หนี้สินไม่หมุนเวียนอื่น [154]. Equity: ทุนจดทะเบียน [155] · 3(1) ทุนที่ออกและชำระแล้ว [156] · 3(2) อื่นๆ [157] · 3(3) กำไรสะสม/ขาดทุนสะสม [158-159] · รวม [160, 161] | S3 p. 12: "ห้ามแก้ไขหรือเพิ่มเติมรายการขึ้นใหม่" (no new lines may be added). |

---

## 3. Placeholder key → official line

### 3a. `DBD_LINES`

The P&L rows assume format **2.7** (by function, multi-step). Ham has to confirm this (Outcome O1).

| Placeholder key | Current th label | Verdict | Official line(s) |
|---|---|---|---|
| `bs-cash` | เงินสดและเงินฝากธนาคาร | Rename | 1.1 เงินสดและรายการเทียบเท่าเงินสด. Pledged deposits go to 2.1 instead. |
| `bs-receivables` | ลูกหนี้การค้า | Rename | 1.3 ลูกหนี้การค้าและลูกหนี้หมุนเวียนอื่น |
| `bs-prepaid` | ค่าใช้จ่ายจ่ายล่วงหน้า | Drop as a DBD line (fold) | S1 has no such line. Fold into 1.3 (as "ลูกหนี้หมุนเวียนอื่น") or 1.9. The choice is my interpretation, UNVERIFIED. Keep it as a sub-class, not a DBD line. |
| `bs-tax-asset` | ภาษีซื้อ/ภาษีหัก ณ ที่จ่ายรอรับ | Split | Prepaid CIT and WHT credits that offset CIT → 1.7 สินทรัพย์ภาษีเงินได้ของงวดปัจจุบัน. Undue/claimable input VAT → 1.9 สินทรัพย์หมุนเวียนอื่น. The 1.9 placement is my interpretation, UNVERIFIED. |
| `bs-other-current` | สินทรัพย์หมุนเวียนอื่น | Keep | 1.9 |
| `bs-ppe` | ที่ดิน อาคารและอุปกรณ์ | Keep | 2.10 (net) |
| `bs-accum-dep` | หัก ค่าเสื่อมราคาสะสม | Drop | No DBD line exists. The account is a contra of 2.10 and maps to `bs-ppe`. |
| `bs-payables` | เจ้าหนี้การค้า | Rename | 3.2 เจ้าหนี้การค้าและเจ้าหนี้หมุนเวียนอื่น |
| `bs-accrued` | ค่าใช้จ่ายค้างจ่าย | Drop (fold) | Fold into 3.2 or 3.10. My interpretation, UNVERIFIED. |
| `bs-tax-payable` | ภาษีค้างจ่าย | Split | CIT payable → 3.7 ภาษีเงินได้นิติบุคคลค้างจ่าย. Output VAT, WHT and SSO payable → 3.10 หนี้สินหมุนเวียนอื่น. The 3.10 placement is my interpretation, UNVERIFIED. |
| `bs-deposits-received` | เงินรับล่วงหน้า | Drop (fold) | 3.3 is for construction contracts only. Customer advances fold into 3.10, or 3.2 as "เจ้าหนี้หมุนเวียนอื่น". My interpretation, UNVERIFIED. |
| `bs-payroll-payable` | เงินเดือนและประกันสังคมค้างจ่าย | Drop (fold) | 3.2 or 3.10. My interpretation, UNVERIFIED. |
| `bs-capital` | ทุนเรือนหุ้น | Keep, narrow | 5.1.2 ทุนที่ชำระแล้ว. Registered capital (5.1.1) is a disclosure, not a balance. |
| `bs-retained` | กำไร(ขาดทุน)สะสม | Split | 5.4.1.1 ทุนสำรองตามกฎหมาย · 5.4.1.2 จัดสรรแล้ว–อื่น ๆ · 5.4.2 ยังไม่ได้จัดสรร |
| `pl-revenue` | รายได้จากการขายหรือบริการ | Rename | 1 รายได้จากการขายหรือการให้บริการ |
| `pl-other-income` | รายได้อื่น | Keep | 2 รายได้อื่น |
| `pl-cost` | ต้นทุนขายและบริการ | Rename | 3 ต้นทุนขายหรือต้นทุนการให้บริการ |
| `pl-selling-admin` | ค่าใช้จ่ายในการขายและบริหาร | Split | 4 ค่าใช้จ่ายในการขาย · 5 ค่าใช้จ่ายในการบริหาร |
| `pl-other-expense` | ค่าใช้จ่ายอื่น | Keep | 6 ค่าใช้จ่ายอื่น |
| `pl-finance-cost` | ต้นทุนทางการเงิน | Keep | 9 ต้นทุนทางการเงิน |
| `pl-income-tax` | ภาษีเงินได้ | Keep | 11 ภาษีเงินได้ |

**Official lines our list lacks that an SME chart needs:**
- 1.6 สินค้าคงเหลือ (inventory)
- 1.5 เงินให้กู้ยืมระยะสั้น (e.g. loans to directors)
- 1.2 เงินลงทุนชั่วคราว
- 2.1 เงินฝากธนาคารที่มีภาระค้ำประกัน
- 2.5 เงินลงทุนระยะยาวอื่น
- 2.7 เงินให้กู้ยืมระยะยาว
- 2.12 สินทรัพย์ไม่มีตัวตน
- 2.15 สินทรัพย์ไม่หมุนเวียนอื่น (e.g. deposits paid)
- 3.1 เงินเบิกเกินบัญชีและเงินกู้ยืมระยะสั้นจากสถาบันการเงิน
- 3.4 ส่วนของหนี้สินระยะยาวที่ถึงกำหนดชำระภายในหนึ่งปี
- 3.5 / 4.2 หนี้สินตามสัญญาเช่าเงินทุน (hire purchase and leases)
- 3.6 เงินกู้ยืมระยะสั้น (e.g. loans from directors)
- 3.10 หนี้สินหมุนเวียนอื่น
- 3.8 / 4.6 ประมาณการหนี้สินผลประโยชน์พนักงาน (severance under the Labour Protection Act, LPA)
- 4.1 เงินกู้ยืมระยะยาว
- 4.8 หนี้สินไม่หมุนเวียนอื่น
- 5.2 ส่วนเกินมูลค่าหุ้น
- 5.4.1.1 ทุนสำรองตามกฎหมาย

Construction, biological, held-for-sale, group and OCI lines are only needed if TEAS 2 serves those businesses. Under ข้อ 7 they may be left out.

### 3b. `PND50_BOXES`

The five boxes are far too coarse. The form's own sub-lines are closed and mandatory (S3: "ให้กรอกรายการที่มีทุกรายการตามที่ปรากฏในแบบ", fill every line the form has).

| Placeholder key | Verdict | Official target(s) |
|---|---|---|
| `p50-revenue` | Rename | รายการที่ 2 1. รายได้โดยตรงจากการประกอบกิจการ [63] |
| `p50-other-income` | Split | รายการที่ 5 lines 1–6 [100–105] |
| `p50-cost` | Split | รายการที่ 3 lines 1, 2, 4, 5, 8 [79, 80, 82, 83, 84] and รายการที่ 4 lines 1–3, 5, 7–13, 16 [86–89, 91–98]. Line 3.1 and 3.8, and 4.1/4.5/4.7/4.16, are inventory **balances**, not P&L accounts. See C5. |
| `p50-expense` | Split | รายการที่ 7 lines 1–23 [110–129.1] plus รายการที่ 6 lines 1–4 [106–109] |
| `p50-nondeductible` | Drop as a mapping target | รายการที่ 8 is computed. The only pure account hit is 8.1 CIT expense [130], which can be mapped. 8.2–8.6 come from rules (caps, กฎกระทรวง tests, reserves, พ.ร.ฎ. 145) applied to amounts already mapped to รายการที่ 7. The add-backs and deductions on รายการที่ 2 lines 10, 13, 15, 17–19 also come from rules, not account balances. |

The balance sheet (รายการที่ 9) is **not** a clean many-to-one roll-up of DBD lines. There are three exceptions:
- DBD 1.3 must split into ลูกหนี้การค้า - สุทธิ [141] and สินทรัพย์หมุนเวียนอื่น [143].
- DBD 3.2 must split into เจ้าหนี้การค้า [150] and หนี้สินหมุนเวียนอื่น [152].
- DBD 2.10 must split into ที่ดิน และอาคาร [145] and ทรัพย์สินอื่น [146].

So either the account `subClass` must carry that distinction, or a third `pnd50Bs` field is needed. Recommendation: derive it from DBD line plus sub-class rather than add a field.

## Verdicts
| Model | Answer (summary) | Key primary sources | Confidence |
|---|---|---|---|
| Claude | As in §1–3. DBD แบบ 2 lines are listed in print order. The DBD list is open (ข้อ 7, ข้อ 8). The ภ.ง.ด.50 is closed and much finer than the placeholders. 8 DBD keys need a rename, split or drop. 18 official lines are missing. รายการที่ 8 is computed, not mapped. | S1 (ราชกิจจาฯ 140/288ง, pp. 24–26 + แบบ 2), S2, S3, S4 | High for the line lists, which are read from the PDFs. Medium for the "fold" placements marked UNVERIFIED. |
| Codex | Not run (single-model dispatch) | — | — |
| AGY | Not run (single-model dispatch) | — | — |

## Agreement
Not applicable: only one model was run.

## Primary-source spot check
- **S1 ข้อ 2(2)** (rendered page 24): "บริษัทจำกัด ต้องมีรายการย่อตามที่กำหนดในแบบ ๒".
- **S1 ข้อ 7** (page 25): "ให้งดเว้นไม่ต้องแสดงรายการย่อที่ไม่มีดังกล่าว".
- **S1 ข้อ 9** (page 26): "รอบปีบัญชีเริ่มต้นในหรือหลังวันที่ ๑ มกราคม พ.ศ. ๒๕๖๗".
- **S1 แบบ 2**, pp. 2-1 – 2-3 and 2-5 / 2-10 / 2-15: the line items were read from PyMuPDF text, which is clean in the attachment pages.
- **S2 pp. 3–6**: page images were rendered and read; the field IDs come from the right margin.
- **S3 p. 1**: "สำหรับรอบระยะเวลาบัญชีที่เริ่มในหรือหลังวันที่ 1 มกราคม พ.ศ. 2568". S3 pp. 10–12 hold the instructions for รายการที่ 6, 7, 8 and 9.

## Outcome
Proposed until Ham rules.

- **O1 (Ham decides): the P&L format.** Recommend 2.7 (by function, multi-step) as the default. Its shape (gross profit, then other income, then selling/admin) mirrors ภ.ง.ด.50 รายการที่ 2. The by-nature format (2.1) has **no** cost-of-sales or selling/admin lines, so `dbdLine` mapping for P&L accounts depends on the format chosen. Either fix one format, or store the expense nature on the account and derive both views.
- **O2:** Replace the `DBD_LINES` keys with the official แบบ 2 numbering from §1a/§1b, applying the verdicts in §3a. Keep the official Thai wording verbatim as the `th` label.
- **O3 (Ham decides): `pnd50Box` granularity.** Replace the 5 boxes with the รายการที่ 3/4/5/6/7 sub-lines and 2.1 / 8.1 (§3b). Do not map to รายการที่ 8 lines 2–6 or to the รายการที่ 2 adjustment lines. Those belong to a tax-computation step.
- **O4:** Derive ภ.ง.ด.50 รายการที่ 9 from DBD line plus sub-class (trade vs other; land and buildings vs other PPE). No second balance-sheet mapping field.

## Implementation consequences
- **C1:** `accounts.ts` `DBD_LINES` / `PND50_BOXES` and the `th.json` labels must change: renames, splits, drops, and the new lines in §3. Any seeded chart or fixtures that use the old keys need migrating in the mock.
- **C2:** Add a DBD statement renderer test. Lines must render in **print order**, which is not number order for format 2.7 (1, 3, GP, 2, …). Lines with no balance are hidden (ข้อ 7).
- **C3:** Add a ภ.ง.ด.50 roll-up test: รายการที่ 7 24 equals the sum of 1–23. รายการที่ 2 9 equals P&L net profit before adjustments. Golden fixture: net profit by DBD equals ภ.ง.ด.50 2.9 before tax adjustments.
- **C4:** Finance cost has two targets: 6.3 (not directly business-related) and 7.12 (business-related). The account or a sub-class must say which.
- **C5:** ภ.ง.ด.50 รายการที่ 3 and 4 use a periodic layout (opening stock + purchases − closing stock). If TEAS 2 posts perpetual COGS, the export needs purchases and inventory balances by date, not just a COGS account. A spec section is needed.
- **C6:** The CIT expense account maps to DBD 11 ภาษีเงินได้ and to ภ.ง.ด.50 8.1 [130]. That is the only account-level hit in รายการที่ 8.
- **C7:** Open items:
  - English labels (needs a DBD e-Filing login to read the XBRL taxonomy).
  - แบบ 1 (partnership) equity section.
  - The fold placements marked UNVERIFIED. Confirm with a TFAC/DBD guide or Ham.
