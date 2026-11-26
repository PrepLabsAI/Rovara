// TASK-ENDED-NOTICE: a hosted install tells the model gateway when a task ends (`POST /v1/service/task-ended`), and sends it again (reconcile) when it did not get through. Fake adapters and a fake gateway only.
// The notice is DELIVERED only on a 200 that names the same company and task with `ended: true`; closing and merging never wait on it and never fail on it; an older gateway without the route (404) is "not delivered", never an error.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TASK_KEY_PURPOSE, WORKFLOW_DISPATCH_DUE_INDEX, type OrgId } from "@agentx/contracts";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import {
  TASK_ENDED_AUDIENCE, TASK_ENDED_BACKOFF_MS, TASK_ENDED_PATH, TASK_ENDED_TRIES, taskEndedSender,
} from "../../packages/broker/src/core-host/task-ended-http.js";
import {
  TASK_END_DUE_PK, TASK_END_FIRST_DUE_MS, TASK_END_GIVE_UP_MS, TASK_END_WAIT_MS, announceTaskEnd, reconcileTaskEnds, taskEndKey,
} from "../../packages/broker/src/core/task-flow/task-end.js";
import { withTaskEndReconcile, TASK_END_RECONCILE_MIN_MS } from "../../packages/broker/src/aws/task-end-reconcile.js";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { makeKey, signerOf } from "./policy-hook-fixture.js";
import { host } from "../support/service-host.js";
import { TASK_ID } from "../support/merge-world.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const GATEWAY = "https://gateway.staging.example";
const ISSUER = "https://api.staging.example/v1/auth";
const NOW = 1_800_000_000_000;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = pair.publicKey.export({ type: "spki", format: "der" });
const exported = pair.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const KID = createHash("sha256").update(der).digest("base64url").slice(0, 16);
const signer: TokenSigner = {
  publicJwk: async () => ({ kty: "RSA", n: exported.n, e: exported.e, kid: KID, alg: "RS256", use: "sig", rovara_purpose: TASK_KEY_PURPOSE }) as never,
  sign: async (input) => sign("sha256", input, pair.privateKey),
};
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
const TASK = "11111111-1111-4111-8111-111111111111";

interface Seen { url: string; init: RequestInit }
function fakeGateway(reply: (seen: Seen, n: number) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => { const s = { url: String(url), init: init ?? {} }; seen.push(s); return reply(s, seen.length); }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}
const took = (company: string = ORG_A, task: string = TASK, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ company, task, ended: true, ...extra }), { status: 200 });
const status = (code: number) => new Response("{}", { status: code });
const sleeps: number[] = [];
const sender = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof taskEndedSender>[0]> = {}) =>
  taskEndedSender({ gatewayUrl: `${GATEWAY}/`, tokens: () => ({ signer, issuer: ISSUER }), fetch: fetchImpl, now: () => NOW, timeoutMs: 40, sleep: async (ms) => { sleeps.push(ms); }, ...extra });

afterEach(() => { sleeps.length = 0; vi.unstubAllGlobals(); });

describe("the sender (what Cloud's route receives, and what counts as delivered)", () => {
  it("posts exactly {company, task} with a service token for that company and answers delivered only on the exact 200", async () => {
    const { seen, fetchImpl } = fakeGateway(() => took());
    expect(await sender(fetchImpl)({ orgId: ORG_A, taskId: TASK })).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${GATEWAY}${TASK_ENDED_PATH}`);
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.redirect).toBe("error");
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ company: ORG_A, task: TASK });
    const [header, claims] = String((seen[0]!.init.headers as Record<string, string>)["authorization"]).replace(/^Bearer /u, "").split(".").slice(0, 2).map((part) => decode(part));
    expect(header).toEqual({ alg: "RS256", typ: "rovara-service+jwt", kid: KID });
    expect(claims).toMatchObject({ iss: ISSUER, aud: TASK_ENDED_AUDIENCE, cid: ORG_A });
    expect(Object.keys(claims!).sort()).toEqual(["aud", "cid", "exp", "iat", "iss", "jti", "nbf"]);
  });

  it.each([
    ["another task", () => took(ORG_A, "22222222-2222-4222-8222-222222222222")],
    ["another company", () => took(ORG_B)],
    ["ended false", () => new Response(JSON.stringify({ company: ORG_A, task: TASK, ended: false }), { status: 200 })],
    ["an extra member", () => took(ORG_A, TASK, { more: 1 })],
    ["junk", () => new Response("not json", { status: 200 })],
    ["a 202", () => new Response(JSON.stringify({ company: ORG_A, task: TASK, ended: true }), { status: 202 })],
  ])("is not delivered when the answer is %s, and is not asked again at once", async (_name, reply) => {
    const { seen, fetchImpl } = fakeGateway(reply);
    expect(await sender(fetchImpl)({ orgId: ORG_A, taskId: TASK })).toBe("pending");
    expect(seen).toHaveLength(1);
  });

  it("an older gateway without the route (404) is not delivered and never an error", async () => {
    const { seen, fetchImpl } = fakeGateway(() => status(404));
    await expect(sender(fetchImpl)({ orgId: ORG_A, taskId: TASK })).resolves.toBe("pending");
    expect(seen).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("a failing gateway is tried exactly TASK_ENDED_TRIES times with the backoff between, then not delivered", async () => {
    const { seen, fetchImpl } = fakeGateway(() => status(503));
    expect(await sender(fetchImpl)({ orgId: ORG_A, taskId: TASK })).toBe("pending");
    expect(seen).toHaveLength(TASK_ENDED_TRIES);
    expect(sleeps).toEqual([...TASK_ENDED_BACKOFF_MS]);
  });

  it("a busy or failing gateway that then answers is delivered on the later try", async () => {
    const { seen, fetchImpl } = fakeGateway((_seen, n) => (n === 1 ? status(429) : n === 2 ? status(502) : took()));
    expect(await sender(fetchImpl)({ orgId: ORG_A, taskId: TASK })).toBeUndefined();
    expect(seen).toHaveLength(3);
  });

  it("a fault and an answer that never comes are tries too, and never throw", async () => {
    const thrown = vi.fn(async () => { throw new Error("socket closed"); }) as unknown as typeof fetch;
    expect(await sender(thrown)({ orgId: ORG_A, taskId: TASK })).toBe("pending");
    expect(thrown).toHaveBeenCalledTimes(TASK_ENDED_TRIES);
    const silent = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    expect(await sender(silent)({ orgId: ORG_A, taskId: TASK })).toBe("pending");
    expect(silent).toHaveBeenCalledTimes(TASK_ENDED_TRIES);
  });

  it("with no task key yet, or a malformed event, nothing is sent and the notice is not delivered", async () => {
    const { seen, fetchImpl } = fakeGateway(() => took());
    expect(await sender(fetchImpl, { tokens: () => undefined })({ orgId: ORG_A, taskId: TASK })).toBe("pending");
    expect(await sender(fetchImpl, { tokens: () => { throw new Error("no key"); } })({ orgId: ORG_A, taskId: TASK })).toBe("pending");
    expect(await sender(fetchImpl)({ orgId: "not a company", taskId: TASK })).toBe("pending");
    expect(await sender(fetchImpl)({ orgId: ORG_A, taskId: "a b" })).toBe("pending");
    expect(seen).toHaveLength(0);
  });

  it("logs fixed words only: no company, task or token", async () => {
    const lines: Array<Record<string, unknown>> = [];
    await sender(fakeGateway(() => took()).fetchImpl, { log: (entry) => lines.push(entry) })({ orgId: ORG_A, taskId: TASK });
    await sender(fakeGateway(() => status(404)).fetchImpl, { log: (entry) => lines.push(entry) })({ orgId: ORG_A, taskId: TASK });
    expect(lines).toEqual([{ event: "task_end_notice", outcome: "delivered" }, { event: "task_end_notice", outcome: "not_delivered" }]);
  });
});

type World = Awaited<ReturnType<typeof host>>;
const markerOf = async (w: World, taskId = TASK_ID) => (await w.world.store.get(taskEndKey(taskId)))!;
const inDueIndex = async (w: World) => (await w.world.store.queryIndex({ index: WORKFLOW_DISPATCH_DUE_INDEX.name, partition: TASK_END_DUE_PK, sort: { op: "lte", value: "9" }, limit: 50 })).items;

describe("announcing an end: fire and reconcile", () => {
  it("a notice the host did not take leaves the marker undelivered, in the due index, and never fails or throws", async () => {
    const w = await host();
    w.h.deps.taskEnded = async () => "pending";
    expect(await announceTaskEnd(w.h.deps, TASK_ID, "merged")).toBe(true);
    const marker = await markerOf(w);
    expect(marker["notifiedAt"]).toBeUndefined();
    expect(marker["orgId"]).toBe(w.h.deps.companyId);
    expect(marker[WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]).toBe(TASK_END_DUE_PK);
    expect((await inDueIndex(w)).map((row) => row["taskId"])).toEqual([TASK_ID]);
  });

  it("a delivered notice is recorded and leaves the due index", async () => {
    const w = await host();
    w.h.deps.taskEnded = async () => undefined;
    await announceTaskEnd(w.h.deps, TASK_ID, "closed");
    const marker = await markerOf(w);
    expect(typeof marker["notifiedAt"]).toBe("string");
    expect(marker[WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]).toBeUndefined();
    expect(await inDueIndex(w)).toEqual([]);
  });

  it("a host that is slow does not hold the close or the merge for longer than the wait, and its late answer is still recorded", async () => {
    const w = await host();
    let answer!: (value: undefined) => void;
    w.h.deps.taskEnded = () => new Promise<undefined>((resolve) => { answer = resolve; });
    const began = Date.now();
    expect(await announceTaskEnd(w.h.deps, TASK_ID, "merged")).toBe(true);
    expect(Date.now() - began).toBeLessThan(TASK_END_WAIT_MS + 5_000);
    expect((await markerOf(w))["notifiedAt"]).toBeUndefined();
    answer(undefined);
    await vi.waitFor(async () => { expect((await markerOf(w))["notifiedAt"]).toBeDefined(); });
  });

  it("a seam that throws is logged and never fails the end; the marker stays for the reconcile", async () => {
    const w = await host();
    w.h.deps.taskEnded = async () => { throw new Error("down"); };
    expect(await announceTaskEnd(w.h.deps, TASK_ID, "merged")).toBe(true);
    expect((await markerOf(w))["notifiedAt"]).toBeUndefined();
    expect(await inDueIndex(w)).toHaveLength(1);
  });
});

describe("the reconcile", () => {
  const later = (w: World, ms: number) => ({ ...w.h.deps, now: () => new Date(w.h.clock.now + ms) });
  const undelivered = async (w: World, answers: Array<"pending" | undefined> = ["pending"]) => {
    const sent: string[] = [];
    let n = 0;
    w.h.deps.taskEnded = async (event) => { sent.push(event.taskId); const answer = answers[Math.min(n, answers.length - 1)]; n += 1; return answer; };
    await announceTaskEnd(w.h.deps, TASK_ID, "merged");
    sent.length = 0;
    return sent;
  };

  it("picks the markers with no notifiedAt once due, sends them again, and records the answer", async () => {
    const w = await host();
    const sent = await undelivered(w, ["pending", undefined]);
    // Not due yet: nothing is sent.
    expect(await reconcileTaskEnds(w.h.deps)).toEqual({ attempted: 0, delivered: 0 });
    expect(sent).toEqual([]);
    expect(await reconcileTaskEnds(later(w, TASK_END_FIRST_DUE_MS + 1_000))).toEqual({ attempted: 1, delivered: 1 });
    expect(sent).toEqual([TASK_ID]);
    expect((await markerOf(w))["notifiedAt"]).toBeDefined();
    expect(await inDueIndex(w)).toEqual([]);
    // A delivered marker is not picked again.
    expect(await reconcileTaskEnds(later(w, 2 * TASK_END_FIRST_DUE_MS))).toEqual({ attempted: 0, delivered: 0 });
  });

  it("a notice that still does not get through is due again later (twice as long), never an error", async () => {
    const w = await host();
    const sent = await undelivered(w, ["pending"]);
    const at = TASK_END_FIRST_DUE_MS + 1_000;
    expect(await reconcileTaskEnds(later(w, at))).toEqual({ attempted: 1, delivered: 0 });
    const marker = await markerOf(w);
    expect(marker["notifyTries"]).toBe(1);
    expect(marker["notifiedAt"]).toBeUndefined();
    // Due again after one more interval of 2 x 5 minutes, not before.
    expect(await reconcileTaskEnds(later(w, at + TASK_END_FIRST_DUE_MS))).toEqual({ attempted: 0, delivered: 0 });
    expect(await reconcileTaskEnds(later(w, at + 2 * TASK_END_FIRST_DUE_MS + 1_000))).toEqual({ attempted: 1, delivered: 0 });
    expect(sent).toHaveLength(2);
    // A seam that throws is the same as not delivered.
    w.h.deps.taskEnded = async () => { throw new Error("down"); };
    await expect(reconcileTaskEnds(later(w, at + 10 * 3_600_000))).resolves.toMatchObject({ attempted: 1, delivered: 0 });
  });

  it("gives up on a marker older than the age limit: it leaves the index and nothing is sent", async () => {
    const w = await host();
    const sent = await undelivered(w, ["pending"]);
    expect(await reconcileTaskEnds(later(w, TASK_END_GIVE_UP_MS + 60_000))).toEqual({ attempted: 1, delivered: 0 });
    expect(sent).toEqual([]);
    expect(await inDueIndex(w)).toEqual([]);
    expect((await markerOf(w))["notifiedAt"]).toBeUndefined();
  });

  it("only this company's markers, and only the bounded number a pass", async () => {
    const w = await host();
    const sent = await undelivered(w, ["pending"]);
    const base = { entityType: "TASK_END", cause: "merged", at: new Date(w.h.clock.now).toISOString(), [WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]: TASK_END_DUE_PK };
    await w.world.store.put({ item: { ...taskEndKey("other-company-task"), ...base, taskId: "other-company-task", orgId: ORG_B, [WORKFLOW_DISPATCH_DUE_INDEX.sortKey]: "000000000000001#other" } });
    await w.world.store.put({ item: { ...taskEndKey("no-company-task"), ...base, taskId: "no-company-task", [WORKFLOW_DISPATCH_DUE_INDEX.sortKey]: "000000000000002#none" } });
    for (let n = 0; n < 5; n += 1) {
      const id = `own-${String(n)}`;
      await w.world.store.put({ item: { ...taskEndKey(id), ...base, taskId: id, orgId: w.h.deps.companyId, [WORKFLOW_DISPATCH_DUE_INDEX.sortKey]: `00000000000001${String(n)}#${id}` } });
    }
    const report = await reconcileTaskEnds(later(w, TASK_END_FIRST_DUE_MS + 1_000), { limit: 3 });
    expect(report.attempted).toBe(3);
    expect(sent).toHaveLength(3);
    expect(sent).not.toContain("other-company-task");
    expect(sent).not.toContain("no-company-task");
    expect((await markerOf(w, "other-company-task"))[WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]).toBe(TASK_END_DUE_PK);
  });

  it("with the real sender: a gateway without the route (404) is not delivered, then delivered once the gateway has it", async () => {
    const w = await host();
    let gatewayHasRoute = false;
    const { seen, fetchImpl } = fakeGateway((request) => (gatewayHasRoute ? took(w.h.deps.companyId, (JSON.parse(request.init.body as string) as { task: string }).task) : status(404)));
    w.h.deps.taskEnded = sender(fetchImpl);
    await expect(announceTaskEnd(w.h.deps, TASK_ID, "merged")).resolves.toBe(true);
    expect((await markerOf(w))["notifiedAt"]).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(await reconcileTaskEnds(later(w, TASK_END_FIRST_DUE_MS + 1_000))).toEqual({ attempted: 1, delivered: 0 });
    gatewayHasRoute = true;
    // The wait grew to ten minutes after the first failed reconcile (due again at 15 minutes).
    expect(await reconcileTaskEnds(later(w, 4 * TASK_END_FIRST_DUE_MS))).toEqual({ attempted: 1, delivered: 1 });
    expect((await markerOf(w))["notifiedAt"]).toBeDefined();
  });
});

describe("the reconcile in the notify-deliver pass", () => {
  const flowOf = (taskEnded: unknown) => ({ deps: { taskEnded, store: undefined, companyId: ORG_A } }) as never;
  const log = () => undefined;
  it("runs first with the time to spare, hands the rest to the notices, and a failure of it never stops them", async () => {
    const passes: number[] = [];
    const services = { "notify-deliver": { pass: async ({ budgetMs }: { budgetMs: number }) => { passes.push(budgetMs); return { delivered: 1 }; } } };
    // The store is missing on purpose: the reconcile cannot read and says so, and the notices still run.
    const wrapped = withTaskEndReconcile(services, { flow: flowOf(async () => undefined), companyId: ORG_A, now: () => NOW, log });
    expect(await wrapped["notify-deliver"]!.pass({ budgetMs: 20_000 })).toMatchObject({ delivered: 1 });
    expect(passes).toEqual([20_000]);
    // Too little time: the reconcile is left for a later pass, the notices get all of it.
    await wrapped["notify-deliver"]!.pass({ budgetMs: TASK_END_RECONCILE_MIN_MS - 1 });
    expect(passes[1]).toBe(TASK_END_RECONCILE_MIN_MS - 1);
  });

  it("a flow with no taskEnded (the laptop's own, or no gateway) is left exactly as it was", () => {
    const services = { "notify-deliver": { pass: async () => ({}) } };
    expect(withTaskEndReconcile(services, { flow: flowOf(undefined), companyId: ORG_A, now: () => NOW, log })).toBe(services);
  });
});

// The hosted core root: every company's flow gets the gateway sender as its `taskEnded` where the gateway is configured.
const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));

async function hostedRoot(env: Record<string, string>) {
  const w = createFakeWorld();
  w.clock.now = Date.now();
  adapters.modules = w.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets"].includes(module.point));
  const logs: Array<Record<string, unknown>> = [];
  const root = createBrokerCoreRoot({
    env,
    taskTokens: () => ({ signer: taskKeySigner(signerOf(makeKey("t".repeat(16)))), issuer: ISSUER }),
    documentClient: { async send() { return { Item: undefined }; } }, stateTableName: "state", signInTableName: "signin", callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => ({ token: "fake" }), codeModules: () => ({}) as never,
    origin: () => "https://api.example", now: () => new Date(w.clock.now), log: (entry) => { logs.push(entry); },
    ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(w.clock.now), taskPeople: { documentClient: { send: async () => ({}) }, tableName: "state" } }),
  });
  return { root, logs };
}

describe("the hosted wiring", () => {
  it("sets taskEnded on each company's flow where the gateway is configured, and it posts that company's notice to the gateway", async () => {
    const { root, logs } = await hostedRoot({ ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-6" });
    const a = (await root.app.runtimeFor(ORG_A)).flow.deps;
    const b = (await root.app.runtimeFor(ORG_B)).flow.deps;
    expect(typeof a.taskEnded).toBe("function");
    const { seen, fetchImpl } = fakeGateway((request) => took(ORG_A, (JSON.parse(request.init.body as string) as { task: string }).task));
    vi.stubGlobal("fetch", fetchImpl);
    await expect(a.taskEnded!({ orgId: ORG_A, taskId: TASK })).resolves.toBeUndefined();
    expect(seen[0]!.url).toBe("https://gateway.example/v1/service/task-ended");
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ company: ORG_A, task: TASK });
    // The other company's flow asks in its own name: the gateway's answer for company A is not delivery of company B's notice.
    await expect(b.taskEnded!({ orgId: ORG_B, taskId: TASK })).resolves.toBe("pending");
    expect(logs.filter((entry) => entry["event"] === "task_end_notice").every((entry) => !JSON.stringify(entry).includes(TASK))).toBe(true);
  });
});
