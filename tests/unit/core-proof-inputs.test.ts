// Playbook P1/P3 (final review I2): reading the Proof section's inputs must stay cheap. The task's operations are passed in, not read again; the newest operations' artifact listings are read together;
// no listing is made for a task with no checks recorded for the current code; and a slow read inside the PR-feedback rewrite replaces an old Proof table with a one-line marker.
import { describe, expect, it, vi } from "vitest";
import type { PlanDocument, TestProof } from "../../packages/contracts/src/index.js";
import { loadProofContext } from "../../packages/broker/src/core/proof/proof-inputs.js";
import { loadTestProof } from "../../packages/broker/src/core/proof/test-proof-reader.js";
import { hadProofSection, proofReadLimitMs, withinTime } from "../../packages/broker/src/core/proof/proof-keep.js";
import { proofSection } from "../../packages/broker/src/core/proof/proof-section.js";

const DIGEST = "1".repeat(64);
const task = { ownerKey: "owner-key", workspaceId: "ws-1" };
const key = (operationId: string) => `private/owner-key/ws-1/${operationId}/test-proof.json`;
const proof = (digest = DIGEST): TestProof => ({
  schemaVersion: 1, candidateDigest: digest, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 },
  items: [{ checkId: "unit", label: "Unit tests", granularity: "check", verdict: "proves_change", reason: "assertion_failed_on_old" }], durationMs: 1,
});
const operation = (index: number) => ({ id: `op-${index}`, kind: "task", status: "SUCCEEDED", createdAt: `2026-10-27T10:00:0${index}.000Z` });
const plan: PlanDocument = {
  schemaVersion: 1, title: "Retry", why: [{ text: "Payments are dropped.", author: "Priya" }], claims: [{ id: "1", text: "Payments are retried." }], notChanging: [], risks: [], decisions: [],
  checks: { proposed: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], proves: { unit: ["1"] } },
};
const approved = { format: "structured", plan, markdown: "", artifact: {} } as never;
/** A workflow as the loader reads it: checks recorded for the candidate or not. */
const workflow = (verified: boolean, extra: Record<string, unknown> = {}) => ({ candidate: { digest: DIGEST }, ...(verified ? { verification: { candidateDigest: DIGEST } } : {}), ...extra }) as never;

function actionsOf(options: { operations?: unknown[]; stored?: Record<string, string> } = {}) {
  const stored = options.stored ?? {};
  let inFlight = 0;
  const counts = { operations: 0, artifacts: 0, maxInFlight: 0 };
  return {
    counts,
    actions: {
      operations: async () => { counts.operations += 1; return (options.operations ?? [operation(1)]) as never; },
      artifacts: async (_workspaceId: string, operationId: string) => {
        counts.artifacts += 1;
        inFlight += 1;
        counts.maxInFlight = Math.max(counts.maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return stored[key(operationId)] === undefined ? [] : [{ name: "test-proof.json", objectKey: key(operationId) }];
      },
      readArtifact: async (objectKey: string) => { const text = stored[objectKey]; if (text === undefined) throw new Error("missing"); return text; },
    },
  };
}

describe("loadTestProof", () => {
  it("lists the newest operations' artifacts together, not one after the other, and still prefers the newest proof", async () => {
    const operations = [1, 2, 3, 4, 5, 6].map(operation);
    const newer = { ...proof(), durationMs: 2 };
    const t = actionsOf({ operations, stored: { [key("op-2")]: JSON.stringify(proof()), [key("op-5")]: JSON.stringify(newer) } });
    expect(await loadTestProof(t.actions, task, DIGEST)).toEqual(newer);
    expect(t.counts.artifacts).toBe(6);
    expect(t.counts.maxInFlight).toBe(6);
  });

  it("does not read the operations again when the caller passes them", async () => {
    const t = actionsOf({ stored: { [key("op-1")]: JSON.stringify(proof()) } });
    expect(await loadTestProof(t.actions, task, DIGEST, [operation(1)])).toEqual(proof());
    expect(t.counts.operations).toBe(0);
  });
});

describe("loadProofContext", () => {
  it("uses the operations it is given and reads none of its own", async () => {
    const t = actionsOf();
    const scenarioResults = vi.fn(async () => ({ scenarios: [] }) as never);
    const context = await loadProofContext({ actions: t.actions, scenarioResults }, task, workflow(true, { e2e: { required: true } }), approved, [operation(1)] as never);
    expect(context?.plan).toBe(plan);
    expect(t.counts.operations).toBe(0);
    expect(scenarioResults).toHaveBeenCalledTimes(1);
  });

  it("lists no artifacts for a task with no checks recorded for the current code (no test proof can matter), and still gives the plan", async () => {
    const t = actionsOf({ stored: { [key("op-1")]: JSON.stringify(proof()) } });
    const none = await loadProofContext({ actions: t.actions }, task, workflow(false), approved, [operation(1)] as never);
    expect(none).toEqual({ plan });
    const other = await loadProofContext({ actions: t.actions }, task, { candidate: { digest: DIGEST }, verification: { candidateDigest: "2".repeat(64) } } as never, approved, [operation(1)] as never);
    expect(other).toEqual({ plan });
    expect(t.counts.artifacts).toBe(0);
    // With checks recorded for this code, the proof is read.
    const verified = await loadProofContext({ actions: t.actions }, task, workflow(true), approved, [operation(1)] as never);
    expect(verified?.testProof).toEqual(proof());
    expect(t.counts.artifacts).toBe(1);
  });

  it("reads the test proof and the browser/API rows together", async () => {
    const order: string[] = [];
    const slow = async <T,>(name: string, value: T) => { order.push(`${name}:start`); await new Promise((resolve) => setTimeout(resolve, 20)); order.push(`${name}:end`); return value; };
    const actions = { operations: async () => [] as never, artifacts: () => slow("artifacts", []), readArtifact: async () => "" };
    await loadProofContext({ actions, scenarioResults: () => slow("scenarios", { scenarios: [] } as never) }, task, workflow(true, { e2e: { required: true } }), approved, [operation(1)] as never);
    expect(order.slice(0, 2).sort()).toEqual(["artifacts:start", "scenarios:start"]);
  });
});

describe("withinTime", () => {
  it("gives the value when it answers in time, and done: false when it is slow or fails (never rejecting)", async () => {
    expect(await withinTime(200, async () => 7)).toEqual({ done: true, value: 7 });
    expect(await withinTime(10, () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 300)))).toEqual({ done: false });
    expect(await withinTime(200, async () => { throw new Error("down"); })).toEqual({ done: false });
  });

  it("gives the Proof section a third of the update's time, at most a second and a half", () => {
    expect(proofReadLimitMs(5_000)).toBe(1_500);
    expect(proofReadLimitMs(3_000)).toBe(1_000);
    expect(proofReadLimitMs(50)).toBe(16);
  });
});

describe("hadProofSection", () => {
  const START = "<!-- rovara:checks-and-reviews -->";
  const END = "<!-- /rovara:checks-and-reviews -->";
  const block = ["## Tests", "- Checks: 1 passed", "", "### Proof", "", "| Requirement | Evidence | Result |", "| --- | --- | --- |", "| 1: Retried | none | ⚠ not tested |", "", "## Reviews", "- ok"];
  const body = (eol = "\n", lines = block) => `A note.\n\n${START}${eol}${lines.join(eol)}${eol}${END}\nRovara session: x`;

  it("is true when the marked block has a Proof section, whatever its size", () => {
    expect(hadProofSection(body())).toBe(true);
    expect(hadProofSection(body("\r\n"))).toBe(true);
    expect(hadProofSection(body("\n", ["### Proof", ...Array.from({ length: 500 }, (_, index) => `line ${index}`), "## Reviews"]))).toBe(true);
  });

  it("is false when there is no Proof section in the block, or the markers are not exactly one pair in order", () => {
    expect(hadProofSection(body("\n", block.filter((line) => line !== "### Proof")))).toBe(false);
    expect(hadProofSection("no markers\n### Proof\n")).toBe(false);
    expect(hadProofSection(`${body()}\n${START}`)).toBe(false);
    expect(hadProofSection(`${END}\n### Proof\n${START}`)).toBe(false);
    // Text outside the block is not the block's.
    expect(hadProofSection(`### Proof\nA person's own words\n\n${START}\n## Tests\n${END}`)).toBe(false);
  });

  it("is the marker the section shows when the inputs could not be read, at every size level, with no table", () => {
    const section = proofSection({} as never, { stale: true })!;
    for (let level = 0; level <= 4; level += 1) expect(section(level)).toEqual(["### Proof", "", "Proof is being updated for the latest change."]);
  });
});

describe("192a injected real-model input", () => {
  const run = { schemaVersion: 1 as const, candidateDigest: DIGEST, items: [{ checkId: "readiness:0", result: "passed" as const }] };
  const scripted = { ...proof(), items: [{ ...proof().items[0]!, checkId: "readiness:0" }], scriptedReplies: [{ checkId: "readiness:0", taskMade: 1, counted: 0 }] };
  const wf = () => ({ candidate: { digest: DIGEST }, verification: { candidateDigest: DIGEST, results: [{ checkId: "unit", status: "PASS" }] } }) as never;
  it("reads once and maps worker readiness ids through recorded order", async () => {
    const t = actionsOf({ stored: { [key("op-1")]: JSON.stringify(scripted) } });
    const realModelRun = vi.fn(async () => run);
    const context = await loadProofContext({ actions: t.actions, realModelRun }, task, wf(), approved, [operation(1)] as never);
    expect(context?.checkDependencies?.get("unit")).toEqual([{ dependencyId: "scripted_replies", trust: "simulated", replies: "task_made" }]);
    expect(context?.realModelRun).toEqual(run);
    expect(realModelRun).toHaveBeenCalledExactlyOnceWith(DIGEST);
    expect(t.counts.operations).toBe(0);
    expect(t.counts.artifacts).toBe(1);
  });
  it("does not invoke the reader without current checks or a plan", async () => {
    const t = actionsOf();
    const realModelRun = vi.fn(async () => run);
    await loadProofContext({ actions: t.actions, realModelRun }, task, workflow(false), approved);
    await loadProofContext({ actions: t.actions, realModelRun }, task, wf(), undefined);
    expect(realModelRun).not.toHaveBeenCalled();
  });
  it("reader faults, malformed and stale runs leave only unconfirmed facts with no leaked cause", async () => {
    const secret = `gh${"p"}_${"x".repeat(36)}`;
    for (const reader of [async () => { throw new Error(secret); }, async () => ({ ...run, candidateDigest: "2".repeat(64) }), async () => ({ ...run, items: secret }) as never]) {
      const t = actionsOf({ stored: { [key("op-1")]: JSON.stringify(scripted) } });
      const context = await loadProofContext({ actions: t.actions, realModelRun: reader }, task, wf(), approved, [operation(1)] as never);
      expect(context?.realModelRun).toBeUndefined();
      expect(context?.checkDependencies?.get("unit")?.[0]?.replies).toBe("task_made");
      expect(JSON.stringify(context)).not.toContain(secret);
    }
  });
  it("times out through the existing guard and ignores a late read result", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: typeof run) => void;
      const pending = loadProofContext({ actions: actionsOf().actions, realModelRun: () => new Promise((resolve) => { finish = resolve; }) }, task, wf(), approved, []);
      await vi.advanceTimersByTimeAsync(1_501);
      const context = await pending;
      expect(context?.realModelRun).toBeUndefined();
      finish(run);
      await Promise.resolve();
      expect(context?.realModelRun).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("a present unreadable or unmappable reply part invalidates the entire proof", async () => {
    for (const scriptedReplies of ["broken", [{ checkId: "unknown", taskMade: 1, counted: 0 }], [{ checkId: "readiness:1", taskMade: 1, counted: 0 }]]) {
      const t = actionsOf({ stored: { [key("op-1")]: JSON.stringify({ ...scripted, scriptedReplies }) } });
      const context = await loadProofContext({ actions: t.actions }, task, wf(), approved, [operation(1)] as never);
      expect(context?.testProof).toBeUndefined();
    }
  });
  it("zero task-made replies do not add provenance or change the legacy context", async () => {
    const value = { ...scripted, scriptedReplies: [{ checkId: "readiness:0", taskMade: 0, counted: 2 }] };
    const t = actionsOf({ stored: { [key("op-1")]: JSON.stringify(value) } });
    expect(await loadProofContext({ actions: t.actions }, task, wf(), approved, [operation(1)] as never)).toEqual({ plan, testProof: value });
  });
});

it("does not revive an older proof when the newest proof has unreadable reply provenance", async () => {
  const old = proof();
  const malformed = { ...old, scriptedReplies: [{ checkId: "unit", taskMade: "broken", counted: 0 }] };
  const t = actionsOf({ stored: { [key("op-1")]: JSON.stringify(old), [key("op-2")]: JSON.stringify(malformed) } });
  expect(await loadTestProof(t.actions, task, DIGEST, [operation(1), operation(2)] as never)).toBeUndefined();
});

it("keeps the legacy context byte-identical for missing and malformed root artifacts", async () => {
  for (const stored of [{}, { [key("op-1")]: "{broken" }, { [key("op-1")]: JSON.stringify({ schemaVersion: 99 }) }]) {
    const t = actionsOf({ stored });
    expect(JSON.stringify(await loadProofContext({ actions: t.actions }, task, workflow(true), approved, [operation(1)] as never))).toBe(JSON.stringify({ plan }));
  }
});

it("a synchronously throwing or non-function real-model reader is a fixed refusal", async () => {
  const secret = `gh${"p"}_${"z".repeat(36)}`;
  for (const realModelRun of [() => { throw new Error(secret); }, "unsupported" as never]) {
    const context = await loadProofContext({ actions: actionsOf().actions, realModelRun }, task, workflow(true), approved, []);
    expect(context?.realModelRun).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain(secret);
  }
});
