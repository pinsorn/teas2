'use client';
import { useEffect, useRef, useState } from 'react';
import type { ComputeResult, DocType } from '@/domain/types';
import { endpoints, type DocInput } from '@/lib/api/endpoints';

const DEBOUNCE_MS = 250;

/**
 * Totals, VAT, amount in words and `missing` come ONLY from the server. Debounced; a response is applied only if it
 * answers the latest input (request id), so a slow stale reply can never overwrite a newer one.
 */
export function useCompute(type: DocType, payload: DocInput, docId?: string) {
  const json = JSON.stringify(payload);
  const [state, setState] = useState<{ json: string; data?: ComputeResult; error?: unknown }>();
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const latest = useRef(payload);
  useEffect(() => { latest.current = payload; });

  useEffect(() => {
    const id = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const data = await endpoints.computeDocument(type, latest.current, docId);
        if (id === seq.current) setState({ json, data });
      } catch (error) {
        if (id === seq.current) setState((p) => ({ json, error, data: p?.data }));
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [type, json, attempt, docId]);

  const settled = state?.json === json;
  return {
    data: settled && !state?.error ? state?.data : undefined,
    /** The last good answer, kept while a newer one is on its way (shown dimmed, never used to gate an action). */
    last: state?.data,
    error: settled ? state?.error : undefined,
    pending: !settled,
    retry: () => { setState(undefined); setAttempt((a) => a + 1); },
  };
}
