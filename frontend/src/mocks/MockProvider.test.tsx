import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockProvider } from './MockProvider';

vi.mock('./browser', () => ({ worker: { start: () => Promise.reject(new Error('sw blocked')) } }));
afterEach(() => vi.unstubAllEnvs());

describe('MockProvider', () => {
  it('I9: a service worker that fails to start shows an error, not a blank page', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_MOCKING', 'enabled');
    render(<MockProvider><p>app</p></MockProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('เริ่มระบบจำลอง');
    expect(screen.queryByText('app')).toBeNull();
    expect(screen.getByRole('button', { name: 'ลองใหม่' })).toBeVisible();
  });
});
