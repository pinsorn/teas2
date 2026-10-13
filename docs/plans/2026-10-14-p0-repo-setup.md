# P0 — Repo and Orchestrator Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TEAS2 repo ready for gated, orchestrated work: trimmed orchestrator setup, repo hygiene,
templates, a root-layout check and a GitHub remote.

**Architecture:** No product code. Install `/minions` no-clobber, add a TEAS 2 project section to `CLAUDE.md`, set
line-ending and ignore rules, add the spec / ADR / research templates, and add a dependency-free Node script that
enforces the root allow-list (run later by CI).

**Tech Stack:** git, Node 24 (`node:test`), gh CLI 2.92 (logged in as `pinsorn`).

**Spec:** `docs/specs/SP0-charter.md` — §11.1 (repo layout), §11.7 (orchestration), §11.8 (git), §1.2 S8 (hygiene).

## Global Constraints

- Repo: `Y:\ClaudePlayground\TEAS2`, branch `main`. TEAS 1 (`Y:\ClaudePlayground\TEAS-Project`) is read-only.
- Root allow-list (files): `README.md`, `CLAUDE.md`, `STATUS.md`, `ROUTING-LOG.md`, `CHANGELOG.md`, `LICENSE`,
  `troubles-wiki.md`, `.gitattributes`, `.gitignore`, `.mcp.json`.
- Root allow-list (directories): `.claude`, `.github`, `docs`, `backend`, `frontend`, `deploy`, `tools`, `fixtures`.
- Never committed: screenshots, logs, generated sites, build output, local env files.
- Line endings: LF in the repository, except `*.ps1`, `*.bat`, `*.cmd` (CRLF).
- Conventional commits; every commit ends with the session attribution trailers.
- Outward-facing actions (creating the GitHub repo, pushing) need Ham's explicit yes at execution time.

## Review Focus

1. Existing files (`STATUS.md`, `docs/**`) must be byte-identical after the `/minions` install — no-clobber is the
   whole point.
2. The project `.claude/settings.json` hook merge must append the `SessionStart` entry, never replace other keys.
3. The root allow-list must accept every root entry the later plans create (`frontend/`, `fixtures/`, `tools/`,
   `.mcp.json`, `deploy/`).
4. Renormalising line endings must not change file content beyond EOL.
5. Nothing is pushed before Ham chooses public or private.

---

### Task 1: Install the orchestrator setup with `/minions` (no-clobber, trimmed)

**Files:**
- Create (from `pinsorn/minions-assemble`, only where absent): `CLAUDE.md`, `.claude/agents/**`,
  `.claude/dispatch-templates/**`, `.claude/hooks/orient.mjs`, `.claude/settings.json`, `troubles-wiki.md`
- Not installed: `PLAN.md`, `README.md`, `tools/`
- Unchanged: `STATUS.md`, `docs/**`

**Interfaces:**
- Produces: `CLAUDE.md` (orchestrator rules, extended in Task 2); `.claude/hooks/orient.mjs` (injects the head of
  `STATUS.md` at session start); agent definitions referenced by later plans (`sonnet-implementer`,
  `opus-reviewer`, `opus-designer`, `haiku-gate-runner`, `acceptance-tester`, `agy-runner`, `codex:codex-rescue`).

- [ ] **Step 1: Record the pre-install state**

```bash
cd "Y:/ClaudePlayground/TEAS2"
git status --short            # expected: clean
git ls-files | sort > "$SCRATCH/before.txt"
```
`$SCRATCH` = the session scratchpad directory.

- [ ] **Step 2: Clone the template**

```bash
git clone --depth 1 https://github.com/pinsorn/minions-assemble.git "$SCRATCH/minions-assemble"
```
Expected: clone succeeds. On failure run `gh auth status` and stop with the error.

- [ ] **Step 3: Copy no-clobber**

```bash
SRC="$SCRATCH/minions-assemble"
for f in CLAUDE.md troubles-wiki.md .claude/hooks/orient.mjs; do
  [ -e "$f" ] || { mkdir -p "$(dirname "$f")"; cp "$SRC/$f" "$f"; }
done
mkdir -p .claude/agents .claude/dispatch-templates
cp -rn "$SRC/.claude/agents/." .claude/agents/
cp -rn "$SRC/.claude/dispatch-templates/." .claude/dispatch-templates/
```

- [ ] **Step 4: Merge the SessionStart hook (append-only)**

```bash
node -e '
const fs=require("fs");const src=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const p=".claude/settings.json";const dst=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};
const entries=(src.hooks&&src.hooks.SessionStart)||[];
dst.hooks=dst.hooks||{};dst.hooks.SessionStart=dst.hooks.SessionStart||[];
const has=JSON.stringify(dst.hooks.SessionStart).includes("orient.mjs");
if(!has) dst.hooks.SessionStart.push(...entries);
fs.writeFileSync(p,JSON.stringify(dst,null,2)+"\n");console.log(has?"hook already present":"hook appended");
' "$SCRATCH/minions-assemble/.claude/settings.json"
```

- [ ] **Step 5: Install quota-guard (non-fatal)**

```bash
node "$SCRATCH/minions-assemble/tools/install-quota-guard.mjs" "$SCRATCH/minions-assemble/quota-guard" || echo "quota-guard install skipped"
```

- [ ] **Step 6: Verify no-clobber**

```bash
git diff --exit-code -- STATUS.md docs   # expected: exit 0 (no changes)
git status --short                         # expected: only new files under .claude/, CLAUDE.md, troubles-wiki.md
```

- [ ] **Step 7: Commit and clean up**

```bash
git add CLAUDE.md troubles-wiki.md .claude/agents .claude/dispatch-templates .claude/hooks/orient.mjs .claude/settings.json
git commit -m "chore: install orchestrator setup from minions-assemble"
rm -rf "$SCRATCH/minions-assemble"
```

---

### Task 2: TEAS 2 project section in `CLAUDE.md` + routing log

**Files:**
- Modify: `CLAUDE.md` (insert a project section directly after the first heading)
- Create: `ROUTING-LOG.md`

**Interfaces:**
- Produces: the "where things live" rules every later worker follows; `ROUTING-LOG.md` table that every dispatch
  appends to.

- [ ] **Step 1: Insert the project section**

Insert this block after the first `#` heading line of `CLAUDE.md`:

```markdown
## TEAS 2 project map (read first)

| What | Where |
|---|---|
| Status board (the only one) | `STATUS.md` |
| Approved design | `docs/specs/SP0-charter.md` (+ `SP0-diagrams.md`) |
| Living specs (one per capability) | `docs/specs/` — start from `docs/specs/_TEMPLATE.md` |
| Implementation plans | `docs/plans/` — progress = the plan's checkboxes |
| Decisions after SP0 | `docs/adr/` — start from `docs/adr/_TEMPLATE.md` |
| Tax research notes | `docs/research/tax/` — start from `docs/research/tax/_TEMPLATE.md` |
| Golden fixtures | `fixtures/golden/` |
| Repo scripts | `tools/` |
| Dispatch log | `ROUTING-LOG.md` |
| Known issues | `troubles-wiki.md` |
| TEAS 1 (reference only, never modified) | `Y:\ClaudePlayground\TEAS-Project` and `docs/discovery/01`–`04` |

Paperwork rules: no `PLAN-*` / `PROGRESS-*` files at the root. Quota checkpoints go to `docs/plans/progress/`.
Nothing at the root outside the allow-list in `tools/check-repo-layout.mjs`.

Machine facts: no Docker on the dev box (Gotenberg runs on staging only); pnpm via `corepack pnpm`; local
PostgreSQL 18 at `S:\Program Files\PostgreSQL\18`, port 5432; Chrome installed (Playwright `channel: 'chrome'`).
```

- [ ] **Step 2: Create the routing log**

```markdown
# ROUTING-LOG — TEAS 2

| Date | Task | Worker | Why this worker |
|---|---|---|---|
```

- [ ] **Step 3: Verify and commit**

```bash
grep -n "TEAS 2 project map" CLAUDE.md   # expected: one hit near the top
git add CLAUDE.md ROUTING-LOG.md
git commit -m "docs: add TEAS 2 project map and routing log"
```

---

### Task 3: Repo hygiene — line endings, ignore rules, README, license

**Files:**
- Create: `.gitattributes`, `.gitignore`, `README.md`, `LICENSE` (copied from `Y:\ClaudePlayground\TEAS-Project\LICENSE`)

- [ ] **Step 1: Write `.gitattributes`**

```gitattributes
* text=auto eol=lf
*.ps1 text eol=crlf
*.bat text eol=crlf
*.cmd text eol=crlf
*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.ico binary
*.pdf binary
*.woff binary
*.woff2 binary
*.ttf binary
*.otf binary
*.xlsx binary
*.zip binary
```

- [ ] **Step 2: Write `.gitignore`**

```gitignore
# dependencies and build output
node_modules/
.next/
out/
dist/
bin/
obj/
coverage/
playwright-report/
test-results/
*.tsbuildinfo
# env and secrets
.env
.env.*
!.env.example
# logs, screenshots, scratch
*.log
screenshots/
shots/
scratch/
codex-out/
agy-out/
# editors and OS
.DS_Store
Thumbs.db
.vs/
.idea/
*.swp
# local Claude settings
.claude/settings.local.json
```

- [ ] **Step 3: Write `README.md`**

```markdown
# TEAS 2

ระบบบัญชีสำหรับธุรกิจไทย รุ่นที่ 2 — ฟีเจอร์เท่า TEAS 1 แต่ยืดหยุ่นทางบัญชีกว่า ใช้งานเร็วกว่า และพัฒนาเป็นขั้นตอนที่มี gate ชัดเจน

- Status: [`STATUS.md`](STATUS.md)
- Design: [`docs/specs/SP0-charter.md`](docs/specs/SP0-charter.md) · diagrams [`docs/specs/SP0-diagrams.md`](docs/specs/SP0-diagrams.md)
- Plans: [`docs/plans/`](docs/plans/)

License: [GNU AGPL-3.0](LICENSE)
```

- [ ] **Step 4: Copy the license and renormalise**

```bash
cp "Y:/ClaudePlayground/TEAS-Project/LICENSE" LICENSE
git add .gitattributes .gitignore README.md LICENSE
git add --renormalize .
git diff --cached --ignore-cr-at-eol --stat -- docs STATUS.md   # expected: no output (EOL-only or nothing)
```

- [ ] **Step 5: Commit**

```bash
git commit -m "chore: add line-ending policy, ignore rules, README and AGPL license"
```

---

### Task 4: Root-layout check + templates

**Files:**
- Create: `tools/check-repo-layout.mjs`, `tools/check-repo-layout.test.mjs`
- Create: `docs/specs/_TEMPLATE.md`, `docs/adr/_TEMPLATE.md`, `docs/research/tax/_TEMPLATE.md`

**Interfaces:**
- Produces: `findViolations(entries: string[], allow: {files: string[], dirs: string[]}): string[]` and the CLI
  `node tools/check-repo-layout.mjs` (exit 1 on violations). The SP1 frontend CI job runs it.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/check-repo-layout.test.mjs`
Expected: FAIL — `Cannot find module './check-repo-layout.mjs'`.

- [ ] **Step 3: Implement**

```js
// tools/check-repo-layout.mjs
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entries = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
  const bad = findViolations(entries, ALLOW);
  if (bad.length) { console.error('Root entries outside the allow-list:\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log('repo layout ok');
}
```

- [ ] **Step 4: Run the tests and the check**

Run: `node --test tools/check-repo-layout.test.mjs && node tools/check-repo-layout.mjs`
Expected: 3 tests pass; `repo layout ok`.

- [ ] **Step 5: Write the spec template**

```markdown
# <SP id> — <Capability>

| | |
|---|---|
| Status | Draft / Approved (date) / Done (date) |
| Owner | Ham |
| Implements | `docs/specs/SP0-charter.md` §… |
| Blast cap | max N files · API changes: none / list — hitting the cap = stop and re-spec |

## Goal
## Requirements (numbered, testable)
## Design
## Definition of Done (SP0 §11.5)
- [ ] Descriptors complete: lifecycle, every guard has an exit, correction policy
- [ ] Date model and period gate applied
- [ ] Permissions in the catalog; frontend gating; MCP tools and agent-policy defaults
- [ ] Error codes registered in Thai and English
- [ ] Every screen state implemented (loading, empty, error, forbidden, locked; VAT and non-VAT)
- [ ] Screen = paper for every document
- [ ] Opening-balance support where the module holds balances
- [ ] Tests: domain unit, integration as `teas_app`, blind acceptance (money), e2e, golden fixtures (tax), RBAC
- [ ] Generated docs updated (OpenAPI, MCP catalog, permission map)
- [ ] Shipped screens match the approved mockups
- [ ] Parity checklist items ticked
## Verification gates (exact commands)
## Attempt log
```

- [ ] **Step 6: Write the ADR template**

```markdown
# ADR-NNNN: <decision>

| Date | Status | Deciders |
|---|---|---|
| YYYY-MM-DD | Proposed / Accepted / Superseded by ADR-NNNN | Ham, orchestrator |

## Context
## Decision
## Consequences
## Spec changes (sections of SP0 or later specs updated by this ADR)
```

- [ ] **Step 7: Write the tax research template**

```markdown
# R-NN: <rule>

| Status | Spec refs | Effective date checked |
|---|---|---|
| Researching / Consensus / Ham ruling / Superseded | SP0 §… | YYYY-MM-DD |

## Question
## Verdicts
| Model | Answer (summary) | Key primary sources | Confidence |
|---|---|---|---|
| Claude | | | |
| Codex | | | |
| AGY | | | |

## Agreement
Agree / Partial / Disagree — what differs.

## Primary-source spot check
Which source the consolidator opened, what it says (section, short quote ≤ 15 words), URL.

## Outcome
The rule TEAS 2 implements, with conditions and exceptions. If Ham ruled: the ruling, date, and why.

## Implementation consequences
Tests to write, spec sections to update, golden-fixture deltas.
```

- [ ] **Step 8: Commit**

```bash
git add tools/check-repo-layout.mjs tools/check-repo-layout.test.mjs docs/specs/_TEMPLATE.md docs/adr/_TEMPLATE.md docs/research/tax/_TEMPLATE.md
git commit -m "chore: add root-layout check and spec, ADR and research templates"
```

---

### Task 5: GitHub remote

**Files:** none in the repo.

- [x] **Step 1: Ask Ham** — answered 2026-10-14: **public** (AGPL, like TEAS 1).

- [ ] **Step 2: Create and push**

```bash
gh repo create pinsorn/teas2 --public --source . --remote origin --push    # or --private, per Ham
```
Expected: repo URL printed; `git remote -v` shows `origin`.

- [ ] **Step 3: Protect `main` (public repos, or private on a paid plan)**

```bash
gh api -X PUT repos/pinsorn/teas2/branches/main/protection --input - <<'JSON'
{ "required_status_checks": null, "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null }
JSON
```
Expected: HTTP 200. On a private free repo the API refuses — record "protection unavailable on this plan" in
`STATUS.md` instead. Required checks are added by the SP1 CI task.

- [ ] **Step 4: Verify and record**

```bash
gh repo view pinsorn/teas2 --json visibility,defaultBranchRef
```
Update `STATUS.md` (Done: P0 complete, repo URL) and commit `docs: P0 repo setup complete`; push via a PR if
protection is on.
