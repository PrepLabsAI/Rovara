// General fakes slice 2 (DEC 234): the "Made by Rovara" label on a check RESULT reaches the places a person reads, with no test proof needed. The worker's entry carries `madeByRovara: true`; the broker keeps it
// on the recorded verification result, the proof table reads it as a `made_by_rovara` dependency (so the check is never Proven), and the pull request's checks section says so on the check's own line.
import { describe, expect, it } from "vitest";
import {
  AGENTX_PREAMBLE_VERSION, CheckEntrySchema, GENERAL_FAKE_LABEL, VerificationResultsSchema, agentxPreambleSha256, checksSection, type CheckEntry, type PlanDocument,
} from "@agentx/contracts";
import { loadProofContext } from "../../packages/broker/src/core/proof/proof-inputs.js";
import { proofCheckResults } from "../../packages/broker/src/core/proof/proof-section.js";
import { verificationResultsOf } from "../../packages/broker/src/core/build-step/check-results.js";

const DIGEST = "1".repeat(64);
const entry = (overrides: Partial<CheckEntry> = {}): CheckEntry => ({ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "ok", durationMs: 10, ...overrides });
const report = (checks: CheckEntry[]) => ({ status: "verified" as const, source: "project" as const, preambleVersion: AGENTX_PREAMBLE_VERSION, preambleSha256: agentxPreambleSha256(), checks, extraTry: "not_needed" as const, agentClaim: "success" as const });

describe("the label on the schemas", () => {
  it("an entry and a recorded result take `madeByRovara: true` and nothing else", () => {
    expect(CheckEntrySchema.safeParse(entry({ madeByRovara: true })).success).toBe(true);
    expect(CheckEntrySchema.safeParse({ ...entry(), madeByRovara: false }).success).toBe(false);
    expect(CheckEntrySchema.safeParse({ ...entry(), madeByRovara: "yes" }).success).toBe(false);
    const recorded = (result: object) => VerificationResultsSchema.safeParse({ candidateDigest: DIGEST, producer: "p", environmentId: "e", recordedAt: "2026-11-16T10:00:00.000Z", results: [{ checkId: "unit", status: "PASS", ...result }] });
    expect(recorded({ madeByRovara: true }).success).toBe(true);
    expect(recorded({ madeByRovara: false }).success).toBe(false);
    expect(recorded({}).success).toBe(true);
  });
});

describe("the pull request's checks section", () => {
  it("says on a check's own line that a Rovara-made fake answered it, and never on another line", () => {
    const section = checksSection([], report([entry({ madeByRovara: true }), entry({ id: "readiness:1", label: "npm run lint" })]));
    const lines = section.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toEqual([
      `- \`npm test\`: passed → passed, passing (${GENERAL_FAKE_LABEL}: answered by a fake Rovara made, never change proof)`,
      "- `npm run lint`: passed → passed, passing",
    ]);
  });

  it("a report with no label is exactly what it was (golden)", () => {
    expect(checksSection([], report([entry()]))).toBe(["## Checks", "", "No check that passed before this change fails now.", "", "After the last task, AgentX reran the project's checks:", "- `npm test`: passed → passed, passing"].join("\n"));
  });
});

describe("the proof table reads the recorded label", () => {
  const plan: PlanDocument = {
    schemaVersion: 1, title: "Retry", why: [{ text: "Payments drop.", author: "Priya" }], claims: [{ id: "1", text: "Payments are retried." }], notChanging: [], risks: [], decisions: [],
    checks: { proposed: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], proves: { unit: ["1"] } },
  };
  const approved = { format: "structured", plan, markdown: "", artifact: {} } as never;
  const noProof = { operations: async () => [], artifacts: async () => [], readArtifact: async () => undefined } as never;
  const workflowWith = (result: object) => ({
    candidate: { digest: DIGEST }, checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [{ id: "unit", label: "Unit tests", kind: "test", command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } }] },
    verification: { candidateDigest: DIGEST, results: [{ checkId: "unit", status: "PASS", ...result }] },
  }) as never;
  const task = { ownerKey: "owner-key", workspaceId: "ws-1" };

  it("a recorded result with the label becomes a made_by_rovara dependency, without any test proof", async () => {
    const context = await loadProofContext({ actions: noProof }, task, workflowWith({ madeByRovara: true }), approved);
    expect(context?.checkDependencies?.get("unit")).toEqual([{ dependencyId: "general_fake", trust: "made_by_rovara" }]);
    expect(proofCheckResults(workflowWith({ madeByRovara: true }))[0]).toMatchObject({ checkId: "unit", madeByRovara: true });
  });

  it("a result without the label leaves the context exactly as it was (golden)", async () => {
    const context = await loadProofContext({ actions: noProof }, task, workflowWith({}), approved);
    expect(context).toEqual({ plan });
  });

  it("the label and the test proof's own facts for the same check give one dependency, not two", async () => {
    const stored = { schemaVersion: 1, candidateDigest: DIGEST, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, durationMs: 1,
      items: [{ checkId: "readiness:0", label: "Unit tests", granularity: "check", verdict: "proves_change", reason: "assertion_failed_on_old" }], madeByRovara: [{ checkId: "readiness:0", served: 2 }] };
    const actions = { operations: async () => [{ id: "op-1", kind: "task", status: "SUCCEEDED", createdAt: "2026-11-16T10:00:00.000Z" }], artifacts: async () => [{ name: "test-proof.json", objectKey: "private/owner-key/ws-1/op-1/test-proof.json" }], readArtifact: async () => JSON.stringify(stored) } as never;
    const context = await loadProofContext({ actions }, task, workflowWith({ madeByRovara: true }), approved);
    expect(context?.testProof).toBeDefined();
    expect(context?.checkDependencies?.get("unit")).toEqual([{ dependencyId: "general_fake", trust: "made_by_rovara" }]);
  });
});

describe("the recorded results (core build step)", () => {
  const selected = [0, 1, 2, 3, 4].map((index) => ({ id: `check-${String(index)}`, command: { cwd: "repo", executable: "npm", args: ["test"] } }));
  const at = (index: number, after: CheckEntry["after"], output = "", extra: Partial<CheckEntry> = {}) => entry({ id: `readiness:${String(index)}`, after, output, exitCode: after === "passed" ? 0 : 1, ...extra });

  it("keeps the label from the worker's entry, only on that check, and every other field is as before (golden)", () => {
    const results = verificationResultsOf(selected, [at(0, "passed", "", { madeByRovara: true }), at(1, "passed"), at(2, "failed", "spawn npm ENOENT", { exitCode: null }), at(3, "failed", "spawn npm EAGAIN", { exitCode: null }), at(4, "not_run")]);
    expect(results).toEqual([
      { checkId: "check-0", status: "PASS", madeByRovara: true },
      { checkId: "check-1", status: "PASS" },
      { checkId: "check-2", status: "FAILED", programNotFound: true, broken: true },
      { checkId: "check-3", status: "FAILED", broken: true, neverStarted: true },
      { checkId: "check-4", status: "UNKNOWN" },
    ]);
  });

  it("an entry that is not a project check, or is missing, never stands in for a result and carries no label", () => {
    const results = verificationResultsOf(selected.slice(0, 2), [at(0, "passed", "", { source: "agent_commands", madeByRovara: true })]);
    expect(results).toEqual([{ checkId: "check-0", status: "UNKNOWN" }, { checkId: "check-1", status: "UNKNOWN" }]);
  });

  it("a command that could not run is broken whatever the label says", () => {
    expect(verificationResultsOf(selected.slice(0, 1), [at(0, "failed", "sh: npm: not found", { exitCode: 127, madeByRovara: true })])).toEqual([{ checkId: "check-0", status: "FAILED", broken: true, madeByRovara: true }]);
  });
});
