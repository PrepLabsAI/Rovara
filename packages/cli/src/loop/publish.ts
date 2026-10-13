// rovara loop (#356): publishing, which the loop does itself, never the agent: push the item's branch, then open
// its pull request (or, when it has one, say the update is pushed). It runs only after the plan was approved and
// the checks passed. A push that would overwrite anything is refused by git, and so is ours.
import { run, type Exec } from "./exec.js";

export interface PublishInput {
  repo: string;
  issue: number;
  worktree: string;
  branch: string;
  plan: string | undefined;
  checks: string;
  startedBy: string;
  approvedBy: string | undefined;
  /** The pull request's base: the repository's default branch, as GitHub names it. */
  defaultBranch: string;
  pullRequest: { number: number; url: string } | undefined;
}

export interface Published { pullRequest: { number: number; url: string }; created: boolean }

export async function publish(exec: Exec, input: PublishInput): Promise<Published> {
  await run(exec, "git", ["-C", input.worktree, "push", "--quiet", "--set-upstream", "origin", input.branch]);
  if (input.pullRequest !== undefined) return { pullRequest: input.pullRequest, created: false };
  // A pull request opened before a restart lost it from the state is found, never opened twice.
  const found = (await run(exec, "gh", ["pr", "list", "--repo", input.repo, "--head", input.branch, "--state", "open", "--json", "number,url", "--jq", ".[0] // empty | \"\\(.number) \\(.url)\""])).trim();
  if (found !== "") {
    const [number, url] = found.split(" ");
    return { pullRequest: { number: Number(number), url: url ?? "" }, created: false };
  }
  const base = input.defaultBranch;
  const title = (await run(exec, "gh", ["api", `repos/${input.repo}/issues/${input.issue}`, "--jq", ".title"])).trim() || `Issue #${input.issue}`;
  const body = [
    `Closes #${input.issue}.`,
    "",
    `Opened by rovara loop's Quick loop for @${input.startedBy}${input.approvedBy === undefined ? "" : `; the plan was approved by @${input.approvedBy}`}.`,
    "",
    "## Plan",
    "",
    input.plan ?? "(the plan could not be read)",
    "",
    "## Checks",
    "",
    input.checks,
  ].join("\n");
  const url = (await run(exec, "gh", ["pr", "create", "--repo", input.repo, "--head", input.branch, "--base", base, "--title", title, "--body-file", "-"], { input: body, cwd: input.worktree })).trim().split("\n").pop() ?? "";
  const number = Number(/\/pull\/(\d+)$/u.exec(url)?.[1]);
  if (!Number.isInteger(number)) throw new Error(`gh pr create answered something that is not a pull request address: ${url.slice(0, 200)}`);
  return { pullRequest: { number, url }, created: true };
}
