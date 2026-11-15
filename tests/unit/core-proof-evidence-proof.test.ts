// Proof and evidence P8: the evidence lines in a pull request's Proof section and the evidence mode. The pull request is public to the repository's readers: counts, labels and results only, every
// repository-written word inert, nothing shown for other code, and the Environment, not-run and not-tested lines never dropped by the shrink levels.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EvidencePackSchema, resolveEvidenceMode, type EvidencePack } from "../../packages/contracts/src/evidence.js";
import type { PlanDocument } from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { evidenceLines, evidenceLinkLine, EVIDENCE_NOT_TESTED_LISTED, type ProofEvidenceContext } from "../../packages/broker/src/core/proof/evidence-lines.js";
import { PULL_REQUEST_BODY_MAX_BYTES, rovaraPullRequestBody } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { PROOF_LEVEL_LAST, proofSection } from "../../packages/broker/src/core/proof/proof-section.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const now = "2026-11-04T12:00:00.000Z";
const CODE = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
const command = { cwd: "repo/payments", executable: "pytest", args: ["-q"], timeoutSeconds: 30 };
const check = (id: string, label: string) => ({ id, label, command });
const URL = "https://rovara.example/review/8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6/task";

const plan = (): PlanDocument => ({
  schemaVersion: 1, title: "Score partners", why: [{ text: "Partners with no region are scored wrongly.", author: "Priya" }],
  claims: [{ id: "1", text: "Score ignores partners with no region." }, { id: "2", text: "A SageMaker timeout falls back to rule ranking." }],
  notChanging: [], risks: [], decisions: [], checks: { proposed: [check("unit", "Unit tests"), check("lint", "Lint")], proves: { unit: ["1"], lint: ["1"] } },
});
const workflow = (): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now, definitionVersion: "1.1.0" }),
  stage: "PULL_REQUEST", state: "READY", candidate: CODE,
  checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [check("unit", "Unit tests"), check("lint", "Lint")] },
  verification: { candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "PASS" }] },
  reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: randomUUID(), candidateDigest: CODE.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
});

const checkEntry = (over: Record<string, unknown> = {}) => ({ checkId: "readiness:0", kind: "test", label: "pytest -q", before: "failed", after: "passed", class: "fixed", durationMs: 900, ...over });
const pack = (over: Record<string, unknown> = {}): EvidencePack => EvidencePackSchema.parse({
  schemaVersion: 1, candidateDigest: CODE.digest,
  environment: { tier: "sandbox", envRevision: 3, services: [{ name: "partner-scorer", mode: "mocked", fixtureRevision: 2, schemaVersion: 3, recordedAt: "2026-11-02T00:00:00.000Z" }], data: "synthetic", accounts: [{ profileId: "buyer", kind: "run_scoped" }] },
  checks: [
    checkEntry({
      tests: { total: 39, passed: 36, failed: 0, skipped: 3, errored: 0, names: [{ name: "test_no_region", status: "passed", proof: "proves_change" }, { name: "test_other", status: "passed", proof: "proves_change" }], newTests: ["test_no_region", "test_other"] },
      coverage: { linesChanged: 48, linesCovered: 41, files: [{ path: "src/match.py", uncovered: [3, 4] }] },
    }),
    checkEntry({ checkId: "readiness:1", kind: "lint", label: "ruff", class: "passing", before: "passed" }),
    checkEntry({ checkId: "readiness:2", kind: "typecheck", label: "mypy", class: "passing", before: "passed" }),
    checkEntry({ checkId: "readiness:3", kind: "security", label: "bandit", class: "passing", before: "passed", findings: { tool: "bandit", newCount: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, items: [] } }),
  ],
  selection: { method: "coverage_map", selected: 37, total: 1240, mapAgeHours: 14, lastFullRun: { at: "2026-11-04T02:10:00.000Z", status: "passed", passed: 1238, total: 1240, flaky: 2 } },
  api: [], browser: [],
  notTested: [
    { kind: "mocked_service", id: "partner-scorer", text: "partner-scorer is mocked", reason: "answered from recorded responses" },
    { kind: "not_selected", id: "selection", text: "1203 of 1240 tests were not run", reason: "not selected (coverage map)" },
  ],
  ...over,
});
const ORIGIN = "https://rovara.example";
const context = (over: Partial<ProofEvidenceContext> = {}): ProofEvidenceContext => ({ pack: pack(), mode: "link", taskUrl: URL, origin: ORIGIN, ...over });
const section = (evidence: ProofEvidenceContext | undefined, level = 0) => proofSection(workflow(), { plan: plan(), ...(evidence === undefined ? {} : { evidence }) })!(level).join("\n");

describe("the evidence lines", () => {
  it("qualifies original-code evidence counts when a proving test used a Rovara-made mock", () => {
    const testProof = {
      schemaVersion: 1 as const, candidateDigest: CODE.digest, status: "checked" as const, note: "completed" as const, changedTests: { added: 1, changed: 0, deleted: 0 }, durationMs: 5,
      items: [{ checkId: "readiness:0", label: "Unit tests", granularity: "test" as const, test: "test_no_region", verdict: "proves_change" as const, reason: "assertion_failed_on_old" as const }],
    };
    for (const level of [0, 1]) {
      const render = (trust: "made_by_rovara" | "real") => proofSection(workflow(), { plan: plan(), testProof, evidence: context(), checkDependencies: new Map([["unit", [{ dependencyId: "payments", trust }]]]) })!(level).find((line) => line.includes("Checks by kind:"));
      expect(render("real")).toContain("2 new, 1 fail on the original code");
      expect(render("real")).not.toContain("not Proven");
      expect(render("made_by_rovara")).toContain("2 new, 1 fail on the original code");
      expect(render("made_by_rovara")).toContain("with a Rovara-made mock; not Proven");
    }
  });

  const at0 = evidenceLines(context(), CODE.digest, 0);
  it("give counts per kind, new tests and what they prove, never a test's output", () => {
    expect(at0.lines[0]).toBe("Checks by kind: pytest -q ✓: 36 passed, 3 skipped; 2 new · lint ✓ · type check ✓ · security scan ✓: 0 new findings · 37 of 1,240 tests selected (coverage map)");
  });
  it("say how many new tests fail on the original code only from the broker's own proof, never from the worker's per-test verdict", () => {
    const proven = (names: string[]) => evidenceLines(context(), CODE.digest, 0, { proven: new Set(names) }).lines[0]!;
    expect(proven(["test_no_region", "test_other"])).toContain("2 new, 2 fail on the original code");
    expect(proven(["test_no_region"])).toContain("2 new, 1 fail on the original code");
    expect(proven([])).toContain("2 new, 0 fail on the original code");
    // The pack's own names say "proves_change", but with no broker proof the clause is absent.
    expect(at0.lines[0]).not.toContain("fail on the original code");
  });
  it("give the changed-line coverage", () => {
    expect(at0.lines[1]).toBe("Changed lines covered by tests: 41 of 48 (85%)");
  });
  it("name the environment, each service's mode, its recording and the data", () => {
    expect(at0.lines[2]).toBe("Environment: sandbox, approved test environment revision 3. partner-scorer: mocked (recorded 2026-11-02, schema v3). Test data: synthetic.");
  });
  it("say how many tests were not run and the last full run", () => {
    expect(at0.lines[3]).toBe("Not run here: 1,203 of 1,240 tests judged unaffected (coverage map, map 14 h old). Last full run: 2026-11-04 02:10 UTC, passed (1,238/1,240; 2 known flaky).");
  });
  it("end with the link to the full evidence, behind sign-in", () => {
    expect(at0.lines[4]).toBe(`Full evidence (screenshots, API samples, video, logs): Rovara task page (sign-in needed): ${URL}`);
    expect(at0.lines).toHaveLength(5);
  });
  it("list the mocked service and the tests not selected as not tested", () => {
    expect(at0.notTested).toEqual(["- Mocked service partner-scorer is mocked (answered from recorded responses)", "- Tests 1203 of 1240 tests were not run (not selected (coverage map))"]);
  });
});

describe("what the evidence never says", () => {
  it("never gives a tick to a check that did not pass, and says what happened instead", () => {
    const failing = pack({ checks: [checkEntry({ kind: "lint", label: "ruff", after: "failed", class: "regression" }), checkEntry({ checkId: "readiness:1", kind: "typecheck", label: "mypy", after: "timed_out", class: "not_rerun" }), checkEntry({ checkId: "readiness:2", kind: "build", label: "build", after: "not_run", class: "not_rerun" }), checkEntry({ checkId: "readiness:3", kind: "smoke", label: "smoke", after: "unknown", class: "not_rerun" })], selection: { method: "full", selected: 0, total: 0 } });
    const line = evidenceLines(context({ pack: failing }), CODE.digest, 0).lines[0]!;
    expect(line).toBe("Checks by kind: lint ✗ · type check timed out · build not run · smoke test not checked");
    expect(line).not.toContain("✓");
  });
  it("says a test check with no readable report has no details, and a failed one is not a tick", () => {
    const line = evidenceLines(context({ pack: pack({ checks: [checkEntry({ after: "failed", class: "regression" })], selection: { method: "full", selected: 0, total: 0 } }) }), CODE.digest, 0).lines[0]!;
    expect(line).toBe("Checks by kind: pytest -q ✗ (test details not read)");
  });
  it("puts the outcome word on a failed test check even when its counts look clean, and on a failed scan", () => {
    const clean = { total: 120, passed: 120, failed: 0, skipped: 0, errored: 0, names: [], newTests: [] };
    const line = evidenceLines(context({ pack: pack({ checks: [checkEntry({ after: "failed", class: "regression", tests: clean }), checkEntry({ checkId: "readiness:1", kind: "security", label: "bandit", after: "failed", class: "regression", findings: { tool: "bandit", newCount: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, items: [] } })], selection: { method: "full", selected: 120, total: 120 } }) }), CODE.digest, 0).lines[0]!;
    expect(line).toBe("Checks by kind: pytest -q ✗: 120 passed · security scan ✗: 0 new findings");
    for (const after of ["timed_out", "unknown", "not_run"] as const) {
      expect(evidenceLines(context({ pack: pack({ checks: [checkEntry({ after, class: "not_rerun", tests: clean })], selection: { method: "full", selected: 120, total: 120 } }) }), CODE.digest, 0).lines[0], after).not.toMatch(/✓/);
    }
  });
  it("says coverage was not measured when a test check ran and no check measured it, and says nothing without a test check", () => {
    const noCoverage = pack({ checks: [checkEntry({ tests: { total: 1, passed: 1, failed: 0, skipped: 0, errored: 0, names: [], newTests: [] } })], selection: { method: "full", selected: 1, total: 1 } });
    expect(evidenceLines(context({ pack: noCoverage }), CODE.digest, 0).lines).toContain("Changed lines covered by tests: no coverage report");
    const onlyLint = pack({ checks: [checkEntry({ kind: "lint" })], selection: { method: "full", selected: 0, total: 0 } });
    expect(evidenceLines(context({ pack: onlyLint }), CODE.digest, 0).lines.some((line) => line.startsWith("Changed lines"))).toBe(false);
  });
  it("shows a new security finding by severity, and migrations that did not roll back cleanly as such", () => {
    const scan = pack({ checks: [checkEntry({ kind: "security", label: "semgrep", findings: { tool: "semgrep", newCount: 3, bySeverity: { critical: 0, high: 1, medium: 2, low: 0, info: 0 }, items: [] } }), checkEntry({ checkId: "readiness:1", kind: "migration", label: "migrate", migrations: { applied: ["001", "002"], rolledBack: false, schemaChanges: [] } })], selection: { method: "full", selected: 0, total: 0 } });
    expect(evidenceLines(context({ pack: scan }), CODE.digest, 0).lines[0]).toBe("Checks by kind: security scan ✓: 3 new (1 high or critical) · migrations: 2 applied, rollback failed");
  });
  it("shows nothing for a pack that is for other code, or none", () => {
    expect(evidenceLines(context({ pack: pack({ candidateDigest: "f".repeat(64) }) }), CODE.digest, 0)).toEqual({ lines: [], notTested: [] });
    expect(evidenceLines(context({ pack: undefined }), CODE.digest, 0)).toEqual({ lines: [], notTested: [] });
    expect(evidenceLines(undefined, CODE.digest, 0)).toEqual({ lines: [], notTested: [] });
    expect(evidenceLines(context(), undefined, 0)).toEqual({ lines: [], notTested: [] });
  });
  it("makes every repository-written word inert: no mention, link, image, cross-reference or secret", () => {
    const hostile = pack({
      environment: { tier: "sandbox", envRevision: 1, services: [{ name: "@everyone [x](https://evil.example) ![i](https://evil.example/a.png) #123", mode: "mocked" }], data: "synthetic", accounts: [] },
      checks: [checkEntry({ label: `@maintainer see https://evil.example ${`ghp_${"Ab1Cd2Ef3Gh4".repeat(3)}`}`, tests: { total: 1, passed: 1, failed: 0, skipped: 0, errored: 0, names: [], newTests: [] } })], selection: { method: "full", selected: 1, total: 1 },
      notTested: [{ kind: "environment", id: "x", text: "<!-- hide --> @here", reason: "![p](https://evil.example/p.png)" }],
    });
    const out = evidenceLines(context({ pack: hostile }), CODE.digest, 0);
    const text = [...out.lines.slice(0, -1), ...out.notTested].join("\n");
    expect(text).not.toMatch(/@(?!‍)/u);
    expect(text).not.toContain("![");
    expect(text).not.toContain("](");
    expect(text).not.toContain("<!--");
    expect(text).not.toContain("ghp_");
    expect(text).not.toMatch(/(?<![\w])#\d/u);
    expect(text).not.toMatch(/https?:\/\/(?!‍)/u);
    expect(text).toContain("[REDACTED]");
  });
});

describe("the evidence mode", () => {
  it("link: the counts and a link; summary: the counts and where to find the rest, with no address", () => {
    expect(evidenceLinkLine(context())).toContain(`: ${URL}`);
    expect(evidenceLinkLine(context({ mode: "summary" }))).toBe("Full evidence is in Rovara (sign-in needed).");
    expect(evidenceLinkLine(context({ mode: "summary" }))).not.toContain("http");
    expect(evidenceLinkLine(context({ mode: "embed" }))).toContain(URL);
  });
  it("leaves out an address that is not https, is on another origin, has spaces, angle brackets or quotes, or has no configured origin, and still says where to look", () => {
    expect(evidenceLinkLine(context({ origin: undefined }))).toBe("Full evidence (screenshots, API samples, video, logs): Rovara task page (sign-in needed)");
    expect(evidenceLinkLine(context({ origin: "http://rovara.example" }))).not.toContain("http");
    for (const taskUrl of ["http://rovara.example/x", "javascript:alert(1)", "https://rovara.example/a b", "https://rovara.example/<b>", 'https://rovara.example/"x', "https://evil.example/x", "https://rovara.example.evil.example/x", "https://rovara.example@evil.example/x", undefined]) {
      expect(evidenceLinkLine(context({ taskUrl })), String(taskUrl)).toBe("Full evidence (screenshots, API samples, video, logs): Rovara task page (sign-in needed)");
    }
  });
  it("resolves to link by default for both editions, and embed is never used for a public or unknown repository", () => {
    expect(resolveEvidenceMode({ repositoryVisibility: "public", embedAllowed: true, configured: "embed" })).toBe("link");
  });
});

describe("in the Proof section", () => {
  it("shows the evidence lines as bullets after the table and the not-tested bullets under What wasn't tested, before the table's own", () => {
    const text = section(context());
    const table = text.indexOf("| Requirement |");
    const env = text.indexOf("- Environment: sandbox, approved test environment revision 3.");
    const untested = text.indexOf("What wasn't tested:");
    expect(table).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(table);
    expect(untested).toBeGreaterThan(env);
    expect(text.indexOf("- Mocked service partner-scorer")).toBeGreaterThan(untested);
    expect(text).toContain("- Full evidence (screenshots, API samples, video, logs)");
  });
  it("says a new test fails on the original code only when the broker's TestProof, bound to this code, says so", () => {
    const testProof = (digest: string, verdict: "proves_change" | "does_not_prove") => ({
      schemaVersion: 1, candidateDigest: digest, status: "checked", note: "completed", changedTests: { added: 2, changed: 0, deleted: 0 }, durationMs: 5,
      items: [{ checkId: "readiness:0", label: "Unit tests", granularity: "test", test: "test_no_region", verdict, reason: verdict === "proves_change" ? "assertion_failed_on_old" : "passed_on_old" }],
    });
    const at = (proof: unknown) => proofSection(workflow(), { plan: plan(), evidence: context(), ...(proof === undefined ? {} : { testProof: proof as never }) })!(0).join("\n");
    expect(at(testProof(CODE.digest, "proves_change"))).toContain("2 new, 1 fail on the original code");
    expect(at(testProof(CODE.digest, "does_not_prove"))).toContain("2 new, 0 fail on the original code");
    // Another candidate's proof, or none: the pack's own per-test "proves_change" is the worker's word and is not repeated.
    expect(at(testProof("f".repeat(64), "proves_change"))).not.toContain("fail on the original code");
    expect(at(undefined)).not.toContain("fail on the original code");
    expect(at({ nonsense: true })).not.toContain("fail on the original code");
  });
  it("is the section as it was without evidence", () => {
    expect(section(undefined)).toBe(section(context({ pack: undefined })));
    expect(section(undefined)).not.toContain("Environment:");
  });
  it("drops the counts and the coverage from level 2 and keeps the Environment line, the not-run line, the link and the not-tested bullets at every level", () => {
    for (let level = 0; level <= PROOF_LEVEL_LAST; level += 1) {
      const text = section(context(), level);
      expect(text.includes("Checks by kind:"), `counts at ${String(level)}`).toBe(level <= 1);
      expect(text.includes("Changed lines covered"), `coverage at ${String(level)}`).toBe(level <= 1);
      expect(text, `environment at ${String(level)}`).toContain("- Environment: sandbox, approved test environment revision 3.");
      expect(text, `not run at ${String(level)}`).toContain("- Not run here: 1,203 of 1,240");
      expect(text, `link at ${String(level)}`).toContain("Full evidence (");
      expect(text, `mocked at ${String(level)}`).toContain("Mocked service");
    }
  });
  it("shortens the Environment line at levels 3 and 4 without dropping the mocked service", () => {
    expect(section(context(), 3)).toContain("- Environment: sandbox, approved test environment revision 3. partner-scorer: mocked. Test data: synthetic.");
  });
  it("lists a not-tested item once when the table already has it", () => {
    const dupe = pack({ notTested: [{ kind: "check", id: "unit", text: "Unit tests", reason: "more tests skipped than before" }, { kind: "mocked_service", id: "partner-scorer", text: "partner-scorer is mocked", reason: "answered from recorded responses" }] });
    const lines = evidenceLines(context({ pack: dupe }), CODE.digest, 0, { alreadyListed: new Set(["check:unit"]) }).notTested;
    expect(lines).toEqual(["- Mocked service partner-scorer is mocked (answered from recorded responses)"]);
    expect(evidenceLines(context({ pack: dupe }), CODE.digest, 0).notTested).toHaveLength(2);
  });
  it("bounds the not-tested bullets to ten and counts the rest", () => {
    const many = pack({ notTested: Array.from({ length: 25 }, (_, index) => ({ kind: "mocked_service", id: `svc${String(index)}`, text: `svc${String(index)} is mocked`, reason: "answered from recorded responses" })) });
    const lines = evidenceLines(context({ pack: many }), CODE.digest, 0).notTested;
    expect(lines).toHaveLength(EVIDENCE_NOT_TESTED_LISTED + 1);
    expect(lines.at(-1)).toBe("- and 15 more not tested");
  });
});

describe("the whole description", () => {
  const body = (evidence: ProofEvidenceContext | undefined) => rovaraPullRequestBody({
    summary: ["Score partners with no region."], fallbackTitle: "Score partners", workflow: workflow(), pageUrl: URL,
    context: { proof: { plan: plan(), ...(evidence === undefined ? {} : { evidence }) } }, reviewLines: () => ["- No findings."],
  });
  it("stays under the byte cap and keeps the Environment, not-run and not-tested lines when the evidence is as large as a pack can be", () => {
    const services = Array.from({ length: 32 }, (_, index) => ({ name: `service-${String(index)}-${"x".repeat(40)}`, mode: "mocked" as const, recordedAt: "2026-11-02T00:00:00.000Z", schemaVersion: 3 }));
    const checks = Array.from({ length: 64 }, (_, index) => checkEntry({ checkId: `readiness:${String(index)}`, label: `check number ${String(index)} ${"y".repeat(100)}`, kind: index === 0 ? "test" : "lint", ...(index === 0 ? { tests: { total: 1, passed: 1, failed: 0, skipped: 0, errored: 0, names: [], newTests: [] } } : {}) }));
    const notTested = Array.from({ length: 200 }, (_, index) => ({ kind: "mocked_service", id: `m${String(index)}`, text: `thing ${String(index)} ${"z".repeat(200)}`, reason: "answered from recorded responses" }));
    const big = pack({ environment: { tier: "sandbox", envRevision: 3, services, data: "synthetic", accounts: [] }, checks, notTested, selection: { method: "coverage_map", selected: 37, total: 1240 } });
    const text = body(context({ pack: big }));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_BYTES);
    expect(text).toContain("- Environment: sandbox, approved test environment revision 3.");
    expect(text).toContain("- Not run here: 1,203 of 1,240");
    expect(text).toContain("- Mocked service thing 0");
    expect(text).toContain("A person must approve it and a person merges it.");
  });
  it("is the description it was before, byte for byte, when there is no evidence", () => {
    expect(body(undefined)).toBe(body(context({ pack: undefined })));
  });
});
