import { docsReadHandlers } from './docs-read';
import { homeHandlers } from './home';
import { itemsHandlers } from './items';
import { meHandlers } from './me';
import { partiesHandlers } from './parties';
import { searchHandlers } from './search';

export * from './common';
export const handlers = [...meHandlers, ...homeHandlers, ...partiesHandlers, ...itemsHandlers, ...docsReadHandlers, ...searchHandlers];
