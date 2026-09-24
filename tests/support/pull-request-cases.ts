import { vi } from "vitest";

export const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
export const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
export const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

/** What each retired lifecycle tool sent, so the replacement can be held to exactly the same calls. */
export const LIFECYCLE_CASES = [
  { tool: "agentx_update_pull_request", action: "edit", params: { repository: "web", pullRequestNumber: 12, title: "New title", body: "New body" } },
  { tool: "agentx_append_pull_request", action: "append", params: { repository: "web", pullRequestNumber: 12 } },
  { tool: "agentx_sync_pull_request", action: "sync", params: { repository: "web", pullRequestNumber: 12 } },
  { tool: "agentx_close_pull_request", action: "close", params: { repository: "web", pullRequestNumber: 12 } },
  { tool: "agentx_reopen_pull_request", action: "reopen", params: { repository: "web", pullRequestNumber: 12 } },
  { tool: "agentx_replace_pull_request", action: "replace", params: { repository: "web", pullRequestNumber: 12, title: "Clean history", body: "Replaces #12" } },
  { tool: "agentx_revert_pull_request", action: "revert", params: { repository: "web", pullRequestNumber: 12, title: "Revert #12" } },
] as const;

export function managePullRequestApi() {
  return {
    submitTask: vi.fn(),
    taskStatus: vi.fn(),
    taskResult: vi.fn(),
    followUp: vi.fn(),
    createPullRequest: vi.fn(),
    managePullRequest: vi.fn(async () => ({ operation: { id: OPERATION_ID } })),
    pullRequestResult: vi.fn(async () => ({ status: "SUCCEEDED", url: "https://github.com/example/web/pull/12" })),
  };
}
