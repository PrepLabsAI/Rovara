import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentXError, type WorkerInvocation } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { OperationJournal, createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/index.js";
import { WorkerOperationCancelledError } from "../../packages/worker/src/cancel.js";
import { WORKER_ERROR_CLASSES, logInvocationStarted, logWorkerStarted, readPiAiVersion, type WorkerLogSink } from "../../packages/worker/src/worker-log.js";

interface Captured { level: "info" | "error"; line: string; json: Record<string, unknown> }

function capture(): { sink: WorkerLogSink; lines: Captured[] } {
  const lines: Captured[] = [];
  const sink: WorkerLogSink = (level, line) => { lines.push({ level, line, json: JSON.parse(line) as Record<string, unknown> }); };
  return { sink, lines };
}

// Built at run time, so the repository holds no literal token-shaped strings for a secret scanner to flag.
const SECRETS = [
  "gh" + "p_" + "x1".repeat(18),
  "s" + "k-" + "proj-" + "abcd1234".repeat(5),
  "s" + "k-" + "ant-api03-" + "abcd1234".repeat(5),
  "hunter2-" + "super-" + "secret",
  ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abcdefghijklmnopqrstuvwxyz0123"].join("."),
  "AK" + "IA" + "IOSFODNN7" + "EXAMPLE",
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

  const ALLOWED_FAILURE_KEYS = ["component", "durationMs", "errorClass", "errorCode", "event", "exceptionName", "httpStatus", "invocationId", "kind", "outcome"];

  it("describes a failure by code, class, status and exception name only, with no message field", async () => {
    const error = agentXError("RUNTIME_UNAVAILABLE", "the model call failed: ThrottlingException: HTTP status 429");
    const { lines, invocation } = await run(async () => { throw error; });
    expect(lines.map((entry) => entry.json.event)).toEqual(["invocation.started", "invocation.failed"]);
    const failed = lines[1]!;
    expect(failed.level).toBe("error");
    expect(failed.json).toEqual({
      component: "worker", event: "invocation.failed", kind: "task", invocationId: invocation.operationId, outcome: "failed",
      durationMs: failed.json.durationMs, errorCode: "RUNTIME_UNAVAILABLE", errorClass: "model-call", httpStatus: 429, exceptionName: "ThrottlingException",
    });
    expect(Number.isInteger(failed.json.durationMs)).toBe(true);
    expect(failed.json).not.toHaveProperty("errorMessage");
    expect(failed.json).not.toHaveProperty("errorName");
  });

  it("takes an http status from the error object, and the exception name from a custom error class", async () => {
    class PushRejectedError extends Error { override name = "PushRejectedError"; status = 403; }
    const { lines } = await run(async () => { throw new PushRejectedError("denied"); });
    expect(lines[1]!.json).toMatchObject({ errorClass: "internal", httpStatus: 403, exceptionName: "PushRejectedError" });
    expect(lines[1]!.json).not.toHaveProperty("errorCode");
  });

  // What each message would leak if the line quoted it. Each case asserts the sensitive fragments are absent, then the key set.
  const LEAKY: { label: string; error: () => unknown; fragments: string[]; errorClass: string }[] = [
    {
      label: "a Bedrock ValidationException that echoes the prompt",
      error: () => agentXError("RUNTIME_UNAVAILABLE", 'the model call failed: ValidationException: messages.2.content.0.text: Input should be valid. Got: "Please rewrite our internal pricing algorithm in src/billing/margin.ts so that HTTP status 400'),
      fragments: ["pricing algorithm", "margin", "Please rewrite", "Input should be valid", "messages.2"],
      errorClass: "model-call",
    },
    {
      label: "a command-failure tail naming test files and values",
      error: () => new Error("setup step 1 (npm test in .) exited 1 Last lines: FAIL src/billing/margin.test.ts expected 'acme-internal-customer-list' to equal 'x'"),
      fragments: ["npm test", "margin.test", "acme-internal", "FAIL", "Last lines"],
      errorClass: "command",
    },
    {
      label: "a repository file path",
      error: () => agentXError("CONFIG_INVALID", "broken symlink is not allowed in workspace: customers/acme-secret-deal.txt"),
      fragments: ["customers", "acme-secret-deal", "symlink"],
      errorClass: "config",
    },
    {
      label: "a branch and an owner/repo name",
      error: () => new Error("fatal: unable to access 'https://github.com/acme/secret-repo.git/' repository default branch does not exist: feature/secret-launch"),
      fragments: ["acme", "secret-repo", "secret-launch", "github.com"],
      errorClass: "git",
    },
    {
      label: "a 40-hex token",
      error: () => new Error("authentication failed for token " + "0123456789abcdef".repeat(2) + "01234567"),
      fragments: ["0123456789abcdef", "authentication failed"],
      errorClass: "internal",
    },
    {
      label: "a bare AWS secret access key",
      error: () => new Error("signature mismatch for " + "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCY" + "EXAMPLEKEY"),
      fragments: ["wJalrXUtnFEMI", "bPxRfiCY", "signature mismatch"],
      errorClass: "internal",
    },
    {
      label: "a password in plain prose",
      error: () => new Error("my password is correct-horse-battery-staple, please keep it"),
      fragments: ["password", "correct-horse", "battery", "please keep"],
      errorClass: "internal",
    },
    {
      label: "vendor-shaped credentials",
      error: () => new Error(`push to https://x-access-token:${SECRETS[0]}@github.com failed; Authorization: Bearer ${SECRETS[4]}; OPENAI_API_KEY=${SECRETS[1]}; ${SECRETS[2]}; password=${SECRETS[3]}; ${SECRETS[5]}`),
      fragments: SECRETS,
      errorClass: "internal",
    },
  ];

  for (const leaky of LEAKY) {
    it(`never lets ${leaky.label} reach a log line`, async () => {
      const { lines } = await run(async () => { throw leaky.error(); });
      expect(lines.map((entry) => entry.json.event)).toEqual(["invocation.started", "invocation.failed"]);
      for (const entry of lines) for (const fragment of leaky.fragments) expect(entry.line).not.toContain(fragment);
      const failed = lines[1]!.json;
      expect(Object.keys(failed).every((key) => ALLOWED_FAILURE_KEYS.includes(key))).toBe(true);
      expect(failed.errorClass).toBe(leaky.errorClass);
      expect(WORKER_ERROR_CLASSES).toContain(failed.errorClass);
    });
  }

  it("does not trust an attacker-shaped error name, error code or status", async () => {
    const { lines } = await run(async () => {
      const error = Object.assign(new Error("boom"), { code: SECRETS[1], status: 99999, $metadata: { httpStatusCode: "400 " + SECRETS[0] } });
      error.name = `Evil ${SECRETS[1]}\nnext line`;
      throw error;
    });
    expect(lines[1]!.json).toEqual({
      component: "worker", event: "invocation.failed", kind: "task", invocationId: lines[0]!.json.invocationId, outcome: "failed",
      durationMs: lines[1]!.json.durationMs, errorClass: "internal",
    });
    expect(lines[1]!.line).not.toContain(SECRETS[1]);
  });

  it("only names an exception from the provider list, never a word the prompt could have supplied", async () => {
    const { lines } = await run(async () => { throw agentXError("RUNTIME_UNAVAILABLE", "the model call failed: AcmeCustomerListException: bad input"); });
    expect(lines[1]!.json).toMatchObject({ errorClass: "model-call" });
    expect(lines[1]!.json).not.toHaveProperty("exceptionName");
    expect(lines[1]!.line).not.toContain("Acme");
  });

  it("logs a non-Error rejection without printing it", async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test is a thrown non-Error
    const { lines } = await run(async () => { throw { token: SECRETS[0], code: "RUNTIME_UNAVAILABLE" }; });
    expect(lines[1]!.json).toMatchObject({ event: "invocation.failed", errorClass: "internal", errorCode: "RUNTIME_UNAVAILABLE" });
    expect(lines[1]!.line).not.toContain(SECRETS[0]);
  });

  it("logs a cancelled invocation as a finish line with outcome cancelled", async () => {
    const { lines } = await run(async () => { throw new WorkerOperationCancelledError("cancelled by owner"); });
    expect(lines.map((entry) => entry.json.event)).toEqual(["invocation.started", "invocation.finished"]);
    expect(lines[1]!.json).toMatchObject({ outcome: "cancelled" });
    expect(lines[1]!.line).not.toContain("owner");
  });

  it("logs a cancellation before it writes the journal, as a failure does", async () => {
    const order: string[] = [];
    const root = await mkdtemp(join(tmpdir(), "agentx-worker-log-order-"));
    const journal = new OperationJournal(root);
    const transition = journal.transition.bind(journal);
    vi.spyOn(journal, "transition").mockImplementation((id, status, ...rest) => { order.push(`journal:${status}`); return transition(id, status, ...rest); });
    const state = createWorkerServerState(journal, { execute: async () => { throw new WorkerOperationCancelledError("c"); } }, {
      log: (_level, line) => { order.push(`log:${(JSON.parse(line) as { outcome?: string }).outcome ?? "started"}`); },
    });
    await handleWorkerRequest(invocationRequest(taskInvocation()), state);
    await vi.waitFor(() => expect(order).toContain("journal:CANCELLED"));
    expect(order.indexOf("log:cancelled")).toBeGreaterThan(-1);
    expect(order.indexOf("log:cancelled")).toBeLessThan(order.indexOf("journal:CANCELLED"));
  });

  it("cannot throw out of the start line, whatever the invocation looks like", () => {
    const hostile = new Proxy({}, { get() { throw new Error("hostile getter"); } }) as unknown as WorkerInvocation;
    const log = logInvocationStarted(() => undefined, hostile);
    expect(() => { log.finished("succeeded"); log.failed(new Error("x")); }).not.toThrow();
    expect(() => logInvocationStarted(() => { throw new Error("stdout closed"); }, taskInvocation())).not.toThrow();
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
