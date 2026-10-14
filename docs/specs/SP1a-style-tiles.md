# SP1a — Visual direction (style tiles)

| | |
|---|---|
| Status | Approved 2026-10-14 (Ham) |
| Owner | Ham |
| Implements | `docs/specs/SP0-charter.md` (visual direction); feeds SP1b design-system kit (Task 9) |
| Blast cap | 1 spec · 1 page · 6 files in `frontend/src/style-tiles/` + e2e + vitest — no change to global tokens |
| Chosen tile | **B — Continuity** |

## Goal
Three genuinely different, production-credible visual directions for TEAS 2, shown on the same four surfaces with real
shadcn components and engine/fixture data, so the owner can pick one. Task 9 turns the pick into the design system.

## Research (Lazyweb desktop references, 2026-10-14)
Thai products FlowAccount, PEAK and Xero/QuickBooks are not indexed by Lazyweb; the closest indexed references were used
(query -> product -> what it taught):
- "accounting invoice editor line items totals" -> **Accrual**: invoice form on the left, live document on the right;
  **FreshBooks**: plain form, purple accent, line-item grid. Lesson: editor and paper are one object (drives C's split).
- "invoice list table status chips" -> **Midday**, **Square**, **Remote**, **PayPal**, **Kitch**: status as a chip in a
  dedicated column, amount right-aligned, filter row above, row actions hidden until needed. Lesson: chip + text label,
  number column right-aligned and tabular (all three tiles).
- "QuickBooks invoice" / "Xero" -> **Midday** invoice view, **Mercury** invoice review: restrained monochrome with one accent;
  money is the loudest element. Lesson: one accent, quiet chrome.
Thai-specific inputs not covered by the references: stacked tone marks need line-height >= 1.5 and a Thai-capable UI face;
Buddhist-era dates and baht text are first-class on every surface.

## Directions
Common to all: Sarabun on the A4 paper (screen = paper), paper identical on every tile; status chips always carry a Thai
text label (never colour alone); VAT 7% with net + vat = total on every shown figure (from the mock engine, checked by
`src/style-tiles/tokens.test.ts`).

### A — บัญชีแยกประเภท (Ledger)
Paper-white, deep green ink and accent, hairline rules, square-ish chips, double rule above the grand total, compact.
| | |
|---|---|
| Fonts | IBM Plex Sans Thai (UI), Sarabun (paper) |
| Scale | 22/29 600 · 16/25 600 · 14/22 400 · 12.5/19 400 |
| Radius / row / control | 6px / 36px / 32px |
| Focus | 2px solid green, 2px offset, no shadow |
| Chips | radius 3, text only |

### B — TEAS ต่อเนื่อง (Continuity)
TEAS 1's peach + warm ink, modernised: TEAS 1's CTA peach `#DD8E5C` fails AA with white text, so the accent is TEAS 1's
`peach-700` `#9E5C34` (5.21:1). Tinted page, white cards with a one-pixel shadow, peach band.
| | |
|---|---|
| Fonts | Noto Sans Thai (UI), Sarabun (paper) |
| Scale | 24/31 600 · 17/26 600 · 15/23 400 · 13/20 400 |
| Radius / row / control | 10px (panels 14) / 40px / 40px |
| Focus | 3px solid peach, 2px offset |
| Chips | radius 6, text only |

### C — สตูดิโอแยกจอ (Studio) — designer's proposal
Cool graphite + indigo, mono tabular figures, floating panels, airy 48px rows with soft zebra, pill chips with a dot, a
dark title band. Argument: the references (Accrual, Midday, Mercury) converge on editor + live document side by side and
on money as the loudest element; a mono figure column makes amounts scan like a ledger without ledger lines, and the
cool hue keeps it visibly apart from both the green of A and the warm TEAS 1 line of B. The 48px rows and 18px panels
suit tablet use and give Thai tone marks room, at the price of density (about 25% fewer rows per screen than A).
| | |
|---|---|
| Fonts | Anuphan (UI), JetBrains Mono (figures), Sarabun (paper) — 3 families |
| Scale | 26/34 600 · 18/28 600 · 15/23 400 · 13/20 400 |
| Radius / row / control | 12px (panels 18) / 48px / 44px |
| Focus | 2px solid indigo + 5px 20% indigo halo |
| Chips | pill, dot + text |

## Colour tokens and contrast (computed, WCAG 2.x; exact values also in `tokens.ts` / `tokens-<id>.css`)
**A** — bg `#FFFFFF` · sub `#F4F6F4` · ink `#14211B` · muted `#4A5A52` · rule `#D3DAD5` · accent `#0F5B3F` · soft `#E1F0E8` · input border `#788880`
| Pair | Ratio |
|---|---|
| ink/bg · ink/sub | 16.63 · 15.31 |
| muted/bg · muted/sub · muted/soft | 7.30 · 6.72 · 6.20 |
| white/accent · accent/bg · accent/soft | 8.11 · 8.11 · 6.89 |
| input border/bg (UI 3:1) | 3.73 |
| chips draft · issued · partly · settled · overdue · cancelled | 7.76 · 7.73 · 6.36 · 7.01 · 6.67 · 7.10 |

**B** — bg `#FAF8F5` · surface `#FFFFFF` · ink `#1A1816` · muted `#5F5A54` · rule `#D7D1C7` · accent `#9E5C34` · soft `#F8E3D0` · accent-ink `#86492A`
| Pair | Ratio |
|---|---|
| ink/bg · ink/surface · ink/soft | 16.70 · 17.70 · 14.24 |
| muted/bg · muted/surface | 6.44 · 6.82 |
| white/accent · accent/bg | 5.21 · 4.91 |
| accent-ink/soft (accent text on tint; `#9E5C34` itself gives 4.19, fails) | 5.63 |
| accent/surface (focus ring, UI 3:1) | 5.21 |
| chips draft · issued · partly · settled · overdue · cancelled | 7.26 · 5.59 · 5.55 · 5.85 · 5.47 · 5.14 |

**C** — bg `#F3F4F8` · surface `#FFFFFF` · ink `#151A2C` · muted `#4C5470` · rule `#D5D9E6` · accent `#4338CA` · soft `#E6E7FB` · input border `#7C86A6` · band `#151A2C`
| Pair | Ratio |
|---|---|
| ink/bg · ink/surface | 15.71 · 17.27 |
| muted/bg · muted/surface | 6.80 · 7.47 |
| white/accent · accent/surface · accent/soft | 7.90 · 7.90 · 6.47 |
| white/band | 17.27 |
| input border/surface (UI 3:1) | 3.61 |
| chips draft · issued · partly · settled · overdue · cancelled | 7.12 · 6.58 · 6.30 · 6.32 · 6.37 · 6.99 |

## Page
`/style-tiles#a|#b|#c` (design artefact, noindex). `TileSwitch` mirrors the hash into `<html data-tile-active>`; nothing is
shown before hydration. Tokens are scoped under `[data-tile="a|b|c"]` and override the shadcn variables; `globals.css` is untouched.

## Verification gates
`corepack pnpm e2e e2e/style-tiles.spec.ts` (3 pass) · `corepack pnpm test` · `corepack pnpm typecheck` · `corepack pnpm lint`

## Decision
Ham picked **B — Continuity** on 2026-10-14 (AskUserQuestion after viewing the three full-page tiles at 1440 px). No notes. Task 9 builds the design system from tile B's tokens.
