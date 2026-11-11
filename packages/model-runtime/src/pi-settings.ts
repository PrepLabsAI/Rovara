import { SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * The retry budget for a model call that fails with a transient error (PLANINC-3b). Pi retries such a call on its own: its default is 3 retries
 * (4 calls) with 2, 4 and 8 s waits. Rovara sets its own, smaller budget so a failing model call ends in a bounded time: `maxRetries` retries after the
 * first call (so `maxRetries + 1` calls at most), each after `baseDelayMs` doubled per retry, and never a wait longer than `maxAgentDelayMs`.
 * The worker and the orchestrator share it. Change the numbers here; the planning deadline and the stall limit (the worker's model-call monitor) bound the calls themselves.
 */
export const PI_MODEL_RETRY = { enabled: true, maxRetries: 2, baseDelayMs: 2_000, maxAgentDelayMs: 10_000 } as const;

/**
 * Pi's settings for every Rovara session: the whole set, written here, and nothing read from a file. A Pi settings file in a repository (`.pi/settings.json`), in the home directory
 * or in a session's agent directory therefore changes nothing, and a default a later Pi release switches on stays off until it is set on purpose.
 *
 * - Project trust is off, so no project setting or resource is read even if a caller reloads with another answer.
 * - No telemetry: no install telemetry (so no Pi attribution headers on a request) and no analytics.
 * - Prompt caches are never warmed: a warm is an extra paid request that no Rovara budget plans for.
 * - Retries follow PI_MODEL_RETRY.
 * - Pi installs and loads no package, extension path, skill path, prompt template path or theme path from settings, and runs no configured shell or npm command.
 *
 * The compat setting that keeps Anthropic message threads off (server-held conversation state) is a model setting, in the model runtime's `requestCompat`.
 */
export function createPiSettingsManager(): SettingsManager {
  return SettingsManager.inMemory({
    retry: { ...PI_MODEL_RETRY },
    cacheWarming: "off",
    enableInstallTelemetry: false,
    enableAnalytics: false,
    defaultProjectTrust: "never",
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  }, { projectTrusted: false });
}
