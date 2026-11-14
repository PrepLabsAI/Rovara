// A spent AI budget, as the model proxy reports it (docs/learnings/model-proxy-spike.md, question 3) and as the task
// ends because of it. Pi's own error drops the proxy's body, so the body is read once, classified and discarded here.
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE } from "@agentx/contracts";

/**
 * Whose budget ran out: the organisation's (Team=), the member's (User=) or the task's own key (Key=) as the proxy reports them; the control plane's refusal
 * to mint a key also names the project's, the agent's, a chain's (Plan 4) and a member's testing allowance (the budget levels of Plan 3).
 */
export type ModelBudgetScope = "org" | "member" | "task" | "project" | "agent" | "chain" | "test";

/** The model's budget ran out; a task that hits it ends, and the owner can raise the budget and continue. */
export class ModelBudgetExhaustedError extends Error {
  constructor(readonly scope: ModelBudgetScope) {
    super(BUDGET_EXHAUSTED_FAILURE_MESSAGE);
    this.name = "ModelBudgetExhaustedError";
  }
}

/**
 * The scope of a proxy 422 `budget_exceeded` body, or undefined for any other answer. The three bodies share their type and
 * code and differ only in their message: `Budget has been exceeded! Team=...`, `ExceededBudget: User=...` and
 * `Budget has been exceeded! Key=...`. Nothing of the body is kept.
 */
export function budgetScopeOfProxyBody(status: number, body: string): ModelBudgetScope | undefined {
  if (status !== 422) return undefined;
  let error: unknown;
  try { error = (JSON.parse(body) as { error?: unknown }).error; } catch { return undefined; }
  if (error === null || typeof error !== "object") return undefined;
  const { type, message } = error as { type?: unknown; message?: unknown };
  if (type !== "budget_exceeded" || typeof message !== "string") return undefined;
  if (/^Budget has been exceeded! Team=/u.test(message)) return "org";
  if (/^ExceededBudget: User=/u.test(message)) return "member";
  if (/^Budget has been exceeded! Key=/u.test(message)) return "task";
  return undefined;
}

const MARKER = /^AI budget exhausted \((org|member|task|project|agent|chain|test)\)$/u;

/** What a stream's error message says when the budget ran out: Pi carries only text, so the scope travels in it. */
export const budgetExhaustedMarker = (scope: ModelBudgetScope): string => `AI budget exhausted (${scope})`;

/** The error a stream message stands for, when it is a budget one (see {@link budgetExhaustedMarker}). */
export function budgetExhaustedFromMarker(message: string | undefined): ModelBudgetExhaustedError | undefined {
  const scope = message === undefined ? undefined : MARKER.exec(message)?.[1];
  return scope === undefined ? undefined : new ModelBudgetExhaustedError(scope as ModelBudgetScope);
}

// ---- a model no source serves (Plan 3 Task 26)

/** The control plane refused to issue a key because no AI source serves the step's model; its words say what to do. The task ends on it, with those words. */
export class ModelNotAllowedError extends Error {
  constructor(readonly text: string) {
    super(text);
    this.name = "ModelNotAllowedError";
  }
}

const NOT_ALLOWED_MARKER = /^Model not allowed: ([^\p{Cc}]{1,300})$/u;

/** What a stream's error message says when the control plane refused the model: Pi carries only text, so the words travel in it. */
export const modelNotAllowedMarker = (text: string): string => `Model not allowed: ${text}`;

/** The error a stream message stands for, when it is a refusal of the model (see {@link modelNotAllowedMarker}). */
export function modelNotAllowedFromMarker(message: string | undefined): ModelNotAllowedError | undefined {
  const text = message === undefined ? undefined : NOT_ALLOWED_MARKER.exec(message)?.[1];
  return text === undefined ? undefined : new ModelNotAllowedError(text);
}
