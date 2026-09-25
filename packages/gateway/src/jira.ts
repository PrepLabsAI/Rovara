import { JIRA_PROJECT_TOOL_ACCESS } from "@agentx/contracts";
import { GuardRejection, type Binder, type ConnectorDefinition, type CredentialProvider, type Guard } from "./types.js";
import { limitJqlToProject } from "./jira-jql.js";
import { isObject, resultText } from "./util.js";
import type { McpToolResult } from "./mcp-client.js";

/** v2 is the endpoint that accepts API tokens; v1 ignores them. */
export const JIRA_MCP_ENDPOINT = new URL("https://mcp.atlassian.com/v2/mcp");

export interface JiraScope { alias: string; cloudId: string; projectKey?: string | undefined }

const ISSUE_REF = /^(?:[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]{0,9}|[1-9][0-9]{0,17})$/;
const KEYED_TOOLS = new Set(["getJiraIssue", "editJiraIssue", "transitionJiraIssue", "addOrEditJiraIssueComment"]);
/** Free-form field objects a tool accepts, where a project or parent could hide. */
const FIELD_OBJECTS: Readonly<Record<string, readonly string[]>> = {
  createJiraIssue: ["additional_fields"],
  editJiraIssue: ["fields", "additional_fields"],
  transitionJiraIssue: ["fields", "update"],
};
/** editJiraIssue's rank anchors name another issue, which must be in the project too. */
const RANK_ANCHORS = ["rankAfterIssue", "rankBeforeIssue"] as const;
const NO_SCOPE = "The Jira project check could not run, so AgentX did not run this call.";

/**
 * cloudId is strict: every approved tool must require it, and tools without it are skipped.
 * projectKey binds only on tools that declare it, and only for a project-scoped connector; a
 * missing value then fails closed in the engine (5b).
 */
export function jiraBinder(projectScoped: boolean): Binder<JiraScope> {
  return projectScoped
    ? { properties: ["cloudId"], optionalProperties: ["projectKey"], bind: (scope) => ({ cloudId: scope.cloudId, projectKey: scope.projectKey }) }
    : { properties: ["cloudId"], bind: (scope) => ({ cloudId: scope.cloudId }) };
}

function jiraScopeOf(value: unknown): JiraScope | undefined {
  if (!isObject(value) || typeof value.cloudId !== "string") return undefined;
  if (value.projectKey !== undefined && typeof value.projectKey !== "string") return undefined;
  return value as unknown as JiraScope;
}

function issueRef(value: unknown, projectKey: string): string {
  if (typeof value === "string" && ISSUE_REF.test(value)) return value;
  throw new GuardRejection(`Pass the Jira issue key (for example ${projectKey}-123) or its numeric ID, not a URL or other text.`);
}

function parentRef(value: unknown, projectKey: string): string {
  if (typeof value === "string") return issueRef(value, projectKey);
  if (isObject(value) && typeof value.key === "string") return issueRef(value.key, projectKey);
  if (isObject(value) && typeof value.id === "string") return issueRef(value.id, projectKey);
  throw new GuardRejection(`Give the parent as an issue key (for example ${projectKey}-10).`);
}

/** Every issue the call names that must be in the project; throws on a project change. */
function issueReferences(tool: string, args: Readonly<Record<string, unknown>>, projectKey: string): string[] {
  const refs: string[] = [];
  if (KEYED_TOOLS.has(tool)) refs.push(issueRef(args.issueIdOrKey, projectKey));
  if (tool === "createJiraIssue" && args.parent !== undefined) refs.push(parentRef(args.parent, projectKey));
  if (tool === "editJiraIssue") {
    for (const anchor of RANK_ANCHORS) if (args[anchor] !== undefined) refs.push(issueRef(args[anchor], projectKey));
  }
  for (const field of FIELD_OBJECTS[tool] ?? []) {
    const values = args[field];
    if (!isObject(values)) continue;
    for (const [name, value] of Object.entries(values)) {
      const lower = name.toLowerCase();
      if (lower === "project" || lower === "pid") throw new GuardRejection("This connector cannot change an issue's project.");
      if (lower === "issuelinks") throw new GuardRejection("This connector cannot link issues, because a link can reach an issue in another project.");
      if (lower === "parent" || lower === "parent link") refs.push(parentRef(value, projectKey));
    }
  }
  return [...new Set(refs)];
}

/** True when `key` is exactly `<projectKey>-<number>`; no pattern is built from configuration. */
function isKeyInProject(key: string, projectKey: string): boolean {
  const prefix = `${projectKey}-`;
  return key.startsWith(prefix) && /^[1-9][0-9]*$/.test(key.slice(prefix.length));
}

/** The live getJiraIssue result (2026-09-24) is `{ data: { id, key, fields } }`. No other shape is trusted. */
function issueKeyOf(result: McpToolResult): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(resultText(result)); } catch { return undefined; }
  return isObject(parsed) && isObject(parsed.data) && typeof parsed.data.key === "string" ? parsed.data.key : undefined;
}

/**
 * Defence in depth behind the service account's own Jira permissions: keeps every call inside
 * the scope's project. Does nothing for a scope without a projectKey.
 */
export const jiraProjectGuard: Guard = {
  requiredTools: (tool) => tool !== "getJiraIssue" && (KEYED_TOOLS.has(tool) || Object.hasOwn(FIELD_OBJECTS, tool)) ? ["getJiraIssue"] : [],
  // 5b: synchronous and pure; returns the whole argument object; bound values are merged after it.
  rewrite({ tool, arguments: args, scope }) {
    if (tool !== "searchJiraIssuesUsingJql") return { ...args };
    const jira = jiraScopeOf(scope);
    if (!jira) throw new GuardRejection(NO_SCOPE);
    if (jira.projectKey === undefined) return { ...args };
    const limited = limitJqlToProject(typeof args.jql === "string" ? args.jql : "", jira.projectKey);
    if ("refused" in limited) {
      throw new GuardRejection(`This JQL cannot be limited to Jira project ${jira.projectKey}: ${limited.refused}. AgentX adds "project = ${jira.projectKey}" itself; send only the rest of the query.`);
    }
    return { ...args, jql: limited.jql };
  },
  async check({ tool, arguments: args, connection, scope }) {
    const jira = jiraScopeOf(scope);
    if (!jira) throw new GuardRejection(NO_SCOPE);
    const projectKey = jira.projectKey;
    if (projectKey === undefined) return;
    if (!Object.hasOwn(JIRA_PROJECT_TOOL_ACCESS, tool)) {
      throw new GuardRejection(`${tool} cannot be limited to Jira project ${projectKey}, so this connector does not run it.`);
    }
    // The binder sets projectKey on a project-scoped create; this also covers a scope and connector that disagree.
    if (tool === "createJiraIssue" && args.projectKey !== undefined && args.projectKey !== projectKey) {
      throw new GuardRejection(`This connector works only in Jira project ${projectKey}.`);
    }
    for (const ref of issueReferences(tool, args, projectKey)) {
      const result = await connection.call("getJiraIssue", { cloudId: jira.cloudId, issueIdOrKey: ref });
      if (result.isError) throw new GuardRejection(`Could not read Jira issue ${ref} to check its project. It may not exist, or AgentX's Jira account cannot see it.`);
      const key = issueKeyOf(result);
      if (key === undefined) throw new GuardRejection(`Could not confirm which project Jira issue ${ref} is in, so AgentX did not run this call.`);
      if (!isKeyInProject(key, projectKey)) {
        throw new GuardRejection(`Jira issue ${ref} is not in project ${projectKey}. This connector works only in ${projectKey}.`);
      }
    }
  },
};

export function jiraConnector(credentials: CredentialProvider<JiraScope>, options: { projectScoped: boolean }): ConnectorDefinition<JiraScope> {
  return {
    label: "Jira",
    endpoint: JIRA_MCP_ENDPOINT,
    permissionsHint: "the service account's API token (complete, not expired), API token authentication in the Rovo MCP server settings, and the service account's Jira project access",
    credentials,
    binder: jiraBinder(options.projectScoped),
    guards: [jiraProjectGuard],
    attributionKeys: ["description", "commentBody"],
  };
}
