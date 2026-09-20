import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { PreparationManifest } from "./prepare.js";
import { redactCredentials } from "./events.js";
import { gitSafeEnvironment } from "./git.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 67_108_864;
// The control plane accepts artifacts up to 5 MB. Leave room for the
// truncation notice and any JSON/HTTP framing added by the callback client.
export const MAX_WORKSPACE_DIFF_BYTES = 4_500_000;
const TRUNCATION_NOTICE = "\n\n[workspace diff truncated to fit the AgentX artifact limit]\n";

export interface WorkerArtifact {
  id?: string;
  name: string;
  mediaType: string;
  content: string;
}

export type ArtifactSink = (artifact: WorkerArtifact) => Promise<void | { artifactId: string; sha256: string; sizeBytes: number }>;

export async function publishWorkspaceDiff(rootPath: string, sink: ArtifactSink): Promise<void> {
  const manifest = JSON.parse(
    await readFile(resolve(rootPath, ".agentx/preparation-manifest.json"), "utf8"),
  ) as PreparationManifest;
  const sections: string[] = [];
  for (const repository of manifest.repositories) {
    const directory = resolve(rootPath, repository.path);
    const { stdout } = await execFileAsync(
      "git",
      ["-C", directory, "diff", "--no-ext-diff", "--binary", "HEAD", "--"],
      { timeout: 60_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, env: gitSafeEnvironment(directory) },
    );
    const { stdout: status } = await execFileAsync(
      "git",
      ["-C", directory, "status", "--short", "--untracked-files=all"],
      { timeout: 30_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, env: gitSafeEnvironment(directory) },
    );
    sections.push(`## ${repository.name}\n\n### status\n${status}\n### diff\n${stdout}`);
  }
  await sink({
    name: "workspace.diff",
    mediaType: "text/plain; charset=utf-8",
    content: boundWorkspaceDiff(String(redactCredentials(sections.join("\n")))),
  });
}

export function boundWorkspaceDiff(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= MAX_WORKSPACE_DIFF_BYTES) return content;
  const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
  const prefix = Buffer.from(content, "utf8")
    .subarray(0, MAX_WORKSPACE_DIFF_BYTES - noticeBytes - 4)
    .toString("utf8");
  return `${prefix}${TRUNCATION_NOTICE}`;
}
