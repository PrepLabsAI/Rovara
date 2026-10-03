import { JiraConnectorSchema } from "@agentx/contracts";
import { JIRA_MCP_ENDPOINT, jiraApprovals, jiraConnector, type JiraScope } from "@agentx/gateway";
import { presetConnectorType } from "./connector-presets.js";

/** Jira through Atlassian's Rovo MCP server, with a service-account API token (static secret). */
export const jiraConnectorType = presetConnectorType<typeof JiraConnectorSchema._output, JiraScope>({
  type: "jira",
  schema: JiraConnectorSchema,
  describe(jira) {
    const projectScoped = jira.scopes.every((scope) => scope.projectKey !== undefined);
    return {
      label: "Jira issues",
      vendor: "Jira",
      scopeNoun: projectScoped ? "Jira project" : "Jira site",
      scopes: jira.scopes.map((scope) => ({ alias: scope.alias, scope })),
      approvals: jiraApprovals(jira.tools, jira.scopes),
      endpoint: JIRA_MCP_ENDPOINT,
      requireHostPin: false,
      accepts: ["static-secret"],
      // Atlassian's MCP refuses service-account OAuth tokens, so only a static API token works.
      wrongType: (ref, type) => `credential ${ref} is ${type}; a Jira connector needs a static-secret API token`,
      definition: (credentials) => jiraConnector(credentials, { projectScoped }),
    };
  },
});
