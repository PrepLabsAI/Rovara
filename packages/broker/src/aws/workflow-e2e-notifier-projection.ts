import { createHash } from "node:crypto";
import { z } from "zod";
import { E2EDisplayBaselineSchema, E2EDisplayScenarioSchema, E2ESharedViewSchema, E2EWorkflowDisplayRefSchema, type E2EScenarioResults, type E2EWorkflowDisplayRef } from "@agentx/contracts";
import { canonicalJson } from "@agentx/contracts";
import { scrubScenarioResults } from "../e2e/application-display.js";

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

/** The newest display schema this code reads. A reader built before a version exists reads nothing of it: it renders its fallback, never a verdict. */
export const WORKFLOW_E2E_DISPLAY_SCHEMA_VERSION = 2;
const DISPLAY_MAX_BYTES = 262_144;

/** Where the screenshot of a row is kept: private to the task's owner and workspace, by its digest. */
export const workflowE2EArtifactKey = (ownerKey: string, workspaceId: string, sha256: string): string => `private/${ownerKey}/${workspaceId}/workflow-e2e-artifacts/${sha256}`;

export async function readWorkflowE2ENotifierProjection(input: {
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

export function workflowE2EDisplayRef(input: Omit<E2EWorkflowDisplayRef, "schemaVersion" | "key" | "sha256" | "byteLength"> & { ownerKey: string; workspaceId: string; bytes: Uint8Array }): E2EWorkflowDisplayRef {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  return E2EWorkflowDisplayRefSchema.parse({ schemaVersion: 1, key: `private/${input.ownerKey}/${input.workspaceId}/workflow-e2e-display/${sha256}.json`,
    sha256, byteLength: input.bytes.byteLength, candidateDigest: input.candidateDigest, roundId: input.roundId, groupRunIds: input.groupRunIds,
    admissionSha256: input.admissionSha256, evidenceSha256: input.evidenceSha256 });
}

/**
 * The bounded display object for a finished round. A portable round (no scenario rows) is written as display schema v1, which every reader reads; a browser and API round
 * is written as v2 with its rows (scrubbed again here, so no email or credential is stored whatever reached a field), and with the baseline when there is one. A display
 * that does not fit its bound loses its baseline first; one that still does not fit is not written, and every reader then falls back to "Open the task page".
 */
export function createWorkflowE2EDisplayObject(input: { ownerKey: string; workspaceId: string; view: unknown; capturedAt: string; current: {
  candidateDigest: string; roundId: string; groupRunIds: string[]; admissionSha256: string; evidenceSha256: string;
}; scenarioResults?: E2EScenarioResults }): { bytes: Uint8Array; ref: E2EWorkflowDisplayRef } | undefined {
  const view = E2ESharedViewSchema.safeParse(input.view);
  if (!view.success) return undefined;
  const scrubbed = input.scenarioResults === undefined ? undefined : scrubScenarioResults(input.scenarioResults);
  if (input.scenarioResults !== undefined && scrubbed === undefined) return undefined;
  const write = (body: Record<string, unknown>): Buffer | undefined => {
    const bytes = Buffer.from(canonicalJson(body), "utf8");
    return bytes.byteLength > DISPLAY_MAX_BYTES ? undefined : bytes;
  };
  let bytes: Buffer | undefined;
  if (scrubbed === undefined || scrubbed.scenarios.length === 0) {
    bytes = write({ displaySchemaVersion: 1, capturedAt: input.capturedAt, ...input.current, ...view.data });
  } else {
    const v2 = (baseline: E2EScenarioResults["baseline"]) => write({ displaySchemaVersion: 2, capturedAt: input.capturedAt, ...input.current, ...view.data,
      scenarios: scrubbed.scenarios, ...(baseline === undefined ? {} : { baseline }) });
    bytes = v2(scrubbed.baseline) ?? (scrubbed.baseline === undefined ? undefined : v2(undefined));
  }
  if (bytes === undefined) return undefined;
  const ref = workflowE2EDisplayRef({ ownerKey: input.ownerKey, workspaceId: input.workspaceId, bytes, ...input.current });
  return { bytes, ref };
}
