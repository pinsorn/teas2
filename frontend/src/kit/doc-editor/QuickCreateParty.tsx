'use client';
import { useEffect, useState } from 'react';
import type { PartySummary } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { RECORDS } from '@/records';
import { RecordFormDialog } from '../record-form/RecordForm';

type Kind = 'customer' | 'vendor';

/** The next free code in this kind's list ("C14" after "C13"): scans every party, inactive ones included, since a code is never reused. */
async function nextCode(kind: Kind): Promise<string> {
  const prefix = kind === 'customer' ? 'C' : 'V';
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0, width = 2, cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await endpoints.listRecords(kind, { active: 'all', limit: 100, cursor });
    for (const row of r.items) {
      const m = re.exec(String(row.code));
      if (m) { max = Math.max(max, Number(m[1])); width = Math.max(width, m[1].length); }
    }
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return `${prefix}${String(max + 1).padStart(width, '0')}`;
}

/**
 * "+ เพิ่ม…" from a document editor: the party form in a dialog, prefilled with the typed name (juristic by default) and the next code.
 * The saved party comes back through the same `/parties` search the editor's type-ahead uses, so it is picked like any hit.
 */
export function QuickCreateParty({ kind, name, onCreated, onClose }: { kind: Kind; name: string; onCreated: (p: PartySummary) => void; onClose: () => void }) {
  const [code, setCode] = useState<string>();
  useEffect(() => {
    let live = true;
    nextCode(kind).then((c) => { if (live) setCode(c); }, () => { if (live) setCode(''); }); // no suggestion is better than no dialog
    return () => { live = false; };
  }, [kind]);
  if (code === undefined) return null;
  return (
    <RecordFormDialog descriptor={RECORDS[kind]!} prefill={{ name, entityKind: 'juristic', ...(code ? { code } : {}) }} onClose={onClose}
      onSaved={(row) => {
        endpoints.searchParties({ kind, q: String(row.code), limit: 8 })
          .then((r) => { const p = r.items.find((x) => x.id === row.id); if (p) onCreated(p); else onClose(); }, onClose);
      }} />
  );
}
