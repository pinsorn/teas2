import { bankHandlers } from './bank';
import { docsReadHandlers } from './docs-read';
import { docsWriteHandlers } from './docs-write';
import { financeRefsHandlers } from './finance-refs';
import { homeHandlers } from './home';
import { itemsHandlers } from './items';
import { meHandlers } from './me';
import { mockFixturesHandlers } from './mock-fixtures';
import { partiesHandlers } from './parties';
import { recordsHandlers } from './records';
import { reportsHandlers } from './reports';
import { searchHandlers } from './search';

export * from './common';
export const handlers = [...meHandlers, ...homeHandlers, ...partiesHandlers, ...recordsHandlers, ...itemsHandlers, ...docsReadHandlers, ...docsWriteHandlers, ...financeRefsHandlers, ...bankHandlers, ...reportsHandlers, ...searchHandlers, ...mockFixturesHandlers];
