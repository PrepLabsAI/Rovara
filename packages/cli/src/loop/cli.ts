// rovara loop (#355): the commands. `init` and `add` set a repository up, `start`/`stop`/`status` run the
// daemon in the background, `run` is the daemon in the foreground, `do` starts a Do loop on an issue,
// `check` evaluates an item without running anything, and `mcp` is the agent's tool server.
import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Command } from "commander";
import { LOOP_CONFIG_PATH, initialLoopConfig, readLoopConfig } from "./config.js";
import { LoopDaemon } from "./daemon.js";
import { LOOPS, loopNamed, stepOf } from "./definitions.js";
import { realExec, run, type Exec } from "./exec.js";
import { GitHub } from "./github.js";
import { AgentHarness } from "./harness.js";
import { createLoopMcpServer } from "./mcp.js";
import { ARTIFACT_SECTIONS } from "./instructions.js";
import { artifactDigest, missingSections, readArtifact } from "./exit-checks.js";
import { artifactPath } from "./naming.js";
import { createStandaloneEnrollment, resolveLoopEnrollment, resolveRegisteredPublication, type PublicationJoinTransport } from "./enrollment.js";
import type { Artifact, LoopDefinition } from "./definitions.js";
import type { WorkItemState } from "./state.js";
import { LoopStore, RepoSlugSchema } from "./state.js";

export interface LoopCommandContext {
  home: string;
  version: string;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  exec?: Exec;
  /** How to run this CLI again: [node, path to the CLI]. */
  cliCommand?: readonly string[];
  /** Authenticated host-owned adapter to the current native evidence producer; absent means HOLD. */
  publicationJoin?: PublicationJoinTransport;
}

const POLL_SECONDS = 30;
const ATTEND_MS = 2_000;

/**
 * Each document the loop writes: declared away, not written yet, missing sections, written but not approved, locked,
 * or changed since it was approved. `rovara loop check` shows these without running anything.
 */
async function documentLines(loop: LoopDefinition, state: WorkItemState): Promise<string[]> {
  const artifacts = [...new Set(loop.steps.filter((step) => step.actor === "agent" && step.artifact !== undefined).map((step) => ({ artifact: step.artifact!, phase: step.phase })).map((entry) => JSON.stringify(entry)))]
    .map((entry) => JSON.parse(entry) as { artifact: Artifact; phase?: string });
  const lines: string[] = [];
  for (const { artifact, phase } of artifacts) {
    const path = artifactPath(state.issue, artifact);
    if (phase !== undefined && (state.skipped ?? []).includes(phase)) { lines.push(`  ${artifact}: declared away by @${state.startedBy}`); continue; }
    const text = await readArtifact(state.worktree?.path, state.issue, artifact);
    const approval = state.approvals?.[artifact];
    if (text === undefined) { lines.push(`  ${artifact}: ${approval === undefined ? "not written yet" : `MISSING, though @${approval.by} approved it`} (${path})`); continue; }
    if (approval !== undefined) {
      lines.push(artifactDigest(text) === approval.digest ? `  ${artifact}: locked, approved by @${approval.by} at ${approval.at}` : `  ${artifact}: CHANGED since @${approval.by} approved it at ${approval.at} (${path})`);
      continue;
    }
    const missing = missingSections(text, ARTIFACT_SECTIONS[artifact]);
    lines.push(missing.length > 0 ? `  ${artifact}: missing sections ${missing.map((section) => `## ${section}`).join(", ")} (${path})` : `  ${artifact}: written, not approved yet, so not locked (${path})`);
  }
  return lines.length === 0 ? [] : ["Documents:", ...lines];
}

export function registerLoopCommands(program: Command, context: LoopCommandContext): void {
  const exec = context.exec ?? realExec;
  const store = new LoopStore(join(context.home, ".rovara", "loop"));
  const github = new GitHub(exec);
  const cliCommand = context.cliCommand ?? [process.execPath, process.argv[1] ?? ""];
  const say = (line: string) => { context.stdout.write(`${line}\n`); };
  const repoAt = async (path: string | undefined) => {
    const full = await realpath(resolve(path ?? process.cwd()));
    return { path: full, repo: await github.repoAt(full) };
  };
  const hostId = `${hostname()}:${process.platform}:${process.arch}`;
  const uid = process.getuid?.() ?? 0;

  /** #358: each per-PR loop of an item: its repository, step, pull request and agent. */
  const pullLines = async (repo: string, issue: number): Promise<string[]> => {
    const pulls = await store.pulls(repo, issue);
    if (pulls.length === 0) return [];
    return ["Pull requests:", ...pulls.map((pull) => {
      const step = stepOf(loopNamed(pull.loop), pull.step);
      const where = pull.pullRequest === undefined ? "not opened yet" : pull.pullRequest.url;
      return `  ${pull.target ?? ""}: step ${pull.step} (${step.terminal ? "ended" : `${step.actor}'s turn`}), ${where}${pull.session === undefined ? "" : `; agent: tmux attach -t =${pull.session.tmux}`}`;
    })];
  };

  const loop = program.command("loop").description("run Rovara's workflow on your GitHub issues with your own local agent (Claude Code), no Rovara install needed");

  loop.command("init").description(`write ${LOOP_CONFIG_PATH} in this repository, with you as its one collaborator`)
    .argument("[path]", "the repository's checkout; this directory by default")
    .action(async (path: string | undefined) => {
      const full = resolve(path ?? process.cwd());
      const target = join(full, LOOP_CONFIG_PATH);
      if (await access(target).then(() => true, () => false)) { say(`${LOOP_CONFIG_PATH} already exists; nothing changed.`); return; }
      await mkdir(join(full, ".rovara"), { recursive: true });
      await writeFile(target, initialLoopConfig(await github.login()));
      say(`Wrote ${LOOP_CONFIG_PATH}. Commit it, then run rovara loop add.`);
    });

  loop.command("add").description("let the loop read this repository's issues")
    .argument("[path]", "the repository's checkout; this directory by default")
    .action(async (path: string | undefined) => {
      const found = await repoAt(path);
      await readLoopConfig(found.path);
      const repos = (await store.repos()).filter((entry) => entry.repo !== found.repo);
      await store.saveRepos([...repos, found]);
      say(`Added ${found.repo} (${found.path}). Comments from now on are read; start the daemon with rovara loop start.`);
    });

  loop.command("enroll").description("enroll one added repository in a host-scoped local publication lane")
    .argument("<repo>", "the added repository, owner/name")
    .requiredOption("--standalone-local", "explicitly enroll this repository in a local-only namespace")
    .action(async (repo: string) => {
      const found = (await store.repos()).find((entry) => entry.repo.toLowerCase() === repo.toLowerCase());
      if (found === undefined) throw new Error(`${repo} is not added to rovara loop on this computer; run rovara loop add in its checkout first`);
      const actualRepo = await github.repoAt(found.path);
      if (actualRepo.toLowerCase() !== found.repo.toLowerCase()) throw new Error("the added checkout now identifies as a different GitHub repository; publication remains on hold");
      const enrollment = createStandaloneEnrollment({
        hostId, uid, account: await github.login(), project: actualRepo, repositoryId: await github.repositoryId(actualRepo),
        checkoutPath: await realpath(found.path), now: new Date(),
      });
      await store.saveEnrollment(enrollment);
      say(`Enrolled ${actualRepo} in ${enrollment.namespace}. This local receipt applies only to this host, account, project and repository.`);
    });

  loop.command("remove").description("stop reading a repository's issues")
    .argument("<repo>", "owner/name")
    .action(async (repo: string) => {
      const repos = await store.repos();
      await store.saveRepos(repos.filter((entry) => entry.repo !== repo));
      say(repos.some((entry) => entry.repo === repo) ? `Removed ${repo}.` : `${repo} was not added; nothing changed.`);
    });

  const daemonPid = async (): Promise<number | undefined> => {
    const pid = Number((await readFile(store.pidPath(), "utf8").catch(() => "")).trim());
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    try { process.kill(pid, 0); return pid; } catch { return undefined; }
  };

  loop.command("start").description("run the loop's daemon in the background")
    .action(async () => {
      const running = await daemonPid();
      if (running !== undefined) { say(`The daemon is already running (pid ${running}).`); return; }
      await mkdir(store.root, { recursive: true, mode: 0o700 });
      const log = await open(store.logPath(), "a", 0o600);
      const [command = process.execPath, ...args] = cliCommand;
      const child = spawn(command, [...args, "loop", "run"], { detached: true, stdio: ["ignore", log.fd, log.fd] });
      child.unref();
      await log.close();
      say(`Started the daemon (pid ${child.pid ?? "?"}). Its log: ${store.logPath()}`);
    });

  loop.command("stop").description("stop the background daemon; agent sessions keep running")
    .action(async () => {
      const pid = await daemonPid();
      if (pid === undefined) { say("The daemon is not running."); return; }
      process.kill(pid, "SIGTERM");
      say(`Stopped the daemon (pid ${pid}).`);
    });

  loop.command("status").description("the daemon, the repositories it reads, and each issue's loop")
    .action(async () => {
      const pid = await daemonPid();
      say(pid === undefined ? "Daemon: not running (rovara loop start)." : `Daemon: running (pid ${pid}).`);
      const repos = await store.repos();
      if (repos.length === 0) say("No repositories added (rovara loop add).");
      for (const entry of repos) {
        say(`${entry.repo}  ${entry.path}`);
        for (const item of await store.items(entry.repo)) {
          const ended = stepOf(loopNamed(item.loop), item.step).terminal;
          say(`  #${item.issue}  ${item.loop}  ${item.step}${ended ? "" : item.session === undefined ? "" : `  tmux attach -t =${item.session.tmux}`}`);
        }
      }
    });

  loop.command("run").description("run the daemon in the foreground (rovara loop start runs this in the background)")
    .action(async () => {
      await mkdir(store.root, { recursive: true, mode: 0o700 });
      await writeFile(store.pidPath(), String(process.pid), { mode: 0o600 });
      const daemon = new LoopDaemon({
        store, exec, github, harness: new AgentHarness(exec), cliCommand, now: () => new Date(),
        log: (line) => { context.stderr.write(`${new Date().toISOString()} ${line}\n`); },
        resolvePublicationContext: async (input) => {
          try {
            const records = await store.enrollments();
            const source = (await store.repos()).find((entry) => entry.repo.toLowerCase() === input.issueRepo.toLowerCase());
            if (source === undefined) return { kind: "hold", reasonCode: "source_checkout_unavailable" };
            const actualRepo = await github.repoAt(source.path);
            if (actualRepo.toLowerCase() !== source.repo.toLowerCase()) return { kind: "hold", reasonCode: "identity_changed" };
            const observation = {
              hostId, uid, account: await github.login(), repo: actualRepo, repositoryId: await github.repositoryId(actualRepo),
              checkoutPath: await realpath(source.path),
            };
            const resolution = resolveLoopEnrollment(records, observation);
            if (resolution.kind === "hold") return resolution;
            if (resolution.kind === "unmanaged-local") return { kind: "unmanaged-local" };
            if (input.targetRepo !== input.issueRepo || input.destinationRepo !== input.issueRepo) {
              return { kind: "hold", reasonCode: "registered_target_join_unavailable" };
            }
            const joined = await resolveRegisteredPublication({
              enrollment: resolution.enrollment,
              subject: {
                projectName: resolution.project, projectRevision: resolution.projectRevision, repositoryId: resolution.repositoryId,
                commitSha: input.candidate.commitSha, treeSha: input.candidate.treeSha, baseCommitSha: input.candidate.baseCommitSha,
              },
              taskRef: resolution.enrollment.taskRef, transport: context.publicationJoin, now: Date.now(),
            });
            return joined.kind === "ready" ? { kind: "registered-ready" } : { kind: "hold", reasonCode: joined.reasonCode };
          } catch {
            return { kind: "hold", reasonCode: "provenance_resolution_failed" };
          }
        },
      });
      let stopping = false;
      const stop = () => { stopping = true; };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      context.stderr.write(`${new Date().toISOString()} rovara loop daemon started (pid ${process.pid})\n`);
      let nextPoll = 0;
      while (!stopping) {
        if (Date.now() >= nextPoll) {
          await daemon.poll();
          nextPoll = Date.now() + POLL_SECONDS * 1_000;
        }
        await daemon.attend();
        await new Promise((done) => setTimeout(done, ATTEND_MS));
      }
      await rm(store.pidPath(), { force: true });
      context.stderr.write(`${new Date().toISOString()} rovara loop daemon stopped\n`);
    });

  for (const [keyword, name, what, argument] of [
    ["do", "Do", "no gates; it never publishes", "<instruction...>"],
    ["quick", "Quick", "plan, your approval, code, checks, then a pull request", "<instruction...>"],
    ["full", "Full", "requirements, design and plan, each approved; then code, checks and a pull request. Start the instruction with --skip design (or requirements) to declare a phase away", "<instruction...>"],
    ["review", "Review", "reviews a pull request, or every one that mentions an issue, round after round, against your brief; it changes no code. Without a brief it asks for one", "[brief...]"],
    ["contribute", "Contribute", "joins an issue, or someone else's pull request with a follow-up into its branch, to meet a goal and success criteria; it asks for them if the brief lacks them", "[brief...]"],
  ] as const) {
    loop.command(keyword).description(`start a ${name} loop on an issue (${what}): posts \`/rovara ${keyword} ${argument.replace("...", "")}\` there as you`)
      .requiredOption("--issue <number>", "the issue (or pull request) number")
      .option("--repo <path>", "the repository's checkout; this directory by default")
      .argument(argument, keyword === "review" ? "what the review should cover" : keyword === "contribute" ? "the goal and success criteria (## Goal, ## Success criteria)" : "what the agent should do")
      .action(async (words: string[] | undefined, options: { issue: string; repo?: string }) => {
        const found = await repoAt(options.repo);
        const issue = Number(options.issue);
        if (!Number.isInteger(issue) || issue <= 0) throw new Error("--issue must be an issue number");
        await run(exec, "gh", ["api", "-X", "POST", `repos/${found.repo}/issues/${issue}/comments`, "--input", "-"], { input: JSON.stringify({ body: `/rovara ${keyword} ${(words ?? []).join(" ")}`.trimEnd() }) });
        say(`Asked for a ${name} loop on ${found.repo}#${issue}. The daemon picks it up on its next read${await daemonPid() === undefined ? "; it is not running: rovara loop start" : ""}.`);
      });
  }

  loop.command("check").description("evaluate an issue's loop without running anything: its loop, step and state")
    .argument("<issue>", "the issue number")
    .option("--repo <owner/name>", "the repository; the one checked out here by default")
    .action(async (issueText: string, options: { repo?: string }) => {
      const repo = options.repo === undefined ? (await repoAt(undefined)).repo : RepoSlugSchema.parse(options.repo);
      const issue = Number(issueText);
      const state = await store.item(repo, issue);
      if (state === undefined) { say(`No loop has run on ${repo}#${issue}.`); return; }
      const definition = LOOPS.find((candidate) => candidate.name === state.loop);
      if (definition === undefined) throw new Error(`${repo}#${issue} names loop ${state.loop}, which this version does not have`);
      const step = stepOf(definition, state.step);
      say([
        `${repo}#${issue}: loop ${state.loop}, step ${state.step} (${step.terminal ? "ended" : `${step.actor}'s turn`}) since ${state.stepEnteredAt}`,
        `Started by @${state.startedBy} at ${state.startedAt}.`,
        ...(step.label === undefined ? [] : [`The issue should carry the label rovara:${step.label}.`]),
        ...(state.worktree === undefined ? [] : [`Worktree: ${state.worktree.path} (branch ${state.worktree.branch})`]),
        ...(await documentLines(definition, state)),
        ...(state.session === undefined ? [] : [`Agent: tmux attach -t =${state.session.tmux}`]),
        ...(await pullLines(repo, issue)),
        ...(state.rounds === undefined ? [] : [`Review: ${state.rounds} round${state.rounds === 1 ? "" : "s"}, ${(state.findings ?? []).length} finding${(state.findings ?? []).length === 1 ? "" : "s"} (${(state.findings ?? []).filter((finding) => finding.filed !== undefined).length} filed as issues)`]),
      ].join("\n"));
    });

  loop.command("mcp").description("the agent's tools for one issue, over stdio (the loop starts this for its agent)")
    .requiredOption("--repo <owner/name>", "the repository")
    .requiredOption("--issue <number>", "the issue number")
    .option("--target <owner/name>", "a per-PR loop's repository")
    .action(async (options: { repo: string; issue: string; target?: string }) => {
      const server = createLoopMcpServer({
        store, repo: RepoSlugSchema.parse(options.repo), issue: Number(options.issue), version: context.version,
        ...(options.target === undefined ? {} : { target: RepoSlugSchema.parse(options.target) }),
      });
      await server.connect(new StdioServerTransport());
    });
}
