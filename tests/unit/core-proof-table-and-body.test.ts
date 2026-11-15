// Playbook P1: the "Proof" section of a Rovara Code (version 2) pull request description. It maps each requirement (claim) of the approved plan to its evidence: the checks whose `proves`
// names it and the browser/API scenarios `scenarioProves` names. The section is public to the repository's readers, so every word that a model, a repository or a person wrote is redacted and
// inert, and it is bounded: under size pressure the evidence text shrinks first, then the proven and passed rows, and a failed requirement or a not-tested item is never dropped.
// (Port lane L7b: the cases that went through Cloud's broker and the worker's own test-proof writer are not here; the proofs below are written out by hand in the worker's format.)
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProofTableViewSchema, type EvidenceTrustClass, type PlanDocument, type TestProof } from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { REVIEW_SAME_MODEL_NOTE } from "../../packages/broker/src/core/proof/review-model-lines.js";
import { PULL_REQUEST_BODY_MAX_BYTES } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { buildProofTable, checkIdOfProofItem, testProofLinesOf, type ProofCheckResult, type ProofScenarioRow, type ProofTableInput } from "../../packages/broker/src/core/proof/proof-table.js";
import { PROOF_LEVEL_LAST, proofSection } from "../../packages/broker/src/core/proof/proof-section.js";
import { proofTableView } from "../../packages/broker/src/core/proof/proof-view.js";
import { loadTestProof } from "../../packages/broker/src/core/proof/test-proof-reader.js";
import { workflowPullRequestBody, workflowPullRequestStatusLines } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";

/** What the worker writes for a task's checks: one item per check, `readiness:<index>`; the check at `provenIndex` is a test runner whose new test fails on the original code, the others are linters that passed. */
function workerTestProof(candidateDigest: string, provenIndex: number, checkCount = provenIndex + 1): { proof: TestProof } {
  return { proof: {
    schemaVersion: 1, candidateDigest, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 },
    items: Array.from({ length: checkCount }, (_, index) => (index === provenIndex
      ? { checkId: `readiness:${index}`, label: "retry tests", granularity: "check" as const, verdict: "proves_change" as const, reason: "assertion_failed_on_old" as const }
      : { checkId: `readiness:${index}`, label: "lint", granularity: "check" as const, verdict: "not_applicable" as const, reason: "not_a_test_check" as const })),
    durationMs: 1200,
  } };
}


const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const now = "2026-10-27T12:00:00.000Z";
const candidate = (letter: string) => createCandidateManifest([{ repositoryId: "payments", commitSha: letter.repeat(40), treeSha: letter.repeat(40), baseCommitSha: "e".repeat(40) }]);
const CODE = candidate("1");
const OTHER = candidate("2");
const command = { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 };
const check = (id: string, label: string) => ({ id, label, command });

/** The plan: claim 1 (with child 1.1), claim 2 and claim 3. Check `unit` proves 1.1, `lint` proves 2; claim 3 has no check. */
function plan(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    schemaVersion: 1,
    title: "Retry failed payments",
    why: [{ text: "Failed payments are dropped.", author: "Priya" }],
    claims: [
      { id: "1", text: "Payments that time out are retried.", children: [{ id: "1.1", text: "The retry waits longer each time." }] },
      { id: "2", text: "A payment is never charged twice." },
      { id: "3", text: "The retry count is shown on the payment page." },
    ],
    notChanging: ["The refund flow stays as it is."],
    risks: ["A slow gateway could keep a retry open."],
    decisions: [],
    checks: { proposed: [check("unit", "Unit tests"), check("lint", "Lint")], proves: { unit: ["1.1"], lint: ["2"] } },
    ...overrides,
  };
}

/** The selected checks of `workflowWith()` and these plans, in the order the worker numbers them: `readiness:0` is `unit`, `readiness:1` is `lint`. */
const SELECTED = ["unit", "lint"];
const passing = (...ids: string[]): ProofCheckResult[] => ids.map((checkId) => ({ checkId, status: "PASS" }));
function proofFor(digest: string, verdict: TestProof["items"][number]["verdict"] = "proves_change"): TestProof {
  // As the worker writes it: one item per selected check, `readiness:<index>` (unit is index 0 and the test runner; lint is index 1 and not a test runner).
  return {
    schemaVersion: 1, candidateDigest: digest, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 },
    items: [
      { checkId: "readiness:0", label: "Unit tests", granularity: "check", verdict, reason: verdict === "proves_change" ? "assertion_failed_on_old" : "passed_on_old" },
      { checkId: "readiness:1", label: "Lint", granularity: "check", verdict: "not_applicable", reason: "not_a_test_check" },
    ], durationMs: 1200,
  };
}
const rowOf = (table: ReturnType<typeof buildProofTable>, claimId: string) => table.rows.find((row) => row.claimId === claimId)!;

describe("mock provenance in the proof", () => {
  const dependencies = (trust: EvidenceTrustClass, checkId = "unit") => new Map([[checkId, [{ dependencyId: "payments", trust }]]]);
  const input = (overrides: Partial<ProofTableInput> = {}): ProofTableInput => ({
    plan: plan(), checkResults: passing("unit", "lint"), scenarioRows: [], testProof: proofFor(CODE.digest), candidateDigest: CODE.digest, recordedCheckIds: SELECTED, ...overrides,
  });
  const golden = {
    rows: [
      { claimId: "1", requirement: "Payments that time out are retried.", evidence: [{ kind: "check", label: "Unit tests", state: "proven" }], result: "proven" },
      { claimId: "1.1", requirement: "The retry waits longer each time.", evidence: [{ kind: "check", label: "Unit tests", state: "proven" }], result: "proven" },
      { claimId: "2", requirement: "A payment is never charged twice.", evidence: [{ kind: "check", label: "Lint", state: "passed" }], result: "passed" },
      { claimId: "3", requirement: "The retry count is shown on the payment page.", evidence: [], result: "not_tested" },
    ],
    notTested: [{ kind: "claim", id: "3", text: "The retry count is shown on the payment page.", reason: "no check or scenario names it" }],
  };

  it("keeps the complete legacy table byte-for-byte when provenance is absent, empty or for an unrelated check", () => {
    for (const checkDependencies of [undefined, new Map(), new Map([["unit", []]]), dependencies("made_by_rovara", "unrelated")]) {
      expect(JSON.stringify(buildProofTable(input({ checkDependencies })))).toBe(JSON.stringify(golden));
    }
  });

  it.each(["real", "recorded", "simulated", "no_outside_calls"] as const)("keeps %s dependencies eligible for Proven", (trust) => {
    expect(buildProofTable(input({ checkDependencies: dependencies(trust) }))).toEqual(golden);
  });

  it("keeps an explicitly Rovara-mock-dependent pass passed, with the reason, including its parent claim", () => {
    const table = buildProofTable(input({ checkDependencies: dependencies("made_by_rovara") }));
    for (const id of ["1", "1.1"]) {
      expect(rowOf(table, id)).toMatchObject({ result: "passed", evidence: [{ state: "passed", label: "with a Rovara-made mock; not Proven: Unit tests" }] });
    }
    expect(table.notTested).toEqual(golden.notTested);
    expect(rowOf(table, "2")).toEqual(golden.rows[2]);
  });

  it("any Rovara-made dependency blocks only its own check, even after a real dependency", () => {
    const checkDependencies = new Map([
      ["unit", [{ dependencyId: "real-db", trust: "real" as const }, { dependencyId: "payments", trust: "made_by_rovara" as const }]],
      ["lint", [{ dependencyId: "recording", trust: "recorded" as const }]],
    ]);
    const proof = proofFor(CODE.digest);
    proof.items[1] = { ...proof.items[0]!, checkId: "readiness:1" };
    const table = buildProofTable(input({ checkDependencies, testProof: proof }));
    expect(rowOf(table, "1.1").result).toBe("passed");
    expect(rowOf(table, "2")).toMatchObject({ result: "proven", evidence: [{ label: "Lint", state: "proven" }] });
  });

  it("maps per-test proofs through recorded check ids, not readiness ids or the current plan order", () => {
    const proof = proofFor(CODE.digest);
    proof.items = [{ ...proof.items[0]!, checkId: "readiness:1", granularity: "test", test: "retries" }, { ...proof.items[1]!, checkId: "readiness:0" }];
    const table = buildProofTable(input({ testProof: proof, recordedCheckIds: ["lint", "unit"], checkDependencies: dependencies("made_by_rovara") }));
    expect(rowOf(table, "1.1").result).toBe("passed");
    expect(rowOf(table, "1.1").evidence[0]?.label).toContain("not Proven");
  });

  it.each([
    { status: "FAILED", expected: "failed" },
    { status: "UNKNOWN", expected: "not_checked" },
    { status: "PASS", couldNotRun: true, expected: "not_checked" },
  ] as const)("does not relabel $status / $expected as a passing mock check", ({ expected, ...result }) => {
    const table = buildProofTable(input({ checkResults: [{ checkId: "unit", ...result }], checkDependencies: dependencies("made_by_rovara") }));
    expect(rowOf(table, "1.1").evidence).toEqual([{ kind: "check", label: "Unit tests", state: expected }]);
  });

  it.each([undefined, proofFor(OTHER.digest)])("labels the passing mock check even without a bound proof (%j)", (testProof) => {
    const table = buildProofTable(input({ testProof, checkDependencies: dependencies("made_by_rovara") }));
    expect(rowOf(table, "1.1")).toMatchObject({ result: "passed", evidence: [{ state: "passed", label: "with a Rovara-made mock; not Proven: Unit tests" }] });
  });

  it("preserves the existing PR section and task view when provenance is absent or empty", () => {
    const workflow = workflowWith();
    const context = { plan: plan(), testProof: proofFor(CODE.digest) };
    for (const checkDependencies of [undefined, new Map(), dependencies("real")]) {
      const next = { ...context, checkDependencies };
      for (let level = 0; level <= PROOF_LEVEL_LAST; level += 1) expect(proofSection(workflow, next)!(level)).toEqual(proofSection(workflow, context)!(level));
      expect(proofTableView(workflow, next)).toEqual(proofTableView(workflow, context));
    }
  });

  it("explains the exclusion in the PR at every shrink level and on the task page", () => {
    const workflow = workflowWith();
    const context = { plan: plan(), testProof: proofFor(CODE.digest), checkDependencies: dependencies("made_by_rovara") };
    const section = proofSection(workflow, context)!;
    for (let level = 0; level <= PROOF_LEVEL_LAST; level += 1) {
      const text = section(level).join("\n");
      expect(text).toContain("Checks passing with a Rovara-made mock are not Proven.");
      expect(text).not.toContain("✅ proven");
    }
    expect(section(0).join("\n")).toContain("with a Rovara-made mock; not Proven: Unit tests (passed)");
    const view = ProofTableViewSchema.parse(proofTableView(workflow, context));
    expect(view.rows.find((row) => row.claimId === "1.1")).toMatchObject({ result: "passed", evidence: [{ label: "with a Rovara-made mock; not Proven: Unit tests", state: "passed" }] });
  });

  it("keeps labels inert and bounded, never renders dependency ids, and retains the reason on long labels", () => {
    const hostile = "[nested [link]](https://evil.example) ![image][ref]\n[ref]: https://evil.example\n@team #123 <img>\n# heading\n> quote\n---\n```\n~~~\n\u200b\u202e\ufe0f";
    const context = {
      plan: plan({ checks: { proposed: [check("unit", hostile + "x".repeat(1_048_576))], proves: { unit: ["1.1"] } } }),
      testProof: proofFor(CODE.digest), checkDependencies: new Map([["unit", [{ dependencyId: "NEVER-RENDER-THIS " + hostile, trust: "made_by_rovara" as const }]]]),
    };
    const table = buildProofTable(input(context));
    const label = rowOf(table, "1.1").evidence[0]!.label;
    expect(label).toMatch(/^with a Rovara-made mock; not Proven: /u);
    expect(Array.from(label).length).toBeLessThanOrEqual(120);
    expect(label).not.toMatch(/\]\(|!\[|@team|#123|<img>|[\r\n\u200b\u202e]|\ufe0f/u);
    const section = proofSection(workflowWith(), context)!;
    for (let level = 0; level <= PROOF_LEVEL_LAST; level += 1) {
      expect(section(level).join("\n")).toContain("Checks passing with a Rovara-made mock are not Proven.");
      expect(section(level).join("\n")).not.toContain("NEVER-RENDER-THIS");
    }
    expect(ProofTableViewSchema.safeParse(proofTableView(workflowWith(), context)).success).toBe(true);
  });

  it("qualifies the Tests summary only for a proving item mapped to an explicit Rovara-made dependency", () => {
    const legacy = ["Test proof: 1 check fails on the original code and passes now"];
    const proof = proofFor(CODE.digest);
    for (const checkDependencies of [undefined, new Map(), dependencies("real"), dependencies("recorded"), dependencies("simulated"), dependencies("no_outside_calls"), dependencies("made_by_rovara", "lint")]) {
      expect(testProofLinesOf(proof, CODE.digest, { recordedCheckIds: SELECTED, checkDependencies })).toEqual(legacy);
    }
    const mixed = new Map([["unit", [{ dependencyId: "real-db", trust: "real" as const }, { dependencyId: "payments", trust: "made_by_rovara" as const }]]]);
    expect(testProofLinesOf(proof, CODE.digest, { checkDependencies: mixed })).toEqual(legacy);
    const provenance = { recordedCheckIds: ["lint", "unit"], checkDependencies: mixed };
    expect(testProofLinesOf(proof, CODE.digest, provenance)).toEqual(legacy);
    proof.items[0]!.checkId = "readiness:1";
    proof.items[1]!.checkId = "readiness:0";
    const qualified = testProofLinesOf(proof, CODE.digest, provenance);
    expect(qualified).toEqual(["with a Rovara-made mock; not Proven: Test proof: 1 check fails on the original code and passes now"]);
    expect(testProofLinesOf(proof, OTHER.digest, provenance)).toEqual([]);
    expect(testProofLinesOf(proofFor(CODE.digest, "does_not_prove"), CODE.digest, { ...provenance, recordedCheckIds: SELECTED }).join("\n")).not.toContain("with a Rovara-made mock");
  });

  it.each([false, true])("qualifies Tests lines in both PR layouts, including supplied lines and status rewrites (testing=%s)", (useTesting) => {
    const context = { plan: plan(), testProof: proofFor(CODE.digest), checkDependencies: dependencies("made_by_rovara") };
    const testing = useTesting ? { schemaVersion: 1, result: "verified", rows: [{ label: "Unit tests", command: "npm test", status: "passed" }], reasons: [] } : undefined;
    for (const proofLines of [undefined, ["Test proof: 1 check fails on the original code and passes now"]]) {
      const extra = { testing, proofLines };
      for (const body of [bodyOf(context, workflowWith(), extra), workflowPullRequestStatusLines(workflowWith(), { proof: context, ...extra } as never).join("\n")]) {
        const line = body.split("\n").find((line) => line.includes("Test proof:"));
        expect(line).toContain("with a Rovara-made mock; not Proven");
        expect(line).toContain("fails on the original code");
      }
    }
  });

  it("qualifies the task page Tests summary", () => {
    const view = ProofTableViewSchema.parse(proofTableView(workflowWith(), { plan: plan(), testProof: proofFor(CODE.digest), checkDependencies: dependencies("made_by_rovara") }));
    expect(view.testProofLines.find((line) => line.includes("fails on the original code"))).toContain("with a Rovara-made mock; not Proven");
  });

  it("keeps the check name visible at shrink level one by shortening the mock prefix", () => {
    const lines = proofSection(workflowWith(), { plan: plan(), checkDependencies: dependencies("made_by_rovara") })!(1);
    expect(lines.find((line) => line.startsWith("| 1.1:"))).toContain("Rovara mock: Unit tests (passed)");
  });

  it("explains a mock row beyond the task page's 50-row cut even without test proof", () => {
    const largePlan = plan({ claims: Array.from({ length: 51 }, (_, i) => ({ id: String(i + 1), text: `Requirement ${i + 1}` })), checks: { proposed: [check("unit", "Unit tests")], proves: { unit: ["51"] } } });
    const view = ProofTableViewSchema.parse(proofTableView(workflowWith(), { plan: largePlan, checkDependencies: dependencies("made_by_rovara") }));
    expect(view.rows).toHaveLength(50);
    expect(view.rows.flatMap((row) => row.evidence)).toEqual([]);
    expect(view.testProofLines).toContain("Checks passing with a Rovara-made mock are not Proven.");
    expect(proofTableView(workflowWith(), { plan: largePlan })?.testProofLines).toEqual([]);
  });
});

describe("buildProofTable", () => {
  it("a claim whose linked check has a proves_change test proof is proven", () => {
    const table = buildProofTable({ plan: plan(), checkResults: passing("unit", "lint"), scenarioRows: [], testProof: proofFor(CODE.digest), candidateDigest: CODE.digest, recordedCheckIds: SELECTED });
    expect(rowOf(table, "1.1").result).toBe("proven");
    expect(rowOf(table, "2").result).toBe("passed");
    // The lines themselves live in the Tests section (the description) and on the task page's proof block; the table only uses the verdicts.
    expect(table).not.toHaveProperty("testProofLines");
  });

  it("a test proof bound to another candidate digest is ignored, as if it were absent", () => {
    const stale = buildProofTable({ plan: plan(), checkResults: passing("unit", "lint"), scenarioRows: [], testProof: proofFor(OTHER.digest), candidateDigest: CODE.digest, recordedCheckIds: SELECTED });
    const absent = buildProofTable({ plan: plan(), checkResults: passing("unit", "lint"), scenarioRows: [], testProof: undefined, candidateDigest: CODE.digest });
    expect(stale).toEqual(absent);
    expect(rowOf(stale, "1.1").result).toBe("passed");
    // No current digest at all: nothing can be bound to it.
    expect(rowOf(buildProofTable({ plan: plan(), checkResults: passing("unit"), scenarioRows: [], testProof: proofFor(CODE.digest), candidateDigest: undefined, recordedCheckIds: SELECTED }), "1.1").result).toBe("passed");
  });

  it("a parent claim is covered by the checks of its children, and a claim no check names is not tested", () => {
    const table = buildProofTable({ plan: plan(), checkResults: passing("unit", "lint"), scenarioRows: [], testProof: undefined, candidateDigest: CODE.digest });
    expect(rowOf(table, "1").result).toBe("passed");
    expect(rowOf(table, "3")).toMatchObject({ result: "not_tested", evidence: [] });
    expect(table.notTested.map((item) => [item.kind, item.id])).toContainEqual(["claim", "3"]);
  });

  it("a failed linked check makes the claim failed, even beside a proves_change one", () => {
    const table = buildProofTable({
      plan: plan({ checks: { proposed: [check("unit", "Unit tests"), check("lint", "Lint")], proves: { unit: ["2"], lint: ["2"] } } }),
      checkResults: [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "FAILED" }], scenarioRows: [],
      testProof: proofFor(CODE.digest), candidateDigest: CODE.digest, recordedCheckIds: SELECTED,
    });
    expect(rowOf(table, "2").result).toBe("failed");
  });

  it("a claim whose every linked check did not run, or has no result, is not tested, and the check is listed", () => {
    const table = buildProofTable({
      plan: plan(), scenarioRows: [], testProof: undefined, candidateDigest: CODE.digest,
      checkResults: [{ checkId: "unit", status: "UNKNOWN" }, { checkId: "lint", status: "FAILED", couldNotRun: true }],
    });
    expect(rowOf(table, "1.1").result).toBe("not_tested");
    expect(rowOf(table, "2").result).toBe("not_tested");
    const checks = table.notTested.filter((item) => item.kind === "check").map((item) => item.id).sort();
    expect(checks).toEqual(["lint", "unit"]);
    // No result at all for a proposed check reads the same.
    const none = buildProofTable({ plan: plan(), checkResults: [], scenarioRows: [], testProof: undefined, candidateDigest: CODE.digest });
    expect(rowOf(none, "2").result).toBe("not_tested");
  });

  it("a claim proved only by checks that read files (the plan self-check's claim-static-only finding) is not tested", () => {
    const reader = { id: "grep", label: "Grep for the flag", command: { cwd: "repo/payments", executable: "grep", args: ["-q", "retry", "src/charge.ts"], timeoutSeconds: 30 } };
    const table = buildProofTable({
      plan: plan({ checks: { proposed: [reader, check("unit", "Unit tests")], proves: { grep: ["2"], unit: ["1.1"] } } }),
      checkResults: passing("grep", "unit"), scenarioRows: [], testProof: undefined, candidateDigest: CODE.digest,
    });
    expect(rowOf(table, "2")).toMatchObject({ result: "not_tested" });
    expect(rowOf(table, "2").evidence).toHaveLength(1);
    expect(table.notTested.find((item) => item.id === "2")?.reason).toMatch(/read files/);
    expect(rowOf(table, "1.1").result).toBe("passed");
  });

  it("scenarios count through scenarioProves: a passed row proves the claim, a failed one fails it, a missing or unknown one is listed as not exercised", () => {
    const withScenarios = plan({
      checks: { proposed: [], proves: {}, noneReason: "no unit tests apply" },
      scenarioProves: { "checkout-flow": ["1.1"], "retry-count": ["3"], "refund-flow": ["2"], "never-ran": ["1.1"] },
    });
    const rows: ProofScenarioRow[] = [
      { scenarioId: "checkout-flow", title: "Checkout flow", kind: "web", status: "PASSED" },
      { scenarioId: "retry-count", title: "Retry count", kind: "web", status: "FAILED" },
      { scenarioId: "refund-flow", title: "Refund flow", kind: "api", status: "UNKNOWN" },
    ];
    const table = buildProofTable({ plan: withScenarios, checkResults: [], scenarioRows: rows, testProof: undefined, candidateDigest: CODE.digest });
    // One scenario passed and another it names never ran: partly tested, not passed.
    expect(rowOf(table, "1.1").result).toBe("partly_tested");
    expect(rowOf(table, "3").result).toBe("failed");
    expect(rowOf(table, "2").result).toBe("not_tested");
    const skipped = table.notTested.filter((item) => item.kind === "scenario").map((item) => item.id).sort();
    expect(skipped).toEqual(["never-ran", "refund-flow"]);
  });
});

describe("a claim is no better than its weakest part (partly tested)", () => {
  const children = (...ids: string[]) => ids.map((id) => ({ id, text: `Part ${id} works.` }));
  const parentPlan = (proves: Record<string, string[]>, proposed = [check("unit", "Unit tests"), check("lint", "Lint")]) =>
    plan({ claims: [{ id: "1", text: "Payments that time out are retried.", children: children("1.1", "1.2") }, { id: "2", text: "A payment is never charged twice." }], checks: { proposed, proves } });
  const build = (p: PlanDocument, checkResults: ProofCheckResult[], testProof?: TestProof) => buildProofTable({ plan: p, checkResults, scenarioRows: [], testProof, candidateDigest: CODE.digest, recordedCheckIds: SELECTED });

  it("a parent whose one child is proven and another has no check is partly tested, not proven", () => {
    const table = build(parentPlan({ unit: ["1.1"], lint: ["2"] }), passing("unit", "lint"), proofFor(CODE.digest));
    expect(rowOf(table, "1.1").result).toBe("proven");
    expect(rowOf(table, "1.2").result).toBe("not_tested");
    expect(rowOf(table, "1").result).toBe("partly_tested");
    // The parent is listed once, naming the missing part; the child is listed on its own.
    const parent = table.notTested.filter((item) => item.kind === "claim" && item.id === "1");
    expect(parent).toHaveLength(1);
    expect(parent[0]!.reason).toContain("1.2");
    expect(table.notTested.filter((item) => item.kind === "claim" && item.id === "1.2")).toHaveLength(1);
    expect(table.notTested.some((item) => item.kind === "claim" && item.id === "1.1")).toBe(false);
  });

  it("a parent whose children are all proven or passed keeps that result, and is not listed", () => {
    const table = build(parentPlan({ unit: ["1.1", "1.2"], lint: ["2"] }), passing("unit", "lint"), proofFor(CODE.digest));
    expect(rowOf(table, "1").result).toBe("proven");
    expect(table.notTested.filter((item) => item.kind === "claim")).toEqual([]);
  });

  it("a failed child fails the parent, even beside an untested one", () => {
    const table = build(parentPlan({ unit: ["1.1"], lint: ["2"] }), [{ checkId: "unit", status: "FAILED" }, { checkId: "lint", status: "PASS" }]);
    expect(rowOf(table, "1").result).toBe("failed");
  });

  it("a claim with one linked check passed and another that never ran is partly tested, and the reason says a linked check did not run", () => {
    const table = build(parentPlan({ unit: ["1.1", "1.2"], lint: ["1.1"] }), [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "UNKNOWN" }]);
    expect(rowOf(table, "1.1").result).toBe("partly_tested");
    expect(rowOf(table, "1.2").result).toBe("passed");
    expect(rowOf(table, "1").result).toBe("partly_tested");
    expect(table.notTested.find((item) => item.kind === "claim" && item.id === "1.1")?.reason).toMatch(/linked check or scenario did not run/u);
    // The parent's missing part is the child that is partly tested.
    expect(table.notTested.find((item) => item.kind === "claim" && item.id === "1")?.reason).toContain("1.1");
  });

  it("a claim with no evidence at all stays not tested, and one whose only evidence did not run stays not tested", () => {
    const table = build(parentPlan({ unit: ["1.1"], lint: ["2"] }), [{ checkId: "unit", status: "UNKNOWN" }, { checkId: "lint", status: "PASS" }]);
    expect(rowOf(table, "1.1").result).toBe("not_tested");
    expect(rowOf(table, "1.2").result).toBe("not_tested");
    expect(rowOf(table, "1").result).toBe("not_tested");
  });

  it("shows partly tested in words, and keeps the row and its bullet at every shrink level", () => {
    const claims = Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), text: `Requirement ${index + 1} ${"is described in a fair amount of detail ".repeat(7)}`.slice(0, 290) }));
    const proposed = [check("unit", "Unit tests"), check("lint", "Lint")];
    const workflow = workflowWith({ stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results", reviews: undefined, checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed },
      verification: { candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "UNKNOWN" }] } });
    // 1-6 pass (unit); 7-8 pass with a second check that never ran (partly tested); 9-12 have no check.
    const ids = (from: number, to: number) => claims.slice(from - 1, to).map((claim) => claim.id);
    const bigPlan = plan({ claims, checks: { proposed, proves: { unit: ids(1, 8), lint: ids(7, 8) } } });
    for (let level = 0; level <= PROOF_LEVEL_LAST; level += 1) {
      const text = proofSection(workflow, { plan: bigPlan })!(level).join("\n");
      for (const id of [7, 8]) {
        expect(text, `level ${level} row ${id}`).toMatch(new RegExp(`\\| ${id}: [^\\n]*\\| ⚠ partly tested \\|`, "u"));
        expect(text.slice(text.indexOf("What wasn't tested")), `level ${level} bullet ${id}`).toMatch(new RegExp(`- Requirement ${id}\\b`, "u"));
      }
    }
    // The passed rows still fold at level 3; the partly tested ones do not.
    expect(proofSection(workflow, { plan: bigPlan })!(3).join("\n")).toContain("6 more requirements proven or passed");
  });
});

function workflowWith(extra: Record<string, unknown> = {}): WorkflowSnapshot {
  const review = (role: "CRITIC" | "SECURITY") => ({ operationId: randomUUID(), candidateDigest: CODE.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now });
  return WorkflowSnapshot.parse({
    ...createWorkflowSnapshot({ taskId, ownerId, now, definitionVersion: "1.1.0" }),
    stage: "PULL_REQUEST", state: "READY", candidate: CODE,
    checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [check("unit", "Unit tests"), check("lint", "Lint")] },
    verification: { candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "PASS" }] },
    reviews: [review("CRITIC"), review("SECURITY")],
    ...extra,
  });
}
const WorkflowSnapshot = WorkflowSnapshotSchema;
const task = { title: "Add a retry flag" } as never;
const SESSION = "https://rovara.example/review/8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6/task";
const START = "<!-- rovara:checks-and-reviews -->";
const END = "<!-- /rovara:checks-and-reviews -->";
const files = { files: [{ repository: "payments", path: "src/retry.ts", added: 10, removed: 2 }, { repository: "payments", path: "src/retry.test.ts", added: 30, removed: 0 }], complete: true };
const bodyOf = (proof: unknown, workflow = workflowWith(), extra: Record<string, unknown> = {}) =>
  workflowPullRequestBody(task, workflow, "# Plan\n\n1. Add the retry flag.\n", SESSION, { changedFiles: files, ...(proof === undefined ? {} : { proof }), ...extra } as never);
const proofPart = (body: string) => {
  const from = body.indexOf("### Proof");
  return from === -1 ? "" : body.slice(from, body.indexOf("## Reviews", from));
};
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("the Proof section of the version 2 pull request description", () => {
  it("shows a requirement whose check has a proves_change test proof as proven, after Tests and before Reviews", () => {
    const body = bodyOf({ plan: plan(), testProof: proofFor(CODE.digest) });
    expect(body.indexOf("### Proof")).toBeGreaterThan(body.indexOf("## Tests"));
    expect(body.indexOf("### Proof")).toBeLessThan(body.indexOf("## Reviews"));
    expect(body.indexOf("### Proof")).toBeGreaterThan(body.indexOf(START));
    expect(body.indexOf("### Proof")).toBeLessThan(body.indexOf(END));
    const section = proofPart(body);
    expect(section).toContain("| Requirement | Evidence | Result |");
    expect(section).toMatch(/\| 1\.1: The retry waits longer each time\. \|[^|\n]*Unit tests[^|\n]*\| ✅ proven \|/);
    expect(section).toMatch(/\| 2: A payment is never charged twice\. \|[^|\n]*Lint[^|\n]*\| ✅ passed \|/);
    // One home for the test-proof lines: the Tests section carries them, the Proof section only marks the row "proven".
    expect(section).not.toContain("Test proof:");
    expect(body.match(/Test proof:/gu)).toHaveLength(1);
    expect(body.slice(body.indexOf("## Tests"), body.indexOf("### Proof"))).toContain("Test proof: 1 check fails on the original code and passes now");
  });

  it("lists the test-proof lines once in Tests when the publication passed them and the Proof inputs carry the same proof", () => {
    const lines = ["Test proof: 1 check fails on the original code and passes now"];
    const body = bodyOf({ plan: plan(), testProof: proofFor(CODE.digest) }, workflowWith(), { proofLines: lines });
    expect(body.match(/Test proof:/gu)).toHaveLength(1);
    expect(proofPart(body)).not.toContain("Test proof:");
  });

  it("shows a requirement with no linked check as not tested and lists it under What wasn't tested", () => {
    const section = proofPart(bodyOf({ plan: plan() }));
    expect(section).toMatch(/\| 3: The retry count is shown on the payment page\. \|[^|\n]*\| ⚠ not tested \|/);
    const after = section.slice(section.indexOf("What wasn't tested"));
    expect(after).toContain("What wasn't tested");
    expect(after).toMatch(/- .*\b3\b.*retry count is shown/);
  });

  it("ignores a test proof bound to a different candidate digest", () => {
    const ignored = bodyOf({ plan: plan(), testProof: proofFor(OTHER.digest) });
    const absent = bodyOf({ plan: plan() });
    expect(ignored).toBe(absent);
    expect(proofPart(ignored)).not.toContain("proven");
    expect(ignored).not.toContain("Test proof:");
  });

  it("renders a requirement's mentions, links, issue numbers, hidden characters and table breaks inert", () => {
    const nasty = "Ping @everyone and @octocat, see [the docs](https://evil.example/x) or https://evil.example/y and www.evil.example, fixes #123 and org/repo#9\u200b\u202e hidden <!-- comment --> | pipe &#x40;user";
    const section = proofPart(bodyOf({ plan: plan({ claims: [{ id: "1", text: nasty }, ...plan().claims.slice(1)] }) }));
    expect(section).not.toMatch(/@[A-Za-z]/u);
    expect(section).not.toMatch(/https?:\/\/[^\s‍]/u);
    expect(section).not.toMatch(/\]\(/u);
    expect(section).not.toMatch(/#\d/u);
    expect(section).not.toContain("<!--");
    expect(section).not.toMatch(/[\u200b\u202e]/u);
    expect(section).not.toMatch(/&#x40;/u);
    // The pipe cannot add a column: every table row has exactly its three cells.
    for (const line of section.split("\n").filter((row) => row.startsWith("| ") && !row.startsWith("| ---"))) expect(line.split(" | ")).toHaveLength(3);
    // The text itself is kept (the words survive), only made inert.
    expect(section).toContain("Ping");
  });

  it("redacts a secret in a requirement and in a check label", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const body = bodyOf({ plan: plan({ claims: [{ id: "1", text: `Uses token ${secret} to call the API` }, ...plan().claims.slice(1)], checks: { proposed: [check("unit", `Unit ${secret}`), check("lint", "Lint")], proves: { unit: ["1"], lint: ["2"] } } }) });
    expect(proofPart(body)).not.toContain("ghp_");
  });

  it("stays within 30,000 bytes under size pressure and never drops a failed requirement or a not-tested item", () => {
    const long = (word: string) => `${word} ${"requirement text that goes on and on ".repeat(8)}`.slice(0, 298);
    const claims = Array.from({ length: 50 }, (_, index) => ({ id: String(index + 1), text: `${index + 1} ${long("claim")}` }));
    const labels = (index: number) => `Check number ${index} ${"with a very long label ".repeat(10)}`.slice(0, 78);
    const proposed = Array.from({ length: 8 }, (_, index) => check(`c${index}`, labels(index)));
    // Claims 1-30 are proven or passed; 31-35 are failed; 36-50 have no check. Each of the first 35 names every check.
    const proves: Record<string, string[]> = Object.fromEntries(proposed.map((item) => [item.id, claims.slice(0, 35).map((claim) => claim.id)]));
    const big = plan({ claims, checks: { proposed, proves } });
    // Failing the last check fails every claim that names it, so give claims 31-35 their own failing check instead.
    const failingPlan = plan({ claims, checks: { proposed: [...proposed.slice(0, 7), check("bad", labels(9))], proves: { ...Object.fromEntries(proposed.slice(0, 7).map((item) => [item.id, claims.slice(0, 30).map((claim) => claim.id)])), bad: claims.slice(30, 35).map((claim) => claim.id) } } });
    const results = [...proposed.slice(0, 7).map((item) => ({ checkId: item.id, status: "PASS" })), { checkId: "bad", status: "FAILED" }];
    const checkPolicy = { required: [], optional: [], selectedOptionalIds: [], proposed: [...proposed.slice(0, 7), check("bad", labels(9))] };
    const workflow = workflowWith({ stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results", reviews: undefined, checkPolicy, verification: { candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results } });
    const manyFiles = { files: Array.from({ length: 200 }, (_, index) => ({ repository: "payments", path: `src/module-${index}/some/deeply/nested/file-name-${index}.ts`, added: 5, removed: 1 })), complete: true };
    const summary = Array.from({ length: 40 }, (_, index) => `Plan line ${index} ${"x".repeat(180)}`).join("\n");
    const body = workflowPullRequestBody(task, workflow, summary, SESSION, { changedFiles: manyFiles, proof: { plan: failingPlan, testProof: undefined } });
    expect(bytes(body)).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_BYTES);
    // The size pressure was real: the section in its full form added to the rest of the body would not fit, so something had to shrink.
    const without = workflowPullRequestBody(task, workflow, summary, SESSION, { changedFiles: manyFiles });
    const full = proofSection(workflow, { plan: failingPlan })!(0).join("\n");
    expect(bytes(without) + bytes(full)).toBeGreaterThan(PULL_REQUEST_BODY_MAX_BYTES);
    expect(bytes(proofPart(body))).toBeLessThan(bytes(full));
    expect(big.claims).toHaveLength(50);
    const section = proofPart(body);
    for (let id = 31; id <= 35; id += 1) expect(section, `failed ${id}`).toMatch(new RegExp(`\\| ${id}: [^\\n]*\\| ❌ failed \\|`, "u"));
    for (let id = 36; id <= 50; id += 1) {
      expect(section, `not tested row ${id}`).toMatch(new RegExp(`\\| ${id}: [^\\n]*\\| ⚠ not tested \\|`, "u"));
      expect(section.slice(section.indexOf("What wasn't tested")), `not tested bullet ${id}`).toMatch(new RegExp(`- [^\\n]*\\b${id}\\b`, "u"));
    }
    // The markers, the risk and the closing line stay.
    expect(body).toContain(START);
    expect(body).toContain(END);
    expect(body).toContain("## Risk:");
    expect(body.trimEnd().endsWith("A person must approve it and a person merges it.")).toBe(true);
  });

  it("shrinks the evidence text first, then folds the proven and passed rows, and keeps failed and not-tested items at every level", () => {
    const claims = Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), text: `Requirement ${index + 1} ${"is described in a fair amount of detail ".repeat(7)}`.slice(0, 290) }));
    const proposed = [check("unit", `Unit tests ${"with a long label ".repeat(5)}`.slice(0, 78)), check("lint", "Lint"), check("bad", "Bad check")];
    const checkPolicy = { required: [], optional: [], selectedOptionalIds: [], proposed };
    const results = [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "PASS" }, { checkId: "bad", status: "FAILED" }];
    const workflow = workflowWith({ stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results", reviews: undefined, checkPolicy,
      verification: { candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results } });
    // 1-6 pass (unit and lint), 7-8 fail (bad), 9-12 have no check.
    const ids = (from: number, to: number) => claims.slice(from - 1, to).map((claim) => claim.id);
    const bigPlan = plan({ claims, checks: { proposed, proves: { unit: ids(1, 6), lint: ids(1, 6), bad: ids(7, 8) } } });
    const at = (level: number) => proofSection(workflow, { plan: bigPlan })!(level).join("\n");
    const rowLines = (text: string) => text.split("\n").filter((line) => /^\| \d+: /u.test(line));

    expect(at(0)).toContain(proposed[0]!.label);
    expect(at(0)).toContain(`${proposed[0]!.label} (passed); Lint (passed)`);
    // Level 1 cuts the evidence entries, level 2 turns them into counts; the requirement text is cut later than the evidence.
    expect(at(1)).not.toContain(proposed[0]!.label);
    expect(at(1)).toContain("Unit tests with a long label with a lon…");
    expect(at(2)).not.toContain("Unit tests");
    expect(at(2)).toContain("2 checks");
    expect(rowLines(at(1))).toHaveLength(12);
    expect(rowLines(at(2))).toHaveLength(12);
    expect(rowLines(at(1))[0]!.length).toBeGreaterThan(rowLines(at(2))[0]!.length);
    // Level 3 folds the six passed rows into one line.
    expect(rowLines(at(3))).toHaveLength(6);
    expect(at(3)).toContain("6 more requirements proven or passed");
    expect(at(3)).not.toContain("| 1: ");
    // Failed rows and not-tested items are in every level.
    for (let level = 0; level <= PROOF_LEVEL_LAST; level += 1) {
      const text = at(level);
      for (const id of [7, 8]) expect(text, `level ${level} failed ${id}`).toMatch(new RegExp(`\\| ${id}: [^\\n]*\\| ❌ failed \\|`, "u"));
      for (const id of [9, 10, 11, 12]) {
        expect(text, `level ${level} row ${id}`).toMatch(new RegExp(`\\| ${id}: [^\\n]*\\| ⚠ not tested \\|`, "u"));
        expect(text.slice(text.indexOf("What wasn't tested")), `level ${level} bullet ${id}`).toMatch(new RegExp(`- Requirement ${id}\\b`, "u"));
      }
    }
    expect(bytes(at(4))).toBeLessThan(bytes(at(3)));
    expect(bytes(at(3))).toBeLessThan(bytes(at(2)));
    expect(bytes(at(2))).toBeLessThan(bytes(at(1)));
    expect(bytes(at(1))).toBeLessThan(bytes(at(0)));
  });

  it("has no Proof section without an approved plan with claims, and the rest of the body is byte-identical to today's", () => {
    const today = bodyOf(undefined);
    expect(today).not.toContain("### Proof");
    expect(bodyOf({ plan: undefined })).toBe(today);
    expect(bodyOf({ plan: plan({ claims: [] }) })).toBe(today);
    // A test proof without a plan with claims adds only its Tests line (as the publication's own hook does); there is still no Proof section.
    const withProofOnly = bodyOf({ plan: undefined, testProof: proofFor(CODE.digest) });
    expect(withProofOnly).not.toContain("### Proof");
    // (TE-B3: a test proof from before the weakening facts could not compare the untouched tests, and the description says so in its own block.)
    expect(withProofOnly.replace("\n- Test proof: 1 check fails on the original code and passes now", "").replace("## Flags for the reviewer\n- Test weakening: could not compare (no test report to compare)\n\n", "")).toBe(today);
    expect(workflowPullRequestStatusLines(workflowWith(), { changedFiles: files, proof: { plan: undefined } })).toEqual(workflowPullRequestStatusLines(workflowWith(), { changedFiles: files }));
  });

  it("a rewrite of the status lines after a pushed fix keeps the Proof section", () => {
    const lines = workflowPullRequestStatusLines(workflowWith(), { changedFiles: files, proof: { plan: plan(), testProof: proofFor(CODE.digest) } }).join("\n");
    expect(lines).toContain("### Proof");
    expect(lines).toContain("✅ proven");
    // The rewrite brings the Tests lines back too (once), from the proof it just read; the Proof section has none.
    expect(lines.match(/Test proof:/gu)).toHaveLength(1);
    expect(lines.slice(lines.indexOf("## Tests"), lines.indexOf("### Proof"))).toContain("Test proof: 1 check fails");
  });
});

describe("loadTestProof", () => {
  const task = { ownerKey: "owner-key", workspaceId: "ws-1" };
  const artifactKey = (operationId: string) => `private/owner-key/ws-1/${operationId}/test-proof.json`;
  const actionsWith = (stored: Record<string, string>, operations = [{ id: "op-1", kind: "task", status: "SUCCEEDED", createdAt: "2026-10-27T10:00:00.000Z" }]) => ({
    operations: async () => operations,
    artifacts: async (_workspaceId: string, operationId: string) => (stored[artifactKey(operationId)] === undefined ? [] : [{ name: "test-proof.json", objectKey: artifactKey(operationId) }]),
    readArtifact: async (objectKey: string) => { const text = stored[objectKey]; if (text === undefined) throw new Error("missing"); return text; },
  });

  it("returns the parsed proof bound to the candidate digest", async () => {
    const proof = proofFor(CODE.digest);
    expect(await loadTestProof(actionsWith({ [artifactKey("op-1")]: JSON.stringify(proof) }), task, CODE.digest)).toEqual(proof);
  });

  it("returns nothing when there is no artifact (always, until the worker part lands), when it is for another digest, malformed, or from another workspace's key", async () => {
    expect(await loadTestProof(actionsWith({}), task, CODE.digest)).toBeUndefined();
    expect(await loadTestProof(actionsWith({ [artifactKey("op-1")]: JSON.stringify(proofFor(OTHER.digest)) }), task, CODE.digest)).toBeUndefined();
    expect(await loadTestProof(actionsWith({ [artifactKey("op-1")]: "{not json" }), task, CODE.digest)).toBeUndefined();
    // TE-B3 (reader tolerance): a key a newer writer added is dropped, and the proof still reads; a known field of the wrong type still does not.
    expect(await loadTestProof(actionsWith({ [artifactKey("op-1")]: JSON.stringify({ ...proofFor(CODE.digest), extra: 1 }) }), task, CODE.digest)).toEqual(proofFor(CODE.digest));
    expect(await loadTestProof(actionsWith({ [artifactKey("op-1")]: JSON.stringify({ ...proofFor(CODE.digest), status: 7 }) }), task, CODE.digest)).toBeUndefined();
    const foreign = { ...actionsWith({ [artifactKey("op-1")]: JSON.stringify(proofFor(CODE.digest)) }), artifacts: async () => [{ name: "test-proof.json", objectKey: "private/someone-else/ws-9/op-1/test-proof.json" }] };
    expect(await loadTestProof(foreign, task, CODE.digest)).toBeUndefined();
    expect(await loadTestProof(actionsWith({ [artifactKey("op-1")]: JSON.stringify(proofFor(CODE.digest)) }), task, undefined)).toBeUndefined();
  });

  it("returns nothing, and does not throw, when storage fails", async () => {
    const broken = { operations: async () => { throw new Error("down"); }, artifacts: async () => [], readArtifact: async () => "" };
    expect(await loadTestProof(broken, task, CODE.digest)).toBeUndefined();
  });
});

// ---- through the broker: the publication reads the approved plan and the test proof from storage

describe("the worker's check ids in a test proof", () => {
  const selected = ["required-1", "unit"];
  const table = (testProof: TestProof, recordedCheckIds: readonly string[] | undefined) => buildProofTable({ plan: plan(), checkResults: passing("unit", "lint"), scenarioRows: [], testProof, candidateDigest: CODE.digest, ...(recordedCheckIds === undefined ? {} : { recordedCheckIds }) });

  it("readiness:<i> is the selected check at index i: the worker's proof for readiness:1 proves the check at index 1", async () => {
    const { proof } = workerTestProof(CODE.digest, 1);
    expect(proof.items.map((item) => item.checkId)).toEqual(["readiness:0", "readiness:1"]);
    expect(rowOf(table(proof, selected), "1.1").result).toBe("proven");
    expect(rowOf(table(proof, selected), "2").result).toBe("passed");
  });

  it("an id that does not map is ignored, never matched by accident: out of range, no recorded checks known, other forms", async () => {
    const { proof } = workerTestProof(CODE.digest, 1);
    expect(rowOf(table(proof, ["required-1"]), "1.1").result).toBe("passed");
    expect(rowOf(table(proof, undefined), "1.1").result).toBe("passed");
    for (const checkId of ["unit", "readiness:01", "readiness:-1", "readiness:1x", "readiness:", "Readiness:1", "readiness:99", "readiness:1.5", "constructor", "__proto__"]) {
      expect(checkIdOfProofItem(checkId, selected), checkId).toBeUndefined();
    }
    expect(checkIdOfProofItem("readiness:0", selected)).toBe("required-1");
    expect(checkIdOfProofItem("readiness:1", selected)).toBe("unit");
    expect(checkIdOfProofItem("readiness:2", selected)).toBeUndefined();
  });
});

// ---- P5: the proof is mapped through the check ids recorded with the results it belongs to, not the policy as it is now

describe("a test proof is read against the checks recorded with its results (P5)", () => {
  const verification = (...ids: string[]) => ({ candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: ids.map((checkId) => ({ checkId, status: "PASS" })) });
  const blocked = { stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results", reviews: undefined };
  const lintOnly = { required: [], optional: [], selectedOptionalIds: [], proposed: [check("lint", "Lint")] };
  const section = (workflow: WorkflowSnapshot, testProof: TestProof) => proofSection(workflow, { plan: plan(), testProof })!(0).join("\n");

  it("normal path: the proof's readiness:<i> are the recorded results' checks in order, and the proving check is proven", async () => {
    const { proof } = workerTestProof(CODE.digest, 0, 2);
    const text = section(workflowWith({ verification: verification("unit", "lint") }), proof);
    expect(text).toMatch(/\| 1\.1: The retry waits longer each time\. \|[^|\n]*Unit tests[^|\n]*\| ✅ proven \|/u);
    expect(text).toMatch(/\| 2: A payment is never charged twice\. \|[^|\n]*Lint[^|\n]*\| ✅ passed \|/u);
  });

  it("after a verification retry that removed an earlier check from the policy, an old proof never marks the wrong check proven", async () => {
    // The proof is from the run that checked unit (readiness:0, proves) and lint (readiness:1). The owner's retry has since dropped unit from the selection, so the policy now lists only lint, at index 0.
    const { proof } = workerTestProof(CODE.digest, 0, 2);
    const text = section(workflowWith({ checkPolicy: lintOnly, verification: verification("unit", "lint") }), proof);
    expect(text).toMatch(/\| 2: A payment is never charged twice\. \|[^|\n]*Lint[^|\n]*\| ✅ passed \|/u);
    expect(text).not.toMatch(/\| 2: [^\n]*proven/u);
    // The check the proof really proved still reads proven.
    expect(text).toMatch(/\| 1\.1: [^\n]*\| ✅ proven \|/u);
  });

  it("is ignored altogether (nothing proven) when the number of recorded results differs from the proof's checks, or no results are recorded for this code", async () => {
    const three = (workerTestProof(CODE.digest, 0, 3)).proof;
    expect(section(workflowWith({ verification: verification("unit", "lint") }), three)).not.toContain("proven");
    const two = (workerTestProof(CODE.digest, 0, 2)).proof;
    expect(section(workflowWith({ verification: verification("unit") }), two)).not.toContain("proven");
    expect(section(workflowWith({ ...blocked, verification: { ...verification("unit", "lint"), candidateDigest: OTHER.digest } }), two)).not.toContain("proven");
    expect(section(workflowWith({ ...blocked, verification: undefined }), two)).not.toContain("proven");
  });
});


// Playbook P2: reviewer models have one source, Trust fix A2's Reviews lines. The Proof section is about requirements and evidence and names no reviewer model.
describe("the reviewer model in a description that has a Proof section", () => {
  const reviewsPart = (body: string) => body.slice(body.indexOf("## Reviews"), body.indexOf("## Risk:"));
  const sameModelTask = { title: "Add a retry flag", reviewSameModel: { candidateDigest: CODE.digest } } as never;

  it("names the reviewer model once, in the Reviews section (A2's lines), and the Proof section has no model line", () => {
    const body = bodyOf({ plan: plan(), testProof: proofFor(CODE.digest) });
    expect(proofPart(body)).toContain("| Requirement | Evidence | Result |");
    expect(body.match(/Reviewed by test\/1/gu)).toHaveLength(1);
    expect(reviewsPart(body)).toContain("Reviewed by test/1");
    expect(body.indexOf("### Proof")).toBeLessThan(body.indexOf("## Reviews"));
    expect(proofPart(body)).not.toMatch(/Reviewed by|test\/1|same model/iu);
  });

  it("says A2's same-model note once, in Reviews, and not in the Proof section", () => {
    const body = workflowPullRequestBody(sameModelTask, workflowWith(), "# Plan\n\n1. Add the retry flag.\n", SESSION, { changedFiles: files, proof: { plan: plan(), testProof: proofFor(CODE.digest) }, reviewSameModel: true });
    expect(body.match(new RegExp(REVIEW_SAME_MODEL_NOTE.replace(/[.]/gu, "\\."), "gu"))).toHaveLength(1);
    expect(reviewsPart(body)).toContain(REVIEW_SAME_MODEL_NOTE);
    expect(proofPart(body)).not.toContain(REVIEW_SAME_MODEL_NOTE);
  });

  it("the rewritten status block (a pushed fix) has the same: the model line once, in Reviews, after the Proof section", () => {
    const lines = workflowPullRequestStatusLines(workflowWith(), { changedFiles: files, proof: { plan: plan(), testProof: proofFor(CODE.digest) }, reviewSameModel: true }).join("\n");
    expect(lines.match(/Reviewed by test\/1/gu)).toHaveLength(1);
    expect(lines.match(/Review used the same model as Build/gu)).toHaveLength(1);
    expect(lines.indexOf("### Proof")).toBeLessThan(lines.indexOf("## Reviews"));
    expect(lines.slice(lines.indexOf("### Proof"), lines.indexOf("## Reviews"))).not.toMatch(/Reviewed by|same model/iu);
  });

  it("a Proof section with the kept or stale marker still leaves A2's lines in Reviews", () => {
    const lines = workflowPullRequestStatusLines(workflowWith(), { changedFiles: files, proof: { stale: true }, reviewSameModel: true }).join("\n");
    expect(lines).toContain("Proof is being updated for the latest change.");
    expect(lines.slice(lines.indexOf("## Reviews"))).toContain("Reviewed by test/1");
    expect(lines.slice(lines.indexOf("## Reviews"))).toContain("Review used the same model as Build");
  });
});


describe("192a agent-written replies", () => {
  const UNCONFIRMED = "proven with scripted replies written in this task: check them";
  const DISAGREED = "scripted replies written in this task: the real model did not agree";
  const dependencies = (trust: EvidenceTrustClass = "simulated") => new Map([["unit", [{ dependencyId: "never-display-dependency", trust, replies: "task_made" as const }]]]);
  const realRun = (result: "passed" | "passed_on_rerun" | "failed" | "not_run" = "passed") => ({ schemaVersion: 1 as const, candidateDigest: CODE.digest, items: [{ checkId: "readiness:0", result }] });
  const input = (overrides: Partial<ProofTableInput> = {}): ProofTableInput => ({ plan: plan(), checkResults: passing("unit", "lint"), scenarioRows: [], testProof: proofFor(CODE.digest), candidateDigest: CODE.digest, recordedCheckIds: SELECTED, checkDependencies: dependencies(), ...overrides });
  it.each([
    [undefined, "passed", "agent_replies_unconfirmed", UNCONFIRMED],
    ["not_run", "passed", "agent_replies_unconfirmed", UNCONFIRMED],
    ["failed", "passed", "agent_replies_disagreed", DISAGREED],
    ["passed", "proven", undefined, "proven with scripted AI replies"],
    ["passed_on_rerun", "proven", undefined, "proven with scripted AI replies"],
  ] as const)("golden row for %s", (result, state, reason, words) => {
    const table = buildProofTable(input({ realModelRun: result === undefined ? undefined : realRun(result) }));
    expect(rowOf(table, "1.1")).toEqual({ claimId: "1.1", requirement: "The retry waits longer each time.", evidence: [{ kind: "check", label: `${words}: Unit tests`, state, ...(reason === undefined ? {} : { notProvenReason: reason }) }], result: state });
  });
  it("keeps marked non-proving checks plain and Passed with no reply reason", () => {
    for (const testProof of [undefined, proofFor(CODE.digest, "does_not_prove"), proofFor(OTHER.digest)]) {
      for (const realModelRun of [undefined, realRun("failed"), realRun()]) {
        expect(rowOf(buildProofTable(input({ testProof, realModelRun })), "1.1")).toEqual({
          claimId: "1.1", requirement: "The retry waits longer each time.",
          evidence: [{ kind: "check", label: "Unit tests", state: "passed" }], result: "passed",
        });
      }
    }
  });
  it("Rovara-made mocks win even when the real model agrees", () => {
    for (const realModelRun of [undefined, realRun("failed"), realRun()]) {
      expect(rowOf(buildProofTable(input({ checkDependencies: dependencies("made_by_rovara"), realModelRun })), "1.1").evidence[0]).toEqual({ kind: "check", label: "with a Rovara-made mock; not Proven: Unit tests", state: "passed", notProvenReason: "made_by_rovara" });
    }
  });
  it("only restricts existing proof and never changes a failed or unrun check", () => {
    for (const status of ["FAILED", "UNKNOWN"] as const) {
      const row = rowOf(buildProofTable(input({ checkResults: [{ checkId: "unit", status }], realModelRun: realRun() })), "1.1");
      expect(row.evidence[0]).toEqual({ kind: "check", label: "Unit tests", state: status === "FAILED" ? "failed" : "not_checked" });
    }
    expect(rowOf(buildProofTable(input({ testProof: undefined, realModelRun: realRun() })), "1.1").result).toBe("passed");
  });
  it("propagates to PR, folded rows, aggregate test lines and the task page", () => {
    for (const result of [undefined, "failed", "passed"] as const) {
      const context = { plan: plan(), testProof: proofFor(CODE.digest), checkDependencies: dependencies(), realModelRun: result === undefined ? undefined : realRun(result) };
      const words = result === "passed" ? "proven with scripted AI replies" : result === "failed" ? DISAGREED : UNCONFIRMED;
      const explanation = result === "failed" ? "Checks passing on scripted replies written in this task are not Proven: the real model did not agree." : "Checks passing on scripted replies written in this task are not Proven until the real model agrees: check them.";
      const section = proofSection(workflowWith(), context)!;
      for (let level = 0; level <= PROOF_LEVEL_LAST; level += 1) {
        if (result !== "passed") expect(section(level)).toContain(explanation);
      }
      const view = ProofTableViewSchema.parse(proofTableView(workflowWith(), context));
      expect(view.rows.find((row) => row.claimId === "1.1")?.evidence[0]?.label).toBe(`${words}: Unit tests`);
      const body = bodyOf(context);
      expect(body).toContain(`${words}: Test proof:`);
      expect(view.testProofLines.some((line) => line.startsWith(`${words}: Test proof:`))).toBe(true);
    }
  });
  it("leaves pre-task replies and recordings byte-identical, even with malformed or unrelated real runs", () => {
    const golden = JSON.stringify(buildProofTable(input({ checkDependencies: undefined })));
    for (const realModelRun of [undefined, realRun(), { items: "broken" } as never]) {
      expect(JSON.stringify(buildProofTable(input({ checkDependencies: undefined, realModelRun })))).toBe(golden);
      expect(JSON.stringify(buildProofTable(input({ checkDependencies: new Map([["unit", [{ dependencyId: "recording", trust: "recorded" }]]]), realModelRun })))).toBe(golden);
    }
  });
  it("renders only fixed refusal words, never real-run fields or dependency ids, with hostile long labels inert", () => {
    const secret = `gh${"p"}_${"a".repeat(36)}`;
    const hostile = "[nested [link]](https://evil.example) ![image][ref]\n[ref]: https://evil.example\n@team #123 <img>\n# heading\n> quote\n---\n```\n~~~\n\u200b\u202e\ufe0f";
    const start = performance.now();
    const table = buildProofTable(input({ plan: plan({ checks: { proposed: [check("unit", hostile + "x".repeat(1_048_576))], proves: { unit: ["1.1"] } } }), realModelRun: { ...realRun(), items: [{ checkId: secret, result: secret }] } as never }));
    const label = rowOf(table, "1.1").evidence[0]!.label;
    expect(label).toMatch(/^proven with scripted replies written in this task: check them/u);
    expect(label).not.toMatch(/\]\(|!\[|@team|#123|<img>|[\r\n\u200b\u202e]|\ufe0f/u);
    expect(JSON.stringify(table)).not.toContain(secret);
    expect(JSON.stringify(table)).not.toContain("never-display-dependency");
    expect(Array.from(label).length).toBeLessThanOrEqual(120);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

it("unknown reply provenance values cannot count as confirmed task-made replies", () => {
  const table = buildProofTable({ plan: plan(), checkResults: passing("unit", "lint"), scenarioRows: [], testProof: proofFor(CODE.digest), candidateDigest: CODE.digest, recordedCheckIds: SELECTED, checkDependencies: new Map([["unit", [{ dependencyId: "reply", trust: "simulated", replies: "unknown" }]]]) as never, realModelRun: { schemaVersion: 1, candidateDigest: CODE.digest, items: [{ checkId: "readiness:0", result: "passed" }] } });
  expect(rowOf(table, "1.1").result).toBe("passed");
  expect(rowOf(table, "1.1").evidence[0]?.notProvenReason).toBe("agent_replies_unconfirmed");
});

it("ambiguous or incomplete recorded check mappings never confirm agent replies", () => {
  const testProof = proofFor(CODE.digest);
  testProof.items[1] = { ...testProof.items[0]!, checkId: "readiness:1" };
  const realModelRun = { schemaVersion: 1 as const, candidateDigest: CODE.digest, items: [{ checkId: "readiness:0", result: "failed" as const }, { checkId: "readiness:1", result: "passed" as const }] };
  for (const [recordedCheckIds, reason] of [[["unit", "unit"], "agent_replies_unconfirmed"], [["lint", "unit", "extra"], undefined]] as const) {
    const table = buildProofTable({ plan: plan(), checkResults: passing("unit", "lint"), scenarioRows: [], testProof, candidateDigest: CODE.digest, recordedCheckIds, realModelRun, checkDependencies: new Map([["unit", [{ dependencyId: "reply", trust: "simulated", replies: "task_made" }]]]) });
    expect(rowOf(table, "1.1")).toMatchObject({ result: "passed", evidence: [{ state: "passed" }] });
    expect(rowOf(table, "1.1").evidence[0]?.notProvenReason).toBe(reason);
    if (reason === undefined) expect(rowOf(table, "1.1").evidence[0]?.label).toBe("Unit tests");
  }
});


it("keeps all three reasons and the Warning within four page lines, dropping only the count", () => {
  const ids = ["unit", "lint", "third"];
  const proposed = ids.map((id) => check(id, id));
  const nextPlan = plan({ checks: { proposed, proves: { unit: ["1.1"], lint: ["2"], third: ["3"] } } });
  const workflow = workflowWith({ checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed },
    verification: { candidateDigest: CODE.digest, producer: "test", environmentId: "ci", recordedAt: now, results: passing(...ids) } });
  const testProof: TestProof = { ...proofFor(CODE.digest), items: [
    ...ids.map((_, i) => ({ ...proofFor(CODE.digest).items[0]!, checkId: `readiness:${i}` })),
    { ...proofFor(CODE.digest, "does_not_prove").items[0]!, label: "vacuous" },
  ] };
  const context = { plan: nextPlan, testProof,
    checkDependencies: new Map([
      ["unit", [{ dependencyId: "mock", trust: "made_by_rovara" as const }]],
      ["lint", [{ dependencyId: "reply", trust: "simulated" as const, replies: "task_made" as const }]],
      ["third", [{ dependencyId: "reply", trust: "simulated" as const, replies: "task_made" as const }]],
    ]),
    realModelRun: { schemaVersion: 1 as const, candidateDigest: CODE.digest, items: [{ checkId: "readiness:2", result: "failed" as const }] },
  };
  const lines = ProofTableViewSchema.parse(proofTableView(workflow, context)).testProofLines;
  expect(lines).toEqual([
    "Checks passing with a Rovara-made mock are not Proven.",
    "Checks passing on scripted replies written in this task are not Proven until the real model agrees: check them.",
    "Checks passing on scripted replies written in this task are not Proven: the real model did not agree.",
    "with a Rovara-made mock; not Proven: Warning: 1 check also passes on the original code, so it does not prove the change (vacuous)",
  ]);
  const body = bodyOf(context, workflow);
  expect(body.indexOf("Test proof:")).toBeLessThan(body.indexOf("Warning:"));
});

it("pins legacy table, PR body and page bytes for ordinary, missing and malformed proofs", () => {
  const hashes = [proofFor(CODE.digest), undefined, { invalid: true }].map((testProof) => {
    const context = { plan: plan(), testProof: testProof as TestProof | undefined };
    const table = buildProofTable({ ...context, checkResults: passing("unit", "lint"), scenarioRows: [], candidateDigest: CODE.digest, recordedCheckIds: SELECTED });
    return createHash("sha256").update(JSON.stringify({ table, body: bodyOf(context), page: proofTableView(workflowWith(), context) })).digest("hex");
  });
  expect(hashes).toEqual([
    "b8b353f5e2bb947fdce313b2791caf7f25ea6f35f049432b10c020817e59629c",
    "1fc846f57ff447087a27664b34d667a381127ad97a87d804034642f1deeed3ba",
    "1fc846f57ff447087a27664b34d667a381127ad97a87d804034642f1deeed3ba",
  ]);
});
