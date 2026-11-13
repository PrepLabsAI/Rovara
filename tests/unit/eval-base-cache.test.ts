// TE-F3 part A: the base score cache. The key is content-addressed, so a change to any part is a miss and a fresh base run, never a stale score; the store is company-scoped; only Rovara's own base round writes it.
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { DOCUMENT_STORE_LIMITS } from "../../packages/contracts/src/ports/document-store.js";
import { COMPANY_KEY_PREFIX, companyOfKey } from "../../packages/contracts/src/ports/company-scope.js";
import {
  EVAL_BASE_CACHE_TTL_DAYS, EvalBaseRecordSchema, createDocumentBaseScoreCache, evalBaseCacheKey, evalCommandFingerprint, evalSettingsFingerprint, type BaseScoreCache, type EvalBaseCacheKeyParts, type EvalBaseRecord, type EvalSettings,
} from "../../packages/contracts/src/eval-base-cache.js";

const SETTINGS: EvalSettings = { runs: 3, seed: "seed-1", repeats: 5, k: 2, minQuestions: 20, imageDigest: `registry.example/worker@sha256:${"c".repeat(64)}`, route: "gemini" };
const hex = (character: string, length = 64) => character.repeat(length);
const parts = (over: Partial<EvalBaseCacheKeyParts> = {}): EvalBaseCacheKeyParts => ({
  company: "org_aaaaaaaaaaaaaaaaaaaa", project: "project-1", baseCommit: hex("a", 40), evalSetHash: hex("b"), hiddenSetHash: "none", commandFingerprint: evalCommandFingerprint("npm run eval"), catalogRowId: "gemini", model: "gemini-small", modelVersion: "gemini-small-2026-10-01", settingsFingerprint: evalSettingsFingerprint(SETTINGS), ...over,
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
    ["settings fingerprint", { settingsFingerprint: evalSettingsFingerprint({ ...SETTINGS, runs: 4 }) }],
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

describe("the settings fingerprint", () => {
  it.each<[string, Partial<EvalSettings>]>([
    ["runs", { runs: 4 }], ["seed", { seed: "seed-2" }], ["repeats", { repeats: 6 }], ["k", { k: 3 }], ["minimum questions", { minQuestions: 30 }],
    ["image digest", { imageDigest: `registry.example/worker@sha256:${"d".repeat(64)}` }], ["route", { route: "openai" }],
  ])("changes when the %s changes", (_name, over) => {
    expect(evalSettingsFingerprint({ ...SETTINGS, ...over })).not.toBe(evalSettingsFingerprint(SETTINGS));
    expect(evalSettingsFingerprint(SETTINGS)).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("refuses a setting that is not valid, naming it and never its value", () => {
    for (const bad of [{ runs: -1 }, { runs: 1.5 }, { repeats: 10_000 }, { k: 0 }, { k: Number.NaN }, { minQuestions: -2 }, { seed: "" }, { seed: "a b" }, { imageDigest: "" }, { route: "x".repeat(300) }]) {
      expect(() => evalSettingsFingerprint({ ...SETTINGS, ...bad })).toThrow(RangeError);
    }
    expect(() => evalSettingsFingerprint({ ...SETTINGS, seed: "has space" })).toThrow(/seed/u);
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
    for (const over of [{ baseCommit: hex("c", 40) }, { evalSetHash: hex("d") }, { hiddenSetHash: hex("e") }, { commandFingerprint: evalCommandFingerprint("other") }, { catalogRowId: "openai" }, { model: "m2" }, { modelVersion: "v2" }, { settingsFingerprint: evalSettingsFingerprint({ ...SETTINGS, seed: "seed-2" }) }, { project: "p2" }] as Partial<EvalBaseCacheKeyParts>[]) {
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
      await store.put({ item: { ...good, ...broken } as never });
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
