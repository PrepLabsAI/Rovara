import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { E2ESourceSnapshot } from "@agentx/contracts";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { validateE2EApplicationBuildSourceManifest } from "../../packages/verifier/src/application-build-source.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";
import { exportBaselineSource, type BaselineSourceExport } from "../../packages/worker/src/baseline-source-export.js";
import { postWorkerTerminalResult } from "../../packages/worker/src/terminal-callback.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

// M1.3 Task 3.7b: running the baseline round needs the unchanged code's source and build source manifest. The worker exports them at the end of the coding run, from the task's
// recorded base commit, through the same safe git path as the candidate's export; the broker judges them against the base it pinned and keeps them on the coding operation.

beforeAll(async () => { await loadSlackBroker(); });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const workspaceId = randomUUID();
const CONTROL_PLANE = "https://control.example.test";

/** A repository whose first commit is the task's base and whose second is the coding run's candidate. */
async function repository() {
  const root = await temp("baseline-source-repo-");
  git(root, "init", "-q");
  const write = async (tree: Record<string, string>) => { for (const [path, content] of Object.entries(tree)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); } };
  await write({ "package.json": "{\"name\":\"app\"}", "src/server.js": "console.log('before')\n", ".env": "SECRET=1\n" });
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "base");
  const base = { commitSha: git(root, "rev-parse", "HEAD"), treeSha: git(root, "rev-parse", "HEAD^{tree}") };
  await write({ "src/server.js": "console.log('after')\n", "src/new-feature.js": "export const added = true;\n" });
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "candidate");
  return { root, base, candidate: { commitSha: git(root, "rev-parse", "HEAD"), treeSha: git(root, "rev-parse", "HEAD^{tree}") } };
}
const inputsOf = (repo: Awaited<ReturnType<typeof repository>>) => [{ repositoryId: "fixture/app", directory: repo.root, baseCommitSha: repo.base.commitSha }];
const readyOf = (built: BaselineSourceExport) => { if (built.status !== "READY") throw new Error(built.reason); return built; };

describe("the worker exports the unchanged code from the task's recorded base commit", () => {
  it("exports the base commit's tree and sources, not the candidate's, with a build source manifest that validates against it", async () => {
    const repo = await repository();
    const built = readyOf(await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal }));
    const [exported] = built.source.repositories;
    expect(exported).toMatchObject({ repositoryId: "fixture/app", commitSha: repo.base.commitSha, treeSha: repo.base.treeSha });
    expect(exported!.baseCommitSha).toBeUndefined();
    expect(built.source.candidate.repositories).toEqual([{ repositoryId: "fixture/app", commitSha: repo.base.commitSha, treeSha: repo.base.treeSha }]);
    expect(exported!.treePaths).toContain("src/server.js");
    expect(exported!.treePaths).not.toContain("src/new-feature.js");
    expect(Buffer.from(exported!.sources.find((item) => item.path === "src/server.js")!.bytesBase64, "base64").toString("utf8")).toBe("console.log('before')\n");
    // A credential-like path is in the inventory but its bytes never travel.
    expect(exported!.treePaths).toContain(".env");
    expect(exported!.sources.map((item) => item.path)).not.toContain(".env");
    expect(built.buildSource.status).toBe("READY");
    const manifest = (built.buildSource as { manifest: Parameters<typeof validateE2EApplicationBuildSourceManifest>[0]["manifest"] }).manifest;
    expect(manifest.candidateDigest).toBe(built.source.candidate.digest);
    expect(manifest.repository).toMatchObject({ commitSha: repo.base.commitSha, treeSha: repo.base.treeSha });
    const snapshot: E2ESourceSnapshot = { candidate: built.source.candidate, commitSha: exported!.commitSha, treeSha: exported!.treeSha, treeComplete: true, treePaths: exported!.treePaths,
      sources: exported!.sources.map((item) => ({ path: item.path, sha256: item.sha256, kind: "blob" as const, bytes: Buffer.from(item.bytesBase64, "base64") })) };
    expect(() => validateE2EApplicationBuildSourceManifest({ manifest, reference: { artifactId: "pending", sha256: manifest.archive.sha256, byteLength: manifest.archive.byteLength, manifestDigest: manifest.manifestDigest },
      expectedCandidate: built.source.candidate, inspectionSnapshot: snapshot })).not.toThrow();
  });

  it("does not touch the workspace: HEAD and the files stay as the coding run left them", async () => {
    const repo = await repository();
    await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal });
    expect(git(repo.root, "rev-parse", "HEAD")).toBe(repo.candidate.commitSha);
    expect(git(repo.root, "status", "--porcelain")).toBe("");
  });

  it("says it is unavailable, with the reason, when there is no recorded base, or the base is not in the repository", async () => {
    const repo = await repository();
    const noBase = await exportBaselineSource({ repositories: [{ repositoryId: "fixture/app", directory: repo.root }], signal: new AbortController().signal });
    expect(noBase).toMatchObject({ status: "UNAVAILABLE" });
    expect((noBase as { reason: string }).reason).toMatch(/base/i);
    const missing = await exportBaselineSource({ repositories: [{ ...inputsOf(repo)[0]!, baseCommitSha: "f".repeat(40) }], signal: new AbortController().signal });
    expect(missing).toMatchObject({ status: "UNAVAILABLE" });
    const many = await exportBaselineSource({ repositories: [...inputsOf(repo), { repositoryId: "fixture/other", directory: repo.root, baseCommitSha: repo.base.commitSha }], signal: new AbortController().signal });
    expect(many).toMatchObject({ status: "UNAVAILABLE" });
    expect((many as { reason: string }).reason).toMatch(/one repository/i);
  });

  it("stops with the operation when it is cancelled", async () => {
    const repo = await repository();
    const controller = new AbortController();
    controller.abort(new Error("operation cancelled"));
    await expect(exportBaselineSource({ repositories: inputsOf(repo), signal: controller.signal })).rejects.toThrow(/cancelled/);
  });
});

/** A broker over a fake table and bucket, a coding operation the worker may report on, and the worker's own callback client wired to the broker handler. */
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
  const issue = (allowCandidateExport: boolean) => issueCapability({ callbackSigningKey: "c".repeat(64) }, workspaceId, operationId, 1, false, false, false, false, allowCandidateExport);
  let capability = issue(true);
  const requests: Array<{ path: string; status: number; body: Record<string, unknown> }> = [];
  const send = async (path: string, body: unknown, token = capability) => {
    const response = await broker.handler({ version: "2.0", rawPath: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/${path}`, rawQueryString: "",
      headers: { "x-agentx-callback-capability": token, "content-type": "application/json" }, body: JSON.stringify(body),
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
  return { ...broker, objects, send, sinks, issue, operationId, operation, requests, putOperation, setCapability: (value: string) => { capability = value; } };
}

describe("the broker judges and keeps the exported baseline source", () => {
  it("stores the export and its build source on the coding operation, through the worker's own callbacks, judged against the base commit it exports", async () => {
    const repo = await repository();
    const built = readyOf(await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal }));
    const h = harness();
    await h.sinks.baselineSourceSink(built);
    const stored = h.operation().baselineSource as Record<string, unknown>;
    expect(stored).toMatchObject({ status: "READY", repositoryId: "fixture/app", baseCommitSha: repo.base.commitSha, baseTreeSha: repo.base.treeSha });
    const exportBytes = Buffer.from(JSON.stringify(built.source), "utf8");
    expect(stored.sourceRef).toEqual({ key: `workflow-candidate-sources/sha256/${sha256(exportBytes)}.json`, sha256: sha256(exportBytes), byteLength: exportBytes.byteLength, candidateDigest: built.source.candidate.digest });
    expect(h.objects.get((stored.sourceRef as { key: string }).key)?.equals(exportBytes)).toBe(true);
    expect(stored.buildSource).toMatchObject({ status: "READY", candidateDigest: built.source.candidate.digest, commitSha: repo.base.commitSha, treeSha: repo.base.treeSha });
    // The candidate's own records are untouched: this is not the candidate.
    expect(h.operation().candidateSourceRef).toBeUndefined();
    expect(h.operation().candidateBuildSource).toBeUndefined();
  });

  it("records an unavailable report with its reason, and a second different report is refused", async () => {
    const h = harness();
    await h.sinks.baselineSourceSink({ schemaVersion: "workflow-baseline-source/v1", status: "UNAVAILABLE", reason: "the task recorded no base commit" });
    expect(h.operation().baselineSource).toMatchObject({ status: "REFUSED" });
    expect(String((h.operation().baselineSource as { reason: string }).reason)).toContain("the task recorded no base commit");
    const again = await h.send("baseline-source", { stage: "unavailable", schemaVersion: "workflow-baseline-source-unavailable/v1", reason: "something else" });
    expect(again.status).toBe(409);
  });

  it("refuses a build source manifest that describes the candidate rather than the exported base", async () => {
    const repo = await repository();
    const built = readyOf(await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal }));
    const other = readyOf(await exportBaselineSource({ repositories: [{ repositoryId: "fixture/app", directory: repo.root, baseCommitSha: repo.base.commitSha }], signal: new AbortController().signal }));
    const candidateManifest = { ...(other.buildSource as { manifest: object }).manifest, repository: { repositoryId: "fixture/app", commitSha: repo.candidate.commitSha, treeSha: repo.candidate.treeSha } };
    const h = harness();
    await h.sinks.baselineSourceSink({ ...built, buildSource: { schemaVersion: "workflow-candidate-build-source/v1", status: "READY", manifest: candidateManifest as never } });
    expect(h.operation().baselineSource).toMatchObject({ status: "REFUSED" });
  });

  it("refuses an export that is not a base: one with a recorded base of its own, or a candidate digest that is not its repositories'", async () => {
    const repo = await repository();
    const built = readyOf(await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal }));
    const h = harness();
    const forged = { ...built, source: { ...built.source, repositories: [{ ...built.source.repositories[0]!, baseCommitSha: repo.base.commitSha }] } };
    await expect(h.sinks.baselineSourceSink(forged as never)).rejects.toThrow();
    expect(h.operation().baselineSource).toBeUndefined();
  });

  it("is limited to the running coding operation, on a capability that allows candidate export", async () => {
    const repo = await repository();
    const built = readyOf(await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal }));
    const h = harness();
    h.putOperation({ workflowMode: "CHECKS" });
    await expect(h.sinks.baselineSourceSink(built)).rejects.toThrow();
    h.putOperation({ status: "SUCCEEDED" });
    await expect(h.sinks.baselineSourceSink(built)).rejects.toThrow();
    h.putOperation();
    const denied = await h.send("baseline-source", { stage: "unavailable", schemaVersion: "workflow-baseline-source-unavailable/v1", reason: "x" }, h.issue(false));
    expect(denied.status).toBe(409);
    expect(h.operation().baselineSource).toBeUndefined();
  });
});

describe("the worker never lets the baseline source decide anything about the coding run", () => {
  const invocation = { kind: "task", payload: { workflowMode: "IMPLEMENT" } } as never;

  it("uploads the baseline source after the candidate's export, then a terminal result that carries neither", async () => {
    const repo = await repository();
    const built = readyOf(await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal }));
    const order: string[] = [];
    const terminal = vi.fn(async () => { order.push("terminal"); });
    await postWorkerTerminalResult({ candidateSourceExportSink: async () => { order.push("export"); }, baselineSourceSink: async () => { order.push("baseline-source"); }, terminalSink: terminal },
      { operationId: "op", status: "SUCCEEDED", result: { conversationId: "c", workflowCandidateSourceExport: built.source, workflowBaselineSource: built } } as never, invocation);
    expect(order).toEqual(["export", "baseline-source", "terminal"]);
    expect(terminal).toHaveBeenCalledWith({ operationId: "op", status: "SUCCEEDED", result: { conversationId: "c" } });
  });

  it("still finishes the run when the baseline source cannot be delivered, and says so", async () => {
    const repo = await repository();
    const built = readyOf(await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal }));
    const terminal = vi.fn(async () => undefined);
    const log = vi.fn();
    await postWorkerTerminalResult({ candidateSourceExportSink: async () => undefined, baselineSourceSink: async () => { throw new Error("broker unreachable"); }, terminalSink: terminal },
      { operationId: "op", status: "SUCCEEDED", result: { conversationId: "c", workflowCandidateSourceExport: built.source, workflowBaselineSource: built } } as never, invocation, log);
    expect(terminal).toHaveBeenCalledWith({ operationId: "op", status: "SUCCEEDED", result: { conversationId: "c" } });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "baseline-source.delivery_failed", operationId: "op", errorMessage: "broker unreachable" }));
  });

  it("sends nothing for a run that was not asked for it, or whose candidate did not export", async () => {
    const sink = vi.fn(async () => undefined);
    const terminal = vi.fn(async () => undefined);
    await postWorkerTerminalResult({ candidateSourceExportSink: async () => undefined, baselineSourceSink: sink, terminalSink: terminal },
      { operationId: "op", status: "SUCCEEDED", result: { conversationId: "c", workflowCandidateSourceExport: { candidate: {} } } } as never, invocation);
    expect(sink).not.toHaveBeenCalled();
  });
});
