// The task-level binding of the final-check eval, end to end on fakes: the control plane's model-access route, the gateway's product route (hold, call, release) and the
// fresh sandbox are scripts behind one injected fetch; the exec, the bridge, the stage guard and the eval itself are the real ones. No network, no Docker, no model.
// Rules: off by default (no setting, no sources, no request = no ports, byte-identical to before); the task token goes only to the origin it was minted for and never into the
// sandbox, an artifact or a log; any outage is Not run with no spend left unaccounted; one invocation's token, approval and plan are never another's.
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attestRovaraOnlyBaseCheckout, evalResultFromArtifact, EvalRoundArtifactSchema, type EvalRequest, type EvalSpendGrant } from "@agentx/contracts";
import { evalEnvironmentWithGateway, evalFinalCheckForTask, evalGatewayOriginFrom, evalGatewayTokenSource, evalHostSourcesFor, EVAL_GATEWAY_URL_VARIABLE, type EvalHostSources } from "../../packages/worker/src/verification/eval-wiring.js";
import { runFinalCheckEval } from "../../packages/worker/src/verification/eval-final-check.js";
import type { FreshEvalSandbox, FreshEvalSandboxRun } from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { collectModelBridge } from "../../packages/worker/src/model-helper-bridge-client.js";
import { createEvalFinalCheckWorld } from "../support/eval-final-check.js";
import { frame } from "../support/eval-model-access.js";

const GATEWAY = "https://gateway.example.test"; const CONTROL = "https://control.example.test";
const TOKEN_A = "task-token-for-company-a-abcdefghijkl"; const TOKEN_B = "task-token-for-company-b-abcdefghijkl"; const CAP_A = "capability-a-".padEnd(40, "a"); const CAP_B = "capability-b-".padEnd(40, "b");
const SCOPE = "0f8fad5b-d9cb-469f-a165-70867728950e"; const hash = "b".repeat(64);
const request: EvalRequest = { aiChange: true, reason: "eval_hint", evalPass: 1, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 };
const env = { [EVAL_GATEWAY_URL_VARIABLE]: GATEWAY };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (text: string): string => Buffer.from(text).toString("base64");
const answerLines = (cost = 10, cls = "ok", status = 200): Response => new Response([{ kind: "head", status, headers: [["content-type", "application/json"]] }, { kind: "chunk", b64: b64("{\"ok\":true}") }, { kind: "settle", status, class: cls, costMicros: cost, estimated: false }].map((l) => JSON.stringify(l)).join("\n") + "\n", { status: 200, headers: { "content-type": "application/x-ndjson" } });

interface Sent { readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly body: string }
interface Net {
  readonly fetchImpl: typeof fetch; readonly sent: Sent[];
  gatewayRequests(): Sent[]; accessRequests(): Sent[]; holds(): Sent[]; releases(): Sent[]; calls(): Sent[];
}
/** The control plane's access route and the gateway's three routes. Every other URL is recorded and fails like a closed port. */
function network(opts: { tokens?: Record<string, string>; baseUrl?: string; access?: () => Response; hold?: (n: number) => Response; call?: (n: number) => Response; release?: () => Response } = {}): Net {
  const sent: Sent[] = []; let holdN = 0; let callN = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {}; new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : typeof init?.body === "string" ? init.body : "";
    sent.push({ url, method: init?.method ?? "GET", headers, body });
    const target = new URL(url);
    if (target.origin === CONTROL && target.pathname === "/v1/internal/model-access") {
      if (opts.access !== undefined) return opts.access();
      const token = (opts.tokens ?? { [CAP_A]: TOKEN_A })[headers["x-agentx-callback-capability"] ?? ""];
      return token === undefined ? json({ error: { code: "CALLBACK_FORBIDDEN" } }, 403) : json({ baseUrl: opts.baseUrl ?? GATEWAY, apiKey: token, expiresAt: Date.now() + 3_600_000 });
    }
    if (target.origin === GATEWAY && target.pathname === "/v1/product/eval/hold") {
      if (opts.hold !== undefined) return opts.hold(holdN++);
      const asked = JSON.parse(body) as { calls: number; costMicros: number }; holdN++;
      return json({ scope: SCOPE, calls: asked.calls, costMicros: asked.costMicros, expiresAt: 1 });
    }
    if (target.origin === GATEWAY && target.pathname === "/v1/product/eval/release") return (opts.release ?? (() => json({ released: 0 })))();
    if (target.origin === GATEWAY && target.pathname.startsWith("/v1/product/gemini/")) return (opts.call ?? (() => answerLines()))(callN++);
    throw new Error("connection refused");
  }) as typeof fetch;
  const gatewayRequests = () => sent.filter((s) => new URL(s.url).origin === GATEWAY);
  return { fetchImpl, sent, gatewayRequests, accessRequests: () => sent.filter((s) => new URL(s.url).origin === CONTROL), holds: () => sent.filter((s) => s.url.endsWith("/v1/product/eval/hold")), releases: () => sent.filter((s) => s.url.endsWith("/v1/product/eval/release")), calls: () => sent.filter((s) => s.url.includes("/v1/product/gemini/")) };
}

interface Built { readonly sources: EvalHostSources; readonly w: Awaited<ReturnType<typeof createEvalFinalCheckWorld>>; readonly runs: FreshEvalSandboxRun[]; readonly runDir: string }
/** Sources over the shared eval world; the sandbox speaks to the bridge's socket as the helper would, and writes the measures file the eval reads. */
async function sources(opts: { newPass?: boolean; available?: boolean; grant?: EvalSpendGrant; n?: number; sandbox?: (inner: FreshEvalSandbox) => FreshEvalSandbox } = {}): Promise<Built> {
  const w = await createEvalFinalCheckWorld(opts.newPass ?? true, opts.n ?? 4); roots.push(w.root);
  const runDir = await mkdtemp(join(tmpdir(), "ew-")); roots.push(runDir);
  const runs: FreshEvalSandboxRun[] = []; let reports = 0;
  const inner: FreshEvalSandbox = {
    available: () => opts.available ?? true,
    async run(input) {
      runs.push(input);
      for (const id of input.ids) for (let i = 0; i < input.runs; i++) await collectModelBridge({ socketPath: input.model.socketPath, mode: "real", token: input.model.token, frame: { ...frame(id) } });
      const file = `wired-report-${String(++reports)}.json`;
      await writeFile(join(w.root, file), JSON.stringify({ schemaVersion: 1, eval_set_hash: hash, measures: [{ name: "accuracy", unit: "fraction", direction: "up_good", value: 1 }],
        questions: input.ids.map((id) => ({ id, samples: Array.from({ length: input.runs }, () => ({ pass: input.side === "old" || (opts.newPass ?? true), answer: input.side === "old" ? "old" : "new" })) })) }));
      return { report: { root: w.root, cwd: ".", argument: file, notBeforeMs: Date.now() - 1000 }, ...(input.side === "old" ? { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: w.plan.key.baseCommit }) } : {}) };
    },
  };
  const grant = opts.grant ?? w.grant;
  return { w, runs, runDir, sources: { plan: () => w.ports.plan(), approval: { read: async () => grant }, cache: w.ports.cache, baselines: w.ports.baselines, sandbox: opts.sandbox?.(inner) ?? inner, runDir, changedPrompt: () => true, modelAllowed: () => true } };
}
const bind = (b: Built, net: Net, over: Partial<Parameters<typeof evalFinalCheckForTask>[0]> = {}) =>
  evalFinalCheckForTask({ requested: true, environment: env, controlPlaneUrl: CONTROL, capability: CAP_A, sources: b.sources, fetch: net.fetchImpl, ...over });
const facts = (signal = new AbortController().signal) => ({ status: "verified", candidateDigest: "a".repeat(64), signal });
const run = async (ports: ReturnType<typeof evalFinalCheckForTask>) => EvalRoundArtifactSchema.parse(await runFinalCheckEval(request, ports, facts()));
const reason = (artifact: unknown) => { const result = evalResultFromArtifact(artifact); expect(result.label).toBe("Not run"); expect(result.disposition).toMatchObject({ check: "neutral", retry: true }); return result.notRun!.reason; };

describe("off by default", () => {
  it.each([
    ["the setting is unset", { env: {} }], ["the setting is empty", { env: { [EVAL_GATEWAY_URL_VARIABLE]: "  " } }], ["the setting is http", { env: { [EVAL_GATEWAY_URL_VARIABLE]: "http://gateway.example.test" } }],
    ["the setting carries a path", { env: { [EVAL_GATEWAY_URL_VARIABLE]: `${GATEWAY}/v1` } }], ["the setting carries credentials", { env: { [EVAL_GATEWAY_URL_VARIABLE]: "https://u:p@gateway.example.test" } }],
    ["the setting carries a query", { env: { [EVAL_GATEWAY_URL_VARIABLE]: `${GATEWAY}?a=b` } }], ["the setting is not a URL", { env: { [EVAL_GATEWAY_URL_VARIABLE]: "not a url" } }],
    ["the setting is a loopback http address", { env: { [EVAL_GATEWAY_URL_VARIABLE]: "http://127.0.0.1:8080" } }], ["the setting is too long", { env: { [EVAL_GATEWAY_URL_VARIABLE]: `https://${"a".repeat(600)}.example.test` } }],
    ["the task asked for no eval", { requested: false }], ["there are no trusted sources", { noSources: true }], ["the control plane address is empty", { controlPlaneUrl: "" }], ["the capability is empty", { capability: "" }],
  ] as Array<[string, { env?: NodeJS.ProcessEnv; requested?: boolean; noSources?: boolean; controlPlaneUrl?: string; capability?: string }]>)("binds nothing when %s", async (_name, change) => {
    const b = await sources(); const net = network();
    const ports = evalFinalCheckForTask({ requested: change.requested ?? true, environment: change.env ?? env, controlPlaneUrl: change.controlPlaneUrl ?? CONTROL, capability: change.capability ?? CAP_A, sources: change.noSources === true ? undefined : b.sources, fetch: net.fetchImpl });
    expect(ports).toBeUndefined();
    expect(net.sent).toEqual([]);
    // the request then reads "not connected" with no call at all
    expect(reason(await runFinalCheckEval(request, ports, facts()))).toBe("not_connected");
    expect(net.sent).toEqual([]);
  });
  it("the trusted plan, approval and cache come over the eval-plan route (DEC 253j(1)); without the check round's own host (TE-B1's fresh sandbox) there are no sources, so the eval stays not connected", () => {
    const invocation = { workspaceId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222", callbackCapability: CAP_A };
    expect(evalHostSourcesFor(invocation, { controlPlaneUrl: "http://broker.invalid" })).toBeUndefined();
    const sandbox = { available: () => true, run: async () => { throw new Error("unused"); } } as never;
    const bound = evalHostSourcesFor(invocation, { controlPlaneUrl: "http://broker.invalid", check: { sandbox, runDir: "/tmp/x", modelAllowed: () => true } });
    expect(bound === undefined ? [] : Object.keys(bound).sort()).toEqual(["approval", "baselines", "cache", "modelAllowed", "plan", "runDir", "sandbox"]);
    expect(evalHostSourcesFor(invocation, { controlPlaneUrl: "", check: { sandbox, runDir: "/tmp/x", modelAllowed: () => true } })).toBeUndefined();
  });
  it("main.ts binds it for a task that carries an eval request, passing the invocation's own capability and the sources only then, and spreads the ports only when there are some", () => {
    const main = readFileSync(join(__dirname, "../../packages/worker/src/main.ts"), "utf8");
    expect(main).toContain('from "./verification/eval-wiring.js"');
    expect(main).toMatch(/const evalRequested = invocation\.payload\.evalRequest !== undefined;/u);
    expect(main).toMatch(/evalFinalCheckForTask\(\{ requested: evalRequested, environment: evalEnvironmentWithGateway\(process\.env, invocation\.payload\.evalGatewayUrl\), controlPlaneUrl, capability: invocation\.callbackCapability, sources: evalRequested \? evalHostSourcesFor\(invocation, \{ controlPlaneUrl,/u);
    // DEC 253n(2): the fresh check sandbox is the worker's own (its environment, Docker and workspace key), built per check from the delivered plan.
    // L4-E12 (E1): the fresh sandbox also gets the task's own services, from the task's dependency plan, only through the starter (undefined without a configuration or a local plan).
    // L4-EINT: the services starter is told the side and the prepared stand-in set and the production stand-ins are always asked for (no switch).
    expect(main).toMatch(/fresh: \{ environment: process\.env, docker: evalDocker \?\? createDockerCli\(\), workspaceKey: \(\) => setupWorkspaceKey\(rootPath\),\s*\/\/[^\n]*\n\s*services: \(context\) => createEvalServicesStarter\(\{ config: testServicesConfigFromEnvironment\(process\.env\), dependencies: invocation\.payload\.testEnvironment\?\.dependencies, \.\.\.\(context\.prepared === undefined \? \{\} : \{ seed: evalDatabaseSeed\(\{ docker: evalDocker \?\? createDockerCli\(\), side: context\.side, prepared: context\.prepared \}\) \}\) \}\),\s*\/\/[^\n]*\n\s*standIns: \{ dependencies: invocation\.payload\.testEnvironment\?\.dependencies \} \} \}\) : undefined \}\)/u);
    expect(main).toMatch(/\.\.\.\(evalFinalCheck === undefined \? \{\} : \{ evalFinalCheck \}\)/u);
  });
});

describe("a fresh sandbox decides the round", () => {
  it("without one the round is the working round: needs a fresh sandbox, and no token is asked for and nothing is held", async () => {
    const b = await sources({ available: false }); const net = network();
    const ports = bind(b, net)!;
    expect(ports.roundKind).toBe("working");
    expect(reason(await runFinalCheckEval(request, ports, facts()))).toBe("needs_fresh_sandbox");
    expect(net.sent).toEqual([]); expect(b.runs).toEqual([]);
  });
  it("a sandbox whose availability look throws is the working round", async () => {
    const b = await sources({ sandbox: (inner) => ({ ...inner, available: () => { throw new Error("x"); } }) }); const net = network();
    expect(bind(b, net)!.roundKind).toBe("working");
  });
});

describe("the live path, on fakes", () => {
  it("worse: the answers the new side gave are measured and the re-ask stages are held and released too", async () => {
    const b = await sources({ newPass: false }); const net = network();
    const artifact = await run(bind(b, net));
    expect(evalResultFromArtifact(artifact)).toMatchObject({ label: "Worse on eval", fixRequested: true });
    expect(net.holds().length).toBeGreaterThan(1); expect(net.holds().length).toBe(net.releases().length);
  });
});

describe("the token goes only to the origin it was minted for", () => {
  it.each([
    ["a proxy key for another origin", "https://proxy.example.test"],
  ])("%s is never sent: no hold, no call, nothing on the gateway, and the eval is Not run", async (_name, baseUrl) => {
    const b = await sources(); const net = network({ baseUrl });
    const artifact = await runFinalCheckEval(request, bind(b, net), facts());
    expect(["cap", "provider_error"]).toContain(reason(artifact));
    expect(net.gatewayRequests()).toEqual([]);
    for (const r of net.sent) expect(JSON.stringify(r)).not.toContain(TOKEN_A);
    expect(b.runs).toEqual([]);
  });
  it("a source of the token that is for the right origin works, with or without a trailing slash on the setting", async () => {
    const net = network();
    const source = evalGatewayTokenSource({ origin: GATEWAY, controlPlaneUrl: `${CONTROL}/`, capability: CAP_A, fetch: net.fetchImpl });
    expect(await source()).toBe(TOKEN_A);
    expect(net.accessRequests()[0]!.url).toBe(`${CONTROL}/v1/internal/model-access`);
  });
});

describe("any outage is Not run, with the spend accounted", () => {
  it.each([
    ["the control plane refuses the capability", () => network({ tokens: {} }), ["cap", "provider_error"]],
    ["the control plane answers something unexpected", () => network({ access: () => json({ nothing: true }) }), ["cap", "provider_error"]],
    ["the control plane is down", () => network({ access: () => { throw new Error("socket-secret-detail"); } }), ["cap", "provider_error"]],
    ["the gateway refuses the hold", () => network({ hold: () => json({ error: { type: "budget_exceeded" } }, 422) }), ["cap"]],
    ["the gateway is down at the hold", () => network({ hold: () => { throw new Error("secret-detail"); } }), ["cap"]],
    ["the gateway answers the hold with another amount", () => network({ hold: () => json({ scope: SCOPE, calls: 1, costMicros: 1 }) }), ["cap"]],
  ] as Array<[string, () => Net, string[]]>)("%s", async (_name, make, reasons) => {
    const b = await sources(); const net = make();
    const artifact = await runFinalCheckEval(request, bind(b, net), facts());
    expect(reasons).toContain(reason(artifact));
    expect(net.calls()).toEqual([]); expect(b.runs).toEqual([]);
    expect(JSON.stringify(artifact)).not.toContain("secret-detail");
  });
  it("a stop while the eval runs ends it Not run (stopped), with nothing open and the folder empty", async () => {
    const stop = new AbortController();
    const b = await sources({ sandbox: (inner) => ({ ...inner, run: async (input) => { stop.abort(); return inner.run(input); } }) }); const net = network();
    const artifact = await runFinalCheckEval(request, bind(b, net), facts(stop.signal));
    expect(reason(artifact)).toBe("stopped");
    const { readdir } = await import("node:fs/promises"); expect(await readdir(b.runDir)).toEqual([]);
  });
});

describe("the model and the meter", () => {
  it("the meter options reach the stage: an answer over the configured byte limit is a provider error with an unknown cost", async () => {
    const b = await sources(); const net = network();
    const withLimit = { ...b.sources, meter: { responseBytes: 5 } };
    expect(reason(await runFinalCheckEval(request, bind(b, net, { sources: withLimit }), facts()))).toBe("provider_error");
    const b2 = await sources(); const net2 = network();
    expect((await run(bind(b2, net2))).outcome).toBe("done");
  });
});

describe("one invocation is never another's (two companies)", () => {
  it("the capability of invocation A never rides on B's token request, and B's token source starts empty", async () => {
    const net = network({ tokens: { [CAP_A]: TOKEN_A, [CAP_B]: TOKEN_B } });
    const sourceA = evalGatewayTokenSource({ origin: GATEWAY, controlPlaneUrl: CONTROL, capability: CAP_A, fetch: net.fetchImpl });
    const sourceB = evalGatewayTokenSource({ origin: GATEWAY, controlPlaneUrl: CONTROL, capability: CAP_B, fetch: net.fetchImpl });
    expect(await sourceA()).toBe(TOKEN_A); expect(await sourceB()).toBe(TOKEN_B); expect(await sourceA()).toBe(TOKEN_A);
    expect(net.accessRequests().map((r) => r.headers["x-agentx-callback-capability"])).toEqual([CAP_A, CAP_B]);
  });
});

// Lead 4 L4-EVW: a hosted worker has no setting of its own; the broker delivers the gateway's origin with the eval request.
describe("the gateway origin the broker delivers (hosted worker)", () => {
  it.each(["not a url"])("refuses a delivered value that is not an https origin (%s)", (bad) => {
    const host: NodeJS.ProcessEnv = { OTHER: "1" };
    const merged = evalEnvironmentWithGateway(host, bad);
    expect(merged).toBe(host);
    expect(evalGatewayOriginFrom(merged)).toBeUndefined();
  });
  it("the host's own setting always wins, whether it is good, empty-looking or one that keeps the eval off", () => {
    const good = { [EVAL_GATEWAY_URL_VARIABLE]: "https://own.example.test" };
    expect(evalEnvironmentWithGateway(good, GATEWAY)).toBe(good);
    expect(evalGatewayOriginFrom(evalEnvironmentWithGateway(good, GATEWAY))).toBe("https://own.example.test");
    // set to something that makes the eval stay off (http): the delivered value does not turn it on
    const off = { [EVAL_GATEWAY_URL_VARIABLE]: "http://gateway.example.test" };
    expect(evalEnvironmentWithGateway(off, GATEWAY)).toBe(off);
    expect(evalGatewayOriginFrom(evalEnvironmentWithGateway(off, GATEWAY))).toBeUndefined();
    // blank counts as unset (the same trim the reader applies)
    expect(evalGatewayOriginFrom(evalEnvironmentWithGateway({ [EVAL_GATEWAY_URL_VARIABLE]: "  " }, GATEWAY))).toBe(GATEWAY);
  });
});


it("carries the internal fill capability through host sources and re-asks both sides exactly once", async () => {
  const b = await sources(); const net = network(); const asked: Array<readonly string[]> = [];
  const fillMissingRows = async (r: { readonly ids: readonly string[] }) => { asked.push(r.ids); return ["q1"]; };
  const check = { sandbox: b.sources.sandbox, runDir: b.runDir, modelAllowed: b.sources.modelAllowed, fillMissingRows };
  expect(evalHostSourcesFor({ workspaceId: SCOPE, operationId: SCOPE, callbackCapability: CAP_A }, { controlPlaneUrl: CONTROL, check })?.fillMissingRows).toBe(fillMissingRows);
  const ports = bind(b, net, { sources: { ...b.sources, fillMissingRows } })!;
  expect(ports.fillMissingRows).toBe(fillMissingRows);
  // The host-to-round seam can be exercised without opening a real Unix socket.
  ports.runner = b.w.ports.runner; ports.meter = b.w.ports.meter;
  expect(evalResultFromArtifact(await run(ports)).outcome).toBe("ran");
  expect(asked).toHaveLength(1);
  expect(b.w.stages.map(r => [r.side, r.ids, r.runs])).toEqual([["new", ["q0", "q1", "q2", "q3"], 1], ["old", ["q1"], 3], ["new", ["q1"], 1]]);
});
