// TE-F2 part B (M2, release 0.5.19; DECISIONS 158, 161): the model helper's ledger and its summary. One JSON line per call, written BEFORE the answer is sent (the fake helper's rule, fake-helper.ts), into a file on the helper's own
// tmpfs. NEVER a body, a header value, a query or a prompt: a row holds the time, the row id, the family, the operation, the model name (held to the echo pattern), the kind, the reply id, the provenance, the SHA-256 of the
// reply's response, the SHA-256 of the prompt (a hash is allowed), the failure-pack mode, the status, and for an escape the NAME a client called (a plain public host name that passed the strict host checker).
//
// The worker reads the summary with `docker exec <helper> node dist/model-helper.js --summarize --ledger <file>` while the helper is up (the fake's pattern, fake-usage.ts). The summary is ONE line of JSON, strict and bounded
// (`ModelHelperSummary`): counts by provenance, failure-pack calls, unmatched, refused, not-served, backend answers, and the escapes recorded by F1-b's 443/80 recorder, plus the block state. A ledger that has a malformed line,
// two headers, a row past a bound or an overflow marker is UNTRUSTED: its summary says nothing (all zero) and the evidence says "not run". A summary that cannot be read is `undefined`, never "no calls".
import { appendFileSync, readFileSync } from "node:fs";
import { z } from "zod";
import { FAILURE_MODES, MODEL_ECHO_PATTERN, REPLY_PROVENANCES, SERVED_MODEL_FAMILIES, checkModelHost, replyCountsTowardProof } from "@agentx/contracts/model-helper";
import { MODEL_BLOCK_STATES, MODEL_HELPER_MODES } from "./model-helper-args.js";

export const MODEL_LEDGER_MAX_ROWS = 10_000;
export const MODEL_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
export const MODEL_SUMMARY_MAX_ESCAPE_HOSTS = 256;
export const MODEL_LEDGER_KINDS = ["scripted", "failure_pack", "unmatched", "refused", "not_served", "backend", "escape", "escape_host"] as const;
export type ModelLedgerKind = (typeof MODEL_LEDGER_KINDS)[number];
/** Why a call was refused before it reached a row: the fixed words, never the refused text. */
export const MODEL_REFUSAL_REASONS = ["caller", "connect", "upgrade", "target", "headers", "too_large", "ledger_full", "mode", "timeout"] as const;
export type ModelRefusalReason = (typeof MODEL_REFUSAL_REASONS)[number];

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const RowId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u);
const ReplyId = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/u);
const Operation = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u);
/** A host as a ledger row may hold it: one lower-case public DNS name (the strict checker's own rule). */
const LedgerHost = z.string().max(253).refine((host) => checkModelHost(host).ok, "a plain public host name");

export const ModelLedgerHeaderSchema = z
  .object({ header: z.literal(1), mode: z.enum(MODEL_HELPER_MODES), blockState: z.enum(MODEL_BLOCK_STATES), digest: Hex64, startedAt: z.number().int().min(0) })
  .strict();
export type ModelLedgerHeader = z.infer<typeof ModelLedgerHeaderSchema>;

export const ModelLedgerRowSchema = z
  .object({
    t: z.number().int().min(0),
    kind: z.enum(MODEL_LEDGER_KINDS),
    row: RowId.optional(),
    family: z.enum(SERVED_MODEL_FAMILIES).optional(),
    operation: Operation.optional(),
    model: z.string().regex(MODEL_ECHO_PATTERN).optional(),
    replyId: ReplyId.optional(),
    provenance: z.enum(REPLY_PROVENANCES).optional(),
    replySha256: Hex64.optional(),
    promptSha256: Hex64.optional(),
    failureMode: z.enum(FAILURE_MODES).optional(),
    /** The HTTP status that was answered; 0 for an escape (a connection that was closed, no HTTP answer). */
    status: z.number().int().min(0).max(599),
    host: LedgerHost.optional(),
    reason: z.enum(MODEL_REFUSAL_REASONS).optional(),
  })
  .strict();
export type ModelLedgerRow = z.infer<typeof ModelLedgerRowSchema>;
const OverflowSchema = z.object({ overflow: z.literal(true) }).strict();

// ---- writing

export interface ModelLedgerWriter {
  /** Appends one row before the answer is sent. Returns false when the ledger is full (the caller then refuses the call, `ledger_full`). Never throws. */
  append(row: ModelLedgerRow): boolean;
  /** Whether the ledger can still take rows. */
  readonly open: boolean;
}

/** The writer of a ledger file: the header first, then one line per row, bounded in rows and bytes; the last accepted line past the bound is an overflow marker (the summary then says nothing). `write` is the file seam (tests). */
export function createModelLedgerWriter(path: string, header: ModelLedgerHeader, write: (path: string, line: string) => void = (target, line) => appendFileSync(target, line, { mode: 0o600 })): ModelLedgerWriter {
  let rows = 0;
  let bytes = 0;
  let full = false;
  let healthy = true;
  const put = (line: string): boolean => {
    try {
      write(path, `${line}\n`);
      bytes += line.length + 1;
      return true;
    } catch {
      healthy = false;
      return false;
    }
  };
  put(JSON.stringify(ModelLedgerHeaderSchema.parse(header)));
  return {
    get open() {
      return healthy && !full;
    },
    append(row) {
      if (!healthy || full) return false;
      const checked = ModelLedgerRowSchema.safeParse(row);
      if (!checked.success) {
        // A row that does not fit the schema is a bug in the caller: the ledger stops being trustworthy, so it says so (an overflow marker) and refuses further calls.
        full = true;
        put(JSON.stringify({ overflow: true }));
        return false;
      }
      const line = JSON.stringify(checked.data);
      if (rows >= MODEL_LEDGER_MAX_ROWS || bytes + line.length + 1 > MODEL_LEDGER_MAX_BYTES) {
        full = true;
        put(JSON.stringify({ overflow: true }));
        return false;
      }
      if (!put(line)) return false;
      rows += 1;
      return true;
    },
  };
}

// ---- the summary

const Count = z.number().int().min(0).max(MODEL_LEDGER_MAX_ROWS);
export const ModelHelperSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    /** False for a ledger that is malformed, past a bound or unreadable: every count is then zero and means nothing. */
    trusted: z.boolean(),
    mode: z.enum(MODEL_HELPER_MODES).nullable(),
    /** `by_name` (hosted) or `not_blocked_here` (the laptop). Null for an untrusted ledger, which the evidence reads as the weaker claim. */
    blockState: z.enum(MODEL_BLOCK_STATES).nullable(),
    replySetDigest: Hex64.nullable(),
    /** Scripted answers by the provenance of the reply that was served. */
    scripted: z.object({ before_task: Count, independent: Count, task_made: Count }).strict(),
    /** Scripted answers whose reply counts toward "proven with scripted AI replies" (`replyCountsTowardProof`): before_task plus independent, never the failure pack. */
    countsTowardProof: Count,
    failurePack: Count,
    unmatched: Count,
    refused: Count,
    notServed: Count,
    backend: Count,
    /** Clients that ignored their redirect and called a model host by name (F1-b's recorder): how many connections, which names, how many unreadable ones. */
    escapes: z.object({ count: Count, hosts: z.array(LedgerHost).max(MODEL_SUMMARY_MAX_ESCAPE_HOSTS), unreadable: Count }).strict(),
  })
  .strict()
  .superRefine((summary, context) => {
    const total = summary.scripted.before_task + summary.scripted.independent + summary.scripted.task_made + summary.failurePack + summary.unmatched + summary.refused + summary.notServed + summary.backend + summary.escapes.count;
    if (!summary.trusted && total > 0) context.addIssue({ code: "custom", path: ["trusted"], message: "an untrusted ledger says nothing" });
  });
export type ModelHelperSummary = z.infer<typeof ModelHelperSummarySchema>;

export const UNTRUSTED_MODEL_SUMMARY: ModelHelperSummary = {
  schemaVersion: 1,
  trusted: false,
  mode: null,
  blockState: null,
  replySetDigest: null,
  scripted: { before_task: 0, independent: 0, task_made: 0 },
  countsTowardProof: 0,
  failurePack: 0,
  unmatched: 0,
  refused: 0,
  notServed: 0,
  backend: 0,
  escapes: { count: 0, hosts: [], unreadable: 0 },
};

/** The summary of a ledger's bytes. Never throws: a ledger it cannot trust is `UNTRUSTED_MODEL_SUMMARY`. */
export function summarizeModelLedgerBytes(bytes: Uint8Array): ModelHelperSummary {
  try {
    if (bytes.byteLength > MODEL_LEDGER_MAX_BYTES) return UNTRUSTED_MODEL_SUMMARY;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length === 0 || lines.length > MODEL_LEDGER_MAX_ROWS + 2) return UNTRUSTED_MODEL_SUMMARY;
    const header = ModelLedgerHeaderSchema.safeParse(JSON.parse(lines[0] as string));
    if (!header.success) return UNTRUSTED_MODEL_SUMMARY;
    const counts = { before_task: 0, independent: 0, task_made: 0 };
    let failurePack = 0;
    let unmatched = 0;
    let refused = 0;
    let notServed = 0;
    let backend = 0;
    let proof = 0;
    let escapeCount = 0;
    let named = 0;
    const hosts = new Set<string>();
    for (const line of lines.slice(1)) {
      const value: unknown = JSON.parse(line);
      if (OverflowSchema.safeParse(value).success) return UNTRUSTED_MODEL_SUMMARY;
      const row = ModelLedgerRowSchema.safeParse(value);
      if (!row.success) return UNTRUSTED_MODEL_SUMMARY;
      const entry = row.data;
      switch (entry.kind) {
        case "scripted": {
          // A scripted row that names no provenance is `task_made`: fail closed (never counted).
          const provenance = entry.provenance ?? "task_made";
          counts[provenance] += 1;
          if (replyCountsTowardProof(provenance)) proof += 1;
          break;
        }
        case "failure_pack":
          failurePack += 1;
          break;
        case "unmatched":
          unmatched += 1;
          break;
        case "refused":
          refused += 1;
          break;
        case "not_served":
          notServed += 1;
          break;
        case "backend":
          backend += 1;
          break;
        case "escape":
          // written when the connection is accepted (a client that sends nothing is still an escape); a name, when one is read, comes as a later `escape_host` row
          escapeCount += 1;
          if (entry.host !== undefined) {
            named += 1;
            if (hosts.size < MODEL_SUMMARY_MAX_ESCAPE_HOSTS) hosts.add(entry.host);
          }
          break;
        case "escape_host":
          // names one connection already counted: a name with no connection before it is a ledger that cannot be trusted
          if (entry.host === undefined || named >= escapeCount) return UNTRUSTED_MODEL_SUMMARY;
          named += 1;
          if (hosts.size < MODEL_SUMMARY_MAX_ESCAPE_HOSTS) hosts.add(entry.host);
          break;
      }
    }
    return {
      schemaVersion: 1,
      trusted: true,
      mode: header.data.mode,
      blockState: header.data.blockState,
      replySetDigest: header.data.digest,
      scripted: counts,
      countsTowardProof: proof,
      failurePack,
      unmatched,
      refused,
      notServed,
      backend,
      escapes: { count: escapeCount, hosts: [...hosts].sort(), unreadable: Math.max(0, escapeCount - named) },
    };
  } catch {
    return UNTRUSTED_MODEL_SUMMARY;
  }
}

/** The summary of a ledger file (the `--summarize` mode). `read` is the file seam (tests). */
export function summarizeModelLedgerFile(path: string, read: (path: string) => Uint8Array = (target) => readFileSync(target)): ModelHelperSummary {
  try {
    return summarizeModelLedgerBytes(read(path));
  } catch {
    return UNTRUSTED_MODEL_SUMMARY;
  }
}

/** Parses the one line the summary printed. Anything else (an empty line, extra text, a count past its bound) is undefined: unreadable, never "no calls". */
export function parseModelHelperSummary(stdout: string): ModelHelperSummary | undefined {
  try {
    const lines = stdout.split("\n").filter((line) => line !== "");
    if (lines.length !== 1) return undefined;
    const parsed = ModelHelperSummarySchema.safeParse(JSON.parse(lines[0] as string));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
