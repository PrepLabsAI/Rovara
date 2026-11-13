import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskGraphDigest, type TaskGraphV1 } from "@rovara-code/contracts";
import { executeParallelWorkflowDependencies } from "../../packages/worker/src/parallel-parts.js";
import { PARTS_DIRECTORY, capturePartTree, checkoutIntegratedTree, createPartWorkingCopy, integrateTrees, partDirectory } from "../../packages/worker/src/parallel-parts-git.js";
import { readCandidateRepositories } from "../../packages/worker/src/verification/candidate.js";

const taskId = "8c330a74-b4c6-4f01-9356-5fe54fc55b19";
const operationId = "8c330a74-b4c6-4f01-9356-5fe54fc55b20";
const runId = "8c330a74-b4c6-4f01-9356-5fe54fc55b21";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const item = (id: string, dependsOn: string[] = []) => ({ id, title: id.slice(0, 2), description: "Do it.", repository: "app", dependsOn });
const graphOf = (...items: ReturnType<typeof item>[]): TaskGraphV1 => ({ schemaVersion: 1, taskId, version: 1, items });

let root: string;
let repository: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rovara-parts-")));
  repository = join(root, "repo/app");
  await mkdir(repository, { recursive: true });
  git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(repository, "shared.txt"), "one\ntwo\nthree\nfour\nfive\n");
  await writeFile(join(repository, "README.md"), "base\n");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "base");
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const treeNow = async (): Promise<string> => (await readCandidateRepositories([{ repositoryId: "app", directory: repository }]))[0]!.treeSha;

/** The worker's loop around the parts, with an edit function standing in for the model. */
async function build(graph: TaskGraphV1, edit: (itemId: string, directory: string, attempt: number) => Promise<void>, options: { maxParallel?: number; before?: (itemId: string) => Promise<void> } = {}) {
  const initialTreeSha = await treeNow();
  const events: Array<{ itemId: string; state: string; baseTreeSha: string }> = [];
  const attempts = new Map<string, number>();
  const result = await executeParallelWorkflowDependencies({
    graph, graphDigest: taskGraphDigest(graph), runId, operationId, initialTreeSha, maxParallel: options.maxParallel ?? 3,
    now: () => new Date().toISOString(),
    persist: async (event) => { events.push(event); },
    execute: async (workItem, context) => {
      const attempt = (attempts.get(workItem.id) ?? 0) + 1;
      attempts.set(workItem.id, attempt);
      const copy = await createPartWorkingCopy({ rootPath: root, repositoryDirectory: repository, repositoryId: "app", itemId: workItem.id, treeSha: context.baseTreeSha });
      try {
        await options.before?.(workItem.id);
        await edit(workItem.id, copy.directory, attempt);
        return { treeSha: await capturePartTree(copy, repository) };
      } finally { await copy.remove(); }
    },
    integrate: ({ integratedTreeSha, baseTreeSha, partTreeSha }) => integrateTrees(repository, { integratedTreeSha, baseTreeSha, partTreeSha }),
    checkout: (treeSha) => checkoutIntegratedTree(repository, initialTreeSha, treeSha),
  });
  return { result, events, initialTreeSha };
}

const read = (file: string) => readFile(join(repository, file), "utf8");

describe("parallel parts on real git", () => {
  it("merges clean parts, builds the dependent part on both changes, and leaves the repository on the integrated tree", async () => {
    const seenByC: string[] = [];
    const { result, events } = await build(graphOf(item(A), item(B), item(C, [A, B])), async (itemId, directory) => {
      if (itemId === A) await writeFile(join(directory, "a.txt"), "from a\n");
      if (itemId === B) await writeFile(join(directory, "b.txt"), "from b\n");
      if (itemId === C) {
        seenByC.push(await readFile(join(directory, "a.txt"), "utf8"), await readFile(join(directory, "b.txt"), "utf8"));
        await writeFile(join(directory, "c.txt"), "from c\n");
      }
    });
    expect(seenByC).toEqual(["from a\n", "from b\n"]);
    expect([await read("a.txt"), await read("b.txt"), await read("c.txt")]).toEqual(["from a\n", "from b\n", "from c\n"]);
    expect(await treeNow()).toBe(result.finalTreeSha);
    // The repository's own index is as it was (the files differ from it, as after an agent's edits), so the run can go on from here one part at a time.
    expect(git("diff", "--cached", "--name-only")).toBe("");
    expect(git("status", "--porcelain")).toContain("a.txt");
    expect(events.map((event) => event.state).filter((state) => state === "IMPLEMENTED")).toHaveLength(3);
    // `.agentx` is outside every repository: git never sees it, and nothing of the parts is left.
    expect(git("status", "--porcelain")).not.toContain(".agentx");
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
    expect(git("branch", "--list").split("\n").map((line) => line.trim().replace("* ", ""))).toEqual(["main"]);
    expect(existsSync(join(root, PARTS_DIRECTORY, A))).toBe(false);
    expect(await readdir(join(root, PARTS_DIRECTORY)).catch(() => [])).toEqual([]);
  });

  it("the project repository does not change while the parts run, and each part starts from the code as it was", async () => {
    const before = await treeNow();
    const seen: string[] = [];
    await build(graphOf(item(A), item(B)), async (itemId, directory) => {
      expect(await treeNow()).toBe(before);
      seen.push(await readFile(join(directory, "README.md"), "utf8"));
      await writeFile(join(directory, `${itemId.slice(0, 2)}.txt`), "x\n");
    });
    expect(seen).toEqual(["base\n", "base\n"]);
  });

  it("starts from the code with its uncommitted changes, and a part's deletion of an untracked file is carried out", async () => {
    await writeFile(join(repository, "notes.txt"), "mine\n");
    await writeFile(join(repository, "README.md"), "edited\n");
    const { result } = await build(graphOf(item(A)), async (_itemId, directory) => {
      expect(await readFile(join(directory, "README.md"), "utf8")).toBe("edited\n");
      await rm(join(directory, "notes.txt"));
    });
    expect(existsSync(join(repository, "notes.txt"))).toBe(false);
    expect(await read("README.md")).toBe("edited\n");
    expect(await treeNow()).toBe(result.finalTreeSha);
  });

  it("on a conflict re-runs the part alone on the integrated tree, so the final code holds both edits", async () => {
    const starts: Array<{ itemId: string; shared: string }> = [];
    const { result, events } = await build(graphOf(item(A), item(B)), async (itemId, directory, attempt) => {
      const file = join(directory, "shared.txt");
      starts.push({ itemId, shared: await readFile(file, "utf8") });
      if (itemId === A) {
        await writeFile(file, (await readFile(file, "utf8")).replace("three", "three by a"));
      } else {
        // B edits the same line, and waits so that A is merged first.
        await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 400 : 0));
        const text = await readFile(file, "utf8");
        await writeFile(file, attempt === 1 ? text.replace("three", "three by b") : text.replace("three by a", "three by a and b"));
      }
    });
    expect(await read("shared.txt")).toBe("one\ntwo\nthree by a and b\nfour\nfive\n");
    expect(starts.filter((entry) => entry.itemId === B)).toHaveLength(2);
    expect(starts.filter((entry) => entry.itemId === B)[1]!.shared).toContain("three by a\n");
    expect(events.filter((event) => event.itemId === B && event.state === "STARTED")).toHaveLength(2);
    expect(await treeNow()).toBe(result.finalTreeSha);
  });

  it("merges edits in different parts of one file without a conflict", async () => {
    await build(graphOf(item(A), item(B)), async (itemId, directory) => {
      const file = join(directory, "shared.txt");
      const text = await readFile(file, "utf8");
      await writeFile(file, itemId === A ? text.replace("one", "ONE") : text.replace("five", "FIVE"));
    });
    expect(await read("shared.txt")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
  });

  it("leaves no folder, branch or worktree behind when a part fails, and keeps the merged work of the one that finished", async () => {
    await expect(build(graphOf(item(A), item(B)), async (itemId, directory) => {
      if (itemId === A) throw new Error("model stopped");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await writeFile(join(directory, "b.txt"), "from b\n");
    })).rejects.toThrow(/failed part/);
    expect(await read("b.txt")).toBe("from b\n");
    expect(existsSync(join(repository, "a.txt"))).toBe(false);
    expect(await readdir(join(root, PARTS_DIRECTORY)).catch(() => [])).toEqual([]);
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
    expect(git("branch", "--list").split("\n")).toHaveLength(1);
    expect(git("status", "--porcelain")).not.toContain(".agentx");
  });

  it("a part's folder is under the worker's parts folder and outside the project repository", async () => {
    await build(graphOf(item(A)), async (_itemId, directory) => {
      expect(directory.startsWith(join(root, PARTS_DIRECTORY) + "/")).toBe(true);
      expect(directory.startsWith(repository)).toBe(false);
      await writeFile(join(directory, "inside.txt"), "ok\n");
      expect(existsSync(join(repository, "inside.txt"))).toBe(false);
    });
  });

  it("refuses part folders that could leave the parts folder", () => {
    for (const bad of ["../x", "a/../b", "/abs", "a//b", ".", ""]) expect(() => partDirectory(root, A, bad)).toThrow(/unsafe folder/);
    expect(() => partDirectory(root, "../escape", "app")).toThrow(/unsafe folder/);
    expect(partDirectory(root, A, "org/app")).toBe(join(root, PARTS_DIRECTORY, A, "org", "app"));
  });

  it("will not check out over a repository that changed while the parts ran", async () => {
    const initial = await treeNow();
    const copy = await createPartWorkingCopy({ rootPath: root, repositoryDirectory: repository, repositoryId: "app", itemId: A, treeSha: initial });
    await writeFile(join(copy.directory, "a.txt"), "a\n");
    const partTree = await capturePartTree(copy, repository);
    await copy.remove();
    await writeFile(join(repository, "README.md"), "someone else\n");
    await expect(checkoutIntegratedTree(repository, initial, partTree)).rejects.toThrow(/changed while parts/);
    expect(await read("README.md")).toBe("someone else\n");
    expect(existsSync(join(repository, "a.txt"))).toBe(false);
  });

  it("reports a conflict as a conflict, and a clean three-way merge as the merged tree", async () => {
    const base = await treeNow();
    const make = async (itemId: string, change: (text: string) => string) => {
      const copy = await createPartWorkingCopy({ rootPath: root, repositoryDirectory: repository, repositoryId: "app", itemId, treeSha: base });
      const file = join(copy.directory, "shared.txt");
      await writeFile(file, change(await readFile(file, "utf8")));
      const tree = await capturePartTree(copy, repository);
      await copy.remove();
      return tree;
    };
    const left = await make(A, (text) => text.replace("three", "left"));
    const right = await make(B, (text) => text.replace("three", "right"));
    const other = await make(C, (text) => text.replace("five", "5"));
    expect(await integrateTrees(repository, { integratedTreeSha: left, baseTreeSha: base, partTreeSha: right })).toEqual({ ok: false });
    const merged = await integrateTrees(repository, { integratedTreeSha: left, baseTreeSha: base, partTreeSha: other });
    expect(merged.ok).toBe(true);
    if (merged.ok) expect(git("show", `${merged.treeSha}:shared.txt`)).toBe("one\ntwo\nleft\nfour\n5");
  });
});
