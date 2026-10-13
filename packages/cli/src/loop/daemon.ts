// rovara loop (#355, #356, #358): the daemon. It reads the issues of every registered repository, turns comments from
// collaborators into events, asks the runtime what to do, and does it: labels and comments on GitHub, the
// agent's worktree and tmux session, the answers to the agent's claims, and the steps the loop runs itself
// (the checks, the reviews, publishing). One event at a time per item, so two events never act on one item at once.
// An item whose approved plan names other repositories (#358) has a per-PR loop for each: their own worktree, agent,
// checks, reviews and pull request, in that repository, saying what they do on the issue.
import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactText } from "@agentx/contracts";
import { z } from "zod";
import { checksReport, runChecks, shellCheckRun, type CheckRun } from "./check-runner.js";
import { parseComment } from "./commands-parse.js";
import { readLoopConfig, type LoopRepoConfig } from "./config.js";
import { loopNamed, planArtifact, stepOf, type Artifact, type LoopDefinition } from "./definitions.js";
import { run, type Exec } from "./exec.js";
import { artifactDigest, failedExitChecks, readArtifact, splitTargets } from "./exit-checks.js";
import type { GitHub, PullRequestRef } from "./github.js";
import type { AgentHarness } from "./harness.js";
import { RESUMED_ASSIGNMENT, pullAssignment } from "./instructions.js";
import { LOOP_COMMENT_MARKER, LOOP_MCP_SERVER, artifactPath, docsDir, elsewhere, evidencePath, itemBranch, tmuxSessionName } from "./naming.js";
import { publish } from "./publish.js";
import { agentReviewerRun, reviewsReport, runBriefReview, runReviews, type ReviewerRun } from "./reviews.js";
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
/** #358: an issue's own loop waiting on its per-PR loops. */
const WAITING_ON_PULLS = new Set(["pulls", "pulls-approved"]);
/** #358: a per-PR loop whose pull request is open, which takes feedback on the pull request. */
const PULL_OPEN = new Set(["pr-review", "approved"]);

export interface DaemonDeps {
  store: LoopStore;
  exec: Exec;
  github: GitHub;
  harness: AgentHarness;
  /** How to run this CLI again, for the agent's MCP server: [node, path to the CLI]. */
  cliCommand: readonly string[];
  now: () => Date;
  log: (line: string) => void;
  /** How the repository's checks run; the shell by default. */
  checkRun?: CheckRun;
  /** How a reviewer runs (#358): the repository's chosen agent (#359), headless and read-only, by default. */
  reviewerRun?: ReviewerRun;
}

type ActionResult = Extract<LoopEvent, { kind: "action-result" }>;
/** Who a pull request's feedback goes to: the issue's own loop, or (`target`) one of its per-PR loops. */
interface PullOwner { home: RegisteredRepo; issue: number; target?: string }

/** A pull request as the issue names it: `#501` in the issue's own repository, `owner/name#501` in another. */
const pullName = (repo: string, owner: PullOwner, number: number) => `${repo === owner.home.repo ? "" : repo}#${number}`;
/** #359: the longest review report one comment carries; GitHub takes 65,536 characters a comment. */
const REPORT_MAX = 60_000;
type Finding = NonNullable<WorkItemState["findings"]>[number];
const findingLine = (finding: Finding) => `${finding.n}. ${finding.severity === undefined ? "" : `**${finding.severity}** `}${finding.text}${finding.file === undefined ? "" : ` (\`${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}\`)`}`;
const keyOf = (item: { repo: string; issue: number; target?: string | undefined }) => `${item.repo}#${item.issue}${item.target === undefined ? "" : `@${item.target}`}`;
const isTerminal = (item: WorkItemState) => stepOf(loopNamed(item.loop), item.step).terminal;

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
    const registered = await this.deps.store.repos();
    for (const entry of registered) {
      try {
        await this.pollRepo(entry, registered);
      } catch (error) {
        this.deps.log(`poll ${entry.repo}: ${(error as Error).message}`);
      }
    }
  }

  /** Answers every claim, handles finished steps of the loop's own, starts the ones due, and keeps agents running. */
  async attend(): Promise<void> {
    for (const registered of await this.deps.store.repos()) {
      for (const item of await this.deps.store.items(registered.repo)) {
        await this.attendItem(registered, item);
        for (const pull of await this.deps.store.pulls(item.repo, item.issue)) await this.attendItem(registered, pull);
      }
    }
  }

  /** Waits for the loop's own steps that are running now (for tests, and before stopping). */
  async settle(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }

  private async attendItem(registered: RegisteredRepo, item: WorkItemState): Promise<void> {
    try {
      await this.answerClaims(registered, item);
      await this.handleResult(registered, item);
      const current = await this.deps.store.item(item.repo, item.issue, item.target) ?? item;
      await this.startAction(registered, current);
      await this.keepWorking(registered, current);
      await this.noticePrompt(current);
    } catch (error) {
      this.deps.log(`${keyOf(item)}: ${(error as Error).message}`);
    }
  }

  private async pollRepo(registered: RegisteredRepo, everyRepo: readonly RegisteredRepo[]): Promise<void> {
    const config = await readLoopConfig(registered.path);
    const now = this.deps.now().toISOString();
    const isCollaborator = (login: string) => config.collaborators.some((collaborator) => collaborator.toLowerCase() === login.toLowerCase());
    const owners = await this.pullOwners(registered.repo, everyRepo);
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
      if (!isCollaborator(comment.author)) continue;
      const owner = owners.get(comment.issue);
      // #359: a loop that joined a pull request another loop opened (Review) has its conversation, and starts there.
      const joined = owner === undefined ? false : await this.joined(registered.repo, comment.issue, comment.body);
      if (owner === undefined || joined) await this.dispatch(registered, comment.issue, comment.author, comment.body, comment.updatedAt);
      else await this.dispatch(owner.home, owner.issue, comment.author, comment.body, comment.updatedAt, { via: `Comment on pull request ${pullName(registered.repo, owner, comment.issue)}`, target: owner.target });
    }
    await this.deps.store.saveCursor(registered.repo, { since, seen: [...seen].slice(-SEEN_MAX) });
    await this.pollPullRequests(registered, owners, isCollaborator, now);
    for (const item of await this.deps.store.items(registered.repo)) {
      if (isTerminal(item)) continue;
      if (item.loop === "review" && item.step === "waiting") await this.noticePushes(registered, item, now);
      if (await this.deps.github.issueState(registered.repo, item.issue) === "closed") {
        await this.handle(registered, item.issue, { kind: "closed", at: now });
      }
    }
  }

  /**
   * #358: the open pull requests the loop opened in `repo`, by number, and the loop each belongs to: an issue's own
   * loop in that repository, or a per-PR loop of an issue in any repository, so what is said on them reaches it.
   */
  private async pullOwners(repo: string, everyRepo: readonly RegisteredRepo[]): Promise<Map<number, PullOwner>> {
    const owners = new Map<number, PullOwner>();
    for (const home of everyRepo) {
      for (const item of await this.deps.store.items(home.repo)) {
        if (isTerminal(item)) continue;
        if (home.repo === repo && item.pullRequest !== undefined) owners.set(item.pullRequest.number, { home, issue: item.issue });
        for (const pull of await this.deps.store.pulls(home.repo, item.issue)) {
          if (pull.target === repo && pull.pullRequest !== undefined && !isTerminal(pull)) owners.set(pull.pullRequest.number, { home, issue: item.issue, target: pull.target });
        }
      }
    }
    return owners;
  }

  /** #359: whether a comment on a pull request another loop opened belongs to a loop that joined it, or starts one. */
  private async joined(repo: string, number: number, body: string): Promise<boolean> {
    const parsed = parseComment(body);
    if (parsed.kind === "start" && parsed.loop.joins) return true;
    const item = await this.deps.store.item(repo, number);
    return item !== undefined && !isTerminal(item) && loopNamed(item.loop).joins;
  }

  /** #359: the open pull requests a Review loop reviews: the pull request it runs on, or every one that mentions its issue. */
  private async pullsUnderReview(item: WorkItemState): Promise<PullRequestRef[]> {
    const itself = await this.deps.github.pullRequest(item.repo, item.issue);
    if (itself !== undefined) return itself.open ? [itself] : [];
    const found: PullRequestRef[] = [];
    for (const linked of await this.deps.github.linkedPulls(item.repo, item.issue)) {
      const pull = await this.deps.github.pullRequest(linked.repo, linked.number).catch(() => undefined);
      if (pull?.open === true) found.push(pull);
    }
    return found;
  }

  /** #359: new commits on a pull request a waiting Review loop reviewed, or a new one mentioning its issue, start the next round. */
  private async noticePushes(registered: RegisteredRepo, item: WorkItemState, at: string): Promise<void> {
    const changed = (await this.pullsUnderReview(item)).filter((pull) => item.reviewed?.[`${pull.repo}#${pull.number}`] !== pull.head);
    if (changed.length === 0) return;
    const named = changed.map((pull) => `${pull.repo}#${pull.number} (\`${pull.head.slice(0, 7)}\`)`).join(", ");
    await this.handle(registered, item.issue, { kind: "pushed", at, detail: `New commits on ${named}: reviewing again.` });
  }

  /**
   * #358: inline review comments and submitted reviews on the loop's pull requests. Each from a collaborator goes to the
   * loop that owns the pull request as a reply. An approving review approves a per-PR loop's pull request; on an
   * issue's own pull request it is acknowledged. Review IDs are kept negated beside the comment IDs, so the two never
   * collide.
   */
  private async pollPullRequests(registered: RegisteredRepo, owners: Map<number, PullOwner>, isCollaborator: (login: string) => boolean, now: string): Promise<void> {
    const cursor = (await this.deps.store.cursor(registered.repo, "pulls")) ?? { since: now, seen: [] };
    // With no pull request to watch, nothing is asked; the cursor still moves on, so feedback on a pull request
    // opened before the next read is not missed, and none from before is read.
    if (owners.size === 0) {
      await this.deps.store.saveCursor(registered.repo, { since: now, seen: cursor.seen }, "pulls");
      return;
    }
    const seen = new Set(cursor.seen);
    let since = cursor.since;
    for (const comment of await this.deps.github.reviewCommentsSince(registered.repo, cursor.since)) {
      if (comment.updatedAt > since) since = comment.updatedAt;
      if (seen.has(comment.id)) continue;
      seen.add(comment.id);
      const owner = owners.get(comment.issue);
      if (owner === undefined || !isCollaborator(comment.author)) continue;
      const where = comment.path === undefined ? "" : ` on \`${comment.path}${comment.line === undefined ? "" : `:${comment.line}`}\``;
      await this.handle(owner.home, owner.issue, { kind: "reply", text: `Review comment on pull request ${pullName(registered.repo, owner, comment.issue)}${where}:\n${comment.body}`, author: comment.author, at: comment.updatedAt }, owner.target);
    }
    for (const [pull, owner] of owners) {
      for (const review of await this.deps.github.pullReviews(registered.repo, pull)) {
        if (seen.has(-review.id) || review.submittedAt < cursor.since) continue;
        seen.add(-review.id);
        if (!isCollaborator(review.author)) continue;
        if (review.state === "APPROVED") {
          const item = owner.target === undefined ? undefined : await this.deps.store.item(owner.home.repo, owner.issue, owner.target);
          if (item !== undefined && stepOf(loopNamed(item.loop), item.step).approvable) {
            await this.handle(owner.home, owner.issue, { kind: "approve", author: review.author, at: review.submittedAt }, owner.target);
          } else if (owner.target === undefined) {
            await this.deps.github.comment(owner.home.repo, owner.issue, `@${review.author} approved pull request #${pull}. Merging it closes this issue, which ends the loop.`);
          }
        } else if (review.body.trim() !== "") {
          const verdict = review.state === "CHANGES_REQUESTED" ? " (changes requested)" : "";
          await this.handle(owner.home, owner.issue, { kind: "reply", text: `Review by @${review.author} on pull request ${pullName(registered.repo, owner, pull)}${verdict}:\n${review.body.trim()}`, author: review.author, at: review.submittedAt }, owner.target);
        }
      }
    }
    await this.deps.store.saveCursor(registered.repo, { since, seen: [...seen].slice(-SEEN_MAX) }, "pulls");
  }

  /**
   * A collaborator's comment, as the command or reply it is. On a pull request (`on.via`), a start is only a reply, and
   * `on.target` names the per-PR loop it belongs to, if any.
   */
  private async dispatch(home: RegisteredRepo, issue: number, author: string, body: string, at: string, on: { via: string; target: string | undefined } | undefined = undefined): Promise<void> {
    const parsed = parseComment(body);
    const target = on?.target;
    const reply = async (text: string) => {
      const said = on === undefined ? text : `${on.via}:\n${text}`;
      // #358: on an issue waiting on its per-PR loops, a reply on the issue goes to them.
      if (on === undefined && await this.routeToPulls(home, issue, author, said, at)) return;
      await this.handle(home, issue, { kind: "reply", text: said, author, at }, target);
    };
    switch (parsed.kind) {
      case "invalid": if (on === undefined) await this.deps.github.comment(home.repo, issue, parsed.reason); else await reply(body.trim()); return;
      case "start": {
        if (on !== undefined) { await reply(body.trim()); return; }
        // #359: Contribute on a pull request follows it up: it starts from the pull request's head, and its own pull
        // request goes into that branch.
        let upstream: WorkItemState["upstream"];
        if (parsed.loop.name === "contribute") {
          const pull = await this.deps.github.pullRequest(home.repo, issue);
          if (pull !== undefined && (!pull.open || pull.headRepo === "")) {
            await this.deps.github.comment(home.repo, issue, pull.open ? "This pull request's branch is gone (its fork was deleted), so there is nothing to follow up." : "This pull request is closed, so there is nothing to contribute to. Start the Contribute loop on its issue instead.");
            return;
          }
          if (pull !== undefined) upstream = { repo: pull.headRepo, branch: pull.headRef, ref: `refs/rovara/contribute/${issue}` };
        }
        await this.handle(home, issue, { kind: "start", loop: parsed.loop, instruction: parsed.instruction, author, at, ...(parsed.skip.length === 0 ? {} : { skip: parsed.skip }), ...(upstream === undefined ? {} : { upstream }) });
        return;
      }
      case "stop": await this.handle(home, issue, { kind: "stop", author, at }, target); return;
      case "approve": {
        // #358: on an issue waiting on its per-PR loops, an approval is for their blocked reviews.
        if (on === undefined && await this.approvePulls(home, issue, author, at, parsed.repo)) return;
        // The approval locks the artifact the gate shows, as it is now; an approved plan may start per-PR loops.
        const item = await this.deps.store.item(home.repo, issue, target);
        const reviewed = item === undefined ? undefined : stepOf(loopNamed(item.loop), item.step).artifact;
        const text = item === undefined || reviewed === undefined ? undefined : await readArtifact(item.worktree?.path, item.issue, reviewed);
        const targets = reviewed === "plan" && item?.target === undefined ? splitTargets(text, home.repo) : undefined;
        await this.handle(home, issue, { kind: "approve", author, at, ...(text === undefined ? {} : { digest: artifactDigest(text) }), ...(targets === undefined ? {} : { targets }) }, target);
        return;
      }
      case "changes":
        if (on === undefined && await this.routeToPulls(home, issue, author, parsed.text, at)) return;
        await this.handle(home, issue, { kind: "changes", text: parsed.text, author, at }, target);
        return;
      case "reply": await reply(parsed.text); return;
      case "file": await this.fileFindings(home, issue, author, parsed.numbers); return;
    }
  }

  /**
   * #359: `/rovara file 2,4` files a Review loop's findings as issues, in the repository of the pull request each is
   * about, and says what it filed. A finding is filed once.
   */
  private async fileFindings(home: RegisteredRepo, issue: number, author: string, numbers: readonly number[]): Promise<void> {
    const item = await this.deps.store.item(home.repo, issue);
    if (item === undefined || (item.findings ?? []).length === 0) {
      await this.deps.github.comment(home.repo, issue, "There are no review findings here to file. A Review loop (`/rovara review`) numbers its findings, and `/rovara file <n>` files one.");
      return;
    }
    const findings = [...(item.findings ?? [])];
    const said: string[] = [];
    for (const n of numbers) {
      const at = findings.findIndex((finding) => finding.n === n);
      const finding = findings[at];
      if (finding === undefined) { said.push(`- ${n}: there is no finding ${n}.`); continue; }
      const [repo = home.repo] = finding.pull.split("#");
      if (finding.filed !== undefined) { said.push(`- ${n}: already filed as ${repo}#${finding.filed}.`); continue; }
      const title = finding.text.length > 100 ? `${finding.text.slice(0, 97)}…` : finding.text;
      const body = [`Found by a rovara loop review of ${finding.pull}, and filed by @${author}.`, "", findingLine(finding).replace(/^\d+\. /u, ""), "", `From ${home.repo}#${issue}.`].join("\n");
      try {
        const filed = await this.deps.github.createIssue(repo, title, body);
        findings[at] = { ...finding, filed };
        said.push(`- ${n}: filed as ${repo}#${filed}.`);
      } catch (error) {
        said.push(`- ${n}: could not be filed: ${redactText((error as Error).message).slice(0, 300)}`);
      }
    }
    await this.deps.store.saveItem({ ...item, findings });
    await this.deps.github.comment(home.repo, issue, `@${author} asked to file review findings:\n\n${said.join("\n")}`);
  }

  /**
   * #358: a reply on an issue whose loop waits on its per-PR loops goes to them: to one, when it starts with
   * `owner/name:`, or else to each one still working (a loop whose pull request is open takes feedback on it). False
   * when the issue's loop is not waiting on any.
   */
  private async routeToPulls(home: RegisteredRepo, issue: number, author: string, text: string, at: string): Promise<boolean> {
    const item = await this.deps.store.item(home.repo, issue);
    if (item === undefined || !WAITING_ON_PULLS.has(item.step)) return false;
    const pulls = (await this.deps.store.pulls(home.repo, issue)).filter((pull) => !isTerminal(pull));
    const named = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):\s*/u.exec(text);
    const chosen = named === null ? undefined : pulls.find((pull) => pull.target?.toLowerCase() === named[1]?.toLowerCase());
    const working = pulls.filter((pull) => !PULL_OPEN.has(pull.step));
    if (chosen === undefined && working.length === 0) {
      await this.deps.github.comment(home.repo, issue, "Every pull request is open, so this reply reached none of them. Reply on the pull request you mean, or start your reply with `owner/name:`.");
      return true;
    }
    for (const pull of chosen === undefined ? working : [chosen]) {
      await this.handle(home, issue, { kind: "reply", text: chosen === undefined ? text : text.slice(named![0].length), author, at }, pull.target);
    }
    return true;
  }

  /**
   * #358: `/rovara approve` on an issue waiting on its per-PR loops publishes the ones whose reviews still block: the one
   * named (`/rovara approve owner/name`), or each of them. A pull request is approved on itself. False when the issue's
   * loop is not waiting on any.
   */
  private async approvePulls(home: RegisteredRepo, issue: number, author: string, at: string, repo: string | undefined): Promise<boolean> {
    const item = await this.deps.store.item(home.repo, issue);
    if (item === undefined || !WAITING_ON_PULLS.has(item.step)) return false;
    const blocked = (await this.deps.store.pulls(home.repo, issue)).filter((pull) => pull.step === "review-blocked" && (repo === undefined || pull.target?.toLowerCase() === repo.toLowerCase()));
    if (blocked.length === 0) {
      await this.deps.github.comment(home.repo, issue, `${repo === undefined ? "No pull request's reviews are" : `${repo}'s reviews are not`} waiting for a person. Approve a pull request on it: a GitHub approval, or \`/rovara approve\` there.`);
      return true;
    }
    for (const pull of blocked) await this.handle(home, issue, { kind: "approve", author, at }, pull.target);
    return true;
  }

  private async answerClaims(registered: RegisteredRepo, item: WorkItemState): Promise<void> {
    const inbox = this.deps.store.inboxDir(item.repo, item.issue, item.target);
    let names: string[];
    try { names = await readdir(inbox); } catch { return; }
    for (const name of names.filter((entry) => /^claim-[0-9a-f-]{36}\.json$/.test(entry))) {
      const path = join(inbox, name);
      const claim = ClaimSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      await rm(path, { force: true });
      if (!claim.success) continue;
      // The exit checks read the worktree, so they run here; the runtime gets only what failed.
      const current = await this.deps.store.item(item.repo, item.issue, item.target) ?? item;
      const loop = loopNamed(current.loop);
      const step = stepOf(loop, current.step);
      const failures = step.actor === "agent" ? await failedExitChecks(step.exit, {
        summary: claim.data.summary, issue: current.issue, worktree: current.worktree?.path, artifact: step.artifact, approvals: current.approvals,
        docs: docsDir(current), repo: current.repo, registered: (await this.deps.store.repos()).map((entry) => entry.repo), criteria: current.criteria ?? [],
      }) : [];
      // The artifact this step wrote is shown at its gate.
      const artifact = step.artifact === undefined ? undefined : await readArtifact(current.worktree?.path, current.issue, step.artifact);
      await this.handle(registered, item.issue, {
        kind: "claim", claimId: claim.data.claimId, summary: claim.data.summary, failures, ...(artifact === undefined ? {} : { artifact }), at: this.deps.now().toISOString(),
      }, item.target);
    }
  }

  /** A step of the loop's own that finished is handled as its event. */
  private async handleResult(registered: RegisteredRepo, item: WorkItemState): Promise<void> {
    const key = keyOf(item);
    const result = this.results.get(key);
    if (result === undefined) return;
    this.results.delete(key);
    await this.handle(registered, item.issue, result, item.target);
  }

  /** The checkout an item works in: the issue's repository's, or (#358) a per-PR loop's repository's. */
  private async whereOf(item: WorkItemState, home: RegisteredRepo): Promise<RegisteredRepo> {
    if (!elsewhere(item)) return home;
    const found = (await this.deps.store.repos()).find((entry) => entry.repo === item.target);
    if (found === undefined) throw new Error(`${item.target ?? ""} is not added to rovara loop on this computer; run \`rovara loop add\` in its checkout`);
    return found;
  }

  /**
   * #358: the approved plan, which lives in the issue's own worktree, also for a per-PR loop in another repository;
   * (#359) Contribute's is its contribution.
   */
  private async planOf(item: WorkItemState): Promise<string | undefined> {
    const owner = item.target === undefined ? item : await this.deps.store.item(item.repo, item.issue);
    return readArtifact(owner?.worktree?.path, item.issue, planArtifact(loopNamed(item.loop)));
  }

  /** Starts the loop's own step an item is on, unless it is running: also after a restart, which forgot it. */
  private async startAction(registered: RegisteredRepo, item: WorkItemState): Promise<void> {
    const step = stepOf(loopNamed(item.loop), item.step);
    const key = keyOf(item);
    if (step.action === undefined || this.running.has(key) || this.results.has(key)) return;
    const action = step.action;
    const done = (outcome: ActionResult["outcome"], detail: string, extra: Partial<ActionResult> = {}) => {
      this.results.set(key, { kind: "action-result", action, outcome, detail, at: this.deps.now().toISOString(), ...extra });
    };
    const work = (async () => {
      try {
        // The checks and reviews are the repository's own: a per-PR loop uses its repository's configuration.
        const config = await readLoopConfig((await this.whereOf(item, registered)).path);
        if (action === "checks") await this.runItemChecks(item, config, done);
        else if (action === "reviews") await this.reviewItem(item, config, done);
        else if (action === "review") await this.reviewRound(item, config, done);
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
    const current = await this.deps.store.item(item.repo, item.issue, item.target);
    if (current !== undefined) await this.deps.store.saveItem({ ...current, checks: report.slice(0, 20_000) });
    done(results.every((result) => result.passed) ? "passed" : "failed", report);
  }

  /**
   * #358: the code and security reviews of the item's change. What blocks sends the change back to the agent, until
   * `maxRounds` rounds in a row still blocked; then a person decides. A review that could not be run or read never
   * passes: a person decides that too.
   */
  private async reviewItem(item: WorkItemState, config: LoopRepoConfig, done: (outcome: ActionResult["outcome"], detail: string) => void): Promise<void> {
    if (item.worktree === undefined) throw new Error("the item has no worktree to review");
    if (!config.reviews.enabled) {
      done("passed", "Reviews are turned off in `.rovara/loop.yaml`.");
      return;
    }
    const results = await runReviews({
      exec: this.deps.exec, worktree: item.worktree.path,
      // A follow-up (#359) is judged on what it adds to the pull request it builds on.
      base: item.upstream?.ref ?? `origin/${await this.deps.github.defaultBranch(item.target ?? item.repo)}`,
      plan: await this.planOf(item), config: config.reviews, run: this.deps.reviewerRun ?? agentReviewerRun,
    });
    const report = reviewsReport(results);
    const current = await this.deps.store.item(item.repo, item.issue, item.target);
    if (current !== undefined) await this.deps.store.saveItem({ ...current, reviews: report.slice(0, 20_000) });
    if (results.some((result) => result.status === "UNKNOWN")) done("blocked", report);
    else if (results.every((result) => result.status === "PASS")) done("passed", report);
    else done((item.reviewRounds ?? 0) + 1 >= config.reviews.maxRounds ? "blocked" : "failed", report);
  }

  /**
   * #359: a Review loop round. Each open pull request under review is checked out at its head, in a detached worktree
   * of its own, and reviewed against the brief; the findings are numbered on from the last round's. Nothing is
   * changed, committed or pushed.
   */
  private async reviewRound(item: WorkItemState, config: LoopRepoConfig, done: (outcome: ActionResult["outcome"], detail: string) => void): Promise<void> {
    const pulls = await this.pullsUnderReview(item);
    if (pulls.length === 0) {
      done("failed", `There is no open pull request to review. ${(await this.deps.github.pullRequest(item.repo, item.issue)) === undefined ? "Mention this issue in a pull request, then reply here to review it." : "This pull request is not open."}`);
      return;
    }
    const everyRepo = await this.deps.store.repos();
    const earlier = item.findings ?? [];
    const findings = [...earlier];
    const reviewed = { ...item.reviewed };
    const sections: string[] = [];
    let next = earlier.reduce((most, finding) => Math.max(most, finding.n), 0);
    let anyReviewed = false;
    for (const pull of pulls) {
      const name = `${pull.repo}#${pull.number}`;
      const where = everyRepo.find((entry) => entry.repo === pull.repo);
      if (where === undefined) { sections.push(`**${name}**: not reviewed; ${pull.repo} is not added to rovara loop on this computer.`); continue; }
      const worktree = await this.reviewWorktree(item, where, pull);
      const review = await runBriefReview({
        exec: this.deps.exec, worktree, pull: name, base: pull.base, brief: item.instruction, focus: item.focus,
        earlier: earlier.filter((finding) => finding.pull === name), config: config.reviews, run: this.deps.reviewerRun ?? agentReviewerRun,
      });
      reviewed[name] = pull.head;
      const heading = `**${name}** at \`${pull.head.slice(0, 7)}\``;
      if (!review.ok) { sections.push(`${heading}: could not be reviewed; ${review.reason}.`); continue; }
      anyReviewed = true;
      const numbered = review.findings.map((finding): Finding => ({ n: ++next, pull: name, ...finding }));
      findings.push(...numbered);
      sections.push([heading, "", review.summary || "(no summary)", "", ...(numbered.length === 0 ? ["No findings."] : numbered.map(findingLine))].join("\n"));
    }
    const rounds = (item.rounds ?? 0) + 1;
    const current = await this.deps.store.item(item.repo, item.issue);
    if (current !== undefined) await this.deps.store.saveItem({ ...current, findings: findings.slice(-500), reviewed, rounds });
    const report = `### Review, round ${rounds}\n\n${sections.join("\n\n")}`;
    const footer = "---\nNew commits on the pull request start the next round, and so does a reply with more to look at. `/rovara file <n>` files a finding as an issue; `/rovara stop` ends the review.";
    done(anyReviewed ? "passed" : "failed", `${report.length > REPORT_MAX ? `${report.slice(0, REPORT_MAX)}\n\n…(cut)` : report}\n\n${footer}`);
  }

  /** #359: a pull request's head, checked out detached in the review's own worktree, with its base branch fetched to diff against. */
  private async reviewWorktree(item: WorkItemState, where: RegisteredRepo, pull: PullRequestRef): Promise<string> {
    const dir = join(this.deps.store.itemDir(item.repo, item.issue), "reviews", `${pull.repo.replace("/", "__")}-${pull.number}`);
    const ref = `refs/rovara/review/${pull.number}`;
    await run(this.deps.exec, "git", ["-C", where.path, "fetch", "--quiet", "origin", `+pull/${pull.number}/head:${ref}`, `+refs/heads/${pull.base}:refs/remotes/origin/${pull.base}`]);
    if (await access(dir).then(() => true, () => false)) await run(this.deps.exec, "git", ["-C", dir, "checkout", "--quiet", "--detach", ref]);
    else await run(this.deps.exec, "git", ["-C", where.path, "worktree", "add", "--detach", dir, ref]);
    return dir;
  }

  private async publishItem(item: WorkItemState, done: (outcome: ActionResult["outcome"], detail: string, extra?: Partial<ActionResult>) => void): Promise<void> {
    if (item.worktree === undefined) throw new Error("the item has no worktree to publish");
    const upstream = item.upstream;
    // #359: a follow-up pull request is opened where the pull request it builds on has its branch: maybe a fork.
    const repo = upstream?.repo ?? item.target ?? item.repo;
    await this.commitEvidence(item, item.worktree.path, item.checks ?? "The checks passed.", item.reviews);
    const contribution = planArtifact(loopNamed(item.loop)) === "contribution";
    const published = await publish(this.deps.exec, {
      repo, issueRepo: item.repo, issue: item.issue, worktree: item.worktree.path, branch: item.worktree.branch,
      closes: upstream !== undefined ? `Builds on ${repo === item.repo ? "" : item.repo}#${item.issue}: a follow-up into its branch \`${upstream.branch}\`, for its author to take or leave.` : elsewhere(item) ? `Part of ${item.repo}#${item.issue}.` : `Closes #${item.issue}.`,
      plan: await this.planOf(item), checks: item.checks ?? "The checks passed.", reviews: item.reviews, ...(contribution ? { planHeading: "Contribution" } : {}),
      startedBy: item.startedBy, approvals: item.approvals, skipped: item.skipped, pullRequest: item.pullRequest,
      defaultBranch: upstream?.branch ?? await this.deps.github.defaultBranch(repo),
      ...(upstream !== undefined && upstream.repo !== item.repo ? { head: `${item.repo.split("/")[0] ?? ""}:${item.worktree.branch}` } : {}),
    });
    const { number, url } = published.pullRequest;
    if (upstream !== undefined) {
      done("published", published.created ? `Opened pull request ${repo === item.repo ? "" : repo}#${number} into this pull request's branch \`${upstream.branch}\`: ${url}\n\nIts author decides what to take. Reply here to ask for changes; the loop runs the checks and reviews again and pushes to the same follow-up.` : `Pushed the update to the follow-up, pull request ${repo === item.repo ? "" : repo}#${number}: ${url}`, { pullRequest: published.pullRequest });
      return;
    }
    const opened = item.target === undefined
      ? `Opened pull request #${number}: ${url}\n\nReply here to ask for changes; the loop runs the checks again and pushes them to the same pull request.`
      : `Opened pull request ${repo}#${number}: ${url}\n\nReview it there: what collaborators say on it goes back to its agent. Approve it (a GitHub approval, or \`/rovara approve\` on it) when it's ready.`;
    done("published", published.created ? opened : `Pushed the update to pull request ${item.target === undefined ? "" : repo}#${number}: ${url}`, { pullRequest: published.pullRequest });
  }

  /** A working agent whose session ended (a crash, a closed terminal) is resumed, a few times, then told about. */
  private async keepWorking(registered: RegisteredRepo, item: WorkItemState): Promise<void> {
    const loop = loopNamed(item.loop);
    if (item.session === undefined || stepOf(loop, item.step).actor !== "agent") return;
    if (await this.deps.harness.alive(item.session.tmux)) return;
    const key = keyOf(item);
    const restarts = this.restarts.get(key) ?? 0;
    if (restarts >= RESTARTS_MAX) return;
    this.restarts.set(key, restarts + 1);
    if (restarts + 1 === RESTARTS_MAX) {
      await this.say(item, `The agent's session ended ${RESTARTS_MAX} times in a row, so I stopped restarting it. Check that \`claude\` runs on the computer running the loop, then reply here to try again.`);
    }
    await this.startSession(registered, item, RESUMED_ASSIGNMENT, true);
  }

  /** An agent stuck on a permission prompt for a minute: the issue says it is waiting for its person, once per prompt. */
  private async noticePrompt(item: WorkItemState): Promise<void> {
    const key = keyOf(item);
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
    await this.say(item, `The agent is waiting for your approval in its terminal: \`tmux attach -t =${item.session.tmux}\` on the computer running the loop.`);
  }

  /** A comment on the item's issue; a per-PR loop's (#358) says which repository it is about. */
  private async say(item: WorkItemState, body: string): Promise<void> {
    await this.deps.github.comment(item.repo, item.issue, item.target === undefined ? body : `**${item.target}**: ${body}`);
  }

  private async handle(registered: RegisteredRepo, issue: number, event: LoopEvent, target?: string): Promise<void> {
    const current = await this.deps.store.item(registered.repo, issue, target);
    // A start uses its own loop; anything else uses the loop running on the issue, and is nothing without one.
    const loop: LoopDefinition | undefined = event.kind === "start" && target === undefined ? event.loop : current === undefined ? undefined : loopNamed(current.loop);
    if (loop === undefined) {
      if (event.kind === "claim") await this.writeVerdict({ repo: registered.repo, issue, target }, event.claimId, { outcome: "block", reason: "no loop is running on this issue" });
      return;
    }
    const decision = decide(loop, current, event, { repo: registered.repo, issue });
    let state = decision.state;
    await this.deps.store.appendEvent(registered.repo, issue, {
      at: this.deps.now().toISOString(), event: event.kind,
      ...("author" in event ? { author: event.author } : {}), ...(event.kind === "action-result" ? { action: event.action, outcome: event.outcome } : {}),
      from: current?.step ?? null, to: state?.step ?? null, effects: decision.effects.map((effect) => effect.kind),
    }, target);
    if (state !== undefined) await this.deps.store.saveItem(state);
    if (event.kind === "reply" || event.kind === "changes" || event.kind === "start") this.restarts.delete(keyOf({ repo: registered.repo, issue, target }));
    for (const effect of decision.effects) {
      if (state === undefined) break;
      state = await this.apply(registered, state, effect);
    }
    // #358: an issue's loop that ended ends its per-PR loops; a per-PR loop that moved may let the issue's loop move.
    if (target === undefined && current !== undefined && !isTerminal(current) && state !== undefined && isTerminal(state)) {
      for (const pull of await this.deps.store.pulls(registered.repo, issue)) {
        if (!isTerminal(pull)) await this.handle(registered, issue, { kind: "closed", at: event.at }, pull.target);
      }
    }
    if (target !== undefined) await this.syncPulls(registered, issue);
  }

  /**
   * #358: the issue's loop waits on its per-PR loops: when every pull request is approved it says so and waits for the
   * merge; when one goes back for more work, it waits again.
   */
  private async syncPulls(registered: RegisteredRepo, issue: number): Promise<void> {
    const item = await this.deps.store.item(registered.repo, issue);
    if (item === undefined || !WAITING_ON_PULLS.has(item.step)) return;
    // A per-PR loop that was stopped no longer counts; the rest decide.
    const pulls = (await this.deps.store.pulls(registered.repo, issue)).filter((pull) => !isTerminal(pull));
    if (pulls.length === 0) return;
    const approved = pulls.every((pull) => pull.step === "approved");
    const at = this.deps.now().toISOString();
    if (item.step === "pulls" && approved) {
      const list = pulls.map((pull) => `- ${pull.target ?? ""}#${pull.pullRequest?.number ?? "?"}: ${pull.pullRequest?.url ?? ""}`).join("\n");
      const closes = pulls.some((pull) => pull.target === registered.repo);
      await this.handle(registered, issue, { kind: "pulls", outcome: "approved", at, detail: `Every pull request is approved:\n\n${list}\n\nMerge them${closes ? `; merging the one in ${registered.repo} closes this issue, which ends the loop` : ", then close this issue to end the loop"}.` });
    } else if (item.step === "pulls-approved" && !approved) {
      await this.handle(registered, issue, { kind: "pulls", outcome: "reply", at, detail: "A pull request went back for more work, so this issue waits for it again." });
    }
  }

  private async apply(registered: RegisteredRepo, state: WorkItemState, effect: Effect): Promise<WorkItemState> {
    switch (effect.kind) {
      case "label":
        // A per-PR loop's steps are said on the issue; the issue's label is its own loop's.
        if (state.target === undefined) await this.deps.github.setLabel(state.repo, state.issue, effect.label);
        return state;
      case "comment":
        await this.say(state, effect.body);
        return state;
      case "assign":
        return this.assign(registered, state, effect.text);
      case "end-session":
        if (state.session !== undefined) await this.deps.harness.stop(state.session.tmux);
        return state;
      case "verdict":
        await this.writeVerdict(state, effect.claimId, { outcome: effect.outcome, reason: effect.reason });
        return state;
      case "run":
        // Started on the next attend, in the background, so a long check never holds up other items.
        return state;
      case "record-feedback":
        await this.recordFeedback(state, effect.artifact, effect.author, effect.text);
        return state;
      case "start-pulls":
        await this.startPulls(registered, state, effect.targets, effect.approver);
        return state;
    }
  }

  /**
   * #358: a per-PR loop for each repository the approved plan names. In the issue's own repository it takes over the
   * planning worktree and branch, which carry the plan; in another it gets its own, from that repository's default
   * branch. Each starts coding with the approved plan.
   */
  private async startPulls(registered: RegisteredRepo, item: WorkItemState, targets: readonly string[], approver: string): Promise<void> {
    const plan = await readArtifact(item.worktree?.path, item.issue, "plan") ?? "(the plan could not be read)";
    const at = this.deps.now().toISOString();
    for (const target of targets) {
      const existing = await this.deps.store.item(item.repo, item.issue, target);
      if (existing !== undefined && !isTerminal(existing)) continue;
      const pull: WorkItemState = {
        version: 1, repo: item.repo, issue: item.issue, loop: "pull", step: "code", target, startedBy: item.startedBy, instruction: item.instruction,
        startedAt: at, stepEnteredAt: at, ...(target === item.repo ? { approvals: item.approvals, ...(item.worktree === undefined ? {} : { worktree: item.worktree }) } : {}),
      };
      await this.deps.store.saveItem(pull);
      try {
        await this.assign(registered, pull, pullAssignment(pull, { approver, plan, targets }));
      } catch (error) {
        await this.say(pull, `I couldn't start this pull request's agent: ${redactText((error as Error).message).slice(0, 500)}`);
      }
    }
  }

  /**
   * The checks report and (#358) the reviews report, committed by the loop in the item's evidence directory before it
   * publishes, so the branch carries what proved it. Added with -f: a repository may ignore docs/. Nothing is
   * committed when unchanged.
   */
  private async commitEvidence(item: WorkItemState, worktree: string, checks: string, reviews: string | undefined): Promise<void> {
    const dir = docsDir(item);
    const files: Array<[string, string]> = [[evidencePath(item.issue, "checks.md", dir), `# Checks\n\nRun by rovara loop before it published this branch.\n\n${checks}\n`]];
    if (reviews !== undefined) files.push([evidencePath(item.issue, "reviews.md", dir), `# Reviews\n\nRun by rovara loop before it published this branch.\n\n${reviews}\n`]);
    const relatives = files.map(([relative]) => relative);
    for (const [relative, text] of files) {
      await mkdir(join(worktree, relative, ".."), { recursive: true });
      await writeFile(join(worktree, relative), text);
    }
    await run(this.deps.exec, "git", ["-C", worktree, "add", "-f", ...relatives]);
    if ((await this.deps.exec("git", ["-C", worktree, "diff", "--cached", "--quiet"])).code === 0) return;
    await run(this.deps.exec, "git", ["-C", worktree, "commit", "--quiet", "-m", `chore(rovara): evidence for ${elsewhere(item) ? `${item.repo}` : ""}#${item.issue}`, "--", ...relatives]);
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
  private async assign(registered: RegisteredRepo, state: WorkItemState, text: string): Promise<WorkItemState> {
    if (state.session !== undefined && await this.deps.harness.alive(state.session.tmux)) {
      await this.deps.harness.deliver(state.session.tmux, text);
      return state;
    }
    return this.startSession(registered, state, text, state.session !== undefined);
  }

  private async startSession(registered: RegisteredRepo, state: WorkItemState, prompt: string, resume: boolean): Promise<WorkItemState> {
    // A per-PR loop's agent works in, and by the configuration of, the repository it changes.
    const where = await this.whereOf(state, registered);
    const config = await readLoopConfig(where.path);
    const worktree = state.worktree ?? { path: join(this.deps.store.itemDir(state.repo, state.issue, state.target), "worktree"), branch: itemBranch(state.issue, state.repo, state.target) };
    // #359: a follow-up starts from the pull request it builds on, fetched by its number.
    if (state.upstream !== undefined && state.worktree === undefined) await run(this.deps.exec, "git", ["-C", where.path, "fetch", "--quiet", "origin", `+pull/${state.issue}/head:${state.upstream.ref}`]);
    await ensureWorktree(this.deps.exec, where.path, worktree.path, worktree.branch, await this.deps.github.defaultBranch(state.target ?? state.repo), state.upstream?.ref);
    // A session keeps the agent it started with, so it can be resumed; a new one uses the repository's (#359).
    const harness = state.session?.harness ?? config.harness.name;
    const session = state.session ?? { harness, tmux: tmuxSessionName(state.repo, state.issue, state.target), ...(harness === "claude-code" ? { id: randomUUID() } : {}) };
    const sessionDir = this.deps.store.sessionDir(state.repo, state.issue, state.target);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const configPath = join(sessionDir, "mcp.json");
    const [command = process.execPath, ...cliArgs] = this.deps.cliCommand;
    const mcpArgs = [...cliArgs, "loop", "mcp", "--repo", state.repo, "--issue", String(state.issue), ...(state.target === undefined ? [] : ["--target", state.target])];
    await writeFile(configPath, `${JSON.stringify({ mcpServers: { [LOOP_MCP_SERVER]: { command, args: mcpArgs } } }, null, 2)}\n`, { mode: 0o600 });
    // Codex's sandbox lets it write its worktree; a worktree's commits go to the checkout's git directory, so that too.
    const writable = harness === "codex" ? await this.gitDirectory(worktree.path) : [];
    await this.deps.harness.start({
      harness, tmux: session.tmux, id: session.id, cwd: worktree.path, mcp: { command, args: mcpArgs, configPath }, writable,
      // Arguments are the repository's harness's; a session that keeps another agent gets none.
      args: harness === config.harness.name ? config.harness.args : [], prompt, resume,
    });
    const next: WorkItemState = { ...state, worktree, session };
    await this.deps.store.saveItem(next);
    return next;
  }

  /** The git directory a worktree commits to (the checkout's .git), or none when git cannot say. */
  private async gitDirectory(worktree: string): Promise<string[]> {
    const found = await this.deps.exec("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const dir = found.stdout.trim();
    return found.code === 0 && dir.startsWith("/") ? [dir] : [];
  }

  private async writeVerdict(item: { repo: string; issue: number; target?: string | undefined }, claimId: string, verdict: z.infer<typeof VerdictSchema>): Promise<void> {
    const inbox = this.deps.store.inboxDir(item.repo, item.issue, item.target);
    await mkdir(inbox, { recursive: true, mode: 0o700 });
    await writeFile(join(inbox, `verdict-${claimId}.json`), JSON.stringify(verdict), { mode: 0o600 });
  }
}
