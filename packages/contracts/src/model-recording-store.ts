// TE-F8 (release 0.5.19, additive, no callers): where a recorded model answer lives, and what it may say about itself.
//
// PHASE A (design te-f1 section 6, DECISIONS 163b D6): a task-scoped cache, never kept past the task. This file is the SEAM (`RecordingStore`) and the fixed words; the file store for a worker or a laptop is
// `packages/worker/src/model-record-store-task.ts`, and the in-memory store here is for tests and for a caller with no disk. PHASE B (project recordings in the customer's bucket) is NOT built here (TE-G7, TE-IF2): its store
// fills the same seam later, and `recordingPlacement` already names where it would live (O35).
//
// Every stored recording has: an EXPIRY (a store refuses an entry with none, or one further out than `RECORDING_TTL_MS_MAX`, and never returns an expired one), ERASE COVERAGE (`deleteTask` at the task's end, `eraseCompany` for
// "delete all recordings", `sweep` for what a crash left behind) and COMPANY SCOPING (every call names a `RecordingScope`; company B can never read company A's recordings, even with the same task id and the same request).
//
// A recording never holds a request header, a request body (its key hash only) or a provider account header. It is labelled "Recorded on <date>", and is the trust class `recorded`, never `real`.
import { z } from "zod";

export const MODEL_RECORDING_SCHEMA_VERSION = 1;

/** The store word of the phase A task cache. `EVIDENCE_RECORDING_STORES` (evidence.ts, A2) has no word for it yet: A2/A3 add `task_cache` there (a coordinator decision), or take this constant. */
export const RECORDING_STORE_TASK_CACHE = "task_cache";
/** Every store word a recording can name: the four evidence words (O35) and the phase A cache. */
export const RECORDING_STORE_WORDS = ["task_cache", "local_file", "customer_bucket", "rovara", "repo"] as const;
export type RecordingStoreWord = (typeof RECORDING_STORE_WORDS)[number];

/** How long a recording may live: the default is a day; no store accepts more than a week. */
export const RECORDING_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000;
export const RECORDING_TTL_MS_MAX = 7 * 24 * 60 * 60 * 1000;
/** The most decoded answer bytes one recording holds, and the most recordings one task holds. */
export const RECORDING_ANSWER_BYTES_MAX = 8 * 1024 * 1024;
export const RECORDING_TASK_ENTRIES_MAX = 100;
/** The per-task recording count a record-replay engine allows by default (defence in depth beside the cost cap). */
export const RECORDING_TASK_RECORDINGS_DEFAULT = 20;

export const RECORDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
export interface RecordingScope {
  readonly companyId: string;
  readonly taskId: string;
}
/** The scope as a plain pair of safe ids, or undefined. Never throws (a scope whose getter throws is "no scope"). */
export function checkRecordingScope(value: unknown): RecordingScope | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const { companyId, taskId } = value as Partial<RecordingScope>;
    return typeof companyId === "string" && typeof taskId === "string" && RECORDING_ID_PATTERN.test(companyId) && RECORDING_ID_PATTERN.test(taskId) ? { companyId, taskId } : undefined;
  } catch {
    return undefined;
  }
}

/** What an answer was, as the ledger read it. Whole numbers only. */
export interface RecordedSettle {
  readonly status: number;
  readonly class: "ok";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costMicros: number;
  readonly estimated: boolean;
}
export interface RecordedAnswer {
  readonly status: number;
  /** The head's headers, as the adapter's allow list already sanitised them. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** The chunks as they came, so a replay keeps the recorded chunking. */
  readonly chunks: readonly Uint8Array[];
  readonly settle: RecordedSettle;
}
export interface RecordingEntry {
  readonly key: string;
  readonly family: string;
  readonly row: string;
  /** The F4 item ids this recording answers (hashes). */
  readonly itemIds: readonly string[];
  /** `YYYY-MM-DD`, UTC. */
  readonly recordedOn: string;
  readonly recordedAtMs: number;
  readonly expiresAtMs: number;
  readonly replayCount: number;
  readonly answer: RecordedAnswer;
}
/** What `list` says of an entry: hashes, dates and counts. Never an answer. */
export interface RecordingIndexRow {
  readonly key: string;
  readonly itemIds: readonly string[];
  readonly recordedOn: string;
  readonly expiresAtMs: number;
  readonly replayCount: number;
  readonly bytes: number;
}

/**
 * The seam. Every method is scoped: an implementation keys EVERYTHING by `scope.companyId` as well as the task. `get` and `list` never return an expired entry. `put` refuses (rejects) an entry with no usable expiry
 * and one that would pass the size or count limits; it never overwrites another company's entry. Errors carry no answer text.
 */
export interface RecordingStore {
  readonly word: RecordingStoreWord;
  get(scope: RecordingScope, key: string): Promise<RecordingEntry | undefined>;
  put(scope: RecordingScope, entry: RecordingEntry): Promise<void>;
  list(scope: RecordingScope): Promise<readonly RecordingIndexRow[]>;
  /** Adds one to the entry's replay count and returns it (0 when there is no such entry). */
  markReplayed(scope: RecordingScope, key: string): Promise<number>;
  /** Task end: removes every recording of this company's task. Returns how many. */
  deleteTask(scope: RecordingScope): Promise<number>;
  /** "Delete all recordings": removes every recording of the company, all tasks. Returns how many. */
  eraseCompany(companyId: string): Promise<number>;
  /** Removes what is expired and what a crash left behind. Returns how many. */
  sweep(): Promise<number>;
}

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Whole = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Header = z.tuple([z.string().max(256), z.string().max(1024)]);
/** The entry as a file holds it: chunks are base64 text. Strict: an unknown key is refused. */
export const RecordingEntryFileSchema = z
  .object({
    version: z.literal(MODEL_RECORDING_SCHEMA_VERSION),
    companyId: z.string().regex(RECORDING_ID_PATTERN),
    taskId: z.string().regex(RECORDING_ID_PATTERN),
    key: Hash,
    family: z.string().max(40),
    row: z.string().max(64),
    itemIds: z.array(Hash).max(500),
    recordedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    recordedAtMs: Whole,
    expiresAtMs: Whole,
    replayCount: Whole,
    answer: z
      .object({
        status: z.number().int().min(100).max(599),
        headers: z.array(Header).max(32),
        chunks: z.array(z.string()).max(100_000),
        settle: z.object({ status: z.number().int().min(100).max(599), class: z.literal("ok"), inputTokens: Whole.optional(), outputTokens: Whole.optional(), costMicros: Whole, estimated: z.boolean() }).strict(),
      })
      .strict(),
  })
  .strict();
export type RecordingEntryFile = z.infer<typeof RecordingEntryFileSchema>;

export const entryAnswerBytes = (answer: RecordedAnswer): number => answer.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);

/** Why an entry may not be stored, or undefined when it may. `now` is the store's clock. */
export function checkRecordingEntry(entry: RecordingEntry, now: number): "no_expiry" | "expiry_too_far" | "too_large" | "bad_key" | "bad_answer" | undefined {
  if (!/^[a-f0-9]{64}$/u.test(entry.key)) return "bad_key";
  if (!Number.isSafeInteger(entry.expiresAtMs) || entry.expiresAtMs <= now) return "no_expiry";
  if (entry.expiresAtMs - now > RECORDING_TTL_MS_MAX) return "expiry_too_far";
  if (entry.answer.settle.class !== "ok" || entry.answer.status < 200 || entry.answer.status > 299) return "bad_answer";
  if (entryAnswerBytes(entry.answer) > RECORDING_ANSWER_BYTES_MAX) return "too_large";
  return undefined;
}

export function entryToFile(scope: RecordingScope, entry: RecordingEntry): RecordingEntryFile {
  return {
    version: MODEL_RECORDING_SCHEMA_VERSION,
    companyId: scope.companyId,
    taskId: scope.taskId,
    key: entry.key,
    family: entry.family,
    row: entry.row,
    itemIds: [...entry.itemIds],
    recordedOn: entry.recordedOn,
    recordedAtMs: entry.recordedAtMs,
    expiresAtMs: entry.expiresAtMs,
    replayCount: entry.replayCount,
    answer: {
      status: entry.answer.status,
      headers: entry.answer.headers.map(([name, value]) => [name, value] as [string, string]),
      chunks: entry.answer.chunks.map((chunk) => Buffer.from(chunk).toString("base64")),
      settle: { ...entry.answer.settle },
    },
  };
}

/** The entry a file holds, with the scope it was written for; undefined for anything that is not exactly an entry. Never throws. */
export function entryFromFileText(text: string): { readonly scope: RecordingScope; readonly entry: RecordingEntry } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  const parsed = RecordingEntryFileSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const file = parsed.data;
  const chunks = file.answer.chunks.map((chunk) => new Uint8Array(Buffer.from(chunk, "base64")));
  return {
    scope: { companyId: file.companyId, taskId: file.taskId },
    entry: {
      key: file.key,
      family: file.family,
      row: file.row,
      itemIds: file.itemIds,
      recordedOn: file.recordedOn,
      recordedAtMs: file.recordedAtMs,
      expiresAtMs: file.expiresAtMs,
      replayCount: file.replayCount,
      answer: {
        status: file.answer.status,
        headers: file.answer.headers,
        chunks,
        settle: {
          status: file.answer.settle.status,
          class: "ok",
          ...(file.answer.settle.inputTokens === undefined ? {} : { inputTokens: file.answer.settle.inputTokens }),
          ...(file.answer.settle.outputTokens === undefined ? {} : { outputTokens: file.answer.settle.outputTokens }),
          costMicros: file.answer.settle.costMicros,
          estimated: file.answer.settle.estimated,
        },
      },
    },
  };
}

export const indexRowOf = (entry: RecordingEntry): RecordingIndexRow => ({ key: entry.key, itemIds: entry.itemIds, recordedOn: entry.recordedOn, expiresAtMs: entry.expiresAtMs, replayCount: entry.replayCount, bytes: entryAnswerBytes(entry.answer) });

/** The in-memory store: the reference for the seam's rules (expiry, scoping, limits, erase). Holds copies, never the caller's arrays. */
export function createMemoryRecordingStore(options: { readonly now: () => number; readonly word?: RecordingStoreWord }): RecordingStore {
  const companies = new Map<string, Map<string, Map<string, RecordingEntry>>>();
  const tasksOf = (companyId: string): Map<string, Map<string, RecordingEntry>> => {
    const held = companies.get(companyId) ?? new Map<string, Map<string, RecordingEntry>>();
    companies.set(companyId, held);
    return held;
  };
  const live = (entry: RecordingEntry | undefined): RecordingEntry | undefined => (entry !== undefined && entry.expiresAtMs > options.now() ? entry : undefined);
  const copy = (entry: RecordingEntry): RecordingEntry => ({ ...entry, itemIds: [...entry.itemIds], answer: { ...entry.answer, headers: entry.answer.headers.map(([name, value]) => [name, value] as const), chunks: entry.answer.chunks.map((chunk) => chunk.slice()) } });
  return {
    word: options.word ?? RECORDING_STORE_TASK_CACHE,
    get(scope, key) {
      const held = companies.get(scope.companyId)?.get(scope.taskId)?.get(key);
      const found = live(held);
      if (held !== undefined && found === undefined) companies.get(scope.companyId)?.get(scope.taskId)?.delete(key);
      return Promise.resolve(found === undefined ? undefined : copy(found));
    },
    put(scope, entry) {
      const refused = checkRecordingEntry(entry, options.now());
      if (refused !== undefined) return Promise.reject(new Error(`recording refused: ${refused}`));
      const task = tasksOf(scope.companyId).get(scope.taskId) ?? new Map<string, RecordingEntry>();
      if (!task.has(entry.key) && task.size >= RECORDING_TASK_ENTRIES_MAX) return Promise.reject(new Error("recording refused: too_many"));
      task.set(entry.key, copy(entry));
      tasksOf(scope.companyId).set(scope.taskId, task);
      return Promise.resolve();
    },
    list(scope) {
      const task = companies.get(scope.companyId)?.get(scope.taskId);
      return Promise.resolve([...(task?.values() ?? [])].filter((entry) => live(entry) !== undefined).map(indexRowOf).sort((left, right) => (left.key < right.key ? -1 : 1)));
    },
    markReplayed(scope, key) {
      const task = companies.get(scope.companyId)?.get(scope.taskId);
      const held = live(task?.get(key));
      if (task === undefined || held === undefined) return Promise.resolve(0);
      task.set(key, { ...held, replayCount: held.replayCount + 1 });
      return Promise.resolve(held.replayCount + 1);
    },
    deleteTask(scope) {
      const tasks = companies.get(scope.companyId);
      const count = tasks?.get(scope.taskId)?.size ?? 0;
      tasks?.delete(scope.taskId);
      return Promise.resolve(count);
    },
    eraseCompany(companyId) {
      let count = 0;
      for (const task of companies.get(companyId)?.values() ?? []) count += task.size;
      companies.delete(companyId);
      return Promise.resolve(count);
    },
    sweep() {
      let count = 0;
      for (const tasks of companies.values()) {
        for (const [taskId, task] of tasks) {
          for (const [key, entry] of task) {
            if (live(entry) !== undefined) continue;
            task.delete(key);
            count += 1;
          }
          if (task.size === 0) tasks.delete(taskId);
        }
      }
      return Promise.resolve(count);
    },
  };
}

// ---- the words -------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** `YYYY-MM-DD` of a millisecond time, UTC. A pure function of its input. */
export function isoDateOf(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "1970-01-01";
}
/** `13 Nov` from `2026-11-13`; undefined for anything else. */
export function shortDayOf(day: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  const month = match === null ? undefined : MONTHS[Number(match[2]) - 1];
  return match === null || month === undefined || Number(match[3]) < 1 || Number(match[3]) > 31 ? undefined : `${String(Number(match[3]))} ${month}`;
}
/** "Recorded on 13 Nov (this task)" for the phase A cache; "Recorded on 13 Nov" for a project recording. Never "Real". An unreadable date gives "Recorded" alone, never an invented day. */
export function recordedLabel(recordedOn: string, scope: "task" | "project" = "task"): string {
  const day = shortDayOf(recordedOn);
  return `${day === undefined ? "Recorded" : `Recorded on ${day}`}${scope === "task" ? " (this task)" : ""}`;
}

export const RECORDING_UNAVAILABLE_SENTENCE = "Connect a bucket, or ask your admin";
export const RECORDING_UNAVAILABLE_ACTION = "send to admin";
export const RECORDING_ROVARA_STORAGE_WARNING = "Recordings are kept in Rovara storage: masked data only, encrypted per company, kept for the retention your admin sets, with a logged read for every access and a one-click delete of all recordings.";
export const RECORDING_REPO_WARNING = "Recordings in your repository stay in git history forever, so they cannot be deleted later.";

export interface RecordingSettings {
  /** A laptop (Code): a local file, never uploaded. */
  readonly laptop?: boolean;
  /** The company has a connected cloud account, so a bucket can be read through its role. */
  readonly cloudAccountConnected?: boolean;
  /** An admin turned on Rovara storage (explicit warning, never a default). */
  readonly adminAllowsRovaraStorage?: boolean;
  /** An admin turned on recording into the customer's repo (explicit warning, never a default). */
  readonly adminAllowsRepoStorage?: boolean;
}
export type RecordingPlacementChoice =
  | { readonly store: "local_file" | "customer_bucket"; readonly isDefault: true }
  | { readonly store: "rovara" | "repo"; readonly isDefault: false; readonly adminOptIn: true; readonly warning: string }
  | { readonly store: "unavailable"; readonly isDefault: false; readonly sentence: typeof RECORDING_UNAVAILABLE_SENTENCE; readonly action: typeof RECORDING_UNAVAILABLE_ACTION };
export interface RecordingPlacement {
  /** Where PROJECT recordings go (phase B; not built here). */
  readonly primary: RecordingPlacementChoice;
  /** The admin opt-ins that are on, besides the primary. */
  readonly alternatives: readonly RecordingPlacementChoice[];
  /** The phase A task cache is allowed whatever the placement is (D6): it is never kept past the task. */
  readonly phaseA: typeof RECORDING_STORE_TASK_CACHE;
}
const ROVARA_CHOICE: RecordingPlacementChoice = { store: "rovara", isDefault: false, adminOptIn: true, warning: RECORDING_ROVARA_STORAGE_WARNING };
const REPO_CHOICE: RecordingPlacementChoice = { store: "repo", isDefault: false, adminOptIn: true, warning: RECORDING_REPO_WARNING };

/** The O35 table as a pure function. Laptop: a local file. Else the customer's bucket when a cloud account is connected (the default). Rovara storage and the repo only as admin opt-ins with their warnings. Else unavailable. */
export function recordingPlacement(settings: RecordingSettings): RecordingPlacement {
  const opt: RecordingPlacementChoice[] = [...(settings.adminAllowsRovaraStorage === true ? [ROVARA_CHOICE] : []), ...(settings.adminAllowsRepoStorage === true ? [REPO_CHOICE] : [])];
  if (settings.laptop === true) return { primary: { store: "local_file", isDefault: true }, alternatives: [], phaseA: RECORDING_STORE_TASK_CACHE };
  if (settings.cloudAccountConnected === true) return { primary: { store: "customer_bucket", isDefault: true }, alternatives: opt, phaseA: RECORDING_STORE_TASK_CACHE };
  const [first, ...rest] = opt;
  if (first !== undefined) return { primary: first, alternatives: rest, phaseA: RECORDING_STORE_TASK_CACHE };
  return { primary: { store: "unavailable", isDefault: false, sentence: RECORDING_UNAVAILABLE_SENTENCE, action: RECORDING_UNAVAILABLE_ACTION }, alternatives: [], phaseA: RECORDING_STORE_TASK_CACHE };
}

/** The v2 evidence dependency fields of a recorded answer (evidence.ts `dependency`: `trust`, `recordedOn`, `recording`). A recording is never `real` and never a proof basis; the type has no other trust word. */
export interface RecordedDependencyFields {
  readonly trust: "recorded";
  readonly recordedOn: string;
  readonly recording: { readonly store: RecordingStoreWord; readonly recordedOn: string };
  /** The words to show: "Recorded on 13 Nov (this task)". */
  readonly labelText: string;
}
/**
 * The dependency fields for a summary, for A2b's writer; `undefined` when the summary has no usable `recordedOn` day (`YYYY-MM-DD`). A recording states when it was recorded or it is not described as one: no day is ever
 * invented, neither today's nor a placeholder.
 */
export function recordedDependencyFor(summary: { readonly recordedOn?: string; readonly store?: RecordingStoreWord }): RecordedDependencyFields | undefined {
  const recordedOn = summary.recordedOn;
  if (recordedOn === undefined || shortDayOf(recordedOn) === undefined) return undefined;
  const store = summary.store ?? RECORDING_STORE_TASK_CACHE;
  return { trust: "recorded", recordedOn, recording: { store, recordedOn }, labelText: recordedLabel(recordedOn, store === RECORDING_STORE_TASK_CACHE ? "task" : "project") };
}
