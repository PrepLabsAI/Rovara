// Conversation compaction (Pi's `session_before_compact`), taken over by the worker.
//
// Pi summarises old messages when the context nears the model's limit. On its defaults that summary is a `compaction` entry in the session file, and two things went
// wrong with it for Rovara: (1) the stubs of the context-source rule (context-sources/transcript.ts) cover `toolResult` entries only, so a summary written in Understand or
// Plan, while a source's text was in context, could carry that text, and Build reopens the same session file and reads the summary; (2) nothing kept the approved plan in
// a summary of a long Build.
//
// The hook below:
//   (a) replaces every context-source result in what the summary is built from with its stub, redacts what the source-text guard remembers from the messages and from the
//       summary itself, and takes any source frame out of the summary;
//   (b) adds the approved plan's key facts to the end of the summary word for word (and asks the summariser to leave them out of its own text);
//   (c) preserves Pi's summary usage in the compaction entry so session/task totals include it; and
//   (d) reports "the conversation was compacted" once the entry is saved (`onCompacted`, which the worker turns into a task event).
//
// The messages are cleaned into new values and assigned together before summarisation. Pi's runner catches a handler's throw and then runs its own summary on whatever the
// preparation holds. Failures therefore return our deterministic fallback, never a cancellation that leaves a full context or an unguarded default summary.
import type { WorkflowApprovedPlan } from "@agentx/contracts";
import type { CompactionResult, InlineExtension, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { stubContextEvent } from "./context-sources/events.js";
import { stubSourceFrames } from "./context-sources/frame.js";
import type { SourceTextGuard } from "./context-sources/text-guard.js";

export const COMPACTION_EXTENSION_NAME = "agentx-compaction";

/** The line that starts the approved plan's facts at the end of a summary. Everything from it to the end of the summary is the facts. */
export const PLAN_FACTS_HEADING = "## Approved plan (key facts, kept word for word)";
/** The most of the approved plan a summary carries. */
export const PLAN_FACTS_MAX_CHARS = 12_000;
const PLAN_SECTION_MAX_CHARS = 5_000;
// A 12,000-character approved plan plus the current item's bounded title/description/repository and scope sentence fits in 15,000 characters.
// Bound the snapshot for both the main and fallback summaries identically; neither may drop facts the other carries.
const SESSION_FACTS_MAX_CHARS = 15_000;
// At most 16,384 characters total (facts + heading + structural text). No fallback calls a model, so it adds no usage.
const FALLBACK_MAX_CHARS = 16_384;
/** The plan sections that are facts to keep: what changes, in what order, what stays, how it is checked and what the owner decided. Why, Risks and E2E intent are left out. */
const KEPT_SECTIONS: readonly string[] = ["Claims", "Work breakdown", "Not changing", "Checks", "Decisions"];

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * The approved plan's key facts, from the plan the broker sent as its own field (`workflowApprovedPlan`): the plan's title, claims, work breakdown, Not changing, Checks and Decisions,
 * and the owner's instructions from plan review. They are never read out of a prompt, which holds teammates' replies and page comments that could pose as a plan. Undefined when there is
 * no plan. A plan that is not in the usual Markdown form is kept as its first characters.
 */
export function approvedPlanFacts(plan: (Pick<WorkflowApprovedPlan, "markdown"> & Partial<WorkflowApprovedPlan>) | undefined): string | undefined {
  if (plan === undefined) return undefined;
  const body = plan.markdown.trim();
  const parts: string[] = [];
  const instructions = (plan.ownerInstructions ?? []).map((text) => text.trim()).filter((text) => text !== "");
  if (instructions.length > 0) parts.push(cut(["The owner's instructions from plan review (the owner's own words). They still hold: this change must not undo them.", ...instructions.map((text, index) => `${index + 1}. ${text}`)].join("\n"), PLAN_SECTION_MAX_CHARS));
  const sections = body.split(/^## /mu);
  const head = sections[0]?.trim() ?? "";
  if (sections.length === 1) {
    if (head !== "") parts.push(cut(head, PLAN_SECTION_MAX_CHARS));
  } else {
    if (head !== "") parts.push(cut(head, 500));
    for (const wanted of KEPT_SECTIONS) {
      const section = sections.slice(1).find((candidate) => candidate.split("\n", 1)[0]?.trim() === wanted);
      if (section !== undefined) parts.push(cut(`## ${section.trim()}`, PLAN_SECTION_MAX_CHARS));
    }
  }
  const facts = parts.join("\n\n").trim();
  return facts === "" ? undefined : cut(facts, PLAN_FACTS_MAX_CHARS);
}

/** The sentence a parallel part's prompt carries, and so the facts of its compaction (run-task.ts uses the same text in both). */
export const PART_SCOPE_SENTENCE = "Complete only the current item below, in the one pinned repository; do not begin or redo other items, and change only the files this item needs, so the changes merge cleanly.";
/** The sentence a serial item's prompt carries. */
export const SERIAL_SCOPE_SENTENCE = "Complete only the current item below, in the one pinned repository. Do not begin later items.";

/**
 * The facts of a coding run that builds one item of an approved work breakdown: the item (title, description, repository: the broker's approved graph, not a prompt) and the sentence that
 * limits the run to it, kept word for word. A parallel part gets only this, not the whole plan, so a long part cannot read its siblings' items as work it should do.
 */
export function itemScopeFacts(item: { title: string; description: string; repository: string }, sentence: string): string {
  return `## Current approved item (plan text scoped by the broker)\nTitle: ${item.title}\nDescription: ${item.description}\nRepository: ${item.repository}\n${sentence}`;
}

/** What the worker tells the compaction hook about the session it is in. */
export interface SessionCompactionOptions {
  /** The stage's source-text guard, once it exists (a stage that reads sources). It redacts what a source returned from the messages and from the summary. */
  sourceGuard?: () => SourceTextGuard | undefined;
  /** The facts to keep in every summary: the approved plan's (approvedPlanFacts), or a part's own item (itemScopeFacts). Read at each compaction, so a serial run can name its current item. */
  planFacts?: () => string | undefined;
  /** Called after a compaction is saved. Must not throw; a throw is swallowed. */
  onCompacted?: (info: ConversationCompacted) => void;
}

/** What a task event says about a compaction. */
export interface ConversationCompacted {
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  tokensBefore: number;
  summaryChars: number;
  /** Whether the worker's hook supplied the summary; worker sessions require this. */
  fromHook: boolean;
  /** Whether the summary ends with the plan's (or the item's) facts. */
  keptApprovedPlan: boolean;
}

type Preparation = SessionBeforeCompactEvent["preparation"];

/** Makes the summary of one compaction, from the cleaned preparation and the instructions. The worker supplies the session's own model, key and stream. */
export type CompactionSummariser = (preparation: Preparation, instructions: string, signal: AbortSignal, event: SessionBeforeCompactEvent) => Promise<CompactionResult>;

// Pi gives a split turn's second summary (the start of the last user turn) no custom instructions: generateTurnPrefixSummary has no slot for them. So this sentence reaches the summary of the
// earlier turns only. The start of the last turn is covered by the other two layers instead: its messages are stubbed before the summary call, and the summary is redacted after it.
const SOURCE_INSTRUCTION = [
  "Some of this conversation consulted the project's connected sources (tickets, chats, documents). What a source said has been replaced by a marker such as [Tracker ABC-123 · 2.1 KB · see Sources].",
  "Do not reproduce, quote or paraphrase anything a source said. Name only the item that was consulted, as the marker does, and what the task decided because of it.",
].join(" ");
const PLAN_INSTRUCTION = "The approved plan (or this run's item) is kept separately and is added to your summary word for word. Do not copy it. Say what has been done against it, what is left, and what failed.";

/** The messages with each context-source result stubbed and the guard's runs redacted. A new array; the same message objects where nothing changed. Returns how many results were stubbed. */
function cleaned<T>(messages: readonly T[], guard: SourceTextGuard | undefined): { messages: T[]; stubbed: number; changed: boolean } {
  let stubbed = 0;
  let changed = false;
  const out = messages.map((message) => {
    let next = stubContextEvent(message);
    if (next !== message) { stubbed += 1; changed = true; }
    if (guard?.active() === true) {
      const scrubbed = guard.scrub(next);
      if (scrubbed !== next) { next = scrubbed; changed = true; }
    }
    return next;
  });
  return { messages: out, stubbed, changed };
}

/** A summary without the facts block a hook of ours added to an earlier one. */
function withoutPlanFacts(summary: string): string {
  const at = summary.indexOf(PLAN_FACTS_HEADING);
  return at < 0 ? summary : summary.slice(0, at).trimEnd();
}

/** Structural facts only: never read message bodies, previous summaries, custom instructions, file names or a failed model's output. */
function fallbackSummary(preparation: Preparation, factsBlock: string): string {
  const structure = `Conversation compacted after the main summary failed. ${String(preparation.messagesToSummarize.length)} earlier messages; ${String(preparation.turnPrefixMessages.length)} turn-prefix messages. Earlier details are unavailable; verify progress against the approved plan and workspace before continuing.`;
  return `${cut(structure, FALLBACK_MAX_CHARS - factsBlock.length)}${factsBlock}`;
}

/**
 * The compaction extension. Installed in every worker session; Pi's default summary is never used.
 * Pi catches a handler's throw and then runs its default summary. Every non-abort error instead returns a bounded, no-model fallback; if even that fails, use only the plan facts.
 */
export function compactionExtension(options: SessionCompactionOptions, summarise: CompactionSummariser, onDiagnostic?: (message: string) => void): InlineExtension {
  return {
    name: COMPACTION_EXTENSION_NAME,
    factory: (pi) => {
      let keptFacts = false;
      pi.on("session_before_compact", async (event) => {
        keptFacts = false;
        const preparation = event.preparation;
        let guard: SourceTextGuard | undefined;
        let facts: string | undefined;
        let usage: CompactionResult["usage"];
        try {
          // Snapshot before touching source content, so a broken guard/cleaner cannot lose the approved facts.
          const suppliedFacts = options.planFacts?.();
          facts = suppliedFacts === undefined ? undefined : cut(suppliedFacts, SESSION_FACTS_MAX_CHARS);
          guard = options.sourceGuard?.();
          // (a) Everything is cleaned into new values first and assigned together, so a failure part way leaves the preparation as it was and the handler's catch supplies the fallback.
          const history = cleaned(preparation.messagesToSummarize, guard);
          const prefix = cleaned(preparation.turnPrefixMessages, guard);
          const previous = preparation.previousSummary === undefined ? undefined : stubSourceFrames(guard?.active() === true ? guard.redact(withoutPlanFacts(preparation.previousSummary)) : withoutPlanFacts(preparation.previousSummary));
          preparation.messagesToSummarize = history.messages;
          preparation.turnPrefixMessages = prefix.messages;
          if (previous !== undefined) preparation.previousSummary = previous;
          const sensitive = history.stubbed + prefix.stubbed > 0 || history.changed || prefix.changed || guard?.active() === true;
          const instructions = [event.customInstructions, sensitive ? SOURCE_INSTRUCTION : undefined, facts === undefined ? undefined : PLAN_INSTRUCTION].filter((part): part is string => part !== undefined && part !== "").join("\n\n");
          const result = await summarise(preparation, instructions, event.signal, event);
          usage = result.usage;
          // (a) The summary itself: no source frame, none of the guard's runs. (b) The facts after it, word for word.
          let summary = stubSourceFrames(withoutPlanFacts(result.summary));
          if (guard?.active() === true) summary = guard.redact(summary);
          if (facts !== undefined) { summary = `${summary}\n\n${PLAN_FACTS_HEADING}\n${facts}`; keptFacts = true; }
          return { compaction: { ...result, summary } };
        } catch (error) {
          if (event.signal.aborted) throw error;
          // Do not echo the failed model/guard's text. Reporting itself must not let Pi run its default.
          try { onDiagnostic?.("conversation compaction: the worker's summary failed; using a deterministic fallback"); } catch { /* reporting must not break compaction */ }
          const factsBlock = facts === undefined ? "" : `\n\n${PLAN_FACTS_HEADING}\n${facts}`;
          let summary: string;
          try {
            summary = fallbackSummary(preparation, factsBlock);
          } catch {
            // No preparation content or guard is needed for this last resort. Unreadable facts are unavailable; never recover them from conversation text.
            summary = facts === undefined ? "Conversation compacted. Earlier details are unavailable." : `${PLAN_FACTS_HEADING}\n${facts}`;
          }
          keptFacts = facts !== undefined;
          return { compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, ...(usage === undefined ? {} : { usage }) } };
        }
      });
      pi.on("session_compact", (event) => {
        try {
          options.onCompacted?.({ reason: event.reason, willRetry: event.willRetry, tokensBefore: event.compactionEntry.tokensBefore, summaryChars: event.compactionEntry.summary.length, fromHook: event.fromExtension, keptApprovedPlan: event.fromExtension && keptFacts });
        } catch { /* reporting must not break a turn */ }
      });
    },
  };
}
