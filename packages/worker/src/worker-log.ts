import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentXErrorCodeSchema, redactText, type WorkerInvocation } from "@agentx/contracts";

/**
 * Structured worker logs. The EC2 worker container ships stdout and stderr through docker's awslogs driver
 * (packages/worker/ec2/boot.sh), so one JSON object per line is what shows in the worker's CloudWatch stream.
 *
 * Nothing here prints a prompt, model output, repository content, a callback capability or a user's text. Every field
 * is chosen from a short list, and each value is checked against a strict shape or a fixed set (an id, a version, an
 * enum, an error code, a class label). A value that does not fit is left out, never printed.
 *
 * There is deliberately no error message field. A failure's message can carry a provider's echo of the prompt, a command's
 * output, a repository path or branch, or a token the credential redaction does not recognise, and this stream is readable
 * by operators. A failure is described by its code, a class label, an HTTP status and an exception name instead; the full
 * (redacted) message stays in the journal and the control plane's record.
 */

export type WorkerLogLevel = "info" | "error";
/** Writes one line. `error` lines go to stderr, the rest to stdout; docker ships both. */
export type WorkerLogSink = (level: WorkerLogLevel, line: string) => void;

export const consoleWorkerLog: WorkerLogSink = (level, line) => {
  if (level === "error") console.error(line);
  else console.log(line);
};

export type WorkerInvocationOutcome = "succeeded" | "cancelled" | "failed";

export const WORKER_ERROR_CLASSES = ["model-call", "command", "git", "config", "timeout", "internal"] as const;
export type WorkerErrorClass = (typeof WORKER_ERROR_CLASSES)[number];

const ID = /^[A-Za-z0-9._-]{1,64}$/u;
const GENERATION = /^[0-9]{1,9}$/u;
const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/u;
const IMAGE_DIGEST = /@(sha256:[0-9a-f]{64})(?![0-9a-f])/u;
const ENUM_VALUE = /^[A-Za-z0-9._:-]{1,80}$/u;
const FEATURE = /^[A-Za-z][A-Za-z0-9.]{0,63}$/u;
const EXCEPTION_NAME = /^[A-Z][A-Za-z0-9]{2,63}$/u;
/** Provider exceptions named in a model-call failure's text. A fixed list: any other word in that text could come from the prompt. */
const PROVIDER_EXCEPTION = /\b(ValidationException|ThrottlingException|AccessDeniedException|ModelTimeoutException|ServiceUnavailableException|InternalServerException|ModelErrorException|ModelNotReadyException|ModelStreamErrorException|ResourceNotFoundException|ServiceQuotaExceededException)\b/u;

/** The value if it has the expected shape and the credential redaction leaves it alone; otherwise nothing. */
function checked(value: unknown, shape: RegExp): string | undefined {
  if (typeof value !== "string" || !shape.test(value) || redactText(value) !== value) return undefined;
  return value;
}

/** The fields are built inside the guard too: logging must never change what the worker does, whatever fails in it. */
function write(sink: WorkerLogSink, level: WorkerLogLevel, fields: () => Record<string, unknown>): void {
  try {
    sink(level, JSON.stringify(defined(fields())));
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
  write(sink, "info", () => {
    const { env, containedRuntime } = input;
    const reason = containedRuntime.status === "ready" ? undefined : checked(containedRuntime.reason, ENUM_VALUE) ?? "unspecified";
    const imageDigest = typeof env.AGENTX_WORKER_IMAGE === "string" ? IMAGE_DIGEST.exec(env.AGENTX_WORKER_IMAGE)?.[1] : undefined;
    return {
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
    };
  });
}

export interface WorkerInvocationLog {
  finished(outcome: Exclude<WorkerInvocationOutcome, "failed">): void;
  failed(error: unknown): void;
}

const NO_LOG: WorkerInvocationLog = { finished() { /* logging is off */ }, failed() { /* logging is off */ } };

/** Logs the start line now and returns the writers for the one finish or failure line. Never throws. */
export function logInvocationStarted(sink: WorkerLogSink, invocation: WorkerInvocation): WorkerInvocationLog {
  try {
    const startedAt = performance.now();
    const durationMs = () => Math.max(0, Math.round(performance.now() - startedAt));
    const line = (event: string, rest: Record<string, unknown>) => {
      const taskId = invocation.kind === "task" ? invocation.payload.workflowFeedbackReview?.taskId : undefined;
      return {
        component: "worker",
        event,
        kind: checked(invocation.kind, ENUM_VALUE) ?? "unknown",
        invocationId: checked(invocation.operationId, ID),
        taskId: checked(taskId, ID),
        ...rest,
      };
    };
    write(sink, "info", () => line("invocation.started", {}));
    return {
      finished(outcome) {
        write(sink, "info", () => line("invocation.finished", { outcome, durationMs: durationMs() }));
      },
      failed(error) {
        write(sink, "error", () => line("invocation.failed", { outcome: "failed", durationMs: durationMs(), ...describeFailure(error) }));
      },
    };
  } catch {
    return NO_LOG;
  }
}

export interface WorkerFailureDescription {
  errorCode?: string;
  errorClass: WorkerErrorClass;
  httpStatus?: number;
  exceptionName?: string;
}

/**
 * Describes a failure without quoting it. The message is read only to pick a label from a fixed set and, for a model-call
 * failure, a provider exception name from a fixed list and an HTTP status number; none of its text is copied out.
 */
export function describeFailure(error: unknown): WorkerFailureDescription {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : "";
  const code = AgentXErrorCodeSchema.safeParse(record.code);
  const errorCode = code.success ? code.data : undefined;
  const errorClass = classify(error, message, errorCode);
  const name = error instanceof Error ? error.name : undefined;
  const exceptionName = name !== undefined && name !== "Error" && name !== "AgentXError" && EXCEPTION_NAME.test(name) && redactText(name) === name
    ? name
    : errorClass === "model-call" ? PROVIDER_EXCEPTION.exec(message)?.[1] : undefined;
  const metadata = typeof record.$metadata === "object" && record.$metadata !== null ? (record.$metadata as Record<string, unknown>).httpStatusCode : undefined;
  const status = [record.status, metadata].find(isHttpStatus)
    ?? (errorClass === "model-call" ? Number(/\b(?:status(?: code)?|HTTP)\D{0,3}([1-5]\d\d)\b/iu.exec(message)?.[1]) : undefined);
  return {
    ...(errorCode === undefined ? {} : { errorCode }),
    errorClass,
    ...(isHttpStatus(status) ? { httpStatus: status } : {}),
    ...(exceptionName === undefined ? {} : { exceptionName }),
  };
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function classify(error: unknown, message: string, code: string | undefined): WorkerErrorClass {
  if (/\bthe model call (?:failed|was aborted)\b/u.test(message)) return "model-call";
  if (error instanceof Error && (error.name === "TimeoutError" || /\b(?:timed out|ETIMEDOUT)\b/iu.test(message))) return "timeout";
  if (/\bexited \d+\b|\bLast lines:|\bcommand failed\b/u.test(message)) return "command";
  if (/\bgit\b|\bfatal: /u.test(message)) return "git";
  if (code === "CONFIG_INVALID") return "config";
  return "internal";
}
