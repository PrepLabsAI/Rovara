// T2 PLANRULES: the pure plan self-check rules, the built-in file checks, and the contract members they read.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PlanQualityFindingSchema, builtinFileCheckCommand, builtinFileCheckOf, canonicalPlanJson, parsePlanDocument, readCanonicalPlan, revisablePlanQualityFindings,
  type PlanDocument, type PlanQualityFinding, type WorkflowCheck, type WorkflowFeatureE2EIntent,
} from "@agentx/contracts";
import { e2eFeatureIntentDigest } from "../../packages/broker/src/e2e/feature-plan-intent.js";
import type { FeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { isStaticReaderCommand, planQualityFindings, type PlanQualityContext } from "../../packages/broker/src/developer/plan-quality.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const FOLDER = "workspace/orders";
const SHA = "a".repeat(64);
const codingInput = { kind: "plan" as const, checks: { repositoryPaths: [FOLDER], required: [] as WorkflowCheck[] } };

const step = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, ...extra });
function scenario(scenarioId: string, requestedTargetIds: string[], steps: unknown[], assertions: unknown[] = [{ kind: "http-status", path: "/api/orders.csv", method: "GET", equals: 403 }]) {
  return { scenarioId, requirementId: "r1", requestedTargetIds, required: true, accountProfileId: "viewer", minimumEvidence: "runtime", requiredRealComponentIds: [], steps, assertions };
}
const mockRef = (requestedTargetId: string) => ({ componentId: "inventory-v1", requestedTargetId, operationId: "getStock", sourcePath: "e2e/mocks/inventory-v1.json", sourceSha256: SHA });
function intentOf(parts: { scenarios: unknown[]; targets: string[]; mocks?: string[]; unavailable?: Array<{ targetId: string }> }): WorkflowFeatureE2EIntent {
  return {
    schemaVersion: 2, requestedTargetIds: parts.targets, mockFixtureRefs: (parts.mocks ?? []).map(mockRef), accountContextRefs: [], scenarios: parts.scenarios, semanticExportDeltas: [],
    applicationRuntimeRefs: [], runtimeAccountRefs: [],
    ...(parts.unavailable === undefined ? {} : { unavailableTargetRefs: parts.unavailable.map((item) => ({ targetId: item.targetId, applicationId: "orders", accountProfileId: "viewer", sourceRefs: [{ path: "package.json", sha256: SHA }] })) }),
  } as unknown as WorkflowFeatureE2EIntent;
}
const check = (id: string, label: string, executable: string, args: string[]): WorkflowCheck => ({ id, label, command: { cwd: FOLDER, executable, args, timeoutSeconds: 60 } });
function codingPlan(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return planDocument({ checks: { proposed: [], proves: {} }, ...overrides });
}
const withChecks = (checks: WorkflowCheck[], proves: Record<string, string[]>, overrides: Partial<PlanDocument> = {}) => codingPlan({ checks: { proposed: checks, proves }, ...overrides });
const codesOf = (findings: PlanQualityFinding[]) => findings.map((finding) => finding.code);

const TARGETS = [{ targetId: "orders-owner-web", kind: "web" }, { targetId: "orders-viewer-web", kind: "web" }, { targetId: "orders-viewer-api", kind: "api" }];
const MOCKS = [{ componentId: "inventory-v1", requestedTargetIds: TARGETS.map((target) => target.targetId) }];
const webSteps = ["navigate", "fill", "click", "request"];
const KINDS_WITH_AGENT = [{ kind: "web", steps: [...webSteps, "agent"], assertions: ["text", "visible", "csv", "http-status"] }, { kind: "api", steps: ["request"], assertions: ["http-status", "json"] }];
const context = (overrides: Partial<PlanQualityContext> = {}): PlanQualityContext => ({ targets: TARGETS, mockFixtures: MOCKS, executableKinds: KINDS_WITH_AGENT, unavailableReasons: [], ...overrides });

describe("built-in file checks have fixed meanings", () => {
  const folder = mkdtempSync(join(tmpdir(), "plan-quality-"));
  writeFileSync(join(folder, "app.js"), "export function exportCsv() {}\nconst flag = -1;\n");
  const run = (kind: "file-contains" | "file-not-contains", path: string, text: string): number => {
    const { executable, args } = builtinFileCheckCommand({ kind, cwd: ".", path, text });
    try {
      execFileSync(executable, args, { cwd: folder, stdio: "pipe" });
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  };

  it("file-contains passes only when the text is in the file", () => {
    expect(run("file-contains", "app.js", "exportCsv")).toBe(0);
    expect(run("file-contains", "app.js", "export-csv")).not.toBe(0);
    expect(run("file-contains", "missing.js", "exportCsv")).not.toBe(0);
  });

  it("file-not-contains passes only when the file is readable and the text is not in it; a missing file fails (it proves nothing)", () => {
    expect(run("file-not-contains", "app.js", "export-csv")).toBe(0);
    expect(run("file-not-contains", "app.js", "exportCsv")).not.toBe(0);
    expect(run("file-not-contains", "missing.js", "export-csv")).not.toBe(0);
  });

  it("treats text that starts with a dash, or holds shell and regex characters, as a plain literal", () => {
    expect(run("file-contains", "app.js", "-1")).toBe(0);
    expect(run("file-not-contains", "app.js", "-2")).toBe(0);
    expect(run("file-contains", "app.js", "export.*Csv")).not.toBe(0);
    expect(run("file-contains", "app.js", "$(touch pwned)")).not.toBe(0);
  });

  it("recognises only the commands it wrote", () => {
    const command = builtinFileCheckCommand({ kind: "file-not-contains", cwd: FOLDER, path: "src/a.ts", text: "TODO" });
    expect(builtinFileCheckOf(command)).toEqual({ kind: "file-not-contains", path: "src/a.ts", text: "TODO" });
    expect(builtinFileCheckOf({ executable: "sh", args: ["-c", "grep -q x y", "sh", "TODO", "src/a.ts"] })).toBeUndefined();
    expect(builtinFileCheckOf({ executable: "bash", args: command.args })).toBeUndefined();
    expect(builtinFileCheckOf({ executable: "sh", args: [...command.args, "extra"] })).toBeUndefined();
  });

  it("is read from a plan's checks member into an ordinary stored check, with what it proves and its expected result on the unchanged code", () => {
    const raw = { checks: [
      { label: "CSV route gone from the viewer page", kind: "file-not-contains", cwd: FOLDER, path: "public/app.js", text: "export-csv", proves: ["1"], expectOnBase: "fail" },
      { label: "Server keeps the route", kind: "file-contains", cwd: FOLDER, path: "server.js", text: "/api/orders.csv", proves: ["nc1"], expectOnBase: "pass" },
    ] };
    const result = parsePlanDocument(planAnswer(planDocument(), { checks: raw as never }), codingInput);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.plan.checks?.proposed.map((item) => builtinFileCheckOf(item.command))).toEqual([
      { kind: "file-not-contains", path: "public/app.js", text: "export-csv" }, { kind: "file-contains", path: "server.js", text: "/api/orders.csv" },
    ]);
    expect(result.plan.checks?.proves).toEqual({ "proposed-1": ["1"], "proposed-2": ["nc1"] });
    expect(result.plan.checks?.expectOnBase).toEqual({ "proposed-1": "fail", "proposed-2": "pass" });
    expect(result.proposal).toEqual({ proposed: result.plan.checks?.proposed });
    expect(readCanonicalPlan(canonicalPlanJson(result.plan))).toEqual(result.plan);
  });

  it("leaves expectOnBase out of a plan that predicted nothing, so its canonical bytes are what they were", () => {
    const raw = { checks: [{ label: "Retry tests", cwd: FOLDER, executable: "npx", args: ["vitest", "run"], proves: ["1"] }] };
    const result = parsePlanDocument(planAnswer(planDocument(), { checks: raw }), codingInput);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(Object.keys(result.plan.checks ?? {}).sort()).toEqual(["proposed", "proves"]);
    expect(canonicalPlanJson(result.plan)).not.toContain("expectOnBase");
  });

  it("marks the checks unreadable (keeping the plan) for a file check with a line break in its text, an over-long text, an unknown kind or an unknown prediction", () => {
    const base = { label: "L", kind: "file-contains", cwd: FOLDER, path: "a.ts", text: "x", proves: ["1"] };
    for (const bad of [{ text: "a\nb" }, { text: "x".repeat(301) }, { text: "" }, { kind: "file-matches" }, { expectOnBase: "maybe" }, { path: "../outside" }, { executable: "grep" }, { cwd: "elsewhere" }]) {
      const result = parsePlanDocument(planAnswer(planDocument(), { checks: { checks: [{ ...base, ...bad }] } as never }), codingInput);
      expect(result.ok && result.proposal, JSON.stringify(bad)).toEqual({ proposed: [], proposalNote: "AgentX could not read the proposed checks" });
    }
  });

  it("drops a duplicate file check and keeps the first prediction", () => {
    const one = { label: "A", kind: "file-contains", cwd: FOLDER, path: "a.ts", text: "x", proves: ["1"] };
    const raw = { checks: [one, { ...one, label: "B", proves: ["2"], expectOnBase: "fail" }] };
    const result = parsePlanDocument(planAnswer(planDocument(), { checks: raw as never }), codingInput);
    expect(result.ok && result.plan.checks?.proposed).toHaveLength(1);
    expect(result.ok && result.plan.checks?.proves).toEqual({ "proposed-1": ["1", "2"] });
    expect(result.ok && result.plan.checks?.expectOnBase).toEqual({ "proposed-1": "fail" });
  });
});

describe("scenarioProves", () => {
  // The portable (version 1) intent parses without accounts and runtime references, which is all these tests need of an intent.
  const intent = { schemaVersion: 1, requestedTargetIds: ["orders-owner-web"], accountContextRefs: [], semanticExportDeltas: [],
    scenarios: [scenario("owner-csv", ["orders-owner-web"], [step("navigate", { path: "/" })])] } as unknown as WorkflowFeatureE2EIntent;

  it("is read on a coding plan, kept outside the E2E intent, and does not move the E2E intent digest", () => {
    const plain = codingPlan({ e2e: intent });
    const proving = codingPlan({ e2e: intent, scenarioProves: { "owner-csv": ["1", "nc1"] } });
    const result = parsePlanDocument(planAnswer(proving), codingInput);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.plan.scenarioProves).toEqual({ "owner-csv": ["1", "nc1"] });
    expect(e2eFeatureIntentDigest(proving.e2e as never)).toBe(e2eFeatureIntentDigest(plain.e2e as never));
    // The version 2 intent is digested from `plan.e2e` alone as well, and `scenarioProves` is not part of it.
    expect(JSON.stringify(Object.keys(JSON.parse(canonicalPlanJson(proving)) as object))).toContain("scenarioProves");
    expect(JSON.stringify(Object.keys((JSON.parse(canonicalPlanJson(proving)) as { e2e: object }).e2e))).not.toContain("scenarioProves");
    expect(canonicalPlanJson(plain)).not.toContain("scenarioProves");
    expect(readCanonicalPlan(canonicalPlanJson(result.plan))?.scenarioProves).toEqual({ "owner-csv": ["1", "nc1"] });
  });

  it("refuses a scenario the plan lacks, a claim it lacks, and a requirements or design document", () => {
    const refused = (scenarioProves: Record<string, string[]>, kind: "plan" | "design" = "plan") => {
      const result = parsePlanDocument(planAnswer(codingPlan({ e2e: intent, scenarioProves })), { kind });
      return result.ok ? [] : result.errors;
    };
    expect(refused({ nope: ["1"] })).toEqual([expect.stringContaining("nope is not one of the E2E scenarios")]);
    expect(refused({ "owner-csv": ["9"] })).toEqual([expect.stringContaining("claim 9, which the plan does not have")]);
    expect(refused({ "owner-csv": ["nc2"] })).toEqual([expect.stringContaining("claim nc2")]);
    expect(refused({ "owner-csv": ["1"] }, "design")).not.toEqual([]);
    const stored = JSON.parse(canonicalPlanJson(codingPlan({ e2e: intent, scenarioProves: { "owner-csv": ["1"] } }))) as Record<string, unknown>;
    expect(readCanonicalPlan(JSON.stringify({ ...stored, scenarioProves: { gone: ["1"] } }))).toBeUndefined();
  });

  it("an old stored plan, without the new members, still parses and reads back unchanged", () => {
    const old = withChecks([check("proposed-1", "Retry tests", "npx", ["vitest", "run"])], { "proposed-1": ["1"] });
    expect(readCanonicalPlan(canonicalPlanJson(old))).toEqual(old);
    expect(parsePlanDocument(planAnswer(planDocument()), { kind: "plan" }).ok).toBe(true);
  });
});

describe("mock-missing-for-target", () => {
  // Test 1, plan v1: the stand-in inventory service was selected for the owner only; the viewers' web and API targets call the real service.
  const scenarios = [
    scenario("owner-csv", ["orders-owner-web"], [step("navigate", { path: "/" })]),
    scenario("viewer-web-hidden", ["orders-viewer-web"], [step("navigate", { path: "/" })], [{ kind: "visible", testId: "export", equals: false }]),
    scenario("viewer-api-refused", ["orders-viewer-api"], [step("request", { requestId: "csv", path: "/api/orders.csv", method: "GET", body: null })]),
  ];
  const targets = TARGETS.map((target) => target.targetId);
  const plan = (mocks: string[], list = scenarios) => withChecks([], {}, { e2e: intentOf({ targets, scenarios: list, mocks }) });

  it("names every viewer target that has no mock selected, and only those", () => {
    const findings = planQualityFindings(plan(["orders-owner-web"]), { context: context() }).filter((finding) => finding.code === "mock-missing-for-target");
    expect(findings.map((finding) => finding.targetIds)).toEqual([["orders-viewer-web"], ["orders-viewer-api"]]);
    expect(findings[0]).toMatchObject({ fixtureIds: ["inventory-v1"], revisable: true });
    expect(findings[0]!.plannerLine).toContain("orders-viewer-web");
    expect(findings[0]!.plannerLine).toContain("inventory-v1");
  });

  it("is quiet once every target that runs the app selects the mock, or when no mock is offered for it", () => {
    expect(codesOf(planQualityFindings(plan(targets), { context: context() }))).not.toContain("mock-missing-for-target");
    expect(codesOf(planQualityFindings(plan([]), { context: context({ mockFixtures: [] }) }))).not.toContain("mock-missing-for-target");
    expect(codesOf(planQualityFindings(plan(["orders-owner-web"]), { context: context({ mockFixtures: [{ componentId: "inventory-v1", requestedTargetIds: ["orders-owner-web"] }] }) }))).not.toContain("mock-missing-for-target");
  });

  it("ignores a target whose scenarios only call source-interface contracts, and skips the rule without a planning context", () => {
    const portable = [scenario("p", ["orders-viewer-web"], [step("invoke-contract", { operationId: "op", input: {} })])];
    expect(codesOf(planQualityFindings(plan([], portable), { context: context() }))).not.toContain("mock-missing-for-target");
    expect(codesOf(planQualityFindings(plan(["orders-owner-web"])))).not.toContain("mock-missing-for-target");
  });
});

describe("check-command-lint", () => {
  const lintOf = (label: string, executable: string, args: string[]) => {
    const plan = withChecks([check("proposed-1", label, executable, args)], { "proposed-1": ["1", "2", "nc1"] });
    return planQualityFindings(plan).filter((finding) => finding.code === "check-command-lint");
  };

  it("flags ecf67d6a's grep -cL, in any spelling, and a shell script that runs it", () => {
    for (const args of [["-cL", "export-csv", "public/app.js"], ["-Lc", "export-csv", "public/app.js"], ["-c", "-L", "export-csv", "public/app.js"], ["--count", "--files-without-match", "export-csv", "public/app.js"]]) {
      expect(lintOf("Export button removed", "grep", args), args.join(" ")).toMatchObject([{ lint: "grep-files-without-match-count", checkIds: ["proposed-1"], revisable: true }]);
    }
    expect(lintOf("Export button removed", "sh", ["-c", "cd public && grep -cL export-csv app.js"])).toMatchObject([{ lint: "grep-files-without-match-count" }]);
    expect(lintOf("Export button removed", "grep", ["-L", "export-csv", "public/app.js"])).toMatchObject([{ lint: "grep-files-without-match" }]);
  });

  it("flags ecf67d6a's exact double-quoted selector, and a quoted literal in a file check", () => {
    expect(lintOf("Selector present", "grep", ["-q", "querySelector(\"#export-csv\")", "public/app.js"])).toMatchObject([{ lint: "quoted-literal" }]);
    expect(lintOf("Selector present", "grep", ["-q", "-e", "getElementById('export')", "public/app.js"])).toMatchObject([{ lint: "quoted-literal" }]);
    const builtin = builtinFileCheckCommand({ kind: "file-contains", cwd: FOLDER, path: "public/app.js", text: "getElementById(\"export\")" });
    expect(lintOf("Selector present", builtin.executable, builtin.args)).toMatchObject([{ lint: "quoted-literal" }]);
  });

  it("flags grep used for absence (counting, or plain) unless the script negates it, and never a sound presence grep", () => {
    expect(lintOf("No default value remains", "grep", ["-c", "default", "server.js"])).toMatchObject([{ lint: "grep-count-absence" }]);
    expect(lintOf("Server does not use the old route", "grep", ["-q", "oldRoute", "server.js"])).toMatchObject([{ lint: "grep-absence" }]);
    expect(lintOf("Server does not use the old route", "sh", ["-c", "grep -q oldRoute server.js"])).toMatchObject([{ lint: "grep-absence" }]);
    expect(lintOf("Server does not use the old route", "sh", ["-c", "! grep -q oldRoute server.js"])).toEqual([]);
    expect(lintOf("Route handler exists", "grep", ["-c", "orders.csv", "server.js"])).toEqual([]);
    expect(lintOf("Retry tests", "npx", ["vitest", "run"])).toEqual([]);
  });

  it("accepts the built-in kinds and leaves model text out of every sentence", () => {
    const builtin = builtinFileCheckCommand({ kind: "file-not-contains", cwd: FOLDER, path: "public/app.js", text: "export-csv" });
    expect(lintOf("No export button", builtin.executable, builtin.args)).toEqual([]);
    const [finding] = lintOf("SECRET-LABEL-hunter2 not present", "grep", ["-cL", "SECRET-PATTERN-hunter2", "public/app.js"]);
    expect(finding).toBeDefined();
    for (const text of [finding!.ownerSentence, finding!.plannerLine, JSON.stringify(finding)]) expect(text).not.toMatch(/hunter2|SECRET/u);
    expect(finding!.plannerLine).toContain("file-contains");
  });
});

describe("claim-not-covered and claim-static-only", () => {
  const grep = check("proposed-1", "Route exists", "grep", ["-c", "orders.csv", "server.js"]);
  const runner = check("proposed-2", "Retry tests", "npx", ["vitest", "run"]);
  const coverage = (plan: PlanDocument) => planQualityFindings(plan).filter((finding) => finding.code.startsWith("claim-"));

  it("reports a claim proved only by a grep as static-only, and one with no check as not covered", () => {
    const findings = coverage(withChecks([grep], { "proposed-1": ["1"] }));
    expect(findings).toMatchObject([{ code: "claim-not-covered", claimIds: ["2", "nc1"], revisable: true }, { code: "claim-static-only", claimIds: ["1"], revisable: true }]);
    expect(findings[0]!.ownerSentence).toContain("Not changing 1");
  });

  it("counts a running check, a scenario that drives the app, and a child claim's proof", () => {
    expect(coverage(withChecks([runner], { "proposed-2": ["1", "2", "nc1"] }))).toEqual([]);
    expect(coverage(withChecks([runner], { "proposed-2": ["1.1", "2", "nc1"] }))).toEqual([]);
    const intent = intentOf({ targets: ["orders-owner-web"], scenarios: [scenario("owner-csv", ["orders-owner-web"], [step("navigate", { path: "/" })])] });
    expect(coverage(withChecks([grep], { "proposed-1": ["1"] }, { e2e: intent, scenarioProves: { "owner-csv": ["1", "2", "nc1"] } }))).toEqual([]);
    // A scenario that does not say what it proves covers nothing.
    expect(coverage(withChecks([grep], { "proposed-1": ["1"] }, { e2e: intent }))).toHaveLength(2);
  });

  it("treats a built-in file check as reading files, and a source-interface-only scenario the same way", () => {
    const builtin = { id: "proposed-1", label: "No export", command: { ...builtinFileCheckCommand({ kind: "file-not-contains", cwd: FOLDER, path: "a.js", text: "x" }), timeoutSeconds: 60 } };
    expect(coverage(withChecks([builtin], { "proposed-1": ["1", "2", "nc1"] }))).toMatchObject([{ code: "claim-static-only", claimIds: ["1", "2", "nc1"] }]);
    const portable = intentOf({ targets: ["orders-owner-web"], scenarios: [scenario("p", ["orders-owner-web"], [step("inspect-contract", { operationId: "op" })])] });
    expect(coverage(withChecks([], {}, { e2e: portable, scenarioProves: { p: ["1"] } })).map((finding) => finding.code)).toEqual(["claim-not-covered", "claim-static-only"]);
  });

  it("classifies commands: readers read, runners run, a find that executes runs", () => {
    expect(isStaticReaderCommand({ executable: "grep", args: ["x", "y"] })).toBe(true);
    expect(isStaticReaderCommand({ executable: "sh", args: ["-c", "grep -q x y && cat y | wc -l"] })).toBe(true);
    expect(isStaticReaderCommand({ executable: "sh", args: ["-c", "grep -q x y && npm test"] })).toBe(false);
    expect(isStaticReaderCommand({ executable: "find", args: [".", "-name", "x"] })).toBe(true);
    expect(isStaticReaderCommand({ executable: "find", args: [".", "-exec", "sh", "{}", ";"] })).toBe(false);
    expect(isStaticReaderCommand({ executable: "npx", args: ["vitest"] })).toBe(false);
  });

  it("gives an old stored plan (no checks, no scenarios, no new members) warnings and no errors, and leaves a plan that says no check applies alone", () => {
    const old = planDocument();
    expect(readCanonicalPlan(canonicalPlanJson(old))).toEqual(old);
    const findings = planQualityFindings(old);
    expect(findings).toMatchObject([{ code: "claim-not-covered", claimIds: ["1", "2", "nc1"] }]);
    expect(findings.every((finding) => PlanQualityFindingSchema.safeParse(finding).success)).toBe(true);
    expect(planQualityFindings(codingPlan({ checks: { proposed: [], noneReason: "Docs-only change.", proves: {} } }))).toEqual([]);
  });
});

describe("e2e-kind-unavailable and e2e-target-unavailable", () => {
  // Task 660ca54b: revision 2 had no approved AI route and its owner and viewer accounts did not match the source contract.
  const demo = context({
    executableKinds: [{ kind: "web", steps: webSteps, assertions: ["text", "visible", "csv"] }],
    unavailableReasons: [{ targetId: "orders-owner-web", reason: "no-account-definition" }, { targetId: "orders-viewer-web", reason: "no-account-definition" }, { targetId: "orders-viewer-api", reason: "runtime-unavailable" }],
  });
  const ownerScenario = scenario("owner-ai", ["orders-owner-web"], [step("agent", { goal: "export", maxActions: 5 })], [{ kind: "text", testId: "status", equals: "ok" }]);

  it("says the AI steps are off when the request needs them and the pinned revision has no AI route", () => {
    const findings = planQualityFindings(codingPlan(), { context: demo, needs: { stepKinds: ["agent"] } });
    expect(findings[0]).toMatchObject({ code: "e2e-kind-unavailable", kinds: ["agent"], revisable: false });
    expect(findings[0]!.ownerSentence).toBe("AI navigation steps are off for this project revision: its AI route is not approved. Run project setup-approve, then close and restart the task.");
  });

  it("flags an agent step the plan wrote anyway, and a kind the runtime does not offer for the scenario's target kind", () => {
    const targetsAvailable = context({ executableKinds: [{ kind: "web", steps: webSteps, assertions: ["text"] }, { kind: "api", steps: ["request"], assertions: ["http-status"] }] });
    const plan = codingPlan({ e2e: intentOf({ targets: ["orders-owner-web", "orders-viewer-api"], scenarios: [ownerScenario, scenario("api-json", ["orders-viewer-api"], [step("request", { requestId: "r", path: "/x", method: "GET", body: null })], [{ kind: "json", responseId: "r", schemaRef: "s", equals: {} }])] }) });
    expect(planQualityFindings(plan, { context: targetsAvailable }).filter((finding) => finding.code === "e2e-kind-unavailable")).toMatchObject([{ kinds: ["agent", "json"] }]);
    expect(planQualityFindings(plan, { context: context() }).filter((finding) => finding.code === "e2e-kind-unavailable")).toEqual([]);
  });

  it("names each target the plan requests that cannot run now, with the cause, grouped by cause, and puts the gaps before everything else", () => {
    const plan = codingPlan({ e2e: intentOf({ targets: ["orders-owner-web", "orders-viewer-web", "orders-viewer-api"], scenarios: [scenario("s", ["orders-owner-web"], [step("navigate", { path: "/" })])], unavailable: [{ targetId: "orders-viewer-web" }] }) });
    const findings = planQualityFindings(plan, { context: demo, needs: { targetIds: ["orders-viewer-web", "not-in-policy"] } });
    const gaps = findings.filter((finding) => finding.code === "e2e-target-unavailable");
    expect(gaps).toMatchObject([
      { targetIds: ["not-in-policy"], targetReason: "not-offered", revisable: false },
      { targetIds: ["orders-owner-web", "orders-viewer-web"], targetReason: "no-account-definition", revisable: false },
      { targetIds: ["orders-viewer-api"], targetReason: "runtime-unavailable" },
    ]);
    expect(gaps[1]!.ownerSentence).toContain("no usable test account is registered");
    expect(findings.slice(0, gaps.length).every((finding) => finding.code === "e2e-target-unavailable")).toBe(true);
    expect(revisablePlanQualityFindings(findings).every((finding) => finding.code.startsWith("claim-") || finding.code.startsWith("mock-"))).toBe(true);
  });

  it("is quiet when everything the plan needs is offered", () => {
    expect(planQualityFindings(codingPlan({ e2e: intentOf({ targets: ["orders-owner-web"], scenarios: [ownerScenario] }) }), { context: context(), needs: { stepKinds: ["agent"] } })
      .filter((finding) => finding.code.startsWith("e2e-"))).toEqual([]);
  });
});

describe("the same findings for every path, in the stored shape", () => {
  it("gives identical findings for Quick and Full, and every finding parses as the stored shape", () => {
    const plan = withChecks([check("proposed-1", "No default remains", "grep", ["-cL", "default", "a.js"])], { "proposed-1": ["1"] }, {
      e2e: intentOf({ targets: TARGETS.map((target) => target.targetId), scenarios: [scenario("v", ["orders-viewer-api"], [step("request", { requestId: "r", path: "/x", method: "GET", body: null })])] }),
    });
    const input = { context: context({ unavailableReasons: [{ targetId: "orders-owner-web", reason: "runtime-not-ready" }] }), needs: { stepKinds: ["agent"] } };
    const quick = planQualityFindings(plan, { ...input, path: "QUICK" } as never);
    const full = planQualityFindings(plan, { ...input, path: "FULL" } as never);
    expect(quick).toEqual(full);
    expect(quick).toEqual(planQualityFindings(plan, input));
    expect(new Set(codesOf(quick))).toEqual(new Set(["e2e-target-unavailable", "mock-missing-for-target", "check-command-lint", "claim-not-covered", "claim-static-only"]));
    for (const finding of quick) expect(PlanQualityFindingSchema.parse(finding)).toEqual(finding);
  });

  it("accepts the planning context the broker builds as it is", () => {
    const fromBroker = (built: FeatureE2EPlanningContext) => planQualityFindings(codingPlan(), { context: built });
    expect(typeof fromBroker).toBe("function");
  });
});
