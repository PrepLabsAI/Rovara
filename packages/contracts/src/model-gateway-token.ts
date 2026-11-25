// Contract TC-1: keep this field list identical to the gateway's copy (checked by the controller).
import { z } from "zod";
import { RunPriceSchema } from "./run-price.js";
import { PayerSchema, WorkOriginSchema } from "./agent-run-node.js";
import { OrgIdSchema } from "./company-scope.js";
import { AGENTX_NAME_PATTERN } from "./names.js";

export const TASK_KEY_PURPOSE = "task";
export const TASK_KEY_PURPOSE_MEMBER = "rovara_purpose";
export const TASK_TOKEN_AUDIENCE = "rovara-model-gateway";
export const TASK_TOKEN_TYP = "rovara-task+jwt";
export const TASK_TOKEN_ALGORITHM = "RS256";
export const TASK_TOKEN_SECONDS = 900;
export const REVIEWER_GRANT_SECONDS = 120;
export const TASK_TOKEN_SKEW_SECONDS = 30;
export const TASK_TOKEN_SIGNING_INPUT_MAX_BYTES = 3500;
export const TASK_TOKEN_CLAIMS = [
  { name: "iss", type: "string", required: true },
  { name: "aud", type: "string", required: true },
  { name: "jti", type: "UUID", required: true },
  { name: "iat", type: "integer", required: true },
  { name: "nbf", type: "integer", required: true },
  { name: "exp", type: "integer", required: true },
  { name: "cid", type: "string", required: true },
  { name: "pid", type: "string", required: true },
  { name: "per", type: "string", required: false },
  { name: "pay", type: "Payer", required: true },
  { name: "tid", type: "string", required: true },
  { name: "ws", type: "UUID", required: true },
  { name: "op", type: "UUID", required: true },
  { name: "stp", type: "string", required: true },
  { name: "src", type: "WorkOrigin", required: false },
  { name: "mdl", type: "string[]", required: true },
  { name: "runPrice", type: "RunPrice", required: false },
  { name: "reviewer", type: "ReviewerGrant", required: false },
] as const;

const seconds = z.number().int().nonnegative();
export const TaskTokenClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.literal(TASK_TOKEN_AUDIENCE),
  jti: z.uuid(),
  iat: seconds,
  nbf: seconds,
  exp: seconds,
  cid: OrgIdSchema,
  pid: z.string().regex(AGENTX_NAME_PATTERN),
  per: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  pay: PayerSchema,
  tid: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u),
  ws: z.uuid(),
  op: z.uuid(),
  stp: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  // Reporting only. No authorization or money decision reads this claim.
  src: WorkOriginSchema.optional(),
  mdl: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u)).min(1).max(16),
  runPrice: RunPriceSchema.optional(),
  /** One reviewer model; cid/pid/tid/ws/op bind the task. Gateway must atomically open or debit the bound jti session before spending. */
  reviewer: z.object({ kind: z.enum(["second_review", "design_review", "tier_review"]), slot: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), ceilingUsd: z.number().finite().positive().max(1_000_000) }).strict().optional(),
}).strict().superRefine((claims, context) => {
  if (claims.runPrice !== undefined && (claims.runPrice.companyId !== claims.cid || claims.mdl.length !== 1 || claims.runPrice.model !== claims.mdl[0])) context.addIssue({ code: "custom", path: ["runPrice"], message: "price must bind the company and one allowed model" });
  if (claims.reviewer !== undefined && (claims.mdl.length !== 1 || claims.stp !== claims.reviewer.kind || (claims.reviewer.kind === "second_review" && claims.reviewer.slot !== "second_review") || claims.exp - claims.iat !== REVIEWER_GRANT_SECONDS)) {
    context.addIssue({ code: "custom", path: ["reviewer"], message: "a reviewer requires one kind, one model and the reviewer TTL" });
  }
});
export type TaskTokenClaims = z.infer<typeof TaskTokenClaimsSchema>;

/** Malformed claims have no partial interpretation and carry no diagnostic text. */
export function parseTaskTokenClaims(value: unknown): TaskTokenClaims | undefined {
  // The schema rejects over-count model arrays before visiting their elements.
  const parsed = TaskTokenClaimsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The issuer supplies integer seconds; lifetime and skew are never caller options. */
export function taskTokenClaimsFor(input: Omit<TaskTokenClaims, "aud" | "nbf" | "exp">): TaskTokenClaims | undefined {
  return parseTaskTokenClaims({ ...input, aud: TASK_TOKEN_AUDIENCE, nbf: input.iat - TASK_TOKEN_SKEW_SECONDS, exp: input.iat + (input.reviewer === undefined ? TASK_TOKEN_SECONDS : REVIEWER_GRANT_SECONDS) });
}

/** After signature/issuer verification only. The gateway's callback MUST atomically open or debit the SAME bound jti session (including concurrent requests), preserve its original ceiling, and refuse closed/exhausted sessions or any use beyond 600 s from first use. Token renewal never opens another session. */
export async function consumeReviewerGrant(claims: TaskTokenClaims, expected: Pick<TaskTokenClaims, "cid" | "pid" | "tid" | "ws" | "op"> & { kind: "second_review" | "design_review" | "tier_review"; slot: string; model: string }, nowSeconds: number, consume: (jti: string, expiresAt: number) => Promise<boolean>): Promise<boolean> {
  const parsed = parseTaskTokenClaims(claims);
  if (parsed?.reviewer === undefined || !Number.isSafeInteger(nowSeconds) || nowSeconds < parsed.iat || nowSeconds >= parsed.exp || parsed.cid !== expected.cid || parsed.pid !== expected.pid || parsed.tid !== expected.tid || parsed.ws !== expected.ws || parsed.op !== expected.op || parsed.reviewer.kind !== expected.kind || parsed.reviewer.slot !== expected.slot || parsed.mdl[0] !== expected.model) return false;
  try { return (await consume(parsed.jti, parsed.exp)) === true; } catch { return false; }
}
