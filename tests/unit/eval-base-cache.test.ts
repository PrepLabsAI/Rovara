// TE-F3 part A: the base score cache. The key is content-addressed, so a change to any part is a miss and a fresh base run, never a stale score; the store is company-scoped; only Rovara's own base round writes it.
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { DOCUMENT_STORE_LIMITS, type StoredDocument } from "../../packages/contracts/src/ports/document-store.js";
import { COMPANY_KEY_PREFIX, companyOfKey } from "../../packages/contracts/src/ports/company-scope.js";
import {
  EVAL_BASE_CACHE_TTL_DAYS, EvalBaseRecordSchema, createDocumentBaseScoreCache, evalBaseCacheKey, evalCommandFingerprint, type BaseScoreCache, type EvalBaseCacheKeyParts, type EvalBaseRecord,
} from "../../packages/contracts/src/eval-base-cache.js";

const hex = (character: string, length = 64) => character.repeat(length);
const parts = (over: Partial<EvalBaseCacheKeyParts> = {}): EvalBaseCacheKeyParts => ({
  company: "org_aaaaaaaaaaaaaaaaaaaa", project: "project-1", baseCommit: hex("a", 40), evalSetHash: hex("b"), hiddenSetHash: "none", commandFingerprint: evalCommandFingerprint("npm run eval"), catalogRowId: "gemini", model: "gemini-small", modelVersion: "gemini-small-2026-10-01", settingsFingerprint: hex("f"), ...over,
});
const record = (over: Partial<EvalBaseRecord> = {}): EvalBaseRecord => ({
  schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.04, count: 50 }], caseCount: 50, recordedOn: "2026-11-13", roundKind: "check_unsealed", runnerSchemaVersion: 1, ...over,
});
const OWN_ROUND = (baseCommit = hex("a", 40)) => ({ writer: "rovara_base_round" as const, baseCommit });

describe("the cache key", () => {
  it("is a stable sha-256 hex, the same for the same parts", () => {
    expect(evalBaseCacheKey(parts())).toMatch(/^[a-f0-9]{64}$/u);
    expect(evalBaseCacheKey(parts())).toBe(evalBaseCacheKey(parts()));
  });
  it.each<[string, Partial<EvalBaseCacheKeyParts>]>([
    ["company", { company: "org_bbbbbbbbbbbbbbbbbbbb" }],
    ["project", { project: "project-2" }],
    ["base commit", { baseCommit: hex("c", 40) }],
    ["eval set hash", { evalSetHash: hex("d") }],
    ["hidden set hash", { hiddenSetHash: hex("e") }],
    ["eval command", { commandFingerprint: evalCommandFingerprint("npm run eval -- --all") }],
    ["catalog row", { catalogRowId: "openai" }],
    ["model", { model: "gemini-large" }],
    ["exact model version", { modelVersion: "gemini-small-2026-11-01" }],
    ["settings fingerprint", { settingsFingerprint: hex("e") }],
  ])("changes when the %s changes", (_name, over) => {
    expect(evalBaseCacheKey(parts(over))).not.toBe(evalBaseCacheKey(parts()));
  });
  it("accepts a 64-hex commit (sha-256 repositories) and tells it from a 40-hex one", () => {
    expect(evalBaseCacheKey(parts({ baseCommit: hex("a", 64) }))).not.toBe(evalBaseCacheKey(parts()));
  });
  it("cannot be forged by moving text between parts (the parts are named, not joined)", () => {
    expect(evalBaseCacheKey(parts({ project: "a", model: "b-c" }))).not.toBe(evalBaseCacheKey(parts({ project: "a-b", model: "c" })));
  });
  it("refuses a part that is not what it should be, naming the part and never its value", () => {
    for (const bad of [{ baseCommit: "main" }, { baseCommit: hex("A", 40) }, { baseCommit: hex("a", 39) }, { evalSetHash: "x" }, { hiddenSetHash: "" }, { hiddenSetHash: "nope" }, { commandFingerprint: "npm run eval" }, { company: "" }, { company: "a#b" }, { project: "" }, { catalogRowId: "" }, { model: "" }, { modelVersion: "" }, { modelVersion: "a b" }, { settingsFingerprint: "x" }]) {
      expect(() => evalBaseCacheKey(parts(bad as Partial<EvalBaseCacheKeyParts>))).toThrow(RangeError);
    }
    expect(() => evalBaseCacheKey(parts({ model: "a-very-secret-looking-value".repeat(20) }))).toThrow(/model/u);
    try { evalBaseCacheKey(parts({ project: "x".repeat(500) })); } catch (error) { expect(String(error)).not.toContain("xxxxx"); }
  });
  it("fingerprints the eval command by content and with a domain, so the fingerprint is not the bare hash of the text", () => {
    expect(evalCommandFingerprint("a")).not.toBe(evalCommandFingerprint("b"));
    expect(evalCommandFingerprint("a")).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("the record", () => {
  it("is strict: scores and counts only, no unknown keys, finite numbers, a real day and round kind", () => {
    expect(EvalBaseRecordSchema.safeParse(record()).success).toBe(true);
    expect(EvalBaseRecordSchema.safeParse({ ...record(), caseId: "case-17" }).success).toBe(false);
    expect(EvalBaseRecordSchema.safeParse(record({ roundKind: "working" as never })).success).toBe(false);
    expect(EvalBaseRecordSchema.safeParse(record({ recordedOn: "yesterday" })).success).toBe(false);
    expect(EvalBaseRecordSchema.safeParse(record({ measures: [] })).success).toBe(false);
    expect(EvalBaseRecordSchema.safeParse(record({ measures: [{ name: "a", unit: "u", value: NaN, direction: "up_good" }] })).success).toBe(false);
    expect(EvalBaseRecordSchema.safeParse(record({ caseCount: -1 })).success).toBe(false);
  });
});

function world(now = () => 1_800_000_000_000) {
  const store = new MemoryDocumentStore({ ttlAttribute: "expiresAtSeconds" });
  const cache = (company: string): BaseScoreCache => createDocumentBaseScoreCache(store, { companyId: company, now });
  return { store, cache };
}

describe("the cache service over the document store", () => {
  it("writes then reads a record, and keeps it in a company-scoped partition with a 30-day expiry", async () => {
    const { store, cache } = world();
    const mine = cache("org_aaaaaaaaaaaaaaaaaaaa");
    expect(await mine.write(parts(), record(), OWN_ROUND())).toBe("stored");
    expect(await mine.read(parts())).toEqual(record());
    const key = evalBaseCacheKey(parts());
    const doc = (await store.query({ pk: `${COMPANY_KEY_PREFIX}org_aaaaaaaaaaaaaaaaaaaa#EVALBASE` })).items;
    expect(doc).toHaveLength(1);
    expect(companyOfKey(doc[0]!.pk)).toBe("org_aaaaaaaaaaaaaaaaaaaa");
    expect(doc[0]!.sk).toContain(key);
    expect(doc[0]!["expiresAtSeconds"]).toBe(1_800_000_000 + EVAL_BASE_CACHE_TTL_DAYS * 86_400);
    expect(EVAL_BASE_CACHE_TTL_DAYS).toBe(30);
    expect(new TextEncoder().encode(JSON.stringify(doc[0])).length).toBeLessThan(DOCUMENT_STORE_LIMITS.maxDocumentBytes);
    expect(JSON.stringify(doc[0])).not.toMatch(/caseId|"input"|"output"|prompt/iu);
  });
  it("never serves one company's record to another: the other company's read is a plain miss", async () => {
    const { cache } = world();
    await cache("org_aaaaaaaaaaaaaaaaaaaa").write(parts(), record(), OWN_ROUND());
    const other = cache("org_bbbbbbbbbbbbbbbbbbbb");
    expect(await other.read(parts({ company: "org_bbbbbbbbbbbbbbbbbbbb" }))).toBeUndefined();
    // even when the other company asks with the first company's own parts (the same key), it reads its own empty partition
    expect(await other.read(parts())).toBeUndefined();
    // the answer for "not there" and "another company's" is the same one
    expect(await other.read(parts({ baseCommit: hex("9", 40) }))).toBeUndefined();
  });
  it("refuses a document that sits in a company's partition but names another company, or another key", async () => {
    const { store, cache } = world();
    const a = cache("org_aaaaaaaaaaaaaaaaaaaa");
    await a.write(parts(), record(), OWN_ROUND());
    const [doc] = (await store.query({ pk: `${COMPANY_KEY_PREFIX}org_aaaaaaaaaaaaaaaaaaaa#EVALBASE` })).items;
    // plant A's document into B's partition under the key B would ask for
    const bParts = parts({ company: "org_bbbbbbbbbbbbbbbbbbbb" });
    await store.put({ item: { ...doc!, pk: `${COMPANY_KEY_PREFIX}org_bbbbbbbbbbbbbbbbbbbb#EVALBASE`, sk: `K#${evalBaseCacheKey(bParts)}` } });
    expect(await cache("org_bbbbbbbbbbbbbbbbbbbb").read(bParts)).toBeUndefined();
    // a record filed under the wrong key is a miss too
    await store.put({ item: { ...doc!, sk: `K#${evalBaseCacheKey(parts({ model: "other" }))}` } });
    expect(await a.read(parts({ model: "other" }))).toBeUndefined();
  });
  it("is a miss, never a stale score, when any one key part differs", async () => {
    const { cache } = world();
    const mine = cache("org_aaaaaaaaaaaaaaaaaaaa");
    await mine.write(parts(), record(), OWN_ROUND());
    for (const over of [{ baseCommit: hex("c", 40) }, { evalSetHash: hex("d") }, { hiddenSetHash: hex("e") }, { commandFingerprint: evalCommandFingerprint("other") }, { catalogRowId: "openai" }, { model: "m2" }, { modelVersion: "v2" }, { settingsFingerprint: hex("e") }, { project: "p2" }] as Partial<EvalBaseCacheKeyParts>[]) {
      expect(await mine.read(parts(over)), JSON.stringify(Object.keys(over))).toBeUndefined();
    }
  });
  it("treats a corrupt, tampered or expired record as a miss", async () => {
    let clock = 1_800_000_000_000;
    const { store, cache } = world(() => clock);
    const mine = cache("org_aaaaaaaaaaaaaaaaaaaa");
    await mine.write(parts(), record(), OWN_ROUND());
    const key = { pk: `${COMPANY_KEY_PREFIX}org_aaaaaaaaaaaaaaaaaaaa#EVALBASE`, sk: `K#${evalBaseCacheKey(parts())}` };
    const good = (await store.get(key))!;
    for (const broken of [{ record: "not json" }, { record: { schemaVersion: 1 } }, { record: { ...record(), measures: [{ name: "a", unit: "u", value: "NaN", direction: "up_good" }] } }, { record: null }, { company: "org_other" }]) {
      // Match the JSON boundary of the real document store (optional fields are absent).
      const item = JSON.parse(JSON.stringify({ ...good, ...broken })) as StoredDocument;
      await store.put({ item });
      expect(await mine.read(parts()), JSON.stringify(broken)).toBeUndefined();
    }
    await store.put({ item: good });
    expect(await mine.read(parts())).toEqual(record());
    clock += (EVAL_BASE_CACHE_TTL_DAYS * 86_400 + 1) * 1000;
    expect(await mine.read(parts())).toBeUndefined();
  });
  it("is a miss when the store is down, and a refused write when it cannot write (the cache is only an optimisation)", async () => {
    const down = {
      ttlAttribute: "expiresAtSeconds",
      get: () => Promise.reject(new Error("store down")),
      put: () => Promise.reject(new Error("store down")),
    } as unknown as MemoryDocumentStore;
    const cache = createDocumentBaseScoreCache(down, { companyId: "org_aaaaaaaaaaaaaaaaaaaa" });
    expect(await cache.read(parts())).toBeUndefined();
    expect(await cache.write(parts(), record(), OWN_ROUND())).toBe("refused");
  });
  it("is written only by Rovara's own base round of that very commit", async () => {
    const { cache } = world();
    const mine = cache("org_aaaaaaaaaaaaaaaaaaaa");
    expect(await mine.write(parts(), record(), { writer: "head_round", baseCommit: hex("a", 40) } as never)).toBe("refused");
    expect(await mine.write(parts(), record(), { writer: "agent_file", baseCommit: hex("a", 40) } as never)).toBe("refused");
    expect(await mine.write(parts(), record(), OWN_ROUND(hex("c", 40)))).toBe("refused");
    expect(await mine.write(parts(), record(), undefined as never)).toBe("refused");
    expect(await mine.read(parts())).toBeUndefined();
    expect(await mine.write(parts(), record(), OWN_ROUND())).toBe("stored");
  });
  it("uses a record only up to its maximum age: the reader's own shorter age wins, and the default is thirty days", async () => {
    let clock = 1_800_000_000_000;
    const store = new MemoryDocumentStore({ ttlAttribute: "expiresAtSeconds" });
    const writer = createDocumentBaseScoreCache(store, { companyId: "org_aaaaaaaaaaaaaaaaaaaa", now: () => clock });
    await writer.write(parts(), record(), OWN_ROUND());
    clock += 8 * 86_400_000;
    expect(await writer.read(parts())).toEqual(record());
    const sevenDays = createDocumentBaseScoreCache(store, { companyId: "org_aaaaaaaaaaaaaaaaaaaa", now: () => clock, maxAgeDays: 7 });
    expect(await sevenDays.read(parts())).toBeUndefined();
    const longer = createDocumentBaseScoreCache(store, { companyId: "org_aaaaaaaaaaaaaaaaaaaa", now: () => clock, maxAgeDays: 400 });
    expect(await longer.read(parts())).toEqual(record());
    clock += 23 * 86_400_000;
    expect(await longer.read(parts())).toBeUndefined();
    // a setting above thirty days is clamped when it WRITES too: the record is not kept longer
    const fresh = new MemoryDocumentStore({ ttlAttribute: "expiresAtSeconds" });
    const generous = createDocumentBaseScoreCache(fresh, { companyId: "org_aaaaaaaaaaaaaaaaaaaa", now: () => clock, maxAgeDays: 400 });
    await generous.write(parts(), record(), OWN_ROUND());
    clock += 31 * 86_400_000;
    expect(await generous.read(parts())).toBeUndefined();
  });
  it("refuses a record that is not valid, and a company that is not this cache's, without ever calling the store", async () => {
    const store = new MemoryDocumentStore({ ttlAttribute: "expiresAtSeconds" });
    let puts = 0;
    const original = store.put.bind(store);
    store.put = (request) => { puts += 1; return original(request); };
    const mine = createDocumentBaseScoreCache(store, { companyId: "org_aaaaaaaaaaaaaaaaaaaa" });
    expect(await mine.write(parts(), { ...record(), measures: [] }, OWN_ROUND())).toBe("refused");
    expect(await mine.write(parts(), { ...record(), caseId: "x" } as never, OWN_ROUND())).toBe("refused");
    expect(await mine.write(parts({ company: "org_bbbbbbbbbbbbbbbbbbbb" }), record(), OWN_ROUND())).toBe("refused");
    expect(await mine.write(parts(), record(), { writer: "head_round", baseCommit: hex("a", 40) } as never)).toBe("refused");
    expect(puts).toBe(0);
    expect(await mine.read(parts({ company: "org_bbbbbbbbbbbbbbbbbbbb" }))).toBeUndefined();
    expect(await mine.write(parts(), record(), OWN_ROUND())).toBe("stored");
    expect(puts).toBe(1);
  });
});

describe("dependency-keyed baseline", () => {
  const dependencyParts = (over: Partial<EvalBaseCacheKeyParts> = {}) => parts({ codeHash: hex("e"), judgePin: hex("f"), ...over });
  it("reuses identical code across commits, but refreshes on every dependency change", async () => {
    const { cache } = world(); const mine = cache("org_aaaaaaaaaaaaaaaaaaaa");
    await mine.write(dependencyParts(), record(), OWN_ROUND());
    expect(await mine.read(dependencyParts({ baseCommit: hex("b", 40) }))).toEqual(record());
    for (const over of [{ codeHash: hex("1") }, { judgePin: hex("2") }, { evalSetHash: hex("3") }, { modelVersion: "another-version" }, { company: "org_bbbbbbbbbbbbbbbbbbbb" }]) {
      expect(await mine.read(dependencyParts(over))).toBeUndefined();
    }
    expect(await mine.read(parts())).toBeUndefined();
  });
  it("refuses partial or malformed dependency identity", () => {
    for (const over of [{ codeHash: "" }, { judgePin: "main" }]) {
      expect(() => evalBaseCacheKey(dependencyParts(over))).toThrow();
    }
    for (const missing of ["codeHash", "judgePin"] as const) {
      const partial = { ...dependencyParts() }; delete partial[missing];
      expect(() => evalBaseCacheKey(partial)).toThrow();
    }
  });
});

it("validates measuring documents, clock values and scope without leaking stored text", async () => {
  const { store, cache } = world(); const mine = cache(parts().company);
  const started = await mine.startMeasurement!(parts()); expect(started.status).toBe("started");
  const address = { pk: `${COMPANY_KEY_PREFIX}${parts().company}#EVALBASE`, sk: `M#${evalBaseCacheKey(parts())}` };
  const good = (await store.get(address))!;
  expect(await mine.readMeasurement!(parts())).toBe("measuring");
  for (const over of [{ state: "private canary" }, { startedAt: "private canary" }, { expiresAt: "private canary" }, { startedAt: 1_800_000_001 }, { expiresAt: 1_800_003_601 }, { company: "private canary" }, { key: "private canary" }]) {
    await store.put({ item: { ...good, ...over } });
    expect(await mine.readMeasurement!(parts())).toBe("unavailable");
    expect(await mine.startMeasurement!(parts())).toEqual({ status: "unavailable" });
  }
  expect(await mine.readMeasurement!(parts({ company: "org_other" }))).toBe("unavailable");
  expect(await mine.startMeasurement!(parts({ company: "org_other" }))).toEqual({ status: "unavailable" });
  expect(await mine.readMeasurement!(null as never)).toBe("unavailable");
  const brokenClock = createDocumentBaseScoreCache(store, { companyId: parts().company, now: () => NaN });
  expect(await brokenClock.startMeasurement!(parts())).toEqual({ status: "unavailable" });
});
it("refuses unavailable measuring storage instead of treating it as a cache miss", async () => {
  const cache = createDocumentBaseScoreCache({ get: async () => { throw new Error("private canary"); }, put: async () => { throw new Error("private canary"); } }, { companyId: parts().company });
  expect(await cache.readMeasurement!(parts())).toBe("unavailable");
  expect(await cache.startMeasurement!(parts())).toEqual({ status: "unavailable" });
});
it.each(["finished", "measuring"])("refuses malformed %s marks instead of overwriting them", async state => {
  const { store, cache } = world(); const mine = cache(parts().company);
  await mine.startMeasurement!(parts());
  const address = { pk: `${COMPANY_KEY_PREFIX}${parts().company}#EVALBASE`, sk: `M#${evalBaseCacheKey(parts())}` };
  const good = (await store.get(address))!;
  for (const over of [{ startedAt: "private canary" }, { expiresAt: 0 }, { expiresAt: null }]) {
    const broken = { ...good, state, ...over };
    await store.put({ item: broken });
    expect(await mine.startMeasurement!(parts())).toEqual({ status: "unavailable" });
    expect(await store.get(address)).toEqual(broken);
  }
});
it("finishes only named fields and keeps errors fixed", async () => {
  const { store, cache } = world(); const mine = cache(parts().company); const claim = await mine.startMeasurement!(parts());
  if (claim.status !== "started") throw new Error("missing mark");
  await mine.finishMeasurement!(parts(), { ...claim.mark, extra: "private canary" } as never);
  const docs = (await store.query({ pk: `${COMPANY_KEY_PREFIX}${parts().company}#EVALBASE` })).items;
  expect(JSON.stringify(docs)).not.toContain("private canary");
  await expect(mine.finishMeasurement!(parts(), { ...claim.mark, state: "private canary" } as never)).rejects.toThrow("baseline mark could not be finished");
});
it("does not let a retried finish clear a same-second successor's measuring mark", async () => {
  const backing = new MemoryDocumentStore();
  let release!: () => void; let applied!: () => void; let retry = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const firstApplied = new Promise<void>(resolve => { applied = resolve; });
  const store: Pick<MemoryDocumentStore, "get" | "put"> = {
    get: address => backing.get(address),
    put: async request => {
      const result = await backing.put(request);
      if (retry && request.item["state"] === "finished") {
        retry = false; applied(); await gate;
        // A successful write whose response was lost can be retried by the adapter.
        await backing.put(request);
      }
      return result;
    },
  };
  const a = createDocumentBaseScoreCache(store, { companyId: parts().company, now: () => 1_800_000_000_000 });
  const b = createDocumentBaseScoreCache(store, { companyId: parts().company, now: () => 1_800_000_000_000 });
  const first = await a.startMeasurement!(parts());
  if (first.status !== "started") throw new Error("missing first mark");
  const finishing = a.finishMeasurement!(parts(), first.mark); await firstApplied;
  try { expect((await b.startMeasurement!(parts())).status).toBe("started"); }
  finally { release(); await finishing; }
  expect(await b.readMeasurement!(parts())).toBe("measuring");
});

it("persists a fresh host claim identity even for same-second starts", async () => {
  const { store, cache } = world(); const mine = cache(parts().company);
  const first = await mine.startMeasurement!(parts());
  if (first.status !== "started") throw new Error("missing first mark");
  const address = { pk: `${COMPANY_KEY_PREFIX}${parts().company}#EVALBASE`, sk: `M#${evalBaseCacheKey(parts())}` };
  const before = (await store.get(address))!;
  expect(before["claimId"]).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  await mine.finishMeasurement!(parts(), first.mark);
  expect((await store.get(address))!["claimId"]).toBe(before["claimId"]);
  const second = await cache(parts().company).startMeasurement!(parts());
  expect(second.status).toBe("started");
  const after = (await store.get(address))!;
  expect(after["startedAt"]).toBe(before["startedAt"]);
  expect(after["claimId"]).not.toBe(before["claimId"]);
});

it.each(["measuring", "finished"])("treats a %s mark without a claim identity as expired and reclaims it once", async state => {
  const { store, cache } = world(); const mine = cache(parts().company);
  await mine.startMeasurement!(parts());
  const address = { pk: `${COMPANY_KEY_PREFIX}${parts().company}#EVALBASE`, sk: `M#${evalBaseCacheKey(parts())}` };
  const legacy: StoredDocument = { ...(await store.get(address))!, state }; delete legacy["claimId"];
  await store.put({ item: legacy });
  expect(await mine.readMeasurement!(parts())).toBe("idle");
  const starts = await Promise.all([mine.startMeasurement!(parts()), cache(parts().company).startMeasurement!(parts())]);
  expect(starts.map(result => result.status).sort()).toEqual(["measuring", "started"]);
  expect(await mine.readMeasurement!(parts())).toBe("measuring");
});

it("refuses malformed claim identities with fixed words and leaves their marks intact", async () => {
  const { store, cache } = world(); const mine = cache(parts().company);
  const first = await mine.startMeasurement!(parts());
  if (first.status !== "started") throw new Error("missing first mark");
  const address = { pk: `${COMPANY_KEY_PREFIX}${parts().company}#EVALBASE`, sk: `M#${evalBaseCacheKey(parts())}` };
  const good = (await store.get(address))!;
  for (const claimId of [null, 42, {}, [], "", "private canary"]) {
    const malformed = { ...good, claimId };
    await store.put({ item: malformed });
    expect(await mine.readMeasurement!(parts())).toBe("unavailable");
    expect(await mine.startMeasurement!(parts())).toEqual({ status: "unavailable" });
    await expect(mine.finishMeasurement!(parts(), { ...first.mark, claimId } as never)).rejects.toEqual(new Error("baseline mark could not be finished"));
    expect(await store.get(address)).toEqual(malformed);
  }
}, 2_000);

it("bounds malformed large claim reads and never calls the writer", async () => {
  const { store, cache } = world(); await cache(parts().company).startMeasurement!(parts());
  const address = { pk: `${COMPANY_KEY_PREFIX}${parts().company}#EVALBASE`, sk: `M#${evalBaseCacheKey(parts())}` };
  const malformed = { ...(await store.get(address))!, claimId: "x".repeat(1_000_000) };
  let reads = 0; let writes = 0;
  // Inject a corrupt read directly: the real DocumentStore rejects oversized writes.
  const mine = createDocumentBaseScoreCache({
    get: async () => { reads++; return malformed; },
    put: async () => { writes++; return { applied: true }; },
  }, { companyId: parts().company, now: () => 1_800_000_000_000 });
  const start = performance.now();
  expect(await mine.readMeasurement!(parts())).toBe("unavailable");
  expect(await mine.startMeasurement!(parts())).toEqual({ status: "unavailable" });
  expect(reads).toBe(2); expect(writes).toBe(0);
  expect(performance.now() - start).toBeLessThan(1_000);
}, 1_000);

it("does not classify a lost claim against an identity-less mark as measuring", async () => {
  const { store, cache } = world(); await cache(parts().company).startMeasurement!(parts());
  const address = { pk: `${COMPANY_KEY_PREFIX}${parts().company}#EVALBASE`, sk: `M#${evalBaseCacheKey(parts())}` };
  const legacy = (await store.get(address))!; delete legacy["claimId"];
  const mine = createDocumentBaseScoreCache({ get: async () => legacy, put: async () => ({ applied: false, reason: "condition_failed" }) }, { companyId: parts().company, now: () => 1_800_000_000_000 });
  expect(await mine.startMeasurement!(parts())).toEqual({ status: "unavailable" });
});

it("refuses a finish without claim identity and hides finish-store errors", async () => {
  const { store, cache } = world(); const mine = cache(parts().company);
  const first = await mine.startMeasurement!(parts());
  if (first.status !== "started") throw new Error("missing first mark");
  const put = store.put.bind(store); let writes = 0;
  store.put = request => { writes++; return put(request); };
  const legacy = { ...first.mark } as Record<string, unknown>; delete legacy["claimId"];
  await expect(mine.finishMeasurement!(parts(), legacy as never)).rejects.toEqual(new Error("baseline mark could not be finished"));
  expect(writes).toBe(0);
  expect(await mine.readMeasurement!(parts())).toBe("measuring");
  store.put = async () => { throw new Error("private canary"); };
  await expect(mine.finishMeasurement!(parts(), first.mark)).rejects.toEqual(new Error("baseline mark could not be finished"));
});
