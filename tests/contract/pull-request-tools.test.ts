import { describe, expect, it, vi } from "vitest";
import { createOrchestrationTools } from "../../packages/orchestrator/src/orchestration-tools.js";
import { CONVERSATION_ID, LIFECYCLE_CASES, OPERATION_ID, REQUEST_ID, WORKSPACE_ID, managePullRequestApi } from "../support/pull-request-cases.js";

describe("pull-request lifecycle tools (characterization)", () => {
  it.each(LIFECYCLE_CASES)("$tool sends action $action with exactly its parameters", async ({ tool, action, params }) => {
    const api = managePullRequestApi();
    const tools = createOrchestrationTools(api, { workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID }, { requestId: () => REQUEST_ID });
    const onUpdate = vi.fn();
    const result = await tools.find((entry) => entry.name === tool)!.execute("call-1", params, undefined, onUpdate, {} as never);
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
});
