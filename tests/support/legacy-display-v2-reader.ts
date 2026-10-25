import { createHash } from "node:crypto";
import { z } from "zod";
import { E2ESharedViewSchema, E2EWorkflowDisplayRefSchema, E2E_DISPLAY_SCREENSHOT_MAX_BYTES } from "@agentx/contracts";

// A verbatim copy of the notifier's display reader as it stood at the end of Task 4.4a (commit d901218b, the parent of Tasks 4.4b and 4.4c), which is the reader M1.3 shipped:
// the strict display schema v2 (a row, a baseline), the v2 envelope and `readWorkflowE2ENotifierProjection`. It is pinned here so that a test can show that a reader built before
// display schema v3 refuses a v3 display and falls back, with the schemas and logic that actually shipped and not with a model of them. Do not edit it to follow the current schemas.
const displaySha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** The account a row ran as: its profile id, never an email. */
const displayAccountLabel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/);
/** The kinds of approved assertion a row can say it failed on. */
const E2E_DISPLAY_ASSERTION_KINDS = ["text", "visible", "csv", "http-status", "json", "state", "file"] as const;
const E2EDisplayScenarioSchema = z.object({
  scenarioId: z.string().min(1).max(120),
  title: z.string().min(1).max(120),
  kind: z.enum(["web", "api"]),
  accountLabel: displayAccountLabel,
  status: z.enum(["PASSED", "FAILED", "UNKNOWN"]),
  reason: z.string().min(1).max(300).optional(),
  failedAssertion: z.object({ kind: z.enum(E2E_DISPLAY_ASSERTION_KINDS), expected: z.string().max(200), actual: z.string().max(200) }).strict().optional(),
  /** A screenshot is the only artifact kept: traces are not captured (Ruling CJ), so there is no `traceRef`. */
  screenshotRef: z.object({ sha256: displaySha256, bytes: z.number().int().positive().max(E2E_DISPLAY_SCREENSHOT_MAX_BYTES), contentType: z.literal("image/jpeg") }).strict().optional(),
  mockedOrigins: z.array(z.string().min(1).max(200)).max(32),
}).strict().superRefine((row, context) => {
  if (row.failedAssertion !== undefined && row.status !== "FAILED") context.addIssue({ code: "custom", path: ["failedAssertion"], message: "only a failed row has a failed assertion" });
});

/** The informational round on the unchanged code: `UNAVAILABLE` is "it could not be run" and holds no rows. It is never a candidate round and never gates anything. */
const E2EDisplayBaselineSchema = z.object({
  status: z.enum(["PASSED", "FAILED", "UNKNOWN", "UNAVAILABLE"]),
  scenarios: z.array(E2EDisplayScenarioSchema).max(64),
}).strict().superRefine((baseline, context) => {
  if (baseline.status === "UNAVAILABLE" && baseline.scenarios.length > 0) context.addIssue({ code: "custom", path: ["scenarios"], message: "a baseline that could not run has no rows" });
});

type E2EScenarioResults = { scenarios: z.infer<typeof E2EDisplayScenarioSchema>[]; baseline?: z.infer<typeof E2EDisplayBaselineSchema> };

const refFields = {
  capturedAt: z.string().datetime(),
  candidateDigest: E2EWorkflowDisplayRefSchema.shape.candidateDigest,
  roundId: E2EWorkflowDisplayRefSchema.shape.roundId,
  groupRunIds: E2EWorkflowDisplayRefSchema.shape.groupRunIds,
  admissionSha256: E2EWorkflowDisplayRefSchema.shape.admissionSha256,
  evidenceSha256: E2EWorkflowDisplayRefSchema.shape.evidenceSha256,
};

/** Display schema v1 (M1.2): the shared view and the identity of the round it was captured for. */
const envelopeV1 = E2ESharedViewSchema.extend({ displaySchemaVersion: z.literal(1), ...refFields }).strict();
/** Display schema v2 (M1.3): v1 plus one row per scenario, and the baseline round when there was one. A v2 object always has at least one row. */
const envelopeV2 = E2ESharedViewSchema.extend({ displaySchemaVersion: z.literal(2), ...refFields,
  scenarios: z.array(E2EDisplayScenarioSchema).min(1).max(64), baseline: E2EDisplayBaselineSchema.optional() }).strict();

const DISPLAY_MAX_BYTES = 262_144;

export async function readLegacyV2WorkflowE2ENotifierProjection(input: {
  ref: unknown;
  ownerKey: string;
  workspaceId: string;
  current: { candidateDigest: string; roundId: string; groupRunIds: string[]; admissionSha256: string; evidenceSha256: string };
  readPrivateObject(key: string, maxBytes: number): Promise<Uint8Array | undefined>;
}): Promise<{ view: ReturnType<typeof E2ESharedViewSchema.parse>; capturedAt: string; candidateDigest: string; roundId: string; scenarioResults?: E2EScenarioResults } | undefined> {
  const ref = E2EWorkflowDisplayRefSchema.safeParse(input.ref);
  if (!ref.success || ref.data.key !== `private/${input.ownerKey}/${input.workspaceId}/workflow-e2e-display/${ref.data.sha256}.json`
    || ref.data.candidateDigest !== input.current.candidateDigest || ref.data.roundId !== input.current.roundId
    || JSON.stringify(ref.data.groupRunIds) !== JSON.stringify(input.current.groupRunIds)
    || ref.data.admissionSha256 !== input.current.admissionSha256 || ref.data.evidenceSha256 !== input.current.evidenceSha256) return undefined;
  const bytes = await input.readPrivateObject(ref.data.key, ref.data.byteLength);
  if (bytes === undefined || bytes.byteLength !== ref.data.byteLength || bytes.byteLength > DISPLAY_MAX_BYTES
    || createHash("sha256").update(bytes).digest("hex") !== ref.data.sha256) return undefined;
  try {
    const raw: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const version = typeof raw === "object" && raw !== null ? (raw as { displaySchemaVersion?: unknown }).displaySchemaVersion : undefined;
    if (version !== 1 && version !== 2) return undefined;
    const envelope = version === 2 ? envelopeV2.safeParse(raw) : envelopeV1.safeParse(raw);
    if (!envelope.success || envelope.data.candidateDigest !== input.current.candidateDigest
      || envelope.data.roundId !== input.current.roundId || JSON.stringify(envelope.data.groupRunIds) !== JSON.stringify(input.current.groupRunIds)
      || envelope.data.admissionSha256 !== input.current.admissionSha256
      || envelope.data.evidenceSha256 !== input.current.evidenceSha256) return undefined;
    const view = { schemaVersion: envelope.data.schemaVersion, setup: envelope.data.setup, e2e: envelope.data.e2e, actions: envelope.data.actions };
    const scenarioResults = "scenarios" in envelope.data ? { scenarios: envelope.data.scenarios, ...(envelope.data.baseline === undefined ? {} : { baseline: envelope.data.baseline }) } : undefined;
    return { view: E2ESharedViewSchema.parse(view), capturedAt: envelope.data.capturedAt,
      candidateDigest: envelope.data.candidateDigest, roundId: envelope.data.roundId, ...(scenarioResults === undefined ? {} : { scenarioResults }) };
  } catch { return undefined; }
}

