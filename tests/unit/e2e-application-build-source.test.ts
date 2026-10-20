import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, createCandidateManifest, type E2ESourceSnapshot } from "@agentx/contracts";
import { E2EApplicationBuildSourceManifestSchema as SourceManifestSchema } from "../../packages/contracts/src/e2e-application-execution.js";
import { encodeE2EApplicationBuildSourceArchive, materializeE2EApplicationBuildSource,
  validateE2EApplicationBuildSourceManifest } from "../../packages/verifier/src/application-build-source.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const gitBlob = (bytes: Uint8Array) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes])).digest("hex");
function tree(name: string, mode: string, objectId: string): string {
  const entry = Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(objectId, "hex")]);
  return createHash("sha1").update(Buffer.concat([Buffer.from(`tree ${entry.byteLength}\0`), entry])).digest("hex");
}
function treeForEntries(entries: readonly { path: string; mode: string; objectId: string }[]): string {
  type Node = { files: Array<{ name: string; mode: string; objectId: string }>; dirs: Map<string, Node> };
  const root: Node = { files: [], dirs: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split("/"); let node = root;
    for (const part of parts.slice(0, -1)) { let child = node.dirs.get(part); if (!child) { child = { files: [], dirs: new Map() }; node.dirs.set(part, child); } node = child; }
    node.files.push({ name: parts.at(-1)!, mode: entry.mode, objectId: entry.objectId });
  }
  const write = (node: Node): Buffer => {
    const records = [...node.files.map((item) => ({ name: item.name, dir: false, bytes: Buffer.concat([Buffer.from(`${item.mode} ${item.name}\0`), Buffer.from(item.objectId, "hex")]) })),
      ...[...node.dirs].map(([name, child]) => ({ name, dir: true, bytes: Buffer.concat([Buffer.from(`40000 ${name}\0`), Buffer.from(createHash("sha1").update(write(child)).digest("hex"), "hex")]) }))];
    records.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.dir ? "/" : "")), Buffer.from(b.name + (b.dir ? "/" : ""))));
    const body = Buffer.concat(records.map((item) => item.bytes)); return Buffer.concat([Buffer.from(`tree ${body.byteLength}\0`), body]);
  };
  return createHash("sha1").update(write(root)).digest("hex");
}

describe("exact candidate application build source", () => {
  it("bounds aggregate decoded source bytes at manifest ingress without allocating file payloads", async () => {
    const limit = 64 * 1024 * 1024;
    const makeManifest = (total: number) => {
      const count = 9; const fileBytes = Array.from({ length: count }, (_, index) => Math.floor(total / count) + (index < total % count ? 1 : 0));
      const files = fileBytes.map((byteLength, index) => ({ path: `src/file${index}.js`, mode: "100644" as const,
        gitBlobId: "a".repeat(40), sha256: "b".repeat(64), byteLength }));
      const treeEntries = files.map(({ path, mode, gitBlobId }) => ({ path, mode, objectId: gitBlobId }));
      const body = { schemaVersion: "e2e-application-build-source-manifest/v1" as const, candidateDigest: "c".repeat(64),
        repository: { repositoryId: "repo", commitSha: "d".repeat(40), treeSha: treeForEntries(treeEntries) }, sourceState: "candidate-index-tree" as const,
        pathPolicy: "existing-safe-e2e-source-path/v1" as const, treeEntries, files, omissions: [],
        archive: { format: "e2e-application-build-source-archive/v1" as const, sha256: "e".repeat(64), byteLength: 100_000_000, fileCount: count } };
      return { ...body, manifestDigest: sha(canonicalJson(body)) };
    };
    expect(SourceManifestSchema.safeParse(makeManifest(limit - 1)).success).toBe(true);
    expect(SourceManifestSchema.safeParse(makeManifest(limit)).success).toBe(true);
    const overLimit = makeManifest(limit + 1);
    expect(SourceManifestSchema.safeParse(overLimit).success).toBe(false);
    const candidate = createCandidateManifest([{ repositoryId: "repo", commitSha: overLimit.repository.commitSha, treeSha: overLimit.repository.treeSha }]);
    const sourceBody = { ...overLimit, candidateDigest: candidate.digest };
    const sourceManifest = { ...sourceBody, manifestDigest: sha(canonicalJson(sourceBody)) };
    const reference = { artifactId: "oversized", sha256: sourceManifest.archive.sha256,
      byteLength: sourceManifest.archive.byteLength, manifestDigest: sourceManifest.manifestDigest };
    const binding = { schemaVersion: "e2e-application-build-binding/v1", preparationId: "11111111-1111-4111-8111-111111111111",
      taskId: "22222222-2222-4222-8222-222222222222", workspaceId: "33333333-3333-4333-8333-333333333333",
      operationId: "44444444-4444-4444-8444-444444444444", operationFence: 1, workflowRevision: 1,
      candidateDigest: candidate.digest, planDigest: "b".repeat(64), intentDigest: "c".repeat(64), applicationApprovalDigest: "d".repeat(64),
      applicationId: "app", recipeDigest: "e".repeat(64), buildSourceManifestDigest: sourceManifest.manifestDigest,
      buildSourceSha256: reference.sha256, runtimeProfileId: "profile", runtimeManifestDigest: "f".repeat(64), deadlineAt: "2099-01-01T00:00:00.000Z" } as const;
    const readChunk = vi.fn(async () => { throw new Error("oversized source payload must not be requested"); });
    await expect(materializeE2EApplicationBuildSource({ manifest: sourceManifest, reference, expectedCandidate: candidate,
      inspectionSnapshot: { candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha: candidate.repositories[0]!.treeSha,
        treeComplete: true, treePaths: overLimit.treeEntries.map((entry) => entry.path).sort(), sources: [] }, binding,
      destination: join(tmpdir(), "oversized-source-must-not-be-created"), signal: new AbortController().signal, readChunk })).rejects.toThrow(/64 MiB aggregate/);
    expect(readChunk).not.toHaveBeenCalled();
  });

  it("materializes a permitted asset that is absent from bounded inspection blobs", async () => {
    const bytes = Buffer.from("export const asset = 42;\n");
    const path = "src/asset.js";
    const blob = gitBlob(bytes);
    const treeSha = tree("src", "40000", tree("asset.js", "100644", blob));
    const candidate = createCandidateManifest([{ repositoryId: "repo", commitSha: "a".repeat(40), treeSha }]);
    const archiveText = canonicalJson({ schemaVersion: "e2e-application-build-source-archive/v1",
      files: [{ path, mode: "100644", bytesBase64: bytes.toString("base64") }] });
    const body = { schemaVersion: "e2e-application-build-source-manifest/v1" as const, candidateDigest: candidate.digest,
      repository: { repositoryId: "repo", commitSha: "a".repeat(40), treeSha }, sourceState: "candidate-index-tree" as const,
      pathPolicy: "existing-safe-e2e-source-path/v1" as const,
      treeEntries: [{ path, mode: "100644" as const, objectId: blob }],
      files: [{ path, mode: "100644" as const, gitBlobId: blob, sha256: sha(bytes), byteLength: bytes.byteLength }], omissions: [],
      archive: { format: "e2e-application-build-source-archive/v1" as const, sha256: sha(archiveText), byteLength: Buffer.byteLength(archiveText), fileCount: 1 } };
    const manifest = { ...body, manifestDigest: sha(canonicalJson(body)) };
    const reference = { artifactId: "owned-source-1", sha256: sha(archiveText), byteLength: Buffer.byteLength(archiveText), manifestDigest: manifest.manifestDigest };
    const snapshot: E2ESourceSnapshot = { candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha, treeComplete: true,
      treePaths: [path], sources: [] };
    const binding = { schemaVersion: "e2e-application-build-binding/v1", preparationId: "11111111-1111-4111-8111-111111111111",
      taskId: "22222222-2222-4222-8222-222222222222", workspaceId: "33333333-3333-4333-8333-333333333333",
      operationId: "44444444-4444-4444-8444-444444444444", operationFence: 1, workflowRevision: 1,
      candidateDigest: candidate.digest, planDigest: "b".repeat(64), intentDigest: "c".repeat(64),
      applicationApprovalDigest: "d".repeat(64), applicationId: "app", recipeDigest: "e".repeat(64),
      buildSourceManifestDigest: manifest.manifestDigest, buildSourceSha256: reference.sha256,
      runtimeProfileId: "web-profile", runtimeManifestDigest: "f".repeat(64), deadlineAt: "2099-01-01T00:00:00.000Z" } as const;
    const encoded = encodeE2EApplicationBuildSourceArchive([{ path, mode: "100644", bytes }]);
    expect(Buffer.from(encoded.bytes).toString("utf8")).toBe(archiveText);
    expect(validateE2EApplicationBuildSourceManifest({ manifest, reference, expectedCandidate: candidate, inspectionSnapshot: snapshot }).files).toHaveLength(1);
    const withBaseCandidate = createCandidateManifest([{ repositoryId: "repo", commitSha: "a".repeat(40), treeSha, baseCommitSha: "b".repeat(40) }]);
    const withBaseBody = { ...body, candidateDigest: withBaseCandidate.digest, repository: { ...body.repository, baseCommitSha: "b".repeat(40) } };
    const withBaseManifest = { ...withBaseBody, manifestDigest: sha(canonicalJson(withBaseBody)) };
    const withBaseReference = { ...reference, manifestDigest: withBaseManifest.manifestDigest };
    const withBaseSnapshot = { ...snapshot, candidate: withBaseCandidate };
    expect(validateE2EApplicationBuildSourceManifest({ manifest: withBaseManifest, reference: withBaseReference,
      expectedCandidate: withBaseCandidate, inspectionSnapshot: withBaseSnapshot }).repository.baseCommitSha).toBe("b".repeat(40));
    const committedCandidate = createCandidateManifest([{ repositoryId: "repo", commitSha: treeSha, treeSha }]);
    const committedBody = { ...body, candidateDigest: committedCandidate.digest, repository: { repositoryId: "repo", commitSha: treeSha, treeSha }, sourceState: "committed-tree" as const };
    const committedManifest = { ...committedBody, manifestDigest: sha(canonicalJson(committedBody)) };
    const committedReference = { ...reference, manifestDigest: committedManifest.manifestDigest };
    const committedSnapshot = { ...snapshot, candidate: committedCandidate, commitSha: treeSha };
    expect(validateE2EApplicationBuildSourceManifest({ manifest: committedManifest, reference: committedReference,
      expectedCandidate: committedCandidate, inspectionSnapshot: committedSnapshot }).sourceState).toBe("committed-tree");
    const committedWithBase = createCandidateManifest([{ repositoryId: "repo", commitSha: treeSha, treeSha, baseCommitSha: "b".repeat(40) }]);
    const committedWithBaseBody = { ...committedBody, candidateDigest: committedWithBase.digest,
      repository: { repositoryId: "repo", commitSha: treeSha, treeSha, baseCommitSha: "b".repeat(40) } };
    const committedWithBaseManifest = { ...committedWithBaseBody, manifestDigest: sha(canonicalJson(committedWithBaseBody)) };
    expect(validateE2EApplicationBuildSourceManifest({ manifest: committedWithBaseManifest,
      reference: { ...reference, manifestDigest: committedWithBaseManifest.manifestDigest }, expectedCandidate: committedWithBase,
      inspectionSnapshot: { ...committedSnapshot, candidate: committedWithBase } }).repository.baseCommitSha).toBe("b".repeat(40));
    const changedBaseCandidate = createCandidateManifest([{ repositoryId: "repo", commitSha: "a".repeat(40), treeSha, baseCommitSha: "c".repeat(40) }]);
    expect(() => validateE2EApplicationBuildSourceManifest({ manifest: withBaseManifest, reference: withBaseReference,
      expectedCandidate: changedBaseCandidate, inspectionSnapshot: { ...withBaseSnapshot, candidate: changedBaseCandidate } })).toThrow(/exact single-repository candidate/);
    const directory = await realpath(await mkdtemp(join(tmpdir(), "e2e-app-source-")));
    try {
      const result = await materializeE2EApplicationBuildSource({ manifest, reference, expectedCandidate: candidate,
        inspectionSnapshot: snapshot, binding, destination: directory, signal: new AbortController().signal,
        readChunk: async (offset) => ({ offset, totalBytes: encoded.bytes.byteLength, sha256: encoded.sha256,
          bytes: encoded.bytes.slice(offset, Math.min(offset + 64 * 1024, encoded.bytes.byteLength)) }) });
      expect(await readFile(join(result.sourceDirectory, path), "utf8")).toBe(bytes.toString("utf8"));
      const cancelledDirectory = await realpath(await mkdtemp(join(tmpdir(), "e2e-app-cancelled-write-")));
      let reading = false;
      let checksAfterRead = 0;
      const cancelDuringMaterialization = { get aborted() { return reading && ++checksAfterRead >= 13; }, reason: undefined,
        addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
      try {
        await expect(materializeE2EApplicationBuildSource({ manifest, reference, expectedCandidate: candidate,
          inspectionSnapshot: snapshot, binding, destination: cancelledDirectory, signal: cancelDuringMaterialization,
          readChunk: async (offset) => { reading = true; return { offset, totalBytes: encoded.bytes.byteLength, sha256: encoded.sha256,
            bytes: encoded.bytes.slice(offset, Math.min(offset + 64 * 1024, encoded.bytes.byteLength)) }; } })).rejects.toThrow(/cancelled or exceeded/);
        expect(checksAfterRead).toBe(13);
      } finally { await rm(cancelledDirectory, { recursive: true, force: true }); }
      const replayDirectory = await realpath(await mkdtemp(join(tmpdir(), "e2e-app-replay-")));
      try {
        await expect(materializeE2EApplicationBuildSource({ manifest, reference, expectedCandidate: candidate,
          inspectionSnapshot: snapshot, binding, destination: replayDirectory, signal: new AbortController().signal,
          readChunk: async (offset) => ({ offset: offset + 1, totalBytes: encoded.bytes.byteLength, sha256: encoded.sha256,
            bytes: encoded.bytes.slice(offset, Math.min(offset + 64 * 1024, encoded.bytes.byteLength)) }) })).rejects.toThrow(/chunks are out of order/);
        expect(await readdir(replayDirectory)).toEqual([]);
      } finally { await rm(replayDirectory, { recursive: true, force: true }); }

      const stalledDirectory = await realpath(await mkdtemp(join(tmpdir(), "e2e-app-stalled-")));
      const controller = new AbortController();
      let readerSignal: AbortSignal | undefined;
      try {
        await expect(materializeE2EApplicationBuildSource({ manifest, reference, expectedCandidate: candidate,
          inspectionSnapshot: snapshot, binding, destination: stalledDirectory, signal: controller.signal,
          // The read never settles, and the caller cancels only once the read is under way: no wall-clock timer decides whether the abort lands
          // before or after the first read (it used to, and under load it could land before, so the reader never saw a signal).
          readChunk: async (_offset, signal) => { readerSignal = signal; controller.abort(); return new Promise(() => undefined); } })).rejects.toThrow(/chunk read exceeded|cancelled or exceeded/);
        expect(readerSignal?.aborted).toBe(true);
        expect(await readdir(stalledDirectory)).toEqual([]);
      } finally { await rm(stalledDirectory, { recursive: true, force: true }); }

      const preDispatchDirectory = await realpath(await mkdtemp(join(tmpdir(), "e2e-app-predispatch-")));
      const preDispatchSignal = { aborted: false, reason: undefined,
        addEventListener(_type: string, listener: () => void) {
          queueMicrotask(() => listener());
        }, removeEventListener() {} } as unknown as AbortSignal;
      const readAfterAbort = vi.fn(async (offset: number) => ({ offset, totalBytes: encoded.bytes.byteLength, sha256: encoded.sha256,
        bytes: encoded.bytes.slice(offset, Math.min(offset + 64 * 1024, encoded.bytes.byteLength)) }));
      try {
        await expect(materializeE2EApplicationBuildSource({ manifest, reference, expectedCandidate: candidate,
          inspectionSnapshot: snapshot, binding, destination: preDispatchDirectory, signal: preDispatchSignal,
          readChunk: readAfterAbort })).rejects.toThrow(/chunk read exceeded/);
        expect(readAfterAbort).not.toHaveBeenCalled();
        expect(await readdir(preDispatchDirectory)).toEqual([]);
      } finally { await rm(preDispatchDirectory, { recursive: true, force: true }); }

      const publicDirectory = await realpath(await mkdtemp(join(tmpdir(), "e2e-app-public-")));
      try {
        await chmod(publicDirectory, 0o755);
        await expect(materializeE2EApplicationBuildSource({ manifest, reference, expectedCandidate: candidate,
          inspectionSnapshot: snapshot, binding, destination: publicDirectory, signal: new AbortController().signal,
          readChunk: async () => { throw new Error("must not be called for a non-private destination"); } })).rejects.toThrow(/owner-controlled private/);
      } finally { await chmod(publicDirectory, 0o700); await rm(publicDirectory, { recursive: true, force: true }); }

      const symlinkParent = await realpath(await mkdtemp(join(tmpdir(), "e2e-app-link-")));
      const linkedDirectory = join(symlinkParent, "linked");
      await symlink(directory, linkedDirectory);
      try {
        await expect(materializeE2EApplicationBuildSource({ manifest, reference, expectedCandidate: candidate,
          inspectionSnapshot: snapshot, binding, destination: linkedDirectory, signal: new AbortController().signal,
          readChunk: async () => { throw new Error("must not be called for a symlink destination"); } })).rejects.toThrow(/owner-controlled private/);
      } finally { await rm(symlinkParent, { recursive: true, force: true }); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects unsafe omitted paths and a chunk replay before writing files", async () => {
    const value = encodeE2EApplicationBuildSourceArchive([{ path: "src/a.js", mode: "100644", bytes: Buffer.from("x") }]);
    expect(() => encodeE2EApplicationBuildSourceArchive([{ path: "../secret", mode: "100644", bytes: Buffer.from("x") }])).toThrow();
    expect(value.byteLength).toBe(value.bytes.byteLength);
  });
});
