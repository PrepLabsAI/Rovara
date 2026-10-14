import { createHash } from "node:crypto";
import { z } from "zod";
import { E2ESharedViewSchema, E2EWorkflowDisplayRefSchema, type E2EWorkflowDisplayRef } from "@agentx/contracts";
import { canonicalJson } from "@agentx/contracts";

const envelopeSchema = E2ESharedViewSchema.extend({
  displaySchemaVersion: E2EWorkflowDisplayRefSchema.shape.schemaVersion,
  capturedAt: z.string().datetime(),
  candidateDigest: E2EWorkflowDisplayRefSchema.shape.candidateDigest,
  roundId: E2EWorkflowDisplayRefSchema.shape.roundId,
  groupRunIds: E2EWorkflowDisplayRefSchema.shape.groupRunIds,
  admissionSha256: E2EWorkflowDisplayRefSchema.shape.admissionSha256,
  evidenceSha256: E2EWorkflowDisplayRefSchema.shape.evidenceSha256,
}).strict();

export async function readWorkflowE2ENotifierProjection(input: {
  ref: unknown;
  ownerKey: string;
  workspaceId: string;
  current: { candidateDigest: string; roundId: string; groupRunIds: string[]; admissionSha256: string; evidenceSha256: string };
  readPrivateObject(key: string, maxBytes: number): Promise<Uint8Array | undefined>;
}): Promise<{ view: ReturnType<typeof E2ESharedViewSchema.parse>; capturedAt: string } | undefined> {
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
    return { view: E2ESharedViewSchema.parse(view), capturedAt: envelope.data.capturedAt };
  } catch { return undefined; }
}

export function workflowE2EDisplayRef(input: Omit<E2EWorkflowDisplayRef, "schemaVersion" | "key" | "sha256" | "byteLength"> & { ownerKey: string; workspaceId: string; bytes: Uint8Array }): E2EWorkflowDisplayRef {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  return E2EWorkflowDisplayRefSchema.parse({ schemaVersion: 1, key: `private/${input.ownerKey}/${input.workspaceId}/workflow-e2e-display/${sha256}.json`,
    sha256, byteLength: input.bytes.byteLength, candidateDigest: input.candidateDigest, roundId: input.roundId, groupRunIds: input.groupRunIds,
    admissionSha256: input.admissionSha256, evidenceSha256: input.evidenceSha256 });
}

export function createWorkflowE2EDisplayObject(input: { ownerKey: string; workspaceId: string; view: unknown; capturedAt: string; current: {
  candidateDigest: string; roundId: string; groupRunIds: string[]; admissionSha256: string; evidenceSha256: string;
} }): { bytes: Uint8Array; ref: E2EWorkflowDisplayRef } | undefined {
  const view = E2ESharedViewSchema.safeParse(input.view);
  if (!view.success) return undefined;
  const bytes = Buffer.from(canonicalJson({ displaySchemaVersion: 1, capturedAt: input.capturedAt, ...input.current, ...view.data }), "utf8");
  if (bytes.byteLength > 262_144) return undefined;
  const ref = workflowE2EDisplayRef({ ownerKey: input.ownerKey, workspaceId: input.workspaceId, bytes, ...input.current });
  return { bytes, ref };
}
