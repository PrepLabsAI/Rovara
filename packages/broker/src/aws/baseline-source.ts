import { createHash } from "node:crypto";
import { z } from "zod";
import { CandidateManifestSchema, createCandidateManifest, verifyE2ESourceSnapshot, type E2ESourceSnapshot } from "@agentx/contracts";
import { StoredCandidateBuildSourceSchema, assessCandidateBuildSource } from "./candidate-build-source.js";

/**
 * M1.3 Task 3.7b: the unchanged code, for the baseline round. At the end of a coding run the worker exports the task's base commit (the code the task started from) the way it
 * exports the candidate: the committed tree and the safe sources, and the build source manifest that describes the tree for a build. The broker judges both here, against each
 * other and against nothing the worker says about itself, and keeps the verdict on the coding operation (`baselineSource`): READY with where the objects are, or REFUSED with the
 * reason. Whether the export is the task's pinned base is not decided here; the dispatch of the baseline round compares it with the base the task pinned.
 */

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sha1 = z.string().regex(/^[a-f0-9]{40}$/);

const ReadyBuildSourceSchema = StoredCandidateBuildSourceSchema.options[0];

export const StoredBaselineSourceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("READY"),
    sourceRef: z.object({ key: z.string().min(1).max(200), sha256, byteLength: z.number().int().positive(), candidateDigest: sha256 }).strict(),
    buildSource: ReadyBuildSourceSchema, repositoryId: z.string().min(1).max(200), baseCommitSha: sha1, baseTreeSha: sha1 }).strict(),
  z.object({ status: z.literal("REFUSED"), reason: z.string().min(1).max(600) }).strict(),
]);
export type StoredBaselineSource = z.infer<typeof StoredBaselineSourceSchema>;
export type ReadyBaselineSource = Extract<StoredBaselineSource, { status: "READY" }>;

/** The upload requests that carry the unchanged code, on the baseline-source callback. */
export const BaselineSourceBodySchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("init"), schemaVersion: z.literal("workflow-baseline-source-upload/v1"), totalBytes: z.number().int().positive(), chunkCount: z.number().int().positive(), sha256 }).strict(),
  z.object({ stage: z.literal("chunk"), schemaVersion: z.literal("workflow-baseline-source-chunk/v1"), uploadId: z.string().uuid(), index: z.number().int().nonnegative(),
    bytesBase64: z.string().min(1).max(Math.ceil(64 * 1024 * 4 / 3) + 8), sha256 }).strict(),
  z.object({ stage: z.literal("finalize"), schemaVersion: z.literal("workflow-baseline-source-finalize/v1"), uploadId: z.string().uuid(), sha256 }).strict(),
  z.object({ stage: z.literal("unavailable"), schemaVersion: z.literal("workflow-baseline-source-unavailable/v1"), reason: z.string().trim().min(1).max(600) }).strict(),
]);

/** What a finalized upload holds: the exact bytes of the committed export and of the build source manifest, each in base64. */
export const BaselineSourceWireSchema = z.object({ schemaVersion: z.literal("workflow-baseline-source/v1"), sourceBase64: z.string().min(1), manifestBase64: z.string().min(1) }).strict();

const ExportSchema = z.object({ schemaVersion: z.literal("workflow-candidate-source/v1"), candidate: CandidateManifestSchema,
  repositories: z.array(z.object({ repositoryId: z.string().min(1).max(200), commitSha: sha1, treeSha: sha1, baseCommitSha: sha1.optional(), treeComplete: z.literal(true),
    treePaths: z.array(z.string().min(1).max(1024)).max(100_000),
    sources: z.array(z.object({ path: z.string().min(1).max(1024), sha256, bytesBase64: z.string().max(700_000), kind: z.literal("blob") }).strict()).max(512) }).strict()).length(1) }).strict();
export type BaselineExport = z.infer<typeof ExportSchema>;

/** The key a stored export lives at: content addressed, as the candidate's are. */
export const baselineSourceKey = (exportSha256: string): string => `workflow-candidate-sources/sha256/${exportSha256}.json`;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/**
 * Judges an uploaded export of the unchanged code. Throws for an export that is not one (malformed, not a single repository, one that records a base of its own, a candidate
 * identity that is not its repositories', sources that do not match its tree), so nothing is recorded for it. A build source manifest that does not fit the export is not an error
 * but a REFUSED verdict with its reason, as for a candidate: the export stands and the baseline round then says it could not be checked.
 */
export function assessBaselineSource(input: { sourceBytes: Buffer; manifestBytes: Buffer | undefined }): StoredBaselineSource {
  const parsed = parseBaselineExport(input.sourceBytes);
  const [repository] = parsed.repositories;
  const [identity] = parsed.candidate.repositories;
  if (repository === undefined || identity === undefined || parsed.candidate.repositories.length !== 1 || createCandidateManifest(parsed.candidate.repositories).digest !== parsed.candidate.digest) {
    throw new Error("the baseline source export's candidate identity is invalid");
  }
  if (repository.baseCommitSha !== undefined || identity.baseCommitSha !== undefined || identity.repositoryId !== repository.repositoryId || identity.commitSha !== repository.commitSha
    || identity.treeSha !== repository.treeSha) throw new Error("the baseline source export is not the unchanged code of one repository");
  let total = 0;
  const sources = repository.sources.map((source) => {
    const decoded = Buffer.from(source.bytesBase64, "base64");
    if (decoded.toString("base64") !== source.bytesBase64) throw new Error("the baseline source blob encoding is invalid");
    total += decoded.byteLength;
    if (total > MAX_SOURCE_BYTES) throw new Error("the baseline source blobs exceed their aggregate bound");
    return { path: source.path, sha256: source.sha256, bytes: decoded, kind: "blob" as const };
  });
  const single = createCandidateManifest([identity]);
  const snapshot: E2ESourceSnapshot = { candidate: single, commitSha: repository.commitSha, treeSha: repository.treeSha, treeComplete: repository.treeComplete, treePaths: repository.treePaths, sources };
  try { verifyE2ESourceSnapshot(snapshot, single); } catch { throw new Error("the baseline source bytes do not match their committed tree inventory"); }
  if (input.manifestBytes === undefined) return { status: "REFUSED", reason: "the worker sent no build source manifest for the unchanged code" };
  const assessed = assessCandidateBuildSource({ manifestBytes: input.manifestBytes, committed: { candidate: parsed.candidate, repositories: parsed.repositories } });
  if (assessed.status === "REFUSED") return { status: "REFUSED", reason: assessed.reason };
  return { status: "READY", sourceRef: { key: baselineSourceKey(createHash("sha256").update(input.sourceBytes).digest("hex")), sha256: createHash("sha256").update(input.sourceBytes).digest("hex"),
    byteLength: input.sourceBytes.byteLength, candidateDigest: parsed.candidate.digest }, buildSource: assessed, repositoryId: repository.repositoryId, baseCommitSha: repository.commitSha,
  baseTreeSha: repository.treeSha };
}

/** The export of the unchanged code in these bytes, held to its bounds; throws for anything else. */
export function parseBaselineExport(sourceBytes: Uint8Array): BaselineExport {
  try { return ExportSchema.parse(JSON.parse(Buffer.from(sourceBytes).toString("utf8")) as unknown); } catch { throw new Error("the baseline source export is malformed or outside its bounds"); }
}
