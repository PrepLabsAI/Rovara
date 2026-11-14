// TE-F8 (release 0.5.19, additive, no callers): record the first real answer per changed prompt, replay it in later rounds.
//
// `createRecordReplay(options)` is what F1-c's bridge (or F2-B's `ModelBackend.serve` for the modes `record` and `replay`) calls for a model request. ONE wiring step from real: the bridge hands in the adapter it has as `egress`
// (the laptop adapter, or Cloud's), and nothing else changes. No real call is made here: every forwarded call goes through F1-a's port, `ModelEgress.forward(scope, frame)`, and every adapter keeps its own caps and keys.
//
// `serve(frame)` answers one of:
//   { kind: "stream", via: "forwarded" | "replayed", events }  head, chunks, settle (consume it, or stop it: a forwarded answer is stored only when its settle arrives)
//   { kind: "scripted" }                                        the call matches no changed prompt (or has no key): the caller answers from its own scripted replies; NO real call
//   { kind: "not_run", sentence }                               the fixed words for why: no recording (replay-only), budget reached, recording limit, unreadable report, unreadable scope or store
//
// Rules: a forwarded call is ONE attempt; a settle class `rate_limit`, `quota`, `overloaded`, `key_refused` or `cap` (and a provider error, a refusal, a withheld or oversize answer) is NOT stored and reads "not run" or "not
// recorded"; a settle with `overrun: true` stops every later real call in this task (DECISIONS 165/165a: over by at most one call); at most `maxRecordings` (default 20) real calls per task. Nothing is logged here, and no error
// carries a provider's text. A stored recording holds no request header, no request body (its key hash only) and no provider account header; it is labelled "Recorded on <date>", never "Real".
import { NOT_RUN_CLASSES, NOT_RUN_SENTENCES, capSentence } from "./model-egress/classify.js";
import { WITHHELD_ECHO_SENTENCE, WITHHELD_SCRUB_SENTENCE } from "./model-egress/sanitize.js";
import type { ModelEgressFamily } from "./model-egress/schemes.js";
import type { ModelEgress, ModelEgressEvent, ModelEgressHead, ModelEgressScope, ModelEgressSettle } from "./ports/model-egress.js";
import { modelRecordKeyOfView, readModelRequest, type ModelRequestView } from "./model-record-key.js";
import {
  RECORDING_NOT_RECORDED_FAILED, RECORDING_NOT_RECORDED_INCOMPLETE, RECORDING_NOT_RECORDED_NO_CALL, RECORDING_NOT_RECORDED_TOO_LARGE, RECORDING_NOT_RECORDED_UNSAVED, RECORDING_NOT_RECORDED_WITHHELD, RECORDING_NOT_RUN_MISS, RECORDING_NOT_RUN_SCOPE,
  RECORDING_NOT_RUN_ENDED, RECORDING_NOT_RUN_STORE, decideRecording, matchChangedItems, recordingLimitSentence, type RecordingMode, type RecordingPlan, type StoredRecordings,
} from "./model-record-policy.js";
import {
  RECORDING_ANSWER_BYTES_MAX, RECORDING_TASK_RECORDINGS_DEFAULT, RECORDING_TTL_MS_DEFAULT, RECORDING_TTL_MS_MAX, checkRecordingScope, isoDateOf, recordedLabel, type RecordedAnswer, type RecordingEntry, type RecordingScope, type RecordingStore,
  type RecordingStoreWord,
} from "./model-recording-store.js";

export interface RecordReplayOptions {
  /** F1-a's port. Every forwarded call goes through it. */
  readonly egress: ModelEgress;
  /** The opaque scope the adapter reads (company, source): the caller's capability, never built here. */
  readonly egressScope: ModelEgressScope;
  /** The company the adapter's scope names (the caller reads it from its own capability). It must equal the company of `scope()` on every call, or the call is "not run": a recording is never made, or served, across companies. */
  readonly egressCompanyOf: (scope: ModelEgressScope) => string | undefined;
  /** Task-level state from an earlier round, so a new engine keeps the stop after an overrun and the count of real calls. Read the current state from `taskState` and hand it to the next engine. */
  readonly taskState?: { readonly overrun?: boolean; readonly forwards?: number };
  readonly store: RecordingStore;
  /** The company and task the recordings belong to. Read on EVERY call: a throw or an unusable answer is "not run", no call, nothing stored (fail closed). */
  readonly scope: () => RecordingScope | undefined;
  /** From `planRecording(report)`. */
  readonly plan: RecordingPlan;
  /** `record`: the first call per changed prompt is forwarded and stored. `replay_only`: nothing is ever forwarded. */
  readonly mode: RecordingMode;
  readonly clock: () => number;
  /** The task cap, for the budget sentence only (the adapter enforces it). */
  readonly capMicros?: number;
  readonly ttlMs?: number;
  /** The most real calls this task makes in `record` mode. Default 20. */
  readonly maxRecordings?: number;
  /** The catalog row's family, when the caller has it; otherwise inferred from the path. */
  readonly familyOf?: (row: string) => ModelEgressFamily | undefined;
}

export type RecordReplayNotRun = "no_recording" | "budget" | "limit" | "plan" | "scope" | "store" | "ended";
export type RecordReplayServe =
  | {
      readonly kind: "stream";
      readonly via: "forwarded" | "replayed";
      readonly key: string;
      readonly itemIds: readonly string[];
      readonly events: AsyncIterable<ModelEgressEvent>;
      /** Only for a stream you will NOT read: gives back the one record slot a forwarded stream holds. Reading the stream to its end, or stopping it, gives it back by itself. */
      readonly abandon: () => void;
    }
  | { readonly kind: "scripted" }
  | { readonly kind: "not_run"; readonly reason: RecordReplayNotRun; readonly sentence: string };

export const RECORDING_ITEM_OUTCOMES = ["recorded", "replayed", "not_recorded", "not_run"] as const;
export type RecordingItemOutcome = (typeof RECORDING_ITEM_OUTCOMES)[number];
export interface RecordingSummaryItem {
  readonly id: string;
  readonly outcome: RecordingItemOutcome;
  /** `recorded`, `replayed`, or the fixed "not recorded: ..." / "not run: ..." sentence. */
  readonly sentence: string;
  readonly recordedOn?: string;
  readonly replays: number;
  /** The record key hashes that answer this item. */
  readonly keys: readonly string[];
}
/** Counts and hashes only: no prompt, no answer, no header. */
export interface RecordingSummary {
  readonly schemaVersion: 1;
  readonly store: RecordingStoreWord;
  readonly items: readonly RecordingSummaryItem[];
  readonly recordedOn?: string;
  /** "Recorded on 13 Nov (this task)"; absent when nothing is recorded. */
  readonly label?: string;
  readonly counts: { readonly recorded: number; readonly replayed: number; readonly notRecorded: number; readonly notRun: number; readonly forwards: number; readonly replaysServed: number };
  /** "Model answers for 2 changed prompts: Recorded on 13 Nov (this task), replayed 3 times". */
  readonly headline: string;
  readonly itemsOmitted: boolean;
}

export interface RecordReplay {
  serve(frame: unknown, options?: { readonly signal?: AbortSignal }): Promise<RecordReplayServe>;
  summary(): Promise<RecordingSummary>;
  /** Task end: deletes every recording of this task. Returns how many. */
  endTask(): Promise<number>;
  /** A call settled above its reservation: no further real call this task. */
  readonly overrun: boolean;
  /** Real calls started this task (by this engine and the earlier rounds it was given). */
  readonly forwards: number;
  /** The task-level state to hand to the next round's engine as `taskState`. */
  readonly taskState: { readonly overrun: boolean; readonly forwards: number };
}

const WITHHELD_BYTES_MAX = 4096;

/** The only response headers a recording keeps: how to read the body, and how long it may be cached. Every other header (request ids, rate limits, account headers, anything a provider can put a key in) is left out. */
export const RECORDED_HEADER_NAMES = ["content-type", "cache-control"] as const;
const SAFE_HEADER_VALUE = /^[\x20-\x7e]{1,200}$/u;

/** The headers a recording keeps, lower-cased, each once, from a head's headers or from an older entry. */
export function recordedHeaders(headers: ReadonlyArray<readonly [string, string]>): Array<[string, string]> {
  const kept = new Map<string, string>();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if ((RECORDED_HEADER_NAMES as readonly string[]).includes(lower) && !kept.has(lower) && SAFE_HEADER_VALUE.test(value)) kept.set(lower, value);
  }
  return [...kept.entries()];
}

const rec = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const nonEmptyString = (value: unknown): boolean => typeof value === "string" && value !== "";

/**
 * Whether a recorded answer is the WHOLE answer. A body that is not a stream must be one JSON document. A stream must show its family's own end: OpenAI-compatible `[DONE]` or a `finish_reason` (or a Responses
 * `response.completed`), Anthropic `message_stop`, Gemini and Vertex a candidate `finishReason`, Cohere `message-end`. Usage sent early proves nothing: a stream that closes cleanly before its end is not complete.
 */
export function answerIsComplete(family: string, isStream: boolean, bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (!isStream) {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }
  const payloads: unknown[] = [];
  const eventNames: string[] = [];
  let done = false;
  if (text.trimStart().startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) payloads.push(...(parsed as unknown[]));
    } catch {
      return false;
    }
  } else {
    for (const line of text.split(/\r?\n/u)) {
      if (line.startsWith("event:")) eventNames.push(line.slice(6).trim());
      else if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data === "[DONE]") done = true;
        else {
          try {
            payloads.push(JSON.parse(data) as unknown);
          } catch {
            // a line that is not JSON says nothing about the end
          }
        }
      }
    }
  }
  const types = payloads.map((payload) => rec(payload)?.type);
  switch (family) {
    case "openai_compatible":
      return done || types.includes("response.completed") || payloads.some((payload) => (Array.isArray(rec(payload)?.choices) ? (rec(payload)!.choices as unknown[]).some((choice) => nonEmptyString(rec(choice)?.finish_reason)) : false));
    case "anthropic_messages":
      return eventNames.includes("message_stop") || types.includes("message_stop");
    case "gemini":
    case "vertex":
      return payloads.some((payload) => (Array.isArray(rec(payload)?.candidates) ? (rec(payload)!.candidates as unknown[]).some((candidate) => nonEmptyString(rec(candidate)?.finishReason) && rec(candidate)?.finishReason !== "FINISH_REASON_UNSPECIFIED") : false));
    case "cohere":
      return eventNames.includes("message-end") || types.includes("message-end");
    default:
      return false;
  }
}

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export function createRecordReplay(options: RecordReplayOptions): RecordReplay {
  const ttlMs = Number.isSafeInteger(options.ttlMs) && (options.ttlMs as number) > 0 ? Math.min(options.ttlMs as number, RECORDING_TTL_MS_MAX) : RECORDING_TTL_MS_DEFAULT;
  const maxRecordings = Number.isSafeInteger(options.maxRecordings) && (options.maxRecordings as number) >= 0 ? (options.maxRecordings as number) : RECORDING_TASK_RECORDINGS_DEFAULT;
  let overrun = options.taskState?.overrun === true;
  let forwards = Number.isSafeInteger(options.taskState?.forwards) && (options.taskState?.forwards as number) >= 0 ? (options.taskState?.forwards as number) : 0;
  let replaysServed = 0;
  let ended = false;
  /** Why a changed item has no recording, from the calls that matched it. */
  const notes = new Map<string, string>();
  /** Writes that have started and not finished: task end waits for them, then deletes. */
  const inflight = new Set<Promise<unknown>>();
  const track = async (work: Promise<unknown>): Promise<void> => {
    inflight.add(work);
    try {
      await work;
    } finally {
      inflight.delete(work);
    }
  };
  /** One record-forward in flight at a time: the decision, the call and the store are one critical section, so two calls for one prompt are one real call. */
  let tail: Promise<void> = Promise.resolve();
  const acquire = async (): Promise<() => void> => {
    const previous = tail;
    let open!: () => void;
    tail = new Promise<void>((resolve) => {
      open = resolve;
    });
    await previous;
    let given = false;
    return () => {
      if (!given) {
        given = true;
        open();
      }
    };
  };

  const readScope = (): RecordingScope | undefined => {
    try {
      return checkRecordingScope(options.scope());
    } catch {
      return undefined;
    }
  };
  const adapterCompany = (): string | undefined => {
    try {
      return options.egressCompanyOf(options.egressScope);
    } catch {
      return undefined;
    }
  };
  const note = (itemIds: readonly string[], sentence: string): void => {
    for (const id of itemIds) notes.set(id, sentence);
  };
  const notRun = (reason: RecordReplayNotRun, sentence: string, itemIds: readonly string[] = []): RecordReplayServe => {
    note(itemIds, sentence);
    return { kind: "not_run", reason, sentence };
  };

  async function* replayEvents(entry: RecordingEntry): AsyncGenerator<ModelEgressEvent> {
    yield { kind: "head", status: entry.answer.status, headers: recordedHeaders(entry.answer.headers) };
    for (const chunk of entry.answer.chunks) yield { kind: "chunk", bytes: chunk.slice() };
    const { settle } = entry.answer;
    // A replay costs nothing and says so: no cost, not an estimate, never an overrun.
    yield { kind: "settle", status: settle.status, class: "ok", ...(settle.inputTokens === undefined ? {} : { inputTokens: settle.inputTokens }), ...(settle.outputTokens === undefined ? {} : { outputTokens: settle.outputTokens }), costMicros: 0, estimated: false };
  }

  async function* forwardEvents(
    scope: RecordingScope, frame: unknown, view: ModelRequestView, key: string, itemIds: readonly string[], signal: AbortSignal | undefined, release: () => void, abandoned: () => boolean,
  ): AsyncGenerator<ModelEgressEvent> {
    let head: ModelEgressHead | undefined;
    let settle: ModelEgressSettle | undefined;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let oversize = false;
    let failed = false;
    if (abandoned()) return;
    try {
      for await (const event of options.egress.forward(options.egressScope, frame as never, signal === undefined ? undefined : { signal })) {
        if (event.kind === "head" && head === undefined) head = event;
        else if (event.kind === "chunk") {
          bytes += event.bytes.byteLength;
          if (bytes > RECORDING_ANSWER_BYTES_MAX) oversize = true;
          else chunks.push(event.bytes.slice());
        } else if (event.kind === "settle") settle = event;
        yield event;
      }
    } catch {
      // An adapter that fails, even after it sent its settle, broke its own contract: nothing it sent is recorded.
      failed = true;
      throw new Error("the model call failed");
    } finally {
      // Runs when the stream ends, fails, or the consumer stops early: only a settled answer can be recorded.
      try {
        if (settle?.overrun === true) overrun = true;
        if (failed || head === undefined || settle === undefined) note(itemIds, RECORDING_NOT_RECORDED_FAILED);
        else await track(finishRecording({ scope, view, key, itemIds, head, settle, chunks, oversize }));
      } finally {
        release();
      }
    }
  }

  async function finishRecording(args: {
    readonly scope: RecordingScope;
    readonly view: ModelRequestView;
    readonly key: string;
    readonly itemIds: readonly string[];
    readonly head: ModelEgressHead;
    readonly settle: ModelEgressSettle;
    readonly chunks: readonly Uint8Array[];
    readonly oversize: boolean;
  }): Promise<void> {
    const { settle, head, itemIds } = args;
    if (settle.class !== "ok") {
      if ((NOT_RUN_CLASSES as readonly string[]).includes(settle.class)) note(itemIds, settle.class === "cap" ? capSentence(options.capMicros) : NOT_RUN_SENTENCES[settle.class as Exclude<(typeof NOT_RUN_CLASSES)[number], "cap">]);
      else note(itemIds, RECORDING_NOT_RECORDED_FAILED);
      return;
    }
    if (head.status < 200 || head.status > 299 || settle.status < 200 || settle.status > 299) return note(itemIds, RECORDING_NOT_RECORDED_FAILED);
    if (args.oversize) return note(itemIds, RECORDING_NOT_RECORDED_TOO_LARGE);
    const whole = joinChunks(args.chunks);
    if (whole.byteLength <= WITHHELD_BYTES_MAX) {
      const text = new TextDecoder().decode(whole);
      if (text.includes(WITHHELD_ECHO_SENTENCE) || text.includes(WITHHELD_SCRUB_SENTENCE)) return note(itemIds, RECORDING_NOT_RECORDED_WITHHELD);
    }
    const isStream = args.view.streaming || head.headers.some(([name, value]) => name.toLowerCase() === "content-type" && /event-stream/iu.test(value));
    if (!answerIsComplete(args.view.family, isStream, whole)) return note(itemIds, RECORDING_NOT_RECORDED_INCOMPLETE);
    // The task has ended (its recordings are deleted): a late answer is not written back.
    if (ended) return;
    const now = options.clock();
    const answer: RecordedAnswer = {
      status: head.status,
      headers: recordedHeaders(head.headers),
      chunks: args.chunks,
      settle: {
        status: settle.status,
        class: "ok",
        ...(settle.inputTokens === undefined ? {} : { inputTokens: settle.inputTokens }),
        ...(settle.outputTokens === undefined ? {} : { outputTokens: settle.outputTokens }),
        costMicros: settle.costMicros,
        estimated: settle.estimated,
      },
    };
    const entry: RecordingEntry = { key: args.key, family: args.view.family, row: args.view.row, itemIds, recordedOn: isoDateOf(now), recordedAtMs: now, expiresAtMs: now + ttlMs, replayCount: 0, answer };
    try {
      await options.store.put(args.scope, entry);
      for (const id of itemIds) notes.delete(id);
    } catch {
      note(itemIds, RECORDING_NOT_RECORDED_UNSAVED);
    }
  }

  async function serve(frame: unknown, serveOptions: { readonly signal?: AbortSignal } = {}): Promise<RecordReplayServe> {
    let release: (() => void) | undefined;
    let handedOver = false;
    try {
      if (ended) return { kind: "not_run", reason: "ended", sentence: RECORDING_NOT_RUN_ENDED };
      if (options.plan.status !== "ready") return { kind: "not_run", reason: "plan", sentence: options.plan.sentence };
      const rowId = typeof (frame as { row?: unknown } | null | undefined)?.row === "string" ? ((frame as { row: string }).row) : undefined;
      const family = rowId === undefined ? undefined : options.familyOf?.(rowId);
      const read = readModelRequest(frame, family === undefined ? {} : { family });
      if (!read.ok) return { kind: "scripted" };
      const view = read.view;
      const matched = matchChangedItems(options.plan, view);
      if (matched.length === 0) return { kind: "scripted" };
      const keyed = modelRecordKeyOfView(view);
      if (!keyed.ok) return { kind: "scripted" };
      const scope = readScope();
      // The adapter's company and the recording's company must be one: a mismatch is a call nobody may make or serve.
      if (scope === undefined || adapterCompany() !== scope.companyId) return notRun("scope", RECORDING_NOT_RUN_SCOPE, matched);
      for (let round = 0; round < 4; round += 1) {
        let index: Awaited<ReturnType<RecordingStore["list"]>>;
        try {
          index = await options.store.list(scope);
        } catch {
          return notRun("store", RECORDING_NOT_RUN_STORE, matched);
        }
        const stored: StoredRecordings = { keys: new Set(index.map((row) => row.key)), itemIds: new Set(index.flatMap((row) => row.itemIds)) };
        const decision = decideRecording({ matched, key: keyed.key, stored, mode: options.mode });
        if (decision.action === "scripted") return { kind: "scripted" };
        if (decision.action === "miss") return notRun("no_recording", RECORDING_NOT_RUN_MISS, matched);
        if (decision.action === "replay") {
          let entry: RecordingEntry | undefined;
          try {
            entry = await options.store.get(scope, keyed.key);
          } catch {
            return notRun("store", RECORDING_NOT_RUN_STORE, matched);
          }
          // Expired or erased between the list and the read: decide again without it.
          if (entry === undefined) continue;
          if (ended) return { kind: "not_run", reason: "ended", sentence: RECORDING_NOT_RUN_ENDED };
          replaysServed += 1;
          await track(options.store.markReplayed(scope, keyed.key).catch(() => 0));
          return { kind: "stream", via: "replayed", key: keyed.key, itemIds: matched, events: replayEvents(entry), abandon: () => undefined };
        }
        // record: take the one slot, then decide again on a fresh look at the store (a call ahead of us may have recorded this prompt).
        if (release === undefined) {
          release = await acquire();
          continue;
        }
        if (ended) return { kind: "not_run", reason: "ended", sentence: RECORDING_NOT_RUN_ENDED };
        if (overrun) return notRun("budget", capSentence(options.capMicros), matched);
        if (forwards >= maxRecordings || index.length >= maxRecordings) return notRun("limit", recordingLimitSentence(maxRecordings), matched);
        forwards += 1;
        handedOver = true;
        let abandoned = false;
        const give = release;
        return {
          kind: "stream",
          via: "forwarded",
          key: keyed.key,
          itemIds: matched,
          events: forwardEvents(scope, frame, view, keyed.key, matched, serveOptions.signal, give, () => abandoned),
          abandon: () => {
            abandoned = true;
            give();
          },
        };
      }
      return notRun("no_recording", RECORDING_NOT_RUN_MISS, matched);
    } catch {
      return { kind: "not_run", reason: "store", sentence: RECORDING_NOT_RUN_STORE };
    } finally {
      if (!handedOver) release?.();
    }
  }

  async function summary(): Promise<RecordingSummary> {
    const plan = options.plan;
    const planned = plan.status === "ready" ? plan.items : [];
    const scope = readScope();
    let index: Awaited<ReturnType<RecordingStore["list"]>> = [];
    if (scope !== undefined) {
      try {
        index = await options.store.list(scope);
      } catch {
        index = [];
      }
    }
    const items: RecordingSummaryItem[] = planned.map((item) => {
      const rows = index.filter((row) => row.itemIds.includes(item.id));
      const replays = rows.reduce((total, row) => total + row.replayCount, 0);
      const recordedOn = rows.map((row) => row.recordedOn).sort()[0];
      const keys = rows.map((row) => row.key).sort();
      if (rows.length > 0) return { id: item.id, outcome: replays > 0 ? "replayed" : "recorded", sentence: replays > 0 ? "replayed" : "recorded", ...(recordedOn === undefined ? {} : { recordedOn }), replays, keys };
      const held = notes.get(item.id);
      if (held === undefined) return { id: item.id, outcome: "not_recorded", sentence: RECORDING_NOT_RECORDED_NO_CALL, replays: 0, keys: [] };
      return { id: item.id, outcome: held.startsWith("not run") ? "not_run" : "not_recorded", sentence: held, replays: 0, keys: [] };
    });
    const count = (outcome: RecordingItemOutcome): number => items.filter((item) => item.outcome === outcome).length;
    const recordedOn = items.map((item) => item.recordedOn).filter((day): day is string => day !== undefined).sort()[0];
    const replaysTotal = items.reduce((total, item) => total + item.replays, 0);
    const recorded = items.filter((item) => item.outcome === "recorded" || item.outcome === "replayed").length;
    const itemsOmitted = plan.status === "ready" && plan.itemsOmitted;
    const headline = `Model answers for ${String(items.length)} changed prompt${items.length === 1 ? "" : "s"}: ${
      recordedOn === undefined ? "none recorded" : `${recordedLabel(recordedOn)}${replaysTotal > 0 ? `, replayed ${String(replaysTotal)} time${replaysTotal === 1 ? "" : "s"}` : ""}${recorded < items.length ? `, ${String(items.length - recorded)} not recorded` : ""}`
    }${itemsOmitted ? "; some changed items not recorded (report truncated)" : ""}`;
    return {
      schemaVersion: 1,
      store: options.store.word,
      items,
      ...(recordedOn === undefined ? {} : { recordedOn, label: recordedLabel(recordedOn) }),
      counts: { recorded: count("recorded"), replayed: count("replayed"), notRecorded: count("not_recorded"), notRun: count("not_run"), forwards, replaysServed },
      headline,
      itemsOmitted,
    };
  }

  async function endTask(): Promise<number> {
    const scope = readScope();
    if (scope === undefined) throw new Error("the recording scope could not be read");
    // First stop new writes, then let the ones already started finish, then delete: nothing survives the task.
    ended = true;
    await Promise.allSettled([...inflight]);
    try {
      return await options.store.deleteTask(scope);
    } catch {
      throw new Error("the recordings could not be deleted");
    }
  }

  return {
    serve,
    summary,
    endTask,
    get overrun() {
      return overrun;
    },
    get forwards() {
      return forwards;
    },
    get taskState() {
      return { overrun, forwards };
    },
  };
}
