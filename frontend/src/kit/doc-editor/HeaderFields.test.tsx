import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import th from '@/messages/th.json';
import type { HeaderFieldKey } from '@/domain/descriptors';
import { HeaderFields } from './HeaderFields';

const ui = (keys: HeaderFieldKey[]) => render(
  <NextIntlClientProvider locale="th" messages={th}>
    <HeaderFields keys={keys} ids="x" header={{ documentDate: '2026-10-14' } as never} setHeader={() => undefined} />
  </NextIntlClientProvider>);

describe('HeaderFields', () => {
  it('renders exactly the keys it is given', () => {
    const { container } = ui(['documentDate', 'notes']);
    expect(container.querySelectorAll('input,textarea')).toHaveLength(2);
  });
  it('an unsupported key throws in dev instead of silently dropping a field', () => {
    expect(() => ui(['bankAccount'])).toThrow(/Unsupported header field/);
  });
});
