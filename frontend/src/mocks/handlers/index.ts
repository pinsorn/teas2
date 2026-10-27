import { http, passthrough, type RequestHandler } from 'msw';
import { LIVE_ROUTES } from '@/contract/live-routes';
import { bankHandlers } from './bank';
import { docsReadHandlers } from './docs-read';
import { docsWriteHandlers } from './docs-write';
import { filingHandlers } from './filings';
import { financeRefsHandlers } from './finance-refs';
import { homeHandlers } from './home';
import { itemsHandlers } from './items';
import { meHandlers } from './me';
import { mockFixturesHandlers } from './mock-fixtures';
import { partiesHandlers } from './parties';
import { periodHandlers } from './periods';
import { recordsHandlers } from './records';
import { reportsHandlers } from './reports';
import { scheduleHandlers } from './schedules';
import { searchHandlers } from './search';
import { settingsHandlers } from './settings';
import { connectHandlers } from './connect';
import { settlementHandlers } from './settlements';

export * from './common';
const mockHandlers: RequestHandler[] = [...meHandlers, ...homeHandlers, ...partiesHandlers, ...recordsHandlers, ...itemsHandlers, ...docsReadHandlers, ...docsWriteHandlers, ...financeRefsHandlers, ...bankHandlers, ...settlementHandlers, ...scheduleHandlers, ...periodHandlers, ...filingHandlers, ...reportsHandlers, ...searchHandlers, ...settingsHandlers, ...connectHandlers, ...mockFixturesHandlers];

/** SP3 4.8: in `hybrid` a live route is not answered by the mock - it passes through to proxy.ts and the real API; any other mode keeps today's handlers. */
export function withLiveRoutes(all: RequestHandler[], mode: string | undefined): RequestHandler[] {
  if (mode !== 'hybrid') return all;
  const verb = { GET: http.get, POST: http.post, PUT: http.put, DELETE: http.delete } as const;
  return [...LIVE_ROUTES.map((r) => verb[r.method](`*/bff/v1${r.path.replace(/\{(\w+)\}/g, ':$1')}`, () => passthrough())), ...all];
}
export const handlers = withLiveRoutes(mockHandlers, process.env.NEXT_PUBLIC_API_MODE);
