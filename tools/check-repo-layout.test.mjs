// tools/check-repo-layout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations, ALLOW } from './check-repo-layout.mjs';

test('accepts every allowed root entry', () => {
  const entries = [...ALLOW.files, ...ALLOW.dirs.map((d) => `${d}/x`)];
  assert.deepEqual(findViolations(entries, ALLOW), []);
});

test('rejects debris at the root', () => {
  const entries = ['README.md', 'mockup-full.png', 'PLAN-x.md', 'scratch.log', 'frontend/package.json'];
  assert.deepEqual(findViolations(entries, ALLOW), ['PLAN-x.md', 'mockup-full.png', 'scratch.log']);
});

test('later plans’ roots are allowed', () => {
  const entries = ['fixtures/golden/teas1/S-01.json', 'tools/golden-capture/run.mjs', 'deploy/x', '.mcp.json'];
  assert.deepEqual(findViolations(entries, ALLOW), []);
});
