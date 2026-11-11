// E1: the settings of a project's MCP context sources, and the pending change that adds, changes or removes one (design meta-repo-mcp.md 3.6).
//
// A source is "read-only, enforced four times". This file holds the first three, checked when an admin ticks a tool and checked again when the change is
// confirmed: (1) the connection must be `access: "read"`; (2) the admin's allow-list names each tool; (3) the tool's own MCP annotations say it only reads.
// The fourth, the write gate on every call, is routes.ts. A tool whose annotations do not say so needs a second admin to confirm "this tool only reads".
//
// Nothing in here reaches the network or the table: the environment (connections, servers, tool discovery) and the store are ports, so the rules are
// testable and the broker supplies the real ones.
import { createHash, randomUUID } from "node:crypto";
import {
  ContextSourceSchema,
  ContextSourcesDocumentSchema,
  CONTEXT_SOURCE_LIMITS,
  DESTRUCTIVE_WORDS,
  WRITE_VERBS,
  agentXError,
  canonicalJson,
  isQuoteForbiddenSystem,
  nameWords,
  type ContextSource,
  type McpServerStatus,
  type ContextSourceServer,
  type ContextSourcesDocument,
  type OrgId,
} from "@agentx/contracts";

/** A tool as an MCP server lists it. Only what the rules read is typed. */
export interface DiscoveredTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown; [key: string]: unknown } | undefined;
}

const HINT_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** The hash an allow-list entry is matched by: the tool's name, its input schema and the four standard hints. A change to any of them is a different tool. */
export function toolSchemaHash(tool: Pick<DiscoveredTool, "name" | "inputSchema" | "annotations">): string {
  const hints: Record<string, unknown> = {};
  for (const key of HINT_KEYS) if (tool.annotations?.[key] !== undefined) hints[key] = tool.annotations[key];
  return createHash("sha256").update(canonicalJson({ name: tool.name, inputSchema: tool.inputSchema, hints })).digest("hex");
}

/**
 * What a tool's annotations say. `read_only`: `readOnlyHint` is true and `destructiveHint` is not. `unsafe`: it says it writes or destroys. `unannotated`:
 * it says nothing, which is not a claim that it reads (a second admin must confirm it).
 */
export function annotationVerdict(tool: Pick<DiscoveredTool, "annotations">): "read_only" | "unannotated" | "unsafe" {
  const hints = tool.annotations;
  if (hints?.destructiveHint === true || hints?.readOnlyHint === false) return "unsafe";
  return hints?.readOnlyHint === true ? "read_only" : "unannotated";
}

const WRITE_WORDS: ReadonlySet<string> = new Set([...WRITE_VERBS, ...DESTRUCTIVE_WORDS]);

/** Whether the tool's name has a word of a change (`create_issue`, `deleteItem`). A hint from the server can lie; the name is Rovara's own check on it. */
export function nameSuggestsWrite(name: string): boolean {
  return nameWords(name).some((word) => WRITE_WORDS.has(word));
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/** What validation needs to know about the world. Each answer is read now. */
export interface SourceEnvironment {
  /** The org connection, if it is this org's. */
  connection(orgId: OrgId, connectionId: string): Promise<{ type: string; access: "read" | "read_write" } | undefined>;
  /** The approved MCP server entry (see mcp-servers.ts), if it is this org's. */
  registeredServer(orgId: OrgId, serverId: string): Promise<{ status: McpServerStatus; /** Absent: a server with an address. */ transport?: "http" | "stdio" } | undefined>;
  /** Whether this install runs servers from a package. Absent counts as no: a package-run server is then not offered and not saved. */
  stdioAvailable?(): boolean;
  /** The tools the source's server lists now. It throws when the server cannot be reached; the message is not shown. */
  discoverTools(orgId: OrgId, server: ContextSourceServer): Promise<DiscoveredTool[]>;
  /** Whether a live check at the source with the viewer's own identity exists for this source (`source_acl` needs it). */
  perUserCheckAvailable(source: ContextSource): boolean;
}

export interface SourceValidation {
  /** Reasons the source cannot be saved. Empty when it can. */
  problems: string[];
  /** Reasons a second admin must also confirm the change. */
  secondAdminReasons: string[];
}

/** Checks a source against its server's tools. It never throws for a bad source: it answers with problems. */
export async function validateContextSource(env: SourceEnvironment, orgId: OrgId, input: unknown): Promise<SourceValidation & { source?: ContextSource }> {
  const parsed = ContextSourceSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // A field a caller made up is not repeated back (a body can carry a secret by mistake).
    return { problems: [`${issue === undefined || issue.path.length === 0 ? "source" : issue.path.join(".")}: ${issue?.code === "unrecognized_keys" ? "has a field this setting does not take" : issue?.message ?? "is not valid"}`], secondAdminReasons: [] };
  }
  const source = parsed.data;
  const problems: string[] = [];
  const secondAdminReasons: string[] = [];

  if (isQuoteForbiddenSystem(source.system)) {
    if (source.quotes !== "citations_only") problems.push(`${source.label}: this system's terms allow citations only, never a stored or shown quote`);
    if (source.retention !== "live_only") problems.push(`${source.label}: this system's text is read live and never kept`);
  }
  if (source.quotes === "source_acl" && !env.perUserCheckAvailable(source)) {
    problems.push(`${source.label}: "people allowed at the source" needs a per-person check, which this source does not have yet; choose project members or citations only`);
  }

  if (source.server.kind === "connection") {
    const connection = await env.connection(orgId, source.server.connectionId);
    if (connection === undefined) problems.push("server: that connection does not exist in this organisation");
    else if (connection.access !== "read") problems.push("server: a context source needs a read-only connection; this one can also write");
  } else {
    const server = await env.registeredServer(orgId, source.server.serverId);
    if (server === undefined) problems.push("server: that MCP server is not registered in this organisation");
    else if (server.status !== "approved") problems.push("server: that MCP server has not been approved by an admin");
    else if (server.transport === "stdio" && env.stdioAvailable?.() !== true) problems.push("server: that MCP server runs from a package, which is switched off on this install; choose a server that has an address");
  }
  if (problems.length > 0) return { problems, secondAdminReasons, source };

  let discovered: DiscoveredTool[];
  try {
    discovered = await env.discoverTools(orgId, source.server);
  } catch {
    return { problems: ["server: Rovara could not list that server's tools right now; try again"], secondAdminReasons, source };
  }
  const byName = new Map(discovered.map((tool) => [tool.name, tool]));
  for (const ticked of source.tools) {
    const tool = byName.get(ticked.upstreamName);
    if (tool === undefined) { problems.push(`tools: ${ticked.upstreamName} is not offered by the server`); continue; }
    if (toolSchemaHash(tool) !== ticked.schemaHash) { problems.push(`tools: ${ticked.upstreamName} changed since it was shown; open the list again and tick it again`); continue; }
    const verdict = annotationVerdict(tool);
    if (verdict === "unsafe") { problems.push(`tools: ${ticked.upstreamName} says it changes things, so a context source cannot use it`); continue; }
    if (verdict === "unannotated" || nameSuggestsWrite(tool.name)) {
      if (ticked.attestedReadOnly === true) {
        secondAdminReasons.push(verdict === "unannotated" ? `${ticked.upstreamName} does not say it only reads` : `${ticked.upstreamName} has a name that sounds like a change`);
      } else {
        problems.push(verdict === "unannotated"
          ? `tools: ${ticked.upstreamName} does not say it only reads; a second admin must confirm "this tool only reads" (tick it as confirmed)`
          : `tools: ${ticked.upstreamName} has a name that sounds like a change; a second admin must confirm "this tool only reads" (tick it as confirmed)`);
      }
    } else if (ticked.attestedReadOnly === true) {
      problems.push(`tools: ${ticked.upstreamName} already says it only reads, so it needs no confirmation`);
    }
  }
  if (source.sendCodeSnippets) {
    // A vendor connection is somewhere else: code sent in a query leaves the machine, so the owner is asked to look at it again before it is saved.
    if (source.server.kind === "connection") secondAdminReasons.push(`${source.label} may receive code in its queries`);
  }
  return { problems, secondAdminReasons: [...new Set(secondAdminReasons)], source };
}

// ---------------------------------------------------------------------------------------------
// Pending changes
// ---------------------------------------------------------------------------------------------

export type ContextSourceChangeStatus = "pending" | "applied" | "rejected";

export interface ContextSourceChange {
  changeId: string;
  orgId: OrgId;
  project: string;
  kind: "set" | "remove";
  sourceId: string;
  /** Present for `set`. */
  source?: ContextSource;
  proposedBy: string;
  proposedAt: string;
  /** The document revision the change was made against; a change is refused when the document has moved. */
  baseRevision: number;
  /** Why a second person must confirm (or, for one owner, what the owner is asked to read again). Empty: any admin may, the proposer included. */
  secondAdminReasons: string[];
  status: ContextSourceChangeStatus;
  decidedBy?: string;
  decidedAt?: string;
}

export interface ContextSourceStore {
  /** The project's document; revision 0 and no sources when none was ever saved. */
  readDocument(orgId: OrgId, project: string): Promise<ContextSourcesDocument>;
  putChange(change: ContextSourceChange): Promise<void>;
  getChange(orgId: OrgId, project: string, changeId: string): Promise<ContextSourceChange | undefined>;
  listPending(orgId: OrgId, project: string): Promise<ContextSourceChange[]>;
  /** Writes the next document only if the stored revision is `change.baseRevision`, and marks the change decided, in one step. */
  apply(input: { change: ContextSourceChange; next: ContextSourcesDocument; decidedBy: string; decidedAt: string }): Promise<"applied" | "stale">;
  reject(input: { change: ContextSourceChange; decidedBy: string; decidedAt: string }): Promise<"rejected" | "stale">;
}

export interface SettingsActor {
  orgId: OrgId;
  developerId: string;
  orgRole: string;
}

export interface SettingsDependencies {
  store: ContextSourceStore;
  env: SourceEnvironment;
  now: () => number;
  newId?: () => string;
  /**
   * One owner decides (Code runs as one person): the person who proposed a change may also confirm it, even when it carries reasons a second person would have been asked about. The reasons are
   * still recorded and shown on the page for the owner to read before pressing Confirm. A company with several administrators leaves this off.
   */
  ownerConfirmsOwn?: boolean;
  /** Told after a decision, for the audit trail. A failure is not the caller's problem. */
  audit?: (event: { action: "context_source.proposed" | "context_source.applied" | "context_source.rejected"; actor: SettingsActor; project: string; sourceId: string; changeId: string; change: "set" | "remove" }) => Promise<void>;
}

function requireAdmin(actor: SettingsActor): void {
  if (actor.orgRole !== "owner" && actor.orgRole !== "admin") throw agentXError("FORBIDDEN", "Only an org owner or admin can change a project's context sources.");
}

async function told(deps: SettingsDependencies, event: Parameters<NonNullable<SettingsDependencies["audit"]>>[0]): Promise<void> {
  try { await deps.audit?.(event); } catch { /* an audit hiccup does not undo the decision; the caller's logs name it */ }
}

/** A maintainer-visible view: the document and the changes waiting. */
export async function readContextSources(deps: SettingsDependencies, actor: SettingsActor, project: string): Promise<{ document: ContextSourcesDocument; pending: ContextSourceChange[] }> {
  requireAdmin(actor);
  return { document: await deps.store.readDocument(actor.orgId, project), pending: await deps.store.listPending(actor.orgId, project) };
}

/** Proposes adding or changing a source. A source that fails the rules is refused with the reasons; otherwise a pending change is stored. */
export async function proposeSourceChange(deps: SettingsDependencies, actor: SettingsActor, project: string, body: { kind: "set"; source: unknown } | { kind: "remove"; sourceId: string }): Promise<ContextSourceChange> {
  requireAdmin(actor);
  const document = await deps.store.readDocument(actor.orgId, project);
  const base = { changeId: (deps.newId ?? randomUUID)(), orgId: actor.orgId, project, proposedBy: actor.developerId, proposedAt: new Date(deps.now()).toISOString(), baseRevision: document.revision, status: "pending" as const };
  let change: ContextSourceChange;
  if (body.kind === "remove") {
    if (!document.sources.some((source) => source.sourceId === body.sourceId)) throw agentXError("NOT_FOUND", "this project has no such source");
    change = { ...base, kind: "remove", sourceId: body.sourceId, secondAdminReasons: [] };
  } else {
    const checked = await validateContextSource(deps.env, actor.orgId, body.source);
    if (checked.problems.length > 0 || checked.source === undefined) throw agentXError("CONFIG_INVALID", checked.problems.slice(0, 5).join("; "));
    const next = [...document.sources.filter((source) => source.sourceId !== checked.source!.sourceId), checked.source];
    if (next.length > CONTEXT_SOURCE_LIMITS.sourcesPerProject) throw agentXError("CONFIG_INVALID", `a project has at most ${CONTEXT_SOURCE_LIMITS.sourcesPerProject} context sources`);
    change = { ...base, kind: "set", sourceId: checked.source.sourceId, source: checked.source, secondAdminReasons: checked.secondAdminReasons };
  }
  await deps.store.putChange(change);
  await told(deps, { action: "context_source.proposed", actor, project, sourceId: change.sourceId, changeId: change.changeId, change: change.kind });
  return change;
}

/**
 * Confirms a pending change and applies it. The source is checked again against the server as it is now (a tool may have changed since the proposal), and a
 * change that needs a second admin cannot be confirmed by its proposer.
 */
export async function confirmSourceChange(deps: SettingsDependencies, actor: SettingsActor, project: string, changeId: string): Promise<ContextSourcesDocument> {
  requireAdmin(actor);
  const change = await deps.store.getChange(actor.orgId, project, changeId);
  if (change === undefined || change.status !== "pending") throw agentXError("NOT_FOUND", "no pending change has that id");
  const document = await deps.store.readDocument(actor.orgId, project);
  if (document.revision !== change.baseRevision) throw agentXError("CHANGE_STALE", "The project's sources changed since this was proposed. Propose it again.");
  let sources: ContextSource[];
  let reasons = change.secondAdminReasons;
  if (change.kind === "remove") {
    sources = document.sources.filter((source) => source.sourceId !== change.sourceId);
  } else {
    const checked = await validateContextSource(deps.env, actor.orgId, change.source);
    if (checked.problems.length > 0 || checked.source === undefined) throw agentXError("CONFIG_INVALID", checked.problems.slice(0, 5).join("; "));
    sources = [...document.sources.filter((source) => source.sourceId !== change.sourceId), checked.source];
    // What needs a second admin is decided by the rules as they are now, not as they were when it was proposed.
    reasons = [...new Set([...change.secondAdminReasons, ...checked.secondAdminReasons])];
  }
  if (reasons.length > 0 && change.proposedBy === actor.developerId && deps.ownerConfirmsOwn !== true) {
    throw agentXError("FORBIDDEN", `A second admin must confirm this change: ${reasons.join("; ")}.`);
  }
  const next = ContextSourcesDocumentSchema.parse({ revision: document.revision + 1, sources });
  const at = new Date(deps.now()).toISOString();
  if (await deps.store.apply({ change, next, decidedBy: actor.developerId, decidedAt: at }) === "stale") {
    throw agentXError("CHANGE_STALE", "The project's sources changed while this was confirmed. Propose it again.");
  }
  await told(deps, { action: "context_source.applied", actor, project, sourceId: change.sourceId, changeId, change: change.kind });
  return next;
}

/** Turns a pending change down. Any admin may, the proposer included. */
export async function rejectSourceChange(deps: SettingsDependencies, actor: SettingsActor, project: string, changeId: string): Promise<void> {
  requireAdmin(actor);
  const change = await deps.store.getChange(actor.orgId, project, changeId);
  if (change === undefined || change.status !== "pending") throw agentXError("NOT_FOUND", "no pending change has that id");
  const result = await deps.store.reject({ change, decidedBy: actor.developerId, decidedAt: new Date(deps.now()).toISOString() });
  if (result === "stale") throw agentXError("CHANGE_STALE", "That change was already decided.");
  await told(deps, { action: "context_source.rejected", actor, project, sourceId: change.sourceId, changeId, change: change.kind });
}
