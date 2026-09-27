import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  AGENTX_NAME_PATTERN,
  AgentXNameSchema,
  ProjectDefinitionSchema,
  agentXError,
  legacyProjectFields,
  type ProjectDefinition,
} from "@agentx/contracts";
import YAML from "yaml";

const MAX_CONFIG_BYTES = 1_048_576;

export interface LoadProjectConfigOptions {
  projectName: string;
  configDirectory: string;
  allowLoopback?: boolean;
}

export async function loadProjectConfig(options: LoadProjectConfigOptions): Promise<ProjectDefinition> {
  // The file's own basename (minus .yaml) is not yet validated here: a name like
  // "connectors-check.rev3", derived from a file named connectors-check.rev3.yaml, is still a
  // legal path segment, so the file can be found and read before its name is checked (see
  // requireValidFileName below, which is what turns that case into a readable CONFIG_INVALID
  // instead of AgentXNameSchema.parse throwing zod's raw regex-failure dump; issue #101).
  const configDirectory = await realpath(resolve(options.configDirectory));
  const configuredPath = resolve(configDirectory, `${options.projectName}.yaml`);
  const canonicalPath = await realpath(configuredPath).catch((error: unknown) => {
    throw agentXError(
      "CONFIG_INVALID",
      isNodeError(error) && error.code === "ENOENT"
        ? `project ${options.projectName} is not configured in ${configDirectory}`
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
  const contents: unknown = document.toJS({ maxAliasCount: 0 });
  const retired = legacyProjectFields(contents);
  if (retired.length > 0) {
    throw agentXError(
      "CONFIG_INVALID",
      `project file must not contain ${retired.join(", ")}; the control-plane URL and login settings now live in the deployment file`,
    );
  }
  const projectName = requireValidFileName(options.projectName, contents);
  const definition = ProjectDefinitionSchema.parse(contents);
  if (definition.name !== projectName) {
    throw agentXError(
      "CONFIG_INVALID",
      `project file ${projectName}.yaml declares name ${JSON.stringify(definition.name)}; rename the file to ${definition.name}.yaml so the file name matches the project name`,
    );
  }
  if (!options.allowLoopback) assertHttps(definition);
  return definition;
}

/**
 * `--file` is `agentx admin project register`'s only project selector, so the file's own name
 * (its basename minus `.yaml`) stands in for `projectName` everywhere else in this module, per the
 * convention documented in the README (`<project-name>.yaml`, selected later with `--project`).
 * That convention is enforced here, early and by name, rather than letting a malformed derived
 * name reach `AgentXNameSchema.parse` and fail with zod's raw regex-failure dump (issue #101).
 * When the YAML can be read that far, the refusal also names the project name it declares, so the
 * operator knows exactly what to rename the file to.
 */
function requireValidFileName(fileStem: string, contents: unknown): string {
  const parsed = AgentXNameSchema.safeParse(fileStem);
  if (parsed.success) return parsed.data;
  const declaredName = readDeclaredName(contents);
  throw agentXError(
    "CONFIG_INVALID",
    declaredName === undefined || declaredName === fileStem
      ? `project file name "${fileStem}.yaml" is invalid; project files must be named <project-name>.yaml, where project-name matches ${AGENTX_NAME_PATTERN}`
      : `project file "${fileStem}.yaml" declares name ${JSON.stringify(declaredName)}; rename the file to "${declaredName}.yaml" so the file name matches the project name`,
  );
}

/** A best-effort peek at the parsed YAML's `name` field, used only to name it in an error message;
 * `ProjectDefinitionSchema.parse` is still what authoritatively validates it. */
function readDeclaredName(contents: unknown): string | undefined {
  if (contents === null || typeof contents !== "object") return undefined;
  const name = (contents as Record<string, unknown>).name;
  return typeof name === "string" ? name : undefined;
}

function assertHttps(definition: ProjectDefinition): void {
  if (definition.repositories.some(({ url }) => new URL(url).protocol !== "https:")) {
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
