import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runIsolatedGit } from "../../packages/worker/src/isolated-repository.js";
import { gitOriginalCode, ORIGINAL_CODE_REF } from "../../packages/worker/src/verification/original-code.js";

// A ref the worker removes (an `update-ref -d` run in the throwaway repository) must be gone from the workspace afterwards, whether the agent left it loose, packed
// (`git pack-refs --all` is an ordinary thing to run), or both: packed-refs is rewritten under packed-refs.lock, keeping its header, its other entries and their
// peeled lines.
const execFile = promisify(execFileCallback);
const roots: string[] = [];

const git = async (directory: string, ...args: string[]): Promise<string> => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trim();
const refExists = (directory: string, name: string) => git(directory, "show-ref", "--verify", "--quiet", name).then(() => true, () => false);

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-refs-")));
  roots.push(root);
  const directory = join(root, "repo");
  await mkdir(directory);
  await git(directory, "init", "--quiet", "--initial-branch=main");
  await git(directory, "config", "user.email", "agentx@example.invalid");
  await git(directory, "config", "user.name", "AgentX Test");
  await writeFile(join(directory, "a.txt"), "1\n");
  await git(directory, "add", ".");
  await git(directory, "commit", "--quiet", "-m", "one");
  const one = await git(directory, "rev-parse", "HEAD");
  await git(directory, "tag", "-a", "-m", "release", "v1");
  await writeFile(join(directory, "a.txt"), "2\n");
  await git(directory, "commit", "--quiet", "-am", "two");
  const two = await git(directory, "rev-parse", "HEAD");
  return { root, directory, one, two };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deleting a ref the agent packed", () => {
  it("removes a ref that exists only in packed-refs, keeping the header, the other entries and their peeled lines", async () => {
    const box = await repository();
    await git(box.directory, "update-ref", "refs/agentx/x", box.one);
    await git(box.directory, "pack-refs", "--all");
    expect(await readFile(join(box.directory, ".git", "refs", "agentx", "x")).catch(() => undefined)).toBeUndefined();
    const before = await readFile(join(box.directory, ".git", "packed-refs"), "utf8");
    expect(before).toContain("refs/agentx/x");
    expect(before).toMatch(/\^[0-9a-f]{40}/u);

    await runIsolatedGit(box.directory, ["update-ref", "-d", "refs/agentx/x"]);

    expect(await refExists(box.directory, "refs/agentx/x")).toBe(false);
    const after = await readFile(join(box.directory, ".git", "packed-refs"), "utf8");
    expect(after).not.toContain("refs/agentx/x");
    expect(after).toContain("# pack-refs with:");
    expect(after).toContain("refs/tags/v1");
    expect(after).toMatch(/\^[0-9a-f]{40}/u);
    expect(await git(box.directory, "rev-parse", "v1^{commit}")).toBe(box.one);
    expect(await git(box.directory, "rev-parse", "refs/heads/main")).toBe(box.two);
  });

  it("removes a ref that is both loose and packed, so the packed value does not reappear", async () => {
    const box = await repository();
    await git(box.directory, "update-ref", "refs/agentx/x", box.one);
    await git(box.directory, "pack-refs", "--all");
    await git(box.directory, "update-ref", "refs/agentx/x", box.two);
    expect(await refExists(box.directory, "refs/agentx/x")).toBe(true);

    await runIsolatedGit(box.directory, ["update-ref", "-d", "refs/agentx/x"]);

    expect(await refExists(box.directory, "refs/agentx/x")).toBe(false);
    expect(await readFile(join(box.directory, ".git", "packed-refs"), "utf8")).not.toContain("refs/agentx/x");
    expect(await git(box.directory, "for-each-ref", "--format=%(refname)", "refs/agentx/")).toBe("");
  });

  it("names a stale packed-refs.lock instead of removing the ref around it", async () => {
    const box = await repository();
    await git(box.directory, "update-ref", "refs/agentx/x", box.one);
    await git(box.directory, "pack-refs", "--all");
    const lock = join(box.directory, ".git", "packed-refs.lock");
    await writeFile(lock, "");
    await expect(runIsolatedGit(box.directory, ["update-ref", "-d", "refs/agentx/x"])).rejects.toThrow(lock);
    await rm(lock);
    expect(await refExists(box.directory, "refs/agentx/x")).toBe(true);
  });

  it("clears the original-code ref after the agent ran `git pack-refs --all` while the original code showed", async () => {
    const box = await repository();
    await writeFile(join(box.directory, "a.txt"), "the agent's version\n");
    let refDuring = "";
    await gitOriginalCode([{ directory: box.directory, commit: box.one }]).run(async () => {
      refDuring = await git(box.directory, "rev-parse", "--verify", ORIGINAL_CODE_REF);
      // What an agent process may do at any moment: pack every ref, including the private one.
      await git(box.directory, "pack-refs", "--all");
    });
    expect(refDuring).toMatch(/^[0-9a-f]{40}$/u);
    expect(await refExists(box.directory, ORIGINAL_CODE_REF)).toBe(false);
    expect(await readFile(join(box.directory, ".git", "packed-refs"), "utf8")).not.toContain(ORIGINAL_CODE_REF);
    expect(await readFile(join(box.directory, "a.txt"), "utf8")).toBe("the agent's version\n");
  });
});
