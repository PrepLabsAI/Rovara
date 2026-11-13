/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-base-to-string --
   the fake worker's answers and the owner routes' bodies are free-form JSON read field by field. */
// The setup agent on `rovara up`: a run that sets a project up by running its commands in a sandbox, driven against a fake worker through the REAL callback listener and the capability the flow issued.
// The owner's own acts (a website, the use of a setup, a command) are made on the page's own session; the routes refuse them. Docker is simulated.
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, WORKER_INVOCATION_FEATURES, orgProjectCatalogKey, type AdapterRegistry, type Approvers, type WorkerInvocation } from "@rovara-code/contracts";
import { createDecisionGate } from "../../packages/core/src/core/decisions/approval-gate.js";
import { SETUP_APPLY_KIND } from "../../packages/core/src/core/setup-agent/apply.js";
import { SETUP_HOST_KIND, hostAskDigest, hostAskSubjectId, HOST_ASK_REVISION } from "../../packages/core/src/core/setup-agent/host-ask.js";
import { hostRequestId, proposalRequestId, setupDecisionSubjects } from "../../packages/core/src/local/app/setup-agent.js";
import { localOwnerPrincipal } from "../../packages/core/src/ports/policy-defaults.js";
import { FakeWorkerMachines } from "../../packages/core/src/ports/fake-worker-machines.js";
import { FakeCodeHost } from "../../packages/core/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/core/src/plugins/fake/model.js";
import { startLocalRuntime, type LocalRuntime } from "../../packages/core/src/local/runtime.js";
import { Command } from "commander";
import { registerSetupAgentCommands } from "../../packages/cli/src/up/setup-agent.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { formBody, formOf, raw } from "../support/local-pages-fakes.js";

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
      const machineId = ((await store.get({ pk: `WORKSPACE#${workspaceId}`, sk: "META" }))?.["machine"] as { machineId?: string } | undefined)?.machineId;
      const fresh = machineId === undefined ? undefined : machines.delivered(machineId).find((job) => !seen.has(job.operationId));
      if (fresh !== undefined) { seen.add(fresh.operationId); return fresh; }
    }
    throw new Error("the flow did not hand a job to the worker");
  };
  const cli = async (...argv: string[]): Promise<string> => {
    const out: string[] = [];
    const program = new Command().exitOverride().option("--json", "", false);
    registerSetupAgentCommands(program, { home: root, fetch, stdout: { write: (text: string) => { out.push(text); return true; } } });
    await program.parseAsync(["node", "rovara", ...argv, "--state-dir", stateDirectory]);
    return out.join("");
  };
  return { runtime, api, browse, page, post, callback, nextJob, store, machines, host, cli, opened };
}
type Harness = Awaited<ReturnType<typeof launch>>;

const ROUTE = "/v1/app/projects/payments/setup-agent";
const entry = (n: number, command: string, extra: Record<string, unknown> = {}) => ({ n, source: "agent", command, exitCode: 0, durationMs: 1200, timedOut: false, flagged: false, blockedHosts: [], tail: "ok", startedAt: new Date().toISOString(), ...extra });
const cite = (line: number, quote: string) => ({ kind: "file", repo: "demo", path: "package.json", commit: BASE, line, quote });
const proposal = () => ({
  basedOnRevision: 1,
  setup: [{ repo: "demo", commands: ["npm ci"], confidence: "high", from: [cite(3, "\"ci\": \"npm ci\"")] }],
  tests: [{ repo: "demo", commands: ["npm test"], confidence: "high", from: [cite(4, "\"test\": \"npm test\"")] }],
});
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

describe("a setup run, from the owner's request to the use of what it found", () => {
  it("hands the worker its limits and the commits the preparation reported, and a capability for the setup callback", async () => {
    const h = await launch();
    const run = await startRun(h);
    expect(run.job).toMatchObject({ kind: "task", payload: { workflowMode: "SETUP_AGENT", setupAgent: { limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, commits: [{ repository: "demo", commit: BASE }] } } });
    // The capability lists the setup action; a preparation's does not.
    expect((await h.callback(run.job, "setup-agent", { kind: "poll" })).status).toBe(200);
    const view = await h.api(ROUTE);
    expect(view.body).toMatchObject({ status: "running", basedOnRevision: 1, taskId: run.taskId });
    // A repeat of the start's request answers the first run and starts nothing.
    const again = await h.api(ROUTE, { method: "POST", body: { requestId: run.requestId } });
    expect(again.status).toBe(200);
    expect(again.body["taskId"]).toBe(run.taskId);
    // A second run while one is going is refused.
    const second = await h.api(ROUTE, { method: "POST", body: { requestId: randomUUID() } });
    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).toContain("already setting up");
  });

  it("keeps the journal once, asks for a website only through the broker's own checks, and an approval is the owner's act on the page", async () => {
    const h = await launch();
    const run = await startRun(h);
    const first = await h.callback(run.job, "setup-agent", { kind: "journal", entries: [entry(1, "npm ci"), entry(2, "npm test", { exitCode: 1, tail: "1 failing" })] });
    expect(first.body).toMatchObject({ stored: 2, repeated: 0, refused: 0 });
    // A repeat of a position changes nothing; a position past the limit is refused.
    expect((await h.callback(run.job, "setup-agent", { kind: "journal", entries: [entry(1, "echo changed"), entry(401, "x")] })).body).toMatchObject({ stored: 0, repeated: 1, refused: 1 });
    const journal = await h.api(`${ROUTE}/journal?after=1`);
    expect(journal.body["entries"]).toHaveLength(1);
    expect(journal.body["entries"][0]).toMatchObject({ n: 2, command: "npm test" });
    // A name the broker refuses without a card is counted and never asked about; a plain one becomes an ask, joined by a second request.
    expect((await h.callback(run.job, "setup-agent", { kind: "host", host: "pastebin.com" })).body).toMatchObject({ outcome: "refused", reason: "paste_site" });
    expect((await h.callback(run.job, "setup-agent", { kind: "host", host: "packages.exampledeps.dev", from: { path: "package.json", line: 4 }, journalN: 2 })).body).toMatchObject({ outcome: "created" });
    expect((await h.callback(run.job, "setup-agent", { kind: "host", host: "packages.exampledeps.dev" })).body).toMatchObject({ outcome: "joined" });
    expect((await h.callback(run.job, "setup-agent", { kind: "poll" })).body).toMatchObject({ hosts: [{ host: "packages.exampledeps.dev", state: "open" }] });
    // The owner decides on the page; the route cannot.
    const link = await h.browse("/setup/payments");
    const shown = await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } });
    expect(shown.status).toBe(200);
    expect(shown.body).toContain("packages.exampledeps.dev");
    const form = formOf(shown.body, "/host");
    const approved = await h.post(link, form.action, { ...form.fields, decision: "approve" });
    expect(approved.headers["location"]).toContain("n=setupdone");
    expect((await h.callback(run.job, "setup-agent", { kind: "poll" })).body).toMatchObject({ hosts: [{ host: "packages.exampledeps.dev", state: "approved" }] });
    expect(await h.runtime.app.setupAgent.approvedHosts("payments")).toEqual(["packages.exampledeps.dev"]);
    // Only that project's machines may reach it.
    expect(await h.runtime.app.setupAgent.approvedHosts("other")).toEqual([]);
    expect(await h.runtime.app.setupAgent.approvedHosts(undefined)).toEqual([]);
    // The same form cannot be used twice.
    expect((await h.post(link, form.action, { ...form.fields, decision: "reject" })).headers["location"]).toContain("n=form");
  });

  it("takes a person's command only from the page, hands it to the worker once, and refuses a command that holds a secret", async () => {
    const h = await launch();
    const run = await startRun(h);
    // The route answers in words that point to the page.
    const routed = await h.api(`${ROUTE}/command`, { method: "POST", body: { requestId: randomUUID(), command: "ls" } });
    expect(routed.status).toBe(403);
    expect(JSON.stringify(routed.body)).toContain("setup page");
    const link = await h.browse("/setup/payments");
    const shown = await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } });
    const form = formOf(shown.body, "/command");
    const secret = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    expect((await h.post(link, form.action, { ...form.fields, command: `echo ${secret}` })).headers["location"]).toContain("n=invalid");
    const fresh = formOf((await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).body, "/command");
    expect((await h.post(link, fresh.action, { ...fresh.fields, command: "ls -la" })).headers["location"]).toContain("n=setupdone");
    // A website a command hit names the person who typed it only once the command was handed over, and only from the broker's own record of that command.
    const askRow = async (host: string) => (await h.store.get({ pk: `ORG#${IMPLICIT_COMPANY_ID}#PROJECT#payments`, sk: `SETUP_HOST_ASK#${host}` }))!;
    await h.callback(run.job, "setup-agent", { kind: "host", host: "early.exampledeps.dev", viaCommandSeq: 1 });
    expect((await askRow("early.exampledeps.dev"))["typedBy"]).toBeUndefined();
    expect((await h.callback(run.job, "setup-agent", { kind: "poll" })).body).toMatchObject({ command: { seq: 1, command: "ls -la" } });
    await h.callback(run.job, "setup-agent", { kind: "host", host: "late.exampledeps.dev", viaCommandSeq: 1 });
    expect((await askRow("late.exampledeps.dev"))["typedBy"]).toMatch(/^[0-9a-f]{64}$/u);
    await h.callback(run.job, "setup-agent", { kind: "host", host: "none.exampledeps.dev", viaCommandSeq: 7 });
    expect((await askRow("none.exampledeps.dev"))["typedBy"]).toBeUndefined();
    // Handed over once.
    expect((await h.callback(run.job, "setup-agent", { kind: "poll" })).body["command"]).toBeUndefined();
    expect((await h.callback(run.job, "setup-agent", { kind: "command_done", seq: 1, journalN: 3 })).body).toMatchObject({ finished: true });
  });

  it("keeps a proposal the run reported, re-reads its citations, and applies it only after a passing check on a new workspace and the owner's approval", async () => {
    const h = await launch();
    const run = await startRun(h);
    await h.callback(run.job, "setup-agent", { kind: "journal", entries: [entry(1, "npm ci"), entry(2, "npm test")] });
    expect((await h.callback(run.job, "result", { status: "SUCCEEDED", result: { setupProposal: proposal(), setupRunSummary: SUMMARY } })).status).toBe(200);
    const ready = await h.api(ROUTE);
    expect(ready.body).toMatchObject({ status: "ready", stop: "proposed", verified: true, verification: { "setup-demo": "verified", "tests-demo": "verified" } });
    // The run's workspace, machine and slot were given back.
    const task = (await h.store.get({ pk: `DEVTASK#${run.taskId}`, sk: "META" }))!;
    expect(task["closedAt"]).toBeTypeOf("string");

    // "Use this setup": the commands become a candidate of the project and a check starts on it. Nothing is applied.
    const link = await h.browse("/setup/payments");
    let shown = await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } });
    const confirmForm = formOf(shown.body, "/confirm");
    expect((await h.post(link, confirmForm.action, { ...confirmForm.fields })).headers["location"]).toContain("n=setupdone");
    expect(((await h.api("/v1/dev/projects")).body["projects"] as Array<{ latestRevision: number }>)[0]!.latestRevision).toBe(1);
    // No other revision may be made while one waits.
    const blocked = await h.api("/v1/admin/projects", { method: "POST", body: { ...PROJECT, orchestratorInstructions: "Other." } });
    expect(blocked.status).toBe(409);
    // The proposal is not offered for approval until the check passes.
    shown = await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } });
    expect(shown.body).toContain("Waiting for your approval");
    expect(shown.body).not.toContain("Approve these commands");
    // The check runs on a NEW workspace, on the candidate revision's commands.
    const apply = (await h.store.get({ pk: `ORG#${IMPLICIT_COMPANY_ID}#SETUP_DRAFT#payments`, sk: "APPLY" }))!;
    const checkWorkspace = (apply["check"] as { workspaceId: string }).workspaceId;
    expect(checkWorkspace).not.toBe(run.workspaceId);
    const checkJob = await h.nextJob(checkWorkspace, new Set());
    expect(checkJob).toMatchObject({ kind: "prepare", projectRevision: 2 });
    expect((checkJob.payload as { project: { setup: unknown[]; readiness: unknown[] } }).project).toMatchObject({ setup: [{ executable: "npm", args: ["ci"] }], readiness: [{ executable: "npm", args: ["test"] }] });
    expect((await h.callback(checkJob, "result", { status: "SUCCEEDED", result: {} })).status).toBe(200);
    shown = await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } });
    expect(shown.body).toContain("Approve these commands");
    const applyForm = formOf(shown.body, "/apply");
    const decided = await h.post(link, applyForm.action, { ...applyForm.fields, decision: "approve" });
    expect(decided.headers["location"]).toContain("n=setupdone");
    expect(((await h.api("/v1/dev/projects")).body["projects"] as Array<{ latestRevision: number }>)[0]!.latestRevision).toBe(2);
  });

  it("ends a run the owner stops as the owner's stop: the fixed sentence, who stopped it, and the workspace given back", async () => {
    const h = await launch();
    const run = await startRun(h);
    const stopped = await h.api(`${ROUTE}/stop`, { method: "POST", body: { requestId: randomUUID() } });
    expect(stopped.status).toBe(202);
    expect(stopped.body).toMatchObject({ status: "failed", stop: "stopped_by_person", failure: "The setup run was stopped.", stoppedBy: { name: expect.any(String) } });
    expect((await h.store.get({ pk: `DEVTASK#${run.taskId}`, sk: "META" }))!["closedAt"]).toBeTypeOf("string");
    // The worker's late result changes nothing, and a stop with nothing running changes nothing.
    await h.callback(run.job, "result", { status: "CANCELLED" });
    expect((await h.api(ROUTE)).body).toMatchObject({ status: "failed", stop: "stopped_by_person" });
    expect((await h.api(`${ROUTE}/stop`, { method: "POST", body: { requestId: randomUUID() } })).status).toBe(200);
    // A new run may start after it.
    expect((await h.api(ROUTE, { method: "POST", body: { requestId: randomUUID() } })).status).toBe(202);
  });

  it("ends a run that failed, or whose answer cannot be read, with a fixed sentence and keeps no worker text", async () => {
    const h = await launch();
    const run = await startRun(h);
    const secret = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    await h.callback(run.job, "result", { status: "FAILED", error: `the model said ${secret}` });
    const failed = await h.api(ROUTE);
    expect(failed.body).toMatchObject({ status: "failed", stop: "infrastructure", failure: "The setup run could not go on. Try again." });
    expect(JSON.stringify(failed.body)).not.toContain(secret);
    const again = await startRun2(h);
    // A success with an answer that does not read is "unreadable", not a proposal.
    await h.callback(again.job, "result", { status: "SUCCEEDED", result: { setupProposal: { nonsense: true }, setupRunSummary: SUMMARY } });
    expect((await h.api(ROUTE)).body).toMatchObject({ status: "failed", stop: "infrastructure", failure: "Rovara ran the setup but couldn't read its answer. Try again." });
  });

  it("keeps what a run learned when it stopped at a limit, and never offers it for use when it needs a code change", async () => {
    const h = await launch();
    const run = await startRun(h);
    await h.callback(run.job, "result", { status: "SUCCEEDED", result: { setupProposal: proposal(), setupRunSummary: { ...SUMMARY, stop: "time_used", partial: true } } });
    expect((await h.api(ROUTE)).body).toMatchObject({ status: "ready", stop: "time_used", summary: { partial: true } });
    const next = await startRun2(h);
    await h.callback(next.job, "result", { status: "SUCCEEDED", result: { setupProposal: proposal(), setupRunSummary: { ...SUMMARY, stop: "needs_code_change", partial: false } } });
    expect((await h.api(ROUTE)).body).toMatchObject({ status: "failed", stop: "needs_code_change" });
  });

  it("reads every citation again from the code host: a quote the file does not hold is unverified and cannot be used, a host that cannot answer leaves it unchecked", async () => {
    const h = await launch();
    const run = await startRun(h);
    const bad = { ...proposal(), setup: [{ repo: "demo", commands: ["npm ci"], confidence: "high", from: [cite(3, "\"ci\": \"invented words here\"")] }] };
    await h.callback(run.job, "result", { status: "SUCCEEDED", result: { setupProposal: bad, setupRunSummary: SUMMARY } });
    const view = await h.api(ROUTE);
    expect(view.body).toMatchObject({ status: "ready", verification: { "setup-demo": "unverified", "tests-demo": "verified" } });
    // Using the setup leaves the unverified item out.
    const link = await h.browse("/setup/payments");
    const page = await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } });
    const form = formOf(page.body, "/confirm");
    expect((await h.post(link, form.action, { ...form.fields })).headers["location"]).toContain("n=setupdone");
    const apply = (await h.store.get({ pk: `ORG#${IMPLICIT_COMPANY_ID}#SETUP_DRAFT#payments`, sk: "APPLY" }))!;
    expect(apply["reply"]).toMatchObject({ used: ["tests-demo"], left: [{ id: "setup-demo", reason: "unverified" }] });
  });

  it("does not offer approval for a candidate whose check failed, names the failing step, and frees the project when the owner discards it", async () => {
    const h = await launch();
    const run = await startRun(h);
    await h.callback(run.job, "result", { status: "SUCCEEDED", result: { setupProposal: proposal(), setupRunSummary: SUMMARY } });
    const link = await h.browse("/setup/payments");
    const confirmForm = formOf((await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).body, "/confirm");
    await h.post(link, confirmForm.action, { ...confirmForm.fields });
    const apply = (await h.store.get({ pk: `ORG#${IMPLICIT_COMPANY_ID}#SETUP_DRAFT#payments`, sk: "APPLY" }))!;
    const checkJob = await h.nextJob((apply["check"] as { workspaceId: string }).workspaceId, new Set());
    await h.callback(checkJob, "result", { status: "FAILED", error: "setup step 0 (npm ci) failed: exit 1" });
    const shown = await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } });
    expect(shown.body).toContain("failed");
    expect(shown.body).toContain("setup: npm ci");
    expect(shown.body).not.toContain("Approve these commands");
    // Even a forged approval of it is refused by the gate: nothing is waiting for a decision.
    const forged = await h.runtime.app.setupAgent.page.decideProposal({ project: "payments", decision: "approve", approval: { requestId: "x", revision: 2, artifactDigest: String(apply["digest"]), kind: "setup" }, proof: { proofId: randomUUID(), method: "local-session", requestId: "x", revision: 2, artifactDigest: String(apply["digest"]), token: "not-a-proof" } });
    expect(forged.ok).toBe(false);
    expect(((await h.api("/v1/dev/projects")).body["projects"] as Array<{ latestRevision: number }>)[0]!.latestRevision).toBe(1);
    // The check's workspace and machine were closed when it ended.
    const workspace = (await h.store.get({ pk: `WORKSPACE#${(apply["check"] as { workspaceId: string }).workspaceId}`, sk: "META" }))!;
    expect(workspace["status"]).toBe("CLOSED");
    const discard = formOf(shown.body, "/discard");
    expect((await h.post(link, discard.action, { ...discard.fields })).headers["location"]).toContain("n=setupdone");
    expect((await h.api("/v1/admin/projects", { method: "POST", body: { ...PROJECT, orchestratorInstructions: "Changed." } })).status).toBe(201);
  });

  it("rejects a waiting setup on the owner's word and removes the candidate", async () => {
    const h = await launch();
    const run = await startRun(h);
    await h.callback(run.job, "result", { status: "SUCCEEDED", result: { setupProposal: proposal(), setupRunSummary: SUMMARY } });
    const link = await h.browse("/setup/payments");
    await h.post(link, formOf((await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).body, "/confirm").action, { ...formOf((await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).body, "/confirm").fields });
    const apply = (await h.store.get({ pk: `ORG#${IMPLICIT_COMPANY_ID}#SETUP_DRAFT#payments`, sk: "APPLY" }))!;
    const checkJob = await h.nextJob((apply["check"] as { workspaceId: string }).workspaceId, new Set());
    await h.callback(checkJob, "result", { status: "SUCCEEDED", result: {} });
    const applyForm = formOf((await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).body, "/apply");
    expect((await h.post(link, applyForm.action, { ...applyForm.fields, decision: "reject" })).headers["location"]).toContain("n=setupdone");
    expect(((await h.api("/v1/dev/projects")).body["projects"] as Array<{ latestRevision: number }>)[0]!.latestRevision).toBe(1);
    expect(await h.store.get({ pk: `ORG#${IMPLICIT_COMPANY_ID}#PROJECT#payments`, sk: "REVISION#0000000002" })).toBeUndefined();
    expect((await h.api("/v1/admin/projects", { method: "POST", body: { ...PROJECT, orchestratorInstructions: "Changed." } })).status).toBe(201);
  });

  it("refuses the approval when the project moved on after the owner looked: the catalog must still be at the revision the candidate was made from", async () => {
    const h = await launch();
    const run = await startRun(h);
    await h.callback(run.job, "result", { status: "SUCCEEDED", result: { setupProposal: proposal(), setupRunSummary: SUMMARY } });
    const link = await h.browse("/setup/payments");
    const confirmForm = formOf((await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).body, "/confirm");
    await h.post(link, confirmForm.action, { ...confirmForm.fields });
    const apply = (await h.store.get({ pk: `ORG#${IMPLICIT_COMPANY_ID}#SETUP_DRAFT#payments`, sk: "APPLY" }))!;
    const checkJob = await h.nextJob((apply["check"] as { workspaceId: string }).workspaceId, new Set());
    await h.callback(checkJob, "result", { status: "SUCCEEDED", result: {} });
    const applyForm = formOf((await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).body, "/apply");
    // Something else moves the project's latest revision (a restored backup, a Cloud writer) before the press.
    await h.store.update({ key: orgProjectCatalogKey(IMPLICIT_COMPANY_ID, "payments"), ops: [{ op: "set", path: ["latestRevision"], value: 5 }] });
    const decided = await h.post(link, applyForm.action, { ...applyForm.fields, decision: "approve" });
    expect(decided.headers["location"]).not.toContain("n=setupdone");
    expect((await h.store.get(orgProjectCatalogKey(IMPLICIT_COMPANY_ID, "payments")))!["latestRevision"]).toBe(5);
    expect((await h.store.get({ pk: `ORG#${IMPLICIT_COMPANY_ID}#SETUP_DRAFT#payments`, sk: "APPLY" }))!["state"]).toBe("checking");
  });

  it("checks the project's own setup on a fresh workspace, and refuses new work while the last check is failed, until it is checked again", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    expect((await h.api("/v1/app/projects/payments/setup-check")).body).toEqual({ status: "unchecked" });
    const requestId = randomUUID();
    const started = await h.api("/v1/app/projects/payments/setup-check", { method: "POST", body: { requestId } });
    expect(started.status).toBe(202);
    expect((await h.api("/v1/app/projects/payments/setup-check", { method: "POST", body: { requestId } })).status).toBe(200);
    expect((await h.api("/v1/app/projects/payments/setup-check", { method: "POST", body: { requestId: randomUUID() } })).status).toBe(409);
    expect((await h.api("/v1/app/projects/payments/setup-check")).body).toMatchObject({ status: "checking" });
    const job = await h.nextJob(started.body["workspaceId"] as string, new Set());
    expect(job).toMatchObject({ kind: "prepare", projectRevision: 1 });
    await h.callback(job, "result", { status: "FAILED", error: "setup step 0 (npm ci) failed: exit 1" });
    expect((await h.api("/v1/app/projects/payments/setup-check")).body).toMatchObject({ status: "failed" });
    const refused = await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint" } });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("failed its last check");
    // A setup run is how it gets fixed, so it is let through; a new revision outdates the failed check.
    expect((await h.api(ROUTE, { method: "POST", body: { requestId: randomUUID() } })).status).toBe(202);
    const ok = await h.api("/v1/app/projects/payments/setup-check", { method: "POST", body: { requestId: randomUUID() } });
    expect(ok.status).toBe(202);
    const second = await h.nextJob(ok.body["workspaceId"] as string, new Set());
    await h.callback(second, "result", { status: "SUCCEEDED", result: {} });
    expect((await h.api("/v1/app/projects/payments/setup-check")).body).toMatchObject({ status: "ready" });
    expect((await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint" } })).status).toBe(201);
  });

  it("is driven from the terminal too: start, status, journal, stop and open, with the person's command, a website and the approval left to the page", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    expect(await h.cli("setup-agent", "start", "payments")).toContain("Rovara is setting payments up.");
    expect(await h.cli("setup-agent", "status", "payments")).toContain("setup run: running");
    expect(await h.cli("setup-agent", "journal", "payments")).toContain("Nothing was run yet.");
    const json = JSON.parse(await h.cli("--json", "setup-agent", "status", "payments")) as { ok: boolean; data: { setupAgent: { status: string } } };
    expect(json).toMatchObject({ ok: true, data: { setupAgent: { status: "running" } } });
    expect(await h.cli("setup-agent", "stop", "payments")).toContain("setup run: failed");
    const before = h.opened.length;
    expect(await h.cli("setup-agent", "open", "payments")).toContain("Opened the setup page");
    expect(h.opened.length).toBe(before + 1);
    await expect(h.cli("setup-agent", "status", "../etc")).rejects.toThrow(/not a project name/u);
    await expect(h.cli("setup-agent", "command", "payments")).rejects.toThrow();
  });

  /** What the owner's page signs for exactly one request, revision and digest: the proof a decision of the owner's page carries. */
  const pageProof = (h: Harness, link: URL, binding: { requestId: string; revision: number; artifactDigest: string }) => {
    const sessions = h.runtime.app.pages.sessions;
    const session = sessions.find(link.pathname.split("/")[2])!;
    return { method: "local-session", token: sessions.issueProof(session.id, binding) };
  };
  /** Runs a project's setup run to a candidate whose check is still running; gives what the owner's page would offer once it passed. */
  async function toCandidate(h: Harness) {
    const run = await startRun(h);
    await h.callback(run.job, "result", { status: "SUCCEEDED", result: { setupProposal: proposal(), setupRunSummary: SUMMARY } });
    const link = await h.browse("/setup/payments");
    const confirmForm = formOf((await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).body, "/confirm");
    expect((await h.post(link, confirmForm.action, { ...confirmForm.fields })).headers["location"]).toContain("n=setupdone");
    const apply = (await h.store.get({ pk: `ORG#${IMPLICIT_COMPANY_ID}#SETUP_DRAFT#payments`, sk: "APPLY" }))!;
    const checkJob = await h.nextJob((apply["check"] as { workspaceId: string }).workspaceId, new Set());
    const offer = { requestId: proposalRequestId(String(apply["digest"]), Number(apply["candidateRevision"])), revision: Number(apply["candidateRevision"]), artifactDigest: String(apply["digest"]) };
    return { link, checkJob, offer };
  }
  const decideProposal = (h: Harness, link: URL, offer: { requestId: string; revision: number; artifactDigest: string }, credential?: { method: string; token: string }) => h.runtime.app.gate.decide({
    companyId: IMPLICIT_COMPANY_ID, kind: SETUP_APPLY_KIND, subjectId: "payments", requestId: offer.requestId, outcome: "approve", seen: { revision: offer.revision, artifactDigest: offer.artifactDigest }, credentials: [credential ?? pageProof(h, link, offer)],
  });

  it("is waiting for a decision only once the candidate's check passed: a valid page proof is refused while it runs and after it failed", async () => {
    const h = await launch();
    const { link, checkJob, offer } = await toCandidate(h);
    expect(await decideProposal(h, link, offer)).toMatchObject({ status: "refused", reason: "not_waiting" });
    await h.callback(checkJob, "result", { status: "FAILED", error: "setup step 0 (npm ci) failed: exit 1" });
    expect(await decideProposal(h, link, offer)).toMatchObject({ status: "refused", reason: "not_waiting" });
    expect(((await h.api("/v1/dev/projects")).body["projects"] as Array<{ latestRevision: number }>)[0]!.latestRevision).toBe(1);
  });

  it("is decided by a strong method only: a code host comment (or any weak method) cannot approve a setup or a website, and a person who is not the owner cannot either", async () => {
    const h = await launch();
    const { link, checkJob, offer } = await toCandidate(h);
    await h.callback(checkJob, "result", { status: "SUCCEEDED", result: {} });
    // A website a run asked for, open on the same page.
    const asking = await startRun2Safe(h);
    await h.callback(asking.job, "setup-agent", { kind: "host", host: "deps.exampledeps.dev" });
    const ask = (await h.store.get({ pk: `ORG#${IMPLICIT_COMPANY_ID}#PROJECT#payments`, sk: "SETUP_HOST_ASK#deps.exampledeps.dev" }))!;
    const hostOffer = { requestId: hostRequestId({ orgId: IMPLICIT_COMPANY_ID, project: "payments", host: "deps.exampledeps.dev", askedAt: String(ask["askedAt"]) }), revision: HOST_ASK_REVISION, artifactDigest: hostAskDigest({ host: "deps.exampledeps.dev", askedAt: String(ask["askedAt"]) }) };
    const decideHost = (credential: { method: string; token: string }, gate = h.runtime.app.gate) => gate.decide({
      companyId: IMPLICIT_COMPANY_ID, kind: SETUP_HOST_KIND, subjectId: hostAskSubjectId(IMPLICIT_COMPANY_ID, "payments", "deps.exampledeps.dev"), requestId: hostOffer.requestId, outcome: "approve",
      seen: { revision: hostOffer.revision, artifactDigest: hostOffer.artifactDigest }, credentials: [credential],
    });
    const comment = { method: "code-host-comment", token: "12345" };
    expect(await decideProposal(h, link, offer, comment)).toMatchObject({ status: "refused", reason: "method_not_allowed" });
    expect(await decideHost(comment)).toMatchObject({ status: "refused", reason: "method_not_allowed" });
    // A person the Approvers seam vouches for who does not hold the owner's role.
    const stranger: Approvers = {
      requirement: async () => ({ methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: true }),
      verify: async (_request, proof) => ({ approved: true, approver: { ...localOwnerPrincipal(), personId: "someone-else", roles: ["member"] }, method: proof.method, proofId: proof.proofId }),
    };
    const strangers = createDecisionGate({ store: h.store, approvers: stranger, audit: h.runtime.registry.require("audit-sink"), subjects: setupDecisionSubjects(h.runtime.app.flow.deps) });
    expect(await strangers.decide({ companyId: IMPLICIT_COMPANY_ID, kind: SETUP_APPLY_KIND, subjectId: "payments", requestId: offer.requestId, outcome: "approve", seen: { revision: offer.revision, artifactDigest: offer.artifactDigest }, credentials: [pageProof(h, link, offer)] })).toMatchObject({ status: "refused", reason: "not_the_approver" });
    expect(await decideHost(pageProof(h, link, hostOffer), strangers)).toMatchObject({ status: "refused", reason: "not_the_approver" });
    expect(((await h.api("/v1/dev/projects")).body["projects"] as Array<{ latestRevision: number }>)[0]!.latestRevision).toBe(1);
    // A proof signed for one request is not carried by a decision that names another (the page checks it before the gate is asked).
    const other = h.runtime.app.setupAgent.page.decideProposal({ project: "payments", decision: "approve", approval: { ...offer, revision: offer.revision + 1, kind: "setup" }, proof: { proofId: randomUUID(), ...pageProof(h, link, offer), requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest } });
    expect(await other).toMatchObject({ ok: false, reason: "invalid" });
    // The owner's own page proof decides both.
    expect(await decideHost(pageProof(h, link, hostOffer))).toMatchObject({ status: "decided" });
    expect(await decideProposal(h, link, offer)).toMatchObject({ status: "decided" });
    expect(((await h.api("/v1/dev/projects")).body["projects"] as Array<{ latestRevision: number }>)[0]!.latestRevision).toBe(2);
  });

  it("refuses to make a candidate on a stale base, and a page decision whose proof is for another request", async () => {
    const h = await launch();
    const run = await startRun(h);
    await h.callback(run.job, "result", { status: "SUCCEEDED", result: { setupProposal: proposal(), setupRunSummary: SUMMARY } });
    const link = await h.browse("/setup/payments");
    const confirmForm = formOf((await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).body, "/confirm");
    // The catalog names a revision the project's own row does not hold, so the flow reads revision 1 and the catalog says 5.
    await h.store.update({ key: orgProjectCatalogKey(IMPLICIT_COMPANY_ID, "payments"), ops: [{ op: "set", path: ["latestRevision"], value: 5 }] });
    const stale = await h.post(link, confirmForm.action, { ...confirmForm.fields });
    expect(stale.headers["location"]).not.toContain("n=setupdone");
    expect(await h.store.get({ pk: `ORG#${IMPLICIT_COMPANY_ID}#SETUP_DRAFT#payments`, sk: "APPLY" })).toBeUndefined();
    const mismatch = await h.runtime.app.setupAgent.page.decideProposal({
      project: "payments", decision: "approve", approval: { requestId: "x", revision: 2, artifactDigest: "d".repeat(64), kind: "setup" },
      proof: { proofId: randomUUID(), method: "local-session", requestId: "other", revision: 2, artifactDigest: "d".repeat(64), token: "t" },
    });
    expect(mismatch).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("lists the websites the owner allowed with their date, and takes one back on the page", async () => {
    const h = await launch();
    const run = await startRun(h);
    await h.callback(run.job, "setup-agent", { kind: "host", host: "deps.exampledeps.dev" });
    const link = await h.browse("/setup/payments");
    const hostForm = formOf((await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).body, "/host");
    await h.post(link, hostForm.action, { ...hostForm.fields, decision: "approve" });
    const shown = await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } });
    expect(shown.body).toContain("Websites you allowed");
    expect(shown.body).toMatch(/allowed \d{4}-\d{2}-\d{2}/u);
    const forget = formOf(shown.body, "/forget");
    expect((await h.post(link, forget.action, { ...forget.fields })).headers["location"]).toContain("n=setupdone");
    expect(await h.runtime.app.setupAgent.approvedHosts("payments")).toEqual([]);
    expect((await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).body).not.toContain("Websites you allowed");
    // It can be asked about again at once, and taking back a website that is not approved does nothing.
    expect((await h.callback(run.job, "setup-agent", { kind: "host", host: "deps.exampledeps.dev" })).body).toMatchObject({ outcome: "created" });
    expect(await h.runtime.app.setupAgent.page.forgetHost({ project: "payments", host: "deps.exampledeps.dev" })).toMatchObject({ ok: false });
    expect((await h.post(link, forget.action, { ...forget.fields, host: "nope.exampledeps.dev" })).headers["location"]).toContain("n=form");
  });

  it("refuses a script token and the wrong person, and answers as an unknown path when the setup agent is off", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const made = await h.runtime.app.scriptTokens.create({ requestId: randomUUID(), name: "ci", projects: ["payments"], permissions: ["read", "start"], days: 1 });
    const response = await fetch(`${h.runtime.url}${ROUTE}`, { method: "POST", headers: { authorization: `Bearer ${made.secret}`, "content-type": "application/json" }, body: JSON.stringify({ requestId: randomUUID() }) });
    expect([401, 403, 404]).toContain(response.status);
    const read = await fetch(`${h.runtime.url}${ROUTE}`, { headers: { authorization: `Bearer ${made.secret}` } });
    expect([401, 403, 404]).toContain(read.status);
    expect((await h.api(ROUTE)).status).toBe(200);
    const off = await launch({ environment: { ROVARA_SETUP_AGENT: "0" } });
    await off.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    expect((await off.api(ROUTE)).status).toBe(404);
    const link = await off.browse("/setup/payments");
    expect((await raw(off.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).status).toBe(404);
  });

  it("will not start without a model key, and says so on the page", async () => {
    const h = await launch({ environment: { ANTHROPIC_API_KEY: "" } });
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const started = await h.api(ROUTE, { method: "POST", body: { requestId: randomUUID() } });
    expect(started.status).toBe(404);
    expect(JSON.stringify(started.body)).toContain("model proxy");
    const link = await h.browse("/setup/payments");
    expect((await raw(h.runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } })).body).toContain("no model key");
  });
});

/** A second run for the same project while the first one's candidate waits (a run may start; only a new revision is held back). */
async function startRun2Safe(h: Harness) {
  const started = await h.api(ROUTE, { method: "POST", body: { requestId: randomUUID() } });
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const taskId = started.body["taskId"] as string;
  const workspaceId = (await h.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
  const seen = new Set<string>();
  await h.callback(await h.nextJob(workspaceId, seen), "result", { status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: BASE }] } });
  return { taskId, workspaceId, job: await h.nextJob(workspaceId, seen) };
}

/** Starts a second run for the same project once the first ended. */
async function startRun2(h: Harness) {
  const started = await h.api(ROUTE, { method: "POST", body: { requestId: randomUUID() } });
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const taskId = started.body["taskId"] as string;
  const workspaceId = (await h.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!["workspaceId"] as string;
  const seen = new Set<string>();
  const prepare = await h.nextJob(workspaceId, seen);
  await h.callback(prepare, "result", { status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: BASE }] } });
  return { taskId, workspaceId, job: await h.nextJob(workspaceId, seen) };
}
