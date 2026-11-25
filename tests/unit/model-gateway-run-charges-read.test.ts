// GATEWAY-RUN-CHARGES-ROUTE: the gateway's signed read of what one run actually cost (GET /v1/service/companies/<company>/runs/<operationId>/charges?task=<task>), read by Code's hosted broker for a run whose
// usage never reached it. The core rules: the token is verified like the offered-models and upkeep-cap tokens, the run is found only under the token's company AND the query's task, "no record", another company's
// run and another task's run are ONE 404 (never a 200 with no receipts: a reader would book $0), a run with a call still open says `complete: false`, every amount is the meter's own receipt amount (USD micros),
// and a run that cannot be read whole is a 503. The same cases run on the DynamoMeter (over the wire fake) and on the InMemoryMeter.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { chargeValue, parseChargeReceiptV1, type ChargeReceiptV1 } from "../../packages/model-gateway/src/charge-receipt.js";
import { finishCharge, initialCharge } from "../../packages/model-gateway/src/charge-producer.js";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { StaticInstallRegistry } from "../../packages/model-gateway/src/installs.js";
import { InMemoryMeter, RUN_CALLS_MAX, RUN_INDEX_GRACE_MS, type MeterScope } from "../../packages/model-gateway/src/meter.js";
import { readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import {
  answerRunCharges, createRunChargesHandler, projectRunReceipt, RUN_CHARGES_AUDIENCE, RUN_CHARGES_PER_MINUTE, RUN_CHARGES_TOKEN_KIND, type RunChargesHandlerOptions,
} from "../../packages/model-gateway/src/run-charges-read.js";
import { createSignedTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { answer, call, claims, jwk, keys, kid, mint, now, setup } from "./model-gateway-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const ISS = claims.iss;
const A = claims.cid;
const B = `org_${"b".repeat(20)}`;
const secs = now / 1000;
const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices", companies: "cloud-companies" };
const PRICE = { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, estimated: false, usageEstimated: false };
const SOURCE = { source: { kind: "company_key" as const, id: "connection_1", name: "Acme private key", provider: "anthropic", connectionRevision: "7" }, billing: "external_provider" as const };
const CAPS = { task: 1e12, projectMonth: 1e12, companyMonth: 1e12 };

function mintRead(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}, signer = keys.privateKey): string {
  const body = { iss: ISS, aud: RUN_CHARGES_AUDIENCE, jti: randomUUID(), iat: secs, nbf: secs - 30, exp: secs + 60, cid: A, ...changes };
  const input = [JSON.stringify({ alg: "RS256", typ: "rovara-service+jwt", kid, ...header }), JSON.stringify(body)].map((v) => Buffer.from(v).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), signer).toString("base64url")}`;
}
const verify = () => createSignedTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: ISS, jwksUrl: `${ISS}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: () => now }, RUN_CHARGES_TOKEN_KIND);

type Kind = "dynamo" | "memory";
const DAY = 86_400_000;
/** `since`: when indexing of runs began in this environment (the marker). Default: ten days before `now`, so a call made at `now` is long after it. */
function world(kind: Kind, since = now - 10 * DAY) {
  let clock = now;
  const wire = new WireDynamo(Object.values(TABLES));
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  const meter = kind === "dynamo" ? new DynamoMeter({ db, tables: TABLES, now: () => clock }) : new InMemoryMeter(() => clock, () => false, () => undefined, { runIndexSince: since });
  const ready = kind === "dynamo" ? db.put(TABLES.meter, { pk: "CO#META#run-index", sk: "SINCE", since }) : Promise.resolve(true);
  const reads: string[] = [];
  const opts: RunChargesHandlerOptions = { verify: verify(), meter: { runCharges: async (scope, op) => { await ready; reads.push(`${scope.cid}/${scope.tid}/${op}`); return meter.runCharges(scope, op); } }, now: () => now };
  /** One call of a run: held with its receipt (as the agent route holds it), then optionally settled. */
  const call = async (o: { company?: string; task?: string; op: string; reservation?: number; settle?: "final" | "estimated" | "none" | "unreceipted"; reported?: number; at?: number }) => {
    await ready; clock = o.at ?? now;
    const company = o.company ?? A, task = o.task ?? "task_1", reservation = o.reservation ?? 500;
    const scope: MeterScope = { iss: ISS, cid: company, pid: "web", tid: task };
    const initial = initialCharge({ ...claims, cid: company, tid: task, op: o.op } as never, { provider: "anthropic", modelId: "claude-sonnet-4-5" }, SOURCE, reservation, now, PRICE);
    const held = await meter.reserve({ scope, caps: CAPS, estimateMicros: reservation, run: { operationId: o.op }, ...(o.settle === "unreceipted" ? {} : { charge: { receipt: initial, kind: "chat", requestFingerprint: "a".repeat(64) } }) });
    if (!held.ok) throw new Error(`not held: ${JSON.stringify(held)}`);
    if (o.settle === "unreceipted") { await meter.settle(held.reservation, reservation); return { initial, final: undefined }; }
    if (o.settle === "none") return { initial, final: undefined };
    const final = o.settle === "estimated"
      ? finishCharge(initial, { price: PRICE, notSent: false, now, failedMicros: Math.floor(reservation / 2) })
      : finishCharge(initial, { reportedCostMicros: o.reported ?? 123, price: PRICE, notSent: false, now });
    await meter.settleV2({ reservationId: held.reservation.id, receipt: final });
    return { initial, final };
  };
  return { meter, opts, reads, call, db };
}
const pathOf = (company: string, op: string, task: string | null = "task_1") => `/v1/service/companies/${company}/runs/${op}/charges${task === null ? "" : `?task=${encodeURIComponent(task)}`}`;
async function get(opts: RunChargesHandlerOptions, url: string, token: string | null = mintRead(), o: { headers?: Record<string, string>; method?: string } = {}) {
  return answerRunCharges(opts, { method: o.method ?? "GET", url, headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...o.headers } });
}
const UNSIGNED = { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } };
const NOT_FOUND = { status: 404, body: { error: { type: "not_found", message: "not found" } } };
const UNAVAILABLE = { status: 503, body: { error: { type: "unavailable", message: "model access unavailable" } } };
type Body = { version: number; operationId: string; seen: boolean; complete: boolean; receipts: ChargeReceiptV1[] };
const amountOf = (r: ChargeReceiptV1) => chargeValue(r.amountMicros)!;

describe.each(["dynamo", "memory"] as const)("the answer (%s meter)", (kind) => {
  it("an owner company's finished run: every call's receipt, complete, seen, with the meter's own amounts in USD micros", async () => {
    const w = world(kind); const op = randomUUID();
    await w.call({ op, reported: 100 }); await w.call({ op, reported: 250 }); await w.call({ op: randomUUID(), reported: 9_999 });
    const got = await get(w.opts, pathOf(A, op));
    expect(got.status).toBe(200);
    const body = got.body as Body;
    expect(Object.keys(body)).toEqual(["version", "operationId", "seen", "complete", "indexedSince", "receipts"]);
    expect(body).toMatchObject({ indexedSince: new Date(now - 10 * DAY).toISOString() });
    expect(body).toMatchObject({ version: 1, operationId: op, seen: true, complete: true });
    expect(body.receipts.map(amountOf).sort((a, b) => a - b)).toEqual([100, 250]);
    // The receipts are what Code's reader requires: this company, this task, this run, USD, an available amount, and each reads by the strict contract reader.
    for (const r of body.receipts) {
      expect(parseChargeReceiptV1(JSON.parse(JSON.stringify(r)))).toBeDefined();
      expect(r).toMatchObject({ companyId: A, taskId: "task_1", operationId: op, currency: "USD", status: "final" });
    }
    // ...and the sum is the meter's own task spend for the run's task less the other run's call (reported cost settles at that amount).
    const rows = await w.meter.read({ iss: ISS, cid: A, pid: "web", tid: "task_1" });
    expect(rows.find((r) => r.item === "task")!.spentMicros).toBe(100 + 250 + 9_999);
  });
  it("an estimate is not final: its receipt says estimated, and the run is still complete (nothing is open)", async () => {
    const w = world(kind); const op = randomUUID();
    await w.call({ op, settle: "estimated", reservation: 800 });
    const body = (await get(w.opts, pathOf(A, op))).body as Body;
    expect(body.complete).toBe(true);
    expect(body.receipts.map((r) => r.status)).toEqual(["estimated"]);
    expect(amountOf(body.receipts[0]!)).toBe(400);
  });
  it("a run with a call still open is NOT complete: the open call's receipt is the hold's own (awaiting usage, its reservation), and it turns complete when that call settles", async () => {
    const w = world(kind); const op = randomUUID();
    await w.call({ op, reported: 100 });
    const open = await w.call({ op, settle: "none", reservation: 700 });
    const during = (await get(w.opts, pathOf(A, op))).body as Body;
    expect(during).toMatchObject({ seen: true, complete: false });
    expect(during.receipts).toHaveLength(2);
    const waiting = during.receipts.find((r) => r.callId === open.initial.callId)!;
    expect(waiting).toMatchObject({ status: "awaiting_usage", reason: "missing_usage" });
    expect(amountOf(waiting)).toBe(700);
    await w.meter.settleV2({ reservationId: open.initial.callId, receipt: finishCharge(open.initial, { reportedCostMicros: 300, price: PRICE, notSent: false, now }) });
    const after = (await get(w.opts, pathOf(A, op))).body as Body;
    expect(after.complete).toBe(true);
    expect(after.receipts.map(amountOf).sort((a, b) => a - b)).toEqual([100, 300]);
  });
  it("a revised receipt (a later revision of a call) is what the run answers, never the first one", async () => {
    const w = world(kind); const op = randomUUID();
    const first = await w.call({ op, settle: "estimated", reservation: 800 });
    const rest = structuredClone(first.final!);
    delete rest.neverConfirmed;
    const revised: ChargeReceiptV1 = { ...rest, revision: 2, replacesRevision: 1, status: "final", reason: "reported_cost", amountMicros: { state: "available", value: 150 }, providerCostMicros: { state: "available", value: 150 }, billableMicros: { state: "available", value: 0 } };
    if (w.meter.applyChargeReceipt === undefined) throw new Error("no revisions");
    await w.meter.applyChargeReceipt(revised);
    const body = (await get(w.opts, pathOf(A, op))).body as Body;
    expect(body.receipts.map((r) => [r.revision, amountOf(r), r.status])).toEqual([[2, 150, "final"]]);
  });
  it("two runs of one task never mix", async () => {
    const w = world(kind); const one = randomUUID(), two = randomUUID();
    await w.call({ op: one, reported: 11 }); await w.call({ op: two, reported: 22 });
    expect(((await get(w.opts, pathOf(A, one))).body as Body).receipts.map(amountOf)).toEqual([11]);
    expect(((await get(w.opts, pathOf(A, two))).body as Body).receipts.map(amountOf)).toEqual([22]);
  });
});

describe.each(["dynamo", "memory"] as const)("not found is one answer (%s meter)", (kind) => {
  it("no record: the fixed 404, never a 200 with no receipts (a reader would take that as $0)", async () => {
    const w = world(kind);
    expect(await get(w.opts, pathOf(A, randomUUID()))).toEqual(NOT_FOUND);
  });
  it("another company's run is the same 404 as an unknown run, byte for byte, and its amounts never appear", async () => {
    const w = world(kind); const op = randomUUID();
    await w.call({ company: B, op, reported: 4_242 });
    const theirs = await get(w.opts, pathOf(A, op));
    const nobody = await get(w.opts, pathOf(A, randomUUID()));
    expect(theirs).toEqual(NOT_FOUND); expect(JSON.stringify(theirs)).toBe(JSON.stringify(nobody));
    // B itself reads it.
    expect(((await get(w.opts, pathOf(B, op), mintRead({ cid: B }))).body as Body).receipts.map(amountOf)).toEqual([4_242]);
  });
  it("the right run under the wrong task is the same 404", async () => {
    const w = world(kind); const op = randomUUID();
    await w.call({ op, task: "task_1", reported: 77 });
    expect(await get(w.opts, pathOf(A, op, "task_2"))).toEqual(NOT_FOUND);
    expect(((await get(w.opts, pathOf(A, op, "task_1"))).body as Body).receipts.map(amountOf)).toEqual([77]);
  });
  it("the query is exactly one task of the gateway's own format; anything else is the 404 and reads nothing", async () => {
    const w = world(kind); const op = randomUUID(); await w.call({ op });
    for (const url of [pathOf(A, op, null), `${pathOf(A, op)}&task=task_1`, `${pathOf(A, op)}&x=1`, `/v1/service/companies/${A}/runs/${op}/charges?x=1`, pathOf(A, op, ""), pathOf(A, op, "a/b"), pathOf(A, op, "t".repeat(129)), `${pathOf(A, op)}%00`]) {
      expect(await get(w.opts, url), url).toEqual(NOT_FOUND);
    }
    expect(await get(w.opts, `/v1/service/companies/${A}/runs/not-a-uuid/charges?task=task_1`)).toEqual(NOT_FOUND);
    expect(await get(w.opts, `/v1/service/companies/org_short/runs/${op}/charges?task=task_1`)).toEqual(NOT_FOUND);
    expect(await get(w.opts, `${pathOf(A, op)}/`)).toEqual(NOT_FOUND);
    expect(w.reads).toEqual([]);
  });
});

describe.each(["dynamo", "memory"] as const)("a run that may start before the index did is never complete (%s meter)", (kind) => {
  const since = now - 2 * DAY;
  const after = since + RUN_INDEX_GRACE_MS + 60_000;
  it("calls before and after the marker: never complete, with the reason and the marker's time, even once every call has settled", async () => {
    const w = world(kind, since); const op = randomUUID();
    await w.call({ op, reported: 100, at: since - 3_600_000 }); await w.call({ op, reported: 250, at: after + 3_600_000 });
    const body = (await get(w.opts, pathOf(A, op))).body as Body & { reason?: string; indexedSince: string };
    expect(body).toMatchObject({ seen: true, complete: false, reason: "started_before_index", indexedSince: new Date(since).toISOString() });
    expect(body.receipts.map(amountOf).sort((a, b) => a - b)).toEqual([100, 250]);
  });
  it("a run fully after the marker (past the grace): complete, no reason", async () => {
    const w = world(kind, since); const op = randomUUID();
    await w.call({ op, reported: 100, at: after }); await w.call({ op, reported: 250, at: after + 3_600_000 });
    const body = (await get(w.opts, pathOf(A, op))).body as Body & { reason?: string; indexedSince: string };
    expect(body).toMatchObject({ seen: true, complete: true, indexedSince: new Date(since).toISOString() });
    expect(Object.hasOwn(body, "reason")).toBe(false);
  });
  it("the grace is exact: a first call at the marker plus the grace is not complete, one millisecond later is", async () => {
    const w = world(kind, since);
    const edge = randomUUID(), past = randomUUID();
    await w.call({ op: edge, at: since + RUN_INDEX_GRACE_MS }); await w.call({ op: past, at: since + RUN_INDEX_GRACE_MS + 1 });
    expect(((await get(w.opts, pathOf(A, edge))).body as Body).complete).toBe(false);
    expect(((await get(w.opts, pathOf(A, past))).body as Body).complete).toBe(true);
  });
  it("a run whose first call came at the marker (the very first run after the release) is not complete either", async () => {
    const w = world(kind, since); const op = randomUUID();
    await w.call({ op, at: since });
    expect(((await get(w.opts, pathOf(A, op))).body as Body & { reason?: string }).reason).toBe("started_before_index");
  });
});

describe("the index marker (the Dynamo meter)", () => {
  it("is written once and never moved: a later process reads the first one's time", async () => {
    const wire = new WireDynamo(Object.values(TABLES));
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const first = new DynamoMeter({ db, tables: TABLES, now: () => now });
    const later = new DynamoMeter({ db, tables: TABLES, now: () => now + 5 * DAY });
    expect(await first.markRunIndex()).toBe(now);
    expect(await later.markRunIndex()).toBe(now);
  });
  it("an environment with no marker gets one the first time a run is read, at that time", async () => {
    const wire = new WireDynamo(Object.values(TABLES));
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => now });
    expect(await meter.runCharges({ iss: ISS, cid: A, tid: "task_1" }, randomUUID())).toEqual({ found: false });
    expect(await meter.markRunIndex()).toBe(now);
  });
});

describe("a run that cannot be read whole is a 503, never a smaller figure", () => {
  it.each(["dynamo", "memory"] as const)("a call held with no receipt (%s meter)", async (kind) => {
    const w = world(kind); const op = randomUUID();
    await w.call({ op, reported: 100 }); await w.call({ op, settle: "unreceipted" });
    expect(await get(w.opts, pathOf(A, op))).toEqual(UNAVAILABLE);
  });
  it("a meter that throws, and one that answers a run with no receipts", async () => {
    const w = world("memory"); const op = randomUUID();
    expect(await get({ ...w.opts, meter: { runCharges: async () => { throw new Error("store down"); } } }, pathOf(A, op))).toEqual(UNAVAILABLE);
    expect(await get({ ...w.opts, meter: { runCharges: async () => ({ found: true, complete: true, receipts: [], indexedSince: now, startedBeforeIndex: false }) } }, pathOf(A, op))).toEqual(UNAVAILABLE);
  });
  it("a receipt that does not read as a receipt", async () => {
    const w = world("memory"); const op = randomUUID(); const { final } = await w.call({ op });
    const broken = { ...final!, amountMicros: { state: "unavailable", reason: "unreadable" } } as ChargeReceiptV1;
    expect(await get({ ...w.opts, meter: { runCharges: async () => ({ found: true, complete: true, receipts: [broken], indexedSince: now, startedBeforeIndex: false }) } }, pathOf(A, op))).toEqual(UNAVAILABLE);
  });
  it("more calls than the read serves (the Dynamo meter reads 501 index items, then refuses)", async () => {
    const w = world("dynamo"); const op = randomUUID();
    const pk = `CO#${JSON.stringify([ISS, A])}`;
    for (let i = 0; i <= RUN_CALLS_MAX; i++) { const id = randomUUID(); await w.db.put(TABLES.meter, { pk, sk: `RUN#${JSON.stringify(["task_1", op])}#${id}`, callId: id, createdAt: now }); }
    await expect(w.meter.runCharges({ iss: ISS, cid: A, tid: "task_1" }, op)).rejects.toThrow("run charges unavailable");
    expect(await get(w.opts, pathOf(A, op))).toEqual(UNAVAILABLE);
  });
  it("an index item with no hold behind it (the Dynamo meter)", async () => {
    const w = world("dynamo"); const op = randomUUID(); const id = randomUUID();
    const pk = `CO#${JSON.stringify([ISS, A])}`;
    await w.db.put(TABLES.meter, { pk, sk: `RUN#${JSON.stringify(["task_1", op])}#${id}`, callId: id, createdAt: now });
    expect(await get(w.opts, pathOf(A, op))).toEqual(UNAVAILABLE);
  });
});

describe("no customer data beyond amounts", () => {
  it("the answer withholds who asked, who pays, the provider's request id, the connection's name and the project; the stored receipt is untouched", async () => {
    const w = world("memory"); const op = randomUUID(); const { final } = await w.call({ op, reported: 500 });
    const got = await get(w.opts, pathOf(A, op));
    const text = JSON.stringify(got.body);
    for (const secret of [claims.per, "Acme private key", "web"]) expect(text, secret).not.toContain(`"${secret}"`);
    const r = (got.body as Body).receipts[0]!;
    expect(r).toMatchObject({ requesterId: { state: "unavailable", reason: "restricted" }, providerRequestId: { state: "unavailable", reason: "restricted" }, project: "restricted", payer: { id: "restricted", name: "restricted" }, source: { id: "connection_1", name: "restricted" } });
    expect(amountOf(r)).toBe(500);
    expect(final!.project).toBe("web");
    expect(parseChargeReceiptV1(projectRunReceipt(final!))).toBeDefined();
  });
});

describe("the service token: the same auth as the other service reads", () => {
  const refused = async (token: string | null, o: { headers?: Record<string, string> } = {}) => {
    const w = world("memory"); const op = randomUUID(); await w.call({ op });
    expect(await get(w.opts, pathOf(A, op), token, o)).toEqual(UNSIGNED);
    expect(w.reads).toEqual([]);
  };
  it("unsigned, wrong audience (the other service reads', a task token), wrong key, wrong type, wrong header, expired, long-lived, extra or missing claims", async () => {
    await refused(null);
    await refused(mintRead({ aud: "rovara-model-gateway-upkeep-cap" }));
    await refused(mintRead({ aud: "rovara-model-gateway-offered-models" }));
    await refused(mint());
    await refused(mintRead({}, {}, (await import("node:crypto")).generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey));
    await refused(mintRead({}, { typ: "rovara-task+jwt" }));
    await refused(mintRead({}, { kid: "x".repeat(16) }));
    await refused(mintRead({ exp: secs - 5 }));
    await refused(mintRead({ exp: secs + 3_600 }));
    await refused(mintRead({ extra: 1 }));
    await refused(mintRead({ jti: "not-a-uuid" }));
    await refused(mintRead(), { headers: { "x-api-key": "k" } });
  });
  it("a token for company B at company A's address learns nothing: the same 401 whether A's run exists or not, and nothing is read", async () => {
    const w = world("memory"); const op = randomUUID(); await w.call({ op, reported: 4_242 });
    const real = await get(w.opts, pathOf(A, op), mintRead({ cid: B }));
    const nobody = await get(w.opts, pathOf(A, randomUUID()), mintRead({ cid: B }));
    expect(real).toEqual(UNSIGNED); expect(nobody).toEqual(UNSIGNED);
    expect(JSON.stringify(real)).not.toContain("4242");
    expect(w.reads).toEqual([]);
  });
  it("only a GET reads", async () => {
    const w = world("memory"); const op = randomUUID(); await w.call({ op });
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) expect((await get(w.opts, pathOf(A, op), mintRead(), { method })).status, method).toBe(405);
    expect(w.reads).toEqual([]);
  });
  it("the verifier accepts the contract's token only: typ rovara-service+jwt, at most 60 seconds", () => {
    expect(RUN_CHARGES_TOKEN_KIND.typ).toBe("rovara-service+jwt");
    expect(RUN_CHARGES_TOKEN_KIND.maxSeconds).toBe(60);
    expect(RUN_CHARGES_AUDIENCE).toBe("rovara-model-gateway-run-charges");
  });
});

class FakeResponse extends EventEmitter {
  statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false; destroyed = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("finish"); this.emit("close"); return this; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
  json() { return JSON.parse(Buffer.concat(this.chunks).toString("utf8")) as unknown; }
}
function http(handler: (req: never, res: never) => Promise<void>, url: string, token: string | null, method = "GET") {
  const req = Object.assign(Readable.from([]), { method, url, headers: token === null ? {} : { authorization: `Bearer ${token}` } });
  const res = new FakeResponse();
  const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
  void handler(req as never, res as never);
  return done;
}

describe("the HTTP handler", () => {
  it("writes the answer as JSON with no-store, and a refusal the same way", async () => {
    const w = world("memory"); const op = randomUUID(); await w.call({ op, reported: 5 });
    const handler = createRunChargesHandler(w.opts);
    const good = await http(handler, pathOf(A, op), mintRead());
    expect(good.statusCode).toBe(200);
    expect(good.headers).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
    expect(good.json()).toMatchObject({ version: 1, operationId: op, seen: true, complete: true });
    expect((await http(handler, pathOf(A, op), null)).statusCode).toBe(401);
  });
  it("is rate limited per serving task: over the minute's calls it answers 429 and reads nothing", async () => {
    const w = world("memory"); const op = randomUUID();
    const handler = createRunChargesHandler(w.opts);
    for (let i = 0; i < RUN_CHARGES_PER_MINUTE; i++) expect((await http(handler, pathOf(A, op), null)).statusCode).toBe(401);
    expect((await http(handler, pathOf(A, op), mintRead())).statusCode).toBe(429);
    expect(w.reads).toEqual([]);
  });
});

// ---- in the deployed process: a real agent call, then Code's read of its run ----------------------------------------------------------------------------------
const ENV = {
  [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: ISS, [GATEWAY_ENV.installJwksUrl]: `${ISS}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: TABLES.meter, [GATEWAY_ENV.ledgerTable]: TABLES.ledger, [GATEWAY_ENV.markersTable]: TABLES.markers, [GATEWAY_ENV.pricesTable]: TABLES.prices, [GATEWAY_ENV.companyTable]: TABLES.companies,
  [GATEWAY_ENV.anthropicKeySecret]: `arn:aws:secretsmanager:us-west-2:${"1".repeat(12)}:secret:rovara-cloud/staging/model-gateway/provider/anthropic-AbCdEf`,
};
const jwksFetch: typeof fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
const running: RunningGateway[] = [];
afterEach(async () => { for (const gateway of running.splice(0)) await gateway.drain(); });
const settleAll = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
function request(server: RunningGateway["server"], method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<FakeResponse> {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers });
  const res = new FakeResponse();
  const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
  server.emit("request", req, res);
  return done;
}
async function serve() {
  const wire = new WireDynamo(Object.values(TABLES));
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  await db.put(TABLES.companies, { pk: `COMPANY#${A}`, sk: "SETTINGS", companyId: A, version: 1, settings: { featureGates: {}, budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } } });
  const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0 };
  const gateway = await startServe(config, {
    db, fetch: jwksFetch, now: () => now, listen: false, log: () => undefined,
    keys: { keyFor: async () => "rovara-install-key" },
    transport: async () => ({ status: 200, body: answer() }),
  });
  running.push(gateway);
  const read = (op: string, token: string | null = mintRead(), task: string | null = "task_1", company = A) => request(gateway.server, "GET", pathOf(company, op, task), token === null ? {} : { authorization: `Bearer ${token}` });
  const agentCall = (changes: Record<string, unknown> = {}) => request(gateway.server, "POST", "/v1/messages", { "content-type": "application/json", "x-api-key": mint(changes) }, { model: claims.mdl[0], messages: [{ role: "user", content: "hello" }], max_tokens: 10, stream: true });
  return { gateway, read, agentCall };
}

describe("gateway process: the run charges read", () => {
  it("the route is served by the deployed process; in install-key mode a call has no receipt (receipts come only with a company key's admitted source), so its run is a 503, never a figure; other runs, tasks and companies are the 404", async () => {
    const s = await serve();
    const op = randomUUID();
    expect((await s.agentCall({ op })).statusCode).toBe(200);
    await settleAll();
    expect((await s.read(op)).json()).toEqual(UNAVAILABLE.body);
    expect((await s.read(randomUUID())).statusCode).toBe(404);
    expect((await s.read(op, mintRead(), "task_2")).statusCode).toBe(404);
    expect((await s.read(op, mintRead({ cid: B }), "task_1", B)).statusCode).toBe(404);
  });
  it("an unsigned call, another company's token and an agent task token never read", async () => {
    const s = await serve(); const op = randomUUID();
    expect((await s.read(op, null)).statusCode).toBe(401);
    expect((await s.read(op, mintRead({ cid: B }))).statusCode).toBe(401);
    expect((await s.read(op, mint())).statusCode).toBe(401);
  });
});

describe("the agent route holds every call under its run", () => {
  it("a real call with a receipt: the hold is found by the token's operation id, open while streaming (not complete) and complete after", async () => {
    const meter = new InMemoryMeter(() => now);
    let during: unknown;
    const f = setup({ meter, transport: async () => { during = await meter.runCharges({ iss: claims.iss, cid: claims.cid, tid: claims.tid }, claims.op); return { status: 200, body: answer() }; } });
    Reflect.set(f.deps, "chargeReceipts", { source: () => SOURCE });
    await call(f.deps);
    expect(during).toMatchObject({ found: true, complete: false });
    const after = await meter.runCharges({ iss: claims.iss, cid: claims.cid, tid: claims.tid }, claims.op);
    expect(after).toMatchObject({ found: true, complete: true });
    if (!after.found) throw new Error("not found");
    expect(after.receipts).toHaveLength(1);
    expect(after.receipts[0]).toMatchObject({ companyId: claims.cid, taskId: claims.tid, operationId: claims.op });
    expect(await meter.runCharges({ iss: claims.iss, cid: claims.cid, tid: "task_other" }, claims.op)).toEqual({ found: false });
  });
});
