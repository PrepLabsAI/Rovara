// TE-B3 (review M1b): the READERS of a v1 pack's `checks[].tests` and of test-proof.json ignore a key they do not know, so a writer can add a part (absentOnNew, weakening) once every reader has this schema. The
// WRITERS stay strict. This reader change ships a release before any writer sets the new parts.
import { describe, expect, it } from "vitest";
import { EvidencePackReadSchema, EvidencePackSchema, TestProofSchema, TestProofWriteSchema, readEvidencePack } from "../../packages/contracts/src/index.js";
import { DIGEST, v1Pack } from "../support/evidence-v2-fixtures.js";

const withExtraTestsKey = () => {
  const pack = JSON.parse(JSON.stringify(v1Pack())) as ReturnType<typeof v1Pack> & { checks: Array<{ tests?: Record<string, unknown> }> };
  pack.checks[0]!.tests!["somethingNewer"] = ["x"];
  return pack;
};

describe("a reader of a v1 pack ignores a key the tests part does not know", () => {
  it("readEvidencePack reads it as v1 and drops the key; the writer's schema refuses it", () => {
    const read = readEvidencePack(withExtraTestsKey());
    expect(read.status).toBe("v1");
    expect(read.status === "v1" && read.pack.checks[0]?.tests).not.toHaveProperty("somethingNewer");
    expect(EvidencePackSchema.safeParse(withExtraTestsKey()).success).toBe(false);
    expect(EvidencePackReadSchema.safeParse(withExtraTestsKey()).success).toBe(true);
  });
  it("is still strict everywhere else: an unknown key on a check or on the pack is refused", () => {
    const onCheck = JSON.parse(JSON.stringify(v1Pack())) as { checks: Array<Record<string, unknown>> };
    onCheck.checks[0]!["extra"] = 1;
    expect(readEvidencePack(onCheck).status).toBe("unreadable");
    expect(readEvidencePack({ ...v1Pack(), extra: 1 }).status).toBe("unreadable");
  });
  it("still checks the fields it knows", () => {
    const pack = withExtraTestsKey();
    pack.checks[0]!.tests!["total"] = 99;
    expect(readEvidencePack(pack).status).toBe("unreadable");
  });
});

describe("a reader of test-proof.json ignores what it does not know", () => {
  const proof = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, candidateDigest: DIGEST, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, items: [], durationMs: 5, ...extra });
  it("drops an unknown top-level key; the worker's strict schema refuses it", () => {
    expect(TestProofSchema.safeParse(proof({ newerPart: 1 })).success).toBe(true);
    expect(TestProofSchema.parse(proof({ newerPart: 1 }))).not.toHaveProperty("newerPart");
    expect(TestProofWriteSchema.safeParse(proof({ newerPart: 1 })).success).toBe(false);
  });
  it("drops a weakening part it cannot read and still reads the rest of the proof", () => {
    const parsed = TestProofSchema.parse(proof({ weakening: [{ checkId: "readiness:0", nonsense: true }], weakeningNotCompared: "no" }));
    expect(parsed.weakening).toBeUndefined();
    expect(parsed.weakeningNotCompared).toBeUndefined();
    expect(parsed.status).toBe("checked");
  });
  it("reads a part a newer writer put in a weakening item (an unknown key is dropped)", () => {
    const item = { checkId: "readiness:0", skippedBefore: 0, skippedAfter: 1, absentOnNew: [], absentOnNewCount: 0, newerField: 1 };
    expect(TestProofSchema.parse(proof({ weakening: [item] })).weakening?.[0]).toEqual({ checkId: "readiness:0", skippedBefore: 0, skippedAfter: 1, absentOnNew: [], absentOnNewCount: 0 });
    expect(TestProofWriteSchema.safeParse(proof({ weakening: [item] })).success).toBe(false);
  });
});
