import { docsReadHandlers } from './docs-read';
import { docsWriteHandlers } from './docs-write';
import { homeHandlers } from './home';
import { itemsHandlers } from './items';
import { meHandlers } from './me';
import { partiesHandlers } from './parties';
import { searchHandlers } from './search';

export * from './common';
export const handlers = [...meHandlers, ...homeHandlers, ...partiesHandlers, ...itemsHandlers, ...docsReadHandlers, ...docsWriteHandlers, ...searchHandlers];
