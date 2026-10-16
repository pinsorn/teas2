import { HttpResponse, http } from 'msw';
import type { BankAccountRef, WhtTypeRef } from '@/lib/api/endpoints';
import { DEFAULT_NOTES } from '../fixtures/default-notes';
import { ctx, forbidden, screenGate } from './common';

/** Reference lists the receipt / payment editors pick from. Readable by whoever can read a receipt or a voucher (M1 / FN1 move these behind
 *  `/records/…` and `bank.read`; the permission catalog has no code for them yet). */
const canRead = (perms: string[]) => perms.includes('doc.RC.read') || perms.includes('doc.PV.read');
const needed = 'doc.RC.read';

export const financeRefsHandlers = [
  http.get('*/bff/v1/bank-accounts', async () => {
    const gate = await screenGate('item');
    if (gate) return gate;
    const { st, company, perms } = ctx();
    if (!canRead(perms)) return forbidden(needed);
    return HttpResponse.json(st.bankAccounts.filter((b) => b.companyId === company.id)
      .map((b): BankAccountRef => ({ id: b.id, nameTh: b.nameTh, ...(b.accountNo ? { accountNo: b.accountNo } : {}), ...(b.default ? { default: true } : {}) })));
  }),
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
