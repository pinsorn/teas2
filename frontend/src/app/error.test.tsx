import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ShellError from './(app)/error';
import RootError from './error';
import GlobalError from './global-error';

describe.each([['root error.tsx', RootError], ['(app)/error.tsx', ShellError]])('%s', (_n, Boundary) => {
  it('shows the app error state (never "no data") and the retry button calls retry() (re-fetch), not reset', async () => {
    const retry = vi.fn();
    const { container } = render(<Boundary error={new Error('boom')} retry={retry} />);
    expect(container.querySelector('[data-screen-state="error"]')).not.toBeNull();
    expect(container.querySelector('[data-screen-state="empty"]')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

it('global-error retry button calls retry()', async () => {
  const retry = vi.fn();
  render(<GlobalError error={new Error('boom')} retry={retry} />, { container: document.documentElement });
  await userEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
  expect(retry).toHaveBeenCalledOnce();
});
