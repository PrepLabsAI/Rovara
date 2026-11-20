// Plan 6 Task 13: the pull request description of a Rovara Code (version 2) task, and the risk level. The risk level comes from defined inputs (the paths and size of the change,
// the checks, the findings the owner accepted and the code reviewer's own level), never from free model text. The description is public to the repository's readers: every
// model-written line is redacted and made inert (no mention, link or cross-reference), the whole body is bounded, and a version 1 task's description is exactly as before.
// (Port lane L7b: the cases that went through Cloud's broker and its state table are not here; they are the task flow's (lane L6a).)
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type VerificationReport } from "../../packages/contracts/src/index.js";
import { workflowFindingFingerprint } from "../../packages/contracts/src/task-workflow.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { RISK_SENSITIVE_PATH_PATTERNS, assessRisk, isSensitivePath, type RiskInput } from "../../packages/broker/src/core/proof/risk.js";
import { parseChangedFiles } from "../../packages/broker/src/core/proof/changed-files.js";
import { recomputeRisk, withLinearCloseLine } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { pullRequestTitle, workflowPullRequestBody, workflowPullRequestStatusLines } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";
import { rewriteAttributionBody } from "../../packages/contracts/src/attribution.js";
import { feedbackFixesSection, withFeedbackFixes, withStatusLines } from "../../packages/broker/src/developer/pull-request-feedback-section.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const now = "2026-10-25T12:00:00.000Z";
const digest = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]).digest;
const candidate = (letter: string) => createCandidateManifest([{ repositoryId: "payments", commitSha: letter.repeat(40), treeSha: letter.repeat(40), baseCommitSha: "e".repeat(40) }]);
const check = (id: string, label: string) => ({ id, label, command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } });

const cleanReport: VerificationReport = { reviewOnly: false, passed: [{ label: "Unit tests" }], failed: [], notChecked: [], testsAdded: [] };
const file = (path: string, added = 3, removed = 1) => ({ repository: "payments", path, added, removed });
function riskInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return { changedFiles: [file("src/retry.ts")], changedFilesComplete: true, report: cleanReport, acceptedFindings: [], securityFindings: 0, candidateDigest: digest, ...overrides };
}

describe("assessRisk", () => {

  it("every sensitive directory, file pattern and the workflows folder is high, in any folder and in any case", () => {
    for (const path of [
      "migrations/1.ts", "app/auth/login.ts", "authn/x.ts", "a/authz/x.ts", "payments/charge.ts", "svc/billing/invoice.ts", "secrets/x.json", "iam/policy.json", "infra/main.ts",
      "terraform/net.tf", "cdk/stack.ts", ".github/workflows/ci.yml", "schema.sql", "deploy/main.tf", "Dockerfile", "services/api/Dockerfile", "Auth/Login.ts", "Db/Migrations/2.ts",
    ]) {
      expect(isSensitivePath(path), path).toBe(true);
      expect(assessRisk(riskInput({ changedFiles: [file(path)] })).level, path).toBe("high");
    }
    // The workflows folder is two segments; neither alone is sensitive.
    expect(isSensitivePath(".github/CODEOWNERS")).toBe(true); // since the review of 2026-10-27: who must approve is a governance file
    expect(isSensitivePath("docs/workflows/overview.md")).toBe(false);
    expect(isSensitivePath("src/Dockerfile.md")).toBe(false);
    expect(RISK_SENSITIVE_PATH_PATTERNS.length).toBeGreaterThan(0);
  });

  it("an accepted code finding is medium and an accepted security finding is high", () => {
    expect(assessRisk(riskInput({ acceptedFindings: [{ role: "CRITIC" }] })).level).toBe("medium");
    expect(assessRisk(riskInput({ acceptedFindings: [{ role: "SECURITY" }] })).level).toBe("high");
    // A security finding the review introduced counts even when the accepted list no longer holds it.
    expect(assessRisk(riskInput({ securityFindings: 1 })).level).toBe("high");
  });
});

// ---- the files of a diff, as the risk rules need them (review fixes I1 and I4)

describe("parseChangedFiles", () => {
  const section = (status: string[], diff: string[]) => ["## payments", "", "### status", ...status, "### diff", ...diff].join("\n");
  const hunk = (path: string, plus = 2, minus = 1): string[] => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...Array.from({ length: minus }, () => "-old"), ...Array.from({ length: plus }, () => "+new")];

  it("counts a tracked file's lines inside its hunks, and leaves a file it can't count without a count (not 0)", () => {
    const text = section([" M src/a.ts", "?? src/big.ts", "?? src/other.ts"], [
      ...hunk("src/a.ts", 3, 2),
      "diff --git a/img/logo.png b/img/logo.png", "index 1..2 100644", "GIT binary patch", "literal 10", "zc$@",
      "diff --git a/bin/run.sh b/bin/run.sh", "old mode 100644", "new mode 100755",
    ]);
    const read = parseChangedFiles(text);
    expect(read.complete).toBe(true);
    expect(read.files).toEqual([
      { repository: "payments", path: "src/a.ts", added: 3, removed: 2 },
      { repository: "payments", path: "img/logo.png" },
      { repository: "payments", path: "bin/run.sh" },
      { repository: "payments", path: "src/big.ts" },
      { repository: "payments", path: "src/other.ts" },
    ]);
  });

  it("reads Git's quoted paths, in a header and in the untracked list, as the real names", () => {
    const text = section(['?? "auth/\\303\\274-new.ts"', '?? "dir with \\"quote\\"/x.ts"'], [
      'diff --git "a/auth/\\303\\274.ts" "b/auth/\\303\\274.ts"', '--- "a/auth/\\303\\274.ts"', '+++ "b/auth/\\303\\274.ts"', "@@ -1 +1 @@", "-a", "+b",
      'diff --git a/lib/ok.ts "b/lib/\\303\\266k.ts"', "@@ -1 +1 @@", "-a", "+b",
    ]);
    expect(parseChangedFiles(text).files.map((file) => file.path)).toEqual(["auth/\u00fc.ts", "lib/\u00f6k.ts", "auth/\u00fc-new.ts", 'dir with "quote"/x.ts']);
    // The quotes and escapes are gone, so a segment rule sees the directory.
    expect(parseChangedFiles(text).files.some((file) => isSensitivePath(file.path))).toBe(true);
  });

  it("is incomplete when the diff was cut, its base was gone, or it names as many files as it keeps", () => {
    expect(parseChangedFiles(`${section([], hunk("a.ts"))}\n\n[workspace diff truncated to fit the AgentX artifact limit]\n`).complete).toBe(false);
    expect(parseChangedFiles(`## payments\n\n[the commit this workspace was prepared at is not in this repository: x]\n### status\n### diff\n`).complete).toBe(false);
    expect(parseChangedFiles(section([], Array.from({ length: 200 }, (_, index) => hunk(`f${index}.ts`)).flat())).complete).toBe(false);
    expect(parseChangedFiles(section([], hunk("a.ts"))).complete).toBe(true);
  });
});

// Blind test 02 (staging 0.4.13): GET /items changed from a list to an envelope and the description said "Risk: Low" without a word about it. The diff says it: a route declaration and a response
// schema changed. Rovara reads that from the diff itself (no model), and the risk then says that existing callers may see a different response.
describe("a changed public API or response shape", () => {
  const section = (diff: string[]) => ["## inventory", "", "### status", "### diff", ...diff].join("\n");
  const change = (path: string, minus: string[], plus: string[]): string[] => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...minus.map((line) => `-${line}`), ...plus.map((line) => `+${line}`)];

  it("shows in the description's Risk section for the diff of the blind test's pull request", () => {
    const diff = section([
      ...change("inventory/app.py", ['    @app.get("/items", response_model=list[ItemView])'], ['    @app.get("/items", response_model=ItemPage)']),
      ...change("inventory/catalog.py", ["def items(session):"], ["def all_items(session):"]),
      ...change("inventory/schemas.py", [], ["class ItemPage(BaseModel):", "    total: int"]),
    ]);
    const read = parseChangedFiles(diff);
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, { changedFiles: read });
    const risk = aboveFold(body);
    expect(risk).toContain("Medium risk");
    expect(risk).toMatch(/public API route or response shape/);
    expect(risk).toContain("inventory/app.py");
  });
});

describe("a file whose lines were not counted", () => {
  const entry = (path: string, more: Record<string, unknown> = {}) => ({ repository: "payments", path, ...more });

  it("is unknown, not 0: the risk is at least medium and says why", () => {
    const risk = assessRisk(riskInput({ changedFiles: [file("src/a.ts", 3, 1), entry("src/new-module.ts"), entry("img/logo.png")] }));
    expect(risk.level).toBe("medium");
    expect(risk.reasons.join("\n")).toMatch(/2 files have no line count/);
    expect(assessRisk(riskInput({ changedFiles: [entry("src/new-module.ts")] })).reasons.join("\n")).toMatch(/1 file has no line count/);
    // A file counted on one side only is not counted.
    expect(assessRisk(riskInput({ changedFiles: [{ repository: "payments", path: "src/half.ts", added: 3 }] })).reasons.join("\n")).toMatch(/1 file has no line count/);
    // A file whose lines were counted says nothing of the kind.
    expect(assessRisk(riskInput({ changedFiles: [file("src/a.ts", 3, 1)] })).level).toBe("low");
  });

  it("is shown as not counted, never as +0 -0, and the totals say at least", () => {
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ changedFiles: { files: [file("src/a.ts", 3, 1), entry("src/new-module.ts")], complete: true } }));
    // The per-file list is GitHub's own; the count says the totals are a floor, and nothing says +0 -0.
    expect(body).not.toContain("+0 -0");
    expect(body).toContain("**Changed** 2 files, at least +3 -1.");
    expect(body).toContain("Medium risk");
  });
});

// ---- the description

function workflowWith(extra: Record<string, unknown> = {}, definitionVersion: "1.0.0" | "1.1.0" = "1.1.0"): WorkflowSnapshot {
  const code = candidate("1");
  const review = (role: "CRITIC" | "SECURITY", more: Record<string, unknown> = {}) => ({
    operationId: randomUUID(), candidateDigest: code.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now, ...more,
  });
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId, now, definitionVersion }),
    stage: "PULL_REQUEST", state: "READY", candidate: code,
    checkPolicy: { required: [check("unit", "Unit tests")], optional: [], selectedOptionalIds: [], proposed: [] },
    verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: [review("CRITIC"), review("SECURITY")],
    ...extra,
  });
}
const task = { title: "Add a retry flag" } as never;
const SESSION = "https://rovara.example/review/8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6/task";
const CLOSING = "Opened by Rovara after the approved plan, checks and reviews. A person must approve it and a person merges it.";
const START = "<!-- rovara:checks-and-reviews -->";
const END = "<!-- /rovara:checks-and-reviews -->";
const context = (extra: Record<string, unknown> = {}) => ({
  changedFiles: { files: [file("src/retry.ts", 10, 2), file("src/retry.test.ts", 30, 0)], complete: true }, ...extra,
});
const planOf = "# Plan\n\n1. Add the retry flag.\n2. Add a regression test.\n";
/** L4-C: the text of one drawer of the redesigned description, from its summary's first words to its closing tag; "" when there is none. */
const drawer = (body: string, summaryStart: string): string => {
  const at = body.indexOf(`<summary>${summaryStart}`);
  return at === -1 ? "" : body.slice(at, body.indexOf("</details>", at));
};
/** The part of the description a reader sees without opening a drawer: from the start to the first drawer. */
const aboveFold = (body: string): string => body.slice(0, body.indexOf("<details>"));

describe("the version 2 pull request description", () => {
  it("names who asked and who approved the plan, outside the marked block, before the session link (I3)", () => {
    const attribution = {
      requester: { state: "named", name: "Maya Chen", ref: "0123456789abcdef" }, approver: { state: "former" },
      auditUrl: "https://rovara.example/v1/app/audit/view?action=pull_request.opened",
    } as const;
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ attribution }));
    const lines = ["Requested by: Maya Chen", "Plan approved by: a former member", "Audit record: https://rovara.example/v1/app/audit/view?action=pull_request.opened"];
    for (const line of lines) {
      expect(body.split(line), line).toHaveLength(2);
      expect(body.indexOf(line), line).toBeGreaterThan(body.indexOf(END));
      expect(body.indexOf(line), line).toBeLessThan(body.indexOf(`Rovara session: ${SESSION}`));
    }
    // Each is a line of its own, so erasing one person rewrites exactly that person's line (the owner's ruling on erasure) and nothing else.
    const named = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ attribution: { requester: { state: "named", name: "Maya Chen", ref: "0123456789abcdef" }, approver: { state: "named", name: "Priya Raman", ref: "fedcba9876543210" }, auditUrl: "https://rovara.example/v1/app/audit/view?x=1" } }));
    const requesterErased = rewriteAttributionBody(named, "requester");
    expect(requesterErased).not.toContain("Maya Chen");
    expect(requesterErased).toContain("Plan approved by: Priya Raman\n");
    expect(requesterErased).toContain("Audit record: https://rovara.example/v1/app/audit/view?x=1");
    const approverErased = rewriteAttributionBody(named, "approver");
    expect(approverErased).not.toContain("Priya Raman");
    expect(approverErased).toContain("Requested by: Maya Chen\n");
    // Only the name: never the person's reference.
    expect(body).not.toContain("0123456789abcdef");
    expect(body.trimEnd().endsWith(CLOSING)).toBe(true);
    // Without attribution the description is exactly what it was.
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context())).not.toContain("Requested by");
  });

  it("names a failed check, a check that couldn't run and a review-only change in Tests", () => {
    const failing = workflowWith({
      stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results", reviews: undefined,
      checkPolicy: { required: [check("unit", "Unit tests"), check("lint", "Lint"), check("types", "Types")], optional: [], selectedOptionalIds: [], proposed: [] },
      verification: { candidateDigest: candidate("1").digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now,
        results: [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "FAILED" }, { checkId: "types", status: "FAILED", programNotFound: true }] },
    });
    const failedBody = workflowPullRequestBody(task, failing, planOf, SESSION, context());
    // A failed check and a check that could not run are above the fold, by name, and the heading says the result.
    expect(aboveFold(failedBody)).toContain("A check failed.");
    expect(aboveFold(failedBody)).toContain("A check was blocked.");
    expect(failedBody.split("\n").find((line) => line.startsWith("## "))).toContain("Checks failed");
    const tests = drawer(failedBody, "Checks: ");
    expect(tests).toContain("| Lint | `npm test` | ❌ failed");
    expect(tests).toContain("| Types | `npm test` | ⛔ blocked");
    // The failed row is the first row of the table.
    expect(tests.indexOf("| Lint ")).toBeLessThan(tests.indexOf("| Unit tests "));
    const reviewOnly = workflowWith({
      stage: "REVIEW", state: "WAITING", reviews: undefined,
      checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [], noneReason: "Documentation only" },
      verification: { candidateDigest: candidate("1").digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [], reviewOnly: true },
    });
    const body = workflowPullRequestBody(task, reviewOnly, planOf, SESSION, context());
    expect(aboveFold(body)).toContain("Not verified by automated checks (review only)");
    expect(aboveFold(body)).toContain("Why: Documentation only");
    expect(body.split("\n").find((line) => line.startsWith("## "))).not.toContain("Verified ·");
  });

  it("shows the plan's words as a quotation under their own heading, so they can't pose as one of Rovara's sections", () => {
    const spoof = ["## Risk: Low", "```", "---", "> deeper", "[1]: http://evil.example/x", "# Tests", "- Passed: everything"].join("\n");
    const body = workflowPullRequestBody(task, workflowWith(), spoof, SESSION, context({ changedFiles: { files: [file("infra/main.ts")], complete: true } }));
    const lines = body.split("\n");
    // Rovara's own heading is the only one, and the plan's words are quotations: the one-line quote on top, and the closing drawer's lines.
    expect(lines.filter((line) => /^#{1,6} /.test(line) && !line.startsWith("### Check these"))).toEqual([lines.find((line) => line.startsWith("## High") || line.startsWith("## Checks passed"))]);
    expect(lines[0]!.startsWith("> ")).toBe(true);
    expect(lines.indexOf(START)).toBe(2);
    expect(drawer(body, "Plan and record").split("\n").filter((line) => /^(?:#{1,6} |```|---|\[1\]:)/.test(line))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("```"))).toEqual([]);
    // The task's title, used when there is no plan, is quoted the same way.
    const titled = workflowPullRequestBody({ title: "## Risk: Low" }, workflowWith(), undefined, SESSION, context());
    expect(titled.split("\n").filter((line) => /^## Risk/.test(line))).toEqual([]);
    expect(titled.split("\n")[0]).toBe("> ## Risk: Low");
  });

  it("neutralises character references and issue shorthands as well as the characters themselves", () => {
    const body = workflowPullRequestBody(task, workflowWith(), "Thanks &#x40;octocat and &#64;octocat and &commat;octocat, see GH-123 and gh-9 &amp; more", SESSION, context());
    expect(body).not.toMatch(/&#/);
    expect(body).not.toContain("&commat;");
    expect(body).toContain("&amp;#x40;octocat");
    expect(body).toContain("&amp;amp; more");
    expect(body).not.toMatch(/GH-\d/i);
  });

  it("stays under the byte cap whatever it is given, and keeps its markers, risk and closing line", () => {
    const longPlan = Array.from({ length: 400 }, (_, index) => `${index}. ${"A long plan sentence. ".repeat(40)}`).join("\n");
    const files = Array.from({ length: 200 }, (_, index) => file(`src/${"deep/".repeat(80)}file-${index}.test.ts`, 5, 5));
    const labels = Array.from({ length: 60 }, (_, index) => check(`c${index}`, `Check number ${index} ${"label ".repeat(10)}`));
    const findings = Array.from({ length: 20 }, (_, index) => ({ text: `Finding ${index} ${"text ".repeat(100)}`.slice(0, 600), origin: "PRE_EXISTING", severity: "LOW", file: `src/f${index}.ts`, line: 1 }));
    const code = candidate("1");
    const heavy = workflowWith({
      checkPolicy: { required: labels, optional: [], selectedOptionalIds: [], proposed: [] },
      verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: labels.map((item) => ({ checkId: item.id, status: "PASS" })) },
      reviews: [
        { operationId: randomUUID(), candidateDigest: code.digest, role: "CRITIC", provider: "t", version: "1", status: "PASS", findings, readOnly: true, recordedAt: now },
        { operationId: randomUUID(), candidateDigest: code.digest, role: "SECURITY", provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now },
      ],
      acceptedFindings: findings.map((finding) => ({ candidateDigest: code.digest, role: "CRITIC", fingerprint: workflowFindingFingerprint("CRITIC", finding), text: finding.text, reason: "r".repeat(500), actorId: ownerId, at: now })),
    });
    const body = workflowPullRequestBody(task, heavy, longPlan, SESSION, { changedFiles: { files, complete: true } });
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(30_000);
    expect(body.split(START)).toHaveLength(2);
    expect(body.split(END)).toHaveLength(2);
    expect(body).toMatch(/\n## .* risk · /u);
    expect(body).toContain("**Risk** ");
    expect(body).toContain(`Rovara session: ${SESSION}`);
    expect(body.trimEnd().endsWith(CLOSING)).toBe(true);
    // A body that big can still be regenerated in place.
    expect(withStatusLines(body, ["- a new line"])).toBeDefined();
  });
});

// Blind test 02 (staging 0.4.13): the plan said "Four files change" and the pull request changed five. The count of files comes from the diff; a model's count that differs is corrected in place and
// says what the plan had said.
describe("the plan summary's file count", () => {
  const fiveFiles = { files: ["a.py", "b.py", "c.py", "tests/test_a.py", "tests/test_b.py"].map((path) => file(path, 3, 1)), complete: true };
  /** The summary the description quotes; `changedFiles` is the diff's list, left out when `undefined` is passed. */
  const summaryOf = (plan: string, ...given: [unknown?]) => {
    const body = workflowPullRequestBody(task, workflowWith(), plan, SESSION, (given.length === 0 ? { changedFiles: fiveFiles } : given[0] === undefined ? {} : { changedFiles: given[0] }) as never);
    // The plan's lines are in the closing "Plan and record" drawer (the one-line quote above the block is its first line).
    return drawer(body, "Plan and record");
  };

  it("is corrected in the other common phrasing too, and for digits", () => {
    expect(summaryOf("# Plan\n\nThe change touches 3 files and adds a test.\n")).toContain("touches 5 files (the plan said 3) and adds a test.");
    expect(summaryOf("# Plan\n\nOne file changes.\n", { files: [file("a.py")], complete: true }).includes("(the plan said")).toBe(false);
    expect(summaryOf("# Plan\n\nTwo files change.\n", { files: [file("a.py")], complete: true })).toContain("1 file change (the plan said two).");
  });

  it("is left as the plan wrote it when it matches the diff, when the diff's list is incomplete or missing, and when it counts something else", () => {
    expect(summaryOf("# Plan\n\nFive files change.\n")).toContain("Five files change.");
    expect(summaryOf("# Plan\n\nFour files change.\n", { ...fiveFiles, complete: false })).toContain("Four files change.");
    expect(summaryOf("# Plan\n\nFour files change.\n", undefined)).toContain("Four files change.");
    expect(summaryOf("# Plan\n\nThree test files change and two modules are renamed.\n")).toContain("Three test files change");
    expect(summaryOf("# Plan\n\nFour files change.\n").includes("(the plan said")).toBe(true);
  });
});

describe("the Tests section names the commit that was tested", () => {
  const testsOf = (body: string) => drawer(body, "Checks: ");

  it("names each repository when the task changed more than one", () => {
    const two = createCandidateManifest([
      { repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "a".repeat(40), baseCommitSha: "e".repeat(40) },
      { repositoryId: "web", commitSha: "b".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) },
    ]);
    const workflow = workflowWith({ candidate: two, verification: { candidateDigest: two.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: (["CRITIC", "SECURITY"] as const).map((role) => ({ operationId: randomUUID(), candidateDigest: two.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })) });
    expect(testsOf(workflowPullRequestBody(task, workflow, planOf, SESSION, context()))).toContain("- Tested on head commits: payments aaaaaaaa, web bbbbbbbb");
  });
});

describe("which findings, reviews and recorded risk count", () => {

  it("a risk recorded for this code stands when the files can't be read now, and one recorded for other code does not", () => {
    const recorded = (letter: string) => ({ level: "high" as const, reasons: ["Changes sensitive paths: infra/main.ts."], candidateDigest: candidate(letter).digest });
    expect(workflowPullRequestBody(task, workflowWith({ risk: recorded("1") }), planOf, SESSION, {})).toContain("infra/main.ts");
    const stale = workflowPullRequestBody(task, workflowWith({ risk: recorded("2") }), planOf, SESSION, {});
    expect(stale).toContain("Rovara couldn't list every changed file.");
    expect(stale).not.toContain("infra/main.ts");
  });
});

describe("the risk is recomputed whenever the code on the pull request changes", () => {

  it("uses the code reviewer's level and the owner's accepted findings for this candidate only", () => {
    const reviewed = workflowWith({ reviews: workflowWith().reviews!.map((review) => review.role === "CRITIC" ? { ...review, risk: "medium" } : review) });
    expect(recomputeRisk(reviewed, context().changedFiles, {}).risk?.level).toBe("medium");
  });

  it("a version 1 task shows no risk, however it is asked", () => {
    const v1 = workflowWith({}, "1.0.0");
    expect(recomputeRisk(v1, context().changedFiles, {})).toBe(v1);
    expect(recomputeRisk(v1, context().changedFiles, {})).not.toHaveProperty("risk");
  });
});

// ---- Plan 6 Task 20 review fixes: no text but Rovara's own Fixes line may name a Linear issue

/** The Linear-key-shaped tokens in a text (a title carries none). The session link (a uuid) is cut out first. */
const bareKeys = (text: string) => (text.replace(SESSION, "").match(/[A-Za-z][A-Za-z0-9]*-\d+/gu) ?? []);
/** What Linear acts on: a magic word (closing or linking) as a whole word, then a key within a few characters. The session link is cut out first. */
const MAGIC = /(?<![A-Za-z0-9])(?:close[sd]?|closing|fix(?:es|ed|ing)?|resolve[sd]?|resolving|complete[sd]?|completing|implement(?:s|ed|ing)?|refs?|references|towards?|updates|part\s+of|contributes?\s+to|relates?\s+to|related\s+to)(?![A-Za-z0-9])(?:[^A-Za-z0-9]|&[a-z]+;|&#x?[0-9a-f]+;){0,12}[A-Za-z][A-Za-z0-9]*\\?-\d+/giu;
const readable = (text: string) => (text.replace(SESSION, "").match(MAGIC) ?? []).map((found) => found.replace(/[^A-Za-z0-9-]+/gu, " ").trim());

describe("every text path into a version 2 pull request leaves no Linear key but Rovara's own Fixes line", () => {
  const OWN = "ENG-142";
  const withOwn = (extra: Record<string, unknown> = {}) => context({ linearIssueKey: OWN, ...extra });
  const onlyOwn = (body: string) => expect(readable(body)).toEqual(["Fixes ENG-142"]);
  const accepted = (text: string, reason: string) => {
    const finding = { text, origin: "INTRODUCED", severity: "HIGH", file: "src/retry.ts", line: 4 };
    const code = candidate("1");
    return workflowWith({
      reviews: [
        { operationId: randomUUID(), candidateDigest: code.digest, role: "CRITIC", provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now },
        { operationId: randomUUID(), candidateDigest: code.digest, role: "SECURITY", provider: "t", version: "1", status: "FINDINGS", findings: [finding], readOnly: true, recordedAt: now },
      ],
      acceptedFindings: [{ candidateDigest: code.digest, role: "SECURITY", fingerprint: workflowFindingFingerprint("SECURITY", finding), text, reason, actorId: ownerId, at: now }],
    });
  };

  it("an accepted review finding, and the owner's reason for accepting it", () => {
    const body = workflowPullRequestBody(task, accepted("This also fixes OPS-12's null check", "Closes OPS-13 as well"), planOf, SESSION, withOwn());
    expect(body).toContain("Owner accepted 1 review finding");
    onlyOwn(body);
    expect(body.replaceAll("‍", "")).toContain("This also fixes OPS-12's null check");
    // The same through the block that a pushed fix rewrites.
    const lines = workflowPullRequestStatusLines(accepted("_Fixes OPS-12_", "see (OPS-13)"), withOwn());
    expect(readable(lines.join("\n"))).toEqual(["Fixes ENG-142"]);
  });

  it("a changed file's path, its old name and its repository", () => {
    const files = [{ repository: "payments", path: "docs/OPS-12-notes.md", added: 1, removed: 0 }, { repository: "OPS-14", path: "src/new.ts", renamedFrom: "src/Fixes-OPS-15.ts", added: 1, removed: 1 }];
    onlyOwn(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, withOwn({ changedFiles: { files, complete: true } })));
  });

  it("the 'Fixes from PR feedback' section, which a reviewer model writes from comments anyone can post", () => {
    const fixes = [
      { summary: "Fixes OPS-12 and the null check", comments: ["https://github.com/example/demo/pull/42#issuecomment-1"] },
      { summary: "_Part of OPS-13_: closes OPS-14", comments: [] },
      { summary: "Resolves UTF-8 handling", comments: ["https://github.com/example/demo/pull/42#issuecomment-2", "https://github.com/example/demo/pull/42#issuecomment-3"] },
    ];
    const section = withFeedbackFixes(`${workflowPullRequestBody(task, workflowWith(), planOf, SESSION, withOwn())}`, fixes);
    expect(section.body).toBeDefined();
    expect(readable(section.body!)).toEqual(["Fixes ENG-142"]);
    // Ordinary text of the section is as it was.
    expect(section.body).toContain("Fixes from PR feedback");
    expect(section.body).toContain("the null check");
    expect(readable(feedbackFixesSection(fixes, 10_000))).toEqual([]);
  });
});

describe("a pull request's title names no issue", () => {
  it("a task's title with a bare key, or a closing word and a key, comes out with the key broken", () => {
    for (const title of ["ENG-9 login retry", "Fixes OTHER-9 by adding a retry flag", "_Closes OPS-1_ now", "Retry (OPS-2)"]) {
      const made = pullRequestTitle(title, true);
      expect(bareKeys(made), title).toEqual([]);
      expect(made.replaceAll("\u200D", ""), title).toContain("Rovara: ");
    }
  });

  it("a version 1 task's title is as it was", () => {
    expect(pullRequestTitle("ENG-9 login retry", false)).toBe("AgentX: ENG-9 login retry");
  });
});

describe("the open pull request's Fixes line follows the binding at once", () => {
  const BLOCK = (...lines: string[]) => ["Plan", "", START, "## Risk: Low", "- ok", ...lines, END, "Rovara session: x", CLOSING].join("\n");

  it("withLinearCloseLine takes Rovara's line out, puts a new one in, and touches nothing outside the block", () => {
    const withOld = `A note from Priya. Fixes ENG-1 by hand.\n\n${BLOCK("", "Fixes ENG-142")}`;
    const removed = withLinearCloseLine(withOld, undefined);
    expect(removed).toEqual({ kind: "changed", body: `A note from Priya. Fixes ENG-1 by hand.\n\n${BLOCK()}` });
    const body = (removed as { body: string }).body;
    expect(body).not.toContain("Fixes ENG-142");
    expect(body).toContain("A note from Priya. Fixes ENG-1 by hand.");
    expect(body.split(START)).toHaveLength(2);
    expect(withLinearCloseLine(withOld, "ENG-143")).toEqual({ kind: "changed", body: withOld.replace("Fixes ENG-142", "Fixes ENG-143") });
    expect(withLinearCloseLine(BLOCK(), "ENG-143")).toEqual({ kind: "changed", body: BLOCK("", "Fixes ENG-143") });
    expect(withLinearCloseLine(withOld, "ENG-142")).toEqual({ kind: "same" });
    expect(withLinearCloseLine(BLOCK(), undefined)).toEqual({ kind: "same" });
  });

  it("keeps a CRLF description's endings, and refuses a description whose block is not as Rovara wrote it", () => {
    const crlf = BLOCK("", "Fixes ENG-142").replaceAll("\n", "\r\n");
    const changed = withLinearCloseLine(crlf, "ENG-143") as { kind: string; body: string };
    expect(changed.body).toContain("Fixes ENG-143\r\n");
    expect(changed.body).not.toMatch(/[^\r]\n/u);
    for (const odd of [`${START}\nx`, `x\n${END}`, `${END}\n${START}`, `${START}\n${START}\n${END}`, "no block at all"]) {
      expect(withLinearCloseLine(odd, "ENG-143"), odd).toEqual({ kind: "no_block" });
    }
    expect(withLinearCloseLine("no block at all", undefined)).toEqual({ kind: "same" });
  });
});

// #412 (A1) merged into Cloud: the test-proof lines go at the end of the version 2 Tests section, and only when given.
describe("the version 2 description carries the test proof", () => {
  const PROOF = "Test proof: 1 check fails on the original code and passes now";

  it("carries them in the status block a later update rewrites when they are given", () => {
    const lines = workflowPullRequestStatusLines(workflowWith(), context(), [PROOF]);
    expect(lines).toContain(`- ${PROOF}`);
    expect(workflowPullRequestStatusLines(workflowWith(), context())).not.toContain(`- ${PROOF}`);
  });
});

// ---- TE-H1 slice 2 (DEC 241d): browser evidence on the pull request is text only, and absent means the description it always was

describe("the browser evidence lines of the description", () => {
  const lines = [
    "Browser evidence: Run by Rovara in its sandbox. Visual evidence only: it does not count as change proof.",
    "- `/checkout`: before and after screenshots (on the task page, behind sign-in)",
    "- `/settings`: Not run: the page did not load",
  ];
  it("version 2 (Rovara Code): one section after the proof, the lines as given; with none, the very same description byte for byte", () => {
    const without = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context());
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ browserEvidenceLines: [] }))).toBe(without);
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ browserEvidenceLines: undefined }))).toBe(without);
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ browserEvidenceLines: lines }));
    // One drawer with the count in its summary and the lines as given; the page that did not run is a thing to check above the fold.
    expect(body).toContain(["<summary>Screenshots: 1 page on the task page</summary>", "", ...lines].join("\n"));
    expect(aboveFold(body)).toContain("**The browser evidence did not fully run.**");
    expect(aboveFold(body)).toContain("`/settings`: Not run: the page did not load");
    expect(without).not.toContain("Screenshots");
    expect(without).not.toContain("Browser evidence");
  });
  it("version 1: the lines join the status block after the proof lines; with none, the block it always was", () => {
    const plain = workflowPullRequestStatusLines(workflowWith({}, "1.0.0"), context());
    expect(workflowPullRequestStatusLines(workflowWith({}, "1.0.0"), context({ browserEvidenceLines: [] }))).toEqual(plain);
    expect(workflowPullRequestStatusLines(workflowWith({}, "1.0.0"), context({ browserEvidenceLines: lines }))).toEqual([...plain, ...lines]);
    const full = workflowPullRequestBody(task, workflowWith({}, "1.0.0"), planOf, SESSION, context({ browserEvidenceLines: lines }));
    for (const entry of lines) expect(full).toContain(entry);
    expect(workflowPullRequestBody(task, workflowWith({}, "1.0.0"), planOf, SESSION, context())).not.toContain("Browser evidence");
  });
});
