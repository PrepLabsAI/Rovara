import { describe, expect, it } from "vitest";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { taskGraphDigest } from "@agentx/contracts";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { createWorkflowE2E, type WorkflowE2E } from "../support/workflow-e2e.js";
import { assertJourneyInvariants, registerJourneyInvariants } from "../support/workflow-e2e-invariants.js";

registerJourneyInvariants();

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const CallbackEventsSchema = z.object({ events: z.array(z.object({
  payload: z.object({ workItemProgress: z.object({ state: z.string(), itemId: z.string() }).optional() }).passthrough().optional(),
}).passthrough()) }).passthrough();

function hasImplementedEvent(body: string): boolean {
  const parsedBody: unknown = JSON.parse(body);
  const parsed = CallbackEventsSchema.safeParse(parsedBody);
  return parsed.success && parsed.data.events.some((event) => event.payload?.workItemProgress?.state === "IMPLEMENTED"
    && event.payload.workItemProgress.itemId === ITEM_ID);
}

function itemPromptCount(e2e: WorkflowE2E): number {
  return new Set(e2e.turns.filter((turn) => turn.role === "CODER" && /Current approved item/.test(turn.userText))
    .map((turn) => turn.userText)).size;
}

function currentE2E(context: { current?: WorkflowE2E }): WorkflowE2E {
  if (context.current === undefined) throw new Error("workflow callback ran before its E2E harness was ready");
  return context.current;
}

function hasUnverifiedArtifact(e2e: WorkflowE2E, reason: "no_checks" | "error"): boolean {
  return [...e2e.s3.objects.values()].some((content) => {
    try {
      const value: unknown = JSON.parse(content);
      return typeof value === "object" && value !== null && "status" in value && value.status === "not_verified"
        && "notVerifiedReason" in value && value.notVerifiedReason === reason;
    } catch {
      return false;
    }
  });
}

describe("completed ordered-work checkpoint recovery", () => {
  it("rechecks the unchanged retained candidate after cancellation at the final item acknowledgement without replaying coding", async () => {
    const context: { current?: WorkflowE2E } = {};
    let cancelledAtFinalAcknowledgement = false;
    const graph = (taskId: string) => ({ schemaVersion: 1 as const, taskId, version: 1, items: [
      { id: ITEM_ID, title: "A: formatter", description: "Add the shared formatter.", repository: "demo", dependsOn: [] },
    ] });
    const e2e = await createWorkflowE2E({
      workflowDependenciesEnvironment: { AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "true" },
      readiness: [{ cwd: "repo/demo", executable: "node", args: ["--version"], timeoutSeconds: 30 }],
      realProjectCommands: true,
      model: {
        plan: () => planAnswer(planDocument({ title: "Coding plan", claims: [{ id: "1", text: "Add a formatter." }], workBreakdown: graph(currentE2E(context).taskId()) })),
        edits: () => [{ path: "repo/demo/formatter.mjs", content: "export const formatGreeting = (name) => `Hello, ${name}`;\n" }],
      },
      workerCallbackResponse: async ({ path, body, statusCode }) => {
        if (!cancelledAtFinalAcknowledgement && path.endsWith("/events") && statusCode === 200 && hasImplementedEvent(body)) {
          const operationId = /\/operations\/([^/]+)\/events$/.exec(path)?.[1];
          expect(operationId).toBeDefined();
          expect((await currentE2E(context).worker.cancelOperation(operationId!)).status).toBe("CANCELLED");
          cancelledAtFinalAcknowledgement = true;
        }
        return undefined;
      },
    });
    context.current = e2e;

    expect(await e2e.mention("quick: Add a formatter")).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();

    expect(cancelledAtFinalAcknowledgement).toBe(true);
    expect(e2e.workflow()).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    const retainedProgress = e2e.workflow().workflowDependenciesProgress ?? [];
    expect(retainedProgress.map((entry) => entry.state)).toEqual(["STARTED", "IMPLEMENTED"]);
    const retainedTreeSha = retainedProgress.at(-1)?.candidateTreeSha;
    expect(retainedTreeSha).toMatch(/^[a-f0-9]{40}$/);
    expect(e2e.checkRuns).toHaveLength(1);
    expect(e2e.checkRuns[0]!.tree).toBe(retainedTreeSha);
    expect(itemPromptCount(e2e)).toBe(1);

    await e2e.click("agentx_workflow_retry_implementation");
    await e2e.settle();

    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(itemPromptCount(e2e)).toBe(1);
    expect(e2e.workflow().workflowDependenciesProgress).toEqual([retainedProgress.at(-1)]);
    expect(e2e.checkRuns).toHaveLength(2);
    expect(e2e.checkRuns[1]!.tree).toBe(retainedTreeSha);
    expect(taskGraphDigest(graph(e2e.taskId()))).toBe(e2e.workflow().workflowDependenciesApproval?.graphDigest);
    expect(e2e.workflow().verification).toMatchObject({
      candidateDigest: e2e.workflow().candidate?.digest,
      results: [{ status: "PASS" }],
    });
    expect(e2e.github.pullRequests).toHaveLength(1);
    expect(e2e.github.pullRequests[0]!.tree).toBe(retainedTreeSha);
    assertJourneyInvariants(e2e);
  }, 120_000);

  it("keeps a completed retained prefix unverified when no selected project checks exist", async () => {
    const context: { current?: WorkflowE2E } = {};
    let cancelledAtFinalAcknowledgement = false;
    const graph = (taskId: string) => ({ schemaVersion: 1 as const, taskId, version: 1, items: [
      { id: ITEM_ID, title: "A: formatter", description: "Add the shared formatter.", repository: "demo", dependsOn: [] },
    ] });
    const e2e = await createWorkflowE2E({
      workflowDependenciesEnvironment: { AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "true" },
      readiness: [],
      realProjectCommands: true,
      model: {
        plan: () => planAnswer(planDocument({ title: "Coding plan", claims: [{ id: "1", text: "Add a formatter." }], workBreakdown: graph(currentE2E(context).taskId()) })),
        edits: () => [{ path: "repo/demo/formatter.mjs", content: "export const formatGreeting = (name) => `Hello, ${name}`;\n" }],
      },
      workerCallbackResponse: async ({ path, body, statusCode }) => {
        if (!cancelledAtFinalAcknowledgement && path.endsWith("/events") && statusCode === 200 && hasImplementedEvent(body)) {
          const operationId = /\/operations\/([^/]+)\/events$/.exec(path)?.[1];
          expect(operationId).toBeDefined();
          expect((await currentE2E(context).worker.cancelOperation(operationId!)).status).toBe("CANCELLED");
          cancelledAtFinalAcknowledgement = true;
        }
        return undefined;
      },
    });
    context.current = e2e;

    expect(await e2e.mention("quick: Add a formatter")).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(cancelledAtFinalAcknowledgement).toBe(true);
    const retainedProgress = e2e.workflow().workflowDependenciesProgress ?? [];
    const retainedTreeSha = retainedProgress.at(-1)?.candidateTreeSha;
    expect(retainedProgress.map((entry) => entry.state)).toEqual(["STARTED", "IMPLEMENTED"]);
    expect(retainedTreeSha).toMatch(/^[a-f0-9]{40}$/);
    expect(itemPromptCount(e2e)).toBe(1);

    await e2e.click("agentx_workflow_retry_implementation");
    await e2e.settle();

    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(hasUnverifiedArtifact(e2e, "no_checks")).toBe(true);
    expect(e2e.workflow().verification).toMatchObject({
      candidateDigest: e2e.workflow().candidate?.digest,
      reviewOnly: true,
      results: [],
    });
    expect(e2e.checkRuns).toHaveLength(0);
    expect(itemPromptCount(e2e)).toBe(1);
    expect(e2e.github.pullRequests).toHaveLength(1);
    expect(e2e.github.pullRequests[0]!.tree).toBe(retainedProgress.at(-1)?.candidateTreeSha);
    expect(e2e.workflow().reviews).toHaveLength(2);
    expect(e2e.workflow().reviews?.every((review) => review.status === "PASS"
      && review.candidateDigest === e2e.workflow().candidate?.digest && review.readOnly)).toBe(true);
    assertJourneyInvariants(e2e);
  }, 120_000);

  it("refuses to bind a selected check when that check changes the retained candidate", async () => {
    const context: { current?: WorkflowE2E } = {};
    let cancelledAtFinalAcknowledgement = false;
    const markerPath = `../.workflow-recovery-check-${randomUUID()}.marker`;
    const mutationCommand = `const fs=require('node:fs'); if(fs.existsSync('${markerPath}')) fs.appendFileSync('formatter.mjs','\\n// retry mutation\\n'); else fs.writeFileSync('${markerPath}','first run')`;
    const graph = (taskId: string) => ({ schemaVersion: 1 as const, taskId, version: 1, items: [
      { id: ITEM_ID, title: "A: formatter", description: "Add the shared formatter.", repository: "demo", dependsOn: [] },
    ] });
    const e2e = await createWorkflowE2E({
      workflowDependenciesEnvironment: { AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "true" },
      readiness: [{ cwd: "repo/demo", executable: "node", args: ["-e", mutationCommand], timeoutSeconds: 30 }],
      realProjectCommands: true,
      model: {
        plan: () => planAnswer(planDocument({ title: "Coding plan", claims: [{ id: "1", text: "Add a formatter." }], workBreakdown: graph(currentE2E(context).taskId()) })),
        edits: () => [{ path: "repo/demo/formatter.mjs", content: "export const formatGreeting = (name) => `Hello, ${name}`;\n" }],
      },
      workerCallbackResponse: async ({ path, body, statusCode }) => {
        if (!cancelledAtFinalAcknowledgement && path.endsWith("/events") && statusCode === 200 && hasImplementedEvent(body)) {
          const operationId = /\/operations\/([^/]+)\/events$/.exec(path)?.[1];
          expect(operationId).toBeDefined();
          expect((await currentE2E(context).worker.cancelOperation(operationId!)).status).toBe("CANCELLED");
          cancelledAtFinalAcknowledgement = true;
        }
        return undefined;
      },
    });
    context.current = e2e;

    expect(await e2e.mention("quick: Add a formatter")).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(cancelledAtFinalAcknowledgement).toBe(true);
    const retainedProgress = e2e.workflow().workflowDependenciesProgress ?? [];
    const retainedTreeSha = retainedProgress.at(-1)?.candidateTreeSha;
    expect(retainedTreeSha).toMatch(/^[a-f0-9]{40}$/);

    await e2e.click("agentx_workflow_retry_implementation");
    await e2e.settle();

    expect(await e2e.repoFile("formatter.mjs")).toContain("// retry mutation");
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(hasUnverifiedArtifact(e2e, "error")).toBe(true);
    expect(e2e.checkRuns).toHaveLength(2);
    expect(e2e.checkRuns[0]!.tree).toBe(retainedTreeSha);
    expect(e2e.checkRuns[1]!.tree).toBe(retainedTreeSha);
    expect(itemPromptCount(e2e)).toBe(1);
    expect(e2e.github.pullRequests).toHaveLength(0);
    expect(e2e.workflow().verification).toBeUndefined();
    await rm(join(e2e.repoDirectory, markerPath), { force: true });
    assertJourneyInvariants(e2e);
  }, 120_000);
});
