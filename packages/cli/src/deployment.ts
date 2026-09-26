import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { EnvironmentNameSchema, agentXError } from "@agentx/contracts";
import YAML from "yaml";
import { z } from "zod";

const MAX_DEPLOYMENT_BYTES = 65_536;

// One AgentX deployment serves every project, so its control-plane URL and login settings live
// beside the project files rather than inside each one. `env` is absent on the legacy file and
// present on a cache written by `agentx env use`, naming which environment it was built for.
export const DeploymentSettingsSchema = z
  .object({
    env: EnvironmentNameSchema.optional(),
    controlPlaneUrl: z.string().url(),
    auth: z
      .object({
        issuer: z.string().url(),
        clientId: z.string().min(1).max(256),
        audience: z.string().min(1).max(256),
      })
      .strict(),
  })
  .strict();

export type DeploymentSettings = z.infer<typeof DeploymentSettingsSchema>;

export async function loadDeploymentSettings(options: {
  path: string;
  allowLoopback?: boolean;
  /** When the file names an environment that differs from this one, refuse it rather than log in against the wrong control plane. */
  expectedEnv?: string;
}): Promise<DeploymentSettings> {
  const canonicalPath = await realpath(resolve(options.path)).catch((error: unknown) => {
    throw agentXError(
      "CONFIG_INVALID",
      isNodeError(error) && error.code === "ENOENT"
        ? `AgentX deployment settings are not configured at ${options.path}`
        : "deployment settings cannot be resolved",
    );
  });
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile() || metadata.size > MAX_DEPLOYMENT_BYTES) {
    throw agentXError("CONFIG_INVALID", "deployment settings must be a regular file no larger than 64 KiB");
  }
  const document = YAML.parseDocument(await readFile(canonicalPath, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw agentXError("CONFIG_INVALID", document.errors[0]?.message ?? "deployment YAML is invalid");
  }
  const settings = DeploymentSettingsSchema.parse(document.toJS({ maxAliasCount: 0 }));
  if (options.expectedEnv !== undefined && settings.env !== undefined && settings.env !== options.expectedEnv) {
    throw agentXError(
      "CONFIG_INVALID",
      `deployment file ${canonicalPath} is for environment ${settings.env}, not ${options.expectedEnv}; run agentx --env ${options.expectedEnv} env use`,
    );
  }
  if (!options.allowLoopback) assertHttps(settings);
  return settings;
}

function assertHttps(settings: DeploymentSettings): void {
  if ([settings.controlPlaneUrl, settings.auth.issuer].some((value) => new URL(value).protocol !== "https:")) {
    throw agentXError("CONFIG_INVALID", "deployment URLs must use HTTPS outside explicit loopback test mode");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
