'use client';
import { useEffect, useRef, useState } from 'react';
import type { Doc, DocType } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints, type DocInput } from '@/lib/api/endpoints';

const IDLE_MS = 2000;

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'conflict' | 'error';
export interface Saved { id: string; version: number }
export interface AutosaveOptions {
  type: DocType;
  payload: DocInput;
  enabled: boolean;
  /** An existing draft: saves PUT with its version from the start. */
  initial?: Saved;
  /** Called once, after the first successful POST. */
  onCreated?: (id: string) => void;
}

/**
 * First change POSTs (one idempotency key per editor session); later changes PUT with the current version, 2 s after the
 * last change. A 409 stops autosave and is surfaced (never retried, never overwritten); local input is untouched.
 */
export function useAutosave({ type, payload, enabled, initial, onCreated }: AutosaveOptions) {
  const json = JSON.stringify(payload);
  const [key] = useState(() => crypto.randomUUID());
  const [savedJson, setSavedJson] = useState(json);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'conflict' | 'error'>('idle');
  const [problem, setProblem] = useState<unknown>();
  const [hasDoc, setHasDoc] = useState(!!initial);

  const latest = useRef({ payload, json, enabled, onCreated });
  useEffect(() => { latest.current = { payload, json, enabled, onCreated }; });
  const saved = useRef(json); // last JSON the server has
  const doc = useRef<Saved | undefined>(initial);
  const blocked = useRef(false);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // A create whose outcome we may not know (lost response, timeout): retries re-send THIS body with the same key, so the
  // server's idempotent replay and our "saved" bookkeeping describe the same content. Newer edits go out as a PUT after.
  const pendingCreate = useRef<{ body: DocInput; json: string }>(undefined);

  const run = (): Promise<void> => {
    const next = chain.current.then(async () => {
      const { payload: body, json: sent, enabled: on } = latest.current;
      if (!on || blocked.current || (doc.current && sent === saved.current)) return;
      if (!doc.current && !pendingCreate.current && sent === saved.current) return;
      setPhase('saving');
      try {
        let d: Doc;
        let persisted = sent;
        const first = !doc.current;
        if (doc.current) d = await endpoints.updateDoc(type, doc.current.id, body, doc.current.version);
        else {
          pendingCreate.current ??= { body, json: sent };
          persisted = pendingCreate.current.json;
          d = await endpoints.createDoc(type, pendingCreate.current.body, key);
        }
        doc.current = { id: d.id, version: d.version };
        pendingCreate.current = undefined;
        saved.current = persisted;
        setSavedJson(persisted);
        setHasDoc(true);
        setPhase('idle');
        if (first) latest.current.onCreated?.(d.id);
        if (latest.current.json !== persisted) schedule(); // edits the server has not seen yet
      } catch (e) {
        setProblem(e);
        if (e instanceof ApiError && e.problem.status === 409) { blocked.current = true; setPhase('conflict'); } else setPhase('error');
      }
    });
    chain.current = next;
    return next;
  };
  function schedule() {
    clearTimeout(timer.current);
    timer.current = setTimeout(run, IDLE_MS);
  }
  const scheduleRef = useRef(schedule);
  useEffect(() => { scheduleRef.current = schedule; });

  useEffect(() => {
    if (enabled && json !== saved.current && !blocked.current) scheduleRef.current();
    return () => clearTimeout(timer.current);
  }, [json, enabled]);

  /** Save now. Resolves with the draft (and the exact JSON it holds) only if everything typed so far is on the server. */
  const flush = async (): Promise<(Saved & { json: string }) | undefined> => {
    clearTimeout(timer.current);
    await run();
    if (doc.current && latest.current.json !== saved.current) await run(); // a create lands first, then the newer edits
    return latest.current.json === saved.current && doc.current ? { ...doc.current, json: saved.current } : undefined;
  };

  const flushRef = useRef(flush);
  useEffect(() => { flushRef.current = flush; });
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') void flushRef.current(); };
    const warn = (e: BeforeUnloadEvent) => {
      if (latest.current.enabled && (latest.current.json !== saved.current)) { e.preventDefault(); e.returnValue = ''; }
    };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('beforeunload', warn);
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('beforeunload', warn); };
  }, []);

  const dirty = enabled && json !== savedJson;
  const status: SaveStatus = !enabled ? 'idle'
    : phase === 'conflict' ? 'conflict' : phase === 'saving' ? 'saving' : phase === 'error' ? 'error'
    : dirty ? 'pending' : hasDoc ? 'saved' : 'idle';
  return { status, problem, flush };
}
