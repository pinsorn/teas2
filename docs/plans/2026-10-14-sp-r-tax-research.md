# SP-R — Tri-Model Tax Research + Golden Fixtures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settle every legal rule the TEAS 2 compliance core depends on through independent research by three model
families on primary sources, and capture TEAS 1's tax outputs as golden fixtures for TEAS 2's tests.

**Architecture:** A register of 20 rules (R-01…R-20) is researched in 4 batches. For each batch, Claude, Codex and
AGY run the same prompt independently; a fresh consolidator compares the three, spot-checks a primary source per
rule, and writes one note per rule. Consensus is accepted; disagreements go to Ham. Golden fixtures are captured by a
Node script that drives a local TEAS 1 through its REST API (never SQL) and normalises ids, dates and numbers.

**Tech Stack:** Claude subagent (WebSearch / WebFetch), Codex via the `codex:codex-rescue` agent (web search on),
AGY via the `agy-runner` agent, Node 24 ESM + `node:test`, local TEAS 1 (.NET 10 API on PostgreSQL 18).

**Spec:** `docs/specs/SP0-charter.md` — §6.4 (oracle), §6.2 (invariants), §6.3 (dates), §6.5 (gap fixes G1–G4),
§6.6–6.7, §5.4, §5.11, §7.12, and every **[SP-R]** marker.

## Global Constraints

- Evidence that decides a rule: ประมวลรัษฎากร, พระราชกฤษฎีกา, กฎกระทรวง, ประกาศ/คำสั่งกรมสรรพากร, ข้อหารือกรมสรรพากร,
  พ.ร.บ.การบัญชี พ.ศ. 2543, ประกาศกรมพัฒนาธุรกิจการค้า, กฎหมายประกันสังคม. Secondary sources only point to primary ones.
- Every finding cites document, section, issuing body, effective date and URL; quotes ≤ 15 words.
- The three runs of a batch are independent: no model sees another model's output before finishing.
- Nothing secret or real-tenant goes to any model. AGY never sees secrets.
- TEAS 1 (`Y:\ClaudePlayground\TEAS-Project`) is read-only: no commits there. Local runs use a fresh database and
  create data through the API only — never SQL INSERT.
- Thai text is checked for Bengali look-alike glyphs (U+0980–U+09FF) before every commit.
- Research notes follow `docs/research/tax/_TEMPLATE.md` (from P0).

## Review Focus

1. **Outdated law** — a rule amended in 2024–2026 (VAT-rate decree, SSO wage ceiling, WHT rates) must be researched
   at its 2026-10-14 state; every note records the effective date it checked.
2. **Two models agree on a hallucinated section** — the consolidator must open at least one primary source per
   rule and confirm the cited section says what is claimed.
3. **Partial agreement hidden as consensus** — any difference in conditions, rates or timing is "Partial" and goes
   to Ham; the consolidator never averages answers.
4. **TEAS 1 "today" dates and monthly numbers** make raw outputs differ run to run — fixtures must be normalised
   (relative dates, series placeholders) so a re-run produces identical files.
5. **Polluted TEAS 1 database** — golden runs must start from an empty database; a leftover company or seed makes the
   fixtures wrong without failing loudly.

---

### Task 1: Research register and shared prompt

**Files:**
- Create: `docs/research/tax/README.md`, `docs/research/tax/PROMPT.md`

**Interfaces:**
- Produces: rule ids R-01…R-20 and batch ids B1…B4 used by Tasks 2–6; the prompt text used verbatim by all three
  models.

- [ ] **Step 1: Write the register**

```markdown
# Tax research register

| ID | Question | Spec | Batch | Status |
|---|---|---|---|---|
| R-01 | Is VAT on a tax invoice computed per line or on the invoice total, and how is it rounded to satang? Is per-line half-away-from-zero acceptable? | §6.2 I2 | B2 | open |
| R-02 | Required contents of a full tax invoice (ม.86/4), including the buyer TIN + head-office/branch rule for VAT-registered and other buyers; who may use the label "ใบกำกับภาษี"; copies | §6.2 I3 | B1 | open |
| R-03 | Serial-number rules for tax invoices and receipts (เล่มที่/เลขที่): gaps, cancelled numbers, monthly vs continuous series, per-branch series | §6.2 I4, §5.14 | B1 | open |
| R-04 | Retention periods for accounting and tax documents (พ.ร.บ.การบัญชี, ประมวลรัษฎากร), immutability of electronic records, how recorded entries may be corrected | §6.2 I5, §7.12 | B4 | open |
| R-05 | Input VAT: claim window and month, vendor not VAT-registered, forbidden input VAT (ม.82/5) and its treatment as cost, documents that qualify | §6.2 I6 | B2 | open |
| R-06 | WHT: rates by income type for companies vs individuals, payer modes incl. gross-up once vs every time, routing to ภ.ง.ด.2/3/53, 50 ทวิ contents incl. the "ลำดับที่ ในแบบ" box, deadlines | §6.2 I7 | B3 | open |
| R-07 | Reverse charge ม.83/6: when VAT on imported services is due, ภ.พ.36 filing, whether and in which month it is claimable as input VAT in ภ.พ.30 | §6.2 I8, §6.5 G2 | B2 | open |
| R-08 | Cancelling and reissuing a wrong tax invoice / receipt (what may change, date of the new one, reference wording); CN/DN conditions ม.86/9–86/10 (reasons, contents, caps vs the original, timing) | §6.2 I9, §6.5 G3 | B1 | open |
| R-09 | Tax point (ม.78, ม.78/1) for goods and services, deposits and advance payments, instalments; when the tax invoice must be issued | §6.3, §5.11 | B1 | open |
| R-10 | VAT registration threshold (ม.85/1): amount, which revenue counts, when to register; what a non-VAT company should monitor | §6.5 G1 | B2 | open |
| R-11 | Must a juristic person recognise revenue and expenses on an accrual basis (ม.65 and related rules)? Consequences for invoice-time revenue | §6.5 G1, §5.12 | B4 | open |
| R-12 | Excess input VAT in ภ.พ.30: carry forward vs cash refund, how the next month's return shows it | §6.5 G2 | B2 | open |
| R-13 | Payroll: PIT withholding method under ม.50(1), 2026 personal allowances, SSO contribution rate and wage ceiling in 2026, ภ.ง.ด.1/1ก deadlines, 50 ทวิ for employees | §6.2 I11 | B3 | open |
| R-14 | CIT: rates, SME criteria and brackets, ภ.ง.ด.51 half-year estimate and the under-estimate penalty, 5-year loss carry-forward | §6.2 I11 | B4 | open |
| R-15 | DBD prescribed financial-statement format for NPAEs (line items) and its relation to the ภ.ง.ด.50 schedules; account classes needed | §5.4 | B4 | open |
| R-16 | Selling a used fixed asset: VAT and tax-invoice duty for a VAT-registered company; depreciation rules (ม.65 ทวิ(2), rate caps) and first-month proration | §6.5 G4 | B4 | open |
| R-17 | May a tax invoice be dated earlier than the day it is issued? Back-dating / late-issue rules and consequences; relation to the tax point | §6.3 | B1 | open |
| R-18 | Current RD Prep "Format กลาง" layouts for ภ.ง.ด.3, ภ.ง.ด.53, ภ.พ.30 and the SSO e-Service upload format (สปส.1-10) | §6.7 | B4 | open |
| R-19 | Payments abroad (ม.70): ภ.ง.ด.54 rates, treaty relief, gross-up; interaction with ภ.พ.36 | §6.2 I7 | B3 | open |
| R-20 | Current VAT rate, the decree that sets it and its expiry; how rate changes are announced (for effective-dated tax tables) | §6.6 | B2 | open |

Batches: **B1** VAT documents (R-02, R-03, R-08, R-09, R-17) · **B2** VAT returns (R-01, R-05, R-07, R-10, R-12, R-20)
· **B3** WHT and payroll (R-06, R-13, R-19) · **B4** accounting, CIT and formats (R-04, R-11, R-14, R-15, R-16, R-18).
```

- [ ] **Step 2: Write the shared prompt**

```markdown
# Research prompt (identical for Claude, Codex and AGY)

You are researching Thai tax and accounting law for the specification of an accounting system used by Thai SMEs
(VAT-registered and non-registered companies). Answer as of 2026-10-14.

Answer each rule below separately, with these sections:
1. **Answer** — the rule in plain terms, with conditions and exceptions.
2. **Legal basis** — for each source: document name in Thai, section/clause, issuing body, date and effective date,
   URL. Quote at most one short phrase (≤ 15 words) per source, only when wording matters.
3. **Amendments** — amendments from 2020 to 2026 and whether they change the answer.
4. **Software implications** — what the system must enforce: inputs, calculations, validations, dates.
5. **Confidence** — High / Medium / Low, and what would change your answer.
6. **Open points** — what the sources leave undecided.

Rules:
- Primary sources decide: ประมวลรัษฎากร, พระราชกฤษฎีกา, กฎกระทรวง, ประกาศ/คำสั่งกรมสรรพากร, ข้อหารือกรมสรรพากร,
  พ.ร.บ.การบัญชี พ.ศ. 2543, ประกาศกรมพัฒนาธุรกิจการค้า, กฎหมายประกันสังคม. Blogs and firm articles may only lead you
  to primary sources.
- Never invent a section number. If you cannot find the primary text, say so and lower your confidence.
- Write in English; keep Thai legal terms in Thai.

## Rules for this batch
{RULES}  ← paste the rows of this batch from docs/research/tax/README.md, one per line: "R-NN — question"
```

- [ ] **Step 3: Commit**

```bash
git add docs/research/tax/README.md docs/research/tax/PROMPT.md
git commit -m "docs(research): tax research register R-01..R-20 and shared prompt"
```

---

### Tasks 2–5: Research batches B1, B2, B3, B4 (one task per batch, same procedure)

Run each batch as its own task, in order B1 → B2 → B3 → B4. The procedure is identical; only `{BATCH}` and the
rules change.

**Files (per batch):**
- Create: `docs/research/tax/raw/{BATCH}/claude.md`, `.../codex.md`, `.../agy.md` (raw outputs, kept for audit)
- Create: `docs/research/tax/R-NN-<slug>.md` for every rule of the batch
- Modify: `docs/research/tax/README.md` (status column)

**Interfaces:**
- Consumes: `PROMPT.md`, the register rows of the batch.
- Produces: one note per rule with status `Consensus` or `Disagree → Ham`; Task 6 reads every `Disagree`.

- [ ] **Step 1: Build the batch prompt**

Copy `PROMPT.md`, replace `{RULES}` with the batch's rows. Save it as `docs/research/tax/raw/{BATCH}/prompt.md`.

- [ ] **Step 2: Dispatch the three runs in parallel (independent)**

| Run | Agent | Instruction beyond the prompt | Output |
|---|---|---|---|
| Claude | `general-purpose`, model `sonnet` | "Use WebSearch and WebFetch. Write only `docs/research/tax/raw/{BATCH}/claude.md`. No other writes, no test runs." | `claude.md` |
| Codex | `codex:codex-rescue` | "Research task, web search enabled (`--search`). Write the answer to `codex-out/{BATCH}.md` only (pass `--write`)." Then copy to `raw/{BATCH}/codex.md`. | `codex.md` |
| AGY | `agy-runner` | "Web research task. Return the full answer as text." The orchestrator saves the text to `raw/{BATCH}/agy.md`. | `agy.md` |

Each run receives only `prompt.md`. Expected: three files, each with a section per rule.

- [ ] **Step 3: Consolidate (fresh agent)**

Dispatch `general-purpose`, model `opus`, with: "Read `raw/{BATCH}/claude.md`, `codex.md`, `agy.md`. For each rule
write `docs/research/tax/R-NN-<slug>.md` from `_TEMPLATE.md`. Fill the verdicts table from the three files. Mark
Agreement **Agree** only if rate, conditions, timing and legal basis all match; any difference is **Partial** or
**Disagree**. For every rule open at least one cited primary source with WebFetch and record what it says (section,
≤ 15-word quote, URL) under 'Primary-source spot check'; if the citation is wrong, say so. Never average answers.
Write only those note files."

- [ ] **Step 4: Verify the notes**

```bash
ls docs/research/tax/R-*.md | wc -l          # expected: running total of researched rules
grep -L "Primary-source spot check" docs/research/tax/R-*.md   # expected: no output
node -e "const fs=require('fs');for(const f of fs.readdirSync('docs/research/tax').filter(n=>n.startsWith('R-'))){const s=fs.readFileSync('docs/research/tax/'+f,'utf8');const b=[...s.matchAll(/[\u0980-\u09FF]/g)].length;if(b)console.log(f,'bengali',b)}"
```
Expected: no file without a spot check; no Bengali glyphs.

- [ ] **Step 5: Update the register and commit**

Set each rule's status to `Consensus` or `Disagree → Ham`.

```bash
git add docs/research/tax
git commit -m "docs(research): batch {BATCH} tri-model research notes"
```

---

### Task 6: Ham rulings on disagreements

**Files:**
- Modify: every `docs/research/tax/R-NN-*.md` with status `Disagree → Ham` or `Partial`
- Create (only when a ruling changes SP0): `docs/adr/0002-<slug>.md` (ADR-0001 is reserved for the SP1 rendering
  decision)

- [ ] **Step 1: Prepare one decision list for Ham**

For each open rule: the question, each model's answer in one line, the primary source that the spot check found,
and the consolidator's recommendation. Present them together with AskUserQuestion (one question per rule, options =
the competing answers + "research more").

- [ ] **Step 2: Record each ruling**

Fill "Outcome" with the ruling, date and reason; set status `Ham ruling`. "Research more" → re-run that rule alone
through Tasks 2–5 Steps 2–4 with the specific doubt added to the prompt.

- [ ] **Step 3: ADR for spec-changing rulings, then commit**

```bash
git add docs/research/tax docs/adr
git commit -m "docs(research): record Ham rulings on disputed tax rules"
```

---

### Task 7: Golden scenario catalogue

**Files:**
- Create: `fixtures/golden/scenarios.json`, `fixtures/golden/README.md`

**Interfaces:**
- Consumes: `frontend/src/mocks/fixtures/companies.json` — created by SP1ab Task 2 Step 7 (run that step first if
  the file is absent); the golden runs use the same two fictional companies as the mockup.
- Produces: scenario ids S-01…S-18 consumed by Tasks 8–10 and, later, by TEAS 2 backend tests.

- [ ] **Step 1: Write `fixtures/golden/scenarios.json`**

```json
{
  "version": 1,
  "companies": "frontend/src/mocks/fixtures/companies.json",
  "parties": {
    "C-001": { "kind": "customer", "name": "บริษัท นาวาพาณิชย์ จำกัด", "taxId": "0105568024684", "branchCode": "00000", "vatRegistered": true, "type": "juristic" },
    "C-002": { "kind": "customer", "name": "นายสมชาย ใจดี", "taxId": "3100600123450", "vatRegistered": false, "type": "individual" },
    "C-003": { "kind": "customer", "name": "Pacific Bay Trading Pte. Ltd.", "foreign": true, "vatRegistered": false, "type": "juristic" },
    "V-001": { "kind": "vendor", "name": "บริษัท ศิลาเครื่องเขียน จำกัด", "taxId": "0105567011228", "branchCode": "00000", "vatRegistered": true, "type": "juristic" },
    "V-002": { "kind": "vendor", "name": "นางสาวมาลี ศรีสุข", "taxId": "1102003456781", "vatRegistered": false, "type": "individual" },
    "V-003": { "kind": "vendor", "name": "บริษัท ชลธีขนส่ง จำกัด", "taxId": "0105566033449", "branchCode": "00000", "vatRegistered": true, "type": "juristic" },
    "V-004": { "kind": "vendor", "name": "CloudNine Software Inc.", "foreign": true, "vatRegistered": false, "type": "juristic", "country": "US" },
    "V-005": { "kind": "vendor", "name": "ร้านป้าแดงอาหาร", "taxId": "3601000555665", "vatRegistered": false, "type": "individual" },
    "E-001": { "kind": "employee", "name": "นายวีระ ทองดี", "taxId": "1100500222336", "monthlySalary": "45000.00", "hiredDay": 1 },
    "E-002": { "kind": "employee", "name": "นางสาวพิมพ์ใจ แสงทอง", "taxId": "1201100778892", "monthlySalary": "30000.00", "hiredDay": 16 }
  },
  "scenarios": [
    { "id": "S-01", "company": "vat", "title": "TI, 1 line, standard 7%, exclusive",
      "steps": [{ "op": "create-and-post", "doc": "tax-invoice", "party": "C-001", "lines": [{ "desc": "ออกแบบอัตลักษณ์องค์กร", "qty": "1", "unitPrice": "60000.00", "tax": "standard" }] }],
      "capture": ["journal", "output-vat-register"] },
    { "id": "S-02", "company": "vat", "title": "TI, mixed standard / zero-rated / exempt lines",
      "steps": [{ "op": "create-and-post", "doc": "tax-invoice", "party": "C-003", "lines": [
        { "desc": "งานออกแบบส่งออก", "qty": "1", "unitPrice": "25000.00", "tax": "zero" },
        { "desc": "หนังสือคู่มือแบรนด์", "qty": "10", "unitPrice": "350.00", "tax": "exempt" },
        { "desc": "ค่าที่ปรึกษา", "qty": "2", "unitPrice": "7500.00", "tax": "standard" }] }],
      "capture": ["journal", "output-vat-register"] },
    { "id": "S-03", "company": "vat", "title": "TI rounding edges: half-satang, thirds, line discount",
      "steps": [{ "op": "create-and-post", "doc": "tax-invoice", "party": "C-001", "lines": [
        { "desc": "สติกเกอร์", "qty": "3", "unitPrice": "0.15", "tax": "standard" },
        { "desc": "งานแบ่งสามงวด", "qty": "1", "unitPrice": "33.33", "tax": "standard" },
        { "desc": "แฟ้มเอกสาร", "qty": "7", "unitPrice": "12.35", "discountPct": "12.5", "tax": "standard" }] }],
      "capture": ["journal", "document-totals"] },
    { "id": "S-04", "company": "vat", "title": "TI, VAT-inclusive pricing",
      "steps": [{ "op": "create-and-post", "doc": "tax-invoice", "party": "C-002", "priceIncludesVat": true, "lines": [{ "desc": "ชุดโปสเตอร์", "qty": "1", "unitPrice": "100.00", "tax": "standard" }] }],
      "capture": ["journal", "document-totals"] },
    { "id": "S-05", "company": "vat", "title": "Receipt for S-01 with customer WHT 3%",
      "steps": [{ "op": "receipt-for", "of": "S-01", "whtPct": "3" }],
      "capture": ["journal", "wht-receivable-register"] },
    { "id": "S-06", "company": "vat", "title": "Cancel and reissue a TI (same total)",
      "steps": [{ "op": "create-and-post", "doc": "tax-invoice", "party": "C-001", "lines": [{ "desc": "พิมพ์แผ่นพับ", "qty": "500", "unitPrice": "8.00", "tax": "standard" }] },
                { "op": "cancel-and-reissue", "reason": "แก้ชื่อผู้ซื้อ" }],
      "capture": ["journal", "output-vat-register"] },
    { "id": "S-07", "company": "vat", "title": "Credit note against S-02 (partial)",
      "steps": [{ "op": "credit-note", "of": "S-02", "amount": "5000.00", "reason": "ลดราคาเนื่องจากงานล่าช้า" }],
      "capture": ["journal", "output-vat-register"] },
    { "id": "S-08", "company": "vat", "title": "Vendor invoice (recoverable VAT) + PV, WHT 1% deduct",
      "steps": [{ "op": "vendor-invoice-and-post", "party": "V-003", "lines": [{ "desc": "ค่าขนส่ง", "amount": "20000.00", "vatPct": "7", "recoverable": true }] },
                { "op": "payment-voucher-for", "of": "previous", "whtType": "transport-1", "mode": "deduct" }],
      "capture": ["journal", "input-vat-register", "wht-certificate"] },
    { "id": "S-09", "company": "vat", "title": "PV to an individual, WHT 3%, gross-up once",
      "steps": [{ "op": "payment-voucher", "party": "V-002", "lines": [{ "desc": "ค่าจ้างออกแบบภาพประกอบ", "amount": "10000.00" }], "whtType": "service-3", "mode": "gross-up-once" }],
      "capture": ["journal", "wht-certificate"] },
    { "id": "S-10", "company": "vat", "title": "PV to an individual, WHT 3%, gross-up every time",
      "steps": [{ "op": "payment-voucher", "party": "V-002", "lines": [{ "desc": "ค่าจ้างถ่ายภาพ", "amount": "8000.00" }], "whtType": "service-3", "mode": "gross-up-forever" }],
      "capture": ["journal", "wht-certificate"] },
    { "id": "S-11", "company": "vat", "title": "Foreign software service: ภ.ง.ด.54 + ภ.พ.36",
      "steps": [{ "op": "vendor-invoice-and-post", "party": "V-004", "lines": [{ "desc": "Design software subscription", "amount": "12000.00", "vatPct": "0", "recoverable": false }] },
                { "op": "payment-voucher-for", "of": "previous", "whtType": "foreign-royalty-15", "mode": "deduct", "reverseCharge": true }],
      "capture": ["journal", "wht-certificate", "pp36"] },
    { "id": "S-12", "company": "vat", "title": "Non-VAT vendor + forbidden input VAT (entertainment)",
      "steps": [{ "op": "vendor-invoice-and-post", "party": "V-005", "lines": [{ "desc": "ค่ารับรองลูกค้า", "amount": "3210.00", "vatPct": "0", "recoverable": false }] }],
      "capture": ["journal", "input-vat-register"] },
    { "id": "S-13", "company": "nonvat", "title": "Invoice (accrual) + receipt",
      "steps": [{ "op": "billing-note-issue", "party": "C-002", "lines": [{ "desc": "ข้าวกล่องจัดเลี้ยง", "qty": "120", "unitPrice": "65.00" }] },
                { "op": "receipt-for", "of": "previous" }],
      "capture": ["journal"] },
    { "id": "S-14", "company": "nonvat", "title": "Standalone receipt (TEAS 1 cash-basis path, G1 delta)",
      "steps": [{ "op": "standalone-receipt", "party": "C-002", "lines": [{ "desc": "ขนมไทยชุดของฝาก", "qty": "40", "unitPrice": "120.00" }] }],
      "capture": ["journal"], "teas2Delta": "G1: revenue recognised at invoice; TEAS 2 has no cash-basis path" },
    { "id": "S-15", "company": "vat", "title": "Payroll month: full month + mid-month hire",
      "steps": [{ "op": "payroll-run", "employees": ["E-001", "E-002"] }],
      "capture": ["journal", "pnd1", "sso"] },
    { "id": "S-16", "company": "vat", "title": "Fixed asset: buy, depreciate 2 months, dispose",
      "steps": [{ "op": "asset-acquire", "party": "V-001", "desc": "เครื่องพิมพ์ดิจิทัล", "cost": "180000.00", "lifeYears": 5, "acquireDay": 10 },
                { "op": "depreciation-run", "months": 2 },
                { "op": "asset-dispose", "price": "150000.00" }],
      "capture": ["journal"], "teas2Delta": "G4: the sale issues a TI with output VAT" },
    { "id": "S-17", "company": "vat", "title": "Month returns over S-01..S-12",
      "steps": [{ "op": "preview-filings", "forms": ["pnd30", "pnd3", "pnd53", "pnd54", "pp36"] }],
      "capture": ["pnd30", "pnd3", "pnd53", "pnd54", "pp36"], "teas2Delta": "G2: ภ.พ.36 VAT appears as input VAT" },
    { "id": "S-18", "company": "vat", "title": "Expense claim with forbidden input VAT",
      "steps": [{ "op": "expense-claim-pay", "employee": "E-001", "lines": [{ "desc": "ค่ารับรองลูกค้า", "amount": "1070.00", "vatPct": "7", "recoverable": false }] }],
      "capture": ["journal"] }
  ]
}
```

- [ ] **Step 2: Write `fixtures/golden/README.md`**

```markdown
# Golden fixtures

`scenarios.json` defines the scenarios; `teas1/S-NN.json` holds TEAS 1 v2.5.0 outputs captured by
`tools/golden-capture`. TEAS 2 tests must reproduce them exactly, except where a scenario carries `teas2Delta` or a
research note (`docs/research/tax/R-NN-*.md`) changes the expected value — those expectations live in
`teas2-expected/S-NN.json`. Dates are relative (`D+0` = the run day) and document numbers are series placeholders
(`{TI}#1`), so re-runs produce identical files.
```

- [ ] **Step 3: Validate checksums and commit**

```bash
node -e "
const s=require('./fixtures/golden/scenarios.json');
const ok=t=>{const d=t.split('').map(Number);const sum=d.slice(0,12).reduce((a,x,i)=>a+x*(13-i),0);return (11-sum%11)%10===d[12];};
for(const [k,p] of Object.entries(s.parties)) if(p.taxId&&!ok(p.taxId)) {console.error('bad TIN',k);process.exit(1);}
console.log('TINs ok', s.scenarios.length, 'scenarios');"
git add fixtures/golden/scenarios.json fixtures/golden/README.md
git commit -m "test(golden): scenario catalogue S-01..S-18"
```
Expected: `TINs ok 18 scenarios`.

---

### Task 8: Golden capture tool

**Files:**
- Create: `tools/golden-capture/normalize.mjs`, `tools/golden-capture/normalize.test.mjs`
- Create: `tools/golden-capture/teas1-client.mjs`, `tools/golden-capture/endpoints.mjs`,
  `tools/golden-capture/scenarios.mjs`, `tools/golden-capture/run.mjs`

**Interfaces:**
- Produces: `normalize(output, ctx) → object` (pure); `run.mjs` CLI:
  `node tools/golden-capture/run.mjs --base http://localhost:5080 --only S-01,S-02` writing
  `fixtures/golden/teas1/S-NN.json` and `fixtures/golden/teas1/pdf/*.pdf`.
- Consumes: env `TEAS1_ADMIN_USER`, `TEAS1_ADMIN_PASSWORD` (never committed).

- [ ] **Step 1: Write the failing normaliser test**

```js
// tools/golden-capture/normalize.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from './normalize.mjs';

const ctx = { runDate: '2026-10-14', series: new Map() };

test('dates become offsets from the run day', () => {
  assert.deepEqual(normalize({ docDate: '2026-10-14', dueDate: '2026-11-13' }, ctx),
    { docDate: 'D+0', dueDate: 'D+30' });
});

test('document numbers become per-prefix placeholders, stable across calls', () => {
  const c = { runDate: '2026-10-14', series: new Map() };
  const out = normalize({ a: '10-2026-TI-0007', b: '10-2026-TI-0008', c: '10-2026-TI-0007', d: '10-2026-RC-0002' }, c);
  assert.deepEqual(out, { a: '{TI}#1', b: '{TI}#2', c: '{TI}#1', d: '{RC}#1' });
});

test('ids, timestamps and versions are dropped; money strings are kept', () => {
  const out = normalize({ id: 991, companyId: 3, createdAt: '2026-10-14T09:01:02+07:00', version: 4, amount: '64200.00' }, ctx);
  assert.deepEqual(out, { amount: '64200.00' });
});

test('arrays are normalised element-wise and keep order', () => {
  const out = normalize({ lines: [{ id: 1, debit: '64200.00' }, { id: 2, credit: '60000.00' }] }, ctx);
  assert.deepEqual(out, { lines: [{ debit: '64200.00' }, { credit: '60000.00' }] });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/golden-capture/normalize.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the normaliser**

```js
// tools/golden-capture/normalize.mjs
const DROP = new Set(['id', 'companyId', 'createdAt', 'updatedAt', 'postedAt', 'version', 'rowVersion', 'traceId', 'createdBy', 'updatedBy']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOCNO = /^\d{2}-\d{4}-([A-Z]{2,5})(?:-[A-Z0-9-]+)?-\d{4,6}$/;

const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

function normValue(v, ctx) {
  if (typeof v !== 'string') return v;
  if (DATE.test(v)) { const d = dayDiff(ctx.runDate, v); return `D${d >= 0 ? '+' : ''}${d}`; }
  const m = v.match(DOCNO);
  if (m) {
    const prefix = m[1];
    if (!ctx.series.has(v)) {
      const n = [...ctx.series.values()].filter((x) => x.startsWith(`{${prefix}}#`)).length + 1;
      ctx.series.set(v, `{${prefix}}#${n}`);
    }
    return ctx.series.get(v);
  }
  return v;
}

export function normalize(value, ctx) {
  if (Array.isArray(value)) return value.map((x) => normalize(x, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP.has(k) || k.endsWith('Id') && typeof v === 'number') continue;
      out[k] = normalize(v, ctx);
    }
    return out;
  }
  return normValue(value, ctx);
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tools/golden-capture/normalize.test.mjs`
Expected: 4 pass.

- [ ] **Step 5: Map the TEAS 1 endpoints**

Write `tools/golden-capture/endpoints.mjs` exporting one object `E` with every route the runner needs. Fill it from
`Y:\ClaudePlayground\TEAS-Project\backend\src\Accounting.Api\Endpoints\*.cs` and `docs\api\openapi.yaml`. Known
groups: `/auth`, `/companies`, `/customers`, `/vendors`, `/products`, `/employees`, `/tax-invoices`
(`POST /tax-invoices`, `POST /tax-invoices/{id}/post`, `GET /tax-invoices/{id}`), `/receipts`
(`POST /receipts`, `POST /receipts/{id}/post`), `/billing-notes`, `/tax-adjustment-notes`, `/vendor-invoices`,
`/payment-vouchers`, `/wht-certificates`, `/expense-claims`, `/fixed-assets`, `/depreciation-runs`,
`/payroll/runs`, `/journals`, `/reports` (`/reports/output-vat-register`, `/reports/input-vat-register`),
`/tax-filings` (`POST /tax-filings/pnd30|pnd3|pnd53|pnd54|pnd36` preview, `GET /tax-filings/{form}/pdf`),
`/wht-receivable-register`. Verify each GET route with one authenticated call and record the HTTP status in a comment
next to it.

- [ ] **Step 6: Write the client, scenario runners and CLI**

- `teas1-client.mjs`: `login(base, user, password) → token`; `call(method, path, body?) → json` with
  `Authorization: Bearer`, `Idempotency-Key: crypto.randomUUID()` on POST, throws with status + problem body on ≥ 400.
- `scenarios.mjs`: one async function per `op` in `scenarios.json` (`create-and-post`, `receipt-for`,
  `cancel-and-reissue`, `credit-note`, `vendor-invoice-and-post`, `payment-voucher-for`, `payment-voucher`,
  `billing-note-issue`, `standalone-receipt`, `payroll-run`, `asset-acquire`, `depreciation-run`, `asset-dispose`,
  `preview-filings`, `expense-claim-pay`), each returning the created document ids so later steps (`"of": "S-01"`,
  `"of": "previous"`) can refer to them.
- `run.mjs`: parse args, read `frontend/src/mocks/fixtures/companies.json` + `scenarios.json`, create both
  companies and all parties
  through the API (onboarding / company endpoints, never SQL), run scenarios in order, collect each `capture` item
  (journal lines of the scenario's documents, register rows, filing preview payloads, certificate data), normalise
  with one shared `ctx`, write `fixtures/golden/teas1/S-NN.json` as
  `{ "scenario": "S-NN", "teas1": { "version": "<from /system/info>", "commit": "712db15" }, "outputs": { ... } }`,
  and save RD PDFs (`pnd30`, `pnd3`, `pnd53`, `pp36`, WT certificate, payslip) to `fixtures/golden/teas1/pdf/`.

- [ ] **Step 7: Commit**

```bash
git add tools/golden-capture
git commit -m "test(golden): TEAS 1 capture tool with normaliser"
```

---

### Task 9: Boot a clean TEAS 1 locally and capture

**Files:**
- Create: `fixtures/golden/teas1/S-01.json` … `S-18.json`, `fixtures/golden/teas1/pdf/*.pdf`

- [ ] **Step 1: Create an empty database**

```powershell
& "S:\Program Files\PostgreSQL\18\bin\psql.exe" -h localhost -U postgres -c "CREATE DATABASE teas_golden OWNER accounting;"
```
Use `postgres` or any local role with CREATEDB; if neither password is known, ask Ham — do not reset passwords.
Expected: `CREATE DATABASE`. Use a new name if it exists (`teas_golden2`) — never reuse a populated database.

- [ ] **Step 2: Boot TEAS 1 against it**

Read `Y:\ClaudePlayground\TEAS-Project\README.md` §การติดตั้ง and `troubles-wiki.md` (grep `boot`, `seed`, `onboard`)
first. Then:

```powershell
cd "Y:\ClaudePlayground\TEAS-Project\backend"
$env:ASPNETCORE_ENVIRONMENT='Development'; $env:ASPNETCORE_URLS='http://localhost:5080'
$env:ConnectionStrings__Postgres="Host=localhost;Port=5432;Database=teas_golden;Username=accounting;Password=$env:TEAS1_DEV_DB_PASSWORD"
# TEAS1_DEV_DB_PASSWORD = the local dev password documented in TEAS-Project/README.md step 1
$env:SeedDemoData='false'
dotnet run --project src\Accounting.Api
```
Run it in the background; poll `http://localhost:5080/health` until 200. Expected: migrations and bootstrap scripts
applied once, no demo companies.

- [ ] **Step 3: Create the super-admin through onboarding**

Use the onboarding endpoint (per README: a clean install starts in the onboarding wizard). Store the chosen
credentials in the shell env (`TEAS1_ADMIN_USER`, `TEAS1_ADMIN_PASSWORD`) only.

- [ ] **Step 4: Run the capture twice and compare**

```bash
node tools/golden-capture/run.mjs --base http://localhost:5080
cp -r fixtures/golden/teas1 "$SCRATCH/run1"
# drop and recreate teas_golden, reboot TEAS 1, repeat onboarding, then:
node tools/golden-capture/run.mjs --base http://localhost:5080
diff -r "$SCRATCH/run1" fixtures/golden/teas1 --exclude=pdf
```
Expected: no differences (Review Focus 4). Any difference = a normaliser gap → fix in Task 8 and re-run.

- [ ] **Step 5: Stop TEAS 1 and commit**

```bash
git add fixtures/golden/teas1
git commit -m "test(golden): capture TEAS 1 v2.5.0 outputs for S-01..S-18"
```

---

### Task 10: TEAS 2 expected values (deltas)

**Files:**
- Create: `fixtures/golden/teas2-expected/S-NN.json` for every scenario whose expected TEAS 2 output differs
  (at least S-14, S-16, S-17; plus any scenario a research note changes)

- [ ] **Step 1: List the deltas**

For each scenario with `teas2Delta`, and for each research note whose "Implementation consequences" names a
scenario, write the TEAS 2 expected output in the same shape as the TEAS 1 file, with a `"because"` field citing
`G1`–`G4` or `R-NN`.

- [ ] **Step 2: Review with a fresh agent**

Dispatch `opus-reviewer`: "Check every file in `fixtures/golden/teas2-expected/` against the cited research note and
SP0 §6.5. Dr = Cr per entry; VAT and WHT arithmetic; dates and forms. Report mismatches; do not edit." Fix what it
confirms.

- [ ] **Step 3: Commit**

```bash
git add fixtures/golden/teas2-expected
git commit -m "test(golden): TEAS 2 expected values for G1-G4 and research deltas"
```

---

### Task 11: Close SP-R

**Files:**
- Modify: `docs/specs/SP0-charter.md` (§6.2 "Source" column: add the R-ids; remove each resolved `[SP-R]` marker
  or replace it with a link to its note), `STATUS.md`, `docs/research/tax/README.md`

- [ ] **Step 1: Link the spec to the notes**

Every `[SP-R]` in SP0 becomes `[R-NN](../research/tax/R-NN-<slug>.md)` once its note is `Consensus` or
`Ham ruling`. A marker whose rule changed the spec gets the ADR link as well.

- [ ] **Step 2: Verify nothing is left open**

```bash
grep -c "\[SP-R" docs/specs/SP0-charter.md     # expected: 0
grep -E "\| (open|Researching|Disagree)" docs/research/tax/README.md   # expected: no output
```

- [ ] **Step 3: Commit**

```bash
git add docs/specs/SP0-charter.md docs/research/tax/README.md STATUS.md
git commit -m "docs: close SP-R — research notes linked from SP0, golden fixtures captured"
```
