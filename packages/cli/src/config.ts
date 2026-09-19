import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AgentXNameSchema, ProjectDefinitionSchema, agentXError, type ProjectDefinition } from "@agentx/contracts";
import YAML from "yaml";

const MAX_CONFIG_BYTES = 1_048_576;

export interface LoadProjectConfigOptions {
  projectName: string;
  configDirectory: string;
  allowLoopback?: boolean;
}

export async function loadProjectConfig(options: LoadProjectConfigOptions): Promise<ProjectDefinition> {
  const projectName = AgentXNameSchema.parse(options.projectName);
  const configDirectory = await realpath(resolve(options.configDirectory));
  const configuredPath = resolve(configDirectory, `${projectName}.yaml`);
  const canonicalPath = await realpath(configuredPath).catch((error: unknown) => {
    throw agentXError(
      "CONFIG_INVALID",
      isNodeError(error) && error.code === "ENOENT"
        ? `project ${projectName} is not configured in ${configDirectory}`
        : "project configuration cannot be resolved",
    );
  });
  assertContained(configDirectory, canonicalPath);
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) {
    throw agentXError("CONFIG_INVALID", "project configuration must be a regular file no larger than 1 MiB");
  }
  const document = YAML.parseDocument(await readFile(canonicalPath, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw agentXError("CONFIG_INVALID", document.errors[0]?.message ?? "project YAML is invalid");
  }
  const definition = ProjectDefinitionSchema.parse(document.toJS({ maxAliasCount: 0 }));
  if (definition.name !== projectName) {
    throw agentXError("CONFIG_INVALID", "project filename and definition name must match");
  }
  if (!options.allowLoopback) assertHttps(definition);
  return definition;
}

function assertHttps(definition: ProjectDefinition): void {
  const urls = [definition.controlPlaneUrl, definition.auth.issuer, ...definition.repositories.map(({ url }) => url)];
  if (urls.some((value) => new URL(value).protocol !== "https:")) {
    throw agentXError("CONFIG_INVALID", "project URLs must use HTTPS outside explicit loopback test mode");
  }
}

function assertContained(parent: string, child: string): void {
  const path = relative(parent, child);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw agentXError("CONFIG_INVALID", "project configuration resolves outside the config directory");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
