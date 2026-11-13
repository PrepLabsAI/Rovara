// TE-F3-b: a hidden round runs in a FIXED WALL-CLOCK SLOT. While a hidden round runs, the working sandbox is paused, so the coding agent can see how long it was paused, and the runner decides how long it runs: a runner could stretch
// or shorten the round to send bits ("long" or "short"). The slot closes that channel: every hidden round, whatever it did (finished, crashed, hit the ledger's limit, ran out of time), returns at the SAME moment, `slotMs` after it
// started, and a runner that is still going then is told to stop (an abort signal) and the round is "not run". The clock is injected.
import type { EvalClock } from "@agentx/contracts";
import { completeGatedEvalRound, planGatedEvalRound, type GatedEvalRoundInput, type GatedEvalRoundOutput, type GatedEvalRoundPlan } from "./eval-gate-round.js";
import { evalGateAgentFeedback, evalGateStopped } from "@agentx/contracts";

/** The default slot: ten minutes. A project may set its own; the runner must fit in it. */
export const HIDDEN_ROUND_SLOT_MS_DEFAULT = 10 * 60_000;
/** The shortest and longest slot a caller may ask for (a slot of 0 would not pad anything). */
export const HIDDEN_ROUND_SLOT_MS_MIN = 1;
export const HIDDEN_ROUND_SLOT_MS_MAX = 60 * 60_000;

export type HiddenSlotResult<T> = { readonly status: "done"; readonly value: T } | { readonly status: "failed" } | { readonly status: "timed_out" };

/** Runs `run` and returns exactly `slotMs` after the start: early when it finished early (after waiting out the rest), at the slot's end (aborting it) when it did not finish. */
export async function runInHiddenSlot<T>(args: { readonly slotMs: number; readonly clock: EvalClock; readonly run: (signal: AbortSignal) => Promise<T> }): Promise<HiddenSlotResult<T>> {
  const slotMs = Number.isSafeInteger(args.slotMs) ? Math.min(HIDDEN_ROUND_SLOT_MS_MAX, Math.max(HIDDEN_ROUND_SLOT_MS_MIN, args.slotMs)) : HIDDEN_ROUND_SLOT_MS_DEFAULT;
  const started = args.clock.now();
  const controller = new AbortController();
  const work: Promise<HiddenSlotResult<T>> = args.run(controller.signal).then((value) => ({ status: "done" as const, value }), () => ({ status: "failed" as const }));
  const limit: Promise<HiddenSlotResult<T>> = args.clock.sleep(slotMs).then(() => ({ status: "timed_out" as const }));
  const first = await Promise.race([work, limit]);
  if (first.status === "timed_out") {
    controller.abort();
    return first;
  }
  const left = slotMs - (args.clock.now() - started);
  if (left > 0) await args.clock.sleep(left);
  return first;
}

/**
 * The gated round with its hidden part in a fixed slot: the plan (the ledger's check is taken here), the runner (`runner`, handed the plan and the abort signal: the caller's throwaway workspace copy, paused working sandbox, sealed
 * sandbox) and the completion, all inside the slot. A round that ran out of time, or whose runner failed, is "not run". A round that needs no eval (the trigger) returns at once: it touches no hidden set.
 */
export async function runGatedEvalRoundInSlot(input: GatedEvalRoundInput, runner: (plan: Extract<GatedEvalRoundPlan, { status: "ready" }>, signal: AbortSignal) => Promise<void>, options: { readonly slotMs: number; readonly clock: EvalClock }): Promise<GatedEvalRoundOutput> {
  if (!input.trigger.needed) return { status: "skipped", reason: input.trigger.reason };
  const slot = await runInHiddenSlot({
    slotMs: options.slotMs, clock: options.clock,
    run: async (signal) => {
      const plan = await planGatedEvalRound(input);
      if (plan.status === "stopped") return plan.output;
      await runner(plan, signal);
      return completeGatedEvalRound(input, plan);
    },
  });
  if (slot.status === "done") return slot.value;
  const gate = evalGateStopped(slot.status === "timed_out" ? "hidden_round_timed_out" : "inputs_unreadable");
  return { status: "done", gate, feedback: evalGateAgentFeedback(gate), cache: { visible: "not_used" } };
}
