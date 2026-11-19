// Saved environments: which preparations name the task's approved-environment pin, and so may be told a saved image. Only a developer task that USES the project's approved environment has a pin
// (its start, and the dispatch of a start that was held); a setup draft, a thread workspace, a project registration and a task whose environment was not applied have none, and are sent nothing.
import { testEnvDigest, type TestEnvironment } from "@agentx/contracts";
import type { StoreOnly } from "./deps.js";
import { readTestEnvPin, type TestEnvPin } from "./usable.js";

export interface SavedEnvPin { revision: number; digest: string }

/** The pin of an environment a starting task uses (undefined when it uses none). */
export function pinOfUsedEnvironment(used: TestEnvironment | undefined): SavedEnvPin | undefined {
  return used === undefined ? undefined : { revision: used.revision, digest: testEnvDigest(used.environment) };
}

/** The pin stored with a task, when the environment was applied (a pin that records an environment NOT applied names none). */
export function pinOfStoredPin(pin: TestEnvPin | undefined): SavedEnvPin | undefined {
  return pin === undefined || pin.unused !== undefined ? undefined : { revision: pin.revision, digest: pin.digest };
}

/**
 * What a task start asks its preparation for: a setup draft reads only (and names no pin; a setup agent's run also asks for pins); an agent-step run reads only with its checkouts (and names none); any other task names its pin, when it has one.
 * Undefined: the ordinary preparation.
 */
export function startPreparationOptions<Checkout>(input: { settingUpDraft: boolean; pinHeads?: boolean; agentSteps: { checkout: readonly Checkout[] } | undefined; testEnvPin: SavedEnvPin | undefined }):
  { readOnly: true; setupDraft: true; pinHeads?: true } | { checkout?: readonly Checkout[]; readOnly: true } | { testEnvPin: SavedEnvPin } | undefined {
  if (input.settingUpDraft) return { readOnly: true, setupDraft: true, ...(input.pinHeads === true ? { pinHeads: true as const } : {}) };
  if (input.agentSteps !== undefined) return { ...(input.agentSteps.checkout.length === 0 ? {} : { checkout: input.agentSteps.checkout }), readOnly: true };
  return input.testEnvPin === undefined ? undefined : { testEnvPin: input.testEnvPin };
}

/** `{ testEnvPin }` for a held start's preparation when its task uses the approved environment (the pin stored at the start); nothing otherwise. */
export async function heldSavedEnvPin(deps: StoreOnly, orgId: string, task: { project: string; taskId: string }): Promise<{ testEnvPin?: SavedEnvPin }> {
  const testEnvPin = pinOfStoredPin(await readTestEnvPin(deps, orgId, task.project, task.taskId));
  return testEnvPin === undefined ? {} : { testEnvPin };
}
