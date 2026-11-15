// Slack tasks exist only where task threads can be read (SHARED_TASKS, named environments). The legacy deployment
// wires the broker too (for stop), and before this every top-level mention there took the task path and was refused
// with the task-threads-off notice; its mentions are the chat agent's, as they were before Slack tasks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awsSlackRouterDependencies, type SlackRouterTransport } from "../../packages/broker/src/aws/slack-ingress.js";

const transport: SlackRouterTransport = {
  postMessage: vi.fn(async () => ({})), update: vi.fn(), postEphemeral: vi.fn(), checkMember: vi.fn(),
  enqueue: vi.fn(), route: vi.fn(), enqueueAnswer: vi.fn(),
};
const TASK_HANDLERS = ["startWorkflow", "requestWorkflowChoice", "chooseWorkflowPath", "pendingWorkflowChoice", "routeRequest", "answerWorkflowChoice", "captureFeedbackNote", "recordThreadNote"] as const;

beforeEach(() => {
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("STATE_TABLE_NAME", "state");
  vi.stubEnv("SLACK_THREADS_TABLE_NAME", "threads");
  vi.stubEnv("BROKER_FUNCTION_NAME", "broker");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Slack tasks, by deployment", () => {
  it("are off in the legacy deployment (no SHARED_TASKS): a mention goes to the chat agent; stop still works", () => {
    const dependencies = awsSlackRouterDependencies(transport) as unknown as Record<string, unknown>;
    for (const name of TASK_HANDLERS) expect(dependencies[name], name).toBeUndefined();
    expect(dependencies.sharedTask).toBeUndefined();
    expect(typeof dependencies.stopTask).toBe("function");
    expect(typeof dependencies.chatgpt).toBe("function");
  });

  it("are on where task threads can be read (SHARED_TASKS=enabled)", () => {
    vi.stubEnv("SHARED_TASKS", "enabled");
    const dependencies = awsSlackRouterDependencies(transport) as unknown as Record<string, unknown>;
    for (const name of TASK_HANDLERS) expect(typeof dependencies[name], name).toBe("function");
    expect(dependencies.sharedTask).toBeDefined();
  });

  it("are off without the broker, whatever SHARED_TASKS says", () => {
    vi.stubEnv("SHARED_TASKS", "enabled");
    vi.stubEnv("BROKER_FUNCTION_NAME", "");
    delete process.env.BROKER_FUNCTION_NAME;
    const dependencies = awsSlackRouterDependencies(transport) as unknown as Record<string, unknown>;
    for (const name of TASK_HANDLERS) expect(dependencies[name], name).toBeUndefined();
    expect(dependencies.stopTask).toBeUndefined();
  });
});
