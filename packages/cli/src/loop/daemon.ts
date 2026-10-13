// rovara loop (#355, #356): the daemon. It reads the issues of every registered repository, turns comments from
// collaborators into events, asks the runtime what to do, and does it: labels and comments on GitHub, the
// agent's worktree and tmux session, the answers to the agent's claims, and the steps the loop runs itself
// (the checks, publishing). One event at a time per item, so two events never act on one item at once.
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactText } from "@agentx/contracts";
import { z } from "zod";
import { checksReport, runChecks, shellCheckRun, type CheckRun } from "./check-runner.js";
import { parseComment } from "./commands-parse.js";
import { readLoopConfig, type LoopRepoConfig } from "./config.js";
import { loopNamed, stepOf, type LoopDefinition } from "./definitions.js";
import type { Exec } from "./exec.js";
import { artifactDigest, failedExitChecks, readArtifact } from "./exit-checks.js";
import type { GitHub } from "./github.js";
import type { ClaudeCodeHarness } from "./harness.js";
import { RESUMED_ASSIGNMENT } from "./instructions.js";
import { LOOP_COMMENT_MARKER, LOOP_MCP_SERVER, artifactPath, evidencePath, itemBranch, tmuxSessionName } from "./naming.js";
import { run } from "./exec.js";
import type { Artifact } from "./definitions.js";
import { publish } from "./publish.js";
import { decide, type Effect, type LoopEvent } from "./runtime.js";
import type { LoopStore, RegisteredRepo, WorkItemState } from "./state.js";
import { ensureWorktree } from "./worktree.js";

/** A claim the agent's MCP tool left for the daemon, and the daemon's answer. */
export const ClaimSchema = z.object({ claimId: z.string().uuid(), summary: z.string().max(20_000) }).strict();
export const VerdictSchema = z.object({ outcome: z.enum(["pass", "block"]), reason: z.string() }).strict();

/** How many times in a row a working agent's session is restarted before the loop stops trying and says so. */
const RESTARTS_MAX = 3;
const SEEN_MAX = 1_000;
/** How long a permission prompt waits before the issue is told the agent needs its person. */
const APPROVAL_NOTICE_MS = 60_000;

export interface DaemonDeps {
  store: LoopStore;
  exec: Exec;
  github: GitHub;
  harness: ClaudeCodeHarness;
  /** How to run this CLI again, for the agent's MCP server: [node, path to the CLI]. */
  cliCommand: readonly string[];
  now: () => Date;
  log: (line: string) => void;
  /** How the repository's checks run; the shell by default. */
  checkRun?: CheckRun;
}

type ActionResult = Extract<LoopEvent, { kind: "action-result" }>;

export class LoopDaemon {
  private readonly restarts = new Map<string, number>();
  /** The loop's own steps now running, by item, and their results waiting to be handled. */
  private readonly running = new Map<string, Promise<void>>();
  private readonly results = new Map<string, ActionResult>();
  /** When each item's agent was first seen waiting on a permission prompt, and whether the issue was told. */
  private readonly prompts = new Map<string, { since: number; told: boolean }>();

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

  /** Answers every claim, handles finished steps of the loop's own, starts the ones due, and keeps agents running. */
  async attend(): Promise<void> {
    for (const registered of await this.deps.store.repos()) {
      for (const item of await this.deps.store.items(registered.repo)) {
        try {
          await this.answerClaims(registered, item);
          await this.handleResult(registered, item);
          const current = await this.deps.store.item(item.repo, item.issue) ?? item;
          await this.startAction(registered, current);
          await this.keepWorking(registered, current);
          await this.noticePrompt(current);
        } catch (error) {
          this.deps.log(`${item.repo}#${item.issue}: ${(error as Error).message}`);
        }
      }
    }
  }

  /** Waits for the loop's own steps that are running now (for tests, and before stopping). */
  async settle(): Promise<void> {
    await Promise.all([...this.running.values()]);
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
      const author = comment.author;
      switch (parsed.kind) {
        case "invalid": await this.deps.github.comment(registered.repo, comment.issue, parsed.reason); break;
        case "start": await this.handle(registered, config, comment.issue, { kind: "start", loop: parsed.loop, instruction: parsed.instruction, author, at, ...(parsed.skip.length === 0 ? {} : { skip: parsed.skip }) }); break;
        case "stop": await this.handle(registered, config, comment.issue, { kind: "stop", author, at }); break;
        case "approve": {
          // The approval locks the artifact the gate shows, as it is now.
          const item = await this.deps.store.item(registered.repo, comment.issue);
          const reviewed = item === undefined ? undefined : stepOf(loopNamed(item.loop), item.step).artifact;
          const text = item === undefined || reviewed === undefined ? undefined : await readArtifact(item.worktree?.path, item.issue, reviewed);
          await this.handle(registered, config, comment.issue, { kind: "approve", author, at, ...(text === undefined ? {} : { digest: artifactDigest(text) }) });
          break;
        }
        case "changes": await this.handle(registered, config, comment.issue, { kind: "changes", text: parsed.text, author, at }); break;
        case "reply": await this.handle(registered, config, comment.issue, { kind: "reply", text: parsed.text, author, at }); break;
      }
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
      // The exit checks read the worktree, so they run here; the runtime gets only what failed.
      const current = await this.deps.store.item(item.repo, item.issue) ?? item;
      const loop = loopNamed(current.loop);
      const step = stepOf(loop, current.step);
      const failures = step.actor === "agent" ? await failedExitChecks(step.exit, { summary: claim.data.summary, issue: current.issue, worktree: current.worktree?.path, artifact: step.artifact, approvals: current.approvals }) : [];
      // The artifact this step wrote is shown at its gate.
      const artifact = step.artifact === undefined ? undefined : await readArtifact(current.worktree?.path, current.issue, step.artifact);
      await this.handle(registered, await readLoopConfig(registered.path), item.issue, {
        kind: "claim", claimId: claim.data.claimId, summary: claim.data.summary, failures, ...(artifact === undefined ? {} : { artifact }), at: this.deps.now().toISOString(),
      });
    }
  }

  /** A step of the loop's own that finished is handled as its event. */
  private async handleResult(registered: RegisteredRepo, item: WorkItemState): Promise<void> {
    const key = `${item.repo}#${item.issue}`;
    const result = this.results.get(key);
    if (result === undefined) return;
    this.results.delete(key);
    await this.handle(registered, await readLoopConfig(registered.path), item.issue, result);
  }

  /** Starts the loop's own step an item is on, unless it is running: also after a restart, which forgot it. */
  private async startAction(registered: RegisteredRepo, item: WorkItemState): Promise<void> {
    const step = stepOf(loopNamed(item.loop), item.step);
    const key = `${item.repo}#${item.issue}`;
    if (step.action === undefined || this.running.has(key) || this.results.has(key)) return;
    const config = await readLoopConfig(registered.path);
    const action = step.action;
    const done = (outcome: ActionResult["outcome"], detail: string, extra: Partial<ActionResult> = {}) => {
      this.results.set(key, { kind: "action-result", action, outcome, detail, at: this.deps.now().toISOString(), ...extra });
    };
    const work = (async () => {
      try {
        if (action === "checks") await this.runItemChecks(item, config, done);
        else await this.publishItem(item, done);
      } catch (error) {
        done("failed", redactText((error as Error).message).slice(0, 1_000));
      } finally {
        this.running.delete(key);
      }
    })();
    this.running.set(key, work);
  }

  private async runItemChecks(item: WorkItemState, config: LoopRepoConfig, done: (outcome: ActionResult["outcome"], detail: string) => void): Promise<void> {
    if (item.worktree === undefined) throw new Error("the item has no worktree to check");
    const results = await runChecks(config.checks, item.worktree.path, this.deps.checkRun ?? shellCheckRun);
    const report = checksReport(results);
    const current = await this.deps.store.item(item.repo, item.issue);
    if (current !== undefined) await this.deps.store.saveItem({ ...current, checks: report.slice(0, 20_000) });
    done(results.every((result) => result.passed) ? "passed" : "failed", report);
  }

  private async publishItem(item: WorkItemState, done: (outcome: ActionResult["outcome"], detail: string, extra?: Partial<ActionResult>) => void): Promise<void> {
    if (item.worktree === undefined) throw new Error("the item has no worktree to publish");
    await this.commitEvidence(item.worktree.path, item.issue, item.checks ?? "The checks passed.");
    const published = await publish(this.deps.exec, {
      repo: item.repo, issue: item.issue, worktree: item.worktree.path, branch: item.worktree.branch,
      plan: await readArtifact(item.worktree.path, item.issue, "plan"), checks: item.checks ?? "The checks passed.",
      startedBy: item.startedBy, approvals: item.approvals, skipped: item.skipped, pullRequest: item.pullRequest, defaultBranch: await this.deps.github.defaultBranch(item.repo),
    });
    const { number, url } = published.pullRequest;
    done("published", published.created ? `Opened pull request #${number}: ${url}\n\nReply here to ask for changes; the loop runs the checks again and pushes them to the same pull request.` : `Pushed the update to pull request #${number}: ${url}`, { pullRequest: published.pullRequest });
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

  /** An agent stuck on a permission prompt for a minute: the issue says it is waiting for its person, once per prompt. */
  private async noticePrompt(item: WorkItemState): Promise<void> {
    const key = `${item.repo}#${item.issue}`;
    const working = item.session !== undefined && stepOf(loopNamed(item.loop), item.step).actor === "agent";
    if (!working || item.session === undefined || !await this.deps.harness.alive(item.session.tmux) || !await this.deps.harness.waitingForApproval(item.session.tmux)) {
      this.prompts.delete(key);
      return;
    }
    const now = this.deps.now().getTime();
    const prompt = this.prompts.get(key) ?? { since: now, told: false };
    this.prompts.set(key, prompt);
    if (prompt.told || now - prompt.since < APPROVAL_NOTICE_MS) return;
    prompt.told = true;
    await this.deps.github.comment(item.repo, item.issue, `The agent is waiting for your approval in its terminal: \`tmux attach -t =${item.session.tmux}\` on the computer running the loop.`);
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
      at: this.deps.now().toISOString(), event: event.kind,
      ...("author" in event ? { author: event.author } : {}), ...(event.kind === "action-result" ? { action: event.action, outcome: event.outcome } : {}),
      from: current?.step ?? null, to: state?.step ?? null, effects: decision.effects.map((effect) => effect.kind),
    });
    if (state !== undefined) await this.deps.store.saveItem(state);
    if (event.kind === "reply" || event.kind === "changes" || event.kind === "start") this.restarts.delete(`${registered.repo}#${issue}`);
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
      case "run":
        // Started on the next attend, in the background, so a long check never holds up other items.
        return state;
      case "record-feedback":
        await this.recordFeedback(state, effect.artifact, effect.author, effect.text);
        return state;
    }
  }

  /**
   * The checks report, committed by the loop at docs/rovara/<issue>/evidence/checks.md before it publishes, so the
   * branch carries what proved it. Added with -f: a repository may ignore docs/. Nothing is committed when unchanged.
   */
  private async commitEvidence(worktree: string, issue: number, report: string): Promise<void> {
    const relative = evidencePath(issue, "checks.md");
    await mkdir(join(worktree, relative, ".."), { recursive: true });
    await writeFile(join(worktree, relative), `# Checks\n\nRun by rovara loop before it published this branch.\n\n${report}\n`);
    await run(this.deps.exec, "git", ["-C", worktree, "add", "-f", relative]);
    if ((await this.deps.exec("git", ["-C", worktree, "diff", "--cached", "--quiet"])).code === 0) return;
    await run(this.deps.exec, "git", ["-C", worktree, "commit", "--quiet", "-m", `chore(rovara): checks evidence for #${issue}`, "--", relative]);
  }

  /** A change request, added to its artifact under "Review feedback", so the document carries its own history. */
  private async recordFeedback(state: WorkItemState, artifact: Artifact, author: string, text: string): Promise<void> {
    if (state.worktree === undefined) return;
    const path = join(state.worktree.path, artifactPath(state.issue, artifact));
    const plan = await readFile(path, "utf8").catch(() => undefined);
    if (plan === undefined) return;
    const entry = `- @${author} (${this.deps.now().toISOString()}): ${text.replace(/\n+/gu, " ")}\n`;
    await appendFile(path, /\n## Review feedback\n/u.test(plan) ? entry : `\n## Review feedback\n\n${entry}`);
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
    await ensureWorktree(this.deps.exec, registered.path, worktree.path, worktree.branch, await this.deps.github.defaultBranch(state.repo));
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

