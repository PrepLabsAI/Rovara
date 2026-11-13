// TE-F3-b: a hidden round runs in a FIXED WALL-CLOCK SLOT. While a hidden round runs, the working sandbox is paused, so the coding agent can see how long it was paused, and the runner decides how long it runs: a runner could stretch
// or shorten the round to send bits ("long" or "short"). The slot closes that channel: every hidden round, whatever it did (finished, crashed, hit the ledger's limit, ran out of time), returns at the SAME moment, `slotMs` after it
// started, and a runner that is still going then is told to stop (an abort signal) and the round is "not run". The clock is injected.
import type { EvalClock } from "@agentx/contracts";
import { completeGatedEvalRound, planGatedEvalRound, resolveGatedBases, type GatedEvalRoundInput, type GatedEvalRoundOutput, type GatedEvalRoundPlan } from "./eval-gate-round.js";
import { evalGateAgentFeedback, evalGateStopped } from "@agentx/contracts";

/** The default slot: two minutes (owner, 2026-11-13). Only the NEW-code hidden run is inside it; the old-code rounds run before. A project may set its own; the runner must fit in it. */
export const HIDDEN_ROUND_SLOT_MS_DEFAULT = 2 * 60_000;
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
 * The gated round with ONLY the new-code hidden run in the fixed slot. Before the slot, outside it: the trigger and budget, the ledger's check (counted here), and the old-code baselines (`resolveGatedBases`: they run on Rovara's own checkout of
 * main, so their length says nothing about the agent's code and must not eat the slot). Inside the slot: the runner (`runner`, handed the plan and the abort signal: the caller's throwaway workspace copy, paused working sandbox, sealed
 * sandbox) and the completion. A round that ran out of time, or whose runner failed, is "not run". At the slot's end, `killRunner` is awaited BEFORE this returns (the caller resumes the working sandbox only after it), whatever the
 * round did. A round that needs no eval, or stops before the runner (no holdout, check limit used up, a base that could not be used), returns at once: it touches nothing the agent's runner decided.
 */
export async function runGatedEvalRoundInSlot(
  input: GatedEvalRoundInput,
  runner: (plan: Extract<GatedEvalRoundPlan, { status: "ready" }>, signal: AbortSignal) => Promise<void>,
  options: { readonly slotMs: number; readonly clock: EvalClock; /** REQUIRED: kills the sealed runner for certain (its container). Awaited at the slot's end, before the working sandbox may resume. */ readonly killRunner: () => Promise<void> },
): Promise<GatedEvalRoundOutput> {
  // A hidden round with no way to kill its sealed runner is not started (and no check is counted): the working sandbox could not safely resume.
  if (typeof options.killRunner !== "function") {
    const gate = evalGateStopped("runner_kill_missing");
    return { status: "done", gate, feedback: evalGateAgentFeedback(gate), cache: { visible: "not_used" } };
  }
  const plan = await planGatedEvalRound(input);
  if (plan.status === "stopped") return plan.output;
  const resolved = await resolveGatedBases(input, plan);
  if (!resolved.ok) return resolved.output;
  const slot = await runInHiddenSlot({
    slotMs: options.slotMs, clock: options.clock,
    run: async (signal) => {
      await runner(plan, signal);
      return completeGatedEvalRound(input, plan, resolved.bases);
    },
  });
  try {
    await options.killRunner();
  } catch {
    // A runner that could not be killed is the caller's alarm; the round is not trusted.
    const gate = evalGateStopped("hidden_round_timed_out");
    return { status: "done", gate, feedback: evalGateAgentFeedback(gate), cache: resolved.bases.cache };
  }
  if (slot.status === "done") return slot.value;
  const gate = evalGateStopped(slot.status === "timed_out" ? "hidden_round_timed_out" : "inputs_unreadable");
  return { status: "done", gate, feedback: evalGateAgentFeedback(gate), cache: resolved.bases.cache };
}
