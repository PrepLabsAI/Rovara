// Test services: the fixture store (org-scoped, behind tx, reviewed before it is delivered), its review card and its 15-minute delivery.
import { describe, expect, it } from "vitest";
import { FixtureSetSchema, canonicalJson, fixtureEntry, fixtureSetDigest, type FixtureSet, type TestEnvProdDeny } from "@agentx/contracts";
import { projectDecisionCards } from "../../packages/broker/src/core/decisions/project.js";
import {
  FIXTURE_READ_URL_SECONDS, FIXTURE_TEXT_MAX_DEPTH, createFixtureStore, fixtureSetFindings, fixtureTexts, verifiedFixtureDecision, createMemoryFixturePorts, fixtureObjectKey, fixtureSetCardItem, fixtureStoreId, parseFixtureStoreId,
  type FixtureRecord, type FixtureStore, type FixtureStoreDependencies,
} from "../../packages/broker/src/core/test-env/fixture-store.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const PROJ = "web";
const DENY: TestEnvProdDeny = { accountIds: ["111122223333"], hosts: ["*.prod.example.com"], arnPrefixes: [] };
const NOW = new Date("2026-11-02T12:00:00.000Z");
const dependency = { id: "payments-api", family: "http:api.example-pay.com", protocol: "http_json", target: "api.example-pay.com" } as const;
const match = { ignorePaths: ["/requestedAt"], query: ["customer"] };
const json = "application/json";
const charge = (amount: number) => ({ method: "POST" as const, path: "/v1/charges", query: [{ name: "customer", value: "c1" }], contentType: json, body: JSON.stringify({ amount, requestedAt: "2026-11-02T00:00:00Z" }) });
const answer = (body: unknown, status = 200) => ({ status, headers: [{ name: "etag" as const, value: "abc" }], contentType: json, body: JSON.stringify(body), latencyMs: 0 });
function makeSet(over: Record<string, unknown> = {}): FixtureSet {
  const shell = { dependency, match };
  return FixtureSetSchema.parse({
    schemaVersion: 2, dependency, origin: "recorded", revision: 2, recordedAt: "2026-11-01T00:00:00.000Z", syntheticOnly: true, match,
    requestSchema: { type: "object", required: ["amount"], properties: { amount: { type: "integer" } } }, responseSchema: { type: "object", properties: { ok: { type: "boolean" }, id: { type: "string" } } },
    entries: [1, 2, 3, 4].map((n) => fixtureEntry(shell, charge(n), answer({ ok: true, id: `ch_${String(n)}` }))),
    faults: [{ name: "busy", kind: "throttle", status: 429, delayMs: 0 }],
    ...over,
  });
}

/** A maintainer's decision, for one action on one digest, in the org of the session; `fresh` is a sign-in a minute ago, `stale` one eleven minutes ago, `synth` the environment's schema_synth backing. */
const by = (action: "approve" | "reject" | "withdraw", orgId: string, digest: string, actor: string, over: { fresh?: boolean; stale?: boolean; synth?: boolean; role?: string } = {}) => {
  const signedInAt = over.fresh === true ? new Date(NOW.getTime() - 60_000) : over.stale === true ? new Date(NOW.getTime() - 11 * 60_000) : undefined;
  const decision = verifiedFixtureDecision({ orgId, project: PROJ, actor, role: over.role ?? "maintainer", action, digest, signedInAt, schemaSynth: over.synth ?? false });
  if (decision === undefined) throw new Error("not a maintainer");
  return decision;
};
function setup(over: Partial<FixtureStoreDependencies> = {}, enabled = true) {
  const ports = createMemoryFixturePorts();
  const touched: string[] = [];
  const objects: FixtureStoreDependencies["objects"] = {
    putIfAbsent: (...args) => { touched.push("put"); return ports.objects.putIfAbsent(...args); },
    replaceIfUnchanged: (...args) => { touched.push("replace"); return ports.objects.replaceIfUnchanged(...args); },
    get: (...args) => { touched.push("get"); return ports.objects.get(...args); },
    presignGet: (...args) => { touched.push("presign"); return ports.objects.presignGet(...args); },
  };
  const index: FixtureStoreDependencies["index"] = {
    get: (...args) => { touched.push("index.get"); return ports.index.get(...args); },
    putIfAbsent: (...args) => { touched.push("index.put"); return ports.index.putIfAbsent(...args); },
    replace: (...args) => { touched.push("index.replace"); return ports.index.replace(...args); },
    listByDependency: (...args) => { touched.push("index.list"); return ports.index.listByDependency(...args); },
  };
  let on = enabled;
  const store = createFixtureStore({ enabled: () => on, objects, index, denyFor: () => Promise.resolve(DENY), now: () => NOW, ...over });
  return { store, ports, touched, setEnabled: (value: boolean) => { on = value; } };
}
const submitOk = async (store: FixtureStore, set = makeSet(), org = ORG_A, recordedFrom: "synthetic" | "test_account" | "written" = "synthetic") => {
  const outcome = await store.submit(org, PROJ, set, { actor: "maya", recordedFrom });
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.record;
};

describe("behind the tx switch", () => {
  it("answers `disabled` to every call with the switch off, and touches neither the object store nor the index", async () => {
    const { store, touched } = setup({}, false);
    const set = makeSet();
    const digest = fixtureSetDigest(set);
    expect(await store.submit(ORG_A, PROJ, set, { actor: "maya", recordedFrom: "synthetic" })).toEqual({ ok: false, reason: "disabled" });
    expect(await store.record(ORG_A, PROJ, digest)).toEqual({ ok: false, reason: "disabled" });
    expect(await store.review(ORG_A, PROJ, digest)).toEqual({ ok: false, reason: "disabled" });
    expect(await store.approve(ORG_A, PROJ, digest, by("approve", ORG_A, digest, "maya"))).toEqual({ ok: false, reason: "disabled" });
    expect(await store.reject(ORG_A, PROJ, digest, by("reject", ORG_A, digest, "maya"))).toEqual({ ok: false, reason: "disabled" });
    expect(await store.deliver(ORG_A, PROJ, digest)).toEqual({ ok: false, reason: "disabled" });
    expect(await store.deliverById(ORG_A, PROJ, fixtureStoreId(ORG_A, PROJ, digest))).toEqual({ ok: false, reason: "disabled" });
    expect(await store.readApproved(ORG_A, PROJ, digest)).toEqual({ ok: false, reason: "disabled" });
    expect(touched).toEqual([]);
  });
  it("reads the switch on every call: turning it off again stops delivery of a set that was approved", async () => {
    const { store, setEnabled } = setup();
    const record = await submitOk(store);
    await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"));
    expect((await store.deliver(ORG_A, PROJ, record.digest)).ok).toBe(true);
    setEnabled(false);
    expect(await store.deliver(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("store ids and keys are org-scoped", () => {
  it("names a set by its org and digest, and keeps one object per org", async () => {
    const { store, ports } = setup();
    const a = await submitOk(store, makeSet(), ORG_A);
    const b = await submitOk(store, makeSet(), ORG_B);
    expect(a.digest).toBe(b.digest);
    expect(a.storeId).toBe(`fxs:${ORG_A}:${PROJ}:${a.digest}`);
    expect(b.storeId).not.toBe(a.storeId);
    expect([...ports.objects.dump().keys()].sort()).toEqual([`private/${ORG_A}/fixtures/${PROJ}/${a.digest}`, `private/${ORG_B}/fixtures/${PROJ}/${a.digest}`]);
    expect(fixtureObjectKey(ORG_A, PROJ, a.digest)).toBe(`private/${ORG_A}/fixtures/${PROJ}/${a.digest}`);
    expect(parseFixtureStoreId(a.storeId)).toEqual({ orgId: ORG_A, project: PROJ, digest: a.digest });
    for (const bad of ["", "fxs:org_x:" + a.digest, `fxs:${ORG_A}:${a.digest.slice(1)}`, `fxs:${ORG_A}:${a.digest}/../x`, `${ORG_A}:${a.digest}`]) expect(parseFixtureStoreId(bad)).toBeUndefined();
  });
  it("refuses an org id that is not an org id (no path can be built from it)", async () => {
    const { store, touched } = setup();
    for (const org of ["", "org_x", "../org_aaaaaaaaaaaaaaaaaaaa", `${ORG_A}/../${ORG_B}`, ORG_A.toUpperCase()]) {
      expect(await store.submit(org, PROJ, makeSet(), { actor: "maya", recordedFrom: "synthetic" })).toEqual({ ok: false, reason: "bad_org" });
    }
    expect(touched).toEqual([]);
  });
  it("is the same upload twice, once: the second submit finds the first", async () => {
    const { store, ports } = setup();
    const first = await store.submit(ORG_A, PROJ, makeSet(), { actor: "maya", recordedFrom: "synthetic" });
    const second = await store.submit(ORG_A, PROJ, makeSet(), { actor: "other", recordedFrom: "synthetic" });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    expect(ports.objects.dump().size).toBe(1);
  });
});

describe("cross-org reads are refused", () => {
  it("answers another org's digest, another org's store id and a digest nobody holds with the same `not_found`", async () => {
    const { store, touched } = setup();
    const record = await submitOk(store, makeSet(), ORG_A);
    await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"));
    const nobody = "f".repeat(64);
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["record", () => store.record(ORG_B, PROJ, record.digest)], ["review", () => store.review(ORG_B, PROJ, record.digest)], ["approve", () => store.approve(ORG_B, PROJ, record.digest, by("approve", ORG_B, record.digest, "x"))], ["reject", () => store.reject(ORG_B, PROJ, record.digest, by("reject", ORG_B, record.digest, "x"))],
      ["deliver", () => store.deliver(ORG_B, PROJ, record.digest)], ["readApproved", () => store.readApproved(ORG_B, PROJ, record.digest)],
      ["deliverById", () => store.deliverById(ORG_B, PROJ, fixtureStoreId(ORG_A, PROJ, record.digest))],
    ];
    touched.length = 0;
    for (const [, call] of calls) expect(await call()).toEqual({ ok: false, reason: "not_found" });
    expect(await store.deliver(ORG_B, PROJ, nobody)).toEqual({ ok: false, reason: "not_found" });
    expect(await store.deliverById(ORG_B, PROJ, fixtureStoreId(ORG_B, PROJ, nobody))).toEqual({ ok: false, reason: "not_found" });
    // No signed address was ever made for the other org's object, and the other org's set is still pending-free: it can still be delivered to its own org.
    expect(touched).not.toContain("presign");
    expect((await store.deliver(ORG_A, PROJ, record.digest)).ok).toBe(true);
    expect((await store.record(ORG_A, PROJ, record.digest))).toMatchObject({ ok: true, record: { status: "approved", decidedBy: "lead" } });
  });
  it("answers a store id that names another org as not found even when the caller's org holds the same digest", async () => {
    const { store, touched } = setup();
    const a = await submitOk(store, makeSet(), ORG_A);
    const b = await submitOk(store, makeSet(), ORG_B);
    await store.approve(ORG_A, PROJ, a.digest, by("approve", ORG_A, a.digest, "lead"));
    await store.approve(ORG_B, PROJ, b.digest, by("approve", ORG_B, b.digest, "lead"));
    touched.length = 0;
    expect(await store.deliverById(ORG_B, PROJ, fixtureStoreId(ORG_A, PROJ, a.digest))).toEqual({ ok: false, reason: "not_found" });
    expect(touched).not.toContain("presign");
    expect((await store.deliverById(ORG_B, PROJ, b.storeId)).ok).toBe(true);
  });
  it("signs only the caller's own key", async () => {
    const seen: string[] = [];
    const { store } = setup({}, true);
    const ports = createMemoryFixturePorts({ signUrl: (key) => { seen.push(key); return `https://fixtures.invalid/${key}`; } });
    const own = createFixtureStore({ enabled: () => true, objects: ports.objects, index: ports.index, denyFor: () => Promise.resolve(DENY), now: () => NOW });
    const record = await submitOk(own, makeSet(), ORG_A);
    await own.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"));
    await own.deliver(ORG_A, PROJ, record.digest);
    expect(seen).toEqual([`private/${ORG_A}/fixtures/${PROJ}/${record.digest}`]);
    void store;
  });
  it("does not trust an index row that names another org", async () => {
    const ports = createMemoryFixturePorts();
    const lying: FixtureStoreDependencies["index"] = { ...ports.index, get: async (org, project, digest) => { const row = await ports.index.get(org, project, digest); return row === undefined ? undefined : { ...row, orgId: ORG_B }; } };
    const store = createFixtureStore({ enabled: () => true, objects: ports.objects, index: lying, denyFor: () => Promise.resolve(DENY), now: () => NOW });
    const record = await submitOk(store, makeSet(), ORG_A);
    expect(await store.record(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "not_found" });
    expect(await store.deliver(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("a submitted set", () => {
  it("is parsed as FixtureSet v2, scanned, and stored pending under its digest with its counts", async () => {
    const { store, ports } = setup();
    const set = makeSet();
    const record = await submitOk(store, set);
    expect(record).toMatchObject({ orgId: ORG_A, digest: fixtureSetDigest(set), dependencyId: "payments-api", entries: 4, faults: 1, origin: "recorded", recordedFrom: "synthetic", status: "pending", scanClean: true, submittedBy: "maya", version: 1 });
    const stored = ports.objects.dump().get(fixtureObjectKey(ORG_A, PROJ, record.digest))!;
    expect(new TextDecoder().decode(stored)).toBe(canonicalJson(set));
  });
  it("is refused when it is not a v2 set, an entry sits under the wrong hash, or it is too big, and nothing is stored", async () => {
    const { store, ports } = setup();
    const set = makeSet();
    expect(await store.submit(ORG_A, PROJ, { ...set, schemaVersion: 1 }, { actor: "m", recordedFrom: "synthetic" })).toEqual({ ok: false, reason: "invalid" });
    expect(await store.submit(ORG_A, PROJ, { ...set, entries: [{ ...set.entries[0]!, requestHash: "a".repeat(64) }] }, { actor: "m", recordedFrom: "synthetic" })).toEqual({ ok: false, reason: "invalid" });
    expect(await store.submit(ORG_A, PROJ, "nonsense", { actor: "m", recordedFrom: "synthetic" })).toEqual({ ok: false, reason: "invalid" });
    const shell = { dependency, match };
    const big = Array.from({ length: 70 }, (_, n) => fixtureEntry(shell, { ...charge(n + 100), body: JSON.stringify({ amount: n + 100, pad: "x".repeat(60_000) }) }, answer({ ok: true, pad: "y".repeat(60_000) })));
    const huge = await store.submit(ORG_A, PROJ, { ...set, entries: big }, { actor: "m", recordedFrom: "synthetic" });
    expect(huge.ok).toBe(false);
    expect(ports.objects.dump().size).toBe(0);
  });
  it.each([
    ["an email address", () => answer({ contact: "jane.roe@acme-corp.com" })],
    ["a production host", () => answer({ callback: "https://a.prod.example.com/x" })],
    ["a credential", () => answer({ debug: `key ${"AKIA"}${"ABCDEFGHIJKLMNOP"}` })],
  ])("stops a set whose answers hold %s, stores nothing, and says only that the guard stopped it", async (_label, make) => {
    const { store, ports } = setup();
    const shell = { dependency, match };
    const dirty = makeSet({ entries: [fixtureEntry(shell, charge(1), make())] });
    const outcome = await store.submit(ORG_A, PROJ, dirty, { actor: "maya", recordedFrom: "synthetic" });
    expect(outcome).toEqual({ ok: false, reason: "data_guard" });
    expect(ports.objects.dump().size).toBe(0);
  });
  it("is scanned in its request, its path and its header values too, with the org's own deny list", async () => {
    const shell = { dependency, match };
    const { store } = setup({ denyFor: (org) => Promise.resolve(org === ORG_B ? { accountIds: [], hosts: ["api.example-pay.com"], arnPrefixes: [] } : DENY) });
    const dirtyRequest = makeSet({ entries: [fixtureEntry(shell, { ...charge(1), body: JSON.stringify({ amount: 1, mail: "jane.roe@acme-corp.com" }) }, answer({ ok: true }))] });
    expect(await store.submit(ORG_A, PROJ, dirtyRequest, { actor: "m", recordedFrom: "synthetic" })).toEqual({ ok: false, reason: "data_guard" });
    // The same clean-looking set names a host that is production for org B only.
    const body = makeSet({ entries: [fixtureEntry(shell, charge(1), answer({ link: "https://api.example-pay.com/receipt" }))] });
    expect((await store.submit(ORG_A, PROJ, body, { actor: "m", recordedFrom: "synthetic" })).ok).toBe(true);
    expect(await store.submit(ORG_B, PROJ, body, { actor: "m", recordedFrom: "synthetic" })).toEqual({ ok: false, reason: "data_guard" });
  });
  it("fails closed when the deny list cannot be read", async () => {
    const { store, ports } = setup({ denyFor: () => Promise.reject(new Error("unavailable")) });
    await expect(store.submit(ORG_A, PROJ, makeSet(), { actor: "m", recordedFrom: "synthetic" })).rejects.toThrow();
    expect(ports.objects.dump().size).toBe(0);
  });
});

describe("the review", () => {
  it("shows counts, the schema, three redacted sample pairs, the scan result, the ignored paths and the faults", async () => {
    const { store } = setup();
    const set = makeSet();
    const record = await submitOk(store, set);
    const reviewed = await store.review(ORG_A, PROJ, record.digest);
    if (!reviewed.ok) throw new Error(reviewed.reason);
    const { review } = reviewed;
    expect(review).toMatchObject({
      storeId: record.storeId, digest: record.digest, origin: "recorded", revision: 2, recordedFrom: "synthetic",
      counts: { entries: 4, faults: 1 }, scan: { clean: true }, ignorePaths: ["/requestedAt"], faults: [{ name: "busy", kind: "throttle", status: 429, delayMs: 0 }],
      schema: { request: ["type object", "fields amount"], response: ["type object", "fields id, ok"] },
    });
    expect(review.samples).toHaveLength(3);
    expect(review.samples[0]).toMatchObject({ method: "POST", path: "/v1/charges", query: "customer=c1", status: 200 });
  });
  it("cuts a long body and flattens control characters, so a recorded answer cannot fill or steer the page", async () => {
    const shell = { dependency, match };
    const long = makeSet({ entries: [fixtureEntry(shell, charge(1), { ...answer({ ok: true }), body: JSON.stringify({ note: `line one\nline two ${"z".repeat(2_000)}` }) })] });
    const { store } = setup();
    const record = await submitOk(store, long);
    const reviewed = await store.review(ORG_A, PROJ, record.digest);
    if (!reviewed.ok) throw new Error(reviewed.reason);
    const body = reviewed.review.samples[0]!.responseBody;
    expect(body.length).toBeLessThanOrEqual(300);
    expect(body).not.toMatch(/[\r\n]/u);
  });
  it("refuses to review a stored object that is no longer the set its digest names", async () => {
    const { store, ports } = setup();
    const record = await submitOk(store);
    const key = fixtureObjectKey(ORG_A, PROJ, record.digest);
    const swapped = makeSet({ revision: 9 });
    ports.objects.dump().set(key, new TextEncoder().encode(canonicalJson(swapped)));
    expect(await store.review(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "digest_mismatch" });
  });
});

describe("approving and delivering", () => {
  it("delivers only an approved set, with a 15-minute signed read of that one key and the digest to check", async () => {
    const { store } = setup();
    const record = await submitOk(store);
    expect(await store.deliver(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "not_approved" });
    expect(await store.readApproved(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "not_approved" });
    const approved = await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"));
    expect(approved).toMatchObject({ ok: true, record: { status: "approved", decidedBy: "lead", decidedAt: NOW.toISOString(), version: 2 } });
    const delivery = await store.deliver(ORG_A, PROJ, record.digest);
    if (!delivery.ok) throw new Error(delivery.reason);
    expect(FIXTURE_READ_URL_SECONDS).toBe(900);
    expect(delivery.url).toBe(`https://fixtures.invalid/private/${ORG_A}/fixtures/${PROJ}/${record.digest}?expires=900`);
    expect(delivery).toMatchObject({ digest: record.digest, storeId: record.storeId, expiresAt: "2026-11-02T12:15:00.000Z" });
    expect(await store.deliverById(ORG_A, PROJ, record.storeId)).toEqual(delivery);
    const read = await store.readApproved(ORG_A, PROJ, record.digest);
    expect(read.ok && fixtureSetDigest(read.set)).toBe(record.digest);
  });
  it("does not deliver a rejected set, and a decision is made once", async () => {
    const { store } = setup();
    const record = await submitOk(store);
    expect(await store.reject(ORG_A, PROJ, record.digest, by("reject", ORG_A, record.digest, "lead"))).toMatchObject({ ok: true, record: { status: "rejected" } });
    expect(await store.deliver(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "not_approved" });
    expect(await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"))).toEqual({ ok: false, reason: "already_decided" });
    expect(await store.reject(ORG_A, PROJ, record.digest, by("reject", ORG_A, record.digest, "lead"))).toEqual({ ok: false, reason: "already_decided" });
  });
  it("loses a race cleanly: two approvals at once, one wins", async () => {
    const { store } = setup();
    const record = await submitOk(store);
    const [first, second] = await Promise.all([store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "a")), store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "b"))]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
  });
  it("hands out nothing for an object that no longer hashes to its digest, and does not approve it either", async () => {
    const { store, ports, touched } = setup();
    const pending = await submitOk(store, makeSet({ revision: 3 }));
    const record = await submitOk(store);
    await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"));
    const key = fixtureObjectKey(ORG_A, PROJ, record.digest);
    ports.objects.dump().set(key, new TextEncoder().encode(canonicalJson(makeSet({ revision: 9 }))));
    touched.length = 0;
    expect(await store.deliver(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "digest_mismatch" });
    expect(await store.readApproved(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "digest_mismatch" });
    expect(touched).not.toContain("presign");
    ports.objects.dump().set(fixtureObjectKey(ORG_A, PROJ, pending.digest), new TextEncoder().encode("not even json"));
    expect(await store.approve(ORG_A, PROJ, pending.digest, by("approve", ORG_A, pending.digest, "lead"))).toEqual({ ok: false, reason: "digest_mismatch" });
    // Truncated bytes that still parse as JSON are no better.
    ports.objects.dump().set(key, new TextEncoder().encode(canonicalJson(makeSet()) + " "));
    expect(await store.deliver(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "digest_mismatch" });
  });
  it("answers a digest that is not 64 hex characters before it asks the index anything", async () => {
    const { store, touched } = setup();
    for (const digest of ["", "abc", "G".repeat(64), "a".repeat(63), `${"a".repeat(64)}x`, "../x"]) expect(await store.deliver(ORG_A, PROJ, digest)).toEqual({ ok: false, reason: "bad_digest" });
    expect(touched).toEqual([]);
  });
});

describe("the review card (approve_fixture_set)", () => {
  const cardFor = async (store: FixtureStore, record: Awaited<ReturnType<typeof submitOk>>, schemaSynth = false) => {
    const reviewed = await store.review(ORG_A, PROJ, record.digest);
    if (!reviewed.ok) throw new Error(reviewed.reason);
    const item = fixtureSetCardItem({ record: reviewed.record, review: reviewed.review, project: "Orders", openPath: `/v1/app/environment/fixtures/${record.digest.slice(0, 16)}`, schemaSynth });
    return { item, projection: projectDecisionCards([item]) };
  };
  it("is a medium card with Approve (evidence first) for a recording from synthetic inputs, bound to the digest", async () => {
    const { store } = setup();
    const record = await submitOk(store);
    const { projection } = await cardFor(store, record);
    const [card] = projection.cards;
    expect(card).toMatchObject({ kind: "approve_fixture_set", id: `approve_fixture_set:${record.digest.slice(0, 40)}`, risk: "medium", status: "pending", friction: { expandEvidenceFirst: true, freshSignIn: false } });
    expect(card!.actions.map((action) => action.kind)).toEqual(["approve", "reject", "open"]);
    expect(card!.evidence.map((chip) => `${chip.label}: ${chip.value}`)).toEqual(["Answers: 4 answers", "Faults: 1 named fault", "Personal-data scan: clean"]);
    const detail = projection.details[card!.id]!.map((group) => group.title);
    expect(detail).toEqual(expect.arrayContaining(["Sample answers (cut, from the recording)", "Schema", "Ignored when matching a request", "Named faults", "Where it came from"]));
    expect(projection.details[card!.id]!.find((group) => group.title.startsWith("Sample"))!.lines).toHaveLength(9);
    expect(projection.digests[card!.id]).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("is high, with no Approve action, when unrecorded requests are answered from the schema", async () => {
    const { store } = setup();
    const record = await submitOk(store);
    const { projection } = await cardFor(store, record, true);
    const [card] = projection.cards;
    expect(card).toMatchObject({ risk: "high", friction: { freshSignIn: true } });
    expect(card!.actions.map((action) => action.kind)).toEqual(["open"]);
    expect(card!.riskReasons).toContain("Requests with no recording are answered from the schema.");
  });
  it("is high for the first recording made with a test account, and medium again once one is approved", async () => {
    const { store } = setup();
    const first = await submitOk(store, makeSet({ revision: 1 }), ORG_A, "test_account");
    expect(first.firstFromTestAccount).toBe(true);
    expect((await cardFor(store, first)).projection.cards[0]).toMatchObject({ risk: "high" });
    // Another org's approved test-account recording does not count; this org's own does.
    const other = await submitOk(store, makeSet({ revision: 5 }), ORG_B, "test_account");
    await store.approve(ORG_B, PROJ, other.digest, by("approve", ORG_B, other.digest, "lead", { fresh: true }));
    expect((await submitOk(store, makeSet({ revision: 6 }), ORG_A, "test_account")).firstFromTestAccount).toBe(true);
    // The first one is high: it is approved only with a fresh sign-in.
    expect(await store.approve(ORG_A, PROJ, first.digest, by("approve", ORG_A, first.digest, "lead"))).toEqual({ ok: false, reason: "fresh_sign_in_required" });
    expect((await store.approve(ORG_A, PROJ, first.digest, by("approve", ORG_A, first.digest, "lead", { fresh: true }))).ok).toBe(true);
    const second = await submitOk(store, makeSet({ revision: 7 }), ORG_A, "test_account");
    expect(second.firstFromTestAccount).toBe(false);
    expect((await cardFor(store, second)).projection.cards[0]).toMatchObject({ risk: "medium" });
  });
  it("shows an approved set as answered, with no actions", async () => {
    const { store } = setup();
    const record = await submitOk(store);
    await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"));
    const decided = (await store.record(ORG_A, PROJ, record.digest));
    if (!decided.ok) throw new Error("missing");
    const reviewed = await store.review(ORG_A, PROJ, record.digest);
    if (!reviewed.ok) throw new Error("missing");
    const item = fixtureSetCardItem({ record: decided.record, review: reviewed.review, project: "Orders", openPath: "/v1/app/environment/fixtures/x1", schemaSynth: false });
    expect(projectDecisionCards([item]).cards[0]).toMatchObject({ status: "approved", actions: [] });
  });
});

describe("the scan sees keys and numbers, not only strings (M1)", () => {
  const shell = { dependency, match };
  const card = ["4111", "1111", "1111", "1111"].join("");
  const akia = `${"AK"}${"IA"}${"ABCDEFGHIJKLMNOP"}`;
  const schemaWith = (properties: Record<string, unknown>) => ({ type: "object", properties });
  const dirtyCases: Array<[string, () => FixtureSet]> = [
    ["an email address as a property name", () => makeSet({ responseSchema: schemaWith({ "jane.roe@acme-corp.com": { type: "string" } }) })],
    ["an AKIA-shaped key as a property name", () => makeSet({ responseSchema: schemaWith({ [akia]: { type: "string" } }) })],
    ["a production host as a property name", () => makeSet({ responseSchema: schemaWith({ "a.prod.example.com": { type: "string" } }) })],
    ["a card number as a numeric enum value", () => makeSet({ responseSchema: schemaWith({ pan: { type: "number", enum: [Number(card)] } }) })],
    ["a card number as a minimum", () => makeSet({ responseSchema: schemaWith({ pan: { type: "number", minimum: Number(card) } }) })],
    ["a card number as a maximum", () => makeSet({ requestSchema: schemaWith({ pan: { type: "number", maximum: Number(card) } }) })],
    ["an email address in an answer", () => makeSet({ entries: [fixtureEntry(shell, charge(1), answer({ contact: "jane.roe@acme-corp.com" }))] })],
    ["an AKIA-shaped key in an answer", () => makeSet({ entries: [fixtureEntry(shell, charge(1), answer({ debug: akia }))] })],
    ["a production host in an answer", () => makeSet({ entries: [fixtureEntry(shell, charge(1), answer({ callback: "https://a.prod.example.com/x" }))] })],
  ];
  it.each(dirtyCases)("refuses at submit, and stores nothing: %s", async (_label, make) => {
    const { store, ports } = setup();
    expect(await store.submit(ORG_A, PROJ, make(), { actor: "maya", recordedFrom: "synthetic" })).toEqual({ ok: false, reason: "data_guard" });
    expect(ports.objects.dump().size).toBe(0);
  });
  it("lists the findings in a bare walker: keys and numbers are texts, a digest and a timestamp are not", () => {
    expect(fixtureTexts({ [akia]: 5, nested: [{ "x@y.com": Number(card) }], hash: "a".repeat(64), at: "2026-11-02T00:00:00Z" })).toEqual([akia, "5", "nested", "x@y.com", "4111111111111111", "hash", "at"]);
    expect(fixtureSetFindings({ minimum: Number(card) }, DENY)).not.toEqual([]);
    expect(fixtureSetFindings({ minimum: 200 }, DENY)).toEqual([]);
  });
});

describe("the scan runs again, with today's deny list, at approve and at deliver (L2)", () => {
  const listed = (hosts: string[]) => ({ accountIds: [], hosts, arnPrefixes: [] });
  it("refuses to approve a set that names a host added to the deny list after it was stored", async () => {
    let deny: TestEnvProdDeny = listed([]);
    const { store } = setup({ denyFor: () => Promise.resolve(deny) });
    const shell = { dependency, match };
    const record = await submitOk(store, makeSet({ entries: [fixtureEntry(shell, charge(1), answer({ link: "https://api.example-pay.com/receipt" }))] }));
    deny = listed(["api.example-pay.com"]);
    expect(await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"))).toEqual({ ok: false, reason: "data_guard" });
    expect((await store.record(ORG_A, PROJ, record.digest) as { record: FixtureRecord }).record.status).toBe("pending");
  });
  it("stops delivering (and reading) an approved set once the list names something in it", async () => {
    let deny: TestEnvProdDeny = listed([]);
    const { store, touched } = setup({ denyFor: () => Promise.resolve(deny) });
    const shell = { dependency, match };
    const record = await submitOk(store, makeSet({ entries: [fixtureEntry(shell, charge(1), answer({ link: "https://api.example-pay.com/receipt" }))] }));
    await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"));
    expect((await store.deliver(ORG_A, PROJ, record.digest)).ok).toBe(true);
    deny = listed(["api.example-pay.com"]);
    touched.length = 0;
    expect(await store.deliver(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "data_guard" });
    expect(await store.deliverById(ORG_A, PROJ, record.storeId)).toEqual({ ok: false, reason: "data_guard" });
    expect(await store.readApproved(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "data_guard" });
    expect(touched).not.toContain("presign");
  });
  it("withdraws an approved set: it is no longer delivered or read, and stays withdrawn", async () => {
    const { store, touched } = setup();
    const record = await submitOk(store);
    expect(await store.withdraw(ORG_A, PROJ, record.digest, by("withdraw", ORG_A, record.digest, "lead"))).toEqual({ ok: false, reason: "not_approved" });
    await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"));
    const withdrawn = await store.withdraw(ORG_A, PROJ, record.digest, by("withdraw", ORG_A, record.digest, "boss"));
    expect(withdrawn).toMatchObject({ ok: true, record: { status: "withdrawn", withdrawnBy: "boss", withdrawnAt: NOW.toISOString() } });
    touched.length = 0;
    expect(await store.deliver(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "not_approved" });
    expect(await store.readApproved(ORG_A, PROJ, record.digest)).toEqual({ ok: false, reason: "not_approved" });
    expect(touched).not.toContain("presign");
    expect(await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"))).toEqual({ ok: false, reason: "already_decided" });
    expect(await store.withdraw(ORG_A, PROJ, record.digest, by("withdraw", ORG_A, record.digest, "lead"))).toEqual({ ok: false, reason: "not_approved" });
    // Submitting the same bytes again does not bring it back.
    expect(await store.submit(ORG_A, PROJ, makeSet(), { actor: "m", recordedFrom: "synthetic" })).toMatchObject({ ok: true, created: false, record: { status: "withdrawn" } });
    expect((await store.deliver(ORG_A, PROJ, record.digest)).ok).toBe(false);
  });
  it("does not withdraw another org's set", async () => {
    const { store } = setup();
    const record = await submitOk(store);
    await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"));
    expect(await store.withdraw(ORG_B, PROJ, record.digest, by("withdraw", ORG_B, record.digest, "lead"))).toEqual({ ok: false, reason: "not_found" });
    expect((await store.deliver(ORG_A, PROJ, record.digest)).ok).toBe(true);
  });
});

describe("a decision is a verified object, not a name (L1, N1, N2)", () => {
  it("refuses a bare string, a hand-written object, a spread copy, a copied symbol, a structured clone and a decision for another org", async () => {
    const { store } = setup();
    const record = await submitOk(store);
    const d = record.digest;
    const real = by("approve", ORG_A, d, "lead");
    const handWritten = { orgId: ORG_A, actor: "lead", action: "approve", digest: d, signedInAt: NOW, schemaSynth: false };
    // A copy that carries every own symbol of the real one, and one that sets the sign-in time too.
    const symbolCopy = Object.freeze(Object.defineProperties({ ...real }, Object.fromEntries(Object.getOwnPropertySymbols(real).map((sym) => [sym, { value: true, enumerable: true }]))));
    const spreadEdited = Object.freeze({ ...real, signedInAt: NOW });
    const cloned = structuredClone({ ...real });
    for (const decision of ["lead", handWritten, { ...real }, spreadEdited, symbolCopy, cloned, Object.create(real) as object, null, undefined]) {
      expect(await store.approve(ORG_A, PROJ, d, decision as never)).toEqual({ ok: false, reason: "unauthorised" });
    }
    expect(await store.approve(ORG_A, PROJ, d, by("approve", ORG_B, d, "lead"))).toEqual({ ok: false, reason: "unauthorised" });
    // The real one was not used up by those: it still works once.
    expect((await store.approve(ORG_A, PROJ, d, real)).ok).toBe(true);
    expect((await store.record(ORG_A, PROJ, d) as { record: FixtureRecord }).record.status).toBe("approved");
  });
  it("is for one action: a decision to approve does not reject or withdraw", async () => {
    const { store } = setup();
    const record = await submitOk(store);
    const d = record.digest;
    const approving = by("approve", ORG_A, d, "lead");
    expect(await store.reject(ORG_A, PROJ, d, approving)).toEqual({ ok: false, reason: "unauthorised" });
    expect(await store.withdraw(ORG_A, PROJ, d, approving)).toEqual({ ok: false, reason: "unauthorised" });
    expect((await store.approve(ORG_A, PROJ, d, approving)).ok).toBe(true);
  });
  it("is for one set: a decision for one digest does not decide another", async () => {
    const { store } = setup();
    const first = await submitOk(store, makeSet({ revision: 11 }));
    const second = await submitOk(store, makeSet({ revision: 12 }));
    const forFirst = by("approve", ORG_A, first.digest, "lead");
    expect(await store.approve(ORG_A, PROJ, second.digest, forFirst)).toEqual({ ok: false, reason: "unauthorised" });
    expect((await store.record(ORG_A, PROJ, second.digest) as { record: FixtureRecord }).record.status).toBe("pending");
    expect((await store.approve(ORG_A, PROJ, first.digest, forFirst)).ok).toBe(true);
  });
  it("is single-use: the second use of the same decision is refused, also when the first one ran at the same moment", async () => {
    const { store } = setup();
    const record = await submitOk(store);
    const d = record.digest;
    const once = by("reject", ORG_A, d, "lead");
    expect((await store.reject(ORG_A, PROJ, d, once)).ok).toBe(true);
    expect(await store.reject(ORG_A, PROJ, d, once)).toEqual({ ok: false, reason: "unauthorised" });
    const other = await submitOk(store, makeSet({ revision: 13 }));
    const both = by("approve", ORG_A, other.digest, "lead");
    const results = await Promise.all([store.approve(ORG_A, PROJ, other.digest, both), store.approve(ORG_A, PROJ, other.digest, both)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === "unauthorised")).toHaveLength(1);
  });
  it("mints a decision only for a maintainer of a real org with a named actor, a known action and a digest", () => {
    const base = { orgId: ORG_A, project: PROJ, actor: "lead", action: "approve" as const, digest: "a".repeat(64), signedInAt: undefined, schemaSynth: false };
    expect(verifiedFixtureDecision({ ...base, role: "maintainer" })).toBeDefined();
    for (const role of ["member", "viewer", "owner", "", "Maintainer"]) expect(verifiedFixtureDecision({ ...base, role })).toBeUndefined();
    expect(verifiedFixtureDecision({ ...base, role: "maintainer", orgId: "org_x" })).toBeUndefined();
    for (const project of ["", "Web", "../api", "a/b"]) expect(verifiedFixtureDecision({ ...base, role: "maintainer", project }), project).toBeUndefined();
    expect(verifiedFixtureDecision({ ...base, role: "maintainer", actor: "  " })).toBeUndefined();
    expect(verifiedFixtureDecision({ ...base, role: "maintainer", digest: "abc" })).toBeUndefined();
    expect(verifiedFixtureDecision({ ...base, role: "maintainer", action: "delete" as never })).toBeUndefined();
  });
  it("needs a sign-in within ten minutes of the use for a high set: the first from a test account, or one the environment backs with schema_synth", async () => {
    const { store } = setup();
    const synth = await submitOk(store, makeSet({ revision: 3 }));
    const d = synth.digest;
    expect(await store.approve(ORG_A, PROJ, d, by("approve", ORG_A, d, "lead", { synth: true }))).toEqual({ ok: false, reason: "fresh_sign_in_required" });
    expect(await store.approve(ORG_A, PROJ, d, by("approve", ORG_A, d, "lead", { synth: true, stale: true }))).toEqual({ ok: false, reason: "fresh_sign_in_required" });
    expect((await store.approve(ORG_A, PROJ, d, by("approve", ORG_A, d, "lead", { synth: true, fresh: true }))).ok).toBe(true);
    // An ordinary set needs none.
    const plain = await submitOk(store, makeSet({ revision: 4 }));
    expect((await store.approve(ORG_A, PROJ, plain.digest, by("approve", ORG_A, plain.digest, "lead"))).ok).toBe(true);
  });
  it("measures the sign-in against the moment of use, not of minting, and refuses one from the future", async () => {
    let at = NOW;
    const { store } = setup({ now: () => at });
    const record = await submitOk(store, makeSet({ revision: 21 }), ORG_A, "test_account");
    const d = record.digest;
    const minted = verifiedFixtureDecision({ project: PROJ, orgId: ORG_A, actor: "lead", role: "maintainer", action: "approve", digest: d, signedInAt: new Date(NOW.getTime() - 5 * 60_000), schemaSynth: false })!;
    at = new Date(NOW.getTime() + 6 * 60_000);
    expect(await store.approve(ORG_A, PROJ, d, minted)).toEqual({ ok: false, reason: "fresh_sign_in_required" });
    at = NOW;
    const future = verifiedFixtureDecision({ project: PROJ, orgId: ORG_A, actor: "lead", role: "maintainer", action: "approve", digest: d, signedInAt: new Date(NOW.getTime() + 30 * 60_000), schemaSynth: false })!;
    expect(await store.approve(ORG_A, PROJ, d, future)).toEqual({ ok: false, reason: "fresh_sign_in_required" });
  });
});

describe("a withdrawal during delivery (N3) and a set nested too deep (N5)", () => {
  it("refuses to hand out a URL when the set is withdrawn while it is being signed", async () => {
    const ports = createMemoryFixturePorts();
    const holder: { store?: FixtureStore } = {};
    let digest = "";
    const objects: FixtureStoreDependencies["objects"] = {
      ...ports.objects,
      presignGet: async (key, seconds) => {
        const url = await ports.objects.presignGet(key, seconds);
        await holder.store!.withdraw(ORG_A, PROJ, digest, by("withdraw", ORG_A, digest, "boss"));
        return url;
      },
    };
    const store = createFixtureStore({ enabled: () => true, objects, index: ports.index, denyFor: () => Promise.resolve(DENY), now: () => NOW });
    holder.store = store;
    const record = await submitOk(store);
    digest = record.digest;
    await store.approve(ORG_A, PROJ, digest, by("approve", ORG_A, digest, "lead"));
    expect(await store.deliver(ORG_A, PROJ, digest)).toEqual({ ok: false, reason: "not_approved" });
  });
  it("treats a value nested deeper than the bound as a finding, not a crash or a pass", () => {
    let deep: unknown = "x";
    for (let level = 0; level < FIXTURE_TEXT_MAX_DEPTH + 5; level += 1) deep = { a: deep };
    expect(() => fixtureTexts(deep)).toThrow(RangeError);
    expect(fixtureSetFindings(deep, DENY)).toEqual(["secret"]);
    let shallow: unknown = "x";
    for (let level = 0; level < 10; level += 1) shallow = [shallow];
    expect(fixtureSetFindings(shallow, DENY)).toEqual([]);
  });
});

describe("a bad object at the key is repaired by the next submit (L5)", () => {
  it("replaces the object with the submitted bytes when they match the digest, then approves and delivers", async () => {
    const { store, ports } = setup();
    const set = makeSet();
    const record = await submitOk(store, set);
    const key = fixtureObjectKey(ORG_A, PROJ, record.digest);
    ports.objects.dump().set(key, new TextEncoder().encode("corrupt"));
    expect(await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"))).toEqual({ ok: false, reason: "digest_mismatch" });
    expect(await store.submit(ORG_A, PROJ, set, { actor: "m", recordedFrom: "synthetic" })).toMatchObject({ ok: true, created: false });
    expect(new TextDecoder().decode(ports.objects.dump().get(key))).toBe(canonicalJson(set));
    expect((await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"))).ok).toBe(true);
    expect((await store.deliver(ORG_A, PROJ, record.digest)).ok).toBe(true);
  });
  it("repairs a corrupt object before the row exists, too, and leaves a good object alone", async () => {
    const { store, ports, touched } = setup();
    const set = makeSet();
    const key = fixtureObjectKey(ORG_A, PROJ, fixtureSetDigest(set));
    ports.objects.dump().set(key, new TextEncoder().encode("planted"));
    expect((await store.submit(ORG_A, PROJ, set, { actor: "m", recordedFrom: "synthetic" })).ok).toBe(true);
    expect(new TextDecoder().decode(ports.objects.dump().get(key))).toBe(canonicalJson(set));
    touched.length = 0;
    await store.submit(ORG_A, PROJ, set, { actor: "m", recordedFrom: "synthetic" });
    expect(touched).not.toContain("replace");
  });
  it("does not overwrite an object that changed after it was read (a conditional write)", async () => {
    const ports = createMemoryFixturePorts();
    const set = makeSet();
    const key = fixtureObjectKey(ORG_A, PROJ, fixtureSetDigest(set));
    ports.objects.dump().set(key, new TextEncoder().encode("first"));
    const racing: FixtureStoreDependencies["objects"] = {
      ...ports.objects,
      // Someone else writes between the read and the replace.
      replaceIfUnchanged: (k, _observed, bytes, type) => { ports.objects.dump().set(k, new TextEncoder().encode("second")); return ports.objects.replaceIfUnchanged(k, new TextEncoder().encode("first"), bytes, type); },
    };
    const store = createFixtureStore({ enabled: () => true, objects: racing, index: ports.index, denyFor: () => Promise.resolve(DENY), now: () => NOW });
    expect(await store.submit(ORG_A, PROJ, set, { actor: "m", recordedFrom: "synthetic" })).toEqual({ ok: false, reason: "digest_mismatch" });
    expect(new TextDecoder().decode(ports.objects.dump().get(key))).toBe("second");
  });
});

describe("H1: a set belongs to ONE project of the org", () => {
  const OTHER = "api";
  /** A maintainer's decision for another project than the one the set was submitted for. */
  const byIn = (project: string, action: "approve" | "reject" | "withdraw", orgId: string, digest: string) => {
    const decision = verifiedFixtureDecision({ orgId, project, actor: "maya", role: "maintainer", action, digest, signedInAt: new Date(NOW.getTime() - 60_000), schemaSynth: false });
    if (decision === undefined) throw new Error("not a maintainer");
    return decision;
  };
  const notFound = { ok: false, reason: "not_found" } as const;

  it("every read, decision and delivery of project B for project A's digest answers exactly what a digest nobody holds answers", async () => {
    const { store } = setup();
    const record = await submitOk(store);
    await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"));
    const nobody = "f".repeat(64);
    expect(record.project).toBe(PROJ);
    for (const digest of [record.digest, nobody]) {
      expect(await store.record(ORG_A, OTHER, digest)).toEqual(notFound);
      expect(await store.review(ORG_A, OTHER, digest)).toEqual(notFound);
      expect(await store.deliver(ORG_A, OTHER, digest)).toEqual(notFound);
      expect(await store.readApproved(ORG_A, OTHER, digest)).toEqual(notFound);
      expect(await store.deliverById(ORG_A, OTHER, fixtureStoreId(ORG_A, PROJ, digest))).toEqual(notFound);
    }
  });
  it("approve, reject and withdraw by project B on project A's set are refused and change nothing", async () => {
    const { store } = setup();
    const record = await submitOk(store);
    const d = record.digest;
    // a decision minted for project B is refused for A, and one minted for A is refused for B
    expect(await store.approve(ORG_A, PROJ, d, byIn(OTHER, "approve", ORG_A, d))).toEqual({ ok: false, reason: "unauthorised" });
    expect(await store.approve(ORG_A, OTHER, d, byIn(PROJ, "approve", ORG_A, d))).toEqual({ ok: false, reason: "unauthorised" });
    expect(await store.approve(ORG_A, OTHER, d, byIn(OTHER, "approve", ORG_A, d))).toEqual(notFound);
    expect(await store.reject(ORG_A, OTHER, d, byIn(OTHER, "reject", ORG_A, d))).toEqual(notFound);
    expect(await store.withdraw(ORG_A, OTHER, d, byIn(OTHER, "withdraw", ORG_A, d))).toEqual(notFound);
    expect(((await store.record(ORG_A, PROJ, d)) as { record: FixtureRecord }).record).toMatchObject({ status: "pending", version: 1 });
    // A's own maintainer still decides it
    expect((await store.approve(ORG_A, PROJ, d, by("approve", ORG_A, d, "lead"))).ok).toBe(true);
  });
  it("the same set in two projects is two rows and two objects, decided on their own", async () => {
    const { store, ports } = setup();
    const a = await submitOk(store);
    const b = await store.submit(ORG_A, OTHER, makeSet(), { actor: "maya", recordedFrom: "synthetic" });
    if (!b.ok) throw new Error(b.reason);
    expect(b.created).toBe(true);
    expect(b.record.storeId).toBe(`fxs:${ORG_A}:${OTHER}:${a.digest}`);
    expect(b.record.storeId).not.toBe(a.storeId);
    expect([...ports.objects.dump().keys()].sort()).toEqual([`private/${ORG_A}/fixtures/${OTHER}/${a.digest}`, `private/${ORG_A}/fixtures/${PROJ}/${a.digest}`].sort());
    await store.approve(ORG_A, PROJ, a.digest, by("approve", ORG_A, a.digest, "lead"));
    expect(((await store.record(ORG_A, OTHER, a.digest)) as { record: FixtureRecord }).record.status).toBe("pending");
    expect(await store.deliver(ORG_A, OTHER, a.digest)).toEqual({ ok: false, reason: "not_approved" });
    expect((await store.deliver(ORG_A, PROJ, a.digest)).ok).toBe(true);
  });
  it("the deny list is asked for the project of the set", async () => {
    const asked: string[] = [];
    const { store } = setup({ denyFor: (org, project) => { asked.push(`${org}/${project}`); return Promise.resolve(DENY); } });
    const record = await submitOk(store);
    await store.approve(ORG_A, PROJ, record.digest, by("approve", ORG_A, record.digest, "lead"));
    await store.deliver(ORG_A, PROJ, record.digest);
    expect(new Set(asked)).toEqual(new Set([`${ORG_A}/${PROJ}`]));
  });
  it("a project name that is not a name is refused before any port is touched", async () => {
    const { store, touched } = setup();
    for (const project of ["", "Web", "../api", "a/b", "web#1"]) {
      expect(await store.submit(ORG_A, project, makeSet(), { actor: "maya", recordedFrom: "synthetic" })).toEqual({ ok: false, reason: "bad_project" });
      expect(await store.record(ORG_A, project, "a".repeat(64))).toEqual({ ok: false, reason: "bad_project" });
    }
    expect(touched).toEqual([]);
  });
  it("firstFromTestAccount counts the project's own earlier approvals only", async () => {
    const { store } = setup();
    const first = await submitOk(store, makeSet({ revision: 3 }), ORG_A, "test_account");
    await store.approve(ORG_A, PROJ, first.digest, by("approve", ORG_A, first.digest, "lead", { fresh: true }));
    const elsewhere = await store.submit(ORG_A, OTHER, makeSet({ revision: 4 }), { actor: "maya", recordedFrom: "test_account" });
    if (!elsewhere.ok) throw new Error(elsewhere.reason);
    expect(elsewhere.record.firstFromTestAccount).toBe(true);
    const same = await store.submit(ORG_A, PROJ, makeSet({ revision: 5 }), { actor: "maya", recordedFrom: "test_account" });
    if (!same.ok) throw new Error(same.reason);
    expect(same.record.firstFromTestAccount).toBe(false);
  });
});
