// L4-EVV: a Vertex AI shaped call under an eval stage's scope. Code's eval worker does not know the customer's connected Vertex project and location, so its sandbox client is given Rovara's placeholder pair
// (EVAL_VERTEX_PLACEHOLDER); under a stage's scope, and only there, the product route reads that pair as the connected one. The upstream path is always the key store's. Money, caps, scope and company isolation are the Gemini stage's.
import { beforeAll, describe, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import type { ProviderRequest } from "../../packages/model-gateway/src/provider.js";
import { PRODUCT_VERTEX_NOT_CONNECTED } from "../../packages/model-gateway/src/product-route.js";
import { EVAL_VERTEX_PLACEHOLDER, parseVertexPath } from "../../packages/model-gateway/src/product-vertex.js";
import { VertexTokens } from "../../packages/model-gateway/src/product-vertex-token.js";
import { EVAL_HOLD_PATH, EVAL_RELEASE_PATH, EVAL_SCOPE_HEADER, ProductEvalStages } from "../../packages/model-gateway/src/product-eval.js";
import { handleGateway, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { MemorySink, mint, now, scope as agentScope } from "./model-gateway-fixture.js";
import { change, cid, geminiAnswer, geminiBody, maintainer, pid, productCall, productGateway, productScope, storeKit } from "./model-gateway-product-fixture.js";
import { AWS_REGION, FakeGoogle, ROLE_ARN, audienceOf, sessionArn } from "./model-gateway-vertex-fake.js";
beforeAll(denyNetwork);

const OTHER = `org_${"b".repeat(20)}`;
const DIGEST = "d".repeat(64);
const PROJECT = "acme-tests"; const LOCATION = "us-central1";
const PH = EVAL_VERTEX_PLACEHOLDER;
const vx = (project: string, location: string, o: { model?: string; stream?: boolean; version?: string } = {}) =>
  `/v1/product/vertex/${o.version ?? "v1beta1"}/projects/${project}/locations/${location}/publishers/google/models/${o.model ?? "gemini-2.5-flash"}:${o.stream === true ? "streamGenerateContent?alt=sse" : "generateContent"}`;
const placeholderPath = (o: { stream?: boolean; version?: string } = {}) => vx(PH.projectId, PH.location, o);
const approval = { selection: "all-questions", inputsDigest: DIGEST, maxCalls: 400, maxCostMicros: 4_000_000, approver: { personId: "p1", provider: "github" } };
const grant = { company: cid, project: pid, selection: "all-questions", role: "maintainer", inputsDigest: DIGEST, provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000 };

async function kit(options: { connect?: boolean } = {}) {
  const google = new FakeGoogle(now);
  google.exactPool(audienceOf("pool-a"), cid);
  const tokens = new VertexTokens({ http: google.http, aws: async () => google.base, federationRoleArn: ROLE_ARN, awsRegion: AWS_REGION, now: () => google.now });
  const store = storeKit({ vertexCheck: async () => "ok" });
  if (options.connect !== false) await store.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_vx", provider: "vertex", key: JSON.stringify({ scheme: "federation", projectId: PROJECT, location: LOCATION, audience: audienceOf("pool-a") }) });
  const stages = new ProductEvalStages({ approvals: { current: async () => approval, roleOf: async () => "maintainer" }, now: () => now });
  const vertexCalls: ProviderRequest[] = [];
  const g = await productGateway({ kit: store, connect: false, vertex: { tokens }, vertexTransport: async (r) => { vertexCalls.push(r); return { status: 200, body: geminiAnswer() }; }, evalStages: stages,
    companyCaps: new FixedCapsSource({ task: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: 1_000_000_000 }) });
  return { ...g, google, vertexCalls, stages };
}
async function control(deps: GatewayDependencies, path: string, body: unknown, token = mint()) {
  const sink = new MemorySink();
  const bytes = Buffer.from(JSON.stringify(body));
  await handleGateway(deps, { method: "POST", url: path, headers: { "content-type": "application/json", "x-api-key": token }, body: (async function* () { yield bytes; })() }, sink);
  return { sink, json: (() => { try { return JSON.parse(sink.text()) as Record<string, unknown>; } catch { return {}; } })() };
}
const hold = async (deps: GatewayDependencies, calls = 10, costMicros = 100_000, token = mint()) => { const r = await control(deps, EVAL_HOLD_PATH, { grant, calls, costMicros }, token); return { status: r.sink.status, scope: r.json["scope"] as string }; };
type Event = { kind: string; status?: number; class?: string; refusal?: string; costMicros?: number };
const NOT_FOUND = { kind: "settle", status: 404, class: "refused", costMicros: 0 };
/** A stage call is always answered as events (head, chunks, one settle); a refusal is a settle of class `refused` with its own status and words. */
const stageCall = async (deps: GatewayDependencies, scope: string, path = placeholderPath({ stream: true }), token = mint()) => {
  const sink = await productCall(deps, path, geminiBody, token, { [EVAL_SCOPE_HEADER]: scope });
  const events = (sink.text().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Event & { b64?: string }));
  const words = events.filter((e) => e.kind === "chunk").map((e) => Buffer.from(e.b64 ?? "", "base64").toString()).join("");
  return { sink, settle: events.at(-1) as Event, words };
};
const projectRow = async (k: Awaited<ReturnType<typeof kit>>) => (await k.productMeter.read(productScope)).find((r) => r.item === "project")!;

describe("the placeholder pair", () => {
  it("is the one pair Code's eval worker gives its sandbox (Code's EVAL_VERTEX_PLACEHOLDER): a drift in either repo fails closed, and this pin names the words", () => {
    expect(PH).toEqual({ projectId: "rovara-eval-project", location: "rovara-eval1" });
    expect(Object.isFrozen(PH)).toBe(true);
  });
  it("passes the route's own path parser, so a call naming it reaches the admission check, and is not a real Google project or location", () => {
    expect(parseVertexPath(placeholderPath({ stream: true }).replace("/v1beta1/", "/v1/").replace("?alt=sse", ""), "alt=sse")).toMatchObject({ project: PH.projectId, location: PH.location });
    expect(PH.projectId).not.toBe("global"); expect(PH.location).not.toMatch(/^(?:us|europe|asia|me|africa|northamerica|southamerica|australia)-/u);
  });
});

describe("a Vertex call under an eval stage's scope with Rovara's placeholder project and location", () => {
  it("is admitted as the connected pair: the upstream path and the company's token come from the key store, and the call settles at its priced cost", async () => {
    const k = await kit();
    const held = await hold(k.deps);
    expect(held.status).toBe(200);
    const { sink, settle } = await stageCall(k.deps, held.scope, placeholderPath({ stream: true, version: "v1" }));
    expect(sink.status).toBe(200);
    expect(settle).toMatchObject({ kind: "settle", class: "ok", costMicros: 20 });
    expect(k.vertexCalls).toHaveLength(1);
    const sent = k.vertexCalls[0]!;
    // Never the request's words: the connected project and location, the version the client named.
    expect(sent.path).toBe(`/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse`);
    expect(JSON.stringify(sent)).not.toContain(PH.projectId); expect(JSON.stringify(sent)).not.toContain(PH.location);
    expect(k.google.whoIs(sent.key)).toBe(sessionArn(cid));
    // The stage's own spend is counted under the one hold; the release gives back only what was not spent.
    const released = await control(k.deps, EVAL_RELEASE_PATH, { scope: held.scope, calls: 1, costMicros: 20, unknown: false });
    expect(released.sink.status).toBe(200);
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 20 });
    expect((await k.meter.read(agentScope)).find((r) => r.item === "company")).toMatchObject({ reservedMicros: 0, spentMicros: 20 });
  });
  it("streams under the scope too, and v1 and v1beta1 are both read", async () => {
    const k = await kit();
    const { scope } = await hold(k.deps);
    for (const version of ["v1", "v1beta1"]) expect((await stageCall(k.deps, scope, placeholderPath({ stream: true, version }))).settle).toMatchObject({ class: "ok" });
    expect(k.vertexCalls.map((c) => c.path)).toEqual([`/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse`, `/v1beta1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse`]);
  });
  it("without a scope the placeholder is just another project: 400 not_allowed before any hold, token or send", async () => {
    const k = await kit();
    const sink = await productCall(k.deps, placeholderPath({ stream: true }));
    expect(sink.status).toBe(400); expect(sink.text()).toContain(PRODUCT_VERTEX_NOT_CONNECTED);
    expect(k.vertexCalls).toHaveLength(0); expect(k.google.calls).toHaveLength(0);
    expect((await projectRow(k)).committed).toBe(0);
  });
  it("a scope that does not exist is the same not-found as any other unknown scope, before a token or a send", async () => {
    const k = await kit();
    const { settle } = await stageCall(k.deps, "00000000-0000-4000-8000-000000000000");
    expect(settle).toMatchObject(NOT_FOUND);
    expect(k.vertexCalls).toHaveLength(0); expect(k.google.calls).toHaveLength(0);
  });
  it.each([
    ["another project with the placeholder location", vx("other-project", PH.location)],
    ["the placeholder project with another location", vx(PH.projectId, "europe-west4")],
    ["the placeholder project with the connected location", vx(PH.projectId, LOCATION)],
    ["the connected project with the placeholder location", vx(PROJECT, PH.location)],
    ["another project", vx("other-project", LOCATION)],
    ["a project number", vx("123456789012", LOCATION)],
    ["the placeholder with another suffix", vx(`${PH.projectId}x`, PH.location)],
  ])("%s is still refused under a valid scope: the placeholder is one exact pair, not a wildcard", async (_n, path) => {
    const k = await kit();
    const { scope } = await hold(k.deps);
    const { settle, words } = await stageCall(k.deps, scope, path.replace(":generateContent", ":streamGenerateContent?alt=sse"));
    expect(settle).toMatchObject({ status: 400, class: "refused", costMicros: 0 });
    expect(words).toContain(PRODUCT_VERTEX_NOT_CONNECTED);
    expect(k.vertexCalls).toHaveLength(0); expect(k.google.calls).toHaveLength(0);
    expect(await projectRow(k)).toMatchObject({ spentMicros: 0 });
  });
  it("the connected pair itself still works under a scope (code that names its real project)", async () => {
    const k = await kit();
    const { scope } = await hold(k.deps);
    expect((await stageCall(k.deps, scope, vx(PROJECT, LOCATION, { stream: true }))).settle).toMatchObject({ class: "ok" });
    expect(k.vertexCalls[0]!.path).toBe(`/v1beta1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse`);
  });
  it("is capped by the stage's held count: the call past it is a cap answer at no cost and nothing is sent", async () => {
    const k = await kit();
    const { scope } = await hold(k.deps, 2, 100_000);
    expect((await stageCall(k.deps, scope)).settle).toMatchObject({ class: "ok" });
    expect((await stageCall(k.deps, scope)).settle).toMatchObject({ class: "ok" });
    const third = await stageCall(k.deps, scope);
    expect(third.settle).toMatchObject({ kind: "settle", class: "cap", costMicros: 0 });
    expect(k.vertexCalls).toHaveLength(2);
  });
  it("is capped by the stage's held cost: once the spend reaches it the next call is refused, and nothing is sent", async () => {
    const k = await kit();
    const { scope } = await hold(k.deps, 10, 20);
    expect((await stageCall(k.deps, scope)).settle).toMatchObject({ class: "ok", costMicros: 20 });
    expect((await stageCall(k.deps, scope)).settle).toMatchObject({ class: "cap", costMicros: 0 });
    expect(k.vertexCalls).toHaveLength(1);
  });
  it("is two-company safe: another company's token, another task's token and a project with no Vertex connection get no use of the scope", async () => {
    const k = await kit();
    const { scope } = await hold(k.deps);
    const otherCompany = await stageCall(k.deps, scope, placeholderPath(), mint({ cid: OTHER }));
    const otherTask = await stageCall(k.deps, scope, placeholderPath(), mint({ tid: "task_2" }));
    expect(otherCompany.settle).toMatchObject({ status: 404, class: "refused" }); expect(otherTask.settle).toMatchObject(NOT_FOUND);
    expect(k.vertexCalls).toHaveLength(0); expect(k.google.calls).toHaveLength(0);
    // The owner's scope still works, and nothing was spent by the others.
    expect(await projectRow(k)).toMatchObject({ spentMicros: 0 });
    expect((await stageCall(k.deps, scope)).settle).toMatchObject({ class: "ok" });
  });
  it("a project with no Gemini and no Vertex connection is given no hold, so there is no scope to name the placeholder under", async () => {
    const k = await kit({ connect: false });
    const held = await hold(k.deps);
    expect(held.status).not.toBe(200);
    expect(held.scope).toBeUndefined();
    expect((await stageCall(k.deps, "00000000-0000-4000-8000-000000000000")).settle).toMatchObject({ status: 404, class: "refused", costMicros: 0 });
    expect(k.vertexCalls).toHaveLength(0);
  });
});
