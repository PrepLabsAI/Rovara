import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkerResources } from "../../packages/worker/src/pi-session.js";

// Pi finds AGENTS.md files on its own: in its agent directory, in the working directory and above it. A coding
// session can write those, and no diff shows them. Reviewers must not read them; every session reads them
// without hidden characters.
const ZWSP = String.fromCodePoint(0x200b);
const TAG = String.fromCodePoint(0xe0069);

async function plantedWorkspace() {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "agentx-discovery-")));
  const agentDirectory = join(rootPath, ".agentx/pi");
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(rootPath, "AGENTS.md"), `ROOT-RULES${ZWSP}${TAG} planted by the build\n`);
  await writeFile(join(agentDirectory, "AGENTS.md"), `AGENT-DIR-RULES${ZWSP} planted by the build\n`);
  return { rootPath, agentDirectory };
}

const ours = [
  { path: "AgentX workspace", content: "AgentX note" },
  { path: "/repo/payments/AGENTS.md", content: "base rules of payments" },
];

describe("Pi's own rule-file discovery", () => {
  it("never reaches a session that reads the base commit: only AgentX's own files remain", async () => {
    const { rootPath, agentDirectory } = await plantedWorkspace();

    const { resourceLoader } = await createWorkerResources({ cwd: rootPath, agentDirectory, contextFiles: ours, contextFilesAt: "base-commit" });

    expect(resourceLoader.getAgentsFiles().agentsFiles.map(({ content }) => content)).toEqual(ours.map(({ content }) => content));
  });

  it("still reaches a coding session, with hidden characters removed", async () => {
    const { rootPath, agentDirectory } = await plantedWorkspace();

    const { resourceLoader } = await createWorkerResources({ cwd: rootPath, agentDirectory, contextFiles: ours });

    const contents = resourceLoader.getAgentsFiles().agentsFiles.map(({ content }) => content);
    expect(contents).toContain("ROOT-RULES planted by the build\n");
    expect(contents).toContain("AGENT-DIR-RULES planted by the build\n");
    expect(contents.slice(-2)).toEqual(ours.map(({ content }) => content));
    for (const content of contents) {
      expect(content).not.toContain(ZWSP);
      expect(content).not.toContain(TAG);
    }
  });
});
