// rovara loop (#355): GitHub, through the developer's own `gh` login. The loop stores no token.
import { run, type Exec } from "./exec.js";
import { LOOP_COMMENT_MARKER } from "./naming.js";

export interface IssueComment { id: number; issue: number; author: string; body: string; updatedAt: string }

/** The labels the loop puts on issues, so a step shows on the issue list. Not the-loop's `loop:*` labels. */
export const LABEL_PREFIX = "rovara:";
const LABEL_COLOR = "5319e7";

export class GitHub {
  private readonly labelsMade = new Set<string>();

  constructor(private readonly exec: Exec) {}

  /** The signed-in developer's login. */
  async login(): Promise<string> {
    return (await run(this.exec, "gh", ["api", "user", "--jq", ".login"])).trim();
  }

  /** The `owner/name` of the repository checked out at `path`. */
  async repoAt(path: string): Promise<string> {
    return (await run(this.exec, "gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: path })).trim();
  }

  /**
   * The repository's default branch, as GitHub says: a clone's origin/HEAD is set when it was cloned and is not
   * updated when the default branch changes, so a worktree or pull request based on it can aim at a stale branch.
   */
  async defaultBranch(repo: string): Promise<string> {
    const name = (await run(this.exec, "gh", ["api", `repos/${repo}`, "--jq", ".default_branch"])).trim();
    if (!/^[A-Za-z0-9._/-]{1,200}$/u.test(name)) throw new Error(`GitHub named no default branch for ${repo}`);
    return name;
  }

  /** Every issue and pull request comment updated since `since`, oldest first. */
  async commentsSince(repo: string, since: string): Promise<IssueComment[]> {
    const out = await run(this.exec, "gh", [
      "api", "--paginate", `repos/${repo}/issues/comments?since=${encodeURIComponent(since)}&sort=updated&direction=asc&per_page=100`,
      "--jq", ".[] | {id, issue_url, author: .user.login, body, updated_at}",
    ]);
    return out.split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
      const value = JSON.parse(line) as { id?: unknown; issue_url?: unknown; author?: unknown; body?: unknown; updated_at?: unknown };
      const issue = typeof value.issue_url === "string" ? Number(/\/issues\/(\d+)$/.exec(value.issue_url)?.[1]) : Number.NaN;
      if (typeof value.id !== "number" || !Number.isInteger(issue) || typeof value.author !== "string" || typeof value.body !== "string" || typeof value.updated_at !== "string") return [];
      return [{ id: value.id, issue, author: value.author, body: value.body, updatedAt: value.updated_at }];
    });
  }

  async issueState(repo: string, issue: number): Promise<"open" | "closed"> {
    return (await run(this.exec, "gh", ["api", `repos/${repo}/issues/${issue}`, "--jq", ".state"])).trim() === "closed" ? "closed" : "open";
  }

  /** A comment from the loop, marked so the poller never reads it as an instruction. */
  async comment(repo: string, issue: number, body: string): Promise<void> {
    await run(this.exec, "gh", ["api", "-X", "POST", `repos/${repo}/issues/${issue}/comments`, "--input", "-"], { input: JSON.stringify({ body: `${LOOP_COMMENT_MARKER}\n${body}` }) });
  }

  /** Leaves at most one rovara:<label> on the issue: `label`, or none. */
  async setLabel(repo: string, issue: number, label: string | undefined): Promise<void> {
    const wanted = label === undefined ? undefined : `${LABEL_PREFIX}${label}`;
    const current = (await run(this.exec, "gh", ["api", `repos/${repo}/issues/${issue}/labels`, "--jq", ".[].name"])).split("\n").map((name) => name.trim()).filter((name) => name.startsWith(LABEL_PREFIX));
    for (const name of current.filter((name) => name !== wanted)) {
      await run(this.exec, "gh", ["api", "-X", "DELETE", `repos/${repo}/issues/${issue}/labels/${encodeURIComponent(name)}`]);
    }
    if (wanted === undefined || current.includes(wanted)) return;
    if (!this.labelsMade.has(`${repo} ${wanted}`)) {
      await run(this.exec, "gh", ["label", "create", wanted, "--repo", repo, "--color", LABEL_COLOR, "--description", "rovara loop: where this issue's loop stands", "--force"]);
      this.labelsMade.add(`${repo} ${wanted}`);
    }
    await run(this.exec, "gh", ["api", "-X", "POST", `repos/${repo}/issues/${issue}/labels`, "--input", "-"], { input: JSON.stringify({ labels: [wanted] }) });
  }
}
