/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
   the fake worker's answers and the owner routes' bodies are free-form JSON read field by field. */
// The setup agent on `rovara up`: a run that sets a project up by running its commands in a sandbox, driven against a fake worker through the REAL callback listener and the capability the flow issued.
// The owner's own acts (a website, the use of a setup, a command) are made on the page's own session; the routes refuse them. Docker is simulated.
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WORKER_INVOCATION_FEATURES, type AdapterRegistry, type WorkerInvocation } from "@agentx/contracts";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { locateWorkspace } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { startLocalRuntime, type LocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { formBody, raw } from "../support/local-pages-fakes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

const HOSTED = "https://github.com/example/demo.git";
const PROJECT = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: HOSTED, path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const PACKAGE = ["{", "  \"scripts\": {", "    \"ci\": \"npm ci\",", "    \"test\": \"npm test\"", "  }", "}", ""].join("\n");
const apiKey = (): string => ["sk", "ant", "x".repeat(40)].join("-");
const BASE = "b".repeat(40);

async function launch(extra: { environment?: NodeJS.ProcessEnv } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rovara-setup-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const machines = new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] });
  const model = new FakeHostModel({ url: HOSTED, id: "1", fullName: "example/demo" });
  const host = Object.defineProperties(new FakeCodeHost(model), { kind: { value: "github" } });
  // The code host answers the citation re-read with the repository's file at any commit.
  host.fileAtRevision = async (_repository, path, _revision, _scope, options) => (path === "package.json" ? (options?.untilLine === undefined ? PACKAGE : PACKAGE.split("\n").slice(0, options.untilLine).join("\n")) : undefined);
  const opened: string[] = [];
  const registerAdapters = (registry: AdapterRegistry): void => { registry.register("code-host", "github", host); };
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment: { ANTHROPIC_API_KEY: apiKey(), ...extra.environment }, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9", machines, timers: false,
    registerAdapters, openBrowser: async (url) => { opened.push(url); },
  });
  cleanup.push(() => runtime.stop());
  const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${runtime.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    return { status: response.status, body: JSON.parse((await response.text()) || "{}") as Record<string, any> };
  };
  const browse = async (path: string): Promise<URL> => {
    expect((await api("/v1/local/pages/open", { method: "POST", body: { path } })).status).toBe(200);
    const once = new URL(opened.at(-1)!);
    const hop = await raw(runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
    return new URL(hop.headers["location"] as string, runtime.pagesUrl);
  };
  const page = async (link: URL, path: string) => raw(runtime.pagesUrl, { path: `${link.pathname.replace(/\/$/u, "").replace(/\/setup.*$/u, "")}${path}`, headers: { host: link.host } });
  const post = async (link: URL, action: string, fields: Record<string, string>) => raw(runtime.pagesUrl, { method: "POST", path: action, body: formBody(fields), headers: { host: link.host, origin: runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
  const callback = (invocation: WorkerInvocation, action: string, body: unknown) => new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = httpRequest({
      host: "127.0.0.1", port: runtime.callbackPort, method: "POST", setHost: false, path: `/v1/internal/workspaces/${invocation.workspaceId}/operations/${invocation.operationId}/${action}`,
      headers: { host: `host.docker.internal:${runtime.callbackPort}`, "content-type": "application/json", "content-length": Buffer.byteLength(text), "x-agentx-callback-capability": invocation.callbackCapability },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, any> }));
    });
    req.on("error", reject);
    req.end(text);
  });
  const store = runtime.registry.require("storage");
  const nextJob = async (workspaceId: string, seen: Set<string>): Promise<WorkerInvocation> => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await runtime.tick();
      const machineId = ((await locateWorkspace(runtime.app.flow.deps, workspaceId))?.workspace["machine"] as { machineId?: string } | undefined)?.machineId;
      const fresh = machineId === undefined ? undefined : machines.delivered(machineId).find((job) => !seen.has(job.operationId));
      if (fresh !== undefined) { seen.add(fresh.operationId); return fresh; }
    }
    throw new Error("the flow did not hand a job to the worker");
  };
  return { runtime, api, browse, page, post, callback, nextJob, store, machines, host, opened };
}
type Harness = Awaited<ReturnType<typeof launch>>;

const ROUTE = "/v1/app/projects/payments/setup-agent";
const SUMMARY = { stop: "proposed", commandsRun: 3, spendCents: 40, elapsedMs: 120_000, hostAsks: 1, partial: false };

/** Registers the project, starts a run, answers its preparation and gives back the setup job. */
async function startRun(h: Harness, requestId = randomUUID()) {
  expect((await h.api("/v1/admin/projects", { method: "POST", body: PROJECT })).status).toBe(201);
  const started = await h.api(ROUTE, { method: "POST", body: { requestId } });
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const taskId = started.body["taskId"] as string;
  const workspaceId = (await h.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
  const seen = new Set<string>();
  const prepare = await h.nextJob(workspaceId, seen);
  expect(prepare.kind).toBe("prepare");
  expect((await h.callback(prepare, "result", { status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: BASE }] } })).status).toBe(200);
  const job = await h.nextJob(workspaceId, seen);
  return { taskId, workspaceId, seen, job, requestId };
}


// Review (Opus, 2026-11-24): released Cloud reads the setup view with its OWN strict SetupRunSummarySchema, which has no `cannot` key
// (Cloud packages/contracts/src/setup-run.ts; its accepted drift says `cannot` is never sent). A gateway stop must not put `cannot` into the view's summary,
// or the Setup tab's read fails exactly when the fix-it card should show.
const CLOUD_SUMMARY_KEYS = ["stop", "commandsRun", "spendCents", "elapsedMs", "hostAsks", "partial"];
describe("review: the setup view a gateway stop produces is readable by released Cloud", () => {
  it("the failed view's summary carries only the keys Cloud's strict summary lists", async () => {
    for (const cannot of ["company_limit_not_set", "rovara_ai_not_confirmed"]) {
      const h = await launch();
      const run = await startRun(h);
      await h.callback(run.job, "result", { status: "SUCCEEDED", result: { setupRunSummary: { ...SUMMARY, stop: "infrastructure", partial: true, cannot } } });
      const body = (await h.api(ROUTE)).body as any;
      expect(body.status).toBe("failed");
      for (const key of Object.keys((body.summary ?? {}) as Record<string, unknown>)) expect(CLOUD_SUMMARY_KEYS).toContain(key);
    }
  });
});
