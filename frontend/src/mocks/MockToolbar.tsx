'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Role } from '@/domain/types';
import { getSettings, setSettings, type MockSettings, type ScreenState } from './settings';
import { resetState } from './store';

const COMPANIES: [MockSettings['companyKey'], string][] = [['vat', 'บริษัทจดทะเบียน VAT'], ['nonvat', 'บริษัทไม่จด VAT']];
const ROLES: [Role, string][] = [['operator', 'พนักงานคีย์ข้อมูล'], ['accountant', 'นักบัญชี'], ['admin', 'ผู้ดูแลระบบ']];
const STATES: [ScreenState, string][] = [['normal', 'ปกติ'], ['empty', 'ไม่มีข้อมูล'], ['loading', 'กำลังโหลด'], ['error', 'เกิดข้อผิดพลาด'],
  ['forbidden', 'ไม่มีสิทธิ์'], ['locked', 'ถูกล็อก']];

function Select({ label, value, opts, onChange }: { label: string; value: string; opts: [string, string][]; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">{label}
      <select className="rounded border bg-background px-2 py-1" value={value} onChange={(e) => onChange(e.target.value)}>
        {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </label>
  );
}

export function MockToolbar({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [s, setS] = useState(getSettings);
  const qc = useQueryClient();
  const router = useRouter();
  const refresh = () => { void qc.invalidateQueries(); router.refresh(); };
  const change = (p: Partial<MockSettings>) => { setS(setSettings(p)); refresh(); };

  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="fixed bottom-3 left-3 z-50 print:hidden rounded-md border bg-background px-3 py-2 text-sm shadow">โหมดตัวอย่าง</button>;
  }
  return (
    <div className="fixed bottom-3 left-3 z-50 print:hidden flex w-64 flex-col gap-2 rounded-md border bg-background p-3 shadow">
      <button type="button" onClick={() => setOpen(false)} className="self-end text-sm">ปิด</button>
      <Select label="บริษัท" value={s.companyKey} opts={COMPANIES} onChange={(v) => change({ companyKey: v as MockSettings['companyKey'] })} />
      <Select label="บทบาท" value={s.role} opts={ROLES} onChange={(v) => change({ role: v as Role })} />
      <Select label="สถานะหน้าจอ" value={s.screenState} opts={STATES} onChange={(v) => change({ screenState: v as ScreenState })} />
      <button type="button" className="rounded border px-2 py-1 text-sm" onClick={() => { resetState(); setS(getSettings()); refresh(); }}>รีเซ็ตข้อมูลตัวอย่าง</button>
    </div>
  );
}

/** Mounts the toolbar only when the mock backend is on. */
export function MockToolbarGate() {
  return process.env.NEXT_PUBLIC_API_MOCKING === 'enabled' ? <MockToolbar /> : null;
}
