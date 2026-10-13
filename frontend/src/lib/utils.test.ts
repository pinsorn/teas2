import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('joins truthy classes and lets later Tailwind classes win', () => {
    expect(cn('px-2', false && 'hidden', 'px-4')).toBe('px-4');
  });
});
