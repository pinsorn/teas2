// SP3 P10a: a link token travels in the path of /auth/links/{token} (routes 13 / 14). When the upstream is down, Next's external rewrite logs
// `Failed to proxy <full target URL>` with console.error, which would put the token in the web logs. Redact it in the server process's console.
const TOKEN = /(\/auth\/links\/)[^/?#\s'"`]+/g;

export const redactLinkTokens = (v: unknown): unknown => {
  if (typeof v === 'string') return v.replace(TOKEN, '$1[redacted]');
  if (v instanceof Error) {
    v.message = v.message.replace(TOKEN, '$1[redacted]');
    if (v.stack) v.stack = v.stack.replace(TOKEN, '$1[redacted]');
  }
  return v;
};

type Sink = Pick<Console, 'error' | 'warn'>;
export function patchConsole(c: Sink): void {
  for (const level of ['error', 'warn'] as const) {
    const original = c[level].bind(c);
    c[level] = (...args: unknown[]) => original(...args.map(redactLinkTokens));
  }
}

export function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') patchConsole(console);
}
