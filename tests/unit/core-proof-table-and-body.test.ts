// Playbook P1: the "Proof" section of a Rovara Code (version 2) pull request description. It maps each requirement (claim) of the approved plan to its evidence: the checks whose `proves`
// names it and the browser/API scenarios `scenarioProves` names. The section is public to the repository's readers, so every word that a model, a repository or a person wrote is redacted and
// inert, and it is bounded: under size pressure the evidence text shrinks first, then the proven and passed rows, and a failed requirement or a not-tested item is never dropped.
// (Port lane L7b: the cases that went through Cloud's broker and the worker's own test-proof writer are not here; the proofs below are written out by hand in the worker's format.)
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProofTableViewSchema, REPLY_PROVENANCES, checkCountsTowardProof, scriptedRepliesCountTowardProof, type EvidenceTrustClass, type PlanDocument, type TestProof } from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { REVIEW_SAME_MODEL_NOTE } from "../../packages/broker/src/core/proof/review-model-lines.js";
import { PULL_REQUEST_BODY_MAX_BYTES } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { buildProofTable, testProofLinesOf, type ProofCheckResult, type ProofScenarioRow, type ProofTableInput } from "../../packages/broker/src/core/proof/proof-table.js";
import { PROOF_LEVEL_LAST, proofSection } from "../../packages/broker/src/core/proof/proof-section.js";
import { proofTableView } from "../../packages/broker/src/core/proof/proof-view.js";
import { loadTestProof } from "../../packages/broker/src/core/proof/test-proof-reader.js";
import { workflowPullRequestBody, workflowPullRequestStatusLines } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";

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

  it.each(["real", "recorded", "simulated", "no_outside_calls"] as const)("keeps %s dependencies eligible for Proven", (trust) => {
    expect(buildProofTable(input({ checkDependencies: dependencies(trust) }))).toEqual(golden);
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
});

describe("buildProofTable", () => {

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
/** L4-C: the "Requirements and proof" drawer of the redesigned description ("" when there is none). */
const proofPart = (body: string) => {
  const from = body.indexOf("<summary>Requirements and proof");
  return from === -1 ? "" : body.slice(from, body.indexOf("</details>", from));
};
const drawerOf = (body: string, summaryStart: string) => {
  const from = body.indexOf(`<summary>${summaryStart}`);
  return from === -1 ? "" : body.slice(from, body.indexOf("</details>", from));
};
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("the Proof section of the version 2 pull request description", () => {

  // T1 (design 4.2): a check the plan proposed that has no result for this code is not tested, and that is said above the fold, not only under "What wasn't tested" in a closed drawer.
  it("says a planned check that could not run above the fold", () => {
    const noResults = workflowWith({ stage: "REVIEW", state: "WAITING", verification: undefined });
    const body = bodyOf({ plan: plan() }, noResults);
    const above = body.slice(0, body.indexOf("<details>"));
    expect(above).toMatch(/\*\*\d+ things were not tested\.\*\*|\*\*Something was not tested\.\*\*/u);
    expect(above).toContain("Check: Unit tests (it could not run)");
    expect(proofPart(body)).toContain("What wasn't tested");
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
    expect(body).toContain("**Risk** ");
    expect(body.trimEnd().endsWith("A person must approve it and a person merges it.")).toBe(true);
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
});

// Playbook P2: reviewer models have one source, Trust fix A2's Reviews lines. The Proof section is about requirements and evidence and names no reviewer model.
describe("the reviewer model in a description that has a Proof section", () => {
  const reviewsPart = (body: string) => drawerOf(body, "Reviews: ");
  const sameModelTask = { title: "Add a retry flag", reviewSameModel: { candidateDigest: CODE.digest } } as never;

  it("says A2's same-model note once, in Reviews, and not in the Proof section", () => {
    const body = workflowPullRequestBody(sameModelTask, workflowWith(), "# Plan\n\n1. Add the retry flag.\n", SESSION, { changedFiles: files, proof: { plan: plan(), testProof: proofFor(CODE.digest) }, reviewSameModel: true });
    expect(body.match(new RegExp(REVIEW_SAME_MODEL_NOTE.replace(/[.]/gu, "\\."), "gu"))).toHaveLength(1);
    expect(reviewsPart(body)).toContain(REVIEW_SAME_MODEL_NOTE);
    expect(proofPart(body)).not.toContain(REVIEW_SAME_MODEL_NOTE);
  });

  it("a Proof section with the kept or stale marker still leaves A2's lines in Reviews", () => {
    const lines = workflowPullRequestStatusLines(workflowWith(), { changedFiles: files, proof: { stale: true }, reviewSameModel: true }).join("\n");
    expect(lines).toContain("Proof is being updated for the latest change.");
    expect(drawerOf(lines, "Reviews: ")).toContain("Reviewed by test/1");
    expect(drawerOf(lines, "Reviews: ")).toContain("Review used the same model as Build");
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
  // TE-A3 rework (a): the contract's counting rule gives every reply case the Proof table's own answer (one rule, one set of words).
  it.each([
    [undefined, "unconfirmed"], ["not_run", "unconfirmed"], ["failed", "disagreed"], ["passed", "confirmed"], ["passed_on_rerun", "confirmed"],
  ] as const)("the contract counts a task_made reply case exactly when the Proof table proves it (%s)", (result, realModel) => {
    const row = rowOf(buildProofTable(input({ realModelRun: result === undefined ? undefined : realRun(result) })), "1.1");
    expect(checkCountsTowardProof({ kind: "test", trust: "simulated", proofBasis: "scripted_ai_replies", replies: "task_made", realModel })).toBe(row.result === "proven");
  });
  // DEC 192a, controller away-log 168: one rule for every (provenance x real-model result) pair, in three places that must agree: the Proof table, A3's rule and the reply-set provenance.
  describe("one rule for every provenance and real-model result", () => {
    const RESULTS = [[undefined, "unconfirmed"], ["not_run", "unconfirmed"], ["failed", "disagreed"], ["passed", "confirmed"], ["passed_on_rerun", "confirmed"]] as const;
    const tableFor = (replies: unknown, result: (typeof RESULTS)[number][0]) => buildProofTable(input({
      realModelRun: result === undefined ? undefined : realRun(result),
      checkDependencies: new Map([["unit", [{ dependencyId: "never-display-dependency", trust: "simulated" as const, replies: replies as never }]]]),
    }));
    it.each([...REPLY_PROVENANCES, "unknown_origin"])("%s: the Proof table, scriptedRepliesCountTowardProof and checkCountsTowardProof give the same answer (the reply-set rule itself is pinned in model-reply-proof-rule-agreement.test.ts)", (provenance) => {
      for (const [result, realModel] of RESULTS) {
        const proven = rowOf(tableFor(provenance, result), "1.1").result === "proven";
        const label = `${provenance} / ${String(result)}`;
        expect(scriptedRepliesCountTowardProof(provenance, realModel), label).toBe(proven);
        expect(checkCountsTowardProof({ kind: "test", trust: "simulated", proofBasis: "scripted_ai_replies", replies: provenance, realModel }), label).toBe(proven);
        expect(proven, label).toBe(provenance === "before_task" || (provenance === "task_made" && realModel === "confirmed"));
      }
    });
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
