import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { agentXError } from "@agentx/contracts";
import type { PreparationManifest } from "./prepare.js";

export async function verifyWorkspaceResume(input: {
  rootPath: string;
  projectName: string;
  projectRevision: number;
}): Promise<PreparationManifest> {
  const rootPath = await realpath(resolve(input.rootPath)).catch(() => {
    throw agentXError("RUNTIME_UNAVAILABLE", "persistent workspace mount is unavailable");
  });
  const manifest = JSON.parse(
    await readFile(resolve(rootPath, ".agentx/preparation-manifest.json"), "utf8"),
  ) as PreparationManifest;
  if (
    !manifest.complete ||
    manifest.projectName !== input.projectName ||
    manifest.projectRevision !== input.projectRevision
  ) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "persistent workspace manifest does not match its registered revision");
  }
  return manifest;
}
