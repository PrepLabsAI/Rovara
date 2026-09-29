// The project files on this computer that agentx destroy removes with an environment.
import { environmentProjectFiles } from "../setup/project-add.js";

/** The environment's project files destroy removes. A file that could not be read, or read as YAML,
 * is skipped and named: its register line may still name the environment's launch template, but
 * agentx destroy never deletes a file it could not read. */
export async function destroyProjectFiles(input: { configDir: string; env: string; write: (line: string) => void }): Promise<Array<{ path: string; launchTemplateId: string }>> {
  const found: Array<{ path: string; launchTemplateId: string }> = [];
  for (const file of await environmentProjectFiles(input.configDir, input.env)) {
    if (file.error !== undefined) {
      const why = file.error === "invalid-yaml" ? "it is not valid YAML" : `it could not be read (${file.errorCode ?? "unknown"})`;
      input.write(`Skipping ${file.path}: ${why}, so agentx destroy leaves it; delete it by hand if it belongs to ${input.env}`);
      continue;
    }
    found.push({ path: file.path, launchTemplateId: file.launchTemplateId });
  }
  return found;
}
