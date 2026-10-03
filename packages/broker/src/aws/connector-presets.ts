import { McpConnectorSchema, type CredentialType, type McpConnectorConfig } from "@agentx/contracts";
import { genericScopes, mcpConnector, type ConnectorDefinition, type CredentialProvider, type GenericScope, type PresentationApproval, type ToolApproval } from "@agentx/gateway";
import type { z } from "zod";
import { connectorLedgerKeys } from "./connector-ledger.js";
import type { ConnectorScope, ConnectorType, ResolvedConnector } from "./connector-types.js";
import { hostPinProblem, type HostPin } from "./credentials.js";

/**
 * Spec 055: every connector type except github is a preset over one generic resolver. A preset maps
 * its validated stored configuration to plain data (labels, scopes, endpoint, credential needs) and
 * an engine definition. The generic `mcp` type is the preset whose description is the configuration.
 */

const NOT_CONFIGURED = "connector credentials are not configured in this deployment";
const MAX_REASON = 300;

/** What every stored connector entry a preset serves carries. */
interface PresetConfig {
  name: string;
  credentialRef: string;
  tools: ToolApproval[];
  attribution?: boolean | undefined;
}

export interface PresetDescription<Scope> {
  /** Thread and manifest label, for example "Linear issues". */
  label: string;
  /** Vendor name in messages and descriptions, for example "Linear". */
  vendor: string;
  scopeNoun: string;
  scopes: ReadonlyArray<ConnectorScope<Scope>>;
  /** The approvals as presented; defaults to the configured tools. */
  approvals?: readonly PresentationApproval[];
  endpoint: URL;
  requireHostPin: boolean;
  accepts: readonly CredentialType[];
  /** Why a credential of another type cannot serve this connector. */
  wrongType(ref: string, type: CredentialType): string;
  /** The OAuth token endpoint, for a preset whose credentials refresh. */
  tokenEndpoint?: URL;
  definition(credentials: CredentialProvider<Scope>): ConnectorDefinition<Scope>;
}

export interface ConnectorPreset<Config extends PresetConfig, Scope> {
  type: string;
  schema: z.ZodType<Config>;
  describe(config: Config): PresetDescription<Scope>;
}

/** The ConnectorType that serves a preset: validates stored data, then resolves it through the shared path. */
export function presetConnectorType<Config extends PresetConfig, Scope>(preset: ConnectorPreset<Config, Scope>): ConnectorType {
  return {
    type: preset.type,
    resolve(config, _project, context) {
      // Stored data is validated here, not trusted: a malformed entry is unusable, never a throw.
      const parsed = preset.schema.safeParse(config);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] === undefined ? "entry" : String(issue.path[0])))];
        // Rule messages name only the connector, its scopes and its tools, never a credential value.
        const rules = parsed.error.issues.filter((issue) => issue.code === "custom").map((issue) => issue.message);
        return { unusable: [`invalid ${preset.type} connector configuration: ${fields.join(", ")}`, ...rules].join("; ").slice(0, MAX_REASON) };
      }
      const stored = parsed.data;
      const described = preset.describe(stored);
      const registry = context.credentialRegistry;
      const ref = stored.credentialRef;
      const pin: HostPin = { host: described.endpoint.hostname, required: described.requireHostPin };
      /** The registered credential's problem for this connector, or undefined when it can serve it. */
      const credentialProblem = async (): Promise<string | undefined> => {
        if (!registry) return NOT_CONFIGURED;
        const record = await registry.registration(ref);
        const type = record?.type ?? await registry.typeOf(ref);
        if (type === undefined) return `credential ${ref} is not registered`;
        if (!described.accepts.includes(type)) return described.wrongType(ref, type);
        return hostPinProblem(ref, record?.host, pin);
      };
      const connector: ResolvedConnector<Scope> = {
        name: stored.name,
        type: preset.type,
        label: described.label,
        vendor: described.vendor,
        scopeNoun: described.scopeNoun,
        scopes: described.scopes,
        policy: { tools: stored.tools },
        approvals: described.approvals ?? stored.tools,
        attribution: stored.attribution !== false,
        ledger: connectorLedgerKeys(stored.name),
        credential: { ref, accepts: described.accepts, pin },
        configured: async () => await credentialProblem() === undefined,
        async definition() {
          const problem = await credentialProblem();
          if (problem !== undefined || !registry) return { notConnected: problem ?? NOT_CONFIGURED };
          return described.definition(registry.provider(ref, {
            accepts: described.accepts, pin,
            ...(described.tokenEndpoint ? { tokenEndpoint: described.tokenEndpoint } : {}),
          }));
        },
        ...(context.connect ? { connect: context.connect } : {}),
      };
      return connector;
    },
  };
}

/**
 * Spec 055: any remote MCP server described by its configuration. Phase 1 serves static-secret
 * credentials only, pinned to the endpoint's host.
 */
export const MCP_PRESET: ConnectorPreset<McpConnectorConfig, GenericScope> = {
  type: "mcp",
  schema: McpConnectorSchema,
  describe(config) {
    return {
      label: config.label,
      vendor: config.vendor,
      scopeNoun: config.scopeNoun ?? "scope",
      scopes: genericScopes(config),
      endpoint: new URL(config.endpoint),
      requireHostPin: true,
      accepts: ["static-secret"],
      wrongType: (ref, type) => `credential ${ref} is ${type}; an mcp connector needs a static-secret credential`,
      definition: (credentials) => mcpConnector(config, credentials),
    };
  },
};

export const mcpConnectorType: ConnectorType = presetConnectorType(MCP_PRESET);
