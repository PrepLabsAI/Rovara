import { AsanaConnectorSchema } from "@agentx/contracts";
import { ASANA_MCP_ENDPOINT, ASANA_TOKEN_ENDPOINT, asanaConnector, type AsanaProjectScope } from "@agentx/gateway";
import { presetConnectorType } from "./connector-presets.js";

/** Asana through its hosted MCP server, as a bot user signed in once (oauth-refresh-token). */
export const asanaConnectorType = presetConnectorType<typeof AsanaConnectorSchema._output, AsanaProjectScope>({
  type: "asana",
  schema: AsanaConnectorSchema,
  describe: (asana) => ({
    label: "Asana tasks",
    vendor: "Asana",
    scopeNoun: "Asana project",
    scopes: asana.scopes.map((scope) => ({ alias: scope.alias, scope: { alias: scope.alias, projectGid: scope.projectGid } })),
    endpoint: ASANA_MCP_ENDPOINT,
    requireHostPin: false,
    accepts: ["oauth-refresh-token"],
    // Asana's MCP server takes only OAuth user tokens: no API keys and no client credentials.
    wrongType: (ref, type) => `credential ${ref} is ${type}; an Asana connector needs an oauth-refresh-token credential from agentx admin credential authorize`,
    tokenEndpoint: ASANA_TOKEN_ENDPOINT,
    definition: asanaConnector,
  }),
});
