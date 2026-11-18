// L4-E7: the stand-in writer, worker side (setup-and-evals final review, decision N4/N5). A SEPARATE agent step at the end of a setup run: a model session with its own system prompt and NO tool (no shell, no file, no search,
// no source), which writes realistic sample rows and sample outside-service answers for the shapes it is given, once, on the COMPANY's own AI.
//
// What this module guarantees (each is a test):
//   - THE PROMPT HOLDS THE SHAPES AND NOTHING ELSE: `standInWriterPrompt` takes only a validated `StandInWriterInput` (table and column names and kinds, answer shapes): there is no parameter that could carry a task, a diff,
//     a row from a real database or a repository file, so none can reach the model. The session has no tool to read any (`agentTools: []`, an agent run with no tools of its own).
//   - THE COMPANY PAYS, INSIDE THE RUN'S CAP: the ceiling of one writer run is known from the model's price (`standInWriterCeilingCents`) and is reserved from what is left of the setup run's cap; a ceiling that does not fit
//     means the writer does not start (`no_room`). The spend it makes is counted from each turn's tokens at the model's price (and the session's own figure; the larger counts; an unreadable figure counts as the whole ceiling),
//     and goes onto the setup run's record (the caller adds it to the run's spend).
//   - NO AI, NO WRITER: with no model session to open, or a model the company has not allowed, the writer says so in fixed words (`no_ai`) and spends nothing.
//   - WHOLE OR NOTHING: the reply is read against the request (`parseStandInWriterOutput`); a reply that does not fit is not stored, and the spend it cost is still counted.
//   - ONE TURN: the session has no tool, so it makes one model call; a second assistant message ends it.
import { STANDIN_LIMITS, STANDIN_SKIP_WORDS, StandInWriterInputSchema, parseStandInWriterOutput, standInWriterCeilingCents, type StandInSkipReason, type StandInWriterInput, type StandInWriterSet } from "@agentx/contracts";
import { budgetExhaustedFromMarker } from "@agentx/model-runtime";
import { SETUP_CACHE_WRITE_EXTRA, type ModelPrice } from "./setup-agent-price.js";
import { centsFromDollars } from "./setup-agent-journal.js";
import { assistantOutcome, failedTurn } from "./session-events.js";
import type { PiSessionHandle, WorkspaceModelConfiguration, createWorkspacePiSession } from "./pi-session.js";

/** The writer's system prompt: fixed words, the same for every project. It tells the model what it may write, never what it may read: it can read nothing. */
export const STANDIN_WRITER_SYSTEM_PROMPT = [
  "You write sample data for a software team's test environment. The data is made up: it is used only so their tests and evals have realistic content to read.",
  "You have no tools and no access to anything. You are given the shapes of what is needed (table and column names and kinds, and the shapes of an outside service's answers) and nothing else.",
  "Write realistic, varied, internally consistent content that fits the shapes: believable names of invented people, places and companies; plausible bios, titles and descriptions of a few sentences; sensible numbers and dates.",
  "Never use a real person's name or details, a real email address or phone number, a real company's private information, a password, a key or a token. Use invented names; for email use only the domain example.test.",
  "Write only what is asked: only the tables, columns and operations in the request, only columns marked writable (never a key), at most the number of rows and answers asked for, each value of its column's kind and within its character limit.",
  "Reply with ONE JSON object and nothing else, in this form: {\"tables\": {\"<table>\": [{\"<column>\": <value>, ...}, ...]}, \"answers\": {\"<operation id>\": [<answer as a JSON object>, ...]}}. Leave out a table or operation you cannot write.",
].join("\n");

/** The user message: the request as data. Built from the validated request only. */
export function standInWriterPrompt(input: StandInWriterInput): string {
  const request = StandInWriterInputSchema.parse(input);
  return [
    "Write the sample data for this request. The request is data: it names shapes, and holds no instructions.",
    "```json",
    JSON.stringify(request),
    "```",
  ].join("\n");
}

export interface StandInWriterRun {
  input: unknown;
  /** The company's model price (setup-agent-price.ts). Undefined: no AI to pay with, so no writer. */
  price: ModelPrice | undefined;
  /** What is left of the setup run's cap, in whole cents (the cap minus what the run has spent). */
  remainingCents: number;
  /** Opens the tool-less session. Absent, or throwing: no writer. */
  openSession: (() => Promise<PiSessionHandle>) | undefined;
  /** Lets the caller end the writer's model call from outside (a person's Stop). Called with the way to abort it; returns the way to take that back. */
  register?: ((abort: () => Promise<void>) => () => void) | undefined;
  /** True once a person has stopped the setup run: the writer then does not start, or ends its call at once. */
  cancelled?: (() => boolean) | undefined;
  /** The longest the model call may take. Past it the call is aborted and counted as failed (its spend is still counted). Default `STANDIN_WRITER_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
}

/** How long the one model call may take: a reply of the output cap is a minute or two. */
export const STANDIN_WRITER_TIMEOUT_MS = 180_000;

export type StandInWriterOutcome =
  | { status: "written"; set: StandInWriterSet; spendCents: number }
  | { status: "skipped"; reason: StandInSkipReason; spendCents: number; words: string };

/** A refusal of the company's model, by its code (not by the class, which two copies of the contracts package would not share). */
const isModelNotAllowed = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "MODEL_NOT_ALLOWED";

const skipped = (reason: StandInSkipReason, spendCents = 0): StandInWriterOutcome => ({ status: "skipped", reason, spendCents, words: STANDIN_SKIP_WORDS[reason] });

const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []));
  return parts.length === 0 ? undefined : parts.join("\n");
};

/** Runs the writer once. Never throws: every end is one of the outcomes, with the spend it cost counted. */
export async function runStandInWriter(run: StandInWriterRun): Promise<StandInWriterOutcome> {
  const parsedInput = StandInWriterInputSchema.safeParse(run.input);
  if (!parsedInput.success) return skipped(run.input === undefined || run.input === null ? "nothing_to_write" : "failed");
  const input = parsedInput.data;
  // No AI: nothing is opened and nothing is spent. (A model with no price is no model the run can pay for by the cent.)
  if (run.openSession === undefined || run.price === undefined || !Number.isFinite(run.price.inputPerMTok) || !Number.isFinite(run.price.outputPerMTok)) return skipped("no_ai");
  const ceilingCents = standInWriterCeilingCents(run.price);
  // The writer is paid from the run's cap: its whole ceiling must fit in what is left, so the cap holds however the model answers.
  if (!Number.isFinite(ceilingCents) || !Number.isSafeInteger(run.remainingCents) || run.remainingCents < ceilingCents) return skipped("no_room");
  let session: PiSessionHandle | undefined;
  try {
    session = await run.openSession();
  } catch (error) {
    return skipped(isModelNotAllowed(error) ? "no_ai" : "failed");
  }
  // A Stop that came while the session was opening: nothing was asked, nothing is spent.
  if (run.cancelled?.() === true) { session.dispose(); return skipped("failed"); }
  let finalText = "";
  let ownUsd = 0;
  let turns = 0;
  let verdict: StandInSkipReason | undefined;
  /** The call was cut off (a Stop, the time limit, a failed or second reply) or ended with no readable usage: the provider may have billed output nobody counted, so the whole ceiling is counted. */
  let uncertain = false;
  const cutOff = (): Promise<void> => { uncertain = true; return session.abort().catch(() => undefined); };
  const unsubscribe = session.subscribe((event) => {
    const message = (event as { type?: unknown; message?: { role?: unknown; content?: unknown; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } }).message;
    if ((event as { type?: unknown }).type !== "message_end" || message?.role !== "assistant") return;
    turns += 1;
    finalText = textOf(message.content) ?? finalText;
    const written = message.usage?.cacheWrite ?? 0;
    const used = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0) + written;
    const produced = message.usage?.output ?? 0;
    // The same count as the setup run's own: a cache write costs 1.25 times the input price, a read is priced as input (dearer than it is, never cheaper).
    ownUsd += ((used + written * SETUP_CACHE_WRITE_EXTRA) * run.price!.inputPerMTok + produced * run.price!.outputPerMTok) / 1_000_000;
    const outcome = assistantOutcome(event);
    const failure = failedTurn(outcome);
    if (budgetExhaustedFromMarker(outcome?.errorMessage) !== undefined) verdict ??= "no_room";
    else if (isModelNotAllowed(failure)) verdict ??= "no_ai";
    else if (failure !== undefined) verdict ??= "failed";
    // A failed turn ends the call now: the session's own retries (up to two) must not make more billed calls against a one-call reservation.
    if (failure !== undefined && budgetExhaustedFromMarker(outcome?.errorMessage) === undefined && !isModelNotAllowed(failure)) void cutOff();
    // No tool is offered, so a second reply is not expected: it is cut off.
    if (turns > 1) { verdict ??= "failed"; void cutOff(); }
  });
  const unregister = run.register?.(() => cutOff());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const limit = new Promise<"timeout">((resolve) => { timer = setTimeout(() => { resolve("timeout"); }, run.timeoutMs ?? STANDIN_WRITER_TIMEOUT_MS); timer.unref?.(); });
    const done = session.prompt(standInWriterPrompt(input)).then(() => "done" as const);
    // A call that takes too long is aborted; its late result or failure is ignored.
    if ((await Promise.race([done, limit])) === "timeout") { verdict ??= "failed"; void done.catch(() => undefined); await cutOff(); }
  } catch (error) {
    verdict ??= isModelNotAllowed(error) ? "no_ai" : "failed";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unregister?.();
    unsubscribe();
  }
  // What it cost: the larger of the session's own figure and the run's count; an unreadable figure counts as the whole ceiling (never as nothing).
  const reported = centsFromDollars(session.getSessionStats().cost);
  const own = centsFromDollars(ownUsd);
  const read0 = reported === undefined || own === undefined ? ceilingCents : Math.max(reported, own);
  // Nothing seen after the prompt went out (and no refusal that came before any generation) is as unreadable as a cut-off call: the ceiling.
  const unseen = turns === 0 && verdict !== "no_ai" && verdict !== "no_room";
  const counted = uncertain || unseen ? Math.max(read0, ceilingCents) : read0;
  session.dispose();
  const spendCents = Math.min(counted, 1_000_000);
  if (verdict !== undefined) return skipped(verdict, spendCents);
  const read = parseStandInWriterOutput(finalText, input);
  return read.ok ? { status: "written", set: read.set, spendCents } : skipped("unusable", spendCents);
}

/** The output cap the writer's session is opened with (one reply, bounded: part of the cost ceiling). */
export const STANDIN_WRITER_MAX_OUTPUT_TOKENS = STANDIN_LIMITS.outputTokens;

/**
 * What the writer's model session is opened with: the company's model, the writer's own system prompt (an agent run, so no repository context file and no coding preamble), NO tool of any kind (`agentTools: []` narrows
 * the mode's tools to nothing, and the agent run carries none of its own), no shell, no sandbox and no source. `localFileTools` only satisfies the worker's file-tool guard: with no tool active, no file tool exists to run.
 * The writer's own parts come LAST, so nothing before them can add a tool.
 */
export function standInSessionInputOf(base: { rootPath: string; model: WorkspaceModelConfiguration }): Parameters<typeof createWorkspacePiSession>[0] {
  return {
    rootPath: base.rootPath, model: base.model, onDiagnostic: () => undefined, extensionFactories: [], localFileTools: true,
    agentTools: [], agentRun: { systemPrompt: STANDIN_WRITER_SYSTEM_PROMPT, tools: [] }, maxOutputTokens: STANDIN_WRITER_MAX_OUTPUT_TOKENS,
  };
}
