#!/usr/bin/env node
// Session-orient hook. Registered as a SessionStart hook (fires on
// startup/resume/clear AND on source=compact, so this also covers
// post-compaction re-orientation). Prints a compact plain-text orientation
// block (STATUS.md excerpt, PROGRESS files, open/partial specs, recent
// routing log entries, 5h quota) — stdout is injected into context.
// Invoked as `node orient.mjs session`; argv[2] is accepted but unused
// (single mode) — kept only so the invocation in settings.json stays
// self-documenting.
//
// A PreCompact mode previously existed here but was removed: Claude Code
// docs confirm PreCompact's output only controls decision:"block" (allow/deny
// compaction) with no additionalContext-equivalent to fold text into the
// compaction summary, and SessionStart already re-fires with source=compact,
// so it already covers post-compaction re-orientation.
//
// This is orientation, not a gate: any internal failure -> exit 0, no output.
// Follows the argv-mode-switch / drain-stdin / never-throw shape of
// quota-guard/token-guard.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Drain stdin (don't wedge the hook pipe) then decide.
let _in = '';
process.stdin.on('data', c => (_in += c));
process.stdin.on('end', run);
process.stdin.on('error', run);

function run() {
  try {
    session();
  } catch { /* orientation must never block or error */ }
  process.exit(0);
}

function session() {
  const lines = [];

  // STATUS.md excerpt (first 12 non-blank lines), if present. First section.
  const statusText = safeRead(path.join(ROOT, 'STATUS.md'));
  if (statusText != null) {
    const nonBlank = statusText.split(/\r?\n/).filter(l => l.trim()).slice(0, 12);
    if (nonBlank.length) {
      lines.push('Status:');
      for (const l of nonBlank) lines.push(`  ${l}`);
    }
  }

  // PROGRESS-*.md at repo root (filenames only).
  const progressFiles = safeReaddir(ROOT)
    .filter(f => /^PROGRESS-.*\.md$/.test(f))
    .sort();
  if (progressFiles.length) {
    lines.push('Progress files:');
    for (const f of progressFiles) lines.push(`  ${f}`);
  }

  // specs/*.md (excluding TEMPLATE.md) with open/partial checklist items.
  const specsDir = path.join(ROOT, 'specs');
  const specFiles = safeReaddir(specsDir)
    .filter(f => f.endsWith('.md') && f !== 'TEMPLATE.md')
    .sort();
  const specLines = [];
  for (const f of specFiles) {
    const text = safeRead(path.join(specsDir, f));
    if (text == null) continue;
    const open = (text.match(/^- \[ \]/gm) || []).length;
    const partial = (text.match(/^- \[~\]/gm) || []).length;
    if (open || partial) specLines.push(`specs/${f} — ${open} open / ${partial} partial`);
  }
  if (specLines.length) {
    lines.push('Open specs:');
    for (const l of specLines) lines.push(`  ${l}`);
  }

  // Last 3 entry lines of ROUTING-LOG.md (skip header/comment/blank lines
  // and fenced example blocks; an entry line contains " | ").
  const routingText = safeRead(path.join(ROOT, 'ROUTING-LOG.md'));
  if (routingText != null) {
    let inFence = false;
    const entries = [];
    for (let raw of routingText.split(/\r?\n/)) {
      const t = raw.trim();
      if (t.startsWith('```')) { inFence = !inFence; continue; }
      if (inFence || !t || t.startsWith('#')) continue;
      if (t.includes(' | ')) entries.push(t);
    }
    const last3 = entries.slice(-3);
    if (last3.length) {
      lines.push('Recent routing log:');
      for (const l of last3) lines.push(`  ${l}`);
    }
  }

  // 5h quota, only if fresh and present.
  const quotaLine = readQuota();
  if (quotaLine) lines.push(quotaLine);

  if (!lines.length) return; // nothing found -> print nothing
  process.stdout.write(lines.join('\n') + '\n');
}

function readQuota() {
  try {
    const p = path.join(os.homedir(), '.claude', 'quota-guard', 'state.json');
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    const pct = s?.five_hour?.pct;
    if (pct == null) return null;
    const ageMin = (Date.now() - (s.ts || 0)) / 60000;
    if (!(ageMin < 15)) return null; // stale -> treat as unknown
    return `5h quota ~${Math.round(pct)}%`;
  } catch { return null; }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}
function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
