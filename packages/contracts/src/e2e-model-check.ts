import { z } from "zod";
import { E2EModelFailureSchema, E2EModelReceiptSchema } from "./e2e-model-channel.js";

/**
 * The on-account model check of the AI browser-test agent (M1.4 Task 4.10C): what the broker asks the qualified runner to do and what the runner answers, over the two keys the
 * runner's transport grant already allows (`e2e-runtime/<role unique ID>:<instance ID>/canary-request.json` and `canary-result.json`).
 *
 * Two kinds: `discover` (list the models the account sees; no model call) and `drive` (the driving test: one call, then a small navigation of the built-in fixture, under a strict
 * budget that the request cannot raise). A result carries digests and counts only: no prompt, no answer, no provider message text.
 */

export const E2E_MODEL_CHECK_REQUEST_SCHEMA = "rovara-e2e-model-check-request/v2" as const;
export const E2E_MODEL_CHECK_RESULT_SCHEMA = "rovara-e2e-model-check-result/v2" as const;

/** The driving test's whole budget. The worker enforces it on the whole test, retries and the navigation step together; a request cannot raise any of it. */
export const DRIVING_TEST_BUDGET = Object.freeze({
  maxCalls: 6,
  maxInputTokensTotal: 36_000,
  maxOutputTokensPerCall: 512,
  maxActions: 3,
  stepDeadlineMs: 90_000,
  testDeadlineMs: 300_000,
} as const);

/** The case ids of the driving test's two phases in its receipts: the single first call, and the navigation of the fixture app. */
export const DRIVING_TEST_FIRST_CALL_CASE_ID = "model-check";
/** A runner serves at most this many checks in its life (a requalification starts a new runner). */
export const MODEL_CHECK_MAX_PER_RUNNER = 12;
/** The least time between two checks on one runner. */
export const MODEL_CHECK_MIN_SPACING_MS = 60_000;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const routeId = z.string().regex(/^[a-z0-9][a-z0-9/._-]{0,79}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const E2EModelCheckRequestSchema = z.object({
  schemaVersion: z.literal(E2E_MODEL_CHECK_REQUEST_SCHEMA),
  checkId: uuid,
  kind: z.enum(["drive", "discover"]),
  routeId: routeId.optional(),
  definitionDigest: digest.optional(),
}).strict().superRefine((request, context) => {
  const named = request.routeId !== undefined && request.definitionDigest !== undefined;
  if (request.kind === "drive" && !named) context.addIssue({ code: "custom", message: "a driving test names the route and its definition digest" });
  if (request.kind === "discover" && (request.routeId !== undefined || request.definitionDigest !== undefined)) context.addIssue({ code: "custom", message: "a discovery names no route" });
});
export type E2EModelCheckRequest = z.infer<typeof E2EModelCheckRequestSchema>;

export const E2E_MODEL_CHECK_REFUSALS = ["check-request-invalid", "served-limit", "agent-route-not-approved", "model-route-changed-reapprove", "model-environment-unsafe", "too-soon"] as const;
export type E2EModelCheckRefusal = (typeof E2E_MODEL_CHECK_REFUSALS)[number];

const count = z.number().int().min(0);
const discoveryModel = z.object({
  modelId: z.string().min(1).max(200),
  visible: z.boolean(),
  state: z.enum(["available", "needs-access", "not-in-region", "limit-zero", "listed"]),
  quotas: z.array(z.object({ scope: z.enum(["geographic", "global"]), code: z.string().max(40).nullable(), tokensPerMinute: count.nullable() }).strict()).max(2),
  signals: z.array(z.string().max(64)).max(8),
}).strict();
export const ModelDiscoveryReportSchema = z.object({
  schemaVersion: z.literal("rovara-model-discovery/v1"),
  provider: z.enum(["amazon-bedrock", "anthropic", "openai", "openrouter"]),
  checkedAt: z.string().datetime(),
  status: z.enum(["listed", "unverified"]),
  unverifiedReason: z.enum(["access-denied", "key-rejected", "unreachable", "not-supported", "unknown"]).optional(),
  models: z.array(discoveryModel).max(1000),
}).strict();

/** What the driving test found, from the runner's own account: counts, the receipts of every call it made, and what the executor's report says of the navigation step. */
export const E2EDrivingTestFindingSchema = z.object({
  routeId,
  routeRevision: z.string().regex(/^r[1-9][0-9]{0,5}-[a-f0-9]{12}$/),
  /** The digest of the definition actually tested, the request shape included. */
  definitionDigest: digest,
  provider: z.enum(["amazon-bedrock", "anthropic", "openai", "openrouter"]),
  modelId: z.string().min(1).max(200),
  payloadShape: z.enum(["standard", "minimal"]),
  outcome: z.enum(["passed", "failed"]),
  /** Why it did not pass, when a model call failed; null for a pass and for a navigation that did not end in a pass. */
  failure: E2EModelFailureSchema.nullable(),
  calls: count.max(DRIVING_TEST_BUDGET.maxCalls),
  inputTokens: count.max(DRIVING_TEST_BUDGET.maxInputTokensTotal),
  outputTokens: count.max(DRIVING_TEST_BUDGET.maxCalls * DRIVING_TEST_BUDGET.maxOutputTokensPerCall),
  /** The verdict of the deterministic oracle on the navigation case; `none` when no navigation was started. */
  caseVerdict: z.enum(["passed", "failed", "unknown", "none"]),
  /** The oracle's reason code for an unknown or failed case, or null. A fixed code, never text. */
  caseCode: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).nullable(),
  receipts: z.array(E2EModelReceiptSchema).max(DRIVING_TEST_BUDGET.maxCalls + 4),
  /** The executor's own account of the navigation step, which the receipts must equal. */
  reported: z.object({ modelCalls: count.max(64), downloads: count.max(16), csvPassed: z.boolean() }).strict().nullable(),
}).strict();
export type E2EDrivingTestFinding = z.infer<typeof E2EDrivingTestFindingSchema>;

export const E2EModelCheckResultSchema = z.discriminatedUnion("status", [
  z.object({ schemaVersion: z.literal(E2E_MODEL_CHECK_RESULT_SCHEMA), status: z.literal("refused"), code: z.enum(E2E_MODEL_CHECK_REFUSALS), checkId: uuid.nullable() }).strict(),
  z.object({ schemaVersion: z.literal(E2E_MODEL_CHECK_RESULT_SCHEMA), status: z.literal("failed"), reason: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), checkId: uuid }).strict(),
  z.object({ schemaVersion: z.literal(E2E_MODEL_CHECK_RESULT_SCHEMA), status: z.literal("discovered"), checkId: uuid, discovery: ModelDiscoveryReportSchema }).strict(),
  z.object({ schemaVersion: z.literal(E2E_MODEL_CHECK_RESULT_SCHEMA), status: z.literal("driven"), checkId: uuid, drive: E2EDrivingTestFindingSchema }).strict(),
]);
export type E2EModelCheckResult = z.infer<typeof E2EModelCheckResultSchema>;
