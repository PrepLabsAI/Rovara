// Lane L9-wire, slice 1: one running `rovara up` on SQLite, the registry, the review pages and the owner's routes, driven against a fake worker. A task is registered and started over HTTP;
// the fake worker answers the preparation, Understand and Plan through the REAL callback listener and the capability the flow issued; the plan appears on the local page and the owner approves
// it there. Docker is simulated (the worker machines are the W0 fake), so nothing here needs Docker.
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPLICIT_COMPANY_ID, UNDERSTAND_ARTIFACT_NAME, type WorkerInvocation } from "@agentx/contracts";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { listSessions, sessionSnapshot } from "../../packages/broker/src/core/sessions/read.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { afterEach, describe, expect, it } from "vitest";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { startLocalRuntime, type LocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { formBody, formOf, raw } from "../support/local-pages-fakes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

const PROJECT = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
interface TaskJson { taskId: string; sessionId?: string; workflow: { stage: string; state: string; planContent?: string; decisions: Array<{ decision: string }> } }
interface ApiBody { task: TaskJson; tasks: TaskJson[]; url: string; projects: Array<{ name: string; latestRevision: number }>; error?: { code: string; message: string } }
interface CallbackBody { accepted?: number; error?: { code: string } }
const PLAN_TEXT = "# Plan\n\nAdd a /health endpoint that answers 200.\n";

async function launch(extra: { storage?: "sqlite" | "memory"; root?: string } = {}) {
  const root = extra.root ?? await mkdtemp(join(tmpdir(), "rovara-l9-"));
  if (extra.root === undefined) cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const machines = new FakeWorkerMachines({ startingChecks: 0, features: ["task.workflowMode"] });
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment: {}, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9", machines, timers: false, ...(extra.storage === undefined ? {} : { storage: extra.storage }),
  });
  cleanup.push(() => runtime.stop());
  const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${runtime.url}${path}`, {
      method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, body: (await response.json()) as ApiBody };
  };
  /** A worker's callback, through the callback listener exactly as the worker's gateway relays it. */
  const callback = (invocation: WorkerInvocation, action: string, body: unknown) => new Promise<{ status: number; body: CallbackBody }>((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = httpRequest({
      host: "127.0.0.1", port: runtime.callbackPort, method: "POST", setHost: false,
      path: `/v1/internal/workspaces/${invocation.workspaceId}/operations/${invocation.operationId}/${action}`,
      headers: { host: `host.docker.internal:${runtime.callbackPort}`, "content-type": "application/json", "content-length": Buffer.byteLength(text), "x-agentx-callback-capability": invocation.callbackCapability },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as CallbackBody }));
    });
    req.on("error", reject);
    req.end(text);
  });
  /** Runs the timers' work until the task's machine holds a job it was not given before, and answers with it. */
  const nextJob = async (workspaceId: string, seen: Set<string>): Promise<WorkerInvocation> => {
    const store = runtime.registry.require("storage");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await runtime.tick();
      const machineId = ((await store.get({ pk: `WORKSPACE#${workspaceId}`, sk: "META" }))?.["machine"] as { machineId?: string } | undefined)?.machineId;
      const fresh = machineId === undefined ? undefined : machines.delivered(machineId).find((job) => !seen.has(job.operationId));
      if (fresh !== undefined) { seen.add(fresh.operationId); return fresh; }
    }
    throw new Error("the flow did not hand a job to the worker");
  };
  return { root, stateDirectory, runtime, machines, token, api, callback, nextJob };
}

/** Registers the project, starts a task and answers its preparation, Understand and Plan, so it waits for the owner's approval. */
async function toPlanReview(h: Awaited<ReturnType<typeof launch>>, requestId = "11111111-1111-4111-8111-111111111111") {
  await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
  const started = await h.api("/v1/dev/tasks", { method: "POST", body: { requestId, project: "payments", instructions: "Add a /health endpoint", workflow: true } });
  const taskId = started.body.task.taskId;
  const workspaceId = (await h.runtime.registry.require("storage").get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
  const seen = new Set<string>();
  const prepare = await h.nextJob(workspaceId, seen);
  await h.callback(prepare, "result", { status: "SUCCEEDED", result: {} });
  const understand = await h.nextJob(workspaceId, seen);
  await h.callback(understand, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify({ kind: "ready", path: "QUICK", restatement: "Add a /health endpoint that answers 200.", assumptions: [] }) });
  await h.callback(understand, "result", { status: "SUCCEEDED" });
  const plan = await h.nextJob(workspaceId, seen);
  await h.callback(plan, "artifacts", { name: "plan.md", mediaType: "text/markdown", content: PLAN_TEXT });
  await h.callback(plan, "result", { status: "SUCCEEDED" });
  return { taskId, workspaceId, seen, prepare, understand, plan };
}

describe("rovara up: a task through Understand and Plan to the owner's approval, on SQLite, against a fake worker", () => {
  it("is wired: SQLite storage and queue, the owner's routes behind the login, the pages and the callback listener", async () => {
    const h = await launch();
    expect(h.runtime.wiring()).toMatchObject({ storage: ["sqlite"], queue: ["sqlite"] });
    expect((await fetch(`${h.runtime.url}/v1/auth/.well-known/agentx-configuration`)).status).toBe(200);
    expect((await fetch(`${h.runtime.url}/v1/dev/tasks`)).status).toBe(401);
    expect((await h.api("/v1/dev/tasks")).body).toMatchObject({ tasks: [] });
    // The pages answer a request with no session token exactly like a path that does not exist.
    expect((await raw(h.runtime.pagesUrl, { path: "/", headers: { host: new URL(h.runtime.pagesUrl).host } })).status).toBe(404);
  });

  it("runs a task from the request to an approved plan", async () => {
    const h = await launch();
    expect((await h.api("/v1/admin/projects", { method: "POST", body: PROJECT })).status).toBe(201);
    expect((await h.api("/v1/dev/projects")).body).toMatchObject({ projects: [{ name: "payments", latestRevision: 1 }] });

    const requestId = "11111111-1111-4111-8111-111111111111";
    const started = await h.api("/v1/dev/tasks", { method: "POST", body: { requestId, project: "payments", instructions: "Add a /health endpoint", workflow: true } });
    expect(started.status).toBe(201);
    const task = started.body.task;
    expect(task.workflow).toMatchObject({ stage: "UNDERSTAND", state: "READY" });
    expect(task.sessionId).toMatch(/^ses_/);
    // A repeat of the same request is the same task.
    const again = await h.api("/v1/dev/tasks", { method: "POST", body: { requestId, project: "payments", instructions: "Add a /health endpoint", workflow: true } });
    expect(again.status).toBe(200);
    expect(again.body.task.taskId).toBe(task.taskId);

    const store = h.runtime.registry.require("storage");
    const workspaceId = (await store.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" }))!["workspaceId"] as string;
    const seen = new Set<string>();

    // 1. The preparation. A callback with a capability for another operation is refused; the right one is accepted.
    const prepare = await h.nextJob(workspaceId, seen);
    expect(prepare.kind).toBe("prepare");
    expect((await h.callback({ ...prepare, callbackCapability: "x.y" }, "result", { status: "SUCCEEDED" })).body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect((await h.callback(prepare, "result", { status: "SUCCEEDED", result: {} })).status).toBe(200);

    // 2. Understand: the worker saves its assessment as a file and ends the job.
    const understand = await h.nextJob(workspaceId, seen);
    expect(understand).toMatchObject({ kind: "task", payload: { workflowMode: "UNDERSTAND" } });
    const assessment = { kind: "ready", path: "QUICK", restatement: "Add a /health endpoint that answers 200.", assumptions: [] };
    expect((await h.callback(understand, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify(assessment) })).status).toBe(200);
    expect((await h.callback(understand, "events", { events: [{ type: "progress", timestamp: new Date().toISOString(), payload: { message: "reading" } }] })).body).toMatchObject({ accepted: 1 });
    expect((await h.callback(understand, "result", { status: "SUCCEEDED" })).status).toBe(200);

    // 3. Plan.
    const plan = await h.nextJob(workspaceId, seen);
    expect(plan).toMatchObject({ kind: "task", payload: { workflowMode: "PLAN" } });
    expect((plan.payload as { prompt: string }).prompt).toContain("Add a /health endpoint that answers 200.");
    await h.callback(plan, "artifacts", { name: "plan.md", mediaType: "text/markdown", content: PLAN_TEXT });
    expect((await h.callback(plan, "result", { status: "SUCCEEDED" })).status).toBe(200);
    const waiting = (await h.api(`/v1/dev/tasks/${task.taskId}`)).body.task;
    expect(waiting.workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", planContent: PLAN_TEXT });

    // The session was created with the task and kept current by the flow; it says the plan waits.
    await h.runtime.tick();
    const owner = localOwnerPrincipal();
    const listed = await listSessions(store, IMPLICIT_COMPANY_ID, developerIdOf(owner));
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({ sessionId: task.sessionId, subject: { kind: "task", taskId: task.taskId } });
    expect(sessionSnapshot(listed.sessions[0]!)).toMatchObject({ needsYou: true, step: "Waiting for your approval" });

    // An assistant (the session token) cannot approve; the answer says where to.
    const refused = await h.api(`/v1/dev/tasks/${task.taskId}/workflow/decision`, { method: "POST", body: { requestId: "22222222-2222-4222-8222-222222222222", decision: "APPROVE" } });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("rovara open");

    // 4. The owner opens the page from their terminal and approves there.
    const link = (await h.api("/v1/local/pages/link", { method: "POST", body: { path: `/plan/${task.taskId}` } })).body.url;
    const pages = new URL(link);
    const host = pages.host;
    const page = await raw(h.runtime.pagesUrl, { path: pages.pathname, headers: { host } });
    expect(page.status).toBe(200);
    expect(page.body).toContain("Add a /health endpoint that answers 200.");
    const form = formOf(page.body, "/decide");
    const post = await raw(h.runtime.pagesUrl, { method: "POST", path: form.action, body: formBody({ ...form.fields, decision: "approve" }), headers: { host, origin: h.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
    expect(post.status).toBe(303);
    expect(post.headers["location"]).toContain("n=approved");
    const approved = (await h.api(`/v1/dev/tasks/${task.taskId}`)).body.task;
    expect(approved.workflow.stage).toBe("IMPLEMENT");
    expect(approved.workflow.decisions.at(-1)).toMatchObject({ decision: "APPROVE" });
  });

  it("sends a plan back with the owner's words, and the next plan is asked for with them", async () => {
    const h = await launch();
    const { taskId, workspaceId, seen } = await toPlanReview(h);
    const link = new URL((await h.api("/v1/local/pages/link", { method: "POST", body: { path: `/plan/${taskId}` } })).body.url);
    const page = await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } });
    const form = formOf(page.body, "/decide");
    const sent = await raw(h.runtime.pagesUrl, { method: "POST", path: form.action, body: formBody({ ...form.fields, decision: "changes", note: "Also log the request id." }), headers: { host: link.host, origin: h.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
    expect(sent.headers["location"]).toContain("n=changes");
    const again = await h.nextJob(workspaceId, seen);
    expect(again).toMatchObject({ kind: "task", payload: { workflowMode: "PLAN" } });
    expect((again.payload as { prompt: string }).prompt).toContain("Also log the request id.");
  });

  it("blocks a task whose step failed, and runs the step again on Retry", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const started = await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: "33333333-3333-4333-8333-333333333333", project: "payments", instructions: "Add a /health endpoint", workflow: true } });
    const taskId = started.body.task.taskId;
    const workspaceId = (await h.runtime.registry.require("storage").get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
    const seen = new Set<string>();
    await h.callback(await h.nextJob(workspaceId, seen), "result", { status: "SUCCEEDED", result: {} });
    const understand = await h.nextJob(workspaceId, seen);
    await h.callback(understand, "result", { status: "FAILED", error: "the model did not answer" });
    const blocked = (await h.api(`/v1/dev/tasks/${taskId}`)).body.task;
    expect(blocked.workflow).toMatchObject({ stage: "UNDERSTAND", state: "BLOCKED" });
    expect((await h.api(`/v1/dev/tasks/${taskId}/workflow/retry`, { method: "POST", body: { requestId: "44444444-4444-4444-8444-444444444444" } })).status).toBe(200);
    const retried = await h.nextJob(workspaceId, seen);
    expect(retried).toMatchObject({ payload: { workflowMode: "UNDERSTAND" } });
    expect(retried.operationId).not.toBe(understand.operationId);
  });

  it("keeps the task across a restart, and a worker that outlived it still reports to the new process", async () => {
    const first = await launch();
    await first.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const started = await first.api("/v1/dev/tasks", { method: "POST", body: { requestId: "55555555-5555-4555-8555-555555555555", project: "payments", instructions: "Add a /health endpoint", workflow: true } });
    const taskId = started.body.task.taskId;
    const workspaceId = (await first.runtime.registry.require("storage").get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
    const prepare = await first.nextJob(workspaceId, new Set());
    await first.runtime.stop();
    const second = await launch({ root: first.root });
    expect((await second.api(`/v1/dev/tasks/${taskId}`)).body.task.taskId).toBe(taskId);
    expect((await second.api("/v1/dev/tasks")).body.tasks).toHaveLength(1);
    // The capability was signed with the key kept in the state folder.
    expect((await second.callback(prepare, "result", { status: "SUCCEEDED", result: {} })).status).toBe(200);
  });
});
