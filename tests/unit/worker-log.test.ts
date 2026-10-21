import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerInvocation } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { OperationJournal, createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/index.js";
import { WorkerOperationCancelledError } from "../../packages/worker/src/cancel.js";
import { logWorkerStarted, readPiAiVersion, type WorkerLogSink } from "../../packages/worker/src/worker-log.js";

interface Captured { level: "info" | "error"; line: string; json: Record<string, unknown> }

function capture(): { sink: WorkerLogSink; lines: Captured[] } {
  const lines: Captured[] = [];
  const sink: WorkerLogSink = (level, line) => { lines.push({ level, line, json: JSON.parse(line) as Record<string, unknown> }); };
  return { sink, lines };
}

const SECRETS = [
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
  "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
  "hunter2-super-secret",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz0123",
  "AKIAIOSFODNN7EXAMPLE",
];

describe("worker startup log line", () => {
  const readyRuntime = { status: "ready" } as never;
  const unavailableRuntime = { status: "unavailable", reason: "private-runtime-paths-unavailable" } as never;

  it("emits exactly one worker.started JSON line with the documented fields", () => {
    const { sink, lines } = capture();
    const workspaceId = randomUUID();
    logWorkerStarted(sink, {
      env: {
        AGENTX_WORKSPACE_ID: workspaceId,
        AGENTX_SESSION_GENERATION: "4",
        AGENTX_INSTANCE_ID: "i-02cc2105be1d957bb",
        AGENTX_WORKER_IMAGE: `944937319445.dkr.ecr.us-east-1.amazonaws.com/agentx-worker@sha256:${"a".repeat(64)}`,
      },
      containedRuntime: unavailableRuntime,
      invocationFeatures: ["task.readiness", "publish.mode"],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("info");
    expect(lines[0]!.line).not.toContain("\n");
    expect(lines[0]!.json).toEqual({
      component: "worker",
      event: "worker.started",
      workspaceId,
      generation: "4",
      instanceId: "i-02cc2105be1d957bb",
      workerVersion: (JSON.parse(readFileSync(join(import.meta.dirname, "../../packages/worker/package.json"), "utf8")) as { version: string }).version,
      imageDigest: `sha256:${"a".repeat(64)}`,
      containedRuntime: { status: "unavailable", reason: "private-runtime-paths-unavailable" },
      invocationFeatures: ["task.readiness", "publish.mode"],
      piAiVersion: readPiAiVersion(),
    });
  });

  it("still logs when nothing is configured and the runtime is ready (fields that are unknown are omitted, never invented)", () => {
    const { sink, lines } = capture();
    logWorkerStarted(sink, { env: {}, containedRuntime: readyRuntime, invocationFeatures: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.json).toMatchObject({ component: "worker", event: "worker.started", containedRuntime: { status: "ready" }, invocationFeatures: [] });
    expect(lines[0]!.json).not.toHaveProperty("workspaceId");
    expect(lines[0]!.json).not.toHaveProperty("imageDigest");
    expect(lines[0]!.json).not.toHaveProperty("instanceId");
  });

  it("does not let a failing sink stop startup", () => {
    expect(() => logWorkerStarted(() => { throw new Error("stdout closed"); }, { env: {}, containedRuntime: readyRuntime, invocationFeatures: [] })).not.toThrow();
  });

  it("never echoes secret-shaped or free-text values placed in the environment or the runtime reason", () => {
    const { sink, lines } = capture();
    logWorkerStarted(sink, {
      env: {
        AGENTX_WORKSPACE_ID: `ws ${SECRETS[0]}`,
        AGENTX_SESSION_GENERATION: SECRETS[1],
        AGENTX_INSTANCE_ID: SECRETS[3],
        AGENTX_WORKER_IMAGE: `registry/${SECRETS[2]}`,
        OPENAI_API_KEY: SECRETS[1],
      },
      containedRuntime: { status: "unavailable", reason: `password=${SECRETS[3]} ${SECRETS[0]}` },
      invocationFeatures: [SECRETS[4]!, "task.readiness"],
    });
    for (const secret of SECRETS) expect(lines[0]!.line).not.toContain(secret);
    expect(lines[0]!.json.invocationFeatures).toEqual(["task.readiness"]);
  });

  it("reads the installed pi-ai version", () => {
    const expected = (JSON.parse(readFileSync(join(import.meta.dirname, "../../node_modules/@earendil-works/pi-ai/package.json"), "utf8")) as { version: string }).version;
    expect(readPiAiVersion()).toBe(expected);
    expect(readPiAiVersion()).not.toBe("unknown");
  });
});

describe("worker entry point", () => {
  it("prints the worker.started line on stdout when it boots, before any invocation", async () => {
    const workspaceId = randomUUID();
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const root = await mkdtemp(join(tmpdir(), "agentx-worker-main-"));
    const child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../../packages/worker/src/main.ts")], {
      env: {
        ...process.env,
        PORT: "0",
        AGENTX_WORKSPACE_ROOT: root,
        AGENTX_WORKSPACE_ID: workspaceId,
        AGENTX_SESSION_GENERATION: "7",
        AGENTX_INVOKE_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error(`no worker.started line within 30s; saw: ${output}`)), 30_000);
        child.once("error", reject);
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const found = output.split("\n").find((candidate) => candidate.includes('"worker.started"'));
          if (found !== undefined) { clearTimeout(timer); resolve(found); }
        });
      });
      expect(JSON.parse(line)).toMatchObject({ component: "worker", event: "worker.started", workspaceId, generation: "7", piAiVersion: readPiAiVersion() });
      expect(JSON.parse(line)).toHaveProperty("containedRuntime.status");
      expect((JSON.parse(line) as { invocationFeatures: string[] }).invocationFeatures).toContain("task.readiness");
    } finally {
      child.kill();
    }
  }, 45_000);
});

describe("worker invocation log lines", () => {
  async function run(execute: (invocation: WorkerInvocation) => Promise<unknown>, invocation: WorkerInvocation = taskInvocation()) {
    const { sink, lines } = capture();
    const root = await mkdtemp(join(tmpdir(), "agentx-worker-log-"));
    const journal = new OperationJournal(root);
    const state = createWorkerServerState(journal, { execute }, { log: sink, retrySleep: () => Promise.resolve() });
    await handleWorkerRequest(invocationRequest(invocation), state);
    await vi.waitFor(() => expect(state.activeOperations.size).toBe(0));
    return { lines, invocation };
  }

  it("logs a start and a finish line for a succeeded invocation, with the exact shapes", async () => {
    const { lines, invocation } = await run(async () => ({ done: true, text: "model output that must not appear" }));
    expect(lines.map((entry) => entry.json.event)).toEqual(["invocation.started", "invocation.finished"]);
    expect(lines[0]!.level).toBe("info");
    expect(lines[0]!.json).toEqual({
      component: "worker", event: "invocation.started", kind: "task", invocationId: invocation.operationId,
    });
    expect(lines[1]!.level).toBe("info");
    expect(Object.keys(lines[1]!.json).sort()).toEqual(["component", "durationMs", "event", "invocationId", "kind", "outcome"]);
    expect(lines[1]!.json).toMatchObject({ component: "worker", event: "invocation.finished", kind: "task", invocationId: invocation.operationId, outcome: "succeeded" });
    expect(Number.isInteger(lines[1]!.json.durationMs)).toBe(true);
    expect(lines[1]!.json.durationMs as number).toBeGreaterThanOrEqual(0);
    for (const entry of lines) {
      expect(entry.line).not.toContain("model output");
      expect(entry.line).not.toContain(invocation.callbackCapability);
    }
  });

  it("logs a failure line with the error name and a short redacted message, never the secrets in it", async () => {
    const message = `git push to https://x-access-token:${SECRETS[0]}@github.com/o/r failed; Authorization: Bearer ${SECRETS[4]}; OPENAI_API_KEY=${SECRETS[1]}; ANTHROPIC key ${SECRETS[2]}; password=${SECRETS[3]}; aws ${SECRETS[5]}; ${"padding ".repeat(200)}`;
    class PushRejectedError extends Error { override name = "PushRejectedError"; }
    const { lines, invocation } = await run(async () => { throw new PushRejectedError(message); });
    expect(lines.map((entry) => entry.json.event)).toEqual(["invocation.started", "invocation.failed"]);
    const failed = lines[1]!;
    expect(failed.level).toBe("error");
    expect(Object.keys(failed.json).sort()).toEqual(["component", "durationMs", "errorMessage", "errorName", "event", "invocationId", "kind", "outcome"]);
    expect(failed.json).toMatchObject({ component: "worker", event: "invocation.failed", kind: "task", invocationId: invocation.operationId, outcome: "failed", errorName: "PushRejectedError" });
    expect((failed.json.errorMessage as string).length).toBeLessThanOrEqual(300);
    for (const entry of lines) for (const secret of SECRETS) expect(entry.line).not.toContain(secret);
    expect(failed.line).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(failed.line).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    expect(failed.line).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
  });

  it("does not trust an attacker-shaped error name", async () => {
    const { lines } = await run(async () => { const error = new Error("boom"); error.name = `Evil ${SECRETS[1]}\nnext line`; throw error; });
    expect(lines[1]!.json.errorName).toBe("Error");
    expect(lines[1]!.line).not.toContain(SECRETS[1]);
  });

  it("logs a non-Error rejection without printing it", async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test is a thrown non-Error
    const { lines } = await run(async () => { throw { token: SECRETS[0] }; });
    expect(lines[1]!.json).toMatchObject({ event: "invocation.failed", errorName: "Error", errorMessage: "worker execution failed" });
    expect(lines[1]!.line).not.toContain(SECRETS[0]);
  });

  it("logs a cancelled invocation as a finish line with outcome cancelled", async () => {
    const { lines } = await run(async () => { throw new WorkerOperationCancelledError("cancelled by owner"); });
    expect(lines.map((entry) => entry.json.event)).toEqual(["invocation.started", "invocation.finished"]);
    expect(lines[1]!.json).toMatchObject({ outcome: "cancelled" });
    expect(lines[1]!.json).not.toHaveProperty("errorMessage");
  });

  it("names the task for a feedback review, where the invocation carries one", async () => {
    const taskId = randomUUID();
    const invocation = taskInvocation();
    if (invocation.kind !== "task") throw new Error("fixture");
    invocation.payload = { ...invocation.payload, workflowMode: "FEEDBACK_REVIEW", workflowFeedbackReview: { taskId, workflowRevision: 1, candidateDigest: "b".repeat(64) } };
    const { lines } = await run(async () => undefined, invocation);
    expect(lines[0]!.json).toMatchObject({ event: "invocation.started", taskId });
    expect(lines[1]!.json).toMatchObject({ event: "invocation.finished", taskId });
  });

  it("never logs the prompt, whatever the outcome", async () => {
    const invocation = taskInvocation();
    if (invocation.kind !== "task") throw new Error("fixture");
    invocation.payload = { ...invocation.payload, prompt: `please use ${SECRETS[1]} and my private text` };
    const { lines } = await run(async () => { throw new Error("nope"); }, invocation);
    for (const entry of lines) {
      expect(entry.line).not.toContain("private text");
      expect(entry.line).not.toContain(SECRETS[1]);
    }
  });

  it("keeps executing when the log sink throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-worker-log-throws-"));
    const journal = new OperationJournal(root);
    const state = createWorkerServerState(journal, { execute: async () => "ok" }, { log: () => { throw new Error("stdout closed"); } });
    const invocation = taskInvocation();
    await handleWorkerRequest(invocationRequest(invocation), state);
    await vi.waitFor(async () => expect((await journal.get(invocation.operationId))?.status).toBe("SUCCEEDED"));
  });
});

function invocationRequest(invocation: WorkerInvocation): Request {
  return new Request("http://worker/invocations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(invocation) });
}

function taskInvocation(): WorkerInvocation {
  return {
    protocolVersion: 1,
    kind: "task",
    operationId: randomUUID(),
    workspaceId: randomUUID(),
    fence: 1,
    projectRevision: 1,
    callbackCapability: "callback-capability-".padEnd(32, "x"),
    payload: { conversationId: randomUUID(), prompt: "do the thing" },
  };
}
