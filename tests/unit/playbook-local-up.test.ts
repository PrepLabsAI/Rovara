// How we work on `rovara up`, end to end on the fakes: the project's playbook file is read through the code host, the company's rules file is read from the state folder, and a task's first steps carry both
// in the worker's invocation. The routes and the page answer from the same running install (`rovara playbook check | init` is tests/unit/playbook-cli.test.ts). Docker and the host are simulated.
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLAYBOOK_FILE_PATH, UNDERSTAND_ARTIFACT_NAME, WORKER_INVOCATION_FEATURES, type WorkerInvocation } from "@agentx/contracts";
import { defaultStateDirectory } from "../../packages/broker/src/local/state-directory.js";
import { locateWorkspace } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { startLocalRuntime, type LocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { formBody, formOf, raw } from "../support/local-pages-fakes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

const REPO = "https://github.com/example/demo.git";
const FILE = "version: 1\nrules: |\n  PROJECT-RULE: always mention the ticket.\nstages:\n  plan:\n    instructions: |\n      PLAN-RULE: name every file.\n";
const PROJECT = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: REPO, path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
/** What the owner's routes answer, as far as these tests read it. */
interface ApiBody { task: { taskId: string; workflow: Record<string, unknown> }; tasks: unknown[]; error: { message: string }; rules: unknown; file: unknown; playbook: unknown }
const COMPANY_RULES = "## Required\n- Never log customer data.\n## Preferred\n- Use integer cents for money.\n";

async function launch(options: { file?: string | undefined; rules?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "rovara-playbook-home-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const stateDirectory = defaultStateDirectory(home);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  if (options.rules !== undefined) await writeFile(join(stateDirectory, "company-instructions.md"), options.rules, { mode: 0o600 });
  const model = new FakeHostModel({ url: REPO, id: "1", fullName: "example/demo", initialFiles: options.file === undefined ? { "README.md": "x" } : { "README.md": "x", [PLAYBOOK_FILE_PATH]: options.file } });
  const host = Object.defineProperty(new FakeCodeHost(model), "kind", { value: "github" });
  const machines = new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] });
  const opened: string[] = [];
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(home, "project"), environment: {}, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "0.1.0", machines, timers: false, storage: "memory",
    registerAdapters: (registry) => { registry.register("code-host", "github", host); }, openBrowser: async (url) => { opened.push(url); },
  });
  cleanup.push(() => runtime.stop());
  const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  const api = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: ApiBody }> => {
    const response = await fetch(`${runtime.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    return { status: response.status, body: await response.json() as ApiBody };
  };
  const callback = (invocation: WorkerInvocation, action: string, body: unknown) => new Promise<number>((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = httpRequest({
      host: "127.0.0.1", port: runtime.callbackPort, method: "POST", setHost: false, path: `/v1/internal/workspaces/${invocation.workspaceId}/operations/${invocation.operationId}/${action}`,
      headers: { host: `host.docker.internal:${runtime.callbackPort}`, "content-type": "application/json", "content-length": Buffer.byteLength(text), "x-agentx-callback-capability": invocation.callbackCapability },
    }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); });
    req.on("error", reject);
    req.end(text);
  });
  const nextJob = async (workspaceId: string, seen: Set<string>): Promise<WorkerInvocation> => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await runtime.tick();
      const machineId = ((await locateWorkspace(runtime.app.flow.deps, workspaceId))?.workspace["machine"] as { machineId?: string } | undefined)?.machineId;
      const fresh = machineId === undefined ? undefined : machines.delivered(machineId).find((job) => !seen.has(job.operationId));
      if (fresh !== undefined) { seen.add(fresh.operationId); return fresh; }
    }
    throw new Error("the flow did not hand a job to the worker");
  };
  await api("/v1/admin/projects", { method: "POST", body: PROJECT });
  await mkdir(join(home, "project"), { recursive: true });
  return { home, runtime, model, api, callback, nextJob, opened, token, stateDirectory };
}

const instructionsOf = (invocation: WorkerInvocation) => (invocation as { payload: { standingInstructions?: { text: string; company?: { text: string } } } }).payload.standingInstructions;

describe("a task on rovara up", () => {
  it("carries the company's rules and the project's How we work from its first step, and the plan step carries the plan's own rules", async () => {
    const h = await launch({ file: FILE, rules: COMPANY_RULES });
    const started = await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: "11111111-1111-4111-8111-111111111111", project: "payments", instructions: "Add a /health endpoint", workflow: true } });
    expect(started.status).toBe(201);
    const taskId = started.body.task.taskId;
    const workspaceId = (await h.runtime.registry.require("storage").get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
    const seen = new Set<string>();
    const prepare = await h.nextJob(workspaceId, seen);
    expect(instructionsOf(prepare)).toBeUndefined();
    await h.callback(prepare, "result", { status: "SUCCEEDED", result: {} });

    const understand = await h.nextJob(workspaceId, seen);
    expect(understand).toMatchObject({ payload: { workflowMode: "UNDERSTAND" } });
    const block = instructionsOf(understand)!;
    expect(block.text).toContain("- Never log customer data.");
    expect(block.text).toContain("- Use integer cents for money.");
    expect(block.text).toContain("> PROJECT-RULE: always mention the ticket.");
    expect(block.text).toContain("> PLAN-RULE: name every file.");
    expect(block.text.indexOf("Company rules")).toBeLessThan(block.text.indexOf("How we work"));
    expect(block.company?.text).not.toContain("PROJECT-RULE");

    await h.callback(understand, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify({ kind: "ready", path: "QUICK", restatement: "Add a health endpoint.", assumptions: [] }) });
    await h.callback(understand, "result", { status: "SUCCEEDED" });
    const plan = await h.nextJob(workspaceId, seen);
    expect(plan).toMatchObject({ payload: { workflowMode: "PLAN" } });
    expect(instructionsOf(plan)?.text).toContain("> PLAN-RULE: name every file.");
  });

});

describe("the routes", () => {
  it("answer the effective view and the file's state for the owner's session, and never for no session", async () => {
    const h = await launch({ file: FILE });
    const view = await h.api("/v1/app/projects/payments/how-we-work");
    expect(view.status).toBe(200);
    expect(view.body.rules).toEqual([{ value: "PROJECT-RULE: always mention the ticket.", source: "project", locked: false }]);
    const state = await h.api("/v1/local/playbook/payments");
    // A read writes nothing: the stored item is brought up to the file when a task starts or a step is sent.
    expect(state.body).toMatchObject({ file: { status: "ok", repository: "demo" }, playbook: { revision: 0, defaultProcess: { kind: "builtin" } } });
    expect((await fetch(`${h.runtime.url}/v1/local/playbook/payments`)).status).toBe(401);
    expect((await h.api("/v1/app/projects/ghost/how-we-work")).status).toBe(404);
    expect((await h.api("/v1/app/projects/payments/playbook", { method: "POST", body: {} })).body.error.message).toContain(".rovara/playbook.yaml");
  });
});

describe("the page", () => {
  it("opens from the owner's session, shows the file, and checks a draft without saving it", async () => {
    const h = await launch({ file: FILE });
    const answer = await h.api("/v1/local/pages/open", { method: "POST", body: { path: "/how-we-work/payments" } });
    expect(answer.status).toBe(200);
    const once = new URL(h.opened.at(-1)!);
    const hop = await raw(h.runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
    const pages = new URL(hop.headers["location"] as string, h.runtime.pagesUrl);
    const page = await raw(h.runtime.pagesUrl, { path: pages.pathname, headers: { host: pages.host } });
    expect(page.status).toBe(200);
    expect(page.body).toContain("PROJECT-RULE: always mention the ticket.");
    const form = formOf(page.body, "/check");
    const draft = await raw(h.runtime.pagesUrl, { method: "POST", path: form.action, body: formBody({ ...form.fields, text: "version: 1\nrules: ONLY-IN-THE-DRAFT" }), headers: { host: pages.host, origin: h.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
    expect(draft.body).toContain("ONLY-IN-THE-DRAFT");
    expect((await h.api("/v1/app/projects/payments/how-we-work")).body.rules).toEqual([{ value: "PROJECT-RULE: always mention the ticket.", source: "project", locked: false }]);
  });
});
