// Lane L6a, task flow core: small shared helpers (clock, ids, log, hashing; the default prompts are in step-prompts.ts).
import { createHash, randomUUID } from "node:crypto";
import { PLAN_WHY_REQUEST_MAX_CHARS, canonicalJson, redactText, taskTitle } from "@agentx/contracts";
import { DEFAULT_DISPATCH_QUEUE, DEFAULT_LIMITS, type TaskFlowDeps } from "./deps.js";

export const iso = (deps: Pick<TaskFlowDeps, "now">): string => (deps.now?.() ?? new Date()).toISOString();
export const newId = (deps: Pick<TaskFlowDeps, "newId">): string => (deps.newId ?? randomUUID)();
export const log = (deps: Pick<TaskFlowDeps, "log">, entry: Record<string, unknown>): void => (deps.log ?? (() => undefined))({ component: "task-flow", ...entry });
export const dispatchQueueName = (deps: Pick<TaskFlowDeps, "dispatchQueue">): string => deps.dispatchQueue ?? DEFAULT_DISPATCH_QUEUE;
export const limitsOf = (deps: Pick<TaskFlowDeps, "limits">): { member: number; organization: number } => deps.limits ?? DEFAULT_LIMITS;

/** The sha-256 of the canonical JSON of a value: the request's identity for idempotency. */
export function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export { DEFAULT_PROMPTS } from "./step-prompts.js";

/**
 * Redacted first, so the cut cannot leave half a token. Cut to at most `max` UTF-16 code units, never between the two halves of a
 * surrogate pair (Cloud's `cutText`).
 */
export function cutText(value: string, max: number): string {
  const text = redactText(value).trim();
  if (text.length <= max) return text;
  let end = max - 3;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}...`;
}

/** The title, redacted before it is cut: it is stored in the task and its index row and shown in limit messages (FR-030). */
export const redactedTitle = (request: { instructions: string; title?: string | undefined }): string =>
  taskTitle(redactText(request.instructions), request.title === undefined ? undefined : redactText(request.title));

/** The owner's request as a task keeps it: redacted and cut to the plan's "why" limit. */
export const storedRequestText = (instructions: string): string => cutText(instructions, PLAN_WHY_REQUEST_MAX_CHARS);
