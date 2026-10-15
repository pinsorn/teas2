# SP1 — Design system (direction B, Continuity)

| | |
|---|---|
| Status | Approved 2026-10-14 (visual direction picked by Ham in SP1a) |
| Owner | Ham |
| Implements | `docs/specs/SP0-charter.md` §9.3 (UX rules), §7 (statuses, locks), D-13 (no dark mode); `docs/specs/SP1a-style-tiles.md` |
| Blast cap | tokens + shadcn variants + `/style-guide`; later UI tasks follow this doc and change it only by amendment |

## Goal
One reference every later screen follows: tokens, type, density, the five screen states, action hierarchy,
confirm dialogs, and which component enforces each of the 12 UX rules. Live version: `/style-guide`.

## Ground rules
- Colours only through tokens (`frontend/src/styles/tokens.css`). No hex, no Tailwind palette classes (`bg-red-500`) in app code.
- Light only. No `dark:` variants (D-13).
- No hard-coded UI strings in components: `src/messages/{th,en}.json` (th is the source; en is the second language).
- One accent. Peach (`--color-brand`) marks the primary action, the current nav item and focus; nothing else is peach-filled. Do not put brand-coloured text on `--color-brand-soft` (4.19:1, below AA): use `--color-brand-ink` there.
- Status is never colour alone: every chip carries its Thai label.
- Fonts: Noto Sans Thai for UI (`--font-ui`), Sarabun for paper/print (`--font-paper`), both via `next/font` in `layout.tsx`.
  No third family; numbers use `tabular-nums`, not a mono font.

## 1. Tokens

Defined in `src/styles/tokens.css`; the shadcn names (`--primary`, `--border`, ...) in `globals.css` point at them, so
shadcn components and Tailwind utilities (`bg-primary`, `text-muted-foreground`) pick them up. `src/styles/tokens.test.ts`
asserts the AA threshold only for the pairs listed in its `TEXT` table (4.5:1), the 3:1 UI pairs on the backgrounds it lists, and every status chip. Other rows below (for example the destructive hover and the brand-on-accent pair) are computed with the same WCAG formula but NOT asserted: a change to those tokens is not caught by the test, so check them by hand.

Ratios are WCAG 2.x relative-luminance contrast. Text needs 4.5:1; UI components (control borders, focus ring) need 3:1.

| Token | Value | Use | Pair and contrast |
|---|---|---|---|
| `--color-bg` (`--background`) | `#FAF8F5` | page background | ink on it 16.70:1 |
| `--color-surface` (`--card`, `--popover`) | `#FFFFFF` | cards, panels, inputs, dialogs | ink on it 17.70:1 |
| `--color-ink` (`--foreground`) | `#1A1816` | body text, headings | on subtle 15.71:1 |
| `--color-ink-muted` (`--muted-foreground`) | `#5F5A54` | secondary text, table headers, placeholders | on bg 6.44:1, on surface 6.82:1, on subtle 6.06:1 |
| `--color-subtle` (`--secondary`, `--muted`) | `#F4F1EC` | table header, hover, disabled and sidebar fill | ink on it 15.71:1 |
| `--color-rule` (`--border`) | `#D7D1C7` | decorative dividers and card borders only | 1.43:1 on bg: never the only boundary of a control |
| `--color-rule-soft` | `#ECE7DF` | in-table row rules (reserved) | decorative |
| `--color-control-border` (`--input`) | `#8A847A` | input, select, checkbox and outline-button borders | 3.71:1 on surface, 3.50:1 on bg (needs 3) |
| `--color-brand` (`--primary`, `--ring`) | `#9E5C34` | primary button, focus ring, links | white on it 5.21:1; as text on bg 4.91:1; ring on bg/surface 4.91 / 5.21 (needs 3) |
| `--color-brand-hover` | `#874E2B` | primary button hover (solid; never `bg-primary/80`, which falls to 3.60:1) | white on it 6.66:1 |
| `--color-brand-contrast` | `#FFFFFF` | text on brand | 5.21:1 |
| `--color-brand-soft` (`--accent`) | `#F8E3D0` | active nav item, selected row, avatar chip | ink on it 14.24:1 |
| `--color-brand-ink` (`--accent-foreground`) | `#86492A` | text on brand-soft; approved chip | on soft 5.63:1, on surface 7.00:1 |
| `--color-danger` (`--destructive`) | `#9B3F38` | error text, invalid border, destructive button text | on surface 6.64:1, on bg 6.27:1, on danger-soft 5.47:1 |
| `--color-danger-soft` | `#FBE4E1` | overdue chip fill | with danger 5.47:1 |

Status chips (`src/kit/doc-list/StatusChip.tsx`; text on tint, 24 px high, radius 8 = `rounded-md`):

| Status (`DocStatus`) | Thai label | fg token | fg | bg | Contrast |
|---|---|---|---|---|---|
| `draft` | ร่าง | `--color-status-draft-fg/bg` | `#4D4943` | `#ECE7DF` | 7.26:1 |
| `pending` | รออนุมัติ | `...-pending-...` | `#80580F` | `#FBEFD7` | 5.55:1 |
| `approved` | อนุมัติแล้ว | `...-approved-...` | `#86492A` | `#F8E3D0` | 5.63:1 |
| `issued` | ออกแล้ว | `...-issued-...` | `#3E5F80` | `#E5ECF2` | 5.59:1 |
| `partly_settled` | ชำระบางส่วน | `...-partly-...` | `#5E4B7E` | `#EEE9F4` | 6.32:1 |
| `settled` | ชำระครบ | `...-settled-...` | `#3A6347` | `#E6EFE7` | 5.85:1 |
| `cancelled` | ยกเลิก | `...-cancelled-...` | `#5F5A54` | `#E4DFD6` | 5.14:1 |
| `replaced` | ถูกแทนที่ | `...-cancelled-...` (shares) | `#5F5A54` | `#E4DFD6` | 5.14:1 |
| `overdue` (derived, extra chip) | เกินกำหนด | `...-overdue-...` | `#9B3F38` | `#FBE4E1` | 5.47:1 |

`overdue` is computed from the due date; it is shown beside the stored status, never stored as one. The same amber pair
(`--color-status-pending-*`) is the locked-banner tone.

Shape, density and focus tokens:

| Token | Value | Use |
|---|---|---|
| `--radius` | 10px | base radius; Tailwind `rounded-lg`. `rounded-xl` (14px) = panels and dialogs; `rounded-md` (8px) = chips and small controls |
| `--row-h` | 40px | table row and header height |
| `--ctl-h` | 40px | default button and input height (`size="sm"` 28px is for dense toolbars only) |
| `--focus-ring` | `3px solid var(--color-brand)` | the one focus indicator, `outline-offset: 2px`, applied globally to `:focus-visible` |
| `--shadow-panel` | `0 1px 2px rgb(26 24 22 / 0.06)` | panels only; nothing else gets a shadow |
| `--fs-title/section/body/small` | 24 / 17 / 15 / 13 px | see §2 |

Disabled controls use 50% opacity and must show why (§6, rule 2).

## 2. Typography

Thai needs air: body line-height is 1.6. Running text (body, small, section) is never below 1.5 (small 1.55, section 1.5); only the single-line `text-title` goes to 1.35.

| Class | Size / line | Weight | Use |
|---|---|---|---|
| `text-title` | 24 / 1.35 | 600 | one per page (`h1`) |
| `text-section` | 17 / 1.5 | 600 | section heading (`h2`), dialog title, empty-state title |
| `text-body` | 15 / 1.6 | 400 (500 for labels) | default; `body` already uses it |
| `text-small` | 13 / 1.55 | 400 | table headers, helper and error text, meta |

Rules: hierarchy by size and weight, not colour; max line length about 70 characters; no all-caps; no letter-spacing on
Thai. Money and dates use `tabular-nums` and right-align money columns. Dates are Buddhist era via `formatDateBE`, money
via `formatMoney`/`formatTHB`, amount in words ends "บาทถ้วน". shadcn internals that still use `text-sm` (14px: menus,
command list) are acceptable; app code uses the four classes above.

**`cn()` and custom utility groups.** `cn()` (`src/lib/utils.ts`) is `twMerge` extended with our own groups. tailwind-merge reads `text-title` / `text-section` / `text-body` / `text-small` as *colours* unless told they are font sizes, and then silently drops one of two conflicting classes. So any new custom utility whose name collides with a built-in group (a new `text-*` size, a custom `shadow-*`, `rounded-*` or `z-*` scale entry added in `@theme`) must be registered in `extendTailwindMerge({ extend: { classGroups } })` in the same change, with a unit test that both classes survive `cn()`.

## 3. Density

Direction B is "comfortable": 40 px rows and controls, 12 px cell padding, 20 px (`p-5`) panel padding, 24 px page
padding (`p-6`), 16 px between related blocks (`gap-4`), 40 px between page sections (`space-y-10`). Tables are plain:
a subtle header band, hairline row rules, no zebra. Default and `lg` buttons, inputs, selects and rows are at least 40 px (`lg` 44 px); mobile (>= 390 px) uses the same sizes. `sm` (28 px), `xs` (24 px) and `icon-sm`/`icon-xs` exist for dense desktop toolbars only; never use them as the main touch action.

## 4. The five screen states (rule 10)

Every screen and every data section designs all five, visibly different from each other (`/style-guide`, "สถานะของหน้าจอ").
Planned kit components (Task 10) are `src/kit/states/{Loading,Empty,Error,Forbidden}State` plus the lock banner
(`LockBanner`, Task 12); until then compose from `Skeleton`, `Alert`, `Button`.

| State | Look | Required content |
|---|---|---|
| Loading | `Skeleton` blocks at the real row height (`h-(--row-h)`) in the final layout; `role="status"` with an sr-only "กำลังโหลด" | no spinner-only screens; no layout jump when data arrives |
| Empty | panel: `text-section` title, one muted sentence, **one primary button with the next step** | says what will appear and offers the action that creates it ("สร้างใบกำกับภาษี") |
| Error | `Alert variant="destructive"` with warning icon | what failed in Thai, how to fix, **Retry** button, and the **trace id** ("รหัสอ้างอิง a1b2c3d4") for support. Never a raw key or empty toast |
| Forbidden | `Alert` with shield icon, `role="status"` | **names the missing permission** ("ต้องมีสิทธิ์ ดูใบกำกับภาษี") and who grants it; no retry button |
| Locked | amber banner (pending tokens) with lock icon | the reason (which period, filing or settlement) and **every exit** as buttons ("ยกเลิกและออกใบใหม่", "ออกใบลดหนี้"), per charter §7.4. A lock without an exit is a bug |

Empty and forbidden must never be confused: forbidden does not say "ไม่มีข้อมูล"; empty does not offer retry.

## 5. Action hierarchy (rule 4)

- One primary button (filled brand) per screen or dialog: the intent of that screen ("ออกใบกำกับภาษี"). It is the rightmost/last action and the default on Enter where safe.
- Secondary (`variant="secondary"` or `outline`): the usual alternatives ("บันทึกร่าง", "พิมพ์"). Outline is the default for toolbar actions.
- Ghost: low-emphasis (cancel editing, change customer). Link: navigation only.
- Destructive (`variant="destructive"`): tinted, never the filled primary colour; always behind a confirm dialog.
- Button labels are verb + object, never "OK"/"ตกลง". Icon-only buttons need `aria-label`.
- A disabled button states why in adjacent text or tooltip, tied with `aria-describedby`.

## 6. Confirm dialog anatomy (rule 3)

Use `AlertDialog` (modal, focus-trapped, Esc closes without action). Top to bottom:

1. **Title**: verb + object with the document number ("ออกใบกำกับภาษี TI-202610-0042").
2. **Consequence line** (muted): what happens now and what the way back is ("... ถ้าผิดพลาดแก้ได้โดยยกเลิกและออกใหม่").
3. **Totals block** for anything number-consuming or irreversible: net, VAT, grand total (`ยอดรวมทั้งสิ้น`, bold, rule above), amount in words. Nothing is confirmed blind.
4. **Footer**: back button (outline, left/second on mobile, label "กลับไปแก้ไข") and the **primary action named by the same verb as the title** ("ออกใบกำกับภาษี"). On mobile the primary is on top, full width.
5. Reasons (cancel, reissue) add a required reason-code select and text field above the footer; the primary stays disabled with the reason shown until both are filled.

Demo: `/style-guide`, "กล่องยืนยัน"; code `src/app/style-guide/ConfirmDemo.tsx`.

## 7. The 12 UX rules (SP0 §9.3) and what enforces each

"Exists" = in the tree now; "Planned" = a later SP1b/SP1c task builds it, and must meet the rule.

| # | Rule | Enforced by |
|---|---|---|
| 1 | Never show what is not wired | Exists: nav built from `src/app-shell/nav.ts` + descriptors (`nav.test.ts`), unbuilt routes land on `ComingInSp1c`. No placeholder buttons |
| 2 | A disabled action says why | Exists: disabled `Button` pattern with `aria-describedby` text (style guide). Planned: `ActionBar` (Task 12) derives the reason from permission/lock/missing data |
| 3 | Number-consuming or irreversible actions confirmed with totals | Exists: `AlertDialog` anatomy (§6). Planned: `ConfirmIssueDialog`, `CancelDialog` (Tasks 11, 12) |
| 4 | One intent, one button | Exists: button variants (§5), one filled primary per screen. Planned: one "แก้ไข" in `ActionBar` for all correction classes |
| 5 | Suggest; do not make users classify | Planned: `ItemField`/`PartyField` defaults and `useCompute` in `DocEditor` (Task 11); style rule: pre-fill, never ask for a tax class the system can derive |
| 6 | Screen = paper | Planned: `kit/paper/Paper` (Task 13) shares one data path with the editor preview. Sarabun via `--font-paper`; money and date formatters from `src/lib/format.ts` |
| 7 | Every mistake has a way back | Exists: locked-banner pattern with exits (§4). Planned: `LockBanner`, `CorrectionPlanDialog`, `RevisionHistory` (Task 12) |
| 8 | Errors are Thai, specific, fix-oriented | Exists: `problem.*` messages in `th.json` and the Error state (§4) with retry and trace id; lint rule is the no-hard-coded-strings convention |
| 9 | Non-VAT is a complete product | Exists: nav and Home gate on `me.vatRegistered` (`shell.spec.ts`). Every new screen is checked with the non-VAT company in the mock toolbar |
| 10 | Five distinct states per screen | Exists: patterns in §4, shown in `/style-guide`. Planned: `kit/states/*` (Task 10) |
| 11 | Daily documents fully keyboard-operable | Exists: Radix primitives, global `--focus-ring`, `Ctrl+K` command menu (`CommandMenu.tsx`). Planned: `useLineGridKeys` (Task 11) |
| 12 | Thai first | Exists: `th` default locale, `formatDateBE`, `formatMoney`, `status.*` labels, `html lang`. Every string has th and en entries |

## 8. How to use this in a new screen
1. Start from shadcn components in `src/components/ui/`; do not restyle per screen. Need a new variant: add it there and amend §1/§5.
2. Colours: `bg-card`, `text-muted-foreground`, `border-input`, or `text-(--color-status-...-fg)`; never hex.
3. Page: `text-title` h1, sections `text-section`, panels `rounded-xl border bg-card p-5 shadow-(--shadow-panel)`.
4. Design the five states before the happy path.
5. Run `corepack pnpm e2e` (axe: no serious or critical violations) and add the screen to the style guide if it introduces a pattern.

## Definition of Done
- [x] Tokens, type scale, density, states, action hierarchy, confirm dialog, rules documented
- [x] Contrast ratios computed; the pairs listed in `src/styles/tokens.test.ts` are asserted (see the note above for what is not)
- [x] `/style-guide` shows tokens, type, buttons, inputs, every `DocStatus` chip, the five states, a table and the confirm dialog
- [x] Shell and Home pass `e2e/shell.spec.ts` (incl. axe) on the new tokens

## Verification gates (from `frontend/`)
`corepack pnpm typecheck` · `lint` · `test` · `e2e` (includes `style-guide.spec.ts`, `shell.spec.ts`) · `build`

## Attempt log
- 2026-10-14: first version (SP1b Task 9).
