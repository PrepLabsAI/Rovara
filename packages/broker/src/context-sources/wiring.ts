// Builders that turn the pieces into what the install's dependency objects hold, so that the wiring is one call for each.
//
//   stage routes (`local/app/context-tools.ts`)     = createContextSourcesRuntime({ ... })
//   the owner's Sources settings (the local page)   = createContextSourceOwnerDependencies({ ... })
//   the owner's registered MCP servers              = createMcpServerDependencies({ ... })
//   once at start                                   = registerContextSourceCleanup({ store: documentResultStore(...), onTaskEnd })
import { isSecretLeaf, orgMcpServerSecretName, type ConnectionSecrets } from "../connections/org-secrets.js";
import { readConnection, readConnectionToken, type OrgConnectionDeps } from "../connections/store.js";
import { agentXError, type DocumentStore, type OrgId } from "@agentx/contracts";
import { documentCitationStore } from "./citations.js";
import { documentControllerEventStore, drainControllerEvents, type DrainDependencies } from "./controller-events.js";
import { documentMcpServerStore, probeLimiter, stdioAvailable, type McpServerDependencies, type McpServerSecrets } from "./mcp-servers.js";
import { documentResultStore } from "./quotes.js";
import type { ContextSourcesRuntime } from "./runtime.js";
import { gatewayProber, gatewayServerPort, hostControlClient, hostProbeClient, prewarmStdioServers, sourceEnvironment, type ConnectionLookup, type McpHostEndpoint } from "./server-port.js";
import type { ContextSourceOwnerDependencies } from "./owner-operations.js";
import { documentContextSourceStore } from "./store.js";

interface Common {
  store: DocumentStore;
  now: () => number;
  connections: ConnectionLookup;
  /** The MCP host's private URL and token, when the install runs one. NOT FOR PRODUCTION until the host is redesigned: it is used only when `stdioEnabled`. */
  mcpHost?: McpHostEndpoint | undefined;
  /** `process.env.ROVARA_STDIO_MCP_SERVERS === "1"` (see `stdioAvailable`). */
  stdioEnabled?: boolean | undefined;
  /** Each registered server's own write-only token. */
  serverSecrets: McpServerSecrets;
  /** `parseInstallCidrs(process.env.ROVARA_PRIVATE_MCP_CIDRS)`: the ranges outside which no private MCP server is tested or called. */
  privateCidrs?: readonly string[] | undefined;
  /** For tests: the transport, tool listing and address guard under a source's server, in place of the real ones. */
  serverPort?: Pick<Parameters<typeof gatewayServerPort>[0], "connect" | "list" | "publicGuard" | "privateGuard"> | undefined;
  /** `ROVARA_VPC_CIDRS`: the network Rovara itself runs in, never called as a private MCP server. */
  rovaraCidrs?: readonly string[] | undefined;
}

/** Registered servers' tokens, in the secret store (the same path as connection secrets). */
export function serverSecretsFromConnectionSecrets(input: { env: string; secrets: Pick<ConnectionSecrets, "read" | "put" | "scheduleDelete"> }): McpServerSecrets {
  const name = (orgId: OrgId, serverId: string): string => {
    if (!isSecretLeaf(serverId)) throw agentXError("FORBIDDEN", "that is not a server id");
    return orgMcpServerSecretName(input.env, orgId, serverId);
  };
  return {
    put: async (orgId, serverId, value) => input.secrets.put(orgId, name(orgId, serverId), value),
    read: async (orgId, serverId, version) => input.secrets.read(orgId, name(orgId, serverId), version),
    remove: async (orgId, serverId) => input.secrets.scheduleDelete(orgId, name(orgId, serverId)),
  };
}

/** The connection lookup the port needs, from the broker's connection store. A connection that is not an MCP connection carries no endpoint. */
export function connectionLookupFromStore(deps: OrgConnectionDeps): ConnectionLookup {
  return {
    async read(orgId, connectionId) {
      const record = await readConnection(deps, orgId, connectionId);
      if (record === undefined) return undefined;
      return { type: record.type, access: record.access, ...(record.type === "mcp" ? { endpoint: record.endpoint, ...(record.auth === undefined ? {} : { auth: record.auth }) } : {}) };
    },
    async token(orgId, connectionId) {
      const record = await readConnection(deps, orgId, connectionId);
      return record === undefined || record.type !== "mcp" || !record.hasSecret ? undefined : readConnectionToken(deps, orgId, record);
    },
  };
}

/** When the host says a package-run server is paused, record the controller's events and move the entry to `changed_needs_review` now (bounded, never throws). Only where package-run servers are on. */
function needsReviewHook(deps: Common & { controllerEventAudit?: DrainDependencies["audit"] }, servers: ReturnType<typeof documentMcpServerStore>): Pick<Parameters<typeof gatewayServerPort>[0], "onHostNeedsReview"> {
  if (deps.mcpHost === undefined || !stdioAvailable({ stdioEnabled: deps.stdioEnabled })) return {};
  const events = documentControllerEventStore(deps);
  return { onHostNeedsReview: (orgId) => { void drainControllerEvents({ events, servers, audit: deps.controllerEventAudit, now: deps.now }, orgId).catch(() => undefined); } };
}

export function createContextSourcesRuntime(deps: Common & { requireAuthority: ContextSourcesRuntime["requireAuthority"]; controllerEventAudit?: DrainDependencies["audit"]; teamSink?: ContextSourcesRuntime["teamSink"]; teamSearch?: ContextSourcesRuntime["teamSearch"] }): ContextSourcesRuntime {
  const servers = documentMcpServerStore(deps);
  return {
    requireAuthority: deps.requireAuthority,
    servers: gatewayServerPort({ ...(deps.serverPort ?? {}), ...needsReviewHook(deps, servers), connections: deps.connections, servers, serverSecrets: deps.serverSecrets, stdioEnabled: deps.stdioEnabled, ...(deps.mcpHost === undefined ? {} : { mcpHost: deps.mcpHost }), ...(deps.privateCidrs === undefined ? {} : { privateCidrs: deps.privateCidrs }), ...(deps.rovaraCidrs === undefined ? {} : { rovaraCidrs: deps.rovaraCidrs }) }),
    citations: documentCitationStore(deps), results: documentResultStore(deps),
    // The host is called only where package-run servers are on; elsewhere there is nothing to warm.
    ...(deps.mcpHost === undefined || !stdioAvailable({ stdioEnabled: deps.stdioEnabled }) ? {} : {
      prewarm: (orgId, serverIds) => prewarmStdioServers({ host: hostControlClient(deps.mcpHost!), servers, stdioEnabled: deps.stdioEnabled }, orgId, serverIds),
    }),
    ...(deps.teamSink === undefined ? {} : { teamSink: deps.teamSink }), ...(deps.teamSearch === undefined ? {} : { teamSearch: deps.teamSearch, teamRecordAvailable: true }),
  };
}

export function createContextSourceOwnerDependencies(deps: Common & { ownerConfirmsOwn?: boolean; controllerEventAudit?: DrainDependencies["audit"]; audit?: ContextSourceOwnerDependencies["audit"]; discoverAllowed?: ContextSourceOwnerDependencies["discoverAllowed"] }): ContextSourceOwnerDependencies {
  const servers = documentMcpServerStore(deps);
  const port = gatewayServerPort({ ...(deps.serverPort ?? {}), ...needsReviewHook(deps, servers), connections: deps.connections, servers, serverSecrets: deps.serverSecrets, stdioEnabled: deps.stdioEnabled, ...(deps.mcpHost === undefined ? {} : { mcpHost: deps.mcpHost }), ...(deps.privateCidrs === undefined ? {} : { privateCidrs: deps.privateCidrs }), ...(deps.rovaraCidrs === undefined ? {} : { rovaraCidrs: deps.rovaraCidrs }) });
  return {
    store: documentContextSourceStore(deps), env: sourceEnvironment({ connections: deps.connections, servers, port }), now: deps.now,
    // Off unless the install says one owner decides: a company with several administrators keeps the second-person rule.
    ...(deps.ownerConfirmsOwn === true ? { ownerConfirmsOwn: true } : {}),
    ...(deps.discoverAllowed === undefined ? {} : { discoverAllowed: deps.discoverAllowed }), ...(deps.audit === undefined ? {} : { audit: deps.audit }),
  };
}

export function createMcpServerDependencies(deps: Common & { audit?: McpServerDependencies["audit"]; secondAdminToApprove?: boolean; controllerEventAudit?: DrainDependencies["audit"] }): McpServerDependencies {
  return {
    store: documentMcpServerStore(deps), now: deps.now, probeAllowed: probeLimiter({ max: 10, windowMs: 600_000, now: deps.now }),
    // The host is handed to the prober only when package-run servers are switched on: with it off the broker never calls the host.
    secrets: deps.serverSecrets, stdioEnabled: deps.stdioEnabled,
    // The controller's events are read only where package-run servers are on.
    ...(deps.mcpHost === undefined || !stdioAvailable({ stdioEnabled: deps.stdioEnabled }) ? {} : { controllerEvents: { store: documentControllerEventStore(deps), audit: deps.controllerEventAudit } }),
    ...(deps.mcpHost === undefined || !stdioAvailable({ stdioEnabled: deps.stdioEnabled }) ? {} : { host: hostControlClient(deps.mcpHost) }),
    prober: gatewayProber({ ...(deps.mcpHost === undefined || !stdioAvailable({ stdioEnabled: deps.stdioEnabled }) ? {} : { host: hostProbeClient(deps.mcpHost) }), ...(deps.privateCidrs === undefined ? {} : { privateCidrs: deps.privateCidrs }), ...(deps.rovaraCidrs === undefined ? {} : { rovaraCidrs: deps.rovaraCidrs }) }),
    ...(deps.audit === undefined ? {} : { audit: deps.audit }), ...(deps.secondAdminToApprove === undefined ? {} : { secondAdminToApprove: deps.secondAdminToApprove }),
  };
}
