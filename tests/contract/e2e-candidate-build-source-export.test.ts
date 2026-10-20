import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/index.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { candidateBuildSourceReference, StoredCandidateBuildSourceSchema } from "../../packages/broker/src/aws/candidate-build-source.js";
import { validateE2EApplicationBuildSourceManifest } from "../../packages/verifier/src/application-build-source.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";
import { exportCandidateBuildSource, type CandidateBuildSourceExport } from "../../packages/worker/src/e2e-build-source-export.js";
import { createProcessCandidateGit } from "../../packages/worker/src/e2e-candidate-source.js";
import { postWorkerTerminalResult } from "../../packages/worker/src/terminal-callback.js";
import { readCommittedCandidateSourceExport, type CommittedCandidateSourceExport } from "../../packages/worker/src/verification/candidate.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const workspaceId = randomUUID();
const CONTROL_PLANE = "https://control.example.test";

async function candidateRepository(tree: Record<string, string>) {
  const root = await temp("build-source-broker-repo-");
  git(root, "init", "-q");
  for (const [path, content] of Object.entries(tree)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "candidate");
  const identity = { repositoryId: "fixture/app", commitSha: git(root, "rev-parse", "HEAD"), treeSha: git(root, "rev-parse", "HEAD^{tree}") };
  const source = await readCommittedCandidateSourceExport([{ repositoryId: identity.repositoryId, directory: root }], [identity]);
  const buildSource = await exportCandidateBuildSource({ git: createProcessCandidateGit(await temp("build-source-scratch-")), repositoryRoot: root, candidate: source.candidate, signal: new AbortController().signal });
  return { root, identity, source, buildSource };
}

/** A broker over a fake table and a bucket that can delete, an IMPLEMENT operation the worker may report on, and the worker's own callback client wired to the broker handler. */
function harness() {
  const objects = new Map<string, Buffer>();
  const s3 = { send: vi.fn(async (command: never) => {
    const typed = command as unknown as { constructor: { name: string }; input: { Key: string; Body?: string | Uint8Array; IfNoneMatch?: string } };
    if (typed.constructor.name === "DeleteObjectCommand") { objects.delete(typed.input.Key); return {}; }
    if (typed.input.Body !== undefined) {
      if (typed.input.IfNoneMatch === "*" && objects.has(typed.input.Key)) throw Object.assign(new Error("precondition"), { name: "PreconditionFailed" });
      objects.set(typed.input.Key, Buffer.from(typed.input.Body)); return {};
    }
    const bytes = objects.get(typed.input.Key);
    if (bytes === undefined) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
    return { Body: { transformToString: async () => bytes.toString("utf8"), transformToByteArray: async () => new Uint8Array(bytes) } };
  }) };
  const broker = createBroker({ s3, slack: false });
  const operationId = randomUUID();
  const putOperation = (patch: Record<string, unknown> = {}) => broker.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, entityType: "OPERATION", id: operationId, workspaceId,
    kind: "task", workflowMode: "IMPLEMENT", status: "RUNNING", fence: 1, eventSequence: 0, requestId: randomUUID(), payloadHash: "a".repeat(64), createdAt: new Date().toISOString(), ...patch });
  putOperation();
  const capability = issueCapability({ callbackSigningKey: "c".repeat(64) }, workspaceId, operationId, 1, false, false, false, false, true);
  const requests: Array<{ path: string; status: number; body: Record<string, unknown> }> = [];
  const send = async (path: string, body: unknown) => {
    const response = await broker.handler({ version: "2.0", rawPath: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/${path}`, rawQueryString: "",
      headers: { "x-agentx-callback-capability": capability, "content-type": "application/json" }, body: JSON.stringify(body),
      requestContext: { requestId: randomUUID(), http: { method: "POST" } } });
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    requests.push({ path, status: response.statusCode, body: parsed });
    return { status: response.statusCode, body: parsed };
  };
  const fetchImplementation = (async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname.split("/").at(-1)!;
    const answer = await send(path, JSON.parse(init.body));
    return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
  }) as unknown as typeof fetch;
  const invocation = { operationId, workspaceId, callbackCapability: capability } as never;
  const sinks = createWorkerCallbackSinks({ controlPlaneUrl: CONTROL_PLANE, invocation, fetchImplementation });
  const operation = () => broker.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as Record<string, unknown>;
  const exportRecord = () => broker.db.get(`WORKSPACE#${workspaceId}`, `CANDIDATE_EXPORT#${operationId}`) as Record<string, unknown> | undefined;
  return { ...broker, objects, s3, send, sinks, operationId, operation, exportRecord, requests, putOperation };
}

/** Streams a manifest to the broker by hand, as a worker would, but for any bytes at all. */
async function uploadManifest(h: ReturnType<typeof harness>, bytes: Buffer) {
  const chunkBytes = 64 * 1024;
  const chunkCount = Math.ceil(bytes.byteLength / chunkBytes);
  const digest = sha256(bytes);
  const init = await h.send("candidate-build-source", { stage: "init", schemaVersion: "workflow-candidate-build-source-upload/v1", totalBytes: bytes.byteLength, chunkCount, sha256: digest });
  expect(init.status).toBe(200);
  const uploadId = init.body.uploadId as string;
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = bytes.subarray(index * chunkBytes, Math.min((index + 1) * chunkBytes, bytes.byteLength));
    expect((await h.send("candidate-build-source", { stage: "chunk", schemaVersion: "workflow-candidate-build-source-chunk/v1", uploadId, index, bytesBase64: chunk.toString("base64"), sha256: sha256(chunk) })).status).toBe(200);
  }
  return h.send("candidate-build-source", { stage: "finalize", schemaVersion: "workflow-candidate-build-source-finalize/v1", uploadId, sha256: digest });
}
const readyOf = (built: CandidateBuildSourceExport) => { if (built.status !== "READY") throw new Error(built.reason); return built.manifest; };

describe("the broker validates and stores the exported build source manifest", () => {
  it("stores the manifest's location and digest on the export record and the operation, through the worker's own callbacks", async () => {
    const repo = await candidateRepository({ "package.json": "{\"name\":\"app\"}", "src/server.js": "console.log(1)\n", ".env": "SECRET=1\n", "bin/run.sh": "#!/bin/sh\n" });
    const h = harness();
    await h.sinks.candidateSourceExportSink(repo.source);
    const exportOnly = { ...h.exportRecord() };
    expect(exportOnly).toMatchObject({ status: "COMPLETE" });
    expect(exportOnly.buildSource).toBeUndefined();

    await h.sinks.candidateBuildSourceSink(repo.buildSource);
    const manifest = readyOf(repo.buildSource);
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const stored = StoredCandidateBuildSourceSchema.parse(h.operation().candidateBuildSource);
    expect(stored).toEqual({ status: "READY", manifestRef: { key: `workflow-candidate-build-sources/sha256/${sha256(manifestBytes)}.json`, sha256: sha256(manifestBytes), byteLength: manifestBytes.byteLength },
      manifestDigest: manifest.manifestDigest, archiveSha256: manifest.archive.sha256, archiveByteLength: manifest.archive.byteLength, fileCount: manifest.files.length,
      omissionCount: manifest.omissions.length, candidateDigest: repo.source.candidate.digest, repositoryId: "fixture/app", commitSha: repo.identity.commitSha, treeSha: repo.identity.treeSha });
    expect(h.exportRecord()!.buildSource).toEqual(stored);
    // Everything the export record held before is untouched; only buildSource is new.
    expect({ ...h.exportRecord(), buildSource: undefined }).toEqual({ ...exportOnly, buildSource: undefined });
    // The stored object is exactly the uploaded bytes, content addressed.
    expect(h.objects.get(stored.status === "READY" ? stored.manifestRef.key : "")?.equals(manifestBytes)).toBe(true);
    // The reference an admission carries validates against the broker's own stored export.
    if (stored.status !== "READY") throw new Error("expected READY");
    const reference = candidateBuildSourceReference(stored);
    expect(reference).toEqual({ artifactId: stored.manifestRef.key, sha256: manifest.archive.sha256, byteLength: manifest.archive.byteLength, manifestDigest: manifest.manifestDigest });
    const snapshot = { candidate: repo.source.candidate, commitSha: repo.identity.commitSha, treeSha: repo.identity.treeSha, treeComplete: true as const, treePaths: repo.source.repositories[0]!.treePaths,
      sources: repo.source.repositories[0]!.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") })) };
    expect(validateE2EApplicationBuildSourceManifest({ manifest, reference, expectedCandidate: repo.source.candidate, inspectionSnapshot: snapshot }).manifestDigest).toBe(manifest.manifestDigest);
    // The chunks the upload staged are gone.
    expect([...h.objects.keys()].filter((key) => key.includes("staging"))).toEqual([]);
  });

  it("answers a replay of the finished upload without recording anything twice", async () => {
    const repo = await candidateRepository({ "package.json": "{}" });
    const h = harness();
    await h.sinks.candidateSourceExportSink(repo.source);
    const bytes = Buffer.from(JSON.stringify(readyOf(repo.buildSource)), "utf8");
    const first = await uploadManifest(h, bytes);
    expect(first.body).toMatchObject({ accepted: true });
    const recorded = structuredClone(h.operation().candidateBuildSource);
    const init = await h.send("candidate-build-source", { stage: "init", schemaVersion: "workflow-candidate-build-source-upload/v1", totalBytes: bytes.byteLength, chunkCount: Math.ceil(bytes.byteLength / 65536), sha256: sha256(bytes) });
    expect(init.status).toBe(409);
    expect(h.operation().candidateBuildSource).toEqual(recorded);
  });

  it("refuses a manifest for another commit or tree, records why, and leaves the portable export working", async () => {
    const repo = await candidateRepository({ "package.json": "{\"name\":\"app\"}", "src/a.js": "a" });
    const other = await candidateRepository({ "package.json": "{\"name\":\"other\"}", "src/b.js": "b" });
    const h = harness();
    await h.sinks.candidateSourceExportSink(repo.source);
    const exportBefore = structuredClone(h.exportRecord());
    const answer = await uploadManifest(h, Buffer.from(JSON.stringify(readyOf(other.buildSource)), "utf8"));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ accepted: false, buildSource: { status: "REFUSED", reason: (expect.stringMatching(/different repository, commit or tree/) as string) } });
    expect(StoredCandidateBuildSourceSchema.parse(h.operation().candidateBuildSource)).toMatchObject({ status: "REFUSED", candidateDigest: repo.source.candidate.digest });
    expect(h.exportRecord()).toMatchObject({ ...exportBefore, buildSource: { status: "REFUSED" } });
    expect(h.operation().candidateSourceRef).toBeDefined();
    expect([...h.objects.keys()].filter((key) => key.startsWith("workflow-candidate-build-sources/"))).toEqual([]);
  });

  it("refuses a manifest whose repository identity was rewritten to the export's but whose content is for another tree", async () => {
    const repo = await candidateRepository({ "package.json": "{\"name\":\"app\"}", "src/a.js": "a" });
    const other = await candidateRepository({ "package.json": "{\"name\":\"other\"}", "src/b.js": "b" });
    const h = harness();
    await h.sinks.candidateSourceExportSink(repo.source);
    const forged = { ...readyOf(other.buildSource), candidateDigest: repo.source.candidate.digest,
      repository: { repositoryId: "fixture/app", commitSha: repo.identity.commitSha, treeSha: repo.identity.treeSha } };
    const answer = await uploadManifest(h, Buffer.from(JSON.stringify(forged), "utf8"));
    expect(answer.body).toMatchObject({ accepted: false, buildSource: { status: "REFUSED" } });
    expect(h.operation().candidateBuildSource).toMatchObject({ status: "REFUSED" });
  });

  it("refuses a manifest that changes a file identity, is not a committed tree, or carries a wrong digest", async () => {
    const repo = await candidateRepository({ "package.json": "{\"name\":\"app\"}", "src/a.js": "a" });
    const manifest = readyOf(repo.buildSource);
    // A manifest whose own digest is recomputed, so only the broker's comparison with the stored export can catch the change.
    const resign = (value: typeof manifest) => { const { manifestDigest: _digest, ...body } = value; void _digest; return { ...body, manifestDigest: sha256(canonicalJson(body)) }; };
    for (const change of [
      (value: typeof manifest) => resign({ ...value, files: value.files.map((file) => file.path === "package.json" ? { ...file, sha256: "f".repeat(64) } : file) }),
      (value: typeof manifest) => resign({ ...value, sourceState: "candidate-index-tree" as const }),
      (value: typeof manifest) => ({ ...value, manifestDigest: "0".repeat(64) }),
    ]) {
      const h = harness();
      await h.sinks.candidateSourceExportSink(repo.source);
      const answer = await uploadManifest(h, Buffer.from(JSON.stringify(change(manifest)), "utf8"));
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ accepted: false, buildSource: { status: "REFUSED" } });
    }
  });

  it("refuses a manifest that is not JSON or not a manifest", async () => {
    const repo = await candidateRepository({ "package.json": "{}" });
    for (const text of ["not json at all", "{\"schemaVersion\":\"e2e-application-build-source-manifest/v1\"}"]) {
      const h = harness();
      await h.sinks.candidateSourceExportSink(repo.source);
      expect((await uploadManifest(h, Buffer.from(text))).body).toMatchObject({ accepted: false, buildSource: { status: "REFUSED" } });
    }
  });

  it("refuses an upload over the manifest size cap before any chunk is accepted", async () => {
    const repo = await candidateRepository({ "package.json": "{}" });
    const h = harness();
    await h.sinks.candidateSourceExportSink(repo.source);
    const total = 8 * 1024 * 1024 + 1;
    const answer = await h.send("candidate-build-source", { stage: "init", schemaVersion: "workflow-candidate-build-source-upload/v1", totalBytes: total, chunkCount: Math.ceil(total / 65536), sha256: "a".repeat(64) });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(h.operation().candidateBuildSource).toBeUndefined();
    expect(h.db.get(`WORKSPACE#${workspaceId}`, `CANDIDATE_BUILD_SOURCE#${h.operationId}`)).toBeUndefined();
  });

  it("records the worker's own refusal (over the build source cap) with its reason, and never a truncated manifest", async () => {
    const repo = await candidateRepository({ "package.json": "{}" });
    const h = harness();
    await h.sinks.candidateSourceExportSink(repo.source);
    const reason = "candidate file big.bin is 9000000 bytes, over the 8 MiB build source file limit";
    await h.sinks.candidateBuildSourceSink({ schemaVersion: "workflow-candidate-build-source/v1", status: "UNAVAILABLE", reason });
    expect(h.operation().candidateBuildSource).toEqual({ status: "REFUSED", reason: `the worker could not export a build source manifest: ${reason}`, candidateDigest: repo.source.candidate.digest });
    expect(h.exportRecord()!.buildSource).toEqual(h.operation().candidateBuildSource);
    // A replay of the same refusal is accepted; a different answer is not.
    expect((await h.send("candidate-build-source", { stage: "unavailable", schemaVersion: "workflow-candidate-build-source-unavailable/v1", reason })).body).toMatchObject({ duplicate: true });
    expect((await h.send("candidate-build-source", { stage: "unavailable", schemaVersion: "workflow-candidate-build-source-unavailable/v1", reason: "something else" })).status).toBe(409);
  });

  it("needs a finalized candidate source export first, and only the running implementation may report", async () => {
    const h = harness();
    const early = await h.send("candidate-build-source", { stage: "unavailable", schemaVersion: "workflow-candidate-build-source-unavailable/v1", reason: "too early" });
    expect(early.status).toBe(409);
    expect(h.operation().candidateBuildSource).toBeUndefined();
    const repo = await candidateRepository({ "package.json": "{}" });
    await h.sinks.candidateSourceExportSink(repo.source);
    h.putOperation({ workflowMode: "CHECKS", candidateSourceRef: h.operation().candidateSourceRef });
    expect((await h.send("candidate-build-source", { stage: "unavailable", schemaVersion: "workflow-candidate-build-source-unavailable/v1", reason: "wrong operation" })).status).toBe(409);
    h.putOperation({ status: "SUCCEEDED", candidateSourceRef: h.operation().candidateSourceRef });
    expect((await h.send("candidate-build-source", { stage: "unavailable", schemaVersion: "workflow-candidate-build-source-unavailable/v1", reason: "finished" })).status).toBe(409);
  });
});

describe("the worker never lets the build source decide the portable export", () => {
  const exportOf = (repo: Awaited<ReturnType<typeof candidateRepository>>): CommittedCandidateSourceExport => repo.source;
  const invocation = { kind: "task", payload: { workflowMode: "IMPLEMENT" } } as never;

  it("uploads the export, then the build source, then a terminal result that carries neither", async () => {
    const repo = await candidateRepository({ "package.json": "{}" });
    const order: string[] = [];
    const terminal = vi.fn(async () => { order.push("terminal"); });
    await postWorkerTerminalResult({ candidateSourceExportSink: async () => { order.push("export"); }, candidateBuildSourceSink: async () => { order.push("build-source"); }, terminalSink: terminal },
      { operationId: "op", status: "SUCCEEDED", result: { conversationId: "c", workflowCandidateSourceExport: exportOf(repo), workflowCandidateBuildSource: repo.buildSource } } as never, invocation);
    expect(order).toEqual(["export", "build-source", "terminal"]);
    expect(terminal).toHaveBeenCalledWith({ operationId: "op", status: "SUCCEEDED", result: { conversationId: "c" } });
  });

  it("still exports and finishes when the build source cannot be delivered or was never computed", async () => {
    const repo = await candidateRepository({ "package.json": "{}" });
    const terminal = vi.fn(async () => undefined);
    const exportSink = vi.fn(async () => undefined);
    await postWorkerTerminalResult({ candidateSourceExportSink: exportSink, candidateBuildSourceSink: async () => { throw new Error("broker unreachable"); }, terminalSink: terminal },
      { operationId: "op", status: "SUCCEEDED", result: { conversationId: "c", workflowCandidateSourceExport: exportOf(repo), workflowCandidateBuildSource: repo.buildSource } } as never, invocation);
    expect(exportSink).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith({ operationId: "op", status: "SUCCEEDED", result: { conversationId: "c" } });

    const sink = vi.fn(async () => undefined);
    const terminalWithout = vi.fn(async () => undefined);
    await postWorkerTerminalResult({ candidateSourceExportSink: async () => undefined, candidateBuildSourceSink: sink, terminalSink: terminalWithout },
      { operationId: "op", status: "SUCCEEDED", result: { conversationId: "c", workflowCandidateSourceExport: exportOf(repo) } } as never, invocation);
    expect(sink).not.toHaveBeenCalled();
    expect(terminalWithout).toHaveBeenCalledWith({ operationId: "op", status: "SUCCEEDED", result: { conversationId: "c" } });
  });

  it("leaves a result with no source export exactly as it was", async () => {
    const terminal = vi.fn(async () => undefined);
    const result = { operationId: "op", status: "SUCCEEDED", result: { conversationId: "c", checks: [] } } as never;
    await postWorkerTerminalResult({ candidateSourceExportSink: async () => { throw new Error("must not export"); }, terminalSink: terminal }, result, invocation);
    expect(terminal).toHaveBeenCalledWith(result);
  });

  it("sends the same export request bytes as before: the build source adds requests, it changes none", async () => {
    const repo = await candidateRepository({ "package.json": "{\"name\":\"app\"}", "src/a.js": "a" });
    const h = harness();
    await h.sinks.candidateSourceExportSink(repo.source);
    const exportRequests = h.requests.filter(({ path }) => path === "candidate-export");
    expect(exportRequests.map(({ status }) => status)).toEqual(exportRequests.map(() => 200));
    const exportBytes = Buffer.from(JSON.stringify(repo.source), "utf8");
    expect(h.exportRecord()).toMatchObject({ sha256: sha256(exportBytes), totalBytes: exportBytes.byteLength, status: "COMPLETE" });
    expect(Object.keys(h.exportRecord()!).sort()).toEqual(["chunkCount", "createdAt", "entityType", "fence", "nextChunkIndex", "operationId", "pk", "schemaVersion", "sha256", "sk", "sourceRef",
      "status", "totalBytes", "uploadId", "workspaceId"]);
    expect(canonicalJson(h.operation().candidateSourceRef)).toBe(canonicalJson({ key: `workflow-candidate-sources/sha256/${sha256(exportBytes)}.json`, sha256: sha256(exportBytes),
      byteLength: exportBytes.byteLength, candidateDigest: repo.source.candidate.digest }));
  });
});
