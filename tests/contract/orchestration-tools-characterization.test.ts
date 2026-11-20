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

describe("in-house tools before lazy preparation (characterization)", () => {

  it("describes the pull request as a draft when a check fails, and hands its result on unchanged, draft included (spec 051 Ruling Z)", async () => {
    const api = fakeApi();
    const tool = toolNamed(api, "agentx_create_pull_request");
    expect(tool.description).toContain("AgentX opens it as a draft when a check fails");
    expect(tool.description).not.toContain("ready-for-review");
    const published = { operationId: OPERATION, status: "SUCCEEDED", result: { number: 7, draft: true } };
    api.pullRequestResult.mockResolvedValue(published);
    expect((await run(tool, { repository: "demo", title: "Fix" })).content).toEqual([{ type: "text", text: JSON.stringify(published) }]);
  });

  it("drops only the recovery tools when nothing is recoverable", () => {
    const api = fakeApi();
    const names = (recovery?: boolean) => createOrchestrationTools(api, context, recovery === undefined ? {} : { recovery }).map((tool) => tool.name);
    expect(names()).toEqual([...ORCHESTRATION_TOOL_NAMES]);
    expect(names(true)).toEqual([...ORCHESTRATION_TOOL_NAMES]);
    expect(names(false)).toEqual(ORCHESTRATION_TOOL_NAMES.filter((name) => !(RECOVERY_TOOL_NAMES as readonly string[]).includes(name)));
  });
});
