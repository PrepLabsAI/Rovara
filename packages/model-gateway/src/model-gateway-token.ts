// TC-1, binding ADDENDUM-1. Mirrored by contracts/shared/model-gateway-token.v1.json.
export const TASK_TOKEN_TYPE = "rovara-task+jwt";
export const TASK_TOKEN_AUDIENCE = "rovara-model-gateway";
export const TASK_TOKEN_ALGORITHM = "RS256";
export const TASK_TOKEN_SECONDS = 900;
/** The lifetime of a reviewer grant (Code's REVIEWER_GRANT_SECONDS): exactly this, never a caller option. */
export const REVIEWER_GRANT_SECONDS = 120;
export const TASK_KEY_PURPOSE = "task";
export const TASK_KEY_PURPOSE_MEMBER = "rovara_purpose";
export const TASK_TOKEN_CLAIMS = [
  {
    "name": "iss",
    "type": "string",
    "required": true
  },
  {
    "name": "aud",
    "type": "string",
    "required": true
  },
  {
    "name": "jti",
    "type": "UUID",
    "required": true
  },
  {
    "name": "iat",
    "type": "integer",
    "required": true
  },
  {
    "name": "nbf",
    "type": "integer",
    "required": true
  },
  {
    "name": "exp",
    "type": "integer",
    "required": true
  },
  {
    "name": "cid",
    "type": "string",
    "required": true
  },
  {
    "name": "pid",
    "type": "string",
    "required": true
  },
  {
    "name": "per",
    "type": "string",
    "required": false
  },
  {
    "name": "pay",
    "type": "Payer",
    "required": true
  },
  {
    "name": "tid",
    "type": "string",
    "required": true
  },
  {
    "name": "ws",
    "type": "UUID",
    "required": true
  },
  {
    "name": "op",
    "type": "UUID",
    "required": true
  },
  {
    "name": "stp",
    "type": "string",
    "required": true
  },
  {
    "name": "src",
    "type": "WorkOrigin",
    "required": false
  },
  {
    "name": "mdl",
    "type": "string[]",
    "required": true
  },
  { name: "runPrice", type: "RunPrice", required: false },
  {
    "name": "reviewer",
    "type": "ReviewerGrant",
    "required": false
  }
] as const;

export const WORK_ORIGINS = ["app", "cli", "mcp", "slack", "linear", "jira", "github_issue", "tracker", "offer", "test_run", "event", "schedule", "chain", "nightly", "automatic"] as const;
export const COMPANY = /^org_[0-9a-z]{20}$/u;
export const PROJECT = /^[a-z][a-z0-9-]{0,62}$/u;
export const PERSON = /^[a-f0-9]{64}$/u;
export const TASK = /^[A-Za-z0-9_.:-]{1,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
const BUILTIN_AGENTS = new Set(["rovara-code", "ticket-triage", "root-cause-analyst", "code-reviewer", "deploy-reviewer", "service-reviewer"]);
export type Payer = { kind: "member"; developerId: string } | { kind: "project"; project: string } | { kind: "agent"; agentId: string } | { kind: "chain"; chainId: string };
/**
 * DEC 254zzz41: one reviewer model for one task and one review kind. The signed cid/pid/tid/ws/op bind the task; the gateway consumes the jti once.
 * `tier_review`: the code or security review a change that grew above its planned tier must pass; the same per-call ceiling, binding and single use as the others.
 */
export const REVIEWER_KINDS = ["second_review", "design_review", "tier_review"] as const;
export type ReviewerKind = typeof REVIEWER_KINDS[number];
export interface ReviewerGrant { kind: ReviewerKind; slot: string; ceilingUsd: number }
/**
 * PRICE-BANDS: the model's BASE band, beside the pooled maximum the run price states. A call whose whole input (plain + cache read + cache write) is at most `upToInputTokens` is settled at these rates;
 * a larger one at the long-context band (never above the pooled figures). Optional and signed with the token: a run price without it is the pooled ceiling alone, exactly as before.
 */
export interface RunPriceBaseBand { upToInputTokens: number; inputUsdPerMillion: number; outputUsdPerMillion: number; cacheWriteUsdPerMillion: number; cacheReadUsdPerMillion: number }
export interface RunPrice {
  companyId: string; model: string; provider: string; sourceId: string; connectionRevision: string;
  catalogModel: string; snapshotHash: string; snapshotVersion: number; expiresAt: number;
  inputUsdPerMillion: number; outputUsdPerMillion: number; cacheWriteUsdPerMillion: number; cacheReadUsdPerMillion: number;
  baseBand?: RunPriceBaseBand;
}
const RATE_FIELDS = ["inputUsdPerMillion", "outputUsdPerMillion", "cacheWriteUsdPerMillion", "cacheReadUsdPerMillion"] as const;
const rateOk = (key: typeof RATE_FIELDS[number], value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= (key === "cacheReadUsdPerMillion" ? 0 : 0.000001) && value <= 1_000_000;
/** A base band is exactly its five fields, each rate valid and NOT above the pooled rate beside it (a band can only lower what the pooled run price already bounds). */
function parseBaseBand(value: unknown, pooled: Record<string, unknown>): RunPriceBaseBand | undefined {
  const b = record(value);
  if (b === undefined || Object.keys(b).length !== 5 || !whole(b.upToInputTokens) || b.upToInputTokens === 0) return undefined;
  for (const key of RATE_FIELDS) if (!rateOk(key, b[key]) || b[key] > (pooled[key] as number)) return undefined;
  return b as unknown as RunPriceBaseBand;
}
export function parseRunPrice(value: unknown): RunPrice | undefined {
  const p = record(value);
  if (p === undefined || Object.keys(p).length !== (Object.hasOwn(p, "baseBand") ? 14 : 13) || !matches(p.companyId, COMPANY) || !matches(p.model, /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u)) return undefined;
  for (const key of ["provider", "sourceId", "connectionRevision", "catalogModel"] as const) if (typeof p[key] !== "string" || !p[key] || p[key].length > (key === "provider" ? 64 : key === "catalogModel" ? 256 : 512)) return undefined;
  if (!matches(p.snapshotHash, /^[a-f0-9]{64}$/u) || !whole(p.snapshotVersion) || p.snapshotVersion === 0 || !whole(p.expiresAt) || p.expiresAt === 0) return undefined;
  for (const key of RATE_FIELDS) if (!rateOk(key, p[key])) return undefined;
  if (Object.hasOwn(p, "baseBand") && parseBaseBand(p.baseBand, p) === undefined) return undefined;
  return p as unknown as RunPrice;
}
export interface TaskClaims {
  iss: string; aud: typeof TASK_TOKEN_AUDIENCE; jti: string; iat: number; nbf: number; exp: number;
  cid: string; pid: string; per?: string; pay: Payer; tid: string; ws: string; op: string;
  stp: string; src?: typeof WORK_ORIGINS[number]; mdl: string[]; reviewer?: ReviewerGrant; runPrice?: RunPrice;
}
export const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
export const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const matches = (v: unknown, pattern: RegExp): v is string => typeof v === "string" && pattern.test(v);
function payer(v: unknown): boolean {
  const p = record(v); if (p === undefined || Object.keys(p).length !== 2) return false;
  switch (p.kind) {
    case "member": return matches(p.developerId, PERSON);
    case "project": return matches(p.project, PROJECT);
    case "chain": return matches(p.chainId, /^chn_[0-9a-z]{20}$/u);
    case "agent": return typeof p.agentId === "string" && (BUILTIN_AGENTS.has(p.agentId) || /^agt_[0-9a-z]{20}$/u.test(p.agentId));
    default: return false;
  }
}
export function parseTaskClaims(value: unknown): TaskClaims | undefined {
  const c = record(value); if (c === undefined) return undefined;
  if (Object.keys(c).some((key) => !TASK_TOKEN_CLAIMS.some((f) => f.name === key))) return undefined;
  if (TASK_TOKEN_CLAIMS.some((f) => f.required && !Object.hasOwn(c, f.name))) return undefined;
  if (typeof c.iss !== "string" || c.iss.length === 0 || c.iss.length > 2048 || c.aud !== TASK_TOKEN_AUDIENCE) return undefined;
  if (![c.jti, c.ws, c.op].every((v) => matches(v, UUID)) || ![c.iat, c.nbf, c.exp].every(whole)) return undefined;
  if (!matches(c.cid, COMPANY) || !matches(c.pid, PROJECT) || !matches(c.tid, TASK) || (c.per !== undefined && !matches(c.per, PERSON))) return undefined;
  if (!payer(c.pay) || !matches(c.stp, /^[a-z][a-z0-9_-]{0,63}$/u) || (c.src !== undefined && !WORK_ORIGINS.some((s) => s === c.src))) return undefined;
  if (!Array.isArray(c.mdl) || c.mdl.length < 1 || c.mdl.length > 16 || !c.mdl.every((v: unknown) => matches(v, MODEL))) return undefined;
  if (c.runPrice !== undefined) { const p = parseRunPrice(c.runPrice); if (p === undefined || p.companyId !== c.cid || c.mdl.length !== 1 || p.model !== c.mdl[0]) return undefined; }
  if (c.reviewer !== undefined && !reviewerOk(c)) return undefined;
  return c as unknown as TaskClaims;
}
const REVIEWER_SLOT = /^[a-z][a-z0-9_-]{0,63}$/u;
/** Code's TaskTokenClaimsSchema `reviewer` rules, exactly: strict members, one model, step = kind, the second review's own slot, the 120 second life. */
function reviewerOk(c: Record<string, unknown>): boolean {
  const r = record(c.reviewer);
  if (r === undefined || Object.keys(r).length !== 3 || !REVIEWER_KINDS.some((k) => k === r.kind) || !matches(r.slot, REVIEWER_SLOT)) return false;
  if (typeof r.ceilingUsd !== "number" || !Number.isFinite(r.ceilingUsd) || r.ceilingUsd <= 0 || r.ceilingUsd > 1_000_000) return false;
  return (c.mdl as unknown[]).length === 1 && c.stp === r.kind && (r.kind !== "second_review" || r.slot === "second_review") && (c.exp as number) - (c.iat as number) === REVIEWER_GRANT_SECONDS;
}
/** What the gateway itself knows about the call being made, never taken from the grant. */
export interface ReviewerExpectation { cid: string; pid: string; tid: string; ws: string; op: string; kind: ReviewerKind; slot: string; model: string }
/**
 * After signature and issuer verification only (Code's consumeReviewerGrant, packages/contracts model-gateway-token.ts; a contract test holds the two
 * to the same answers). True only when the grant is inside its lifetime, bound to exactly the expected company, project, task, workspace, operation,
 * kind, slot and model, AND `consume` atomically claims its jti for the first time. A throw or a refusal from `consume` is a refusal here.
 */
export async function consumeReviewerGrant(claims: TaskClaims, expected: ReviewerExpectation, nowSeconds: number, consume: (jti: string, expiresAt: number) => Promise<boolean>): Promise<boolean> {
  const parsed = parseTaskClaims(claims);
  if (parsed?.reviewer === undefined || !Number.isSafeInteger(nowSeconds) || nowSeconds < parsed.iat || nowSeconds >= parsed.exp || parsed.cid !== expected.cid || parsed.pid !== expected.pid || parsed.tid !== expected.tid || parsed.ws !== expected.ws || parsed.op !== expected.op || parsed.reviewer.kind !== expected.kind || parsed.reviewer.slot !== expected.slot || parsed.mdl[0] !== expected.model) return false;
  try { return (await consume(parsed.jti, parsed.exp)) === true; } catch { return false; }
}
