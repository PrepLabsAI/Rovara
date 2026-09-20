import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerInvocation } from "@agentx/contracts";
import {
  OperationJournal,
  createWorkerServerState,
  handleWorkerRequest,
} from "../../packages/worker/src/index.js";
import { describe, expect, it, vi } from "vitest";

describe("AgentCore worker HTTP contract", () => {
  it("replays a durable terminal payload after a lost callback without re-executing", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-replay-"));
    const journal = new OperationJournal(root);
    const invocation = taskInvocation();
    const result = { candidate: { commit: "a".repeat(40) } };
    let executions = 0;
    const state = createWorkerServerState(journal, { execute: async () => { executions += 1; return result; } });
    await handleWorkerRequest(invocationRequest(invocation), state);
    await vi.waitFor(async () => expect((await journal.get(invocation.operationId))?.status).toBe("SUCCEEDED"));
    const receipts: unknown[] = [];
    const restarted = createWorkerServerState(new OperationJournal(root), { execute: async () => { executions += 1; } }, { onTerminal: async (receipt) => { receipts.push(receipt); } });
    await handleWorkerRequest(invocationRequest(invocation), restarted);
    await vi.waitFor(() => expect(receipts).toEqual([{ operationId: invocation.operationId, status: "SUCCEEDED", result }]));
    expect(executions).toBe(1);
  });
  it("journals before acknowledging and reports HealthyBusy during background execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-journal-"));
    const journal = new OperationJournal(root);
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let executions = 0;
    const state = createWorkerServerState(journal, {
      execute: async () => {
        executions += 1;
        await executionGate;
      },
    });
    const invocation = taskInvocation();

    const accepted = await handleWorkerRequest(invocationRequest(invocation), state);
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ accepted: true, status: "ACCEPTED" });
    expect(await journal.get(invocation.operationId)).toBeDefined();

    await vi.waitFor(() => expect(executions).toBe(1));
    const ping = await handleWorkerRequest(new Request("http://worker/ping"), state);
    await expect(ping.json()).resolves.toMatchObject({ status: "HealthyBusy", activeOperations: 1 });

    const duplicate = await handleWorkerRequest(invocationRequest(invocation), state);
    await expect(duplicate.json()).resolves.toMatchObject({ accepted: true, duplicate: true });
    expect(executions).toBe(1);

    releaseExecution();
    await vi.waitFor(async () => {
      expect((await journal.get(invocation.operationId))?.status).toBe("SUCCEEDED");
    });
    const healthy = await handleWorkerRequest(new Request("http://worker/ping"), state);
    await expect(healthy.json()).resolves.toMatchObject({ status: "Healthy", activeOperations: 0 });
  });

  it("reports the persisted terminal state after background execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-terminal-"));
    const journal = new OperationJournal(root);
    const terminal: Array<{ operationId: string; status: string; error?: string }> = [];
    const state = createWorkerServerState(
      journal,
      { execute: async () => undefined },
      {
        onTerminal: async (result) => {
          terminal.push(result);
        },
      },
    );
    const invocation = taskInvocation();

    await handleWorkerRequest(invocationRequest(invocation), state);
    await vi.waitFor(() => expect(terminal).toEqual([
      { operationId: invocation.operationId, status: "SUCCEEDED" },
    ]));
    expect((await journal.get(invocation.operationId))?.status).toBe("SUCCEEDED");
  });
});

function invocationRequest(invocation: WorkerInvocation): Request {
  return new Request("http://worker/invocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(invocation),
  });
}

function taskInvocation(): WorkerInvocation {
  return {
    protocolVersion: 1,
    kind: "task",
    operationId: randomUUID(),
    workspaceId: randomUUID(),
    fence: 1,
    projectRevision: 1,
    callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "Inspect the fixture" },
  };
}
