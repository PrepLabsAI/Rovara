// The model of an answer on this computer (lead 4, J1): the existing Ask model path (`createLocalAskModel`, local/ask-model.ts), one request with no tools to the provider the install chose, signed by the
// broker itself; this adapter only gives it the answer service's seam. The key never reaches the service. A price (the install's price table) lets a turn be refused BEFORE it is made when its worst case is
// over what the answer may still spend, and gives each turn a cost; a model with no price is not free: the service's token ceiling stands in for the dollar one.
import type { ModelIdentifier } from "@agentx/contracts";
import { AnswerModelRefused, type AnswerModel, type AnswerModelSession } from "../core/answers/ports.js";
import { costMicrosOf, type ModelPrices } from "../core/cost/price-table.js";
import type { AskAnswerer } from "../core/sessions/ask.js";

export interface LocalAnswerModelOptions {
  answerer: AskAnswerer;
  /** The model the install's steps use now; undefined: none is set up. Only used to price a turn before it is made. */
  choice: () => Promise<{ provider: string; model: string } | undefined>;
  prices?: Pick<ModelPrices, "findCap"> | undefined;
}

const CENT_MICROS = 10_000;

export function createLocalAnswerModel(options: LocalAnswerModelOptions): AnswerModel {
  const centsOf = async (model: ModelIdentifier, tokens: { input: number; output: number }): Promise<number | undefined> => {
    const found = options.prices?.findCap(model);
    if (found === undefined || found.currency !== "USD") return undefined;
    return Math.ceil(costMicrosOf(found.price, { ...tokens, cacheRead: 0, cacheWrite: 0 }) / CENT_MICROS);
  };
  return {
    async available() {
      try { return options.answerer.available === undefined ? true : await options.answerer.available(); } catch { return false; }
    },
    async open(): Promise<AnswerModelSession> {
      return {
        async complete(turn) {
          const choice = await options.choice().catch(() => undefined);
          if (choice === undefined) throw new AnswerModelRefused("not_set_up");
          // The worst case of this turn at the model's price: what is read (about four bytes a token) and the most that may be written.
          const worst = await centsOf({ provider: choice.provider, modelId: choice.model }, { input: Math.ceil(Buffer.byteLength(turn.system + turn.transcript, "utf8") / 4), output: turn.maxOutputTokens });
          if (worst !== undefined && worst > turn.remainingCents) throw new AnswerModelRefused("over_budget");
          let reply;
          try {
            reply = await options.answerer.answer({ context: turn.system, question: turn.transcript, maxOutputTokens: turn.maxOutputTokens, signal: turn.signal, taskId: "answers" });
          } catch (error) {
            // A failure is a name (`AskModelProblem.reason`), never the provider's words; "no model" and "no credential" are not-set-up, anything else is a fault.
            const reason = (error as { reason?: unknown } | null)?.reason;
            throw new AnswerModelRefused(reason === "no_model" || reason === "provider_not_set_up" || reason === "no_credential" ? "not_set_up" : "unavailable");
          }
          const used = reply.usage;
          // A reply that says nothing of what it used is charged what it could have cost at the most, never nothing.
          const costCents = used === undefined ? worst : await centsOf({ provider: used.provider, modelId: used.modelId }, { input: used.input + used.cacheRead + used.cacheWrite, output: used.output });
          return { text: reply.text, model: reply.model, ...(used === undefined ? {} : { tokens: { input: used.input + used.cacheRead + used.cacheWrite, output: used.output } }), ...(costCents === undefined ? {} : { costCents }) };
        },
        // A laptop has no reservation to settle: the install's own key is billed by the provider.
        async finish() { /* nothing held */ },
      };
    },
  };
}
