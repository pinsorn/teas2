# TEAS 2 — SP0 Diagrams

Visual companion to [`SP0-charter.md`](SP0-charter.md). The spec is the source of truth: if a diagram and the
spec disagree, the spec wins and this file is corrected.

## 1. ภาพรวมแผน — sub-projects และ gates
> §11.2

ทุก sub-project วน spec → plan → execute และผ่าน gate ของ Ham ก่อนไปขั้นถัดไป · SP-R (research ภาษี) วิ่งขนานกับ mockup

```mermaid
flowchart TB
  subgraph DESIGN["ออกแบบ"]
    SP0["SP0 · Charter + design<br/>spec ฉบับนี้"]
    G0{{"Ham approve spec"}}
  end
  subgraph MOCK["Mockup = frontend ตัวจริง"]
    SP1a["SP1a · Style tiles 2–3 แบบ"]
    G1a{{"Ham เลือก 1 แบบ"}}
    SP1b["SP1b · Design system + shell + doc kit<br/>TI ครบ loop + rendering spike"]
    G1b{{"Ham approve pattern<br/>+ spike ผ่าน"}}
    SP1c["SP1c · Mockup ทุกหน้า<br/>VAT / non-VAT · ทุก role · ทุก state"]
    G1c{{"Ham approve ราย module group"}}
  end
  subgraph RESEARCH["Research ขนาน"]
    SPR["SP-R · Tri-model tax research<br/>Claude + Codex + AGY<br/>+ golden fixtures จาก TEAS 1"]
    GR{{"3 model ตรงกัน<br/>หรือ Ham ตัดสิน"}}
  end
  subgraph BUILD["แผน + สร้าง"]
    SP2["SP2 · Contract freeze<br/>+ แผนละเอียดราย module"]
    G2{{"Ham approve plans"}}
    SP3["SP3 · Platform foundation"]
    SP4["SP4.1–4.11 · Modules<br/>DoD + Tier 1–4 + demo"]
    SPZ["SPz · Hardening + Tier-4 + Launch"]
    GZ{{"Ham go"}}
  end
  SP0 --> G0 --> SP1a --> G1a --> SP1b --> G1b --> SP1c --> G1c --> SP2
  G0 --> SPR --> GR --> SP2
  SP2 --> G2 --> SP3 --> SP4 --> SPZ --> GZ
  classDef gate fill:#EEF0FB,stroke:#3B4FB8,color:#1D2A6B
  class G0,G1a,G1b,G1c,GR,G2,GZ gate
```

## 2. ลำดับการสร้าง module
> §11.4

ลูกศร = ต้องเสร็จก่อน · MCP tools ของแต่ละ module generate จาก descriptor และออกพร้อม module นั้น

```mermaid
flowchart TB
  P["SP3 Platform<br/>tenancy · RLS · migrator · auth + membership<br/>permissions · errors · idempotency · audit · jobs · MCP host"]
  L["SP4.1 Ledger<br/>ผังบัญชี · posting kernel · posting profiles<br/>มิติ · party · งวด · JV + กลับรายการ"]
  M["SP4.2 Masters + Document engine<br/>ลูกค้า · ผู้ขาย · สินค้า · ธนาคาร<br/>series เลขที่ · descriptors · UI kit"]
  S["SP4.3 ขาย<br/>QT SO DO IV TI BL RC CN/DN<br/>VAT ขาย · AR settlement"]
  PU["SP4.4 ซื้อ<br/>PO PB PCN/PDN PV · WHT + 50 ทวิ<br/>ภ.พ.36 · AP settlement · ใบเบิก"]
  SB["SP4.5 Settlement + ธนาคาร<br/>มัดจำ · หักกลบ · ส่วนต่าง<br/>import statement · กระทบยอด"]
  A["SP4.6 สินทรัพย์ + Schedules<br/>FA · ค่าเสื่อม · รายการซ้ำ<br/>ค้างจ่าย · ตัดจ่ายล่วงหน้า"]
  PR["SP4.7 เงินเดือน<br/>PIT · SSO · ภ.ง.ด.1/1ก · สปส.1-10"]
  T["SP4.8 แบบภาษี<br/>ภ.พ.30 · ภ.ง.ด.2/3/53/54 · ภ.พ.36<br/>ภ.ง.ด.50/51 · RD Prep · filing locks"]
  R["SP4.9 รายงาน<br/>งบการเงินตามมิติ · aging · XLSX"]
  C["SP4.10 Connect<br/>OAuth 2.1 · agent policy + review"]
  O["SP4.11 Onboarding + Import<br/>wizard · ยอดยกมา · CSV"]
  P --> L --> M
  M --> S
  M --> PU
  S --> SB
  PU --> SB
  L --> A
  M --> A
  M --> PR
  S --> T
  PU --> T
  PR --> T
  A --> T
  SB --> R
  T --> R
  S --> C
  PU --> C
  SB --> O
  A --> O
  PR --> O
```

## 3. สถาปัตยกรรมระบบ
> §4, §10

browser ผ่าน BFF เสมอ · agent / ระบบภายนอกเข้าทาง Traefik ตรงเข้า API · app, test และ CI ใช้ role `teas_app` (ติด RLS)

```mermaid
flowchart LR
  U["ผู้ใช้<br/>browser / มือถือ"] --> FE["Next.js 16.4<br/>UI + BFF (proxy.ts)<br/>httpOnly cookie"]
  AG["AI agent / ระบบภายนอก"] --> TR["Traefik<br/>/api/v1 · /mcp · /oauth"]
  FE -->|"/bff/*"| API["Teas.Api · .NET 10<br/>modules · command pipeline<br/>MCP · OAuth 2.1"]
  TR --> API
  FE --> PAPER["Paper component<br/>จอ = กระดาษ"]
  PAPER --> GOT["Gotenberg<br/>Chromium → PDF"]
  API --> RD["RD AcroForm engine<br/>17 แบบฟอร์มทางการ"]
  API --> DB[("PostgreSQL 18<br/>FORCE RLS · teas_app")]
  MIG["Teas.Migrator<br/>migrations + catalog sync"] --> DB
  API --> FILES[("File storage<br/>volume + backup")]
```

## 4. แผนผังเมนู (IA)
> §9.1

จัดตามงาน ~35 รายการ (TEAS 1 มี 51) · ซ่อนรายการที่ไม่มีสิทธิ์ · บริษัท non-VAT ไม่เห็นเมนูเฉพาะ VAT

```mermaid
flowchart LR
  ROOT(["TEAS 2"])
  ROOT --> H["หน้าหลัก"] --> H1["งานของฉัน · inbox รออนุมัติ<br/>draft ค้าง · เกินกำหนด · ภาษีใกล้ยื่น<br/>KPI เงินสด / AR / AP / VAT"]
  ROOT --> S["ขาย"] --> S1["ใบเสนอราคา · ใบสั่งขาย · ใบส่งของ<br/>ใบแจ้งหนี้ / ใบวางบิล · ใบกำกับภาษี<br/>ใบเสร็จรับเงิน · ใบลดหนี้ / เพิ่มหนี้"]
  ROOT --> B["ซื้อ"] --> B1["ใบสั่งซื้อ · บันทึกซื้อ/ค่าใช้จ่าย<br/>ใบสำคัญจ่าย · ใบลด/เพิ่มหนี้ผู้ขาย<br/>ใบเบิกค่าใช้จ่าย"]
  ROOT --> F["การเงิน"] --> F1["บัญชีธนาคาร + import + กระทบยอด<br/>มัดจำ / เงินล่วงหน้า"]
  ROOT --> AC["บัญชี"] --> AC1["สมุดรายวัน · ผังบัญชี · ยอดยกมา<br/>รายการซ้ำ / ตัดจ่าย<br/>สินทรัพย์ + ค่าเสื่อม · ปิดงวด / ปิดปี"]
  ROOT --> TX["ภาษี"] --> TX1["สรุปภาษีรายเดือน · ภ.พ.30 + ทะเบียน<br/>หัก ณ ที่จ่าย: 50 ทวิ · ภ.ง.ด.2/3/53/54 · ภ.พ.36<br/>ภ.ง.ด.50/51"]
  ROOT --> PY["เงินเดือน"] --> PY1["พนักงาน · รอบเงินเดือน<br/>ภ.ง.ด.1/1ก · สปส.1-10"]
  ROOT --> RP["รายงาน"] --> RP1["งบการเงิน TB / P&L / BS / GL ตามมิติ<br/>ลูกหนี้ / เจ้าหนี้ aging + statement<br/>สรุปขาย / ซื้อ · ตรวจสอบ"]
  ROOT --> MD["ข้อมูลหลัก"] --> MD1["ลูกค้า · ผู้ขาย · สินค้า/บริการ"]
  ROOT --> ST["ตั้งค่า"] --> ST1["บริษัท · ผู้ใช้และสิทธิ์ · การลงบัญชี · มิติ<br/>ภาษี · เลขที่เอกสาร · การอนุมัติ<br/>แม่แบบเอกสาร · TEAS Connect"]
```

## 5. Accounting engine
> §5, §6.1

เอกสารไม่ระบุเลขบัญชีเอง — ส่ง posting intent ให้ ledger ตัดสินบัญชีผ่าน posting profile · แบบภาษีอ่านจากเอกสาร แล้ว tie-out กับ GL

```mermaid
flowchart LR
  DOC["เอกสาร<br/>TI · PB · PV · PR · JV …"] -->|"posting intent<br/>role + ยอด + party + มิติ"| RES["Posting profile resolver<br/>สินค้า → หมวด → กลุ่ม party<br/>→ ชนิดเอกสาร → default"]
  RES --> KER["Ledger kernel<br/>Dr = Cr · 2 ทศนิยม · งวดเปิด<br/>บัญชีถูก class · party · มิติ"]
  KER --> JE[("Journal entries<br/>แก้ไม่ได้ · กลับรายการได้ทุกใบ")]
  JE --> SUB["Subledgers AR / AP<br/>aging · statement"]
  JE --> FS["งบการเงิน · TB / GL<br/>แยกตามมิติ"]
  JE --> CIT["ภ.ง.ด.50 / 51"]
  DOC --> TAX["Tax core<br/>VAT · WHT · ภาษีเงินเดือน"]
  TAX --> REG["ทะเบียน + แบบภาษี<br/>ภ.พ.30 · ภ.ง.ด. · 50 ทวิ"]
  REG -.->|"tie-out"| JE
```

## 6. Lifecycle ของเอกสาร
> §7.2, §7.6

ขั้นอนุมัติปิดเป็นค่าเริ่มต้น (เปิดรายชนิดได้) · ลบได้เฉพาะ draft ซึ่งยังไม่มีเลข · settlement มาจากใบเสร็จ/การจ่ายเท่านั้น

```mermaid
stateDiagram-v2
  state "ร่าง" as Draft
  state "รออนุมัติ" as Pending
  state "อนุมัติแล้ว" as Approved
  state "ออกแล้ว" as Issued
  state "ชำระบางส่วน" as Partly
  state "ชำระครบ" as Settled
  state "ยกเลิก (เลขคงอยู่)" as Cancelled
  state "ถูกแทนที่" as Replaced
  [*] --> Draft
  Draft --> [*]: ลบ
  Draft --> Pending: ส่งอนุมัติ ถ้าเปิดใช้
  Pending --> Approved: อนุมัติ
  Pending --> Draft: ส่งกลับ
  Approved --> Draft: แก้ไข
  Draft --> Issued: บันทึกและออก
  Approved --> Issued: ออกเอกสาร
  Issued --> Issued: แก้ไข = revision
  Issued --> Partly: รับ/จ่ายบางส่วน
  Partly --> Settled: ครบ
  Issued --> Settled: ครบ
  Issued --> Cancelled: ยกเลิก
  Issued --> Replaced: ยกเลิก + ออกใหม่
```

## 7. ปุ่ม "แก้ไข" หลังออกเอกสาร
> §7.3, §7.5

ปุ่มเดียวทุกเอกสาร — engine เลือกทางตามชั้น N / L / T · ถ้าติดล็อก แสดงเหตุผลพร้อมทางออก ไม่ซ่อนปุ่ม

```mermaid
flowchart TB
  E["กด แก้ไข"] --> LOCK{"ติดล็อกไหม<br/>งวดปิด · แบบภาษียื่นแล้ว<br/>มีการชำระ · กระทบยอดแล้ว"}
  LOCK -->|"ติด"| EXIT["แสดงเหตุผล + ทางออก<br/>เช่น ออก CN/DN งวดถัดไป<br/>หรือยกเลิกการตัดชำระก่อน"]
  LOCK -->|"ไม่ติด"| Q{"ชั้นของเอกสาร"}
  Q -->|"N · QT SO DO BL PO"| N["แก้ในที่ → Rev.n<br/>diff ใน history · เลขเดิม<br/>เตือนถ้ามีเอกสารปลายทาง"]
  Q -->|"L · IV PB PV EX JV FA PR"| L["Rev.n → กลับรายการ JE เดิม<br/>+ ลง JE ใหม่อัตโนมัติ · เลขเดิม<br/>WHT เปลี่ยน → ออก 50 ทวิ ใหม่"]
  Q -->|"T · TI RC CN DN"| T{"แก้ช่องไหน"}
  T -->|"โน้ต · ไฟล์ · มิติ · due date"| T1["แก้ในที่ + audit"]
  T -->|"ช่องภาษี · ยอดเท่าเดิม"| T2["ยกเลิก + ออกใหม่<br/>อ้างฉบับเดิม"]
  T -->|"ยอดเปลี่ยน"| T3["เสนอ CN / DN<br/>พร้อม reason code"]
  L --> PC{"งวดเดิมปิดแล้ว?"}
  PC -->|"ปิด"| PC1["ลงงวดปัจจุบัน<br/>ป้าย แก้ไขย้อนหลัง"]
  PC -->|"เปิด"| PC2["ลงงวดเดิม"]
```

## 8. Agent post เอกสาร (hybrid review)
> §8

agent ต้อง review ก่อนเสมอ · token ผูกกับ version ของเอกสาร · ผลสะอาดและไม่เกินเพดาน → auto, นอกนั้นส่งคนอนุมัติ

```mermaid
sequenceDiagram
  participant A as AI agent
  participant S as TEAS 2 API
  participant H as คน (inbox)
  A->>S: สร้าง / แก้ draft
  A->>S: review(document)
  S-->>A: ยอด · ภาษี · JE preview · ผลตรวจ · route · review_token
  A->>S: post(document, review_token)
  S->>S: ตรวจซ้ำ version · token · checks
  alt auto — ผลสะอาด + ไม่เกินเพดาน
    S-->>A: ออกเอกสารแล้ว · audit = agent + owner
  else human — มี warning / เกินเพดาน / เอกสารภาษี
    S->>H: รออนุมัติจาก agent + review report
    H->>S: อนุมัติและออก ใน 1 action
    S-->>A: ออกเอกสารแล้ว
  end
```
