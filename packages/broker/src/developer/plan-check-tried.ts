import type { PlanDryRunClass } from "@agentx/contracts";

/**
 * DRYMSG: what a plan card says of a proposed check's try on the unchanged code, from the dry run's fixed class alone. Pure, and every sentence is fixed
 * text: nothing a worker, a command or an error said can reach it (the record keeps classes, never output).
 */

/** The classes that mean the check was not tried at all (as opposed to tried and passed, failed or could not run). */
export type PlanNotTriedClass = Extract<PlanDryRunClass, "not-checked" | "not-run">;

/** `not-checked`: the dry run only tries file checks and plain grep/test; `not-run`: it was meant to try the check but could not. */
export const NOT_TRIED_SENTENCES: Readonly<Record<PlanNotTriedClass, string>> = {
  "not-checked": "not tried on current code: it needs tools the sandbox does not run",
  "not-run": "not tried on current code: it ran out of time or the sandbox could not start it",
};

/** Appended to a tried check's result when the plan gave no `expectOnBase`: says why there is no "as expected". */
export const NO_EXPECTATION_SUFFIX = ", no expectation given";

/** The checks a dry run did not try, by check ID, with the fixed class; checks that were tried are left out. */
export function notTriedOf(tried: ReadonlyArray<{ checkId: string; class: PlanDryRunClass }>): Record<string, PlanNotTriedClass> {
  return Object.fromEntries(tried.flatMap((entry) => (entry.class === "not-checked" || entry.class === "not-run" ? [[entry.checkId, entry.class] as const] : [])));
}
