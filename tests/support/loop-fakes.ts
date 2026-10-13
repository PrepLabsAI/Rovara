// rovara loop (#355, #358): a fake GitHub, git and tmux behind the loop's one Exec, with real state: comments with
// times, labels, open and closed issues, worktrees on disk, and tmux sessions with what was typed into them. Several
// repositories (#358) are several worlds sharing one clock, with GitHub calls routed by repository.
import { mkdir } from "node:fs/promises";
import type { Exec, ExecResult } from "../../packages/cli/src/loop/exec.js";
import { LOOP_COMMENT_MARKER } from "../../packages/cli/src/loop/naming.js";

export interface FakeComment { id: number; issue: number; author: string; body: string; updated_at: string }
export interface FakeSession {
  name: string; cwd: string;
  /** The agent started (#359), and its arguments: `claude` holds them whichever agent it is. */
  agent: "claude" | "codex"; claude: string[];
  received: string[]; /** What its terminal shows. */ screen: string;
}
export interface FakeReviewComment { id: number; pull: number; author: string; body: string; path: string; line: number; updated_at: string }
export interface FakeReview { id: number; pull: number; author: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"; body: string; submitted_at: string }
export interface FakePullRequest { number: number; url: string; head: string; base: string; title: string; body: string }

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: "", stderr });

export class LoopWorld {
  readonly comments: FakeComment[] = [];
  readonly closed = new Set<number>();
  readonly labels = new Map<number, Set<string>>();
  readonly sessions = new Map<string, FakeSession>();
  /** Every session ever started, in order, including ones since killed. */
  readonly started: FakeSession[] = [];
  readonly labelsCreated: string[] = [];
  readonly calls: string[][] = [];
  private nextId = 1_000;
  private buffers = new Map<string, string>();
  private ownClock = Date.parse("2026-10-12T12:00:00.000Z");
  /** Now, in this world; another repository's world shares the first one's. */
  get clock(): number { return this.clockOf === undefined ? this.ownClock : this.clockOf.clock; }
  set clock(value: number) { if (this.clockOf === undefined) this.ownClock = value; else this.clockOf.clock = value; }
  /** The first pull request opened here is number pullBase + 1. */
  pullBase = 500;
  /** When set, a started session exits at once (a broken `claude`). */
  sessionsDie = false;
  /** Branches pushed, in order, and the pull requests opened. */
  readonly pushes: string[] = [];
  readonly pullRequests: FakePullRequest[] = [];
  readonly titles = new Map<number, string>();
  /** The default branch GitHub names; the clone's origin/HEAD is never asked. */
  defaultBranch = "main";
  /** What the loop committed itself (its evidence), as "<path>: <message>". */
  readonly loopCommits: string[] = [];
  /** When set, the next push is refused (someone else pushed to the branch). */
  pushRefused = false;
  /** #358: inline review comments and submitted reviews on pull requests. */
  readonly reviewComments: FakeReviewComment[] = [];
  readonly reviews: FakeReview[] = [];
  /** #358: what `git diff <default>...HEAD` shows the reviewers. */
  diff = "diff --git a/src/retry.ts b/src/retry.ts\n+export const RETRIES = 3;\n";

  constructor(readonly repo = "acme/payments", readonly developer = "maya", private readonly clockOf?: LoopWorld) {}

  /** Someone comments on an issue, a second after the last thing that happened. */
  say(issue: number, author: string, body: string): FakeComment {
    this.clock += 1_000;
    const comment = { id: this.nextId++, issue, author, body, updated_at: new Date(this.clock).toISOString() };
    this.comments.push(comment);
    return comment;
  }

  /** Someone leaves an inline review comment on a pull request. */
  reviewComment(pull: number, author: string, body: string, path = "src/retry.ts", line = 12): FakeReviewComment {
    this.clock += 1_000;
    const comment = { id: this.nextId++, pull, author, body, path, line, updated_at: new Date(this.clock).toISOString() };
    this.reviewComments.push(comment);
    return comment;
  }

  /** Someone submits a review on a pull request. */
  review(pull: number, author: string, state: FakeReview["state"], body = ""): FakeReview {
    this.clock += 1_000;
    const review = { id: this.nextId++, pull, author, state, body, submitted_at: new Date(this.clock).toISOString() };
    this.reviews.push(review);
    return review;
  }

  /** What the loop posted on an issue: its comments carry the marker (the developer may comment there too). */
  posted(issue: number): string[] {
    return this.comments.filter((comment) => comment.issue === issue && comment.body.startsWith(LOOP_COMMENT_MARKER)).map((comment) => comment.body);
  }

  exec: Exec = async (command, args, options = {}) => {
    this.calls.push([command, ...args]);
    if (command === "gh") return this.gh([...args], options.input ?? "");
    if (command === "git") return this.git([...args]);
    if (command === "tmux") return this.tmux([...args], options.input ?? "");
    return fail(`${command}: not found`, 127);
  };

  private gh(args: string[], input: string): ExecResult {
    const [first, second] = args;
    if (first === "api" && second === "user") return ok(`${this.developer}\n`);
    if (first === "api" && second === `repos/${this.repo}` && args.includes(".default_branch")) return ok(`${this.defaultBranch}\n`);
    if (first === "repo" && second === "view") return ok(`${this.repo}\n`);
    if (first === "label" && second === "create") { this.labelsCreated.push(args[2] ?? ""); return ok(); }
    if (first === "pr" && second === "list") {
      const head = args[args.indexOf("--head") + 1];
      const found = this.pullRequests.find((pull) => pull.head === head);
      return ok(found === undefined ? "" : `${found.number} ${found.url}\n`);
    }
    if (first === "pr" && second === "create") {
      const at = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
      const number = this.pullBase + this.pullRequests.length + 1;
      const url = `https://github.com/${this.repo}/pull/${number}`;
      this.pullRequests.push({ number, url, head: at("--head"), base: at("--base"), title: at("--title"), body: input });
      return ok(`Creating pull request for ${at("--head")} into ${at("--base")}\n\n${url}\n`);
    }
    if (first !== "api") return fail(`unexpected gh ${args.join(" ")}`);
    const method = args[1] === "-X" ? args[2] : "GET";
    const path = args[1] === "-X" ? args[3] ?? "" : args[1] === "--paginate" ? args[2] ?? "" : args[1] ?? "";
    const comments = /^repos\/[^/]+\/[^/]+\/issues\/comments\?since=([^&]+)/.exec(path);
    if (comments !== null) {
      const since = decodeURIComponent(comments[1] ?? "");
      return ok(this.comments.filter((comment) => comment.updated_at >= since).sort((left, right) => left.updated_at.localeCompare(right.updated_at))
        .map((comment) => JSON.stringify({ id: comment.id, issue_url: `https://api.github.com/repos/${this.repo}/issues/${comment.issue}`, author: comment.author, body: comment.body, updated_at: comment.updated_at })).join("\n"));
    }
    const reviewComments = /^repos\/[^/]+\/[^/]+\/pulls\/comments\?since=([^&]+)/.exec(path);
    if (reviewComments !== null) {
      const since = decodeURIComponent(reviewComments[1] ?? "");
      return ok(this.reviewComments.filter((comment) => comment.updated_at >= since).sort((left, right) => left.updated_at.localeCompare(right.updated_at))
        .map((comment) => JSON.stringify({ id: comment.id, pull_request_url: `https://api.github.com/repos/${this.repo}/pulls/${comment.pull}`, author: comment.author, body: comment.body, path: comment.path, line: comment.line, updated_at: comment.updated_at })).join("\n"));
    }
    const reviews = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews/.exec(path);
    if (reviews !== null) {
      return ok(this.reviews.filter((review) => review.pull === Number(reviews[1]))
        .map((review) => JSON.stringify({ id: review.id, author: review.author, state: review.state, body: review.body, submitted_at: review.submitted_at })).join("\n"));
    }
    const issue = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)(\/.*)?$/.exec(path);
    if (issue === null) return fail(`unexpected path ${path}`);
    const number = Number(issue[1]);
    const rest = issue[2] ?? "";
    const labels = this.labels.get(number) ?? new Set<string>();
    this.labels.set(number, labels);
    if (rest === "" && method === "GET" && args.includes(".title")) return ok(`${this.titles.get(number) ?? `Issue ${number}`}\n`);
    if (rest === "" && method === "GET") return ok(this.closed.has(number) ? "closed\n" : "open\n");
    if (rest === "/comments" && method === "POST") { this.say(number, this.developer, (JSON.parse(input) as { body: string }).body); return ok("{}"); }
    if (rest === "/labels" && method === "GET") return ok([...labels].join("\n"));
    if (rest === "/labels" && method === "POST") { for (const name of (JSON.parse(input) as { labels: string[] }).labels) labels.add(name); return ok("[]"); }
    const removed = /^\/labels\/(.+)$/.exec(rest);
    if (removed !== null && method === "DELETE") { labels.delete(decodeURIComponent(removed[1] ?? "")); return ok("[]"); }
    return fail(`unexpected ${method} ${path}`);
  }

  private async git(args: string[]): Promise<ExecResult> {
    const sub = args[2];
    if (sub === "fetch") return ok();
    // The loop's own evidence commit: something is always staged in this fake.
    if (sub === "add") return ok();
    // `diff --cached --quiet` after the evidence is added: something is staged. Otherwise the change under review.
    if (sub === "diff") return args.includes("--cached") ? fail("", 1) : ok(this.diff);
    if (sub === "commit") { this.loopCommits.push(`${args.slice(args.indexOf("--") + 1).join(", ")}: ${args[args.indexOf("-m") + 1] ?? ""}`); return ok(); }
    if (sub === "push") {
      if (this.pushRefused) { this.pushRefused = false; return fail("! [rejected] (fetch first)"); }
      this.pushes.push(args[args.length - 1] ?? "");
      return ok();
    }
    if (sub === "symbolic-ref") return fail("origin/HEAD is not asked any more", 1);
    // A worktree commits to its checkout's git directory (#359: Codex's sandbox is told it may write there).
    if (sub === "rev-parse" && args.includes("--git-common-dir")) return ok(`/checkouts/${this.repo}/.git\n`);
    // origin has the default branch; no local branch exists yet.
    if (sub === "rev-parse") return args.includes(`refs/remotes/origin/${this.defaultBranch}`) ? ok("abc123\n") : fail("", 1);
    if (sub === "worktree" && args[3] === "add") {
      const dir = args[4] === "-b" ? args[6] : args[4];
      await mkdir(dir ?? "", { recursive: true });
      return ok();
    }
    return fail(`unexpected git ${args.join(" ")}`);
  }

  private tmux(args: string[], input: string): ExecResult {
    const target = (flag: string) => { const at = args.indexOf(flag); return (args[at + 1] ?? "").replace(/^=/, "").replace(/:$/, ""); };
    switch (args[0]) {
      case "has-session": return this.sessions.has(target("-t")) ? ok() : fail("can't find session", 1);
      case "new-session": {
        const name = target("-s");
        if (this.sessions.has(name)) return fail("duplicate session", 1);
        const agentAt = args.findIndex((arg) => arg === "claude" || arg === "codex");
        const session = { name, cwd: target("-c"), agent: args[agentAt] as FakeSession["agent"], claude: args.slice(agentAt + 1), received: [], screen: "" };
        this.started.push(session);
        if (!this.sessionsDie) this.sessions.set(name, session);
        return ok();
      }
      case "load-buffer": this.buffers.set(target("-b"), input); return ok();
      case "paste-buffer": {
        const session = this.sessions.get(target("-t"));
        if (session === undefined) return fail("can't find pane", 1);
        session.received.push(this.buffers.get(target("-b")) ?? "");
        return ok();
      }
      case "send-keys": return this.sessions.has(target("-t")) ? ok() : fail("can't find pane", 1);
      case "kill-session": return this.sessions.delete(target("-t")) ? ok() : fail("can't find session", 1);
      case "capture-pane": { const session = this.sessions.get(target("-t")); return session === undefined ? fail("can't find pane", 1) : ok(session.screen); }
      default: return fail(`unexpected tmux ${args.join(" ")}`);
    }
  }
}

/**
 * #358: several repositories behind one Exec. A GitHub call goes to the world of the repository it names (`--repo`, or
 * a `repos/owner/name` path); git and tmux, and anything naming no repository, go to the first world.
 */
export function routeWorlds(home: LoopWorld, others: readonly LoopWorld[]): Exec {
  const worlds = [home, ...others];
  return async (command, args, options) => {
    if (command !== "gh") return home.exec(command, args, options);
    const flag = args.indexOf("--repo");
    const named = flag >= 0 ? args[flag + 1] : args.map((arg) => /^repos\/([^/]+\/[^/?]+)/u.exec(arg)?.[1]).find((repo) => repo !== undefined);
    return (worlds.find((world) => world.repo === named) ?? home).exec(command, args, options);
  };
}
