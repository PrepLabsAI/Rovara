// Whether a task's spec is due, and what the target is.
import type { SpecKind, SpecTarget } from "@agentx/contracts";

/** The project's spec target, or undefined when it names none (no spec is written). */
export function specTargetOf(definition: { specTarget?: SpecTarget | undefined }): SpecTarget | undefined {
  return definition.specTarget;
}

export interface SpecTrigger {
  kind: SpecKind;
  /** The plan's size, when something says; unknown counts as medium (a spec is written rather than silently skipped). */
  size?: "small" | "medium" | "large" | undefined;
  /** The owner asked for a spec on this task. */
  requested?: boolean | undefined;
}

/** `when: always` writes one for every task; `features` for a feature (a bug only with `always`); `medium_and_large` for anything not small; `on_request` only when asked. An owner's request always counts. */
export function specIsDue(target: SpecTarget | undefined, trigger: SpecTrigger): boolean {
  if (target === undefined) return false;
  if (trigger.requested === true) return true;
  switch (target.when) {
    case "always": return true;
    case "features": return trigger.kind === "feature";
    case "medium_and_large": return trigger.size !== "small";
    case "on_request": return false;
  }
}
