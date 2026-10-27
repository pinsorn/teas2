// The shape of one row of a module's route table (master plan C0; created in P0 because C0 had not run). Type-only: no runtime import.
export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** BFF path (`/bff/v1` + path -> API `/internal/v1` + path), `{param}` style. A machine route (auth 'key') is its own full path, e.g. `/api/v1/whoami`. */
  path: string;
  auth: 'public' | 'session' | 'session-or-expired' | 'key';
  /** A catalog permission code (or a function of the path params). */
  permission?: string | ((p: Record<string, string>) => string);
  /** A non-catalog access rule in words ("any member", "own sessions", "not self"): the server enforces it in code. */
  rule?: string;
  /** Mapped on `/api/v1` and `/mcp`? "no" = an agent reaching it gets 403 agent.forbidden_action (agent.forbidden_setting under /settings). */
  agent: boolean;
  idempotency: 'required' | 'none';
  concurrency: 'version-body' | 'version-query' | 'none';
  /** Type names (documentation); the conformance check of P3 binds them to the generated types. */
  request?: string;
  response: string;
  /** Error codes besides 401 / 403 / rate limit. */
  errors: string[];
  audit?: string;
}
