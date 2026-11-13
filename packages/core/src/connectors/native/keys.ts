// The pure helpers and types the native connectors and the per-org connection registry share. They used to sit in `aws/credentials.ts`, `aws/connector-ledger.ts` and
// `aws/connector-types.ts`, next to the DynamoDB and Secrets Manager code of the hosted registry, and that put the AWS SDK behind the engine's connector runtime. Here
// they import only contracts and the gateway; the `aws/` files re-export them, so nothing that imported them from there changes.
import { type ConnectionSecret, type CredentialRecord, type CredentialType, type OrgConnection, type ProjectDefinition } from "@rovara-code/contracts";
import type { ConnectorDefinition, ConnectorPolicy, CredentialProvider, PresentationApproval, connectMcp } from "@agentx/gateway";
import type { McpEndpointGuard } from "../../connections/pinned-endpoint.js";
import type { GitHubMcpDependencies } from "../../github-mcp.js";

/** The host a connector's credential must be pinned to (spec 055 FR-009). */
export interface HostPin {
  /** The endpoint's host. */
  host: string;
  /** True for a generic `mcp` connector: an unpinned credential is refused too. */
  required: boolean;
}

/** Why a credential's pinned host does not allow sending it to this connector, or undefined. */
export function hostPinProblem(ref: string, recordHost: string | undefined, pin: HostPin | undefined): string | undefined {
  if (pin === undefined) return undefined;
  if (recordHost === undefined) {
    return pin.required ? `credential ${ref} is not pinned to a host; register it again with --host ${pin.host}` : undefined;
  }
  return recordHost === pin.host ? undefined : `credential ${ref} is pinned to ${recordHost}, not ${pin.host}, so AgentX does not send it there`;
}

/**
 * What a connector type reads of a credential registry: the install-wide one below, or, on a cloud install, one org's
 * connections (connections/registry.ts). It can say what is registered and hand out a provider; it cannot register.
 */
export interface ConnectorCredentials {
  /** Whether a valid record is registered under this reference; a malformed record counts as absent. */
  has(ref: string): Promise<boolean>;
  /** The registration under a reference, if a valid one exists. */
  registration(ref: string): Promise<CredentialRecord | undefined>;
  /** The provider type behind a reference: the built-in GitHub App, a valid stored record's type, or undefined. */
  typeOf(ref: string): Promise<CredentialType | undefined>;
  /** A provider that resolves the record on each issue, so re-registration takes effect. */
  provider(ref: string, options?: { tokenEndpoint?: URL; accepts?: readonly CredentialType[]; pin?: HostPin }): CredentialProvider<unknown>;
  /**
   * The settings (never the secret) of the org connection `ref` names, for a native connector that needs its region, site or organization. Only
   * a cloud install's per-org registry has it; the install-wide one does not.
   */
  connection?(ref: string): Promise<OrgConnection | undefined>;
  /**
   * The whole secret of the org connection `ref` names, in its type's shape, for a connector whose credential is more than one value (Datadog's
   * API and application keys). Read by the version the connection's own save wrote. Only the per-org registry has it; the connector must not log or echo it.
   */
  connectionSecret?(ref: string): Promise<ConnectionSecret | undefined>;
}

export function connectorLedgerKeys(connector: string): { prefix: string; entityType: string } {
  return { prefix: `CONNECTOR#${connector}#`, entityType: "CONNECTOR_INVOCATION" };
}

export interface ConnectorScope<Scope> { alias: string; scope: Scope }

export interface ResolvedConnector<Scope = unknown> {
  name: string;
  type: string;
  /** Thread and manifest label, for example "GitHub issues". */
  label: string;
  /** Vendor name in presented descriptions, for example "GitHub". */
  vendor: string;
  scopeNoun: string;
  scopes: ReadonlyArray<ConnectorScope<Scope>>;
  policy: ConnectorPolicy;
  approvals: readonly PresentationApproval[];
  attribution: boolean;
  ledger: { prefix: string; entityType: string };
  /**
   * The registry credential this connector reads, the provider types it accepts and the host it must
   * be pinned to (spec 055); absent for github.
   */
  credential?: { ref: string; accepts: readonly CredentialType[]; pin?: HostPin };
  /** Whether this deployment can reach the connector at all; cheap, used at thread setup. */
  configured(): Promise<boolean>;
  /** The engine definition, or why the connector is not connected in this deployment. */
  definition(): Promise<ConnectorDefinition<Scope> | { notConnected: string }>;
  connect?: typeof connectMcp;
}

export interface ConnectorTypeContext {
  githubMcp?: GitHubMcpDependencies;
  credentialRegistry?: ConnectorCredentials;
  /** A vendor connection override, for a connector type with no deployment connect of its own. Only test types use this today. */
  connect?: typeof connectMcp;
  /**
   * Checks a company's MCP endpoint before every request and pins the connection to the addresses it checked (`mcpEndpointGuard`). Only
   * the types whose address a person typed (`HOST_TYPED_CONNECTOR_TYPES`: `mcp`, and Grafana's runtime connector) go through it; a vendor's own endpoint (Linear, Jira, Asana, GitHub) does not.
   */
  endpointGuard?: McpEndpointGuard;
  /**
   * The fetch under every native connector's vendor requests, which hold it to the vendor's one host and refuse a redirect
   * (`connectors/native/vendor-fetch.ts`). Absent, the connectors use the lookup-checked fetch that refuses a non-public address at connect time; a test passes a fake.
   */
  nativeFetch?: typeof fetch;
}

/** A stored connectors entry. Only its name and type are known before its type validates the rest. */
export type StoredConnectorConfig = { name: string; type: string } & Record<string, unknown>;

export interface ConnectorType {
  type: string;
  /** Returns `{ unusable }`, with a reason, when the configuration cannot be served by this type. */
  resolve(config: StoredConnectorConfig, project: ProjectDefinition, context: ConnectorTypeContext): ResolvedConnector | { unusable: string };
}
