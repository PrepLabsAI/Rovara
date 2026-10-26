import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";
import { exportBaselineSource, type BaselineSourceExport } from "../../packages/worker/src/baseline-source-export.js";
import { postWorkerTerminalResult } from "../../packages/worker/src/terminal-callback.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

// T7b PLANGROUNDING: a planning run that was asked for the unchanged code (to try the plan's must-not-change scenarios on the current app) uploads it on its own callback capability, under its
// own operation, with the same judgement as a coding run's export. It never touches a coding run's baseline source, and a failure of the export is stored as one fixed sentence.

beforeAll(async () => { await loadSlackBroker(); });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

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
    kind: "task", workflowMode: "PLAN", groundingSourceAsked: true, status: "RUNNING", fence: 1, eventSequence: 0, requestId: randomUUID(), payloadHash: "a".repeat(64), createdAt: new Date().toISOString(), ...patch });
  putOperation();
  const issue = (allowCandidateExport: boolean, allowGroundingSource = false) => issueCapability({ callbackSigningKey: "c".repeat(64) }, workspaceId, operationId, 1, false, false, false, false, allowCandidateExport, false, false, allowGroundingSource);
  let capability = issue(false, true);
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


describe("a planning run asked for the unchanged code may upload it, and nothing else of a coding run's", () => {
  it("stores the export and its build source on the PLAN operation through the worker's own callbacks, judged against the base it exports", async () => {
    const repo = await repository();
    const built = readyOf(await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal }));
    const h = harness();
    await h.sinks.baselineSourceSink(built);
    const stored = h.operation().baselineSource as Record<string, unknown>;
    expect(stored).toMatchObject({ status: "READY", repositoryId: "fixture/app", baseCommitSha: repo.base.commitSha, baseTreeSha: repo.base.treeSha });
    const exportBytes = Buffer.from(JSON.stringify(built.source), "utf8");
    expect(h.objects.get((stored.sourceRef as { key: string }).key)?.equals(exportBytes)).toBe(true);
    expect(h.operation().candidateSourceRef).toBeUndefined();
  });

  it("refuses the upload from a planning run that was not asked, and from one whose capability does not carry it", async () => {
    const repo = await repository();
    const built = readyOf(await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal }));
    const notAsked = harness();
    notAsked.putOperation({ groundingSourceAsked: undefined });
    await expect(notAsked.sinks.baselineSourceSink(built)).rejects.toThrow();
    expect(notAsked.operation().baselineSource).toBeUndefined();
    const noGrant = harness();
    noGrant.setCapability(noGrant.issue(false, false));
    expect((await noGrant.send("baseline-source", { stage: "unavailable", schemaVersion: "workflow-baseline-source-unavailable/v1", reason: "x" })).status).toBe(409);
    expect(noGrant.operation().baselineSource).toBeUndefined();
  });

  it("is limited to the running planning operation: not a finished one, not a CHECKS or REVIEW one that carries the flag", async () => {
    const repo = await repository();
    const built = readyOf(await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal }));
    const h = harness();
    for (const patch of [{ status: "SUCCEEDED" }, { workflowMode: "CHECKS" }, { workflowMode: "REVIEW" }, { workflowMode: "FEEDBACK_REVIEW" }]) {
      h.putOperation(patch);
      await expect(h.sinks.baselineSourceSink(built), JSON.stringify(patch)).rejects.toThrow();
      expect(h.operation().baselineSource, JSON.stringify(patch)).toBeUndefined();
    }
  });

  it("grants a planning run the baseline-source action only: the candidate's export and build source stay the coding run's", async () => {
    const h = harness();
    for (const path of ["candidate-export", "candidate-build-source"]) {
      const denied = await h.send(path, { stage: "init" });
      expect(denied.status, path).toBe(409);
    }
    expect((await h.send("baseline-source", { stage: "unavailable", schemaVersion: "workflow-baseline-source-unavailable/v1", reason: "x" })).status).toBe(200);
    // The coding run's own capability is unchanged: it still carries all three.
    const coding = JSON.parse(Buffer.from(h.issue(true).split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] };
    expect(coding.actions).toEqual(expect.arrayContaining(["candidate-export", "candidate-build-source", "baseline-source"]));
    const planning = JSON.parse(Buffer.from(h.issue(false, true).split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] };
    expect(planning.actions).toContain("baseline-source");
    expect(planning.actions).not.toContain("candidate-export");
    expect(planning.actions).not.toContain("candidate-build-source");
    const neither = JSON.parse(Buffer.from(h.issue(false, false).split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] };
    expect(neither.actions).not.toContain("baseline-source");
  });

  it("never overwrites a coding run's baseline source: the upload lands on the planning operation's own row only", async () => {
    const repo = await repository();
    const built = readyOf(await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal }));
    const h = harness();
    const codingId = randomUUID();
    const coding = { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${codingId}`, entityType: "OPERATION", id: codingId, workspaceId, kind: "task", workflowMode: "IMPLEMENT", status: "SUCCEEDED", fence: 1,
      eventSequence: 0, requestId: randomUUID(), payloadHash: "a".repeat(64), createdAt: new Date().toISOString(), baselineSource: { status: "REFUSED", reason: "the coding run's own" } };
    h.db.set(coding);
    await h.sinks.baselineSourceSink(built);
    expect(h.db.get(coding.pk, coding.sk)).toEqual(coding);
    expect(h.operation().baselineSource).toMatchObject({ status: "READY" });
    // A second, different report from the same planning run is refused, as for a coding run.
    const again = await h.send("baseline-source", { stage: "unavailable", schemaVersion: "workflow-baseline-source-unavailable/v1", reason: "other" });
    expect(again.status).toBe(409);
  });

  it("stores a failed export as one fixed sentence, never the worker's own text (a git message can name a path); a coding run's report is kept as it was", async () => {
    const message = "fatal: unable to read /home/ci/workspaces/abc/secret-repo/.git/objects/ab/cdef: Permission denied";
    const planning = harness();
    await planning.sinks.baselineSourceSink({ schemaVersion: "workflow-baseline-source/v1", status: "UNAVAILABLE", reason: `the unchanged code could not be exported: ${message}` } as never);
    const stored = planning.operation().baselineSource as { status: string; reason: string };
    expect(stored.status).toBe("REFUSED");
    expect(stored.reason).toBe("the worker could not export the unchanged code for the plan");
    expect(JSON.stringify(planning.operation())).not.toContain("secret-repo");
    // Control: the report really carried the text, and a coding run still stores it (its record is the existing behaviour, untouched).
    const coding = harness();
    coding.putOperation({ workflowMode: "IMPLEMENT", groundingSourceAsked: undefined });
    coding.setCapability(coding.issue(true));
    await coding.sinks.baselineSourceSink({ schemaVersion: "workflow-baseline-source/v1", status: "UNAVAILABLE", reason: `the unchanged code could not be exported: ${message}` } as never);
    expect(String((coding.operation().baselineSource as { reason: string }).reason)).toContain("secret-repo");
  });

  it("stores a refused build source of a planning run as one fixed sentence, never the validator's own text (it can name manifest paths); a coding run keeps its reason (control)", async () => {
    const repo = await repository();
    const built = readyOf(await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal }));
    const manifest = (built.buildSource as unknown as { manifest: Record<string, unknown> }).manifest;
    const tampered = { ...built, buildSource: { ...built.buildSource, manifest: { ...manifest, schemaVersion: "src/secret-dir/not-a-manifest" } } } as never;
    const planning = harness();
    await planning.sinks.baselineSourceSink(tampered);
    expect(planning.operation().baselineSource).toEqual({ status: "REFUSED", reason: "the unchanged code's build source was refused for the plan" });
    const coding = harness();
    coding.putOperation({ workflowMode: "IMPLEMENT", groundingSourceAsked: undefined });
    coding.setCapability(coding.issue(true));
    await coding.sinks.baselineSourceSink(tampered);
    const kept = coding.operation().baselineSource as { status: string; reason: string };
    expect(kept.status).toBe("REFUSED");
    expect(kept.reason).not.toBe("the unchanged code's build source was refused for the plan");
  });

  it("says only a fixed word when the export of a planning run is malformed", async () => {
    const repo = await repository();
    const built = readyOf(await exportBaselineSource({ repositories: inputsOf(repo), signal: new AbortController().signal }));
    const h = harness();
    const forged = { ...built, source: { ...built.source, repositories: [{ ...built.source.repositories[0]!, baseCommitSha: repo.base.commitSha }] } };
    const error = await h.sinks.baselineSourceSink(forged as never).catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(h.operation().baselineSource).toBeUndefined();
  });
});

describe("the worker logs only a fixed class when it cannot deliver a planning run's export", () => {
  const planInvocation = { kind: "task", payload: { workflowMode: "PLAN", workflowE2EGroundingSource: true } } as never;
  const report = { operationId: "op", status: "SUCCEEDED", result: { conversationId: "c", workflowBaselineSource: { status: "UNAVAILABLE", reason: "x" } } } as never;

  it("logs an AgentX error code as it is, and anything else (a code a library set, with a path in it) as UNKNOWN", async () => {
    const log = vi.fn();
    const failing = (error: Error) => async () => { throw error; };
    await postWorkerTerminalResult({ candidateSourceExportSink: async () => undefined, baselineSourceSink: failing(Object.assign(new Error("callback failed"), { code: "RUNTIME_UNAVAILABLE" })), terminalSink: async () => undefined }, report, planInvocation, log);
    await postWorkerTerminalResult({ candidateSourceExportSink: async () => undefined, baselineSourceSink: failing(Object.assign(new Error("boom"), { code: "ENOENT: /home/ci/workspaces/abc/secret" })), terminalSink: async () => undefined }, report, planInvocation, log);
    await postWorkerTerminalResult({ candidateSourceExportSink: async () => undefined, baselineSourceSink: failing(new Error("no code at all")), terminalSink: async () => undefined }, report, planInvocation, log);
    const lines = log.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(lines.map((line) => line.errorCode)).toEqual(["RUNTIME_UNAVAILABLE", "UNKNOWN", "UNKNOWN"]);
    expect(JSON.stringify(lines)).not.toContain("secret");
    expect(lines.every((line) => line.event === "grounding-source.delivery_failed" && line.errorMessage === undefined)).toBe(true);
  });
});
