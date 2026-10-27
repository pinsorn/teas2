import { describe, expect, it, vi } from 'vitest';
import { patchConsole, redactLinkTokens, register } from './instrumentation';

describe('link tokens never reach the web log', () => {
  const sink = () => ({ error: vi.fn(), warn: vi.fn() });
  it('console.error / warn: a "Failed to proxy" line loses the token, the rest of the line stays', () => {
    const c = sink();
    const { error, warn } = c;
    patchConsole(c);
    c.error('Failed to proxy http://api:8080/internal/v1/auth/links/tok_ABC-123?x=1 Error: connect ECONNREFUSED');
    c.warn('Failed to proxy http://api:8080/internal/v1/auth/links/tok_ABC-123');
    expect(error).toHaveBeenCalledWith('Failed to proxy http://api:8080/internal/v1/auth/links/[redacted]?x=1 Error: connect ECONNREFUSED');
    expect(warn).toHaveBeenCalledWith('Failed to proxy http://api:8080/internal/v1/auth/links/[redacted]');
  });
  it('matches the path case-insensitively (the API routes /Auth/Links/<token> too)', () => {
    expect(redactLinkTokens('Failed to proxy http://api:8080/internal/v1/Auth/LINKS/MixedTok9')).toBe('Failed to proxy http://api:8080/internal/v1/Auth/LINKS/[redacted]');
  });
  it('an Error argument is redacted in message and stack; other values pass untouched', () => {
    const e = new Error('connect failed for /internal/v1/auth/links/secrettoken');
    const c = sink();
    const { error } = c;
    patchConsole(c);
    c.error('Failed to proxy x', e, { n: 1 });
    const [, passed, obj] = error.mock.calls[0] as [string, Error, unknown];
    expect(passed.message).not.toContain('secrettoken');
    expect(passed.stack).not.toContain('secrettoken');
    expect(obj).toEqual({ n: 1 });
    expect(redactLinkTokens(42)).toBe(42);
  });
  it('register() patches only the node server runtime', () => {
    const before = console.error;
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    register();
    expect(console.error).toBe(before);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    register();
    expect(console.error).not.toBe(before);
    expect(() => console.error('Failed to proxy http://x/auth/links/zzz')).not.toThrow();
    console.error = before;
    vi.unstubAllEnvs();
  });
});
