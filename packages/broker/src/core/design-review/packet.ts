// Design review stage: the BROKER builds each reviewer's packet.
//
// A packet is the role prompt (id, version, digest), the design (artifact digest), the approved requirements (digest) and the design's section 8 sources, read by the broker:
// repository files at the pinned base commit, meta repository files at `knowledgeCommit`, and MCP items fetched again through the context-tools route under the PLAN_CRITIQUE
// stage permission. Every item is recorded with its kind, ref, commit or fetch time, digest and bytes, and the packet digest covers that record (canonical JSON, then SHA-256).
//
// What is NOT in a packet, by construction: the planner's transcript, the Slack thread, people's messages. The builder takes a strict, closed set of fields, so a caller that passes one
// of those is refused (`forbidden_input`), never silently trimmed. The request text goes in for the comprehension reviewer only, labelled as information.
//
// Nothing here reads anything itself: the three readers are injected (`PacketReaders`), so the existing code-host and context-tools readers are reused by the wiring (see `mcpItemReaderOf`).
// Everything is bounded: at most DESIGN_REVIEW_PACKET_ITEMS_MAX items and PACKET_BYTES_MAX bytes. A source that does not fit or cannot be read is left out and listed in `omitted`, with a
// fixed reason; the design and the requirements are never left out (the build is refused instead).
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DESIGN_REVIEW_PACKET_ITEMS_MAX, DesignReviewTierSchema, PACKET_DIGEST_VERSION, ReviewerPacketItemSchema, ReviewerRoleSchema, itemOf, neutralizePacketText, packetDigestOf, promptDigest, renderPacketDocument, renderPacketRequest, reviewerMessagesOf,
  type ContextSource, type ContextToolCallResponse, type PacketDelivery, type PacketDocument, type PacketItemKind, type ReviewerPacketItem,
} from "@agentx/contracts";
import { isOriginItem, packetMcpCall, type PacketMcpOptions, type PacketMcpRefusal } from "./mcp-allowlist.js";
import { reviewerPromptFor } from "./prompts/index.js";

// The frames, the defusing of frame-like text, the rendering and the packet digest live ONCE, in contracts/src/design-review-packet.ts: the worker renders and digests the same bytes with the
// same functions. They are re-exported here for the broker's callers and tests.
export { PACKET_DIGEST_VERSION, itemOf, neutralizePacketText, packetDigestOf, renderPacketDocument, renderPacketRequest, reviewerMessagesOf };
export type { PacketDelivery, PacketDocument, PacketItemKind, ReviewerPacketItem };

/** The most bytes of text one packet carries (role prompt, documents and request together). About 100k tokens. */
export const PACKET_BYTES_MAX = 400_000;
/** The most of the request text the comprehension reviewer is given. */
export const REQUEST_TEXT_MAX_BYTES = 16_000;
/** Section 8 can name any number of sources; the build looks at this many and no more. */
export const PACKET_SOURCES_LOOKED_AT_MAX = 200;
/** [I] Roughly four bytes to a token for prose, a little fewer for code. Calibrate against the proxy's first-call counts before relying on the 10% check. */
export const BYTES_PER_TOKEN = 4;
/** Tokens a first call carries that the packet does not: the four read-only tool definitions and the wrapper words. Calibrate on real runs. */
export const FIRST_CALL_OVERHEAD_TOKENS = 1_500;
/**
 * Tokens the reviewer's answer tool adds to the first call (structured answers): its schema and description, and the line in the system text that says to use it. The worker's biggest (the comprehension reviewer's,
 * with the paraphrase) is about 2,400 bytes; a test holds this number above it. With structured answers turned off the first call is this much smaller than the estimate: a temporary setting for one release.
 */
export const ANSWER_TOOL_OVERHEAD_TOKENS = 800;
/** One reader call (a repository file, a meta repository file, an MCP item) may take this long, then the source is left out as `unavailable`. */
export const READER_TIMEOUT_MS = 10_000;
/** The whole build may read for this long; the sources not yet read when it passes are left out as `unavailable`. */
export const BUILD_DEADLINE_MS = 60_000;

export const PACKET_OMITTED_REASONS = ["invalid_ref", "unpinned_repo", "no_knowledge_commit", "not_found", "unavailable", "not_text", "duplicate", "item_cap", "byte_cap", "not_allowed", "conversation"] as const;
export type PacketOmittedReason = (typeof PACKET_OMITTED_REASONS)[number];

export const PACKET_BUILD_FAILURES = ["forbidden_input", "invalid_input", "design_digest_mismatch", "requirements_digest_mismatch", "packet_too_large"] as const;
export type PacketBuildFailure = (typeof PACKET_BUILD_FAILURES)[number];
const BUILD_MESSAGES: Record<PacketBuildFailure, string> = {
  forbidden_input: "A reviewer packet takes only the role, the design, the requirements, the request and the section 8 sources.",
  invalid_input: "The reviewer packet input is not valid.",
  design_digest_mismatch: "The design is not the one that was approved for review.",
  requirements_digest_mismatch: "The requirements are not the ones that were approved.",
  packet_too_large: "The role prompt, the design and the requirements are too large for one reviewer packet.",
};
/** A packet that cannot be built. The message is fixed text; nothing from the input is echoed. */
export class PacketBuildError extends Error {
  constructor(readonly code: PacketBuildFailure) { super(BUILD_MESSAGES[code]); this.name = "PacketBuildError"; }
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

/** A ref is shown inside an attribute of the data frame, so it is plain text with none of the characters that could close the frame. */
const PlainRef = z.string().min(1).max(500).refine((value) => !/[\p{Cc}\p{Cf}"<>\\]/u.test(value), "must be a plain reference");
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Sha1 = z.string().regex(/^[a-f0-9]{40}$/);
const Artifact = z.object({
  ref: PlainRef.refine((value) => value.length <= 200),
  /** The artifact's version label (its round, or a short digest); recorded where an item has no commit. */
  revision: z.string().min(1).max(64).refine((value) => !/[\p{Cc}\p{Cf}"<>\\]/u.test(value)),
  text: z.string().min(1),
  /** The digest the broker recorded when the artifact was stored; when given, the text must hash to it. */
  expectedDigest: Digest.optional(),
}).strict();

/**
 * What section 8 may name. An MCP item is named by its source and its ref ONLY: the tool and the arguments that fetch it are never in the input (a design can name an item, not choose the call),
 * they are derived by code from the project's configured read-only sources (mcp-allowlist.ts) inside the MCP reader.
 */
const SourceRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repo_file"), repo: z.string().min(1).max(200), path: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("meta_repo_file"), path: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("mcp_item"), sourceId: z.string().min(1).max(64), itemRef: z.string().min(1).max(200) }).strict(),
]);
export type DesignSourceRef = z.infer<typeof SourceRef>;

/**
 * The only things a packet is built from. `.strict()`: a transcript, a thread, messages, or a role prompt passed along are refused. The role prompt is not an input: the builder takes it from the
 * registry by role and tier (`reviewerPromptFor`), so a caller cannot hand a role another role's prompt or any other text.
 */
export const PacketBuildInputSchema = z.object({
  role: ReviewerRoleSchema,
  /** Only picks between registered prompts (the Light tier's Critic also asks for the paraphrase). It is not text: `reviewerPromptFor(role, tier)` is the only place a prompt is chosen. */
  tier: DesignReviewTierSchema.optional(),
  design: Artifact,
  requirements: Artifact,
  /** The task's request, as the person wrote it. Used for the comprehension reviewer only; ignored for every other role. */
  requestText: z.string().max(200_000).optional(),
  /** The pinned base commit of each repository the design may read, by the name section 8 uses. A repository with no pin is not read. */
  baseCommits: z.record(z.string().min(1).max(200), Sha1),
  knowledgeCommit: Sha1.optional(),
  sources: z.array(SourceRef).max(PACKET_SOURCES_LOOKED_AT_MAX),
  /** The task's own request thread (the Linear, Jira or GitHub issue it came from). An item that is it, or continues it (its comments), is never put in a packet (M6). An `itemRef` of "" names the whole source: the task does not record which item it came from, so every item of that tracker is withheld. */
  origin: z.array(z.object({ sourceId: z.string().min(1).max(64), itemRef: z.string().max(200) }).strict()).max(20).optional(),
}).strict();
export type PacketBuildInput = z.input<typeof PacketBuildInputSchema>;

/** What the broker reads for a packet. Each is an existing reader behind a small port (the wiring is listed in report.md). A throw or an `undefined` leaves the source out. */
export interface PacketReaders {
  /** A repository file at the pinned commit (`getFileAtCommit` of the code host); `undefined` when the file is not there. */
  readRepoFile(input: { repo: string; path: string; commit: string; maxBytes: number }): Promise<string | undefined>;
  /** A meta repository file at `knowledgeCommit` (the same reader, pointed at the project's meta repository). */
  readMetaFile(input: { path: string; commit: string; maxBytes: number }): Promise<string | undefined>;
  /** An MCP item fetched again through the context-tools route under the PLAN_CRITIQUE stage permission (see `mcpItemReaderOf`). */
  fetchMcpItem(input: { sourceId: string; itemRef: string }): Promise<{ ok: true; text: string; fetchedAt: string } | { ok: false; reason?: PacketMcpRefusal }>;
}

export interface BuiltPacket extends PacketDelivery {
  rolePrompt: { id: string; version: number; digest: string; text: string };
  packetDigest: string;
  /** What `ReviewerRun.packet` records: one entry per document, in the same order. */
  items: ReviewerPacketItem[];
  /** Sources section 8 named that are not in the packet, each with a fixed reason. The card says so. */
  omitted: Array<{ kind: PacketItemKind; ref: string; reason: PacketOmittedReason }>;
  /** Bytes of everything the first request carries. */
  totalBytes: number;
  /** What the broker expects the first model call to read; the proxy's count is held to this within 10% (verify.ts). */
  estimatedInputTokens: number;
}

/** What the broker expects the first call to cost in input tokens: the bytes of the first request, divided by BYTES_PER_TOKEN, plus the fixed overhead. */
export function estimateInputTokens(totalBytes: number, options: { bytesPerToken?: number; overheadTokens?: number } = {}): number {
  return Math.ceil(totalBytes / (options.bytesPerToken ?? BYTES_PER_TOKEN)) + (options.overheadTokens ?? FIRST_CALL_OVERHEAD_TOKENS + ANSWER_TOOL_OVERHEAD_TOKENS);
}

function cutToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  return `${Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "")}\n[cut]`;
}

/** The path rules of the code host's reader (`getFileAtCommit`): relative, no empty, dot or dot-dot segment, no backslash. */
function plainPath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path.includes("\\") || /[\p{Cc}\p{Cf}"<>]/u.test(path)) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

export interface BuildPacketOptions {
  bytesPerToken?: number;
  overheadTokens?: number;
  /** One reader call may take this long (default READER_TIMEOUT_MS). */
  readerTimeoutMs?: number;
  /** The whole build reads for at most this long (default BUILD_DEADLINE_MS). */
  deadlineMs?: number;
  now?: () => number;
}

/** A reader call that stops waiting after `ms`. A throw, a rejection and a timeout are all "no answer"; what was thrown is never kept. */
function withTimeout<T>(call: () => Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false }), Math.max(1, ms));
    Promise.resolve().then(call).then(
      (value) => { clearTimeout(timer); resolve({ ok: true, value }); },
      () => { clearTimeout(timer); resolve({ ok: false }); },
    );
  });
}

/** What a fetch time or any other attribute shown in a frame may be made of. */
const PLAIN_ATTRIBUTE = /^[^\p{Cc}\p{Cf}"<>\\]{1,64}$/u;

/**
 * Builds one reviewer's packet. Refuses (PacketBuildError) when the input has a field outside the closed set, when the design or the requirements do not hash to the recorded digest,
 * or when the role prompt, design and requirements alone do not fit. Sources are looked at in the order section 8 gives them; one that cannot be used is listed in `omitted`.
 */
export async function buildReviewerPacket(rawInput: unknown, readers: PacketReaders, options: BuildPacketOptions = {}): Promise<BuiltPacket> {
  const parsed = PacketBuildInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new PacketBuildError(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys") ? "forbidden_input" : "invalid_input");
  }
  const input = parsed.data;
  if (input.design.expectedDigest !== undefined && sha256(input.design.text) !== input.design.expectedDigest) throw new PacketBuildError("design_digest_mismatch");
  if (input.requirements.expectedDigest !== undefined && sha256(input.requirements.text) !== input.requirements.expectedDigest) throw new PacketBuildError("requirements_digest_mismatch");
  // The role decides the prompt. Nothing the caller sends can change its text, and its digest is the one the run record carries.
  const prompt = reviewerPromptFor(input.role, input.tier);

  const documents: PacketDocument[] = [
    { kind: "design", ref: input.design.ref, commitOrFetchedAt: input.design.revision, text: input.design.text },
    { kind: "requirements", ref: input.requirements.ref, commitOrFetchedAt: input.requirements.revision, text: input.requirements.text },
  ];
  const request = input.role === "comprehension" && input.requestText !== undefined && input.requestText.trim() !== "" ? cutToBytes(input.requestText, REQUEST_TEXT_MAX_BYTES) : undefined;
  const fixedBytes = byteLength(prompt.text) + (request === undefined ? 0 : byteLength(renderPacketRequest(request))) + documents.reduce((sum, document) => sum + byteLength(renderPacketDocument(document)), 0);
  if (fixedBytes > PACKET_BYTES_MAX) throw new PacketBuildError("packet_too_large");

  let totalBytes = fixedBytes;
  const omitted: BuiltPacket["omitted"] = [];
  // A ref names one item. Two sources with the same ref (even of different kinds, or `repo` + `path` that spell the same text) would make a citation ambiguous, so the second is left out.
  const seen = new Set<string>(documents.map((document) => document.ref));
  const leave = (kind: PacketItemKind, ref: string, reason: PacketOmittedReason): void => { omitted.push({ kind, ref: ref.replace(/[\p{Cc}\p{Cf}"<>\\]/gu, "?").slice(0, 500), reason }); };
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? BUILD_DEADLINE_MS);
  const readerTimeout = options.readerTimeoutMs ?? READER_TIMEOUT_MS;

  for (const source of input.sources) {
    const ref = source.kind === "repo_file" ? `${source.repo}:${source.path}` : source.kind === "meta_repo_file" ? `meta:${source.path}` : `${source.sourceId}:${source.itemRef}`;
    // A repository name with a colon would make `a:b` + `c` and `a` + `b:c` the same ref.
    if (!PlainRef.safeParse(ref).success || (source.kind !== "mcp_item" && !plainPath(source.path)) || (source.kind === "repo_file" && source.repo.includes(":"))) { leave(source.kind, ref, "invalid_ref"); continue; }
    if (source.kind === "mcp_item" && isOriginItem(input.origin, source)) { leave(source.kind, ref, "conversation"); continue; }
    if (seen.has(ref)) { leave(source.kind, ref, "duplicate"); continue; }
    seen.add(ref);
    if (documents.length >= DESIGN_REVIEW_PACKET_ITEMS_MAX) { leave(source.kind, ref, "item_cap"); continue; }
    const room = PACKET_BYTES_MAX - totalBytes;
    if (room <= 0) { leave(source.kind, ref, "byte_cap"); continue; }
    const remaining = deadline - now();
    // Past the deadline nothing more is read: the rest is left out with the same fixed reason a hung reader gets.
    if (remaining <= 0) { leave(source.kind, ref, "unavailable"); continue; }
    const timeout = Math.min(readerTimeout, remaining);

    let document: PacketDocument | undefined;
    if (source.kind === "repo_file") {
      const commit = input.baseCommits[source.repo];
      if (commit === undefined) { leave(source.kind, ref, "unpinned_repo"); continue; }
      const answer = await withTimeout(() => readers.readRepoFile({ repo: source.repo, path: source.path, commit, maxBytes: room }), timeout);
      // The reason is fixed. What the reader threw is not kept: it can hold a path, a host or a token.
      if (!answer.ok) { leave(source.kind, ref, "unavailable"); continue; }
      if (typeof answer.value !== "string") { leave(source.kind, ref, "not_found"); continue; }
      document = { kind: "repo_file", ref, commitOrFetchedAt: commit, text: answer.value };
    } else if (source.kind === "meta_repo_file") {
      if (input.knowledgeCommit === undefined) { leave(source.kind, ref, "no_knowledge_commit"); continue; }
      const commit = input.knowledgeCommit;
      const answer = await withTimeout(() => readers.readMetaFile({ path: source.path, commit, maxBytes: room }), timeout);
      if (!answer.ok) { leave(source.kind, ref, "unavailable"); continue; }
      if (typeof answer.value !== "string") { leave(source.kind, ref, "not_found"); continue; }
      document = { kind: "meta_repo_file", ref, commitOrFetchedAt: commit, text: answer.value };
    } else {
      const answer = await withTimeout(() => readers.fetchMcpItem({ sourceId: source.sourceId, itemRef: source.itemRef }), timeout);
      if (!answer.ok) { leave(source.kind, ref, "unavailable"); continue; }
      const fetched = answer.value;
      if (!fetched.ok) { leave(source.kind, ref, fetched.reason === "not_allowed" || fetched.reason === "conversation" ? fetched.reason : "unavailable"); continue; }
      if (typeof fetched.text !== "string" || fetched.text.trim() === "" || typeof fetched.fetchedAt !== "string" || !PLAIN_ATTRIBUTE.test(fetched.fetchedAt)) { leave(source.kind, ref, "unavailable"); continue; }
      document = { kind: "mcp_item", ref, commitOrFetchedAt: fetched.fetchedAt, text: fetched.text };
    }
    if (document.text.includes("\u0000")) { leave(source.kind, ref, "not_text"); continue; }
    const bytes = byteLength(renderPacketDocument(document));
    if (bytes > room || itemOf(document).bytes > 5_000_000) { leave(source.kind, ref, "byte_cap"); continue; }
    documents.push(document);
    totalBytes += bytes;
  }

  const delivery: PacketDelivery = { role: input.role, rolePrompt: { id: prompt.id, version: prompt.version, text: prompt.text }, documents, request };
  const items = documents.map((document) => ReviewerPacketItemSchema.parse(itemOf(document)));
  return {
    role: input.role,
    rolePrompt: { id: prompt.id, version: prompt.version, digest: promptDigest(prompt), text: prompt.text },
    documents,
    ...(request === undefined ? {} : { request }),
    packetDigest: packetDigestOf(delivery),
    items,
    omitted,
    totalBytes,
    estimatedInputTokens: estimateInputTokens(totalBytes, options),
  };
}

/**
 * The MCP reader over the existing context-tools route: `call` is `callContextTool(deps, run, request)` with `run.operation.workflowMode` set to "PLAN_CRITIQUE", so every
 * check the route makes (stage permission, the tool still being the ticked read-only tool, argument rules, the stage's allowance) applies unchanged. The answer is already framed as untrusted data.
 * The tool and the arguments are NOT taken from the design: `packetMcpCall` derives them from `sources`, the project's configured read-only context sources, and refuses a chat or conversation
 * source or tool (M6). A refused item comes back as `{ ok: false, reason }` and is listed as omitted.
 */
export function mcpItemReaderOf(
  call: (request: { requestId: string; tool: string; arguments: Record<string, unknown> }) => Promise<ContextToolCallResponse>,
  options: { sources: readonly ContextSource[]; now: () => number; newRequestId: () => string } & PacketMcpOptions,
): PacketReaders["fetchMcpItem"] {
  return async (input) => {
    const planned = packetMcpCall(options.sources, input, { ...(options.argumentsFor === undefined ? {} : { argumentsFor: options.argumentsFor }), ...(options.origin === undefined ? {} : { origin: options.origin }) });
    if (!planned.ok) return { ok: false, reason: planned.reason };
    const answer = await call({ requestId: options.newRequestId(), tool: planned.tool, arguments: planned.arguments });
    if (answer.status !== "OK") return { ok: false };
    return { ok: true, text: answer.text, fetchedAt: answer.citations?.[0]?.fetchedAt ?? new Date(options.now()).toISOString() };
  };
}
