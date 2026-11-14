// Live interaction A2: "peek", a read-only look at a running task's working tree for an Ask. The broker cannot sign a worker call itself (only the dispatcher may), so it asks the dispatcher
// synchronously (`DispatcherPeekEvent`), which signs one `peek` invocation, posts it to the worker that holds the workspace, and answers on the same request. The worker reads the repository
// through its isolated Git (no write, no hook, no config of the candidate), redacts what it read, and cuts it to fixed sizes. Nothing here can carry a command, a path to read or a budget.
// This file imports no Node module (the contracts are shared with the browser entry).
import { z } from "zod";

/** The most bytes of patch text a peek returns, in all (the Ask context takes at most this much of a patch). */
export const PEEK_PATCH_MAX_BYTES = 32_768;
/**
 * A peek has no callback: the worker never calls the broker for it. The invocation schema still requires a 32-character capability, so the broker puts this fixed filler there. It is not a capability
 * (no route accepts it), so a peek hands the worker no authority.
 */
export const PEEK_NO_CALLBACK_CAPABILITY = "peek-has-no-callback-capability-".padEnd(64, "-");
/** The most changed files (and untracked names) a peek lists. */
export const PEEK_FILES_MAX = 200;

export const PeekPayloadSchema = z.object({
  /** How much patch text the caller will take; the worker never returns more (and never more than PEEK_PATCH_MAX_BYTES). */
  maxPatchBytes: z.number().int().min(1).max(PEEK_PATCH_MAX_BYTES),
}).strict();
export type PeekPayload = z.infer<typeof PeekPayloadSchema>;

const PeekPathSchema = z.string().min(1).max(1_024);
const PeekRepositorySchema = z.string().min(1).max(200);

export const PeekAnswerSchema = z.object({
  accepted: z.literal(true),
  /** `peeked`: the files and patch below. `unavailable`: the workspace could not be read now (not prepared, not a plain repository, Git failed); the caller falls back to the pull request's diff. */
  outcome: z.enum(["peeked", "unavailable"]),
  files: z.array(z.object({ repository: PeekRepositorySchema, path: PeekPathSchema, additions: z.number().int().min(0), deletions: z.number().int().min(0), binary: z.boolean().optional() }).strict()).max(PEEK_FILES_MAX),
  untracked: z.array(z.object({ repository: PeekRepositorySchema, path: PeekPathSchema }).strict()).max(PEEK_FILES_MAX),
  /** Redacted unified diff text, at most `maxPatchBytes` bytes; files whose names look like credentials have counts but no patch. */
  patch: z.string().max(PEEK_PATCH_MAX_BYTES * 4),
  patchTruncated: z.boolean(),
  filesTruncated: z.boolean(),
}).strict().refine((answer) => new TextEncoder().encode(answer.patch).length <= PEEK_PATCH_MAX_BYTES, { message: "the patch is longer than a peek may return", path: ["patch"] });
export type PeekAnswer = z.infer<typeof PeekAnswerSchema>;

/**
 * What the broker sends the dispatcher Lambda (direct invoke, never through the queue). The invocation is the broker-built `peek` worker invocation (strict, validated by `WorkerInvocationSchema`
 * in the dispatcher); it is not repeated in this file so that this file stays free of protocol.ts.
 */
export const DISPATCHER_PEEK_EVENT_KIND = "task-peek" as const;
export interface DispatcherPeekEvent { kind: typeof DISPATCHER_PEEK_EVENT_KIND; invocation: unknown }
export function isDispatcherPeekEvent(value: unknown): value is DispatcherPeekEvent {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)["kind"] === DISPATCHER_PEEK_EVENT_KIND;
}

/** Why the dispatcher gave no peek. Every one is final for this Ask: the caller uses the pull request's diff instead. */
export const PEEK_REFUSALS = ["not_running", "no_worker", "old_worker", "stale", "invalid", "unavailable"] as const;
export const DispatcherPeekReplySchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("peeked"), answer: PeekAnswerSchema }).strict(),
  z.object({ outcome: z.enum(PEEK_REFUSALS) }).strict(),
]);
export type DispatcherPeekReply = z.infer<typeof DispatcherPeekReplySchema>;
