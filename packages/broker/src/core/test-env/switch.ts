// The test environment's install switches. Leaf module (no broker imports), so the setup routes, the task start, the dispatch payload, the nightly schedule and the evidence line can all read it.
// Code reads them from the environment (`rovara up` and a plug-in install set them; Cloud sets the same variables from its own settings). Each takes the environment as a parameter, so a test never
// touches the process's own.
//
//   ROVARA_TEST_ENVIRONMENT   the project test environment (propose, prove, approve, the task's checks, the nightly run, the evidence line). ON unless exactly "0": nothing happens until
//                             an environment is approved, so on is the safe default for a laptop.
//   ROVARA_TEST_SERVICES      dependencies get a backing (real software, local AWS, fakes) on a sealed per-run network. OFF unless exactly "1": it needs Docker and the signed service catalog.
//   ROVARA_TEST_ACCOUNTS      a project may use the customer's own test accounts. OFF unless exactly "1". Needs the services switch too.
//   ROVARA_PROJECT_IMAGES     a project may bring its own images. OFF unless exactly "1". Needs the services switch too.
//   ROVARA_SAVED_ENVIRONMENTS a project's proven setup is built into an image, kept in the image registry and used by tasks. OFF unless exactly "1".
//   ROVARA_NIGHTLY_HEALTH     the nightly run sets the project's health (the "Setup needs repair" state). OFF unless exactly "1". Does nothing without the test environment.
//   ROVARA_BASELINE_CACHE     TE-C1: the nightly also keeps one baseline row per commit, a task's plan offers the newest ones to the worker, and the checks say which run they were compared with. OFF unless exactly "1".
export const TEST_ENVIRONMENT_VARIABLE = "ROVARA_TEST_ENVIRONMENT";
export const TEST_SERVICES_VARIABLE = "ROVARA_TEST_SERVICES";
export const TEST_ACCOUNTS_VARIABLE = "ROVARA_TEST_ACCOUNTS";
export const PROJECT_IMAGES_VARIABLE = "ROVARA_PROJECT_IMAGES";
export const SAVED_ENVIRONMENTS_VARIABLE = "ROVARA_SAVED_ENVIRONMENTS";
export const NIGHTLY_HEALTH_VARIABLE = "ROVARA_NIGHTLY_HEALTH";
export const BASELINE_CACHE_VARIABLE = "ROVARA_BASELINE_CACHE";

/** On only when exactly "1" (unset, empty, "true" and " 1" are off). */
export const optIn = (env: NodeJS.ProcessEnv, variable: string): boolean => env[variable] === "1";

/** Whether the project test environment exists in this install. Only exactly "0" turns it off. */
export const testEnvironmentEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env[TEST_ENVIRONMENT_VARIABLE] !== "0";

/** TE-C1: whether the baseline per base commit is kept and used. Anything but exactly "1" is off, and off is today's flow byte for byte (nothing new is written, planned or said). */
export const baselineCacheEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => optIn(env, BASELINE_CACHE_VARIABLE);
