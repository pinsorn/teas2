import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('joins truthy classes and lets later Tailwind classes win', () => {
    expect(cn('px-2', false && 'hidden', 'px-4')).toBe('px-4');
  });
  it('keeps the semantic type-scale classes next to a colour class', () => {
    expect(cn('text-small', 'text-ink')).toBe('text-small text-ink');
    expect(cn('text-body text-primary-foreground', 'text-small')).toBe('text-primary-foreground text-small');
  });
});
