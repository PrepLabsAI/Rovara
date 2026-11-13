import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReplyProbeStore, MODEL_PROBE_REQUEST_KIND } from "../../packages/contracts/src/model-reply-check-store.js";
import { checkReplySetAgainstReal, type ReplyProbe, type ReplyProbeSource } from "../../packages/contracts/src/model-reply-check.js";
import type { ModelEgress, ModelEgressScope } from "../../packages/contracts/src/ports/model-egress.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { COMPANY_A, COMPANY_B, SHARED_RAW_IDS, assertSurfacesIsolated } from "../../packages/testing/src/isolation/two-company.js";
import { installNetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import { modelReplyEntrySha256, type ModelReplySet } from "../../packages/contracts/src/model-reply-set.js";
import { createFakeProvider, createFakeEgress, fakeScope } from "../../packages/testing/src/ports/model-egress-fake.js";
import { fixtureEgressRows, fixtureKey } from "../../packages/testing/src/ports/model-egress-fixtures.js";

const query = { project: SHARED_RAW_IDS.project, branch: SHARED_RAW_IDS.branch, family: "openai_compatible" as const };
const set: ModelReplySet = { version: 1, family: "openai_compatible", replies: [{ id: "reply-a", match: {}, response: { text: "script", finish: "stop" }, provenance: "task_made" }] };
const probe = (text = "prompt"): ReplyProbe => ({ replyId: "reply-a", entrySha256: modelReplyEntrySha256(set.replies[0]!), rowId: "openai", family: "openai_compatible", frame: { row: "openai", method: "POST", path: "/v1/chat/completions", query: "", headers: [], body: new TextEncoder().encode(JSON.stringify({ model: "fixture-small", messages: [{ content: text }] })) } });
async function sourceProbes(source: ReplyProbeSource): Promise<readonly ReplyProbe[]> { const result = await source.readProbes(); return result.ok ? result.probes : []; }
function world() {
  let now = 2_000_000_000;
  // No automatic TTL sweep: the service's read-time expiry is the safety boundary.
  const store = new MemoryDocumentStore({ changeFeed: false });
  const service = createReplyProbeStore({ store, companyOf: (scope) => "orgId" in scope ? scope.orgId : undefined, now: () => now, retentionSeconds: 60 });
  const put = (personId = "person-p", text = "prompt", scope = COMPANY_A.scope) => service.put(scope, { ...query, personId, probe: probe(text), expiresAt: now + 60 });
  return { store, service, put, advance: (n: number) => { now += n; } };
}
let tripwire: ReturnType<typeof installNetworkTripwire>;
beforeEach(() => { tripwire = installNetworkTripwire(); });
afterEach(() => { tripwire.restore(); expect(tripwire.attempts).toEqual([]); });

describe("probe retention, erase and company isolation", () => {
  it("stores explicit expiry and TTL; expires exactly at the boundary without relying on sweep", async () => {
    const w = world(); expect(await w.put()).toEqual({ ok: true });
    const rows = await w.store.query({ pk: `ORG#${COMPANY_A.orgId}#MODEL_PROBE_REQUEST` });
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]).toMatchObject({ kind: MODEL_PROBE_REQUEST_KIND, expiresAt: 2_000_000_060, indexExpiresAt: 2_000_000_060 });
    expect((await sourceProbes(w.service.source(COMPANY_A.scope, query))).length).toBe(1);
    w.advance(60);
    expect(await sourceProbes(w.service.source(COMPANY_A.scope, query))).toEqual([]);
    expect(await w.service.read(COMPANY_A.scope, { ...query, replyId: "reply-a" })).toEqual({ ok: false, word: "not_found" });
    expect((await w.store.query({ pk: `ORG#${COMPANY_A.orgId}#MODEL_PROBE_REQUEST` })).items).toHaveLength(1);
  });
  it("requires bounded retention, refuses expired writes, strips authorization by refusing header-bearing probes", async () => {
    const w = world();
    for (const expiresAt of [2_000_000_000, 2_000_000_061, Infinity, NaN]) expect(await w.service.put(COMPANY_A.scope, { ...query, personId: "person-p", probe: probe(), expiresAt })).toEqual({ ok: false, word: "not_allowed" });
    const p = probe(); p.frame.headers = [["authorization", fixtureKey("inbound")]];
    expect(await w.service.put(COMPANY_A.scope, { ...query, personId: "person-p", probe: p, expiresAt: 2_000_000_060 })).toEqual({ ok: false, word: "not_allowed" });
    expect(await sourceProbes(w.service.source(COMPANY_A.scope, query))).toEqual([]);
  });
  it("person erase and company deletion remove probes and refuse resurrection while preserving company B", async () => {
    const w = world(); await w.put(); await w.put("person-q", "q", COMPANY_B.scope);
    expect(await w.service.erasePerson(COMPANY_A.scope, "person-p")).toEqual({ ok: true, deleted: 1 });
    expect(await sourceProbes(w.service.source(COMPANY_A.scope, query))).toEqual([]);
    expect(await w.put()).toEqual({ ok: false, word: "not_allowed" });
    await w.put("person-q");
    expect(await w.service.deleteCompany(COMPANY_A.scope)).toEqual({ ok: true, deleted: 1 });
    expect(await sourceProbes(w.service.source(COMPANY_A.scope, query))).toEqual([]);
    expect(await w.put("person-r")).toEqual({ ok: false, word: "not_allowed" });
    expect(await sourceProbes(w.service.source(COMPANY_B.scope, query))).toHaveLength(1);
    const rows = await w.store.query({ pk: `ORG#${COMPANY_A.orgId}#MODEL_PROBE_REQUEST` });
    expect(await w.service.erasePerson(COMPANY_A.scope, "person-late")).toEqual({ ok: false, word: "not_allowed" });
    expect(rows.items).toEqual([{ pk: `ORG#${COMPANY_A.orgId}#MODEL_PROBE_REQUEST`, sk: "ERASED#company", erased: true }]);
  });
  it("the shared two-company kit checks reads and lists with identical raw ids", async () => {
    const w = world();
    await assertSurfacesIsolated([{
      kind: "read", name: "probe requests",
      async plant(me) { await w.put("person-p", me.canary, me.scope); },
      async observe(as) { return { read: await w.service.read(as.scope, { ...query, replyId: "reply-a" }), list: (await sourceProbes(w.service.source(as.scope, query))).map((p) => new TextDecoder().decode(p.frame.body)) }; },
    }]);
  });
  it("company B cannot read, list or replay company A's probes", async () => {
    const w = world(); await w.put();
    expect(await w.service.read(COMPANY_B.scope, { ...query, replyId: "reply-a" })).toEqual({ ok: false, word: "not_found" });
    const probes = await sourceProbes(w.service.source(COMPANY_B.scope, query)); expect(probes).toEqual([]);
    const row = fixtureEgressRows().openai; const provider = createFakeProvider([row]);
    const egress = createFakeEgress({ rows: [row], sources: [{ company: "b", id: "source", row, connection: {}, key: fixtureKey("store"), capMicros: 100000 }], provider }).adapter;
    const report = await checkReplySetAgainstReal({ set, probes: w.service.source(COMPANY_B.scope, query), egress: egress as unknown as ModelEgress, scope: { companyId: COMPANY_B.orgId, egressScope: fakeScope("b", "source") as unknown as ModelEgressScope }, today: "2026-11-13" });
    expect(report.items[0]?.reasons).toEqual(["no_probe"]); expect(provider.calls).toHaveLength(0);
  });
  it("failed company resolution and store errors contain no customer text", async () => {
    const canary = ["canary", String(Math.floor(Math.random() * 1e9))].join("-");
    const w = world(); await w.put("person-p", canary);
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- a failing resolver must contain even raw thrown customer data.
    for (const companyOf of [() => undefined, () => { throw canary; }]) {
      const service = createReplyProbeStore({ store: w.store, companyOf, now: () => 2_000_000_000, retentionSeconds: 60 });
      expect(await sourceProbes(service.source(COMPANY_A.scope, query))).toEqual([]);
      const result = await service.put(COMPANY_A.scope, { ...query, personId: "p", probe: probe(), expiresAt: 2_000_000_060 });
      expect(result).toEqual({ ok: false, word: "not_allowed" }); expect(JSON.stringify(result)).not.toContain(canary);
    }
  });
});

describe("probe-store boundary guards", () => {
  it("keeps person attribution immutable, isolates projects/branches and bounds retention configuration", async () => {
    const w = world(); await w.put("person-p");
    expect(await w.put("person-q")).toEqual({ ok: false, word: "not_allowed" });
    expect(await sourceProbes(w.service.source(COMPANY_A.scope, { ...query, project: "other-project" }))).toEqual([]);
    expect(await sourceProbes(w.service.source(COMPANY_A.scope, { ...query, branch: "other-branch" }))).toEqual([]);
    for (const retentionSeconds of [0, -1, Infinity, 30 * 86400 + 1]) {
      const service = createReplyProbeStore({ store: w.store, companyOf: () => COMPANY_A.orgId, now: () => 2_000_000_000, retentionSeconds });
      expect(await service.put(COMPANY_A.scope, { ...query, personId: "person-p", probe: probe(), expiresAt: 2_000_000_060 })).toEqual({ ok: false, word: "not_allowed" });
    }
  });
  it("refuses query credentials and oversized probe bodies before writing", async () => {
    const w = world();
    for (const p of [{ ...probe(), frame: { ...probe().frame, query: `key=${fixtureKey("query")}` } }, probe("x".repeat(256 * 1024))]) {
      expect(await w.service.put(COMPANY_A.scope, { ...query, personId: "person-p", probe: p, expiresAt: 2_000_000_060 })).toEqual({ ok: false, word: "not_allowed" });
    }
    expect(await sourceProbes(w.service.source(COMPANY_A.scope, query))).toEqual([]);
  });
});

describe("bounded erase progress", () => {
  it("checkpoints a long erase so retries finish instead of leaving prompts forever", async () => {
    const w = world();
    for (let i = 0; i < 22; i++) {
      const p = probe(); p.replyId = `reply-${String(i)}`;
      expect(await w.service.put(COMPANY_A.scope, { ...query, personId: "person-p", probe: p, expiresAt: 2_000_000_060 })).toEqual({ ok: true });
    }
    const queryPage = w.store.query.bind(w.store);
    w.store.query = (request) => queryPage({ ...request, limit: 1 });
    const pk = `ORG#${COMPANY_A.orgId}#MODEL_PROBE_REQUEST`;
    expect(await w.service.erasePerson(COMPANY_A.scope, "person-p")).toEqual({ ok: false, word: "not_allowed" });
    expect((await queryPage({ pk, sk: { op: "beginsWith", prefix: "PROBE#" } })).items).toHaveLength(2);
    expect(await sourceProbes(w.service.source(COMPANY_A.scope, query))).toEqual([]);
    expect(await w.service.erasePerson(COMPANY_A.scope, "person-p")).toEqual({ ok: true, deleted: 2 });
    expect((await queryPage({ pk, sk: { op: "beginsWith", prefix: "PROBE#" } })).items).toEqual([]);
    // An unrelated person's many earlier keys must not trap a later erase at the page bound forever.
    for (let i = 0; i < 22; i++) {
      const p = probe(); p.replyId = `other-${String(i)}`;
      expect(await w.service.put(COMPANY_A.scope, { ...query, personId: "person-q", probe: p, expiresAt: 2_000_000_060 })).toEqual({ ok: true });
    }
    expect(await w.service.erasePerson(COMPANY_A.scope, "person-r")).toEqual({ ok: false, word: "not_allowed" });
    expect(await w.service.erasePerson(COMPANY_A.scope, "person-r")).toEqual({ ok: true, deleted: 0 });
    expect((await queryPage({ pk, sk: { op: "beginsWith", prefix: "PROBE#" } })).items).toHaveLength(22);
  });
});


describe("review storage regressions", () => {
  it("refuses path credentials, delimiters anywhere, and paths the family cannot route", async () => {
    const w = world(); const secret = ["sk", "live", String(Math.random()).slice(2)].join("-");
    for (const path of [`/v1/chat/completions?key=${secret}`, "/v1/chat/completions;key=x", "/v1/chat/completions#key", "/v1;key=x/chat/completions", "/v1#key/chat/completions", "/v1?key=x/chat/completions", "/not/a/model/route"]) {
      const p = probe(); p.frame.path = path;
      expect(await w.service.put(COMPANY_A.scope, { ...query, personId: "person-p", probe: p, expiresAt: 2_000_000_060 })).toEqual({ ok: false, word: "not_allowed" });
    }
    expect((await w.store.query({ pk: `ORG#${COMPANY_A.orgId}#MODEL_PROBE_REQUEST` })).items).toEqual([]);
    expect(await w.put()).toEqual({ ok: true });
  });
  it("refuses secret-shaped body values including JSON-escaped secrets before storage", async () => {
    const w = world(); const secret = ["sk", "test", "x".repeat(24)].join("_");
    for (const body of [JSON.stringify({ api_key: secret }), JSON.stringify({ api_key: secret }).replaceAll("_", "\\u005f")]) {
      const p = probe(); p.frame.body = new TextEncoder().encode(body);
      expect(await w.service.put(COMPANY_A.scope, { ...query, personId: "person-p", probe: p, expiresAt: 2_000_000_060 })).toEqual({ ok: false, word: "not_allowed" });
    }
    expect((await w.store.query({ pk: `ORG#${COMPANY_A.orgId}#MODEL_PROBE_REQUEST` })).items).toEqual([]);
  });
  it("refuses implausible epoch seconds and a millisecond clock on writes and reads", async () => {
    const w = world(); expect(await w.put()).toEqual({ ok: true });
    for (const now of [1, 946684799, 4102444800, 1_763_000_000_000]) {
      const service = createReplyProbeStore({ store: w.store, companyOf: () => COMPANY_A.orgId, now: () => now, retentionSeconds: 60 });
      expect(await service.put(COMPANY_A.scope, { ...query, personId: "person-p", probe: probe(), expiresAt: now + 60 })).toEqual({ ok: false, word: "not_allowed" });
      expect(await service.read(COMPANY_A.scope, { ...query, replyId: "reply-a" })).toEqual({ ok: false, word: "not_found" });
    }
  });
  it("a put during the erase query cannot survive the person fence", async () => {
    const w = world(); expect(await w.put()).toEqual({ ok: true });
    const queryPage = w.store.query.bind(w.store); let raced = false;
    w.store.query = async (request) => {
      const page = await queryPage(request);
      if (!raced) {
        raced = true;
        const p = probe(); p.replyId = "late-reply";
        await w.service.put(COMPANY_A.scope, { ...query, personId: "person-p", probe: p, expiresAt: 2_000_000_060 });
      }
      return page;
    };
    expect(await w.service.erasePerson(COMPANY_A.scope, "person-p")).toEqual({ ok: true, deleted: 1 });
    expect(raced).toBe(true);
    expect((await queryPage({ pk: `ORG#${COMPANY_A.orgId}#MODEL_PROBE_REQUEST`, sk: { op: "beginsWith", prefix: "PROBE#" } })).items).toEqual([]);
  });
});


describe("bound probe sources", () => {
  const scope = (companyId: string) => ({ companyId, egressScope: fakeScope(companyId, "source") as unknown as ModelEgressScope });
  it("refuses company A probes with company B scope before forwarding", async () => {
    const w = world(); expect(await w.put()).toEqual({ ok: true });
    let forwards = 0;
    const egress: ModelEgress = { capabilities: { schemes: [] }, async *forward() { forwards++; yield { kind: "head", status: 200, headers: [] }; yield { kind: "chunk", bytes: new TextEncoder().encode('{"choices":[{"message":{"content":"answer"},"finish_reason":"stop"}]}') }; yield { kind: "settle", status: 200, class: "ok", costMicros: 7, estimated: false }; } };
    const args = { set, probes: w.service.source(COMPANY_A.scope, query), egress, scope: scope(COMPANY_B.orgId), today: "2026-11-13" };
    expect(await checkReplySetAgainstReal(args)).toMatchObject({ status: "not_checked", label: "not checked: scope mismatch", items: [] });
    expect(forwards).toBe(0);
    const report = await checkReplySetAgainstReal({ ...args, scope: scope(COMPANY_A.orgId) });
    expect(report.status).toBe("checked"); expect(forwards).toBe(1);
  });
  for (const refusal of ["truncated", "too_many", "fenced"] as const) it(`reports ${refusal} source refusal as store unavailable`, async () => {
    const w = world(); expect(await w.put()).toEqual({ ok: true });
    if (refusal === "fenced") await w.service.deleteCompany(COMPANY_A.scope);
    if (refusal === "too_many") {
      for (let i = 0; i < 2000; i++) {
        const p = probe(); p.replyId = `extra-${String(i)}`;
        expect(await w.service.put(COMPANY_A.scope, { ...query, personId: "person-p", probe: p, expiresAt: 2_000_000_060 })).toEqual({ ok: true });
      }
    }
    if (refusal === "truncated") w.store.query = async () => ({ items: [], cursor: "more" });
    let forwards = 0;
    const egress: ModelEgress = { capabilities: { schemes: [] }, forward() { forwards++; throw new Error("must not forward"); } };
    const report = await checkReplySetAgainstReal({ set, probes: w.service.source(COMPANY_A.scope, query), egress, scope: scope(COMPANY_A.orgId), today: "2026-11-13" });
    expect(report).toMatchObject({ status: "not_checked", label: "not checked: store unavailable", items: [], spend: { attempted: 0 } });
    expect(forwards).toBe(0);
  });
});


describe("company deletion fence cleanup", () => {
  it("removes many person fences over bounded retries and leaves only the company fence", async () => {
    const w = world();
    for (let i = 0; i < 22; i++) expect(await w.service.erasePerson(COMPANY_A.scope, `person-${String(i)}`)).toEqual({ ok: true, deleted: 0 });
    const queryPage = w.store.query.bind(w.store); w.store.query = (request) => queryPage({ ...request, limit: 1 });
    expect(await w.service.deleteCompany(COMPANY_A.scope)).toEqual({ ok: false, word: "not_allowed" });
    expect(await w.service.deleteCompany(COMPANY_A.scope)).toEqual({ ok: true, deleted: 0 });
    expect((await queryPage({ pk: `ORG#${COMPANY_A.orgId}#MODEL_PROBE_REQUEST` })).items).toEqual([{ pk: `ORG#${COMPANY_A.orgId}#MODEL_PROBE_REQUEST`, sk: "ERASED#company", erased: true }]);
  });
  it("refuses a cleanup page from another company without deleting its fence", async () => {
    const w = world(); await w.service.erasePerson(COMPANY_B.scope, "person-p");
    const queryPage = w.store.query.bind(w.store);
    const foreign = (await queryPage({ pk: `ORG#${COMPANY_B.orgId}#MODEL_PROBE_REQUEST` })).items;
    w.store.query = async (request) => request.sk?.op === "beginsWith" && request.sk.prefix === "ERASED#person#" ? { items: foreign } : queryPage(request);
    expect(await w.service.deleteCompany(COMPANY_A.scope)).toEqual({ ok: false, word: "not_allowed" });
    expect((await queryPage({ pk: `ORG#${COMPANY_B.orgId}#MODEL_PROBE_REQUEST` })).items).toEqual(foreign);
  });
});
