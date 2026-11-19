// Lane H: "may this task start?" over the `admission` point. Only `task.start` asks; every other action is the install's own admission, untouched.
// Stricter only: the install's own refusal stands without asking; an allow is then put to the company rules service. The question is never cached. With no
// answer, the start is held and the same signed question is sent again for up to 240 s in all (under the server request timeout), then refused with fixed words: nothing has started.
import { POLICY_HOOK_TIMEOUT_SECONDS, POLICY_HOOK_WORDS, type Admission, type AdmissionDecision, type AdmissionRequest, type PolicyHookStartQuestion } from "@agentx/contracts";
import type { PolicyHookClient } from "./client.js";

/**
 * The whole hold, last attempt included, stays at or under 240 s (controller, 2026-11-15): under Node's 300 s request timeout, so the person always gets the
 * fixed words and never a dropped connection. The contract's 300 s (`POLICY_HOOK_START_HOLD_SECONDS`) is the most any asker may hold.
 */
export const POLICY_HOOK_START_HOLD_CAP_MS = 240_000;
export const POLICY_HOOK_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1_000, 2_000, 4_000, 8_000, 15_000, 30_000]);

export interface PolicyHookAdmissionOptions {
  /** How long a start is held while the service does not answer, last attempt included. Default and most: 240 s. */
  holdMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const NO_ANSWER: AdmissionDecision = Object.freeze({ allowed: false, code: "company_rules_no_answer", message: POLICY_HOOK_WORDS.startNoAnswer, retryAfterSeconds: 60 });
const REFUSED: AdmissionDecision = Object.freeze({ allowed: false, code: "company_rules_refused", message: POLICY_HOOK_WORDS.startRefused });
const UNASKABLE: AdmissionDecision = Object.freeze({ allowed: false, code: "company_rules_unaskable", message: POLICY_HOOK_WORDS.startRefused });

function startQuestion(request: AdmissionRequest): PolicyHookStartQuestion {
  const cost = request.estimate?.cost;
  return {
    cid: request.companyId,
    pid: request.projectName ?? "",
    ...(request.actor === undefined ? {} : { per: request.actor.personId }),
    tid: request.subject?.type === "task" ? request.subject.id : "",
    ...(request.taskStart?.path === undefined ? {} : { path: request.taskStart.path }),
    ...(cost !== undefined && cost.currency === "USD" ? { estUsdMicros: cost.micros } : {}),
    ...(request.estimate?.tokens === undefined ? {} : { estTokens: request.estimate.tokens }),
  };
}

export function withPolicyHookAdmission(base: Admission, hook: PolicyHookClient, options: PolicyHookAdmissionOptions = {}): Admission {
  const asked = options.holdMs;
  const holdMs = asked !== undefined && Number.isFinite(asked) && asked >= 0 ? Math.min(asked, POLICY_HOOK_START_HOLD_CAP_MS) : POLICY_HOOK_START_HOLD_CAP_MS;
  // Each attempt may take up to the request timeout; the next one starts only if it can end inside the hold.
  const attemptMs = POLICY_HOOK_TIMEOUT_SECONDS * 1000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function ask(request: AdmissionRequest): Promise<AdmissionDecision | undefined> {
    const prepared = await hook.prepare("start", startQuestion(request));
    if (prepared === undefined) return UNASKABLE;
    const started = now();
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const result = await hook.send(prepared);
      if (result.answered) {
        await hook.audit(prepared, { answered: true, allow: result.answer.allow, attempts });
        return result.answer.allow ? undefined : REFUSED;
      }
      const delay = POLICY_HOOK_RETRY_DELAYS_MS[Math.min(attempts - 1, POLICY_HOOK_RETRY_DELAYS_MS.length - 1)]!;
      if (now() - started + delay + attemptMs > holdMs) {
        await hook.audit(prepared, { answered: false, attempts });
        return NO_ANSWER;
      }
      await sleep(delay);
    }
  }

  return {
    ...(base.enforcesCost === undefined ? {} : { enforcesCost: base.enforcesCost }),
    async admit(request) {
      const decision = await base.admit(request);
      if (request.action !== "task.start" || !decision.allowed) return decision;
      const refusal = await ask(request);
      if (refusal === undefined) return decision;
      if (decision.reservationId !== undefined) await base.release(decision.reservationId).catch(() => undefined);
      return refusal;
    },
    async stage(request) {
      const staged = await base.stage(request);
      if (request.action !== "task.start" || !staged.decision.allowed) return staged;
      const refusal = await ask(request);
      if (refusal === undefined) return staged;
      // A refused decision has no steps: nothing the install's own admission staged is committed, and its reservation is given back.
      if (staged.decision.reservationId !== undefined) await base.release(staged.decision.reservationId).catch(() => undefined);
      return { decision: refusal, items: [] };
    },
    settle: (reservationId, actual) => base.settle(reservationId, actual),
    release: (reservationId) => base.release(reservationId),
  };
}
