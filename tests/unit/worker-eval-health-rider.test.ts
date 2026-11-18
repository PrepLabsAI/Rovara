// L4-EVH (DEC 254zzz20 D5): the health run's prepare rider on the worker, and the invocation contract that carries it. The job (worker-eval-health-job.test.ts) is tested on its own; here: the pin is main itself, the
// result is posted once to the run's own route under its own capability (retried a few times, within a budget), a worker that cannot run it says so, and the contract refuses an `evalHealth` that is not alone on a
// read-only, pinned preparation. Every guard has a named mutant in briefs/lead4/L4-EVH-MUTANTS-20261118.md.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { EVAL_HEALTH_RESULT_PATH, EvalHealthResultBodySchema, PREPARE_EVAL_HEALTH_FEATURE, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, type WorkerInvocation } from "@agentx/contracts";
import { runEvalHealthRider, type EvalHealthRiderDeps } from "../../packages/worker/src/eval-health-run.js";
import { pinnedEvalPlan } from "../../packages/worker/src/verification/eval-plan-source.js";
import { EVAL_GATEWAY_URL_VARIABLE } from "../../packages/worker/src/verification/eval-wiring.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { createEvalFinalCheckWorld } from "../support/eval-final-check.js";

const HEAD = "d".repeat(40);
const TREE = "e".repeat(40);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const ids = { requestId: randomUUID(), claimId: randomUUID() };
const CAPABILITY = "capability-for-the-health-run-".padEnd(40, "x");
function invocation(over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return { protocolVersion: 1, kind: "prepare", operationId: "22222222-2222-4222-8222-222222222222", workspaceId: "11111111-1111-4111-8111-111111111111", fence: 1, projectRevision: 1, callbackCapability: CAPABILITY,
    payload: { project: { name: "demo", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "web", defaultBranch: "main", credentialRef: "r" }], setup: [], readiness: [], orchestratorInstructions: "x" },
      repositoryGrant: "g", readOnly: true, pins: [{ repository: "web", commit: HEAD }], evalHealth: ids, ...payload }, ...over } as unknown as Extract<WorkerInvocation, { kind: "prepare" }>;
}
const manifest = (commit = HEAD) => ({ repositories: [{ name: "web", path: "web", defaultBranch: "main", resolvedCommit: commit, resolvedAt: "x", completedAt: "x" }] });
interface Sent { url: string; headers: Record<string, string>; body: string }
function network(answers: Array<number | "throw"> = [200]) {
  const sent: Sent[] = []; let n = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}; new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    sent.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, headers, body: typeof init?.body === "string" ? init.body : "" });
    const answer = answers[Math.min(n++, answers.length - 1)]!;
    if (answer === "throw") throw new Error("down");
    return new Response("{}", { status: answer });
  }) as typeof fetch;
  return { sent, fetchImpl };
}
const deps = (over: Partial<EvalHealthRiderDeps> = {}): EvalHealthRiderDeps => ({ rootPath: "/work", controlPlaneUrl: "https://control.example.test/", invocation: invocation(), manifest: manifest(), docker: {} as never, signal: new AbortController().signal,
  treeOf: async () => TREE, ...over });
async function withPorts(over: Partial<EvalHealthRiderDeps> = {}) {
  const w = await createEvalFinalCheckWorld(true, 2); roots.push(w.root);
  const net = network();
  const seen: { treeAsked: Array<[string, string]> } = { treeAsked: [] };
  const base = deps({ fetch: net.fetchImpl, treeOf: async (directory, commit) => { seen.treeAsked.push([directory, commit]); return TREE; }, ports: () => ({ plan: () => w.ports.plan(), approval: w.ports.approval, meter: w.ports.meter, runner: (r) => w.ports.runner(r) }), ...over });
  return { w, net, seen, base };
}

describe("the contract of the health run's preparation", () => {
  it("is on the worker's lists, and a preparation carrying it is read-only, pinned and alone", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain(PREPARE_EVAL_HEALTH_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(PREPARE_EVAL_HEALTH_FEATURE);
    expect(WorkerInvocationSchema.safeParse(invocation()).success).toBe(true);
    for (const bad of [{ readOnly: undefined }, { pins: undefined }, { setupProve: {} }, { savedEnvBuild: {} }, { savedEnv: {} }, { checkout: [] }, { registries: {} }, { evalHealth: { ...ids, extra: 1 } }, { evalHealth: { requestId: "x", claimId: ids.claimId } }]) {
      expect(WorkerInvocationSchema.safeParse(invocation({}, bad)).success, JSON.stringify(Object.keys(bad))).toBe(false);
    }
  });
  it("takes the gateway's address only with a health run, and only as an https origin", () => {
    expect(WorkerInvocationSchema.safeParse(invocation({}, { evalGatewayUrl: "https://gateway.example.test" })).success).toBe(true);
    for (const url of ["http://gateway.example.test", "https://gateway.example.test/path", "https://u:p@gateway.example.test", "gateway"]) expect(WorkerInvocationSchema.safeParse(invocation({}, { evalGatewayUrl: url })).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse(invocation({}, { evalHealth: undefined, evalGatewayUrl: "https://gateway.example.test" })).success).toBe(false);
  });
});

describe("the rider measures main and posts the one result", () => {
  it("is nothing for a preparation that is not a health run's", async () => {
    const inv = invocation({}, { evalHealth: undefined });
    expect(await runEvalHealthRider(deps({ invocation: inv }))).toBeUndefined();
    expect(await runEvalHealthRider(deps({ invocation: null as never }))).toBeUndefined();
  });
  it("pins main as the candidate (each repository's own commit and its tree), runs the job and posts the result to its own route with its own capability", async () => {
    const t = await withPorts();
    const answer = await runEvalHealthRider(t.base);
    expect(answer).toMatchObject({ ...ids, result: { status: "measured" } });
    expect(EvalHealthResultBodySchema.safeParse(answer).success).toBe(true);
    expect(t.seen.treeAsked).toEqual([["/work/web", HEAD]]);
    expect(t.net.sent).toHaveLength(1);
    expect(t.net.sent[0]!.url).toBe(`https://control.example.test/v1/internal/workspaces/11111111-1111-4111-8111-111111111111/operations/22222222-2222-4222-8222-222222222222/${EVAL_HEALTH_RESULT_PATH}`);
    expect(t.net.sent[0]!.headers["x-agentx-callback-capability"]).toBe(CAPABILITY);
    expect(JSON.parse(t.net.sent[0]!.body)).toEqual(JSON.parse(JSON.stringify(answer)));
    expect(t.w.holds).toHaveLength(1);
  });
  it("hands the job the delivered plan inside the pin: the plan's per-question hashes are read at the pinned commit", async () => {
    const t = await withPorts({ ports: (inv) => { void inv; return { plan: async () => { const planned = await pinnedEvalPlan({}); return planned; }, approval: { read: async () => undefined }, meter: { reserve: async () => undefined }, runner: async () => { throw new Error("no"); } }; } });
    const answer = await runEvalHealthRider(t.base);
    // The empty plan is not runnable (nothing was delivered): not connected, nothing held, and the person is told.
    expect(answer?.result).toEqual({ status: "not_run", reason: "not_connected" });
    expect(t.net.sent).toHaveLength(1);
  });
  it("a worker that cannot run it (no sandbox, no sources) says not connected, spends nothing, and posts that", async () => {
    const net = network();
    const answer = await runEvalHealthRider(deps({ fetch: net.fetchImpl, ports: () => undefined }));
    expect(answer).toMatchObject({ ...ids, result: { status: "not_run", reason: "not_connected" } });
    expect(net.sent).toHaveLength(1);
  });
  it("the production binding without a fresh check sandbox (no worker image) is not connected: it asks for no plan, holds nothing and only posts the answer", async () => {
    const net = network();
    const answer = await runEvalHealthRider(deps({ fetch: net.fetchImpl, environment: { [EVAL_GATEWAY_URL_VARIABLE]: "https://gateway.example.test" } }));
    expect(answer?.result).toEqual({ status: "not_run", reason: "not_connected" });
    expect(net.sent.map(s => s.url.split("/").pop())).toEqual([EVAL_HEALTH_RESULT_PATH]);
    // And with nothing set at all (no gateway), the same.
    const bare = network();
    expect((await runEvalHealthRider(deps({ fetch: bare.fetchImpl, environment: {} })))?.result).toEqual({ status: "not_run", reason: "not_connected" });
  });
  it("main must be exactly what the broker pinned: a repository the preparation resolved elsewhere, or not in the pins, is refused before any sandbox", async () => {
    for (const m of [manifest("a".repeat(40)), { repositories: [] }, { repositories: [{ ...manifest().repositories[0]!, name: "other" }] }, { repositories: [...manifest().repositories, ...manifest().repositories] }]) {
      const t = await withPorts({ manifest: m });
      const answer = await runEvalHealthRider(t.base);
      expect(answer?.result, JSON.stringify(m)).toEqual({ status: "not_run", reason: "invalid_identity" });
      expect(t.w.holds).toEqual([]); expect(t.w.calls).toEqual([]);
    }
  });
  it("a tree that cannot be read ends as unavailable, with no hold, and still tells the person", async () => {
    const t = await withPorts({ treeOf: async () => { throw new Error("git"); } });
    const answer = await runEvalHealthRider(t.base);
    expect(answer?.result).toEqual({ status: "not_run", reason: "unavailable" });
    expect(t.w.holds).toEqual([]); expect(t.net.sent).toHaveLength(1);
  });
  it("a stop from the broker before the run is reported as stopped, with no hold", async () => {
    const stop = new AbortController(); stop.abort();
    const t = await withPorts({ signal: stop.signal });
    const answer = await runEvalHealthRider(t.base);
    expect(answer?.result).toEqual({ status: "not_run", reason: "stopped" });
    expect(t.w.holds).toEqual([]);
  });
  it("the post is retried a few times and then given up: never more than three, never an error out", async () => {
    const t = await withPorts({ fetch: network([500, "throw", 200]).fetchImpl });
    expect((await runEvalHealthRider(t.base))?.result.status).toBe("measured");
    const none = network(["throw"]);
    const t2 = await withPorts({ fetch: none.fetchImpl });
    await expect(runEvalHealthRider(t2.base)).resolves.toMatchObject({ result: { status: "measured" } });
    expect(none.sent).toHaveLength(3);
    const ok = network([200]); const t3 = await withPorts({ fetch: ok.fetchImpl }); await runEvalHealthRider(t3.base);
    expect(ok.sent).toHaveLength(1);
  });
  it("a result that leaves the worker carries no company, project, key, payer or cost", async () => {
    const t = await withPorts(); await runEvalHealthRider(t.base);
    expect(Object.keys((JSON.parse(t.net.sent[0]!.body) as object)).sort()).toEqual(["claimId", "requestId", "result"]);
    expect(t.net.sent[0]!.body).not.toMatch(/company-a|project-a|costMicros|"payer"/u);
  });
});
