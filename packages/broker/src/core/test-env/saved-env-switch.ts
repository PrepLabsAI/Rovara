// Saved environments: the install switch (see `switch.ts`). Leaf module (no broker imports), so the registry, the push and pull routes, the task start and the dispatch payload can all read it.
// Off is the plain flow: no image is built, pushed, pulled, listed, deleted or sent to a worker, whatever a project set.
import { SAVED_ENVIRONMENTS_VARIABLE, optIn } from "./switch.js";

/** Whether saved environments exist in this install. Anything but exactly "1" (unset, empty, "true", " 1") is off. */
export const savedEnvEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => optIn(env, SAVED_ENVIRONMENTS_VARIABLE);
