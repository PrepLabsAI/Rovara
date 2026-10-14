// rovara loop (#356): publishing, which the loop does itself, never the agent: push the item's branch, then open
// its pull request (or, when it has one, say the update is pushed). It runs only after the plan was approved and
// the checks passed. A push that would overwrite anything is refused by git, and so is ours.
import { run, type Exec } from "./exec.js";

export interface PublishInput {
  /** The repository the pull request is opened in. */
  repo: string;
  /** #358: the issue's repository, when it is another (a per-PR loop's pull request); its title is the pull request's. */
  issueRepo?: string;
  issue: number;
  /** #358: the description's first line: `Closes #<issue>.` by default, or `Part of owner/name#<issue>.` elsewhere. */
  closes?: string;
  worktree: string;
  branch: string;
  plan: string | undefined;
  checks: string;
  /** #358: the reviews report, when the loop ran them. */
  reviews?: string | undefined;
  startedBy: string;
  /** Who approved each document; the description names them. */
  approvals: Partial<Record<"requirements" | "design" | "plan" | "contribution", { by: string }>> | undefined;
  /** Phases declared away when the loop started. */
  skipped: readonly string[] | undefined;
  /** The pull request's base: the repository's default branch, as GitHub names it (or, #359, the branch it follows up). */
  defaultBranch: string;
  /** #359: the head as `gh pr create` names it when the pull request is in another repository (`owner:branch`). */
  head?: string;
  /** #359: what the planning document is called in the description: "Plan", or "Contribution". */
  planHeading?: string;
  pullRequest: { number: number; url: string; repo?: string | undefined } | undefined;
  /** Host-owned candidate/enrollment/evidence check, awaited immediately before every push. */
  beforePush: () => Promise<void>;
  /** #394: a person published past reviews that blocked or couldn't run. */
  reviewsAccepted?: { by: string; at: string; unrun: boolean } | undefined;
}

export interface Published { pullRequest: { number: number; url: string; repo?: string | undefined }; created: boolean }

/** " Approved: the requirements by @a, the plan by @b. Declared away: design." */
function approvalLine(input: PublishInput): string {
  const approved = (["requirements", "design", "plan"] as const).flatMap((artifact) => {
    const approval = input.approvals?.[artifact];
    return approval === undefined ? [] : [`the ${artifact} by @${approval.by}`];
  });
  const skipped = input.skipped ?? [];
  return `${approved.length === 0 ? "" : ` Approved: ${approved.join(", ")}.`}${skipped.length === 0 ? "" : ` Declared away: ${skipped.join(", ")}.`}`;
}

/**
 * #394: a document embedded in the description, its headings one level down (outside code blocks), so its sections sit
 * under the description's own: "## Summary" in a plan becomes "### Summary" under "## Plan".
 */
export function demoteHeadings(markdown: string): string {
  let fence: string | undefined;
  return markdown.split("\n").map((line) => {
    const opening = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (opening !== undefined) {
      if (fence === undefined) fence = opening[0];
      else if (opening[0] === fence) fence = undefined;
      return line;
    }
    return fence === undefined && /^#{1,5} /u.test(line) ? `#${line}` : line;
  }).join("\n");
}

/** The pull request's description: written when it opens, and (#394) again on every push, so it says what is so now. */
export function describe(input: PublishInput): string {
  const accepted = input.reviewsAccepted === undefined ? [] : [
    `> **@${input.reviewsAccepted.by} published this past reviews that ${input.reviewsAccepted.unrun ? "could not be run" : "still blocked it"}** (${input.reviewsAccepted.at}).`, "",
  ];
  return [
    input.closes ?? `Closes #${input.issue}.`,
    "",
    `Opened by rovara loop for @${input.startedBy}.${approvalLine(input)}`,
    "",
    `## ${input.planHeading ?? "Plan"}`,
    "",
    input.plan === undefined ? "(the plan could not be read)" : demoteHeadings(input.plan),
    "",
    "## Checks",
    "",
    input.checks,
    ...(input.reviews === undefined ? [] : ["", "## Reviews", "", ...accepted, input.reviews]),
  ].join("\n");
}

export async function publish(exec: Exec, input: PublishInput): Promise<Published> {
  await input.beforePush();
  await run(exec, "git", ["-C", input.worktree, "push", "--quiet", "--set-upstream", "origin", input.branch]);
  // A pull request opened before a restart lost it from the state is found, never opened twice.
  let existing = input.pullRequest;
  if (existing === undefined) {
    const found = (await run(exec, "gh", ["pr", "list", "--repo", input.repo, "--head", input.branch, "--state", "open", "--json", "number,url", "--jq", ".[0] // empty | \"\\(.number) \\(.url)\""])).trim();
    if (found !== "") {
      const [number, url] = found.split(" ");
      existing = { number: Number(number), url: url ?? "" };
    }
  }
  if (existing !== undefined) {
    // #394: the description follows the branch: the checks, the reviews, and who published past them, now.
    await run(exec, "gh", ["api", "-X", "PATCH", `repos/${existing.repo ?? input.repo}/pulls/${existing.number}`, "--input", "-"], { input: JSON.stringify({ body: describe(input) }) });
    return { pullRequest: existing, created: false };
  }
  const base = input.defaultBranch;
  const title = (await run(exec, "gh", ["api", `repos/${input.issueRepo ?? input.repo}/issues/${input.issue}`, "--jq", ".title"])).trim() || `Issue #${input.issue}`;
  const url = (await run(exec, "gh", ["pr", "create", "--repo", input.repo, "--head", input.head ?? input.branch, "--base", base, "--title", title, "--body-file", "-"], { input: describe(input), cwd: input.worktree })).trim().split("\n").pop() ?? "";
  const number = Number(/\/pull\/(\d+)$/u.exec(url)?.[1]);
  if (!Number.isInteger(number)) throw new Error(`gh pr create answered something that is not a pull request address: ${url.slice(0, 200)}`);
  return { pullRequest: { number, url }, created: true };
}
