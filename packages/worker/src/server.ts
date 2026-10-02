import { createServer, type Server } from "node:http";
import { AgentXError, WORKER_INVOCATION_FEATURES, WORKER_PING_FEATURES_FIELD, WorkerInvocationSchema, redactText, type WorkerInvocation } from "@agentx/contracts";
import type { OperationJournal } from "./journal.js";
import { WorkerOperationCancelledError } from "./cancel.js";
import {
  invocationMatchesClaims,
  verifyInvokeAuthorization,
  type InvokeAuthentication,
  type InvokeRejection,
} from "./invoke-auth.js";

const MAX_INVOCATION_BYTES = 1_048_576;

export interface WorkerExecutor {
  execute(invocation: WorkerInvocation): Promise<unknown>;
}

export interface WorkerTerminalResult {
  operationId: string;
  status: "SUCCEEDED" | "FAILED" | "CANCELLED";
  result?: unknown;
  error?: string;
}

/**
 * Waits before each retry of a failed terminal callback: long enough to outlast real AWS
 * throttling, so the broker's retry of a temporary error can succeed (about 40 s in all).
 */
export const TERMINAL_CALLBACK_RETRY_DELAYS_MS = [2_000, 8_000, 30_000] as const;

export interface WorkerServerCallbacks {
  onTerminal?: (result: WorkerTerminalResult, invocation: WorkerInvocation) => Promise<void>;
  /** Injectable wait between terminal callback retries; tests pass one that does not wait. */
  retrySleep?: (ms: number) => Promise<void>;
}

export interface WorkerServerState {
  journal: OperationJournal;
  executor: WorkerExecutor;
  callbacks: WorkerServerCallbacks;
  activeOperations: Set<string>;
  /** Required by the deployed worker; injectable for in-process tests. */
  invokeAuthentication?: InvokeAuthentication;
}

export function createWorkerServerState(
  journal: OperationJournal,
  executor: WorkerExecutor,
  callbacks: WorkerServerCallbacks = {},
  invokeAuthentication?: InvokeAuthentication,
): WorkerServerState {
  return {
    journal,
    executor,
    callbacks,
    activeOperations: new Set(),
    ...(invokeAuthentication === undefined ? {} : { invokeAuthentication }),
  };
}

export async function handleWorkerRequest(request: Request, state: WorkerServerState): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/ping") {
    return response(200, {
      status: state.activeOperations.size === 0 ? "Healthy" : "HealthyBusy",
      activeOperations: state.activeOperations.size,
      // Spec 053: the optional invocation fields this build parses; the dispatcher sends one only when listed.
      [WORKER_PING_FEATURES_FIELD]: [...WORKER_INVOCATION_FEATURES],
    });
  }
  if (request.method === "POST" && url.pathname === "/invocations") {
    const verified = state.invokeAuthentication
      ? verifyInvokeAuthorization(request.headers.get("authorization"), state.invokeAuthentication)
      : undefined;
    if (verified && !verified.ok) return unauthorized(verified.reason);
    try {
      const text = await request.text();
      if (Buffer.byteLength(text, "utf8") > MAX_INVOCATION_BYTES) {
        return response(413, { error: "invocation is too large" });
      }
      const invocation = WorkerInvocationSchema.parse(JSON.parse(text) as unknown);
      if (verified && !invocationMatchesClaims(invocation, verified.claims)) return unauthorized("invocation_mismatch");
      const accepted = await state.journal.accept(invocation);
      if (!accepted.duplicate) {
        state.activeOperations.add(invocation.operationId);
        queueMicrotask(() => {
          void executeInBackground(invocation, state);
        });
      }
      return response(200, {
        accepted: true,
        operationId: invocation.operationId,
        status: accepted.duplicate ? accepted.record.status : "ACCEPTED",
        duplicate: accepted.duplicate,
      });
    } catch (error) {
      const conflict = error instanceof AgentXError && error.code === "IDEMPOTENCY_CONFLICT";
      return response(conflict ? 409 : 400, {
        error: error instanceof Error ? error.message : "invalid invocation",
      });
    }
  }
  return response(404, { error: "not found" });
}

export function startWorkerServer(
  state: WorkerServerState,
  options: { port?: number; host?: string } = {},
): Server {
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= MAX_INVOCATION_BYTES) chunks.push(chunk);
    });
    incoming.on("end", () => {
      if (size > MAX_INVOCATION_BYTES) {
        outgoing.writeHead(413, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: "invocation is too large" }));
        return;
      }
      const host = incoming.headers.host ?? "127.0.0.1";
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
        else if (value !== undefined) headers.set(name, value);
      }
      const request = new Request(`http://${host}${incoming.url ?? "/"}`, {
        method: incoming.method ?? "GET",
        headers,
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
      });
      void handleWorkerRequest(request, state).then(async (result) => {
        outgoing.writeHead(result.status, Object.fromEntries(result.headers.entries()));
        outgoing.end(Buffer.from(await result.arrayBuffer()));
      });
    });
  });
  server.listen(options.port ?? 8080, options.host ?? "0.0.0.0");
  return server;
}

async function executeInBackground(invocation: WorkerInvocation, state: WorkerServerState): Promise<void> {
  let terminal: WorkerTerminalResult;
  try {
    await state.journal.transition(invocation.operationId, "RUNNING");
    const result = await state.executor.execute(invocation);
    await state.journal.transition(invocation.operationId, "SUCCEEDED");
    terminal = {
      operationId: invocation.operationId,
      status: "SUCCEEDED",
      ...(result === undefined ? {} : { result }),
    };
  } catch (error) {
    if (error instanceof WorkerOperationCancelledError) {
      await state.journal.transition(invocation.operationId, "CANCELLED", error.message);
      terminal = { operationId: invocation.operationId, status: "CANCELLED", error: error.message };
    } else {
      // Redacted before the journal stores it on disk or the terminal callback sends it: an error
      // can carry a command's or Git's output (#170).
      const message = redactText(error instanceof Error ? error.message : "worker execution failed");
      await state.journal.transition(
        invocation.operationId,
        "FAILED",
        message,
      );
      terminal = { operationId: invocation.operationId, status: "FAILED", error: message };
    }
  } finally {
    state.activeOperations.delete(invocation.operationId);
  }
  await reportTerminal(state, terminal!, invocation);
}

async function reportTerminal(
  state: WorkerServerState,
  terminal: WorkerTerminalResult,
  invocation: WorkerInvocation,
): Promise<void> {
  const { onTerminal, retrySleep = sleep } = state.callbacks;
  if (!onTerminal) return;
  for (let attempt = 0; attempt <= TERMINAL_CALLBACK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await onTerminal(terminal, invocation);
      return;
    } catch {
      const delay = TERMINAL_CALLBACK_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) await retrySleep(delay);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unauthorized(reason: InvokeRejection): Response {
  return Response.json(
    { error: "invocation is not authorized", reason },
    { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "AgentX-Invoke" } },
  );
}

function response(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
