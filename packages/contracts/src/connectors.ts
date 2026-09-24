import { z } from "zod";
import { ToolApprovalListSchema } from "./github-mcp.js";
import { AGENTX_NAME_PATTERN } from "./names.js";

/** Becomes the tool prefix `<name>__<tool>`, so it is short and lowercase. */
export const ConnectorNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,19}$/);
const RepositoryNameSchema = z.string().regex(AGENTX_NAME_PATTERN);

/** GitHub uses each scoped repository's own GitHub App credential, as feature 007 does. */
export const GitHubConnectorSchema = z.object({
  name: ConnectorNameSchema,
  type: z.literal("github"),
  scopes: z.union([
    z.literal("all-repositories"),
    z.array(RepositoryNameSchema).min(1).max(32).refine((names) => new Set(names).size === names.length, "connector scopes must be unique"),
  ]),
  tools: ToolApprovalListSchema,
}).strict();

export const ConnectorConfigSchema = z.discriminatedUnion("type", [GitHubConnectorSchema]);

export const ConnectorsSchema = z.array(ConnectorConfigSchema).min(1).max(8).superRefine((connectors, context) => {
  if (new Set(connectors.map((connector) => connector.name)).size !== connectors.length) {
    context.addIssue({ code: "custom", message: "connector names must be unique" });
  }
  if (connectors.filter((connector) => connector.type === "github").length > 1) {
    context.addIssue({ code: "custom", message: "at most one github connector is supported" });
  }
});

export type GitHubConnectorConfig = z.infer<typeof GitHubConnectorSchema>;
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;
