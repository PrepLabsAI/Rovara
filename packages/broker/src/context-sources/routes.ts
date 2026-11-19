// E2: the two internal routes through which a running Understand, Plan, Plan-check or Review stage consults the project's context sources:
//
//   GET  /v1/internal/context-tools        the tools the stage may use, as the model sees them
//   POST /v1/internal/context-tools/call   one call: `{ requestId, tool, arguments }`
//
// The broker authorizes the request with the operation's own `context-tools` capability and finds the run it belongs to (`local/app/context-tools.ts` on a laptop);
// everything after that is here. A call goes through, in order: the stage is one that may use sources (never Build); the task's person still has authority on the project (where the install has such a rule); the tool is one an admin ticked for this stage; the stage's allowance is not used up; the tool is still the tool
// that was ticked (its hash) and still only reads (the write gate); the arguments are small, on-host and carry neither code nor a credential; and the call
// has a time limit. What comes back is cleaned, cut, framed as data and recorded as a citation. Nothing the model supplies decides any of it.
import {
  ContextToolCallRequestSchema,
  SEARCH_TEAM_KNOWLEDGE_TOOL,
  agentXError,
  isContextSourceStage,
  type Citation,
  type CitationStanding,
  type ContextSource,
  type ContextSourceServer,
  type ContextSourcesDocument,
  type ContextToolCallResponse,
  type ContextToolCatalog,
  type ContextToolPresentation,
  type OrgId,
} from "@agentx/contracts";
import { ARGUMENT_REFUSAL_TEXT, checkArguments, contextWriteGate } from "./guards.js";
import { UNAVAILABLE_TEXT, frameResult, inertSentence, presentTool, presentedToolName, resolvePresentedTool, resultDigest } from "./present.js";
import { toolSchemaHash, annotationVerdict, nameSuggestsWrite, type DiscoveredTool } from "./settings.js";
import { TEAM_SEARCH_LIMIT_MAX, withoutLiveFacts, type TeamRecordSearch, type TeamRecordSink } from "./team-record.js";
import type { UsageStore } from "./usage.js";

/** A connection to one source's server. It is closed after the list or the call. */
export interface ContextServerSession {
  /** The hosts that are the source's own (an address argument must be on one of them). */
  hosts: readonly string[];
  tools: readonly DiscoveredTool[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ isError?: boolean | undefined; content?: Array<{ type: string; text?: string | undefined }> | undefined; structuredContent?: unknown }>;
  close(): Promise<void>;
}

export interface ContextServerPort {
  /**
   * Connects to the source's server (an org connection, or an approved registered server). `tools` are the names the project ticked: the connection discovers those and
   * no others. It throws when the server cannot be reached.
   */
  open(orgId: OrgId, server: ContextSourceServer, signal: AbortSignal, tools: readonly string[]): Promise<ContextServerSession>;
  /** Every tool the server lists, for the settings page that shows what to tick. */
  listAll?(orgId: OrgId, server: ContextSourceServer, signal: AbortSignal): Promise<DiscoveredTool[]>;
}

/** Where a result's text is kept for the task's lifetime so that people allowed to see it can (quotes.ts). */
export interface ResultKeeper {
  keep(input: { orgId: OrgId; taskId: string; operationId: string; sourceId: string; itemRef: string; digest: string; text: string; retention: ContextSource["retention"]; quotes: ContextSource["quotes"]; system?: string | undefined; fetchedAt: string }): Promise<void>;
}

export interface CitationRecorder {
  /** `replay` is the call that fetched the item (the presented name and the arguments), kept server-side so that a plan check and the page can ask for it again. */
  record(input: { orgId: OrgId; taskId: string; operationId: string; stage: string; citation: Citation; replay: { tool: string; arguments: Record<string, unknown> } }): Promise<void>;
}

/** The task a stage belongs to, as the route sees it: its id and its project. */
export interface ContextToolsTask {
  taskId: string;
  project: string;
}

/** The task's operation as the route sees it. */
export interface ContextToolsRun {
  orgId: OrgId;
  task: ContextToolsTask;
  operation: { id: string; workflowMode?: string | undefined };
}

export interface ContextToolsDependencies {
  now: () => number;
  /**
   * Refuses (by throwing) when the person the task belongs to may no longer use it: the hosted product ends the task when its creator has left the company or lost authority on the project.
   * Read on every request. REQUIRED, so that a host that forgets it does not compile and does not start: an install with one owner says so with an explicit no-op.
   */
  requireAuthority(run: ContextToolsRun): Promise<void>;
  /** The project's sources, read now. */
  sources(orgId: OrgId, project: string): Promise<ContextSourcesDocument>;
  servers: ContextServerPort;
  usage: UsageStore;
  teamSink: TeamRecordSink;
  teamSearch: TeamRecordSearch;
  /** Whether the Team record can answer a search (false while it is the empty stand-in), so `search_team_knowledge` is offered only when it can do something. */
  teamRecordAvailable?: boolean | undefined;
  citations?: CitationRecorder | undefined;
  results?: ResultKeeper | undefined;
  /** Who wrote the item: a connector that can tell says so. Without one every item is an outsider's, the safest reading. */
  standingOf?: ((source: ContextSource, structured: unknown) => CitationStanding) | undefined;
  /** A line for the operator's log. Never given a result's text or an argument. */
  log?: ((event: string, fields: Record<string, string | number>) => void) | undefined;
  callTimeoutMs?: number | undefined;
}

export const CONTEXT_CALL_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 10_000;

const refused = (text: string): ContextToolCallResponse => ({ status: "REFUSED", text });
const unavailable = (label: string): ContextToolCallResponse => ({ status: "UNAVAILABLE", text: UNAVAILABLE_TEXT(label) });

/** The sources that may be used in this operation's stage; none for any other stage, Build included. */
async function stageSources(deps: ContextToolsDependencies, run: ContextToolsRun): Promise<ContextSource[]> {
  const mode = run.operation.workflowMode;
  if (!isContextSourceStage(mode)) return [];
  // The task's person and their authority are checked on every request, as the agent-tool routes do.
  await deps.requireAuthority(run);
  const document = await deps.sources(run.orgId, run.task.project);
  return document.sources.filter((source) => source.stages.includes(mode));
}

const withTimeout = (ms: number): AbortSignal => AbortSignal.timeout(ms);

/** Whether the ticked tool is still the tool that was ticked, and still reads only. */
function toolStatus(ticked: ContextSource["tools"][number], discovered: DiscoveredTool | undefined): "ok" | "changed" | "unsafe" {
  if (discovered === undefined || toolSchemaHash(discovered) !== ticked.schemaHash) return "changed";
  const verdict = annotationVerdict(discovered);
  if (verdict === "unsafe") return "unsafe";
  if ((verdict === "unannotated" || nameSuggestsWrite(discovered.name)) && ticked.attestedReadOnly !== true) return "unsafe";
  return "ok";
}

// ---------------------------------------------------------------------------------------------
// GET /v1/internal/context-tools
// ---------------------------------------------------------------------------------------------

export async function listContextTools(deps: ContextToolsDependencies, run: ContextToolsRun): Promise<ContextToolCatalog> {
  const sources = await stageSources(deps, run);
  const catalog: ContextToolCatalog = { sources: [], tools: [], searchTeamKnowledge: false, unavailable: [], disabled: [] };
  if (sources.length === 0) return catalog;
  const perSource = await Promise.all(sources.map(async (source) => {
    let session: ContextServerSession | undefined;
    try {
      session = await deps.servers.open(run.orgId, source.server, withTimeout(deps.callTimeoutMs ?? LIST_TIMEOUT_MS), source.tools.map((tool) => tool.upstreamName));
      const byName = new Map(session.tools.map((tool) => [tool.name, tool]));
      const presented: ContextToolPresentation[] = [];
      const disabled: ContextToolCatalog["disabled"] = [];
      for (const ticked of source.tools) {
        const discovered = byName.get(ticked.upstreamName);
        const status = toolStatus(ticked, discovered);
        const shown = status === "ok" && discovered !== undefined ? presentTool(source, ticked, discovered) : undefined;
        if (shown === undefined) disabled.push({ sourceId: source.sourceId, tool: ticked.upstreamName });
        else presented.push(shown);
      }
      return { source, presented, disabled, reachable: true };
    } catch {
      return { source, presented: [] as ContextToolPresentation[], disabled: [] as ContextToolCatalog["disabled"], reachable: false };
    } finally {
      await session?.close().catch(() => undefined);
    }
  }));
  for (const entry of perSource) {
    catalog.sources.push({ sourceId: entry.source.sourceId, label: entry.source.label, quotes: entry.source.quotes });
    if (!entry.reachable) catalog.unavailable.push(entry.source.sourceId);
    catalog.tools.push(...entry.presented);
    catalog.disabled.push(...entry.disabled);
  }
  catalog.searchTeamKnowledge = deps.teamRecordAvailable === true || catalog.tools.some((tool) => tool.role === "search");
  return catalog;
}

// ---------------------------------------------------------------------------------------------
// POST /v1/internal/context-tools/call
// ---------------------------------------------------------------------------------------------

/** The argument of a search tool that takes the words to look for, from its schema: a conventional name, else the only required text argument. */
export function searchArgumentName(schema: Record<string, unknown>): string | undefined {
  const properties = typeof schema.properties === "object" && schema.properties !== null ? schema.properties as Record<string, unknown> : {};
  for (const name of ["query", "q", "text", "search", "keywords", "keyword", "term", "terms"]) if (Object.hasOwn(properties, name)) return name;
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  const text = required.filter((name) => (properties[name] as { type?: unknown } | undefined)?.type === "string");
  return text.length === 1 ? text[0] : undefined;
}

function textOf(result: { content?: Array<{ type: string; text?: string | undefined }> | undefined }): string {
  return (result.content ?? []).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text!).join("\n");
}

function firstRecord(structured: unknown): Record<string, unknown> | undefined {
  const value: unknown = Array.isArray(structured) ? (structured as unknown[])[0] : structured;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown> | undefined, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = record?.[name];
    if (typeof value === "string" && value.trim() !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

/** A link is kept only when it is https, has no login and is on the source's own host. */
function safeUrl(value: string | undefined, hosts: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || !hosts.map((host) => host.toLowerCase()).includes(url.hostname.toLowerCase())) return undefined;
    return url.href.slice(0, 500);
  } catch {
    return undefined;
  }
}

async function callOne(deps: ContextToolsDependencies, run: ContextToolsRun, sources: readonly ContextSource[], presented: string, args: unknown): Promise<ContextToolCallResponse> {
  const resolved = resolvePresentedTool(sources, presented);
  if (resolved === undefined) return refused("That source tool is not available in this stage.");
  const { source, tool: ticked } = resolved;
  const orgId = run.orgId;
  const operationId = run.operation.id;
  const stage = run.operation.workflowMode!;

  const reservation = await deps.usage.reserveCall({ orgId, operationId, sourceId: source.sourceId, callsPerStage: source.limits.callsPerStage });
  if (!reservation.ok) {
    return refused(reservation.reason === "failures"
      ? `${source.label} failed several times in this stage, so Rovara stopped asking it. Carry on without it.`
      : `This stage has used its allowance of calls to ${reservation.reason === "total" ? "all its sources" : source.label}. Carry on with what you have.`);
  }
  const used = await deps.usage.bytesUsed({ orgId, operationId, sourceId: source.sourceId });
  const room = source.limits.bytesPerStage - used;
  if (room <= 0) return refused(`This stage has read all it may from ${source.label}. Carry on with what you have.`);

  let session: ContextServerSession | undefined;
  try {
    try {
      session = await deps.servers.open(orgId, source.server, withTimeout(deps.callTimeoutMs ?? CONTEXT_CALL_TIMEOUT_MS), source.tools.map((tool) => tool.upstreamName));
    } catch {
      await deps.usage.recordFailure({ orgId, operationId, sourceId: source.sourceId });
      deps.log?.("context_source.unreachable", { sourceId: source.sourceId });
      return unavailable(source.label);
    }
    const discovered = session.tools.find((entry) => entry.name === ticked.upstreamName);
    const status = toolStatus(ticked, discovered);
    if (status !== "ok" || discovered === undefined) {
      deps.log?.("context_source.tool_disabled", { sourceId: source.sourceId, reason: status });
      return refused("That tool changed since an admin ticked it, so it is off until they tick it again. Nothing was sent.");
    }
    const gate = contextWriteGate({ tool: discovered, attestedReadOnly: ticked.attestedReadOnly === true });
    if (gate.decision === "refuse") return refused(gate.message);
    const checked = checkArguments({ args, inputSchema: discovered.inputSchema, hosts: session.hosts, sendCodeSnippets: source.sendCodeSnippets });
    if (!checked.ok) {
      deps.log?.("context_source.arguments_refused", { sourceId: source.sourceId, reason: checked.reason });
      return refused(ARGUMENT_REFUSAL_TEXT[checked.reason]);
    }
    let answer;
    try {
      answer = await session.call(ticked.upstreamName, args as Record<string, unknown>, withTimeout(deps.callTimeoutMs ?? CONTEXT_CALL_TIMEOUT_MS));
    } catch {
      await deps.usage.recordFailure({ orgId, operationId, sourceId: source.sourceId });
      deps.log?.("context_source.call_failed", { sourceId: source.sourceId });
      return unavailable(source.label);
    }
    if (answer.isError === true) {
      await deps.usage.recordFailure({ orgId, operationId, sourceId: source.sourceId });
      return unavailable(source.label);
    }

    const record = firstRecord(answer.structuredContent);
    const rawText = textOf(answer) || (answer.structuredContent === undefined ? "" : JSON.stringify(answer.structuredContent));
    const digest = resultDigest({ structuredContent: answer.structuredContent, text: rawText }, source.liveFacts);
    const itemRef = inertSentence(stringField(record, ["key", "id", "number", "identifier", "ticketId", "pageId"]) ?? `${ticked.upstreamName}:${digest.slice(0, 12)}`, 200);
    const title = inertSentence(stringField(record, ["title", "summary", "name", "subject"]) ?? source.label, 200);
    const url = safeUrl(stringField(record, ["url", "webUrl", "html_url", "link"]), session.hosts);
    const standing = deps.standingOf?.(source, answer.structuredContent) ?? "outsider";
    const fetchedAt = new Date(deps.now()).toISOString();
    const framed = frameResult({ source, itemRef, fetchedAt, text: rawText, maxBytes: Math.min(source.limits.bytesPerResult, room), standing });
    await deps.usage.addBytes({ orgId, operationId, sourceId: source.sourceId, bytes: framed.bytes });

    const citation: Citation = { sourceId: source.sourceId, itemRef, title, ...(url === undefined ? {} : { url }), fetchedAt, digest, standing };
    // The stage goes on if any of these fail: a citation or a record that is missing is a gap in the page, never a reason to lose the answer.
    await deps.citations?.record({ orgId, taskId: run.task.taskId, operationId, stage, citation, replay: { tool: presented, arguments: args as Record<string, unknown> } }).catch(() => deps.log?.("context_source.citation_failed", { sourceId: source.sourceId }));
    await deps.results?.keep({ orgId, taskId: run.task.taskId, operationId, sourceId: source.sourceId, itemRef, digest, text: stripForKeeping(rawText, source.limits.bytesPerResult), retention: source.retention, quotes: source.quotes, system: source.system, fetchedAt })
      .catch(() => deps.log?.("context_source.keep_failed", { sourceId: source.sourceId }));
    void deps.teamSink.seen({
      orgId, projectId: run.task.project, taskId: run.task.taskId, stage, sourceId: source.sourceId, system: source.system ?? "mcp", itemRef, url, title, permissionSnapshot: null, fetchedAt, contentDigest: digest,
      ...(source.retention === "team_record" && source.quotes !== "citations_only" ? { content: JSON.stringify(withoutLiveFacts(answer.structuredContent ?? rawText, source.liveFacts)).slice(0, source.limits.bytesPerResult) } : {}), standing,
    }).catch(() => undefined);
    return { status: "OK", text: framed.text, citations: [citation], ...(framed.truncated ? { truncated: true } : {}) };
  } finally {
    await session?.close().catch(() => undefined);
  }
}

/** What is kept for people to read: the cleaned text, cut to the same bound the model saw. */
function stripForKeeping(text: string, maxBytes: number): string {
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
  return cut;
}

const SearchArgumentsSchema = (value: unknown): { query: string; sources?: string[] } | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { query, sources } = value as { query?: unknown; sources?: unknown };
  if (typeof query !== "string" || query.trim() === "" || query.length > 300) return undefined;
  if (sources !== undefined && !(Array.isArray(sources) && sources.length <= 16 && sources.every((entry) => typeof entry === "string" && entry.length <= 16))) return undefined;
  return { query, ...(sources === undefined ? {} : { sources: sources as string[] }) };
};

/** `search_team_knowledge`: asks the first `search` tool of each allowed source (one call each) and the Team record, and returns each answer framed on its own. */
async function searchAll(deps: ContextToolsDependencies, run: ContextToolsRun, sources: readonly ContextSource[], args: unknown): Promise<ContextToolCallResponse> {
  const parsed = SearchArgumentsSchema(args);
  if (parsed === undefined) return refused("search_team_knowledge takes a short query (up to 300 characters) and, optionally, a list of source ids.");
  const wanted = sources.filter((source) => parsed.sources === undefined || parsed.sources.includes(source.sourceId));
  const parts: string[] = [];
  const citations: Citation[] = [];
  const missing: string[] = [];
  for (const source of wanted) {
    const search = source.tools.find((tool) => tool.role === "search");
    if (search === undefined) continue;
    // The argument name comes from the tool's own schema, which needs a connection; the single call below opens another, so ask the list route's data first.
    let name: string | undefined;
    let session: ContextServerSession | undefined;
    try {
      session = await deps.servers.open(run.orgId, source.server, withTimeout(deps.callTimeoutMs ?? CONTEXT_CALL_TIMEOUT_MS), source.tools.map((tool) => tool.upstreamName));
      const schema = session.tools.find((tool) => tool.name === search.upstreamName)?.inputSchema;
      name = schema === undefined ? undefined : searchArgumentName(schema);
    } catch { missing.push(source.label); continue; } finally { await session?.close().catch(() => undefined); }
    if (name === undefined) continue;
    const answer = await callOne(deps, run, sources, presentedToolName(source.sourceId, search.upstreamName), { [name]: parsed.query });
    if (answer.status === "OK") { parts.push(answer.text); citations.push(...(answer.citations ?? [])); } else missing.push(source.label);
  }
  let hits: Awaited<ReturnType<TeamRecordSearch["search"]>> = [];
  try {
    hits = await deps.teamSearch.search({ orgId: run.orgId, projectId: run.task.project, query: parsed.query, ...(parsed.sources === undefined ? {} : { sources: parsed.sources }), asAgentForTask: run.task.taskId, limit: TEAM_SEARCH_LIMIT_MAX });
  } catch { deps.log?.("context_source.team_search_failed", {}); }
  if (hits.length > 0) {
    const lines = hits.slice(0, TEAM_SEARCH_LIMIT_MAX).map((hit) => `- ${inertSentence(hit.title, 120)} (${inertSentence(hit.system, 24)}, ${inertSentence(hit.itemRef, 60)})${hit.snippet === undefined ? "" : `: ${inertSentence(hit.snippet, 240)}`}`);
    parts.push(frameResult({ source: { label: "Team record" } as ContextSource, itemRef: "search", fetchedAt: new Date(deps.now()).toISOString(), text: lines.join("\n"), maxBytes: 8 * 1_024, standing: "outsider" }).text);
  }
  const note = missing.length === 0 ? "" : `\n\nNot reachable or not usable right now: ${missing.map((label) => inertSentence(label, 60)).join(", ")}. Say so in your answer.`;
  if (parts.length === 0) return { status: "OK", text: `No results.${note}` };
  return { status: "OK", text: `${parts.join("\n\n")}${note}`, citations: citations.slice(0, 50) };
}

export async function callContextTool(deps: ContextToolsDependencies, run: ContextToolsRun, rawBody: unknown): Promise<ContextToolCallResponse> {
  const parsed = ContextToolCallRequestSchema.safeParse(rawBody);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "invalid context tool request");
  const sources = await stageSources(deps, run);
  if (!isContextSourceStage(run.operation.workflowMode)) return refused("Sources are not available in this stage.");
  if (parsed.data.tool === SEARCH_TEAM_KNOWLEDGE_TOOL) return searchAll(deps, run, sources, parsed.data.arguments);
  return callOne(deps, run, sources, parsed.data.tool, parsed.data.arguments);
}
