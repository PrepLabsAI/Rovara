// Pins each agentx_* tool to the API calls it makes today, one tool to one mapping, before phase
// 14b gives some of them a worker handle.
import { describe, expect, it, vi } from "vitest";
import {
  ORCHESTRATION_TOOL_NAMES, RECOVERY_TOOL_NAMES, createOrchestrationTools,
} from "../../packages/orchestrator/src/orchestration-tools.js";

const OPERATION = "11111111-1111-4111-8111-111111111111";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const context = { workspaceId: "22222222-2222-4222-8222-222222222222", conversationId: "33333333-3333-4333-8333-333333333333" };

function fakeApi() {
  return {
    submitTask: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    taskStatus: vi.fn().mockResolvedValue({ id: OPERATION, status: "RUNNING" }),
    taskResult: vi.fn().mockResolvedValue({ operationId: OPERATION, status: "SUCCEEDED", response: "done" }),
    followUp: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    createPullRequest: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    managePullRequest: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    pullRequestResult: vi.fn().mockResolvedValue({ operationId: OPERATION, status: "SUCCEEDED" }),
  };
}

function toolNamed(api: ReturnType<typeof fakeApi>, name: string) {
  const found = createOrchestrationTools(api, context, { requestId: () => REQUEST }).find((entry) => entry.name === name);
  if (!found) throw new Error(`${name} is missing`);
  return found;
}

function run(tool: ReturnType<typeof toolNamed>, parameters: Record<string, unknown>) {
  return tool.execute("call-1", parameters, undefined, undefined, {} as never);
}

function onlyCalled(api: ReturnType<typeof fakeApi>, ...names: Array<keyof ReturnType<typeof fakeApi>>) {
  for (const [name, mock] of Object.entries(api)) {
    if (names.includes(name as keyof ReturnType<typeof fakeApi>)) expect(mock, name).toHaveBeenCalledOnce();
    else expect(mock, name).not.toHaveBeenCalled();
  }
}

describe("in-house tools before lazy preparation (characterization)", () => {
  it("submits a task with the next request ID on the thread's conversation and waits for it", async () => {
    const api = fakeApi();
    const result = await run(toolNamed(api, "agentx_submit_task"), { prompt: "list the files" });
    onlyCalled(api, "submitTask", "taskResult");
    expect(api.submitTask).toHaveBeenCalledWith({ ...context, requestId: REQUEST, prompt: "list the files" });
    expect(api.taskResult.mock.calls[0]?.[0]).toEqual({ workspaceId: context.workspaceId, operationId: OPERATION });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ operationId: OPERATION, status: "SUCCEEDED", response: "done" }) }]);
  });

  it("runs a follow-up as one remote task on the thread's conversation and waits for it", async () => {
    const api = fakeApi();
    await run(toolNamed(api, "agentx_follow_up"), { prompt: "and the tests" });
    onlyCalled(api, "followUp", "taskResult");
    expect(api.followUp).toHaveBeenCalledWith({ ...context, requestId: REQUEST, prompt: "and the tests" });
  });

  it("reads a recoverable operation's status without starting work", async () => {
    const api = fakeApi();
    const result = await run(toolNamed(api, "agentx_task_status"), { operationId: OPERATION });
    onlyCalled(api, "taskStatus");
    expect(api.taskStatus).toHaveBeenCalledWith({ workspaceId: context.workspaceId, operationId: OPERATION });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ id: OPERATION, status: "RUNNING" }) }]);
  });

  it("waits for a recoverable operation's result without starting work", async () => {
    const api = fakeApi();
    await run(toolNamed(api, "agentx_task_result"), { operationId: OPERATION });
    onlyCalled(api, "taskResult");
    expect(api.taskResult.mock.calls[0]?.[0]).toEqual({ workspaceId: context.workspaceId, operationId: OPERATION });
  });

  it("publishes a pull request with the next request ID and waits for the publication", async () => {
    const api = fakeApi();
    await run(toolNamed(api, "agentx_create_pull_request"), { repository: "demo", title: "Fix", body: "Why" });
    onlyCalled(api, "createPullRequest", "pullRequestResult");
    expect(api.createPullRequest).toHaveBeenCalledWith({ workspaceId: context.workspaceId, requestId: REQUEST, repository: "demo", title: "Fix", body: "Why" });
  });

  it("describes the pull request as a draft when a check fails, and hands its result on unchanged, draft included (spec 051 Ruling Z)", async () => {
    const api = fakeApi();
    const tool = toolNamed(api, "agentx_create_pull_request");
    expect(tool.description).toContain("AgentX opens it as a draft when a check fails");
    expect(tool.description).not.toContain("ready-for-review");
    const published = { operationId: OPERATION, status: "SUCCEEDED", result: { number: 7, draft: true } };
    api.pullRequestResult.mockResolvedValue(published);
    expect((await run(tool, { repository: "demo", title: "Fix" })).content).toEqual([{ type: "text", text: JSON.stringify(published) }]);
  });

  it("sends a title and body only with the pull request actions that carry them", async () => {
    for (const action of ["edit", "replace", "revert"]) {
      const api = fakeApi();
      await run(toolNamed(api, "agentx_manage_pull_request"), { repository: "demo", pullRequestNumber: 7, action, title: "T", body: "B" });
      onlyCalled(api, "managePullRequest", "pullRequestResult");
      expect(api.managePullRequest).toHaveBeenCalledWith({ workspaceId: context.workspaceId, requestId: REQUEST, repository: "demo", pullRequestNumber: 7, action, title: "T", body: "B" });
    }
    for (const action of ["append", "sync", "close", "reopen"]) {
      const api = fakeApi();
      await run(toolNamed(api, "agentx_manage_pull_request"), { repository: "demo", pullRequestNumber: 7, action, title: "T", body: "B" });
      expect(api.managePullRequest).toHaveBeenCalledWith({ workspaceId: context.workspaceId, requestId: REQUEST, repository: "demo", pullRequestNumber: 7, action });
    }
  });

  it("drops only the recovery tools when nothing is recoverable", () => {
    const api = fakeApi();
    const names = (recovery?: boolean) => createOrchestrationTools(api, context, recovery === undefined ? {} : { recovery }).map((tool) => tool.name);
    expect(names()).toEqual([...ORCHESTRATION_TOOL_NAMES]);
    expect(names(true)).toEqual([...ORCHESTRATION_TOOL_NAMES]);
    expect(names(false)).toEqual(ORCHESTRATION_TOOL_NAMES.filter((name) => !(RECOVERY_TOOL_NAMES as readonly string[]).includes(name)));
  });
});
