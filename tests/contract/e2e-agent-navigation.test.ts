import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2EDisplayAgentNavigationSchema, e2eAgentValueDigest, e2eAgentValueKeyId, e2eModelRouteRevision, type E2EModelReceipt } from "@agentx/contracts";
import { scriptedE2ERouteDefinition } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { agentCaseDirectoryName } from "../../packages/verifier/src/executor/evidence-paths.js";
import { agentCaseDirectory, agentNavigationOf } from "../../packages/broker/src/e2e/application-agent-display.js";

// M1.4 Task 4.4b: the navigation block of a row comes from the verified action ledger and from nothing else. These tests hold the pure derivation; the end to end (a real executor run,
// the broker's own display) is in tests/contract/workflow-e2e-agent-evidence.test.ts.
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const KEY = "ab".repeat(32);
const RUN = "11111111-1111-4111-8111-111111111111";
const CASE = "owner-export-ai-case";
const GOAL = "Download the orders export and type 'ada' in the search";
const route = scriptedE2ERouteDefinition();
const REVISION = e2eModelRouteRevision(route);
let counter = 0;
const receipt = (stepIndex: number, callIndex: number): E2EModelReceipt => {
  counter += 1;
  return { receiptId: `rcpt-${counter}`, runId: RUN, caseId: CASE, stepIndex, callIndex, routeId: route.routeId, routeRevision: REVISION, provider: route.provider, modelId: route.modelId,
    startedAt: new Date(Date.parse("2026-10-22T10:00:00.000Z") + callIndex * 1000).toISOString(), inputTokens: 100, outputTokens: 10, latencyMs: 5, servedModelId: null, servedUpstream: null,
    promptSha256: sha(`p${counter}`), responseSha256: sha(`r${counter}`), outcome: "ok" };
};
const action = (over: Record<string, unknown> = {}) => ({ tool: "tap", node: { role: "button", name: "Download orders", testId: "download-orders" }, valueDigest: null, valueLiteral: null, url: null,
  snapshotSha256: sha("screen"), outcome: "ok", ...over });
const typed = (literal: string | null) => action({ tool: "type", node: { role: "textbox", name: "Search", testId: null }, valueDigest: e2eAgentValueDigest(KEY, literal ?? "a-value-not-in-the-goal"), valueLiteral: literal });
type Spec = { stepIndex: number; goal: string; receipts: E2EModelReceipt[]; actions?: unknown[]; verdict?: string; stopCode?: string | null };
const ledgerOf = (steps: Spec[], over: Record<string, unknown> = {}) => ({ schemaVersion: "rovara-agent-actions/v1", runId: RUN, caseId: CASE, valueKeyId: e2eAgentValueKeyId(KEY),
  steps: steps.map((step) => ({ stepIndex: step.stepIndex, goalDigest: sha(step.goal), verdict: step.verdict ?? "concluded", actions: step.actions ?? [action()], stopCode: step.stopCode ?? null,
    receiptIds: step.receipts.map((item) => item.receiptId) })), ...over });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function input(over: { ledger?: unknown; receipts?: E2EModelReceipt[]; steps?: Spec[]; agentSteps?: { declaredStepIndex: number; goal: string }[]; valueKey?: string; ledgerBytes?: Uint8Array | null } = {}) {
  const receipts = over.receipts ?? [receipt(1, 0), receipt(1, 1), receipt(1, 2)];
  const steps = over.steps ?? [{ stepIndex: 1, goal: GOAL, receipts }];
  return { ledgerBytes: over.ledgerBytes === undefined ? bytes(over.ledger ?? ledgerOf(steps)) : over.ledgerBytes, valueKey: over.valueKey ?? KEY, runId: RUN, caseId: CASE,
    agentSteps: over.agentSteps ?? [{ declaredStepIndex: 1, goal: GOAL }], receipts, routeId: route.routeId, decidedBy: ["csv" as const] };
}

describe("agentNavigationOf", () => {
  it("builds the block from a verified ledger: the approved goal, the role and name acted on, how the step ended, the model calls, the route", () => {
    const block = agentNavigationOf(input());
    expect(block).toEqual({ steps: [{ goal: GOAL, actedOn: [{ role: "button", name: "Download orders" }], stop: "concluded" }], modelCalls: 3, routeId: route.routeId, decidedBy: ["csv"] });
    expect(E2EDisplayAgentNavigationSchema.safeParse(block).success).toBe(true);
  });

  it("names a node by role and name only, never a test id, a url, a digest or a typed value, and leaves out the node of a typed value", () => {
    const receipts = [receipt(1, 0)];
    const block = agentNavigationOf(input({ receipts, steps: [{ stepIndex: 1, goal: GOAL, receipts, actions: [typed("ada"), typed(null), action({ tool: "navigate", node: null, url: "/orders" }), action()] }] }))!;
    const text = JSON.stringify(block);
    expect(block.steps[0]!.actedOn).toEqual([{ role: "button", name: "Download orders" }]);
    for (const leak of ["download-orders", "/orders", e2eAgentValueDigest(KEY, "ada"), e2eAgentValueDigest(KEY, "a-value-not-in-the-goal"), "a-value-not-in-the-goal", "Search", KEY]) expect(text, leak).not.toContain(leak);
  });

  it("gives nothing for a ledger of more AI steps than a group may have (the contract allows 3)", () => {
    const receipts = [receipt(1, 0), receipt(2, 0), receipt(3, 0), receipt(4, 0)];
    const many = Array.from({ length: 8 }, (_, index) => action({ node: { role: "button", name: `Button ${index}`, testId: null } }));
    const steps: Spec[] = [
      { stepIndex: 1, goal: "one", receipts: [receipts[0]!], actions: [action({ outcome: "action-failed", node: { role: "button", name: "Broken button", testId: null } }), action(), action(), ...many] },
      { stepIndex: 2, goal: "two", receipts: [receipts[1]!] }, { stepIndex: 3, goal: "three", receipts: [receipts[2]!] }, { stepIndex: 4, goal: "four", receipts: [receipts[3]!] },
    ];
    const block = agentNavigationOf(input({ receipts, steps, agentSteps: steps.map((step) => ({ declaredStepIndex: step.stepIndex, goal: step.goal })) }));
    expect(block).toBeUndefined();
  });

  it("leaves out an action that did not succeed, folds a repeated click and keeps the first 3 steps' elements in order", () => {
    const receipts = [receipt(1, 0), receipt(2, 0), receipt(3, 0)];
    const many = Array.from({ length: 5 }, (_, index) => action({ node: { role: "button", name: `Button ${index}`, testId: null } }));
    const steps: Spec[] = [
      { stepIndex: 1, goal: "one", receipts: [receipts[0]!], actions: [action({ outcome: "action-failed", node: { role: "button", name: "Broken button", testId: null } }), action(), action(), ...many] },
      { stepIndex: 2, goal: "two", receipts: [receipts[1]!] }, { stepIndex: 3, goal: "three", receipts: [receipts[2]!] },
    ];
    const block = agentNavigationOf(input({ receipts, steps, agentSteps: steps.map((step) => ({ declaredStepIndex: step.stepIndex, goal: step.goal })) }))!;
    expect(block.steps).toHaveLength(3);
    expect(block.steps[0]!.actedOn.map((node) => node.name)).toEqual(["Download orders", "Button 0", "Button 1", "Button 2", "Button 3", "Button 4"]);
    expect(JSON.stringify(block)).not.toContain("Broken button");
  });

  it("says how a step ended as the ledger recorded it", () => {
    const receipts = [receipt(1, 0)];
    const failed = agentNavigationOf(input({ receipts, steps: [{ stepIndex: 1, goal: GOAL, receipts, verdict: "failed", stopCode: "STEP_BUDGET_EXHAUSTED", actions: [] }] }))!;
    expect(failed.steps[0]).toMatchObject({ stop: "failed", actedOn: [] });
    const cut = agentNavigationOf(input({ receipts, steps: [{ stepIndex: 1, goal: GOAL, receipts, verdict: "cut-short" }] }))!;
    expect(cut.steps[0]!.stop).toBe("cut-short");
  });

  it("shows a step the ledger has when a later AI step of the scenario was never reached", () => {
    const receipts = [receipt(1, 0)];
    const block = agentNavigationOf(input({ receipts, agentSteps: [{ declaredStepIndex: 1, goal: GOAL }, { declaredStepIndex: 3, goal: "never reached" }] }));
    expect(block?.steps).toHaveLength(1);
  });

  it("gives nothing for a ledger that is not verified: another key, another run or case, a goal that is not the approved one, a literal that is not in the goal, a forged receipt id", () => {
    expect(agentNavigationOf(input({ valueKey: "cd".repeat(32) }))).toBeUndefined();
    expect(agentNavigationOf(input({ ledger: ledgerOf([{ stepIndex: 1, goal: GOAL, receipts: [receipt(1, 0)] }], { runId: "22222222-2222-4222-8222-222222222222" }) }))).toBeUndefined();
    expect(agentNavigationOf(input({ ledger: ledgerOf([{ stepIndex: 1, goal: GOAL, receipts: [receipt(1, 0)] }], { caseId: "another-case" }) }))).toBeUndefined();
    expect(agentNavigationOf(input({ agentSteps: [{ declaredStepIndex: 1, goal: "a different approved goal" }] }))).toBeUndefined();
    const receipts = [receipt(1, 0)];
    expect(agentNavigationOf(input({ receipts, steps: [{ stepIndex: 1, goal: GOAL, receipts, actions: [typed("not in the goal")] }] }))).toBeUndefined();
    const forged = ledgerOf([{ stepIndex: 1, goal: GOAL, receipts: [receipt(1, 0)] }]);
    expect(agentNavigationOf(input({ ledger: forged, receipts: [receipt(1, 0)] }))).toBeUndefined();
  });

  it("gives nothing for a receipt of another step, a missing, oversized or unreadable ledger, or an approved step with no goal", () => {
    const receipts = [receipt(2, 0)];
    expect(agentNavigationOf(input({ receipts, steps: [{ stepIndex: 1, goal: GOAL, receipts }] }))).toBeUndefined();
    expect(agentNavigationOf(input({ ledgerBytes: null }))).toBeUndefined();
    expect(agentNavigationOf(input({ ledgerBytes: new Uint8Array(70_000).fill(32) }))).toBeUndefined();
    expect(agentNavigationOf(input({ ledgerBytes: new TextEncoder().encode("{not json") }))).toBeUndefined();
    expect(agentNavigationOf(input({ ledgerBytes: bytes([1, 2]) }))).toBeUndefined();
    expect(agentNavigationOf(input({ agentSteps: [] }))).toBeUndefined();
  });

  it("scrubs the free text it shows: a credential pattern or an email in a goal or an element name", () => {
    const goal = "Open the page for ops@tenant-a.example with password=hunter2-secret";
    const receipts = [receipt(1, 0)];
    const block = agentNavigationOf({ ...input({ receipts, steps: [{ stepIndex: 1, goal, receipts, actions: [action({ node: { role: "button", name: "Mail ops@tenant-a.example", testId: null } })] }], agentSteps: [{ declaredStepIndex: 1, goal }] }) });
    const text = JSON.stringify(block);
    expect(block).toBeDefined();
    expect(text).not.toContain("hunter2-secret");
    expect(text).not.toContain("ops@tenant-a.example");
  });

  it("names the ledger directory exactly as the verifier does", () => {
    for (const caseId of ["owner-export-ai-case", "x", "a".repeat(160)]) expect(agentCaseDirectory(caseId)).toBe(agentCaseDirectoryName(caseId));
  });
});

// Test 29, at the level of a ledger that typed values: a ledger whose `type` action has `valueLiteral: null` and a known `valueDigest`, a password as the typed value, and a seeded password
// in the name of an element the page shows. Whatever the model typed, the display, the page, Slack and the stored copy hold none of it.
import { E2EScenarioResultsSchema } from "@agentx/contracts";
import { renderE2EScenarioRowsHtml, renderE2EScenarioSlackBlocks } from "../../packages/broker/src/e2e-presentation.js";
import { scrubScenarioResults } from "../../packages/broker/src/e2e/application-display.js";
import { createWorkflowE2EDisplayObject } from "../../packages/broker/src/aws/workflow-e2e-notifier-projection.js";
import { row } from "../support/e2e-scenario-results.js";

describe("test 29: nothing the model typed reaches a row, the page, Slack or the stored copy", () => {
  const PASSWORD = "Hunter2-seeded-password";
  const EMAIL_LOCAL = "maya.owner";
  it("holds none of the typed values, their digests, the run's key, a seeded password or an email", () => {
    const receipts = [receipt(1, 0), receipt(1, 1)];
    const actions = [typed(null), typed("ada"), action({ tool: "type", node: { role: "textbox", name: `Password ${PASSWORD}`, testId: "password" }, valueDigest: e2eAgentValueDigest(KEY, PASSWORD), valueLiteral: null }),
      action({ tool: "select", node: { role: "combobox", name: "Sort", testId: null }, valueDigest: e2eAgentValueDigest(KEY, "newest-first"), valueLiteral: null }),
      action({ tool: "press", node: { role: "textbox", name: "Search", testId: null }, valueDigest: e2eAgentValueDigest(KEY, "Enter"), valueLiteral: null }), action()];
    const block = agentNavigationOf(input({ receipts, steps: [{ stepIndex: 1, goal: GOAL, receipts, actions }] }))!;
    expect(block).toBeDefined();
    const digests = actions.map((item) => (item as { valueDigest: string | null }).valueDigest).filter((digest): digest is string => digest !== null);
    expect(digests.length).toBeGreaterThanOrEqual(4);
    const rows = [row({ scenarioId: "owner-export-ai", title: "Owner export ai", agentNavigation: block })];
    const stored = scrubScenarioResults({ scenarios: rows })!;
    expect(E2EScenarioResultsSchema.safeParse(stored).success).toBe(true);
    const display = createWorkflowE2EDisplayObject({ ownerKey: "owner", workspaceId: "workspace", capturedAt: "2026-10-22T12:00:00.000Z", scenarioResults: { scenarios: rows },
      view: { schemaVersion: 1, setup: { status: "unavailable", selectedTargetIds: [], executionPlanDigest: null, blockingInputIds: [], mockSubstitutableInputIds: [] },
        e2e: { status: "UNKNOWN", label: "x", executionPlanDigest: null, expectedGroups: 1, receivedGroups: 1, executedCases: 1, qualifiedCriteria: 0, requiredCriteria: 1, unavailableCriteria: 1,
          optionalUnavailableCriteria: 0, mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [], policyPresence: "present", workflowPhase: "VERIFY", requiredUnexercisedCriteriaIds: [] }, actions: [] },
      current: { candidateDigest: "a".repeat(64), roundId: "11111111-1111-4111-8111-111111111111", groupRunIds: ["22222222-2222-4222-8222-222222222222"], admissionSha256: "b".repeat(64), evidenceSha256: "c".repeat(64) } })!;
    const everything = [JSON.stringify(rows), JSON.stringify(stored), renderE2EScenarioRowsHtml({ scenarios: rows }, { artifactPath: (sha) => `/a/${sha}` }),
      renderE2EScenarioSlackBlocks({ scenarios: rows }, { taskPageUrl: "https://agentx.test/t" }).map((item) => item.text.text).join("\n"), Buffer.from(display.bytes).toString("utf8")].join("\n");
    // Positive control: the display is there and shows the element the model clicked, so the scan ran over the right thing.
    expect(everything).toContain("Download orders");
    for (const secret of [KEY, e2eAgentValueKeyId(KEY), ...digests, "newest-first", PASSWORD, EMAIL_LOCAL, "download-orders"]) expect(everything, secret).not.toContain(secret);
  });
});
