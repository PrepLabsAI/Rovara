// Contract TC-1: keep this field list identical to the gateway's copy (checked by the controller).
import { z } from "zod";
import { PayerSchema, WorkOriginSchema } from "./agent-run-node.js";
import { OrgIdSchema } from "./company-scope.js";
import { AGENTX_NAME_PATTERN } from "./names.js";

export const TASK_KEY_PURPOSE = "task";
export const TASK_KEY_PURPOSE_MEMBER = "rovara_purpose";
export const TASK_TOKEN_AUDIENCE = "rovara-model-gateway";
export const TASK_TOKEN_TYP = "rovara-task+jwt";
export const TASK_TOKEN_ALGORITHM = "RS256";
export const TASK_TOKEN_SECONDS = 900;
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
}).strict();
export type TaskTokenClaims = z.infer<typeof TaskTokenClaimsSchema>;

/** Malformed claims have no partial interpretation and carry no diagnostic text. */
export function parseTaskTokenClaims(value: unknown): TaskTokenClaims | undefined {
  // The schema rejects over-count model arrays before visiting their elements.
  const parsed = TaskTokenClaimsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The issuer supplies integer seconds; lifetime and skew are never caller options. */
export function taskTokenClaimsFor(input: Omit<TaskTokenClaims, "aud" | "nbf" | "exp">): TaskTokenClaims | undefined {
  return parseTaskTokenClaims({ ...input, aud: TASK_TOKEN_AUDIENCE, nbf: input.iat - TASK_TOKEN_SKEW_SECONDS, exp: input.iat + TASK_TOKEN_SECONDS });
}
