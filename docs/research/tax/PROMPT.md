# Research prompt (identical for Claude, Codex and Gemini)

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
