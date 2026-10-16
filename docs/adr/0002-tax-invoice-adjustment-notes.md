# ADR-0002: Tax-invoice cancel waits for its notes; mixed corrections issue a separate CN and DN

| Date | Status | Deciders |
|---|---|---|
| 2026-10-16 | Accepted | Ham, orchestrator |

## Context

SP1c S5 built line-based credit and debit notes. Two money defects surfaced in the Opus reviews:

1. Cancelling a tax invoice (TI) while a live CN / DN adjusts it reversed the receivable twice: once through the
   TI's own reversal, once through the notes that still reduce or raise its outstanding.
2. A correction plan whose line deltas went both ways produced one debit note with a negative line. That line credited
   the TI outside the per-line credit cap (G3), so a later user CN could over-credit the line and its output VAT
   (probe: 9.10 VAT relieved on a line that charged 7.00, invariants silent).

The signed combined-note question (one note for both directions, R-08) is still open in the SP-R decision list.

## Decision

1. A TI cannot be cancelled while a live CN or DN adjusts it. The exit is to cancel the notes first, then the TI.
2. A correction plan whose line deltas go both ways issues two documents: a CN for the decreasing lines and a DN for
   the increasing lines, each with rule-B VAT (Ham, 2026-10-14) on its own lines; together they equal
   the total change. A tax-code shift at the same price is therefore a CN on the old code plus a DN on the new code.
   A user note's lines are all positive; a stored negative DN line still counts as a credit in the cap.
3. A fiscal correction plan on a TI that has live notes is refused (exit: cancel the notes or issue a further note);
   plans that start after notes remain SP2 work (ledger 184).

## Consequences

- AR is reversed exactly once; the per-line credit cap sees every credit.
- Some corrections produce two documents instead of one; the VAT report (TX1) lists both.
- If Ham later rules for a signed combined note (R-08), decision 2 is revisited in a superseding ADR.

## Spec changes

- SP0 §7.4, TI row, Cancel: "yes; blocked while a receipt is applied → exit: cancel / reissue the receipt first;
  blocked while a live CN / DN adjusts it → exit: cancel the notes first".
- `docs/plans/sp1c/02-sales.md` S5 already reflects decisions 2–3 through the S5 review rulings.
