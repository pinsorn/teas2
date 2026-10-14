'use client';
import { useState } from 'react';
import { useMe } from './useMe';

/**
 * A counter that goes up when the ACTIVE company changes (the first answer from /me is not a change).
 * Use it as a `key` on any component that holds company data in local state (editor, view): it remounts on a switch,
 * so one company's party / lines / drafts can never leak into another.
 */
export function useCompanyEpoch(): number {
  const { me } = useMe();
  const [s, setS] = useState<{ company?: string; epoch: number }>({ epoch: 0 });
  const cur = me?.activeCompanyId;
  if (cur && cur !== s.company) setS({ company: cur, epoch: s.company ? s.epoch + 1 : s.epoch });
  return s.epoch;
}
