/**
 * The worker's environment with Git's safe directory set. `extra` (a project command's own `env`,
 * #54) goes over the worker's variables but never over the Git settings.
 */
export function gitSafeEnvironment(directory: string, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: directory,
  };
}

/** The identity AgentX commits as: its own publication commits and the agent's shell (#208). */
export const AGENTX_GIT_NAME = "AgentX";
export const AGENTX_GIT_EMAIL = "agentx@noreply.local";

/**
 * Git's author and committer variables set to AgentX's identity. The agent's shell has them, so a
 * commit there never fails for a missing identity and the agent never writes one into a
 * repository's config (#208).
 */
export const AGENTX_GIT_IDENTITY_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  GIT_AUTHOR_NAME: AGENTX_GIT_NAME,
  GIT_AUTHOR_EMAIL: AGENTX_GIT_EMAIL,
  GIT_COMMITTER_NAME: AGENTX_GIT_NAME,
  GIT_COMMITTER_EMAIL: AGENTX_GIT_EMAIL,
});
