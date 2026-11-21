// PLANVIEW (next milestone T4): what a coding plan's checks say in plain words (card, task page, full-plan route, Markdown copy),
// the decision answers an Approve in Slack uses, and why an unreadable plan could not be read.
import { describe, expect, it } from "vitest";
import {
  WorkflowSnapshotSchema, builtinFileCheckCommand, canonicalPlanJson, createWorkflowSnapshot, parsePlanDocument, planDocumentMarkdown, readCanonicalPlan,
  type PlanDocument,
} from "@agentx/contracts";
import { shortenMarkdown } from "../../packages/broker/src/developer/plan-artifacts.js";
import { PLAN_UNREADABLE_CATEGORIES, PLAN_UNREADABLE_SENTENCES, planCheckSummary, planUnreadableCategory } from "../../packages/broker/src/developer/plan-check-summary.js";
import { plainBlockReason, workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { renderPlanDocument } from "../../packages/broker/src/aws/plan-page/render-plan.js";
import { readTaskPlanDocument } from "../../packages/broker/src/aws/task-plan-document.js";
import { pageTask } from "../support/page-tasks.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const SHA = "a".repeat(64);
const PASSWORD = "hunter2-planted-secret";

type Raw = Record<string, unknown>;
const scenario = (scenarioId: string, account: string, target: string, steps: Raw[], assertions: Raw[]): Raw => ({
  scenarioId, requirementId: "export-csv", requestedTargetIds: [target], required: true, accountProfileId: account, minimumEvidence: "runtime", requiredRealComponentIds: [], steps, assertions,
});
const request = (requestId: string, path: string): Raw => ({ kind: "request", requestId, path, method: "GET", body: {} });

/** The coding plan of task ecf67d6a (Test 1): four scenarios (an AI step with a CSV, a viewer API 403, a viewer page, a form login) and two checks. */
function ordersPlan(overrides: Partial<PlanDocument> = {}, extraScenarios: Raw[] = [], mockTargets: string[] = ["web-owner", "api-viewer", "web-viewer"]): PlanDocument {
  const scenarios = [
    scenario("owner-exports-csv", "owner", "web-owner", [{ kind: "agent", goal: "Tap the Download orders button", maxActions: 5 }], [
      { kind: "visible", testId: "export-toolbar", equals: true }, { kind: "text", testId: "export-status", equals: "Orders exported" },
      { kind: "csv", downloadName: "orders.csv", columns: ["id", "status"], rows: [["a1", "in-stock"], ["a2", "unavailable"]] }]),
    scenario("viewer-api-refused", "viewer", "api-viewer", [request("r1", "/api/tenants/t1/orders"), request("r2", "/api/orders.csv")], [{ kind: "http-status", path: "/api/orders.csv", method: "GET", equals: 403 }]),
    scenario("viewer-page-hides-export", "viewer", "web-viewer", [{ kind: "navigate", path: "/" }], [{ kind: "visible", testId: "export-csv", equals: false }, { kind: "visible", testId: "export-toolbar", equals: false }]),
    scenario("owner-form-login", "owner", "web-owner", [{ kind: "navigate", path: "/login" }, { kind: "fill", testId: "password", value: PASSWORD }, { kind: "click", testId: "submit" }],
      [{ kind: "text", testId: "banner", equals: "<script>alert(1)</script>" }]),
    ...extraScenarios,
  ];
  const e2e = { schemaVersion: 1 as const, requestedTargetIds: ["web-owner", "api-viewer", "web-viewer"], accountContextRefs: [], semanticExportDeltas: [], scenarios,
    mockFixtureRefs: mockTargets.map((requestedTargetId) => ({ componentId: "inventory-v1", requestedTargetId, operationId: "getStock", sourcePath: "e2e/mocks/inventory-v1.json", sourceSha256: SHA })) };
  return planDocument({
    claims: [{ id: "1", text: "Owners can download the orders as a CSV." }, { id: "2", text: "Viewers cannot download the orders." }],
    notChanging: ["The login page stays as it is."],
    decisions: [{ id: "d1", claimId: "1", question: "Which statuses does the CSV list?", options: [{ id: "all", label: "Every status", consequence: "Longer file." }, { id: "stock", label: "In stock and unavailable", consequence: "Shorter file." }], recommended: "stock" }],
    e2e: e2e as unknown as PlanDocument["e2e"],
    scenarioProves: Object.fromEntries([["owner-exports-csv", ["1"]], ["viewer-api-refused", ["2"]], ["viewer-page-hides-export", ["2"]], ["owner-form-login", ["nc1"]]]),
    checks: { proposed: [
      { id: "proposed-1", label: "Server no longer defaults the port", command: { ...builtinFileCheckCommand({ kind: "file-not-contains", cwd: "repo/app", path: "server.mjs", text: "|| 3000" }), timeoutSeconds: 60 } },
      { id: "proposed-2", label: "Unit tests", command: { cwd: "repo/app", executable: "npx", args: ["vitest", "run"], timeoutSeconds: 120 } },
    ], proves: { "proposed-1": ["1", "nc1"], "proposed-2": ["2"] }, expectOnBase: { "proposed-1": "fail" } },
    ...overrides,
  });
}

describe("planCheckSummary", () => {
  it("POLISH-1: a derived account target has no readable name, so the line and the page omit it instead of showing its hash", async () => {
    const opaque = "account-target-7dc634a1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e";
    const plan = ordersPlan({}, [scenario("orders-region", "orders-owner", opaque, [{ kind: "navigate", path: "/" }], [{ kind: "visible", testId: "region", equals: true }])], ["web-owner", opaque]);
    const summary = planCheckSummary(plan);
    const derived = summary.scenarios.find((item) => item.scenarioId === "orders-region")!;
    expect(derived.line.startsWith("As orders-owner: expects ")).toBe(true);
    expect(derived.targets).toEqual([]);
    expect(derived.mocks).toEqual(["inventory-v1"]);
    expect(JSON.stringify(summary)).not.toContain("account-target-");
    // A named target still reads as before.
    expect(summary.lines[0]!.startsWith("As owner on web-owner: ")).toBe(true);
    const page = await renderPlanDocument({ anchor: "coding-plan", kind: "plan", version: 1, approved: false, current: true, plan, openWhatChanged: false });
    expect(page).not.toContain("account-target-");
  });

});

describe("planUnreadableCategory", () => {
  const errorsOf = (answer: string, kind: "plan" | "design" = "plan") => {
    const result = parsePlanDocument(answer, { kind });
    if (result.ok) throw new Error("expected the plan to be unreadable");
    return result.errors;
  };
  const withBlock = (mutate: (plan: Raw) => void) => {
    const plan = JSON.parse(JSON.stringify(ordersPlan())) as Raw;
    delete plan["checks"];
    mutate(plan);
    return `Here.\n\n\`\`\`agentx-plan\n${JSON.stringify(plan)}\n\`\`\`\n`;
  };

  it("reads the category from the validator's own field words, for real validator output", () => {
    const e2eSteps = errorsOf(withBlock((plan) => { ((plan["e2e"] as { scenarios: Array<{ steps: Raw[] }> }).scenarios[0]!.steps[0]!)["maxActions"] = undefined; }));
    expect(e2eSteps.join(" ")).toMatch(/e2e scenarios 1 steps 1/);
    expect(planUnreadableCategory(e2eSteps)).toBe("e2e-shape");
    expect(planUnreadableCategory(errorsOf(withBlock((plan) => { (plan["e2e"] as Raw)["schemaVersion"] = 7; })))).toBe("wrong-e2e-version");
    expect(planUnreadableCategory(errorsOf(withBlock((plan) => { plan["claims"] = [{ id: "1", text: "" }]; })))).toBe("claims-shape");
    expect(planUnreadableCategory(errorsOf(withBlock((plan) => { plan["scenarioProves"] = { nope: ["1"] }; })))).toBe("e2e-shape");
    expect(planUnreadableCategory(errorsOf("no block here"))).toBe("other");
    expect(planUnreadableCategory(errorsOf(withBlock((plan) => { plan["workBreakdown"] = { schemaVersion: 1, items: "x" }; })))).toBe("work-breakdown");
    expect(planUnreadableCategory(["the answer is too long"])).toBe("too-long");
    expect(planUnreadableCategory(['check Unit tests: arguments may not contain line breaks or control characters'])).toBe("checks-shape");
  });

  it("reads the problems the broker itself raises after a plan parses (the same function the stored category and the card use)", () => {
    expect(planUnreadableCategory(["the plan is too long once saved"])).toBe("too-long");
    expect(planUnreadableCategory(["the plan: e2e schemaVersion 2 was not offered for this planning step; use the schemaVersion 1 portable intent, or leave e2e out"])).toBe("wrong-e2e-version");
    expect(planUnreadableCategory(["ordered work is available only for a task pinned to one registered repository"])).toBe("work-breakdown");
    expect(planUnreadableCategory(["graph.items.repository: does not match the task's pinned repository"])).toBe("work-breakdown");
    expect(planUnreadableCategory(["graph.taskId: does not match the current task"])).toBe("work-breakdown");
  });

  it("the most telling category wins, and nothing is read from the model's words", () => {
    expect(planUnreadableCategory(["claim 1: text is empty", "the plan: e2e scenarios 1 steps 1 kind has a kind AgentX does not know"])).toBe("e2e-shape");
    // A model-written claim ID that spells another category changes nothing: the field words after the colon decide.
    expect(planUnreadableCategory(["claim e2e: text is empty"])).toBe("claims-shape");
    expect(planUnreadableCategory([])).toBe("other");
  });

  it("has one fixed sentence per category", () => {
    expect(Object.keys(PLAN_UNREADABLE_SENTENCES).sort()).toEqual([...PLAN_UNREADABLE_CATEGORIES].sort());
    expect(PLAN_UNREADABLE_SENTENCES["e2e-shape"]).toBe("the browser and API checks part did not match the required format");
  });
});

describe("the Markdown copy", () => {
  const markdown = (plan: PlanDocument) => planDocumentMarkdown(plan, { kind: "plan", version: 2, sha256: SHA });

  it("says a built-in file check in words, not as sh -c", () => {
    const text = markdown(ordersPlan());
    expect(text).toContain("- Server no longer defaults the port: the file `server.mjs` does not contain `|| 3000` in `repo/app` — proves 1, Not changing 1");
    expect(text).toContain("- Unit tests: `npx vitest run` in `repo/app` — proves 2");
    expect(text).not.toMatch(/sh -c|test ! -L/);
  });

  it("puts the E2E section and the checks before the decisions and lists, so a shortened copy keeps them", () => {
    const risks = Array.from({ length: 44 }, (_, index) => `Risk ${index} ${"long ".repeat(40)}`);
    const text = markdown(ordersPlan({ risks }));
    const at = (heading: string) => text.indexOf(`## ${heading}`);
    expect(at("Proposed E2E intent")).toBeGreaterThan(at("Claims"));
    expect(at("Checks")).toBeGreaterThan(at("Proposed E2E intent"));
    expect(at("Decisions")).toBeGreaterThan(at("Checks"));
    expect(at("Not changing")).toBeGreaterThan(at("Decisions"));
    expect(at("Risks")).toBeGreaterThan(at("Not changing"));
    const shortened = shortenMarkdown(text, 4_500);
    expect(shortened).toContain("## Proposed E2E intent");
    expect(shortened).toContain("## Checks");
    expect(shortened).toContain("Server no longer defaults the port");
    expect(shortened).not.toContain("Risk 43");
  });
});

describe("the approval card", () => {
  const workflow = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: "2026-10-25T10:00:00.000Z" }),
    revision: 4, stage: "PLAN_REVIEW", state: "WAITING", artifacts: [{ id: "plan-v2", type: "plan", version: 2, sha256: SHA, producer: "p", objectKey: "private/o/w/plan.json", createdAt: "2026-10-25T10:00:00.000Z" }] });

  it("is the card it was before when the plan adds no checks and has no decisions", () => {
    const plain = planDocument({ decisions: [] });
    const summary = planCheckSummary(plain);
    const card = workflowMessage({ taskId: workflow.taskId, workflow, structured: { claims: ["A."], claimCount: 1, decisionCount: 0, tiny: true, decisions: summary.decisions, checkLines: summary.lines } })!;
    expect(card.text).not.toMatch(/•|And \d+ more on/);
  });
});

describe("an unreadable plan", () => {
  const blocked = (extra: Raw = {}) => WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: "2026-10-25T10:00:00.000Z" }),
    revision: 3, stage: "PLAN", state: "BLOCKED", blockReason: "the plan couldn't be read", ...extra });
  const taskId = "11111111-1111-4111-8111-111111111111";

  it("says a stop the owner asked for once, not twice (CANCELDUP)", () => {
    const stopped = (stage: string, blockReason: string) => workflowMessage({ taskId, workflow: WorkflowSnapshotSchema.parse({ ...blocked(), stage, blockReason }) })!.text;
    expect(stopped("IMPLEMENT", "implementation operation ended cancelled")).toBe("Coding was stopped before it finished. Choose Retry to run it again.");
    expect(stopped("IMPLEMENT", "implementation operation ended interrupted")).toBe("Coding was stopped before it finished. Choose Retry to run it again.");
    expect(stopped("PLAN", "planning operation ended cancelled")).toBe("Planning was stopped before it finished. Choose Retry to run it again.");
    // A run that failed on its own still gets the full lead-in.
    expect(stopped("IMPLEMENT", "implementation operation ended failed")).toBe("Coding stopped before it finished. The run stopped unexpectedly.");
    expect(stopped("PLAN", "planning operation ended failed")).toBe("I couldn't finish the coding plan. The run stopped unexpectedly.");
    expect(plainBlockReason("implementation operation ended cancelled")).toBe("Coding was stopped before it finished. Choose Retry to run it again.");
  });
});

describe("what the card and page show of tonight's plan mistakes (fix round 1)", () => {
  const workflow = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: "2026-10-25T10:00:00.000Z" }),
    revision: 4, stage: "PLAN_REVIEW", state: "WAITING", artifacts: [{ id: "plan-v1", type: "plan", version: 1, sha256: SHA, producer: "p", objectKey: "private/o/w/plan.json", createdAt: "2026-10-25T10:00:00.000Z" }] });
  const cardOf = (plan: PlanDocument, extra: Record<string, unknown> = {}, claims = ["Owners can download the orders as a CSV."], only?: number) => {
    const summary = planCheckSummary(plan);
    if (only !== undefined) summary.lines = [summary.lines[only]!];
    return workflowMessage({ taskId: workflow.taskId, workflow, taskPageUrl: "https://agentx.example.test/review/x/task", documentLink: { url: "https://agentx.example.test/review/x/task?doc=coding-plan&from=1#coding-plan" },
      structured: { claims, claimCount: claims.length, decisionCount: plan.decisions.length, tiny: false, decisions: summary.decisions, checkLines: summary.lines }, ...extra })!;
  };
  const visible = (text: string) => text.replace(/<[^>]*\|([^>]*)>/g, "$1");
  const page = (plan: PlanDocument) => renderPlanDocument({ anchor: "coding-plan", kind: "plan", version: 1, approved: false, current: true, plan, openWhatChanged: false });

  // Task 65fd0cd0, first plan: the scenario says inventory must be real while the plan also mocks it on that target.
  const realAndMocked = ordersPlan({}, [{ ...scenario("owner-real", "owner", "web-owner", [{ kind: "navigate", path: "/" }], [{ kind: "visible", testId: "t", equals: true }]), requiredRealComponentIds: ["inventory-v1"] }]);

  it("flags a component that must be real and is also a stand-in, and lists the real ones", async () => {
    const summary = planCheckSummary(realAndMocked);
    const line = summary.lines[4]!;
    expect(summary.scenarios[4]).toMatchObject({ requiredReal: ["inventory-v1"], realAndStandIn: ["inventory-v1"] });
    expect(line).toContain("inventory-v1 must be real but is also a stand-in");
    expect(line).toContain("real: inventory-v1");
    expect(visible(cardOf(realAndMocked, {}, undefined, 4).text)).toContain("inventory-v1 must be real but is also a stand-in");
    const html = await page(realAndMocked);
    expect(html).toContain("Must run for real: inventory-v1.");
    expect(html).toContain("inventory-v1 must run for real but is also a stand-in here; approval refuses this.");
    // A scenario with only a real component and no stand-in raises no clash.
    expect(planCheckSummary(ordersPlan({}, [{ ...scenario("real-only", "owner", "web-owner", [], [{ kind: "visible", testId: "t", equals: true }]), requiredRealComponentIds: ["db"] }], []))
      .scenarios[4]).toMatchObject({ requiredReal: ["db"], realAndStandIn: [] });
  });

  it("puts the expected values first and cuts the steps, then the service names, before any expected value", () => {
    const longSteps = Array.from({ length: 12 }, (_, index) => ({ kind: "navigate", path: `/a/very/long/path/number/${index}/that/goes/on` }));
    const assertions = [{ kind: "text", testId: "status", equals: "Orders exported for the whole tenant" }, { kind: "csv", downloadName: "orders.csv", columns: ["id", "name", "qty", "status"],
      rows: [["a1", "Ada Lovelace", "12", "in-stock"], ["a2", "Grace Hopper", "3", "unavailable"]] }, { kind: "visible", testId: "export-toolbar", equals: true }];
    const busy = ordersPlan({ scenarioProves: { busy: ["1", "2"] } }, [scenario("busy", "owner", "web-owner", longSteps, assertions)]);
    const line = planCheckSummary(busy).lines[4]!;
    expect(line.length).toBeLessThanOrEqual(280);
    // The compact CSV: the count, then each row's first two cells, an ellipsis and its last cell.
    expect(line).toContain("the download orders.csv has 2 rows: a1,Ada Lovelace,…,in-stock; a2,Grace Hopper,…,unavailable");
    expect(line).toContain('the text of status is "Orders exported for the whole tenant"');
    expect(line).toContain("proves claim 1 and claim 2");
    expect(line.indexOf("expects")).toBeLessThan(line.indexOf("proves"));
    expect(line).not.toContain("steps:");
    expect(line).not.toContain("a/very/long/path");
    // On the page nothing is dropped.
    expect(planCheckSummary(busy, { detail: "page" }).scenarios[4]!.steps).toHaveLength(12);
  });

  it("always lists at least one check line, or says the plan adds checks, however many decisions and claims crowd the card", () => {
    const decisions = Array.from({ length: 6 }, (_, index) => ({ id: `d${index + 1}`, claimId: "1", question: `Question number ${index + 1} is rather long and wordy?`.padEnd(120, "x"),
      options: [{ id: "a", label: "A fairly long option label that goes on and on", consequence: "x" }, { id: "b", label: "B", consequence: "y" }], recommended: "a" }));
    const plan = ordersPlan({ decisions });
    const claims = Array.from({ length: 3 }, (_, index) => `${"Claim ".repeat(30)}${index}`);
    for (const replies of [0, 3]) {
      const text = visible(cardOf(plan, { newReplies: replies }, claims).text);
      expect(text.length).toBeLessThanOrEqual(1_200);
      expect(/^• As /m.test(text) || text.includes("This plan adds 6 checks; read them on the task page.")).toBe(true);
      expect(text).toContain("• d1:");
      // Decisions never crowd out every check line: at most two are spelled out when checks are listed.
      expect(text.match(/^• d\d/gm)!.length).toBeLessThanOrEqual(2);
    }
  });

});

describe("GET /v1/dev/tasks/:id/plan", () => {

  it("reads only this task's own storage", async () => {
    const fixture = pageTask();
    const artifact = fixture.addVersion("plan", ordersPlan());
    const task = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as never;
    const foreign = { ...(task as { workflow: { artifacts: Array<{ objectKey: string }> } }) };
    const record = { ...foreign, workflow: { ...foreign.workflow, artifacts: foreign.workflow.artifacts.map((item) => ({ ...item, objectKey: item.objectKey.replace("private/", "private/other-")})) } };
    await expect(readTaskPlanDocument(record as never, async () => fixture.objects.get(artifact.objectKey), {})).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("planAnswer round trip", () => {
  it("the fixture plan is a valid stored plan (the tests above rely on it)", () => {
    expect(readCanonicalPlan(canonicalPlanJson(ordersPlan()))).toBeDefined();
    expect(planAnswer(ordersPlan())).toContain("agentx-plan");
  });
});
