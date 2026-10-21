import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import type { WorkflowVerificationResults } from "./task-workflow.js";
import { redactText } from "./redaction.js";
import { e2eApplicationUpstreamTestIdFromIdentity, e2eCaseIdFromIdentity, e2eUpstreamTestIdFromIdentity } from "./e2e-case-identity.js";
import { copyBoundedE2EJsonArrayItems } from "./e2e-safe-data.js";
import { E2ECallableSelectorSchema } from "./e2e-portable.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = (max = 120) => z.string().trim().min(1).max(max);
const ids = (max = 64) => z.array(id()).min(1).max(max).refine((values) => new Set(values).size === values.length, "identifiers must be unique");
const timestamp = z.string().datetime();
const positiveInt = z.number().int().positive();
const MAX_JSON_LITERAL_BYTES = 65_536;
const MAX_JSON_LITERAL_DEPTH = 32;
const MAX_STRUCTURED_RECORD_BYTES = 262_144;
const MAX_STRUCTURED_RECORD_DEPTH = 64;
const MAX_E2E_AGGREGATE_RESULT_ROWS = 4;
const MAX_E2E_AGGREGATE_CARRIER_BYTES = (MAX_E2E_AGGREGATE_RESULT_ROWS + 2) * MAX_STRUCTURED_RECORD_BYTES + 4_096;
const sourceRelativePath = z.string().min(1).max(1024).superRefine((value, context) => {
  try {
    let decoded = value;
    for (let depth = 0; depth < 4; depth += 1) decoded = decodeURIComponent(decoded);
    if (value.startsWith("/") || value.includes("\\") || decoded.includes("\\") || decoded.includes("\u0000")
      || decoded.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..")
      || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || value.startsWith("//") || /%(?:2e|2f|5c)/i.test(decoded)) {
      context.addIssue({ code: "custom", message: "path must be normalized relative source syntax without traversal" });
    }
  } catch { context.addIssue({ code: "custom", message: "path contains invalid percent encoding" }); }
});
const recipeWorkingDirectory = z.union([z.literal("."), sourceRelativePath]);
const sameOriginAppPath = z.string().min(1).max(2048).superRefine((value, context) => {
  try {
    let decoded = value;
    for (let depth = 0; depth < 4; depth += 1) decoded = decodeURIComponent(decoded);
    if (value !== value.trim() || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || value.startsWith("//") || value.startsWith("\\") || value.includes("\\") || decoded.includes("\\")
      || /^[a-z][a-z0-9+.-]*:/i.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith("//")
      || decoded.split("/").some((part) => part === ".." || part === ".") || decoded.includes("\u0000")
      || /%(?:2e|2f|5c)/i.test(decoded)) {
      context.addIssue({ code: "custom", message: "path must remain within the pinned application origin" });
    }
  } catch { context.addIssue({ code: "custom", message: "path contains invalid percent encoding" }); }
});

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonBounds = { maxBytes: number; maxDepth: number; maxNodes?: number };
function copyJsonValue(value: unknown, bounds: JsonBounds): JsonValue {
  const seen = new Set<object>();
  const maxNodes = bounds.maxNodes ?? 16_384;
  let nodes = 0;
  const copy = (item: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > maxNodes) throw new TypeError("JSON value exceeds structural limit");
    if (depth > bounds.maxDepth) throw new TypeError(`JSON nesting exceeds ${bounds.maxDepth}`);
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object") throw new TypeError("value is not JSON data");
    if (seen.has(item)) throw new TypeError("cyclic JSON value");
    seen.add(item);
    try {
      const prototype: unknown = Object.getPrototypeOf(item);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Reflect.ownKeys(descriptors);
      if (Array.isArray(item)) {
        const length = descriptors.length;
        if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 16_384) throw new TypeError("array length is not bounded data");
        if (prototype !== Array.prototype || keys.some((key) => {
          if (typeof key !== "string") return true;
          if (key === "length") return false;
          const index = Number(key);
          return !Number.isInteger(index) || index < 0 || index >= length.value || index > 4_294_967_294 || String(index) !== key;
        })) throw new TypeError("array has non-index properties");
        const output: JsonValue[] = [];
        for (let index = 0; index < length.value; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError("array must be dense data");
          output.push(copy(descriptor.value as unknown, depth + 1));
        }
        return output;
      }
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("object prototype is not JSON data");
      const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const key of keys) {
        if (typeof key !== "string") throw new TypeError("symbol keys are not JSON data");
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError("object properties must be enumerable data");
        output[key] = copy(descriptor.value as unknown, depth + 1);
      }
      return output;
    } finally { seen.delete(item); }
  };
  const copied = copy(value, 0);
  if (Buffer.byteLength(canonicalJson(copied), "utf8") > bounds.maxBytes) throw new TypeError(`canonical JSON exceeds ${bounds.maxBytes} bytes`);
  return copied;
}
const safeJsonInput = z.unknown().transform((value, context) => {
  try { return copyJsonValue(value, { maxBytes: MAX_STRUCTURED_RECORD_BYTES, maxDepth: MAX_STRUCTURED_RECORD_DEPTH }); }
  catch { context.addIssue({ code: "custom", message: "value must be bounded JSON data" }); return z.NEVER; }
});
const plainJson = z.unknown().transform((value, context) => {
  try { return copyJsonValue(value, { maxBytes: MAX_JSON_LITERAL_BYTES, maxDepth: MAX_JSON_LITERAL_DEPTH }); }
  catch { context.addIssue({ code: "custom", message: "JSON literal must be bounded JSON data" }); return z.NEVER; }
});
function safeJsonSchema<T extends z.ZodType>(schema: T) {
  return z.unknown().transform((value, context): z.output<T> => {
    const copied = safeJsonInput.safeParse(value);
    if (!copied.success) { context.addIssue({ code: "custom", message: "value must be bounded JSON data" }); return z.NEVER; }
    const parsed = schema.safeParse(copied.data);
    if (!parsed.success) { for (const issue of parsed.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message }); return z.NEVER; }
    return parsed.data;
  });
}

export const E2E_WORKER_PROTOCOL = "trusted-e2e/v1" as const;
export const E2EWorkerProtocolSchema = z.literal(E2E_WORKER_PROTOCOL);
export function assertE2EWorkerProtocol(protocol: unknown): typeof E2E_WORKER_PROTOCOL {
  const parsed = E2EWorkerProtocolSchema.safeParse(protocol);
  if (!parsed.success) throw new Error("worker does not support trusted E2E protocol");
  return parsed.data;
}
export const E2E_PROJECT_CHECK_ID = "project-e2e" as const;
export const E2E_HARD_LIMITS = { runTimeoutMs: 1_800_000, startupTimeoutMs: 120_000, preparationTimeoutMs: 300_000, caseTimeoutMs: 300_000, maxActionsPerCase: 100, maxModelRequests: 200, maxInputTokens: 1_000_000, maxOutputTokens: 100_000 } as const;
export const E2E_DEFAULT_LIMITS = { runTimeoutMs: 600_000, startupTimeoutMs: 60_000, preparationTimeoutMs: 180_000, caseTimeoutMs: 90_000, maxActionsPerCase: 30, maxModelRequests: 60, maxInputTokens: 200_000, maxOutputTokens: 20_000, maxSpendUsd: null } as const;

export const E2EEvidenceScopeSchema = z.enum(["source", "mock-contract", "runtime", "external-live"]);
export type E2EEvidenceScope = z.infer<typeof E2EEvidenceScopeSchema>;
export const E2EExecutionModeSchema = z.enum(["mock-only", "hybrid", "real-runtime"]);
export type E2EExecutionMode = z.infer<typeof E2EExecutionModeSchema>;
export const E2ELimitsSchema = z.object({
  runTimeoutMs: positiveInt.max(E2E_HARD_LIMITS.runTimeoutMs), startupTimeoutMs: positiveInt.max(E2E_HARD_LIMITS.startupTimeoutMs),
  preparationTimeoutMs: positiveInt.max(E2E_HARD_LIMITS.preparationTimeoutMs), caseTimeoutMs: positiveInt.max(E2E_HARD_LIMITS.caseTimeoutMs),
  maxActionsPerCase: positiveInt.max(E2E_HARD_LIMITS.maxActionsPerCase), maxModelRequests: positiveInt.max(E2E_HARD_LIMITS.maxModelRequests),
  maxInputTokens: positiveInt.max(E2E_HARD_LIMITS.maxInputTokens), maxOutputTokens: positiveInt.max(E2E_HARD_LIMITS.maxOutputTokens),
  maxSpendUsd: z.number().finite().positive().nullable(),
}).strict();
export type E2ELimits = z.infer<typeof E2ELimitsSchema>;
export const E2ECapturePolicySchema = z.object({ screenshots: z.boolean(), traces: z.boolean(), video: z.boolean(), downloads: z.boolean() }).strict();
export type E2ECapturePolicy = z.infer<typeof E2ECapturePolicySchema>;

const E2ETargetBaseSchema = z.object({ targetId: id(80), applicationId: id(120), runtimeProfileId: id(120), accountProfileId: id(120) }).strict();
export const E2ETargetSchema = z.discriminatedUnion("kind", [
  E2ETargetBaseSchema.extend({ kind: z.literal("web"), browser: z.enum(["chromium", "firefox", "webkit"]), viewport: z.object({ width: positiveInt.max(7680), height: positiveInt.max(4320) }).strict() }),
  E2ETargetBaseSchema.extend({ kind: z.literal("api"), protocol: z.literal("http"), originRef: id(200) }),
  E2ETargetBaseSchema.extend({ kind: z.literal("mobile"), os: z.enum(["android", "ios"]), appId: id(200), deviceProfileId: id(120) }),
  E2ETargetBaseSchema.extend({ kind: z.literal("desktop"), os: z.enum(["linux", "macos", "windows"]), driver: z.enum(["electron", "native"]), appId: id(200) }),
  E2ETargetBaseSchema.extend({ kind: z.literal("contract"), requestedTargetId: id(80), adapterProfileId: id(120) }),
]);
export type E2ETarget = z.infer<typeof E2ETargetSchema>;
export const E2EPolicySchema = z.object({ schemaVersion: z.literal(1), policyRevision: positiveInt, executionMode: z.literal("trusted-scenarios"), baselineScenarioIds: z.array(id()).max(32), targets: z.array(E2ETargetSchema).max(12), defaultSandboxProfileId: id(120), fallback: z.literal("mock-unconnected"), modelRouteRevision: id(120).nullable(), capture: E2ECapturePolicySchema, limits: E2ELimitsSchema }).strict().superRefine((policy, context) => {
  if (new Set(policy.targets.map((target) => target.targetId)).size !== policy.targets.length) context.addIssue({ code: "custom", path: ["targets"], message: "target IDs must be unique" });
  if (new Set(policy.baselineScenarioIds).size !== policy.baselineScenarioIds.length) context.addIssue({ code: "custom", path: ["baselineScenarioIds"], message: "baseline scenario IDs must be unique" });
});
export type E2EPolicy = z.infer<typeof E2EPolicySchema>;
export function e2ePolicyDigest(policy: E2EPolicy): string { const copied = safeJsonInput.parse(policy); return createHash("sha256").update(canonicalJson(E2EPolicySchema.parse(copied))).digest("hex"); }
export const E2EQualifiedRoundSchema = z.object({ candidateDigest: digest, contractDigest: digest, policyDigest: digest, bundleDigest: digest,
  executionPlanDigest: digest, roundId: z.string().uuid(), groupRunIds: z.array(z.string().uuid()).min(1).max(4),
  admissionSha256: digest, evidenceSha256: digest }).strict();
export const E2EFailedRoundSchema = z.object({ status: z.literal("FAILED"), candidateDigest: digest, roundId: z.string().uuid(),
  groupRunIds: z.array(z.string().uuid()).min(1).max(4), admissionSha256: digest, evidenceSha256: digest }).strict();
export type E2EFailedRound = z.infer<typeof E2EFailedRoundSchema>;
/** Bounded notifier display cache. It is never qualification or action authority. */
export const E2EWorkflowDisplayRefSchema = z.object({ schemaVersion: z.literal(1), key: z.string().regex(/^private\/[^/]+\/[^/]+\/workflow-e2e-display\/[a-f0-9]{64}\.json$/),
  sha256: digest, byteLength: positiveInt.max(262_144), candidateDigest: digest, roundId: z.string().uuid(), groupRunIds: z.array(z.string().uuid()).min(1).max(4), admissionSha256: digest, evidenceSha256: digest }).strict();
export type E2EWorkflowDisplayRef = z.infer<typeof E2EWorkflowDisplayRefSchema>;
/**
 * What plan approval derived for a plan that carries a v2 application intent: the digests that identify the approved selection, the targets that
 * can run application scenarios, the criteria that will wait (and why), and the READY runtime rows it was derived against. Dispatch re-reads the
 * rows and re-derives the selection (Ruling AL); this record is what the Owner approved, never authority to run.
 */
export const E2EApplicationSelectionRecordSchema = z.object({
  schemaVersion: z.literal("e2e-application-selection/v1"),
  /** sha256 of the whole canonical intent, portable scenarios included (the facade digests only the application part). */
  intentDigest: digest,
  /** The approval-time plan identity the selection was derived under (the canonical artifact; not the dispatch-time plan digest). */
  planDigest: digest,
  semanticApproval: z.object({ artifactId: id(120), digest }).strict(),
  setupApproval: z.object({ artifactId: id(120), digest }).strict(),
  /** The application approval binding of the executable subset; null when no target can run application scenarios yet. */
  applicationApprovalBindingDigest: digest.nullable(),
  /**
   * The application execution plan and scenario bundle derived at approval from the application scenarios only (template `trusted-e2e-application/v1`,
   * under `planDigest`). They are not `workflow.e2e.executionPlanDigest`/`bundleDigest`, which identify the approved intent and its portable bundle
   * (`trusted-e2e/v1`) exactly as for a v1 plan. Dispatch derives its own plan, so these identify what the Owner approved and are never compared with it.
   */
  applicationExecutionPlanDigest: digest,
  applicationBundleDigest: digest,
  executableTargetIds: z.array(id(80)).max(12),
  unavailableCriteria: z.array(z.object({ criterionId: id(120), reason: id(500) }).strict()).max(64),
  runtimeRows: z.array(z.object({ kind: z.enum(["web", "api"]), profileId: id(120), runtimeCatalogId: id(120), catalogRevision: positiveInt, generation: positiveInt,
    bindingDigest: digest, capabilityDigest: digest, expiresAt: id(40) }).strict()).max(2),
  evaluatedAt: id(40),
}).strict();
export type E2EApplicationSelectionRecord = z.infer<typeof E2EApplicationSelectionRecordSchema>;
/** What identifies an approved application selection, for the audit of a re-approval: the whole record's digest, the intent, the executable targets and the runtime rows. */
const E2EApplicationSelectionFingerprintSchema = z.object({ selectionDigest: digest, intentDigest: digest, executableTargetIds: z.array(id(80)).max(12), runtimeRowsDigest: digest }).strict();
export type E2EApplicationSelectionFingerprint = z.infer<typeof E2EApplicationSelectionFingerprintSchema>;
export function e2eApplicationSelectionFingerprint(record: E2EApplicationSelectionRecord): E2EApplicationSelectionFingerprint {
  const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
  return { selectionDigest: sha(record), intentDigest: record.intentDigest, executableTargetIds: [...record.executableTargetIds], runtimeRowsDigest: sha(record.runtimeRows) };
}
/**
 * The owner's re-approval of an application plan against the runtime rows READY now (a retry after the approved selection changed): who, why, when, and the selection
 * it replaced and the one it recorded. Appended, never overwritten, so what the owner authorized can always be reconstructed.
 */
export const E2EApplicationReapprovalSchema = z.object({ requestId: id(120), actorId: id(200), reason: id(500), at: id(40),
  previous: E2EApplicationSelectionFingerprintSchema, current: E2EApplicationSelectionFingerprintSchema }).strict();
export type E2EApplicationReapproval = z.infer<typeof E2EApplicationReapprovalSchema>;
export const E2EWorkflowProgressSchema = z.object({ contractDigest: digest, policyDigest: digest, bundleDigest: digest, executionPlanDigest: digest, required: z.boolean(), currentRoundId: z.string().uuid().optional(), currentGroupRunIds: z.array(z.string().uuid()).max(12), resultRefs: z.array(id(200)).max(64), qualifiedRound: E2EQualifiedRoundSchema.optional(), failedRound: E2EFailedRoundSchema.optional(), displayRef: E2EWorkflowDisplayRefSchema.optional(), applicationSelection: E2EApplicationSelectionRecordSchema.optional(), applicationReapprovals: z.array(E2EApplicationReapprovalSchema).max(20).optional() }).strict();
export type E2EWorkflowProgress = z.infer<typeof E2EWorkflowProgressSchema>;
export type E2EQualifiedRound = z.infer<typeof E2EQualifiedRoundSchema>;

/**
 * Server-assigned admission object reference for a separate native CHECKS operation. `kind` is "application" for a browser or API round (and absent for a
 * portable one): the dispatcher uses it to hand such a round only to a worker that lists "task.workflowE2EApplicationChecks" (Ruling BQ, mixed fleet).
 * Neither side trusts the kind alone: the dispatcher (where it can read admissions) and the worker both read the admission and refuse a round whose reference
 * kind and admission schemaVersion disagree.
 */
export const E2EWorkflowAdmissionRefSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("application").optional(), taskId: z.string().uuid(), workflowRevision: positiveInt,
  candidateDigest: digest, roundId: z.string().uuid(), groupRunIds: z.array(z.string().uuid()).min(1).max(4).refine((values) => new Set(values).size === values.length), admissionRef: z.object({
    key: z.string().regex(/^workflow-e2e-admissions\/sha256\/[a-f0-9]{64}\.json$/), sha256: digest,
    byteLength: positiveInt.max(24 * 1024 * 1024),
  }).strict(),
}).strict();
export type E2EWorkflowAdmissionRef = z.infer<typeof E2EWorkflowAdmissionRefSchema>;
/**
 * What an application round's evidence may weigh (Ruling BV): the worker refuses to upload more (the group is UNKNOWN, "evidence too large"), the broker accepts and reads no more.
 * They are what the deployed broker can hold and process, of the same order as the portable bound (24 MiB) the evidence references keep. Revisit them with measured sizes.
 */
export const E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;
/** All of a round's evidence together, the aggregate included: the aggregate holds every group's run once. */
export const E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES = 24 * 1024 * 1024;
export const E2EWorkflowEvidenceRefSchema = z.object({ key: z.string().regex(/^workflow-e2e-evidence\/sha256\/[a-f0-9]{64}\.json$/), sha256: digest, byteLength: positiveInt.max(24 * 1024 * 1024) }).strict();
export type E2EWorkflowEvidenceRef = z.infer<typeof E2EWorkflowEvidenceRefSchema>;
export const E2EWorkflowGroupEvidenceRefSchema = z.object({
  groupRunId: z.string().uuid(),
  evidenceRef: z.object({ key: z.string().regex(/^workflow-e2e-group-evidence\/sha256\/[a-f0-9]{64}\.json$/), sha256: digest,
    byteLength: positiveInt.max(24 * 1024 * 1024) }).strict(),
}).strict();
export type E2EWorkflowGroupEvidenceRef = z.infer<typeof E2EWorkflowGroupEvidenceRefSchema>;

const CommandRecipeSchema = z.object({ program: id(256), args: z.array(z.string().max(8192)).max(256), cwd: recipeWorkingDirectory, timeoutMs: positiveInt.max(300_000), env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(4096)).refine((env) => Object.keys(env).length <= 64 && !Object.keys(env).some((key) => /^(PATH|HOME|AWS_|AGENTX_|PI_|GIT_)/i.test(key) || /(TOKEN|SECRET|PASSWORD|API_KEY)$/i.test(key)) && !Object.values(env).some((value) => redactText(value) !== value), "environment must contain only non-secret allowlisted literals") }).strict().superRefine((command, context) => {
  if (/(^|[/\\])(?:sh|bash|zsh|cmd|powershell|pwsh)(\.exe)?$/i.test(command.program) || command.args.some((arg) => /(^|\s)(?:\||&&|;|>|<|\$\(|`)/.test(arg))) context.addIssue({ code: "custom", message: "shell wrappers and shell-interpreted arguments are forbidden" });
});
export type E2ECommandRecipe = z.infer<typeof CommandRecipeSchema>;
export const E2EAppRecipeSchema = z.object({ schemaVersion: z.literal(1), recipeDigest: digest, build: z.array(CommandRecipeSchema).max(16), launch: z.discriminatedUnion("kind", [z.object({ kind: z.literal("service"), start: CommandRecipeSchema, health: z.object({ path: sameOriginAppPath, expectedStatus: z.number().int().min(100).max(599) }).strict() }).strict(), z.object({ kind: z.literal("application"), appId: id(200), artifactRef: id(500), arguments: z.array(z.string().max(8192)).max(100) }).strict(), z.object({ kind: z.literal("contract"), adapterProfileId: id(120), operationIds: ids(200) }).strict()]), serviceProfileIds: z.array(id(120)).max(8), seedProfileId: id(120), accountProfileIds: ids(32), allowedOrigins: z.array(id(200)).max(64) }).strict();
export type E2EAppRecipe = z.infer<typeof E2EAppRecipeSchema>;

const stepSchemas = [
  z.object({ kind: z.literal("navigate"), path: sameOriginAppPath }), z.object({ kind: z.literal("fill"), testId: id(256), value: z.string().max(8192) }), z.object({ kind: z.literal("click"), testId: id(256) }),
  z.object({ kind: z.literal("agent"), goal: z.string().min(1).max(8192), maxActions: positiveInt.max(100) }), z.object({ kind: z.literal("request"), requestId: id(120), path: sameOriginAppPath, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), body: plainJson }),
  z.object({ kind: z.literal("invoke-contract"), operationId: id(120), input: plainJson }), z.object({ kind: z.literal("inspect-contract"), operationId: id(120) }), z.object({ kind: z.literal("launch-app") }), z.object({ kind: z.literal("tap"), testId: id(256) }),
  z.object({ kind: z.literal("swipe"), direction: z.enum(["up", "down", "left", "right"]) }), z.object({ kind: z.literal("deep-link"), path: sameOriginAppPath }), z.object({ kind: z.literal("restart-app") }),
  z.object({ kind: z.literal("set-permission"), permission: id(120), value: z.enum(["grant", "deny", "reset"]) }), z.object({ kind: z.literal("choose-file"), fixtureFileId: id(120) }),
].map((schema) => schema.strict());
export const E2EStepSchema = safeJsonSchema(z.discriminatedUnion("kind", stepSchemas as [typeof stepSchemas[number], typeof stepSchemas[number], ...typeof stepSchemas[number][]]));
export type E2EStep = z.infer<typeof E2EStepSchema>;
export const E2EAssertionSchema = safeJsonSchema(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), testId: id(256), equals: z.string().max(8192) }).strict(), z.object({ kind: z.literal("visible"), testId: id(256), equals: z.boolean() }).strict(),
  z.object({ kind: z.literal("csv"), downloadName: id(255), columns: ids(256), rows: z.array(z.array(z.string().max(8192)).max(256)).max(10_000) }).strict(),
  z.object({ kind: z.literal("http-status"), path: sameOriginAppPath, method: z.enum(["GET", "POST"]), equals: z.number().int().min(100).max(599) }).strict(),
  z.object({ kind: z.literal("json"), responseId: id(120), schemaRef: id(200), equals: plainJson }).strict(), z.object({ kind: z.literal("state"), probeId: id(120), equals: plainJson, pollTimeoutMs: positiveInt.max(300_000) }).strict(),
  z.object({ kind: z.literal("file"), fixtureRootId: id(120), relativePath: sourceRelativePath, sha256: digest }).strict(),
]));
export type E2EAssertion = z.infer<typeof E2EAssertionSchema>;
export const E2EScenarioSchema = safeJsonSchema(z.object({ scenarioId: id(120), requirementId: id(120), requestedTargetIds: ids(12), required: z.boolean(), accountProfileId: id(120), minimumEvidence: E2EEvidenceScopeSchema, requiredRealComponentIds: z.array(id(120)).max(32), steps: z.array(E2EStepSchema).max(30), assertions: z.array(E2EAssertionSchema).min(1).max(20) }).strict().superRefine((scenario, context) => {
  if (new Set(scenario.requiredRealComponentIds).size !== scenario.requiredRealComponentIds.length) context.addIssue({ code: "custom", path: ["requiredRealComponentIds"], message: "component IDs must be unique" });
  if (scenario.steps[0]?.kind === "inspect-contract" && (scenario.steps.length !== 1 || scenario.assertions.length !== 1 || scenario.assertions[0]?.kind !== "state" || scenario.assertions[0].probeId !== "module-export-names")) context.addIssue({ code: "custom", path: ["assertions"], message: "source-interface inspection requires one fixed module-export-names assertion" });
}));
export type E2EScenario = z.infer<typeof E2EScenarioSchema>;
/** Untrusted feature-plan intent. The broker still derives inherited floors, target availability and evidence bindings. */
export const E2EFeaturePlanIntentSchema = z.object({
  schemaVersion: z.literal(1),
  requestedTargetIds: ids(12),
  // The model may propose a callable selector, but the broker treats it only as an
  // untrusted candidate: the canonical plan approval binds it, then the protected
  // candidate source inventory must independently prove the package export and callable.
  portableOperationRefs: z.array(z.object({
    operationId: id(120), applicationId: id(120), requestedTargetIds: ids(12),
    packageExportSubpath: z.string().regex(/^(?:\.|\.\/[A-Za-z0-9_./-]{1,160})$/),
    moduleSpecifier: z.string().regex(/^\.\.?\/[A-Za-z0-9_./-]{1,512}$/),
    callableSelector: E2ECallableSelectorSchema,
  }).strict()).max(32).optional(),
  // Owner-approved feature intent may select a source-held API fixture descriptor. The
  // broker re-reads and validates both source refs; this is selection, never mock authority.
  mockFixtureRefs: z.array(z.object({ componentId: id(120), requestedTargetId: id(80), operationId: id(120),
    sourcePath: sourceRelativePath, sourceSha256: digest }).strict()).max(200).optional(),
  accountContextRefs: z.array(z.object({
    applicationId: id(120), profileId: id(120), sourcePath: sourceRelativePath, sourceSha256: digest,
  }).strict()).max(32),
  scenarios: z.array(E2EScenarioSchema).max(32),
  semanticExportDeltas: z.array(z.object({
    applicationId: id(120), operationId: id(120), requestedTargetIds: ids(12), expectedExportNames: z.array(id(120)).max(128), reason: id(500),
  }).strict()).max(32),
}).strict().superRefine((intent, context) => {
  if (new Set(intent.scenarios.map((scenario) => scenario.scenarioId)).size !== intent.scenarios.length) {
    context.addIssue({ code: "custom", path: ["scenarios"], message: "scenario IDs must be unique" });
  }
  const requested = new Set(intent.requestedTargetIds);
  if (intent.scenarios.some((scenario) => scenario.requestedTargetIds.some((targetId) => !requested.has(targetId)))) {
    context.addIssue({ code: "custom", path: ["scenarios"], message: "every scenario target must be explicitly requested by the feature plan" });
  }
  const accounts = intent.accountContextRefs.map((item) => `${item.applicationId}\0${item.profileId}`);
  if (new Set(accounts).size !== accounts.length) context.addIssue({ code: "custom", path: ["accountContextRefs"], message: "account context references must be unique by application and profile" });
  const deltas = intent.semanticExportDeltas.map((item) => `${item.applicationId}\0${item.operationId}`);
  if (new Set(deltas).size !== deltas.length) context.addIssue({ code: "custom", path: ["semanticExportDeltas"], message: "semantic export deltas must be unique by operation" });
  const operationRefs = intent.portableOperationRefs ?? [];
  if (new Set(operationRefs.map((item) => `${item.applicationId}\0${item.operationId}`)).size !== operationRefs.length) {
    context.addIssue({ code: "custom", path: ["portableOperationRefs"], message: "portable operation references must be unique by application and operation" });
  }
  const mockRefs = intent.mockFixtureRefs ?? [];
  if (new Set(mockRefs.map((item) => `${item.requestedTargetId}\0${item.componentId}`)).size !== mockRefs.length) {
    context.addIssue({ code: "custom", path: ["mockFixtureRefs"], message: "source-backed mock selections must be unique by target and component" });
  }
  if (mockRefs.some((item) => !requested.has(item.requestedTargetId))) {
    context.addIssue({ code: "custom", path: ["mockFixtureRefs"], message: "source-backed mock selections must bind a requested target" });
  }
  for (const [index, operation] of operationRefs.entries()) {
    if (operation.requestedTargetIds.length === 0 || operation.requestedTargetIds.some((targetId) => !requested.has(targetId))) {
      context.addIssue({ code: "custom", path: ["portableOperationRefs", index, "requestedTargetIds"], message: "portable operation targets must be selected by the feature plan" });
    }
  }
  for (const [index, scenario] of intent.scenarios.entries()) {
    const step = scenario.steps[0];
    if (step?.kind !== "invoke-contract") continue;
    const operation = operationRefs.find((item) => item.operationId === step.operationId);
    if (!operation || scenario.requestedTargetIds.some((targetId) => !operation.requestedTargetIds.includes(targetId))) {
      context.addIssue({ code: "custom", path: ["scenarios", index, "steps"], message: "portable invocation must reference a proposed operation bound to every requested scenario target" });
    }
  }
});
export type E2EFeaturePlanIntent = z.infer<typeof E2EFeaturePlanIntentSchema>;
export const E2EScenarioBundleSchema = safeJsonSchema(z.object({ schemaVersion: z.literal(1), planDigest: digest, bundleDigest: digest, templateVersion: id(80), scenarios: z.array(E2EScenarioSchema).max(32) }).strict().superRefine((bundle, context) => {
  if (new Set(bundle.scenarios.map((scenario) => scenario.scenarioId)).size !== bundle.scenarios.length) context.addIssue({ code: "custom", path: ["scenarios"], message: "scenario IDs must be unique" });
  const actual = e2eScenarioBundleDigest(bundle);
  if (bundle.bundleDigest !== actual) context.addIssue({ code: "custom", path: ["bundleDigest"], message: "bundle digest does not match canonical content" });
}));
export type E2EScenarioBundle = z.infer<typeof E2EScenarioBundleSchema>;
export function e2eScenarioBundleDigest(bundle: E2EScenarioBundle): string { const content = Object.fromEntries(Object.entries(safeJsonInput.parse(bundle) as E2EScenarioBundle).filter(([key]) => key !== "bundleDigest")); return createHash("sha256").update(canonicalJson(content)).digest("hex"); }
export function validateE2EScenarioBundleForPolicy(bundle: unknown, policy: unknown): E2EScenarioBundle {
  const parsedPolicy = E2EPolicySchema.parse(policy); const parsedBundle = E2EScenarioBundleSchema.parse(bundle);
  for (const scenario of parsedBundle.scenarios) {
    for (const requestedTargetId of scenario.requestedTargetIds) {
      const target = parsedPolicy.targets.find((item) => item.targetId === requestedTargetId);
      if (target === undefined) throw new Error(`scenario references unconfigured target ${requestedTargetId}`);
      if (target.accountProfileId !== scenario.accountProfileId) throw new Error(`scenario account profile does not match target ${requestedTargetId}`);
      if (target.kind === "api" && scenario.steps.some((step) => ["navigate", "fill", "click", "launch-app", "tap", "swipe", "deep-link", "restart-app", "set-permission", "choose-file"].includes(step.kind))) throw new Error(`UI scenario steps are incompatible with API target ${requestedTargetId}`);
    }
  }
  if (parsedPolicy.modelRouteRevision === null && parsedBundle.scenarios.some((scenario) => scenario.steps.some((step) => step.kind === "agent"))) throw new Error("agent steps require an approved model route revision");
  return parsedBundle;
}

export const E2EApiMockVariantSchema = z.object({ id: z.enum(["success", "refusal", "invalid-data"]), inputValue: z.string().max(128), status: z.number().int().min(100).max(599), body: z.unknown() }).strict();
export const E2EApiMockFixtureSchema = z.object({ schemaVersion: z.literal("source-backed-api-fixtures/v1"), operationId: id(120), method: z.literal("GET"), path: z.string().min(1).max(512), inputField: id(120), variants: z.array(E2EApiMockVariantSchema).min(3).max(3) }).strict().superRefine((fixture, context) => {
  if (new Set(fixture.variants.map((variant) => variant.id)).size !== 3 || new Set(fixture.variants.map((variant) => variant.inputValue)).size !== 3) context.addIssue({ code: "custom", path: ["variants"], message: "source-backed API fixture variants must have unique IDs and input values" });
  if (!/^\/[A-Za-z0-9._~/-]{1,511}$/.test(fixture.path) || fixture.path.includes("..") || fixture.path.includes("//") || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(fixture.inputField)) context.addIssue({ code: "custom", path: ["path"], message: "source-backed API mock route and input selector must be canonical and bounded" });
});
export type E2EApiMockFixture = z.infer<typeof E2EApiMockFixtureSchema>;
export const E2EMockSpecSchema = z.object({ componentId: id(120), requestedTargetId: id(80), effectiveTargetId: id(80), kind: z.enum(["api", "database", "queue", "identity", "device-service", "os-service", "model", "driver"]), contractDigest: digest, fixtureVersion: id(80), sourceRefs: z.array(z.object({ path: sourceRelativePath, sha256: digest }).strict()).max(64), reason: z.enum(["unconnected", "unapproved", "declined", "unqualified", "phase-unavailable"]), apiFixture: E2EApiMockFixtureSchema.optional() }).strict();
export type E2EMockSpec = z.infer<typeof E2EMockSpecSchema>;
export const E2ERuntimeAvailabilitySchema = z.object({ targetId: id(80), profileId: id(120), connection: z.enum(["connected", "unconnected"]), approval: z.enum(["approved", "pending", "declined"]), qualification: z.enum(["qualified", "unqualified"]), authorizationRevision: id(120) }).strict();
export type E2ERuntimeAvailability = z.infer<typeof E2ERuntimeAvailabilitySchema>;
export const E2ECriterionExpectationSchema = z.object({ criterionId: id(120), requirementId: id(120), scenarioId: id(120), requestedTargetId: id(80), required: z.boolean(), minimumEvidence: E2EEvidenceScopeSchema, requiredRealComponentIds: z.array(id(120)).max(32), expectedCaseIds: z.array(id(160)).max(64) }).strict();
export type E2ECriterionExpectation = z.infer<typeof E2ECriterionExpectationSchema>;
export const E2ECaseCoverageSchema = z.object({ observedScope: E2EEvidenceScopeSchema, subject: z.enum(["candidate", "simulation", "fixture"]), executedCandidateParts: z.array(id(256)).max(64), realComponentIds: z.array(id(120)).max(32), mockedComponentIds: z.array(id(120)).max(32), observedMockedComponentIds: z.array(id(120)).max(32), unexercisedBehaviors: z.array(id(256)).max(64) }).strict();
export type E2ECaseCoverage = z.infer<typeof E2ECaseCoverageSchema>;
export const E2EExpectedCaseSchema = z.object({ caseId: id(160), criterionId: id(120), scenarioId: id(120), upstreamTestId: id(512), targetId: id(80), requestedTargetId: id(80), agentId: id(120), repeat: z.literal(0), executionDescriptorDigest: digest, accountContextId: id(120), accountContextDigest: digest, accountProfileId: id(120), assertionDigest: digest, assertionDigests: z.array(digest).min(1).max(20), required: z.boolean(), minimumEvidence: E2EEvidenceScopeSchema, requiredRealComponentIds: z.array(id(120)).max(32) }).strict().superRefine((item, context) => {
  if (createHash("sha256").update(canonicalJson(item.assertionDigests)).digest("hex") !== item.assertionDigest) context.addIssue({ code: "custom", path: ["assertionDigest"], message: "aggregate assertion digest must bind the ordered assertion identities" });
  if (item.caseId !== e2eCaseIdFromIdentity(item) || (item.upstreamTestId !== e2eUpstreamTestIdFromIdentity(item)
    && item.upstreamTestId !== e2eApplicationUpstreamTestIdFromIdentity(item))) context.addIssue({ code: "custom", path: ["caseId"], message: "case and pinned upstream test IDs must bind the full execution and account identity" });
});
export type E2EExpectedCase = z.infer<typeof E2EExpectedCaseSchema>;
export const E2EExecutionGroupSchema = z.object({ groupId: id(80), targetIds: ids(3), runtimeProfileId: id(120), mode: E2EExecutionModeSchema, mockManifestDigest: digest, expectedCases: z.array(E2EExpectedCaseSchema).max(64) }).strict();
const E2EGroupSchema = E2EExecutionGroupSchema;
export const E2EExecutionPlanSchema = safeJsonSchema(z.object({ schemaVersion: z.literal(1), digest, candidateDigest: digest, planDigest: digest, criteria: z.array(E2ECriterionExpectationSchema).max(64), effectiveTargets: z.array(E2ETargetSchema).max(12), groups: z.array(E2EGroupSchema).max(4), mocks: z.array(E2EMockSpecSchema).max(200), unavailableCriteria: z.array(z.object({ criterionId: id(120), reason: id(500) }).strict()).max(64) }).strict().superRefine((plan, context) => {
  try {
    if (e2eExecutionPlanDigest(plan) !== plan.digest) context.addIssue({ code: "custom", path: ["digest"], message: "execution plan digest does not match canonical content" });
  } catch { context.addIssue({ code: "custom", path: ["digest"], message: "execution plan digest cannot be computed safely" }); }
  if (new Set(plan.criteria.map((criterion) => criterion.criterionId)).size !== plan.criteria.length) context.addIssue({ code: "custom", path: ["criteria"], message: "criterion IDs must be unique" });
  const targets = new Set(plan.effectiveTargets.map((target) => target.targetId));
  if (new Set(plan.effectiveTargets.map((target) => target.targetId)).size !== plan.effectiveTargets.length) context.addIssue({ code: "custom", path: ["effectiveTargets"], message: "effective target IDs must be unique" });
  if (new Set(plan.groups.map((group) => group.groupId)).size !== plan.groups.length) context.addIssue({ code: "custom", path: ["groups"], message: "group IDs must be unique" });
  if (plan.groups.some((group) => group.targetIds.some((targetId) => !targets.has(targetId)))) context.addIssue({ code: "custom", path: ["groups"], message: "group targets must reference effective targets" });
  const cases = plan.groups.flatMap((group) => group.expectedCases);
  if (new Set(plan.unavailableCriteria.map((item) => item.criterionId)).size !== plan.unavailableCriteria.length) context.addIssue({ code: "custom", path: ["unavailableCriteria"], message: "unavailable criteria must be unique" });
  const unavailableIds = new Set(plan.unavailableCriteria.map((item) => item.criterionId));
  for (const unavailableId of unavailableIds) if (!plan.criteria.some((item) => item.criterionId === unavailableId)) context.addIssue({ code: "custom", path: ["unavailableCriteria"], message: "unavailable criteria must reference a planned criterion" });
  if (cases.length > 64) context.addIssue({ code: "custom", path: ["groups"], message: "verification round may expand to at most 64 cases" });
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length) context.addIssue({ code: "custom", path: ["groups"], message: "expected case IDs must be unique" });
  for (const group of plan.groups) for (const item of group.expectedCases) {
    const target = plan.effectiveTargets.find((candidate) => candidate.targetId === item.targetId);
    if (!group.targetIds.includes(item.targetId) || target === undefined || (target.kind === "contract" ? target.requestedTargetId : target.targetId) !== item.requestedTargetId) context.addIssue({ code: "custom", path: ["groups"], message: "expected cases must preserve requested and effective target identities" });
  }
  for (const criterion of plan.criteria) {
    if (new Set(criterion.expectedCaseIds).size !== criterion.expectedCaseIds.length) context.addIssue({ code: "custom", path: ["criteria"], message: "criterion case IDs must be unique" });
    if (criterion.expectedCaseIds.length === 0 && !unavailableIds.has(criterion.criterionId)) context.addIssue({ code: "custom", path: ["criteria"], message: "criteria with no executable cases require an unavailable reason" });
    for (const caseId of criterion.expectedCaseIds) {
      const expectedMatches = cases.filter((item) => item.caseId === caseId && item.criterionId === criterion.criterionId && item.requestedTargetId === criterion.requestedTargetId);
      const expected = expectedMatches[0];
      if (expectedMatches.length !== 1 || expected === undefined || expected.scenarioId !== criterion.scenarioId || expected.required !== criterion.required || expected.minimumEvidence !== criterion.minimumEvidence || canonicalJson(expected.requiredRealComponentIds) !== canonicalJson(criterion.requiredRealComponentIds)) context.addIssue({ code: "custom", path: ["criteria"], message: "criterion cases must preserve criterion, scenario, target, and evidence floor bindings exactly once" });
    }
  }
  for (const expected of cases) {
    const memberships = plan.criteria.filter((criterion) => criterion.expectedCaseIds.includes(expected.caseId));
    const criterion = memberships[0];
    if (memberships.length !== 1 || criterion === undefined || criterion.criterionId !== expected.criterionId || criterion.scenarioId !== expected.scenarioId || criterion.requestedTargetId !== expected.requestedTargetId) {
      context.addIssue({ code: "custom", path: ["groups"], message: "every expected case must belong to exactly one matching criterion" });
    }
  }
}));
export type E2EExecutionPlan = z.infer<typeof E2EExecutionPlanSchema>;
export function e2eExecutionPlanDigest(plan: E2EExecutionPlan): string { const content = Object.fromEntries(Object.entries(safeJsonInput.parse(plan) as E2EExecutionPlan).filter(([key]) => key !== "digest")); return createHash("sha256").update(canonicalJson(content)).digest("hex"); }

/** True only when every required criterion in the approved plan has executable, group-bound cases. */
export function e2ePlanHasCompleteRequiredCriteria(plan: E2EExecutionPlan): boolean {
  const unavailable = new Set(plan.unavailableCriteria.map((item) => item.criterionId));
  const cases = new Map<string, E2EExpectedCase[]>();
  for (const group of plan.groups) for (const expected of group.expectedCases) {
    const entries = cases.get(expected.caseId) ?? [];
    entries.push(expected);
    cases.set(expected.caseId, entries);
  }
  return plan.criteria.filter((criterion) => criterion.required).every((criterion) => !unavailable.has(criterion.criterionId)
    && criterion.expectedCaseIds.length > 0 && criterion.expectedCaseIds.every((caseId) => {
      const matches = cases.get(caseId) ?? [];
      return matches.length === 1 && matches[0]?.criterionId === criterion.criterionId
        && matches[0]?.scenarioId === criterion.scenarioId && matches[0]?.requestedTargetId === criterion.requestedTargetId;
    }));
}

export const E2EExpectedCaseManifestSchema = E2EExpectedCaseSchema;
export const E2ERunBindingSchema = z.object({ schemaVersion: z.literal(1), runId: z.string().uuid(), roundId: z.string().uuid(), taskId: id(120), operationId: id(120), operationFence: positiveInt, workflowRevision: positiveInt, groupId: id(80), executionPlanDigest: digest, executionMode: E2EExecutionModeSchema, mockManifestDigest: digest, authorizationRevision: id(120), candidateDigest: digest, planDigest: digest, policyDigest: digest, bundleDigest: digest, appBuildDigest: digest, environmentDigest: digest, runtimeManifestDigest: digest, modelRouteRevision: id(120).nullable(), expectedCases: z.array(E2EExpectedCaseSchema).max(64), admittedAt: timestamp, deadlineAt: timestamp }).strict().superRefine((binding, context) => {
  if (Date.parse(binding.deadlineAt) <= Date.parse(binding.admittedAt)) context.addIssue({ code: "custom", path: ["deadlineAt"], message: "run deadline must follow admission" });
  if (new Set(binding.expectedCases.map((item) => item.caseId)).size !== binding.expectedCases.length) context.addIssue({ code: "custom", path: ["expectedCases"], message: "expected case IDs must be unique" });
});
export type E2ERunBinding = z.infer<typeof E2ERunBindingSchema>;
export function e2eBindingDigest(binding: E2ERunBinding): string { const copied = safeJsonInput.parse(binding); return createHash("sha256").update(canonicalJson(E2ERunBindingSchema.parse(copied))).digest("hex"); }
export const E2ERoundSchema = z.object({ schemaVersion: z.literal(1), roundId: z.string().uuid(), taskId: id(120), operationId: id(120), operationFence: positiveInt, workflowRevision: positiveInt, executionPlanDigest: digest, admittedAt: timestamp, deadlineAt: timestamp, limits: E2ELimitsSchema, groupBindings: z.array(E2ERunBindingSchema).max(4) }).strict().superRefine((round, context) => {
  const groups = new Set<string>();
  const bindings = round.groupBindings;
  const cases = bindings.flatMap((binding) => binding.expectedCases);
  if (cases.length > 64) context.addIssue({ code: "custom", path: ["groupBindings"], message: "a round may contain at most 64 cases total" });
  if (new Set(bindings.map((binding) => binding.runId)).size !== bindings.length) context.addIssue({ code: "custom", path: ["groupBindings"], message: "run IDs must be unique across a round" });
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length) context.addIssue({ code: "custom", path: ["groupBindings"], message: "case IDs must be unique across a round" });
  const duration = Date.parse(round.deadlineAt) - Date.parse(round.admittedAt);
  if (duration <= 0 || duration > round.limits.runTimeoutMs || duration > E2E_HARD_LIMITS.runTimeoutMs) context.addIssue({ code: "custom", path: ["deadlineAt"], message: "round deadline must stay within its admitted run timeout" });
  for (const binding of round.groupBindings) {
    if (groups.has(binding.groupId)) context.addIssue({ code: "custom", path: ["groupBindings"], message: "round group bindings must be unique" }); groups.add(binding.groupId);
    if (binding.roundId !== round.roundId || binding.taskId !== round.taskId || binding.operationId !== round.operationId || binding.operationFence !== round.operationFence || binding.workflowRevision !== round.workflowRevision || binding.executionPlanDigest !== round.executionPlanDigest || binding.admittedAt !== round.admittedAt || binding.deadlineAt !== round.deadlineAt) context.addIssue({ code: "custom", path: ["groupBindings"], message: "group binding must share round identity, deadline, and plan" });
    const first = bindings[0];
    if (first !== undefined && (binding.policyDigest !== first.policyDigest || binding.bundleDigest !== first.bundleDigest || binding.authorizationRevision !== first.authorizationRevision || binding.modelRouteRevision !== first.modelRouteRevision || binding.candidateDigest !== first.candidateDigest || binding.planDigest !== first.planDigest)) context.addIssue({ code: "custom", path: ["groupBindings"], message: "group bindings must share policy, bundle, authorization, route, candidate, and plan" });
  }
});
export type E2ERound = z.infer<typeof E2ERoundSchema>;

export const E2ECaseStatusSchema = z.enum(["passed", "failed", "unavailable", "skipped", "unstable", "cancelled", "stale"]);
export type E2ECaseStatus = z.infer<typeof E2ECaseStatusSchema>;
export const E2EArtifactRefSchema = z.object({ artifactId: id(200), sha256: digest, bytes: z.number().int().nonnegative().max(26_214_400), mediaType: id(120), kind: z.enum(["report", "screenshot", "video", "download"]), captureQualification: z.enum(["synthetic", "redacted", "restricted"]) }).strict();
export type E2EArtifactRef = z.infer<typeof E2EArtifactRefSchema>;
export const E2EAssertionReceiptSchema = z.object({ assertionIndex: z.number().int().min(0).max(19), assertionDigest: digest, status: E2ECaseStatusSchema, reason: id(500) }).strict();
export type E2EAssertionReceipt = z.infer<typeof E2EAssertionReceiptSchema>;
export const E2ECaseResultSchema = z.object({ caseId: id(160), executionDescriptorDigest: digest, accountContextId: id(120), accountContextDigest: digest, status: E2ECaseStatusSchema, reason: id(500), attemptCount: positiveInt.max(2), assertionDigest: digest, assertionReceipts: z.array(E2EAssertionReceiptSchema).min(1).max(20), artifacts: z.array(E2EArtifactRefSchema).max(200), coverage: E2ECaseCoverageSchema }).strict().superRefine((result, context) => {
  if (new Set(result.assertionReceipts.map((receipt) => receipt.assertionIndex)).size !== result.assertionReceipts.length) context.addIssue({ code: "custom", path: ["assertionReceipts"], message: "assertion receipt indices must be unique" });
  if (result.assertionReceipts.some((receipt, index) => receipt.assertionIndex !== index)) context.addIssue({ code: "custom", path: ["assertionReceipts"], message: "assertion receipts must cover contiguous ordered indices" });
});
export type E2ECaseResult = z.infer<typeof E2ECaseResultSchema>;
export const E2EQualifiedResultSchema = z.object({ schemaVersion: z.literal(1), binding: E2ERunBindingSchema, producer: id(120), startedAt: timestamp, finishedAt: timestamp, receivedAt: timestamp, status: E2ECaseStatusSchema, qualification: z.enum(["trusted", "exploratory"]), executionMode: E2EExecutionModeSchema, reason: id(500), cases: z.array(E2ECaseResultSchema).max(64), rawReportSha256: digest.nullable(), modelReceiptIds: z.array(id(200)).max(200), cleanup: z.enum(["confirmed", "pending", "failed"]) }).strict().superRefine((result, context) => {
  if (Date.parse(result.finishedAt) < Date.parse(result.startedAt)) context.addIssue({ code: "custom", path: ["finishedAt"], message: "finish precedes start" });
  if (new Set(result.cases.map((item) => item.caseId)).size !== result.cases.length) context.addIssue({ code: "custom", path: ["cases"], message: "case results must be unique" });
  const expected = new Set(result.binding.expectedCases.map((item) => item.caseId));
  if (result.cases.some((item) => !expected.has(item.caseId))) context.addIssue({ code: "custom", path: ["cases"], message: "result includes an unbound case" });
  for (const observed of result.cases) {
    const item = result.binding.expectedCases.find((candidate) => candidate.caseId === observed.caseId);
    if (item && (observed.executionDescriptorDigest !== item.executionDescriptorDigest || observed.accountContextId !== item.accountContextId || observed.accountContextDigest !== item.accountContextDigest || observed.assertionReceipts.length !== item.assertionDigests.length || observed.assertionReceipts.some((receipt, index) => receipt.assertionDigest !== item.assertionDigests[index]))) context.addIssue({ code: "custom", path: ["cases"], message: "result case must match frozen execution descriptor, account context, and every assertion identity by index" });
  }
  if (result.cases.reduce((total, item) => total + item.artifacts.length, 0) > 200) context.addIssue({ code: "custom", path: ["cases"], message: "result may contain at most 200 artifacts" });
  if (result.executionMode !== result.binding.executionMode) context.addIssue({ code: "custom", path: ["executionMode"], message: "result mode must match its frozen binding" });
  if (result.binding.modelRouteRevision === null && result.modelReceiptIds.length > 0) context.addIssue({ code: "custom", path: ["modelReceiptIds"], message: "a null model route cannot have model usage receipts" });
});
export type E2EQualifiedResult = z.infer<typeof E2EQualifiedResultSchema>;
export const E2EProcessResultSchema = z.object({ exitCode: z.number().int().nullable(), timedOut: z.boolean(), aborted: z.boolean() }).strict();
export type E2EProcessResult = z.infer<typeof E2EProcessResultSchema>;

const evidenceRank: Record<E2EEvidenceScope, number> = { source: 0, "mock-contract": 1, runtime: 2, "external-live": 3 };
function qualifies(result: E2EQualifiedResult, item: E2EExpectedCase): boolean {
  const observed = result.cases.find((candidate) => candidate.caseId === item.caseId);
  return result.qualification === "trusted" && result.status === "passed" && result.cleanup === "confirmed" && observed?.status === "passed" && observed.executionDescriptorDigest === item.executionDescriptorDigest && observed.accountContextId === item.accountContextId && observed.accountContextDigest === item.accountContextDigest && observed.attemptCount === 1 && observed.assertionDigest === item.assertionDigest && observed.assertionReceipts.length === item.assertionDigests.length && observed.assertionReceipts.every((receipt, index) => receipt.assertionIndex === index && receipt.assertionDigest === item.assertionDigests[index] && receipt.status === "passed") && observed.coverage.subject === "candidate" && evidenceRank[observed.coverage.observedScope] >= evidenceRank[item.minimumEvidence] && item.requiredRealComponentIds.every((component) => observed.coverage.realComponentIds.includes(component));
}
function workflowResult(checkId: string, status: "PASS" | "FAILED" | "UNKNOWN") { return { checkId, status }; }
function resultTimingValid(result: E2EQualifiedResult): boolean {
  const admitted = Date.parse(result.binding.admittedAt);
  const started = Date.parse(result.startedAt);
  const finished = Date.parse(result.finishedAt);
  const deadline = Date.parse(result.binding.deadlineAt);
  const received = Date.parse(result.receivedAt);
  return admitted <= started && started <= finished && finished <= deadline && received >= finished - 5_000 && received <= finished + 305_000;
}
function projection(status: "PASS" | "FAILED" | "UNKNOWN", candidateDigest = "0".repeat(64), producer = "e2e-aggregator", environmentId = "unavailable", recordedAt = new Date(0).toISOString()): WorkflowVerificationResults {
  return { candidateDigest, producer, environmentId, recordedAt, results: [workflowResult(E2E_PROJECT_CHECK_ID, status)] };
}
function safeResult(input: unknown): E2EQualifiedResult | null {
  const copied = safeJsonInput.safeParse(input);
  if (!copied.success) return null;
  const parsed = E2EQualifiedResultSchema.safeParse(copied.data);
  return parsed.success ? parsed.data : null;
}
export function projectE2EVerification(input: E2EQualifiedResult): WorkflowVerificationResults {
  const result = safeResult(input);
  if (result === null) return projection("UNKNOWN");
  const required = result.binding.expectedCases.filter((item) => item.required);
  const completeCases = result.cases.length === result.binding.expectedCases.length && result.binding.expectedCases.every((item) => result.cases.some((observed) => observed.caseId === item.caseId));
  const freshTrusted = result.qualification === "trusted" && result.status !== "stale" && result.cases.filter((item) => item.status === "stale" && result.binding.expectedCases.find((expected) => expected.caseId === item.caseId)?.required).length === 0 && resultTimingValid(result);
  const passed = freshTrusted && completeCases && result.status === "passed" && result.cleanup === "confirmed" && required.length > 0 && required.every((item) => qualifies(result, item));
  const failed = freshTrusted && (result.status === "failed" || result.status === "unstable" || result.cases.some((item) => result.binding.expectedCases.find((expected) => expected.caseId === item.caseId)?.required && (item.status === "failed" || item.status === "unstable")));
  return projection(passed ? "PASS" : failed ? "FAILED" : "UNKNOWN", result.binding.candidateDigest, result.producer, result.binding.runtimeManifestDigest, result.receivedAt);
}
export function aggregateE2EVerification(planInput: E2EExecutionPlan, resultsInput: E2EQualifiedResult[], currentRoundInput?: E2ERound): WorkflowVerificationResults {
  // The current round is an oracle supplied by the authoritative caller. Without it, results are history only.
  if (currentRoundInput === undefined) return projection("UNKNOWN");
  try {
    const planCopy = safeJsonInput.safeParse(planInput);
    const roundCopy = safeJsonInput.safeParse(currentRoundInput);
    if (!planCopy.success || !roundCopy.success) return projection("UNKNOWN");
    const resultRows = copyBoundedE2EJsonArrayItems(resultsInput, MAX_E2E_AGGREGATE_RESULT_ROWS, { maxBytes: MAX_STRUCTURED_RECORD_BYTES, maxDepth: MAX_STRUCTURED_RECORD_DEPTH });
    const planBytes = Buffer.byteLength(canonicalJson(planCopy.data), "utf8");
    const roundBytes = Buffer.byteLength(canonicalJson(roundCopy.data), "utf8");
    const resultBytes = resultRows.reduce<number>((total, item) => total + Buffer.byteLength(canonicalJson(item), "utf8"), 0);
    if (planBytes + roundBytes + resultBytes + 4_096 > MAX_E2E_AGGREGATE_CARRIER_BYTES) return projection("UNKNOWN");
    const parsedPlan = E2EExecutionPlanSchema.safeParse(planCopy.data);
    const parsedRound = E2ERoundSchema.safeParse(roundCopy.data);
    const parsedResults = resultRows.map((item) => E2EQualifiedResultSchema.safeParse(item));
    if (!parsedPlan.success || !parsedRound.success || parsedResults.some((item) => !item.success)) return projection("UNKNOWN", parsedPlan.success ? parsedPlan.data.candidateDigest : undefined);
    const plan = parsedPlan.data;
    const round = parsedRound.data;
    const results = parsedResults.map((item) => item.success ? item.data : null).filter((item): item is E2EQualifiedResult => item !== null);
    const roundBindings = new Map(round.groupBindings.map((binding) => [binding.groupId, binding]));
    const resultsByGroup = new Map<string, E2EQualifiedResult>();
    let identityValid = plan.groups.length > 0 && round.executionPlanDigest === plan.digest && round.groupBindings.length === plan.groups.length && results.length === plan.groups.length;
    for (const result of results) {
      const binding = result.binding;
      const group = plan.groups.find((item) => item.groupId === binding.groupId);
      const currentBinding = roundBindings.get(binding.groupId);
      if (group === undefined || currentBinding === undefined || resultsByGroup.has(binding.groupId)
        || canonicalJson(binding) !== canonicalJson(currentBinding)
        || binding.candidateDigest !== plan.candidateDigest || binding.planDigest !== plan.planDigest
        || binding.executionPlanDigest !== plan.digest || binding.executionMode !== group.mode
        || binding.mockManifestDigest !== group.mockManifestDigest
        || canonicalJson(binding.expectedCases) !== canonicalJson(group.expectedCases)
        || !resultTimingValid(result)
        || result.cases.length !== binding.expectedCases.length
        || !binding.expectedCases.every((item) => result.cases.some((observed) => observed.caseId === item.caseId))) identityValid = false;
      resultsByGroup.set(binding.groupId, result);
    }
    for (const group of plan.groups) {
      const binding = roundBindings.get(group.groupId);
      if (binding === undefined || binding.candidateDigest !== plan.candidateDigest || binding.planDigest !== plan.planDigest || binding.executionPlanDigest !== plan.digest || binding.executionMode !== group.mode || binding.mockManifestDigest !== group.mockManifestDigest || canonicalJson(binding.expectedCases) !== canonicalJson(group.expectedCases)) identityValid = false;
    }
    const allExpected = plan.groups.flatMap((group) => group.expectedCases);
    const requiredCases = allExpected.filter((item) => item.required);
    const observed = new Map<string, { result: E2EQualifiedResult; expected: E2EExpectedCase }>();
    for (const result of resultsByGroup.values()) for (const expected of result.binding.expectedCases) observed.set(expected.caseId, { result, expected });
    const freshTrusted = [...resultsByGroup.values()].every((result) => result.qualification === "trusted" && result.status !== "stale" && !result.cases.some((item) => item.status === "stale" && result.binding.expectedCases.find((expected) => expected.caseId === item.caseId)?.required));
    const pass = identityValid && freshTrusted && requiredCases.length > 0
      && requiredCases.every((item) => { const found = observed.get(item.caseId); return found !== undefined && canonicalJson(found.expected) === canonicalJson(item) && qualifies(found.result, item); })
      && plan.criteria.every((item) => !item.required || (item.expectedCaseIds.length > 0 && item.expectedCaseIds.every((caseId) => {
        const expected = allExpected.find((candidate) => candidate.caseId === caseId);
        const found = observed.get(caseId);
        return expected !== undefined && expected.criterionId === item.criterionId && expected.scenarioId === item.scenarioId && expected.requestedTargetId === item.requestedTargetId && found !== undefined && qualifies(found.result, expected);
      })));
    const failed = identityValid && freshTrusted && [...observed.values()].some(({ result, expected }) => expected.required && (result.status === "failed" || result.status === "unstable" || result.cases.find((item) => item.caseId === expected.caseId)?.status === "failed" || result.cases.find((item) => item.caseId === expected.caseId)?.status === "unstable"));
    const first = results[0];
    return projection(pass ? "PASS" : failed ? "FAILED" : "UNKNOWN", plan.candidateDigest, first?.producer ?? "e2e-aggregator", first?.binding.runtimeManifestDigest ?? "unavailable", first?.receivedAt ?? new Date(0).toISOString());
  } catch {
    return projection("UNKNOWN");
  }
}

// Additional P0 data contracts are exported as strict schemas for future owners; no runtime or broker behavior lives here.
export const E2EDiscoveredApplicationSchema = z.object({ applicationId: id(120), kind: z.enum(["web", "api", "mobile", "desktop"]), sourcePaths: z.array(sourceRelativePath).max(128), recipe: E2EAppRecipeSchema.nullable() }).strict();
export type E2EDiscoveredApplication = z.infer<typeof E2EDiscoveredApplicationSchema>;
export const E2EDependencyEdgeSchema = z.object({ fromApplicationId: id(120), toComponentId: id(120), contractRef: id(200).nullable(), sourcePaths: z.array(sourceRelativePath).max(128) }).strict();
export type E2EDependencyEdge = z.infer<typeof E2EDependencyEdgeSchema>;
export const E2EMissingInputSchema = z.object({ inputId: id(120), targetIds: z.array(id(80)).max(12), kind: z.enum(["access", "auth", "network", "business-rule", "runtime", "target-selection"]), disposition: z.enum(["blocking", "mock-substitutable"]), reason: id(500), sourcePaths: z.array(sourceRelativePath).max(128) }).strict();
export type E2EMissingInput = z.infer<typeof E2EMissingInputSchema>;
export const E2ERepositoryInspectionSchema = z.object({ candidateDigest: digest, sources: z.array(z.object({ path: sourceRelativePath, sha256: digest }).strict()).max(512), applications: z.array(E2EDiscoveredApplicationSchema).max(32), proposedTargets: z.array(E2ETargetSchema).max(12), dependencyEdges: z.array(E2EDependencyEdgeSchema).max(256), proposedScenarios: z.array(E2EScenarioSchema).max(32), missingInputs: z.array(E2EMissingInputSchema).max(128) }).strict();
export type E2ERepositoryInspection = z.infer<typeof E2ERepositoryInspectionSchema>;
export const E2ESetupProposalSchema = z.object({ candidateDigest: digest, applications: z.array(E2EDiscoveredApplicationSchema).max(32), targets: z.array(E2ETargetSchema).max(12), dependencyEdges: z.array(E2EDependencyEdgeSchema).max(256), scenarios: z.array(E2EScenarioSchema).max(32), sources: E2ERepositoryInspectionSchema.shape.sources, missingInputs: z.array(E2EMissingInputSchema).max(128), state: z.enum(["proposed", "needs-input"]) }).strict();
export type E2ESetupProposal = z.infer<typeof E2ESetupProposalSchema>;
export const E2ESetupViewSchema = z.object({ state: z.enum(["mock-ready", "mixed", "runtime-ready", "needs-input"]), selectedTargetIds: z.array(id(80)).max(12), executionPlanDigest: digest.nullable(), blockingInputIds: z.array(id(120)).max(128), mockSubstitutableInputIds: z.array(id(120)).max(128) }).strict();
export type E2ESetupView = z.infer<typeof E2ESetupViewSchema>;

export const E2EMockBindingSchema = z.object({ componentId: id(120), requestedTargetId: id(80), effectiveTargetId: id(80), binding: z.discriminatedUnion("kind", [z.object({ kind: z.literal("http"), runLocalOrigin: z.string().url() }).strict(), z.object({ kind: z.literal("in-process"), adapterProfileId: id(120), fixtureVersion: id(80) }).strict()]), contractDigest: digest }).strict();
export type E2EMockBinding = z.infer<typeof E2EMockBindingSchema>;
export type E2EMockLease = { digest: string; bindings: readonly E2EMockBinding[]; close(signal: AbortSignal): Promise<{ confirmed: boolean }> };
export type E2ECollection = { process: z.infer<typeof E2EProcessResultSchema>; rawReport: Uint8Array | null; observedUpstreamRunId: string | null; coverageByCase: ReadonlyMap<string, E2ECaseCoverage>; artifacts: E2EArtifactRef[]; modelReceiptIds: string[]; startedAt: string; finishedAt: string; cleanup: E2EQualifiedResult["cleanup"] };
export type E2EValidationContext = { binding: E2ERunBinding; producer: string; now: string; qualification: E2EQualifiedResult["qualification"] };
export type E2EApplicationRuntime = { applicationId: string; appBuildManifestDigest: string; appRecipe: E2EAppRecipe };
export type E2ERuntimeProfile = { profileId: string; kind: "default-sandbox" | "web" | "api" | "android" | "ios" | "electron" | "native-desktop"; runtimeManifestDigest: string; applications: E2EApplicationRuntime[]; networkPolicyDigest: string; seedDigest: string; limits: E2ELimits; capture: E2ECapturePolicy };
export type CompiledE2ESuite = { bundle: E2EScenarioBundle; files: ReadonlyMap<string, string>; expectedCases: E2EExpectedCase[] };
export type E2ERunInput = { binding: E2ERunBinding; suite: CompiledE2ESuite; profile: E2ERuntimeProfile; modelPermit: E2EModelPermit | null };
export type E2ERuntimePorts = { allocate(input: E2ERunInput, signal: AbortSignal): Promise<E2ELease> };
export type E2ELease = { leaseId: string; execute(signal: AbortSignal): Promise<E2ECollection>; close(signal: AbortSignal): Promise<{ confirmed: boolean }> };
export type E2EModelPermit = { permitId: string; token: string; runId: string; taskId: string; creatorPrincipal: string; routeRevision: string; expiresAt: string };
export type E2EModelRequest = { requestId: string; permit: E2EModelPermit; prompt: unknown; tools: unknown; responseFormat: unknown; toolChoice: unknown; maxOutputTokens: number; temperature: number | null; stopSequences: string[] };
export type E2EModelResponse = { content: unknown; finishReason: string; usage: { inputTokens: number | null; outputTokens: number | null }; receiptId: string };
export type E2EModelTransport = { generate(request: E2EModelRequest, signal: AbortSignal): Promise<E2EModelResponse> };
