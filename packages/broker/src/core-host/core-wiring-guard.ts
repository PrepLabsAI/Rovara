// Engine host: what must hold before the root hands out a company's runtime (renamed in D1 from `switch-blockers.ts`: there is no switch to block any more, this is the live fail-closed wiring guard).
// Each check is REQUIRED, in the spirit of the registry's never-default rule: a deployment that has not wired what a check needs gets a refused runtime (`CoreWiringIncompleteError`, by id), never a
// core that runs on a guess. They are checked at run time, in `runtimeFor`.
//
//   services           Every required service (merge tracking, the session sweep, notice delivery, the admission hold sweep) must be wired; a missing one is named.
//   honest-ci          The core always reports honest CI states: CI that cannot be read is `unreadable`, a required check nothing has run is `required_missing`, and "no CI" never counts as a
//                      pass except where the project says it does not rely on CI (`sandbox_only`). Whether a draft may leave draft rests on the project's own CI mode, so the deployment must
//                      hand in the reader of that mode (`ciReporting`), the one its merge tracking and its task readers use. There is no default mode: a reader that is missing is a
//                      refused runtime, and an answer that is not one of the four modes (or a reader that throws) is a fixed refusal at use, never `DEFAULT_CI_MODE`.
//
// Asked of every runtime that is not a dispatch-only root (which runs no merge tracking, see `createCoreHostApp`).
import type { ProjectCiMode, TrackedTask } from "../core/merge/merge-tracking.js";

/** The services every company's runtime must have, beyond the task flow. */
export const REQUIRED_CORE_SERVICES = ["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"] as const;

/** The deployment's CI reporting: the project's own CI mode reader. `honest` must be exactly `true`: the deployment says its task readers show the honest states as they are. */
export interface CiReporting {
  honest: true;
  ciMode(task: TrackedTask): ProjectCiMode | Promise<ProjectCiMode>;
}

/** The validated wrapper the runtime holds: `ciMode` always answers one of the four modes, or rejects with fixed words. */
export interface CheckedCiReporting {
  readonly honest: true;
  readonly ciMode: (task: TrackedTask) => Promise<ProjectCiMode>;
}

export interface CoreWiringCheck {
  readonly id: string;
  /** In plain words, for whoever runs the install. Fixed. */
  readonly words: string;
  /** Who wires what it needs. */
  readonly owner: string;
}

export const CORE_WIRING_CHECKS: readonly CoreWiringCheck[] = Object.freeze([
  Object.freeze({
    id: "honest-ci",
    words: "The core reports CI honestly (unreadable and missing required checks are shown as such), so the deployment must pass the project's own CI mode reader before merge tracking runs on the core.",
    owner: "the deployment's wiring (lane E2), with the project CI mode store",
  }),
]);

export const CI_MODE_UNREADABLE_WORDS = "the project's CI mode could not be read";
export const WIRING_INCOMPLETE_WORDS = "the core engine cannot run for this company yet";

const CI_MODES: ReadonlySet<unknown> = new Set<unknown>(["sandbox_only", "their_ci_watch", "their_ci_fix", "rovara_real_run"] satisfies ProjectCiMode[]);

/** The deployment's CI reporting, checked at run time. Undefined unless `honest` is exactly `true` and `ciMode` is a function. The wrapper never echoes what the reader said or threw. */
export function checkedCiReporting(given: unknown): CheckedCiReporting | undefined {
  if (given === null || typeof given !== "object") return undefined;
  const candidate = given as { honest?: unknown; ciMode?: unknown };
  if (candidate.honest !== true || typeof candidate.ciMode !== "function") return undefined;
  const reader = candidate.ciMode as (task: TrackedTask) => unknown;
  return Object.freeze({
    honest: true as const,
    ciMode: async (task: TrackedTask): Promise<ProjectCiMode> => {
      let answer: unknown;
      try { answer = await reader.call(given, task); } catch { throw new Error(CI_MODE_UNREADABLE_WORDS); }
      if (!CI_MODES.has(answer)) throw new Error(CI_MODE_UNREADABLE_WORDS);
      return answer as ProjectCiMode;
    },
  });
}

/** What a runtime lacks: the required services it has not wired (by name) and the ids of the wiring checks that stand. Both empty: nothing is missing. */
export interface CoreWiringGaps {
  services: string[];
  blockers: string[];
}

export function coreWiringGaps(runtime: { services: Readonly<Partial<Record<string, unknown>>>; ciReporting?: CheckedCiReporting | undefined }): CoreWiringGaps {
  return {
    services: REQUIRED_CORE_SERVICES.filter((name) => runtime.services[name] === undefined),
    blockers: runtime.ciReporting?.honest === true ? [] : ["honest-ci"],
  };
}

/** A company's runtime was refused because a wiring check stands. Names the checks by id only (fixed words). */
export class CoreWiringIncompleteError extends Error {
  constructor(readonly blockers: readonly string[]) {
    super(`${WIRING_INCOMPLETE_WORDS}: ${blockers.join(", ")}`);
    this.name = "CoreWiringIncompleteError";
  }
}
