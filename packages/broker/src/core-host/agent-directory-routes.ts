// Lead 4 L4-MF3: the company-wide agent directory on the deployed developer API, for Cloud's agents screen:
//
//   GET /v1/app/agents?scope=all|mine|builtin|shared     { agents: AgentView[] }   (Cloud's AgentDirectoryResponseReaderSchema; the shape is contracts/agent-directory-view.ts)
//
// Rules (owner decision, 2026-11-17: only a company owner or administrator reads it):
//  - The caller must be a live company owner or administrator. The role is the membership the dev routes read for THIS request (never a token claim, a header or a cached answer). Anyone
//    else gets one fixed 403 before anything is read or parsed: a member, a project maintainer, a script token (refused earlier by the dev routes) and a caller with an unknown role.
//  - The company is the caller's membership (the dev routes mount that company's runtime); the store is read for that company only: the directory partition, then each agent's own META, which
//    names its company (a row that names another company is not read). No route reads across companies.
//  - What is listed: the six built-in agents (code constants, with the company's own "turned off" setting from its guardrails) and the company's custom agents. Hosted Code cannot run a custom
//    agent yet, so every custom agent says so in fixed words (`needsLaterConnectors`, the view's "what it can't do yet" line). Nothing is invented: Code stores no per-agent budget, accountable
//    person, share or project roster, so those fields are omitted (they are optional) and `shared` is empty until share rows have a writer.
//  - The answer is built field by field and parsed with the contract's strict schema; one unreadable record is a fixed 503, never a shorter list. A directory larger than the bound is a fixed 503 too.
//  - Refusals are fixed words; nothing a caller sent is echoed.
import {
  AgentDirectoryResponseSchema, AgentOwnerSchema, AgentScopeSchema, AgentXError, BUILTIN_AGENTS, BUILTIN_AGENT_IDS, agentDirectoryKey, agentXError, builtinDefaultPin, currentBuiltinVersion,
  type AgentDirectoryResponse, type AgentOwner, type AgentView, type AuditSink, type DocumentStore, type OrgId, type OrgRole,
} from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { readGuardrails } from "../core/agents/guardrails.js";
import { AgentStore, type AgentRecord } from "../core/agents/store.js";

export const AGENTS_PATH = "/v1/app/agents";
export const AGENT_DIRECTORY_NOT_ALLOWED = "Only an owner or an administrator of the company can see the company's agents.";
export const AGENT_DIRECTORY_BAD_VIEW = "That is not an agent view this directory offers.";
export const AGENT_DIRECTORY_PROJECT_NOT_HERE = "A project's agent list is not on hosted Code yet.";
export const AGENT_DIRECTORY_UNAVAILABLE = "The agent directory could not be read just now. Try again in a moment.";
/** What each custom agent says: hosted Code starts no custom agent yet. */
export const AGENT_CANT_RUN_ON_HOSTED = "Can't run on hosted yet.";
/** The most custom agents one answer lists. A larger directory is refused (a fixed 503), never cut. */
export const AGENT_DIRECTORY_MAX = 500;

export interface HostedAgentDirectoryInput {
  request: BrokerRequest;
  /** The request's path without its query. */
  path: string;
  /** The member company the dev routes mounted. */
  companyId: OrgId;
  /** The caller's live role in that company, as membership read it for this request. */
  role: OrgRole;
  /** The caller's developer id (for `scope=mine`). */
  developerId: string;
  store: DocumentStore;
  audit: AuditSink;
  now: () => number;
}

/** Whether this method and path is the directory read. */
export function isAgentDirectoryPath(path: string, method: string): boolean {
  return method === "GET" && path === AGENTS_PATH;
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const unavailable = (): AgentXError => agentXError("RUNTIME_UNAVAILABLE", AGENT_DIRECTORY_UNAVAILABLE);

/** The view the query asks for: `scope` once (default `all`) and no project. Anything else is a fixed refusal. */
function scopeOf(request: BrokerRequest): "all" | "mine" | "shared" | "builtin" {
  const params = new URLSearchParams(request.path.split("?")[1] ?? "");
  if (params.has("project")) throw agentXError("NOT_FOUND", AGENT_DIRECTORY_PROJECT_NOT_HERE);
  const keys = [...params.keys()];
  if (keys.some((key) => key !== "scope") || params.getAll("scope").length > 1) throw agentXError("CONFIG_INVALID", AGENT_DIRECTORY_BAD_VIEW);
  const scope = AgentScopeSchema.safeParse(params.get("scope") ?? "all");
  if (!scope.success) throw agentXError("CONFIG_INVALID", AGENT_DIRECTORY_BAD_VIEW);
  return scope.data;
}

async function guarded<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch { throw unavailable(); }
}

/** One built-in agent as the directory shows it: the company pins the default release until it adopts another; a company can turn a built-in off in its guardrails. */
function builtinView(id: (typeof BUILTIN_AGENT_IDS)[number], disabled: boolean): AgentView {
  const template = BUILTIN_AGENTS[id];
  const pinned = builtinDefaultPin(id), latest = currentBuiltinVersion(id);
  return {
    agentId: id, name: template.name, description: template.description, builtin: true, access: "manage", status: "active",
    currentVersion: pinned, pinnedVersion: pinned, latestVersion: latest,
    ...(disabled ? { disabled: true } : {}),
    ...(template.needsLaterConnectors === undefined ? {} : { needsLaterConnectors: template.needsLaterConnectors }),
    ...(pinned < latest ? { updateAvailable: { from: pinned, to: latest } } : {}),
  };
}

/**
 * The agent's owner as stored: one member, or a project (the contract's two kinds). Hosted agents made before the hosted directory are project-owned (live test run 2, 2026-11-18:
 * every one of the pilot company's agents), so a project owner is listed as such. Anything else is unreadable: the whole answer is the fixed 503, never a shorter list.
 */
function ownerOf(record: AgentRecord): AgentOwner {
  const owner = AgentOwnerSchema.safeParse((record as { owner?: unknown }).owner);
  if (!owner.success) throw unavailable();
  return owner.data;
}

function customView(record: AgentRecord): AgentView {
  return {
    agentId: record.agentId, name: record.name, description: record.description, builtin: false, access: "manage", status: record.status,
    owner: ownerOf(record),
    ...(record.currentVersion === undefined ? {} : { currentVersion: record.currentVersion }), latestVersion: record.latestVersion, draftRevision: record.draftRevision,
    createdBy: record.createdBy, createdAt: record.createdAt, updatedAt: record.updatedAt,
    needsLaterConnectors: AGENT_CANT_RUN_ON_HOSTED,
  };
}

/** The company's custom agents, oldest first, from its own directory partition; a row that names another company is never read. */
async function customAgents(input: HostedAgentDirectoryInput): Promise<AgentRecord[]> {
  const agents = new AgentStore({ store: input.store, now: input.now, audit: input.audit, companyId: input.companyId });
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await input.store.query({ pk: agentDirectoryKey(input.companyId, "agt_x").pk, limit: AGENT_DIRECTORY_MAX + 1, ...(cursor === undefined ? {} : { cursor }) });
    for (const row of page.items) ids.push(String(row["sk"]));
    if (ids.length > AGENT_DIRECTORY_MAX) throw unavailable();
    cursor = page.cursor;
  } while (cursor !== undefined);
  const records = await Promise.all(ids.map((agentId) => agents.get(input.companyId, agentId)));
  // A directory row with no agent behind it (or one of another company, which `get` does not return) is not listed; a record that is not this company's is never shown.
  return records.filter((record): record is AgentRecord => record !== undefined && record.orgId === input.companyId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.agentId.localeCompare(b.agentId));
}

/** One request on the directory path (`isAgentDirectoryPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedAgentDirectory(input: HostedAgentDirectoryInput): Promise<BrokerResponse> {
  try {
    // The live role first: nothing is parsed or read for anyone else.
    if (input.role !== "owner" && input.role !== "admin") throw agentXError("FORBIDDEN", AGENT_DIRECTORY_NOT_ALLOWED);
    if (!isAgentDirectoryPath(input.path, input.request.method)) throw agentXError("NOT_FOUND", "route not found");
    const scope = scopeOf(input.request);
    const views: AgentView[] = [];
    if (scope === "all" || scope === "builtin") {
      const disabled = new Set<string>((await guarded(async () => await readGuardrails({ store: input.store, now: input.now }, input.companyId))).disabledBuiltins);
      for (const id of BUILTIN_AGENT_IDS) views.push(builtinView(id, disabled.has(id)));
    }
    if (scope === "all" || scope === "mine") {
      for (const record of await guarded(async () => await customAgents(input))) {
        if (scope === "mine") { const owner = ownerOf(record); if (owner.kind !== "member" || owner.developerId !== input.developerId) continue; }
        views.push(customView(record));
      }
    }
    const parsed = AgentDirectoryResponseSchema.safeParse({ agents: views } satisfies AgentDirectoryResponse);
    if (!parsed.success) throw unavailable();
    return json(200, parsed.data);
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    return errorAnswer(unavailable());
  }
}
