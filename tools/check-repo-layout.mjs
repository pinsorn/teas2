// tools/check-repo-layout.mjs
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ALLOW = {
  files: ['README.md', 'CLAUDE.md', 'STATUS.md', 'ROUTING-LOG.md', 'CHANGELOG.md', 'LICENSE',
    'troubles-wiki.md', '.gitattributes', '.gitignore', '.mcp.json'],
  dirs: ['.claude', '.github', 'docs', 'backend', 'frontend', 'deploy', 'tools', 'fixtures'],
};

export function findViolations(entries, allow) {
  const bad = new Set();
  for (const e of entries) {
    const [top, ...rest] = e.split('/');
    const isDir = rest.length > 0;
    if (isDir ? !allow.dirs.includes(top) : !allow.files.includes(top)) bad.add(top);
  }
  return [...bad].sort();
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const entries = execSync('git -c core.quotePath=false ls-files -z', { encoding: 'utf8', cwd: root }).split('\0').filter(Boolean);
  const bad = findViolations(entries, ALLOW);
  if (bad.length) { console.error('Root entries outside the allow-list:\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log('repo layout ok');
}
