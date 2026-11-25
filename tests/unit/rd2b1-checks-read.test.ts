// RD-2b1: the task page's checks read (`GET /v1/dev/tasks/{taskId}/checks`, row `tasks.checks`). Two parts: the join itself (`checksViewOf`, core/task-view/checks.ts: states, the claim each check proves, reviews, the
// security scan, links, bounds, words) over plain facts; and the route through the core host's dev routes (the task read's own rule: another company's task and a colleague who may not read it answer exactly as a missing task,
// the served answer reads whole with the row's schema, a plan on disk gives the mapping, a kept output tail is a link while the store holds it and "expired" when it does not).
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ROUTES, routeIdOf } from "@preplabsai/rovara-code-api";
import { canonicalPlanJson, orgProjectCatalogKey, projectRevisionKey, type EvidencePack, type EvidenceView, type JsonValue, type PlanDocument, type ProjectDefinition, type WorkflowSnapshot } from "@agentx/contracts";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { evidencePackKey } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { evidenceArtifactKey } from "../../packages/broker/src/core/proof/evidence-artifacts.js";
import { evidenceViewOf } from "../../packages/broker/src/core/proof/evidence-pack.js";
import { CHECKS_VIEW_LIMITS, CHECKS_WORDS, PLAN_UNREADABLE_WORDS, REVIEW_ONLY_WORDS, checksViewOf, plainText, rowStateOf, scenarioWords, unavailableChecksView, type ChecksView } from "../../packages/broker/src/core/task-view/checks.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { DIGEST, SHA, v1Pack } from "../support/evidence-v2-fixtures.js";
import { readsAsRow } from "../support/code-api-row-read.js";
import { planDocument } from "../support/plan-documents.js";

const D2 = "d".repeat(64);
const AT = "2026-11-25T10:00:00.000Z";
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const chk = (id: string, label = id, kind?: "test" | "lint" | "build" | "other") => ({ id, label, ...(kind === undefined ? {} : { kind }), command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } });

// ---- plain facts for the join (only the members the join reads)

type Result = { checkId: string; status: "PASS" | "FAILED" | "UNKNOWN"; broken?: true; neverStarted?: true; programNotFound?: true };
function workflowOf(over: { stage?: string; state?: string; digest?: string | null; verifiedFor?: string; results?: Result[]; reviewOnly?: boolean; required?: ReturnType<typeof chk>[]; reviews?: unknown[]; accepted?: unknown[]; noneReason?: string } = {}): WorkflowSnapshot {
  const digest = over.digest === null ? undefined : over.digest ?? DIGEST;
  return {
    stage: over.stage ?? "REVIEW", state: over.state ?? "WAITING", decisions: [], artifacts: [],
    ...(digest === undefined ? {} : { candidate: { schemaVersion: 1, digest, repositories: [{ repositoryId: "web", commitSha: SHA, treeSha: "b".repeat(40) }] } }),
    checkPolicy: { required: over.required ?? [chk("unit", "Unit tests", "test"), chk("lint", "Lint", "lint")], optional: [], selectedOptionalIds: [], proposed: [], ...(over.noneReason === undefined ? {} : { noneReason: over.noneReason }) },
    ...(over.results === undefined && over.reviewOnly !== true ? {} : { verification: { candidateDigest: over.verifiedFor ?? digest ?? DIGEST, producer: "worker", environmentId: "env", recordedAt: AT, results: over.results ?? [], ...(over.reviewOnly === true ? { reviewOnly: true } : {}) } }),
    ...(over.reviews === undefined ? {} : { reviews: over.reviews }), ...(over.accepted === undefined ? {} : { acceptedFindings: over.accepted }),
  } as unknown as WorkflowSnapshot;
}
function packOf(checks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): EvidencePack {
  const base = clone(v1Pack()) as unknown as Record<string, unknown>;
  return { ...base, checks: checks.map((check) => ({ kind: "test", label: String(check["checkId"]), before: "passed", after: "passed", class: "passing", durationMs: 10, exitCode: 0, ...check })), notTested: [], api: [], ...extra } as unknown as EvidencePack;
}
const view = (input: Partial<Parameters<typeof checksViewOf>[0]> & { workflow: WorkflowSnapshot | undefined }): ChecksView => checksViewOf({ taskId: "t1", plan: undefined, pack: undefined, links: undefined, codeDetails: true, evidenceLinks: true, ...input });
const rowOf = (answer: ChecksView, id: string) => answer.rows.find((row) => row.id === id)!;
const PASS = (checkId: string): Result => ({ checkId, status: "PASS" });

describe("the state of each row (derived from stored facts only)", () => {
  it("passed, failed, flaky, known failing, couldn't verify (unknown, broken, never started, program missing), not run yet and running", () => {
    const required = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) => chk(id));
    const results: Result[] = [PASS("a"), { checkId: "b", status: "FAILED" }, PASS("c"), { checkId: "d", status: "FAILED" }, { checkId: "e", status: "UNKNOWN" }, { checkId: "f", status: "FAILED", broken: true }, { checkId: "g", status: "UNKNOWN", neverStarted: true }, { checkId: "h", status: "FAILED", programNotFound: true }];
    const pack = packOf([
      { checkId: "b", after: "failed", class: "regression" }, { checkId: "c", tests: { total: 2, passed: 2, failed: 0, skipped: 0, errored: 0, names: [], newTests: [], flakyOnRerun: ["x"], flakyOnRerunCount: 1 } },
      { checkId: "d", before: "failed", after: "failed", class: "already_failing" },
    ]);
    const answer = view({ workflow: workflowOf({ required, results }), pack });
    expect(answer.rows.map((row) => [row.id, row.state])).toEqual([["a", "passed"], ["b", "failed"], ["c", "flaky"], ["d", "known_failing"], ["e", "unverified"], ["f", "unverified"], ["g", "unverified"], ["h", "unverified"], ["i", "not_run"]]);
    // A step that is running reads "Running" for a check with no result yet; a step that is not, "Not run yet".
    expect(view({ workflow: workflowOf({ required: [chk("a")], stage: "VERIFY", state: "RUNNING" }) }).rows[0]!.state).toBe("running");
    expect(view({ workflow: workflowOf({ required: [chk("a")], stage: "VERIFY", state: "READY" }) }).rows[0]!.state).toBe("not_run");
  });

  it("a result for other code than the current candidate is Out of date (and Running while a new round runs); only the pack for the current code is ever read", () => {
    const stale = workflowOf({ results: [PASS("unit"), { checkId: "lint", status: "FAILED" }], verifiedFor: D2 });
    const answer = view({ workflow: stale, pack: packOf([{ checkId: "unit" }]) });
    expect(answer.rows.map((row) => row.state)).toEqual(["out_of_date", "out_of_date"]);
    // Out of date names the time of that run, never the current commit.
    expect(rowOf(answer, "unit").ranOn).toEqual({ at: AT });
    expect(answer.ranOn).toEqual({ at: AT });
    expect(view({ workflow: workflowOf({ results: [PASS("unit")], verifiedFor: D2, stage: "VERIFY", state: "RUNNING" }) }).rows.map((row) => row.state)).toEqual(["running", "running"]);
    // A pack for other code is ignored whole (no before and after, no failures, no scan).
    const foreign = { ...packOf([{ checkId: "unit", after: "failed", class: "regression" }]), candidateDigest: D2 };
    const current = view({ workflow: workflowOf({ results: [PASS("unit"), PASS("lint")] }), pack: foreign });
    expect(rowOf(current, "unit")).toEqual(expect.objectContaining({ state: "passed" }));
    expect(rowOf(current, "unit").after).toBeUndefined();
  });

  it("rowStateOf: a result and a kept check that disagree read Couldn't verify; a pack alone (no recorded result) is read for its outcome", () => {
    const workflow = workflowOf({ results: [PASS("unit")] });
    const verified = { kind: "current" as const, at: AT, commit: SHA };
    expect(rowStateOf(workflow, verified, "unit", packOf([{ checkId: "unit", after: "failed", class: "regression" }]).checks[0])).toBe("unverified");
    expect(rowStateOf(workflow, verified, "unit", packOf([{ checkId: "unit", after: "passed" }]).checks[0])).toBe("passed");
    expect(rowStateOf(workflow, verified, "x", packOf([{ checkId: "x", after: "timed_out" }]).checks[0])).toBe("failed");
    expect(rowStateOf(workflow, verified, "x", packOf([{ checkId: "x", after: "unknown" }]).checks[0])).toBe("unverified");
    expect(rowStateOf(workflow, verified, "x", packOf([{ checkId: "x", after: "not_run" }]).checks[0])).toBe("not_run");
  });

  it("with no workflow there are no rows and no reviews (an empty answer, never an error); a plan that could not be read says so", () => {
    expect(view({ workflow: undefined })).toEqual({ taskId: "t1", acceptance: [], rows: [], reviews: [], notTested: [] });
    expect(view({ workflow: undefined, planNote: "unreadable" }).notTested).toEqual([PLAN_UNREADABLE_WORDS]);
    expect(view({ workflow: workflowOf({ results: [PASS("unit")] }), planNote: "unreadable" }).notTested).toEqual([PLAN_UNREADABLE_WORDS]);
  });
});

describe("which claim each check proves (the six acceptance checks)", () => {
  const plan = (over: Partial<PlanDocument> = {}): PlanDocument => planDocument({
    claims: [{ id: "1", text: "Retries on timeout", children: [{ id: "1.1", text: "Waits longer each time" }] }, { id: "2", text: "Never charged twice" }, { id: "3", text: "Nothing proves this one" }],
    notChanging: ["Refunds stay as they are."],
    checks: { proposed: [], proves: { unit: ["1", "1.1"], lint: ["2", "nc1"], gone: ["3"] } },
    ...over,
  });

  it("each plan claim lists the checks that prove it (the inverse of `proves`), a Not changing item a check proves is listed, and a claim nothing proves has an empty list", () => {
    const answer = view({ workflow: workflowOf({ results: [PASS("unit"), PASS("lint")] }), plan: plan() });
    expect(answer.acceptance).toEqual([
      { claimId: "1", text: "Retries on timeout", checkIds: ["unit"] }, { claimId: "1.1", text: "Waits longer each time", checkIds: ["unit"] },
      { claimId: "2", text: "Never charged twice", checkIds: ["lint"] }, { claimId: "3", text: "Nothing proves this one", checkIds: [] },
      { claimId: "nc1", text: "Refunds stay as they are.", checkIds: ["lint"] },
    ]);
    expect(rowOf(answer, "unit").proves).toEqual(["1", "1.1"]);
    expect(rowOf(answer, "lint").proves).toEqual(["2", "nc1"]);
  });

  it("a check the plan proves a claim with that is not one of the task's checks adds no row and no id (the owner dropped it)", () => {
    const answer = view({ workflow: workflowOf({ results: [PASS("unit"), PASS("lint")] }), plan: plan() });
    expect(answer.rows.map((row) => row.id)).toEqual(["unit", "lint"]);
    expect(answer.acceptance.find((claim) => claim.claimId === "3")!.checkIds).toEqual([]);
  });

  it("with no plan (a Quick task) there is no acceptance list and the rows still read", () => {
    const answer = view({ workflow: workflowOf({ results: [PASS("unit"), PASS("lint")] }) });
    expect(answer.acceptance).toEqual([]);
    expect(answer.rows.map((row) => [row.id, row.state, row.proves])).toEqual([["unit", "passed", []], ["lint", "passed", []]]);
  });

  it("before a policy exists, the rows are what the plan lists (not run yet)", () => {
    const workflow = { ...workflowOf(), checkPolicy: undefined } as unknown as WorkflowSnapshot;
    const answer = view({ workflow, plan: plan({ checks: { proposed: [chk("unit", "Unit tests")], alsoRun: [chk("lint", "Lint")], proves: { unit: ["1"] } } }) });
    expect(answer.rows.map((row) => [row.id, row.label, row.state])).toEqual([["lint", "Lint", "not_run"], ["unit", "Unit tests", "not_run"]]);
  });

  it("bounds: at most 60 claims and 20 check ids a claim", () => {
    const claims = Array.from({ length: 50 }, (_, index) => ({ id: String(index + 1), text: `claim ${String(index + 1)}` }));
    const many = view({ workflow: workflowOf({ results: [PASS("unit")] }), plan: plan({ claims, notChanging: Array.from({ length: 10 }, (_, index) => `n${String(index)}`), checks: { proposed: [], proves: { unit: ["1", ...Array.from({ length: 10 }, (_, index) => `nc${String(index + 1)}`)] } } }) });
    expect(many.acceptance.length).toBeLessThanOrEqual(CHECKS_VIEW_LIMITS.acceptance);
    expect(many.acceptance.length).toBe(60);
  });
});

const cause = { kind: "change", paths: ["src/cart.ts"], pathsCount: 1, commit: SHA, basis: ["named_in_failure"] };
const failing = (checkId: string, names: string[], withCauses = true) => ({
  checkId, after: "failed", class: "regression", exitCode: 1,
  tests: { total: names.length, passed: 0, failed: names.length, skipped: 0, errored: 0, names: names.map((name) => ({ name, status: "failed" })), newTests: [], ...(withCauses ? { failureCauses: names.map((testId) => ({ testId, cause })) } : {}) },
});

describe("end-to-end scenarios", () => {
  const e2e = (): PlanDocument["e2e"] => ({
    schemaVersion: 1, requestedTargetIds: ["web"], accountContextRefs: [], semanticExportDeltas: [],
    scenarios: [
      { scenarioId: "owner-exports", requirementId: "r", requestedTargetIds: ["web"], required: true, accountProfileId: "owner", minimumEvidence: "runtime", requiredRealComponentIds: [], steps: [{ kind: "navigate", path: "/" }, { kind: "click", testId: "b" }, { kind: "agent", goal: "SECRET-GOAL-TEXT tap the button", maxActions: 5 }], assertions: [{ kind: "visible", testId: "x", equals: true }, { kind: "visible", testId: "y", equals: true }] },
      { scenarioId: "viewer-refused", requirementId: "r", requestedTargetIds: ["web"], required: true, accountProfileId: "viewer", minimumEvidence: "runtime", requiredRealComponentIds: [], steps: [{ kind: "request", requestId: "q", path: "/a", method: "GET", body: {} }], assertions: [{ kind: "http-status", path: "/a", method: "GET", equals: 403 }] },
    ],
  } as unknown as PlanDocument["e2e"]);

  it("a passing aggregate end-to-end result is shown as its scenarios (not twice): each with the claims it proves, fixed words for what it does (never the scenario's own text), and the run's state", () => {
    const plan = planDocument({ e2e: e2e(), scenarioProves: { "owner-exports": ["1"], "viewer-refused": ["2"] }, claims: [{ id: "1", text: "Owners export" }, { id: "2", text: "Viewers cannot" }], checks: { proposed: [], proves: { unit: ["1"] } } });
    const answer = view({ workflow: workflowOf({ results: [PASS("unit"), PASS("project-e2e")] }), plan, pack: packOf([{ checkId: "unit" }, { checkId: "project-e2e" }]) });
    expect(answer.rows.map((row) => [row.id, row.kind, row.state])).toEqual([["unit", "test", "passed"], ["lint", "lint", "not_run"], ["owner-exports", "e2e", "passed"], ["viewer-refused", "e2e", "passed"]]);
    expect(rowOf(answer, "owner-exports").what).toBe("Opens 1 page, clicks 1 time, lets an AI agent act toward a goal, then checks 2 results");
    expect(rowOf(answer, "viewer-refused").what).toBe("Sends 1 request, then checks 1 result");
    expect(rowOf(answer, "owner-exports").proves).toEqual(["1"]);
    expect(answer.acceptance.map((claim) => [claim.claimId, claim.checkIds])).toEqual([["1", ["unit", "owner-exports"]], ["2", ["viewer-refused"]]]);
    expect(JSON.stringify(answer)).not.toContain("SECRET-GOAL-TEXT");
    expect(answer.rows.some((row) => row.id === "project-e2e")).toBe(false);
  });

  it("a failed aggregate run keeps its own row (state, failing lines, output link) and no scenario is called failed: one result is for the whole run, so each scenario reads Couldn't verify", () => {
    const plan = planDocument({ e2e: e2e(), scenarioProves: { "owner-exports": ["1"], "viewer-refused": ["2"] }, claims: [{ id: "1", text: "Owners export" }, { id: "2", text: "Viewers cannot" }], checks: { proposed: [], proves: {} } });
    const ref = { kind: "log_txt" as const, sha256: "8".repeat(64), bytes: 20, retentionClass: "evidence-std" as const };
    const pack = packOf([{ checkId: "unit" }, { ...failing("project-e2e", ["e2e.spec.ts::exports a csv"]), outputTailRef: ref }]);
    const answer = view({ workflow: workflowOf({ results: [PASS("unit"), { checkId: "project-e2e", status: "FAILED" }] }), plan, pack, links: evidenceViewOf(pack, "t1", () => "available") });
    expect(answer.rows.map((row) => [row.id, row.state])).toEqual([["unit", "passed"], ["lint", "not_run"], ["project-e2e", "failed"], ["owner-exports", "unverified"], ["viewer-refused", "unverified"]]);
    expect(rowOf(answer, "project-e2e").failures?.map((item) => item.test)).toEqual(["e2e.spec.ts::exports a csv"]);
    expect(rowOf(answer, "project-e2e").failures?.[0]?.cause).toContain("likely broken");
    expect(rowOf(answer, "project-e2e").output).toMatchObject({ kind: "output", id: ref.sha256 });
    expect(rowOf(answer, "owner-exports").what).toContain(CHECKS_WORDS.wholeRun);
    expect(rowOf(answer, "owner-exports").failures).toBeUndefined();
    expect(rowOf(answer, "owner-exports").after).toBeUndefined();
  });

  it("scenarios not run yet read Not run yet; a screenshot strip belongs to its own scenario, as links", () => {
    const plan = planDocument({ e2e: e2e(), scenarioProves: {} });
    expect(view({ workflow: workflowOf(), plan }).rows.filter((row) => row.kind === "e2e").map((row) => row.state)).toEqual(["not_run", "not_run"]);
    const shot = (byte: string) => ({ kind: "jpeg" as const, sha256: byte.repeat(64), bytes: 9, retentionClass: "evidence-std" as const });
    const pack = packOf([{ checkId: "unit" }, { checkId: "project-e2e" }], { browser: [{ scenarioId: "owner-exports", strip: { before: [shot("1")], after: [shot("2")] } }] });
    const links = evidenceViewOf(pack, "t1", () => "available") as EvidenceView;
    const answer = view({ workflow: workflowOf({ results: [PASS("unit"), PASS("project-e2e")] }), plan, pack, links });
    expect(rowOf(answer, "owner-exports").screenshots).toEqual([
      { kind: "screenshot", id: "1".repeat(64), label: "before", href: `/v1/app/tasks/t1/evidence/${"1".repeat(64)}` }, { kind: "screenshot", id: "2".repeat(64), label: "after", href: `/v1/app/tasks/t1/evidence/${"2".repeat(64)}` },
    ]);
    expect(rowOf(answer, "owner-exports").retention).toBe("kept");
    expect(rowOf(answer, "viewer-refused").screenshots).toBeUndefined();
  });

  it("a browser scenario the plan does not list is still a row; scenarioWords counts step kinds and assertions", () => {
    const pack = packOf([{ checkId: "unit" }], { browser: [{ scenarioId: "extra-case", strip: { before: [], after: [] } }] });
    expect(view({ workflow: workflowOf({ results: [PASS("unit")] }), pack }).rows.map((row) => row.id)).toEqual(["unit", "lint", "extra-case"]);
    expect(scenarioWords([], 0)).toBe("Runs one scenario");
    expect(scenarioWords([{ kind: "fill" }, { kind: "fill" }, { kind: "swipe" }, { kind: "tap" }], 0)).toBe("Clicks 1 time, fills 2 fields, does 1 other action");
  });
});

describe("failing tests, links, the scan, reviews and what was not tested", () => {

  it("lists the failing tests with their likely cause, ten across all rows and the rest counted per row; a failed check with no causes lists its failing names without one", () => {
    const required = [chk("a"), chk("b"), chk("c")];
    const pack = packOf([failing("a", Array.from({ length: 7 }, (_, index) => `a.test.ts::${String(index)}`)), failing("b", Array.from({ length: 6 }, (_, index) => `b.test.ts::${String(index)}`)), failing("c", ["c.test.ts::one"], false)]);
    const answer = view({ workflow: workflowOf({ required, results: [{ checkId: "a", status: "FAILED" }, { checkId: "b", status: "FAILED" }, { checkId: "c", status: "FAILED" }] }), pack });
    expect(rowOf(answer, "a").failures!.length).toBe(7);
    expect(rowOf(answer, "a").failures![0]).toEqual({ test: "a.test.ts::0", cause: `likely broken by a change (commit ${SHA.slice(0, 7)}) to src/cart.ts` });
    expect(rowOf(answer, "b").failures!.length).toBe(3);
    expect(rowOf(answer, "b").failuresNotListed).toBe(3);
    expect(rowOf(answer, "c").failures).toBeUndefined();
    const alone = view({ workflow: workflowOf({ required: [chk("c")], results: [{ checkId: "c", status: "FAILED" }] }), pack });
    expect(rowOf(alone, "c").failures).toEqual([{ test: "c.test.ts::one" }]);
  });

  it("a passing check lists no failures; before and after come from the pack (unknown and not run are left out)", () => {
    const pack = packOf([{ checkId: "unit", before: "failed", after: "passed" }, { checkId: "lint", before: "unknown", after: "not_run" }]);
    const answer = view({ workflow: workflowOf({ results: [PASS("unit"), PASS("lint")] }), pack });
    expect(rowOf(answer, "unit")).toMatchObject({ before: "failed", after: "passed" });
    expect(rowOf(answer, "unit").failures).toBeUndefined();
    expect(rowOf(answer, "lint").before).toBeUndefined();
    expect(rowOf(answer, "lint").after).toBeUndefined();
  });

  it("the output tail is a link while the store holds it, 'expired' (no link) when it does not, 'withheld' for anything else; no links view means no link", () => {
    const ref = { kind: "log_txt" as const, sha256: "9".repeat(64), bytes: 40, retentionClass: "evidence-std" as const };
    const pack = packOf([{ checkId: "unit", outputTailRef: ref }]);
    const workflow = workflowOf({ results: [PASS("unit")] });
    for (const [state, expected] of [["available", "kept"], ["expired", "expired"], ["withheld", "withheld"]] as const) {
      const row = rowOf(view({ workflow, pack, links: evidenceViewOf(pack, "t1", () => state) }), "unit");
      expect(row.retention, state).toBe(expected);
      expect(row.output, state).toEqual({ kind: "output", id: ref.sha256, label: "Command output", ...(state === "available" ? { href: `/v1/app/tasks/t1/evidence/${ref.sha256}` } : {}) });
    }
    // No links view although the pack names a file (the view did not fit its schema): no link, and the row says the file is withheld, never silence. A row with no file says nothing.
    const none = rowOf(view({ workflow, pack, links: undefined }), "unit");
    expect([none.output, none.retention]).toEqual([undefined, "withheld"]);
    expect(rowOf(view({ workflow: workflowOf({ results: [PASS("unit"), PASS("lint")] }), pack: packOf([{ checkId: "unit" }, { checkId: "lint" }]), links: undefined }), "lint").retention).toBeUndefined();
    // While Code does not serve the files (RD-2d), an available file carries no address and says so in fixed words; an expired one is as before.
    const open = rowOf(view({ workflow, pack, links: evidenceViewOf(pack, "t1", () => "available"), evidenceLinks: false }), "unit");
    expect(open.output).toEqual({ kind: "output", id: ref.sha256, label: CHECKS_WORDS.fileNotYet });
    expect(open.retention).toBe("kept");
    // A reader who may not read code gets no link and no failing lines, but the row's state and the retention word stay.
    const blind = rowOf(view({ workflow, pack, links: evidenceViewOf(pack, "t1", () => "available"), codeDetails: false }), "unit");
    expect([blind.output, blind.screenshots, blind.failures, blind.state, blind.retention]).toEqual([undefined, undefined, undefined, "passed", "kept"]);
    // Links for another pack than the one read are not used.
    const other = { ...evidenceViewOf(pack, "t1", () => "available")!, candidateDigest: D2 };
    expect(rowOf(view({ workflow, pack, links: other }), "unit").output).toBeUndefined();
  });

  it("the Code and Security review rows: state, the findings that can block (an advisory or pre-existing remark is not one), and whether the owner accepted each", () => {
    const base = { operationId: randomUUID(), candidateDigest: DIGEST, provider: "p", version: "1", readOnly: true, recordedAt: AT };
    const finding = { text: "The version is public", origin: "INTRODUCED", severity: "MEDIUM", file: "src/health.ts", line: 4 };
    const security = { ...base, role: "SECURITY", status: "FINDINGS", findings: [finding, { text: "old", origin: "PRE_EXISTING" }] };
    const code = { ...base, role: "CRITIC", status: "PASS", findings: [{ text: "style remark", origin: "INTRODUCED", advisory: true }] };
    const fingerprint = createHash("sha256").update(JSON.stringify(["SECURITY", finding.text, finding.file, finding.line])).digest("hex");
    const open = view({ workflow: workflowOf({ reviews: [code, security], results: [PASS("unit")] }) }).reviews;
    expect(open).toEqual([{ role: "code", state: "passed", findings: [] }, { role: "security", state: "findings", findings: [{ file: "src/health.ts", line: 4, severity: "medium", text: "The version is public", accepted: false }] }]);
    const accepted = view({ workflow: workflowOf({ reviews: [code, security], accepted: [{ candidateDigest: DIGEST, role: "SECURITY", fingerprint, text: finding.text, reason: "ok", actorId: "a", at: AT }] }) }).reviews;
    expect(accepted[1]!.findings[0]!.accepted).toBe(true);
    // A failure marker beats a nominal PASS; a review of other code, or none, is not run (running while the review step runs).
    expect(view({ workflow: workflowOf({ reviews: [{ ...code, failureReason: "TIMEOUT" }] }) }).reviews[0]!.state).toBe("unfinished");
    expect(view({ workflow: workflowOf({ reviews: [{ ...code, candidateDigest: D2 }] }) }).reviews.map((row) => row.state)).toEqual(["not_run", "not_run"]);
    expect(view({ workflow: workflowOf({ stage: "REVIEW", state: "RUNNING" }) }).reviews.map((row) => row.state)).toEqual(["running", "running"]);
    expect(view({ workflow: workflowOf({ reviews: Array.from({ length: 1 }, () => ({ ...security, findings: Array.from({ length: 20 }, (_, index) => ({ text: `f${String(index)}`, origin: "INTRODUCED" })) })) }) }).reviews[1]!.findings.length).toBe(20);
  });

  it("the security scan, what was not tested, and the review-only words", () => {
    const scan = { tool: "semgrep", newCount: 1, bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, items: [{ ruleId: "r1", severity: "high", path: "src/a.ts", line: 3, message: "bad call" }] };
    const pack = packOf([{ checkId: "scan", kind: "security", findings: scan }, { checkId: "unit" }], { notTested: [{ kind: "claim", id: "c1", text: "refund flow", reason: "no test" }, { kind: "environment", id: "e", text: "", reason: "no browser" }] });
    const answer = view({ workflow: workflowOf({ results: [PASS("unit")] }), pack });
    expect(answer.securityScan).toEqual({ tool: "semgrep", counts: scan.bySeverity, items: scan.items });
    expect(answer.notTested).toEqual(["refund flow: no test", "no browser"]);
    expect(answer.rows.map((row) => row.id)).toEqual(["unit", "lint", "scan"]);
    expect(view({ workflow: workflowOf({ results: [PASS("unit")] }) }).securityScan).toBeUndefined();
    const reviewOnly = view({ workflow: workflowOf({ required: [], reviewOnly: true }) });
    expect(reviewOnly.notTested).toEqual([REVIEW_ONLY_WORDS]);
    expect(view({ workflow: workflowOf({ required: [], reviewOnly: true, noneReason: "Docs only" }) }).notTested).toEqual(["Docs only"]);
  });

  it("every text from a repository, a worker or a model is made plain: redacted, one line, inert, cut; a check recorded but not selected is still a row", () => {
    const label = `deploy @everyone\n${"x".repeat(400)}`;
    const answer = view({ workflow: workflowOf({ results: [PASS("unit"), { checkId: "extra", status: "FAILED" }] }), pack: packOf([{ checkId: "extra", label }]) });
    expect(rowOf(answer, "extra").label.length).toBeLessThanOrEqual(200);
    expect(rowOf(answer, "extra").label).not.toContain("\n");
    expect(rowOf(answer, "extra").label).not.toMatch(/@(?!‍)/u);
    expect(rowOf(answer, "extra").state).toBe("failed");
  });
});

// ---- review round: what customer text may carry, states that never read better than the facts, ids, who sees code

/** Every string in a value. */
const stringsOf = (value: unknown): string[] => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsOf) : value !== null && typeof value === "object" ? Object.values(value).flatMap(stringsOf) : []);
const HIDDEN = /[\p{Cc}\p{Cf}]/u;

describe("customer text is plain (no control, direction or invisible characters)", () => {
  it("plainText removes NUL, ESC, C1, direction marks and isolates, zero-width characters and line breaks, keeping one space between words", () => {
    expect(plainText("a\u0000b\u001bc\u0085d\u202ee\u2066f\u2069g\u200bh\ufeffi\nj\t k\u2028l")).toBe("abcdefgh i j k l");
  });

  it("test names, causes, labels, finding text and files, scan messages and paths, claim text and not-tested lines carry none of them", () => {
    const evil = "x\u0000\u001b\u0085\u202e\u2066\u200by";
    const names = [`tests/${evil}.test.ts::one`];
    const pack = packOf([
      { ...failing("unit", names, false), label: `Unit ${evil}` },
      { checkId: "scan", kind: "security", findings: { tool: `semgrep${evil}`, newCount: 1, bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, items: [{ ruleId: `r${evil}`, severity: "high", path: `src/${evil}.ts`, line: 3, message: `bad${evil}call` }] } },
    ], { notTested: [{ kind: "claim", id: "c", text: `refund${evil}`, reason: `no${evil}test` }] });
    const security = { operationId: randomUUID(), candidateDigest: DIGEST, provider: "p", version: "1", readOnly: true, recordedAt: AT, role: "SECURITY", status: "FINDINGS", findings: [{ text: `leak${evil}`, origin: "INTRODUCED", file: `src/${evil}.ts`, line: 2 }] };
    const plan = planDocument({ claims: [{ id: "1", text: `Claim${evil}` }], notChanging: [`Keep${evil}`], checks: { proposed: [], proves: { unit: ["1", "nc1"] } } });
    const answer = view({ workflow: workflowOf({ results: [{ checkId: "unit", status: "FAILED" }], reviews: [security] }), pack, plan });
    const text = stringsOf(answer);
    expect(text.length).toBeGreaterThan(20);
    expect(text.filter((item) => HIDDEN.test(item))).toEqual([]);
    expect(text.some((item) => item.includes("xy.test.ts") || item.includes("Claimxy"))).toBe(true);
  });

  it("a secret split by an invisible character is still redacted (the characters go before redaction)", () => {
    const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
    const answer = view({ workflow: workflowOf({ results: [PASS("unit")] }), pack: packOf([{ checkId: "unit", label: `key ${secret.slice(0, 6)}\u200b${secret.slice(6)}` }]) });
    expect(JSON.stringify(answer)).not.toContain(secret);
    expect(JSON.stringify(answer)).not.toContain("ABCDEFGHIJKLMNOP");
  });
});

describe("a state never reads better than the stored facts", () => {
  it("a result answered by a Rovara-made fake is Faked, never Passed; a recorded pass whose kept check failed is Couldn't verify", () => {
    const answer = view({ workflow: workflowOf({ results: [{ ...PASS("unit"), madeByRovara: true } as Result, PASS("lint")] }), pack: packOf([{ checkId: "unit" }, { checkId: "lint", after: "failed", class: "regression" }]) });
    expect(answer.rows.map((row) => [row.id, row.state])).toEqual([["unit", "faked"], ["lint", "unverified"]]);
  });

  it("a review that saw part of the diff reads Partial, one whose blocking findings are all accepted reads Findings accepted, open findings read Findings", () => {
    const base = { operationId: randomUUID(), candidateDigest: DIGEST, provider: "p", version: "1", readOnly: true, recordedAt: AT };
    const finding = { text: "The version is public", origin: "INTRODUCED", severity: "MEDIUM", file: "src/health.ts", line: 4 };
    const fingerprint = createHash("sha256").update(JSON.stringify(["SECURITY", finding.text, finding.file, finding.line])).digest("hex");
    const states = (reviews: unknown[], accepted?: unknown[]) => view({ workflow: workflowOf({ reviews, ...(accepted === undefined ? {} : { accepted }) }) }).reviews.map((row) => row.state);
    expect(states([{ ...base, role: "CRITIC", status: "PASS", findings: [], partialDiff: true }])).toEqual(["partial", "not_run"]);
    expect(states([{ ...base, role: "SECURITY", status: "FINDINGS", findings: [finding] }])).toEqual(["not_run", "findings"]);
    expect(states([{ ...base, role: "SECURITY", status: "FINDINGS", findings: [finding] }], [{ candidateDigest: DIGEST, role: "SECURITY", fingerprint, text: finding.text, reason: "ok", actorId: "a", at: AT }])).toEqual(["not_run", "findings_accepted"]);
    expect(states([{ ...base, role: "CRITIC", status: "PASS", findings: [], partialDiff: true, failureReason: "TIMEOUT" }])).toEqual(["unfinished", "not_run"]);
  });

  it("with more than one repository no commit is named (the digest is the identity); with one it is", () => {
    const workflow = workflowOf({ results: [PASS("unit")] });
    expect(view({ workflow }).ranOn).toEqual({ commit: SHA, at: AT });
    const two = { ...workflow, candidate: { ...workflow.candidate!, repositories: [...workflow.candidate!.repositories, { repositoryId: "api", commitSha: "e".repeat(40), treeSha: "f".repeat(40) }] } } as WorkflowSnapshot;
    const answer = view({ workflow: two });
    expect(answer.ranOn).toEqual({ at: AT });
    expect(rowOf(answer, "unit").ranOn).toEqual({ at: AT });
  });
});

describe("missing parts are said, ids are words, and who may see code", () => {
  it("no approved plan, an approved plan with no structured form and an unreadable pack each add their one fixed sentence", () => {
    const workflow = workflowOf({ results: [PASS("unit")] });
    expect(view({ workflow, planNote: "unapproved" }).notTested).toEqual([CHECKS_WORDS.planUnapproved]);
    expect(view({ workflow, planNote: "markdown" }).notTested).toEqual([CHECKS_WORDS.planNotStructured]);
    expect(view({ workflow, packUnreadable: true }).notTested).toEqual([CHECKS_WORDS.evidenceUnreadable]);
    expect(view({ workflow: undefined, packUnreadable: true, planNote: "unapproved" }).notTested).toEqual([CHECKS_WORDS.planUnapproved, CHECKS_WORDS.evidenceUnreadable]);
    expect(unavailableChecksView("t1").notTested).toEqual([CHECKS_WORDS.viewFailed]);
  });

  it("a check or scenario id that is a word of the language (toString, constructor, hasOwnProperty) is just a row: no lookup finds a function", () => {
    const required = [chk("constructor"), chk("valueOf")];
    const plan = planDocument({ e2e: { schemaVersion: 1, requestedTargetIds: ["web"], accountContextRefs: [], semanticExportDeltas: [], scenarios: [{ scenarioId: "toString", requirementId: "r", requestedTargetIds: ["web"], required: true, accountProfileId: "o", minimumEvidence: "runtime", requiredRealComponentIds: [], steps: [], assertions: [{ kind: "visible", testId: "x", equals: true }] }] } as unknown as PlanDocument["e2e"], checks: { proposed: [], proves: { valueOf: ["1"] } }, scenarioProves: {} });
    const pack = packOf([{ checkId: "hasOwnProperty" }, { checkId: "toString" }], { browser: [{ scenarioId: "constructor", strip: { before: [], after: [] } }] });
    const answer = view({ workflow: workflowOf({ required, results: [PASS("constructor"), PASS("valueOf")] }), plan, pack });
    expect(answer.rows.map((row) => [row.id, row.proves])).toEqual([["constructor", []], ["valueOf", ["1"]], ["hasOwnProperty", []], ["toString", []], ["toString", []], ["constructor", []]]);
  });

  it("a reader who may not read code gets every state, count and id, and no test name, cause, finding text or file, scan item or link", () => {
    const ref = { kind: "log_txt" as const, sha256: "9".repeat(64), bytes: 40, retentionClass: "evidence-std" as const };
    const scan = { tool: "semgrep", newCount: 1, bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, items: [{ ruleId: "r1", severity: "high", path: "src/secret-module.ts", line: 3, message: "bad call" }] };
    const pack = packOf([{ ...failing("unit", ["tests/secret-module.test.ts::one"]), outputTailRef: ref }, { checkId: "scan", kind: "security", findings: scan }]);
    const finding = { text: "uses the secret module", origin: "INTRODUCED", severity: "HIGH", file: "src/secret-module.ts", line: 9 };
    const review = { operationId: randomUUID(), candidateDigest: DIGEST, provider: "p", version: "1", readOnly: true, recordedAt: AT, role: "SECURITY", status: "FINDINGS", findings: [finding] };
    const workflow = workflowOf({ results: [{ checkId: "unit", status: "FAILED" }], reviews: [review] });
    const full = view({ workflow, pack, links: evidenceViewOf(pack, "t1", () => "available") });
    expect(JSON.stringify(full)).toContain("secret-module");
    const blind = view({ workflow, pack, links: evidenceViewOf(pack, "t1", () => "available"), codeDetails: false });
    expect(JSON.stringify(blind)).not.toContain("secret-module");
    expect(JSON.stringify(blind)).not.toContain(ref.sha256);
    expect(rowOf(blind, "unit")).toMatchObject({ state: "failed", before: "passed", after: "failed", retention: "kept" });
    expect(blind.securityScan).toEqual({ tool: "semgrep", counts: scan.bySeverity, items: [] });
    expect(blind.reviews[1]).toEqual({ role: "security", state: "findings", findings: [{ severity: "high", accepted: false }] });
  });
});

// ---- the route

const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const OTHER = "org_corehost00000000000b";
const OWNER_ID = "person-owner-00000000001";
const COLLEAGUE_ID = "person-colleague-000000001";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const WIRED: CoreDevWiring = { origin: () => "https://api.example" };
const get = (path: string) => ({ method: "GET", path, headers: {} });

/** The company's rule as a deployment wires it: the task's own person, and the named readers, may read it. */
function hostedRule(readers: Set<string>): TaskFlowDeps["access"] {
  return { ...createOwnerTaskAccess(), async checkStart() { return { allowed: true }; }, async canAct(principal, task) { return principal.personId === task.developerId || readers.has(principal.personId); } };
}
function appWith(world: FakeWorld, access: TaskFlowDeps["access"]): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI, flowOptions: { understandFirst: true } }),
  });
}
async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

const PLAN_V1 = { unit: ["1"], build: ["2"] };

async function world() {
  const fake = createFakeWorld();
  await registerProject(fake, FAKE_COMPANY);
  await registerProject(fake, OTHER);
  const readers = new Set<string>();
  const app = appWith(fake, hostedRule(readers));
  const members = new Map<string, CompanyMembership>();
  const companyOf = vi.fn(async (caller: DeployedCaller) => members.get(`${caller.principal.personId}|${caller.principal.companyId}`));
  const person = (personId: string, companyId: string, role: CompanyMembership["role"] = "member"): DeployedCaller => {
    members.set(`${personId}|${companyId}`, { companyId, role });
    return { principal: localOwnerPrincipal({ companyId, personId }), client: "cli" };
  };
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
  const blobs = (await app.registry()).require("object-storage");
  const planWith = (proves: Record<string, string[]>) => ({ claims: [{ id: "1", text: "Health answers 200" }, { id: "2", text: "Nothing else changes" }], checks: { proposed: [chk("unit", "pytest -q", "test"), chk("build", "npm run build", "build")], proves } });
  /** A task of `companyId` started by `owner`, with a checked candidate (the fixture's digest), results (unit passes, build fails), reviews, a stored plan (one version, or `versions`: each stored in order, `approved` named by the owner), and (optionally) a kept pack and the artifacts it names. */
  const taskOf = async (owner: DeployedCaller, companyId: string, options: { pack?: EvidencePack; stored?: Array<{ sha256: string; bytes: Uint8Array }>; planned?: boolean; versions?: Array<{ proves: Record<string, string[]>; approved?: boolean }> } = {}) => {
    const runtime = await app.runtimeFor(companyId);
    const { task } = await runtime.flow.start({ principal: owner.principal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true });
    const record = (await readTask(runtime.flow.deps, task.taskId))!;
    const artifacts: unknown[] = [];
    const decisions: unknown[] = [];
    if (options.planned !== false) {
      const versions: Array<{ proves: Record<string, string[]>; approved?: boolean }> = options.versions ?? [{ proves: PLAN_V1, approved: true }];
      for (const [index, version] of versions.entries()) {
        const text = canonicalPlanJson(planDocument(planWith(version.proves)));
        const objectKey = `private/${record.ownerKey}/${record.workspaceId}/plan-v${String(index + 1)}.json`;
        const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
        await blobs.put(objectKey, Buffer.from(text), { contentType: "application/json", metadata: {}, retention: "evidence-std" }, { overwrite: true });
        artifacts.push({ id: `plan-v${String(index + 1)}`, type: "plan", version: index + 1, sha256, producer: "agentx-planner", objectKey, createdAt: AT, format: "structured" });
        if (version.approved === true) decisions.push({ decision: "APPROVE", artifactDigest: sha256 });
      }
    }
    const workflow = {
      ...record.workflow!, artifacts: [...(record.workflow!.artifacts ?? []), ...artifacts], decisions: [...(record.workflow!.decisions ?? []), ...decisions], candidate: { schemaVersion: 1, digest: DIGEST, repositories: [{ repositoryId: "demo", commitSha: SHA, treeSha: "b".repeat(40) }] },
      checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [chk("unit", "pytest -q", "test"), chk("build", "npm run build", "build")] },
      verification: { candidateDigest: DIGEST, producer: "w", environmentId: "e", recordedAt: AT, results: [{ checkId: "unit", status: "PASS" }, { checkId: "build", status: "FAILED" }] },
      reviews: [{ role: "CRITIC", candidateDigest: DIGEST, status: "PASS", findings: [], operationId: randomUUID(), provider: "p", version: "1", readOnly: true, recordedAt: AT }],
    };
    await fake.store.put({ item: { ...(await fake.store.get(taskKey(task.taskId)))!, workflow } as never });
    if (options.pack !== undefined) await blobs.put(evidencePackKey({ ownerKey: record.ownerKey, workspaceId: record.workspaceId, taskId: task.taskId }, DIGEST), Buffer.from(JSON.stringify(options.pack)), { contentType: "application/json", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    for (const item of options.stored ?? []) await blobs.put(evidenceArtifactKey(record.ownerKey, record.workspaceId, task.taskId, item.sha256), item.bytes, { contentType: "text/plain", metadata: { sha256: item.sha256 }, retention: "evidence-std" }, { overwrite: true });
    return { taskId: task.taskId, ownerKey: record.ownerKey, workspaceId: record.workspaceId };
  };
  const read = (caller: DeployedCaller, taskId: string) => routes.route(get(`/v1/dev/tasks/${taskId}/checks`), caller);
  return { fake, routes, readers, person, taskOf, read, blobs };
}

const TAIL = Buffer.from("npm run build\nerror TS2304\n");
const TAIL_REF = { kind: "log_txt" as const, sha256: createHash("sha256").update(TAIL).digest("hex"), bytes: TAIL.byteLength, retentionClass: "evidence-std" as const };
const keptPack = (): EvidencePack => packOf([
  { checkId: "unit", label: "pytest -q", before: "failed", after: "passed", class: "fixed" },
  { checkId: "build", label: "npm run build", kind: "build", before: "passed", after: "failed", class: "regression", exitCode: 1, outputTailRef: TAIL_REF },
]);

describe("GET /v1/dev/tasks/{id}/checks on a core task", () => {
  it("the owner reads the checks: rows from the policy and the recorded results, the claims each proves from the stored plan, the review row, and the answer reads whole with the `tasks.checks` row's schema", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY);
    const answer = await w.read(owner, taskId);
    expect(answer?.statusCode).toBe(200);
    const body = JSON.parse(answer!.body) as { checks: ChecksView };
    readsAsRow("tasks.checks", body);
    expect(body.checks.taskId).toBe(taskId);
    expect(body.checks.candidateDigest).toBe(DIGEST);
    expect(body.checks.ranOn).toEqual({ commit: SHA, at: AT });
    expect(body.checks.rows.map((row) => [row.id, row.state, row.proves])).toEqual([["unit", "passed", ["1"]], ["build", "failed", ["2"]]]);
    expect(body.checks.acceptance).toEqual([{ claimId: "1", text: "Health answers 200", checkIds: ["unit"] }, { claimId: "2", text: "Nothing else changes", checkIds: ["build"] }]);
    expect(body.checks.reviews).toEqual([{ role: "code", state: "passed", findings: [] }, { role: "security", state: "not_run", findings: [] }]);
    // The row's own example is a valid answer of the same schema (the journey the table pins).
    const row = ROUTES.find((candidate) => routeIdOf(candidate) === "tasks.checks")!;
    expect(row.response!.safeParse(row.example!.response).success).toBe(true);
    // An unknown member in a newer Code's answer does not break an older reader.
    expect(row.response!.safeParse({ ...body, extra: 1, checks: { ...body.checks, other: [] } }).success).toBe(true);
  });

  it("the claims come from the plan version the owner approved, not a newer draft; with none approved there is no plan: no claim, no mapping, one fixed sentence", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const read = async (versions: Array<{ proves: Record<string, string[]>; approved?: boolean }>) => {
      const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { versions });
      return (JSON.parse((await w.read(owner, taskId))!.body) as { checks: ChecksView }).checks;
    };
    const draft = { unit: ["2"], build: ["1"] };
    expect((await read([{ proves: PLAN_V1, approved: true }, { proves: draft }])).rows.map((row) => row.proves)).toEqual([["1"], ["2"]]);
    // Nothing approved (before approval, or the approval is missing): the draft is not read, whichever version it is.
    for (const versions of [[{ proves: PLAN_V1 }, { proves: draft }], [{ proves: draft }]]) {
      const answer = await read(versions);
      expect(answer.rows.map((row) => row.proves), "no mapping").toEqual([[], []]);
      expect(answer.acceptance).toEqual([]);
      expect(answer.notTested).toEqual([CHECKS_WORDS.planUnapproved]);
      expect(JSON.stringify(answer)).not.toContain("Health answers 200");
    }
  });

  it("a task with no stored plan (a Quick task) answers its rows and no acceptance list; a plan that cannot be read says so, never a failure", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const quick = await w.taskOf(owner, FAKE_COMPANY, { planned: false });
    const body = JSON.parse((await w.read(owner, quick.taskId))!.body) as { checks: ChecksView };
    expect(body.checks.acceptance).toEqual([]);
    expect(body.checks.rows.length).toBe(2);
    const broken = await w.taskOf(owner, FAKE_COMPANY);
    await w.blobs.put(`private/${broken.ownerKey}/${broken.workspaceId}/plan-v1.json`, Buffer.from("{}"), { contentType: "application/json", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    const answer = await w.read(owner, broken.taskId);
    expect(answer?.statusCode).toBe(200);
    expect((JSON.parse(answer!.body) as { checks: ChecksView }).checks.notTested).toEqual([PLAN_UNREADABLE_WORDS]);
  });

  it("the kept pack: before and after, and the output tail is a link while the store holds it and 'expired' (no link) once it is gone", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const held = await w.taskOf(owner, FAKE_COMPANY, { pack: keptPack(), stored: [{ sha256: TAIL_REF.sha256, bytes: TAIL }] });
    const first = (JSON.parse((await w.read(owner, held.taskId))!.body) as { checks: ChecksView }).checks;
    readsAsRow("tasks.checks", { checks: first });
    // RD-2d does not serve the files yet: a kept file says so in fixed words and has no address (a dead link is worse than none); the row still says it is kept.
    expect(first.rows[1]).toMatchObject({ id: "build", before: "passed", after: "failed", retention: "kept", output: { kind: "output", id: TAIL_REF.sha256, label: CHECKS_WORDS.fileNotYet } });
    expect(first.rows[1]!.output!.href).toBeUndefined();
    // The same pack with its file gone from the store (past retention): no link, and the row says so.
    await w.blobs.delete(evidenceArtifactKey(held.ownerKey, held.workspaceId, held.taskId, TAIL_REF.sha256));
    const gone = (JSON.parse((await w.read(owner, held.taskId))!.body) as { checks: ChecksView }).checks;
    expect(gone.rows[1]).toMatchObject({ retention: "expired", output: { id: TAIL_REF.sha256 } });
    expect(gone.rows[1]!.output!.href).toBeUndefined();
    // The same size under another digest (the store's own record of what it holds) is not the pack's artifact either: withheld.
    await w.blobs.put(evidenceArtifactKey(held.ownerKey, held.workspaceId, held.taskId, TAIL_REF.sha256), TAIL, { contentType: "text/plain", metadata: { sha256: "f".repeat(64) }, retention: "evidence-std" }, { overwrite: true });
    expect(((JSON.parse((await w.read(owner, held.taskId))!.body) as { checks: ChecksView }).checks).rows[1]).toMatchObject({ retention: "withheld" });
    // Bytes of another size under the same name are not the pack's artifact: withheld, no link.
    await w.blobs.put(evidenceArtifactKey(held.ownerKey, held.workspaceId, held.taskId, TAIL_REF.sha256), Buffer.from("other"), { contentType: "text/plain", metadata: { sha256: TAIL_REF.sha256 }, retention: "evidence-std" }, { overwrite: true });
    const other = (JSON.parse((await w.read(owner, held.taskId))!.body) as { checks: ChecksView }).checks;
    expect(other.rows[1]).toMatchObject({ retention: "withheld" });
    expect(other.rows[1]!.output!.href).toBeUndefined();
  });

  it("the task read's own rule: another company's task, a colleague who may not read it and a company admin who may not read it all answer exactly as a missing task, and nothing about the task", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const stranger = w.person("person-ownerb-0000000001", OTHER);
    const colleague = w.person(COLLEAGUE_ID, FAKE_COMPANY);
    const admin = w.person("person-admin-00000000001", FAKE_COMPANY, "admin");
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { pack: keptPack(), stored: [{ sha256: TAIL_REF.sha256, bytes: TAIL }] });
    const missing = await w.read(colleague, randomUUID());
    expect(missing?.statusCode).toBe(404);
    for (const caller of [stranger, colleague, admin]) {
      const answer = await w.read(caller, taskId);
      expect(answer, "as a missing task").toEqual(missing);
      expect(answer!.body).not.toContain(taskId);
      expect(answer!.body).not.toContain("pytest");
    }
    expect((JSON.parse(missing!.body) as { error: { code: string } }).error.code).toBe("TASK_NOT_FOUND");
    // Named as a reader, the colleague reads it; the person's own company only (the same person with a token of the other company is refused first).
    w.readers.add(COLLEAGUE_ID);
    expect((await w.read(colleague, taskId))?.statusCode).toBe(200);
    const crossed: DeployedCaller = { principal: localOwnerPrincipal({ companyId: OTHER, personId: OWNER_ID }), client: "cli" };
    expect((await w.read(crossed, taskId))?.statusCode).not.toBe(200);
  });

  it("an approved plan with no structured form says so; a pack in the store that cannot be read says so (none kept does not); the answer is never cached", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const old = await w.taskOf(owner, FAKE_COMPANY);
    const stored = (await w.fake.store.get(taskKey(old.taskId)))!;
    const workflow = stored["workflow"] as unknown as { artifacts: Array<Record<string, unknown>> };
    workflow.artifacts.forEach((artifact) => { delete artifact["format"]; });
    await w.fake.store.put({ item: { ...stored, workflow } as never });
    const markdown = await w.read(owner, old.taskId);
    expect((JSON.parse(markdown!.body) as { checks: ChecksView }).checks.notTested).toEqual([CHECKS_WORDS.planNotStructured]);
    expect(markdown!.headers["cache-control"]).toBe("no-store");
    const none = await w.taskOf(owner, FAKE_COMPANY);
    expect((JSON.parse((await w.read(owner, none.taskId))!.body) as { checks: ChecksView }).checks.notTested).toEqual([]);
    const bad = await w.taskOf(owner, FAKE_COMPANY);
    await w.blobs.put(evidencePackKey({ ownerKey: bad.ownerKey, workspaceId: bad.workspaceId, taskId: bad.taskId }, DIGEST), Buffer.from("not a pack"), { contentType: "application/json", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    const unreadable = (JSON.parse((await w.read(owner, bad.taskId))!.body) as { checks: ChecksView }).checks;
    expect(unreadable.notTested).toEqual([CHECKS_WORDS.evidenceUnreadable]);
    expect(unreadable.rows.map((row) => row.state)).toEqual(["passed", "failed"]);
  });

  it("the files are checked against the store a few at a time (at most eight at once), and a join that cannot be made answers one fixed sentence, not a failure", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const tails = Array.from({ length: 20 }, (_, index) => Buffer.from(`output ${String(index)}`));
    const refs = tails.map((tail) => ({ kind: "log_txt" as const, sha256: createHash("sha256").update(tail).digest("hex"), bytes: tail.byteLength, retentionClass: "evidence-std" as const }));
    const pack = packOf(refs.map((ref, index) => ({ checkId: `check-${String(index)}`, outputTailRef: ref })));
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { pack, stored: refs.map((ref, index) => ({ sha256: ref.sha256, bytes: tails[index]! })) });
    const real = w.blobs.stat.bind(w.blobs);
    let inFlight = 0;
    let most = 0;
    const spy = vi.spyOn(w.blobs, "stat").mockImplementation(async (key: string) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return real(key);
    });
    const answer = await w.read(owner, taskId);
    spy.mockRestore();
    expect(answer?.statusCode).toBe(200);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(8);
    const checks = (JSON.parse(answer!.body) as { checks: ChecksView }).checks;
    expect(checks.rows.filter((row) => row.retention === "kept").length).toBe(20);
    // A stored workflow the join cannot read: the answer is the fixed sentence (access was settled first, so this says nothing about who may read).
    const stored = (await w.fake.store.get(taskKey(taskId)))!;
    const workflow = stored["workflow"] as unknown as { verification: { results: unknown[] } };
    workflow.verification.results = [null];
    await w.fake.store.put({ item: { ...stored, workflow } as never });
    const broken = await w.read(owner, taskId);
    expect(broken?.statusCode).toBe(200);
    expect(JSON.parse(broken!.body)).toEqual({ checks: unavailableChecksView(taskId) });
  });

  it("two companies' packs stay apart, and a read writes nothing", async () => {
    const w = await world();
    const ownerA = w.person(OWNER_ID, FAKE_COMPANY);
    const ownerB = w.person("person-ownerb-0000000001", OTHER);
    const a = await w.taskOf(ownerA, FAKE_COMPANY, { pack: packOf([{ checkId: "unit", label: "company A only" }]) });
    const b = await w.taskOf(ownerB, OTHER, { pack: packOf([{ checkId: "unit", label: "company B only", after: "failed", class: "regression" }]) });
    const before = await w.fake.store.get(taskKey(a.taskId));
    const bodyA = (await w.read(ownerA, a.taskId))!.body;
    const bodyB = (await w.read(ownerB, b.taskId))!.body;
    expect(bodyB).toContain('"state":"failed"');
    expect(bodyA).not.toContain("company B only");
    expect(bodyB).not.toContain("company A only");
    expect(await w.read(ownerB, a.taskId)).toEqual(await w.read(ownerB, randomUUID()));
    expect(await w.fake.store.get(taskKey(a.taskId))).toEqual(before);
  });
});
