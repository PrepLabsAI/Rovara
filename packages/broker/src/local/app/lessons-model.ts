// The model and the spend path lessons learn through, on one laptop. The learning call is one request with no tools to the provider the install chose for its steps (the same call an Ask makes: `ask-model.ts`),
// paid by the owner's own key; there is no Rovara-paid route (decision: diagnosis and learning run on the customer's connected provider). The call asks the `admission` point first (`LearningSpend`), and what it used is
// recorded through the `metering` point, so a company that registers a limit there holds learning to it.
import type { Admission, Metering } from "@agentx/contracts";
import { createLocalAskModel, type LocalAskModelOptions } from "../ask-model.js";
import { LearningRefusal } from "../../lessons/pause.js";
import { currentLearningAttempt, learningCallMayStart, noteLearningFault } from "../../lessons/learning-deadline.js";
import type { LearningSpend, PipelineModel } from "../../lessons/ports.js";

/** The longest one learning call is waited for when no attempt of the reflection worker sets a sooner deadline. */
export const LEARNING_CALL_TIMEOUT_MS = 90_000;

/** The reasons a call was refused before anything was sent: nothing is spent and the project says why learning paused. */
const NOT_SET_UP: ReadonlySet<string> = new Set(["no_model", "provider_not_set_up", "no_credential", "sign_in_failed"]);

export interface LocalPipelineModelOptions extends LocalAskModelOptions {
  metering?: Metering | undefined;
  newEntryId?: () => string;
}

export function createLocalPipelineModel(options: LocalPipelineModelOptions): PipelineModel {
  const answerer = createLocalAskModel(options);
  const now = options.now ?? Date.now;
  let counter = 0;
  return {
    async complete(request) {
      if (answerer.available !== undefined && !(await answerer.available())) throw new LearningRefusal("no_provider", "No AI provider is connected, so nothing can be learned yet.");
      if (!learningCallMayStart(now(), 1_000)) { noteLearningFault("retryable"); throw new Error("the learning call could not start before its deadline"); }
      const attempt = currentLearningAttempt();
      // The mark that a call may now reach the provider: after it, the reflection is never run again. A mark that cannot be made means the call is not made.
      await attempt?.callStarting?.();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(LEARNING_CALL_TIMEOUT_MS, attempt === undefined ? LEARNING_CALL_TIMEOUT_MS : attempt.deadlineAt - now())));
      timer.unref?.();
      const stop = (): void => controller.abort();
      attempt?.signal?.addEventListener("abort", stop, { once: true });
      try {
        const answered = await answerer.answer({ context: request.system, question: request.user, maxOutputTokens: request.maxOutputTokens, signal: controller.signal, taskId: "lessons" });
        let costUsd = 0;
        if (answered.usage !== undefined && options.metering !== undefined) {
          const usage = { provider: answered.usage.provider, modelId: answered.usage.modelId, tokens: { input: answered.usage.input, output: answered.usage.output, cacheRead: answered.usage.cacheRead, cacheWrite: answered.usage.cacheWrite } };
          counter += 1;
          const recorded = await options.metering.record({ companyId: options.companyId, entryId: options.newEntryId?.() ?? `learning:${String(now())}:${String(counter)}`, at: new Date(now()).toISOString(), usage, ...(request.project === undefined ? {} : { projectName: request.project }) }).catch(() => undefined);
          if (recorded?.cost !== null && recorded?.cost !== undefined) costUsd = recorded.cost.micros / 1_000_000;
        }
        return { text: answered.text, costUsd, model: answered.model };
      } catch (error) {
        const reason = (error as { reason?: unknown } | null)?.reason;
        if (typeof reason === "string" && NOT_SET_UP.has(reason)) {
          // Nothing was sent: the call is refused with the reason learning pauses for. The mark that a call started is taken back.
          await attempt?.callNotSent?.().catch(() => undefined);
          throw new LearningRefusal("no_provider", "No AI provider is connected, so nothing can be learned yet.");
        }
        // The call may have reached the provider: it counts as made, and the reflection is not run again.
        noteLearningFault("final");
        throw error;
      } finally {
        clearTimeout(timer);
        attempt?.signal?.removeEventListener("abort", stop);
      }
    },
  };
}

/** The spend look over the `admission` point: a call is admitted when the install's admission says so (Code's default allows everything; a company's own limit refuses). It holds nothing and writes nothing. */
export function createLocalLearningSpend(admission: Admission, companyId: string): LearningSpend {
  const admit = async (estimateUsd: number): Promise<boolean> => {
    const decision = await admission.admit({ companyId, idempotencyKey: `learning.look:${String(Date.now())}:${Math.random().toString(36).slice(2)}`, action: "learning.call", estimate: { cost: { micros: Math.round(estimateUsd * 1_000_000), currency: "USD" } } });
    return decision.allowed;
  };
  return {
    admit: (_workspaceId, estimateUsd) => admit(estimateUsd),
    async look(_workspaceId, estimateUsd) {
      try { return (await admit(estimateUsd)) ? "ok" : "month_full"; } catch { return "unreadable"; }
    },
  };
}
