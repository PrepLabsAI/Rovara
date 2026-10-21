import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactText, type WorkerInvocation } from "@agentx/contracts";

/**
 * Structured worker logs. The EC2 worker container ships stdout and stderr through docker's awslogs driver
 * (packages/worker/ec2/boot.sh), so one JSON object per line is what shows in the worker's CloudWatch stream.
 *
 * Nothing here prints a prompt, model output, repository content, a callback capability or a user's text. Every field
 * is chosen from a short list, and each value is either checked against a strict shape (an id, a version, an enum) or,
 * for the one free-text field (a failure's error message), redacted with the shared credential redaction and cut short.
 * A value that does not fit its shape is left out, never printed.
 */

export type WorkerLogLevel = "info" | "error";
/** Writes one line. `error` lines go to stderr, the rest to stdout; docker ships both. */
export type WorkerLogSink = (level: WorkerLogLevel, line: string) => void;

export const consoleWorkerLog: WorkerLogSink = (level, line) => {
  if (level === "error") console.error(line);
  else console.log(line);
};

export type WorkerInvocationOutcome = "succeeded" | "cancelled" | "failed";

const ERROR_MESSAGE_MAX_CHARS = 200;
const ID = /^[A-Za-z0-9._-]{1,64}$/u;
const GENERATION = /^[0-9]{1,9}$/u;
const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/u;
const IMAGE_DIGEST = /@(sha256:[0-9a-f]{64})(?![0-9a-f])/u;
const ENUM_VALUE = /^[A-Za-z0-9._:-]{1,80}$/u;
const FEATURE = /^[A-Za-z][A-Za-z0-9.]{0,63}$/u;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/u;
const GENERIC_FAILURE = "worker execution failed";

/** The value if it has the expected shape and the credential redaction leaves it alone; otherwise nothing. */
function checked(value: unknown, shape: RegExp): string | undefined {
  if (typeof value !== "string" || !shape.test(value) || redactText(value) !== value) return undefined;
  return value;
}

function write(sink: WorkerLogSink, level: WorkerLogLevel, fields: Record<string, unknown>): void {
  // Logging must never change what the worker does: a closed stdout or a bad sink is dropped.
  try {
    sink(level, JSON.stringify(defined(fields)));
  } catch { /* dropped on purpose */ }
}

function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

let cachedPiAiVersion: string | undefined;
/**
 * The installed pi-ai version. The package exports only its entry points (not package.json) and only for ESM, so neither
 * require nor a package.json import can find it; walk up the node_modules directories from here instead.
 */
export function readPiAiVersion(): string {
  if (cachedPiAiVersion !== undefined) return cachedPiAiVersion;
  cachedPiAiVersion = "unknown";
  try {
    for (let directory = dirname(fileURLToPath(import.meta.url)); ; directory = dirname(directory)) {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, "node_modules", "@earendil-works", "pi-ai", "package.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name === "@earendil-works/pi-ai") cachedPiAiVersion = checked(manifest.version, ENUM_VALUE) ?? "unknown";
        break;
      } catch { /* not in this directory */ }
      if (dirname(directory) === directory) break;
    }
  } catch { /* stays unknown */ }
  return cachedPiAiVersion;
}

let cachedWorkerVersion: string | undefined;
function readWorkerVersion(): string {
  if (cachedWorkerVersion !== undefined) return cachedWorkerVersion;
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version?: unknown };
    cachedWorkerVersion = checked(manifest.version, ENUM_VALUE) ?? "unknown";
  } catch {
    cachedWorkerVersion = "unknown";
  }
  return cachedWorkerVersion;
}

export interface WorkerStartedInput {
  /** Read for AGENTX_WORKSPACE_ID, AGENTX_SESSION_GENERATION, AGENTX_INSTANCE_ID and AGENTX_WORKER_IMAGE only. */
  env: Readonly<Record<string, string | undefined>>;
  containedRuntime: { readonly status: string; readonly reason?: string };
  /** The features /ping lists. */
  invocationFeatures: readonly string[];
}

/** One line, every boot, whatever the runtime state: an empty stream then means the worker never started, not that it was quiet. */
export function logWorkerStarted(sink: WorkerLogSink, input: WorkerStartedInput): void {
  const { env, containedRuntime } = input;
  const reason = containedRuntime.status === "ready" ? undefined : checked(containedRuntime.reason, ENUM_VALUE) ?? "unspecified";
  const imageDigest = typeof env.AGENTX_WORKER_IMAGE === "string" ? IMAGE_DIGEST.exec(env.AGENTX_WORKER_IMAGE)?.[1] : undefined;
  write(sink, "info", {
    component: "worker",
    event: "worker.started",
    workspaceId: checked(env.AGENTX_WORKSPACE_ID, ID),
    generation: checked(env.AGENTX_SESSION_GENERATION, GENERATION),
    instanceId: checked(env.AGENTX_INSTANCE_ID, INSTANCE_ID),
    workerVersion: readWorkerVersion(),
    imageDigest,
    containedRuntime: defined({ status: checked(containedRuntime.status, ENUM_VALUE) ?? "unknown", reason }),
    invocationFeatures: input.invocationFeatures.flatMap((feature) => checked(feature, FEATURE) ?? []),
    piAiVersion: readPiAiVersion(),
  });
}

export interface WorkerInvocationLog {
  finished(outcome: Exclude<WorkerInvocationOutcome, "failed">): void;
  failed(error: unknown): void;
}

/** Logs the start line now and returns the writers for the one finish or failure line. */
export function logInvocationStarted(sink: WorkerLogSink, invocation: WorkerInvocation): WorkerInvocationLog {
  const startedAt = performance.now();
  const durationMs = () => Math.max(0, Math.round(performance.now() - startedAt));
  const taskId = invocation.kind === "task" ? invocation.payload.workflowFeedbackReview?.taskId : undefined;
  const line = (event: string, rest: Record<string, unknown>) => ({
    component: "worker",
    event,
    kind: checked(invocation.kind, ENUM_VALUE) ?? "unknown",
    invocationId: checked(invocation.operationId, ID),
    taskId: checked(taskId, ID),
    ...rest,
  });
  write(sink, "info", line("invocation.started", {}));
  return {
    finished(outcome) {
      write(sink, "info", line("invocation.finished", { outcome, durationMs: durationMs() }));
    },
    failed(error) {
      write(sink, "error", line("invocation.failed", {
        outcome: "failed",
        durationMs: durationMs(),
        errorName: errorName(error),
        errorMessage: errorMessage(error),
      }));
    },
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? checked(error.name, ERROR_NAME) ?? "Error" : "Error";
}

/** Redacted first, then flattened to one line and cut, so the cut never leaves half a credential that the redaction would have caught. */
function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return GENERIC_FAILURE;
  // eslint-disable-next-line no-control-regex
  const flat = redactText(error.message).replace(/[\u0000-\u001f\u007f\s]+/gu, " ").trim();
  return flat === "" ? GENERIC_FAILURE : flat.slice(0, ERROR_MESSAGE_MAX_CHARS);
}
