import { HttpResponse, http } from 'msw';
import type { Me } from '@/domain/types';
import { setSettings } from '../settings';
import { ctx, problem, screenGate } from './common';

export const buildMe = (): Me => {
  const { st, s, company, perms } = ctx();
  return {
    userId: 'u-1', displayName: 'สมศรี บัญชีดี', activeCompanyId: company.id, vatRegistered: company.vatRegistered, permissions: perms,
    memberships: st.memberships.map((m) => ({ companyId: m.companyId, companyName: m.companyName, role: m.companyId === company.id ? s.role : m.role })),
  };
};

export const meHandlers = [
  http.get('*/bff/v1/me', async () => (await screenGate('me')) ?? HttpResponse.json(buildMe())),
  http.post('*/bff/v1/me/active-company', async ({ request }) => {
    const { companyId } = (await request.json()) as { companyId?: string };
    if (companyId !== 'co-vat' && companyId !== 'co-nonvat') return problem(404, 'company.not_found', 'ไม่พบบริษัท');
    setSettings({ companyKey: companyId === 'co-vat' ? 'vat' : 'nonvat' });
    return HttpResponse.json(buildMe());
  }),
];
