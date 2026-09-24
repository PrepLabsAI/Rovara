import { z } from "zod";
import { GitHubMcpResultSchema, McpToolNameSchema, ToolApprovalListSchema } from "./github-mcp.js";
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

/** A scope alias such as a repository name. */
export const ConnectorAliasSchema = z.string().regex(AGENTX_NAME_PATTERN);
const SchemaHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const PresentedToolSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  upstreamName: McpToolNameSchema,
  description: z.string().max(2_048),
  inputSchema: z.record(z.string(), z.unknown()),
  access: z.enum(["read", "write"]),
  scopes: z.array(z.object({ alias: ConnectorAliasSchema, schemaHash: SchemaHashSchema }).strict()).min(1).max(32),
}).strict();

export const ConnectorCatalogSchema = z.object({
  connector: ConnectorNameSchema,
  notConnected: z.literal(true).optional(),
  tools: z.array(PresentedToolSchema).max(40),
  skipped: z.array(z.object({ tool: z.string().max(64), reason: z.string().max(256) }).strict()).max(64),
}).strict();

export const ConnectorCallRequestSchema = z.object({
  requestId: z.uuid(),
  scope: ConnectorAliasSchema,
  tool: McpToolNameSchema,
  schemaHash: SchemaHashSchema,
  arguments: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 65_536, "arguments exceed limit"),
}).strict();

export const ConnectorResultReasonSchema = z.enum(["not_connected", "schema_changed", "policy_denied", "vendor_error"]);
export const ConnectorResultSchema = GitHubMcpResultSchema.extend({ reason: ConnectorResultReasonSchema.optional() }).strict();

export const ThreadConnectorSchema = z.object({
  name: ConnectorNameSchema,
  type: z.literal("github"),
  label: z.string().min(1).max(64),
  scopes: z.array(ConnectorAliasSchema).max(32),
  connected: z.boolean(),
}).strict();

export type PresentedTool = z.infer<typeof PresentedToolSchema>;
export type ConnectorCatalog = z.infer<typeof ConnectorCatalogSchema>;
export type ConnectorCallRequest = z.infer<typeof ConnectorCallRequestSchema>;
export type ConnectorResult = z.infer<typeof ConnectorResultSchema>;
export type ThreadConnector = z.infer<typeof ThreadConnectorSchema>;

export type GitHubConnectorConfig = z.infer<typeof GitHubConnectorSchema>;
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;
