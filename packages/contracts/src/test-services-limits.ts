// The resource ceilings of test services on a laptop (DEC 254zm 2). Test services are on by default, so the ceilings are low; the owner may raise them with three settings, never past the old hard limits.
// One list of names, defaults and bounds for the three places that must agree: the broker (reads the owner's settings), the Docker socket guard (enforces them) and the worker (refuses a run that cannot fit, in fixed words).
// Leaf module: no imports.

/** The owner's settings (environment of `rovara up`). Each is a plain whole number; anything else makes test services unavailable with a fixed sentence (never a silent default). */
export const TEST_SERVICES_MAX_CONTAINERS_VARIABLE = "ROVARA_TEST_SERVICES_MAX_CONTAINERS";
export const TEST_SERVICES_MAX_HELPER_MEMORY_VARIABLE = "ROVARA_TEST_SERVICES_MAX_HELPER_MEMORY_MIB";
export const TEST_SERVICES_MAX_MEMORY_PERCENT_VARIABLE = "ROVARA_TEST_SERVICES_MAX_MEMORY_PERCENT";

/** What the worker is told (the broker sets them; a project cannot): the resolved limits, so a run that cannot fit is refused before anything starts. */
export const TEST_SERVICES_WORKER_MAX_CONTAINERS_VARIABLE = "AGENTX_TEST_SERVICES_MAX_CONTAINERS";
export const TEST_SERVICES_WORKER_MAX_HELPER_MEMORY_VARIABLE = "AGENTX_TEST_SERVICES_MAX_HELPER_MEM_MIB";

/**
 * Today's defaults: about 12 service containers at once, 1 GiB for any one helper (the starter helpers ask for 128 to 768 MiB), and 40% of the Docker VM's memory for all of them together. Before DEC 254zm they were
 * 48, 3 GiB and 75%.
 */
export const TEST_SERVICES_LIMIT_DEFAULTS = { containers: 12, helperMemoryMiB: 1024, memoryPercent: 40 } as const;

/** The most an owner may raise each to: the old hard limits, so a setting can bring back the old ceilings and never go past them. */
export const TEST_SERVICES_LIMIT_BOUNDS = {
  containers: { min: 1, max: 96 },
  helperMemoryMiB: { min: 64, max: 16384 },
  memoryPercent: { min: 5, max: 75 },
} as const;

export interface TestServicesLimits { containers: number; helperMemoryMiB: number; memoryPercent: number }

/** The words the guard answers with when a ceiling stops a start (HTTP 429, or 403 for one service's own memory); the guard puts "rovara: " in front. The worker recognises exactly this marker and tells the person, in its own fixed words, which setting raises it. */
export const TEST_SERVICES_CEILING_MARKER = "test services limit reached";

export const TEST_SERVICES_LIMIT_SENTENCES = {
  containers: `${TEST_SERVICES_CEILING_MARKER}: too many service containers at once on this computer (raise ${TEST_SERVICES_MAX_CONTAINERS_VARIABLE})`,
  memory: `${TEST_SERVICES_CEILING_MARKER}: the service containers together may not be given more of this computer's memory (raise ${TEST_SERVICES_MAX_MEMORY_PERCENT_VARIABLE})`,
  helperMemory: `${TEST_SERVICES_CEILING_MARKER}: a service asks for more memory than one service may have on this computer (raise ${TEST_SERVICES_MAX_HELPER_MEMORY_VARIABLE})`,
} as const;

/** What a run is told when its own plan cannot fit under the ceilings, or a start was stopped by one. Fixed words, no numbers or values from anywhere. */
export const TEST_SERVICES_OVER_LIMIT_SENTENCE =
  `Test services limit reached: this run needs more service containers or memory than this computer allows for test services. Use fewer dependencies, or raise ${TEST_SERVICES_MAX_CONTAINERS_VARIABLE}, ${TEST_SERVICES_MAX_HELPER_MEMORY_VARIABLE} or ${TEST_SERVICES_MAX_MEMORY_PERCENT_VARIABLE} and restart Rovara`;

/** The sentence for a setting that is not a whole number in its range. It names the setting and never the value. */
export const testServicesLimitInvalidSentence = (variable: string): string =>
  `Test services are not available: ${variable} must be a whole number within its allowed range (it is left unset to use the default)`;

export type TestServicesLimitsResult = { ok: true; limits: TestServicesLimits } | { ok: false; variable: string };

const WHOLE_NUMBER = /^[1-9][0-9]{0,5}$/u;

function readOne(environment: NodeJS.ProcessEnv, variable: string, bounds: { min: number; max: number }, fallback: number): number | undefined {
  const raw = environment[variable];
  if (raw === undefined) return fallback;
  if (!WHOLE_NUMBER.test(raw)) return undefined;
  const value = Number(raw);
  return value >= bounds.min && value <= bounds.max ? value : undefined;
}

/**
 * The limits from the owner's settings. An unset setting is the default. A set one that is empty, has a sign, a space, a decimal point, a leading zero or letters, or is outside its bounds is NOT clamped or ignored:
 * the answer names the first setting that is wrong, so the install can say so and test services stay unavailable until it is fixed.
 */
export function resolveTestServicesLimits(environment: NodeJS.ProcessEnv): TestServicesLimitsResult {
  const containers = readOne(environment, TEST_SERVICES_MAX_CONTAINERS_VARIABLE, TEST_SERVICES_LIMIT_BOUNDS.containers, TEST_SERVICES_LIMIT_DEFAULTS.containers);
  if (containers === undefined) return { ok: false, variable: TEST_SERVICES_MAX_CONTAINERS_VARIABLE };
  const helperMemoryMiB = readOne(environment, TEST_SERVICES_MAX_HELPER_MEMORY_VARIABLE, TEST_SERVICES_LIMIT_BOUNDS.helperMemoryMiB, TEST_SERVICES_LIMIT_DEFAULTS.helperMemoryMiB);
  if (helperMemoryMiB === undefined) return { ok: false, variable: TEST_SERVICES_MAX_HELPER_MEMORY_VARIABLE };
  const memoryPercent = readOne(environment, TEST_SERVICES_MAX_MEMORY_PERCENT_VARIABLE, TEST_SERVICES_LIMIT_BOUNDS.memoryPercent, TEST_SERVICES_LIMIT_DEFAULTS.memoryPercent);
  if (memoryPercent === undefined) return { ok: false, variable: TEST_SERVICES_MAX_MEMORY_PERCENT_VARIABLE };
  return { ok: true, limits: { containers, helperMemoryMiB, memoryPercent } };
}
