// E6: the real `ContextServerPort` (reaching a source's server) and `SourceEnvironment` (what the settings rules ask of the world), built on the gateway's MCP client.
//
// Three ways to reach a source, all read through the same client and all pinned to the addresses that were checked:
//   - an org connection of type `mcp` (a public https server): the public guard (checkEndpointUrl);
//   - an approved registered server over HTTP: the install's allow-list, which is the approved entries (mcp-servers.ts), and the never-called list;
//   - an approved registered server over stdio: the MCP host, an operator-configured private URL with its own token. No server code runs here.
// No other connection type is reached by this port yet: Linear and Jira are native connectors and are added behind this same port later (not in this lane).
import { connectMcp, listMcpTools, type McpConnection, type McpToolResult } from "@agentx/gateway";
import { agentXError, type ContextSourceServer, type McpAuth, type McpServerEntry, type OrgId } from "@agentx/contracts";
import { mcpEndpointGuard, type McpEndpointGuard } from "../connections/pinned-endpoint.js";
import { privateMcpEndpointGuard, probeMcpEndpointGuard } from "../connections/private-endpoints.js";
import { McpProbeError, STDIO_OFF_MESSAGE, allowedTargets, stdioAvailable, toolsDifferFromApproved, type McpHostControl, type McpProber, type McpServerSecrets, type McpServerStore } from "./mcp-servers.js";
import { MCP_INSTALL_FAILURES, type McpInstallFailureCode } from "@agentx/contracts";
import type { ContextServerPort, ContextServerSession } from "./routes.js";
import type { DiscoveredTool, SourceEnvironment } from "./settings.js";

/** The org connection as the port needs it. The broker builds this from its connection store (connections/store.ts `readConnection`, `readConnectionToken`). */
export interface ConnectionLookup {
  read(orgId: OrgId, connectionId: string): Promise<{ type: string; access: "read" | "read_write"; endpoint?: string | undefined; auth?: McpAuth | undefined } | undefined>;
  token(orgId: OrgId, connectionId: string): Promise<string | undefined>;
}

/**
 * the host's bearer token travels only over TLS. An http:// host address is refused, except on this machine's own loopback (a test host never leaves it).
 */
export function assertSecureHostUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw agentXError("CONFIG_INVALID", "the MCP host address is not a web address"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw agentXError("CONFIG_INVALID", "the MCP host must be reached over https");
  return url;
}

export interface McpHostEndpoint {
  /** The private URL of the MCP host service (https when the install gave it a certificate). */
  url: string;
  /** The bearer token the host expects from the broker. */
  token: string;
}

export interface ServerPortDependencies {
  connections: ConnectionLookup;
  servers: Pick<McpServerStore, "get" | "list" | "pause">;
  mcpHost?: McpHostEndpoint | undefined;
  /** Each registered server's own token (write-only; read only here, to send to that server's checked host and port). */
  serverSecrets?: Pick<McpServerSecrets, "read"> | undefined;
  /** Whether the install runs package-run servers (see `stdioAvailable`). Off: the MCP host is never called. */
  stdioEnabled?: boolean | undefined;
  /** The install's private address ranges (`parseInstallCidrs(process.env.ROVARA_PRIVATE_MCP_CIDRS)`). None: no private server is called. */
  privateCidrs?: readonly string[] | undefined;
  /** The network Rovara itself runs in (`ROVARA_VPC_CIDRS`): never called, whatever the allow-list says. */
  rovaraCidrs?: readonly string[] | undefined;
  /** For a public connection. Default: the existing guard. */
  publicGuard?: McpEndpointGuard | undefined;
  /** For an approved private server. Default: the allow-list guard over `servers`. */
  privateGuard?: ((orgId: OrgId) => McpEndpointGuard) | undefined;
  connect?: typeof connectMcp | undefined;
  list?: typeof listMcpTools | undefined;
  /**
   * Told (fire and forget, at most once every 30 seconds for a server) when the MCP host answers 409 for a package-run server: its tools changed after approval and the controller has paused it.
   * The broker uses it to record the controller's events and move the entry to `changed_needs_review` at once, instead of waiting for an admin to open the list.
   */
  onHostNeedsReview?: ((orgId: OrgId, serverId: string) => void) | undefined;
  /** For the time a pause is recorded at. Default: the clock. */
  now?: (() => number) | undefined;
}

const NO_TOKEN_AUTH: McpAuth = { header: "x-rovara-client", prefix: "rovara" };

/** `approved` is the tool list an admin approved, for a registered server (absent for a hosted connection, which has none of its own). */
interface Target { endpoint: URL; token: string; auth: McpAuth | undefined; fetchImplementation: typeof fetch; hosts: string[]; approved?: { toolsHash: string; tools: McpServerEntry["probe"]["tools"] } | undefined }

const NEEDS_REVIEW_EVERY_MS = 30_000;
const noted = new Map<string, number>();
/** Calls `notify` for a server at most once every 30 seconds; never throws. The map is bounded (it forgets entries older than the window). */
export function noteNeedsReview(notify: (orgId: OrgId, serverId: string) => void, orgId: OrgId, serverId: string, now: () => number = Date.now): void {
  const at = now();
  for (const [key, when] of noted) if (at - when >= NEEDS_REVIEW_EVERY_MS) noted.delete(key);
  const key = `${orgId}/${serverId}`;
  if (noted.has(key) || noted.size >= 1_000) return;
  noted.set(key, at);
  try { notify(orgId, serverId); } catch { /* the call that found it is not the place to fail */ }
}

async function targetOf(deps: ServerPortDependencies, orgId: OrgId, server: ContextSourceServer): Promise<Target> {
  if (server.kind === "connection") {
    const connection = await deps.connections.read(orgId, server.connectionId);
    // Context sources are read-only: a connection that can also write is not used, whatever the project's settings once said.
    if (connection === undefined || connection.type !== "mcp" || connection.access !== "read" || connection.endpoint === undefined) throw agentXError("CONFIG_INVALID", "this source's connection cannot be used");
    const endpoint = new URL(connection.endpoint);
    const token = await deps.connections.token(orgId, server.connectionId);
    if (token === undefined) throw agentXError("CONFIG_INVALID", "this source's connection has no key");
    return { endpoint, token, auth: connection.auth, fetchImplementation: await (deps.publicGuard ?? mcpEndpointGuard())(endpoint), hosts: [endpoint.hostname] };
  }
  const entry = await deps.servers.get(orgId, server.serverId);
  // Read now, every time: an entry that was disabled a moment ago is not called.
  if (entry === undefined || entry.status !== "approved") throw agentXError("FORBIDDEN", "that MCP server is not approved");
  if (entry.transport.kind === "http") {
    const endpoint = new URL(entry.transport.address);
    const guard = (deps.privateGuard ?? ((org: OrgId) => privateMcpEndpointGuard({ allowed: () => allowedTargets(deps.servers, org, deps.privateCidrs ?? []), rovaraCidrs: deps.rovaraCidrs })))(orgId);
    // The server's own token, read now and sent only to this server's checked host and port (the pinned fetch refuses any other origin).
    let token: string | undefined;
    if (entry.hasSecret === true) {
      token = await deps.serverSecrets?.read(orgId, entry.serverId, entry.secretVersion);
      if (token === undefined) throw agentXError("FORBIDDEN", "this server's token cannot be read");
    }
    return { endpoint, token: token ?? "", auth: token === undefined ? NO_TOKEN_AUTH : undefined, fetchImplementation: await guard(endpoint), hosts: [endpoint.hostname], approved: entry.probe };
  }
  // NOT FOR PRODUCTION until the host is redesigned: with the switch off the broker never calls the MCP host.
  if (!stdioAvailable({ stdioEnabled: deps.stdioEnabled })) throw agentXError("FORBIDDEN", STDIO_OFF_MESSAGE);
  if (deps.mcpHost === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the MCP host is not set up in this install");
  // The host address is the operator's, not a person's: it is not an SSRF input and is called with the host's own token. A stdio server has no site of its own, so
  // no address argument is ever on its host.
  const hostFetch: typeof fetch = deps.onHostNeedsReview === undefined ? fetch : (async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 409) noteNeedsReview(deps.onHostNeedsReview!, orgId, server.serverId);
    return response;
  });
  return { endpoint: new URL(`${assertSecureHostUrl(deps.mcpHost.url).href.replace(/\/$/u, "")}/servers/${server.serverId}/mcp`), token: deps.mcpHost.token, auth: undefined, fetchImplementation: hostFetch, hosts: [], approved: entry.probe };
}

/**
 * A server that echoes its own credential back in a tool result (a debug tool that prints the request headers) must not hand it to a model: the token this call was made with is
 * replaced by `[redacted]` in the text and in the structured content. A token too short to be a secret is left, since replacing a few characters would damage ordinary words.
 */
export function withoutToken(result: McpToolResult, token: string): McpToolResult {
  if (token.length < 8) return result;
  const clean = (text: string): string => text.split(token).join("[redacted]");
  return {
    ...result,
    ...(result.content === undefined ? {} : { content: result.content.map((block) => (typeof block.text === "string" ? { ...block, text: clean(block.text) } : block)) }),
    ...(result.structuredContent === undefined ? {} : { structuredContent: JSON.parse(clean(JSON.stringify(result.structuredContent))) as unknown }),
  };
}

const toDiscovered = (tools: McpConnection["tools"]): DiscoveredTool[] => tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }));

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error instanceof Error ? error : new Error("failed")); });
  });
}

export function gatewayServerPort(deps: ServerPortDependencies): ContextServerPort {
  const connect = deps.connect ?? connectMcp;
  const list = deps.list ?? listMcpTools;
  /**
   * The tools a registered server lists are checked against the list the admin approved on EVERY open and EVERY listing, not once when a task starts: a server that answered honestly
   * first and then adds a tool or changes a description or a definition is paused (card and one-click re-approve) and nothing it said is offered or called. A tool that is not in the approved
   * list, or has changed, is never returned. Paused even when the pause cannot be recorded: the refusal does not depend on it.
   */
  async function holdToApproved(orgId: OrgId, server: ContextSourceServer, target: Target, live: McpConnection["tools"], scope: "all" | readonly string[]): Promise<void> {
    if (target.approved === undefined || server.kind !== "registered_server" || !toolsDifferFromApproved(target.approved, toDiscovered(live), scope)) return;
    try { await deps.servers.pause({ orgId, serverId: server.serverId, toolsHash: target.approved.toolsHash, at: new Date((deps.now ?? Date.now)()).toISOString() }); } catch { /* the refusal below does not wait on it */ }
    console.log(JSON.stringify({ component: "broker", event: "context_source.server_tools_changed", serverId: server.serverId }));
    throw agentXError("FORBIDDEN", "that MCP server's tools are not the ones an admin approved, so it is paused until an admin looks at them");
  }
  return {
    async open(orgId, server, signal, tools): Promise<ContextServerSession> {
      const target = await targetOf(deps, orgId, server);
      const connection = await connect({ endpoint: target.endpoint, token: target.token, tools, signal, ...(target.auth === undefined ? {} : { auth: target.auth }), fetchImplementation: target.fetchImplementation });
      try { await holdToApproved(orgId, server, target, connection.tools, tools ?? []); } catch (error) { await connection.close().catch(() => undefined); throw error; }
      return {
        hosts: target.hosts, tools: toDiscovered(connection.tools),
        call: async (name, args, callSignal): Promise<McpToolResult> => withoutToken(await abortable(connection.call(name, args), callSignal), target.token),
        close: () => connection.close(),
      };
    },
    async listAll(orgId, server, signal): Promise<DiscoveredTool[]> {
      const target = await targetOf(deps, orgId, server);
      const live = await list({ endpoint: target.endpoint, token: target.token, signal, ...(target.auth === undefined ? {} : { auth: target.auth }), fetchImplementation: target.fetchImplementation });
      await holdToApproved(orgId, server, target, live, "all");
      return toDiscovered(live);
    },
  };
}

/** The settings rules' view of the world, from the real port. */
export function sourceEnvironment(deps: ServerPortDependencies & { port: ContextServerPort }): SourceEnvironment {
  return {
    connection: async (orgId, connectionId) => {
      const connection = await deps.connections.read(orgId, connectionId);
      return connection === undefined ? undefined : { type: connection.type, access: connection.access };
    },
    registeredServer: async (orgId, serverId) => {
      const entry = await deps.servers.get(orgId, serverId);
      return entry === undefined ? undefined : { status: entry.status, transport: entry.transport.kind };
    },
    // A package-run server is offered and saved only where the install runs them (switched on), however it is stored.
    stdioAvailable: () => stdioAvailable({ stdioEnabled: deps.stdioEnabled }),
    discoverTools: async (orgId, server) => {
      if (deps.port.listAll === undefined) throw new Error("no tool listing");
      return deps.port.listAll(orgId, server, AbortSignal.timeout(15_000));
    },
    // Nothing checks a viewer's own identity at a source yet, so "people allowed at the source" cannot be chosen.
    perUserCheckAvailable: () => false,
  };
}

// ---------------------------------------------------------------------------------------------
// Testing a pasted address
// ---------------------------------------------------------------------------------------------

/** How long the broker waits for the controller's install-and-probe job. The controller's job deadline (420 s) is shorter, and the probe slot's lease (10 min) is longer. */
export const HOST_PROBE_TIMEOUT_MS = 450_000;

export interface HostProbeClient {
  /** Asks the MCP host to install a package for a moment and list its tools (with `pinned`: to test the pinned bundle without installing). Throws McpProbeError. */
  probe(spec: Parameters<McpProber["stdio"]>[0], pinned?: Parameters<McpProber["stdio"]>[1], serverId?: string): ReturnType<McpProber["stdio"]>;
}

/** Maps what went wrong while testing an address to one of the fixed codes. The error's own text is never kept. */
function classify(error: unknown): McpProbeError {
  if (error instanceof McpProbeError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  const message = error instanceof Error ? error.message : "";
  if (name === "McpUnauthorized") return new McpProbeError("unauthorized");
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|aborted/iu.test(message)) return new McpProbeError("timed_out");
  if (/never calls/u.test(message)) return new McpProbeError("not_allowed_address");
  if (/could not be looked up|did not resolve/u.test(message)) return new McpProbeError("dns_failed");
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|fetch failed|certificate|self[- ]signed/iu.test(message)) return new McpProbeError("unreachable");
  return new McpProbeError("not_mcp");
}

/**
 * Tests a pasted address: the form and the never-called list apply, the allow-list does not (nothing is approved yet), and the connection is pinned to the checked
 * addresses. `host` serves stdio specs. Every failure is one of the fixed codes.
 */
export function gatewayProber(deps: { host?: HostProbeClient | undefined; privateCidrs?: readonly string[] | undefined; rovaraCidrs?: readonly string[] | undefined; guard?: McpEndpointGuard | undefined; list?: typeof listMcpTools | undefined; timeoutMs?: number | undefined }): McpProber {
  const list = deps.list ?? listMcpTools;
  return {
    async http(address, token) {
      try {
        const endpoint = new URL(address);
        const fetchImplementation = await (deps.guard ?? probeMcpEndpointGuard({ installCidrs: deps.privateCidrs ?? [], rovaraCidrs: deps.rovaraCidrs }))(endpoint);
        return toDiscovered(await list({ endpoint, token: token ?? "", signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000), ...(token === undefined ? { auth: NO_TOKEN_AUTH } : {}), fetchImplementation }));
      } catch (error) {
        throw classify(error);
      }
    },
    async stdio(spec, pinned, serverId) {
      if (deps.host === undefined) throw new McpProbeError("host_unavailable");
      try { return await deps.host.probe(spec, pinned, serverId); } catch (error) { throw error instanceof McpProbeError ? error : new McpProbeError("host_refused"); }
    },
  };
}

/** The MCP host's probe route, called by the broker with the host's token. */
export function hostProbeClient(host: McpHostEndpoint, fetchImplementation: typeof fetch = fetch): HostProbeClient {
  return {
    async probe(spec, pinned, serverId) {
      assertSecureHostUrl(host.url);
      let response: Response;
      try {
        response = await fetchImplementation(`${host.url.replace(/\/$/u, "")}/probe`, {
          method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify({ spec, ...(pinned === undefined ? {} : { pinned }), ...(serverId === undefined ? {} : { serverId }) }), signal: AbortSignal.timeout(HOST_PROBE_TIMEOUT_MS),
        });
      } catch {
        throw new McpProbeError("host_unavailable");
      }
      if (!response.ok) throw new McpProbeError(response.status === 401 ? "host_unavailable" : response.status === 429 ? "host_busy" : "host_refused");
      const body = await response.json().catch(() => undefined) as { tools?: unknown; error?: unknown; reason?: unknown; install?: { code?: unknown; computedIntegrity?: unknown } } | undefined;
      // The host's words are never shown: of what it says, only a refused destination and the FIXED code of a failed install are taken, and each is looked up in the broker's own tables.
      if (body !== undefined && body.error === "host_refused") {
        if (body.reason === "destination_refused") throw new McpProbeError("destination_refused");
        const code = body.install?.code;
        if (typeof code === "string" && Object.prototype.hasOwnProperty.call(MCP_INSTALL_FAILURES, code)) {
          const computed = body.install?.computedIntegrity;
          throw new McpProbeError("install_failed", { installCode: code as McpInstallFailureCode, ...(typeof computed === "string" && /^sha512-[A-Za-z0-9+/=]{20,200}$/u.test(computed) ? { computedIntegrity: computed } : {}) });
        }
      }
      if (body === undefined || !Array.isArray(body.tools) || typeof (body as { integrity?: unknown }).integrity !== "string") throw new McpProbeError("host_refused");
      const tools = (body.tools as Array<{ name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown }>)
        .filter((tool): tool is { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: DiscoveredTool["annotations"] } => typeof tool.name === "string" && typeof tool.inputSchema === "object" && tool.inputSchema !== null)
        .slice(0, 200).map((tool) => ({ name: tool.name, description: typeof tool.description === "string" ? tool.description : undefined, inputSchema: tool.inputSchema, annotations: tool.annotations }));
      const hash = (value: unknown): string | undefined => (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : undefined);
      const answer = body as { integrity: string; lockfileHash?: unknown; bundleHash?: unknown; installed?: { packageCount?: unknown; unpackedBytes?: unknown } };
      const count = (value: unknown, max: number): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined);
      const packageCount = count(answer.installed?.packageCount, 5_000), unpackedBytes = count(answer.installed?.unpackedBytes, 2 ** 40);
      return { tools, integrity: answer.integrity, lockfileHash: hash(answer.lockfileHash), bundleHash: hash(answer.bundleHash), ...(packageCount === undefined || unpackedBytes === undefined ? {} : { installed: { packageCount, unpackedBytes } }) };
    },
  };
}

/** Calls the MCP host's `warm` and `release` routes (T9). Both are POSTs with the host's token, bounded to 10 seconds, and any failure is the caller's to ignore: neither is needed for a call to work. */
export function hostControlClient(host: McpHostEndpoint, fetchImplementation: typeof fetch = fetch): McpHostControl {
  const send = async (serverId: string, action: "warm" | "release"): Promise<void> => {
    if (!/^mcp[a-z0-9]{6,24}$/u.test(serverId)) throw new Error("not a server id");
    const base = assertSecureHostUrl(host.url);
    const response = await fetchImplementation(`${base.href.replace(/\/$/u, "")}/servers/${serverId}/${action}`, {
      method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    await response.body?.cancel();
    if (!response.ok && !(action === "release" && response.status === 409)) throw new Error(`the host answered ${response.status}`);
  };
  return { warm: (serverId) => send(serverId, "warm"), release: (serverId) => send(serverId, "release") };
}

/**
 * Starts the tasks of the package-run servers a stage is about to use, so the first tool call does not wait for a cold start (design section 6, "Prewarm"). Called when a stage that has
 * package-run sources starts. It never throws, never waits for a task to come up, and does at most 16 calls. the requests are SENT in parallel and then awaited for a short bound
 * (2 seconds; the host answers 202 at once), because a Lambda invocation that returns is frozen and a request still in flight may never be sent. Returns how many it asked for.
 */
export async function prewarmStdioServers(deps: { host: Pick<McpHostControl, "warm"> | undefined; servers: Pick<McpServerStore, "get">; stdioEnabled: boolean | undefined; waitMs?: number | undefined }, orgId: OrgId, serverIds: readonly string[]): Promise<number> {
  if (deps.host === undefined || !stdioAvailable({ stdioEnabled: deps.stdioEnabled })) return 0;
  const sent: Array<Promise<unknown>> = [];
  for (const serverId of [...new Set(serverIds)].slice(0, 16)) {
    try {
      const entry = await deps.servers.get(orgId, serverId);
      // Only an approved package-run server is warmed; the host checks this again from the registry.
      if (entry?.status !== "approved" || entry.transport.kind !== "stdio") continue;
      sent.push(deps.host.warm(serverId).catch(() => undefined));
    } catch { /* a stage never fails because a server could not be warmed */ }
  }
  if (sent.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(sent), new Promise<void>((resolve) => { timer = setTimeout(resolve, deps.waitMs ?? 2_000); })]);
    if (timer !== undefined) clearTimeout(timer);
  }
  return sent.length;
}
