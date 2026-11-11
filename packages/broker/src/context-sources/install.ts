// What the install hands to the context-source builders (`wiring.ts`), in one place that reads the operator's settings and fails closed.
//
//   ROVARA_PRIVATE_MCP_CIDRS    the private ranges outside which no private MCP server is tested or called (unset: none, so every private server is refused)
//   ROVARA_VPC_CIDRS            the network Rovara itself runs in. A private range that overlaps it stops the install; an address inside it is never tested or called
//   ROVARA_STDIO_MCP_SERVERS    exactly "1" runs servers from a package through an MCP host. OFF by default: Code runs no host of its own yet, so this needs a host's address
//   MCP_HOST_URL, MCP_HOST_TOKEN  the host's address (https; http only on this machine's loopback) and the bearer the broker presents
//
// A host address that is not https stops the install even while package-run servers are off, so a later switch-on cannot send the token in clear.
import { agentXError, type AuditSink, type DocumentStore } from "@agentx/contracts";
import { cidrBlockListOf, parseInstallCidrs } from "../connections/private-endpoints.js";
import { contextSourceAudit, controllerEventAudit, mcpServerAudit } from "./audit.js";
import { connectionLookupFromStore, createContextSourceOwnerDependencies, createContextSourcesRuntime, createMcpServerDependencies, serverSecretsFromConnectionSecrets } from "./wiring.js";
import type { OrgConnectionDeps } from "../connections/store.js";
import { probeLimiter, type McpServerDependencies } from "./mcp-servers.js";
import { documentResultStore, registerContextSourceCleanup, type TaskEndRegistrar } from "./quotes.js";
import type { ContextSourcesRuntime } from "./runtime.js";
import { assertSecureHostUrl, type McpHostEndpoint } from "./server-port.js";
import type { ContextSourceOwnerDependencies } from "./owner-operations.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface PrivateMcpInstallConfig {
  /** `parseInstallCidrs(ROVARA_PRIVATE_MCP_CIDRS)`; empty means every private server is refused. */
  privateCidrs: string[];
  /** `ROVARA_VPC_CIDRS`: the network Rovara runs in. */
  rovaraCidrs: string[];
  /** True only with `ROVARA_STDIO_MCP_SERVERS=1` and a host. */
  stdioEnabled: boolean;
  mcpHost?: McpHostEndpoint;
}

/** Reads the settings above. Throws a CONFIG_INVALID that names the setting (never its value, which may be a token) when one is wrong. */
export function privateMcpInstallConfig(env: Environment): PrivateMcpInstallConfig {
  const rovaraCidrs = (env.ROVARA_VPC_CIDRS ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (cidrBlockListOf(rovaraCidrs) === undefined) throw agentXError("CONFIG_INVALID", "ROVARA_VPC_CIDRS is not a list of ranges such as 10.42.0.0/16");
  const privateCidrs = parseInstallCidrs(env.ROVARA_PRIVATE_MCP_CIDRS, rovaraCidrs);
  // Fail closed: ranges set by hand without the install's own network could not be checked for overlap with it.
  if (privateCidrs.length > 0 && rovaraCidrs.length === 0) throw agentXError("CONFIG_INVALID", "ROVARA_PRIVATE_MCP_CIDRS needs ROVARA_VPC_CIDRS, the network Rovara itself runs in, so that an overlap can be refused");
  const stdioEnabled = env.ROVARA_STDIO_MCP_SERVERS === "1";
  const url = env.MCP_HOST_URL;
  const token = env.MCP_HOST_TOKEN;
  const hostGiven = url !== undefined && url !== "";
  if (stdioEnabled && !hostGiven) throw agentXError("CONFIG_INVALID", "ROVARA_STDIO_MCP_SERVERS=1 needs MCP_HOST_URL, the address of the MCP host");
  if (!hostGiven) return { privateCidrs, rovaraCidrs, stdioEnabled: false };
  // https only, checked now: the token never goes to an http:// address, whether or not package-run servers are on yet.
  assertSecureHostUrl(url);
  if (token === undefined || token === "") throw agentXError("CONFIG_INVALID", "MCP_HOST_URL needs MCP_HOST_TOKEN, the host's bearer token");
  return { privateCidrs, rovaraCidrs, stdioEnabled, mcpHost: { url, token } };
}

export interface ContextSourcesInstall {
  config: PrivateMcpInstallConfig;
  /** What the stage routes read (`local/app/context-tools.ts`). */
  runtime: ContextSourcesRuntime;
  /** What the owner's page calls: the Sources settings and the registered MCP servers. The MCP servers flow is built once, so its test limiter lasts. */
  owner: { contextSources: ContextSourceOwnerDependencies; mcpServers: McpServerDependencies };
  /** Takes the live-only cleanup off the task-end hook again (tests). */
  stopCleanup?: () => void;
}

export interface ContextSourcesInstallInput {
  env: Environment;
  /** The connection dependencies: the document store, the clock and the secret store a registered server's token is kept in. */
  connections: OrgConnectionDeps;
  store: DocumentStore;
  now?: () => number;
  /** Where the install says a task has ended. Given: a task's live-only source text is deleted when it ends. */
  onTaskEnd?: TaskEndRegistrar;
  /** The audit sink. Absent: nothing is recorded. */
  audit?: AuditSink;
  /** Refuses a stage's request when the person the task belongs to may no longer use it. Required: an install with one owner passes an explicit no-op. */
  requireAuthority: ContextSourcesRuntime["requireAuthority"];
  /** One owner decides: the person who proposes a change may confirm it. Default OFF, so a shared install keeps the second-person rule; only a single-owner install passes true. */
  ownerConfirmsOwn?: boolean;
  /** For tests: the transport, tool listing and address guard under a source's server. */
  serverPort?: ContextSourcesInstallServerPort;
}

type ContextSourcesInstallServerPort = NonNullable<Parameters<typeof createContextSourcesRuntime>[0]["serverPort"]>;

/** Builds the context sources for this install. A wrong setting throws. */
export function installContextSources(input: ContextSourcesInstallInput): ContextSourcesInstall {
  const config = privateMcpInstallConfig(input.env);
  const now = input.now ?? Date.now;
  const common = {
    store: input.store, now,
    connections: connectionLookupFromStore(input.connections),
    serverSecrets: serverSecretsFromConnectionSecrets({ env: input.connections.env, secrets: input.connections.secrets }),
    stdioEnabled: config.stdioEnabled,
    privateCidrs: config.privateCidrs,
    rovaraCidrs: config.rovaraCidrs,
    ...(config.mcpHost === undefined ? {} : { mcpHost: config.mcpHost }),
    ...(input.serverPort === undefined ? {} : { serverPort: input.serverPort }),
  };
  const controllerAudit = controllerEventAudit(input.audit);
  const runtime = createContextSourcesRuntime({ ...common, requireAuthority: input.requireAuthority, ...(controllerAudit === undefined ? {} : { controllerEventAudit: controllerAudit }) });
  // Changes to servers and Sources are recorded on the audit sink (audit.ts), where the install has one.
  const serverAudit = mcpServerAudit(input.audit, now);
  const sourceAudit = contextSourceAudit(input.audit, now);
  // One limiter for the install: listing a server's tools is a call out to the server, so it may be done only so often (like the test of a pasted server).
  const discoverAllowed = probeLimiter({ max: 30, windowMs: 600_000, now });
  const stopCleanup = input.onTaskEnd === undefined ? undefined : registerContextSourceCleanup({ store: documentResultStore(common), onTaskEnd: input.onTaskEnd, log: (event, fields) => console.warn(JSON.stringify({ event, ...fields })) });
  return {
    config, runtime,
    owner: {
      contextSources: createContextSourceOwnerDependencies({ ...common, ownerConfirmsOwn: input.ownerConfirmsOwn === true, ...(controllerAudit === undefined ? {} : { controllerEventAudit: controllerAudit }), discoverAllowed, ...(sourceAudit === undefined ? {} : { audit: sourceAudit }) }),
      mcpServers: createMcpServerDependencies({ ...common, ...(serverAudit === undefined ? {} : { audit: serverAudit }), ...(controllerAudit === undefined ? {} : { controllerEventAudit: controllerAudit }) }),
    },
    ...(stopCleanup === undefined ? {} : { stopCleanup }),
  };
}
