// tests/contract/worker-access.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  NO_WORKSPACE_TO_PUBLISH, ORCHESTRATION_TOOL_NAMES, WORKER_TOOL_NAMES, createOrchestrationTools, type WorkerAccess,
} from "../../packages/orchestrator/src/orchestration-tools.js";
import { createOrchestratorRuntime } from "../../packages/orchestrator/src/orchestrator.js";
import { createFixtureDirectory } from "../fixtures/index.js";

type ToolName = (typeof ORCHESTRATION_TOOL_NAMES)[number];
const OPERATION = "11111111-1111-4111-8111-111111111111";
const context = { workspaceId: "22222222-2222-4222-8222-222222222222", conversationId: "33333333-3333-4333-8333-333333333333" };
const refusal = { status: "WORKSPACE_LIMIT_REACHED" as const, message: "No coding work can run in this thread." };

// One rule per in-house tool. Adding a tool without a rule fails the first test.
const WORKER_RULE = {
  agentx_submit_task: "prepares",
  agentx_follow_up: "prepares",
  agentx_create_pull_request: "needs-prepared",
  agentx_task_status: "never",
  agentx_task_result: "never",
  agentx_manage_pull_request: "never",
} satisfies Record<ToolName, "prepares" | "needs-prepared" | "never">;

const PARAMETERS: Record<ToolName, Record<string, unknown>> = {
  agentx_submit_task: { prompt: "list the files" },
  agentx_follow_up: { prompt: "and the tests" },
  agentx_create_pull_request: { repository: "demo", title: "Fix" },
  agentx_task_status: { operationId: OPERATION },
  agentx_task_result: { operationId: OPERATION },
  agentx_manage_pull_request: { repository: "demo", pullRequestNumber: 7, action: "close" },
};

function fakeApi() {
  return {
    submitTask: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    taskStatus: vi.fn().mockResolvedValue({ id: OPERATION, status: "RUNNING" }),
    taskResult: vi.fn().mockResolvedValue({ operationId: OPERATION, status: "SUCCEEDED" }),
    followUp: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    createPullRequest: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    managePullRequest: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    pullRequestResult: vi.fn().mockResolvedValue({ operationId: OPERATION, status: "SUCCEEDED" }),
    callConnectorTool: vi.fn().mockResolvedValue({ requestId: OPERATION, status: "SUCCEEDED", text: "2 open", replayed: false, truncated: false }),
  };
}

// Plain properties, not methods, so a test can read the ensureReady mock on its own.
function worker(prepared: boolean, answer?: typeof refusal) {
  return { prepared: () => prepared, ensureReady: vi.fn(async (): Promise<typeof refusal | undefined> => answer) } satisfies WorkerAccess;
}

function run(tools: ReturnType<typeof createOrchestrationTools>, name: string, parameters: Record<string, unknown>) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`${name} is missing`);
  return tool.execute("call-1", parameters, undefined, undefined, {} as never);
}

describe("which in-house tools need the worker", () => {
  it("has exactly one worker rule per in-house tool", () => {
    expect(Object.keys(WORKER_RULE).sort()).toEqual([...ORCHESTRATION_TOOL_NAMES].sort());
    expect([...WORKER_TOOL_NAMES].sort()).toEqual(Object.entries(WORKER_RULE).filter(([, rule]) => rule === "prepares").map(([name]) => name).sort());
  });

  it.each(ORCHESTRATION_TOOL_NAMES)("%s follows its worker rule in a thread with no compute", async (name) => {
    const api = fakeApi();
    const access = worker(false);
    const result = await run(createOrchestrationTools(api, context, { worker: access }), name, PARAMETERS[name]);
    expect(access.ensureReady).toHaveBeenCalledTimes(WORKER_RULE[name] === "prepares" ? 1 : 0);
    if (WORKER_RULE[name] === "needs-prepared") {
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(NO_WORKSPACE_TO_PUBLISH) }]);
      expect(api.createPullRequest).not.toHaveBeenCalled();
    }
  });

  it("publishes as today once the thread has compute", async () => {
    const api = fakeApi();
    await run(createOrchestrationTools(api, context, { worker: worker(true) }), "agentx_create_pull_request", PARAMETERS.agentx_create_pull_request);
    expect(api.createPullRequest).toHaveBeenCalledOnce();
  });

  it("exposes prepared() as a plain fact a caller can read directly, without going through a tool (spec 014 D5: 14c's confirmation gate reads it)", () => {
    expect(worker(false).prepared()).toBe(false);
    expect(worker(true).prepared()).toBe(true);
  });

  it("hands a refusal to the model, starts no work and uses no request ID", async () => {
    const api = fakeApi();
    const requestId = vi.fn(() => OPERATION);
    for (const name of WORKER_TOOL_NAMES) {
      const result = await run(createOrchestrationTools(api, context, { worker: worker(false, refusal), requestId }), name, PARAMETERS[name]);
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(refusal) }]);
    }
    expect(api.submitTask).not.toHaveBeenCalled();
    expect(api.followUp).not.toHaveBeenCalled();
    expect(requestId).not.toHaveBeenCalled();
  });

  it("never prepares for a connector tool", async () => {
    const api = fakeApi();
    const access = worker(false);
    const catalog = {
      connector: "github", skipped: [],
      tools: [{ name: "github__list_issues", upstreamName: "list_issues", description: "List issues", access: "read" as const,
        scopes: [{ alias: "demo", schemaHash: "a".repeat(64) }], inputSchema: { type: "object", properties: {} } }],
    };
    await run(createOrchestrationTools(api, context, { worker: access, connectorCatalogs: [catalog] }), "github__list_issues", {});
    expect(api.callConnectorTool).toHaveBeenCalledOnce();
    expect(access.ensureReady).not.toHaveBeenCalled();
  });

  it("hands the worker handle from the orchestrator runtime to the task tools", async () => {
    const api = fakeApi();
    const access = worker(false, refusal);
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-worker-access-"), projectInstructions: "Delegate.", api, context,
      model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" }, worker: access,
    });
    try {
      const result = await runtime.session.getToolDefinition("agentx_submit_task")!.execute("call-1", { prompt: "list" }, undefined, undefined, {} as never);
      expect(access.ensureReady).toHaveBeenCalledOnce();
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(refusal) }]);
      expect(api.submitTask).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });
});
