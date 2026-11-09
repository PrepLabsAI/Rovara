// Lane L9-wire, slice 1: one running `rovara up` on SQLite, the registry, the review pages and the owner's routes, driven against a fake worker. A task is registered and started over HTTP;
// the fake worker answers the preparation, Understand and Plan through the REAL callback listener and the capability the flow issued; the plan appears on the local page and the owner approves
// it there. Docker is simulated (the worker machines are the W0 fake), so nothing here needs Docker.
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeveloperProjectsResponseSchema, DeveloperTaskListResponseSchema, DeveloperTaskResponseSchema, IMPLICIT_COMPANY_ID, SessionListReaderSchema, SessionResponseReaderSchema, UNDERSTAND_ARTIFACT_NAME, WORKER_INVOCATION_FEATURES,
  createCandidateManifest, type WorkerInvocation,
} from "@agentx/contracts";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { listSessions, sessionSnapshot } from "../../packages/broker/src/core/sessions/read.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { MESSAGES_PER_HOUR, MESSAGE_NOT_PASSED_ON, MESSAGE_RATE_LIMITED } from "../../packages/broker/src/local/app/host.js";
import { registerOpenCommand } from "../../packages/cli/src/up/cli.js";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { readBranchWriters } from "../../packages/broker/src/core/branch-sync/branch-writers.js";
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
const BASE_COMMIT = "b".repeat(40);

async function launch(extra: { storage?: "sqlite" | "memory"; root?: string; host?: boolean } = {}) {
  const root = extra.root ?? await mkdtemp(join(tmpdir(), "rovara-l9-"));
  if (extra.root === undefined) cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const machines = new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] });
  // A fake code host that holds the repository (lane L10): the build step reads the pushed branch and opens the pull request through its port.
  const hostedUrl = "https://github.com/example/demo.git";
  const model = new FakeHostModel({ url: hostedUrl, id: "1", fullName: "example/demo" });
  // A project cannot yet name another code host at registration (51 gap: the project contract refuses `repositories[].host`), so a repository is on the code host registered as `github`; the
  // test's host is the fake one under that name.
  const project = extra.host === true ? { ...PROJECT, repositories: [{ ...PROJECT.repositories[0]!, url: hostedUrl }] } : PROJECT;
  const base = extra.host === true ? model.headOf("main") : BASE_COMMIT;
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment: {}, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9", machines, timers: false, ...(extra.storage === undefined ? {} : { storage: extra.storage }),
    ...(extra.host === true ? { registerAdapters: (registry) => registry.register("code-host", "github", Object.defineProperty(new FakeCodeHost(model), "kind", { value: "github" })) } : {}),
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
  return { root, stateDirectory, runtime, machines, token, api, callback, nextJob, model, project, base };
}

/** Registers the project, starts a task and answers its preparation, Understand and Plan, so it waits for the owner's approval. */
async function toPlanReview(h: Awaited<ReturnType<typeof launch>>, requestId = "11111111-1111-4111-8111-111111111111") {
  await h.api("/v1/admin/projects", { method: "POST", body: h.project });
  const started = await h.api("/v1/dev/tasks", { method: "POST", body: { requestId, project: "payments", instructions: "Add a /health endpoint", workflow: true } });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const taskId = started.body.task.taskId;
  const workspaceId = (await h.runtime.registry.require("storage").get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
  const seen = new Set<string>();
  const prepare = await h.nextJob(workspaceId, seen);
  await h.callback(prepare, "result", { status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: h.base }] } });
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

  it("answers the reads the MCP tools and the CLI make in the shapes they parse, and takes the owner's answers to Understand's questions", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const projects = DeveloperProjectsResponseSchema.safeParse((await h.api("/v1/dev/projects")).body);
    expect(projects.success, JSON.stringify(projects.success ? {} : projects.error.issues.slice(0, 3))).toBe(true);
    const started = await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: "66666666-6666-4666-8666-666666666666", project: "payments", instructions: "Add a /health endpoint", workflow: true } });
    const taskId = started.body.task.taskId;
    expect(DeveloperTaskResponseSchema.safeParse(started.body).success).toBe(true);
    expect(DeveloperTaskListResponseSchema.safeParse((await h.api("/v1/dev/tasks")).body).success).toBe(true);
    const workspaceId = (await h.runtime.registry.require("storage").get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
    const seen = new Set<string>();
    await h.callback(await h.nextJob(workspaceId, seen), "result", { status: "SUCCEEDED", result: {} });
    const understand = await h.nextJob(workspaceId, seen);
    const questions = { kind: "questions", restatement: "Add a health endpoint.", questions: [{ id: "q1", text: "Which path?", options: [{ id: "a", label: "/health" }, { id: "b", label: "/healthz" }], recommended: "a" }] };
    await h.callback(understand, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify(questions) });
    await h.callback(understand, "result", { status: "SUCCEEDED" });
    const waiting = (await h.api(`/v1/dev/tasks/${taskId}`)).body.task;
    expect(waiting.workflow).toMatchObject({ stage: "UNDERSTAND", state: "WAITING" });
    await h.runtime.tick();

    const listed = await h.api("/v1/app/sessions");
    expect(SessionListReaderSchema.safeParse(listed.body).success).toBe(true);
    const sessionId = waiting.sessionId!;
    const read = await h.api(`/v1/app/sessions/${sessionId}`);
    const parsed = SessionResponseReaderSchema.safeParse(read.body);
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues.slice(0, 3))).toBe(true);

    // The owner answers; Understand runs again with the answers, and then Plan follows from its assessment.
    const answered = await h.api(`/v1/app/sessions/${sessionId}/answers`, { method: "POST", body: { requestId: "77777777-7777-4777-8777-777777777777", round: 1, answers: [{ questionId: "q1", optionId: "a" }] } });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const again = await h.nextJob(workspaceId, seen);
    expect(again).toMatchObject({ payload: { workflowMode: "UNDERSTAND" } });
    expect((await h.api(`/v1/dev/tasks/${taskId}`)).body.task.workflow).toMatchObject({ stage: "UNDERSTAND", state: "RUNNING" });

    // Stop: the running step ends, the task waits for Retry; a message to the agent is saved and says it was not passed on.
    const stopped = await h.api(`/v1/app/sessions/${sessionId}/stop`, { method: "POST", body: { requestId: "88888888-8888-4888-8888-888888888888" } });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect((await h.api(`/v1/dev/tasks/${taskId}`)).body.task.workflow).toMatchObject({ state: "BLOCKED" });
    const told = await h.api(`/v1/app/sessions/${sessionId}/messages`, { method: "POST", body: { requestId: "99999999-9999-4999-8999-999999999999", kind: "steer", text: "use /health" } });
    expect(told.status).toBe(200);
    expect(JSON.stringify(told.body)).toContain("not_delivered");
    expect((await h.api(`/v1/app/sessions/${sessionId}/messages`, { method: "POST", body: { requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "comment", text: "hello" } })).status).toBe(400);
    expect((await h.api("/v1/app/sessions/ses_00000000000000000000")).status).toBe(404);
  });

  it("`rovara open` prints the page address from the running process, and says so when nothing is running", async () => {
    const h = await launch();
    const { taskId } = await toPlanReview(h);
    const printed: string[] = [];
    const run = async (stateDir: string, ...args: string[]) => {
      const program = new Command().exitOverride().option("--json");
      registerOpenCommand(program, { home: h.root, fetch, stdout: { write: (text: string) => { printed.push(text); return true; } } });
      await program.parseAsync(["node", "rovara", "open", "--state-dir", stateDir, ...args]);
    };
    await run(h.stateDirectory, taskId);
    const link = new URL(printed.join("").trim());
    const page = await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } });
    expect(page.status).toBe(200);
    expect(page.body).toContain("Add a /health endpoint that answers 200.");
    await h.runtime.stop();
    await expect(run(h.stateDirectory, taskId)).rejects.toThrow(/not running/);
    await expect(run(h.stateDirectory, "not-a-task")).rejects.toThrow(/UUID/);
  });

  it("hands the job to the Docker adapter's worker (simulated Docker) with a token the real worker accepts, and its callbacks reach the flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "rovara-l9-docker-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const docker = new FakeDocker();
    docker.features = ["task.workflowMode"];
    // A key-shaped value is built at runtime (the public repository refuses one in a file).
    const githubToken = ["gh", "p_"].join("") + "a1".repeat(18);
    const runtime = await startLocalRuntime({ stateDirectory, cwd: join(root, "project"), environment: { GH_TOKEN: githubToken }, gh: async () => undefined, modelProxyEndpoint: { url: "http://model-proxy.examplehost:4321" }, workerImage: "worker:test", docker, workerFetch: docker.fetch, version: "9.9.9", timers: false });
    cleanup.push(() => runtime.stop());
    const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
    const call = async (path: string, body?: unknown) => (await fetch(`${runtime.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json() as Promise<ApiBody>;
    await call("/v1/admin/projects", PROJECT);
    const started = await call("/v1/dev/tasks", { requestId: "12121212-1212-4212-8212-121212121212", project: "payments", instructions: "Add a /health endpoint", workflow: true });
    for (let attempt = 0; attempt < 8 && docker.invocations.length === 0; attempt += 1) {
      await runtime.tick();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(docker.invocations[0]).toMatchObject({ kind: "prepare" });
    const worker = [...docker.containers.values()].find((container) => container.kind === "worker");
    expect(worker).toBeDefined();
    // TODO(L9a): the model proxy's address reaches the worker as the environment the worker reads; the proxy itself is lane K1's.
    expect(worker?.environment["AGENTX_MODEL_PROXY_URL"]).toBe("http://model-proxy.examplehost:4321");
    // The worker clones with the grant it was given: the exchange answers with the owner's token while the job is live, and never for a grant that names other repositories.
    const prepare = docker.invocations[0] as WorkerInvocation & { payload: { repositoryGrant: string } };
    const exchange = (body: unknown) => runtime.app.callbacks({
      method: "POST", path: `/v1/internal/workspaces/${prepare.workspaceId}/operations/${prepare.operationId}/repository-credentials`,
      headers: { "x-agentx-repository-grant": prepare.payload.repositoryGrant }, body: JSON.stringify(body),
    });
    const given = await exchange({ credentialRef: "host-app", repositoryUrl: PROJECT.repositories[0]!.url, access: "clone" });
    expect(given.statusCode).toBe(200);
    expect(JSON.parse(given.body)).toEqual({ credential: { token: githubToken } });
    expect((await exchange({ credentialRef: "host-app", repositoryUrl: PROJECT.repositories[0]!.url, access: "push" })).statusCode).toBe(403);
    expect((await exchange({ credentialRef: "host-app", repositoryUrl: "https://examplehost/example/other.git", access: "clone" })).statusCode).toBe(403);
    expect(started.task.workflow.stage).toBe("UNDERSTAND");
  });

  it("limits how often the owner can message a session in an hour, and says so", async () => {
    const h = await launch();
    const { taskId } = await toPlanReview(h);
    const sessionId = (await h.api(`/v1/dev/tasks/${taskId}`)).body.task.sessionId!;
    const send = async (index: number) => {
      const id = `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
      return (await h.api(`/v1/app/sessions/${sessionId}/messages`, { method: "POST", body: { requestId: id, kind: "steer", text: `note ${index}` } })).body as unknown as { delivery: { state: string; reason?: string } };
    };
    for (let index = 1; index <= MESSAGES_PER_HOUR; index += 1) expect((await send(index)).delivery.reason).toBe(MESSAGE_NOT_PASSED_ON);
    expect((await send(MESSAGES_PER_HOUR + 1)).delivery).toMatchObject({ state: "not_delivered", reason: MESSAGE_RATE_LIMITED });
    // A repeat of a request already answered is answered again, not counted.
    expect((await send(1)).delivery.reason).toBe(MESSAGE_NOT_PASSED_ON);
  });
});

// ---- Lane L10: the build step. A task runs on from the approved plan against a fake worker: coding, the checks, both reviews, Rovara's own sending back, and the pull request.
const COMMIT = "c".repeat(40);
const CHECK_REPORT = { status: "not_verified", notVerifiedReason: "no_checks", source: "none", preambleVersion: "1", preambleSha256: "a".repeat(64), checks: [], extraTry: "not_needed", agentClaim: "none" };
const candidateOf = (tree: string, base = BASE_COMMIT, commit = COMMIT) => [{ repositoryId: "demo", commitSha: commit, treeSha: tree, baseCommitSha: base }];

/** The owner approves the plan on the review page, as a person would. */
async function approvePlan(h: Awaited<ReturnType<typeof launch>>, taskId: string): Promise<void> {
  const link = new URL((await h.api("/v1/local/pages/link", { method: "POST", body: { path: `/plan/${taskId}` } })).body.url);
  const page = await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } });
  const form = formOf(page.body, "/decide");
  const post = await raw(h.runtime.pagesUrl, { method: "POST", path: form.action, body: formBody({ ...form.fields, decision: "approve" }), headers: { host: link.host, origin: h.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
  expect(post.headers["location"]).toContain("n=approved");
}

/** A task through its approved plan, with the fake worker waiting for the coding run. */
async function toCoding(h: Awaited<ReturnType<typeof launch>>, requestId?: string) {
  const planned = await toPlanReview(h, requestId);
  await approvePlan(h, planned.taskId);
  const coding = await h.nextJob(planned.workspaceId, planned.seen);
  return { ...planned, coding };
}

const builtResult = (tree: string, base = BASE_COMMIT, commit = COMMIT) => ({ status: "SUCCEEDED", result: { conversationId: "conversation", checks: CHECK_REPORT, workflowCandidateRepositories: candidateOf(tree, base, commit), workflowCheckCandidateRepositories: candidateOf(tree, base, commit) } });

function reviewsOf(job: WorkerInvocation, tree: string, verdict: "pass" | "findings", base = BASE_COMMIT, commit = COMMIT) {
  const candidateDigest = createCandidateManifest(candidateOf(tree, base, commit)).digest;
  const report = (role: "CRITIC" | "SECURITY") => ({
    operationId: job.operationId, candidateDigest, role, provider: "examplehost-model", version: "1", readOnly: true, recordedAt: new Date().toISOString(),
    status: verdict === "pass" || role === "SECURITY" ? "PASS" : "FINDINGS",
    findings: verdict === "pass" || role === "SECURITY" ? [] : [{ text: "The endpoint answers 500 when the store is down.", origin: "INTRODUCED", severity: "HIGH", file: "src/health.ts", line: 4 }],
    ...(role === "CRITIC" ? { risk: "low" } : {}),
  });
  return { status: "SUCCEEDED", result: { conversationId: "conversation", workflowCandidateRepositories: candidateOf(tree, base, commit), workflowReviews: [report("CRITIC"), report("SECURITY")] } };
}

const taskRecord = async (h: Awaited<ReturnType<typeof launch>>, taskId: string) =>
  (await h.runtime.registry.require("storage").get({ pk: `DEVTASK#${taskId}`, sk: "META" })) as unknown as { workflow: { stage: string; state: string; revision: number; blockReason?: string; reviewBase?: unknown[]; verification?: { reviewOnly?: boolean }; decisions: Array<{ source?: string; actorRole?: string }> }; autofixAsk?: { reason: string } };

describe("rovara up: from the approved plan to the checked code and its reviews, against a fake worker", () => {
  it("builds the approved plan, records the checked code, runs both reviews and makes the pull request due", async () => {
    const h = await launch();
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    // The coding run is told the approved plan, that it publishes nothing, and where the task started; its checks are the plan's selected ones (none here).
    expect(coding).toMatchObject({ kind: "task", payload: { workflowMode: "IMPLEMENT", readiness: [], workflowBase: [{ repositoryId: "demo", baseCommitSha: BASE_COMMIT }] } });
    const prompt = (coding.payload as { prompt: string }).prompt;
    expect(prompt).toContain("Add a /health endpoint that answers 200.");
    expect(prompt).toContain("Do not push branches or create pull requests");
    expect((await taskRecord(h, taskId)).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });

    // The uploads a coding run makes besides its result are answered (they feed only the browser and API checks, which Code does not run yet).
    const init = await h.callback(coding, "candidate-export", { stage: "init", schemaVersion: "workflow-candidate-export-upload/v1", totalBytes: 10, chunkCount: 1, sha256: "e".repeat(64) });
    expect(init.status).toBe(200);
    expect((await h.callback(coding, "candidate-export", { stage: "init", totalBytes: 0, chunkCount: 0, sha256: "e".repeat(64) })).status).toBe(400);

    expect((await h.callback(coding, "result", builtResult("d".repeat(40)))).status).toBe(200);
    // The checks passed on exactly this code (a review-only task has none to run), so the reviews start by themselves.
    const review = await h.nextJob(workspaceId, seen);
    expect(review).toMatchObject({ kind: "task", payload: { workflowMode: "REVIEW", workflowReviewRisk: true } });
    expect((review.payload as { workflowReviewPlan?: { markdown: string } }).workflowReviewPlan?.markdown).toContain("/health");
    const verified = await taskRecord(h, taskId);
    expect(verified.workflow).toMatchObject({ stage: "REVIEW", state: "RUNNING", reviewBase: [{ repositoryId: "demo", baseCommitSha: BASE_COMMIT }], verification: { reviewOnly: true } });

    // A review that names another run's id is not this run's: the step blocks instead of believing it.
    const wrong = reviewsOf({ ...review, operationId: "00000000-0000-4000-8000-000000000000" }, "d".repeat(40), "pass");
    expect((await h.callback(review, "result", wrong)).status).toBe(200);
    expect((await taskRecord(h, taskId)).workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
  });

  it("makes the pull request due once both reviews pass on the checked code", async () => {
    const h = await launch();
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    await h.callback(coding, "result", builtResult("d".repeat(40)));
    const review = await h.nextJob(workspaceId, seen);
    expect((await h.callback(review, "result", reviewsOf(review, "d".repeat(40), "pass"))).status).toBe(200);
    const after = await taskRecord(h, taskId);
    expect(after.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    const rows = await h.runtime.registry.require("storage").query({ pk: `ORG#${IMPLICIT_COMPANY_ID}#WORKFLOW_DISPATCH`, sk: { op: "beginsWith", prefix: `${taskId}#` } });
    expect(rows.items.map((row) => row["kind"])).toEqual(["PUBLISH"]);
  });

  it("sends review findings back to coding by itself, twice, and then asks the owner", async () => {
    const h = await launch();
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    let job = coding;
    const trees = ["1", "2", "3"].map((digit) => digit.repeat(40));
    for (const [round, tree] of trees.entries()) {
      await h.callback(job, "result", builtResult(tree));
      const review = await h.nextJob(workspaceId, seen);
      await h.callback(review, "result", reviewsOf(review, tree, "findings"));
      if (round === 2) break;
      // Rovara's own send back: the coding run that follows is told what the reviews found, as untrusted data, and keeps to the plan.
      job = await h.nextJob(workspaceId, seen);
      expect(job).toMatchObject({ payload: { workflowMode: "IMPLEMENT" } });
      const prompt = (job.payload as { prompt: string }).prompt;
      expect(prompt).toContain("The endpoint answers 500 when the store is down.");
      expect(prompt).toMatch(/<problem id="[0-9a-f]{16}" source="/u);
      expect(prompt).toContain("Approved plan (sha256");
    }
    const blocked = await taskRecord(h, taskId);
    expect(blocked.workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    // Two automatic send backs, then the owner is asked, with what failed.
    expect(blocked.workflow.decisions.filter((decision) => decision.source === "AUTO_FIX")).toHaveLength(2);
    expect(blocked.autofixAsk).toMatchObject({ reason: "send-back-limit" });
  });

  it("opens the draft pull request on the code host for exactly the checked code, links it to the task, and waits for the merge", async () => {
    const h = await launch({ host: true });
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    // The coding run's commit on the host, and the tree the checks and reviews pass on.
    const commit = h.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree = h.model.revision(commit).tree;
    await h.callback(coding, "result", builtResult(tree, h.base, commit));
    const review = await h.nextJob(workspaceId, seen);
    await h.callback(review, "result", reviewsOf(review, tree, "pass", h.base, commit));
    const publish = await h.nextJob(workspaceId, seen);
    const payload = publish.payload as Record<string, unknown>;
    // The publication names its tree and its branch, carries the digest of its own context and a push grant for the one repository, and nothing else is pushed.
    expect(publish).toMatchObject({ kind: "publish", payload: { mode: "create", repository: "demo", candidateTreeSha: tree, publicationMode: "CHECKED_TREE", workflowBaseCommit: h.base } });
    expect(payload["headBranch"]).toMatch(/^agentx\/[0-9a-f-]{36}$/u);
    expect(payload["publicationContextDigest"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(typeof payload["repositoryGrant"]).toBe("string");
    expect(payload["title"]).toMatch(/^Rovara: /u);
    expect(String(payload["body"])).toContain("a person merges it");

    // The worker pushes the checked commit to its branch and asks for the pull request. A request for another title is refused.
    h.model.branches.set(String(payload["headBranch"]), commit);
    const ask = { repository: "demo", repositoryUrl: h.project.repositories[0]!.url, headBranch: payload["headBranch"], baseBranch: "main", commit, title: payload["title"], body: payload["body"] };
    expect((await h.callback(publish, "pull-request", { ...ask, title: "Something else" })).body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    const opened = await h.callback(publish, "pull-request", ask);
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ number: 1, reconciled: false, draft: true });
    expect(h.model.getChangeRequest("1")).toMatchObject({ draft: true, state: "open", sourceBranch: payload["headBranch"], targetBranch: "main" });
    const result = { repository: "demo", number: 1, url: h.model.crUrl("1"), headBranch: payload["headBranch"], baseBranch: "main", commit, checks: [], reconciled: false, draft: true };
    expect((await h.callback(publish, "result", { status: "SUCCEEDED", result })).status).toBe(200);

    const waiting = await taskRecord(h, taskId) as unknown as { workflow: { stage: string; state: string; pullRequests: Array<{ number: number; headSha: string; headTreeSha: string }> } };
    expect(waiting.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [{ number: 1, headSha: commit, headTreeSha: tree }] });
    const store = h.runtime.registry.require("storage");
    // The pull request is linked back to its task, merge tracking is enrolled, and the branch is recorded as Rovara's alone.
    expect(await store.get({ pk: "CODEHOST_CR#github#example/demo", sk: "CR#0000000001" })).toMatchObject({ taskId, number: 1, repositoryId: "demo", url: h.model.crUrl("1") });
    expect((await store.get({ pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${taskId}` }))).toMatchObject({ kind: "tracking", taskId });
    expect(await readBranchWriters(store, { orgId: IMPLICIT_COMPANY_ID, repositoryId: "demo", branch: String(payload["headBranch"]) })).toEqual({ state: "rovara_only", restackRefused: false });
    expect((await h.api(`/v1/dev/tasks/${taskId}`)).body.task.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE" });
  });

  it("refuses to open a pull request from a branch that is not the checked code, closes nothing it did not open, and stops the task with Retry", async () => {
    const h = await launch({ host: true });
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    const commit = h.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree = h.model.revision(commit).tree;
    await h.callback(coding, "result", builtResult(tree, h.base, commit));
    const review = await h.nextJob(workspaceId, seen);
    await h.callback(review, "result", reviewsOf(review, tree, "pass", h.base, commit));
    const publish = await h.nextJob(workspaceId, seen);
    const payload = publish.payload as Record<string, unknown>;
    // The worker's branch holds other code than the checked tree (its word for it is not taken).
    const other = h.model.commit(String(payload["headBranch"]), { "src/health.ts": "export const health = 500;\n" });
    const denied = await h.callback(publish, "pull-request", { repository: "demo", repositoryUrl: h.project.repositories[0]!.url, headBranch: payload["headBranch"], baseBranch: "main", commit: other, title: payload["title"], body: payload["body"] });
    expect(denied.body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect(h.model.changeRequests).toHaveLength(0);
    expect((await taskRecord(h, taskId)).workflow).toMatchObject({ stage: "PULL_REQUEST", state: "BLOCKED", blockReason: "AgentX couldn't open the pull request automatically. Use Retry opening the pull request to try again." });
    // The worker ends its publication as failed; the system never tries again on its own. The owner's Retry opens it again, as a new publication on a new branch, and this time the worker pushes the checked commit.
    await h.callback(publish, "result", { status: "FAILED", error: "the pushed commit is not the checked code" });
    expect((await h.api(`/v1/dev/tasks/${taskId}/workflow/retry`, { method: "POST", body: { requestId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd" } })).status).toBe(200);
    const second = await h.nextJob(workspaceId, seen);
    const branch = (second.payload as { headBranch: string }).headBranch;
    expect(second).toMatchObject({ kind: "publish" });
    expect(branch).not.toBe(payload["headBranch"]);
    h.model.branches.set(branch, commit);
    const opened = await h.callback(second, "pull-request", { repository: "demo", repositoryUrl: h.project.repositories[0]!.url, headBranch: branch, baseBranch: "main", commit, title: payload["title"], body: payload["body"] });
    expect(opened.status).toBe(200);
  });

  it("blocks a coding run that failed, with a reason, and does not try to fix it by itself", async () => {
    const h = await launch();
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    await h.callback(coding, "result", { status: "FAILED", error: "the model did not answer" });
    const blocked = await taskRecord(h, taskId);
    expect(blocked.workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: "implementation operation ended failed" });
    expect(blocked.autofixAsk).toBeUndefined();
    // The owner's Retry codes again on the same approved plan.
    expect((await h.api(`/v1/dev/tasks/${taskId}/workflow/retry`, { method: "POST", body: { requestId: "abababab-abab-4bab-8bab-abababababab" } })).status).toBe(200);
    const again = await h.nextJob(workspaceId, seen);
    expect(again).toMatchObject({ payload: { workflowMode: "IMPLEMENT" } });
    expect(again.operationId).not.toBe(coding.operationId);
    expect((again.payload as { prompt: string }).prompt).toContain("Approved plan (sha256");
  });

  it("blocks code that did not start where the task started", async () => {
    const h = await launch();
    const { taskId, coding } = await toCoding(h);
    await h.callback(coding, "result", builtResult("d".repeat(40), "f".repeat(40)));
    const blocked = await taskRecord(h, taskId);
    expect(blocked.workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(blocked.workflow.blockReason).toContain("starting point changed");
  });
});
