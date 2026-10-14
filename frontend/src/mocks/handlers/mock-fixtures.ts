import { HttpResponse, http } from 'msw';
import { fixtureIds } from '../fixtures/ids';
import { loadState, saveState } from '../store';
import { problem } from './common';

/** Test/e2e support: named fixture documents resolved against the CURRENT mock state. Deliberately no screenGate. */
export const mockFixturesHandlers = [
  /** Writes the current (possibly still unsaved seed) state to storage, so an e2e test can edit the stored state and reload. */
  http.post('*/bff/v1/mock/persist', () => { saveState(loadState()); return new HttpResponse(null, { status: 204 }); }),
  http.get('*/bff/v1/mock/fixtures', () => {
    try { return HttpResponse.json(fixtureIds(loadState())); } catch (e) {
      return problem(500, 'mock.fixture_unresolved', e instanceof Error ? e.message : 'fixture ids unresolved');
    }
  }),
];
