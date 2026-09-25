import { LinearConnectorSchema, type CredentialType } from "@agentx/contracts";
import { linearConnector, type LinearTeamScope } from "@agentx/gateway";
import { connectorLedgerKeys } from "./connector-ledger.js";
import type { ConnectorType, ResolvedConnector } from "./connector-types.js";

const ACCEPTS: readonly CredentialType[] = ["static-secret"];
const NOT_CONFIGURED = "connector credentials are not configured in this deployment";

/** Linear: one scope per team, all read through one static-secret API key from the registry. */
export const linearConnectorType: ConnectorType = {
  type: "linear",
  resolve(config, _project, context) {
    // Stored data is validated here, not trusted: a malformed entry is unusable, never a throw.
    const parsed = LinearConnectorSchema.safeParse(config);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] === undefined ? "entry" : String(issue.path[0])))];
      return { unusable: `invalid linear connector configuration: ${fields.join(", ")}` };
    }
    const { name, credentialRef, scopes, tools, attribution } = parsed.data;
    const registry = context.credentialRegistry;
    const connector: ResolvedConnector<LinearTeamScope> = {
      name,
      type: "linear",
      label: "Linear issues",
      vendor: "Linear",
      scopeNoun: "team",
      scopes: scopes.map((scope) => ({ alias: scope.alias, scope: { alias: scope.alias, teamId: scope.teamId.toLowerCase() } })),
      policy: { tools },
      approvals: tools,
      attribution: attribution ?? true,
      ledger: connectorLedgerKeys(name),
      credential: { ref: credentialRef, accepts: ACCEPTS },
      ...(context.connect ? { connect: context.connect } : {}),
      configured: async () => (await registry?.typeOf(credentialRef)) === "static-secret",
      async definition() {
        if (!registry) return { notConnected: NOT_CONFIGURED };
        const type = await registry.typeOf(credentialRef);
        if (type === undefined) return { notConnected: `credential ${credentialRef} is not registered` };
        if (type !== "static-secret") return { notConnected: `credential ${credentialRef} is ${type}; a Linear connector needs a static-secret API key` };
        return linearConnector(registry.provider(credentialRef));
      },
    };
    return connector;
  },
};
