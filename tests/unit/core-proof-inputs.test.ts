// Playbook P1/P3 (final review I2): reading the Proof section's inputs must stay cheap. The task's operations are passed in, not read again; the newest operations' artifact listings are read together;
// no listing is made for a task with no checks recorded for the current code; and a slow read inside the PR-feedback rewrite replaces an old Proof table with a one-line marker.
import { describe, expect, it, vi } from "vitest";
import type { PlanDocument, TestProof } from "../../packages/contracts/src/index.js";
import { loadProofContext } from "../../packages/broker/src/core/proof/proof-inputs.js";
import { hadProofSection, proofReadLimitMs } from "../../packages/broker/src/core/proof/proof-keep.js";
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

describe("loadProofContext", () => {
  it("uses the operations it is given and reads none of its own", async () => {
    const t = actionsOf();
    const scenarioResults = vi.fn(async () => ({ scenarios: [] }) as never);
    const context = await loadProofContext({ actions: t.actions, scenarioResults }, task, workflow(true, { e2e: { required: true } }), approved, [operation(1)] as never);
    expect(context?.plan).toBe(plan);
    expect(t.counts.operations).toBe(0);
    expect(scenarioResults).toHaveBeenCalledTimes(1);
  });
});

describe("withinTime", () => {

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
  it("a present unreadable or unmappable reply part invalidates the entire proof", async () => {
    for (const scriptedReplies of ["broken", [{ checkId: "unknown", taskMade: 1, counted: 0 }], [{ checkId: "readiness:1", taskMade: 1, counted: 0 }]]) {
      const t = actionsOf({ stored: { [key("op-1")]: JSON.stringify({ ...scripted, scriptedReplies }) } });
      const context = await loadProofContext({ actions: t.actions }, task, wf(), approved, [operation(1)] as never);
      expect(context?.testProof).toBeUndefined();
    }
  });
  it("an independent reply (parked by DEC 192a) in a check marks it as independent: it never counts, whatever the real model says", async () => {
    const withFacts = (fact: Record<string, unknown>) => ({ ...scripted, scriptedReplies: [{ checkId: "readiness:0", taskMade: 0, counted: 0, ...fact }] });
    const independent = actionsOf({ stored: { [key("op-1")]: JSON.stringify(withFacts({ independent: 2 })) } });
    expect((await loadProofContext({ actions: independent.actions, realModelRun: async () => run }, task, wf(), approved, [operation(1)] as never))?.checkDependencies?.get("unit"))
      .toEqual([{ dependencyId: "scripted_replies", trust: "simulated", replies: "independent" }]);
    const both = actionsOf({ stored: { [key("op-1")]: JSON.stringify(withFacts({ independent: 1, taskMade: 3 })) } });
    expect((await loadProofContext({ actions: both.actions }, task, wf(), approved, [operation(1)] as never))?.checkDependencies?.get("unit"))
      .toEqual([{ dependencyId: "scripted_replies", trust: "simulated", replies: "task_made" }, { dependencyId: "scripted_replies", trust: "simulated", replies: "independent" }]);
    const zero = withFacts({ independent: 0 });
    const t = actionsOf({ stored: { [key("op-1")]: JSON.stringify(zero) } });
    expect(await loadProofContext({ actions: t.actions }, task, wf(), approved, [operation(1)] as never)).toEqual({ plan, testProof: zero });
  });
});
