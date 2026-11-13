// TE-R2 part A (M2, release 0.5.19; DECISIONS 161, 166b): the REAL EXAMPLES the independent reply agent may be shown, at most 3. PURE: no I/O.
//
// THE RULE: an example comes only from a reply the project's reply set listed as `before_task` before the task started (customer-written, made by the setup agent from the customer's fakes, a capped real recording, or the
// prompt and expected shape). The provenance is read from the HEAD ENTRY (what the store wrote), never from the reply body. A `task_made` or `independent` entry is never an example, and so is nothing from this task's overlay:
// `pickExamples` takes the head's entries and bodies and has no parameter for an overlay. No examples is fine: the agent then writes from the prompt and the shape alone.
//
// What qualifies: same family (the head's), the same operation as the brief (or a reply that names none), a reply that fits the brief's declared shape (an example the agent could not copy the shape of is no help), each at most
// 8 KiB as compact JSON and 24 KiB together. The nearest model first (the brief's own model, then a reply with no model, then another model's), the head's order inside each group. Every body is parsed and re-hashed against its
// head entry: a body that no longer says what its key says is skipped (fail closed). A reply's `usage` is dropped (token counts say nothing about how to answer). A reply that matches by prompt hash has no prompt text to show; one that
// matches by `promptContains` shows that literal (masked as the brief is).
import { checkReplyShape } from "./model-reply-agent.js";
import type { ReplyBrief } from "./model-reply-brief.js";
import { modelReplyEntrySha256, type ModelReplyResponse } from "./model-reply-set.js";
import type { ReplyBodies } from "./model-reply-store-rules.js";
import { ReplySetEntryBodySchema, type ReplySetHeadEntry } from "./model-reply-store.js";
import { redactText } from "./redaction.js";

export const REPLY_EXAMPLES_MAX = 3;
export const REPLY_EXAMPLE_MAX_BYTES = 8 * 1024;
export const REPLY_EXAMPLES_TOTAL_MAX_BYTES = 24 * 1024;

export interface ReplyExample {
  readonly id: string;
  /** The literal the reply matched on (a substring of the prompt it was written for), when it had one. */
  readonly promptContains?: string | undefined;
  readonly response: ModelReplyResponse;
}

const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Up to 3 real examples for this brief from the head's `before_task` entries. `headEntries` are the head's own entries (never the overlay's); `bodies` are the stored bodies by `entrySha256`. Pure; the order is deterministic.
 */
export function pickExamples(headEntries: readonly ReplySetHeadEntry[], bodies: ReplyBodies, brief: ReplyBrief): ReplyExample[] {
  const ranked: { rank: number; index: number; example: ReplyExample }[] = [];
  headEntries.forEach((entry, index) => {
    if (entry.provenance !== "before_task" || entry.origin === undefined) return;
    const raw = bodies.get(entry.entrySha256);
    if (raw === undefined) return;
    const parsed = ReplySetEntryBodySchema.safeParse(raw);
    if (!parsed.success || modelReplyEntrySha256(parsed.data) !== entry.entrySha256) return;
    const { match, response } = parsed.data;
    if (match.operation !== undefined && match.operation !== brief.operation) return;
    const { usage: _usage, ...withoutUsage } = response;
    const trimmed: ModelReplyResponse = withoutUsage;
    if (!checkReplyShape(brief, trimmed)) return;
    const hint = match.promptContains === undefined ? undefined : redactText(match.promptContains);
    const example: ReplyExample = { id: entry.id, ...(hint === undefined ? {} : { promptContains: hint }), response: trimmed };
    if (bytesOf(example) > REPLY_EXAMPLE_MAX_BYTES) return;
    const rank = match.model === undefined ? 1 : match.model === brief.model ? 0 : 2;
    ranked.push({ rank, index, example });
  });
  ranked.sort((left, right) => left.rank - right.rank || left.index - right.index);
  const picked: ReplyExample[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const { example } of ranked) {
    const key = JSON.stringify(example.response);
    if (seen.has(key)) continue;
    const size = bytesOf(example);
    if (picked.length >= REPLY_EXAMPLES_MAX || total + size > REPLY_EXAMPLES_TOTAL_MAX_BYTES) continue;
    seen.add(key);
    total += size;
    picked.push(example);
  }
  return picked;
}
