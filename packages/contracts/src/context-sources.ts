// MCP context sources (design meta-repo-mcp.md section 3.6, lane E, task E1): the read-only systems a project may let Rovara consult while it
// understands, plans, checks a plan and reviews. The shapes here are shared by the broker (which holds the settings and makes every call), the worker
// (which only presents the tools and frames the answers) and the UI.
//
// Rules that live in these types, so no caller can forget them:
//   - Only four stages are named. IMPLEMENT (Build) is not in the list, so a source that names it does not parse (CONTEXT decision 6, Q7).
//   - A source never holds a secret: it points at an org connection or at an approved MCP server entry.
//   - Everything a source returns is data. The answer carries `untrusted: true` and Rovara's framing says so (section 3.6, injection safety).
import { z } from "zod";
import { ConnectionIdSchema } from "./agent-node.js";
import { McpToolNameSchema } from "./github-mcp.js";
import type { WorkflowReviewFinding } from "./task-workflow.js";

/** The stages that may consult a source. Build (IMPLEMENT) is deliberately absent. */
export const CONTEXT_SOURCE_STAGES = ["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "REVIEW"] as const;
export const ContextSourceStageSchema = z.enum(CONTEXT_SOURCE_STAGES);
export type ContextSourceStage = z.infer<typeof ContextSourceStageSchema>;

/** Whether a worker mode (or workflow mode) may use context sources. Anything else, IMPLEMENT included, may not. */
export function isContextSourceStage(mode: unknown): mode is ContextSourceStage {
  return typeof mode === "string" && (CONTEXT_SOURCE_STAGES as readonly string[]).includes(mode);
}

/** A short lower-case name that is safe inside a tool name (`src_<id>_<tool>`); it has no underscore, so the split is unambiguous. */
export const ContextSourceIdSchema = z.string().regex(/^[a-z][a-z0-9]{1,15}$/, "source id: 2 to 16 lower-case letters and digits, starting with a letter");

export const CONTEXT_SOURCE_LIMITS = { sourcesPerProject: 16, toolsPerSource: 16, callsPerStage: 25, bytesPerResult: 16 * 1_024, bytesPerStage: 192 * 1_024, argumentBytes: 1_024 } as const;

export const ContextToolRoleSchema = z.enum(["search", "read", "status"]);
export type ContextToolRole = z.infer<typeof ContextToolRoleSchema>;

/**
 * One tool an admin ticked. `schemaHash` is the hash of the tool's name, input schema and annotations when it was ticked: a source tool that changes
 * is disabled until an admin ticks it again. `attestedReadOnly` is set only when a tool had no read-only annotation and a second admin confirmed it.
 */
export const ContextSourceToolSchema = z.object({
  upstreamName: McpToolNameSchema,
  role: ContextToolRoleSchema,
  schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
  attestedReadOnly: z.boolean().optional(),
}).strict();
export type ContextSourceTool = z.infer<typeof ContextSourceToolSchema>;

/** Who may see quoted content. `citations_only` shows the title, the link and Rovara's one-line summary to everyone and the quote to nobody. */
export const QuoteVisibilitySchema = z.enum(["source_acl", "project_members", "citations_only"]);
export type QuoteVisibility = z.infer<typeof QuoteVisibilitySchema>;

export const SourceRetentionSchema = z.enum(["live_only", "team_record"]);
export type SourceRetention = z.infer<typeof SourceRetentionSchema>;

/**
 * Where a source's tools come from: an org connection (`access` must be `read`), or an MCP server an admin approved in the server registry (a private HTTP
 * endpoint on the install allow-list, or a stdio server run by the MCP host). Neither holds a secret here.
 */
export const ContextSourceServerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("connection"), connectionId: ConnectionIdSchema }).strict(),
  z.object({ kind: z.literal("registered_server"), serverId: z.string().regex(/^mcp[a-z0-9]{6,24}$/) }).strict(),
]);
export type ContextSourceServer = z.infer<typeof ContextSourceServerSchema>;

const OneLine = z.string().min(1).max(60).refine((value) => ![...value].some((char) => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f), "must be one line");

export const ContextSourceSchema = z.object({
  sourceId: ContextSourceIdSchema,
  label: OneLine,
  /** The kind of system, when Rovara has rules for it (`slack`: text is processed and dropped, never quoted). Free text is not accepted. */
  system: z.string().regex(/^[a-z][a-z0-9_]{1,23}$/).optional(),
  server: ContextSourceServerSchema,
  tools: z.array(ContextSourceToolSchema).min(1).max(CONTEXT_SOURCE_LIMITS.toolsPerSource)
    .refine((tools) => new Set(tools.map((tool) => tool.upstreamName)).size === tools.length, "a tool is ticked once"),
  stages: z.array(ContextSourceStageSchema).min(1).max(CONTEXT_SOURCE_STAGES.length)
    .refine((stages) => new Set(stages).size === stages.length, "a stage is listed once"),
  quotes: QuoteVisibilitySchema,
  retention: SourceRetentionSchema,
  limits: z.object({
    callsPerStage: z.int().min(1).max(CONTEXT_SOURCE_LIMITS.callsPerStage),
    bytesPerResult: z.int().min(256).max(CONTEXT_SOURCE_LIMITS.bytesPerResult),
    bytesPerStage: z.int().min(1_024).max(CONTEXT_SOURCE_LIMITS.bytesPerStage),
  }).strict(),
  /** Fields always fetched fresh when shown and never stored (for example status, assignee, priority). */
  liveFacts: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,39}$/)).max(16),
  /** Whether a query to this source may carry code. Off unless an admin turns it on. */
  sendCodeSnippets: z.boolean(),
}).strict();
export type ContextSource = z.infer<typeof ContextSourceSchema>;

/** The project's list of sources, kept with a revision so a stale write is refused. */
export const ContextSourcesDocumentSchema = z.object({
  revision: z.int().min(0),
  sources: z.array(ContextSourceSchema).max(CONTEXT_SOURCE_LIMITS.sourcesPerProject)
    .refine((sources) => new Set(sources.map((source) => source.sourceId)).size === sources.length, "source ids are unique")
    .refine((sources) => new Set(sources.map((source) => source.label.toLowerCase())).size === sources.length, "source labels are unique"),
}).strict();
export type ContextSourcesDocument = z.infer<typeof ContextSourcesDocumentSchema>;

// ---------------------------------------------------------------------------------------------
// The worker's tool list and call (the broker route `/v1/internal/context-tools`)
// ---------------------------------------------------------------------------------------------

/** The name of the tool that asks every allowed `search` tool and the Team record at once. */
export const SEARCH_TEAM_KNOWLEDGE_TOOL = "search_team_knowledge";

export const ContextToolPresentationSchema = z.object({
  /** `src_<sourceId>_<tool>`, at most 64 characters (the provider limit). */
  name: z.string().regex(/^src_[a-z][a-z0-9]{1,15}_[A-Za-z0-9_-]{1,50}$/).max(64),
  sourceId: ContextSourceIdSchema,
  upstreamName: McpToolNameSchema,
  role: ContextToolRoleSchema,
  description: z.string().max(1_000),
  inputSchema: z.record(z.string(), z.unknown()),
}).strict();
export type ContextToolPresentation = z.infer<typeof ContextToolPresentationSchema>;

export const ContextToolCatalogSchema = z.object({
  sources: z.array(z.object({ sourceId: ContextSourceIdSchema, label: OneLine, quotes: QuoteVisibilitySchema }).strict()).max(CONTEXT_SOURCE_LIMITS.sourcesPerProject),
  tools: z.array(ContextToolPresentationSchema).max(CONTEXT_SOURCE_LIMITS.sourcesPerProject * CONTEXT_SOURCE_LIMITS.toolsPerSource),
  /** `search_team_knowledge` is offered when the stage has a `search` tool or the Team record can answer. */
  searchTeamKnowledge: z.boolean(),
  /** Sources that could not be reached when the list was made: the plan says "<label> was not reachable". */
  unavailable: z.array(ContextSourceIdSchema).max(CONTEXT_SOURCE_LIMITS.sourcesPerProject),
  /** Ticked tools that are off until an admin ticks them again (their schema or annotations changed, or they no longer read only). */
  disabled: z.array(z.object({ sourceId: ContextSourceIdSchema, tool: McpToolNameSchema }).strict()).max(CONTEXT_SOURCE_LIMITS.sourcesPerProject * CONTEXT_SOURCE_LIMITS.toolsPerSource),
}).strict();
export type ContextToolCatalog = z.infer<typeof ContextToolCatalogSchema>;

export const ContextToolCallRequestSchema = z.object({
  requestId: z.string().uuid(),
  /** The presented name (`src_…`) or `search_team_knowledge`. */
  tool: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()),
}).strict();
export type ContextToolCallRequest = z.infer<typeof ContextToolCallRequestSchema>;

export const CitationStandingSchema = z.enum(["member", "outsider", "bot"]);
export type CitationStanding = z.infer<typeof CitationStandingSchema>;

/** A source item a stage used. It holds no quote: the text lives only in the short-lived blob store. */
export const CitationSchema = z.object({
  sourceId: ContextSourceIdSchema,
  itemRef: z.string().min(1).max(200),
  title: z.string().max(200),
  url: z.string().max(500).optional(),
  fetchedAt: z.string().max(40),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  standing: CitationStandingSchema,
}).strict();
export type Citation = z.infer<typeof CitationSchema>;

export const ContextToolCallResponseSchema = z.object({
  status: z.enum(["OK", "UNAVAILABLE", "REFUSED"]),
  /** What the model reads. For `OK` it is the framed result; otherwise a short fixed sentence. */
  text: z.string().max(200_000),
  citations: z.array(CitationSchema).max(50).optional(),
  truncated: z.boolean().optional(),
}).strict();
export type ContextToolCallResponse = z.infer<typeof ContextToolCallResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Edition defaults (design 3.6 "Defaults")
// ---------------------------------------------------------------------------------------------

/** Systems whose terms forbid keeping or showing their text (Slack's API terms, CONTEXT decision 4). */
export const QUOTE_FORBIDDEN_SYSTEMS: readonly string[] = ["slack"];

export function isQuoteForbiddenSystem(system: string | undefined): boolean {
  return system !== undefined && QUOTE_FORBIDDEN_SYSTEMS.includes(system);
}

/** Company-run installs: `citations_only` until a per-user check exists for the source. Hosted: `project_members`. Slack: always `citations_only`. */
export function defaultQuoteVisibility(edition: "enterprise" | "public", system?: string): QuoteVisibility {
  if (isQuoteForbiddenSystem(system)) return "citations_only";
  return edition === "enterprise" ? "citations_only" : "project_members";
}

/** The retention a source starts with. Slack is always `live_only`; everything else follows the Team record's per-source setting. */
export function defaultSourceRetention(system?: string): SourceRetention {
  return isQuoteForbiddenSystem(system) ? "live_only" : "team_record";
}

export const DEFAULT_CONTEXT_SOURCE_LIMITS = { callsPerStage: 25, bytesPerResult: 16 * 1_024, bytesPerStage: 192 * 1_024 } as const;

// ---------------------------------------------------------------------------------------------
// Hidden characters
// ---------------------------------------------------------------------------------------------

/**
 * Format, control, private-use, unassigned, surrogate and default-ignorable characters, which can hide instructions from the person who reads a result
 * (the same set as the worker's rule-file reader, `worker/src/context-text.ts`).
 */
const HIDDEN_CHARACTERS = /[\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/** `text` without hidden characters (newline and tab stay), CRLF folded to a newline, and how many were removed. */
export function stripHiddenCharacters(text: string): { text: string; removed: number } {
  let removed = 0;
  const cleaned = (text.startsWith("﻿") ? text.slice(1) : text).replace(/\r\n?/gu, "\n").replace(HIDDEN_CHARACTERS, (character) => {
    if (character === "\n" || character === "\t") return character;
    removed += 1;
    return "";
  });
  return { text: cleaned, removed };
}

// ---------------------------------------------------------------------------------------------
// Citation markers and the review rule
// ---------------------------------------------------------------------------------------------

/** `[Tracker ABC-123]`: a source's label, a space, and the item's reference. The label may have spaces (`[Team wiki PAGE-12]` reads the last word as the reference). */
export const CITATION_MARKER = /\[([^\][\n]{1,60}?) ([^\][\s]{1,80})\]/gu;

export const SOURCE_ONLY_NOTE = " (cites a source only, with no code or test, so it does not block)";

/**
 * A review finding that cites a source (`[Tracker ABC-123]`) must also point at code or a test (`file`). One that does not is kept but made advisory, so it is read and
 * cannot block the change. Only the finding's own words are changed; its citation stays. A review's approval is never derived from a source: nothing here turns a
 * finding into a pass, and nothing turns a pass into one because a source said so.
 */
export function downgradeSourceOnlyFindings(findings: readonly WorkflowReviewFinding[], sources: readonly { label: string }[]): WorkflowReviewFinding[] {
  const labels = new Set(sources.map((source) => source.label.toLowerCase()));
  return findings.map((finding) => {
    if (finding.file !== undefined || finding.advisory === true) return finding;
    const cites = [...finding.text.matchAll(CITATION_MARKER)].some((match) => labels.has(match[1]!.toLowerCase()));
    if (!cites) return finding;
    return { ...finding, advisory: true, text: `${finding.text.slice(0, 600 - SOURCE_ONLY_NOTE.length)}${SOURCE_ONLY_NOTE}` };
  });
}
