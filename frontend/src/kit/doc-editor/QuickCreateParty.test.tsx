import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tinCheckDigit } from '@/domain/tin';
import type { PartySummary } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { PartyField } from './PartyField';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const TIN = `010550000000${tinCheckDigit('010550000000')}`;
const NAME = 'บริษัท ผู้ขายใหม่ จำกัด';

/** PartyField wired to the real search endpoint, with the pick held in state the way DocEditor holds it. */
function Host({ kind = 'vendor', canCreate, onPick = () => {} }: { kind?: 'customer' | 'vendor'; canCreate?: boolean; onPick?: (p: PartySummary) => void }) {
  const [party, setParty] = useState<PartySummary>();
  return (
    <>
      <PartyField kind={kind} value={party} canCreate={canCreate} onPick={(p) => { setParty(p); onPick(p); }} onClear={() => setParty(undefined)}
        search={(q) => endpoints.searchParties({ kind, q, limit: 8 }).then((r) => r.items)} />
      <output aria-label="picked">{party?.id}</output>
    </>
  );
}
const mount = (props: Parameters<typeof Host>[0] = {}) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Host {...props} /></QueryClientProvider>);

describe('quick-create a party from the document editor', () => {
  it('no match → "+ เพิ่มผู้ขาย …" option → form prefilled → saved party is picked into the editor', async () => {
    const picked = vi.fn();
    mount({ canCreate: true, onPick: picked });
    const box = screen.getByRole('combobox', { name: 'ผู้ขาย' });
    await userEvent.type(box, NAME);
    const option = await screen.findByRole('option', { name: `+ เพิ่มผู้ขาย “${NAME}”` });
    expect(screen.getAllByRole('option')).toHaveLength(1); // the add option is the only one when nothing matches
    expect(option).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'เพิ่มผู้ขาย' });
    expect(within(dialog).getByLabelText('ชื่อ', { exact: true })).toHaveValue(NAME);
    expect(within(dialog).getByLabelText('ประเภทคู่ค้า')).toHaveValue('juristic');
    await waitFor(() => expect(within(dialog).getByLabelText('รหัส')).toHaveValue('V13')); // the next free vendor code
    expect(within(dialog).getByLabelText('สาขา')).toHaveValue('00000');
    await userEvent.type(within(dialog).getByLabelText('เลขประจำตัวผู้เสียภาษี'), TIN);
    await userEvent.type(within(dialog).getByLabelText('ที่อยู่ตามทะเบียน'), '99 ถนนสีลม กรุงเทพมหานคร');
    await userEvent.click(within(dialog).getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const made = loadState().parties.find((p) => p.name === NAME)!;
    expect(made).toMatchObject({ kind: 'vendor', companyId: 'co-vat', entityKind: 'juristic', code: 'V13', taxId: TIN });
    expect(made.active).not.toBe(false); // a new party is active
    expect(screen.getByLabelText('picked')).toHaveTextContent(made.id);
    expect(picked).toHaveBeenCalledWith(expect.objectContaining({ id: made.id, name: NAME, taxId: TIN, paymentTermDays: 0 }));
    expect(box).toHaveValue(NAME);
    expect(await screen.findByText(new RegExp(TIN))).toBeVisible(); // the party card shows what was just saved
  });

  it('a customer editor offers "+ เพิ่มลูกค้า" and creates a customer', async () => {
    mount({ kind: 'customer', canCreate: true });
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'ลูกค้ารายใหม่');
    await userEvent.click(await screen.findByRole('option', { name: '+ เพิ่มลูกค้า “ลูกค้ารายใหม่”' }));
    const dialog = await screen.findByRole('dialog', { name: 'เพิ่มลูกค้า' });
    await waitFor(() => expect(within(dialog).getByLabelText('รหัส')).toHaveValue('C14'));
    await userEvent.selectOptions(within(dialog).getByLabelText('ประเภทคู่ค้า'), 'individual');
    await userEvent.click(within(dialog).getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(loadState().parties.find((p) => p.name === 'ลูกค้ารายใหม่')).toMatchObject({ kind: 'customer', code: 'C14' });
    expect(screen.getByLabelText('picked')).not.toBeEmpty();
  });

  it('the option is offered only when nothing matches', async () => {
    mount({ canCreate: true });
    await userEvent.type(screen.getByRole('combobox', { name: 'ผู้ขาย' }), 'ภูพาน');
    await screen.findByRole('option', { name: /ภูพานกระดาษ/ });
    expect(screen.queryByRole('option', { name: /เพิ่มผู้ขาย/ })).toBeNull();
  });

  it('cancelling the form creates nothing and keeps the typed text; the editor has no party', async () => {
    mount({ canCreate: true });
    const box = screen.getByRole('combobox', { name: 'ผู้ขาย' });
    await userEvent.type(box, NAME);
    await userEvent.click(await screen.findByRole('option', { name: /เพิ่มผู้ขาย/ }));
    const dialog = await screen.findByRole('dialog', { name: 'เพิ่มผู้ขาย' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'ยกเลิก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(box).toHaveValue(NAME);
    expect(screen.getByLabelText('picked')).toBeEmptyDOMElement();
    expect(loadState().parties.some((p) => p.name === NAME)).toBe(false);
  });

  it('a server rejection stays in the form (bad TIN) and nothing is picked until it is fixed', async () => {
    mount({ canCreate: true });
    await userEvent.type(screen.getByRole('combobox', { name: 'ผู้ขาย' }), NAME);
    await userEvent.click(await screen.findByRole('option', { name: /เพิ่มผู้ขาย/ }));
    const dialog = await screen.findByRole('dialog', { name: 'เพิ่มผู้ขาย' });
    await waitFor(() => expect(within(dialog).getByLabelText('รหัส')).toHaveValue('V13'));
    await userEvent.type(within(dialog).getByLabelText('เลขประจำตัวผู้เสียภาษี'), '0105500000001');
    await userEvent.click(within(dialog).getByRole('button', { name: 'บันทึก' }));
    expect(await within(dialog).findByText(/เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง/)).toBeVisible();
    expect(screen.getByLabelText('picked')).toBeEmptyDOMElement();
    expect(loadState().parties.some((p) => p.name === NAME)).toBe(false);
  });

  it('without party.manage the option is absent and the hint names party.manage', async () => {
    mount({ canCreate: false });
    await userEvent.type(screen.getByRole('combobox', { name: 'ผู้ขาย' }), NAME);
    const hints = await screen.findAllByText(/ต้องมีสิทธิ์ party\.manage/); // the visible line and the live region say the same
    for (const h of hints) expect(h).toHaveTextContent('ไม่พบรายการที่ตรงกัน');
    expect(screen.queryByRole('option')).toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a host that does not opt in (canCreate unset) behaves as before: plain "no match", no option', async () => {
    mount();
    await userEvent.type(screen.getByRole('combobox', { name: 'ผู้ขาย' }), NAME);
    expect((await screen.findAllByText('ไม่พบรายการที่ตรงกัน ใช้ข้อความที่พิมพ์ต่อไปได้')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('option')).toBeNull();
  });
});
