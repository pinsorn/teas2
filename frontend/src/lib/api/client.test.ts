import { describe, expect, it } from 'vitest';
import { normalizeProblem } from './client';

describe('normalizeProblem', () => {
  it('keeps a problem+json body', () => {
    expect(normalizeProblem(409, { title: 'มีคนแก้เอกสารนี้ก่อนคุณ', code: 'doc.version_conflict', status: 409 }))
      .toMatchObject({ code: 'doc.version_conflict', status: 409 });
  });
  it('fills code and title for an empty or non-JSON body', () => {
    expect(normalizeProblem(502, undefined)).toMatchObject({ code: 'http.502', status: 502 });
    expect(normalizeProblem(500, '<html>')).toMatchObject({ code: 'http.500' });
  });
  it('never returns an empty title', () => {
    expect(normalizeProblem(418, {}).title.length).toBeGreaterThan(0);
  });
});
