import { AsanaConnectorSchema, type CredentialType } from "@agentx/contracts";
import { ASANA_TOKEN_ENDPOINT, asanaConnector, type AsanaProjectScope } from "@agentx/gateway";
import { connectorLedgerKeys } from "./connector-ledger.js";
import type { ConnectorType, ResolvedConnector } from "./connector-types.js";

const ACCEPTS: readonly CredentialType[] = ["oauth-refresh-token"];
const NOT_CONFIGURED = "connector credentials are not configured in this deployment";
const MAX_REASON = 300;

/** Asana through its hosted MCP server, as a bot user signed in once (oauth-refresh-token). */
export const asanaConnectorType: ConnectorType = {
  type: "asana",
  resolve(config, _project, context) {
    // Stored data is validated here, not trusted: a malformed entry is unusable, never a throw.
    const parsed = AsanaConnectorSchema.safeParse(config);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] === undefined ? "entry" : String(issue.path[0])))];
      // Rule messages name only the connector, its scopes and its tools, never a credential value.
      const rules = parsed.error.issues.filter((issue) => issue.code === "custom").map((issue) => issue.message);
      return { unusable: [`invalid asana connector configuration: ${fields.join(", ")}`, ...rules].join("; ").slice(0, MAX_REASON) };
    }
    const asana = parsed.data;
    const registry = context.credentialRegistry;
    const connector: ResolvedConnector<AsanaProjectScope> = {
      name: asana.name,
      type: "asana",
      label: "Asana tasks",
      vendor: "Asana",
      scopeNoun: "Asana project",
      scopes: asana.scopes.map((scope) => ({ alias: scope.alias, scope: { alias: scope.alias, projectGid: scope.projectGid } })),
      policy: { tools: asana.tools },
      approvals: asana.tools,
      attribution: asana.attribution !== false,
      ledger: connectorLedgerKeys(asana.name),
      credential: { ref: asana.credentialRef, accepts: ACCEPTS },
      configured: async () => (await registry?.typeOf(asana.credentialRef)) === "oauth-refresh-token",
      async definition() {
        if (!registry) return { notConnected: NOT_CONFIGURED };
        const type = await registry.typeOf(asana.credentialRef);
        if (type === undefined) return { notConnected: `credential ${asana.credentialRef} is not registered` };
        // Asana's MCP server takes only OAuth user tokens: no API keys and no client credentials.
        if (type !== "oauth-refresh-token") return { notConnected: `credential ${asana.credentialRef} is ${type}; an Asana connector needs an oauth-refresh-token credential from agentx admin credential authorize` };
        return asanaConnector(registry.provider(asana.credentialRef, { tokenEndpoint: ASANA_TOKEN_ENDPOINT, accepts: ACCEPTS }));
      },
      ...(context.connect ? { connect: context.connect } : {}),
    };
    return connector;
  },
};
