// TE-F2 part A (M2, release 0.5.19; DECISIONS 158, 161): the reply set, the file of scripted model replies a project keeps (`.rovara/mocks/model/<family>.json`) and the helper answers from.
//
// TWO FORMS, on purpose:
//   the FILE form (`ModelReplySetFileSchema`): what a repo file may hold. A reply is `{id, match, response}` and has NO provenance and NO origin: a key of either name is an unknown key and is refused. A file the coding
//   agent could have written is never trusted to say where its replies came from.
//   the RESOLVED form (`ModelReplySetSchema`): what the helper loads. Each reply also carries `provenance` (`before_task`, `independent`, `task_made`) and, for `before_task` only, its `origin`. The WORKER builds it from the
//   file with `stampReplyProvenance`, from the base commit (Part B item 3); a reply the worker has no decision for, or one it cannot show the origin of, is `task_made` (never counted). `independent` is defined here and is
//   accepted only through a Rovara-side channel that does not exist yet (Part A defines the value; no store and no agent are built).
//
// Rules the schema carries: unknown keys refused at every level; a `__proto__` key is an unknown key (and is refused inside tool-call arguments too); every list and text is bounded: 2,000 replies, 4 MiB, 1,000,000
// characters of text, 32 tool calls; `promptContains` is a literal (never a regex); the first matching reply wins; no match is `unmatched` and the helper never invents a reply. PURE: no network; the digest and the prompt
// hash use `node:crypto` through `sha256HexOf`, as F0a's catalog digest does.
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { MODEL_ECHO_PATTERN, MODEL_NAME_MAX_CHARS, MODEL_REPLY_MAX_CHARS, type ModelReply } from "./model-family-common.js";
import { BEFORE_TASK_ORIGINS, REPLY_PROVENANCES, isReplyProvenance, type BeforeTaskOrigin, type ReplyProvenance } from "./model-reply-provenance.js";
import { ALL_REPLY_OPERATIONS, OPERATIONS_BY_FAMILY, SERVED_MODEL_FAMILIES, type ServedModelFamily } from "./model-served-family.js";
import { sha256HexOf } from "./service-catalog-verify.js";

export const MODEL_REPLY_SET_VERSION = 1;
export const MODEL_REPLY_SET_MAX_REPLIES = 2000;
export const MODEL_REPLY_SET_MAX_BYTES = 4 * 1024 * 1024;
export const MODEL_REPLY_PROMPT_CONTAINS_MAX_CHARS = 512;
export const MODEL_REPLY_SEQUENCE_MAX = 10_000;
const MODEL_REPLY_TOOL_CALLS_MAX = 32;
const ARGS_MAX_DEPTH = 16;
const ARGS_MAX_NODES = 5_000;
const REPLY_SET_DIGEST_DOMAIN = "rovara-model-reply-set/v1\n";

const ReplyId = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/u).refine((id) => id !== "__proto__", "a plain id");

/** A JSON object with finite numbers, no `__proto__` key at any depth, bounded in depth and size: a tool call's arguments. */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > ARGS_MAX_NODES || depth > ARGS_MAX_DEPTH) return false;
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return true;
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (Array.isArray(candidate)) return candidate.every((item) => visit(item, depth + 1));
    if (typeof candidate === "object") {
      const prototype = Object.getPrototypeOf(candidate) as unknown;
      if (prototype !== Object.prototype && prototype !== null) return false;
      return Object.keys(candidate).every((key) => key !== "__proto__" && visit((candidate as Record<string, unknown>)[key], depth + 1));
    }
    return false;
  };
  return typeof value === "object" && value !== null && !Array.isArray(value) && visit(value, 0) && JSON.stringify(value).length <= MODEL_REPLY_MAX_CHARS;
}
const ToolArgs = z.custom<Record<string, unknown>>(isPlainJsonObject, "tool-call arguments are a plain JSON object");
const TokenCount = z.number().int().min(0).max(1_000_000_000);

export const ModelReplyResponseSchema = z
  .object({
    text: z.string().max(MODEL_REPLY_MAX_CHARS),
    toolCalls: z.array(z.object({ name: z.string().min(1).max(MODEL_NAME_MAX_CHARS), args: ToolArgs }).strict()).max(MODEL_REPLY_TOOL_CALLS_MAX).optional(),
    finish: z.enum(["stop", "length", "safety", "tool_calls", "other"]),
    usage: z.object({ inputTokens: TokenCount, outputTokens: TokenCount }).strict().optional(),
  })
  .strict();
export type ModelReplyResponse = z.infer<typeof ModelReplyResponseSchema>;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
export const ModelReplyMatchSchema = z
  .object({
    model: z.string().regex(MODEL_ECHO_PATTERN).optional(),
    operation: z.enum(ALL_REPLY_OPERATIONS as [string, ...string[]]).optional(),
    promptSha256: Sha256Hex.optional(),
    promptContains: z.string().min(1).max(MODEL_REPLY_PROMPT_CONTAINS_MAX_CHARS).optional(),
    /** The nth call that matches this reply's other criteria (1 is the first). */
    sequence: z.number().int().min(1).max(MODEL_REPLY_SEQUENCE_MAX).optional(),
  })
  .strict()
  .refine((match) => match.promptSha256 === undefined || match.promptContains === undefined, "promptSha256 or promptContains, not both");
export type ModelReplyMatch = z.infer<typeof ModelReplyMatchSchema>;

const FileReplySchema = z.object({ id: ReplyId, match: ModelReplyMatchSchema, response: ModelReplyResponseSchema }).strict();
const ResolvedReplySchema = z
  .object({ id: ReplyId, match: ModelReplyMatchSchema, response: ModelReplyResponseSchema, provenance: z.enum(REPLY_PROVENANCES), origin: z.enum(BEFORE_TASK_ORIGINS).optional() })
  .strict()
  .refine((reply) => (reply.provenance === "before_task") === (reply.origin !== undefined), "an origin belongs to a before_task reply, and a before_task reply has one");

type FileReply = z.infer<typeof FileReplySchema>;
type ResolvedReply = z.infer<typeof ResolvedReplySchema>;

function setSchema<Reply extends FileReply | ResolvedReply>(reply: z.ZodType<Reply>) {
  return z
    .object({ version: z.literal(MODEL_REPLY_SET_VERSION), family: z.enum(SERVED_MODEL_FAMILIES), replies: z.array(reply).max(MODEL_REPLY_SET_MAX_REPLIES) })
    .strict()
    .superRefine((set, context) => {
      const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
      const ids = set.replies.map((entry) => entry.id);
      if (new Set(ids).size !== ids.length) problem(["replies"], "a reply id is listed once");
      const allowed = OPERATIONS_BY_FAMILY[set.family];
      set.replies.forEach((entry, index) => {
        if (entry.match.operation !== undefined && !allowed.includes(entry.match.operation)) problem(["replies", index, "match", "operation"], "this operation does not belong to the set's family");
      });
      if (new TextEncoder().encode(JSON.stringify(set)).length > MODEL_REPLY_SET_MAX_BYTES) problem([], "a reply set is at most 4 MiB");
    });
}

/** The FILE form: no provenance, no origin. */
export const ModelReplySetFileSchema = setSchema(FileReplySchema);
/** The RESOLVED form: every reply has the provenance the worker decided. */
export const ModelReplySetSchema = setSchema(ResolvedReplySchema);
export type ModelReplySetFile = z.infer<typeof ModelReplySetFileSchema>;
export type ModelReplySet = z.infer<typeof ModelReplySetSchema>;
export type ModelReplyFileEntry = ModelReplySetFile["replies"][number];
export type ModelReplyEntry = ModelReplySet["replies"][number];

/** The canonical digest of a reply set (either form): SHA-256 over a fixed domain prefix and the canonical JSON (keys in alphabetical order; the reply ORDER is content, because the first match wins). */
export function modelReplySetDigest(set: ModelReplySetFile | ModelReplySet): string {
  return sha256HexOf(new TextEncoder().encode(`${REPLY_SET_DIGEST_DOMAIN}${canonicalJson(set)}`));
}

/** The SHA-256 (hex) of a reply's response in canonical JSON: what the ledger records instead of the reply text. */
export function modelReplyContentSha256(reply: Pick<ModelReplyEntry, "response">): string {
  return sha256HexOf(new TextEncoder().encode(canonicalJson(reply.response)));
}

export type ParsedReplySetFile = { ok: true; set: ModelReplySetFile; digest: string } | { ok: false; reason: string };
export type ParsedReplySet = { ok: true; set: ModelReplySet; digest: string } | { ok: false; reason: string };

function parseBytes(bytes: Uint8Array): { ok: true; json: unknown } | { ok: false; reason: string } {
  if (bytes.byteLength > MODEL_REPLY_SET_MAX_BYTES) return { ok: false, reason: "the reply set is too large" };
  try {
    return { ok: true, json: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { ok: false, reason: "the reply set is not valid JSON" };
  }
}

/** The strict parse of a repo file's bytes: size cap, JSON, then the FILE schema. Fixed words on failure; never throws. */
export function parseModelReplySetFileBytes(bytes: Uint8Array): ParsedReplySetFile {
  const read = parseBytes(bytes);
  if (!read.ok) return read;
  const parsed = ModelReplySetFileSchema.safeParse(read.json);
  return parsed.success ? { ok: true, set: parsed.data, digest: modelReplySetDigest(parsed.data) } : { ok: false, reason: "the reply set does not pass the reply-set schema" };
}

/** The strict parse of the helper's file (the resolved form, written by the worker). */
export function parseModelReplySetBytes(bytes: Uint8Array): ParsedReplySet {
  const read = parseBytes(bytes);
  if (!read.ok) return read;
  const parsed = ModelReplySetSchema.safeParse(read.json);
  return parsed.success ? { ok: true, set: parsed.data, digest: modelReplySetDigest(parsed.data) } : { ok: false, reason: "the reply set does not pass the reply-set schema" };
}

/** What the worker decided for one reply. */
export interface ReplyProvenanceDecision {
  readonly provenance: ReplyProvenance;
  /** Required for `before_task`; ignored otherwise. */
  readonly origin?: BeforeTaskOrigin | undefined;
}

/**
 * The resolved set for a file set and the worker's decisions (reply id to decision). A reply with no decision, a provenance that is not exactly one of the three, or a `before_task` with no known origin is `task_made`:
 * fail closed. Nothing in the file can reach this function's decision: the file form has no provenance to read.
 */
export function stampReplyProvenance(file: ModelReplySetFile, decisions: ReadonlyMap<string, ReplyProvenanceDecision>): ModelReplySet {
  const replies = file.replies.map((reply): ModelReplyEntry => {
    const decision = decisions.get(reply.id);
    const provenance: unknown = decision?.provenance;
    if (isReplyProvenance(provenance) && provenance === "before_task" && (BEFORE_TASK_ORIGINS as readonly unknown[]).includes(decision?.origin)) return { ...reply, provenance, origin: decision?.origin };
    if (isReplyProvenance(provenance) && provenance === "independent") return { ...reply, provenance };
    return { ...reply, provenance: "task_made" };
  });
  return { version: file.version, family: file.family, replies };
}

// ---- selection

export interface ModelCallFacts {
  readonly model: string | undefined;
  readonly operation: string;
  /** The prompt text of the request, or undefined when it could not be read. */
  readonly promptText: string | undefined;
}
export interface ReplySelection {
  readonly reply: ModelReplyEntry | undefined;
  /** The counts after this call: the number of calls that matched each reply's other criteria. A new map; the one passed in is not changed. */
  readonly nextCounts: Map<string, number>;
}

/**
 * The reply for a call: the FIRST reply (in the set's order) whose criteria all hold. `model` and `operation` are exact; `promptContains` is a literal, case-sensitive substring of the prompt text and never a regex;
 * `promptSha256` is the SHA-256 of the prompt text (a criterion on the prompt never matches a call whose prompt could not be read); `sequence` n selects the nth call that matches that reply's OTHER criteria, so the
 * counts advance for every reply whose other criteria matched, chosen or not. No match gives `reply: undefined` (unmatched). A set of another family than `family` matches nothing.
 */
export function selectModelReply(set: ModelReplySet | undefined, call: ModelCallFacts, counts: ReadonlyMap<string, number>, family?: ServedModelFamily): ReplySelection {
  const nextCounts = new Map(counts);
  if (set === undefined || (family !== undefined && set.family !== family)) return { reply: undefined, nextCounts };
  let promptSha: string | undefined;
  let chosen: ModelReplyEntry | undefined;
  for (const reply of set.replies) {
    const match = reply.match;
    if (match.model !== undefined && match.model !== call.model) continue;
    if (match.operation !== undefined && match.operation !== call.operation) continue;
    if (match.promptContains !== undefined && !(call.promptText !== undefined && call.promptText.includes(match.promptContains))) continue;
    if (match.promptSha256 !== undefined) {
      if (call.promptText === undefined) continue;
      promptSha ??= sha256HexOf(new TextEncoder().encode(call.promptText));
      if (promptSha !== match.promptSha256) continue;
    }
    const nth = (nextCounts.get(reply.id) ?? 0) + 1;
    nextCounts.set(reply.id, nth);
    if (chosen === undefined && (match.sequence === undefined || match.sequence === nth)) chosen = reply;
  }
  return { reply: chosen, nextCounts };
}

/** The `ModelReply` F0a's builders render for a reply's response. */
export function modelReplyOf(reply: Pick<ModelReplyEntry, "response">): ModelReply {
  const { text, toolCalls, finish, usage } = reply.response;
  return { text, finish, ...(toolCalls === undefined ? {} : { toolCalls }), ...(usage === undefined ? {} : { usage }) };
}
