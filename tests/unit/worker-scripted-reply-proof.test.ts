import { describe, expect, it } from "vitest";
import { TestProofSchema, TestProofWriteSchema, type TestProof } from "../../packages/contracts/src/index.js";
import { serializeTestProof, withScriptedReplyFacts } from "../../packages/worker/src/verification/test-proof.js";
import { modelHelperReplyCollector } from "../../packages/worker/src/model-helper-round.js";
import { buildProofTable } from "../../packages/broker/src/core/proof/proof-table.js";
import { loadProofContext } from "../../packages/broker/src/core/proof/proof-inputs.js";
import { loadTestProof } from "../../packages/broker/src/core/proof/test-proof-reader.js";

const digest = "a".repeat(64);
const proof = (): TestProof => ({ schemaVersion: 1, candidateDigest: digest, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, items: [0, 2].map((id) => ({ checkId: `readiness:${String(id)}`, label: "Tests", granularity: "check", verdict: "proves_change", reason: "assertion_failed_on_old" })), durationMs: 0 });
const facts = [{ checkId: "readiness:0", taskMade: 2, counted: 1 }, { checkId: "readiness:1", taskMade: 8, counted: 0 }, { checkId: "readiness:2", taskMade: 0, counted: 2 }];

describe("reply facts in the saved proof", () => {
  it("writes only item ids, uniquely, and round-trips through strict writer and reader", () => {
    const before = proof();
    before.items.push({ ...before.items[0]!, granularity: "test", test: "another test" });
    const added = withScriptedReplyFacts(before, "project", facts);
    expect(added.scriptedReplies).toEqual([facts[0], facts[2]]);
    const bytes = serializeTestProof(added);
    expect(TestProofWriteSchema.parse(JSON.parse(bytes))).toEqual(added);
    expect(TestProofSchema.parse(JSON.parse(bytes))).toEqual(added);
    expect(before.scriptedReplies).toBeUndefined();
  });
  it("unknown means at least one task-made reply for EVERY item id, including skipped checks", () => {
    expect(withScriptedReplyFacts(proof(), "project", "unknown").scriptedReplies).toEqual([
      { checkId: "readiness:0", taskMade: 1, counted: 0 }, { checkId: "readiness:2", taskMade: 1, counted: 0 },
    ]);
  });
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
  it("writes zero-use entries explicitly", () => {
    const zero = [{ checkId: "readiness:0", taskMade: 0, counted: 0 }];
    expect(serializeTestProof(withScriptedReplyFacts(proof(), "project", zero))).toBe(JSON.stringify({ ...proof(), scriptedReplies: zero }));
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
  it("the broker reads written facts and refuses the WHOLE damaged proof rather than reviving an older one", async () => {
    const input = proof();
    input.items.push({ ...input.items[0]!, checkId: "readiness:1" });
    const written = serializeTestProof(withScriptedReplyFacts(input, "project", facts));
    let newest = written;
    const task = { ownerKey: "owner", workspaceId: "workspace" };
    const actions = {
      operations: async () => [1, 2].map((i) => ({ id: String(i), kind: "task", status: "SUCCEEDED", createdAt: `2026-11-14T00:00:0${String(i)}.000Z` })),
      artifacts: async (_workspace: string, operation: string) => [{ name: "test-proof.json", objectKey: `private/owner/workspace/${operation}/test-proof.json` }],
      readArtifact: async (key: string) => key.includes("/2/") ? newest : serializeTestProof(proof()),
    };
    expect((await loadTestProof(actions, task, digest))?.scriptedReplies).toEqual(facts);
    const plan = { schemaVersion: 1 as const, title: "Proof", why: [], claims: [{ id: "1", text: "Fixed" }], notChanging: [], risks: [], decisions: [], checks: { proposed: [{ id: "unit", label: "Tests", command: { cwd: ".", executable: "npm", args: ["test"], timeoutSeconds: 5 } }], proves: { unit: ["1"] } } };
    const wf = { candidate: { digest }, verification: { candidateDigest: digest, results: [{ checkId: "unit", status: "PASS" }, { checkId: "unused", status: "PASS" }, { checkId: "third", status: "PASS" }] } } as never;
    const table = async () => {
      const context = await loadProofContext({ actions }, task, wf, { format: "structured", plan } as never);
      return buildProofTable({ plan, checkResults: [{ checkId: "unit", status: "PASS" }], scenarioRows: [], testProof: context?.testProof, candidateDigest: digest, recordedCheckIds: ["unit", "unused", "third"], checkDependencies: context?.checkDependencies });
    };
    newest = serializeTestProof(input);
    expect((await table()).rows[0]?.evidence[0]?.state).toBe("proven");
    newest = written;
    expect((await table()).rows[0]?.evidence[0]).toMatchObject({ state: "passed", notProvenReason: "agent_replies_unconfirmed" });
    newest = JSON.stringify({ ...TestProofSchema.parse(JSON.parse(written)), scriptedReplies: "damaged" });
    expect(await loadTestProof(actions, task, digest)).toBeUndefined();
    expect((await table()).rows[0]?.evidence[0]?.state).toBe("passed");
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

it("the collector preserves the required result consumer and owns its facts before forwarding", () => {
  const collector = modelHelperReplyCollector();
  const input = [{ checkId: "readiness:0", taskMade: 2, counted: 0 }];
  const wrapped = collector.wrap({ blockList: [], start: async () => undefined, onResult: () => { input[0]!.taskMade = 0; } })!;
  wrapped.onResult({ summary: undefined, evidence: { result: "ran", lines: [], countsTowardProof: 0, escapedHosts: [] }, scriptedReplies: input });
  expect(collector.take()).toEqual([{ checkId: "readiness:0", taskMade: 2, counted: 0 }]);
  const noSink = { blockList: [], start: async () => undefined };
  expect(collector.wrap(noSink as never)).toBe(noSink);
});

it("refuses oversized or invalid runtime proof data with fixed words and no leaked label", () => {
  const p = proof();
  p.items[0]!.label = `${"sk"}-${"private".repeat(8)}${"x".repeat(1024 * 1024)}`;
  const began = performance.now();
  expect(() => withScriptedReplyFacts(p, "project", facts)).toThrow(/^unsupported scripted reply facts$/u);
  expect(performance.now() - began).toBeLessThan(1000);
  const tooMany = Array.from({ length: 201 }, (_, i) => ({ checkId: `readiness:${String(i)}`, taskMade: 0, counted: 0 }));
  expect(withScriptedReplyFacts(proof(), "project", tooMany).scriptedReplies?.every((entry) => entry.taskMade === 1)).toBe(true);
});
