import { describe, expect, it, vi } from "vitest";
import { createOrchestrationTools } from "../../packages/orchestrator/src/orchestration-tools.js";
import { CONVERSATION_ID, LIFECYCLE_CASES, OPERATION_ID, REQUEST_ID, WORKSPACE_ID, managePullRequestApi } from "../support/pull-request-cases.js";

describe("agentx_manage_pull_request replaces the seven lifecycle tools call for call", () => {
  it.each(LIFECYCLE_CASES)("action $action sends exactly what $tool sent", async ({ action, params }) => {
    const api = managePullRequestApi();
    const tools = createOrchestrationTools(api, { workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID }, { requestId: () => REQUEST_ID });
    const onUpdate = vi.fn();
    const result = await tools.find((entry) => entry.name === "agentx_manage_pull_request")!.execute("call-1", { action, ...params }, undefined, onUpdate, {} as never);
    expect(api.managePullRequest).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, action, ...params });
    expect(api.pullRequestResult).toHaveBeenCalledOnce();
    expect(api.pullRequestResult.mock.calls[0]?.[0]).toEqual({ workspaceId: WORKSPACE_ID, operationId: OPERATION_ID });
    expect(typeof (api.pullRequestResult.mock.calls[0]?.[1] as { onProgress?: unknown } | undefined)?.onProgress).toBe("function");
    const accepted = JSON.parse((onUpdate.mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]!.text) as unknown;
    expect(accepted).toEqual({ operationId: OPERATION_ID, status: "ACCEPTED", message: `AgentX accepted pull request ${action}.` });
    expect(JSON.parse((result.content[0] as { text: string }).text) as unknown).toEqual({ status: "SUCCEEDED", url: "https://github.com/example/web/pull/12" });
    expect(api.submitTask).not.toHaveBeenCalled();
    expect(api.createPullRequest).not.toHaveBeenCalled();
  });

  it.each(["append", "sync", "close", "reopen"] as const)("drops a title and body sent with %s, as the retired tool could not send them", async (action) => {
    const api = managePullRequestApi();
    const tools = createOrchestrationTools(api, { workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID }, { requestId: () => REQUEST_ID });
    await tools.find((entry) => entry.name === "agentx_manage_pull_request")!
      .execute("call-1", { action, repository: "web", pullRequestNumber: 12, title: "Ignored", body: "Ignored" }, undefined, undefined, {} as never);
    expect(api.managePullRequest).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, action, repository: "web", pullRequestNumber: 12 });
  });

  it("no longer offers the retired tool names", () => {
    const tools = createOrchestrationTools(managePullRequestApi(), { workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID });
    for (const { tool } of LIFECYCLE_CASES) expect(tools.map((entry) => entry.name)).not.toContain(tool);
  });

  const PROGRESS = { operationId: OPERATION_ID, status: "RUNNING", message: "Running checks." };

  it.each(LIFECYCLE_CASES.filter(({ action }) => action === "append" || action === "edit"))("action $action forwards progress from the result stream to onUpdate, as $tool did", async ({ action, params }) => {
    const api = managePullRequestApi();
    api.pullRequestResult.mockImplementationOnce((async (_input: unknown, options?: { onProgress?: (progress: typeof PROGRESS) => void }) => {
      options?.onProgress?.(PROGRESS);
      return { status: "SUCCEEDED", url: "https://github.com/example/web/pull/12" };
    }) as never);
    const tools = createOrchestrationTools(api, { workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID }, { requestId: () => REQUEST_ID });
    const onUpdate = vi.fn();
    await tools.find((entry) => entry.name === "agentx_manage_pull_request")!.execute("call-1", { action, ...params }, undefined, onUpdate, {} as never);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(JSON.parse((onUpdate.mock.calls[1]?.[0] as { content: Array<{ text: string }> }).content[0]!.text) as unknown).toEqual(PROGRESS);
  });

  it.each(LIFECYCLE_CASES)("action $action forwards the abort signal to the result stream, as $tool did", async ({ action, params }) => {
    const api = managePullRequestApi();
    const tools = createOrchestrationTools(api, { workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID }, { requestId: () => REQUEST_ID });
    const signal = new AbortController().signal;
    await tools.find((entry) => entry.name === "agentx_manage_pull_request")!.execute("call-1", { action, ...params }, signal, undefined, {} as never);
    expect((api.pullRequestResult.mock.calls[0]?.[1] as { signal?: unknown } | undefined)?.signal).toBe(signal);
  });

  it.each(LIFECYCLE_CASES.filter(({ action }) => action === "edit" || action === "replace" || action === "revert"))("action $action sends a body without a title, as $tool did", async ({ action }) => {
    const api = managePullRequestApi();
    const tools = createOrchestrationTools(api, { workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID }, { requestId: () => REQUEST_ID });
    await tools.find((entry) => entry.name === "agentx_manage_pull_request")!.execute("call-1", { action, repository: "web", pullRequestNumber: 12, body: "Only body" }, undefined, undefined, {} as never);
    expect(api.managePullRequest).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, action, repository: "web", pullRequestNumber: 12, body: "Only body" });
  });
});
