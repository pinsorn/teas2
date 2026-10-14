# ADR-0001: One React paper component renders screen and PDF; Chromium (Gotenberg) converts the print route

| Date | Status | Deciders |
|---|---|---|
| 2026-10-14 | Accepted | Orchestrator, by the pass/fail rule in the SP1ab plan approved by Ham |

## Context
SP0 §10.6 requires that what the user sees on screen is what is printed and archived. Two candidate renderers:
(A) one React paper component (`frontend/src/kit/paper/*`) shown on screen and converted to PDF by Chromium
(Gotenberg in deployed environments, via the stand-alone print route `/print/[type]/[id]`); (B) QuestPDF on the
server, with the screen showing server-rendered page images. (A) keeps a single layout source. The risk is
print fidelity: pagination, repeated header, "page x/y", signatures only on the last page, and Thai shaping
(tone marks, sara am, line breaks) in the PDF.

## What was tested
`frontend/e2e/render-spike.spec.ts` opens the print route for three issued tax invoices of the VAT company
(fictional data, seeded through the engine in `src/mocks/fixtures/documents.ts`, ids `spike-1`, `spike-25`,
`spike-60`; 1 / 25 / 60 lines, descriptions up to 300 Thai characters, mixing tone marks, sara am, long words,
dated 2025-03-14 so no other seeded document is affected). It waits for `[data-paper-ready="true"]`, counts the
on-screen `[data-paper-page]` sections, prints with `page.pdf({ format: 'A4', printBackground: true,
preferCSSPageSize: true })` and reads the PDF text per page with pdfjs-dist.

No Docker on the dev machine: Gotenberg runs on staging only. The local test uses system Chrome's print engine,
which is the same Chromium print pipeline Gotenberg drives. The Gotenberg wiring itself is NOT tested here.

## Results
| Assertion | spike-1 | spike-25 | spike-60 |
|---|---|---|---|
| PDF page count = on-screen page count | 1 = 1 | 4 = 4 | 8 = 8 |
| Page count >= expected minimum (1 / 2 / 3) | pass | pass | pass |
| Every page carries the header title "ใบกำกับภาษี" | pass | pass | pass |
| Every page carries "หน้า x/y" with the right x and y | pass | pass | pass |
| "ผู้มีอำนาจลงนาม" only on the last page | pass | pass | pass |
| Last page contains "บาท" (amount in words / total) | pass | pass | pass |

Visual check of the rendered PDFs (page 1, a middle page and the last page of each, rasterised with PyMuPDF and
viewed): tone marks and sara am render correctly; Thai lines break at word boundaries with no clipped row and no
row split across pages; the document header and the column header repeat on every page; the totals block and
the three signature lines appear only on the last page; page footer shows "หน้า x/y".

Extraction note (not a rendering defect): pdfjs returns sara am (U+0E33) as U+0E4D U+0E32, drops some stacked
tone marks and inserts spaces inside words. NFC does not fold U+0E33, so the brief's `NFC` normalisation was not
enough; the spec compares both sides after `.normalize('NFKC').replace(/\s/g, '')`. The PDF itself is correct
(viewed). Any future text-based PDF assertion must use the same normalisation.

## Decision
**Pass.** One React paper component renders screen and PDF; deployed environments convert the print route to
PDF with Gotenberg (Chromium); the Gotenberg wiring is verified in SP3.

## Consequences
- One layout source for screen, print and archive; SP1c and SP3 build further document forms as paper components.
- SP3 must verify the Gotenberg conversion (fonts available in the container, `preferCSSPageSize`, wait for
  `data-paper-ready`) against the same three spike documents.
- PDF text tests must NFKC-normalise and strip whitespace (see above); Thai text in PDFs is not searchable
  verbatim via pdfjs.
- The spike TIs remain in the mock seed as fixtures; seed-count tests exclude ids starting `spike-`.

## Spec changes (sections of SP0 or later specs updated by this ADR)
- SP0 §10.6 (Rendering): decided as above.
