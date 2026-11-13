// Lessons replay, the file arm (DECISIONS 50.5, 68): the worker places a replay copy's lessons file and pointer in the checkout, and keeps both out of the candidate (the diff and any commit), tracked or not. A checkout that tries to
// send the write elsewhere (a link at .rovara, the lessons file or AGENTS.md) fails the run; nothing is placed for an ordinary task.
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { EVAL_FILES_FEATURE, EvalFilesPayloadSchema, WORKER_INVOCATION_FEATURES } from "@rovara-code/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { agentsFileWithPointer, placeEvalFiles } from "../../packages/worker/src/eval-files.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { readCandidateRepositories } from "../../packages/worker/src/verification/candidate.js";
import { HIDDEN_WORK_TREES_MAX, hiddenWorkTreeCount, hideFromCandidate } from "../../packages/worker/src/isolated-git.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const git = async (directory: string, ...args: string[]): Promise<string> => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trim();
async function repository(files: Record<string, string> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentx-evalfiles-"));
  roots.push(directory);
  await git(directory, "init", "--quiet");
  await git(directory, "config", "user.email", "agentx@example.invalid");
  await git(directory, "config", "user.name", "AgentX Test");
  await writeFile(join(directory, "tracked.txt"), "baseline\n");
  for (const [name, text] of Object.entries(files)) { await mkdir(join(directory, name, ".."), { recursive: true }); await writeFile(join(directory, name), text); }
  await git(directory, "add", "-A");
  await git(directory, "commit", "--quiet", "-m", "baseline");
  return directory;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const payload = (repositoryId = "payments") => EvalFilesPayloadSchema.parse({ repository: repositoryId, lessonsFile: { path: ".rovara/lessons.md", content: "# Lessons\n\n- Use withRetry\n" }, pointerLine: "Before you change code in this repository, read `.rovara/lessons.md`." });
const treeOf = async (directory: string): Promise<{ tree: string; head: string }> => { const [identity] = await readCandidateRepositories([{ repositoryId: "payments", directory }]); return { tree: identity!.treeSha, head: await git(directory, "rev-parse", "HEAD^{tree}") }; };

describe("the worker places a replay copy's lessons file", () => {
  it("is a feature this worker lists, and the contract lists", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain(EVAL_FILES_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(EVAL_FILES_FEATURE);
  });
  it("writes .rovara/lessons.md and creates AGENTS.md with the one pointer, and neither is in the candidate", async () => {
    const directory = await repository();
    await placeEvalFiles(payload(), [{ repositoryId: "payments", directory }]);
    expect(await readFile(join(directory, ".rovara/lessons.md"), "utf8")).toContain("Use withRetry");
    const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
    expect(agents).toContain("## Team lessons");
    expect(agents).toContain(".rovara/lessons.md");
    // the agent's own edit is still captured next to the hidden files
    await writeFile(join(directory, "tracked.txt"), "changed by the agent\n");
    const after = await treeOf(directory);
    expect(after.tree).not.toBe(after.head);
    expect(await git(directory, "ls-tree", "-r", "--name-only", after.tree)).toBe("tracked.txt");
  });
  it("adds the pointer to a TRACKED AGENTS.md and replaces a tracked lessons file, both kept out of the candidate", async () => {
    const directory = await repository({ "AGENTS.md": "# Notes\n\nBe kind.\n", ".rovara/lessons.md": "# the team file\n" });
    await placeEvalFiles(payload(), [{ repositoryId: "payments", directory }]);
    expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toContain("Be kind.");
    expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toContain("## Team lessons");
    const after = await treeOf(directory);
    expect(after.tree).toBe(after.head);
    expect(await git(directory, "show", `${after.tree}:AGENTS.md`)).toBe("# Notes\n\nBe kind.");
    expect(await git(directory, "show", `${after.tree}:.rovara/lessons.md`)).toBe("# the team file");
  });
  it("leaves an AGENTS.md that already names the lessons file alone, and says so in the pure helper", async () => {
    expect(agentsFileWithPointer("see .rovara/lessons.md\n", "x")).toBeUndefined();
    expect(agentsFileWithPointer(undefined, "read it")).toBe("# Agent instructions\n\n## Team lessons\n\nread it\n");
    expect(agentsFileWithPointer("a\r\n", "read it")).toBe("a\r\n\r\n## Team lessons\r\n\r\nread it\r\n");
  });
  it("fails the run when the checkout would send the write elsewhere, or the repository is not there", async () => {
    const linked = await repository();
    const outside = await mkdtemp(join(tmpdir(), "agentx-evalfiles-out-"));
    roots.push(outside);
    await symlink(outside, join(linked, ".rovara"));
    await expect(placeEvalFiles(payload(), [{ repositoryId: "payments", directory: linked }])).rejects.toThrow(/could not place the lessons file/u);
    expect(await readFile(join(outside, "lessons.md"), "utf8").catch(() => "absent")).toBe("absent");

    const agentLink = await repository();
    await symlink(join(outside, "target.md"), join(agentLink, "AGENTS.md"));
    await expect(placeEvalFiles(payload(), [{ repositoryId: "payments", directory: agentLink }])).rejects.toThrow(/could not place the lessons file/u);
    expect(await readFile(join(outside, "target.md"), "utf8").catch(() => "absent")).toBe("absent");

    await expect(placeEvalFiles(payload("other"), [{ repositoryId: "payments", directory: await repository() }])).rejects.toThrow(/could not place the lessons file/u);
  });
  it("hides nothing for an ordinary task: a lessons file the agent writes without this placement is in the candidate", async () => {
    const directory = await repository();
    await mkdir(join(directory, ".rovara"));
    await writeFile(join(directory, ".rovara/lessons.md"), "agent wrote this\n");
    // a different checkout path than the placed one above (the hidden set is per work tree)
    const after = await treeOf(directory);
    expect(await git(directory, "ls-tree", "-r", "--name-only", after.tree)).toContain(".rovara/lessons.md");
  });
  it("refuses a lessons file bigger than the contract allows", () => {
    expect(EvalFilesPayloadSchema.safeParse({ ...payload(), lessonsFile: { path: ".rovara/lessons.md", content: "x".repeat(100_001) } }).success).toBe(false);
    expect(EvalFilesPayloadSchema.safeParse({ ...payload(), lessonsFile: { path: "elsewhere.md", content: "x" } }).success).toBe(false);
  });
});

describe("the hidden-path registry is bounded", () => {
  it("never holds more work trees than the bound, and the oldest are the ones dropped", () => {
    for (let i = 0; i < HIDDEN_WORK_TREES_MAX + 20; i += 1) hideFromCandidate(`/work/${String(i)}`, ".rovara/lessons.md");
    expect(hiddenWorkTreeCount()).toBeLessThanOrEqual(HIDDEN_WORK_TREES_MAX);
    expect(hiddenWorkTreeCount()).toBe(HIDDEN_WORK_TREES_MAX);
    // Re-registering a work tree already held does not evict another.
    hideFromCandidate(`/work/${String(HIDDEN_WORK_TREES_MAX + 19)}`, "AGENTS.md");
    expect(hiddenWorkTreeCount()).toBe(HIDDEN_WORK_TREES_MAX);
  });
});
