// Contract H-1: keep these constants, claim lists and patterns identical to contracts/shared/policy-hook.v1.json and to the answering side's copy (checked by a test in each repo).
//
// The policy hook (migration plan v3.2, section 7.5; decision 214.6). An install that names a policy address asks it three questions: may this task start,
// may this person decide this (is the sign-in fresh enough, is a second person needed), and what are the company's values. Each question is a compact JWS
// signed with the install's key; each answer is a compact JWS signed with the answering service's hook key, which the install pins (at most two keys, so
// one can be rotated). An answer that is unsigned, signed by another key, expired, or bound to another request id, question or kind is NO answer, and the
// caller treats no answer as a refusal. The hook can only make things stricter. This file is pure: no network, no clock of its own, no storage.
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { z } from "zod";

export const POLICY_HOOK_VERSION = 1;
export const POLICY_HOOK_ALG = "RS256";
export const POLICY_HOOK_QUESTION_TYP = "rovara-policy-question+jwt";
export const POLICY_HOOK_ANSWER_TYP = "rovara-policy-answer+jwt";
export const POLICY_HOOK_QUESTION_SECONDS = 360;
export const POLICY_HOOK_ANSWER_MAX_SECONDS = 300;
export const POLICY_HOOK_SKEW_SECONDS = 30;
export const POLICY_HOOK_MAX_BODY_BYTES = 8192;
export const POLICY_HOOK_PINNED_KEYS_MAX = 2;
export const POLICY_HOOK_TIMEOUT_SECONDS = 5;
export const POLICY_HOOK_START_HOLD_SECONDS = 300;
export const POLICY_HOOK_VALUES_GRACE_SECONDS = 300;
export const POLICY_HOOK_CONTENT_TYPE = "application/jose";

export const POLICY_HOOK_PATTERNS = Object.freeze({
  OrgId: /^org_[0-9a-z]{20}$/u,
  ProjectName: /^[a-z][a-z0-9-]{0,62}$/u,
  PersonId: /^[A-Za-z0-9_.:@+-]{1,128}$/u,
  TaskId: /^[A-Za-z0-9_.:-]{1,128}$/u,
  DecisionKind: /^[a-z][a-z0-9_.-]{0,63}$/u,
  Code: /^[a-z][a-z0-9_]{0,63}$/u,
  Kid: /^[A-Za-z0-9_-]{1,64}$/u,
  Issuer: /^https:\/\/[^\s]{1,504}$/u,
});

/** Fixed words a person sees. Never the service's text, never a cause. */
export const POLICY_HOOK_WORDS = Object.freeze({
  startNoAnswer: "the company rules service did not answer; nothing has started",
  startRefused: "the company rules do not allow this task to start",
  decideNoAnswer: "the company rules service did not answer; nothing was decided",
  decideRefused: "the company rules do not allow this decision",
  valuesNoAnswer: "the company rules service did not answer; the strictest settings apply",
});

export const POLICY_HOOK_KINDS = ["start", "decide", "values"] as const;
export type PolicyHookKind = typeof POLICY_HOOK_KINDS[number];

const P = POLICY_HOOK_PATTERNS;
const int = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

export const PolicyHookStartQuestionSchema = z.object({
  cid: z.string().regex(P.OrgId), pid: z.string().regex(P.ProjectName), per: z.string().regex(P.PersonId).optional(), tid: z.string().regex(P.TaskId),
  path: z.enum(["QUICK", "FULL"]).optional(), estUsdMicros: int.optional(), estTokens: int.optional(),
}).strict();
export const PolicyHookDecideQuestionSchema = z.object({
  cid: z.string().regex(P.OrgId), pid: z.string().regex(P.ProjectName).optional(), stage: z.enum(["requirement", "verdict"]), what: z.string().regex(P.DecisionKind),
  styp: z.string().regex(P.DecisionKind), sid: z.string().regex(P.TaskId), risk: z.enum(["low", "medium", "high"]).optional(),
  by: z.string().regex(P.PersonId).optional(), per: z.string().regex(P.PersonId).optional(), auth: int.optional(),
}).strict();
export const PolicyHookValuesQuestionSchema = z.object({ cid: z.string().regex(P.OrgId), pid: z.string().regex(P.ProjectName).optional() }).strict();

export const PolicyHookStartAnswerSchema = z.object({ allow: z.boolean(), code: z.string().regex(P.Code).optional() }).strict();
export const PolicyHookDecideAnswerSchema = z.object({
  allow: z.boolean(), minApprovers: z.number().int().min(1).max(10), secondPerson: z.boolean(), selfApproval: z.boolean(),
  signInMaxAgeSeconds: z.number().int().min(0).max(2_592_000).optional(),
}).strict();
/** Values are checked again by the caller against its own field list (`PolicyRowsSchema`); here only their outer shape. */
export const PolicyHookValuesAnswerSchema = z.object({
  locks: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u), z.union([z.string().max(64), z.number().finite(), z.boolean(), z.null()])).refine((value) => Object.keys(value).length <= 64),
}).strict();

export type PolicyHookStartQuestion = z.infer<typeof PolicyHookStartQuestionSchema>;
export type PolicyHookDecideQuestion = z.infer<typeof PolicyHookDecideQuestionSchema>;
export type PolicyHookValuesQuestion = z.infer<typeof PolicyHookValuesQuestionSchema>;
export type PolicyHookStartAnswer = z.infer<typeof PolicyHookStartAnswerSchema>;
export type PolicyHookDecideAnswer = z.infer<typeof PolicyHookDecideAnswerSchema>;
export type PolicyHookValuesAnswer = z.infer<typeof PolicyHookValuesAnswerSchema>;
export interface PolicyHookQuestions { start: PolicyHookStartQuestion; decide: PolicyHookDecideQuestion; values: PolicyHookValuesQuestion }
export interface PolicyHookAnswers { start: PolicyHookStartAnswer; decide: PolicyHookDecideAnswer; values: PolicyHookValuesAnswer }

const questionOf = { start: PolicyHookStartQuestionSchema, decide: PolicyHookDecideQuestionSchema, values: PolicyHookValuesQuestionSchema } as const;
const answerOf = { start: PolicyHookStartAnswerSchema, decide: PolicyHookDecideAnswerSchema, values: PolicyHookValuesAnswerSchema } as const;

export const PolicyHookQuestionClaimsSchema = z.object({
  v: z.literal(POLICY_HOOK_VERSION), iss: z.string().regex(P.Issuer), rid: uuid, iat: int, exp: int, kind: z.enum(POLICY_HOOK_KINDS), q: z.record(z.string(), z.unknown()),
}).strict().superRefine((claims, context) => {
  if (claims.exp - claims.iat !== POLICY_HOOK_QUESTION_SECONDS) context.addIssue({ code: "custom", message: "lifetime" });
  if (!questionOf[claims.kind].safeParse(claims.q).success) context.addIssue({ code: "custom", message: "question" });
});
export const PolicyHookAnswerClaimsSchema = z.object({
  v: z.literal(POLICY_HOOK_VERSION), rid: uuid, qh: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), iat: int, exp: int, kind: z.enum(POLICY_HOOK_KINDS), a: z.record(z.string(), z.unknown()),
}).strict().superRefine((claims, context) => {
  if (claims.exp <= claims.iat || claims.exp - claims.iat > POLICY_HOOK_ANSWER_MAX_SECONDS) context.addIssue({ code: "custom", message: "lifetime" });
  if (!answerOf[claims.kind].safeParse(claims.a).success) context.addIssue({ code: "custom", message: "answer" });
});
export type PolicyHookQuestionClaims = z.infer<typeof PolicyHookQuestionClaimsSchema>;
export type PolicyHookAnswerClaims = z.infer<typeof PolicyHookAnswerClaimsSchema>;

/** A pinned public key, as a JWK. Only RS256 RSA keys of at least 2048 bits. */
export const PolicyHookPinnedKeySchema = z.object({
  kty: z.literal("RSA"), n: z.string().regex(/^[A-Za-z0-9_-]{342,1400}$/u), e: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/u), kid: z.string().regex(P.Kid),
  alg: z.literal(POLICY_HOOK_ALG), use: z.literal("sig").optional(),
}).strict();
export type PolicyHookPinnedKey = z.infer<typeof PolicyHookPinnedKeySchema>;

/** The install's settings for the hook (the owner's config file). Absent: no hook, and Code behaves exactly as before. */
export const PolicyHookSettingsSchema = z.object({
  /** The answering address. HTTPS, or HTTP on a loopback address only (tests and a local answering service). */
  address: z.string().max(512).refine(policyHookAddressAllowed, "an https address, or http on 127.0.0.1 or localhost"),
  /** The answering service's public keys: one, or two while one is rotated. */
  keys: z.array(PolicyHookPinnedKeySchema).min(1).max(POLICY_HOOK_PINNED_KEYS_MAX).refine((keys) => new Set(keys.map((key) => key.kid)).size === keys.length, "two keys share a kid"),
}).strict();
export type PolicyHookSettings = z.infer<typeof PolicyHookSettingsSchema>;

export function policyHookAddressAllowed(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
/** The `qh` of an answer: base64url SHA-256 of the exact question JWS text that was sent. */
export function policyHookQuestionHash(questionJws: string): string {
  return createHash("sha256").update(questionJws, "utf8").digest("base64url");
}
/** The JWS signing input for a header and claims (the caller signs it with RS256). */
export function policyHookSigningInput(header: { alg: string; typ: string; kid: string }, claims: unknown): string {
  return `${b64(header)}.${b64(claims)}`;
}

const HEADER_KEYS = ["alg", "kid", "typ"];
/** Reads a compact JWS whose header is exactly { alg: RS256, typ, kid }. Undefined for anything else. Does not check the signature. */
export function readPolicyHookJws(text: unknown, typ: string): { kid: string; claims: unknown; signingInput: string; signature: Buffer } | undefined {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > POLICY_HOOK_MAX_BODY_BYTES) return undefined;
  const parts = text.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) return undefined;
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    if (header === null || typeof header !== "object" || Array.isArray(header)) return undefined;
    const record = header as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== HEADER_KEYS.join(",")) return undefined;
    if (record["alg"] !== POLICY_HOOK_ALG || record["typ"] !== typ || typeof record["kid"] !== "string" || !P.Kid.test(record["kid"])) return undefined;
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return { kid: record["kid"], claims, signingInput: `${parts[0]!}.${parts[1]!}`, signature: Buffer.from(parts[2]!, "base64url") };
  } catch {
    return undefined;
  }
}

/** True when `signature` is a valid RS256 signature of `signingInput` by this JWK. False for a key that cannot be read or is under 2048 bits. */
export function policyHookSignatureValid(key: Pick<PolicyHookPinnedKey, "kty" | "n" | "e">, signingInput: string, signature: Buffer): boolean {
  try {
    const publicKey = createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: "jwk" });
    if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return false;
    return verifySignature("RSA-SHA256", Buffer.from(signingInput, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}

export type PolicyHookAnswerCheck<K extends PolicyHookKind> = { ok: true; answer: PolicyHookAnswers[K]; expiresAt: number; kid: string } | { ok: false };

/**
 * Checks an answer. Every failure is the same `{ ok: false }` (no answer): unsigned, signed by a key that is not pinned, a header other than
 * exactly { alg: RS256, typ: answer, kid }, an unknown claim, a lifetime over 300 s, expired at `nowSeconds`, issued more than 30 s ahead, or bound to
 * another request id, question text or kind.
 */
export function checkPolicyHookAnswer<K extends PolicyHookKind>(input: {
  text: unknown; pinned: readonly PolicyHookPinnedKey[]; requestId: string; questionJws: string; kind: K; nowSeconds: number;
}): PolicyHookAnswerCheck<K> {
  const read = readPolicyHookJws(input.text, POLICY_HOOK_ANSWER_TYP);
  if (read === undefined) return { ok: false };
  const key = input.pinned.slice(0, POLICY_HOOK_PINNED_KEYS_MAX).find((candidate) => candidate.kid === read.kid);
  if (key === undefined || !policyHookSignatureValid(key, read.signingInput, read.signature)) return { ok: false };
  const parsed = PolicyHookAnswerClaimsSchema.safeParse(read.claims);
  if (!parsed.success) return { ok: false };
  const claims = parsed.data;
  if (claims.rid !== input.requestId || claims.kind !== input.kind || claims.qh !== policyHookQuestionHash(input.questionJws)) return { ok: false };
  if (input.nowSeconds >= claims.exp || claims.iat > input.nowSeconds + POLICY_HOOK_SKEW_SECONDS) return { ok: false };
  return { ok: true, answer: answerOf[input.kind].parse(claims.a) as PolicyHookAnswers[K], expiresAt: claims.exp, kid: key.kid };
}

/** Checks a question's shape and lifetime (the answering side also checks its signature against the asking install's keys). */
export function readPolicyHookQuestion(text: unknown, nowSeconds: number): { kid: string; claims: PolicyHookQuestionClaims; signingInput: string; signature: Buffer } | undefined {
  const read = readPolicyHookJws(text, POLICY_HOOK_QUESTION_TYP);
  if (read === undefined) return undefined;
  const parsed = PolicyHookQuestionClaimsSchema.safeParse(read.claims);
  if (!parsed.success) return undefined;
  if (nowSeconds >= parsed.data.exp || parsed.data.iat > nowSeconds + POLICY_HOOK_SKEW_SECONDS) return undefined;
  return { kid: read.kid, claims: parsed.data, signingInput: read.signingInput, signature: read.signature };
}

/** The question of a kind, checked; undefined when it does not fit. */
export function parsePolicyHookQuestion<K extends PolicyHookKind>(kind: K, value: unknown): PolicyHookQuestions[K] | undefined {
  const parsed = questionOf[kind].safeParse(value);
  return parsed.success ? parsed.data as PolicyHookQuestions[K] : undefined;
}
