import { z } from "zod";
import { ItemPathSchema } from "./item-paths.js";
import { GitHubMcpResultSchema, McpToolNameSchema, ToolApprovalListSchema } from "./github-mcp.js";
import { AGENTX_NAME_PATTERN } from "./names.js";

/** Becomes the tool prefix `<name>__<tool>`, so it is short and lowercase. */
export const ConnectorNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,19}$/);

/** The Jira tools AgentX can hold to one project, and the access each must be approved with. */
export const JIRA_PROJECT_TOOL_ACCESS = {
  getJiraIssue: "read",
  searchJiraIssuesUsingJql: "read",
  createJiraIssue: "write",
  editJiraIssue: "write",
  transitionJiraIssue: "write",
  addOrEditJiraIssueComment: "write",
} as const satisfies Record<string, "read" | "write">;

/**
 * The Asana tools AgentX can hold to one project, and the access each must be approved with.
 * An Asana connector may approve only these.
 */
export const ASANA_PROJECT_TOOL_ACCESS = {
  get_task: "read",
  get_task_stories: "read",
  get_tasks: "read",
  search_tasks: "read",
  get_project: "read",
  create_tasks: "write",
  update_tasks: "write",
  add_comment: "write",
} as const satisfies Record<string, "read" | "write">;

const RepositoryNameSchema = z.string().regex(AGENTX_NAME_PATTERN);

/** A scope alias such as a repository name. */
export const ConnectorAliasSchema = z.string().regex(AGENTX_NAME_PATTERN);

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

const JiraScopeSchema = z.object({
  alias: ConnectorAliasSchema,
  /** Atlassian site UUID, from https://<site>.atlassian.net/_edge/tenant_info. */
  cloudId: z.guid()
    .regex(/^[0-9a-f-]+$/, "cloudId must be lowercase")
    .refine((id) => id !== "00000000-0000-0000-0000-000000000000", "cloudId must not be the nil UUID"),
  /**
   * The site's web address, so AgentX can tell the model how to link an issue in a reply instead of
   * it guessing a host. Strictly `https://<site>.atlassian.net`: no path, no trailing slash, and a
   * lowercase host. Optional so a stored config from before this field keeps working.
   */
  siteUrl: z.string().regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?\.atlassian\.net$/,
    "siteUrl must be exactly https://<site>.atlassian.net, with no path, no trailing slash, a lowercase host and no leading or trailing hyphen in the site name").optional(),
  /** Jira project keys are 2 to 10 characters; a longer key is refused. */
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,9}$/).optional(),
}).strict();

/**
 * Jira reads a static-secret service-account API token through the credential registry. Each
 * scope is one Atlassian site, optionally held to one project. The project guard does nothing
 * for a scope without a projectKey, so a project-scoped connector sets it on every scope and
 * approves only the tools the guard can hold to the project.
 */
export const JiraConnectorSchema = z.object({
  name: ConnectorNameSchema,
  type: z.literal("jira"),
  credentialRef: z.string().regex(AGENTX_NAME_PATTERN),
  identity: z.literal("service").optional(),
  scopes: z.array(JiraScopeSchema).min(1).max(32),
  tools: ToolApprovalListSchema,
  attribution: z.boolean().optional(),
}).strict().superRefine((connector, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message: `connector ${connector.name}: ${message}` });
  const aliases = connector.scopes.map((scope) => scope.alias);
  if (new Set(aliases).size !== aliases.length) issue("scope aliases must be unique");
  const seen = new Map<string, string>();
  for (const scope of connector.scopes) {
    const key = `${scope.cloudId.toLowerCase()}/${scope.projectKey ?? ""}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) issue(`scopes ${earlier} and ${scope.alias} address the same Jira site and project`);
    else seen.set(key, scope.alias);
  }
  const keyed = connector.scopes.filter((scope) => scope.projectKey !== undefined).length;
  if (keyed !== 0 && keyed !== connector.scopes.length) issue("set projectKey on every scope or on none");
  const guarded = Object.keys(JIRA_PROJECT_TOOL_ACCESS);
  for (const tool of connector.tools) {
    const pinned = Object.hasOwn(JIRA_PROJECT_TOOL_ACCESS, tool.name) ? (JIRA_PROJECT_TOOL_ACCESS as Record<string, "read" | "write">)[tool.name] : undefined;
    if (pinned !== undefined && tool.access !== pinned) issue(`tool ${tool.name} must be approved with access: ${pinned}`);
    if (keyed > 0 && pinned === undefined) {
      issue(`tool ${tool.name} cannot be limited to a Jira project; approve only ${guarded.join(", ")}, or remove projectKey from every scope`);
    }
  }
});


/** A Linear team UUID, in any case; resolvers lowercase it. */
const LinearTeamIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "teamId must be a Linear team UUID");

export const LinearScopeSchema = z.object({ alias: ConnectorAliasSchema, teamId: LinearTeamIdSchema }).strict();

/** Linear reads a static-secret API key through the credential registry; each scope is one team. */
export const LinearConnectorSchema = z.object({
  name: ConnectorNameSchema,
  type: z.literal("linear"),
  credentialRef: z.string().regex(AGENTX_NAME_PATTERN),
  scopes: z.array(LinearScopeSchema).min(1).max(32)
    .refine((scopes) => new Set(scopes.map((scope) => scope.alias)).size === scopes.length, "connector scope aliases must be unique")
    .refine((scopes) => new Set(scopes.map((scope) => scope.teamId.toLowerCase())).size === scopes.length, "connector scopes must name different teams"),
  tools: ToolApprovalListSchema,
  attribution: z.boolean().optional(),
}).strict();

/** An Asana project GID: the long number in the project's URL. */
const AsanaGidSchema = z.string().regex(/^[1-9][0-9]{0,19}$/, "projectGid must be an Asana project GID, the long number in the project's URL");

export const AsanaScopeSchema = z.object({ alias: ConnectorAliasSchema, projectGid: AsanaGidSchema }).strict();

/**
 * Asana reads an oauth-refresh-token credential (a bot user signed in once) through the credential
 * registry. Each scope is one Asana project, and only the tools the project guard can hold to a
 * project may be approved, each with its pinned access.
 */
export const AsanaConnectorSchema = z.object({
  name: ConnectorNameSchema,
  type: z.literal("asana"),
  credentialRef: z.string().regex(AGENTX_NAME_PATTERN),
  identity: z.literal("service").optional(),
  scopes: z.array(AsanaScopeSchema).min(1).max(32),
  tools: ToolApprovalListSchema,
  attribution: z.boolean().optional(),
}).strict().superRefine((connector, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message: `connector ${connector.name}: ${message}` });
  if (new Set(connector.scopes.map((scope) => scope.alias)).size !== connector.scopes.length) issue("scope aliases must be unique");
  if (new Set(connector.scopes.map((scope) => scope.projectGid)).size !== connector.scopes.length) issue("scopes must name different Asana projects");
  const guarded = Object.keys(ASANA_PROJECT_TOOL_ACCESS);
  for (const tool of connector.tools) {
    const pinned = Object.hasOwn(ASANA_PROJECT_TOOL_ACCESS, tool.name) ? (ASANA_PROJECT_TOOL_ACCESS as Record<string, "read" | "write">)[tool.name] : undefined;
    if (pinned === undefined) issue(`tool ${tool.name} cannot be limited to an Asana project; approve only ${guarded.join(", ")}`);
    else if (tool.access !== pinned) issue(`tool ${tool.name} must be approved with access: ${pinned}`);
  }
});

export const ConnectorConfigSchema = z.discriminatedUnion("type", [GitHubConnectorSchema, LinearConnectorSchema, JiraConnectorSchema, AsanaConnectorSchema]);

const KNOWN_CONNECTOR_TYPES = new Set(ConnectorConfigSchema.options.map((option) => option.shape.type.value as string));

/**
 * A connector entry whose type this release's schema does not know, for example one written by a
 * later control plane before a rollback. Only its name and type are checked; every other field
 * passes through unexamined, because a stored definition may carry a shape this release cannot
 * interpret. A `github` entry never matches this schema: it must match `GitHubConnectorSchema`
 * instead, so a malformed github connector still fails, never passes through as unknown.
 */
export const UnknownConnectorEntrySchema = z.object({
  name: ConnectorNameSchema,
  type: z.string().min(1).max(32),
}).passthrough().refine(
  (value) => !KNOWN_CONNECTOR_TYPES.has(value.type),
  "a known connector type must match its own schema, not the passthrough shape",
);

/**
 * A connector entry for a stored (already-registered) project definition: a known type validates
 * strictly, exactly as `ConnectorConfigSchema` does, and any other type passes through as
 * `UnknownConnectorEntrySchema`. Registration must still refuse an unknown type, so it parses with
 * `ConnectorConfigSchema` (via `ConnectorsSchema`), never with this one.
 */
export const StoredConnectorConfigSchema = z.union([ConnectorConfigSchema, UnknownConnectorEntrySchema]);

function connectorArrayChecks(connectors: ReadonlyArray<{ name: string; type: string }>, context: z.RefinementCtx): void {
  if (new Set(connectors.map((connector) => connector.name)).size !== connectors.length) {
    context.addIssue({ code: "custom", message: "connector names must be unique" });
  }
  if (connectors.filter((connector) => connector.type === "github").length > 1) {
    context.addIssue({ code: "custom", message: "at most one github connector is supported" });
  }
}

export const ConnectorsSchema = z.array(ConnectorConfigSchema).min(1).max(8).superRefine(connectorArrayChecks);
export const StoredConnectorsSchema = z.array(StoredConnectorConfigSchema).min(1).max(8).superRefine(connectorArrayChecks);

const SchemaHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * The two MCP tool annotations the action gate reads (feature 014). They come from the vendor, so
 * the gate lets them make a tool stricter, never looser.
 */
export const ToolHintsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
}).strict();

export const PresentedToolSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  upstreamName: McpToolNameSchema,
  description: z.string().max(2_048),
  inputSchema: z.record(z.string(), z.unknown()),
  access: z.enum(["read", "write"]),
  scopes: z.array(z.object({ alias: ConnectorAliasSchema, schemaHash: SchemaHashSchema }).strict()).min(1).max(32),
  // The two fields below are sent only to a Slack service that sends x-agentx-include: gate;
  // older services parse this schema strictly (feature 014).
  hints: ToolHintsSchema.optional(),
  /**
   * The connector's item argument paths (item-paths.ts) that this tool's schema offers, in the
   * connector's order; a call that sets any of them names an existing item. Empty when the connector
   * declares paths and this tool offers none (so a call creates), absent when the connector declares
   * none.
   */
  itemArguments: z.array(ItemPathSchema).max(16).optional(),
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
  type: ConnectorNameSchema,
  label: z.string().min(1).max(64),
  scopes: z.array(ConnectorAliasSchema).max(32),
  connected: z.boolean(),
}).strict();

export type ToolHints = z.infer<typeof ToolHintsSchema>;
export type PresentedTool = z.infer<typeof PresentedToolSchema>;
export type ConnectorCatalog = z.infer<typeof ConnectorCatalogSchema>;
export type ConnectorCallRequest = z.infer<typeof ConnectorCallRequestSchema>;
export type ConnectorResult = z.infer<typeof ConnectorResultSchema>;
export type ThreadConnector = z.infer<typeof ThreadConnectorSchema>;

export type GitHubConnectorConfig = z.infer<typeof GitHubConnectorSchema>;
export type JiraConnectorConfig = z.infer<typeof JiraConnectorSchema>;
export type LinearConnectorConfig = z.infer<typeof LinearConnectorSchema>;
export type AsanaConnectorConfig = z.infer<typeof AsanaConnectorSchema>;
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

/** Each connector's name and approved tools. The feature 007 githubMcp policy reads as a connector named github. */
export function connectorApprovals(definition: ConnectorApprovals): Array<{ name: string; tools: ReadonlyArray<{ name: string }> }> {
  return definition.integrations?.githubMcp
    ? [{ name: "github", tools: definition.integrations.githubMcp.tools }]
    : [...(definition.integrations?.connectors ?? [])];
}

export function presentedNameProblems(definition: ConnectorApprovals): string[] {
  const connectors = connectorApprovals(definition);
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
