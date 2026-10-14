import { useMutation, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { endpoints } from '@/lib/api/endpoints';
import { testServer } from '@/mocks/test-server';
import { QueryProvider } from './QueryProvider';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());

const body = (status: number, code: string) => HttpResponse.json({ type: 'about:blank', status, code, title: `t${status}`, traceId: 't' }, { status });

function Probe() {
  const q = useQuery({ queryKey: ['probe'], queryFn: () => endpoints.getMe() });
  return <p role="status">{q.isError ? `error:${(q.error as { code?: string }).code}` : q.isPending ? 'pending' : 'ok'}</p>;
}

describe('QueryProvider', () => {
  it('does not retry 4xx, retries 5xx once', async () => {
    let calls = 0;
    testServer.use(http.get('*/bff/v1/me', () => { calls++; return body(404, 'doc.not_found'); }));
    const four = render(<QueryProvider><Probe /></QueryProvider>);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('error:doc.not_found'));
    await new Promise((r) => setTimeout(r, 1300)); // longer than the default retry delay: a retry would have landed by now
    expect(calls).toBe(1);
    four.unmount();

    calls = 0;
    testServer.use(http.get('*/bff/v1/me', () => { calls++; return body(500, 'mock.server_error'); }));
    render(<QueryProvider><Probe /></QueryProvider>);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('error:mock.server_error'), { timeout: 5000 });
    expect(calls).toBe(2); // the first attempt plus exactly one retry
  }, 15_000);

  it('a 409 version conflict surfaces doc.version_conflict to the caller', async () => {
    testServer.use(http.put('*/bff/v1/docs/TI/d1', () => body(409, 'doc.version_conflict')));
    function Save() {
      const m = useMutation({ mutationFn: () => endpoints.updateDoc('TI', 'd1', { header: { partyId: 'p', documentDate: '2026-10-14' }, lines: [] }, 1) });
      return <><button onClick={() => m.mutate()}>save</button><p role="status">{m.isError ? (m.error as { code?: string }).code : ''}</p></>;
    }
    render(<QueryProvider><Save /></QueryProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('doc.version_conflict'));
  });

  it('create sends the idempotency key as a header (a retried POST cannot create twice)', async () => {
    let key: string | null = null;
    testServer.use(http.post('*/bff/v1/docs/TI', ({ request }) => { key = request.headers.get('idempotency-key'); return body(500, 'x'); }));
    await endpoints.createDoc('TI', { header: { partyId: 'p', documentDate: '2026-10-14' }, lines: [] }, 'key-123').catch(() => undefined);
    expect(key).toBe('key-123');
  });
});
