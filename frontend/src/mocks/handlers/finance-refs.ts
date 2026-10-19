import { HttpResponse, http } from 'msw';
import type { WhtTypeRef } from '@/lib/api/endpoints';
import { today } from '../engine/log';
import { ctx, forbidden, screenGate } from './common';

/** Reference lists the receipt / payment editors pick from. Readable by whoever can read a receipt or a voucher (M1 moves the WHT types behind `/records/…`).
 *  The bank accounts are no longer here: they are the FN1 records (`/records/bank-account`, `bank.read`). */
const canRead = (perms: string[]) => perms.includes('doc.RC.read') || perms.includes('doc.PV.read');
const needed = 'doc.RC.read';

export const financeRefsHandlers = [
  // [SP-R] the rates shown are mock reference data, not a ruled tax position
  http.get('*/bff/v1/wht-types', async () => {
    const gate = await screenGate('item');
    if (gate) return gate;
    const { st, company, perms } = ctx();
    if (!canRead(perms)) return forbidden(needed);
    return HttpResponse.json(st.whtTypes.filter((t) => t.companyId === company.id && t.active !== false && t.effectiveFrom <= today() && // ST3: a deactivated type is not offered for new lines
       !st.whtTypes.some((u) => u.companyId === t.companyId && u.code === t.code && u.effectiveFrom <= today() && u.effectiveFrom > t.effectiveFrom)) // the row in force today, one per code
      .map((t): WhtTypeRef => ({ code: t.code, nameTh: t.nameTh, rate: `${t.rateBp % 100 === 0 ? t.rateBp / 100 : (t.rateBp / 100).toFixed(2)}%`, incomeType: t.incomeType })));
  }),
  // the notes a blank new document starts with, per type: the company's own (ST1 edits them on the company page). Any signed-in user may read them: a blank document needs them.
  http.get('*/bff/v1/settings/default-notes', async () => {
    const gate = await screenGate('item');
    if (gate) return gate;
    return HttpResponse.json(ctx().company.defaultNotes ?? {});
  }),
];
