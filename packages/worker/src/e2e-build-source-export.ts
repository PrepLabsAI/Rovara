import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2EApplicationBuildSourceManifestSchema, E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES, canonicalJson, type CandidateManifest, type E2EApplicationBuildSourceManifest } from "@agentx/contracts";
import { encodeE2EApplicationBuildSourceArchive } from "@agentx/verifier";
import { BuildSourceCapError, createProcessCandidateGit, type CandidateBuildSourceGit } from "./e2e-candidate-source.js";

/** A candidate whose manifest would be larger is refused, never trimmed (the bound is shared with the broker, which refuses to store a larger one). */
export const MAX_BUILD_SOURCE_MANIFEST_BYTES = E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES;

/** What the worker reports about the build source of the candidate it just exported. UNAVAILABLE carries the reason the owner is shown at dispatch. */
export type CandidateBuildSourceExport =
  | { schemaVersion: "workflow-candidate-build-source/v1"; status: "READY"; manifest: E2EApplicationBuildSourceManifest }
  | { schemaVersion: "workflow-candidate-build-source/v1"; status: "UNAVAILABLE"; reason: string };

const SCHEMA_VERSION = "workflow-candidate-build-source/v1" as const;
const REASON_BYTES = 480;
const unavailable = (reason: string): CandidateBuildSourceExport => ({ schemaVersion: SCHEMA_VERSION, status: "UNAVAILABLE",
  reason: reason.length <= REASON_BYTES ? reason : `${reason.slice(0, REASON_BYTES - 1)}…` });

/**
 * Computes the build source manifest of the committed candidate through the worker's safe git path (a throwaway repository that only borrows the
 * candidate's objects; git never runs in the candidate repository). Every tree path is recorded once, either as a permitted regular file (mode, blob id,
 * sha256, size) or as an explicit omission (blocked path, symlink, submodule). A candidate the build source cannot hold is reported UNAVAILABLE with the
 * reason; only the operation's own cancellation throws.
 */
export async function exportCandidateBuildSource(input: { git: CandidateBuildSourceGit; repositoryRoot: string; candidate: CandidateManifest; signal: AbortSignal;
  maxManifestBytes?: number }): Promise<CandidateBuildSourceExport> {
  const maxManifestBytes = input.maxManifestBytes ?? MAX_BUILD_SOURCE_MANIFEST_BYTES;
  const [repository] = input.candidate.repositories;
  if (input.candidate.repositories.length !== 1 || repository === undefined) return unavailable("the build source needs a candidate with exactly one repository");
  try {
    const listing = await input.git.buildSourceOf(input.repositoryRoot, repository.commitSha, input.signal);
    if (listing.treeSha !== repository.treeSha) return unavailable("the committed tree does not match the candidate tree");
    if (listing.entries.length === 0) return unavailable("the committed candidate tree is empty");
    const permitted = new Set(listing.files.map((file) => file.path));
    const treeEntries = [...listing.entries].sort((left, right) => compare(left.path, right.path));
    const omissions = treeEntries.filter((entry) => !permitted.has(entry.path)).map((entry) => ({ path: entry.path, mode: entry.mode, objectId: entry.objectId,
      reason: entry.mode === "120000" ? "symlink" as const : entry.mode === "160000" ? "submodule" as const : "blocked-path" as const }));
    const files = [...listing.files].sort((left, right) => compare(left.path, right.path));
    const archive = encodeE2EApplicationBuildSourceArchive(files.map(({ path, mode, bytes }) => ({ path, mode, bytes })));
    const body = { schemaVersion: "e2e-application-build-source-manifest/v1" as const, candidateDigest: input.candidate.digest,
      repository: { repositoryId: repository.repositoryId, commitSha: repository.commitSha, treeSha: repository.treeSha,
        ...(repository.baseCommitSha === undefined ? {} : { baseCommitSha: repository.baseCommitSha }) },
      sourceState: "committed-tree" as const, pathPolicy: "existing-safe-e2e-source-path/v1" as const, treeEntries,
      files: files.map(({ path, mode, gitBlobId, sha256, byteLength }) => ({ path, mode, gitBlobId, sha256, byteLength })), omissions,
      archive: { format: "e2e-application-build-source-archive/v1" as const, sha256: archive.sha256, byteLength: archive.byteLength, fileCount: archive.fileCount } };
    const parsed = E2EApplicationBuildSourceManifestSchema.safeParse({ ...body, manifestDigest: createHash("sha256").update(canonicalJson(body)).digest("hex") });
    if (!parsed.success) return unavailable(`the candidate tree cannot be described as a build source: ${parsed.error.issues[0]?.message ?? "invalid manifest"}`);
    const size = Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
    if (size > maxManifestBytes) return unavailable(`the build source manifest is ${size} bytes, over the ${maxManifestBytes} byte limit`);
    return { schemaVersion: SCHEMA_VERSION, status: "READY", manifest: parsed.data };
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : error;
    if (error instanceof BuildSourceCapError) return unavailable(error.message);
    return unavailable(`the build source could not be computed: ${error instanceof Error ? error.message : "unknown failure"}`);
  }
}

/**
 * `exportCandidateBuildSource` with its own scratch directory for the throwaway repository, made and removed here. A scratch directory that cannot be made
 * is a reason like any other (the build source is then unavailable); it never fails the run that is exporting its candidate. Only cancellation throws.
 */
export async function exportCandidateBuildSourceInScratch(input: { repositoryRoot: string; candidate: CandidateManifest; signal: AbortSignal;
  maxManifestBytes?: number; makeScratch?: () => Promise<string> }): Promise<CandidateBuildSourceExport> {
  let scratch: string | undefined;
  try {
    scratch = await (input.makeScratch ?? (() => mkdtemp(join(tmpdir(), "agentx-build-source-"))))();
    return await exportCandidateBuildSource({ git: createProcessCandidateGit(scratch), repositoryRoot: input.repositoryRoot, candidate: input.candidate, signal: input.signal,
      ...(input.maxManifestBytes === undefined ? {} : { maxManifestBytes: input.maxManifestBytes }) });
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : error;
    return unavailable(`the build source could not be computed: ${error instanceof Error ? error.message : "unknown failure"}`);
  } finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
