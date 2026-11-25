// journey-gate: mcp
// G-F (D1-PLAN 5.3): MCP parity. An AI tool is an equal path to the web: each recovery tool must do what the web's action does, on the real core and the real worker. The table runs every row
// once per path, each path in a world of its own and in the same state, and compares what the task and the host look like afterwards. The tool is `agentx mcp`'s real server (packages/cli
// mcp/serve.ts over packages/mcp tools) signed in as Maya, calling the broker's front; the web's action is the request the web app makes (the same front, the web sign-in).
// Tests/integration/workflow-e2e/11-mcp-parity.test.ts (old engine, Slack buttons) is deleted by D1; its recovery table is replaced by this one (the tool names are the same).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createJourneyWorld, MAYA, type JourneyWorld } from "./harness/hosted-core.js";
import { INTENT_BLOCK_INFO_STRING } from "../../packages/contracts/src/index.js";
import { buildUntilPullRequest, clean, FILE_CHECK_PLAN, fenced, IMPLEMENT_SCRIPT, planUntilCard, startTask } from "./harness/task.js";
import { signedInClient } from "../support/mcp-broker-client.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

type Json = Record<string, unknown>;
type McpClient = Awaited<ReturnType<typeof signedInClient>>;
interface Path { name: string; act(w: JourneyWorld, taskId: string, mcp: McpClient): Promise<unknown> }
interface Recovery {
  tool: string;
  /** The same state for every path. */
  reach(w: JourneyWorld): Promise<{ taskId: string; [key: string]: unknown }>;
  /** What the person (and the host) can see afterwards. Compared across paths. */
  outcome(w: JourneyWorld, context: { taskId: string; [key: string]: unknown }): Promise<Json>;
  /** The outcome must have moved: a row whose paths all did nothing proves nothing. */
  moved(outcome: Json): boolean;
  paths: Path[];
}
const task = (w: JourneyWorld, taskId: string) => w.taskRow(taskId) as unknown as { closedAt?: string; workflow: { stage: string; state: string; revision: number; blockReason?: string } };
const sessionIdOf = async (w: JourneyWorld) => String(((await w.maya("GET", "/v1/app/sessions")).body.sessions as Array<{ sessionId: string }>)[0]!.sessionId);

const recoveries: Recovery[] = [
  { tool: "agentx_send_workflow_back (a failed check) and the web's Send back",
    async reach(w) {
      const taskId = await startTask(w);
      await planUntilCard(w, taskId, { plan: FILE_CHECK_PLAN });
      await w.approvePlan(taskId);
      // The first run changes the wrong file: the plan's check (health.txt must exist) fails inside the worker's own checks.
      const first = await w.runStep("IMPLEMENT", [fauxAssistantMessage([fauxToolCall("bash", { command: "printf wrong > repo/demo/other.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage("I added the health endpoint.")]);
      expect({ stage: task(w, taskId).workflow.stage, state: task(w, taskId).workflow.state }).toEqual({ stage: "VERIFY", state: "BLOCKED" });
      return { taskId, firstOperation: first.invocation.operationId };
    },
    async outcome(w, { taskId, firstOperation }) {
      const second = await w.runStep("IMPLEMENT", [fauxAssistantMessage([fauxToolCall("bash", { command: "printf ok > repo/demo/health.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage("I wrote health.txt.")], String(firstOperation));
      const prompt = JSON.stringify((second.invocation as { payload: { prompt?: string } }).payload.prompt);
      return { stage: task(w, taskId).workflow.stage, state: task(w, taskId).workflow.state, secondRun: second.operation.status, promptHasOwnersWords: prompt.includes("Write the endpoint's answer to health.txt."), promptHasFailedCheck: prompt.includes("health.txt exists") };
    },
    moved: (outcome) => outcome.secondRun === "SUCCEEDED" && outcome.promptHasOwnersWords === true && outcome.stage === "REVIEW",
    paths: [
      { name: "web", act: async (w, taskId) => { const sent = await w.maya("POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: task(w, taskId).workflow.revision, instructions: "Write the endpoint's answer to health.txt." }); expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200); } },
      { name: "mcp", act: async (w, taskId, mcp) => { const sent = await mcp.tool("agentx_send_workflow_back", { task_id: taskId, expected_revision: task(w, taskId).workflow.revision, instructions: "Write the endpoint's answer to health.txt." }); expect(sent.isError, JSON.stringify(sent.error)).toBe(false); } },
    ] },

  { tool: "agentx_close_task (a task with an open draft pull request) and the web's Close",
    async reach(w) {
      const taskId = await startTask(w);
      await planUntilCard(w, taskId);
      await w.approvePlan(taskId);
      const pullRequest = await buildUntilPullRequest(w, taskId);
      return { taskId, pullRequest };
    },
    async outcome(w, { taskId, pullRequest }) {
      const read = (await w.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task as { status: string };
      return { closed: task(w, taskId).closedAt !== undefined, status: read.status, stage: task(w, taskId).workflow.stage, state: task(w, taskId).workflow.state, pullRequest: (pullRequest as { draft: { state: string; draft: boolean } }).draft.state };
    },
    moved: (outcome) => outcome.closed === true && outcome.status === "CLOSED",
    paths: [
      { name: "web (the task route)", act: async (w, taskId) => { const closed = await w.maya("POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() }); expect(closed.status, JSON.stringify(closed.body).slice(0, 300)).toBe(200); } },
      { name: "web (the session route)", act: async (w) => { const closed = await w.maya("POST", `/v1/app/sessions/${await sessionIdOf(w)}/close`, { requestId: randomUUID() }); expect(closed.status, JSON.stringify(closed.body).slice(0, 300)).toBe(200); } },
      { name: "mcp", act: async (_w, taskId, mcp) => { const closed = await mcp.tool("agentx_close_task", { task_id: taskId }); expect(closed.isError, JSON.stringify(closed.error)).toBe(false); } },
    ] },

  { tool: "agentx_retry_workflow (a step the owner stopped) and the web's Retry",
    async reach(w) {
      const taskId = await startTask(w);
      await w.prepare(taskId);
      let began!: () => void;
      const modelBegan = new Promise<void>((resolve) => { began = resolve; });
      const running = await w.startStep("UNDERSTAND", [(_context: unknown, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => { began(); options?.signal?.addEventListener("abort", () => { reject(new Error("aborted")); }); })]);
      await modelBegan;
      const pumping = w.pumpDispatcher();
      const stopped = await w.maya("POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() }).finally(pumping);
      expect(stopped.status, JSON.stringify(stopped.body).slice(0, 300)).toBe(200);
      const ended = await w.stepEnd("UNDERSTAND", running);
      expect(ended.operation.status).toBe("CANCELLED");
      expect(task(w, taskId).workflow).toMatchObject({ state: "BLOCKED", blockReason: "You stopped this step. Retry to run it again." });
      return { taskId, stoppedOperation: running.invocation.operationId };
    },
    async outcome(w, { taskId, stoppedOperation }) {
      // The retry dispatches Understand again: it runs on the real worker and reaches the plan.
      const again = await w.runStep("UNDERSTAND", [fauxAssistantMessage(fenced(INTENT_BLOCK_INFO_STRING, { kind: "ready", path: "QUICK", restatement: "Add a health endpoint.", assumptions: [] }))], String(stoppedOperation));
      return { understand: again.operation.status, stage: task(w, taskId).workflow.stage, state: task(w, taskId).workflow.state };
    },
    moved: (outcome) => outcome.understand === "SUCCEEDED",
    paths: [
      { name: "web (the task route)", act: async (w, taskId) => { const retried = await w.maya("POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), expectedRevision: task(w, taskId).workflow.revision, instructions: "Try again." }); expect(retried.status, JSON.stringify(retried.body).slice(0, 300)).toBe(200); } },
      { name: "web (the session route)", act: async (w) => {
        // FINDING (pinned to today, core/sessions/control.ts:234): the session's retry decides from the session's own summary (`workflowBlocked`), which the session sweep job keeps (a deployment runs it
        // every minute). Until it has run, the owner's Retry on the session says "nothing to retry" for a task that IS blocked, while the task route and the tool retry it at once.
        const sessionId = await sessionIdOf(w);
        const early = await w.maya("POST", `/v1/app/sessions/${sessionId}/retry`, { requestId: randomUUID() });
        expect([early.status, JSON.stringify(early.body)]).toEqual([409, JSON.stringify({ error: { code: "CONFIG_INVALID", message: "There is nothing to retry: the task is not blocked." } })]);
        await w.runJobs();
        const retried = await w.maya("POST", `/v1/app/sessions/${sessionId}/retry`, { requestId: randomUUID() });
        expect(retried.status, JSON.stringify(retried.body).slice(0, 300)).toBe(200);
      } },
      { name: "mcp", act: async (w, taskId, mcp) => { const retried = await mcp.tool("agentx_retry_workflow", { task_id: taskId, expected_revision: task(w, taskId).workflow.revision, instructions: "Try again." }); expect(retried.isError, JSON.stringify(retried.error)).toBe(false); } },
    ] },

  { tool: "agentx_retry_workflow (the plan's check failed) and the web's Retry with the owner's note",
    // Opus review (A1-11 F6): re-proven after the fake DynamoDB fix; without that one line both paths answered a generic 400 although the checks run started.
    async reach(w) {
      const taskId = await startTask(w);
      await planUntilCard(w, taskId, { plan: FILE_CHECK_PLAN });
      await w.approvePlan(taskId);
      await w.runStep("IMPLEMENT", [fauxAssistantMessage([fauxToolCall("bash", { command: "printf wrong > repo/demo/other.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage("I added the health endpoint.")]);
      expect({ stage: task(w, taskId).workflow.stage, state: task(w, taskId).workflow.state }).toEqual({ stage: "VERIFY", state: "BLOCKED" });
      return { taskId, blockedAt: task(w, taskId).workflow.revision };
    },
    async outcome(w, { taskId, blockedAt }) {
      const read = (await w.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task as { status: string };
      return { stage: task(w, taskId).workflow.stage, state: task(w, taskId).workflow.state, status: read.status, revisionMoved: task(w, taskId).workflow.revision > Number(blockedAt) };
    },
    moved: (outcome) => outcome.state === "RUNNING" && outcome.revisionMoved === true,
    paths: [
      { name: "web (the task route)", act: async (w, taskId) => { const retried = await w.maya("POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), expectedRevision: task(w, taskId).workflow.revision, instructions: "Run the checks again." }); expect(retried.status, JSON.stringify(retried.body).slice(0, 300)).toBe(200); } },
      { name: "mcp", act: async (w, taskId, mcp) => { const retried = await mcp.tool("agentx_retry_workflow", { task_id: taskId, expected_revision: task(w, taskId).workflow.revision, instructions: "Run the checks again." }); expect(retried.isError, JSON.stringify(retried.error)).toBe(false); } },
    ] },

  { tool: "agentx_retry_workflow_publish (the draft pull request did not open) and the web's Retry opening the pull request",
    async reach(w) {
      const taskId = await startTask(w);
      await planUntilCard(w, taskId);
      await w.approvePlan(taskId);
      expect((await w.runStep("IMPLEMENT", IMPLEMENT_SCRIPT)).operation.status).toBe("SUCCEEDED");
      expect((await w.runStep("REVIEW", clean())).operation.status).toBe("SUCCEEDED");
      // The code host refuses the push: the publishing worker reports the step failed (the one result the worker cannot make on a Mac, posted with the invocation's own capability).
      const { invocation } = await w.dispatchOnly("publish");
      const failed = await w.postWorkerCallback(String(w.taskRow(taskId)!.workspaceId), invocation.operationId, "result", (invocation as { callbackCapability: string }).callbackCapability,
        { operationId: invocation.operationId, status: "FAILED", error: "the code host refused the push" });
      expect(failed.status, JSON.stringify(failed.body)).toBe(200);
      expect(task(w, taskId).workflow, "the person is told the pull request did not open").toMatchObject({ stage: "PULL_REQUEST", state: "BLOCKED" });
      return { taskId };
    },
    async outcome(w, { taskId }) {
      // The retry dispatches the publication again: it opens one draft pull request and the task waits for the merge.
      const opened = await w.publish();
      return { stage: task(w, taskId).workflow.stage, state: task(w, taskId).workflow.state, draft: opened.draft.draft, pullRequests: w.harness.world.host.model.changeRequests.length };
    },
    moved: (outcome) => outcome.stage === "WAIT_FOR_MERGE" && outcome.pullRequests === 1,
    paths: [
      { name: "web (the task route)", act: async (w, taskId) => { const retried = await w.maya("POST", `/v1/dev/tasks/${taskId}/workflow/publish-retry`, { requestId: randomUUID(), expectedRevision: task(w, taskId).workflow.revision }); expect(retried.status, JSON.stringify(retried.body).slice(0, 300)).toBe(200); } },
      { name: "mcp", act: async (w, taskId, mcp) => { const retried = await mcp.tool("agentx_retry_workflow_publish", { task_id: taskId, expected_revision: task(w, taskId).workflow.revision }); expect(retried.isError, JSON.stringify(retried.error)).toBe(false); } },
    ] },
];

describe("MCP parity (G-F): each recovery tool does what its web action does", () => {
  for (const recovery of recoveries) {
    it(recovery.tool, async () => {
      const outcomes: Array<{ path: string; outcome: Json }> = [];
      for (const path of recovery.paths) {
        world = await createJourneyWorld();
        const context = await recovery.reach(world);
        const mcp = await signedInClient({ handler: world.handler } as never, MAYA);
        await path.act(world, context.taskId, mcp);
        outcomes.push({ path: path.name, outcome: await recovery.outcome(world, context) });
        world.proof.assertAllCore();
        await world.close();
        world = undefined;
      }
      for (const { path, outcome } of outcomes) expect(recovery.moved(outcome), `${path} moved the task: ${JSON.stringify(outcome)}`).toBe(true);
      for (const { path, outcome } of outcomes.slice(1)) expect(outcome, `${path} against ${outcomes[0]!.path}`).toEqual(outcomes[0]!.outcome);
    }, 600_000);
  }
});
