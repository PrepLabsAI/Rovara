// Plan 6 Task 13: the pull request description of a Rovara Code (version 2) task, and the risk level. The risk level comes from defined inputs (the paths and size of the change,
// the checks, the findings the owner accepted and the code reviewer's own level), never from free model text. The description is public to the repository's readers: every
// model-written line is redacted and made inert (no mention, link or cross-reference), the whole body is bounded, and a version 1 task's description is exactly as before.
// (Port lane L7b: the cases that went through Cloud's broker and its state table are not here; they are the task flow's (lane L6a).)
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RiskAssessmentSchema, type VerificationReport } from "../../packages/contracts/src/index.js";
import { workflowFindingFingerprint } from "../../packages/contracts/src/task-workflow.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { RISK_SENSITIVE_PATH_PATTERNS, assessRisk, isSensitivePath, type RiskInput } from "../../packages/broker/src/core/proof/risk.js";
import { parseChangedFiles } from "../../packages/broker/src/core/proof/changed-files.js";
import { recomputeRisk, withLinearCloseLine } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { pullRequestTitle, workflowPullRequestBody, workflowPullRequestStatusLines } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";
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
  it("a small change with nothing else to say is low, with its one reason", () => {
    const risk = assessRisk(riskInput());
    expect(risk.level).toBe("low");
    expect(risk.reasons).toHaveLength(1);
    expect(risk.candidateDigest).toBe(digest);
    expect(RiskAssessmentSchema.safeParse(risk).success).toBe(true);
  });

  it("db/migrations/001.sql is high", () => {
    const risk = assessRisk(riskInput({ changedFiles: [file("db/migrations/001.sql")] }));
    expect(risk.level).toBe("high");
    expect(risk.reasons.join("\n")).toContain("db/migrations/001.sql");
  });

  it("matches path segments, not substrings: src/author.ts and src/diamond.ts are not high", () => {
    for (const path of ["src/author.ts", "src/diamond.ts", "src/authored/list.ts", "src/payments-ui.ts", "docs/infrastructure.md", "src/secretsanta.ts", "src/cdk8s.ts",
      // A directory that only ends like a sensitive one is not one either.
      "src/xoauth/x.ts", "src/reauth/x.ts", "lib/preauthz/x.ts", "lib/subiam/x.ts", "app/nonmigrations/x.ts", "app/myinfra/x.ts"]) {
      expect(assessRisk(riskInput({ changedFiles: [file(path)] })).level, path).toBe("low");
    }
  });

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

  it("450 lines is medium, 400 is not, and a count covers both added and removed lines", () => {
    expect(assessRisk(riskInput({ changedFiles: [file("src/a.ts", 450, 0)] })).level).toBe("medium");
    expect(assessRisk(riskInput({ changedFiles: [file("src/a.ts", 400, 0)] })).level).toBe("low");
    expect(assessRisk(riskInput({ changedFiles: [file("src/a.ts", 401, 0)] })).level).toBe("medium");
    expect(assessRisk(riskInput({ changedFiles: [file("src/a.ts", 200, 0), file("src/b.ts", 100, 101)] })).level).toBe("medium");
    expect(assessRisk(riskInput({ changedFiles: [file("src/a.ts", 200, 0), file("src/b.ts", 100, 100)] })).level).toBe("low");
  });

  it("a lock file or a manifest is medium", () => {
    for (const path of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "web/package.json", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "requirements.txt", "poetry.lock", "pyproject.toml", "Gemfile.lock", "pom.xml", "build.gradle"]) {
      expect(assessRisk(riskInput({ changedFiles: [file(path)] })).level, path).toBe("medium");
    }
    expect(assessRisk(riskInput({ changedFiles: [file("docs/package.json.md")] })).level).toBe("low");
  });

  it("a review-only change, a failed check and a check that couldn't run are each medium", () => {
    expect(assessRisk(riskInput({ report: { ...cleanReport, reviewOnly: true, passed: [], notChecked: [{ label: "Automated checks", reason: "Docs only" }] } })).level).toBe("medium");
    expect(assessRisk(riskInput({ report: { ...cleanReport, failed: [{ label: "Lint", summary: "It failed on the latest code." }] } })).level).toBe("medium");
    expect(assessRisk(riskInput({ report: { ...cleanReport, notChecked: [{ label: "Types", reason: "It never started." }] } })).level).toBe("medium");
  });

  it("an accepted code finding is medium and an accepted security finding is high", () => {
    expect(assessRisk(riskInput({ acceptedFindings: [{ role: "CRITIC" }] })).level).toBe("medium");
    expect(assessRisk(riskInput({ acceptedFindings: [{ role: "SECURITY" }] })).level).toBe("high");
    // A security finding the review introduced counts even when the accepted list no longer holds it.
    expect(assessRisk(riskInput({ securityFindings: 1 })).level).toBe("high");
  });

  it("the reviewer's high raises low, the reviewer's medium raises low, and the reviewer's low lowers nothing", () => {
    expect(assessRisk(riskInput({ reviewerRisk: "high" })).level).toBe("high");
    expect(assessRisk(riskInput({ reviewerRisk: "medium" })).level).toBe("medium");
    expect(assessRisk(riskInput({ reviewerRisk: "low" })).level).toBe("low");
    expect(assessRisk(riskInput({ changedFiles: [file("infra/main.ts")], reviewerRisk: "low" })).level).toBe("high");
    expect(assessRisk(riskInput({ changedFiles: [file("package.json")], reviewerRisk: "low" })).level).toBe("medium");
  });

  it("the highest matching rule wins, and every match adds its reason", () => {
    const risk = assessRisk(riskInput({
      changedFiles: [file("infra/main.ts", 300, 200), file("package.json")], report: { ...cleanReport, failed: [{ label: "Lint", summary: "x" }] },
      acceptedFindings: [{ role: "SECURITY" }, { role: "CRITIC" }], reviewerRisk: "high",
    }));
    expect(risk.level).toBe("high");
    const text = risk.reasons.join("\n");
    expect(text).toContain("infra/main.ts");
    expect(text).toMatch(/security/i);
    expect(text).toMatch(/code review/i);
    expect(text).toMatch(/lines/i);
    expect(text).toMatch(/package\.json/);
    expect(risk.reasons.length).toBeLessThanOrEqual(8);
    expect(risk.reasons.every((reason) => reason.length >= 1 && reason.length <= 200)).toBe(true);
    expect(RiskAssessmentSchema.safeParse(risk).success).toBe(true);
  });

  it("every rule at once still gives a valid assessment of at most 8 reasons, with the high ones first", () => {
    const risk = assessRisk(riskInput({
      changedFiles: [file("infra/main.ts", 500, 0), file("package.json")], changedFilesComplete: false, report: { ...cleanReport, reviewOnly: true, failed: [{ label: "Lint", summary: "x" }], notChecked: [{ label: "Types", reason: "y" }] },
      acceptedFindings: [{ role: "SECURITY" }, { role: "CRITIC" }], securityFindings: 2, reviewerRisk: "high",
    }));
    expect(risk.level).toBe("high");
    expect(risk.reasons).toHaveLength(8);
    expect(risk.reasons.slice(0, 3).join("\n")).toMatch(/sensitive paths[\s\S]*security[\s\S]*code review/i);
    expect(RiskAssessmentSchema.safeParse(risk).success).toBe(true);
  });

  it("a change whose files couldn't all be read is at least medium, never low", () => {
    expect(assessRisk(riskInput({ changedFiles: [], changedFilesComplete: false })).level).toBe("medium");
    expect(assessRisk(riskInput({ changedFiles: [file("src/a.ts")], changedFilesComplete: false })).level).toBe("medium");
    expect(assessRisk(riskInput({ changedFiles: [file("infra/x.ts")], changedFilesComplete: false })).level).toBe("high");
  });

  it("file names are untrusted: a reason has no mention, no link, no line break and no secret, and stays in its limit", () => {
    const hostile = `infra/@octocat/https://evil.example/ghp_abcdefghijklmnopqrstuvwxyz0123456789\n# injected ${"x".repeat(400)}.tf`;
    const risk = assessRisk(riskInput({ changedFiles: [file(hostile), file("auth/@everyone.ts"), file("iam/[click](http://e.example).ts")] }));
    expect(risk.level).toBe("high");
    for (const reason of risk.reasons) {
      expect(reason).not.toMatch(/\n/);
      expect(reason).not.toContain("ghp_");
      expect(reason.length).toBeLessThanOrEqual(200);
    }
    expect(RiskAssessmentSchema.safeParse(risk).success).toBe(true);
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

  it("counts a pure addition and a pure deletion as counted (0 on the other side), not as unknown", () => {
    const text = section([], ["diff --git a/src/added.ts b/src/added.ts", "@@ -0,0 +1,2 @@", "+a", "+b", "diff --git a/src/removed.ts b/src/removed.ts", "@@ -1,2 +0,0 @@", "-a", "-b"]);
    expect(parseChangedFiles(text).files).toEqual([
      { repository: "payments", path: "src/added.ts", added: 2, removed: 0 },
      { repository: "payments", path: "src/removed.ts", added: 0, removed: 2 },
    ]);
  });

  it("records a rename with both names, and counts its changed lines", () => {
    const text = section([], ["diff --git a/auth/old.ts b/lib/old.ts", "similarity index 90%", "rename from auth/old.ts", "rename to lib/old.ts", "--- a/auth/old.ts", "+++ b/lib/old.ts", "@@ -1 +1 @@", "-a", "+b"]);
    expect(parseChangedFiles(text).files).toEqual([{ repository: "payments", path: "lib/old.ts", renamedFrom: "auth/old.ts", added: 1, removed: 1 }]);
    const pure = section([], ["diff --git a/auth/old.ts b/lib/old.ts", "similarity index 100%", "rename from auth/old.ts", "rename to lib/old.ts"]);
    expect(parseChangedFiles(pure).files).toEqual([{ repository: "payments", path: "lib/old.ts", renamedFrom: "auth/old.ts" }]);
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
  const flagged = (path: string, minus: string[], plus: string[]) => parseChangedFiles(section(change(path, minus, plus))).files[0]?.apiShapeChanged === true;

  it("is read from a route declaration or response model a change adds or removes, in the common frameworks", () => {
    expect(flagged("inventory/app.py", ['    @app.get("/items", response_model=list[ItemView])'], ['    @app.get("/items", response_model=ItemPage)'])).toBe(true);
    expect(flagged("src/routes/orders.ts", [], ["router.post('/orders', createOrder);"])).toBe(true);
    expect(flagged("src/server.ts", ["app.get('/health', (req, res) => res.json({ ok: true }));"], [])).toBe(true);
    expect(flagged("src/orders.controller.ts", [], ["  @Get(':id')"])).toBe(true);
    expect(flagged("src/main/java/OrderController.java", [], ['  @GetMapping("/orders")'])).toBe(true);
    expect(flagged("cmd/api/main.go", [], ['  r.GET("/orders", list)'])).toBe(true);
  });

  it("is read from a schema, serializer, OpenAPI or protobuf file that changed", () => {
    for (const path of ["inventory/schemas.py", "src/schemas/item.ts", "api/serializers.py", "openapi.yaml", "docs/swagger.json", "proto/orders.proto", "api/schema.graphql", "src/dto/order.dto.ts"]) {
      expect(flagged(path, ["old"], ["new"]), path).toBe(true);
    }
  });

  it("is not read from a handler's body alone, an ordinary module, a test that declares a route, or a file that only looks like a schema", () => {
    expect(flagged("inventory/catalog.py", ["    return session.scalars(select(Item)).all()"], ["    return session.scalars(select(Item).limit(5)).all()"])).toBe(false);
    expect(flagged("src/retry.ts", ["const a = 1;"], ["const a = 2;"])).toBe(false);
    expect(flagged("tests/test_api.py", [], ['    @app.get("/items")'])).toBe(false);
    expect(flagged("src/schemas.test.ts", ["a"], ["b"])).toBe(false);
    expect(flagged("src/reschedule.ts", ["a"], ["b"])).toBe(false);
  });

  it("makes the risk at least medium and says existing callers may see a different response, naming the files", () => {
    const risk = assessRisk(riskInput({ changedFiles: [{ ...file("inventory/app.py"), apiShapeChanged: true }, { ...file("inventory/schemas.py"), apiShapeChanged: true }, file("inventory/catalog.py")] }));
    expect(risk.level).toBe("medium");
    expect(risk.reasons.join("\n")).toMatch(/public API route or response shape/);
    expect(risk.reasons.join("\n")).toContain("inventory/app.py");
    expect(risk.reasons.join("\n")).toMatch(/existing callers/);
    // It raises nothing above medium by itself, and a high reason still leads.
    expect(assessRisk(riskInput({ changedFiles: [{ ...file("src/payments/charge.ts"), apiShapeChanged: true }] })).level).toBe("high");
    expect(assessRisk(riskInput({ changedFiles: [file("inventory/catalog.py")] })).level).toBe("low");
  });

  it("shows in the description's Risk section for the diff of the blind test's pull request", () => {
    const diff = section([
      ...change("inventory/app.py", ['    @app.get("/items", response_model=list[ItemView])'], ['    @app.get("/items", response_model=ItemPage)']),
      ...change("inventory/catalog.py", ["def items(session):"], ["def all_items(session):"]),
      ...change("inventory/schemas.py", [], ["class ItemPage(BaseModel):", "    total: int"]),
    ]);
    const read = parseChangedFiles(diff);
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, { changedFiles: read });
    const risk = body.slice(body.indexOf("## Risk:"), body.indexOf(END));
    expect(risk).toContain("## Risk: Medium");
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
    expect(body).toContain("- src/new-module.ts (lines not counted)");
    expect(body).toContain("- src/a.ts (+3 -1)");
    expect(body).not.toContain("+0 -0");
    expect(body).toMatch(/2 files changed \(at least \+3 -1; 1 file not counted\)/);
    expect(body).toContain("## Risk: Medium");
  });

  it("a new test file that was not counted still counts as a test added", () => {
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ changedFiles: { files: [entry("tests/new.test.ts")], complete: true } }));
    expect(body).toContain("Tests added: tests/new.test.ts");
  });
});

describe("a renamed file", () => {
  it("is high when its old name or its new name is a sensitive path, and the reason names the sensitive one", () => {
    const moved = { repository: "payments", path: "lib/old.ts", renamedFrom: "auth/old.ts", added: 1, removed: 1 };
    const risk = assessRisk(riskInput({ changedFiles: [moved] }));
    expect(risk.level).toBe("high");
    expect(risk.reasons.join("\n")).toContain("auth/old.ts");
    expect(assessRisk(riskInput({ changedFiles: [{ ...moved, path: "infra/old.ts", renamedFrom: "lib/old.ts" }] })).level).toBe("high");
    expect(assessRisk(riskInput({ changedFiles: [{ ...moved, renamedFrom: "lib/older.ts" }] })).level).toBe("low");
    expect(assessRisk(riskInput({ changedFiles: [{ ...moved, path: "lib/package.json", renamedFrom: "lib/x.json" }] })).level).toBe("medium");
    expect(assessRisk(riskInput({ changedFiles: [{ ...moved, path: "lib/x.json", renamedFrom: "lib/package.json" }] })).level).toBe("medium");
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
    // Only the name: never the person's reference.
    expect(body).not.toContain("0123456789abcdef");
    expect(body.trimEnd().endsWith(CLOSING)).toBe(true);
    // Without attribution the description is exactly what it was.
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context())).not.toContain("Requested by");
  });

  it("keeps the attribution when the body is cut to its size: the lists shrink, the attribution stays (I3)", () => {
    const files = Array.from({ length: 4_000 }, (_, index) => file(`src/very/long/path/number/${String(index)}/module-with-a-long-name.ts`, 5, 1));
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ changedFiles: { files, complete: true }, attribution: { requester: { state: "named", name: "Maya Chen", ref: "0123456789abcdef" } } }));
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(30_000);
    expect(body).toContain("Requested by: Maya Chen");
  });

  it("has its sections in order, the plan summary first, the session link and the closing line last, and never says AgentX", () => {
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context());
    const at = (text: string) => body.indexOf(text);
    const order = ["Add the retry flag.", START, "## What changed", "## Tests", "## Reviews", "## Risk: Low", END, `Rovara session: ${SESSION}`, CLOSING];
    for (const text of order) expect(at(text), text).toBeGreaterThanOrEqual(0);
    for (let index = 1; index < order.length; index += 1) expect(at(order[index]!), order[index]).toBeGreaterThan(at(order[index - 1]!));
    expect(body.trimEnd().endsWith(CLOSING)).toBe(true);
    expect(body).not.toMatch(/agentx/i);
    expect(body).not.toContain("Opened as a draft");
    expect(body.split(START)).toHaveLength(2);
    expect(body.split(END)).toHaveLength(2);
  });

  it("What changed lists the files with their line counts, and Tests lists what passed and the tests added", () => {
    const report = workflowWith();
    const body = workflowPullRequestBody(task, report, planOf, SESSION, context());
    expect(body).toContain("src/retry.ts");
    expect(body).toContain("+10");
    expect(body).toContain("src/retry.test.ts");
    const tests = body.slice(body.indexOf("## Tests"), body.indexOf("## Reviews"));
    expect(tests).toContain("Unit tests");
    expect(tests).toContain("src/retry.test.ts");
    expect(body.slice(body.indexOf("## Reviews"), body.indexOf("## Risk:"))).toContain("code review passed; security review passed");
  });

  it("says when the changed files couldn't be listed, and doesn't pretend that no test was added", () => {
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, {});
    expect(body.slice(body.indexOf("## What changed"), body.indexOf("## Tests"))).toMatch(/couldn't list/i);
    expect(body.slice(body.indexOf("## Tests"), body.indexOf("## Reviews"))).toMatch(/couldn't list|unknown/i);
    expect(body).toContain("## Risk: Medium");
  });

  it("names a failed check, a check that couldn't run and a review-only change in Tests", () => {
    const failing = workflowWith({
      stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results", reviews: undefined,
      checkPolicy: { required: [check("unit", "Unit tests"), check("lint", "Lint"), check("types", "Types")], optional: [], selectedOptionalIds: [], proposed: [] },
      verification: { candidateDigest: candidate("1").digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now,
        results: [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "FAILED" }, { checkId: "types", status: "FAILED", programNotFound: true }] },
    });
    const tests = (() => { const body = workflowPullRequestBody(task, failing, planOf, SESSION, context()); return body.slice(body.indexOf("## Tests"), body.indexOf("## Reviews")); })();
    expect(tests).toMatch(/Failed:.*Lint/);
    expect(tests).toMatch(/Not checked:.*Types/);
    const reviewOnly = workflowWith({
      stage: "REVIEW", state: "WAITING", reviews: undefined,
      checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [], noneReason: "Documentation only" },
      verification: { candidateDigest: candidate("1").digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [], reviewOnly: true },
    });
    const body = workflowPullRequestBody(task, reviewOnly, planOf, SESSION, context());
    expect(body.slice(body.indexOf("## Tests"), body.indexOf("## Reviews"))).toContain("Documentation only");
    expect(body).toContain("## Risk: Medium");
  });

  it("says it checked against every check on the branch only when the base has no required checks", () => {
    const line = (base: string) => `Checked against every check on this branch, because ${base} has no required checks.`;
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ ciBasis: "all_checks", baseBranch: "main" }))).toContain(line("main"));
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ ciBasis: "all_checks" }))).toContain(line("the base branch"));
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ ciBasis: "required", baseBranch: "main" }))).not.toContain("Checked against every check");
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context())).not.toContain("Checked against every check");
    // The line sits under Tests.
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ ciBasis: "all_checks", baseBranch: "main" }));
    expect(body.indexOf(line("main"))).toBeGreaterThan(body.indexOf("## Tests"));
    expect(body.indexOf(line("main"))).toBeLessThan(body.indexOf("## Reviews"));
    // A branch name is untrusted text.
    const odd = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ ciBasis: "all_checks", baseBranch: "@everyone/ghp_abcdefghijklmnopqrstuvwxyz0123456789" }));
    expect(odd).not.toContain("@everyone");
    expect(odd).not.toContain("ghp_");
  });

  it("shows the risk level with its reasons, from the files and the code reviewer's own level", () => {
    const sensitive = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ changedFiles: { files: [file("db/migrations/001.sql")], complete: true } }));
    expect(sensitive).toContain("## Risk: High");
    expect(sensitive.slice(sensitive.indexOf("## Risk:"), sensitive.indexOf(END))).toContain("db/migrations/001.sql");
    const reviewed = workflowWith({ reviews: workflowWith().reviews!.map((review) => review.role === "CRITIC" ? { ...review, risk: "high" } : review) });
    const body = workflowPullRequestBody(task, reviewed, planOf, SESSION, context());
    expect(body).toContain("## Risk: High");
    expect(body.slice(body.indexOf("## Risk:"), body.indexOf(END))).toMatch(/code review/i);
    // A review of other code doesn't count (the snapshot is at its review step, where that is allowed).
    const stale = workflowWith({ stage: "REVIEW", state: "WAITING", reviews: workflowWith().reviews!.map((review) => review.role === "CRITIC" ? { ...review, risk: "high", candidateDigest: candidate("2").digest } : review) });
    expect(workflowPullRequestBody(task, stale, planOf, SESSION, context())).toContain("## Risk: Low");
  });

  it("an accepted finding raises the risk and is listed under Reviews", () => {
    const finding = { text: "Retries can double-charge a card", origin: "INTRODUCED", severity: "HIGH", file: "src/retry.ts", line: 4 };
    const code = candidate("1");
    const accepted = workflowWith({
      reviews: [
        { operationId: randomUUID(), candidateDigest: code.digest, role: "CRITIC", provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now },
        { operationId: randomUUID(), candidateDigest: code.digest, role: "SECURITY", provider: "t", version: "1", status: "FINDINGS", findings: [finding], readOnly: true, recordedAt: now },
      ],
      acceptedFindings: [{ candidateDigest: code.digest, role: "SECURITY", fingerprint: workflowFindingFingerprint("SECURITY", finding), text: finding.text, reason: "Handled by the payment provider", actorId: ownerId, at: now }],
    });
    const body = workflowPullRequestBody(task, accepted, planOf, SESSION, context());
    expect(body).toContain("## Risk: High");
    const reviews = body.slice(body.indexOf("## Reviews"), body.indexOf("## Risk:"));
    expect(reviews).toContain("Owner accepted 1 review finding");
    expect(reviews).toContain("Retries can double-charge a card");
  });

  it("makes every model-written line inert: no mention, link, image, cross-reference, HTML or comment, and no secret", () => {
    const hostile = [
      "# Plan", "",
      "1. Ping @octocat and @org/team about https://evil.example/x and www.evil.example",
      "2. ![pixel](https://evil.example/p.png) [click me](javascript:alert(1)) <https://evil.example/auto>",
      "3. Fix #123 and org/repo#456 with <script>alert(1)</script> token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "4. <!-- an unclosed comment that would hide the rest",
      "5. <!-- /rovara:checks-and-reviews --> and <!-- rovara:checks-and-reviews -->",
    ].join("\n");
    const body = workflowPullRequestBody(task, workflowWith({
      checkPolicy: { required: [check("unit", "Unit @octocat <b>t</b> https://e.x/ghp_abcdefghijklmnopqrstuvwxyz0123456789")], optional: [], selectedOptionalIds: [], proposed: [] },
    }), hostile, SESSION, context({ changedFiles: { files: [file("src/@everyone.ts"), file("src/[x](http://evil.example).ts"), file("src/#12.ts")], complete: true } }));
    expect(body).not.toMatch(/@(?!‍)/u);
    expect(body).not.toContain("ghp_");
    expect(body).not.toMatch(/https?:\/\/(?!‍)[^\s]*evil/);
    expect(body).not.toMatch(/\]\(/);
    expect(body).not.toContain("<script");
    expect(body).not.toContain("<b>");
    expect(body).not.toMatch(/#(?!‍)\d/u);
    expect(body).not.toContain("<!-- an unclosed");
    expect(body).not.toMatch(/<!--(?! \/?rovara:checks-and-reviews -->)/);
    // The markers appear once each, so the block stays regenerable.
    expect(body.split(START)).toHaveLength(2);
    expect(body.split(END)).toHaveLength(2);
    expect(body).not.toMatch(/<(?!!-- \/?rovara:checks-and-reviews -->)/);
  });

  it("shows the plan's words as a quotation under their own heading, so they can't pose as one of Rovara's sections", () => {
    const spoof = ["## Risk: Low", "```", "---", "> deeper", "[1]: http://evil.example/x", "# Tests", "- Passed: everything"].join("\n");
    const body = workflowPullRequestBody(task, workflowWith(), spoof, SESSION, context({ changedFiles: { files: [file("infra/main.ts")], complete: true } }));
    const lines = body.split("\n");
    expect(lines.filter((line) => /^## Risk/.test(line))).toEqual(["## Risk: High"]);
    expect(lines.filter((line) => /^#{1,6} Tests/.test(line))).toEqual(["## Tests"]);
    const startAt = lines.indexOf("## Plan summary");
    expect(startAt).toBe(0);
    const quoted = lines.slice(1, lines.indexOf(START)).filter((line) => line !== "");
    expect(quoted.length).toBeGreaterThan(0);
    expect(quoted.every((line) => line.startsWith("> "))).toBe(true);
    expect(lines.filter((line) => line.startsWith("```"))).toEqual([]);
    // The task's title, used when there is no plan, is quoted the same way.
    const titled = workflowPullRequestBody({ title: "## Risk: Low" }, workflowWith(), undefined, SESSION, context());
    expect(titled.split("\n").filter((line) => /^## Risk/.test(line))).toEqual(["## Risk: Low"]);
    expect(titled.split("\n")[1]).toBe("> ## Risk: Low");
  });

  it("neutralises character references and issue shorthands as well as the characters themselves", () => {
    const body = workflowPullRequestBody(task, workflowWith(), "Thanks &#x40;octocat and &#64;octocat and &commat;octocat, see GH-123 and gh-9 &amp; more", SESSION,
      context({ changedFiles: { files: [file("src/&#x40;user.ts")], complete: true } }));
    expect(body).not.toMatch(/&#/);
    expect(body).not.toContain("&commat;");
    expect(body).toContain("&amp;#x40;octocat");
    expect(body).toContain("&amp;amp; more");
    expect(body).not.toMatch(/GH-\d/i);
    expect(body).toContain("src/&amp;#x40;user.ts");
  });

  it("falls back to the task's title, made inert, when there is no plan", () => {
    const body = workflowPullRequestBody({ title: "Ping @octocat about <https://evil.example|this>" }, workflowWith(), undefined, SESSION, context());
    expect(body.split("\n")[1]).not.toMatch(/@(?!‍)/u);
    expect(body.split("\n")[1]).toContain("Ping");
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
    expect(body).toContain("## Risk:");
    expect(body).toContain(`Rovara session: ${SESSION}`);
    expect(body.trimEnd().endsWith(CLOSING)).toBe(true);
    // A body that big can still be regenerated in place.
    expect(withStatusLines(body, ["- a new line"])).toBeDefined();
  });

  it("a pushed fix regenerates only the marked block: the person's words around it stay, and the risk is recomputed", () => {
    const first = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context());
    expect(first).toContain("## Risk: Low");
    const edited = `Heads up from Priya: please look at the retry cap first.\n\n${first}\n\nPS: merged after the standup.`;
    // A CI fix then touched infra/: another candidate, with its own diff.
    const fixed = workflowWith({ candidate: candidate("2"), reviews: workflowWith().reviews!.map((review) => ({ ...review, candidateDigest: candidate("2").digest })),
      verification: { candidateDigest: candidate("2").digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] } });
    const lines = workflowPullRequestStatusLines(fixed, context({ changedFiles: { files: [file("src/retry.ts"), file("infra/queue.ts")], complete: true } }));
    const next = withStatusLines(edited, lines);
    expect(next).toBeDefined();
    expect(next).toContain("Heads up from Priya: please look at the retry cap first.");
    expect(next).toContain("PS: merged after the standup.");
    expect(next).toContain("## Risk: High");
    expect(next).not.toContain("## Risk: Low");
    expect(next).toContain("infra/queue.ts");
    expect(next).toContain(`Rovara session: ${SESSION}`);
    expect(next).toContain(CLOSING);
    expect(next).toContain("Add the retry flag.");
    // Nothing else moved: putting the first lines back gives the first block again.
    const back = withStatusLines(next!, workflowPullRequestStatusLines(workflowWith(), context()));
    expect(back).toBe(edited);
  });
});

// Blind test 02 (staging 0.4.13): the plan said "Four files change" and the pull request changed five. The count of files comes from the diff; a model's count that differs is corrected in place and
// says what the plan had said.
describe("the plan summary's file count", () => {
  const fiveFiles = { files: ["a.py", "b.py", "c.py", "tests/test_a.py", "tests/test_b.py"].map((path) => file(path, 3, 1)), complete: true };
  /** The summary the description quotes; `changedFiles` is the diff's list, left out when `undefined` is passed. */
  const summaryOf = (plan: string, ...given: [unknown?]) => {
    const body = workflowPullRequestBody(task, workflowWith(), plan, SESSION, (given.length === 0 ? { changedFiles: fiveFiles } : given[0] === undefined ? {} : { changedFiles: given[0] }) as never);
    return body.slice(body.indexOf("## Plan summary"), body.indexOf(START));
  };

  it("is corrected to the diff's count, saying what the plan had said", () => {
    const summary = summaryOf("# Plan\n\nGET /items takes limit and offset.\nFour files change; no schema migration is needed.\n");
    expect(summary).toContain("5 files change (the plan said four); no schema migration is needed.");
    expect(summary).not.toContain("Four files change");
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, { changedFiles: fiveFiles });
    expect(body).toContain("5 files changed (+15 -5).");
  });

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
  const testsOf = (body: string) => body.slice(body.indexOf("## Tests"), body.indexOf("## Reviews"));
  const pushed = (letter: string, candidateDigest: string) => ({ repositoryId: "payments", number: 7, url: "https://github.com/example/payments/pull/7", headSha: letter.repeat(40), candidateDigest, required: true, state: "OPEN" });

  it("says the short head commit (8 characters) of the checked code", () => {
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context());
    expect(testsOf(body)).toContain("- Tested on head commit 11111111\n");
    expect(testsOf(body)).not.toContain("1".repeat(9));
  });

  it("says where the pushed head differs from the commit the checks ran on, and the pull request head when it holds the same code", () => {
    const code = candidate("1");
    expect(testsOf(workflowPullRequestBody(task, workflowWith({ pullRequests: [pushed("2", code.digest)] }), planOf, SESSION, context()))).toContain("- Tested on head commit 11111111 (pushed as 22222222)");
    // A pull request head that holds older code says nothing: it was not the code that was tested.
    expect(testsOf(workflowPullRequestBody(task, workflowWith({ pullRequests: [pushed("2", candidate("3").digest)] }), planOf, SESSION, context()))).not.toContain("pushed as");
    expect(testsOf(workflowPullRequestBody(task, workflowWith({ pullRequests: [pushed("1", code.digest)] }), planOf, SESSION, context()))).toContain("- Tested on head commit 11111111\n");
  });

  it("names each repository when the task changed more than one", () => {
    const two = createCandidateManifest([
      { repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "a".repeat(40), baseCommitSha: "e".repeat(40) },
      { repositoryId: "web", commitSha: "b".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) },
    ]);
    const workflow = workflowWith({ candidate: two, verification: { candidateDigest: two.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: (["CRITIC", "SECURITY"] as const).map((role) => ({ operationId: randomUUID(), candidateDigest: two.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })) });
    expect(testsOf(workflowPullRequestBody(task, workflow, planOf, SESSION, context()))).toContain("- Tested on head commits: payments aaaaaaaa, web bbbbbbbb");
  });

  it("is in the regenerated block too, so a fix on the pull request names the new commit", () => {
    const lines = workflowPullRequestStatusLines(workflowWith(), context());
    expect(lines).toContain("- Tested on head commit 11111111");
  });

  it("is not in a version 1 description", () => {
    expect(workflowPullRequestBody(task, workflowWith({}, "1.0.0"), planOf, SESSION)).not.toContain("Tested on head commit");
  });
});

describe("which findings, reviews and recorded risk count", () => {
  const securityFinding = { text: "Retries can double-charge a card", origin: "INTRODUCED", severity: "HIGH", file: "src/retry.ts", line: 4 };
  const acceptedFor = (letter: string) => ({ candidateDigest: candidate(letter).digest, role: "SECURITY", fingerprint: workflowFindingFingerprint("SECURITY", securityFinding), text: securityFinding.text, reason: "ok", actorId: ownerId, at: now });

  it("only a finding accepted for this very code counts", () => {
    expect(recomputeRisk(workflowWith({ acceptedFindings: [acceptedFor("2")] }), context().changedFiles, {}).risk?.level).toBe("low");
    expect(recomputeRisk(workflowWith({ acceptedFindings: [acceptedFor("1")] }), context().changedFiles, {}).risk?.level).toBe("high");
  });

  it("a risk recorded for this code stands when the files can't be read now, and one recorded for other code does not", () => {
    const recorded = (letter: string) => ({ level: "high" as const, reasons: ["Changes sensitive paths: infra/main.ts."], candidateDigest: candidate(letter).digest });
    expect(workflowPullRequestBody(task, workflowWith({ risk: recorded("1") }), planOf, SESSION, {})).toContain("## Risk: High");
    const stale = workflowPullRequestBody(task, workflowWith({ risk: recorded("2") }), planOf, SESSION, {});
    expect(stale).toContain("## Risk: Medium");
    expect(stale).not.toContain("infra/main.ts");
  });

  it("an unclosed tag in a model-written line can't open a hidden comment", () => {
    const body = workflowPullRequestBody(task, workflowWith(), "<!-- hide the rest of the page\nSecond line", SESSION, context());
    expect(body.split("\n")[1]).toContain("&lt;!-- hide");
    expect(body).not.toContain("<!-- hide");
    expect(body.split("\n")[1]).toContain("&lt;!-- hide the rest of the page");
    expect(body.match(/<!--/g)).toHaveLength(2);
  });
});

describe("the risk is recomputed whenever the code on the pull request changes", () => {
  it("a CI fix touching infra/ recomputes the risk to high, for the new candidate", () => {
    const before = recomputeRisk(workflowWith(), context().changedFiles, {});
    expect(before.risk).toMatchObject({ level: "low", candidateDigest: candidate("1").digest });
    const fixed = workflowWith({ candidate: candidate("2"), risk: before.risk,
      reviews: workflowWith().reviews!.map((review) => ({ ...review, candidateDigest: candidate("2").digest })),
      verification: { candidateDigest: candidate("2").digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] } });
    const after = recomputeRisk(fixed, { files: [file("src/retry.ts"), file("infra/queue.ts")], complete: true }, {});
    expect(after.risk).toMatchObject({ level: "high", candidateDigest: candidate("2").digest });
    expect(WorkflowSnapshotSchema.safeParse(after).success).toBe(true);
  });

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

describe("a version 1 task's description is exactly as before", () => {
  it("keeps its title-free body, its AgentX task line and its closing line, and ignores a version 2 context", () => {
    const v1 = workflowWith({}, "1.0.0");
    const body = workflowPullRequestBody(task, v1, planOf, SESSION, undefined);
    const [summary, ...rest] = body.split("\n\n");
    expect(summary).toContain("Add the retry flag");
    expect(rest.join("\n\n")).toBe([
      "<!-- agentx:checks-and-reviews -->", "Checks: Unit tests passed", "Reviews: code review passed; security review passed", "<!-- /agentx:checks-and-reviews -->",
      `AgentX task: ${SESSION}`, "",
      "Opened as a draft by AgentX after the owner-approved plan, checks and reviews passed. Merge it on GitHub.",
    ].join("\n"));
    expect(body).toContain("<!-- agentx:checks-and-reviews -->");
    expect(body).toContain(`AgentX task: ${SESSION}`);
    expect(body).not.toContain("## ");
    expect(body).not.toContain("Rovara");
    // A context (version 2's) changes nothing on a version 1 task.
    expect(workflowPullRequestBody(task, v1, planOf, SESSION, context({ ciBasis: "all_checks", baseBranch: "main" }))).toBe(body);
    expect(workflowPullRequestStatusLines(v1, context())).toEqual(workflowPullRequestStatusLines(v1));
    expect(workflowPullRequestStatusLines(v1)).toEqual(["Checks: Unit tests passed", "Reviews: code review passed; security review passed"]);
  });
});

// ---- through the broker


// ---- Plan 6 Task 20: "Fixes <KEY>" for a session bound to a Linear issue

const FIXES = /\b(?:fix|fixes|fixed|fixing|close|closes|closed|closing|resolve|resolves|resolved|resolving|complete|completes|completed|completing)[\s:]+[a-z][a-z0-9]*-\d+/giu;
const closers = (text: string) => text.match(FIXES) ?? [];

describe("a pull request for a session bound to a Linear issue", () => {
  it("says Fixes <KEY> exactly once, inside Rovara's block, so Linear's own GitHub integration closes the issue when it merges", () => {
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ linearIssueKey: "ENG-142" }));
    expect(closers(body)).toEqual(["Fixes ENG-142"]);
    expect(body.indexOf("Fixes ENG-142")).toBeGreaterThan(body.indexOf(START));
    expect(body.indexOf("Fixes ENG-142")).toBeLessThan(body.indexOf(END));
    expect(body.trimEnd().endsWith(CLOSING)).toBe(true);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(30_000);
  });

  it("says nothing of Linear without a key, and refuses a key that is not an issue key", () => {
    expect(closers(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context()))).toEqual([]);
    for (const key of ["", "eng", "ENG-", "ENG-0", "ENG-142\n/approve", "ENG-142 and OPS-1", "ENG_142", "<!-- x -->", "@all-1", "ENG-1234567890123"]) {
      expect(closers(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ linearIssueKey: key }))), key).toEqual([]);
    }
  });

  it("keeps it exactly once when the block is rewritten after a fix, and adds it when the issue was bound after the pull request opened", () => {
    const wf = workflowWith();
    const first = workflowPullRequestBody(task, wf, planOf, SESSION, context({ linearIssueKey: "ENG-142" }));
    const noted = `A note from Priya, kept.\n\n${first}`;
    // Rewriting with the same lines changes nothing (undefined); a rewrite after a fix, with the new code's lines, replaces the block and keeps the one line.
    expect(withStatusLines(noted, workflowPullRequestStatusLines(wf, context({ linearIssueKey: "ENG-142" })))).toBeUndefined();
    const fixed = withStatusLines(noted, workflowPullRequestStatusLines(wf, { changedFiles: { files: [file("src/retry.ts", 10, 2), file("src/other.ts", 1, 1)], complete: true }, linearIssueKey: "ENG-142" }))!;
    expect(closers(fixed)).toEqual(["Fixes ENG-142"]);
    expect(fixed).toContain("src/other.ts");
    expect(fixed).toContain("A note from Priya, kept.");
    const unbound = workflowPullRequestBody(task, wf, planOf, SESSION, context());
    expect(closers(withStatusLines(unbound, workflowPullRequestStatusLines(wf, context({ linearIssueKey: "ENG-142" })))!)).toEqual(["Fixes ENG-142"]);
  });

  it("keeps the line when the lists shrink to fit the byte cap", () => {
    const many = Array.from({ length: 400 }, (_, index) => file(`src/generated/module-${index}-${"x".repeat(120)}.ts`, 3, 1));
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, { changedFiles: { files: many, complete: true }, linearIssueKey: "ENG-142" });
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(30_000);
    expect(closers(body)).toEqual(["Fixes ENG-142"]);
  });

  it("is not fooled by model-written words: a plan that says Fixes OTHER-9 or Closes ENG-142 adds no second closer", () => {
    const plan = "# Plan\n\n1. Fixes OTHER-9 and closes ENG-142, resolves OPS-1 & OPS-2.\n2. Add a regression test.\n";
    const hostile = workflowWith({ checkPolicy: { required: [check("unit", "Completes ENG-7 check")], optional: [], selectedOptionalIds: [], proposed: [] } });
    const body = workflowPullRequestBody(task, hostile, plan, SESSION, context({ linearIssueKey: "ENG-142" }));
    expect(closers(body)).toEqual(["Fixes ENG-142"]);
    // The words stay readable: only the issue key is broken for Linear's reader.
    expect(body.replaceAll("‍", "")).toContain("Fixes OTHER-9 and closes ENG-142");
    const without = workflowPullRequestBody(task, hostile, plan, SESSION, context());
    expect(closers(without)).toEqual([]);
  });

  it("is not fooled by a task title either", () => {
    const titled = { title: "Fixes OTHER-9: add a retry flag" } as never;
    const body = workflowPullRequestBody(titled, workflowWith(), undefined, SESSION, context({ linearIssueKey: "ENG-142" }));
    expect(closers(body)).toEqual(["Fixes ENG-142"]);
  });

  it("is the version 1 description, as it was, for a version 1 task", () => {
    const v1 = workflowWith({}, "1.0.0");
    expect(workflowPullRequestBody(task, v1, planOf, SESSION, context({ linearIssueKey: "ENG-142" }))).toBe(workflowPullRequestBody(task, v1, planOf, SESSION));
    expect(workflowPullRequestStatusLines(v1, context({ linearIssueKey: "ENG-142" }))).toEqual(workflowPullRequestStatusLines(v1));
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

  it("the plan's summary", () => {
    onlyOwn(workflowPullRequestBody(task, workflowWith(), "# Plan\n\n1. _Fixes OPS-3_ by retrying; also `OPS-4` and (OPS-5).\n2. Fixes ENG-1 ENG-2\n", SESSION, withOwn()));
  });

  it("the task's title, when there is no plan", () => {
    onlyOwn(workflowPullRequestBody({ title: "OPS-9 and Fixes OPS-10" }, workflowWith(), undefined, SESSION, withOwn()));
  });

  it("a changed file's path, its old name and its repository", () => {
    const files = [{ repository: "payments", path: "docs/OPS-12-notes.md", added: 1, removed: 0 }, { repository: "OPS-14", path: "src/new.ts", renamedFrom: "src/Fixes-OPS-15.ts", added: 1, removed: 1 }];
    onlyOwn(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, withOwn({ changedFiles: { files, complete: true } })));
  });

  it("a check's label, a failed check, a check that couldn't run, a test added and the reason there was no check", () => {
    const failing = workflowWith({
      stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results", reviews: undefined,
      checkPolicy: { required: [check("unit", "Unit OPS-1"), check("lint", "Lint OPS-2"), check("types", "Types OPS-3")], optional: [], selectedOptionalIds: [], proposed: [] },
      verification: { candidateDigest: candidate("1").digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now,
        results: [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "FAILED" }, { checkId: "types", status: "FAILED", programNotFound: true }] },
    });
    onlyOwn(workflowPullRequestBody(task, failing, planOf, SESSION, withOwn({ changedFiles: { files: [file("src/OPS-4.test.ts")], complete: true } })));
    const reviewOnly = workflowWith({
      stage: "REVIEW", state: "WAITING", reviews: undefined,
      checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [], noneReason: "Documentation only, see OPS-9" },
      verification: { candidateDigest: candidate("1").digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [], reviewOnly: true },
    });
    onlyOwn(workflowPullRequestBody(task, reviewOnly, planOf, SESSION, withOwn()));
  });

  it("the base branch's name, and a risk reason", () => {
    onlyOwn(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, withOwn({ ciBasis: "all_checks", baseBranch: "release/OPS-77" })));
    onlyOwn(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, withOwn({ changedFiles: { files: [file("db/migrations/OPS-8.sql")], complete: true } })));
  });

  it("anything at all that reaches the block: a final pass breaks it, and keeps Rovara's own line and the session link whole", () => {
    // A path that skipped every per-line guard still cannot name an issue.
    const lines = workflowPullRequestStatusLines(workflowWith(), withOwn({ changedFiles: { files: [file("OPS-1.ts")], complete: true } }));
    expect(lines).toContain("Fixes ENG-142");
    expect(readable(lines.join("\n"))).toEqual(["Fixes ENG-142"]);
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, withOwn());
    expect(body).toContain(`Rovara session: ${SESSION}`);
    expect(body).toContain(CLOSING);
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

  it("without a key of its own, no key at all", () => {
    expect(readable(workflowPullRequestBody(task, accepted("Fixes OPS-12", "Part of OPS-13"), "1. Closes OPS-3", SESSION, context()))).toEqual([]);
  });
});

describe("technical text in a version 2 description stays as it is", () => {
  it("keeps UTF-8, SHA-256, node-22, x86-64 and paths byte for byte, including in a risk reason (no stray space where a joiner was)", () => {
    const files = [file("db/V1-2__init.sql"), file("src/utf-8-handler.ts"), file("docs/ADR-0007.md"), file("scripts/sha-256.sh")];
    const lines = workflowPullRequestStatusLines(workflowWith(), context({ linearIssueKey: "ENG-142", changedFiles: { files, complete: true } }));
    const body = lines.join("\n");
    for (const text of ["db/V1-2__init.sql", "src/utf-8-handler.ts", "docs/ADR-0007.md", "scripts/sha-256.sh"]) expect(body, text).toContain(text);
    expect(body).toMatch(/Changes sensitive paths: db\/V1-2__init\.sql/u);
    expect(body).not.toContain("V1- 2");
    expect(body).not.toContain("\u200D");
    const full = workflowPullRequestBody(task, workflowWith(), "# Plan\n\n1. Use UTF-8 and SHA-256 on node-22 (x86-64)\n2. Run `git checkout feature-2`\n", SESSION, context({ linearIssueKey: "ENG-142", changedFiles: { files, complete: true } }));
    expect(full).toContain("Use UTF-8 and SHA-256 on node-22 (x86-64)");
    expect(full).toContain("git checkout feature-2");
    expect(full).not.toContain("\u200D");
  });

  it("keeps the joiner it puts in a name that holds a magic word and a key, in the block and in a risk reason (it is not inerted a second time into a space)", () => {
    const files = [file("db/migrations/Fixes-ENG-1.sql")];
    const body = workflowPullRequestStatusLines(workflowWith(), context({ linearIssueKey: "ENG-142", changedFiles: { files, complete: true } })).join("\n");
    expect(body).toContain("Changes sensitive paths: db/migrations/F\u200Dixes-ENG-1.sql");
    expect(body).not.toContain("F ixes");
    expect(readable(body)).toEqual(["Fixes ENG-142"]);
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

  it("takes out only a line that is exactly Rovara's own, not words of a person's inside the block", () => {
    const noted = BLOCK("", "A person wrote: Fixes ENG-9 here", "Fixes ENG-142 too", "Fixes ENG-142");
    const removed = withLinearCloseLine(noted, undefined) as { kind: string; body: string };
    expect(removed.body).toContain("A person wrote: Fixes ENG-9 here");
    expect(removed.body).toContain("Fixes ENG-142 too");
    expect(removed.body.split("\n").filter((line) => line === "Fixes ENG-142")).toEqual([]);
    expect(withLinearCloseLine(BLOCK("", "Fixes ENG-142 too"), undefined)).toEqual({ kind: "same" });
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

  it("lists the proof lines at the end of the Tests section, before the Reviews", () => {
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context(), [PROOF]);
    const tests = body.indexOf("## Tests");
    const proof = body.indexOf(`- ${PROOF}`);
    expect(tests).toBeGreaterThanOrEqual(0);
    expect(proof).toBeGreaterThan(tests);
    expect(proof).toBeGreaterThan(body.indexOf("- Tests added:"));
    expect(proof).toBeLessThan(body.indexOf("## Reviews"));
    expect(body.split(PROOF)).toHaveLength(2);
  });

  it("leaves the description as it was without proof lines", () => {
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context(), [])).toBe(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context()));
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context())).not.toContain("Test proof");
  });

  it("carries them in the status block a later update rewrites when they are given", () => {
    const lines = workflowPullRequestStatusLines(workflowWith(), context(), [PROOF]);
    expect(lines).toContain(`- ${PROOF}`);
    expect(workflowPullRequestStatusLines(workflowWith(), context())).not.toContain(`- ${PROOF}`);
  });
});

describe("the version 1 pull request description names who asked (I3)", () => {
  it("adds the lines after the status block, and nothing when there is no attribution", () => {
    const v1 = workflowWith({}, "1.0.0");
    const plain = workflowPullRequestBody({ title: "Add a retry flag" }, v1, planOf, "https://rovara.example/review/x/task");
    expect(plain).not.toContain("Requested by");
    const body = workflowPullRequestBody({ title: "Add a retry flag" }, v1, planOf, "https://rovara.example/review/x/task", { attribution: { requester: { state: "named", name: "Maya Chen", ref: "0123456789abcdef" }, approver: { state: "named", name: "Priya Raman", ref: "fedcba9876543210" } } });
    expect(body).toContain("Requested by: Maya Chen\nPlan approved by: Priya Raman\n");
    expect(body.indexOf("Requested by")).toBeGreaterThan(body.indexOf("<!-- /agentx:checks-and-reviews -->"));
    expect(body).not.toContain("0123456789abcdef");
  });
});
