import { createHash } from "node:crypto";
import { z } from "zod";
import { E2EApplicationBuildSourceManifestSchema, E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES, type CandidateManifest, type E2EApplicationBuildSourceRef,
  type E2ESourceSnapshot } from "@agentx/contracts";
import { validateE2EApplicationBuildSourceManifest } from "@agentx/verifier";

/** Where the broker keeps the manifest a worker exported for a candidate, content addressed so a replay is the same object. */
export const candidateBuildSourceKey = (manifestSha256: string): string => `workflow-candidate-build-sources/sha256/${manifestSha256}.json`;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * What the broker records about a candidate's build source, on the candidate export record (`buildSource`) and on the IMPLEMENT operation
 * (`candidateBuildSource`). READY: the validated manifest is stored at `manifestRef.key`; its archive identity is the reference an application admission
 * carries. REFUSED: there is no usable manifest and `reason` says why, in words an owner can read; application dispatch refuses with it.
 */
export const StoredCandidateBuildSourceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("READY"), manifestRef: z.object({ key: z.string().min(1).max(200), sha256, byteLength: z.number().int().positive().max(E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES) }).strict(),
    manifestDigest: sha256, archiveSha256: sha256, archiveByteLength: z.number().int().positive(), fileCount: z.number().int().nonnegative(), omissionCount: z.number().int().nonnegative(),
    candidateDigest: sha256, repositoryId: z.string().min(1).max(200), commitSha: z.string().regex(/^[a-f0-9]{40}$/), treeSha: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  z.object({ status: z.literal("REFUSED"), reason: z.string().min(1).max(600), candidateDigest: sha256 }).strict(),
]);
export type StoredCandidateBuildSource = z.infer<typeof StoredCandidateBuildSourceSchema>;

/**
 * The reference an application admission carries for a READY build source. The archive itself is deliberately not stored (the worker re-stages the source
 * from its own repository), so `artifactId` is an explicit "unstored archive" name that no reader can resolve to bytes, never the manifest's key; the
 * archive's sha256 and size and the manifest's digest are the identities that matter. Where the manifest is stored is `manifestRef`.
 */
export function candidateBuildSourceAdmissionReference(stored: Extract<StoredCandidateBuildSource, { status: "READY" }>): E2EApplicationBuildSourceRef {
  return { artifactId: `unstored-archive-sha256-${stored.archiveSha256}`, sha256: stored.archiveSha256, byteLength: stored.archiveByteLength, manifestDigest: stored.manifestDigest };
}

/** The upload requests that carry a build source manifest, after the candidate source export, on the candidate-build-source callback. */
export const CandidateBuildSourceBodySchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("init"), schemaVersion: z.literal("workflow-candidate-build-source-upload/v1"), totalBytes: z.number().int().positive().max(E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES),
    chunkCount: z.number().int().positive(), sha256 }).strict(),
  z.object({ stage: z.literal("chunk"), schemaVersion: z.literal("workflow-candidate-build-source-chunk/v1"), uploadId: z.string().uuid(), index: z.number().int().nonnegative(),
    bytesBase64: z.string().min(1).max(Math.ceil(64 * 1024 * 4 / 3) + 8), sha256 }).strict(),
  z.object({ stage: z.literal("finalize"), schemaVersion: z.literal("workflow-candidate-build-source-finalize/v1"), uploadId: z.string().uuid(), sha256 }).strict(),
  z.object({ stage: z.literal("unavailable"), schemaVersion: z.literal("workflow-candidate-build-source-unavailable/v1"), reason: z.string().trim().min(1).max(600) }).strict(),
]);

/** The committed export the manifest must describe, as the broker stored it. */
export type CommittedExportForBuildSource = {
  candidate: CandidateManifest;
  repositories: ReadonlyArray<{ repositoryId: string; commitSha: string; treeSha: string; treePaths: readonly string[];
    sources: ReadonlyArray<{ path: string; sha256: string; bytesBase64: string }> }>;
};

const refused = (candidateDigest: string, reason: string): StoredCandidateBuildSource => ({ status: "REFUSED", reason: `the build source manifest was refused: ${reason}`.slice(0, 600), candidateDigest });

/**
 * Judges the manifest a worker uploaded against the candidate export the broker already holds. Never throws: a manifest that is malformed, too large, for
 * another repository, commit or tree, or that the application admission validator rejects is REFUSED with its reason, and the portable export is untouched.
 * `manifestBytes` are the exact uploaded bytes (already matched to the upload digest) and are stored as they are.
 */
export function assessCandidateBuildSource(input: { manifestBytes: Buffer; committed: CommittedExportForBuildSource }): StoredCandidateBuildSource {
  const { candidate } = input.committed;
  if (input.committed.repositories.length !== 1) return refused(candidate.digest, "the candidate export must hold exactly one repository");
  const repository = input.committed.repositories[0]!;
  if (input.manifestBytes.byteLength > E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES) return refused(candidate.digest, "the manifest is over its size limit");
  let json: unknown;
  try { json = JSON.parse(input.manifestBytes.toString("utf8")) as unknown; } catch { return refused(candidate.digest, "it is not valid JSON"); }
  const parsed = E2EApplicationBuildSourceManifestSchema.safeParse(json);
  if (!parsed.success) return refused(candidate.digest, parsed.error.issues[0]?.message ?? "it does not match the manifest schema");
  const manifest = parsed.data;
  if (manifest.repository.repositoryId !== repository.repositoryId || manifest.repository.commitSha !== repository.commitSha || manifest.repository.treeSha !== repository.treeSha
    || manifest.candidateDigest !== candidate.digest) return refused(candidate.digest, "it describes a different repository, commit or tree than the exported candidate");
  if (manifest.sourceState !== "committed-tree") return refused(candidate.digest, "it does not describe a committed tree");
  const snapshot: E2ESourceSnapshot = { candidate: candidate, commitSha: repository.commitSha, treeSha: repository.treeSha, treeComplete: true, treePaths: [...repository.treePaths],
    sources: repository.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") })) };
  const reference = { artifactId: "pending", sha256: manifest.archive.sha256, byteLength: manifest.archive.byteLength, manifestDigest: manifest.manifestDigest };
  try { validateE2EApplicationBuildSourceManifest({ manifest, reference, expectedCandidate: candidate, inspectionSnapshot: snapshot }); }
  catch (error) { return refused(candidate.digest, error instanceof Error ? error.message : "it did not validate"); }
  const manifestSha256 = createHash("sha256").update(input.manifestBytes).digest("hex");
  return { status: "READY", manifestRef: { key: candidateBuildSourceKey(manifestSha256), sha256: manifestSha256, byteLength: input.manifestBytes.byteLength }, manifestDigest: manifest.manifestDigest,
    archiveSha256: manifest.archive.sha256, archiveByteLength: manifest.archive.byteLength, fileCount: manifest.files.length, omissionCount: manifest.omissions.length,
    candidateDigest: candidate.digest, repositoryId: repository.repositoryId, commitSha: repository.commitSha, treeSha: repository.treeSha };
}
