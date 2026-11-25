// B8 (PRODUCT-EVAL-STAGE-STORE): eval stages in one shared DynamoDB stage table, so the gateway's two Fargate tasks can each serve
// any stage call. Two "tasks" here are two gateways with their OWN meter objects and their OWN ProductEvalStages over ONE table
// set: a hold on one, its calls and release on the other. Every #56 guarantee holds across them: the atomic hold, the call-count
// and cost ceilings, at most one call over the hold, one release, and company isolation.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoEvalStageStore } from "../../packages/model-gateway/src/dynamo-eval-stages.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { EVAL_DEAD_CALL_MS, EVAL_HOLD_PATH, EVAL_RELEASE_PATH, EVAL_SCOPE_HEADER, EVAL_STAGE_MS, ProductEvalStages, type EvalApproval } from "../../packages/model-gateway/src/product-eval.js";
import type { ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { handleGateway, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { MemorySink, mint, now, scope as agentScope } from "./model-gateway-fixture.js";
import { change, cid, geminiAnswer, geminiBody, geminiKey, maintainer, pid, productCall, productGateway, productScope, storeKit, streamPath } from "./model-gateway-product-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const DIGEST = "d".repeat(64);
const OTHER = `org_${"b".repeat(20)}`;
const TABLES = ["gw-meter", "gw-ledger", "gw-markers", "gw-pmeter", "gw-pledger", "gw-pmarkers", "gw-stages"];
const grant = () => ({ company: cid, project: pid, selection: "all-questions", role: "maintainer", inputsDigest: DIGEST, provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000 });
const approval: EvalApproval = { selection: "all-questions", inputsDigest: DIGEST, maxCalls: 400, maxCostMicros: 4_000_000, approver: { personId: "p1", provider: "github" } };
const media = { contents: [{ role: "user", parts: [{ text: "x" }, { inlineData: { mimeType: "image/png", data: "aGk=" } }] }], generationConfig: { maxOutputTokens: 100 } };
const creds = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" });

/** Two gateway tasks over one set of tables; each has its own Dynamo client, meters and stages object. */
async function twoTasks(options: { transport?: ProviderTransport; companyMonth?: number } = {}) {
  const wire = new WireDynamo(TABLES, { namespaceTables: true });
  const kit = storeKit();
  await kit.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_gem", provider: "gemini", key: geminiKey() });
  await kit.store.connect({ ...change(pid, 0, maintainer), cid: OTHER, sourceId: "src_gem", provider: "gemini", key: geminiKey() });
  const clock = { at: now };
  const task = async () => {
    const db = new Dynamo({ region: "us-west-2", credentials: creds, transport: wire.transport, now: () => clock.at });
    const meter = new DynamoMeter({ db, tables: { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers" }, now: () => clock.at });
    const productMeter = new DynamoMeter({ db, tables: { meter: "gw-pmeter", ledger: "gw-pledger", markers: "gw-pmarkers" }, now: () => clock.at, combinedCompany: { meter: "gw-meter", markers: "gw-markers" } });
    const store = new DynamoEvalStageStore(db, "gw-stages");
    const stages = new ProductEvalStages({ approvals: { current: async () => approval, roleOf: async () => "maintainer" }, now: () => clock.at, store, waitMs: 3_000 });
    const g = await productGateway({ kit, connect: false, evalStages: stages, productMeter, overrides: { meter }, ...(options.transport === undefined ? {} : { transport: options.transport }),
      companyCaps: new FixedCapsSource({ task: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: options.companyMonth ?? 1_000_000_000 }) });
    return { g, stages, store, meter, productMeter };
  };
  return { wire, kit, clock, a: await task(), b: await task() };
}
async function control(deps: GatewayDependencies, path: string, body: unknown, token = mint()) {
  const sink = new MemorySink();
  const bytes = Buffer.from(JSON.stringify(body));
  await handleGateway(deps, { method: "POST", url: path, headers: { "content-type": "application/json", "x-api-key": token }, body: (async function* () { yield bytes; })() }, sink);
  return { sink, json: (() => { try { return JSON.parse(sink.text()) as Record<string, unknown>; } catch { return {}; } })() };
}
const hold = (deps: GatewayDependencies, calls = 10, costMicros = 100_000, token = mint()) => control(deps, EVAL_HOLD_PATH, { grant: grant(), calls, costMicros }, token);
const release = (deps: GatewayDependencies, scope: string, spent = { calls: 0, costMicros: 0, unknown: false }, token = mint()) => control(deps, EVAL_RELEASE_PATH, { scope, ...spent }, token);
async function stageCall(deps: GatewayDependencies, scope: string, body: unknown = geminiBody, token = mint()) {
  const sink = await productCall(deps, streamPath, body, token, { [EVAL_SCOPE_HEADER]: scope });
  const events = sink.text().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { sink, events, settle: events.at(-1) as { class: string; costMicros: number; overrun?: boolean } };
}
const projectRow = async (meter: DynamoMeter, company = cid) => (await meter.read({ ...productScope, cid: company })).find((r) => r.item === "project")!;
const combinedRow = async (meter: DynamoMeter) => (await meter.read(agentScope)).find((r) => r.item === "company")!;
const scopeOf = (r: { json: Record<string, unknown> }) => r.json.scope as string;

describe("eval stages shared by two gateway tasks (B8)", () => {
  it("a hold on one task is served and released on the other, settled once at the gateway's own count", async () => {
    const t = await twoTasks();
    const held = await hold(t.a.g.deps);
    expect(held.sink.status).toBe(200);
    const scope = scopeOf(held);
    // 10 input x $1/M + 5 output x $2/M: whatever the fixture prices, the settle names it and the meter matches.
    const c = await stageCall(t.b.g.deps, scope);
    expect(c.settle.class).toBe("ok");
    const spent = c.settle.costMicros;
    expect(spent).toBeGreaterThan(0);
    expect(await projectRow(t.b.productMeter)).toMatchObject({ reservedMicros: 100_000 });
    const r = await release(t.b.g.deps, scope, { calls: 1, costMicros: spent, unknown: false });
    expect(r.json).toEqual({ released: 100_000 - spent });
    expect(await projectRow(t.a.productMeter)).toMatchObject({ reservedMicros: 0, spentMicros: spent });
    expect(await combinedRow(t.a.meter)).toMatchObject({ reservedMicros: 0, spentMicros: spent });
    // Release once, on either task.
    expect((await release(t.a.g.deps, scope)).sink.status).toBe(409);
    expect((await release(t.b.g.deps, scope)).sink.status).toBe(409);
  });

  it("the held call count is a ceiling across both tasks, even for calls admitted at the same moment", async () => {
    const t = await twoTasks();
    const scope = scopeOf(await hold(t.a.g.deps, 3, 1_000_000));
    const results = await Promise.all([t.a, t.b, t.a, t.b, t.a, t.b].map((task) => stageCall(task.g.deps, scope)));
    expect(results.filter((r) => r.settle.class === "ok")).toHaveLength(3);
    expect(results.filter((r) => r.settle.class === "cap")).toHaveLength(3);
    expect(t.a.g.productCalls.length + t.b.g.productCalls.length).toBe(3);
  });

  it("the last call is taken by exactly one task when two ask at once (conditional write on the stage)", async () => {
    const t = await twoTasks();
    const scope = scopeOf(await hold(t.a.g.deps, 1, 1_000_000));
    const [x, y] = await Promise.all([stageCall(t.a.g.deps, scope), stageCall(t.b.g.deps, scope)]);
    expect([x.settle.class, y.settle.class].sort()).toEqual(["cap", "ok"]);
    expect(t.a.g.productCalls.length + t.b.g.productCalls.length).toBe(1);
  });

  it("an overrun-capable call runs alone across tasks, so the stage passes its hold by at most one call", async () => {
    let sent = 0;
    const t = await twoTasks({ transport: async () => { sent++; return { status: 200, body: geminiAnswer({ promptTokenCount: 2_000_000, candidatesTokenCount: 5 }) }; } });
    const scope = scopeOf(await hold(t.a.g.deps, 10, 1_000_000));
    const [x, y] = await Promise.all([stageCall(t.a.g.deps, scope, media), stageCall(t.b.g.deps, scope, media)]);
    expect(sent).toBe(1);
    const over = [x, y].find((r) => r.settle.class === "ok")!;
    expect(over.settle.overrun).toBe(true);
    expect([x, y].filter((r) => r.settle.class === "cap")).toHaveLength(1);
    // The overshoot is on the meter, settled once (no release needed), and the stage takes nothing more on either task.
    expect(await projectRow(t.b.productMeter)).toMatchObject({ reservedMicros: 0, spentMicros: over.settle.costMicros });
    expect((await stageCall(t.b.g.deps, scope)).settle.class).toBe("cap");
    expect((await release(t.a.g.deps, scope)).json).toEqual({ released: 0 });
  });

  it("the per-company open-stage limit is shared: 8 open stages across both tasks, the 9th refused", async () => {
    const t = await twoTasks();
    const results = [];
    for (let i = 0; i < 9; i++) results.push(await hold((i % 2 === 0 ? t.a : t.b).g.deps, 1, 10));
    expect(results.slice(0, 8).every((r) => r.sink.status === 200)).toBe(true);
    expect(results[8]!.sink.status).toBe(429);
    expect(await projectRow(t.a.productMeter)).toMatchObject({ reservedMicros: 80 });
    // A settled stage gives its slot back, on whichever task released it.
    await release(t.b.g.deps, scopeOf(results[0]!));
    expect((await hold(t.a.g.deps, 1, 10)).sink.status).toBe(200);
  });

  it("two companies: one company's scope is not found for another, on either task, and nothing moves", async () => {
    const t = await twoTasks();
    const scope = scopeOf(await hold(t.a.g.deps));
    const tokenB = mint({ cid: OTHER });
    const stolen = await stageCall(t.b.g.deps, scope, geminiBody, tokenB);
    expect(stolen.events[0]).toMatchObject({ status: 404 });
    expect((await release(t.b.g.deps, scope, undefined, tokenB)).sink.status).toBe(404);
    expect((await release(t.a.g.deps, scope, undefined, mint({ tid: "task_2" }))).sink.status).toBe(404);
    expect(t.a.g.productCalls.length + t.b.g.productCalls.length).toBe(0);
    expect(await projectRow(t.a.productMeter)).toMatchObject({ reservedMicros: 100_000 });
    expect(await projectRow(t.a.productMeter, OTHER)).toMatchObject({ reservedMicros: 0, spentMicros: 0 });
    // Every stage row lives under its own company's key (the IAM LeadingKeys rule).
    expect(t.wire.items("gw-stages").every((item) => String(item.pk).startsWith(`CO#${JSON.stringify([productScope.iss, cid])}`))).toBe(true);
  });

  it("the sweep on either task settles an expired stage; a call whose task died counts at its whole estimate", async () => {
    const t = await twoTasks();
    const scope = scopeOf(await hold(t.a.g.deps, 10, 100_000));
    // Task A admitted an overrun-capable call (150,000 estimate, so it may pass the 100,000 hold: it runs alone) and died before its settle.
    const row = (await t.a.store.get({ iss: productScope.iss, cid, id: scope }))!;
    row.stage.subs["00000000-0000-4000-8000-00000000dead"] = { estimate: 150_000, exclusive: true, startedAt: now };
    row.stage.dispatched++; row.stage.inFlight++; row.stage.inFlightCost += 150_000; row.stage.exclusive = true;
    expect(await t.a.store.put(row.stage, row.version)).toBe(true);
    // Before the call ceiling nothing changes, and the stage takes no other call (the dead call still runs alone).
    expect(await t.b.stages.sweep(now + 1)).toEqual({ released: 0, failed: 0 });
    // After the call ceiling, the sweep (well before the stage's deadline) counts the dead call at its whole estimate and frees the turn.
    t.clock.at = now + EVAL_DEAD_CALL_MS;
    expect(await t.b.stages.sweep(t.clock.at)).toEqual({ released: 0, failed: 0 });
    const after = (await t.a.store.get({ iss: productScope.iss, cid, id: scope }))!.stage;
    expect(after).toMatchObject({ inFlight: 0, exclusive: false, spent: 150_000, keepWhole: true, subs: {} });
    // At the deadline the parent settles at the counted spend, past the hold: never below what the dead call may have spent.
    t.clock.at = now + EVAL_STAGE_MS;
    expect(await t.b.stages.sweep(t.clock.at)).toEqual({ released: 1, failed: 0 });
    expect(await projectRow(t.b.productMeter)).toMatchObject({ reservedMicros: 0, spentMicros: 150_000 });
    // Settled once: another pass on the other task changes nothing.
    expect(await t.a.stages.sweep(t.clock.at)).toEqual({ released: 0, failed: 0 });
  });

  it("stage rows carry a TTL after the deadline plus the call ceiling, and leave the due index once settled", async () => {
    const t = await twoTasks();
    const scope = scopeOf(await hold(t.a.g.deps));
    const stored = () => t.wire.items("gw-stages").find((item) => item.sk === `STAGE#${scope}`)!;
    expect(stored().expiresAt).toBe(Math.ceil((now + EVAL_STAGE_MS + EVAL_DEAD_CALL_MS) / 1000));
    expect(stored().dueAll).toBe("DUE");
    await release(t.b.g.deps, scope);
    expect(stored().dueAll).toBeUndefined();
    expect(stored().v).toBeGreaterThan(1);
  });
});
