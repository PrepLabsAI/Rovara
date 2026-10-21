import { createHash } from "node:crypto";
import { z } from "zod";

// A verbatim copy of the notifier's display reader as it stood before M1.3 Task 3.7 (commit 3dd0d549, the parent of the commit that added display schema v2): the shared view
// schema, the display ref schema and `readWorkflowE2ENotifierProjection`. It is pinned here so that a test can show that a reader built before M1.3 refuses a version 2 display
// and falls back, with the schemas and logic that actually shipped and not with a model of them. Do not edit it to follow the current schemas.
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positiveInt = z.number().int().positive();
export const E2ESharedSetupViewSchema = z.object({ status: z.enum(["unavailable", "proposed", "needs-input", "mock-ready", "mixed", "runtime-ready"]), selectedTargetIds: z.array(z.string()).max(12), executionPlanDigest: z.string().nullable(), blockingInputIds: z.array(z.string()).max(128), mockSubstitutableInputIds: z.array(z.string()).max(128) }).strict();
export const E2ESharedViewSchema = z.object({ schemaVersion: z.literal(1), setup: E2ESharedSetupViewSchema, e2e: z.object({ status: z.enum(["UNKNOWN", "FAILED", "PASS"]), label: z.string(), executionPlanDigest: z.string().nullable(), expectedGroups: z.number().int().nonnegative(), receivedGroups: z.number().int().nonnegative(), executedCases: z.number().int().nonnegative(), qualifiedCriteria: z.number().int().nonnegative(), requiredCriteria: z.number().int().nonnegative(), unavailableCriteria: z.number().int().nonnegative(), optionalUnavailableCriteria: z.number().int().nonnegative(), mockedComponentIds: z.array(z.string()).max(200), observedMockedComponentIds: z.array(z.string()).max(200), unexercisedBehaviors: z.array(z.string()).max(256), policyPresence: z.enum(["present", "absent"]), workflowPhase: z.string().max(120).nullable(), requiredUnexercisedCriteriaIds: z.array(z.string()).max(64) }).strict(), actions: z.array(z.enum(["review-setup", "retry-run", "connect-runtime"])).max(3) }).strict();
export const E2EWorkflowDisplayRefSchema = z.object({ schemaVersion: z.literal(1), key: z.string().regex(/^private\/[^/]+\/[^/]+\/workflow-e2e-display\/[a-f0-9]{64}\.json$/),
  sha256: digest, byteLength: positiveInt.max(262_144), candidateDigest: digest, roundId: z.string().uuid(), groupRunIds: z.array(z.string().uuid()).min(1).max(4), admissionSha256: digest, evidenceSha256: digest }).strict();

const envelopeSchema = E2ESharedViewSchema.extend({
  displaySchemaVersion: E2EWorkflowDisplayRefSchema.shape.schemaVersion,
  capturedAt: z.string().datetime(),
  candidateDigest: E2EWorkflowDisplayRefSchema.shape.candidateDigest,
  roundId: E2EWorkflowDisplayRefSchema.shape.roundId,
  groupRunIds: E2EWorkflowDisplayRefSchema.shape.groupRunIds,
  admissionSha256: E2EWorkflowDisplayRefSchema.shape.admissionSha256,
  evidenceSha256: E2EWorkflowDisplayRefSchema.shape.evidenceSha256,
}).strict();

export async function readLegacyWorkflowE2ENotifierProjection(input: {
  ref: unknown;
  ownerKey: string;
  workspaceId: string;
  current: { candidateDigest: string; roundId: string; groupRunIds: string[]; admissionSha256: string; evidenceSha256: string };
  readPrivateObject(key: string, maxBytes: number): Promise<Uint8Array | undefined>;
}): Promise<{ view: ReturnType<typeof E2ESharedViewSchema.parse>; capturedAt: string; candidateDigest: string; roundId: string } | undefined> {
  const ref = E2EWorkflowDisplayRefSchema.safeParse(input.ref);
  if (!ref.success || ref.data.key !== `private/${input.ownerKey}/${input.workspaceId}/workflow-e2e-display/${ref.data.sha256}.json`
    || ref.data.candidateDigest !== input.current.candidateDigest || ref.data.roundId !== input.current.roundId
    || JSON.stringify(ref.data.groupRunIds) !== JSON.stringify(input.current.groupRunIds)
    || ref.data.admissionSha256 !== input.current.admissionSha256 || ref.data.evidenceSha256 !== input.current.evidenceSha256) return undefined;
  const bytes = await input.readPrivateObject(ref.data.key, ref.data.byteLength);
  if (bytes === undefined || bytes.byteLength !== ref.data.byteLength || bytes.byteLength > 262_144
    || createHash("sha256").update(bytes).digest("hex") !== ref.data.sha256) return undefined;
  try {
    const envelope = envelopeSchema.safeParse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    if (!envelope.success || envelope.data.displaySchemaVersion !== 1 || envelope.data.candidateDigest !== input.current.candidateDigest
      || envelope.data.roundId !== input.current.roundId || JSON.stringify(envelope.data.groupRunIds) !== JSON.stringify(input.current.groupRunIds)
      || envelope.data.admissionSha256 !== input.current.admissionSha256
      || envelope.data.evidenceSha256 !== input.current.evidenceSha256) return undefined;
    const view = { schemaVersion: envelope.data.schemaVersion, setup: envelope.data.setup, e2e: envelope.data.e2e, actions: envelope.data.actions };
    return { view: E2ESharedViewSchema.parse(view), capturedAt: envelope.data.capturedAt,
      candidateDigest: envelope.data.candidateDigest, roundId: envelope.data.roundId };
  } catch { return undefined; }
}
