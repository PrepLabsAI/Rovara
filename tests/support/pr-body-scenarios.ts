// Lane L4-C (PR redesign, B0): three representative tasks whose whole pull request description is rendered by the real functions (`workflowPullRequestBody`), so a person can read the real output and a later change shows
// as an exact diff. Everything is fixed: ids, times, digests, urls. Nothing reads the network, the clock or a model.
//   green:      a typical task, every check passed, a real and a recorded service, two lessons, a Linear issue, people known
//   exceptions: a failed check, a Rovara-made mock, an out-of-date recorded fake, a changed snapshot and instruction file, a sensitive path, an accepted finding, a blocking second review, same-model review
//   largest:    far more files, checks, requirements, lessons and findings than the description holds, so every shrink step runs
import { EvidencePackSchema, readEvidencePack, wholeTaskSpendUsd, type ActingAttribution, type AutoFixBudget, type EvidencePack, type PlanDocument, type TestProof } from "@agentx/contracts";
import { workflowFindingFingerprint } from "../../packages/contracts/src/task-workflow.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import type { PullRequestBodyContext } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { buildEvidencePack, evidencePackV2Of, type EvidenceV2Writer } from "../../packages/broker/src/core/proof/evidence-pack.js";
import type { ChangedFileEntry } from "../../packages/broker/src/core/proof/verification-report.js";
import { testingViewOf } from "../../packages/broker/src/core/proof/testing-section.js";
import { workflowPullRequestBody } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";

const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const OWNER_ID = "a".repeat(64);
const NOW = "2026-11-17T12:00:00.000Z";
const ORIGIN = "https://rovara.example";
const SESSION = `${ORIGIN}/t/482`;
const CODE = createCandidateManifest([{ repositoryId: "app", commitSha: "4c1d9e07".padEnd(40, "0"), treeSha: "2".repeat(40), baseCommitSha: "e".repeat(40) }]);
const BUDGET: AutoFixBudget = { enabled: false, dayBudgetHasRoom: false, baselineRequests: 0, spend: { spentUsd: wholeTaskSpendUsd(0), roundEstimateUsd: 0, capUsd: 15 } };
const command = (executable: string, args: string[]) => ({ cwd: "repo/app", executable, args, timeoutSeconds: 600 });
const checkOf = (id: string, label: string, executable: string, args: string[]) => ({ id, label, command: command(executable, args) });

type Over = Record<string, unknown>;

/** Text a repository, a person or a model could write, used by `exceptionsScenario(hostile)` for the plan, a requirement, a finding, a service, a lesson and a second-review line. */
let HOSTILE: string | undefined;

/** The task's checks, in the order the worker numbers them (`readiness:0` is the first). */
function policyOf(count: number) {
  const base = [checkOf("unit", "Unit tests", "npm", ["test"]), checkOf("int", "Integration tests", "npm", ["run", "test:integration"]), checkOf("lint", "Lint", "npm", ["run", "lint"]), checkOf("types", "Type check", "npm", ["run", "typecheck"])];
  const extra = Array.from({ length: Math.max(0, count - base.length) }, (_, index) => checkOf(`extra${index}`, `Package check ${index}`, "npm", ["run", `check:${index}`]));
  return { required: [...base, ...extra].slice(0, count), optional: [], selectedOptionalIds: [], proposed: [] };
}

function planOf(claims: number): PlanDocument {
  const claimTexts = [
    "The invoice page shows subtotal, tax and total.", "The PDF shows the same three lines.", "An order with no tax shows a zero tax line.", "The tax line follows the customer's region.",
  ];
  return {
    schemaVersion: 1, title: "Show tax on the invoice page and the invoice PDF", why: [{ text: "Customers ask where the tax went.", author: "Priya N." }],
    claims: Array.from({ length: claims }, (_, index) => ({ id: String(index + 1), text: index === 0 && HOSTILE !== undefined ? HOSTILE : claimTexts[index] ?? `Requirement number ${index + 1} of the large change holds for every package.` })),
    notChanging: ["The refund flow stays as it is."], risks: [],
    decisions: [],
    checks: { proposed: [checkOf("unit", "Unit tests", "npm", ["test"])], proves: { unit: ["1"], int: ["2"], lint: ["3"], types: ["4"] } },
  };
}

const planText = (): string => [
  "# Show tax on the invoice page and the invoice PDF", "", `1. ${HOSTILE ?? "Add a tax line to the invoice view model."}`, "2. Render it on the invoice page and in the PDF template.", "3. Cover zero-tax orders.", "",
].join("\n");

const checkEntry = (index: number, over: Over = {}) => ({ checkId: `readiness:${index}`, kind: "test", label: "npm test", before: "passed", after: "passed", class: "passing", durationMs: 700, exitCode: 0, ...over });
const testsOf = (passed: number, failed = 0) => ({ total: passed + failed, passed, failed, skipped: 0, errored: 0, names: [{ name: "invoice.test::shows tax", status: "passed" }], newTests: ["invoice.test::shows tax", "pdf.test::has tax line"] });

function packOf(scenario: Over): EvidencePack {
  const checks = (scenario["checks"] as Over[]);
  return EvidencePackSchema.parse({
    schemaVersion: 1, candidateDigest: CODE.digest,
    environment: { tier: "sandbox", envRevision: 7, services: [], data: "synthetic", accounts: [], ...(scenario["dependencies"] === undefined ? {} : { dependencies: scenario["dependencies"] }) },
    checks, selection: { method: "full", selected: 214, total: 214 }, api: [], browser: [], notTested: (scenario["notTested"] as Over[] | undefined) ?? [],
  });
}
void buildEvidencePack;

const WRITER: EvidenceV2Writer = { version: 2, producer: { edition: "code", isolation: "sandbox" } };

function testProofOf(checkCount: number, provenAt: readonly number[], compared = false): TestProof {
  return {
    schemaVersion: 1, candidateDigest: CODE.digest, status: "checked", note: "completed", changedTests: { added: 3, changed: 0, deleted: 0 }, durationMs: 1200,
    // A check that was compared and shows nothing has zeros: only then is "no test weakened" a thing the description may say.
    ...(compared ? { weakening: [{ checkId: "readiness:0", skippedBefore: 0, skippedAfter: 0, absentOnNew: [], absentOnNewCount: 0 }] } : {}),
    items: Array.from({ length: checkCount }, (_, index) => (provenAt.includes(index)
      ? { checkId: `readiness:${index}`, label: index === 0 ? "Unit tests" : "Integration tests", granularity: "check" as const, verdict: "proves_change" as const, reason: "assertion_failed_on_old" as const }
      : { checkId: `readiness:${index}`, label: "check", granularity: "check" as const, verdict: "not_applicable" as const, reason: "not_a_test_check" as const })),
  };
}

const review = (role: "CRITIC" | "SECURITY", over: Over = {}) => ({ operationId: `00000000-0000-4000-8000-00000000000${role === "CRITIC" ? 1 : 2}`, candidateDigest: CODE.digest, role, provider: "anthropic", version: "model-a", status: "PASS", findings: [], readOnly: true, recordedAt: NOW, ...over });

function workflowOf(over: Over): WorkflowSnapshot {
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER_ID, now: NOW, definitionVersion: "1.1.0" }), revision: 7,
    stage: "PULL_REQUEST", state: "READY", candidate: CODE, ...over,
  });
}

const person = (name: string, ref: string) => ({ state: "named" as const, name, ref });
const ATTRIBUTION: ActingAttribution = { requester: person("Priya N.", "a1b2c3d4e5f60718"), approver: person("Priya N.", "a1b2c3d4e5f60718"), auditUrl: `${ORIGIN}/audit/482` };

const file = (path: string, added: number, removed: number, over: Partial<ChangedFileEntry> = {}): ChangedFileEntry => ({ repository: "app", path, added, removed, ...over });

/** `inputs` are what the description was built from, for a test that builds another surface (the "Rovara" Check's verdict) from the very same facts. */
export interface Scenario { name: string; title: string; body: string; inputs: { workflow: WorkflowSnapshot; context: PullRequestBodyContext; proofLines: readonly string[] } }

function render(name: string, input: { workflow: WorkflowSnapshot; evidence: EvidencePack; claims: number; files: ChangedFileEntry[]; context: PullRequestBodyContext; dependencies?: Map<string, readonly { dependencyId: string; trust: "real" | "recorded" | "made_by_rovara" }[]>; checkCount: number; provenAt: readonly number[]; compared?: boolean; proofLines?: string[] }): Scenario {
  const read = readEvidencePack(JSON.parse(JSON.stringify(evidencePackV2Of(input.evidence, { ...WRITER, changedFiles: input.files }))));
  const outcome = testingViewOf({ workflow: input.workflow, facts: {}, budget: BUDGET, evidence: input.evidence, alreadyFailing: [] });
  const proof = {
    plan: planOf(input.claims), testProof: testProofOf(input.checkCount, input.provenAt, input.compared === true),
    evidence: { pack: input.evidence, read, mode: "link" as const, origin: ORIGIN, taskUrl: SESSION },
    ...(input.dependencies === undefined ? {} : { checkDependencies: input.dependencies }),
  };
  const context: PullRequestBodyContext = {
    changedFiles: { files: input.files, complete: true }, proof, evidenceWriter: 2, repositoryKnownPrivate: true, attribution: ATTRIBUTION,
    ...(outcome.view === undefined ? {} : { testing: outcome.view }), ...input.context,
  };
  const body = workflowPullRequestBodyOf(input.workflow, context, input.proofLines ?? []);
  return { name, title: "Rovara: Show tax on the invoice page and the invoice PDF", body, inputs: { workflow: input.workflow, context, proofLines: input.proofLines ?? [] } };
}

export const SCENARIO_TASK = { title: "Show tax on the invoice page and the invoice PDF" };
export const SCENARIO_PLAN_TEXT = planText;
export const SCENARIO_SESSION = SESSION;

function workflowPullRequestBodyOf(workflow: WorkflowSnapshot, context: PullRequestBodyContext, proofLines: readonly string[]): string {
  return workflowPullRequestBody({ title: "Show tax on the invoice page and the invoice PDF" }, workflow, planText(), SESSION, context, proofLines);
}

const LESSONS = { count: 2, taskUrl: SESSION, entries: [
  { title: "Money is stored in cents; format at the edge", notHelpfulUrl: `${SESSION}?lesson=1`, number: 1 },
  { title: "PDF templates live in templates/pdf, not in the route", notHelpfulUrl: `${SESSION}?lesson=2`, number: 2 },
] };

/** The typical task of design example 1, but with every requirement proven and the tests before and after compared. `agreed`: a second review in mode on agreed. */
export function greenScenario(variant: "today" | "clean" = "today"): Scenario {
  const provenAt = variant === "clean" ? [0, 1, 2] : [0];
  const compared = variant === "clean";
  const evidence = packOf({
    checks: [checkEntry(0, { tests: testsOf(176), label: "npm test" }), checkEntry(1, { label: "integration", tests: testsOf(38) }), checkEntry(2, { kind: "lint", label: "lint" }), checkEntry(3, { kind: "typecheck", label: "tsc" })],
    dependencies: [{ name: "Postgres", backing: "project_image", label: "real_project_image" }, { name: "Stripe", backing: "fake", label: "recorded_fake", recordedAt: "2026-10-14T00:00:00.000Z", fixtureRevision: 3 }],
  });
  const workflow = workflowOf({
    checkPolicy: policyOf(4),
    verification: { candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: NOW, results: ["unit", "int", "lint", "types"].map((checkId) => ({ checkId, status: "PASS" })) },
    reviews: [review("CRITIC", { risk: "low" }), review("SECURITY")],
  });
  return render(variant === "clean" ? "green-clean" : "green", {
    workflow, evidence, claims: 3, checkCount: 4, provenAt: provenAt, compared: compared, files: [file("src/invoice/view.ts", 40, 6), file("src/invoice/pdf.ts", 30, 4), file("tests/invoice/tax.test.ts", 9, 1), file("tests/invoice/pdf.test.ts", 7, 1)],
    dependencies: new Map([["unit", [{ dependencyId: "Postgres", trust: "real" as const }, { dependencyId: "Stripe", trust: "recorded" as const }]]]),
    context: { lessonsUsed: LESSONS, linearIssueKey: "ENG-482", reviewSameModel: false, ciBasis: "required", baseBranch: "main", secondReview: { state: "agreed" } },
  });
}

export function exceptionsScenario(hostile?: string): Scenario {
  HOSTILE = hostile;
  try {
    return exceptionsScenarioOf();
  } finally {
    HOSTILE = undefined;
  }
}

function exceptionsScenarioOf(): Scenario {
  const evidence = packOf({
    checks: [
      checkEntry(0, { after: "failed", class: "regression", tests: { ...testsOf(37, 1), names: [{ name: "refund.test::refund more than captured is refused", status: "failed" }] }, label: "npm test" }),
      checkEntry(1, { label: "integration", tests: testsOf(181) }), checkEntry(2, { kind: "lint", label: "lint" }), checkEntry(3, { kind: "typecheck", label: "tsc" }),
    ],
    dependencies: [{ name: "Postgres", backing: "project_image", label: "real_project_image" }, { name: HOSTILE === undefined ? "Stripe" : HOSTILE.slice(0, 80), backing: "fake", label: "rovara_made_fake", madeUpAnswers: 2, fixtureRevision: 1 }],
    notTested: [{ kind: "mocked_service", id: "stripe", text: "Stripe is mocked", reason: "answered from made-up responses" }],
  });
  const finding = { text: HOSTILE ?? "The refund amount is not checked against the amount already refunded", origin: "INTRODUCED", severity: "HIGH", file: "src/payments/refund.ts", line: 88 };
  const workflow = workflowOf({
    stage: "REVIEW", state: "WAITING", checkPolicy: policyOf(4),
    verification: { candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: NOW, results: [{ checkId: "unit", status: "FAILED" }, { checkId: "int", status: "PASS" }, { checkId: "lint", status: "PASS" }, { checkId: "types", status: "PASS" }] },
    reviews: [review("CRITIC", { risk: "high" }), review("SECURITY", { status: "FINDINGS", findings: [finding] })],
    acceptedFindings: [{ candidateDigest: CODE.digest, role: "SECURITY", fingerprint: workflowFindingFingerprint("SECURITY", finding), text: finding.text, reason: "Checked by hand: the payments service enforces it", actorId: OWNER_ID, at: NOW }],
  });
  return render("exceptions", {
    workflow, evidence, claims: 4, checkCount: 4, provenAt: [0, 1],
    files: [file("src/payments/refund.ts", 120, 30), file("src/orders/page.tsx", 60, 8), file("tests/orders/__snapshots__/order-page.snap", 10, 2, { snapshotChanged: true }), file("CLAUDE.md", 2, 0), file("tests/payments/refund.test.ts", 30, 0), file("tests/orders/refund.test.ts", 9, 0), file("src/orders/model.ts", 4, 0)],
    dependencies: new Map([["int", [{ dependencyId: "Stripe", trust: "made_by_rovara" as const }]]]),
    context: {
      lessonsUsed: { count: 1, taskUrl: SESSION, entries: [{ ...LESSONS.entries[0]!, title: HOSTILE ?? LESSONS.entries[0]!.title }] }, reviewSameModel: true, linearIssueKey: "ENG-517", ciBasis: "all_checks", baseBranch: "main",
      acceptedBy: { [workflowFindingFingerprint("SECURITY", finding)]: "Dana K. via the task page" },
      secondReviewLines: ["Second review (openai/model-b): 1 blocking finding", "- The refund amount is not checked against the amount already refunded (src/payments/refund.ts:88)"],
      secondReview: { state: "blocking", count: 1, model: "openai/model-b", findings: [{ text: HOSTILE ?? "The refund amount is not checked against the amount already refunded", file: "src/payments/refund.ts", line: 88 }] },
      mergeOrderLines: ["Merge the app pull request first, then the docs pull request."],
    },
    proofLines: ["Tests that fail on the original code: refund.test::partial refund amount"],
  });
}

export function largestScenario(): Scenario {
  const count = 40;
  const dependencies = Array.from({ length: 12 }, (_, index) => ({ name: `Service ${index}`, backing: "fake" as const, label: index % 2 === 0 ? "recorded_fake" as const : "hand_written_fake" as const, ...(index % 2 === 0 ? { recordedAt: "2026-07-02T00:00:00.000Z" } : {}), madeUpAnswers: 3 }));
  const evidence = packOf({
    checks: Array.from({ length: count }, (_, index) => checkEntry(index, { label: `check ${index}`, ...(index % 7 === 3 ? { after: "failed", class: "regression" } : {}) })),
    dependencies,
    notTested: Array.from({ length: 12 }, (_, index) => ({ kind: "mocked_service", id: `svc${index}`, text: `Service ${index} is mocked`, reason: "answered from recorded responses" })),
  });
  const findings = Array.from({ length: 20 }, (_, index) => ({ text: `Finding number ${index} about retries in module ${index}`, origin: "INTRODUCED", severity: "MEDIUM", file: `src/module${index}.ts`, line: index + 1 }));
  const workflow = workflowOf({
    stage: "REVIEW", state: "WAITING", checkPolicy: policyOf(count),
    verification: { candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: NOW, results: Array.from({ length: count }, (_, index) => ({ checkId: index < 4 ? ["unit", "int", "lint", "types"][index]! : `extra${index - 4}`, status: index % 7 === 3 ? "FAILED" : "PASS" })) },
    reviews: [review("CRITIC", { risk: "high", status: "FINDINGS", findings }), review("SECURITY")],
    acceptedFindings: findings.map((finding) => ({ candidateDigest: CODE.digest, role: "CRITIC", fingerprint: workflowFindingFingerprint("CRITIC", finding), text: finding.text, reason: `Reason ${finding.line}: accepted after reading ${finding.file}`, actorId: OWNER_ID, at: NOW })),
  });
  const files = Array.from({ length: 300 }, (_, index) => file(index === 0 ? "db/migrations/001.sql" : `packages/pkg${index % 12}/src/file${index}.ts`, 20 + index, index % 5));
  return render("largest", {
    workflow, evidence, claims: 40, checkCount: count, provenAt: [0], files,
    context: {
      lessonsUsed: { count: 30, taskUrl: SESSION, entries: Array.from({ length: 30 }, (_, index) => ({ title: `Lesson ${index}: a rule about module ${index} that is worth remembering`, notHelpfulUrl: `${SESSION}?lesson=${index}`, number: index + 1 })) },
      linearIssueKey: "ENG-900", ciBasis: "required", baseBranch: "main",
      secondReviewLines: ["Second review (openai/model-b): 6 blocking findings", ...Array.from({ length: 5 }, (_, index) => `- Blocking finding ${index} about the retry loop (src/module${index}.ts:${index + 1})`)],
      mergeOrderLines: ["Merge order line one.", "Merge order line two.", "Merge order line three.", "Merge order line four."],
    },
  });
}

export const SCENARIOS: ReadonlyArray<{ name: string; build: () => Scenario }> = [
  { name: "green", build: () => greenScenario() }, { name: "green-clean", build: () => greenScenario("clean") }, { name: "exceptions", build: exceptionsScenario }, { name: "largest", build: largestScenario },
];
