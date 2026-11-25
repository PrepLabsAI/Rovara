import { describe, expect, it } from "vitest";
import { TestProofWriteSchema, type TestProof } from "../../packages/contracts/src/index.js";
import { serializeTestProof, withScriptedReplyFacts } from "../../packages/worker/src/verification/test-proof.js";
import { modelHelperReplyCollector } from "../../packages/worker/src/model-helper-round.js";
import { expectLinearScaling } from "../support/scaling.js";

const digest = "a".repeat(64);
const proof = (): TestProof => ({ schemaVersion: 1, candidateDigest: digest, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, items: [0, 2].map((id) => ({ checkId: `readiness:${String(id)}`, label: "Tests", granularity: "check", verdict: "proves_change", reason: "assertion_failed_on_old" })), durationMs: 0 });
const facts = [{ checkId: "readiness:0", taskMade: 2, counted: 1 }, { checkId: "readiness:1", taskMade: 8, counted: 0 }, { checkId: "readiness:2", taskMade: 0, counted: 2 }];

describe("reply facts in the saved proof", () => {
  it("pins legacy bytes for absent facts, no changed tests, not checked and non-project plans", () => {
    const legacy = '{"schemaVersion":1,"candidateDigest":"' + digest + '","status":"checked","note":"completed","changedTests":{"added":1,"changed":0,"deleted":0},"items":[{"checkId":"readiness:0","label":"Tests","granularity":"check","verdict":"proves_change","reason":"assertion_failed_on_old"},{"checkId":"readiness:2","label":"Tests","granularity":"check","verdict":"proves_change","reason":"assertion_failed_on_old"}],"durationMs":0}';
    expect(serializeTestProof(withScriptedReplyFacts(proof(), "project", undefined))).toBe(legacy);
    expect(serializeTestProof(withScriptedReplyFacts(proof(), "project", []))).toBe(legacy);
    expect(serializeTestProof(withScriptedReplyFacts(proof(), "agent_commands", facts))).toBe(legacy);
    for (const status of ["no_changed_tests", "not_checked"] as const) {
      const p = { ...proof(), status };
      expect(serializeTestProof(withScriptedReplyFacts(p, "project", facts))).toBe(JSON.stringify(p));
    }
  });
  it.each([null, "broken", [{}], [{ ...facts[0], taskMade: -1 }], [{ ...facts[0], counted: Infinity }], [facts[0], facts[0]], [{ ...facts[0], injected: "private" }]].map((bad) => [bad]))("fails closed on malformed facts %j", (bad) => {
    expect(withScriptedReplyFacts(proof(), "project", bad as never).scriptedReplies).toEqual([
      { checkId: "readiness:0", taskMade: 1, counted: 0 }, { checkId: "readiness:2", taskMade: 1, counted: 0 },
    ]);
  });
  it("retains markers when labels and items shrink, with no unmappable fact ids", () => {
    const p = proof();
    p.items = Array.from({ length: 200 }, (_, id) => ({ ...p.items[0]!, checkId: `readiness:${String(id)}`, label: "界".repeat(1024), granularity: "test", test: "界".repeat(500) }));
    const added = withScriptedReplyFacts(p, "project", "unknown");
    // Exercise the existing label/name shrinking with the largest allowed weakening section.
    added.weakening = Array.from({ length: 40 }, (_, id) => ({ checkId: `readiness:${String(id)}`, skippedBefore: 0, skippedAfter: 0, absentOnNewCount: 100, absentOnNew: Array.from({ length: 100 }, () => "界".repeat(500)) }));
    const bytes = serializeTestProof(added);
    const read = TestProofWriteSchema.parse(JSON.parse(bytes));
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(200 * 1024);
    expect(read.scriptedReplies?.length).toBeGreaterThan(0);
    expect(read.items.length).toBeLessThan(200);
    const ids = new Set(read.items.map((item) => item.checkId));
    expect(read.scriptedReplies?.every((entry) => ids.has(entry.checkId) && entry.taskMade === 1)).toBe(true);
  });
    it("collector snapshots candidate facts synchronously and ignores later rerun facts", () => {
    const collector = modelHelperReplyCollector();
    let delivered = 0;
    const plan = collector.wrap({ blockList: [], start: async () => undefined, onResult: () => { delivered++; } })!;
    const result = { summary: undefined, evidence: { result: "ran" as const, lines: [], countsTowardProof: 0, escapedHosts: [] }, scriptedReplies: facts };
    plan.onResult(result);
    const candidate = collector.take();
    plan.onResult({ ...result, scriptedReplies: "unknown" });
    expect(withScriptedReplyFacts(proof(), "project", candidate).scriptedReplies).toEqual([facts[0], facts[2]]);
    expect(collector.take()).toBe("unknown");
    expect(collector.take()).toBeUndefined();
    expect(delivered).toBe(2);
    expect(collector.wrap(undefined)).toBeUndefined();
  });
});

it("refuses oversized or invalid runtime proof data with fixed words and no leaked label", () => {
  let failure = "";
  // The refusal grows no faster than the label: 32,000, then 256,000 characters (the 8N input stays at or under 256 KiB so it stays in CPU cache). The 1 MiB label is refused once, un-timed.
  const refuseLabel = (size: number) => {
    const p = proof();
    p.items[0]!.label = `${"sk"}-${"private".repeat(8)}${"x".repeat(size)}`;
    return () => { try { withScriptedReplyFacts(p, "project", facts); failure = "no refusal"; } catch (error) { failure = error instanceof Error ? error.message : String(error); } };
  };
  expectLinearScaling(refuseLabel, { n: 32_000, label: "refusing an oversized proof label" });
  refuseLabel(1024 * 1024)();
  expect(failure).toMatch(/^unsupported scripted reply facts$/u);
  const tooMany = Array.from({ length: 201 }, (_, i) => ({ checkId: `readiness:${String(i)}`, taskMade: 0, counted: 0 }));
  expect(withScriptedReplyFacts(proof(), "project", tooMany).scriptedReplies?.every((entry) => entry.taskMade === 1)).toBe(true);
});
