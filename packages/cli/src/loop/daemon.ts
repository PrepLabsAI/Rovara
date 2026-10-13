// rovara loop (#355): the daemon. It reads the issues of every registered repository, turns comments from
// collaborators into events, asks the runtime what to do, and does it: labels and comments on GitHub, the
// agent's worktree and tmux session, and the answers to the agent's claims. One tick at a time, so two
// events never act on one item at once.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseComment } from "./commands-parse.js";
import { readLoopConfig, type LoopRepoConfig } from "./config.js";
import { loopNamed, stepOf, type LoopDefinition } from "./definitions.js";
import type { Exec } from "./exec.js";
import type { GitHub } from "./github.js";
import type { ClaudeCodeHarness } from "./harness.js";
import { RESUMED_ASSIGNMENT } from "./instructions.js";
import { LOOP_COMMENT_MARKER, LOOP_MCP_SERVER, itemBranch, tmuxSessionName } from "./naming.js";
import { decide, type Effect, type LoopEvent } from "./runtime.js";
import type { LoopStore, RegisteredRepo, WorkItemState } from "./state.js";
import { ensureWorktree } from "./worktree.js";

/** A claim the agent's MCP tool left for the daemon, and the daemon's answer. */
export const ClaimSchema = z.object({ claimId: z.string().uuid(), summary: z.string().max(20_000) }).strict();
export const VerdictSchema = z.object({ outcome: z.enum(["pass", "block"]), reason: z.string() }).strict();

/** How many times in a row a working agent's session is restarted before the loop stops trying and says so. */
const RESTARTS_MAX = 3;
const SEEN_MAX = 1_000;

export interface DaemonDeps {
  store: LoopStore;
  exec: Exec;
  github: GitHub;
  harness: ClaudeCodeHarness;
  /** How to run this CLI again, for the agent's MCP server: [node, path to the CLI]. */
  cliCommand: readonly string[];
  now: () => Date;
  log: (line: string) => void;
}

export class LoopDaemon {
  private readonly restarts = new Map<string, number>();

  constructor(private readonly deps: DaemonDeps) {}

  /** Reads every repository's new comments and closed issues. */
  async poll(): Promise<void> {
    for (const registered of await this.deps.store.repos()) {
      try {
        await this.pollRepo(registered);
      } catch (error) {
        this.deps.log(`poll ${registered.repo}: ${(error as Error).message}`);
      }
    }
  }

  /** Answers every claim the agents left, and keeps working agents' sessions running. */
  async attend(): Promise<void> {
    for (const registered of await this.deps.store.repos()) {
      for (const item of await this.deps.store.items(registered.repo)) {
        try {
          await this.answerClaims(registered, item);
          await this.keepWorking(registered, item);
        } catch (error) {
          this.deps.log(`${item.repo}#${item.issue}: ${(error as Error).message}`);
        }
      }
    }
  }

  private async pollRepo(registered: RegisteredRepo): Promise<void> {
    const config = await readLoopConfig(registered.path);
    const now = this.deps.now().toISOString();
    // A repository seen for the first time starts from now: comments from before it was added are never replayed.
    const cursor = (await this.deps.store.cursor(registered.repo)) ?? { since: now, seen: [] };
    const seen = new Set(cursor.seen);
    let since = cursor.since;
    for (const comment of await this.deps.github.commentsSince(registered.repo, cursor.since)) {
      if (comment.updatedAt > since) since = comment.updatedAt;
      if (seen.has(comment.id)) continue;
      seen.add(comment.id);
      if (comment.body.trimStart().startsWith(LOOP_COMMENT_MARKER)) continue;
      // Only collaborators are obeyed; anyone else's words never reach the agent.
      if (!config.collaborators.some((login) => login.toLowerCase() === comment.author.toLowerCase())) continue;
      const parsed = parseComment(comment.body);
      const at = comment.updatedAt;
      if (parsed.kind === "invalid") await this.deps.github.comment(registered.repo, comment.issue, parsed.reason);
      else if (parsed.kind === "start") await this.handle(registered, config, comment.issue, { kind: "start", loop: parsed.loop, instruction: parsed.instruction, author: comment.author, at });
      else if (parsed.kind === "stop") await this.handle(registered, config, comment.issue, { kind: "stop", author: comment.author, at });
      else await this.handle(registered, config, comment.issue, { kind: "reply", text: parsed.text, author: comment.author, at });
    }
    await this.deps.store.saveCursor(registered.repo, { since, seen: [...seen].slice(-SEEN_MAX) });
    for (const item of await this.deps.store.items(registered.repo)) {
      if (stepOf(loopNamed(item.loop), item.step).terminal) continue;
      if (await this.deps.github.issueState(registered.repo, item.issue) === "closed") {
        await this.handle(registered, config, item.issue, { kind: "closed", at: now });
      }
    }
  }

  private async answerClaims(registered: RegisteredRepo, item: WorkItemState): Promise<void> {
    const inbox = this.deps.store.inboxDir(item.repo, item.issue);
    let names: string[];
    try { names = await readdir(inbox); } catch { return; }
    for (const name of names.filter((entry) => /^claim-[0-9a-f-]{36}\.json$/.test(entry))) {
      const path = join(inbox, name);
      const claim = ClaimSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      await rm(path, { force: true });
      if (!claim.success) continue;
      await this.handle(registered, await readLoopConfig(registered.path), item.issue, { kind: "claim", claimId: claim.data.claimId, summary: claim.data.summary, at: this.deps.now().toISOString() });
    }
  }

  /** A working agent whose session ended (a crash, a closed terminal) is resumed, a few times, then told about. */
  private async keepWorking(registered: RegisteredRepo, item: WorkItemState): Promise<void> {
    const loop = loopNamed(item.loop);
    if (item.session === undefined || stepOf(loop, item.step).actor !== "agent") return;
    if (await this.deps.harness.alive(item.session.tmux)) return;
    const key = `${item.repo}#${item.issue}`;
    const restarts = this.restarts.get(key) ?? 0;
    if (restarts >= RESTARTS_MAX) return;
    this.restarts.set(key, restarts + 1);
    if (restarts + 1 === RESTARTS_MAX) {
      await this.deps.github.comment(item.repo, item.issue, `The agent's session ended ${RESTARTS_MAX} times in a row, so I stopped restarting it. Check that \`claude\` runs on the computer running the loop, then reply here to try again.`);
    }
    await this.startSession(registered, await readLoopConfig(registered.path), item, RESUMED_ASSIGNMENT, true);
  }

  private async handle(registered: RegisteredRepo, config: LoopRepoConfig, issue: number, event: LoopEvent): Promise<void> {
    const current = await this.deps.store.item(registered.repo, issue);
    // A start uses its own loop; anything else uses the loop running on the issue, and is nothing without one.
    const loop: LoopDefinition | undefined = event.kind === "start" ? event.loop : current === undefined ? undefined : loopNamed(current.loop);
    if (loop === undefined) {
      if (event.kind === "claim") await this.writeVerdict(registered.repo, issue, event.claimId, { outcome: "block", reason: "no loop is running on this issue" });
      return;
    }
    const decision = decide(loop, current, event, { repo: registered.repo, issue });
    let state = decision.state;
    await this.deps.store.appendEvent(registered.repo, issue, {
      at: this.deps.now().toISOString(), event: event.kind, ...(event.kind === "reply" || event.kind === "start" || event.kind === "stop" ? { author: event.author } : {}),
      from: current?.step ?? null, to: state?.step ?? null, effects: decision.effects.map((effect) => effect.kind),
    });
    if (state !== undefined) await this.deps.store.saveItem(state);
    if (event.kind === "reply" || event.kind === "start") this.restarts.delete(`${registered.repo}#${issue}`);
    for (const effect of decision.effects) {
      if (state === undefined) break;
      state = await this.apply(registered, config, state, effect);
    }
  }

  private async apply(registered: RegisteredRepo, config: LoopRepoConfig, state: WorkItemState, effect: Effect): Promise<WorkItemState> {
    switch (effect.kind) {
      case "label":
        await this.deps.github.setLabel(state.repo, state.issue, effect.label);
        return state;
      case "comment":
        await this.deps.github.comment(state.repo, state.issue, effect.body);
        return state;
      case "assign":
        return this.assign(registered, config, state, effect.text);
      case "end-session":
        if (state.session !== undefined) await this.deps.harness.stop(state.session.tmux);
        return state;
      case "verdict":
        await this.writeVerdict(state.repo, state.issue, effect.claimId, { outcome: effect.outcome, reason: effect.reason });
        return state;
    }
  }

  /** Gives the agent `text`: into its running session, or by starting (or resuming) one with it. */
  private async assign(registered: RegisteredRepo, config: LoopRepoConfig, state: WorkItemState, text: string): Promise<WorkItemState> {
    if (state.session !== undefined && await this.deps.harness.alive(state.session.tmux)) {
      await this.deps.harness.deliver(state.session.tmux, text);
      return state;
    }
    return this.startSession(registered, config, state, text, state.session !== undefined);
  }

  private async startSession(registered: RegisteredRepo, config: LoopRepoConfig, state: WorkItemState, prompt: string, resume: boolean): Promise<WorkItemState> {
    const worktree = state.worktree ?? { path: join(this.deps.store.itemDir(state.repo, state.issue), "worktree"), branch: itemBranch(state.issue) };
    await ensureWorktree(this.deps.exec, registered.path, worktree.path, worktree.branch);
    const session = state.session ?? { harness: "claude-code" as const, tmux: tmuxSessionName(state.repo, state.issue), id: randomUUID() };
    const sessionDir = this.deps.store.sessionDir(state.repo, state.issue);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const mcpConfigPath = join(sessionDir, "mcp.json");
    const [command = process.execPath, ...cliArgs] = this.deps.cliCommand;
    await writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: { [LOOP_MCP_SERVER]: {
      command, args: [...cliArgs, "loop", "mcp", "--repo", state.repo, "--issue", String(state.issue)],
    } } }, null, 2)}\n`, { mode: 0o600 });
    await this.deps.harness.start({ tmux: session.tmux, id: session.id, cwd: worktree.path, mcpConfigPath, args: config.harness.args, prompt, resume });
    const next: WorkItemState = { ...state, worktree, session };
    await this.deps.store.saveItem(next);
    return next;
  }

  private async writeVerdict(repo: string, issue: number, claimId: string, verdict: z.infer<typeof VerdictSchema>): Promise<void> {
    const inbox = this.deps.store.inboxDir(repo, issue);
    await mkdir(inbox, { recursive: true, mode: 0o700 });
    await writeFile(join(inbox, `verdict-${claimId}.json`), JSON.stringify(verdict), { mode: 0o600 });
  }
}
