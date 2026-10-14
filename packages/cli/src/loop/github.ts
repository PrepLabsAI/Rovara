// rovara loop (#355): GitHub, through the developer's own `gh` login. The loop stores no token.
import { run, type Exec } from "./exec.js";
import { LOOP_COMMENT_MARKER } from "./naming.js";

export interface IssueComment { id: number; issue: number; author: string; body: string; updatedAt: string }
/** #359: a pull request as the Review loop reviews it. */
export interface PullRequestRef {
  repo: string; number: number; open: boolean; base: string; head: string; url: string;
  /** The repository and branch its head commit is on: this repository's, or a fork's. */
  headRepo: string; headRef: string;
}

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

  /** The stable repository identity GitHub reports for the repository at an already resolved owner/name. */
  async repositoryId(repo: string): Promise<number> {
    const value = Number((await run(this.exec, "gh", ["api", `repos/${repo}`, "--jq", ".id"])).trim());
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`GitHub returned no stable repository ID for ${repo}`);
    return value;
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

  /** #358: every inline review comment on the repository's pull requests updated since `since`, oldest first. */
  async reviewCommentsSince(repo: string, since: string): Promise<Array<IssueComment & { path?: string; line?: number }>> {
    const out = await run(this.exec, "gh", [
      "api", "--paginate", `repos/${repo}/pulls/comments?since=${encodeURIComponent(since)}&sort=updated&direction=asc&per_page=100`,
      "--jq", ".[] | {id, pull_request_url, author: .user.login, body, path, line, updated_at}",
    ]);
    return out.split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
      const value = JSON.parse(line) as { id?: unknown; pull_request_url?: unknown; author?: unknown; body?: unknown; path?: unknown; line?: unknown; updated_at?: unknown };
      const pull = typeof value.pull_request_url === "string" ? Number(/\/pulls\/(\d+)$/u.exec(value.pull_request_url)?.[1]) : Number.NaN;
      if (typeof value.id !== "number" || !Number.isInteger(pull) || typeof value.author !== "string" || typeof value.body !== "string" || typeof value.updated_at !== "string") return [];
      return [{ id: value.id, issue: pull, author: value.author, body: value.body, updatedAt: value.updated_at,
        ...(typeof value.path === "string" ? { path: value.path } : {}), ...(typeof value.line === "number" ? { line: value.line } : {}) }];
    });
  }

  /** #358: a pull request's submitted reviews: who, their verdict, and what they wrote. */
  async pullReviews(repo: string, pull: number): Promise<Array<{ id: number; author: string; state: string; body: string; submittedAt: string }>> {
    const out = await run(this.exec, "gh", ["api", "--paginate", `repos/${repo}/pulls/${pull}/reviews?per_page=100`, "--jq", ".[] | {id, author: .user.login, state, body, submitted_at}"]);
    return out.split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
      const value = JSON.parse(line) as { id?: unknown; author?: unknown; state?: unknown; body?: unknown; submitted_at?: unknown };
      if (typeof value.id !== "number" || typeof value.author !== "string" || typeof value.state !== "string" || typeof value.submitted_at !== "string") return [];
      return [{ id: value.id, author: value.author, state: value.state, body: typeof value.body === "string" ? value.body : "", submittedAt: value.submitted_at }];
    });
  }

  /**
   * #359: pull request `number`, open or not, with its base branch and head commit; undefined when `number` is an issue,
   * not a pull request.
   */
  async pullRequest(repo: string, number: number): Promise<PullRequestRef | undefined> {
    const found = await this.exec("gh", ["api", `repos/${repo}/pulls/${number}`, "--jq", "{state, base: .base.ref, head: .head.sha, url: .html_url, headRepo: .head.repo.full_name, headRef: .head.ref}"]);
    if (found.code !== 0) {
      if (/HTTP 404|Not Found/u.test(found.stderr)) return undefined;
      throw new Error(`gh could not read ${repo}#${number}: ${found.stderr.trim().split("\n").pop() ?? ""}`);
    }
    const value = JSON.parse(found.stdout) as { state?: unknown; base?: unknown; head?: unknown; url?: unknown; headRepo?: unknown; headRef?: unknown };
    if (typeof value.base !== "string" || typeof value.head !== "string") return undefined;
    return {
      repo, number, open: value.state === "open", base: value.base, head: value.head, url: typeof value.url === "string" ? value.url : "",
      // A deleted fork has no repository; its branch can no longer take a follow-up.
      headRepo: typeof value.headRepo === "string" ? value.headRepo : "", headRef: typeof value.headRef === "string" ? value.headRef : "",
    };
  }

  /** #359: the pull requests that mention issue `issue` (GitHub's cross-references), in any repository: owner/name and number. */
  async linkedPulls(repo: string, issue: number): Promise<Array<{ repo: string; number: number }>> {
    const out = await run(this.exec, "gh", ["api", "--paginate", `repos/${repo}/issues/${issue}/timeline?per_page=100`, "--jq",
      '.[] | select(.event == "cross-referenced") | .source.issue | select(.pull_request != null) | {repo: .repository.full_name, number}']);
    const found = new Map<string, { repo: string; number: number }>();
    for (const line of out.split("\n").filter((entry) => entry.trim() !== "")) {
      const value = JSON.parse(line) as { repo?: unknown; number?: unknown };
      if (typeof value.repo === "string" && typeof value.number === "number") found.set(`${value.repo}#${value.number}`, { repo: value.repo, number: value.number });
    }
    return [...found.values()];
  }

  /** #359: opens an issue, and answers its number. */
  async createIssue(repo: string, title: string, body: string): Promise<number> {
    const out = await run(this.exec, "gh", ["api", "-X", "POST", `repos/${repo}/issues`, "--input", "-", "--jq", ".number"], { input: JSON.stringify({ title, body }) });
    const number = Number(out.trim());
    if (!Number.isInteger(number) || number <= 0) throw new Error(`GitHub answered no issue number for the new issue in ${repo}`);
    return number;
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
