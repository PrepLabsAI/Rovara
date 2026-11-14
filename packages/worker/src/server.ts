import { createServer, type Server } from "node:http";
import { AgentXError, WORKER_PING_FEATURES_FIELD, WorkerInvocationSchema, modelFailureCodeOf, noChangeFindingsFrom, redactText, type WorkerInvocation, type WorkerInvocationFeature } from "@agentx/contracts";
import { WORKER_IMPLEMENTED_FEATURES } from "./implemented-features.js";
import type { OperationJournal } from "./journal.js";
import { WorkerOperationCancelledError } from "./cancel.js";
import {
  invocationMatchesClaims,
  verifyInvokeAuthorization,
  type InvokeAuthentication,
  type InvokeRejection,
} from "./invoke-auth.js";
import { logInvocationStarted, type WorkerInvocationLog, type WorkerLogSink } from "./worker-log.js";

const MAX_INVOCATION_BYTES = 1_048_576;

export interface WorkerExecutor {
  execute(invocation: WorkerInvocation): Promise<unknown>;
  /** Live steer (steer-invocation.ts): answers a `steer` invocation on the same request. Absent: the invocation is refused (the worker does not list the feature). */
  steer?(invocation: Extract<WorkerInvocation, { kind: "steer" }>): Promise<Record<string, unknown>>;
  /** Live interaction A2: answers a `peek` invocation (a read-only look at the working tree) on the same request. Absent: refused. */
  peek?(invocation: Extract<WorkerInvocation, { kind: "peek" }>): Promise<Record<string, unknown>>;
  /** Explicitly implemented invocation extensions; never inferred from parser acceptance alone. */
  invocationFeatures?: readonly WorkerInvocationFeature[];
  /** Feature-specific optional runtime gates are reported independently of ordinary worker health. */
  invocationFeatureDiagnostics?: Readonly<Record<string, unknown>>;
  /**
   * Listed features this worker cannot use right now (for example application CHECKS while the executor image is missing), answered from what it already knows:
   * /ping never waits on anything slow, because the broker's probes give up after 2 to 3 seconds. Each is left out of the list the dispatcher reads, and its
   * diagnostic says why. Features the executor does not name stay listed.
   */
  withheldInvocationFeatures?(): Readonly<Partial<Record<WorkerInvocationFeature, unknown>>>;
  /** Every feature `withheldInvocationFeatures` may name. If asking throws, all of these are withheld (fail closed). */
  withholdableInvocationFeatures?: readonly WorkerInvocationFeature[];
  /**
   * Why this worker cannot run tasks at all, found at start (for example worker scratch, worker-scratch.ts). /ping then answers the way a failed boot does (boot.sh's report_boot_failure):
   * 503 and `{"status":"BootFailed","reason":...}`. The broker already reads that: a provisioning session fails at once, and a READY one counts it as a failed probe and is recycled.
   */
  bootFailure?: string;
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
  /** Where the structured per-invocation lines go (worker-log.ts). Absent: no lines, as in tests that do not look. */
  log?: WorkerLogSink;
}

export interface WorkerServerState {
  journal: OperationJournal;
  executor: WorkerExecutor;
  callbacks: WorkerServerCallbacks;
  activeOperations: Set<string>;
  invocationFeatures: readonly string[];
  invocationFeatureDiagnostics?: Readonly<Record<string, unknown>>;
  /** See `WorkerExecutor.bootFailure`. */
  bootFailure?: string;
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
    invocationFeatures: [...WORKER_IMPLEMENTED_FEATURES, ...(executor.invocationFeatures ?? [])],
    ...(executor.invocationFeatureDiagnostics === undefined ? {} : { invocationFeatureDiagnostics: executor.invocationFeatureDiagnostics }),
    ...(executor.bootFailure === undefined ? {} : { bootFailure: executor.bootFailure }),
    ...(invokeAuthentication === undefined ? {} : { invokeAuthentication }),
  };
}

/**
 * Whether the worker is still running an operation other than `operationId`. The worker accepts an invocation without waiting for the earlier ones, so the broker may have written
 * an operation off as lost while it still runs here.
 */
export function anotherOperationActive(state: Pick<WorkerServerState, "activeOperations">, operationId: string): boolean {
  return [...state.activeOperations].some((active) => active !== operationId);
}

/** What /ping lists: the features this build implements, less those the executor withholds right now (and why). */
export function advertisedInvocationFeatures(state: WorkerServerState): { features: string[]; withheld: Readonly<Record<string, unknown>> } {
  let withheld: Readonly<Record<string, unknown>> = {};
  try { withheld = state.executor.withheldInvocationFeatures?.() ?? {}; } catch {
    withheld = Object.fromEntries((state.executor.withholdableInvocationFeatures ?? []).map((feature) => [feature, { status: "unavailable", reason: "availability-check-failed" }]));
  }
  return { features: state.invocationFeatures.filter((feature) => !Object.hasOwn(withheld, feature)), withheld };
}

export async function handleWorkerRequest(request: Request, state: WorkerServerState): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/ping") {
    // Not Healthy and no feature list: the same body the boot script's failure responder serves, which the broker already treats as a worker to stop using (session-steps.ts BootFailed).
    if (state.bootFailure !== undefined) return response(503, { status: "BootFailed", reason: state.bootFailure.slice(0, 300) });
    const { features, withheld } = advertisedInvocationFeatures(state);
    const diagnostics = { ...state.invocationFeatureDiagnostics, ...withheld };
    return response(200, {
      status: state.activeOperations.size === 0 ? "Healthy" : "HealthyBusy",
      activeOperations: state.activeOperations.size,
      // Spec 053: the optional invocation fields this build parses and can use now; the dispatcher sends one only when listed.
      [WORKER_PING_FEATURES_FIELD]: features,
      ...(Object.keys(diagnostics).length === 0 ? {} : { invocationFeatureDiagnostics: diagnostics }),
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
      // A live steer is answered on this request and is not an operation: no journal record of its own here, no background run, no terminal callback.
      if (invocation.kind === "steer") {
        if (state.executor.steer === undefined) return response(400, { error: "live steer is not supported by this worker" });
        return response(200, await state.executor.steer(invocation));
      }
      // A peek is answered on this request and is not an operation: no journal record, no background run, no terminal callback.
      if (invocation.kind === "peek") {
        if (state.executor.peek === undefined) return response(400, { error: "peek is not supported by this worker" });
        return response(200, await state.executor.peek(invocation));
      }
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
  const log: WorkerInvocationLog | undefined = state.callbacks.log === undefined ? undefined : logInvocationStarted(state.callbacks.log, invocation);
  try {
    await state.journal.transition(invocation.operationId, "RUNNING");
    const result = await state.executor.execute(invocation);
    await state.journal.transition(invocation.operationId, "SUCCEEDED");
    terminal = {
      operationId: invocation.operationId,
      status: "SUCCEEDED",
      ...(result === undefined ? {} : { result }),
    };
    log?.finished("succeeded");
  } catch (error) {
    if (error instanceof WorkerOperationCancelledError) {
      // Logged before the journal write, as a failure is, so a journal fault leaves a line too.
      log?.finished("cancelled");
      await state.journal.transition(invocation.operationId, "CANCELLED", error.message);
      terminal = { operationId: invocation.operationId, status: "CANCELLED", error: error.message, ...checksResult(error) };
    } else {
      // Redacted before the journal stores it on disk or the terminal callback sends it: an error
      // can carry a command's or Git's output (#170).
      const message = redactText(error instanceof Error ? error.message : "worker execution failed");
      log?.failed(error);
      await state.journal.transition(
        invocation.operationId,
        "FAILED",
        message,
      );
      terminal = { operationId: invocation.operationId, status: "FAILED", error: message, ...checksResult(error) };
    }
  } finally {
    state.activeOperations.delete(invocation.operationId);
  }
  await reportTerminal(state, terminal!, invocation);
}

/**
 * Spec 051 Ruling Y: a task that ends failed or cancelled with a regression AgentX found carries its report, so the
 * broker keeps the regression standing. No other failure sends a result.
 */
function checksResult(error: unknown): { result?: { checks?: unknown; workflowDependenciesResult?: unknown; noChangeFindings?: unknown; workflowMode?: unknown; setupProposal?: unknown; setupRunSummary?: unknown; modelFailureCode?: unknown } } {
  // F5: a stopped setup run's own report (its partial proposal and summary; the broker reads both again) is the whole result.
  const setupRun = error instanceof WorkerOperationCancelledError && typeof error.setupRunResult === "object" && error.setupRunResult !== null ? error.setupRunResult as Record<string, unknown> : undefined;
  if (setupRun?.["workflowMode"] === "SETUP_AGENT") return { result: { workflowMode: "SETUP_AGENT", ...(setupRun["setupProposal"] === undefined ? {} : { setupProposal: setupRun["setupProposal"] }), ...(setupRun["setupRunSummary"] === undefined ? {} : { setupRunSummary: setupRun["setupRunSummary"] }) } };
  const checks = typeof error === "object" && error !== null && "checks" in error ? error.checks : undefined;
  const workflowDependenciesResult = typeof error === "object" && error !== null && "workflowDependenciesResult" in error ? error.workflowDependenciesResult : undefined;
  // A coding run that left the code as it was carries what it found (already redacted and bounded by the run; redacted again here, as every failure's text is).
  const noChangeFindings = typeof error === "object" && error !== null && "noChangeFindings" in error ? noChangeFindingsFrom(error.noChangeFindings) : undefined;
  // DR-KEY-1 (B): a failed model call's fixed code (never its words), which the broker learns from.
  const modelFailureCode = modelFailureCodeOf(error);
  return checks === undefined && workflowDependenciesResult === undefined && noChangeFindings === undefined && modelFailureCode === undefined ? {} : {
    result: { ...(checks === undefined ? {} : { checks }), ...(workflowDependenciesResult === undefined ? {} : { workflowDependenciesResult }), ...(noChangeFindings === undefined ? {} : { noChangeFindings }), ...(modelFailureCode === undefined ? {} : { modelFailureCode }) },
  };
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
