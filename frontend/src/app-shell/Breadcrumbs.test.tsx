import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Breadcrumbs } from './Breadcrumbs';

vi.mock('next/navigation', () => ({ usePathname: () => '/sales/tax-invoices/%zz' }));

describe('Breadcrumbs', () => {
  it('a malformed percent-escape in the path does not throw; the raw segment is shown', () => {
    render(<Breadcrumbs />);
    expect(screen.getByText('%zz')).toBeInTheDocument();
  });
});
