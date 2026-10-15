'use client';
import { useQuery } from '@tanstack/react-query';
import { Fragment, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { useMe } from '@/app-shell/useMe';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { HeaderFieldKey } from '@/domain/descriptors';
import { REASON_CODES } from '@/domain/doc-types';
import type { DocHeader, DocType, WhtMode } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE } from '@/lib/format';
import { qk } from '@/lib/query/keys';

const selectCls = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-3 text-body outline-none';
const METHODS = ['transfer', 'cash', 'cheque'] as const;
const WHT_MODES: WhtMode[] = ['deduct', 'grossup_once', 'grossup_always'];

/** The company's bank / cash accounts (from the server). The account shown before a choice is the server default the engine will fill in. */
function BankAccountField({ id, header, setHeader }: { id: string; header: DocHeader; setHeader: Dispatch<SetStateAction<DocHeader>> }) {
  const t = useTranslations('docEditor');
  const { me } = useMe();
  const companyId = me?.activeCompanyId ?? '';
  const q = useQuery({ queryKey: qk.bankAccounts(companyId), queryFn: endpoints.bankAccounts, enabled: !!me });
  const shown = header.bankAccountId ?? q.data?.find((b) => b.default)?.id ?? '';
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{t('bankAccount')}</Label>
      <select id={id} className={selectCls} value={shown} disabled={!q.data} onChange={(e) => setHeader((h) => ({ ...h, bankAccountId: e.target.value || undefined }))}>
        {q.isError ? <option value="">{t('bankFailed')}</option> : !q.data ? <option value="">{t('bankLoading')}</option> : null}
        {q.data?.map((b) => <option key={b.id} value={b.id}>{b.accountNo ? `${b.nameTh} ${b.accountNo}` : b.nameTh}</option>)}
      </select>
    </div>
  );
}

/** CN / DN: the tax invoice adjusted - the server owns it (set by "ออกใบลดหนี้" / "ออกใบเพิ่มหนี้" on the invoice), so it is shown, not edited. */
function RefDocField({ id, refDocId }: { id: string; refDocId?: string }) {
  const t = useTranslations('docEditor');
  const { me } = useMe();
  const q = useQuery({ queryKey: qk.doc(me?.activeCompanyId ?? '', 'TI', refDocId ?? ''), queryFn: () => endpoints.getDoc('TI', refDocId!), enabled: !!me && !!refDocId });
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{t('refDoc')}</Label>
      <Input id={id} type="text" readOnly value={!refDocId ? t('refDocNone') : q.data ? `${q.data.number ?? ''} · ${formatDateBE(q.data.header.documentDate)}` : '…'} />
    </div>
  );
}

/** CN / DN: why the note is issued - a code of the type (shown in the user's language; the paper prints the Thai wording), with a text when it is "other". */
function ReasonField({ ids, type, header, setHeader }: { ids: string; type?: DocType; header: DocHeader; setHeader: Dispatch<SetStateAction<DocHeader>> }) {
  const t = useTranslations('docEditor');
  const codes = (type && REASON_CODES[type]) || [];
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-reason`}>{t('reason')}</Label>
        <select id={`${ids}-reason`} className={selectCls} value={header.reasonCode ?? ''}
          onChange={(e) => setHeader((h) => ({ ...h, reasonCode: e.target.value || undefined, ...(e.target.value === 'OTHER' ? {} : { reasonText: undefined }) }))}>
          <option value="">{t('reasonPick')}</option>
          {codes.map((c) => <option key={c} value={c}>{t(`reasons.${c}`)}</option>)}
        </select>
      </div>
      {header.reasonCode === 'OTHER' ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-reason-text`}>{t('reasonText')}</Label>
          <Input id={`${ids}-reason-text`} type="text" autoComplete="off" value={header.reasonText ?? ''} onChange={(e) => setHeader((h) => ({ ...h, reasonText: e.target.value }))} />
        </div>
      ) : null}
    </>
  );
}

export function HeaderFields({ type, keys, ids, header, setHeader }: {
  /** Picks per-type labels (a quotation's due date is "valid until"). */ type?: DocType; keys: HeaderFieldKey[]; ids: string; header: DocHeader; setHeader: Dispatch<SetStateAction<DocHeader>>;
}) {
  const t = useTranslations('docEditor');
  const field = (key: HeaderFieldKey) => {
    switch (key) {
      case 'documentDate': return (
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-date`}>{t('documentDate')}</Label>
          <Input id={`${ids}-date`} type="date" value={header.documentDate} onChange={(e) => setHeader((h) => ({ ...h, documentDate: e.target.value }))} />
          {header.documentDate && <p className="text-small text-muted-foreground">{formatDateBE(header.documentDate)}</p>}
        </div>
      );
      case 'dueDate': return (
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-due`}>{type && t.has(`dueDateByType.${type}`) ? t(`dueDateByType.${type}`) : t('dueDate')}</Label>
          <Input id={`${ids}-due`} type="date" value={header.dueDate ?? ''} onChange={(e) => setHeader((h) => ({ ...h, dueDate: e.target.value || undefined }))} />
          {header.dueDate && <p className="text-small text-muted-foreground">{formatDateBE(header.dueDate)}</p>}
        </div>
      );
      case 'reference': return (
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-ref`}>{t('reference')}</Label>
          <Input id={`${ids}-ref`} type="text" autoComplete="off" value={header.reference ?? ''} onChange={(e) => setHeader((h) => ({ ...h, reference: e.target.value }))} />
        </div>
      );
      case 'notes': return (
        <div className="grid gap-1.5 md:col-span-2">
          <Label htmlFor={`${ids}-notes`}>{t('notes')}</Label>
          <Textarea id={`${ids}-notes`} value={header.notes ?? ''} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} />
        </div>
      );
      case 'refDoc': return <RefDocField id={`${ids}-refdoc`} refDocId={header.refDocId} />;
      case 'reason': return <ReasonField ids={ids} type={type} header={header} setHeader={setHeader} />;
      case 'bankAccount': return <BankAccountField id={`${ids}-bank`} header={header} setHeader={setHeader} />;
      case 'paymentMethod': return (
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-method`}>{t('paymentMethod')}</Label>
          <select id={`${ids}-method`} className={selectCls} value={header.paymentMethod ?? 'transfer'}
            onChange={(e) => setHeader((h) => ({ ...h, paymentMethod: e.target.value as DocHeader['paymentMethod'] }))}>
            {METHODS.map((m) => <option key={m} value={m}>{t(`method.${m}`)}</option>)}
          </select>
        </div>
      );
      case 'cheque': {
        if ((header.paymentMethod ?? 'transfer') !== 'cheque') return null;
        const c = header.cheque ?? { number: '', date: '', bank: '' };
        const set = (p: Partial<typeof c>) => setHeader((h) => {
          const n = { ...c, ...p };
          return { ...h, cheque: n.number || n.date || n.bank ? n : undefined };
        });
        return (
          <div className="grid gap-3 md:col-span-2 md:grid-cols-3">
            <div className="grid gap-1.5"><Label htmlFor={`${ids}-chq-no`}>{t('chequeNumber')}</Label>
              <Input id={`${ids}-chq-no`} type="text" autoComplete="off" value={c.number} onChange={(e) => set({ number: e.target.value })} /></div>
            <div className="grid gap-1.5"><Label htmlFor={`${ids}-chq-date`}>{t('chequeDate')}</Label>
              <Input id={`${ids}-chq-date`} type="date" value={c.date} onChange={(e) => set({ date: e.target.value })} /></div>
            <div className="grid gap-1.5"><Label htmlFor={`${ids}-chq-bank`}>{t('chequeBank')}</Label>
              <Input id={`${ids}-chq-bank`} type="text" autoComplete="off" value={c.bank} onChange={(e) => set({ bank: e.target.value })} /></div>
          </div>
        );
      }
      case 'whtMode': return (
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-whtmode`}>{t('whtMode')}</Label>
          <select id={`${ids}-whtmode`} className={selectCls} value={header.whtMode ?? 'deduct'}
            onChange={(e) => setHeader((h) => ({ ...h, whtMode: e.target.value as WhtMode }))}>
            {WHT_MODES.map((m) => <option key={m} value={m}>{t(`whtModes.${m}`)}</option>)}
          </select>
        </div>
      );
      default:
        if (process.env.NODE_ENV !== 'production') throw new Error(`Unsupported header field: ${key}`);
        return null;
    }
  };
  return keys.map((key) => <Fragment key={key}>{field(key)}</Fragment>);
}
