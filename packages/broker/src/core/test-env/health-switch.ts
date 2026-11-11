// Nightly health: the switch (see `switch.ts`). Leaf module (no broker imports), so the nightly listener, the task start and the project page can all read it.
// It does nothing without the test environment: there is no nightly run to read then. Callers that start work check both.
import { NIGHTLY_HEALTH_VARIABLE, optIn, testEnvironmentEnabled } from "./switch.js";

/** Whether the nightly run sets the project's health. Anything but exactly "1" is off. */
export const nightlyHealthEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => optIn(env, NIGHTLY_HEALTH_VARIABLE);

/** Whether nightly runs exist: the nightly switch with the test environment. Off, no run is started, the result route answers forbidden and nothing is read. */
export const nightlyRunsOn = (env: NodeJS.ProcessEnv = process.env): boolean => nightlyHealthEnabled(env) && testEnvironmentEnabled(env);
