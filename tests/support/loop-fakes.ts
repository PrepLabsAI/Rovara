// rovara loop (#355): a fake GitHub, git and tmux behind the loop's one Exec, with real state: comments with
// times, labels, open and closed issues, worktrees on disk, and tmux sessions with what was typed into them.
import { mkdir } from "node:fs/promises";
import type { Exec, ExecResult } from "../../packages/cli/src/loop/exec.js";
import { LOOP_COMMENT_MARKER } from "../../packages/cli/src/loop/naming.js";

export interface FakeComment { id: number; issue: number; author: string; body: string; updated_at: string }
export interface FakeSession { name: string; cwd: string; claude: string[]; received: string[] }

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
  clock = Date.parse("2026-10-12T12:00:00.000Z");
  /** When set, a started session exits at once (a broken `claude`). */
  sessionsDie = false;

  constructor(readonly repo = "acme/payments", readonly developer = "maya") {}

  /** Someone comments on an issue, a second after the last thing that happened. */
  say(issue: number, author: string, body: string): FakeComment {
    this.clock += 1_000;
    const comment = { id: this.nextId++, issue, author, body, updated_at: new Date(this.clock).toISOString() };
    this.comments.push(comment);
    return comment;
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
    if (first === "repo" && second === "view") return ok(`${this.repo}\n`);
    if (first === "label" && second === "create") { this.labelsCreated.push(args[2] ?? ""); return ok(); }
    if (first !== "api") return fail(`unexpected gh ${args.join(" ")}`);
    const method = args[1] === "-X" ? args[2] : "GET";
    const path = args[1] === "-X" ? args[3] ?? "" : args[1] === "--paginate" ? args[2] ?? "" : args[1] ?? "";
    const comments = /^repos\/[^/]+\/[^/]+\/issues\/comments\?since=([^&]+)/.exec(path);
    if (comments !== null) {
      const since = decodeURIComponent(comments[1] ?? "");
      return ok(this.comments.filter((comment) => comment.updated_at >= since).sort((left, right) => left.updated_at.localeCompare(right.updated_at))
        .map((comment) => JSON.stringify({ id: comment.id, issue_url: `https://api.github.com/repos/${this.repo}/issues/${comment.issue}`, author: comment.author, body: comment.body, updated_at: comment.updated_at })).join("\n"));
    }
    const issue = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)(\/.*)?$/.exec(path);
    if (issue === null) return fail(`unexpected path ${path}`);
    const number = Number(issue[1]);
    const rest = issue[2] ?? "";
    const labels = this.labels.get(number) ?? new Set<string>();
    this.labels.set(number, labels);
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
    if (sub === "symbolic-ref") return ok("origin/main\n");
    if (sub === "rev-parse") return fail("", 1);
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
        const claudeAt = args.indexOf("claude");
        const session = { name, cwd: target("-c"), claude: args.slice(claudeAt + 1), received: [] };
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
      default: return fail(`unexpected tmux ${args.join(" ")}`);
    }
  }
}
