// Lane L9-wire, slice 1: one running `rovara up` on SQLite, the registry, the review pages and the owner's routes, driven against a fake worker. A task is registered and started over HTTP;
// the fake worker answers the preparation, Understand and Plan through the REAL callback listener and the capability the flow issued; the plan appears on the local page and the owner approves
// it there. Docker is simulated (the worker machines are the W0 fake), so nothing here needs Docker.
import { request as httpRequest } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterRegistry, AuditEvent, AuditSink } from "@agentx/contracts";
import {
  DeveloperProjectsResponseSchema, DeveloperTaskListResponseSchema, DeveloperTaskResponseSchema, IMPLICIT_COMPANY_ID, ROVARA_REPLY_MARKER, SessionListReaderSchema, SessionResponseReaderSchema, UNDERSTAND_ARTIFACT_NAME, WORKER_INVOCATION_FEATURES,
  change, createCandidateManifest, projectMetaKey, startWorkflowBranchSync, startWorkflowFix, when, type Check, type TransactItem, type WorkerInvocation, type WorkflowSnapshot,
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
import { shortDigest } from "../../packages/broker/src/core/pr-commands/comment-checks.js";
import { approvalOfferOf } from "../../packages/broker/src/local/app/page-data.js";
import { verifiedChangedFiles } from "../../packages/broker/src/core/build-step/changed-files.js";
import { readyToMerge } from "../../packages/broker/src/local/app/attention.js";
import { retryBlockedStep } from "../../packages/broker/src/local/app/retry.js";
import { recordedHeadOf } from "../../packages/broker/src/core/build-step/head-check.js";
import { WORKFLOW_DOCUMENT_KIND } from "../../packages/broker/src/core/decisions/workflow-subject.js";
import { runDispatchRow } from "../../packages/broker/src/core/task-flow/stage-machine.js";
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

async function launch(extra: { storage?: "sqlite" | "memory"; root?: string; environment?: NodeJS.ProcessEnv; audit?: AuditEvent[]; host?: boolean; model?: FakeHostModel; readiness?: boolean; now?: () => Date; commentThreadsPerPoll?: number } = {}) {
  const root = extra.root ?? await mkdtemp(join(tmpdir(), "rovara-l9-"));
  if (extra.root === undefined) cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const machines = new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] });
  // A fake code host that holds the repository (lane L10): the build step reads the pushed branch and opens the pull request through its port.
  const hostedUrl = "https://github.com/example/demo.git";
  const model = extra.model ?? new FakeHostModel({ url: hostedUrl, id: "1", fullName: "example/demo" });
  const fakeHost = Object.defineProperty(new FakeCodeHost(model), "kind", { value: "github" });
  // A project cannot yet name another code host at registration (51 gap: the project contract refuses `repositories[].host`), so a repository is on the code host registered as `github`; the
  // test's host is the fake one under that name.
  const readiness = extra.readiness === true ? [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 }] : [];
  const project = extra.host === true ? { ...PROJECT, readiness, repositories: [{ ...PROJECT.repositories[0]!, url: hostedUrl }] } : PROJECT;
  const base = extra.host === true ? model.headOf("main") : BASE_COMMIT;
  /** The addresses the server asked the browser to open: the only place a page address goes. */
  const opened: string[] = [];
  const registerAdapters = (registry: AdapterRegistry): void => {
    if (extra.audit !== undefined) registry.register("audit-sink", "recording", recordingAudit(extra.audit));
    if (extra.host === true) {
      const host = fakeHost;
      // The fake's clock is its own (2026-10-30); a credential the worker is sent must expire in the real future.
      const issue = host.issueGitCredential.bind(host);
      host.issueGitCredential = async (repository, access, scope) => ({ ...(await issue(repository, access, scope)), expiresAt: new Date(Date.now() + 50 * 60_000).toISOString() });
      registry.register("code-host", "github", host);
    }
  };
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment: extra.environment ?? {}, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9", machines, timers: false,
    registerAdapters, openBrowser: async (url) => { opened.push(url); }, ...(extra.storage === undefined ? {} : { storage: extra.storage }), ...(extra.now === undefined ? {} : { now: extra.now }), ...(extra.commentThreadsPerPoll === undefined ? {} : { commentThreadsPerPoll: extra.commentThreadsPerPoll }),
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
  return { root, stateDirectory, runtime, machines, token, api, bodies, opened, browse, callback, nextJob, model, project, base, host: fakeHost };
}

/** Registers the project, starts a task and answers its preparation, Understand and Plan, so it waits for the owner's approval. */
async function toPlanReview(h: Awaited<ReturnType<typeof launch>>, requestId = "11111111-1111-4111-8111-111111111111", instructions = "Add a /health endpoint") {
  await h.api("/v1/admin/projects", { method: "POST", body: h.project });
  const started = await h.api("/v1/dev/tasks", { method: "POST", body: { requestId, project: "payments", instructions, workflow: true } });
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
    await h.runtime.registry.require("storage").put({ item: { ...projectMetaKey(IMPLICIT_COMPANY_ID, "ghproject"), entityType: "PROJECT_META", status: "archived" } });
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

/** A page of the local review server, fetched as the browser the owner was sent to. */
const raw_ = (h: Awaited<ReturnType<typeof launch>>, link: URL) => raw(h.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
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


describe("rovara up: an open pull request is fixed and kept up to date, against a fake worker and a fake code host", () => {
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


  // ---- the opus review's fixes (lane L10 round 1)
  type Harness = Awaited<ReturnType<typeof launch>>;
  const PR_RECORD = (workspaceId: string) => ({ pk: `WORKSPACE#${workspaceId}`, sk: "PULL_REQUEST#demo#0000000001" });
  const recordHead = async (h: Harness, workspaceId: string) => (await h.runtime.registry.require("storage").get(PR_RECORD(workspaceId)))?.["expectedHeadCommit"];
  /** The worker exchanges its repository grant for a credential, as its helper does. */
  const exchange = (h: Harness, job: WorkerInvocation, access: "clone" | "push", url = h.project.repositories[0]!.url) => h.runtime.app.callbacks({
    method: "POST", path: `/v1/internal/workspaces/${job.workspaceId}/operations/${job.operationId}/repository-credentials`,
    headers: { "x-agentx-repository-grant": (job.payload as { repositoryGrant: string }).repositoryGrant }, body: JSON.stringify({ credentialRef: "host-app", repositoryUrl: url, access }),
  });

  /** A CI fix reviewed and ready to be pushed: the maintain job is in hand. */
  async function toAppend(h: Harness) {
    const waiting = await toWaitForMerge(h);
    const now = new Date().toISOString();
    await commitRound(h, waiting.taskId, (workflow) => startWorkflowFix(workflow, { source: "ci", problems: ["unit-tests"], now }), "IMPLEMENT", (after) => [
      ciEvidenceItem({ orgId: IMPLICIT_COMPANY_ID, taskId: waiting.taskId, revision: after.revision, block: ciOutputBlock([{ name: "unit-tests", conclusion: "failure", log: "1 failing" }]), now: Date.now() }),
    ]);
    const fix = await h.nextJob(waiting.workspaceId, waiting.seen);
    h.model.branches.set("fix", waiting.commit);
    const fixCommit = h.model.commit("fix", { "src/health.ts": "export const health = 200; // CI fixed\n" });
    const fixTree = h.model.revision(fixCommit).tree;
    await h.callback(fix, "result", builtResult(fixTree, h.base, fixCommit));
    const review = await h.nextJob(waiting.workspaceId, waiting.seen);
    await h.callback(review, "result", reviewsOf(review, fixTree, "pass", h.base, fixCommit));
    const update = await h.nextJob(waiting.workspaceId, waiting.seen);
    const call = { repository: "demo", pullRequestNumber: 1, action: "append", headBranch: waiting.headBranch, baseBranch: "main", previousCommit: waiting.commit, commit: fixCommit };
    const lifecycle = (commit: string, treeSha: string, action = "append") => ({ action, repository: "demo", number: 1, url: h.model.crUrl("1"), state: "open", headBranch: waiting.headBranch, baseBranch: "main", previousCommit: waiting.commit, commit, treeSha, checks: [], reconciled: false });
    return { ...waiting, update, fixCommit, fixTree, call, lifecycle };
  }

  /** The base moved on and merge tracking asked for a merge: the maintain job is in hand. */
  async function toSync(h: Harness) {
    const waiting = await toWaitForMerge(h);
    const newBase = h.model.commit("main", { "README.md": "# demo, moved on\n" });
    await commitRound(h, waiting.taskId, (workflow) => startWorkflowBranchSync(workflow, { repositoryId: "demo", number: 1, reason: "behind", now: new Date().toISOString() }), "SYNC");
    const sync = await h.nextJob(waiting.workspaceId, waiting.seen);
    /** The worker's merge commit on the host's branch: the given parents, and a tree. */
    const merge = (sha: string, tree: string, parents: string[]) => { h.model.revisions.set(sha, { sha, tree, parents, files: new Map() }); h.model.branches.set(waiting.headBranch, sha); return sha; };
    const call = (commit: string) => ({ repository: "demo", pullRequestNumber: 1, action: "sync", headBranch: waiting.headBranch, baseBranch: "main", previousCommit: waiting.commit, commit });
    const lifecycle = (commit: string, treeSha: string) => ({ action: "sync", repository: "demo", number: 1, url: h.model.crUrl("1"), state: "open", headBranch: waiting.headBranch, baseBranch: "main", previousCommit: waiting.commit, commit, treeSha, checks: [], reconciled: false });
    return { ...waiting, newBase, sync, merge, call, lifecycle };
  }

  it("gives a worker a push credential only from the code host, for a publication and for a push to an open pull request, and never after the operation ended or for a clone grant", async () => {
    const h = await launch({ host: true });
    const { workspaceId, seen, coding } = await toCoding(h);
    const commit = h.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree = h.model.revision(commit).tree;
    await h.callback(coding, "result", builtResult(tree, h.base, commit));
    const review = await h.nextJob(workspaceId, seen);
    await h.callback(review, "result", reviewsOf(review, tree, "pass", h.base, commit));
    const publish = await h.nextJob(workspaceId, seen);
    // The host's own credential (the fake gives a token whose text says it is for a push), for the one repository the grant names.
    const given = await exchange(h, publish, "push");
    expect(given.statusCode).toBe(200);
    expect(JSON.parse(given.body)).toEqual({ credential: { token: "fake-push-token-not-a-real-secret" } });
    expect((await exchange(h, publish, "clone")).statusCode).toBe(403);
    expect((await exchange(h, publish, "push", "https://github.com/example/other.git")).statusCode).toBe(403);
    const headBranch = (publish.payload as { headBranch: string }).headBranch;
    h.model.branches.set(headBranch, commit);
    const payload = publish.payload as Record<string, unknown>;
    await h.callback(publish, "pull-request", { repository: "demo", repositoryUrl: h.project.repositories[0]!.url, headBranch, baseBranch: "main", commit, title: payload["title"], body: payload["body"] });
    await h.callback(publish, "result", { status: "SUCCEEDED", result: { repository: "demo", number: 1, url: h.model.crUrl("1"), headBranch, baseBranch: "main", commit, checks: [], reconciled: false, draft: true } });
    expect((await exchange(h, publish, "push")).statusCode).toBe(403);

    // The push of a fix to the open pull request asks the same way.
    const now = new Date().toISOString();
    const taskId = (await h.api("/v1/dev/tasks")).body.tasks[0]!.taskId;
    await commitRound(h, taskId, (workflow) => startWorkflowFix(workflow, { source: "ci", problems: ["unit-tests"], now }), "IMPLEMENT", (after) => [
      ciEvidenceItem({ orgId: IMPLICIT_COMPANY_ID, taskId, revision: after.revision, block: ciOutputBlock([{ name: "unit-tests", conclusion: "failure" }]), now: Date.now() }),
    ]);
    const fix = await h.nextJob(workspaceId, seen);
    h.model.branches.set("fix", commit);
    const fixCommit = h.model.commit("fix", { "src/health.ts": "export const health = 200; // fixed\n" });
    const fixTree = h.model.revision(fixCommit).tree;
    await h.callback(fix, "result", builtResult(fixTree, h.base, fixCommit));
    const second = await h.nextJob(workspaceId, seen);
    await h.callback(second, "result", reviewsOf(second, fixTree, "pass", h.base, fixCommit));
    const update = await h.nextJob(workspaceId, seen);
    expect(update.kind).toBe("maintain");
    expect(JSON.parse((await exchange(h, update, "push")).body)).toEqual({ credential: { token: "fake-push-token-not-a-real-secret" } });
  });

  it("answers no callback of an operation that has ended: a late pull request after an interrupted publication and a Retry opens no second draft", async () => {
    const h = await launch({ host: true });
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    const commit = h.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree = h.model.revision(commit).tree;
    await h.callback(coding, "result", builtResult(tree, h.base, commit));
    const review = await h.nextJob(workspaceId, seen);
    await h.callback(review, "result", reviewsOf(review, tree, "pass", h.base, commit));
    const first = await h.nextJob(workspaceId, seen);
    const payload = first.payload as Record<string, unknown>;
    const branch = String(payload["headBranch"]);
    h.model.branches.set(branch, commit);
    // The publication is lost after the push: it ends INTERRUPTED, the task stops, and the owner retries.
    await h.callback(first, "result", { status: "FAILED", error: "the machine was lost" });
    expect((await taskRecord(h, taskId)).workflow).toMatchObject({ stage: "PULL_REQUEST", state: "BLOCKED" });
    expect((await h.api(`/v1/dev/tasks/${taskId}/workflow/retry`, { method: "POST", body: { requestId: "efefefef-efef-4fef-8fef-efefefefefef" } })).status).toBe(200);
    const second = await h.nextJob(workspaceId, seen);
    expect(second.kind).toBe("publish");
    // The first operation's capability is still good for 9 hours, but it has ended.
    const ask = { repository: "demo", repositoryUrl: h.project.repositories[0]!.url, headBranch: branch, baseBranch: "main", commit, title: payload["title"], body: payload["body"] };
    // (The retry took the workspace again, so the old fence refuses it; the next operation's own check is below.)
    expect([403, 409]).toContain((await h.callback(first, "pull-request", ask)).status);
    expect(h.model.changeRequests).toHaveLength(0);
    // Without a Retry the ended operation is refused for having ended: every action but the result.
    const alone = await launch({ host: true });
    const t = await toCoding(alone);
    const c2 = alone.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree2 = alone.model.revision(c2).tree;
    await alone.callback(t.coding, "result", builtResult(tree2, alone.base, c2));
    expect((await alone.callback(t.coding, "candidate-export", { stage: "finalize" })).body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    const review2 = await alone.nextJob(t.workspaceId, t.seen);
    await alone.callback(review2, "result", reviewsOf(review2, tree2, "pass", alone.base, c2));
    const publish2 = await alone.nextJob(t.workspaceId, t.seen);
    const p2 = publish2.payload as Record<string, unknown>;
    alone.model.branches.set(String(p2["headBranch"]), c2);
    await alone.callback(publish2, "result", { status: "FAILED", error: "the machine was lost" });
    const refused = await alone.callback(publish2, "pull-request", { repository: "demo", repositoryUrl: alone.project.repositories[0]!.url, headBranch: p2["headBranch"], baseBranch: "main", commit: c2, title: p2["title"], body: p2["body"] });
    expect(refused.body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect(alone.model.changeRequests).toHaveLength(0);
  });

  it("closes the draft an interrupted publication left, and writes an audit event for the one it opens", async () => {
    const events: AuditEvent[] = [];
    const h = await launch({ host: true, audit: events });
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    const commit = h.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree = h.model.revision(commit).tree;
    await h.callback(coding, "result", builtResult(tree, h.base, commit));
    const review = await h.nextJob(workspaceId, seen);
    await h.callback(review, "result", reviewsOf(review, tree, "pass", h.base, commit));
    const first = await h.nextJob(workspaceId, seen);
    const payload = first.payload as Record<string, unknown>;
    const branch = String(payload["headBranch"]);
    h.model.branches.set(branch, commit);
    await h.callback(first, "pull-request", { repository: "demo", repositoryUrl: h.project.repositories[0]!.url, headBranch: branch, baseBranch: "main", commit, title: payload["title"], body: payload["body"] });
    expect(events.filter((event) => event.action === "pull_request.opened")).toHaveLength(1);
    // The result is lost: the draft is open on the host and nothing tracks it.
    await h.callback(first, "result", { status: "FAILED", error: "the machine was lost" });
    expect(h.model.getChangeRequest("1").state).toBe("open");
    await h.api(`/v1/dev/tasks/${taskId}/workflow/retry`, { method: "POST", body: { requestId: "efefefef-efef-4fef-8fef-efefefefefef" } });
    expect(h.model.getChangeRequest("1").state).toBe("closed");
    const second = await h.nextJob(workspaceId, seen);
    const branch2 = String((second.payload as { headBranch: string }).headBranch);
    h.model.branches.set(branch2, commit);
    expect((await h.callback(second, "pull-request", { ...{ repository: "demo", repositoryUrl: h.project.repositories[0]!.url, baseBranch: "main", commit, title: payload["title"], body: payload["body"] }, headBranch: branch2 })).body).toMatchObject({ number: 2 });
  });

  it("leaves an earlier draft open when a person took it up (pushed to it, or marked it ready), and says why", async () => {
    for (const how of ["pushed", "ready"] as const) {
      const h = await launch({ host: true });
      const { taskId, workspaceId, seen, coding } = await toCoding(h);
      const commit = h.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
      const tree = h.model.revision(commit).tree;
      await h.callback(coding, "result", builtResult(tree, h.base, commit));
      const review = await h.nextJob(workspaceId, seen);
      await h.callback(review, "result", reviewsOf(review, tree, "pass", h.base, commit));
      const first = await h.nextJob(workspaceId, seen);
      const payload = first.payload as Record<string, unknown>;
      const branch = String(payload["headBranch"]);
      h.model.branches.set(branch, commit);
      await h.callback(first, "pull-request", { repository: "demo", repositoryUrl: h.project.repositories[0]!.url, headBranch: branch, baseBranch: "main", commit, title: payload["title"], body: payload["body"] });
      await h.callback(first, "result", { status: "FAILED", error: "the machine was lost" });
      if (how === "pushed") h.model.commit(branch, { "README.md": "a person's change\n" }); else h.model.markReady("1");
      await h.api(`/v1/dev/tasks/${taskId}/workflow/retry`, { method: "POST", body: { requestId: "efefefef-efef-4fef-8fef-efefefefefef" } });
      expect(h.model.getChangeRequest("1").state).toBe("open");
      const record = await h.runtime.registry.require("storage").get(PR_RECORD(workspaceId));
      expect(record?.["leftOpen"]).toContain(how === "pushed" ? "someone pushed" : "marked ready");
      // The Retry still goes on with a new draft of its own.
      expect((await h.nextJob(workspaceId, seen)).kind).toBe("publish");
    }
  });

  it("judges the opened draft's head as the first read shows it, and does not wait for a branch put back", async () => {
    const h = await launch({ host: true });
    const { workspaceId, seen, coding } = await toCoding(h);
    const commit = h.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree = h.model.revision(commit).tree;
    const other = h.model.commit("elsewhere", { "src/health.ts": "export const health = 500;\n" });
    await h.callback(coding, "result", builtResult(tree, h.base, commit));
    const review = await h.nextJob(workspaceId, seen);
    await h.callback(review, "result", reviewsOf(review, tree, "pass", h.base, commit));
    const publish = await h.nextJob(workspaceId, seen);
    const payload = publish.payload as Record<string, unknown>;
    const branch = String(payload["headBranch"]);
    h.model.branches.set(branch, commit);
    // The branch moves between the check and the read of the opened draft, and is put back after it.
    const read = h.host.getChangeRequest.bind(h.host);
    h.host.getChangeRequest = async (ref, scope) => { h.model.branches.set(branch, other); const details = await read(ref, scope); h.model.branches.set(branch, commit); return details; };
    const denied = await h.callback(publish, "pull-request", { repository: "demo", repositoryUrl: h.project.repositories[0]!.url, headBranch: branch, baseBranch: "main", commit, title: payload["title"], body: payload["body"] });
    expect(denied.body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect(h.model.getChangeRequest("1").state).toBe("closed");
  });

  it("does not record a result that names another pull request or another commit than the one the callback opened", async () => {
    const h = await launch({ host: true });
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    const commit = h.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree = h.model.revision(commit).tree;
    await h.callback(coding, "result", builtResult(tree, h.base, commit));
    const review = await h.nextJob(workspaceId, seen);
    await h.callback(review, "result", reviewsOf(review, tree, "pass", h.base, commit));
    const publish = await h.nextJob(workspaceId, seen);
    const payload = publish.payload as Record<string, unknown>;
    const branch = String(payload["headBranch"]);
    h.model.branches.set(branch, commit);
    await h.callback(publish, "pull-request", { repository: "demo", repositoryUrl: h.project.repositories[0]!.url, headBranch: branch, baseBranch: "main", commit, title: payload["title"], body: payload["body"] });
    await h.callback(publish, "result", { status: "SUCCEEDED", result: { repository: "demo", number: 7, url: h.model.crUrl("7"), headBranch: branch, baseBranch: "main", commit, checks: [], reconciled: false } });
    expect((await taskRecord(h, taskId)).workflow).toMatchObject({ stage: "PULL_REQUEST", state: "BLOCKED" });
  });

  it("grades the plan waiting for approval from the request text and the task's cost estimate, through the wiring", async () => {
    const tier = async (instructions: string, estimate?: number) => {
      const h = await launch();
      const { taskId } = await toPlanReview(h, "11111111-1111-4111-8111-111111111111", instructions);
      if (estimate !== undefined) await h.runtime.registry.require("storage").update({ key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ops: [change.set("runEstimate", { lowUsd: 100, highUsd: estimate })] });
      return (await h.runtime.app.gate.requirement(IMPLICIT_COMPANY_ID, WORKFLOW_DOCUMENT_KIND, taskId))?.risk;
    };
    // A Markdown plan is unread (medium) whatever it says; the request's words and the estimate raise it.
    expect(await tier("Add a /health endpoint")).toBe("medium");
    expect(await tier("Add a /health endpoint and change the IAM policy")).toBe("high");
    expect(await tier("Add a /health endpoint", 150)).toBe("high");
  });

  it("says on the page that a pull request changed outside Rovara when its head is not the one Rovara recorded, and merge tracking is told the head is not Rovara's", async () => {
    const h = await launch({ host: true });
    const { taskId, workspaceId, headBranch, commit } = await toWaitForMerge(h);
    const store = h.runtime.registry.require("storage");
    const pageOf = async () => { const link = await h.browse(`/plan/${taskId}`); return (await raw(h.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } })).body; };
    // The head is the one Rovara recorded: nothing is said.
    expect(await pageOf()).not.toContain("changed outside Rovara");
    expect(await recordedHeadOf(h.runtime.app.flow.deps)(workspaceId, "demo", 1)).toBe(commit);
    // The worker (or anyone) pushes to the branch after its operation ended; the next read of the page, a little later, sees it.
    h.model.commit(headBranch, { "README.md": "pushed after the result\n" });
    h.runtime.app.flow.deps.now = () => new Date(Date.now() + 60_000);
    const body = await pageOf();
    expect(body).toContain("changed outside Rovara");
    expect((await store.get(PR_RECORD(workspaceId)))?.["changedOutside"]).toContain("changed outside Rovara");
    // Merge tracking is given no recorded head for it, so it never reads the head as Rovara's and never calls the pull request ready.
    expect(await recordedHeadOf(h.runtime.app.flow.deps)(workspaceId, "demo", 1)).toBeUndefined();
    // Put back, the mark goes.
    h.model.branches.set(headBranch, commit);
    h.runtime.app.flow.deps.now = () => new Date(Date.now() + 120_000);
    expect(await pageOf()).not.toContain("changed outside Rovara");
    expect(await recordedHeadOf(h.runtime.app.flow.deps)(workspaceId, "demo", 1)).toBe(commit);
  });

  it("keeps the newest post of checks.json, each under its own digest, and no more than eight posts in one operation", async () => {
    const h = await launch();
    const { coding } = await toCoding(h);
    const post = (n: number) => h.callback(coding, "artifacts", { name: "checks.json", mediaType: "application/json", content: JSON.stringify({ round: n }) });
    for (let n = 1; n <= 8; n += 1) expect((await post(n)).status).toBe(200);
    expect((await post(9)).body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    // The same bytes again are the same post, not another.
    expect((await post(8)).status).toBe(200);
    // Any other name is still kept once.
    const once = (content: string) => h.callback(coding, "artifacts", { name: "notes.txt", mediaType: "text/plain", content });
    expect((await once("a")).status).toBe(200);
    expect((await once("b")).body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
  });

  it("refuses an update whose tree is not the reviewed one or whose parents are not the recorded head, and keeps the pull request's record on the head it had", async () => {
    const h = await launch({ host: true });
    const t = await toAppend(h);
    // A commit on the right parent with other code.
    h.model.branches.set("evil", t.commit);
    const evil = h.model.commit("evil", { "src/health.ts": "export const health = 500;\n" });
    h.model.branches.set(t.headBranch, evil);
    expect((await h.callback(t.update, "pull-request-update", { ...t.call, commit: evil })).body).toMatchObject({ error: { code: "STALE_FENCE" } });
    expect(await recordHead(h, t.workspaceId)).toBe(t.commit);
    // The reviewed tree, but not on top of the recorded head.
    const rootless = h.model.commit("main", { "src/health.ts": "export const health = 200; // CI fixed\n" });
    h.model.branches.set(t.headBranch, rootless);
    expect((await h.callback(t.update, "pull-request-update", { ...t.call, commit: rootless })).body).toMatchObject({ error: { code: "STALE_FENCE" } });
    expect(await recordHead(h, t.workspaceId)).toBe(t.commit);
  });

  it("rolls the record back when a push the callback took is refused at the end of the operation", async () => {
    const h = await launch({ host: true });
    const t = await toAppend(h);
    h.model.branches.set(t.headBranch, t.fixCommit);
    expect((await h.callback(t.update, "pull-request-update", t.call)).status).toBe(200);
    expect(await recordHead(h, t.workspaceId)).toBe(t.fixCommit);
    // The run then reports a push of other code than the reviewed tree: it is refused, and the push is not recorded as Rovara's.
    await h.callback(t.update, "result", { status: "SUCCEEDED", result: t.lifecycle(t.fixCommit, "2".repeat(40)) });
    const after = await taskRecord(h, t.taskId);
    expect(after.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
    expect(await recordHead(h, t.workspaceId)).toBe(t.commit);
  });

  it("lets the owner retry a push that stopped: the fix is due again and is pushed when the head is still the recorded one", async () => {
    const h = await launch({ host: true });
    const t = await toAppend(h);
    await h.callback(t.update, "result", { status: "FAILED", error: "the machine was lost" });
    expect((await taskRecord(h, t.taskId)).workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
    expect((await h.api(`/v1/dev/tasks/${t.taskId}/workflow/retry`, { method: "POST", body: { requestId: "abababab-abab-4bab-8bab-abababababab" } })).status).toBe(200);
    const again = await h.nextJob(t.workspaceId, t.seen);
    expect(again).toMatchObject({ kind: "maintain", payload: { action: "append", expectedHeadCommit: t.commit, workflowCandidateTreeSha: t.fixTree } });
  });

  it("does not take a merge of the base on its parents alone: wrong parents are refused, a failed run's merge is not recorded, and a good one is checked and reviewed again before the task waits for the merge", async () => {
    // Wrong parents: not the recorded head and the base commit.
    const a = await launch({ host: true });
    const wrong = await toSync(a);
    wrong.merge("7".repeat(40), "6".repeat(40), [wrong.commit, "5".repeat(40)]);
    expect((await a.callback(wrong.sync, "pull-request-update", wrong.call("7".repeat(40)))).body).toMatchObject({ error: { code: "STALE_FENCE" } });
    expect(await recordHead(a, wrong.workspaceId)).toBe(wrong.commit);

    // A run that failed after pushing a right-looking merge: the merge is not recorded.
    const b = await launch({ host: true });
    const failed = await toSync(b);
    const mergeSha = failed.merge("8".repeat(40), "9".repeat(40), [failed.commit, failed.newBase]);
    expect((await b.callback(failed.sync, "pull-request-update", failed.call(mergeSha))).status).toBe(200);
    await b.callback(failed.sync, "result", { status: "FAILED", error: "the readiness checks failed" });
    const afterFailed = await taskRecord(b, failed.taskId) as unknown as { workflow: { stage: string; branchSync?: unknown; pullRequests: Array<{ headSha: string }> } };
    expect(afterFailed.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", pullRequests: [{ headSha: failed.commit }] });
    expect(afterFailed.workflow.branchSync).toBeUndefined();
    expect(await recordHead(b, failed.workspaceId)).toBe(failed.commit);

    // A good merge: new candidate. The checks run again on it, then the reviews; only then does the task wait for the merge again.
    const c = await launch({ host: true });
    const good = await toSync(c);
    const merged = good.merge("8".repeat(40), "9".repeat(40), [good.commit, good.newBase]);
    expect((await c.callback(good.sync, "pull-request-update", good.call(merged))).status).toBe(200);
    expect((await c.callback(good.sync, "result", { status: "SUCCEEDED", result: good.lifecycle(merged, "9".repeat(40)) })).status).toBe(200);
    const checks = await c.nextJob(good.workspaceId, good.seen);
    expect(checks).toMatchObject({ kind: "task", payload: { workflowMode: "CHECKS" } });
    expect((await taskRecord(c, good.taskId)).workflow).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
    await c.callback(checks, "result", builtResult("9".repeat(40), good.newBase, merged));
    const review = await c.nextJob(good.workspaceId, good.seen);
    expect((await taskRecord(c, good.taskId)).workflow).toMatchObject({ stage: "REVIEW", state: "RUNNING" });
    await c.callback(review, "result", reviewsOf(review, "9".repeat(40), "pass", good.newBase, merged));
    await c.runtime.tick();
    expect((await taskRecord(c, good.taskId)).workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [{ headSha: merged }] });
  });

  it("blocks a merge whose checked code is not the code the host shows (extra changes in the merge)", async () => {
    const h = await launch({ host: true });
    const t = await toSync(h);
    const merged = t.merge("8".repeat(40), "9".repeat(40), [t.commit, t.newBase]);
    await h.callback(t.sync, "pull-request-update", t.call(merged));
    await h.callback(t.sync, "result", { status: "SUCCEEDED", result: t.lifecycle(merged, "9".repeat(40)) });
    const checks = await h.nextJob(t.workspaceId, t.seen);
    // The workspace the checks ran on holds other code than the merge commit the host shows.
    await h.callback(checks, "result", builtResult("4".repeat(40), t.newBase, "3".repeat(40)));
    const blocked = await taskRecord(h, t.taskId);
    expect(blocked.workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(blocked.workflow.blockReason).toContain("other code");
  });

  it("abandons a CI round when a person pushed to the pull request meanwhile, and starts no coding run", async () => {
    const h = await launch({ host: true });
    const w = await toWaitForMerge(h);
    await commitRound(h, w.taskId, (workflow) => startWorkflowFix(workflow, { source: "ci", problems: ["unit-tests"], now: new Date().toISOString() }), "IMPLEMENT");
    h.model.commit(w.headBranch, { "README.md": "a person's change\n" });
    await h.runtime.tick();
    expect((await taskRecord(h, w.taskId)).workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    const operations = await h.runtime.registry.require("storage").query({ pk: `WORKSPACE#${w.workspaceId}`, sk: { op: "beginsWith", prefix: "OPERATION#" } });
    expect(operations.items.filter((item) => item["workflowMode"] === "IMPLEMENT")).toHaveLength(1);
  });

  it("starts one operation when the same dispatch row is run twice at once", async () => {
    const h = await launch();
    const { taskId, workspaceId } = await toCoding(h);
    const deps = h.runtime.app.flow.deps;
    const ref = { taskId, workflowRevision: (await taskRecord(h, taskId)).workflow.revision - 1, kind: "IMPLEMENT" as const };
    const again = await Promise.all([runDispatchRow(deps, ref), runDispatchRow(deps, ref)]);
    expect(again).not.toContain("STARTED");
    const operations = await h.runtime.registry.require("storage").query({ pk: `WORKSPACE#${workspaceId}`, sk: { op: "beginsWith", prefix: "OPERATION#" } });
    expect(operations.items.filter((item) => item["workflowMode"] === "IMPLEMENT")).toHaveLength(1);
  });

  it("keeps a publication across a restart: the result of a draft opened before it is recorded by the new process", async () => {
    const first = await launch({ host: true });
    const { taskId, workspaceId, seen, coding } = await toCoding(first);
    const commit = first.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree = first.model.revision(commit).tree;
    await first.callback(coding, "result", builtResult(tree, first.base, commit));
    const review = await first.nextJob(workspaceId, seen);
    await first.callback(review, "result", reviewsOf(review, tree, "pass", first.base, commit));
    const publish = await first.nextJob(workspaceId, seen);
    const payload = publish.payload as Record<string, unknown>;
    const branch = String(payload["headBranch"]);
    first.model.branches.set(branch, commit);
    await first.callback(publish, "pull-request", { repository: "demo", repositoryUrl: first.project.repositories[0]!.url, headBranch: branch, baseBranch: "main", commit, title: payload["title"], body: payload["body"] });
    await first.runtime.stop();
    const second = await launch({ root: first.root, host: true, model: first.model });
    const result = { repository: "demo", number: 1, url: second.model.crUrl("1"), headBranch: branch, baseBranch: "main", commit, checks: [], reconciled: false, draft: true };
    expect((await second.callback(publish, "result", { status: "SUCCEEDED", result })).status).toBe(200);
    expect((await taskRecord(second, taskId)).workflow).toMatchObject({ stage: "WAIT_FOR_MERGE" });
  });
});

describe("rovara up: the reviews and checks are read against the code and the run that made them", () => {
  async function toReview(h: Harness) {
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    await h.callback(coding, "result", builtResult("d".repeat(40)));
    const review = await h.nextJob(workspaceId, seen);
    return { taskId, workspaceId, seen, review };
  }
  type Harness = Awaited<ReturnType<typeof launch>>;

  it("blocks reviews for other code, from another run, or with a role missing or doubled", async () => {
    const forged: Array<(job: WorkerInvocation) => ReturnType<typeof reviewsOf>> = [
      (job) => reviewsOf(job, "e".repeat(40), "pass"),
      (job) => reviewsOf({ ...job, operationId: "00000000-0000-4000-8000-000000000000" }, "d".repeat(40), "pass"),
      (job) => { const r = reviewsOf(job, "d".repeat(40), "pass"); (r.result.workflowReviews as unknown[]).pop(); return r; },
      (job) => { const r = reviewsOf(job, "d".repeat(40), "pass"); (r.result.workflowReviews as unknown[]).push((r.result.workflowReviews as unknown[])[0]); return r; },
    ];
    for (const make of forged) {
      const h = await launch();
      const { taskId, review } = await toReview(h);
      await h.callback(review, "result", make(review));
      // Whatever the reports said, the reviews did not pass: the task is still at its reviews (blocked, or run again by Rovara's one automatic retry), and no pull request is due.
      const after = await taskRecord(h, taskId);
      expect(after.workflow.stage).toBe("REVIEW");
      expect(["BLOCKED", "RUNNING"]).toContain(after.workflow.state);
    }
  });

  it("reruns the checks when the owner retries a failed check, and the rerun's code must be the code the task holds", async () => {
    const h = await launch({ host: true, readiness: true });
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    const commit = h.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree = h.model.revision(commit).tree;
    const failedCheck = { id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "failed", class: "regression", output: "1 failing", durationMs: 5, exitCode: 1 };
    const withCheck = (entry: object, status: string) => { const r = builtResult(tree, h.base, commit); (r.result as Record<string, unknown>)["checks"] = { ...CHECK_REPORT, status, source: "project", notVerifiedReason: undefined, checks: [entry] }; return r; };
    await h.callback(coding, "result", withCheck(failedCheck, "regression"));
    expect((await taskRecord(h, taskId)).workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    // Rovara asks (the fault cannot be told from the original code) rather than sending a failed check back on a guess.
    expect((await taskRecord(h, taskId)).autofixAsk).toMatchObject({ reason: "unclear-fault" });
    expect((await h.api(`/v1/dev/tasks/${taskId}/workflow/retry`, { method: "POST", body: { requestId: "abababab-abab-4bab-8bab-abababababab" } })).status).toBe(200);
    const rerun = await h.nextJob(workspaceId, seen);
    expect(rerun).toMatchObject({ payload: { workflowMode: "CHECKS", readiness: [{ executable: "npm" }] } });
    await h.callback(rerun, "result", withCheck({ ...failedCheck, after: "passed", class: "passing", exitCode: 0, output: "" }, "verified"));
    const review = await h.nextJob(workspaceId, seen);
    expect(review).toMatchObject({ payload: { workflowMode: "REVIEW" } });
  });

  it("keeps the evidence of a run's checks when they are recorded (write-once, the pack replaced only on a re-check of the same code), and the proof page shows it (lane L12 slice 3)", async () => {
    const h = await launch({ host: true, readiness: true });
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    const commit = h.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree = h.model.revision(commit).tree;
    const digest = createCandidateManifest(candidateOf(tree, h.base, commit)).digest;
    const check = (after: string, cls: string) => ({ id: "readiness:0", label: "npm test", source: "project", before: "passed", after, class: cls, output: after === "failed" ? "1 failing" : "", durationMs: 5, exitCode: after === "failed" ? 1 : 0 });
    const withCheck = (entry: object, status: string) => { const r = builtResult(tree, h.base, commit); (r.result as Record<string, unknown>)["checks"] = { ...CHECK_REPORT, status, source: "project", notVerifiedReason: undefined, checks: [entry] }; return r; };
    const owner = (await taskRecord(h, taskId)) as unknown as { ownerKey: string };
    // A coding run whose check failed: the verification is recorded (as failed), and so is its evidence, which says "failed" and that no test details were captured.
    await h.callback(coding, "result", withCheck(check("failed", "regression"), "regression"));
    const first = await h.runtime.app.evidence.packOf({ ownerKey: owner.ownerKey, workspaceId, taskId }, digest);
    expect(first).toMatchObject({ checks: [{ checkId: "readiness:0", after: "failed" }] });
    expect(first?.checks[0]?.tests).toBeUndefined();
    expect(first?.notTested.some((item) => item.id === "evidence_capture")).toBe(true);
    // The owner retries; the rerun of the checks (the same code) asks the worker to save the raw parts of its evidence, and the worker does.
    expect((await h.api(`/v1/dev/tasks/${taskId}/workflow/retry`, { method: "POST", body: { requestId: "abababab-abab-4bab-8bab-abababababab" } })).status).toBe(200);
    const rerun = await h.nextJob(workspaceId, seen);
    expect(rerun).toMatchObject({ payload: { workflowMode: "CHECKS", evidenceCapture: true } });
    const raw = { schemaVersion: 1, candidateDigest: digest, checks: [{ checkId: "readiness:0", tests: { total: 12, passed: 12, failed: 0, skipped: 0, errored: 0, names: [], newTests: [] } }] };
    expect((await h.callback(rerun, "artifacts", { name: "evidence-raw.json", mediaType: "application/json", content: JSON.stringify(raw) })).status).toBe(200);
    await h.callback(rerun, "result", withCheck(check("passed", "passing"), "verified"));
    const pack = await h.runtime.app.evidence.packOf({ ownerKey: owner.ownerKey, workspaceId, taskId }, digest);
    // ... and replaces the earlier pack for that code (the one object the keeper overwrites on purpose).
    expect(pack).toMatchObject({ candidateDigest: digest, checks: [{ checkId: "readiness:0", kind: "test", after: "passed", tests: { total: 12, passed: 12 } }] });
    // The proof page of the task shows the checks, the reviews' absence and the evidence, in the broker's words.
    const review = await h.nextJob(workspaceId, seen);
    await h.callback(review, "result", reviewsOf(review, tree, "pass", h.base, commit));
    const link = await h.browse(`/proof/${taskId}`);
    const page = await raw_(h, link);
    expect(page.status).toBe(200);
    expect(page.body).toContain("npm test");
    expect(page.body).toContain("Evidence kept for this code");
    expect(page.body).toContain("Code review");
    expect(page.body).toContain("12 passed");
    // Objects are write-once: the same pack key cannot be written again without the opt-in that the keeper itself uses for a re-check of the same code.
    const key = `private/${owner.ownerKey}/${workspaceId}/evidence-pack/${taskId}/${digest}.json`;
    await expect(h.runtime.app.blobs.put(key, new Uint8Array([1]), { contentType: "application/json", metadata: {}, retention: "evidence-std" })).rejects.toThrow(/already stored/);
  });

  it("retries a review whose run was lost once by itself, and asks when it is lost again; a review that failed for its own reasons is asked about at once", async () => {
    const h = await launch();
    const { taskId, workspaceId, seen, review } = await toReview(h);
    const lose = (job: WorkerInvocation) => h.runtime.app.flow.recordResult({ workspaceId: job.workspaceId, operationId: job.operationId, fence: job.fence, status: "INTERRUPTED", error: "the machine was lost" });
    await lose(review);
    const again = await h.nextJob(workspaceId, seen);
    expect(again).toMatchObject({ payload: { workflowMode: "REVIEW" } });
    expect((await taskRecord(h, taskId)).workflow.decisions.filter((decision) => decision.source === "AUTO_RETRY")).toHaveLength(1);
    await lose(again);
    const asked = await taskRecord(h, taskId);
    expect(asked.workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expect(asked.autofixAsk).toBeDefined();
    // A run that ended failed on its own is not the infrastructure's fault: the owner is asked, nothing is retried.
    const g = await launch();
    const failed = await toReview(g);
    await g.callback(failed.review, "result", { status: "FAILED", error: "the model did not answer" });
    expect((await taskRecord(g, failed.taskId)).autofixAsk).toBeDefined();
    expect((await taskRecord(g, failed.taskId)).workflow.decisions.filter((decision) => decision.source === "AUTO_RETRY")).toHaveLength(0);
  });

  it("asks the owner when the task's spend cannot be read, and sends back with nothing priced", async () => {
    const h = await launch();
    h.runtime.app.flow.deps.taskSpendUsd = async () => { throw new Error("the ledger is not readable"); };
    const { taskId, review } = await toReview(h);
    await h.callback(review, "result", reviewsOf(review, "d".repeat(40), "findings"));
    expect((await taskRecord(h, taskId)).autofixAsk).toMatchObject({ reason: "inputs-missing" });
    const g = await launch();
    g.runtime.app.flow.deps.taskSpendUsd = async () => undefined;
    const unpriced = await toReview(g);
    await g.callback(unpriced.review, "result", reviewsOf(unpriced.review, "d".repeat(40), "findings"));
    expect((await taskRecord(g, unpriced.taskId)).workflow.decisions.filter((decision) => decision.source === "AUTO_FIX")).toHaveLength(1);
  });
});

// ---- lane L12: merge tracking by polling

/** A clock a test moves; the app reads it for the records, the sessions and the tracking timer's schedule. */
function movingClock() {
  const clock = { at: Date.now(), now: (): Date => new Date(clock.at), advance: (ms: number): void => { clock.at += ms; } };
  return clock;
}
const passingCheck = (name = "unit-tests", runId = "run-1"): Check => ({ name, state: "completed", conclusion: "success", required: false, url: "", runId });
const failingCheck = (name = "unit-tests", runId = "run-1"): Check => ({ name, state: "completed", conclusion: "failure", required: false, url: "", runId });

describe("rovara up: merge tracking by polling, against a fake code host and a moving clock (lane L12 slice 1)", () => {
  const MINUTE = 60_000;
  type Harness = Awaited<ReturnType<typeof launch>>;
  const store = (h: Harness) => h.runtime.registry.require("storage");
  const trackingRow = async (h: Harness, taskId: string) => (await store(h).get({ pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${taskId}` }))!;
  const trackingItem = async (h: Harness, taskId: string) => (await store(h).get({ pk: `DEVTASK#${taskId}`, sk: "MERGE_TRACKING#demo#000000000001" }))
    ?? (await store(h).query({ pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "MERGE_TRACKING#" } })).items[0];
  const sessionLines = async (h: Harness, taskId: string): Promise<string[]> => {
    const sessionId = (await store(h).get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["sessionId"] as string;
    return (await readSessionEvents(store(h), IMPLICIT_COMPANY_ID, sessionId as never)).events.map((event) => event.text ?? "");
  };
  /** Counts the pull request reads the host was asked for. */
  const countReads = (h: Harness) => {
    let reads = 0;
    const original = h.host.changeRequestStatus.bind(h.host);
    h.host.changeRequestStatus = async (...args) => { reads += 1; return original(...args); };
    return () => reads;
  };

  it("reads a due pull request, takes a draft out of draft when its checks pass, tells the session, and waits longer while nothing changes", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const waiting = await toWaitForMerge(h);
    const reads = countReads(h);
    const cr = h.model.changeRequests[0]!;
    expect(cr.draft).toBe(true);
    // The publish step enrolled the task: a numeric due time, and no pass yet.
    expect(typeof (await trackingRow(h, waiting.taskId))["nextAttemptAt"]).toBe("number");
    // Checks still running: the first pass reads the pull request, writes its item, and leaves the draft alone.
    h.model.setChecks(waiting.commit, [{ name: "unit-tests", state: "pending", required: false, url: "", runId: "run-1" }]);
    await h.runtime.tick();
    expect(reads()).toBe(1);
    expect(cr.draft).toBe(true);
    expect(await trackingItem(h, waiting.taskId)).toMatchObject({ ci: "pending", draft: true, state: "open", headByRovara: true });
    // Not due again yet: a tick a few seconds later asks the host nothing.
    clock.advance(10_000);
    await h.runtime.tick();
    expect(reads()).toBe(1);
    // The checks pass; the next pass is due after a minute and takes the pull request out of draft. Merge tracking never merges.
    h.model.setChecks(waiting.commit, [passingCheck()]);
    clock.advance(MINUTE);
    await h.runtime.tick();
    expect(reads()).toBe(2);
    expect(cr.draft).toBe(false);
    expect(cr.state).toBe("open");
    expect(await trackingItem(h, waiting.taskId)).toMatchObject({ ci: "passing", draft: false, readyAt: expect.stringMatching(/^2/) as unknown });
    expect(await sessionLines(h, waiting.taskId)).toContain("Rovara marked demo pull request 1 ready for review.");
    // Nothing changes: each quiet pass waits longer (60 s, then 2 minutes, then 4, up to 5), so the host is asked less and less.
    const waits: number[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      clock.advance(5 * MINUTE);
      await h.runtime.tick();
      waits.push(((await trackingRow(h, waiting.taskId))["nextAttemptAt"] as number) - clock.at);
    }
    expect(waits).toEqual([2 * MINUTE, 4 * MINUTE, 5 * MINUTE, 5 * MINUTE]);
    expect(cr.state).toBe("open");
    // The session reads "ready to merge" for a task that waits for it.
    expect(await h.runtime.app.flow.deps.store.get({ pk: `DEVTASK#${waiting.taskId}`, sk: "META" })).toMatchObject({ workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" } });
  });

  it("fixes failing CI by itself when the timer sees it, pushes the reviewed fix, and announces the approval that makes the pull request ready to merge", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const waiting = await toWaitForMerge(h);
    const { taskId, workspaceId, seen, commit } = waiting;
    const cr = h.model.changeRequests[0]!;
    h.model.setChecks(commit, [passingCheck()]);
    await h.runtime.tick();
    expect(cr.draft).toBe(false);
    // CI goes red on Rovara's own head: the next pass decides a round, records "fixing" on the session, and the coding run starts without anyone asking.
    h.model.setChecks(commit, [failingCheck()]);
    clock.advance(2 * MINUTE);
    await h.runtime.tick();
    expect(await taskRecord(h, taskId)).toMatchObject({ workflow: { stage: "IMPLEMENT" } });
    expect(await sessionLines(h, taskId)).toContainEqual(expect.stringMatching(/^CI is failing on unit-tests, so Rovara is fixing it \(round 1 of 3\)\.$/));
    const fix = await h.nextJob(workspaceId, seen);
    expect(fix).toMatchObject({ payload: { workflowMode: "IMPLEMENT", workflowFix: { source: "ci", startFrom: commit } } });
    h.model.branches.set("fix", commit);
    const fixCommit = h.model.commit("fix", { "src/health.ts": "export const health = 200; // CI fixed\n" });
    const fixTree = h.model.revision(fixCommit).tree;
    await h.callback(fix, "result", builtResult(fixTree, h.base, fixCommit));
    const review = await h.nextJob(workspaceId, seen);
    await h.callback(review, "result", reviewsOf(review, fixTree, "pass", h.base, fixCommit));
    const update = await h.nextJob(workspaceId, seen);
    h.model.branches.set(waiting.headBranch, fixCommit);
    const call = { repository: "demo", pullRequestNumber: 1, action: "append", headBranch: waiting.headBranch, baseBranch: "main", previousCommit: commit, commit: fixCommit };
    expect((await h.callback(update, "pull-request-update", call)).status).toBe(200);
    expect((await h.callback(update, "result", { status: "SUCCEEDED", result: { action: "append", repository: "demo", number: 1, url: h.model.crUrl("1"), state: "open", headBranch: waiting.headBranch, baseBranch: "main", previousCommit: commit, commit: fixCommit, treeSha: fixTree, checks: [], reconciled: false } })).status).toBe(200);
    expect(await taskRecord(h, taskId)).toMatchObject({ workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" } });
    // The new head passes; a writer approves it. Tracking reads both and says, once, that the pull request is ready to merge.
    h.model.setChecks(fixCommit, [passingCheck()]);
    h.model.setAccount("dana", "write");
    h.model.addReview(cr.id, { login: "dana", state: "APPROVED", revision: fixCommit });
    clock.advance(2 * MINUTE);
    await h.runtime.tick();
    expect(await trackingItem(h, taskId)).toMatchObject({ ci: "passing", review: "approved", headSha: fixCommit, headByRovara: true });
    const lines = await sessionLines(h, taskId);
    expect(lines.filter((line) => line.startsWith("Approved by dana. Ready to merge"))).toHaveLength(1);
    // A further pass says nothing twice, and presses nothing: the pull request is still open.
    clock.advance(5 * MINUTE);
    await h.runtime.tick();
    expect((await sessionLines(h, taskId)).filter((line) => line.startsWith("Approved by dana"))).toHaveLength(1);
    expect(cr.state).toBe("open");
    await h.runtime.tick();
    const listed = await listSessions(store(h), IMPLICIT_COMPANY_ID, developerIdOf(localOwnerPrincipal()));
    expect(listed.sessions[0]).toMatchObject({ summary: { display: { state: "ready_to_merge" } } });
  });

  it("records a merge made on the code host: the task is merged, the session says so, and the pull request is not read again", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const { taskId, commit } = await toWaitForMerge(h);
    const cr = h.model.changeRequests[0]!;
    h.model.setChecks(commit, [passingCheck()]);
    await h.runtime.tick();
    expect(cr.draft).toBe(false);
    // A person merges it on the code host. Rovara did not press anything.
    expect(h.model.merge(cr.id, { revision: commit, method: "squash" })).toMatchObject({ outcome: "merged" });
    clock.advance(2 * MINUTE);
    await h.runtime.tick();
    expect(await taskRecord(h, taskId)).toMatchObject({ workflow: { stage: "MERGED", state: "COMPLETE", pullRequests: [{ state: "MERGED" }] } });
    expect(await sessionLines(h, taskId)).toEqual(expect.arrayContaining(["Merged on the code host by rovara-user; no approval was recorded.", "Merged."]));
    // The task is over: its tracking row is gone and no further pass reads it.
    expect(await store(h).get({ pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${taskId}` })).toBeUndefined();
    const reads = countReads(h);
    clock.advance(20 * MINUTE);
    await h.runtime.tick();
    expect(reads()).toBe(0);
  });


  it("lists the changed files from the code host after the push, not from the worker's report: a worker that leaves a sensitive file out cannot lower the risk (review H3)", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    // The worker reports one harmless file; the commit also changes a CI workflow.
    const { taskId, cr, openingBody } = await published(h, { "src/health.ts": "export const health = 200;\n", ".github/workflows/ci.yml": "name: ci\n" }, diffOf("src/health.ts"));
    // At opening nothing is verified: the description cannot list the files, and the risk is HIGH and says why (the worker's list is not believed).
    expect(openingBody).toContain("couldn't list the changed files");
    expect(openingBody).toContain("## Risk: High");
    expect(openingBody).toContain("Rovara has not yet checked which files changed against the code host.");
    expect(openingBody).toContain("## Lessons used");
    expect(((await taskRecord(h, taskId)).workflow as unknown as { risk?: { level: string } }).risk?.level).toBe("high");
    // The next tracking pass reads the files from the code host: the description now lists BOTH files and the risk names the CI workflow.
    await h.runtime.tick();
    expect(cr.body).toContain("2 files changed");
    expect(cr.body).toContain(".github/workflows/ci.yml");
    expect(cr.body).toContain("- src/health.ts");
    expect(cr.body).toContain("## Risk: High");
    expect(cr.body).toContain("Changes sensitive paths: .github/workflows/ci.yml");
    // The proof page shows the worker's list only as unchecked.
    const link = await h.browse(`/proof/${taskId}`);
    const proof = await raw(h.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
    expect(proof.body).toContain("Changed files, read from the code host: 2");
    expect(proof.body).toContain("The worker reported 1 changed file");
    expect(proof.body).toContain("has not checked that list and does not use it");
  });

  it("N1: verifies nothing when the host shows another head than the one Rovara checked, and keeps the risk high (the head-moved guard)", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const { taskId, cr, workspaceId, openingBody } = await published(h, { "src/health.ts": "export const health = 200;\n" }, undefined);
    // Someone pushes to the branch before the pass reads the files.
    h.model.commit(cr.sourceBranch, { "src/sneaky.ts": "export const sneaky = 1;\n" });
    await h.runtime.tick();
    expect(await verifiedChangedFiles(h.runtime.app.flow.deps, workspaceId, ((await taskRecord(h, taskId)).workflow as unknown as { candidate: { digest: string } }).candidate.digest)).toBeUndefined();
    expect(((await taskRecord(h, taskId)).workflow as unknown as { risk?: { level: string } }).risk?.level).toBe("high");
    expect(cr.body).toBe(openingBody);
  });

  it("N2: a description a person edited is left as they left it, though the files are verified and the risk is judged", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const { taskId, cr } = await published(h, { "src/health.ts": "export const health = 200;\n" }, undefined);
    cr.body = "Dana's own words about this change.";
    await h.runtime.tick();
    expect(cr.body).toBe("Dana's own words about this change.");
    expect(((await taskRecord(h, taskId)).workflow as unknown as { risk?: { level: string } }).risk?.level).not.toBe("high");
    // An edit that lands between the first read and the write is caught by the read right before the write.
    const g = await launch({ host: true, now: clock.now });
    const other = await published(g, { "src/health.ts": "export const health = 200;\n" }, undefined);
    const original = g.host.getChangeRequest.bind(g.host);
    let reads = 0;
    g.host.getChangeRequest = async (...args) => { const answer = await original(...args); reads += 1; if (reads === 2) other.cr.body = "edited in between"; return answer; };
    await g.runtime.tick();
    expect(other.cr.body).toBe("edited in between");
  });

  it("reads a harmless change below high once the code host has listed its files, and keeps it high until then", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const { taskId, cr, openingBody } = await published(h, { "src/health.ts": "export const health = 200;\n" }, undefined);
    expect(openingBody).toContain("## Risk: High");
    // A host that cannot list the files now leaves the risk high; the next pass tries again.
    const original = h.host.changedFiles.bind(h.host);
    h.host.changedFiles = async () => { throw new Error("the host is down"); };
    await h.runtime.tick();
    expect(((await taskRecord(h, taskId)).workflow as unknown as { risk?: { level: string } }).risk?.level).toBe("high");
    h.host.changedFiles = original;
    clock.advance(2 * MINUTE);
    await h.runtime.tick();
    const risk = ((await taskRecord(h, taskId)).workflow as unknown as { risk?: { level: string } }).risk?.level;
    expect(risk).not.toBe("high");
    expect(cr.body).toContain("1 file changed");
    expect(cr.body).toContain("- src/health.ts (+2 -0)");
    expect(cr.body).not.toContain("## Risk: High");
    // A description a person edited is left as they left it.
    expect(cr.body).toContain("None. This install does not use lessons yet.");
  });

  it("backs off when the code host says slow down, pauses every row until the time it names, and goes on after", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const waiting = await toWaitForMerge(h);
    const reads = countReads(h);
    h.model.rateLimitedUntil = clock.at + 10 * MINUTE;
    await h.runtime.tick();
    expect(reads()).toBe(1);
    expect(h.runtime.app.tracking.pausedUntil()).toBe(clock.at + 10 * MINUTE);
    // The row waits for the host's time at least, and a tick inside it asks nothing.
    expect((await trackingRow(h, waiting.taskId))["nextAttemptAt"]).toBeGreaterThanOrEqual(clock.at + 10 * MINUTE);
    clock.advance(5 * MINUTE);
    await h.runtime.tick();
    expect(reads()).toBe(1);
    // The host is open again and the time has passed: the pass reads and records the pull request.
    h.model.rateLimitedUntil = undefined;
    clock.advance(6 * MINUTE);
    await h.runtime.tick();
    expect(reads()).toBe(2);
    expect(h.runtime.app.tracking.pausedUntil()).toBeUndefined();
    expect(await trackingItem(h, waiting.taskId)).toMatchObject({ state: "open" });
  });
});

/** A task through publication with the given files in its commit, and the worker's own report of what it changed (its `workspace.diff`) as given. */
async function published(h: Awaited<ReturnType<typeof launch>>, files: Record<string, string>, reportedDiff: string | undefined) {
  const { taskId, workspaceId, seen, coding } = await toCoding(h);
  const commit = h.model.commit("work", files);
  const tree = h.model.revision(commit).tree;
  if (reportedDiff !== undefined) await h.callback(coding, "artifacts", { name: "workspace.diff", mediaType: "text/plain", content: reportedDiff });
  await h.callback(coding, "result", builtResult(tree, h.base, commit));
  const review = await h.nextJob(workspaceId, seen);
  await h.callback(review, "result", reviewsOf(review, tree, "pass", h.base, commit));
  const publish = await h.nextJob(workspaceId, seen);
  const payload = publish.payload as Record<string, unknown>;
  const headBranch = String(payload["headBranch"]);
  h.model.branches.set(headBranch, commit);
  await h.callback(publish, "pull-request", { repository: "demo", repositoryUrl: h.project.repositories[0]!.url, headBranch, baseBranch: "main", commit, title: payload["title"], body: payload["body"] });
  const cr = h.model.changeRequests.find((entry) => entry.sourceBranch === headBranch)!;
  await h.callback(publish, "result", { status: "SUCCEEDED", result: { repository: "demo", number: Number(cr.id), url: h.model.crUrl(cr.id), headBranch, baseBranch: "main", commit, checks: [], reconciled: false, draft: true } });
  return { taskId, workspaceId, commit, cr, openingBody: String(payload["body"]) };
}
const diffOf = (path: string) => `## demo\n### status\n M ${path}\n### diff\ndiff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;
/** Counts the pull request reads the host is asked for from now on. */
const countReadsOf = (h: Awaited<ReturnType<typeof launch>>) => {
  let reads = 0;
  const original = h.host.changeRequestStatus.bind(h.host);
  h.host.changeRequestStatus = async (...args) => { reads += 1; return original(...args); };
  return () => reads;
};

/** The owner attaches a thread on the task's page, as a person would (a form of the page session; the API token cannot). */
async function attachThreadOnPage(h: Awaited<ReturnType<typeof launch>>, taskId: string, number: number, repository = "demo"): Promise<string> {
  const link = await h.browse(`/plan/${taskId}`);
  const page = await raw(h.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
  const form = formOf(page.body, "/thread");
  const post = await raw(h.runtime.pagesUrl, { method: "POST", path: form.action, body: formBody({ ...form.fields, repository, number: String(number) }), headers: { host: link.host, origin: h.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
  return String(post.headers["location"]);
}
const noticeOf = (short: string): string => `Plan version ${short} is waiting for a decision. To approve it, say /rovara approve ${short}. To ask for changes, say /rovara changes: and what to change.`;

describe("rovara up: pull request comment commands, polled through the code host and checked by the core (lane L12 slice 2, decision 66)", () => {
  const MINUTE = 60_000;
  type Harness = Awaited<ReturnType<typeof launch>>;
  const store = (h: Harness) => h.runtime.registry.require("storage");

  /** A task whose plan waits for approval, with a thread (a pull request on the host) the owner says the plan is posted on. */
  async function planOnThread(options: { clock: ReturnType<typeof movingClock> }) {
    const h = await launch({ host: true, now: options.clock.now });
    const planned = await toPlanReview(h);
    h.model.commit("design-discussion", { "NOTES.md": "# notes\n" });
    const thread = h.model.reconcile({ sourceBranch: "design-discussion", targetBranch: "main", title: "Discussion of the plan" }).cr;
    // Only the owner, on the task's page, can say where the plan is posted; only a repository of the task's own project can be named.
    expect(await attachThreadOnPage(h, planned.taskId, Number(thread.id), "elsewhere")).toContain("n=refused");
    expect(await attachThreadOnPage(h, planned.taskId, Number(thread.id))).toContain("n=attached");
    h.model.setAccount("dana", "write");
    h.model.setAccount("rita", "read");
    /** The fake host's own clock, lined up with the app's. */
    const write = (ms: number, author: string, body: string) => { h.model.setNow(new Date(options.clock.at + ms - 1_000).toISOString()); return h.model.addDiscussionComment(thread.id, author, body); };
    const workflowOf = async () => (await taskRecord(h, planned.taskId)).workflow;
    /** What the decision gate says to a comment offered as the proof, for the plan as it waits now. */
    const offer = approvalOfferOf(planned.taskId, (await store(h).get({ pk: `DEVTASK#${planned.taskId}`, sk: "META" }))!["workflow"] as unknown as WorkflowSnapshot)!;
    const viaGate = async (commentId: string, requestId = offer.requestId) => {
      return h.runtime.app.gate.decide({
        companyId: IMPLICIT_COMPANY_ID, kind: WORKFLOW_DOCUMENT_KIND, subjectId: planned.taskId, requestId, outcome: "approve", seen: { revision: offer.revision, artifactDigest: offer.artifactDigest },
        credentials: [{ method: "code-host-comment", token: commentId }],
      });
    };
    const poll = async () => { options.clock.advance(MINUTE + 1_000); await h.runtime.tick(); };
    const repliesOnThread = () => thread.comments.filter((comment) => comment.body.includes(ROVARA_REPLY_MARKER)).map((comment) => comment.body.split("\n")[0]);
    /** The words that approve exactly the version that waits (its notice names it). */
    const short = shortDigest(offer.artifactDigest);
    return { h, ...planned, thread, write, workflowOf, viaGate, poll, repliesOnThread, short, offer };
  }

  it("runs a plan approval from a writer's comment, and refuses a wrong thread, a stale or edited comment, a read-only author and a reused comment, each decided in the core", async () => {
    const clock = movingClock();
    const w = await planOnThread({ clock });
    const { h, taskId } = w;
    const waiting = async () => expect(await w.workflowOf()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });

    // WRONG THREAD: the host reports a comment as being on another change request than the one the plan was posted on. The core refuses; the host is never asked what it means.
    const wrongThread = w.write(5_000, "rita", `/rovara approve ${w.short}`);
    const original = h.host.comments.bind(h.host);
    h.host.comments = async (...args) => { const page = await original(...args); return { ...page, comments: page.comments.map((comment) => (comment.id === wrongThread.id ? { ...comment, ref: { ...comment.ref, id: "77" } } : comment)) }; };
    expect(await w.viaGate(wrongThread.id)).toMatchObject({ status: "refused", reason: "not_approved", detail: expect.stringContaining("comment_on_other_change") as unknown });
    h.host.comments = original;

    // STALE: written before the plan was posted (the thread's clock is earlier than the plan's).
    h.model.setNow(new Date(clock.at - 3_600_000).toISOString());
    const stale = h.model.addDiscussionComment(w.thread.id, "dana", `/rovara approve ${w.short}`);
    expect(await w.viaGate(stale.id)).toMatchObject({ status: "refused", detail: expect.stringContaining("comment_before_request") as unknown });

    // EDITED: the host records an edit, so the comment is never a proof, whatever it says now.
    const edited = w.write(10_000, "dana", "looks fine");
    h.model.setNow(new Date(clock.at + 11_000).toISOString());
    h.model.editDiscussionComment(w.thread.id, edited.id, `/rovara approve ${w.short}`);
    expect(await w.viaGate(edited.id)).toMatchObject({ status: "refused", detail: expect.stringContaining("comment_edited") as unknown });

    // READ-ONLY AUTHOR and a plain remark: polled and dropped; nothing is decided and Rovara says nothing.
    w.write(15_000, "rita", `/rovara approve ${w.short}`);
    w.write(16_000, "dana", "one question about the second step");
    const readOnly = w.write(17_000, "rita", `/rovara approve ${w.short}`);
    expect(await w.viaGate(readOnly.id)).toMatchObject({ status: "refused", detail: expect.stringContaining("not_a_collaborator") as unknown });
    await w.poll();
    await waiting();
    // Rovara posted ONE notice naming the version that waits, and said nothing to a reader or a remark.
    expect(w.repliesOnThread()).toEqual([noticeOf(w.short)]);

    // A FRESH `/rovara approve` from a writer on the plan's thread approves the plan: the flow goes on to coding, recorded as the writer's decision (a project approver), never the owner's.
    const approving = w.write(2 * MINUTE, "dana", `/rovara approve ${w.short}`);
    await w.poll();
    expect(await w.workflowOf()).toMatchObject({ stage: "IMPLEMENT" });
    const decision = (await w.workflowOf()).decisions.at(-1) as { decision: string; actorRole?: string };
    expect(decision).toMatchObject({ decision: "APPROVE" });
    expect(decision.actorRole).not.toBe("TASK_OWNER");
    expect(w.repliesOnThread()).toEqual([noticeOf(w.short), "Approved."]);

    // REUSED: the same comment cannot approve again, here or anywhere; Rovara's own reply (it carries the marker) is never read as a command; a later poll does nothing more.
    expect(await w.viaGate(approving.id)).toMatchObject({ status: "replayed" });
    expect(await w.viaGate(approving.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toMatchObject({ status: "refused" });
    await w.poll();
    expect(w.repliesOnThread()).toEqual([noticeOf(w.short), "Approved."]);
    expect((await taskRecord(h, taskId)).workflow.decisions.filter((entry) => entry.source === undefined && (entry as { decision?: string }).decision === "APPROVE")).toHaveLength(1);
  });

  it("sends a plan back from a writer's `/rovara changes:` comment, with the words in the next plan's prompt, and ignores a command on a thread the plan is not on", async () => {
    const clock = movingClock();
    const w = await planOnThread({ clock });
    const { h } = w;
    h.model.commit("unrelated", { "OTHER.md": "# other\n" });
    const other = h.model.reconcile({ sourceBranch: "unrelated", targetBranch: "main", title: "Something else" }).cr;
    h.model.setNow(new Date(clock.at + 4_000).toISOString());
    h.model.addDiscussionComment(other.id, "dana", `/rovara approve ${w.short}`);
    w.write(5_000, "dana", "/rovara changes: keep the old endpoint too");
    await w.poll();
    expect(await w.workflowOf()).toMatchObject({ stage: "PLAN" });
    expect(w.repliesOnThread()).toEqual([noticeOf(w.short), "Sent back."]);
    const feedback = await store(h).query({ pk: `DEVTASK#${w.taskId}`, sk: { op: "beginsWith", prefix: "PLAN_FEEDBACK" } });
    expect(JSON.stringify(feedback.items)).toContain("keep the old endpoint too");
  });

  it("stops polling comments while the code host asks to slow down, and offers the comment way only while a host can read comments", async () => {
    const clock = movingClock();
    const w = await planOnThread({ clock });
    const { h } = w;
    expect(h.runtime.app.comments.available()).toBe(true);
    h.model.rateLimitedUntil = clock.at + 10 * MINUTE;
    w.write(5_000, "dana", "/rovara changes: x");
    await w.poll();
    expect(h.runtime.app.tracking.pausedUntil()).toBe(clock.at - MINUTE - 1_000 + 10 * MINUTE);
    expect(await w.workflowOf()).toMatchObject({ stage: "PLAN_REVIEW" });
  });
});

describe("rovara up: Rovara's ask and the pull request's state on the task page and in the sessions, answered from the page (lane L12 slice 4)", () => {
  const MINUTE = 60_000;
  type Harness = Awaited<ReturnType<typeof launch>>;
  const store = (h: Harness) => h.runtime.registry.require("storage");
  const pageOf = async (h: Harness, taskId: string) => {
    const link = await h.browse(`/plan/${taskId}`);
    return { link, ...(await raw(h.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } })) };
  };
  const post = (h: Harness, link: URL, action: string, fields: Record<string, string>) => raw(h.runtime.pagesUrl, { method: "POST", path: action, body: formBody(fields), headers: { host: link.host, origin: h.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
  const sessionOf = async (h: Harness) => (await listSessions(store(h), IMPLICIT_COMPANY_ID, developerIdOf(localOwnerPrincipal()))).sessions[0]!;

  it("shows why Rovara asks, in its fixed words, and runs the step again from a Retry on the page", async () => {
    const h = await launch();
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    let job = coding;
    for (const [round, tree] of ["1", "2", "3"].map((digit) => digit.repeat(40)).entries()) {
      await h.callback(job, "result", builtResult(tree));
      const review = await h.nextJob(workspaceId, seen);
      await h.callback(review, "result", reviewsOf(review, tree, "findings"));
      if (round === 2) break;
      job = await h.nextJob(workspaceId, seen);
    }
    await h.runtime.tick();
    // The session says the task needs the owner, and why, in the status model's words.
    expect((await sessionOf(h)).summary).toMatchObject({ display: { state: "needs_you", reason: expect.stringContaining("sent this back to coding twice") as unknown } });
    const page = await pageOf(h, taskId);
    expect(page.body).toContain("Rovara asks");
    expect(page.body).toContain("I already sent this back to coding twice for this plan");
    expect(page.body).toContain("The reviews found problems in this code.");
    // Retry from the page: the owner's form, once; the step runs again.
    const form = formOf(page.body, "/retry");
    const sent = await post(h, page.link, form.action, form.fields);
    expect(sent.headers["location"]).toContain("n=retried");
    expect((await post(h, page.link, form.action, form.fields)).headers["location"]).toContain("n=form");
    expect(await h.nextJob(workspaceId, seen)).toMatchObject({ payload: { workflowMode: "REVIEW" } });
  });

  it("refuses a Retry for a page that is out of date", async () => {
    const h = await launch();
    const { taskId, workspaceId, seen, coding } = await toCoding(h);
    await h.callback(coding, "result", builtResult("1".repeat(40)));
    const review = await h.nextJob(workspaceId, seen);
    await h.callback(review, "result", { status: "FAILED", error: "the review stopped" });
    await h.runtime.tick();
    expect((await taskRecord(h, taskId)).workflow).toMatchObject({ state: "BLOCKED" });
    const page = await pageOf(h, taskId);
    const form = formOf(page.body, "/retry");
    // The owner retries from the API meanwhile; the page's form is for an older revision and is refused as stale, not run twice.
    expect((await h.api(`/v1/dev/tasks/${taskId}/workflow/retry`, { method: "POST", body: { requestId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd" } })).status).toBe(200);
    expect((await post(h, page.link, form.action, form.fields)).headers["location"]).toContain("n=stale");
  });

  it("shows where the pull request stands while it waits for its checks and when it is ready to merge, on the page and in the session, and never merges", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const { taskId, commit } = await toWaitForMerge(h);
    const cr = h.model.changeRequests[0]!;
    h.model.setChecks(commit, [{ name: "unit-tests", state: "pending", required: false, url: "", runId: "run-1" }]);
    await h.runtime.tick();
    let page = await pageOf(h, taskId);
    expect(page.body).toContain("The pull request");
    expect(page.body).toContain("demo pull request #1: a draft; its checks are running");
    expect(page.body).toContain("Rovara is watching it. It is not ready to merge yet.");
    // The sessions follow on the next sweep (the timer runs them every two seconds).
    await h.runtime.tick();
    expect((await sessionOf(h)).summary).toMatchObject({ step: "Waiting for the pull request's checks", display: { state: "checking" } });
    h.model.setChecks(commit, [passingCheck()]);
    clock.advance(2 * MINUTE);
    await h.runtime.tick();
    await h.runtime.tick();
    page = await pageOf(h, taskId);
    expect(page.body).toContain("ready for review; its checks pass");
    expect(page.body).toContain("Ready to merge. Rovara never merges by itself");
    expect((await sessionOf(h)).summary).toMatchObject({ step: "Ready to merge", display: { state: "ready_to_merge" } });
    expect(cr.state).toBe("open");
    // Someone else pushes to the branch: the page says Rovara has stopped changing it.
    h.model.commit(h.model.changeRequests[0]!.sourceBranch, { "other.txt": "a person's change\n" });
    clock.advance(10 * MINUTE);
    await h.runtime.tick();
    page = await pageOf(h, taskId);
    expect(page.body).toContain("Someone else pushed to it, so Rovara has stopped changing it");
  });

  it("shows Understand's questions on the page and takes the owner's answers there", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const started = await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: "66666666-6666-4666-8666-666666666667", project: "payments", instructions: "Add a /health endpoint", workflow: true } });
    const taskId = started.body.task.taskId;
    const workspaceId = (await store(h).get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
    const seen = new Set<string>();
    await h.callback(await h.nextJob(workspaceId, seen), "result", { status: "SUCCEEDED", result: {} });
    const understand = await h.nextJob(workspaceId, seen);
    const questions = { kind: "questions", restatement: "Add a health endpoint.", questions: [{ id: "q1", text: "Which path?", options: [{ id: "a", label: "/health" }, { id: "b", label: "/healthz" }], recommended: "a" }] };
    await h.callback(understand, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify(questions) });
    await h.callback(understand, "result", { status: "SUCCEEDED" });
    const page = await pageOf(h, taskId);
    expect(page.body).toContain("Rovara has questions");
    expect(page.body).toContain("Which path?");
    const form = formOf(page.body, "/answers");
    // An answer that picks nothing is not sent.
    const empty = await post(h, page.link, form.action, form.fields);
    expect(empty.headers["location"]).toContain("n=refused");
    const fresh = formOf((await pageOf(h, taskId)).body, "/answers");
    const sent = await post(h, page.link, fresh.action, { ...fresh.fields, "option-q1": "b" });
    expect(sent.headers["location"]).toContain("n=answered");
    expect(await h.nextJob(workspaceId, seen)).toMatchObject({ payload: { workflowMode: "UNDERSTAND" } });
  });
});

describe("rovara up: the 10-minute laptop journey from the plan's approval to a pull request that is ready to merge (lane L12)", () => {
  const MINUTE = 60_000;

  it("approves the plan by a writer's comment, codes and checks it, opens the pull request, fixes failing CI on the timer, and ends ready to merge with its proof on the page", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, readiness: true, now: clock.now });
    const store = h.runtime.registry.require("storage");
    const { taskId, workspaceId, seen } = await toPlanReview(h);

    // The plan is posted on a thread; a writer approves it there. The comment is read by the poll, checked by the core, and decides as the writer, not the owner.
    h.model.commit("design-thread", { "NOTES.md": "# notes\n" });
    const thread = h.model.reconcile({ sourceBranch: "design-thread", targetBranch: "main", title: "The plan" }).cr;
    expect(await attachThreadOnPage(h, taskId, Number(thread.id))).toContain("n=attached");
    h.model.setAccount("dana", "write");
    h.model.setNow(new Date(clock.at + 5_000).toISOString());
    const waitingOffer = approvalOfferOf(taskId, (await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workflow"] as unknown as WorkflowSnapshot)!;
    h.model.addDiscussionComment(thread.id, "dana", `/rovara approve ${shortDigest(waitingOffer.artifactDigest)}`);
    clock.advance(MINUTE + 1_000);
    await h.runtime.tick();
    const coding = await h.nextJob(workspaceId, seen);
    expect(coding).toMatchObject({ payload: { workflowMode: "IMPLEMENT" } });

    // Coding: a verified check, the diff, the reviews; the evidence of the checks is kept.
    const commit = h.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree = h.model.revision(commit).tree;
    const digest = createCandidateManifest(candidateOf(tree, h.base, commit)).digest;
    await h.callback(coding, "artifacts", { name: "workspace.diff", mediaType: "text/plain", content: "## demo\n### status\n M src/health.ts\n### diff\ndiff --git a/src/health.ts b/src/health.ts\n--- a/src/health.ts\n+++ b/src/health.ts\n@@ -0,0 +1 @@\n+export const health = 200;\n" });
    const built = builtResult(tree, h.base, commit);
    (built.result as Record<string, unknown>)["checks"] = { ...CHECK_REPORT, status: "verified", source: "project", notVerifiedReason: undefined, checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 5, exitCode: 0 }] };
    await h.callback(coding, "result", built);
    const review = await h.nextJob(workspaceId, seen);
    await h.callback(review, "result", reviewsOf(review, tree, "pass", h.base, commit));
    const publish = await h.nextJob(workspaceId, seen);
    const payload = publish.payload as Record<string, unknown>;
    const headBranch = String(payload["headBranch"]);
    h.model.branches.set(headBranch, commit);
    await h.callback(publish, "pull-request", { repository: "demo", repositoryUrl: h.project.repositories[0]!.url, headBranch, baseBranch: "main", commit, title: payload["title"], body: payload["body"] });
    const cr = h.model.changeRequests.find((entry) => entry.sourceBranch === headBranch)!;
    await h.callback(publish, "result", { status: "SUCCEEDED", result: { repository: "demo", number: Number(cr.id), url: h.model.crUrl(cr.id), headBranch, baseBranch: "main", commit, checks: [], reconciled: false, draft: true } });
    expect((await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workflow"]).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(cr.draft).toBe(true);
    expect(String(payload["body"])).toContain("## Lessons used");

    // The timer: checks pass, the draft is taken out of draft; then CI goes red and Rovara fixes it by itself.
    h.model.setChecks(commit, [passingCheck()]);
    await h.runtime.tick();
    expect(cr.draft).toBe(false);
    h.model.setChecks(commit, [failingCheck()]);
    clock.advance(2 * MINUTE);
    await h.runtime.tick();
    const fix = await h.nextJob(workspaceId, seen);
    expect(fix).toMatchObject({ payload: { workflowMode: "IMPLEMENT", workflowFix: { source: "ci" } } });
    h.model.branches.set("fix", commit);
    const fixCommit = h.model.commit("fix", { "src/health.ts": "export const health = 200; // CI fixed\n" });
    const fixTree = h.model.revision(fixCommit).tree;
    const fixed = builtResult(fixTree, h.base, fixCommit);
    (fixed.result as Record<string, unknown>)["checks"] = (built.result as Record<string, unknown>)["checks"];
    await h.callback(fix, "result", fixed);
    const review2 = await h.nextJob(workspaceId, seen);
    await h.callback(review2, "result", reviewsOf(review2, fixTree, "pass", h.base, fixCommit));
    const update = await h.nextJob(workspaceId, seen);
    h.model.branches.set(headBranch, fixCommit);
    expect((await h.callback(update, "pull-request-update", { repository: "demo", pullRequestNumber: Number(cr.id), action: "append", headBranch, baseBranch: "main", previousCommit: commit, commit: fixCommit })).status).toBe(200);
    expect((await h.callback(update, "result", { status: "SUCCEEDED", result: { action: "append", repository: "demo", number: Number(cr.id), url: h.model.crUrl(cr.id), state: "open", headBranch, baseBranch: "main", previousCommit: commit, commit: fixCommit, treeSha: fixTree, checks: [], reconciled: false } })).status).toBe(200);

    // The fix passes and a writer approves the pull request: Rovara says it is ready to merge, and does not merge.
    h.model.setChecks(fixCommit, [passingCheck()]);
    h.model.addReview(cr.id, { login: "dana", state: "APPROVED", revision: fixCommit });
    clock.advance(2 * MINUTE);
    await h.runtime.tick();
    await h.runtime.tick();
    const events = (await readSessionEvents(store, IMPLICIT_COMPANY_ID, (await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["sessionId"] as never)).events.map((event) => event.text ?? "");
    expect(events).toContain("Rovara marked demo pull request " + cr.id + " ready for review.");
    expect(events.some((line) => line.startsWith("CI is failing on unit-tests, so Rovara is fixing it"))).toBe(true);
    expect(events.some((line) => line.startsWith("Approved by dana. Ready to merge"))).toBe(true);
    expect(cr.state).toBe("open");
    const listed = await listSessions(store, IMPLICIT_COMPANY_ID, developerIdOf(localOwnerPrincipal()));
    expect(listed.sessions[0]).toMatchObject({ summary: { step: "Ready to merge", display: { state: "ready_to_merge" } } });

    // The pages: the pull request's state on the task page, and the evidence on the proof page.
    const owner = (await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["ownerKey"] as string;
    expect(await h.runtime.app.evidence.packOf({ ownerKey: owner, workspaceId, taskId }, digest)).toMatchObject({ checks: [{ checkId: "readiness:0", after: "passed" }] });
    const link = await h.browse(`/plan/${taskId}`);
    const page = await raw(h.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
    expect(page.body).toContain("Ready to merge. Rovara never merges by itself");
    const proofLink = await h.browse(`/proof/${taskId}`);
    const proof = await raw(h.runtime.pagesUrl, { path: proofLink.pathname + proofLink.search, headers: { host: proofLink.host } });
    expect(proof.body).toContain("npm test");
    expect(proof.body).toContain("Evidence kept for this code");
  });
});

describe("rovara up: the L12 review's fixes (H1 to H3, M1 to M3, lows, decision 51)", () => {
  const MINUTE = 60_000;
  type Harness = Awaited<ReturnType<typeof launch>>;
  const store = (h: Harness) => h.runtime.registry.require("storage");
  const thread = (h: Harness, name: string) => { h.model.commit(name, { [`${name}.md`]: `# ${name}\n` }); return h.model.reconcile({ sourceBranch: name, targetBranch: "main", title: name }).cr; };
  const at = (h: Harness, clock: ReturnType<typeof movingClock>, ms: number) => h.model.setNow(new Date(clock.at + ms - 1_000).toISOString());
  const offerOf = async (h: Harness, taskId: string) => approvalOfferOf(taskId, (await store(h).get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workflow"] as unknown as WorkflowSnapshot)!;
  const poll = async (h: Harness, clock: ReturnType<typeof movingClock>) => { clock.advance(MINUTE + 1_000); await h.runtime.tick(); };
  const repliesOn = (cr: { comments: Array<{ body: string }> }): string[] => cr.comments.filter((comment) => comment.body.includes(ROVARA_REPLY_MARKER)).map((comment) => comment.body.split("\n")[0] ?? "");

  it("H1: one open task per thread: a second task cannot be attached, and a comment where several tasks work decides none and stops none", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const a = await toPlanReview(h, "11111111-1111-4111-8111-1111111111a1");
    const b = await toPlanReview(h, "11111111-1111-4111-8111-1111111111b2");
    const shared = thread(h, "epic");
    expect(await attachThreadOnPage(h, a.taskId, Number(shared.id))).toContain("n=attached");
    // Task B cannot take the thread task A has.
    expect(await attachThreadOnPage(h, b.taskId, Number(shared.id))).toContain("n=refused");
    expect(await store(h).get({ pk: "COMMENT_THREADS", sk: `TASK#${b.taskId}` })).toBeUndefined();
    // Whatever put B there anyway (an older record), a comment names no task: nothing is decided, and Rovara says so.
    await store(h).put({ item: { pk: "COMMENT_THREADS", sk: `TASK#${b.taskId}`, entityType: "COMMENT_THREAD", taskId: b.taskId, repositoryId: "demo", number: Number(shared.id), attachedAt: new Date(clock.at).toISOString() } });
    h.model.setAccount("dana", "write");
    at(h, clock, 5_000);
    h.model.addDiscussionComment(shared.id, "dana", `/rovara approve ${shortDigest((await offerOf(h, a.taskId)).artifactDigest)}`);
    at(h, clock, 6_000);
    h.model.addDiscussionComment(shared.id, "dana", "/rovara stop");
    await poll(h, clock);
    for (const task of [a, b]) expect((await taskRecord(h, task.taskId)).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(repliesOn(shared).filter((line) => line.startsWith("Several tasks"))).toHaveLength(2);
    // The same holds for a pull request: a task cannot be attached to the pull request another open task works on.
    const c = await launch({ host: true, now: clock.now });
    const done = await published(c, { "src/health.ts": "export const health = 200;\n" }, undefined);
    const other = await toPlanReview(c, "11111111-1111-4111-8111-1111111111c3");
    expect(await attachThreadOnPage(c, other.taskId, Number(done.cr.id))).toContain("n=refused");
  });

  it("H2: the API token cannot attach a thread (403); only the task's page can", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const planned = await toPlanReview(h);
    const shared = thread(h, "design");
    const refused = await h.api(`/v1/dev/tasks/${planned.taskId}/thread`, { method: "POST", body: { repository: "demo", number: Number(shared.id) } });
    expect(refused.status).toBe(403);
    expect(refused.body.error?.message).toContain("on the task's page");
    expect(await store(h).get({ pk: "COMMENT_THREADS", sk: `TASK#${planned.taskId}` })).toBeUndefined();
    // The page shows the form, and the form needs the page session's token (a replayed or foreign one is refused).
    const link = await h.browse(`/plan/${planned.taskId}`);
    const page = await raw(h.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
    const form = formOf(page.body, "/thread");
    const forged = await raw(h.runtime.pagesUrl, { method: "POST", path: form.action, body: formBody({ ...form.fields, ft: "forged", repository: "demo", number: shared.id }), headers: { host: link.host, origin: h.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
    expect(String(forged.headers["location"])).toContain("n=form");
    expect(await store(h).get({ pk: "COMMENT_THREADS", sk: `TASK#${planned.taskId}` })).toBeUndefined();
  });

  it("M1: Rovara posts the waiting version on the thread once, and an approval must name that version: a bare approve or an older version's is refused and told which waits", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const planned = await toPlanReview(h);
    const shared = thread(h, "plan-thread");
    expect(await attachThreadOnPage(h, planned.taskId, Number(shared.id))).toContain("n=attached");
    h.model.setAccount("dana", "write");
    const v1 = shortDigest((await offerOf(h, planned.taskId)).artifactDigest);
    await poll(h, clock);
    await poll(h, clock);
    expect(repliesOn(shared)).toEqual([noticeOf(v1)]);
    // A bare approve approves nothing and says which version waits.
    at(h, clock, 2 * MINUTE);
    h.model.addDiscussionComment(shared.id, "dana", "/rovara approve");
    await poll(h, clock);
    expect((await taskRecord(h, planned.taskId)).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(repliesOn(shared).at(-1)).toBe(`Version ${v1} is waiting. To approve that one, say /rovara approve ${v1}.`);
    // The writer asks for changes; the next version is posted, and approving the OLD one is refused.
    at(h, clock, 4 * MINUTE);
    h.model.addDiscussionComment(shared.id, "dana", "/rovara changes: also cover the 503 case");
    await poll(h, clock);
    const replan = await h.nextJob(planned.workspaceId, planned.seen);
    expect(replan).toMatchObject({ payload: { workflowMode: "PLAN" } });
    await h.callback(replan, "artifacts", { name: "plan.md", mediaType: "text/markdown", content: `${PLAN_TEXT}\nAlso answer 503 when the store is down.\n` });
    await h.callback(replan, "result", { status: "SUCCEEDED" });
    const v2 = shortDigest((await offerOf(h, planned.taskId)).artifactDigest);
    expect(v2).not.toBe(v1);
    at(h, clock, 8 * MINUTE);
    h.model.addDiscussionComment(shared.id, "dana", `/rovara approve ${v1}`);
    await poll(h, clock);
    expect(repliesOn(shared)).toContain(noticeOf(v2));
    expect(repliesOn(shared).at(-1)).toBe(`Version ${v2} is waiting. To approve that one, say /rovara approve ${v2}.`);
    expect((await taskRecord(h, planned.taskId)).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    at(h, clock, 10 * MINUTE);
    h.model.addDiscussionComment(shared.id, "dana", `/rovara approve ${v2}`);
    await poll(h, clock);
    expect((await taskRecord(h, planned.taskId)).workflow).toMatchObject({ stage: "IMPLEMENT" });
  });

  it("M2: a pull request merged at a head Rovara did not check ends the tracking row and stops the task waiting, saying so", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const { taskId, commit, cr } = await published(h, { "src/health.ts": "export const health = 200;\n" }, undefined);
    h.model.setChecks(commit, [passingCheck()]);
    await h.runtime.tick();
    // A reviewer pushes a fix-up and merges.
    const fixUp = h.model.commit(cr.sourceBranch, { "src/extra.ts": "export const extra = 1;\n" });
    expect(h.model.merge(cr.id, { revision: fixUp, method: "squash" })).toMatchObject({ outcome: "merged" });
    clock.advance(10 * MINUTE);
    await h.runtime.tick();
    const task = await taskRecord(h, taskId);
    expect(task.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: expect.stringContaining("merged with commits Rovara did not check") as unknown });
    expect(task.workflow.stage).not.toBe("MERGED");
    expect(await store(h).get({ pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${taskId}` })).toBeUndefined();
    const sessionId = (await store(h).get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["sessionId"] as string;
    const lines = (await readSessionEvents(store(h), IMPLICIT_COMPANY_ID, sessionId as never)).events.map((event) => event.text ?? "");
    expect(lines.some((line) => line.includes("not a merge of the code Rovara checked"))).toBe(true);
    const reads = countReadsOf(h);
    clock.advance(20 * MINUTE);
    await h.runtime.tick();
    expect(reads()).toBe(0);
  });

  it("M3: a thread the owner attached never hides the task's pull request, and with more threads than one poll reads every thread is reached in turn", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now, commentThreadsPerPoll: 1 });
    h.model.setAccount("dana", "write");
    // Two tasks, each with its own thread; one thread is read per poll.
    const a = await toPlanReview(h, "11111111-1111-4111-8111-1111111111d4");
    const b = await toPlanReview(h, "11111111-1111-4111-8111-1111111111e5");
    const ta = thread(h, "thread-a");
    const tb = thread(h, "thread-b");
    await attachThreadOnPage(h, a.taskId, Number(ta.id));
    await attachThreadOnPage(h, b.taskId, Number(tb.id));
    at(h, clock, 5_000);
    h.model.addDiscussionComment(ta.id, "dana", "/rovara changes: change a");
    at(h, clock, 6_000);
    h.model.addDiscussionComment(tb.id, "dana", "/rovara changes: change b");
    await poll(h, clock);
    await poll(h, clock);
    await poll(h, clock);
    for (const task of [a, b]) expect((await taskRecord(h, task.taskId)).workflow).toMatchObject({ stage: "PLAN" });
    // A task with an attached thread whose pull request exists: a command on the pull request still reaches it.
    const c = await launch({ host: true, now: clock.now });
    c.model.setAccount("dana", "write");
    const planned = await toPlanReview(c, "11111111-1111-4111-8111-1111111111f6");
    const plan = thread(c, "plan-thread");
    await attachThreadOnPage(c, planned.taskId, Number(plan.id));
    await approvePlan(c, planned.taskId);
    const coding = await c.nextJob(planned.workspaceId, planned.seen);
    const commit = c.model.commit("work", { "src/health.ts": "export const health = 200;\n" });
    const tree = c.model.revision(commit).tree;
    await c.callback(coding, "result", builtResult(tree, c.base, commit));
    const review = await c.nextJob(planned.workspaceId, planned.seen);
    await c.callback(review, "result", reviewsOf(review, tree, "pass", c.base, commit));
    const publish = await c.nextJob(planned.workspaceId, planned.seen);
    const payload = publish.payload as Record<string, unknown>;
    const headBranch = String(payload["headBranch"]);
    c.model.branches.set(headBranch, commit);
    await c.callback(publish, "pull-request", { repository: "demo", repositoryUrl: c.project.repositories[0]!.url, headBranch, baseBranch: "main", commit, title: payload["title"], body: payload["body"] });
    const cr = c.model.changeRequests.find((entry) => entry.sourceBranch === headBranch)!;
    await c.callback(publish, "result", { status: "SUCCEEDED", result: { repository: "demo", number: Number(cr.id), url: c.model.crUrl(cr.id), headBranch, baseBranch: "main", commit, checks: [], reconciled: false, draft: true } });
    at(c, clock, 3 * MINUTE);
    c.model.addDiscussionComment(cr.id, "dana", "/rovara stop");
    await poll(c, clock);
    expect(repliesOn(cr)).toEqual(["Stopped the work on this change."]);
  });

  it("N5: a thread whose read fails is marked as read and waits longer each time, so it cannot starve the others", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now, commentThreadsPerPoll: 1 });
    h.model.setAccount("dana", "write");
    const older = await toPlanReview(h, "11111111-1111-4111-8111-1111111111a7");
    const newer = await toPlanReview(h, "11111111-1111-4111-8111-1111111111b8");
    const good = thread(h, "good-thread");
    const bad = thread(h, "bad-thread");
    await attachThreadOnPage(h, older.taskId, Number(good.id));
    await attachThreadOnPage(h, newer.taskId, Number(bad.id));
    at(h, clock, 5_000);
    h.model.addDiscussionComment(good.id, "dana", "/rovara changes: change the older one");
    // The newer task's thread is first in line and its read always fails.
    const original = h.host.comments.bind(h.host);
    let badReads = 0;
    h.host.comments = async (ref, options, scope, budget) => { if (ref.id === bad.id) { badReads += 1; throw new Error("the host failed"); } return original(ref, options, scope, budget); };
    await poll(h, clock);
    expect(badReads).toBe(1);
    const row = await store(h).get({ pk: "COMMENT_CURSOR", sk: `example/demo#${bad.id}` });
    expect(row).toMatchObject({ failures: 1 });
    expect(typeof row?.["polledAt"]).toBe("number");
    // The next poll reaches the thread that works (with one thread a poll, the failing one would otherwise be first for ever) and the failing one waits.
    await poll(h, clock);
    expect((await taskRecord(h, older.taskId)).workflow).toMatchObject({ stage: "PLAN" });
    expect(badReads).toBe(1);
    // A thread that reads again is back in line and forgets its failures.
    h.host.comments = original;
    clock.advance(10 * MINUTE);
    await poll(h, clock);
    await poll(h, clock);
    expect((await store(h).get({ pk: "COMMENT_CURSOR", sk: `example/demo#${bad.id}` }))?.["failures"]).toBeUndefined();
  });

  it("N6: the notice of a version is claimed for the task, the version AND the thread, so a thread the plan moved to gets its own notice", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const planned = await toPlanReview(h);
    const first = thread(h, "first-thread");
    const second = thread(h, "second-thread");
    const short = shortDigest((await offerOf(h, planned.taskId)).artifactDigest);
    await attachThreadOnPage(h, planned.taskId, Number(first.id));
    await poll(h, clock);
    expect(repliesOn(first)).toEqual([noticeOf(short)]);
    // The owner moves the plan to another thread: the same version is announced there, once.
    expect(await attachThreadOnPage(h, planned.taskId, Number(second.id))).toContain("n=attached");
    await poll(h, clock);
    await poll(h, clock);
    expect(repliesOn(second)).toEqual([noticeOf(short)]);
    expect(repliesOn(first)).toEqual([noticeOf(short)]);
  });

  it("51: a bot's comment is not a command (the adapter says isBot), and the merge observation names a neutral source", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    const planned = await toPlanReview(h);
    const shared = thread(h, "bots");
    await attachThreadOnPage(h, planned.taskId, Number(shared.id));
    h.model.setAccount("ci-bot", "write", "Bot");
    at(h, clock, 5_000);
    h.model.addDiscussionComment(shared.id, "ci-bot", "/rovara changes: change everything");
    await poll(h, clock);
    expect((await taskRecord(h, planned.taskId)).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    const page = await h.runtime.app.comments.fetchComment(shared.comments.find((comment) => comment.author === "ci-bot")!.id, { ...(await offerOf(h, planned.taskId)), companyId: IMPLICIT_COMPANY_ID, kind: "plan", subject: { type: "task", id: planned.taskId } });
    expect(page).toMatchObject({ authorIsBot: true });
    // The account is the host's own id when it gives one (a login can be renamed).
    expect(page?.author.accountId).toBe(h.model.accounts.get("ci-bot")!.hostUserId);
  });

  it("L5, L7, L8, L9 and L10: the pause survives a restart, a pending review is not ready, a retry is for the revision the page showed, the cursor waits for the whole conversation, and a poll reads the task list once", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    // L5: a pause the host asked for is kept, and a restart inside it reads it back.
    h.runtime.app.tracking.pauseUntil(clock.at + 30 * MINUTE);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await store(h).get({ pk: "WORKFLOW_MERGE_SWEEP", sk: "COOLDOWN" }))?.["until"]).toBe(clock.at + 30 * MINUTE);
    await h.runtime.stop();
    const again = await launch({ root: h.root, now: clock.now, host: true });
    await again.runtime.tick();
    expect(again.runtime.app.tracking.pausedUntil()).toBe(clock.at + 30 * MINUTE);

    // L7: "ready to merge" waits for the reviews that were asked for.
    const item = { state: "open", draft: false, ci: "passing", review: "requested", branch: "up_to_date", headByRovara: true } as const;
    expect(readyToMerge(item)).toBe(false);
    expect(readyToMerge({ ...item, review: "approved" })).toBe(true);
    expect(readyToMerge({ ...item, review: "not_requested" })).toBe(true);

    // L8: a retry for an older revision of the page is refused by the retry itself.
    const g = await launch();
    const { taskId, workspaceId, seen, coding } = await toCoding(g);
    await g.callback(coding, "result", builtResult("1".repeat(40)));
    const review = await g.nextJob(workspaceId, seen);
    await g.callback(review, "result", { status: "FAILED", error: "the review stopped" });
    const blocked = (await taskRecord(g, taskId)).workflow;
    await expect(retryBlockedStep(g.runtime.app.flow.deps, taskId, blocked.revision - 1)).rejects.toThrow(/changed since you read it/u);
    expect((await taskRecord(g, taskId)).workflow.revision).toBe(blocked.revision);
  });

  it("L9 and L10: the poll cursor does not move past comments it did not read, and a poll reads the owner's task list once however many commands it runs", async () => {
    const clock = movingClock();
    const h = await launch({ host: true, now: clock.now });
    h.model.setAccount("dana", "write");
    const planned = await toPlanReview(h);
    const shared = thread(h, "busy");
    await attachThreadOnPage(h, planned.taskId, Number(shared.id));
    // L9: a conversation that never ends (every page says there is one more) leaves the cursor where it was.
    await poll(h, clock);
    const before = (await store(h).get({ pk: "COMMENT_CURSOR", sk: `example/demo#${shared.id}` }))?.["since"];
    expect(typeof before).toBe("string");
    const original = h.host.comments.bind(h.host);
    h.host.comments = async (ref, options, scope, budget) => ({ ...(await original(ref, options, scope, budget)), nextPage: (options.page ?? 1) + 1 });
    at(h, clock, 5_000);
    h.model.addDiscussionComment(shared.id, "dana", "chatter");
    await poll(h, clock);
    expect((await store(h).get({ pk: "COMMENT_CURSOR", sk: `example/demo#${shared.id}` }))?.["since"]).toBe(before);
    h.host.comments = original;
    // L10: three command comments, one read of the task list.
    for (let n = 0; n < 3; n += 1) { at(h, clock, 6_000 + n * 1_000); h.model.addDiscussionComment(shared.id, "dana", "/rovara stop"); }
    let listings = 0;
    const query = store(h).query.bind(store(h));
    store(h).query = async (input) => { if ("sk" in input && typeof input.sk === "object" && "prefix" in input.sk && input.sk.prefix === "TASK#" && input.pk.startsWith("DEVELOPER")) listings += 1; return query(input); };
    await poll(h, clock);
    store(h).query = query;
    expect(listings).toBeLessThanOrEqual(1);
  });
});

function assertGithubCloneAccessFor(url: string, access: "clone" | "push"): boolean {
  try { assertGithubCloneAccess(url, access); return true; } catch { return false;  }
}
