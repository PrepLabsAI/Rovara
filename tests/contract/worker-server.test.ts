import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerInvocation } from "@agentx/contracts";
import {
  type JournalStatus,
  OperationJournal,
  createWorkerServerState,
  handleWorkerRequest,
} from "../../packages/worker/src/index.js";
import { WorkerOperationCancelledError } from "../../packages/worker/src/cancel.js";
import { describe, expect, it, vi } from "vitest";

describe("worker HTTP contract", () => {
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
    // Wait on the ping, not the journal: the journal reads SUCCEEDED a moment before the operation
    // leaves the active set (see the test below).
    await vi.waitFor(async () => {
      const healthy = await handleWorkerRequest(new Request("http://worker/ping"), state);
      await expect(healthy.json()).resolves.toMatchObject({ status: "Healthy", activeOperations: 0 });
    });
    expect((await journal.get(invocation.operationId))?.status).toBe("SUCCEEDED");
    // Spec 053: what this build parses, so the dispatcher sends the thinking level only to it; spec 051 adds readiness,
    // and publish's reportChecks (P-2), so only this build is asked to publish despite a failing check.
    await expect((await handleWorkerRequest(new Request("http://worker/ping"), state)).json())
      .resolves.toMatchObject({ invocationFeatures: ["model.thinkingLevel", "task.readiness", "task.workflowMode", "task.workflowReview", "task.workflowFeedbackReview", "task.workflowFeedbackApproval", "publish.reportChecks"] });
  });

  // The journal reads SUCCEEDED a moment before the operation leaves the active set: the write lands,
  // then transition() returns, then executeInBackground clears it. The worker stays busy until the
  // operation is fully recorded, so a caller that saw SUCCEEDED in the journal must wait on /ping.
  it("reports HealthyBusy until a finished operation is fully recorded, though the journal already reads SUCCEEDED", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-recorded-"));
    let releaseRecord!: () => void;
    const recordGate = new Promise<void>((resolve) => {
      releaseRecord = resolve;
    });
    class HeldJournal extends OperationJournal {
      override async transition(operationId: string, status: JournalStatus, error?: string) {
        const record = await super.transition(operationId, status, error);
        if (status === "SUCCEEDED") await recordGate;
        return record;
      }
    }
    const journal = new HeldJournal(root);
    const state = createWorkerServerState(journal, { execute: async () => undefined });
    const invocation = taskInvocation();

    await handleWorkerRequest(invocationRequest(invocation), state);
    await vi.waitFor(async () => {
      expect((await journal.get(invocation.operationId))?.status).toBe("SUCCEEDED");
    });
    const busy = await handleWorkerRequest(new Request("http://worker/ping"), state);
    await expect(busy.json()).resolves.toMatchObject({ status: "HealthyBusy", activeOperations: 1 });

    releaseRecord();
    await vi.waitFor(async () => {
      const ping = await handleWorkerRequest(new Request("http://worker/ping"), state);
      await expect(ping.json()).resolves.toMatchObject({ status: "Healthy", activeOperations: 0 });
    });
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

  it("redacts a failed operation's error before it is journaled or reported (#170)", async () => {
    const token = `ghp_${"Q1w2E3r4T5".repeat(4)}`;
    const root = await mkdtemp(join(tmpdir(), "agentx-terminal-"));
    const journal = new OperationJournal(root);
    const terminal: Array<{ operationId: string; status: string; error?: string }> = [];
    const state = createWorkerServerState(
      journal,
      { execute: async () => { throw new Error(`fatal: could not read from https://github.com/x?token=1 ${token}`); } },
      { onTerminal: async (result) => { terminal.push(result); } },
    );
    const invocation = taskInvocation();

    await handleWorkerRequest(invocationRequest(invocation), state);
    await vi.waitFor(() => expect(terminal).toHaveLength(1));
    expect(terminal[0]).toMatchObject({ status: "FAILED" });
    expect(terminal[0]!.error).toContain("[REDACTED]");
    expect(terminal[0]!.error).not.toContain(token);
    const record = await journal.get(invocation.operationId);
    expect(record?.error).toBe(terminal[0]!.error);
    expect(await readFile(join(root, ".agentx/operations", `${invocation.operationId}.json`), "utf8")).not.toContain(token);
  });

  it("sends the regression a failed or cancelled task carries as its result, and nothing for other failures (spec 051 Ruling Y)", async () => {
    const checks = { status: "regression", checks: [] };
    for (const [thrown, expected] of [
      [Object.assign(new Error("model down"), { checks }), { status: "FAILED", result: { checks } }],
      [Object.assign(new WorkerOperationCancelledError("op"), { checks }), { status: "CANCELLED", result: { checks } }],
      [new Error("model down"), { status: "FAILED" }],
    ] as const) {
      const journal = new OperationJournal(await mkdtemp(join(tmpdir(), "agentx-terminal-")));
      const terminal: Array<Record<string, unknown>> = [];
      const state = createWorkerServerState(journal, { execute: async () => { throw thrown; } }, { onTerminal: async (result) => { terminal.push(result as unknown as Record<string, unknown>); } });
      await handleWorkerRequest(invocationRequest(taskInvocation()), state);
      await vi.waitFor(() => expect(terminal).toHaveLength(1));
      expect(terminal[0]).toMatchObject(expected);
      if (!("result" in expected)) expect(terminal[0]).not.toHaveProperty("result");
    }
  });

  it("retries a failed terminal callback three times, waiting 2 s, 8 s and 30 s", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-terminal-"));
    const journal = new OperationJournal(root);
    const waits: number[] = [];
    let attempts = 0;
    const state = createWorkerServerState(
      journal,
      { execute: async () => undefined },
      {
        onTerminal: async () => {
          attempts += 1;
          throw new Error("ThrottlingException");
        },
        retrySleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    const invocation = taskInvocation();

    await handleWorkerRequest(invocationRequest(invocation), state);
    await vi.waitFor(() => expect(attempts).toBe(4));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(4);
    expect(waits).toEqual([2_000, 8_000, 30_000]);
    expect((await journal.get(invocation.operationId))?.status).toBe("SUCCEEDED");
  });

  it("stops retrying the terminal callback once it succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-terminal-"));
    const journal = new OperationJournal(root);
    const waits: number[] = [];
    let attempts = 0;
    const state = createWorkerServerState(
      journal,
      { execute: async () => undefined },
      {
        onTerminal: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("ThrottlingException");
        },
        retrySleep: async (ms) => {
          waits.push(ms);
        },
      },
    );

    await handleWorkerRequest(invocationRequest(taskInvocation()), state);
    await vi.waitFor(() => expect(attempts).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(3);
    expect(waits).toEqual([2_000, 8_000]);
  });

  it("accepts a prepare invocation whose stored project has a connector of an unknown type", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-journal-"));
    const journal = new OperationJournal(root);
    const state = createWorkerServerState(journal, { execute: async () => undefined });
    const invocation = prepareInvocationWithUnknownConnector();

    const accepted = await handleWorkerRequest(invocationRequest(invocation), state);
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ accepted: true, status: "ACCEPTED" });
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

/** A revision written by a later control plane, before a rollback to this one: the worker never
 * reads integrations.connectors, and StoredProjectDefinitionSchema passes an unknown type through. */
function prepareInvocationWithUnknownConnector(): WorkerInvocation {
  return {
    protocolVersion: 1,
    kind: "prepare",
    operationId: randomUUID(),
    workspaceId: randomUUID(),
    fence: 1,
    projectRevision: 1,
    callbackCapability: "c".repeat(64),
    payload: {
      project: {
        name: "payments",
        revision: 1,
        repositories: [
          {
            name: "api",
            url: "https://git.example.test/api.git",
            path: "repo/api",
            defaultBranch: "main",
            credentialRef: "api-readwrite",
          },
        ],
        setup: [],
        readiness: [],
        orchestratorInstructions: "Delegate coding to the remote worker.",
        integrations: {
          connectors: [
            { name: "tracker", type: "future-vendor", credentialRef: "future-vendor-key", scopes: ["api"] },
          ],
        },
      },
      repositoryGrant: "signed-grant",
    },
  };
}
