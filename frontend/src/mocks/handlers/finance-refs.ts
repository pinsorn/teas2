import { HttpResponse, http } from 'msw';
import type { WhtTypeRef } from '@/lib/api/endpoints';
import { DEFAULT_NOTES } from '../fixtures/default-notes';
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
    return HttpResponse.json(st.whtTypes.filter((t) => t.companyId === company.id)
      .map((t): WhtTypeRef => ({ code: t.code, nameTh: t.nameTh, rate: `${t.rateBp % 100 === 0 ? t.rateBp / 100 : (t.rateBp / 100).toFixed(2)}%`, incomeType: t.incomeType })));
  }),
  // the notes a blank new document starts with, per type (ST1 edits them; here a fixture). Not company data: any signed-in user may read them.
  http.get('*/bff/v1/settings/default-notes', async () => {
    const gate = await screenGate('item');
    if (gate) return gate;
    return HttpResponse.json(DEFAULT_NOTES);
  }),
];
