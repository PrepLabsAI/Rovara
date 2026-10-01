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
