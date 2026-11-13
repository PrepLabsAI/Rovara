import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isolatedGitEnvironment } from "../../packages/worker/src/git.js";
import type { MutationSpotOptions } from "../../packages/worker/src/verification/mutation-spot-check.js";

export async function fixture(files: Record<string, string> = { "value.ts": "export const value = true;\n" }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "b11-fixture-")));
  const directory = join(root, "candidate");
  await mkdir(directory);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Codex", "-c", "user.email=noreply@openai.com", ...args], {
    cwd: directory, encoding: "utf8", env: isolatedGitEnvironment(directory, { GIT_LITERAL_PATHSPECS: "1", GIT_GLOB_PATHSPECS: "0", GIT_NOGLOB_PATHSPECS: "0", GIT_ICASE_PATHSPECS: "0" }),
  }).trim();
  git("init", "--quiet", "--template=");
  git("commit", "--allow-empty", "--quiet", "-m", "fixture base\n\nCo-Authored-By: Codex <noreply@openai.com>");
  const startCommit = git("rev-parse", "HEAD");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  git("add", "--all");
  git("commit", "--quiet", "-m", "fixture candidate\n\nCo-Authored-By: Codex <noreply@openai.com>");
  const candidateTreeSha = git("rev-parse", "HEAD^{tree}");
  const scratchRoot = join(root, "scratch");
  await mkdir(scratchRoot);
  const repository = { directory, startCommit, candidateTreeSha };
  const selection: MutationSpotOptions["selection"] = [{
    command: { cwd: ".", executable: "node", args: ["--outputFile=report.json", "--json"], timeoutSeconds: 30 },
    check: { id: "unit", selectArgs: ["{tests}"] },
    inventory: ["test.ts", "other1.ts", "other2.ts", "other3.ts"], affectedTests: ["test.ts"],
    coverageMap: { builtAt: new Date().toISOString(), files: Object.fromEntries(Object.keys(files).map((path) => [path, ["test.ts"]])) },
  }];
  return { root, directory, repository, selection, scratchRoot, git };
}
export const report = (status: "passed" | "failed" | "skipped") => JSON.stringify({ testResults: [{ name: "test.ts", assertionResults: [{ fullName: "test", status }] }] });
