// The wiki build run, worker side (W3b; design wiki-design-review fixes 3, 5, 8): drives the broker's page loop with a READ-ONLY model session per page. Called by `run-task.ts` in ONE early hunk for `workflowMode: "WIKI_BUILD"`.
// Everything that touches the outside (the model session, the broker, the file system) is a port, so the whole run is tested without any of them.
//
// What this module guarantees (each is a test, and a mutant where it is a trust check):
//   - the repositories are read at the commits the BROKER pinned: the preparation manifest must hold exactly the invocation's pins (a repository missing, extra or at another commit refuses the run before anything is asked);
//   - the session's tools are `WIKI_BUILD_TOOLS` (read, grep, find, ls): no shell, no write, no network tool. The session runs in the `WIKI` mode (no repository context file is loaded into it);
//   - the run's scope is the operation's: the callback carries NO company, project or task (the broker reads them from the authenticated operation), so nothing here can name another project's page loop;
//   - money: the run is metered (the larger of the session's reported cost and the run's own count from each turn's tokens at the catalog price; a turn with no readable usage is unreadable = used up), `spentCents` only
//     goes up, and the session is stopped BEFORE a turn that could cross the job's `spendCeilingCents`; a stop there reports the failure word `budget_used` (the page is not marked done);
//   - failures are fixed words: `needs_ai_key` (the gateway refuses the model: no AI source serves it), `repo_unreadable` (a repository folder cannot be read), `budget_used`, `infrastructure`, and (lead 4 N1) `upkeep_paused`
//     with its reason when the gateway's upkeep limit refused a nightly refresh's call (read from the gateway's fixed sentence; the broker only takes it from an unattended run).
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentXError, isBudgetExhaustedMessage, WIKI_BUILD_TOOLS, agentXError, upkeepPauseReasonOfText, type UpkeepPauseReason, type WikiBuildPins, type WikiBuildLimits } from "@agentx/contracts";
import { ModelBudgetExhaustedError, budgetExhaustedFromMarker } from "@agentx/model-runtime";
import { assistantOutcome, failedTurn } from "./session-events.js";
import { SETUP_NEXT_TURN_MARGIN_TOKENS, dearestInputPerMTok, priceForInputTokens, tokensOfUsage, turnCostUsd, type ModelPrice } from "./setup-agent-price.js";
import { SETUP_AGENT_MAX_OUTPUT_TOKENS, centsFromDollars, estimateNextTurnCents } from "./setup-agent-journal.js";
import type { PiSessionHandle } from "./pi-session.js";

/** What the preparation manifest says about a repository (the broker's own record of the commit the workspace holds). */
export interface WikiManifestRepository { name: string; path: string; resolvedCommit: string; checkedOut?: unknown }

/** The session's parts the run asks for: the tools are fixed here, never the caller's. */
export interface WikiSessionParts { workflowMode: "WIKI"; agentTools: readonly string[]; sequentialTools: true; maxOutputTokens: number }

export interface WikiRunPorts {
  /** Opens a fresh model session with exactly these parts (one per page, so a page's context never carries into the next). */
  openSession(parts: WikiSessionParts): Promise<PiSessionHandle>;
  /** The broker's wiki build callback (`POST .../wiki-build`) with this invocation's own capability. Throws on a refusal. */
  callback(body: unknown): Promise<unknown>;
  progress(message: string): Promise<void>;
  /** Registers the run so a cancel aborts it. Returns the unregister. */
  register(control: { abort(): Promise<void> }): () => void;
  /** Whether a repository's folder can be read (a real directory, not a link). Default: the file system. */
  repositoryReadable?: (directory: string) => Promise<boolean>;
  /** How long one page may take before it is given up (ms). Default 15 minutes. */
  pageTimeoutMs?: number;
}

export interface WikiRunInput {
  rootPath: string;
  operationId: string;
  limits: WikiBuildLimits;
  pins: WikiBuildPins;
  repositories: readonly WikiManifestRepository[];
  /** The model's price per million tokens. REQUIRED: a run for a model with no price is refused before anything starts. */
  price: ModelPrice | undefined;
  ports: WikiRunPorts;
}

export interface WikiRunResult { workflowMode: "WIKI_BUILD"; pagesAttempted: number; spentCents: number; end?: string }

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PAGE_TIMEOUT_MS = 15 * 60_000;
/**
 * The most one read, grep, find or ls result can add to the next request, in tokens: the session's file tools cut a result at 51,200 bytes, and dense text (JSON, base64, non-Latin) can run about 2 bytes a token, so 26,000.
 * Each tool execution since the last model message is counted at this size in the next-turn estimate (an assistant message may make several calls), so a turn that reads a lot cannot carry the run past its ceiling (review M1).
 */
export const WIKI_TOOL_RESULT_MAX_TOKENS = 26_000;

/**
 * The manifest is held to the pins the broker sent: the same repositories at the same commits, none extra, none missing, no pull request head. A mismatch refuses the run before the broker is asked for anything.
 */
export function assertPinsMatch(manifest: readonly WikiManifestRepository[], pins: WikiBuildPins): void {
  const pinned = new Map(pins.map((pin) => [pin.repo, pin.commit]));
  if (manifest.length === 0 || pinned.size !== manifest.length) throw agentXError("CONFIG_INVALID", "the workspace does not hold the repositories the broker pinned");
  for (const repository of manifest) {
    if (repository.checkedOut !== undefined) throw agentXError("CONFIG_INVALID", "a wiki build reads the default branch only, never a pull request head");
    if (!COMMIT.test(repository.resolvedCommit)) throw agentXError("CONFIG_INVALID", "a wiki build needs the commit the broker pinned");
    if (pinned.get(repository.name) !== repository.resolvedCommit) throw agentXError("CONFIG_INVALID", "the workspace holds a repository at another commit than the broker pinned");
  }
}

/** The page the model wrote, from its last message: the last fenced block that parses as a JSON object, else the outermost braces. Undefined when none parses. The broker validates it; nothing here is trusted. */
export function wikiDraftFromAnswer(text: string): unknown {
  const parse = (candidate: string): unknown => { try { const value: unknown = JSON.parse(candidate); return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined; } catch { return undefined; } };
  const fenced = [...text.matchAll(/```[^\n`]*\n([\s\S]*?)```/gu)].map((match) => match[1] ?? "");
  for (const block of fenced.reverse()) {
    const value = parse(block.trim());
    if (value !== undefined) return value;
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first >= 0 && last > first ? parse(text.slice(first, last + 1)) : undefined;
}

const RETRY_PROMPT = "Your answer could not be read as the page JSON. Answer again with exactly one JSON object in the format given above (a pageId, sections and links), and nothing else.";

async function folderReadable(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    await readdir(directory);
    return true;
  } catch {
    return false;
  }
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []));
  return parts.length === 0 ? undefined : parts.join("\n");
}

interface PageJob { kind: "page"; page: { id: string; kind: string; repo?: string }; pins: WikiBuildPins; instructions: string; notes?: string; spendCeilingCents: number }
type Job = PageJob | { kind: "end"; word: string };

function jobOf(reply: unknown): Job {
  const value = typeof reply === "object" && reply !== null ? reply as Record<string, unknown> : {};
  if (value["kind"] === "end" && typeof value["word"] === "string") return { kind: "end", word: value["word"] };
  const page = value["page"] as { id?: unknown; kind?: unknown; repo?: unknown } | undefined;
  if (value["kind"] !== "page" || typeof page?.id !== "string" || typeof page.kind !== "string" || typeof value["instructions"] !== "string" || typeof value["spendCeilingCents"] !== "number" || !Array.isArray(value["pins"])) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the control plane's answer to the wiki build was not a page or an end");
  }
  return {
    kind: "page", page: { id: page.id, kind: page.kind, ...(typeof page.repo === "string" ? { repo: page.repo } : {}) }, pins: value["pins"] as WikiBuildPins, instructions: value["instructions"],
    ...(typeof value["notes"] === "string" ? { notes: value["notes"] } : {}), spendCeilingCents: value["spendCeilingCents"],
  };
}

export async function runWikiBuild(input: WikiRunInput): Promise<WikiRunResult> {
  const { ports } = input;
  assertPinsMatch(input.repositories, input.pins);
  if (input.price === undefined || !Number.isFinite(input.price.inputPerMTok) || !Number.isFinite(input.price.outputPerMTok)) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX does not know this model's price, so it did not start the wiki build");
  const readable = ports.repositoryReadable ?? folderReadable;
  const where = new Map(input.repositories.map((repository) => [repository.name, resolve(input.rootPath, repository.path)]));
  /** The run's spend so far in whole cents, never lowered. Earlier pages' sessions are in it; the current one is added while it runs. */
  let spentCents = 0;
  let pagesAttempted = 0;
  let cancelled = false;
  let current: PiSessionHandle | undefined;
  const unregister = ports.register({ abort: async () => { cancelled = true; await current?.abort(); } });
  try {
    for (let turn = 0; turn <= input.limits.pages + 2; turn += 1) {
      if (cancelled) break;
      const job = jobOf(await ports.callback({ kind: "next", spentCents }));
      if (job.kind === "end") { await ports.progress("The wiki build ended."); return { workflowMode: "WIKI_BUILD", pagesAttempted, spentCents, end: job.word }; }
      pagesAttempted += 1;
      const submit = (extra: { draft?: unknown; failure?: PageOutcome["failure"]; pause?: UpkeepPauseReason }): Promise<unknown> =>
        ports.callback({ kind: "page", answer: { pageId: job.page.id, spentCents, ...(extra.draft === undefined ? {} : { draft: extra.draft }), ...(extra.failure === undefined ? {} : { failure: extra.failure }), ...(extra.pause === undefined ? {} : { pause: extra.pause }) } });
      // A repository the page needs (every pinned one for the overview and the connections page) must be readable at the commit the workspace holds.
      const needed = job.page.repo === undefined ? input.pins.map((pin) => pin.repo) : [job.page.repo];
      if (!(await Promise.all(needed.map(async (repo) => { const directory = where.get(repo); return directory !== undefined && await readable(directory); }))).every(Boolean)) {
        await submit({ failure: "repo_unreadable" });
        continue;
      }
      await ports.progress(`Writing the wiki page ${job.page.id}.`);
      const outcome = await writePage(input, job, spentCents, ports, (session) => { current = session; });
      current = undefined;
      spentCents = Math.max(spentCents, outcome.spentCents);
      if (cancelled) break;
      await submit(outcome.failure === undefined ? { draft: outcome.draft } : { failure: outcome.failure, ...(outcome.pause === undefined ? {} : { pause: outcome.pause }) });
    }
    return { workflowMode: "WIKI_BUILD", pagesAttempted, spentCents };
  } finally {
    unregister();
  }
}

interface PageOutcome { spentCents: number; draft?: unknown; failure?: "needs_ai_key" | "repo_unreadable" | "budget_used" | "infrastructure" | "upkeep_paused"; pause?: UpkeepPauseReason }

/** One page: a fresh read-only session, metered turn by turn, stopped before a turn that could cross the ceiling. */
async function writePage(input: WikiRunInput, job: PageJob, baseCents: number, ports: WikiRunPorts, hold: (session: PiSessionHandle | undefined) => void): Promise<PageOutcome> {
  const price = input.price!;
  const paths = input.repositories.map((repository) => `- ${repository.name}: ${repository.path}`).join("\n");
  const task = [job.instructions, "", "Repositories (name: path in the workspace):", paths, ...(job.notes === undefined ? [] : ["", job.notes])].join("\n");
  let session: PiSessionHandle | undefined;
  let finalText = "";
  let turns = 0;
  let lastInputTokens = 20_000;
  let lastOutputTokens = 0;
  let ownUsd = 0;
  /** Tool executions since the last model message: each one's result is in the next request. */
  let toolRuns = 0;
  /** Set when a model turn reported no usage and no new cost: what that turn cost cannot be told, so the spend is unreadable (used up) from then on. */
  let unreadable = false;
  let lastReportedCents = 0;
  let stopped: "budget_used" | "needs_ai_key" | "upkeep_paused" | undefined;
  /** Why the gateway paused upkeep, when its fixed sentence was what refused a call. */
  let pause: UpkeepPauseReason | undefined;
  const sessionSpend = (): number | undefined => {
    if (session === undefined) return 0;
    const reported = centsFromDollars(session.getSessionStats().cost);
    const own = centsFromDollars(ownUsd);
    // A turn with no usage and no cost is unreadable: the run counts it as used up.
    if (unreadable || (turns > 0 && (reported ?? 0) === 0 && (own ?? 0) === 0)) return undefined;
    return reported === undefined ? own : own === undefined ? reported : Math.max(reported, own);
  };
  const nextTurn = (): number => {
    // The whole last context, its output, the margin and the tool results since, all at the dearest input rate (a cold cache writes it again; the write rate already holds the write premium), and the output cap.
    // Inside the price's base band the next call is bounded at the base rates, else at the pooled ones.
    const inputTokens = lastInputTokens + lastOutputTokens + SETUP_NEXT_TURN_MARGIN_TOKENS + toolRuns * WIKI_TOOL_RESULT_MAX_TOKENS;
    return estimateNextTurnCents({ inputTokens, maxOutputTokens: SETUP_AGENT_MAX_OUTPUT_TOKENS, inputPerMTok: dearestInputPerMTok(price, inputTokens), outputPerMTok: priceForInputTokens(price, inputTokens).outputPerMTok });
  };
  /** The run's spend now: what earlier pages cost plus this session's. Undefined when it cannot be read. */
  const spendNow = (): number | undefined => { const own = sessionSpend(); return own === undefined ? undefined : baseCents + own; };
  const check = (): void => {
    if (stopped !== undefined) return;
    const spent = spendNow();
    const next = nextTurn();
    // The ceiling is the most the run's own spend may reach: stop when the spend (or an unreadable spend) plus the next turn would reach it.
    if (spent === undefined || !Number.isFinite(next) || spent + next > job.spendCeilingCents) { stopped = "budget_used"; void session?.abort().catch(() => undefined); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    session = await ports.openSession({ workflowMode: "WIKI", agentTools: WIKI_BUILD_TOOLS, sequentialTools: true, maxOutputTokens: SETUP_AGENT_MAX_OUTPUT_TOKENS });
    hold(session);
    const unsubscribe = session.subscribe((event) => {
      const message = (event as { type?: unknown; message?: { role?: unknown; content?: unknown; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } }).message;
      const type = (event as { type?: unknown }).type;
      if (type === "message_end" && message?.role === "assistant") {
        finalText = textOf(message.content) ?? finalText;
        const written = message.usage?.cacheWrite ?? 0;
        const used = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0) + written;
        const produced = message.usage?.output ?? 0;
        turns += 1;
        toolRuns = 0;
        const reportedNow = centsFromDollars(session?.getSessionStats().cost) ?? 0;
        if (used === 0 && produced === 0 && reportedNow <= lastReportedCents) unreadable = true;
        lastReportedCents = Math.max(lastReportedCents, reportedNow);
        if (used > 0) lastInputTokens = used;
        lastOutputTokens = produced;
        // Every token class at its own rate (the same pricing as the setup run).
        ownUsd += turnCostUsd(price, tokensOfUsage(message.usage));
        const outcome = assistantOutcome(event);
        const failure = failedTurn(outcome);
        const paused = upkeepPauseReasonOfText(outcome?.errorMessage) ?? upkeepPauseReasonOfText(failure?.message);
        if (paused !== undefined) { stopped = "upkeep_paused"; pause = paused; void session?.abort().catch(() => undefined); }
        else if (budgetExhaustedFromMarker(outcome?.errorMessage) !== undefined || isBudgetExhaustedMessage(failure?.message)) stopped = "budget_used";
        else if (failure instanceof AgentXError && failure.code === "MODEL_NOT_ALLOWED") stopped = "needs_ai_key";
      }
      if (type === "tool_execution_end") toolRuns += 1;
      // The ceiling is looked at AFTER a turn's tokens were counted and before the next turn starts.
      if (type === "turn_start" || type === "turn_end" || type === "tool_execution_start" || type === "tool_execution_end" || type === "message_end") check();
    });
    timer = setTimeout(() => { timedOut = true; void session?.abort().catch(() => undefined); }, ports.pageTimeoutMs ?? PAGE_TIMEOUT_MS);
    timer.unref?.();
    let failed = false;
    const refused = (error: unknown): void => {
      failed = true;
      const paused = upkeepPauseReasonOfText(error instanceof Error ? error.message : undefined);
      if (paused !== undefined) { stopped ??= "upkeep_paused"; pause ??= paused; }
      else if (error instanceof AgentXError && error.code === "MODEL_NOT_ALLOWED") stopped ??= "needs_ai_key";
      else if (error instanceof ModelBudgetExhaustedError || (error instanceof Error && isBudgetExhaustedMessage(error.message))) stopped ??= "budget_used";
    };
    try { await session.prompt(task); } catch (error) { refused(error); }
    // One more try when the answer is not readable as the page (not when the run was stopped).
    if (!failed && stopped === undefined && !timedOut && wikiDraftFromAnswer(finalText) === undefined) {
      try { await session.prompt(RETRY_PROMPT); } catch (error) { refused(error); }
    }
    unsubscribe();
    const spent = spendNow();
    const spentCents = spent === undefined ? Math.max(baseCents, job.spendCeilingCents) : spent;
    if (stopped !== undefined) return { spentCents, failure: stopped, ...(stopped === "upkeep_paused" && pause !== undefined ? { pause } : {}) };
    if (failed || timedOut) return { spentCents, failure: "infrastructure" };
    const draft = wikiDraftFromAnswer(finalText);
    return draft === undefined ? { spentCents } : { spentCents, draft };
  } catch (error) {
    // A session that could not even open: the gateway's refusal of the model is the missing key; anything else is a fault.
    const paused = upkeepPauseReasonOfText(error instanceof Error ? error.message : undefined);
    if (paused !== undefined) return { spentCents: Math.max(baseCents, spendNow() ?? job.spendCeilingCents), failure: "upkeep_paused", pause: paused };
    return { spentCents: Math.max(baseCents, spendNow() ?? job.spendCeilingCents), failure: error instanceof AgentXError && error.code === "MODEL_NOT_ALLOWED" ? "needs_ai_key" : "infrastructure" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    hold(undefined);
    session?.dispose();
  }
}
