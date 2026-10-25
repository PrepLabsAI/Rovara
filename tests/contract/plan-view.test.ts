// PLANVIEW (next milestone T4): what a coding plan's checks say in plain words (card, task page, full-plan route, Markdown copy),
// the decision answers an Approve in Slack uses, and why an unreadable plan could not be read.
import { describe, expect, it } from "vitest";
import {
  WorkflowSnapshotSchema, builtinFileCheckCommand, canonicalPlanJson, createWorkflowSnapshot, parsePlanDocument, planDocumentMarkdown, readCanonicalPlan,
  type PlanDocument,
} from "@agentx/contracts";
import { shortenMarkdown } from "../../packages/broker/src/developer/plan-artifacts.js";
import { PLAN_UNREADABLE_CATEGORIES, PLAN_UNREADABLE_SENTENCES, planCheckSummary, planUnreadableCategory } from "../../packages/broker/src/developer/plan-check-summary.js";
import { plainBlockReason, structuredExtraLines, workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { renderPlanDocument } from "../../packages/broker/src/aws/plan-page/render-plan.js";
import { readTaskPlanDocument } from "../../packages/broker/src/aws/task-plan-document.js";
import { routeDeveloperTaskRequest } from "../../packages/broker/src/aws/developer-tasks.js";
import { OMAR, PRIYA, pageTask } from "../support/page-tasks.js";
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
  it("says each scenario in plain words from its structured fields", () => {
    const summary = planCheckSummary(ordersPlan());
    expect(summary.scenarios).toHaveLength(4);
    // Expected values come first, then what it proves, the AI step limit and the stand-ins; the steps are what is cut to fit.
    expect(summary.lines[0]).toBe('As owner on web-owner: expects export-toolbar is shown; the text of export-status is "Orders exported"; the download orders.csv has 2 rows: a1,in-stock; a2,unavailable; '
      + "proves claim 1; AI steps take up to 5 actions; stand-ins: inventory-v1; steps: 1 step");
    expect(summary.lines[1]).toBe("As viewer on api-viewer: expects GET /api/orders.csv answers 403; proves claim 2; stand-ins: inventory-v1; steps: sends GET /api/tenants/t1/orders, sends GET /api/orders.csv");
    expect(summary.lines[2]).toBe("As viewer on web-viewer: expects export-csv is hidden; export-toolbar is hidden; proves claim 2; stand-ins: inventory-v1; steps: opens /");
    expect(summary.scenarios[0]).toMatchObject({ maxActions: 5, proves: ["claim 1"], mocks: ["inventory-v1 on web-owner"], requiredReal: [], realAndStandIn: [] });
    expect(summary.scenarios[3]!.proves).toEqual(["Not changing 1"]);
  });

  it("never shows what was typed into a field", () => {
    const summary = planCheckSummary(ordersPlan(), { detail: "page" });
    expect(JSON.stringify(summary)).not.toContain(PASSWORD);
    expect(summary.scenarios[3]!.steps).toEqual(["opens /login", "fills in password", "clicks submit"]);
  });

  it("says a built-in file check in words, never as the sh -c script", () => {
    const summary = planCheckSummary(ordersPlan());
    expect(summary.checks[0]).toMatchObject({ builtin: true, proves: ["claim 1", "Not changing 1"] });
    expect(summary.lines[4]).toBe('Check "Server no longer defaults the port" checks that server.mjs does not contain "|| 3000"; proves claim 1 and Not changing 1');
    expect(summary.lines[5]).toBe('Check "Unit tests" runs npx vitest run; proves claim 2');
    expect(summary.lines.join("\n")).not.toMatch(/sh -c|grep|test ! -L/);
  });

  it("adds what a try on the current code gave, as expected or not", () => {
    const tried = (outcome: "passed" | "failed" | "broken") => planCheckSummary(ordersPlan(), { triedOnCurrentCode: { "proposed-1": outcome } }).checks[0]!.tried;
    expect(tried("failed")).toBe("tried on current code: failed as expected");
    expect(tried("passed")).toBe("tried on current code: passed, not as expected");
    expect(tried("broken")).toBe("tried on current code: could not run");
    expect(planCheckSummary(ordersPlan()).checks[0]).not.toHaveProperty("tried");
    expect(planCheckSummary(ordersPlan(), { triedOnCurrentCode: { "proposed-1": "failed" } }).lines[4]).toContain("; tried on current code: failed as expected");
  });

  it("gives the answer each decision gets when Approve takes AgentX's recommendation", () => {
    expect(planCheckSummary(ordersPlan()).decisions).toEqual([{ id: "d1", question: "Which statuses does the CSV list?", answer: "In stock and unavailable" }]);
  });

  it("cuts an expected value to 80 characters on a card and keeps far more for the page, always on one line with secrets removed", () => {
    const long = `${"word ".repeat(60)}AKIAABCDEFGHIJKLMNOP\nsecond line`;
    const plan = ordersPlan({}, [scenario("long", "owner", "web-owner", [], [{ kind: "text", testId: "t", equals: long }])]);
    const card = planCheckSummary(plan).scenarios[4]!;
    const page = planCheckSummary(plan, { detail: "page" }).scenarios[4]!;
    expect(card.expects[0]).toMatch(/^the text of t is "word word .*…"$/);
    expect(Array.from(card.expects[0]!.split('"')[1]!)).toHaveLength(80);
    expect(page.expects[0]!.length).toBeGreaterThan(card.expects[0]!.length);
    for (const text of [card.line, page.line]) expect(text).not.toMatch(/AKIA|\n/);
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
  const cardOf = (plan: PlanDocument) => {
    const summary = planCheckSummary(plan);
    return workflowMessage({ taskId: workflow.taskId, workflow, taskPageUrl: "https://agentx.example.test/review/x/task", documentLink: { url: "https://agentx.example.test/review/x/task?doc=coding-plan&from=2#coding-plan" },
      structured: { claims: ["Owners can download the orders as a CSV.", "Viewers cannot download the orders."], claimCount: 2, decisionCount: plan.decisions.length, tiny: false, decisions: summary.decisions, checkLines: summary.lines } })!;
  };
  const bullets = (text: string) => text.split("\n").filter((line) => line.startsWith("• "));

  it("lists the scenarios with their CSV rows and the decision answer Approve here uses, within the brief limit", () => {
    const card = cardOf(ordersPlan());
    expect(card.text).toContain("• d1: Which statuses does the CSV list? Answer: In stock and unavailable");
    expect(card.text).toContain("the download orders.csv has 2 rows: a1,in-stock; a2,unavailable; proves claim 1");
    expect(card.text).toContain("As viewer on api-viewer: expects GET /api/orders.csv answers 403; proves claim 2");
    expect(card.text.split("\n").indexOf("• d1: Which statuses does the CSV list? Answer: In stock and unavailable"))
      .toBeGreaterThan(card.text.split("\n").findIndex((line) => line.startsWith("Approve here uses")));
    expect(card.text.replace(/<[^>]*\|([^>]*)>/g, "$1").length).toBeLessThanOrEqual(1_200);
  });

  it("says 'And N more' for the lines it cannot list, counting each one", () => {
    const many = Array.from({ length: 9 }, (_, index) => scenario(`extra-${index}`, "owner", "web-owner", [{ kind: "navigate", path: `/p${index}` }], [{ kind: "visible", testId: `t${index}`, equals: true }]));
    const plan = ordersPlan({}, many);
    const card = cardOf(plan);
    const total = planCheckSummary(plan).lines.length;
    expect(total).toBe(15);
    const listed = bullets(card.text).filter((line) => !line.startsWith("• d1:")).length;
    expect(listed).toBeLessThanOrEqual(8);
    expect(card.text).toContain(`And ${total - listed} more on the task page.`);
    expect(card.text.replace(/<[^>]*\|([^>]*)>/g, "$1").length).toBeLessThanOrEqual(1_200);
  });

  it("escapes the plan's own words for Slack and shows no typed value", () => {
    const text = cardOf(ordersPlan()).text;
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("<script>");
    const longLabel = ordersPlan({ decisions: [{ id: "d1", claimId: "1", question: "Tell <!channel> now?", options: [{ id: "a", label: "<@U0TEAMMATE1>", consequence: "x" }, { id: "b", label: "B", consequence: "y" }], recommended: "a" }] });
    expect(cardOf(longLabel).text).not.toMatch(/<!channel>|<@U0TEAMMATE1>/);
    expect(cardOf(longLabel).text).toContain("&lt;@U0TEAMMATE1&gt;");
  });

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

  it("says why in a fixed category sentence and what to do, with no validator text", () => {
    const message = workflowMessage({ taskId, workflow: blocked(), planUnreadableCategory: planUnreadableCategory(["the plan: e2e scenarios 1 steps 2 maxActions is missing", "the plan: e2e goal AKIAABCDEFGHIJKLMNOP"]) })!;
    expect(message.text).toBe("AgentX couldn't read the coding plan it wrote: the browser and API checks part did not match the required format. Choose Retry planning (it gets the problems found), or Close.");
    expect(message.text).not.toMatch(/maxActions|AKIA/);
    expect(JSON.stringify(message.blocks)).toContain("agentx_workflow_retry_plan");
  });

  it("keeps the short sentence when no category is known", () => {
    expect(workflowMessage({ taskId, workflow: blocked() })!.text).toBe("AgentX couldn't read the coding plan it wrote.");
  });

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

describe("the task page section", () => {
  it("lists every scenario and every proposed check with escaped expected values, stand-ins and the AI step limit", async () => {
    const plan = ordersPlan();
    const html = await renderPlanDocument({ anchor: "coding-plan", kind: "plan", version: 2, approved: false, current: true, plan, openWhatChanged: false });
    expect(html).toContain("Checks this plan adds");
    for (const id of ["owner-exports-csv", "viewer-api-refused", "viewer-page-hides-export", "owner-form-login"]) expect(html).toContain(id);
    expect(html).toContain("the download orders.csv has the columns id, status and the rows &quot;a1,in-stock&quot;; &quot;a2,unavailable&quot;");
    expect(html).toContain("the text of banner is &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Stand-in services: inventory-v1 on web-owner.");
    expect(html).toContain("An AI step may take up to 5 actions.");
    expect(html).toContain("fills in password");
    expect(html).not.toContain(PASSWORD);
    expect(html).toContain("checks that server.mjs does not contain &quot;|| 3000&quot;");
    expect(html).not.toMatch(/sh -c|test ! -L/);
    expect(html).toContain("Proves:");
    // A plan with no scenarios and no proposed checks has no such section.
    expect(await renderPlanDocument({ anchor: "design", kind: "design", version: 1, approved: false, current: true, plan: planDocument(), openWhatChanged: false })).not.toContain("Checks this plan adds");
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

  // Task ecf67d6a, first plan: the stand-in service is selected for the owner target only.
  const mockOnOwnerOnly = ordersPlan({}, [], ["web-owner"]);
  // Task 65fd0cd0, first plan: the scenario says inventory must be real while the plan also mocks it on that target.
  const realAndMocked = ordersPlan({}, [{ ...scenario("owner-real", "owner", "web-owner", [{ kind: "navigate", path: "/" }], [{ kind: "visible", testId: "t", equals: true }]), requiredRealComponentIds: ["inventory-v1"] }]);

  it("shows which scenarios have no stand-in (the viewer targets of the plan that forgot them), on the card and the page", async () => {
    const summary = planCheckSummary(mockOnOwnerOnly);
    expect(summary.lines[0]).toContain("stand-ins: inventory-v1");
    expect(summary.lines[1]).toContain("no stand-ins");
    expect(summary.lines[2]).toContain("no stand-ins");
    expect(visible(cardOf(mockOnOwnerOnly).text)).toContain("As viewer on api-viewer: expects GET /api/orders.csv answers 403; proves claim 2; no stand-ins");
    const html = await page(mockOnOwnerOnly);
    expect(html).toContain("No stand-in services on api-viewer.");
    expect(html).toContain("No stand-in services on web-viewer.");
    expect(html).toContain("Stand-in services: inventory-v1 on web-owner.");
  });

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

  it("shows an AI step's action limit next to its expected values (maxActions 8)", () => {
    const eight = ordersPlan({}, [scenario("ai", "owner", "web-owner", [{ kind: "agent", goal: "Tap the Download orders button", maxActions: 8 }], [{ kind: "visible", testId: "t", equals: true }])]);
    expect(planCheckSummary(eight).lines[4]).toContain("AI steps take up to 8 actions");
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

  it("says the plan adds checks when not even one line fits, and still lists the first line when one does", () => {
    const summary = planCheckSummary(ordersPlan());
    const structured = { claims: ["A."], claimCount: 1, decisionCount: 1, tiny: false, decisions: summary.decisions, checkLines: summary.lines };
    // 100 characters of room hold neither a decision line nor a check line: the notice is still said.
    expect(structuredExtraLines(structured, 100)).toEqual(["This plan adds 6 checks; read them on the task page."]);
    // With room for one check line and its "And N more", that line is listed, not the decision.
    const first = structuredExtraLines({ ...structured, decisions: [] }, 340);
    expect(first[0]).toMatch(/^• As owner on web-owner: expects /);
    expect(first.at(-1)).toBe("And 5 more on the task page.");
    const withDecision = structuredExtraLines(structured, 340);
    expect(withDecision.some((line) => line.startsWith("• As "))).toBe(true);
    expect(planCheckSummary(planDocument()).lines).toEqual([]);
    expect(structuredExtraLines({ ...structured, decisions: [], checkLines: [] }, 100)).toEqual([]);
  });
});

describe("GET /v1/dev/tasks/:id/plan", () => {
  const route = (fixture: ReturnType<typeof pageTask>, caller: typeof PRIYA, query = "") => routeDeveloperTaskRequest(fixture.deps, caller,
    { method: "GET", path: `/v1/dev/tasks/${fixture.taskId}/plan${query}`, headers: {}, requestId: "r1" }, new URL(`/v1/dev/tasks/${fixture.taskId}/plan${query}`, "https://agentx.invalid")) as Promise<{
    plan: { version: number; sha256: string; approved: boolean; current: boolean; versions: number[]; content: PlanDocument; summary: { lines: string[]; decisions: unknown[] } } }>;

  it("returns the whole canonical document, at the size limit, with the plain summary", async () => {
    const fixture = pageTask();
    const bulk = (index: number, size: number) => scenario(`bulk-${index}`, "owner", "web-owner", [], [{ kind: "text", testId: `t${index}`, equals: `${index}`.repeat(size) }]);
    const big = ordersPlan({}, [bulk(1, 7_000), bulk(2, 7_000), bulk(3, 7_000), bulk(4, 6_500)]);
    const artifact = fixture.addVersion("plan", big);
    // Within the size a stored plan may have, and large enough that the Markdown copy a task shows would be cut short with the E2E section in it.
    const bytes = Buffer.byteLength(canonicalPlanJson(big), "utf8");
    expect(bytes).toBeGreaterThan(30_000);
    expect(bytes).toBeLessThanOrEqual(32_768);
    const { plan } = await route(fixture, PRIYA);
    expect(plan).toMatchObject({ version: 1, sha256: artifact.sha256, approved: false, current: true, versions: [1] });
    expect(canonicalPlanJson(plan.content)).toBe(canonicalPlanJson(big));
    expect(readCanonicalPlan(canonicalPlanJson(plan.content))).toBeDefined();
    expect(plan.summary.lines).toHaveLength(10);
    expect(plan.summary.decisions).toEqual([{ id: "d1", question: "Which statuses does the CSV list?", answer: "In stock and unavailable" }]);
  });

  it("returns the version asked for, and says which is the latest", async () => {
    const fixture = pageTask();
    const first = fixture.addVersion("plan", ordersPlan());
    fixture.addVersion("plan", ordersPlan({ title: "Second try" }));
    const old = (await route(fixture, PRIYA, "?version=1")).plan;
    expect(old).toMatchObject({ version: 1, sha256: first.sha256, current: false, versions: [1, 2] });
    expect((await route(fixture, PRIYA)).plan).toMatchObject({ version: 2, current: true });
    await expect(route(fixture, PRIYA, "?version=3")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(route(fixture, PRIYA, "?version=abc")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(route(fixture, PRIYA, "?document=nonsense")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("answers only the task's owner, and the same as a missing task for anyone else", async () => {
    const fixture = pageTask();
    fixture.addVersion("plan", ordersPlan());
    const other = await route(fixture, OMAR).catch((error: unknown) => error as { code: string; message: string });
    expect(other).toMatchObject({ code: "TASK_NOT_FOUND" });
    const missing = await routeDeveloperTaskRequest(fixture.deps, OMAR, { method: "GET", path: "/x", headers: {}, requestId: "r" },
      new URL("/v1/dev/tasks/8b579b4b-eaa7-4bf2-87bc-999999999999/plan", "https://agentx.invalid")).catch((error: unknown) => error as { code: string });
    expect(missing).toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("refuses a document whose bytes changed, a task with no plan yet and a Markdown document", async () => {
    const fixture = pageTask();
    await expect(route(fixture, PRIYA)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const artifact = fixture.addVersion("plan", ordersPlan());
    fixture.objects.set(artifact.objectKey, `${fixture.objects.get(artifact.objectKey)!} `);
    await expect(route(fixture, PRIYA)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const legacy = pageTask();
    legacy.addVersion("plan", "# Goal\nFix it.");
    await expect(route(legacy, PRIYA)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("removes secrets from every string of the document", async () => {
    const fixture = pageTask();
    fixture.addVersion("plan", ordersPlan({ risks: ["Key AKIAABCDEFGHIJKLMNOP leaked"] }));
    const { plan } = await route(fixture, PRIYA);
    expect(JSON.stringify(plan.content)).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });

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
