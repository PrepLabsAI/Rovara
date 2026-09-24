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
  attribution: z.boolean().optional(),
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

/** Six in-house tools when recovery tools are shown; kept equal to ORCHESTRATION_TOOL_NAMES by a test. */
export const IN_HOUSE_TOOL_COUNT = 6;
export const TOOL_WARNING_THRESHOLD = 20;
export const TOOL_LIMIT = 40;

interface ConnectorApprovals {
  integrations?: {
    githubMcp?: { tools: ReadonlyArray<{ name: string }> } | undefined;
    connectors?: ReadonlyArray<{ name: string; tools: ReadonlyArray<{ name: string }> }> | undefined;
  } | undefined;
}

export function approvedToolCount(definition: ConnectorApprovals): number {
  const legacy = definition.integrations?.githubMcp?.tools.length ?? 0;
  return legacy + (definition.integrations?.connectors ?? []).reduce((sum, connector) => sum + connector.tools.length, 0);
}

/** The most tools the model could see: every in-house tool plus every approval. */
export function toolBudget(approved: number): { maximum: number; warning?: string; refusal?: string } {
  const maximum = IN_HOUSE_TOOL_COUNT + approved;
  if (maximum > TOOL_LIMIT) return { maximum, refusal: `this project could expose ${maximum} tools; at most ${TOOL_LIMIT} are allowed. Approve fewer connector tools.` };
  if (maximum > TOOL_WARNING_THRESHOLD) return { maximum, warning: `the model could see ${maximum} tools; above ${TOOL_WARNING_THRESHOLD}, tool choice gets less reliable. Approve fewer connector tools.` };
  return { maximum };
}

export function presentedNameProblems(definition: ConnectorApprovals): string[] {
  const connectors = definition.integrations?.githubMcp
    ? [{ name: "github", tools: definition.integrations.githubMcp.tools }]
    : definition.integrations?.connectors ?? [];
  return connectors.flatMap((connector) => connector.tools
    .map((tool) => `${connector.name}__${tool.name}`)
    .filter((presented) => presented.length > 64)
    .map((presented) => `connector ${connector.name} tool ${presented.slice(connector.name.length + 2)}: presented name ${presented} exceeds 64 characters`));
}

export const ConnectorPreflightSchema = z.object({
  name: ConnectorNameSchema,
  status: z.enum(["connected", "not_connected", "unavailable"]),
  problem: z.string().max(512).optional(),
  offered: z.array(z.string().max(64)).max(40),
  skipped: z.array(z.object({ tool: z.string().max(64), reason: z.string().max(256) }).strict()).max(64),
}).strict();

export const RegistrationPreflightSchema = z.object({
  connectors: z.array(ConnectorPreflightSchema).max(8),
}).strict();

export type ConnectorPreflight = z.infer<typeof ConnectorPreflightSchema>;
export type RegistrationPreflight = z.infer<typeof RegistrationPreflightSchema>;
