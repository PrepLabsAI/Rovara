import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentXError } from "@agentx/contracts";
import YAML from "yaml";
import type { DeploymentSettings } from "../deployment.js";
import type { EnvironmentSettings } from "./settings.js";

/** Where `agentx env use` caches an environment's connection settings: <home>/.agentx/environments/<env>.yaml. */
export function environmentCachePath(home: string, env: string): string {
  return join(home, ".agentx", "environments", `${env}.yaml`);
}

/** The cache holds no secrets: only the environment name, control-plane URL and auth identity. */
export function cacheFromSettings(settings: EnvironmentSettings): DeploymentSettings & { env: string } {
  return {
    env: settings.env,
    controlPlaneUrl: settings.controlPlaneUrl,
    auth: {
      issuer: settings.identity.issuer,
      clientId: settings.identity.clientId,
      audience: settings.identity.audience,
    },
  };
}

/**
 * The region this computer's cache places environment `env` in, read from the AWS endpoints it
 * records (the control plane's execute-api URL, or a Cognito issuer). undefined when there is no
 * cache, it cannot be read, or neither endpoint names a region (a custom domain and your own OIDC
 * provider).
 */
export async function cachedEnvironmentRegion(home: string, env: string): Promise<string | undefined> {
  let cached: unknown;
  try {
    cached = YAML.parse(await readFile(environmentCachePath(home, env), "utf8"));
  } catch {
    return undefined;
  }
  const record = (cached ?? {}) as { controlPlaneUrl?: unknown; auth?: { issuer?: unknown } };
  const endpoints = [record.controlPlaneUrl, record.auth?.issuer].filter((value): value is string => typeof value === "string");
  for (const endpoint of endpoints) {
    const match = /^https:\/\/(?:[a-z0-9-]+\.execute-api|cognito-idp)\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com(?:\.cn)?(?:\/|$)/.exec(endpoint);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

export async function writeEnvironmentCache(home: string, settings: EnvironmentSettings): Promise<string> {
  const path = environmentCachePath(home, settings.env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    const handle = await open(temporary, "w", 0o600);
    try {
      // open() applies the mode only to a new file; tighten it explicitly too, in case an earlier
      // run left a temp file behind with looser permissions.
      await handle.chmod(0o600);
      await handle.writeFile(`# AgentX environment ${settings.env}; rebuilt from SSM by agentx env use.\n${YAML.stringify(cacheFromSettings(settings))}`);
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    return path;
  } catch (error) {
    // Never leave a half-written or unrenamed temp file behind on failure.
    await rm(temporary, { force: true });
    throw error;
  }
}

const exists = (path: string) => access(path).then(() => true, () => false);

/**
 * Explicit --deployment-file wins; then the environment cache; then, for production only, the
 * legacy ~/.agentx/deployment.yaml. Any other environment with neither an explicit file nor a
 * cache must be installed locally first with `agentx env use`.
 */
export async function resolveDeploymentFile(input: { home: string; env: string; explicitFile?: string }): Promise<string> {
  if (input.explicitFile !== undefined) return input.explicitFile;
  const cached = environmentCachePath(input.home, input.env);
  if (await exists(cached)) return cached;
  const legacy = join(input.home, ".agentx", "deployment.yaml");
  if (input.env === "production" && (await exists(legacy))) return legacy;
  throw agentXError("CONFIG_INVALID", `no settings for environment ${input.env} on this machine; run agentx --env ${input.env} env use`);
}
