// Engine host (lane E2): what must hold before the root hands out a company's runtime with an area switched on. Each blocker is a REQUIRED check, in the spirit of the registry's never-default
// rule: a deployment that has not wired what a blocker needs gets a refused switch (`CoreSwitchBlockedError`, by id), never a core that runs on a guess. The earlier hosted line kept these as a
// list for the owner beside its parity tests; on Code they are checked at run time, in `runtimeFor`, next to the missing-service check.
//
//   honest-ci (merge)  The core always reports honest CI states: CI that cannot be read is `unreadable`, a required check nothing has run is `required_missing`, and "no CI" never counts as a
//                      pass except where the project says it does not rely on CI (`sandbox_only`). Whether a draft may leave draft rests on the project's own CI mode, so the deployment must
//                      hand in the reader of that mode (`ciReporting`), the one its merge tracking and its task readers use. There is no default mode: a reader that is missing is a
//                      refused switch, and an answer that is not one of the four modes (or a reader that throws) is a fixed refusal at use, never `DEFAULT_CI_MODE`.
//
// Asked where it matters: honest CI when the merge area is on for the company, or when the runtime runs merge tracking at all (a drained company's held tasks are still tracked, and a pass
// there would mark ready on a guessed mode). A company served only for its held flow tasks, with no merge tracking, is not asked.
import type { ProjectCiMode, TrackedTask } from "../core/merge/merge-tracking.js";
import type { CoreArea } from "./flags.js";

/** The deployment's CI reporting: the project's own CI mode reader. `honest` must be exactly `true`: the deployment says its task readers show the honest states as they are. */
export interface CiReporting {
  honest: true;
  ciMode(task: TrackedTask): ProjectCiMode | Promise<ProjectCiMode>;
}

/** The validated wrapper the runtime holds: `ciMode` always answers one of the four modes, or rejects with fixed words. */
export interface CheckedCiReporting {
  readonly honest: true;
  ciMode(task: TrackedTask): Promise<ProjectCiMode>;
}

export interface CoreSwitchBlocker {
  readonly id: string;
  /** The area whose switch-on it blocks. */
  readonly area: CoreArea;
  /** In plain words, for whoever runs the install. Fixed. */
  readonly words: string;
  /** Who wires what it needs. */
  readonly owner: string;
}

export const CORE_SWITCH_BLOCKERS: readonly CoreSwitchBlocker[] = Object.freeze([
  Object.freeze({
    id: "honest-ci", area: "merge" as const,
    words: "The core reports CI honestly (unreadable and missing required checks are shown as such), so the deployment must pass the project's own CI mode reader before merge tracking runs on the core.",
    owner: "the deployment's wiring (lane E2), with the project CI mode store",
  }),
]);

export const CI_MODE_UNREADABLE_WORDS = "the project's CI mode could not be read";
export const SWITCH_BLOCKED_WORDS = "the core engine cannot be switched on for this company yet";

const CI_MODES: ReadonlySet<unknown> = new Set<unknown>(["sandbox_only", "their_ci_watch", "their_ci_fix", "rovara_real_run"] satisfies ProjectCiMode[]);

/** The deployment's CI reporting, checked at run time. Undefined unless `honest` is exactly `true` and `ciMode` is a function. The wrapper never echoes what the reader said or threw. */
export function checkedCiReporting(given: unknown): CheckedCiReporting | undefined {
  if (given === null || typeof given !== "object") return undefined;
  const candidate = given as { honest?: unknown; ciMode?: unknown };
  if (candidate.honest !== true || typeof candidate.ciMode !== "function") return undefined;
  const reader = candidate.ciMode as (task: TrackedTask) => unknown;
  return Object.freeze({
    honest: true as const,
    async ciMode(task: TrackedTask): Promise<ProjectCiMode> {
      let answer: unknown;
      try { answer = await reader.call(given, task); } catch { throw new Error(CI_MODE_UNREADABLE_WORDS); }
      if (!CI_MODES.has(answer)) throw new Error(CI_MODE_UNREADABLE_WORDS);
      return answer as ProjectCiMode;
    },
  });
}

/** The ids of the blockers that stand for this runtime, given the areas switched on for its company. Empty: nothing blocks. */
export function switchBlockers(runtime: { services: Readonly<Partial<Record<string, unknown>>>; ciReporting?: CheckedCiReporting | undefined }, areasOn: readonly CoreArea[]): string[] {
  const tracksMerges = areasOn.includes("merge") || runtime.services["merge-tracking"] !== undefined;
  const standing: string[] = [];
  if (tracksMerges && runtime.ciReporting?.honest !== true) standing.push("honest-ci");
  return standing;
}

/** A company's runtime was refused because a blocker stands. Names the blockers by id only (fixed words). */
export class CoreSwitchBlockedError extends Error {
  constructor(readonly blockers: readonly string[]) {
    super(`${SWITCH_BLOCKED_WORDS}: ${blockers.join(", ")}`);
    this.name = "CoreSwitchBlockedError";
  }
}
