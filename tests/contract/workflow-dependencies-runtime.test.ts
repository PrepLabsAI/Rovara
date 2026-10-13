import { describe, expect, it } from "vitest";
import { z } from "zod";
import { taskGraphDigest, WORKER_INVOCATION_FEATURES } from "@agentx/contracts";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { createWorkflowE2E, SLACK_MAYA, type WorkflowE2E } from "../support/workflow-e2e.js";
import { assertJourneyInvariants, registerJourneyInvariants } from "../support/workflow-e2e-invariants.js";

registerJourneyInvariants();

const CallbackEventsSchema = z.object({ events: z.array(z.object({
  payload: z.object({ workItemProgress: z.object({ state: z.string(), itemId: z.string() }).optional() }).passthrough().optional(),
}).passthrough()) }).passthrough();
const SlackActionBlockSchema = z.object({ elements: z.array(z.unknown()).optional() }).passthrough();
const SlackActionElementSchema = z.object({ action_id: z.string(), value: z.string() }).passthrough();
const ApprovalButtonValueSchema = z.object({ workBreakdownDigest: z.string().optional() }).passthrough();

const ITEM_A = "11111111-1111-4111-8111-111111111111";
const ITEM_B = "22222222-2222-4222-8222-222222222222";
const ITEM_C = "33333333-3333-4333-8333-333333333333";

function graphFor(taskId: string) {
  return { schemaVersion: 1 as const, taskId, version: 1, items: [
    { id: ITEM_A, title: "A: create formatter", description: "Create the shared formatter function.", repository: "demo", dependsOn: [] },
    { id: ITEM_B, title: "B: consume formatter", description: "Create a service that imports and uses A.", repository: "demo", dependsOn: [ITEM_A] },
    { id: ITEM_C, title: "C: integration assertion", description: "Add an executable integration assertion over A and B.", repository: "demo", dependsOn: [ITEM_B] },
  ] };
}

function fullPlan(taskId: string, latest: string): string {
  const cleanClaims = [{ id: "1", text: "Users can create and use a greeting service." }];
  if (/writing the requirements/i.test(latest)) return planAnswer(planDocument({ title: "Requirements", claims: cleanClaims }));
  if (/writing the design/i.test(latest)) return planAnswer(planDocument({ title: "Design", claims: cleanClaims }));
  return planAnswer(planDocument({ title: "Coding plan", claims: cleanClaims, workBreakdown: graphFor(taskId) }));
}

function currentE2E(context: { current?: WorkflowE2E }): WorkflowE2E {
  if (context.current === undefined) throw new Error("workflow model invoked before its E2E harness was ready");
  return context.current;
}

function workflowModel(context: { current?: WorkflowE2E }) {
  return { plan: (latest: string) => fullPlan(currentE2E(context).taskId(), latest), edits: itemEdits };
}

function reportsImplementedItem(body: string, itemId: string): boolean {
  const parsedBody: unknown = JSON.parse(body);
  const parsed = CallbackEventsSchema.safeParse(parsedBody);
  return parsed.success && parsed.data.events.some((event) => event.payload?.workItemProgress?.state === "IMPLEMENTED"
    && event.payload.workItemProgress.itemId === itemId);
}

function itemEdits(latest: string) {
  const title = latest.match(/Current approved item[^\n]*\nTitle: (.*)/)?.[1];
  if (title === "A: create formatter") return [{ path: "repo/demo/formatter.mjs", content: "export const formatGreeting = (name) => `Hello, ${name}`;\n" }];
  if (title === "B: consume formatter") return [{ path: "repo/demo/service.mjs", content: "import { formatGreeting } from './formatter.mjs';\nexport const greet = (name) => formatGreeting(name);\n" }];
  if (title === "C: integration assertion") return [{ path: "repo/demo/integration.mjs", content: "import assert from 'node:assert/strict';\nimport { formatGreeting } from './formatter.mjs';\nimport { greet } from './service.mjs';\nassert.equal(formatGreeting('Ada'), 'Hello, Ada');\nassert.equal(greet('Lin'), 'Hello, Lin');\n" }];
  return [];
}

function itemPromptTitles(e2e: WorkflowE2E): string[] {
  return itemPromptBodies(e2e).map((prompt) => prompt.match(/Title: (.*)/)?.[1] ?? "");
}

function itemPromptBodies(e2e: WorkflowE2E): string[] {
  return [...new Map(e2e.turns.filter((turn) => turn.role === "CODER" && /Current approved item/.test(turn.userText))
    .map((turn) => [turn.userText.match(/Title: (.*)/)?.[1] ?? "", turn.userText])).values()];
}

async function approveFullPlan(e2e: WorkflowE2E, checkGraph?: (graph: ReturnType<typeof graphFor>) => void): Promise<void> {
  expect(await e2e.mention("Add a shared greeting service")).toBe(200);
  expect(await e2e.mention("full please", { type: "message" })).toBe(200);
  await e2e.settle();
  for (let index = 0; index < 3; index += 1) {
    const card = e2e.slack.lastPostWithAction("agentx_workflow_approve");
    if (index === 2) checkGraph?.(graphFor(e2e.taskId()));
    const viewCount = e2e.slack.views.length;
    await e2e.click("agentx_workflow_approve");
    if (e2e.slack.views.length > viewCount) await e2e.submitView();
    await e2e.settle();
    expect(card).toBeDefined();
  }
}

describe("native runtime journeys for ordered work", () => {
  it("runs a Full Slack graph A to B to C on one checked tree and finishes only after GitHub merge observation", async () => {
    const context: { current?: WorkflowE2E } = {};
    let admissionTurnedOff = false;
    const e2e = await createWorkflowE2E({ workflowDependenciesEnvironment: { AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "true" },
      readiness: [{ cwd: "repo/demo", executable: "node", args: ["integration.mjs"], timeoutSeconds: 30 }], realProjectCommands: true,
      workerCallbackResponse: ({ path, body, statusCode }) => {
        if (!admissionTurnedOff && path.endsWith("/events") && statusCode === 200) {
          if (reportsImplementedItem(body, ITEM_A)) {
            admissionTurnedOff = true;
            currentE2E(context).worker.workflowDependenciesEnvironment({});
          }
        }
        return undefined;
      }, model: workflowModel(context) });
    context.current = e2e;
    await approveFullPlan(e2e, (graph) => {
      const digest = taskGraphDigest(graph);
      const action = e2e.slack.lastPostWithAction("agentx_workflow_approve").blocks
        ?.flatMap((block) => {
          const parsed = SlackActionBlockSchema.safeParse(block);
          return parsed.success ? (parsed.data.elements ?? []).flatMap((element) => {
            const parsedElement = SlackActionElementSchema.safeParse(element);
            return parsedElement.success ? [parsedElement.data] : [];
          }) : [];
        }).find((element) => element.action_id === "agentx_workflow_approve");
      expect(action).toBeDefined();
      const approvalButton = ApprovalButtonValueSchema.parse(JSON.parse(action!.value));
      expect(approvalButton.workBreakdownDigest).toBe(digest);
    });

    const workflow = e2e.workflow() as unknown as { stage: string; state: string; candidate?: { repositories: Array<{ treeSha: string }> }; workflowDependenciesProgress?: Array<Record<string, unknown>>; reviews?: Array<Record<string, unknown>> };
    const approvedGraphDigest = taskGraphDigest(graphFor(e2e.taskId()));
    expect(e2e.brokerEvents.filter((event) => event.action === "workflow-decision").at(-1)).toMatchObject({ workBreakdownDigest: approvedGraphDigest });
    const itemPrompts = itemPromptBodies(e2e);
    expect(itemPrompts).toHaveLength(3);
    expect(itemPromptTitles(e2e)).toEqual([
      "A: create formatter", "B: consume formatter", "C: integration assertion",
    ]);
    expect(itemPrompts[0]).toContain("Repository: demo");
    const planningPrompt = e2e.turns.filter((turn) => turn.role === "PLAN").at(-1)?.userText ?? "";
    expect(planningPrompt).toContain(e2e.taskId());
    expect(planningPrompt).toContain('"repository":"demo"');
    expect(await e2e.repoFile("formatter.mjs")).toContain("formatGreeting");
    expect(await e2e.repoFile("service.mjs")).toContain("formatGreeting");
    expect(await e2e.repoFile("integration.mjs")).toContain("assert.equal(greet('Lin'), 'Hello, Lin')");
    expect(workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(admissionTurnedOff).toBe(true);
    expect(e2e.checkRuns).toHaveLength(1);
    expect(e2e.checkRuns[0]!.tree).toBe(workflow.candidate!.repositories[0]!.treeSha);
    const checkpoints = workflow.workflowDependenciesProgress ?? [];
    expect(checkpoints.filter((entry) => entry.state === "IMPLEMENTED")).toHaveLength(3);
    expect(checkpoints.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(checkpoints.filter((entry) => entry.state === "STARTED").map((entry) => entry.itemId)).toEqual([ITEM_A, ITEM_B, ITEM_C]);
    expect(checkpoints.filter((entry) => entry.state === "IMPLEMENTED").map((entry) => entry.itemId)).toEqual([ITEM_A, ITEM_B, ITEM_C]);
    expect(checkpoints.every((entry) => entry.runId === checkpoints[0]!.runId && entry.graphDigest === approvedGraphDigest)).toBe(true);
    expect(checkpoints[2]!.baseTreeSha).toBe(checkpoints[1]!.candidateTreeSha);
    expect(checkpoints[4]!.baseTreeSha).toBe(checkpoints[3]!.candidateTreeSha);
    expect(e2e.github.pullRequests).toHaveLength(1);
    expect(e2e.github.pullRequests[0]!.tree).toBe(workflow.candidate!.repositories[0]!.treeSha);
    expect(e2e.invocations.filter((invocation) => invocation.kind === "task" && invocation.payload.workflowMode === "REVIEW")).toHaveLength(1);
    expect(e2e.invocations.filter((invocation) => invocation.kind === "publish")).toHaveLength(1);
    expect(e2e.invocations.filter((invocation) => invocation.kind === "task" && invocation.payload.workflowMode === "IMPLEMENT")).toHaveLength(1);
    expect(e2e.slack.lastPostWithAction("agentx_workflow_approve").text).toContain("Coding plan");
    assertJourneyInvariants(e2e);

    e2e.github.merge(e2e.github.pullRequests[0]!.number);
    await e2e.runMergeRecovery();
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
    await e2e.runRecovery();
    await e2e.settle();
    assertJourneyInvariants(e2e);
  }, 180_000);

  it("keeps a stored graph readable and unapproved when runtime admission is off", async () => {
    const context: { current?: WorkflowE2E } = {};
    const e2e = await createWorkflowE2E({ workflowDependenciesEnvironment: { AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "false" }, model: workflowModel(context) });
    context.current = e2e;
    const started = await e2e.mcp("agentx_start_workflow", { project: "payments", instructions: "Add a shared greeting service", workflow_path: "quick" });
    expect(started.isError).not.toBe(true);
    await e2e.settle();
    const page = await e2e.taskPage("", SLACK_MAYA);
    expect(page.status).toBe(200);
    expect(page.body).toContain("Work breakdown");
    const before = e2e.workflow();
    const refused = await e2e.mcp("agentx_decide_workflow", { task_id: e2e.taskId(), request_id: "d805b284-f307-4dc2-9ac4-716c68125914",
      expected_revision: before.revision, decision: "APPROVE", reason: "Owner review", artifact_digest: before.artifacts.at(-1)!.sha256,
      work_breakdown_digest: taskGraphDigest(graphFor(e2e.taskId())) });
    expect(refused.isError).toBe(true);
    expect(e2e.workflow().revision).toBe(before.revision);
    expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(e2e.invocations.filter((invocation) => invocation.kind === "task" && invocation.payload.workflowMode === "IMPLEMENT")).toEqual([]);
    expect(e2e.github.pullRequests).toEqual([]);
    assertJourneyInvariants(e2e);
  }, 120_000);

  it("approves the same task-bound graph through MCP and executes the approved A to B to C sequence", async () => {
    const context: { current?: WorkflowE2E } = {};
    const e2e = await createWorkflowE2E({ workflowDependenciesEnvironment: { AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "true" },
      readiness: [{ cwd: "repo/demo", executable: "node", args: ["integration.mjs"], timeoutSeconds: 30 }], realProjectCommands: true,
      model: workflowModel(context) });
    context.current = e2e;
    const started = await e2e.mcp("agentx_start_workflow", { project: "payments", instructions: "Add a shared greeting service", workflow_path: "full" });
    expect(started.isError).not.toBe(true);
    for (let index = 0; index < 3; index += 1) {
      await e2e.settle();
      const before = e2e.workflow();
      expect(before).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
      const decision = await e2e.mcp("agentx_decide_workflow", {
        task_id: e2e.taskId(), request_id: `a0b10000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        expected_revision: before.revision, decision: "APPROVE", reason: "Owner reviewed the exact plan.",
        artifact_digest: before.artifacts.at(-1)!.sha256,
        ...(index === 2 ? { work_breakdown_digest: taskGraphDigest(graphFor(e2e.taskId())) } : {}),
      });
      expect(decision.isError).not.toBe(true);
    }
    await e2e.settle();
    const workflow = e2e.workflow() as unknown as { stage: string; state: string; candidate?: { repositories: Array<{ treeSha: string }> }; workflowDependenciesProgress?: Array<Record<string, unknown>> };
    const digest = taskGraphDigest(graphFor(e2e.taskId()));
    expect(workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(itemPromptTitles(e2e)).toEqual(["A: create formatter", "B: consume formatter", "C: integration assertion"]);
    expect(await e2e.repoFile("formatter.mjs")).toContain("formatGreeting");
    expect(await e2e.repoFile("service.mjs")).toContain("formatGreeting");
    expect(await e2e.repoFile("integration.mjs")).toContain("assert.equal(greet('Lin'), 'Hello, Lin')");
    expect(e2e.checkRuns).toHaveLength(1);
    expect(e2e.checkRuns[0]!.tree).toBe(workflow.candidate!.repositories[0]!.treeSha);
    expect(workflow.workflowDependenciesProgress?.filter((entry) => entry.state === "IMPLEMENTED").map((entry) => entry.itemId)).toEqual([ITEM_A, ITEM_B, ITEM_C]);
    expect(e2e.github.pullRequests).toHaveLength(1);
    expect(e2e.github.pullRequests[0]!.tree).toBe(workflow.candidate!.repositories[0]!.treeSha);
    expect(e2e.workflow().decisions.at(-1)).toMatchObject({ decision: "APPROVE", workBreakdownDigest: digest });
    assertJourneyInvariants(e2e);
  }, 180_000);

  it("does not start a dependent prompt when the durable A checkpoint acknowledgement is lost", async () => {
    const context: { current?: WorkflowE2E } = {};
    let lostAck = false;
    const e2e = await createWorkflowE2E({ workflowDependenciesEnvironment: { AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "true" },
      workerCallbackResponse: ({ path, body, statusCode }) => {
        if (!lostAck && path.endsWith("/events") && statusCode === 200) {
          if (reportsImplementedItem(body, ITEM_A)) {
            lostAck = true;
            return 503;
          }
        }
        return undefined;
      }, model: workflowModel(context) });
    context.current = e2e;
    await approveFullPlan(e2e);
    const wf = e2e.workflow() as unknown as { stage: string; state: string; workflowDependenciesProgress?: Array<Record<string, unknown>> };
    expect(lostAck).toBe(true);
    expect(itemPromptTitles(e2e)).toEqual(["A: create formatter"]);
    expect(wf.stage).toBe("IMPLEMENT");
    expect(wf.state).toBe("BLOCKED");
    expect(e2e.github.pullRequests).toEqual([]);
    expect(e2e.invocations.some((invocation) => invocation.kind === "publish")).toBe(false);
    expect(wf.workflowDependenciesProgress?.some((entry) => entry.itemId === ITEM_B)).toBe(false);
    assertJourneyInvariants(e2e);
  }, 180_000);

  it("pauses before the first item on worker feature skew and resumes only after the Owner retry", async () => {
    const context: { current?: WorkflowE2E } = {};
    const e2e = await createWorkflowE2E({ workflowDependenciesEnvironment: { AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "true" }, model: workflowModel(context) });
    context.current = e2e;
    await expect(e2e.mention("quick: Add a shared greeting service")).resolves.toBe(200);
    await e2e.settle();
    e2e.worker.features(WORKER_INVOCATION_FEATURES.filter((feature) => feature !== "task.workflowDependencies"));
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    expect(itemPromptTitles(e2e)).toEqual([]);
    expect(e2e.github.pullRequests).toEqual([]);
    e2e.worker.features(WORKER_INVOCATION_FEATURES);
    await e2e.click("agentx_workflow_retry_implementation");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(itemPromptTitles(e2e)).toEqual(["A: create formatter", "B: consume formatter", "C: integration assertion"]);
    expect(e2e.github.pullRequests).toHaveLength(1);
    assertJourneyInvariants(e2e);
  }, 180_000);

  it("pauses accepted work when the real worker cancellation controller fires after A and never prompts B", async () => {
    const context: { current?: WorkflowE2E } = {};
    let cancelled = false;
    const e2e = await createWorkflowE2E({ workflowDependenciesEnvironment: { AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "true" },
      workerCallbackResponse: async ({ path, body, statusCode }) => {
        if (!cancelled && path.endsWith("/events") && statusCode === 200) {
          if (reportsImplementedItem(body, ITEM_A)) {
            const operationId = /\/operations\/([^/]+)\/events$/.exec(path)?.[1];
            expect(operationId).toBeDefined();
            const result = await currentE2E(context).worker.cancelOperation(operationId!);
            expect(result.status).toBe("CANCELLED");
            cancelled = true;
          }
        }
        return undefined;
      }, model: workflowModel(context) });
    context.current = e2e;
    await approveFullPlan(e2e);
    expect(cancelled).toBe(true);
    expect(itemPromptTitles(e2e)).toEqual(["A: create formatter"]);
    const blocked = e2e.workflow() as unknown as { stage: string; state: string; workflowDependenciesProgress?: Array<Record<string, unknown>> };
    expect(blocked.stage).toBe("IMPLEMENT");
    expect(blocked.state).toBe("BLOCKED");
    expect(blocked.workflowDependenciesProgress?.some((entry) => entry.itemId === ITEM_B)).toBe(false);
    expect(e2e.github.pullRequests).toEqual([]);
    const promptCount = e2e.prompts.length;
    await e2e.runRecovery();
    expect(e2e.prompts).toHaveLength(promptCount);
    assertJourneyInvariants(e2e);
  }, 180_000);
});
