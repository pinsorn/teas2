import { HttpResponse, http } from 'msw';
import { fixtureIds } from '../fixtures/ids';
import { loadState } from '../store';
import { problem } from './common';

/** Test/e2e support: named fixture documents resolved against the CURRENT mock state. Deliberately no screenGate. */
export const mockFixturesHandlers = [
  http.get('*/bff/v1/mock/fixtures', () => {
    try { return HttpResponse.json(fixtureIds(loadState())); } catch (e) {
      return problem(500, 'mock.fixture_unresolved', e instanceof Error ? e.message : 'fixture ids unresolved');
    }
  }),
];
