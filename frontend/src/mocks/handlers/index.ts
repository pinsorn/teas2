import { docsReadHandlers } from './docs-read';
import { docsWriteHandlers } from './docs-write';
import { financeRefsHandlers } from './finance-refs';
import { homeHandlers } from './home';
import { itemsHandlers } from './items';
import { meHandlers } from './me';
import { mockFixturesHandlers } from './mock-fixtures';
import { partiesHandlers } from './parties';
import { searchHandlers } from './search';

export * from './common';
export const handlers = [...meHandlers, ...homeHandlers, ...partiesHandlers, ...itemsHandlers, ...docsReadHandlers, ...docsWriteHandlers, ...financeRefsHandlers, ...searchHandlers, ...mockFixturesHandlers];
