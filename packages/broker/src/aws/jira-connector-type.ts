import { JiraConnectorSchema, type CredentialType } from "@agentx/contracts";
import { jiraApprovals, jiraConnector, type JiraScope } from "@agentx/gateway";
import { connectorLedgerKeys } from "./connector-ledger.js";
import type { ConnectorType, ResolvedConnector } from "./connector-types.js";

const ACCEPTS: readonly CredentialType[] = ["static-secret"];
const NOT_CONFIGURED = "connector credentials are not configured in this deployment";
const MAX_REASON = 300;

/** Jira through Atlassian's Rovo MCP server, with a service-account API token (static secret). */
export const jiraConnectorType: ConnectorType = {
  type: "jira",
  resolve(config, _project, context) {
    // Stored data is validated here, not trusted: a malformed entry is unusable, never a throw.
    const parsed = JiraConnectorSchema.safeParse(config);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] === undefined ? "entry" : String(issue.path[0])))];
      // Rule messages name only the connector, its scopes and its tools, never a credential value.
      const rules = parsed.error.issues.filter((issue) => issue.code === "custom").map((issue) => issue.message);
      const reason = [`invalid jira connector configuration: ${fields.join(", ")}`, ...rules].join("; ");
      return { unusable: reason.slice(0, MAX_REASON) };
    }
    const jira = parsed.data;
    const registry = context.credentialRegistry;
    const projectScoped = jira.scopes.every((scope) => scope.projectKey !== undefined);
    const connector: ResolvedConnector<JiraScope> = {
      name: jira.name,
      type: "jira",
      label: "Jira issues",
      vendor: "Jira",
      scopeNoun: projectScoped ? "Jira project" : "Jira site",
      scopes: jira.scopes.map((scope) => ({ alias: scope.alias, scope })),
      policy: { tools: jira.tools },
      approvals: jiraApprovals(jira.tools, jira.scopes),
      attribution: jira.attribution !== false,
      ledger: connectorLedgerKeys(jira.name),
      credential: { ref: jira.credentialRef, accepts: ACCEPTS },
      configured: async () => (await registry?.typeOf(jira.credentialRef)) === "static-secret",
      async definition() {
        if (!registry) return { notConnected: NOT_CONFIGURED };
        const type = await registry.typeOf(jira.credentialRef);
        if (type === undefined) return { notConnected: `credential ${jira.credentialRef} is not registered` };
        // Atlassian's MCP refuses service-account OAuth tokens, so only a static API token works.
        if (type !== "static-secret") return { notConnected: `credential ${jira.credentialRef} is ${type}; a Jira connector needs a static-secret API token` };
        return jiraConnector(registry.provider(jira.credentialRef), { projectScoped });
      },
      ...(context.connect ? { connect: context.connect } : {}),
    };
    return connector;
  },
};
