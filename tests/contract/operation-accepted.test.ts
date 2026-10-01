// Issue 157: the host hears about each worker operation the moment it is accepted, before the
// tool waits on it, so a turn stopped mid-wait can be re-attached to that operation later.
import { describe, expect, it, vi } from "vitest";
import { createOrchestrationTools } from "../../packages/orchestrator/src/orchestration-tools.js";
import { createHostedSlackRuntime, runHostedTurn, stopModelOnAbort } from "../../packages/slack-service/src/runtime.js";
import { createFixtureDirectory } from "../fixtures/index.js";

const OPERATION = "11111111-1111-4111-8111-111111111111";
const context = { workspaceId: "22222222-2222-4222-8222-222222222222", conversationId: "33333333-3333-4333-8333-333333333333" };

function fakeApi(order: string[]) {
  return {
    submitTask: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    taskStatus: vi.fn().mockResolvedValue({ id: OPERATION, status: "RUNNING" }),
    taskResult: vi.fn(async () => {
      order.push("wait");
      return { operationId: OPERATION, status: "SUCCEEDED", response: "done" };
    }),
    followUp: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    createPullRequest: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    managePullRequest: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    pullRequestResult: vi.fn().mockResolvedValue({ operationId: OPERATION, status: "SUCCEEDED" }),
  };
}

function tools(order: string[], onOperationAccepted: (operationId: string) => Promise<void>) {
  const api = fakeApi(order);
  const all = createOrchestrationTools(api, context, { requestId: () => "44444444-4444-4444-8444-444444444444", recovery: true, onOperationAccepted });
  const named = (name: string) => {
    const found = all.find((tool) => tool.name === name);
    if (!found) throw new Error(`${name} is missing`);
    return (parameters: Record<string, unknown>) => found.execute("call-1", parameters, undefined, undefined, {} as never);
  };
  return { api, named };
}

describe("onOperationAccepted", () => {
  for (const name of ["agentx_submit_task", "agentx_follow_up"] as const) {
    it(`${name} reports its accepted operation once, and before it waits on it`, async () => {
      const order: string[] = [];
      const accepted = vi.fn(async (operationId: string) => {
        order.push(`accepted ${operationId}`);
      });
      await tools(order, accepted).named(name)({ prompt: "fix it" });
      expect(accepted).toHaveBeenCalledOnce();
      expect(order).toEqual([`accepted ${OPERATION}`, "wait"]);
    });
  }

  it("is not called by the recovery tools, which start no new work", async () => {
    const accepted = vi.fn(async () => undefined);
    const { named } = tools([], accepted);
    await named("agentx_task_status")({ operationId: OPERATION });
    await named("agentx_task_result")({ operationId: OPERATION });
    expect(accepted).not.toHaveBeenCalled();
  });

  it("is not called when the worker never accepted the task", async () => {
    const accepted = vi.fn(async () => undefined);
    const { api, named } = tools([], accepted);
    api.submitTask.mockResolvedValueOnce({});
    await expect(named("agentx_submit_task")({ prompt: "fix it" })).rejects.toThrow("omitted the operation");
    expect(accepted).not.toHaveBeenCalled();
  });
});

describe("onOperationAttached (#173)", () => {
  it("agentx_task_result reports the operation it re-attaches to once, before it waits, and never as accepted", async () => {
    const order: string[] = [];
    const accepted = vi.fn(async () => undefined);
    const attached = vi.fn(async (operationId: string) => { order.push(`attached ${operationId}`); });
    const api = fakeApi(order);
    const tool = createOrchestrationTools(api, context, { requestId: () => "44444444-4444-4444-8444-444444444444", recovery: true, onOperationAccepted: accepted, onOperationAttached: attached })
      .find((entry) => entry.name === "agentx_task_result")!;
    await tool.execute("call-1", { operationId: OPERATION }, undefined, undefined, {} as never);
    expect(attached).toHaveBeenCalledExactlyOnceWith(OPERATION);
    expect(order).toEqual([`attached ${OPERATION}`, "wait"]);
    expect(accepted).not.toHaveBeenCalled();
  });

  it("is not called by agentx_task_status, which waits on nothing", async () => {
    const attached = vi.fn(async () => undefined);
    const tool = createOrchestrationTools(fakeApi([]), context, { recovery: true, onOperationAttached: attached }).find((entry) => entry.name === "agentx_task_status")!;
    await tool.execute("call-1", { operationId: OPERATION }, undefined, undefined, {} as never);
    expect(attached).not.toHaveBeenCalled();
  });

  it("is handed from the hosted Slack runtime to agentx_task_result", async () => {
    const attached = vi.fn(async () => undefined);
    const runtime = await createHostedSlackRuntime({
      message: {
        version: 1, eventId: "EvATTACH0001", receivedAt: "2026-09-29T19:30:00.000Z", userId: "U0123456789",
        thread: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" }, text: "is it done?",
      },
      subject: "T0BSHLLUGBD/C0123456789/1695500000.000001",
      ...context,
      orchestratorInstructions: "Delegate work.",
      computePrepared: true,
      recoverableOperations: [OPERATION],
      requestId: () => "44444444-4444-4444-8444-444444444444",
      onOperationAttached: attached,
    }, { stateDirectory: await createFixtureDirectory("agentx-attached-"), api: fakeApi([]), model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" } });
    try {
      await runtime.session.getToolDefinition("agentx_task_result")!.execute("result-1", { operationId: OPERATION }, undefined, undefined, {} as never);
    } finally {
      await runtime.dispose();
    }
    expect(attached).toHaveBeenCalledExactlyOnceWith(OPERATION);
  });
});

describe("the hosted Slack runtime", () => {
  it("hands the turn's onOperationAccepted to agentx_submit_task", async () => {
    const accepted = vi.fn(async () => undefined);
    const runtime = await createHostedSlackRuntime({
      message: {
        version: 1, eventId: "EvACCEPT0001", receivedAt: "2026-09-29T19:30:00.000Z", userId: "U0123456789",
        thread: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" }, text: "fix it",
      },
      subject: "T0BSHLLUGBD/C0123456789/1695500000.000001",
      ...context,
      orchestratorInstructions: "Delegate work.",
      computePrepared: true,
      requestId: () => "44444444-4444-4444-8444-444444444444",
      onOperationAccepted: accepted,
    }, { stateDirectory: await createFixtureDirectory("agentx-accepted-"), api: fakeApi([]), model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" } });
    try {
      await runtime.session.getToolDefinition("agentx_submit_task")!.execute("submit-1", { prompt: "fix it" }, undefined, undefined, {} as never);
    } finally {
      await runtime.dispose();
    }
    expect(accepted).toHaveBeenCalledExactlyOnceWith(OPERATION);
  });
});

describe("stopping a handed-off turn's model", () => {
  it("aborts the session when the turn's signal fires, once, and not after the turn let go", async () => {
    const abort = vi.fn(async () => undefined);
    const controller = new AbortController();
    const release = stopModelOnAbort(controller.signal, { session: { abort } });
    expect(abort).not.toHaveBeenCalled();
    controller.abort();
    controller.abort();
    expect(abort).toHaveBeenCalledOnce();
    release();

    const later = new AbortController();
    stopModelOnAbort(later.signal, { session: { abort } })();
    later.abort();
    expect(abort).toHaveBeenCalledOnce();
  });

  it("aborts at once for a signal that already fired, and reports a failed abort instead of throwing", async () => {
    const abort = vi.fn(async () => {
      throw Object.assign(new Error("not running"), { name: "StateError" });
    });
    const failed = vi.fn();
    stopModelOnAbort(AbortSignal.abort(), { session: { abort } }, failed);
    expect(abort).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "StateError" }));
  });

  it("does nothing without a signal", () => {
    const abort = vi.fn(async () => undefined);
    stopModelOnAbort(undefined, { session: { abort } })();
    expect(abort).not.toHaveBeenCalled();
  });
});

describe("running a hosted turn that may be handed off", () => {
  it("never prompts the model when the turn was handed off while its runtime was being made", async () => {
    const abort = vi.fn(async () => undefined);
    const run = vi.fn(async () => "answered");
    await expect(runHostedTurn({ session: { abort } }, AbortSignal.abort(), run)).rejects.toThrow("handed off");
    expect(run).not.toHaveBeenCalled();
  });

  it("stops the model when the hand-off comes mid-turn, and lets go of the signal afterwards", async () => {
    const abort = vi.fn(async () => undefined);
    const controller = new AbortController();
    const answer = await runHostedTurn({ session: { abort } }, controller.signal, async () => {
      controller.abort();
      return "partial";
    });
    expect(answer).toBe("partial");
    expect(abort).toHaveBeenCalledOnce();
  });

  it("runs the turn as before without a signal", async () => {
    const abort = vi.fn(async () => undefined);
    expect(await runHostedTurn({ session: { abort } }, undefined, async () => "answered")).toBe("answered");
    expect(abort).not.toHaveBeenCalled();
  });
});

describe("a task tool whose turn was handed off", () => {
  for (const name of ["agentx_submit_task", "agentx_follow_up"] as const) {
    it(`${name} starts no worker task once the turn's signal has fired`, async () => {
      const accepted = vi.fn(async () => undefined);
      const api = fakeApi([]);
      const tool = createOrchestrationTools(api, context, { requestId: () => "44444444-4444-4444-8444-444444444444", onOperationAccepted: accepted }).find((entry) => entry.name === name)!;
      await expect(tool.execute("call-1", { prompt: "fix it" }, AbortSignal.abort(), undefined, {} as never)).rejects.toThrow("AgentX is restarting");
      expect(api.submitTask).not.toHaveBeenCalled();
      expect(api.followUp).not.toHaveBeenCalled();
      expect(accepted).not.toHaveBeenCalled();
    });
  }
});
