// TE-A2a: the check-kind registry and the trust classes. Pure data; every case fails when the rule it names is removed.
import { describe, expect, it } from "vitest";
import {
  CHECK_KIND_REGISTRY, CHECK_KINDS, CHECK_PARTS, PROOF_BASES, SCRIPTED_AI_PROOF_WORDS, EVIDENCE_TRUST_CLASSES, EVIDENCE_TRUST_CLASS_WORDS, checkKindInfo, checkKindWords, isRegisteredCheckKind, partsOutsideKind, trustLabelWords,
} from "../../packages/contracts/src/index.js";

describe("the registry", () => {
  it("registers every v1 kind, so a v1 pack's kinds are all known", () => {
    for (const kind of CHECK_KINDS) expect(isRegisteredCheckKind(kind), kind).toBe(true);
  });

  it("has unique ids, words for each, and only known parts", () => {
    const ids = CHECK_KIND_REGISTRY.map((info) => info.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const info of CHECK_KIND_REGISTRY) {
      expect(info.words.length, info.id).toBeGreaterThan(0);
      for (const part of info.parts) expect(CHECK_PARTS).toContain(part);
    }
  });

  it("counts toward proof only for kinds that run tests, never for evals, lint, type checks, scans, builds or migrations", () => {
    expect(["test", "e2e"].every((id) => checkKindInfo(id)?.countsTowardProof === true)).toBe(true);
    for (const id of ["eval", "lint", "typecheck", "security", "build", "migration", "benchmark", "visual", "smoke", "other"]) expect(checkKindInfo(id)?.countsTowardProof, id).toBe(false);
  });

  it("says which parts a kind may carry", () => {
    expect(partsOutsideKind("lint", ["findings"])).toEqual([]);
    expect(partsOutsideKind("lint", ["tests", "coverage", "findings", "migrations", "measures", "pairs"])).toEqual(["measures", "pairs"]);
    expect(partsOutsideKind("benchmark", ["tests"])).toEqual(["tests"]);
    expect(partsOutsideKind("benchmark", ["measures"])).toEqual([]);
    expect(partsOutsideKind("other", [...CHECK_PARTS])).toEqual([]);
  });

  it("lets every v1 kind carry every v1 part, because the v1 builder attaches them by what a check's report held, whatever its kind", () => {
    for (const kind of CHECK_KINDS) expect(partsOutsideKind(kind, ["tests", "coverage", "findings", "migrations"]), kind).toEqual([]);
  });

  it("does not know an unregistered kind, and gives it generic words rather than failing", () => {
    expect(isRegisteredCheckKind("hologram")).toBe(false);
    expect(checkKindInfo("hologram")).toBeUndefined();
    expect(partsOutsideKind("hologram", ["tests"])).toEqual([]);
    expect(checkKindWords("hologram")).toBe("Newer check kind");
  });
});

describe("trust classes", () => {
  it("are the five of O51 with the owner's words", () => {
    expect([...EVIDENCE_TRUST_CLASSES]).toEqual(["real", "recorded", "simulated", "made_by_rovara", "no_outside_calls"]);
    expect(EVIDENCE_TRUST_CLASS_WORDS).toEqual({ real: "Real", recorded: "Recorded", simulated: "Simulated", made_by_rovara: "Made by Rovara", no_outside_calls: "No outside calls" });
  });

  it("label a scripted-AI proof 'proven with scripted AI replies', never Real, whatever the trust class says", () => {
    expect(PROOF_BASES).toEqual(["scripted_ai_replies"]);
    expect(SCRIPTED_AI_PROOF_WORDS).toBe("proven with scripted AI replies");
    for (const trust of [...EVIDENCE_TRUST_CLASSES, undefined]) {
      const words = trustLabelWords(trust, "scripted_ai_replies");
      expect(words, String(trust)).toBe("proven with scripted AI replies");
      expect(words).not.toMatch(/real/iu);
    }
    expect(trustLabelWords("real")).toBe("Real");
    expect(trustLabelWords(undefined)).toBeUndefined();
  });
});
