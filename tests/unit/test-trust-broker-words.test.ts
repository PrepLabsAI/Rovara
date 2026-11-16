// TE-A3: the broker's words for the two new labels and the new backing. Fixed words only; nothing from a repository is echoed.
import { describe, expect, it } from "vitest";
import { evidenceDependencyLabelFor, evidenceDependencyTrustClass, testEnvBackingTrustClass, trustClassOf, type EvidenceDependency, type TestEnvBacking } from "@agentx/contracts";
import { dependencyEvidenceOf } from "../../packages/broker/src/core/proof/dependency-evidence.js";
import { backingWords } from "../../packages/broker/src/core/test-env/dependency-card-lines.js";
import { pinnedFakeOf } from "../../packages/broker/src/core/test-env/evidence-line.js";
import { dependencyLines } from "../../packages/broker/src/core/proof/dependency-lines.js";

const sha = (letter: string) => letter.repeat(64);
const fake = (provenance?: Record<string, unknown>): TestEnvBacking => ({ kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail", ...(provenance === undefined ? {} : { provenance }) }) as TestEnvBacking;
const mockSet = { setId: "payments-mocks", version: 1, store: "rovara" };

describe("the approval card's words for a backing", () => {
  it("says a vendor's test mode needs a second person, like a test account", () => {
    expect(backingWords({ kind: "vendor_test", accountId: "payments-test" })).toBe("uses the vendor's own test mode with your test key in sealed checks (a second person approves this)");
  });
  it("says who made a fake: Rovara, a recording, or nobody in particular", () => {
    expect(backingWords(fake({ origin: "rovara_task", mockSet }))).toBe("answers from a fake made by Rovara");
    expect(backingWords(fake({ origin: "rovara_setup", mockSet }))).toBe("answers from a fake made by Rovara");
    expect(backingWords(fake(), new Map([[sha("a"), { origin: "recorded" as const }]]))).toBe("answers from a recorded fake");
    expect(backingWords(fake())).toBe("answers from a fake");
  });
  it("takes 'recorded' from the fixture store, as the evidence does, never from the plan's own word (review L1)", () => {
    expect(backingWords(fake({ origin: "recorded", recordedOn: "2026-11-12" }))).toBe("answers from a fake");
    expect(backingWords(fake({ origin: "recorded", recordedOn: "2026-11-12" }), new Map([[sha("a"), { origin: "hand_written" as const }]]))).toBe("answers from a hand-written fake");
    expect(backingWords(fake({ origin: "customer" }), new Map([[sha("a"), { origin: "recorded" as const }]]))).toBe("answers from a recorded fake");
  });
  it("never lets a recording that Rovara made read as a plain recording", () => {
    expect(backingWords(fake({ origin: "rovara_task", mockSet }), new Map([[sha("a"), { origin: "recorded" as const }]]))).toBe("answers from a fake made by Rovara");
  });
});

describe("the pull request's lines for the new labels", () => {
  const made: EvidenceDependency = { name: "Payments", backing: "fake", label: "rovara_made_fake", madeUpAnswers: 3 };
  const vendor: EvidenceDependency = { name: "Stripe", backing: "vendor_test", label: "vendor_test" };
  it("says a Rovara-made fake's answers were made by Rovara and counts its made-up answers", () => {
    const { lines, notTested } = dependencyLines([made], 0);
    expect(lines.join("\n")).toContain("fake made by Rovara");
    expect(notTested.join("\n")).toContain("answers were made by Rovara, not recorded from the real service");
    expect(notTested.join("\n")).toContain("3 requests had no recording and got a made-up answer");
    expect(dependencyLines([made], 3).notTested.join("\n")).toContain("made by Rovara");
  });
  it("says a vendor test mode ran, and adds no 'not checked' line for it", () => {
    const { lines, notTested } = dependencyLines([vendor], 0);
    expect(lines.join("\n")).toContain("vendor test mode");
    expect(notTested).toEqual([]);
  });
});

describe("the plan's trust class and the evidence's label come from the same source (review L1)", () => {
  const provenances: Array<Record<string, unknown> | undefined> = [undefined, { origin: "customer" }, { origin: "recorded", recordedOn: "2026-11-12" }, { origin: "rovara_setup", mockSet }, { origin: "rovara_task", mockSet }];
  const sets = [undefined, { origin: "recorded", revision: 2, recordedAt: "2026-11-12T10:00:00.000Z" }, { origin: "recorded", revision: 2 }, { origin: "hand_written", revision: 1 }, { origin: "something_newer", revision: 1, recordedAt: "2026-11-12T10:00:00.000Z" }];
  it("gives every combination of plan provenance and stored set the same class in both", () => {
    for (const provenance of provenances) {
      for (const set of sets) {
        const backing = fake(provenance) as Extract<TestEnvBacking, { kind: "fake" }>;
        const pinned = pinnedFakeOf(backing, set);
        const label = evidenceDependencyLabelFor({ backing: "fake", recorded: pinned.origin === "recorded" && pinned.recordedAt !== undefined, madeByRovara: pinned.madeByRovara === true });
        expect(testEnvBackingTrustClass(backing, set), JSON.stringify({ provenance, set })).toBe(trustClassOf(label));
      }
    }
  });
});

describe("a fake that may make up answers, when its ledger was not read (review 2 M2)", () => {
  const synth = { kind: "fake", fixtureSetRef: sha("a"), unmatched: "schema_synth" } as Extract<TestEnvBacking, { kind: "fake" }>;
  const failing = { kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail" } as Extract<TestEnvBacking, { kind: "fake" }>;
  const set = { origin: "recorded", revision: 2, recordedAt: "2026-11-12T10:00:00.000Z" };
  const started = { schemaVersion: 1 as const, dependencies: [{ id: "payments", started: true, healthy: true, startMs: 1, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 } };
  it("carries whether the pinned fake may make up answers, and only then", () => {
    expect(pinnedFakeOf(synth, set).makesUpAnswers).toBe(true);
    expect(pinnedFakeOf(failing, set)).not.toHaveProperty("makesUpAnswers");
  });
  it("is Made by Rovara when nothing counted its made-up answers, and the row's words stay as they were", () => {
    const fake = pinnedFakeOf(synth, set);
    const row = dependencyEvidenceOf([{ id: "payments", name: "Payments", backing: "fake", fake }], started).dependencies[0]!;
    expect(row).toMatchObject({ label: "recorded_fake", recordedAt: "2026-11-12T10:00:00.000Z" });
    expect(row).not.toHaveProperty("usage");
    expect(evidenceDependencyTrustClass(row, fake)).toBe("made_by_rovara");
    // the same unread ledger behind a fake that never makes up answers keeps its class
    const plain = pinnedFakeOf(failing, set);
    expect(evidenceDependencyTrustClass(dependencyEvidenceOf([{ id: "payments", name: "Payments", backing: "fake", fake: plain }], started as never).dependencies[0]!, plain)).toBe("recorded");
  });
});
