import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AppError from './error';

describe('app error boundary', () => {
  it('shows the app error state (never "no data") and retry calls reset', async () => {
    const reset = vi.fn();
    const { container } = render(<AppError error={new Error('boom')} reset={reset} />);
    expect(container.querySelector('[data-screen-state="error"]')).not.toBeNull();
    expect(container.querySelector('[data-screen-state="empty"]')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
