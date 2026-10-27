# ADR-0005: Agents never approve, cancel or correct a document

| Date | Status | Deciders |
|---|---|---|
| 2026-10-27 | Accepted | Ham, orchestrator |

## Context
SP0 §8.5 lists the rights an agent may never hold. The SP1c Connect group (HC2) went further: an agent working
through an API or MCP key can prepare work, but every decision that changes the legal state of a document stays with
a person. Without a recorded decision, a later module could add an agent route that approves, cancels or corrects.

## Decision
- No agent ever holds `doc.<TYPE>.approve`, `doc.<TYPE>.cancel` or `doc.<TYPE>.correct`, for ANY document type, nor
  any other code the frozen `AgentForbidden` rule names (`frontend/src/contract/platform.ts`) (Q9).
- Agents may create / compute / update / delete their own drafts, request a review, issue through the review gate,
  and read (GET) except `/connect/*`, `/oauth/*`, `/auth/*` (mock `AGENT_ALLOWED`).
- Enforced by construction (`docs/specs/SP3-platform.md` §4.6): the machine groups `/api/v1` and `/mcp` map only
  routes with `agent: true`; a route declaring `agent: true` with an agent-forbidden permission is a declaration error;
  an agent reaching any other route gets 403 `agent.forbidden_action` / `agent.forbidden_setting` before the body is
  read; an agent's rights are its key scopes ∩ its owner's rights minus the forbidden codes.

## Consequences
- An approval inbox always needs a person; agents feed it.
- Changing this needs a new ADR and a contract version bump (the rule is part of the frozen platform contract).

## Spec changes
`docs/specs/SP3-platform.md` §4.5, §4.6 and the Ham rulings of 2026-10-27 (Q9); stricter than SP0 §8.5.
