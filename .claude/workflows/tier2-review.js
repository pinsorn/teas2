export const meta = {
  name: 'tier2-review',
  description: 'Escalated Tier-2: parallel per-lens reviewers + adversarial verify per finding',
  whenToUse: 'Money/compliance diffs spanning multiple WPs, releases that already ate 2+ REJECT rounds, or a final pre-release review at extreme blast radius. Default Tier-2 (single fresh reviewer) is cheaper — use that unless the stakes justify this.',
  phases: [
    { title: 'Review', detail: 'one fresh reviewer per lens, in parallel', model: 'sonnet' },
    { title: 'Verify', detail: 'adversarial refutation of every deduped finding', model: 'opus' },
  ],
}

// args: {
//   specPath:  'specs/<task>.md'          (required)
//   diffScope: 'how to obtain the diff'   (e.g. "git diff HEAD~1" or "uncommitted working tree + untracked files X,Y")
//   lenses:    ['spec-compliance', ...]   (optional; defaults below)
//   context:   'orchestrator evidence'    (optional: worker gate evidence, known accepted deviations)
// }
const a = typeof args === 'string' ? JSON.parse(args) : (args ?? {})
const spec = a.specPath
if (!spec) throw new Error('args.specPath is required')
const diffScope = a.diffScope ?? 'the uncommitted working-tree diff (git diff + git status untracked source files)'
const context = a.context ?? ''
const LENSES = a.lenses ?? [
  'spec-compliance: walk the spec checklist item by item, map each to its diff hunk; item without hunk or hunk without item is a finding',
  'regression: what did this change break for EXISTING callers/consumers? sweep every consumer of any widened seam; check declared mirrors (FE/BE pairs, screen==print) agree on shared-field semantics',
  'security: authz on new routes, tenant scoping, RLS context of any seed/migration, input validation at trust boundaries, forgery/abuse paths',
  'money-invariants: totals tie out, partitions are disjoint+exhaustive, no silent success/failure on money paths, invariants in the spec each hold',
]

const FINDINGS = {
  type: 'object', required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', required: ['file', 'line', 'severity', 'claim', 'failureScenario'],
        properties: {
          file: { type: 'string' }, line: { type: 'number' },
          severity: { enum: ['HIGH', 'MED', 'LOW'] },
          claim: { type: 'string' },
          failureScenario: { type: 'string', description: 'concrete inputs/state -> wrong output' },
        },
      },
    },
  },
}
const VERDICT = {
  type: 'object', required: ['refuted', 'reasoning'],
  properties: {
    refuted: { type: 'boolean', description: 'true = the finding does NOT hold' },
    confirmedSeverity: { enum: ['HIGH', 'MED', 'LOW'] },
    reasoning: { type: 'string' },
  },
}

phase('Review')
const reviews = await parallel(LENSES.map((lens) => () => agent(
  `You are a fresh Tier-2 reviewer on repo ${'Y:\\ClaudePlayground\\TEAS-Project'.replace(/\\\\/g, '\\')} (use the repo at the current working directory if that path is wrong). READ-ONLY: no edits, no git writes, no builds, no tests (shared test DB).
Read the spec ${spec} in full, then review ${diffScope} through ONE lens only:
${lens}
${context ? `Orchestrator context (trusted): ${context}` : ''}
Every finding needs file + 1-indexed line + a CONCRETE failure scenario (inputs/state -> wrong output). No vague suggestions. Return findings only via the structured output.`,
  { label: `review:${lens.split(':')[0]}`, phase: 'Review', model: 'sonnet', schema: FINDINGS },
)))

const all = reviews.filter(Boolean).flatMap((r) => r.findings)
const seen = new Map()
for (const f of all) {
  const key = `${f.file}:${f.line}`
  if (!seen.has(key) || (f.severity === 'HIGH' && seen.get(key).severity !== 'HIGH')) seen.set(key, f)
}
let deduped = [...seen.values()]
log(`${all.length} raw findings -> ${deduped.length} after dedup`)
const CAP = 10
if (deduped.length > CAP) {
  const order = { HIGH: 0, MED: 1, LOW: 2 }
  deduped.sort((a, b) => order[a.severity] - order[b.severity])
  log(`capping verification at ${CAP} by severity — DROPPED unverified: ${deduped.slice(CAP).map((f) => `${f.file}:${f.line} [${f.severity}]`).join(', ')}`)
  deduped = deduped.slice(0, CAP)
}

phase('Verify')
const verified = await parallel(deduped.map((f) => () => agent(
  `READ-ONLY adversarial verification in the repo at the current working directory. A reviewer claims:
${f.file}:${f.line} [${f.severity}] ${f.claim}
Failure scenario: ${f.failureScenario}
Try hard to REFUTE it by reading the actual code (trace the real path, check the claimed line exists and behaves as claimed). Default to refuted=true if the scenario cannot actually occur. If it holds, set confirmedSeverity honestly (it may be lower than claimed).`,
  { label: `verify:${f.file.split(/[\\/]/).pop()}:${f.line}`, phase: 'Verify', model: 'opus', schema: VERDICT },
).then((v) => ({ ...f, verdict: v }))))

const confirmed = verified.filter(Boolean).filter((x) => x.verdict && !x.verdict.refuted)
  .map((x) => ({ ...x, severity: x.verdict.confirmedSeverity ?? x.severity }))
const refuted = verified.filter(Boolean).filter((x) => x.verdict?.refuted).length
log(`confirmed ${confirmed.length}, refuted ${refuted}`)
return {
  verdict: confirmed.some((f) => f.severity === 'HIGH') ? 'REJECT' : confirmed.length ? 'FINDINGS' : 'APPROVE',
  confirmed,
  note: 'Orchestrator (Fable) still personally verifies every confirmed finding in code before ordering fixes; any capped/dropped findings are listed in the run log.',
}
