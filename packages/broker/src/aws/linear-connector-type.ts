import { LinearConnectorSchema } from "@agentx/contracts";
import { LINEAR_MCP_ENDPOINT, linearConnector, type LinearTeamScope } from "@agentx/gateway";
import { presetConnectorType } from "./connector-presets.js";

/** Linear: one scope per team, all read through one static-secret API key from the registry. */
export const linearConnectorType = presetConnectorType<typeof LinearConnectorSchema._output, LinearTeamScope>({
  type: "linear",
  schema: LinearConnectorSchema,
  describe: (linear) => ({
    label: "Linear issues",
    vendor: "Linear",
    scopeNoun: "team",
    scopes: linear.scopes.map((scope) => ({ alias: scope.alias, scope: { alias: scope.alias, teamId: scope.teamId.toLowerCase() } })),
    endpoint: LINEAR_MCP_ENDPOINT,
    requireHostPin: false,
    accepts: ["static-secret"],
    wrongType: (ref, type) => `credential ${ref} is ${type}; a Linear connector needs a static-secret API key`,
    definition: linearConnector,
  }),
});
