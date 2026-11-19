// Connections, context sources and registered MCP servers on `rovara up`.
//
// Who may do what (owner decision 66):
//  - ADDING a connection, ticking a tool, approving a server and confirming a source are the owner's acts on the Connections and Sources pages, in a page session opened in the last few minutes.
//    The API token (which an AI tool may hold) reads and nothing more: `routes` answers a write with the page message.
//  - A secret is write-only. The page posts it, the store keeps it as a file only the owner can read (`connections/local-secrets.ts`), and it comes back through the `secrets` socket at the moment it is
//    used. No record, answer, audit event or log line holds it.
//  - What a source returns is data: `context-sources/routes.ts` frames, cuts and cleans it before a model sees it, and the worker frames it again (worker/src/context-sources).
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  AgentXError, agentXError, canonicalJson, connectionTakesSecret, newPrefixedId,
  type AdapterRegistry, type ContextSource, type ContextSourceServer, type DocumentStore, type OrgConnection, type OrgId, type Principal,
} from "@agentx/contracts";
import { CONNECTION_FORMS } from "../../core/local-pages/connection-forms.js";
import type {
  ConnectionPageAction, ConnectionRowView, ConnectionsPageView, LocalActionResult, McpServerRowView, SourcesPageView,
} from "../../core/local-pages/views.js";
import { developerIdOf } from "../../core/sessions/create.js";
import type { TaskCaller, TaskFlowDeps } from "../../core/task-flow/deps.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { checkEndpointUrl, dnsResolveHost } from "../../connections/endpoint-check.js";
import { createLocalConnectionSecrets } from "../../connections/local-secrets.js";
import { readRequestMark, type RequestMark } from "../../connections/request-marks.js";
import { OrgConnectionStore, type OrgConnectionDeps, type OrgConnectionRecord } from "../../connections/store.js";
import { documentContextSourceStore } from "../../context-sources/store.js";
import { installContextSources, type ContextSourcesInstall } from "../../context-sources/install.js";
import { approveMcpServer, disableMcpServer, proposeMcpServer, reapprovePausedMcpServer, removeMcpServer } from "../../context-sources/mcp-servers.js";
import { confirmSource, discoverSourceTools, proposeSource, rejectSource, serversOf, sourcesOf } from "../../context-sources/owner-operations.js";
import type { TaskEndRegistrar } from "../../context-sources/quotes.js";
import { connectionChecksFromRegistry } from "../../monitoring/native-adapters.js";
import { createRegistrySecretStore } from "../../ports/secret-stores.js";
import { listProjects } from "./projects.js";

/** The environment name that prefixes every secret name on a laptop. */
export const LOCAL_SECRET_ENV = "local";
export const CONNECTIONS_ON_THE_PAGE = "A connection, a registered MCP server and a project's context sources are added, changed and approved on their local page, by you, in a page session opened within the last ten minutes. Run `rovara open connections` to open it; an assistant cannot do it for you, and neither can this token.";
export const NEEDS_FRESH_PAGE = "That change needs a page you opened in the last few minutes. Close this page and run `rovara open connections` again, then make the change within ten minutes.";
const CONNECTIONS_PATH = /^\/v1\/dev\/connections(?:\/([^/]+))?$/u;
const SOURCES_PATH = "/v1/dev/context-sources";
const SERVERS_PATH = "/v1/dev/mcp-servers";
/** The most a source's tools may be ticked at once on the form. */
const SOURCE_LIMITS = { callsPerStage: 10, bytesPerResult: 8_192, bytesPerStage: 65_536 } as const;

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });

export interface LocalConnectionsOptions {
  registry: AdapterRegistry;
  store: DocumentStore;
  companyId: OrgId;
  owner: Principal;
  stateDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  /** Where the install says a task ended (the live-only text of its sources is deleted then). */
  onTaskEnd?: TaskEndRegistrar;
  /** For tests: the fetch under a connection's check. */
  fetch?: typeof fetch;
  /** For tests: refuses an address that must not be called (default: the public address check). */
  checkEndpoint?: (url: string) => Promise<void>;
  /** For tests: the transport, tool listing and address guard under a source's server. */
  serverPort?: NonNullable<Parameters<typeof installContextSources>[0]["serverPort"]>;
}

export interface LocalConnections {
  readonly connections: OrgConnectionStore;
  readonly install: ContextSourcesInstall;
  /** For the task flow: whether a stage has sources, so it is dispatched with the capability to read them. */
  readonly contextSources: NonNullable<TaskFlowDeps["contextSources"]>;
  /** What a worker's stage reads (`/v1/internal/context-tools`). */
  readonly runtime: ContextSourcesInstall["runtime"];
  /** The owner's reads for a token (`GET /v1/dev/connections`, `/v1/dev/context-sources`, `/v1/dev/mcp-servers`); a write is refused with the page message. */
  routes(request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined>;
  getConnectionsPage(): Promise<ConnectionsPageView>;
  getSourcesPage(project: string, discover?: string): Promise<SourcesPageView | undefined>;
  action(input: ConnectionPageAction, context: { fresh: boolean }): Promise<LocalActionResult>;
}

function detailOf(connection: OrgConnection): string {
  switch (connection.type) {
    case "jira": return connection.siteUrl;
    case "mcp": return new URL(connection.endpoint).hostname;
    case "grafana": return new URL(connection.baseUrl).hostname;
    case "sentry": return `${connection.orgSlug} (${connection.region})`;
    case "datadog": return connection.site;
    case "pagerduty": return `region ${connection.region}`;
    case "cloudwatch": return connection.regions.join(", ");
    case "vercel": return connection.teamId ?? "personal account";
    case "linear": return "linear.app";
  }
}

function rowOf(record: OrgConnectionRecord): ConnectionRowView {
  const { hasSecret, lastCheck } = record;
  return {
    connectionId: record.connectionId, type: record.type, label: record.label, access: record.access, hasCredential: hasSecret, detail: detailOf(record),
    ...(lastCheck === undefined ? {} : { lastCheck: { ok: lastCheck.ok, at: lastCheck.at } }),
  };
}

/** A connection as a token may read it: the row of the page. Nothing of its secret, its name or the vendor account. */
const viewOf = (record: OrgConnectionRecord) => rowOf(record);

/** How the owner's act is refused in words: an AgentXError carries its own sentence, anything else is a fault and is not shown. */
function refusal(error: unknown): LocalActionResult {
  if (!(error instanceof AgentXError)) throw error;
  const message = error.message.slice(error.code.length + 2);
  const reason = error.code === "NOT_FOUND" ? "not_found" : error.code === "CHANGE_STALE" ? "stale" : error.code === "CONFIG_INVALID" ? "invalid" : "refused";
  return { ok: false, reason, message };
}

const sha = (...parts: string[]): string => createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");

export function createLocalConnections(options: LocalConnectionsOptions): LocalConnections {
  const { registry, store, companyId, owner } = options;
  const developerId = developerIdOf(owner);
  const actor = { orgId: companyId, developerId, orgRole: "owner" } as const;
  const secrets = createLocalConnectionSecrets({ directory: join(options.stateDirectory, "connection-secrets"), secrets: createRegistrySecretStore(registry), companyId, env: LOCAL_SECRET_ENV, now: options.now });
  const deps: OrgConnectionDeps = { store, env: LOCAL_SECRET_ENV, secrets, now: options.now };
  const connections = new OrgConnectionStore({
    ...deps, audit: registry.require("audit-sink"), checks: connectionChecksFromRegistry(registry),
    checkEndpoint: options.checkEndpoint ?? (async (url) => { await checkEndpointUrl(url, dnsResolveHost); }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const install = installContextSources({
    env: options.environment, connections: deps, store, now: options.now, audit: registry.require("audit-sink"),
    // One owner: the one person here is always allowed to use their own task, so there is nothing to check; and they confirm their own proposal after reading what it asks.
    requireAuthority: async () => undefined, ownerConfirmsOwn: true, ...(options.onTaskEnd === undefined ? {} : { onTaskEnd: options.onTaskEnd }),
    ...(options.serverPort === undefined ? {} : { serverPort: options.serverPort }),
  });
  const sourceStore = documentContextSourceStore({ store, now: options.now });
  const projectNames = async (): Promise<string[]> => (await listProjects(store, companyId)).map((project) => project.name).sort();

  const contextSources: LocalConnections["contextSources"] = {
    async stageHasSources(task, mode) {
      // Read now, at the start of the step: a project that has no source for this stage is dispatched with no capability at all.
      return (await sourceStore.readDocument(companyId, task.project)).sources.some((source) => source.stages.includes(mode as ContextSource["stages"][number]));
    },
  };

  const getConnectionsPage = async (): Promise<ConnectionsPageView> => {
    const records = await connections.list(companyId);
    const listed = await serversOf(install.owner.mcpServers, actor);
    const servers: McpServerRowView[] = listed.servers.map((server) => ({
      serverId: server.serverId, label: server.label, status: server.status, transport: server.transport.kind,
      ...(server.transport.kind === "http" ? { address: server.transport.address } : {}),
      hasToken: server.hasSecret === true,
      tools: server.probe.tools.map((tool) => ({ name: tool.name, description: tool.description, annotation: tool.annotation })),
      ...(server.pausedAt === undefined ? {} : { pausedAt: server.pausedAt }),
    }));
    return {
      connections: records.map(rowOf), servers, monitoringKinds: registry.names("monitoring").sort(), privateRangesSet: install.config.privateCidrs.length > 0,
      stdioAvailable: listed.stdioAvailable, projects: await projectNames(),
    };
  };

  const serverOf = (value: string): ContextSourceServer | undefined => {
    const [kind, id] = [value.slice(0, value.indexOf(":")), value.slice(value.indexOf(":") + 1)];
    return kind === "connection" ? { kind: "connection", connectionId: id } : kind === "server" ? { kind: "registered_server", serverId: id } : undefined;
  };

  const getSourcesPage = async (project: string, discover?: string): Promise<SourcesPageView | undefined> => {
    if (!(await projectNames()).includes(project)) return undefined;
    const { document, pending } = await sourcesOf(install.owner.contextSources, actor, project);
    const choices: Array<{ value: string; label: string }> = [];
    for (const record of await connections.list(companyId)) if (record.type === "mcp" && record.access === "read") choices.push({ value: `connection:${record.connectionId}`, label: `${record.label} (connection, ${detailOf(record)})` });
    for (const server of (await serversOf(install.owner.mcpServers, actor)).servers) if (server.status === "approved" && server.transport.kind === "http") choices.push({ value: `server:${server.serverId}`, label: `${server.label} (registered server)` });
    const nameOf = new Map(choices.map((choice) => [choice.value, choice.label]));
    const view: SourcesPageView = {
      project,
      sources: document.sources.map((source) => ({
        sourceId: source.sourceId, label: source.label,
        server: nameOf.get(source.server.kind === "connection" ? `connection:${source.server.connectionId}` : `server:${source.server.serverId}`) ?? "a server that is no longer available",
        stages: [...source.stages], tools: source.tools.map((tool) => ({ name: tool.upstreamName, role: tool.role, attested: tool.attestedReadOnly === true })),
        quotes: source.quotes, retention: source.retention, sendCodeSnippets: source.sendCodeSnippets,
      })),
      pending: pending.map((change) => ({ changeId: change.changeId, kind: change.kind, sourceId: change.sourceId, ...(change.source === undefined ? {} : { label: change.source.label }), proposedAt: change.proposedAt, reasons: change.secondAdminReasons })),
      serverChoices: choices,
    };
    const server = discover === undefined ? undefined : serverOf(discover);
    if (discover !== undefined && server !== undefined && nameOf.has(discover)) {
      try {
        const tools = await discoverSourceTools(install.owner.contextSources, actor, { server });
        return { ...view, discovered: { server: discover, serverLabel: nameOf.get(discover)!, tools: tools } };
      } catch (error) {
        if (!(error instanceof AgentXError)) throw error;
        return { ...view, discovered: { server: discover, serverLabel: nameOf.get(discover)!, problem: error.message.slice(error.code.length + 2) } };
      }
    }
    return view;
  };

  /** A posted form as the connection's settings and secret: the fields go where the form table says, and the contract's schemas decide what is valid. */
  const connectionFromForm = (input: Extract<ConnectionPageAction, { op: "save" }>): { connection: Record<string, unknown>; secret: Record<string, unknown> | undefined; connectionId: string } => {
    const form = CONNECTION_FORMS.find((candidate) => candidate.type === input.type);
    if (form === undefined) throw agentXError("CONFIG_INVALID", "type: that kind of connection is not offered");
    const existing = input.fields["connectionId"];
    const connectionId = existing !== undefined && existing !== "" ? existing : newPrefixedId("con");
    const connection: Record<string, unknown> = { connectionId, type: input.type, label: input.fields["label"] ?? "", access: form.mayWrite ? input.access : "read" };
    const secret: Record<string, unknown> = {};
    for (const field of form.fields) {
      const value = (input.fields[field.name] ?? "").trim();
      if (field.into === "secret") { if (value !== "") secret[field.name] = value; continue; }
      if (value === "") { if (field.required === true) throw agentXError("CONFIG_INVALID", `${field.name}: fill this in`); continue; }
      connection[field.name] = field.name === "regions" ? value.split(",").map((part) => part.trim()).filter((part) => part !== "") : value;
    }
    return { connection, secret: Object.keys(secret).length === 0 ? undefined : secret, connectionId };
  };

  const markOf = (requestId: string, fingerprint: string): RequestMark => ({ orgId: companyId, developerId, requestId, fingerprint });

  const act = async (input: ConnectionPageAction): Promise<LocalActionResult> => {
    switch (input.op) {
      case "save": {
        const { connection, secret, connectionId } = connectionFromForm(input);
        // A secret enters the fingerprint only as a one-way hash that is specific to this company and connection.
        const secretDigest = secret === undefined ? null : sha("connection-secret", companyId, connectionId, canonicalJson(secret));
        const request = markOf(input.requestId, sha(canonicalJson({ route: "save", connectionId, connection, secret: secretDigest })));
        const earlier = await readEarlier(input.requestId);
        if (earlier !== undefined) return earlier === request.fingerprint ? { ok: true, message: "Saved." } : { ok: false, reason: "invalid", message: "This request id was already used for another change." };
        const exists = input.fields["connectionId"] !== undefined && input.fields["connectionId"] !== "";
        const saved = await connections.put({ orgId: companyId, connection, ...(secret === undefined ? {} : { secret }), by: developerId, requestId: input.requestId, request, ...(exists ? { requireExisting: true } : { requireNew: true }) });
        return { ok: true, message: saved.hasSecret || !connectionTakesSecret(saved.type) ? "Saved." : "Saved, with no key yet." };
      }
      case "remove": {
        await connections.remove({ orgId: companyId, connectionId: input.connectionId, by: developerId, requestId: input.requestId, request: markOf(input.requestId, sha("remove", input.connectionId)) });
        return { ok: true, message: "Removed." };
      }
      case "check": {
        const result = await connections.check(companyId, input.connectionId, markOf(input.requestId, sha("check", input.connectionId)));
        return result.ok ? { ok: true, message: result.message === undefined ? "The connection works." : `The connection works: ${result.message}` } : { ok: false, reason: "refused", message: result.message ?? "The check failed." };
      }
      case "server-add": {
        await proposeMcpServer(install.owner.mcpServers, actor, { label: input.label, transport: { kind: "http", address: input.address }, ...(input.token === "" ? {} : { secret: input.token }) });
        return { ok: true, message: "Added. Look at what it offers, then approve it." };
      }
      case "server-approve": await approveMcpServer(install.owner.mcpServers, actor, input.serverId); return { ok: true, message: "Approved." };
      case "server-disable": await disableMcpServer(install.owner.mcpServers, actor, input.serverId); return { ok: true, message: "Turned off." };
      case "server-remove": await removeMcpServer(install.owner.mcpServers, actor, input.serverId); return { ok: true, message: "Removed." };
      case "server-reapprove": await reapprovePausedMcpServer(install.owner.mcpServers, actor, input.serverId, input.toolsHash); return { ok: true, message: "Approved again." };
      case "source-propose": {
        const server = serverOf(input.server);
        if (server === undefined) throw agentXError("CONFIG_INVALID", "server: choose where the source reads from");
        const source = {
          sourceId: input.sourceId, label: input.label, server,
          tools: input.tools.map((tool) => ({ upstreamName: tool.name, role: tool.role, schemaHash: tool.schemaHash, ...(tool.attested ? { attestedReadOnly: true } : {}) })),
          stages: input.stages, quotes: input.quotes, retention: input.retention, limits: { ...SOURCE_LIMITS }, liveFacts: [], sendCodeSnippets: input.sendCodeSnippets,
        };
        const change = await proposeSource(install.owner.contextSources, actor, input.project, { kind: "set", source });
        return { ok: true, message: change.secondAdminReasons.length === 0 ? "Proposed. Read it below, then confirm." : `Proposed. Read what it asks below (${change.secondAdminReasons.join("; ")}), then confirm.` };
      }
      case "source-remove": await proposeSource(install.owner.contextSources, actor, input.project, { kind: "remove", sourceId: input.sourceId }); return { ok: true, message: "Proposed the removal. Confirm it below." };
      case "source-confirm": await confirmSource(install.owner.contextSources, actor, input.project, input.changeId); return { ok: true, message: "Applied." };
      case "source-reject": await rejectSource(install.owner.contextSources, actor, input.project, input.changeId); return { ok: true, message: "Turned down." };
    }
  };

  const readEarlier = async (requestId: string): Promise<string | undefined> => {
    return (await readRequestMark({ store, now: options.now }, companyId, developerId, requestId))?.fingerprint;
  };

  return {
    connections, install, contextSources, runtime: install.runtime,
    getConnectionsPage, getSourcesPage,
    async action(input, context) {
      // Every one of these is the owner's own act on a page they opened a few minutes ago: the API token never reaches here, and a page left open for long does not make one.
      if (!context.fresh) return { ok: false, reason: "reauth", message: NEEDS_FRESH_PAGE };
      try { return await act(input); } catch (error) { return refusal(error); }
    },
    async routes(request, caller) {
      const path = request.path.split("?")[0] ?? request.path;
      const connectionMatch = CONNECTIONS_PATH.exec(path);
      if (connectionMatch === null && path !== SOURCES_PATH && path !== SERVERS_PATH) return undefined;
      try {
        if (caller.principal.companyId !== companyId) throw agentXError("FORBIDDEN", "that is not this install's company");
        // Reading is for any holder of the token; changing is the owner's act on the local page (the same rule as approving a plan).
        if (request.method !== "GET") throw agentXError("FORBIDDEN", CONNECTIONS_ON_THE_PAGE);
        if (connectionMatch !== null) {
          if (connectionMatch[1] === undefined) return json(200, { connections: (await connections.list(companyId)).map(viewOf) });
          const record = await connections.get(companyId, connectionMatch[1]);
          if (record === undefined) throw agentXError("NOT_FOUND", "no connection has that ID");
          return json(200, { connection: viewOf(record) });
        }
        if (path === SERVERS_PATH) {
          const listed = await serversOf(install.owner.mcpServers, actor);
          return json(200, { servers: listed.servers.map((server) => ({ serverId: server.serverId, label: server.label, status: server.status, transport: server.transport.kind, hasToken: server.hasSecret === true, tools: server.probe.tools.map((tool) => ({ name: tool.name, annotation: tool.annotation })) })), stdioAvailable: listed.stdioAvailable });
        }
        const project = new URL(request.path, "http://local").searchParams.get("project") ?? "";
        if (!(await projectNames()).includes(project)) throw agentXError("NOT_FOUND", "no project has that name");
        const { document, pending } = await sourcesOf(install.owner.contextSources, actor, project);
        return json(200, { project, revision: document.revision, sources: document.sources.map((source) => ({ sourceId: source.sourceId, label: source.label, stages: source.stages, tools: source.tools.map((tool) => ({ name: tool.upstreamName, role: tool.role })), quotes: source.quotes, retention: source.retention })), pending: pending.map((change) => ({ changeId: change.changeId, kind: change.kind, sourceId: change.sourceId, reasons: change.secondAdminReasons })) });
      } catch (error) {
        if (!(error instanceof AgentXError)) throw error;
        return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
      }
    },
  };
}

