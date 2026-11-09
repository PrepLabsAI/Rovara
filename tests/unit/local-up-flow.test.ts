// Lane L9-wire, slice 1: one running `rovara up` on SQLite, the registry, the review pages and the owner's routes, driven against a fake worker. A task is registered and started over HTTP;
// the fake worker answers the preparation, Understand and Plan through the REAL callback listener and the capability the flow issued; the plan appears on the local page and the owner approves
// it there. Docker is simulated (the worker machines are the W0 fake), so nothing here needs Docker.
import { request as httpRequest } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterRegistry, AuditEvent, AuditSink, OrgId } from "@agentx/contracts";
import {
  DeveloperProjectsResponseSchema, DeveloperTaskListResponseSchema, DeveloperTaskResponseSchema, IMPLICIT_COMPANY_ID, SessionListReaderSchema, SessionResponseReaderSchema, UNDERSTAND_ARTIFACT_NAME, WORKER_INVOCATION_FEATURES,
  change, createCandidateManifest, projectMetaKey, startWorkflowBranchSync, startWorkflowFix, when, type TransactItem, type WorkerInvocation, type WorkflowSnapshot,
} from "@agentx/contracts";
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
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { readBranchWriters } from "../../packages/broker/src/core/branch-sync/branch-writers.js";
import { ciEvidenceItem, ciOutputBlock } from "../../packages/broker/src/core/ci-fix/ci-fix.js";
import { dispatchRowItem } from "../../packages/broker/src/core/task-flow/dispatch-rows.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
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

/** Lane L11: a fake GitHub API for the laptop code host. It knows one repository, `example/demo`, and answers only to `token`; every request it sees is listed in `calls`. */
function fakeGithub(token: string, options: { canPush?: boolean } = {}): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${token}`) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (url.pathname === "/repos/example/demo") return Response.json({ id: 77, full_name: "example/demo", owner: { login: "example", id: 5, type: "User" }, permissions: { push: options.canPush !== false, pull: true } });
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
  return { fetch: fetchImplementation, calls };
}
/** A fine-grained token has this shape (built at runtime; the public repository refuses a real-looking one in a file). */
const fineGrainedToken = (seed: string): string => ["github", "pat"].join("_") + "_" + seed.repeat(8);
const classicToken = (seed: string): string => ["gh", "p_"].join("") + seed.repeat(18);
const PLAN_TEXT = "# Plan\n\nAdd a /health endpoint that answers 200.\n";
const BASE_COMMIT = "b".repeat(40);

async function launch(extra: { storage?: "sqlite" | "memory"; root?: string; environment?: NodeJS.ProcessEnv; audit?: AuditEvent[]; host?: boolean } = {}) {
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
  /** The addresses the server asked the browser to open: the only place a page address goes. */
  const opened: string[] = [];
  const registerAdapters = (registry: AdapterRegistry): void => {
    if (extra.audit !== undefined) registry.register("audit-sink", "recording", recordingAudit(extra.audit));
    if (extra.host === true) registry.register("code-host", "github", Object.defineProperty(new FakeCodeHost(model), "kind", { value: "github" }));
  };
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment: extra.environment ?? {}, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9", machines, timers: false,
    registerAdapters, openBrowser: async (url) => { opened.push(url); }, ...(extra.storage === undefined ? {} : { storage: extra.storage }),
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
  return { root, stateDirectory, runtime, machines, token, api, bodies, opened, browse, callback, nextJob, model, project, base };
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
    const githubToken = fineGrainedToken("a1");
    const github = fakeGithub(githubToken);
    const runtime = await startLocalRuntime({ stateDirectory, cwd: join(root, "project"), environment: { GH_TOKEN: githubToken }, gh: async () => undefined, fetch: github.fetch, workerImage: "worker:test", docker, workerFetch: docker.fetch, version: "9.9.9", timers: false });
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
    // The grant covers a clone only; a push credential is not in it (and would come from the code host, too).
    expect((await exchange({ credentialRef: "host-app", repositoryUrl: GITHUB_PROJECT.repositories[0]!.url, access: "push" })).statusCode).toBe(403);
    expect((await exchange({ credentialRef: "host-app", repositoryUrl: "https://examplehost/example/other.git", access: "clone" })).statusCode).toBe(403);
    expect(started.task.workflow.stage).toBe("UNDERSTAND");
  });

  /** A running `rovara up` with the Docker adapter (simulated), a GitHub token in the environment and a fake GitHub; the project is registered and a task started, and the worker's grant is at hand. */
  async function githubFlow(input: { token: string; canPush?: boolean; config?: unknown }) {
    const root = await mkdtemp(join(tmpdir(), "rovara-l11-flow-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    if (input.config !== undefined) await writeFile(join(stateDirectory, "config.json"), JSON.stringify(input.config), { mode: 0o600 });
    const docker = new FakeDocker();
    docker.features = ["task.workflowMode"];
    const github = fakeGithub(input.token, input.canPush === undefined ? {} : { canPush: input.canPush });
    const runtime = await startLocalRuntime({ stateDirectory, cwd: join(root, "project"), environment: { GH_TOKEN: input.token }, gh: async () => undefined, fetch: github.fetch, workerImage: "worker:test", docker, workerFetch: docker.fetch, version: "9.9.9", timers: false });
    cleanup.push(() => runtime.stop());
    const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
    const call = async (path: string, body?: unknown) => (await fetch(`${runtime.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json() as Promise<ApiBody>;
    await call("/v1/admin/projects", GITHUB_PROJECT);
    await call("/v1/dev/tasks", { requestId: "13131313-1313-4313-8313-131313131313", project: "ghproject", instructions: "Add a /health endpoint", workflow: true });
    for (let attempt = 0; attempt < 8 && docker.invocations.length === 0; attempt += 1) {
      await runtime.tick();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const prepare = docker.invocations[0] as WorkerInvocation & { payload: { repositoryGrant: string } };
    const exchange = (access: string, url = GITHUB_PROJECT.repositories[0]!.url) => runtime.app.callbacks({
      method: "POST", path: `/v1/internal/workspaces/${prepare.workspaceId}/operations/${prepare.operationId}/repository-credentials`,
      headers: { "x-agentx-repository-grant": prepare.payload.repositoryGrant }, body: JSON.stringify({ credentialRef: "host-app", repositoryUrl: url, access }),
    });
    return { runtime, github, exchange };
  }

  it("does not give a worker a token that reaches every repository, unless the config says so (L11 M1)", async () => {
    const classic = classicToken("c3");
    const refused = await githubFlow({ token: classic });
    const answer = await refused.exchange("clone");
    expect(answer.statusCode).toBe(403);
    expect(answer.body).not.toContain(classic);
    expect(answer.body).toContain("allowBroadTokenForWorker");
    // The same through the code host the app resolves it with, for a push as well.
    await expect(refused.runtime.registry.require("code-host", "github").issueGitCredential({ url: GITHUB_PROJECT.repositories[0]!.url }, "push", { orgId: IMPLICIT_COMPANY_ID })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const allowedToken = classicToken("d4");
    const allowed = await githubFlow({ token: allowedToken, config: { version: 1, allowBroadTokenForWorker: true, plugins: [] } });
    expect(JSON.parse((await allowed.exchange("clone")).body)).toEqual({ credential: { token: allowedToken } });
  });

  it("gives a worker a credential only for a registered project's repository, and stops when the project is archived (L11 M2)", async () => {
    const token = fineGrainedToken("e5");
    const h = await githubFlow({ token });
    expect((await h.exchange("clone")).statusCode).toBe(200);
    const before = h.github.calls.length;
    // The project is archived: its repository is no longer a registered one, whatever the token can see and whatever the worker's grant still names.
    await h.runtime.registry.require("storage").put({ item: { ...projectMetaKey(IMPLICIT_COMPANY_ID as OrgId, "ghproject"), entityType: "PROJECT_META", status: "archived" } });
    const stopped = await h.exchange("clone");
    expect(stopped.statusCode).toBe(403);
    expect(stopped.body).not.toContain(token);
    expect(h.github.calls.slice(before)).toEqual([]);
  });

  it("refuses a push credential from the registered code host when the token cannot push, and gives one when it can (L11)", async () => {
    const scope = { orgId: IMPLICIT_COMPANY_ID };
    const repository = { url: GITHUB_PROJECT.repositories[0]!.url };
    const cannot = await githubFlow({ token: fineGrainedToken("f6"), canPush: false });
    expect(await cannot.runtime.registry.require("code-host", "github").issueGitCredential(repository, "clone", scope)).toMatchObject({ kind: "basic" });
    await expect(cannot.runtime.registry.require("code-host", "github").issueGitCredential(repository, "push", scope)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const can = await githubFlow({ token: fineGrainedToken("a7") });
    expect(await can.runtime.registry.require("code-host", "github").issueGitCredential(repository, "push", scope)).toMatchObject({ kind: "basic", username: "x-access-token" });
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

// ---- Lane L10: the build step. A task runs on from the approved plan against a fake worker: coding, the checks, both reviews, Rovara's own sending back, and the pull request.
const COMMIT = "c".repeat(40);
const CHECK_REPORT = { status: "not_verified", notVerifiedReason: "no_checks", source: "none", preambleVersion: "1", preambleSha256: "a".repeat(64), checks: [], extraTry: "not_needed", agentClaim: "none" };
const candidateOf = (tree: string, base = BASE_COMMIT, commit = COMMIT) => [{ repositoryId: "demo", commitSha: commit, treeSha: tree, baseCommitSha: base }];

/** The owner approves the plan on the review page, as a person would. */
async function approvePlan(h: Awaited<ReturnType<typeof launch>>, taskId: string): Promise<void> {
  const link = await h.browse(`/plan/${taskId}`);
  const page = await raw(h.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
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

describe("rovara up: an open pull request is fixed and kept up to date, against a fake worker and a fake code host", () => {
  /** A task through publication: the pull request is open on the host and the task waits for the merge. */
  async function toWaitForMerge(h: Awaited<ReturnType<typeof launch>>) {
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    const commit = h.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree = h.model.revision(commit).tree;
    await h.callback(coding, "result", builtResult(tree, h.base, commit));
    const review = await h.nextJob(workspaceId, seen);
    await h.callback(review, "result", reviewsOf(review, tree, "pass", h.base, commit));
    const publish = await h.nextJob(workspaceId, seen);
    const payload = publish.payload as Record<string, unknown>;
    const headBranch = String(payload["headBranch"]);
    h.model.branches.set(headBranch, commit);
    await h.callback(publish, "pull-request", { repository: "demo", repositoryUrl: h.project.repositories[0]!.url, headBranch, baseBranch: "main", commit, title: payload["title"], body: payload["body"] });
    await h.callback(publish, "result", { status: "SUCCEEDED", result: { repository: "demo", number: 1, url: h.model.crUrl("1"), headBranch, baseBranch: "main", commit, checks: [], reconciled: false, draft: true } });
    expect((await taskRecord(h, taskId)).workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    return { taskId, workspaceId, seen, headBranch, commit, tree };
  }

  /** What merge tracking's deciders commit for a round: the next workflow, the rows it owns, and the row of the step the new state is due for (the pass commits them together). */
  async function commitRound(h: Awaited<ReturnType<typeof launch>>, taskId: string, next: (workflow: WorkflowSnapshot) => WorkflowSnapshot, kind: "IMPLEMENT" | "SYNC", rows: (after: WorkflowSnapshot) => TransactItem[] = () => []): Promise<WorkflowSnapshot> {
    const store = h.runtime.registry.require("storage");
    const task = (await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!;
    const workflow = task["workflow"] as unknown as WorkflowSnapshot;
    const after = next(workflow);
    const written = await store.transact([
      { kind: "update", key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ops: [change.set("workflow", toDocument(after))], condition: when.eq(["workflow", "revision"], workflow.revision) },
      dispatchRowItem(h.runtime.app.flow.deps, taskId, after.revision, kind, new Date().toISOString()), ...rows(after),
    ]);
    expect(written.applied).toBe(true);
    return after;
  }

  it("fixes failing CI: the coding run is told what CI said, and the reviewed fix is pushed as exactly the reviewed tree onto the open pull request", async () => {
    const h = await launch({ host: true });
    const { taskId, workspaceId, seen, headBranch, commit } = await toWaitForMerge(h);
    const now = new Date().toISOString();
    await commitRound(h, taskId, (workflow) => startWorkflowFix(workflow, { source: "ci", problems: ["unit-tests"], now }), "IMPLEMENT", (after) => [
      ciEvidenceItem({ orgId: IMPLICIT_COMPANY_ID, taskId, revision: after.revision, block: ciOutputBlock([{ name: "unit-tests", conclusion: "failure", log: "1 failing: health answers 500" }]), now: Date.now() }),
    ]);
    // The sweep starts the row. The run starts from the head the pull request has, and is told what CI said, not the plan again.
    const fix = await h.nextJob(workspaceId, seen);
    expect(fix).toMatchObject({ payload: { workflowMode: "IMPLEMENT", workflowFix: { source: "ci", startFrom: commit } } });
    expect((fix.payload as { prompt: string }).prompt).toContain("health answers 500");
    // The fix is a commit on top of the pull request's head (made in the worker's workspace; the host does not have it yet).
    h.model.branches.set("fix", commit);
    const fixCommit = h.model.commit("fix", { "src/health.ts": "export const health = 200; // CI fixed\n" });
    const fixTree = h.model.revision(fixCommit).tree;
    await h.callback(fix, "result", builtResult(fixTree, h.base, fixCommit));
    const review = await h.nextJob(workspaceId, seen);
    await h.callback(review, "result", reviewsOf(review, fixTree, "pass", h.base, fixCommit));
    // Every repository already has its pull request, so the reviewed fix is pushed to it (a `maintain` run), as exactly the reviewed tree on the pinned base and onto the recorded head.
    const update = await h.nextJob(workspaceId, seen);
    expect(update).toMatchObject({ kind: "maintain", payload: { action: "append", repository: "demo", pullRequestNumber: 1, headBranch, expectedHeadCommit: commit, workflowCandidateTreeSha: fixTree, workflowBaseCommit: h.base, workflowFix: { source: "ci" } } });
    expect(typeof (update.payload as { repositoryGrant?: unknown }).repositoryGrant).toBe("string");
    const call = { repository: "demo", pullRequestNumber: 1, action: "append", headBranch, baseBranch: "main", previousCommit: commit, commit: fixCommit };
    // A push that is not what the operation was started with is refused, and so is one the host does not show.
    expect((await h.callback(update, "pull-request-update", { ...call, previousCommit: "f".repeat(40) })).body).toMatchObject({ error: { code: "STALE_FENCE" } });
    expect((await h.callback(update, "pull-request-update", call)).body).toMatchObject({ error: { code: "STALE_FENCE" } });
    h.model.branches.set(headBranch, fixCommit);
    expect((await h.callback(update, "pull-request-update", call)).status).toBe(200);
    const result = { action: "append", repository: "demo", number: 1, url: h.model.crUrl("1"), state: "open", headBranch, baseBranch: "main", previousCommit: commit, commit: fixCommit, treeSha: fixTree, checks: [], reconciled: false };
    expect((await h.callback(update, "result", { status: "SUCCEEDED", result })).status).toBe(200);
    const after = await taskRecord(h, taskId) as unknown as { workflow: { stage: string; state: string; pullRequests: Array<{ headSha: string; headTreeSha: string }> } };
    expect(after.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [{ headSha: fixCommit, headTreeSha: fixTree }] });
  });

  it("merges the base branch into the pull request's branch when merge tracking asks, and records the merge the host shows", async () => {
    const h = await launch({ host: true });
    const { taskId, workspaceId, seen, headBranch, commit } = await toWaitForMerge(h);
    const base = h.model.commit("main", { "README.md": "# demo, moved on\n" });
    await commitRound(h, taskId, (workflow) => startWorkflowBranchSync(workflow, { repositoryId: "demo", number: 1, reason: "behind", now: new Date().toISOString() }), "SYNC");
    const sync = await h.nextJob(workspaceId, seen);
    expect(sync).toMatchObject({ kind: "maintain", payload: { action: "sync", pullRequestNumber: 1, expectedHeadCommit: commit, workflowSync: { baseCommit: base, expectedHeadCommit: commit } } });
    // The worker's merge commit: the recorded head first, the base commit second.
    const merge = "8".repeat(40);
    const mergeTree = "9".repeat(40);
    h.model.revisions.set(merge, { sha: merge, tree: mergeTree, parents: [commit, base], files: new Map() });
    h.model.branches.set(headBranch, merge);
    expect((await h.callback(sync, "pull-request-update", { repository: "demo", pullRequestNumber: 1, action: "sync", headBranch, baseBranch: "main", previousCommit: commit, commit: merge })).status).toBe(200);
    const result = { action: "sync", repository: "demo", number: 1, url: h.model.crUrl("1"), state: "open", headBranch, baseBranch: "main", previousCommit: commit, commit: merge, treeSha: mergeTree, checks: [], reconciled: false };
    expect((await h.callback(sync, "result", { status: "SUCCEEDED", result })).status).toBe(200);
    const after = await taskRecord(h, taskId) as unknown as { workflow: { stage: string; state: string; branchSync?: unknown; pullRequests: Array<{ headSha: string }> } };
    expect(after.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", pullRequests: [{ headSha: merge }] });
    expect(after.workflow.branchSync).toBeUndefined();
  });
});
function assertGithubCloneAccessFor(url: string, access: "clone" | "push"): boolean {
  try { assertGithubCloneAccess(url, access); return true; } catch { return false;  }
}
