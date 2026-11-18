// L4-E34 (E4): the stand-in set version is part of an eval's base-cache identity and its settings fingerprint, and of NOTHING an approval binds. A seed change misses the cache; an unchanged set hits it; an eval with no stand-ins
// keeps the key and fingerprint it always had (golden values taken from the code before this change).
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import {
  STAND_IN_ROW_GENERATOR_VERSION, createDocumentBaseScoreCache, evalBaseCacheKey, evalCommandFingerprint, evalSettingsFingerprintOf, isStandInSetVersion, standInSetVersion, standInSettingsFingerprint,
  type EvalBaseCacheKeyParts, type EvalBaseRecord, type StandInSetParts,
} from "@agentx/contracts";

const hex = (character: string, length = 64) => character.repeat(length);
const set = (over: Partial<StandInSetParts> = {}): StandInSetParts => ({ images: ["registry.example/postgres@sha256:" + hex("1")], seeds: [hex("a"), hex("b")], generatorVersion: STAND_IN_ROW_GENERATOR_VERSION, answerSets: [], ...over });
const parts = (over: Partial<EvalBaseCacheKeyParts> = {}): EvalBaseCacheKeyParts => ({
  company: "org_aaaaaaaaaaaaaaaaaaaa", project: "project-1", baseCommit: hex("a", 40), evalSetHash: hex("b"), hiddenSetHash: "none", commandFingerprint: evalCommandFingerprint("npm run eval"), catalogRowId: "gemini", model: "gemini-small", modelVersion: "gemini-small-2026-10-01", settingsFingerprint: hex("f"), ...over,
});
const record = (): EvalBaseRecord => ({ schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.04, count: 50 }], caseCount: 50, recordedOn: "2026-11-18", roundKind: "check_unsealed", runnerSchemaVersion: 1 });
const OWN = { writer: "rovara_base_round" as const, baseCommit: hex("a", 40) };

describe("the stand-in set version", () => {
  it("is a stable sha-256 hex for the same set", () => {
    expect(standInSetVersion(set())).toMatch(/^[a-f0-9]{64}$/u);
    expect(standInSetVersion(set())).toBe(standInSetVersion(set()));
    expect(isStandInSetVersion(standInSetVersion(set()))).toBe(true);
  });
  it.each<[string, Partial<StandInSetParts>]>([
    ["an image", { images: ["registry.example/postgres@sha256:" + hex("2")] }],
    ["a seed's content", { seeds: [hex("c"), hex("b")] }],
    ["the order the seeds load in", { seeds: [hex("b"), hex("a")] }],
    ["one seed more", { seeds: [hex("a"), hex("b"), hex("c")] }],
    ["the row generator's version", { generatorVersion: "rows-v2" }],
    ["an answer set", { answerSets: [hex("d")] }],
  ])("moves when %s changes", (_name, over) => {
    expect(standInSetVersion(set(over))).not.toBe(standInSetVersion(set()));
  });
  it("treats images and answer sets as sets (order and repeats do not matter) but seeds as a list", () => {
    const images = ["x/b@sha256:" + hex("2"), "x/a@sha256:" + hex("1")];
    expect(standInSetVersion(set({ images }))).toBe(standInSetVersion(set({ images: [...images].reverse(), }))); 
    expect(standInSetVersion(set({ images: [...images, images[0]!] }))).toBe(standInSetVersion(set({ images })));
    expect(standInSetVersion(set({ answerSets: [hex("d"), hex("e")] }))).toBe(standInSetVersion(set({ answerSets: [hex("e"), hex("d"), hex("d")] })));
  });
  it("cannot be forged by moving text between parts (the parts are named)", () => {
    expect(standInSetVersion(set({ seeds: [hex("a")], answerSets: [hex("b")] }))).not.toBe(standInSetVersion(set({ seeds: [hex("b")], answerSets: [hex("a")] })));
  });
  it("refuses a part that is not what it must be, naming the part and never its value", () => {
    const bad: Array<[string, Partial<StandInSetParts>]> = [
      ["seeds", { seeds: ["not a digest"] }], ["seeds", { seeds: [hex("A")] }], ["seeds", { seeds: Array.from({ length: 257 }, () => hex("a")) }],
      ["answerSets", { answerSets: ["x"] }], ["images", { images: ["has space"] }], ["images", { images: [""] }], ["generatorVersion", { generatorVersion: "" }], ["generatorVersion", { generatorVersion: "Rows V1" }],
      ["seeds", { seeds: "x" as never }], ["images", { images: undefined as never }],
    ];
    for (const [name, over] of bad) expect(() => standInSetVersion(set(over))).toThrow(new RegExp(`the ${name} `, "u"));
    try { standInSetVersion(set({ seeds: ["secret-looking-value-123"] })); } catch (error) { expect(String(error)).not.toContain("secret-looking"); }
  });
});

describe("the settings fingerprint", () => {
  const settings = { imageDigest: "sha256:" + hex("1"), route: "gemini" };
  it("with no stand-in version is byte for byte what it was before (the approved spend binds this value)", () => {
    expect(evalSettingsFingerprintOf(settings, hex("2"))).toBe("055d17c5488cd1d1c1c8877351ccc4377086425547e8fb87244b62426d541a9d");
    expect(evalSettingsFingerprintOf(settings, hex("2"), undefined)).toBe("055d17c5488cd1d1c1c8877351ccc4377086425547e8fb87244b62426d541a9d");
    expect(standInSettingsFingerprint(hex("f"), undefined)).toBe(hex("f"));
  });
  it("with a version is a different fingerprint per version, and never the plain one", () => {
    const one = standInSetVersion(set()); const two = standInSetVersion(set({ seeds: [hex("c")] }));
    const plain = evalSettingsFingerprintOf(settings, hex("2"));
    expect(evalSettingsFingerprintOf(settings, hex("2"), one)).not.toBe(plain);
    expect(evalSettingsFingerprintOf(settings, hex("2"), one)).not.toBe(evalSettingsFingerprintOf(settings, hex("2"), two));
    expect(evalSettingsFingerprintOf(settings, hex("2"), one)).toBe(evalSettingsFingerprintOf(settings, hex("2"), one));
    expect(evalSettingsFingerprintOf(settings, hex("2"), one)).toBe(standInSettingsFingerprint(plain, one));
  });
  it("refuses a version or a fingerprint that is not 64 hex characters (it never falls back to the plain one)", () => {
    expect(() => evalSettingsFingerprintOf(settings, hex("2"), "short")).toThrow(RangeError);
    expect(() => standInSettingsFingerprint(hex("f"), "")).toThrow(RangeError);
    expect(() => standInSettingsFingerprint("nope", undefined)).toThrow(RangeError);
  });
});

describe("the base-cache key", () => {
  it("is byte for byte what it was with no stand-in version (v1 and v2 keys, golden), and an explicit undefined is the same as none", () => {
    expect(evalBaseCacheKey(parts())).toBe("040c3654d5adf083f3e7fa55a1e8c7d67aba5be161c6334ac0f93da227729e2e");
    expect(evalBaseCacheKey(parts({ codeHash: hex("c"), judgePin: hex("d") }))).toBe("e4ee3b563d375329ab326d8e3ae43ce557052913e9e6095a701b3e7640f2f2bb");
    expect(evalBaseCacheKey(parts({ standInSetVersion: undefined }))).toBe(evalBaseCacheKey(parts()));
  });
  it("moves with the version, in both key forms, and an unchanged version gives an unchanged key", () => {
    const one = standInSetVersion(set()); const two = standInSetVersion(set({ seeds: [hex("c")] }));
    expect(evalBaseCacheKey(parts({ standInSetVersion: one }))).not.toBe(evalBaseCacheKey(parts()));
    expect(evalBaseCacheKey(parts({ standInSetVersion: one }))).not.toBe(evalBaseCacheKey(parts({ standInSetVersion: two })));
    expect(evalBaseCacheKey(parts({ standInSetVersion: one }))).toBe(evalBaseCacheKey(parts({ standInSetVersion: one })));
    const v2 = { codeHash: hex("c"), judgePin: hex("d") };
    expect(evalBaseCacheKey(parts({ ...v2, standInSetVersion: one }))).not.toBe(evalBaseCacheKey(parts(v2)));
    expect(evalBaseCacheKey(parts({ ...v2, standInSetVersion: one }))).not.toBe(evalBaseCacheKey(parts({ ...v2, standInSetVersion: two })));
  });
  it("refuses a version that is present and not a version (never the plain key), naming the part", () => {
    for (const bad of ["", "short", hex("A"), 5, null]) expect(() => evalBaseCacheKey(parts({ standInSetVersion: bad as never }))).toThrow(/standInSetVersion/u);
  });
});

describe("the cache over the document store", () => {
  const cacheOf = (store: MemoryDocumentStore, companyId: string) => createDocumentBaseScoreCache(store, { companyId });
  it("a seed change misses and an unchanged set hits: the score of one version is never read for another, nor for no version", async () => {
    const store = new MemoryDocumentStore(); const cache = cacheOf(store, "org_aaaaaaaaaaaaaaaaaaaa");
    const one = standInSetVersion(set()); const changedSeed = standInSetVersion(set({ seeds: [hex("c"), hex("b")] }));
    expect(await cache.write(parts({ standInSetVersion: one }), record(), OWN)).toBe("stored");
    expect(await cache.read(parts({ standInSetVersion: one }))).toBeDefined();
    expect(await cache.read(parts({ standInSetVersion: standInSetVersion(set()) }))).toBeDefined();
    expect(await cache.read(parts({ standInSetVersion: changedSeed }))).toBeUndefined();
    expect(await cache.read(parts())).toBeUndefined();
    // and the other way: a plain score is not a stand-in score
    const other = new MemoryDocumentStore(); const plain = cacheOf(other, "org_aaaaaaaaaaaaaaaaaaaa");
    await plain.write(parts(), record(), OWN);
    expect(await plain.read(parts({ standInSetVersion: one }))).toBeUndefined();
  });
  it("two companies: the same project, commit and stand-in set never share a record", async () => {
    const store = new MemoryDocumentStore(); const one = standInSetVersion(set());
    const a = cacheOf(store, "org_aaaaaaaaaaaaaaaaaaaa"); const b = cacheOf(store, "org_bbbbbbbbbbbbbbbbbbbb");
    await a.write(parts({ standInSetVersion: one }), record(), OWN);
    expect(await a.read(parts({ standInSetVersion: one }))).toBeDefined();
    expect(await b.read(parts({ company: "org_bbbbbbbbbbbbbbbbbbbb", standInSetVersion: one }))).toBeUndefined();
    // a company cannot ask the other's partition by naming it in the parts
    expect(await b.read(parts({ standInSetVersion: one }))).toBeUndefined();
  });
});
