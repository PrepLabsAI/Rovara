import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realExec } from "../../packages/cli/src/loop/exec.js";
import { captureCandidate } from "../../packages/cli/src/loop/candidate.js";

const roots: string[] = [];

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

async function candidateRepo(ignoreNodeModules: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rovara-candidate-untracked-"));
  roots.push(root);
  const checkout = join(root, "checkout");
  await mkdir(checkout, { recursive: true });
  git(checkout, "init", "-b", "main");
  git(checkout, "config", "user.email", "test@example.invalid");
  git(checkout, "config", "user.name", "Synthetic fixture");
  await writeFile(join(checkout, ".gitignore"), ignoreNodeModules ? "node_modules/\n" : "");
  await writeFile(join(checkout, "tracked.txt"), "base\n");
  git(checkout, "add", ".gitignore", "tracked.txt");
  git(checkout, "commit", "-m", "base");
  const baseCommit = git(checkout, "rev-parse", "HEAD");
  git(checkout, "branch", "rovara/42");
  git(checkout, "switch", "rovara/42");
  await writeFile(join(checkout, "tracked.txt"), "candidate\n");
  git(checkout, "commit", "-am", "candidate");
  git(checkout, "update-ref", "refs/remotes/origin/main", baseCommit);
  return checkout;
}

describe("registered candidate captures", () => {
  it("holds nonignored untracked source files", async () => {
    const checkout = await candidateRepo(false);
    await writeFile(join(checkout, "untracked-helper.mjs"), "export const helper = true;\n");

    await expect(captureCandidate(realExec, checkout, "rovara/42", "origin/main"))
      .rejects.toMatchObject({ reasonCode: "candidate_untracked_changes" });
  });

  it("allows ignored dependency material without treating it as candidate source", async () => {
    const checkout = await candidateRepo(true);
    const dependencyDir = join(checkout, "node_modules", "fixture-helper");
    await mkdir(dependencyDir, { recursive: true });
    await writeFile(join(dependencyDir, "index.mjs"), "export const helper = true;\n");

    await expect(captureCandidate(realExec, checkout, "rovara/42", "origin/main"))
      .resolves.toMatchObject({ branch: "rovara/42", baseCommitSha: git(checkout, "rev-parse", "origin/main") });
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
