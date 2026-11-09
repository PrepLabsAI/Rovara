// Lane L9-wire, slice 1: one running `rovara up` on SQLite, the registry, the review pages and the owner's routes, driven against a fake worker. A task is registered and started over HTTP;
// the fake worker answers the preparation, Understand and Plan through the REAL callback listener and the capability the flow issued; the plan appears on the local page and the owner approves
// it there. Docker is simulated (the worker machines are the W0 fake), so nothing here needs Docker.
import { request as httpRequest } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterRegistry, AuditEvent, AuditSink } from "@agentx/contracts";
import { DeveloperProjectsResponseSchema, DeveloperTaskListResponseSchema, DeveloperTaskResponseSchema, IMPLICIT_COMPANY_ID, SessionListReaderSchema, SessionResponseReaderSchema, UNDERSTAND_ARTIFACT_NAME, type WorkerInvocation } from "@agentx/contracts";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { listSessions, readSessionEvents, sessionSnapshot } from "../../packages/broker/src/core/sessions/read.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { modelProxyWorkerUrl } from "../../packages/broker/src/local/docker-worker-machines.js";
import { OPENS_PER_MINUTE } from "../../packages/broker/src/local/app/routes.js";
import { assertGithubCloneAccess } from "../../packages/broker/src/local/github-access.js";
import { artifactObjectKey } from "../../packages/broker/src/local/app/callbacks.js";
import { DOCUMENT_CHANGED } from "../../packages/broker/src/local/app/documents.js";
import { MESSAGES_PER_HOUR, MESSAGE_NOT_PASSED_ON, MESSAGE_RATE_LIMITED } from "../../packages/broker/src/local/app/host.js";
import { registerOpenCommand } from "../../packages/cli/src/up/cli.js";
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
/** An audit sink that keeps what it is told, as a transactional one would (the event is a put in the caller's transaction). */
function recordingAudit(events: AuditEvent[]): AuditSink {
  return {
    stage(event) { events.push(event); return [{ kind: "put", item: { pk: `AUDIT#${event.companyId}`, sk: `EVENT#${event.eventId}`, entityType: "AUDIT", action: event.action, at: event.at }, condition: { op: "notExists", path: ["pk"] } }]; },
    async record(event) { events.push(event); },
  };
}
const GITHUB_PROJECT = { ...PROJECT, name: "ghproject", repositories: [{ ...PROJECT.repositories[0]!, url: "https://github.com/example/demo.git" }] };
const PLAN_TEXT = "# Plan\n\nAdd a /health endpoint that answers 200.\n";

async function launch(extra: { storage?: "sqlite" | "memory"; root?: string; environment?: NodeJS.ProcessEnv; audit?: AuditEvent[] } = {}) {
  const root = extra.root ?? await mkdtemp(join(tmpdir(), "rovara-l9-"));
  if (extra.root === undefined) cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const machines = new FakeWorkerMachines({ startingChecks: 0, features: ["task.workflowMode", "model.route"] });
  /** The addresses the server asked the browser to open: the only place a page address goes. */
  const opened: string[] = [];
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment: extra.environment ?? {}, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9", machines, timers: false,
    ...(extra.audit === undefined ? {} : { registerAdapters: (registry: AdapterRegistry) => registry.register("audit-sink", "recording", recordingAudit(extra.audit!)) }), openBrowser: async (url) => { opened.push(url); }, ...(extra.storage === undefined ? {} : { storage: extra.storage }),
  });
  cleanup.push(() => runtime.stop());
  const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  /** Every answer body an API-token route gave, as text: none may hold a page address. */
  const bodies: string[] = [];
  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${runtime.url}${path}`, {
      method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    bodies.push(text);
    return { status: response.status, body: JSON.parse(text) as ApiBody };
  };
  /**
   * The owner's "open in browser": the server opens the page, and what reaches the browser is a single-use address with no session in it. The "browser" here is the recorder; it follows the
   * address once (as a browser would) and lands on the real page address.
   */
  const browse = async (path: string): Promise<URL> => {
    const before = opened.length;
    const answer = await api("/v1/local/pages/open", { method: "POST", body: { path } });
    expect(answer.status).toBe(200);
    expect(opened.length).toBe(before + 1);
    const once = new URL(opened.at(-1)!);
    // What went through the process list holds no page session.
    expect(once.pathname).toMatch(/^\/s\/once\/[A-Za-z0-9_-]{32,64}$/);
    const hop = await raw(runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
    expect(hop.status).toBe(303);
    // ... and it is spent: the same address a second time is a page that does not exist.
    expect((await raw(runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } })).status).toBe(404);
    return new URL(hop.headers["location"] as string, runtime.pagesUrl);
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
  return { root, stateDirectory, runtime, machines, token, api, bodies, opened, browse, callback, nextJob };
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

    // 4. The owner opens the page (the server opens their browser) and approves there.
    const pages = await h.browse(`/plan/${task.taskId}`);
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
    // C1: no answer an API-token route gave, in the whole journey, held a page address or a page session.
    expect(h.bodies.length).toBeGreaterThan(5);
    for (const body of h.bodies) expect(body).not.toMatch(/\/s\/[A-Za-z0-9_-]{43}/);
    expect(h.bodies.join("")).not.toContain(pages.pathname.split("/")[2]!);
    // The retired route that returned an address is gone.
    expect((await h.api("/v1/local/pages/link", { method: "POST", body: { path: "/" } })).status).toBe(404);
    expect(approved.workflow.decisions.at(-1)).toMatchObject({ decision: "APPROVE" });
  });

  it("sends a plan back with the owner's words, and the next plan is asked for with them", async () => {
    const h = await launch();
    const { taskId, workspaceId, seen } = await toPlanReview(h);
    const link = await h.browse(`/plan/${taskId}`);
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

  it("`rovara open` has the running process open the browser and prints no address, and says so when nothing is running", async () => {
    const h = await launch();
    const { taskId } = await toPlanReview(h);
    const printed: string[] = [];
    const run = async (stateDir: string, ...args: string[]) => {
      const program = new Command().exitOverride().option("--json");
      registerOpenCommand(program, { home: h.root, fetch, stdout: { write: (text: string) => { printed.push(text); return true; } } });
      await program.parseAsync(["node", "rovara", "open", "--state-dir", stateDir, ...args]);
    };
    await run(h.stateDirectory, taskId);
    expect(printed.join("")).toBe("Opened in your browser.\n");
    expect(printed.join("")).not.toMatch(/\/s\//);
    const once = new URL(h.opened.at(-1)!);
    expect(once.pathname).toMatch(/^\/s\/once\//);
    const link = new URL((await raw(h.runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } })).headers["location"] as string, h.runtime.pagesUrl);
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
    const runtime = await startLocalRuntime({ stateDirectory, cwd: join(root, "project"), environment: { GH_TOKEN: githubToken }, gh: async () => undefined, workerImage: "worker:test", docker, workerFetch: docker.fetch, version: "9.9.9", timers: false });
    cleanup.push(() => runtime.stop());
    const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
    const call = async (path: string, body?: unknown) => (await fetch(`${runtime.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json() as Promise<ApiBody>;
    await call("/v1/admin/projects", GITHUB_PROJECT);
    const started = await call("/v1/dev/tasks", { requestId: "12121212-1212-4212-8212-121212121212", project: "ghproject", instructions: "Add a /health endpoint", workflow: true });
    for (let attempt = 0; attempt < 8 && docker.invocations.length === 0; attempt += 1) {
      await runtime.tick();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(docker.invocations[0]).toMatchObject({ kind: "prepare" });
    const worker = [...docker.containers.values()].find((container) => container.kind === "worker");
    expect(worker).toBeDefined();
    // The model proxy's address reaches the worker as the environment the worker reads (the proxy itself is lane L9a's, served on the callback listener).
    expect(worker?.environment["AGENTX_MODEL_PROXY_URL"]).toBe(modelProxyWorkerUrl());
    // The worker clones with the grant it was given: the exchange answers with the owner's token while the job is live, and never for a grant that names other repositories.
    const prepare = docker.invocations[0] as WorkerInvocation & { payload: { repositoryGrant: string } };
    const exchange = (body: unknown) => runtime.app.callbacks({
      method: "POST", path: `/v1/internal/workspaces/${prepare.workspaceId}/operations/${prepare.operationId}/repository-credentials`,
      headers: { "x-agentx-repository-grant": prepare.payload.repositoryGrant }, body: JSON.stringify(body),
    });
    const given = await exchange({ credentialRef: "host-app", repositoryUrl: GITHUB_PROJECT.repositories[0]!.url, access: "clone" });
    expect(given.statusCode).toBe(200);
    expect(JSON.parse(given.body)).toEqual({ credential: { token: githubToken } });
    expect((await exchange({ credentialRef: "host-app", repositoryUrl: GITHUB_PROJECT.repositories[0]!.url, access: "push" })).statusCode).toBe(403);
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

  it("takes no output once an operation has ended, keeps an artifact once, and shows nothing that does not match the digest the approval binds (H1)", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const taskId = (await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: "13131313-1313-4313-8313-131313131313", project: "payments", instructions: "Add a /health endpoint", workflow: true } })).body.task.taskId;
    const workspaceId = (await h.runtime.registry.require("storage").get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
    const seen = new Set<string>();
    await h.callback(await h.nextJob(workspaceId, seen), "result", { status: "SUCCEEDED", result: {} });
    const understand = await h.nextJob(workspaceId, seen);
    await h.callback(understand, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify({ kind: "ready", path: "QUICK", restatement: "Add a /health endpoint that answers 200.", assumptions: [] }) });
    await h.callback(understand, "result", { status: "SUCCEEDED" });
    const plan = await h.nextJob(workspaceId, seen);
    const save = (content: string) => h.callback(plan, "artifacts", { name: "plan.md", mediaType: "text/markdown", content });
    expect((await save(PLAN_TEXT)).status).toBe(200);
    // N7: an artifact name is kept once per operation. Understand and Plan post each name once, so slice 1 has no name a worker may replace; when the coding step is wired, a name the worker
    // contract defines as replaceable (a per-round file) must be listed in `callbacks.ts` before it may be posted twice. This pins the refusal until then.
    // Within the run, the same bytes again are the same artifact (a retried post); other bytes are refused.
    expect((await save(PLAN_TEXT)).status).toBe(200);
    expect((await save("# Plan\n\nSomething else.\n")).body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect((await h.callback(plan, "result", { status: "SUCCEEDED" })).status).toBe(200);

    // After the result, the capability is still good but takes no more output: not a rewritten plan, not events. A repeat of the result is still answered.
    expect((await save("# Plan\n\nAlso add a deploy key.\n")).body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect((await h.callback(plan, "events", { events: [{ type: "progress", timestamp: new Date().toISOString(), payload: null }] })).body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect((await h.callback(plan, "result", { status: "SUCCEEDED" })).status).toBe(200);
    const pageText = async () => {
      const link = await h.browse(`/plan/${taskId}`);
      return (await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).body;
    };
    expect(await pageText()).toContain("Add a /health endpoint that answers 200.");
    expect((await h.api(`/v1/dev/tasks/${taskId}`)).body.task.workflow.planContent).toBe(PLAN_TEXT);

    // Bytes that no longer match the digest (the store was written to by something else) are not shown on the page, in the task, or by the plan route.
    await h.runtime.app.blobs.put(artifactObjectKey(workspaceId, plan.operationId, "plan.md"), new TextEncoder().encode("# Plan\n\nDisable the checks.\n"), { contentType: "text/markdown", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    const tampered = await pageText();
    expect(tampered).not.toContain("Disable the checks.");
    expect(tampered).toContain(DOCUMENT_CHANGED);
    expect((await h.api(`/v1/dev/tasks/${taskId}`)).body.task.workflow.planContent).toBeUndefined();
    const route = await h.api(`/v1/dev/tasks/${taskId}/plan`);
    expect(route.status).toBe(409);
    expect(JSON.stringify(route.body)).not.toContain("Disable the checks.");
  });

  it("gives the GitHub token only for a repository on github.com, to clone (H2)", async () => {
    const githubToken = ["gh", "p_"].join("") + "b2".repeat(18);
    const h = await launch({ environment: { GH_TOKEN: githubToken } });
    // The owner's project names a host that is not github.com (an allowed but foreign site): the grant covers it, and still no credential is given.
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const taskId = (await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: "14141414-1414-4414-8414-141414141414", project: "payments", instructions: "x", workflow: true } })).body.task.taskId;
    const workspaceId = (await h.runtime.registry.require("storage").get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
    const prepare = await h.nextJob(workspaceId, new Set()) as WorkerInvocation & { payload: { repositoryGrant: string } };
    const exchange = (url: string, access: string) => h.runtime.app.callbacks({
      method: "POST", path: `/v1/internal/workspaces/${prepare.workspaceId}/operations/${prepare.operationId}/repository-credentials`,
      headers: { "x-agentx-repository-grant": prepare.payload.repositoryGrant }, body: JSON.stringify({ credentialRef: "host-app", repositoryUrl: url, access }),
    });
    const refused = await exchange(PROJECT.repositories[0]!.url, "clone");
    expect(refused.statusCode).toBe(403);
    expect(refused.body).not.toContain(githubToken);
    expect(assertGithubCloneAccessFor("https://github.com/example/demo.git", "clone")).toBe(true);
    for (const url of ["http://github.com/a/b.git", "https://github.com.evil.example/a/b.git", "https://user:pw@github.com/a/b.git", "https://github.com:444/a/b.git", "https://GITHUB.COM.evil.example/a/b.git", "https://api.github.com/a/b.git"]) expect(assertGithubCloneAccessFor(url, "clone"), url).toBe(false);
    expect(assertGithubCloneAccessFor("https://github.com/a/b.git", "push")).toBe(false);
    // N2: where URL parsers disagree. The WHATWG parser reads `https://github.com\@evil.example.com/x.git` as host github.com; git and curl connect to evil.example.com.
    const evil = ["https://github.com", "@evil.example.com/x.git"].join("\\");
    expect(new URL(evil).hostname).toBe("github.com");
    for (const url of [evil, "https://github.com\\.evil.example.com/a/b.git", "https://github.com%5C@evil.example.com/a/b.git", "https://github.com%5c@evil.example.com/a/b.git", "https://github.com/a/b.git\t", "https://github.com/a/\tb.git", "https://github.com/a/b.git\n", "https://github.com\\\\evil.example.com/a/b.git", "https://github.com@evil.example.com/a/b.git", "https://github.com/a/b.git?x=@evil", "https://github.com/a/b.git#x", " https://github.com/a/b.git", "https://github.com/a/b/c.git", "https://github.com/a", "https://github.com/\u0430/b.git"]) expect(assertGithubCloneAccessFor(url, "clone"), JSON.stringify(url)).toBe(false);
    for (const url of ["https://github.com/example/demo.git", "https://github.com/example/demo", "https://github.com/example/demo/", "https://github.com/Example/de-mo_1.git"]) expect(assertGithubCloneAccessFor(url, "clone"), url).toBe(true);
    // The same addresses are refused when a project is registered, for any host.
    for (const url of [evil, "https://examplehost\\@evil.example.com/a/b.git", "https://examplehost/a/b.git\n", "https://examplehost/a%5Cb.git", "https://exämple.test/a/b.git"]) {
      const refusedProject = await h.api("/v1/admin/projects", { method: "POST", body: { ...PROJECT, name: "odd", repositories: [{ ...PROJECT.repositories[0]!, url }] } });
      expect(refusedProject.status, JSON.stringify(url)).toBe(400);
    }
  });

  it("stops and retries over /v1/dev/tasks through the session control: audited, on the timeline, and once per request id (M2)", async () => {
    const audit: AuditEvent[] = [];
    const h = await launch({ audit });
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const task = (await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: "15151515-1515-4515-8515-151515151515", project: "payments", instructions: "x", workflow: true } })).body.task;
    const workspaceId = (await h.runtime.registry.require("storage").get({ pk: `DEVTASK#${task.taskId}`, sk: "META" }))!["workspaceId"] as string;
    const seen = new Set<string>();
    await h.callback(await h.nextJob(workspaceId, seen), "result", { status: "SUCCEEDED", result: {} });
    await h.nextJob(workspaceId, seen);
    const before = audit.length;
    // A request with no id is refused: a repeat could not be told from a new request.
    expect((await h.api(`/v1/dev/tasks/${task.taskId}/cancel`, { method: "POST", body: {} })).status).toBe(400);
    const stopId = "16161616-1616-4616-8616-161616161616";
    expect((await h.api(`/v1/dev/tasks/${task.taskId}/cancel`, { method: "POST", body: { requestId: stopId } })).status).toBe(200);
    expect(audit.length).toBeGreaterThan(before);
    expect(audit.slice(before).map((event) => event.action).join(",")).toMatch(/session\./);
    const events = await readSessionEvents(h.runtime.registry.require("storage"), IMPLICIT_COMPANY_ID, task.sessionId!);
    expect(events.events.map((event) => event.type)).toContain("stopped");
    // The retry runs the step once, however often the same request id is sent.
    const retryId = "17171717-1717-4717-8717-171717171717";
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await h.api(`/v1/dev/tasks/${task.taskId}/workflow/retry`, { method: "POST", body: { requestId: retryId } })).status).toBe(200);
    const next = await h.nextJob(workspaceId, seen);
    expect(next).toMatchObject({ payload: { workflowMode: "UNDERSTAND" } });
    await h.runtime.tick();
    const operations = (await h.api(`/v1/dev/tasks/${task.taskId}`)).body.task as unknown as { workflow: { revision: number } };
    expect(operations.workflow.revision).toBeGreaterThan(0);
    expect(audit.filter((event) => event.action.startsWith("session.")).length).toBeGreaterThanOrEqual(2);
  });

  it("signs a repository grant and a callback capability with different keys, so one is never good as the other (L1)", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const taskId = (await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: "18181818-1818-4818-8818-181818181818", project: "payments", instructions: "x", workflow: true } })).body.task.taskId;
    const workspaceId = (await h.runtime.registry.require("storage").get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
    const prepare = await h.nextJob(workspaceId, new Set()) as WorkerInvocation & { payload: { repositoryGrant: string } };
    // A grant presented as a capability is a 403 (the signature fails first), not a server error.
    const asCapability = await h.callback({ ...prepare, callbackCapability: prepare.payload.repositoryGrant }, "result", { status: "SUCCEEDED" });
    expect(asCapability.body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect(asCapability.status).toBeLessThan(500);
    // A capability presented as a grant is refused too.
    const asGrant = await h.runtime.app.callbacks({
      method: "POST", path: `/v1/internal/workspaces/${prepare.workspaceId}/operations/${prepare.operationId}/repository-credentials`,
      headers: { "x-agentx-repository-grant": prepare.callbackCapability }, body: JSON.stringify({ credentialRef: "host-app", repositoryUrl: PROJECT.repositories[0]!.url, access: "clone" }),
    });
    expect(asGrant.statusCode).toBe(403);
  });

  it("holds one rovara up per state folder, takes over a lock whose process is gone, and releases it when start fails (L2)", async () => {
    const first = await launch();
    await expect(launch({ root: first.root })).rejects.toThrow(/another rovara up/);
    // The refused start did not disturb the running one.
    expect((await first.api("/v1/dev/tasks")).status).toBe(200);
    await first.runtime.stop();
    // A lock left by a process that is gone is replaced.
    await writeFile(join(first.stateDirectory, "up.lock"), "999999:stale\n", { mode: 0o600 });
    const second = await launch({ root: first.root });
    expect((await second.api("/v1/dev/tasks")).status).toBe(200);
    await second.runtime.stop();
    // A start that fails (a callback key others can read) gives the lock back.
    await chmod(join(first.stateDirectory, "callback-key"), 0o644);
    await expect(launch({ root: first.root })).rejects.toThrow();
    await chmod(join(first.stateDirectory, "callback-key"), 0o600);
    const third = await launch({ root: first.root });
    expect((await third.api("/v1/dev/tasks")).status).toBe(200);
  });

  it("never judges a lock stale while it is empty and young, and names the lock file when it refuses (N4)", async () => {
    const h = await launch();
    await h.runtime.stop();
    const lock = join(h.stateDirectory, "up.lock");
    // A starter that has made the file and not yet written it: held, not stale.
    await writeFile(lock, "", { mode: 0o600 });
    await expect(launch({ root: h.root })).rejects.toThrow(new RegExp(lock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(await readFile(lock, "utf8")).toBe("");
    // Old enough, it is a leftover and is replaced.
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const again = await launch({ root: h.root });
    expect((await again.api("/v1/dev/tasks")).status).toBe(200);
    // A live holder is named by pid and path; no stray stage files are left in the folder.
    await expect(launch({ root: h.root })).rejects.toThrow(/another rovara up \(process \d+\) holds .*up\.lock/);
    expect((await readdir(h.stateDirectory)).filter((name) => name.startsWith("up.lock."))).toEqual([]);
  });

  it("keeps the callback key in a 0600 file and refuses to start on one others can read", async () => {
    const h = await launch();
    expect((await lstat(join(h.stateDirectory, "callback-key"))).mode & 0o777).toBe(0o600);
    await h.runtime.stop();
    await chmod(join(h.stateDirectory, "callback-key"), 0o640);
    await expect(launch({ root: h.root })).rejects.toThrow(/readable by other users|callback key/);
  });

  it("takes no answers on a closed task", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const task = (await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: "19191919-1919-4919-8919-191919191919", project: "payments", instructions: "x", workflow: true } })).body.task;
    const workspaceId = (await h.runtime.registry.require("storage").get({ pk: `DEVTASK#${task.taskId}`, sk: "META" }))!["workspaceId"] as string;
    const seen = new Set<string>();
    await h.callback(await h.nextJob(workspaceId, seen), "result", { status: "SUCCEEDED", result: {} });
    const understand = await h.nextJob(workspaceId, seen);
    await h.callback(understand, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify({ kind: "questions", restatement: "x", questions: [{ id: "q1", text: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }) });
    await h.callback(understand, "result", { status: "SUCCEEDED" });
    expect((await h.api(`/v1/dev/tasks/${task.taskId}/close`, { method: "POST", body: {} })).status).toBe(200);
    const answered = await h.api(`/v1/app/sessions/${task.sessionId!}/answers`, { method: "POST", body: { requestId: "20202020-2020-4020-8020-202020202020", round: 1, answers: [{ questionId: "q1", optionId: "a" }] } });
    expect(answered.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(answered.body)).toContain("closed");
  });

  it("limits how often the browser is opened, and opens one page at a time (N6)", async () => {
    const h = await launch();
    const open = () => h.api("/v1/local/pages/open", { method: "POST", body: { path: "/" } });
    for (let index = 0; index < OPENS_PER_MINUTE; index += 1) expect((await open()).status).toBe(200);
    const sixth = await open();
    expect(sixth.status).toBe(429);
    expect(h.opened).toHaveLength(OPENS_PER_MINUTE);
    expect(sixth.body.error?.code).toBe("TOO_MANY_REQUESTS");
  });

  it("opens one page at a time: a second request while the first is still starting the browser is refused (N6)", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const root = await mkdtemp(join(tmpdir(), "rovara-l9-open-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "state"), { recursive: true, mode: 0o700 });
    const runtime = await startLocalRuntime({ stateDirectory: join(root, "state"), cwd: join(root, "p"), environment: {}, gh: async () => undefined, workerImage: "w", docker: new FakeDocker(), version: "1", timers: false, storage: "memory", openBrowser: () => slow });
    cleanup.push(() => runtime.stop());
    const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
    const post = () => fetch(`${runtime.url}/v1/local/pages/open`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    const first = post();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await post()).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
  });

  it("gives a step the model proxy: the capability lists model-access, the payload names the route, a token is minted while the operation runs and refused after it ends (L9a wiring)", async () => {
    const key = ["sk", "ant", "x".repeat(24)].join("-");
    const h = await launch({ environment: { ANTHROPIC_API_KEY: key } });
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const taskId = (await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: "21212121-2121-4212-8212-212121212121", project: "payments", instructions: "x", workflow: true } })).body.task.taskId;
    const workspaceId = (await h.runtime.registry.require("storage").get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
    const seen = new Set<string>();
    await h.callback(await h.nextJob(workspaceId, seen), "result", { status: "SUCCEEDED", result: {} });
    const understand = await h.nextJob(workspaceId, seen);
    expect((understand.payload as { modelRoute?: { alias: string; api: string } }).modelRoute).toMatchObject({ alias: expect.stringMatching(/^anthropic\//) as string, api: "anthropic-messages" });
    const access = () => new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1", port: h.runtime.callbackPort, method: "GET", path: "/v1/internal/model-access", setHost: false,
        // The worker's own egress gateway stamps the workspace the call comes from.
        headers: { host: `host.docker.internal:${h.runtime.callbackPort}`, "x-agentx-callback-capability": understand.callbackCapability, "x-rovara-workspace": understand.workspaceId },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
    const minted = await access();
    expect(minted.status, minted.text).toBe(200);
    // The worker gets a token of the proxy's, never the owner's key.
    expect(minted.text).not.toContain(key);
    expect(h.bodies.join("")).not.toContain(key);
    await h.callback(understand, "result", { status: "SUCCEEDED" });
    const after = await access();
    expect(after.status).toBeGreaterThanOrEqual(400);
    expect(after.text).not.toContain(key);
    // A step the worker cannot route (no model.route) is not sent at all: a route is never dropped.
  });
});

function assertGithubCloneAccessFor(url: string, access: "clone" | "push"): boolean {
  try { assertGithubCloneAccess(url, access); return true; } catch { return false;  }
}
