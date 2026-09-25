import { JIRA_PROJECT_TOOL_ACCESS } from "@agentx/contracts";
import { GuardRejection, type Binder, type ConnectorDefinition, type CredentialProvider, type Guard } from "./types.js";
import { limitJqlToProject } from "./jira-jql.js";
import { isObject } from "./util.js";
import type { McpToolResult } from "./mcp-client.js";

/** v2 is the endpoint that accepts API tokens; v1 ignores them. */
export const JIRA_MCP_ENDPOINT = new URL("https://mcp.atlassian.com/v2/mcp");

export interface JiraScope { alias: string; cloudId: string; projectKey?: string | undefined }

const ISSUE_KEY = /^[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]{0,9}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,17}$/;
const ISSUE_REF = new RegExp(`${ISSUE_KEY.source}|${NUMERIC_ID.source}`);
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

/** A parent names an issue by key, id or both; every one given is checked. null clears the parent. */
function parentRefs(value: unknown, projectKey: string): string[] {
  if (value === null) return [];
  if (typeof value === "string") return [issueRef(value, projectKey)];
  if (isObject(value) && (typeof value.key === "string" || typeof value.id === "string")) {
    return [value.key, value.id].filter((part) => part !== undefined).map((part) => issueRef(part, projectKey));
  }
  throw new GuardRejection(`Give the parent as an issue key (for example ${projectKey}-10).`);
}

/** Free text a field object can carry. A key in it is a mention, not a reference, so it is not walked. */
const TEXT_FIELDS = new Set(["description", "environment", "comment", "commentbody", "summary"]);
const MAX_REFERENCES = 10;
const MAX_DEPTH = 12;

/** Words that mark a field as naming another issue, so a bare numeric id under it is an issue id. */
const RELATION_WORDS = new Set([
  "parent", "parents", "epic", "link", "links", "linked", "issuelinks", "issue", "issues", "blocks",
  "relates", "duplicate", "duplicates", "clone", "clones", "cloned", "sub", "tasks", "subtask", "subtasks",
]);
/** Relation names written as one word, compared with separators removed. */
const RELATION_COMPOUNDS = new Set(["epiclink", "parentlink", "linkedissues", "issuelinks", "subtasks"]);
const RELATED_ISSUE_SHAPE = "Give each related Jira issue as its key (for example KAN-10) or numeric ID.";

type FieldKind = "type" | "relation" | "other";

/**
 * "Linked Issues", "outwardIssue", "Sub-tasks" and "epiclink" are relation names. A name with the
 * word "type" or ending in "type" (issuetype, "Issue Type", a link's type) is a type field; a name
 * that only contains it ("Prototype Issue") is not. See typeReferences for what under one is checked.
 */
function fieldKind(name: string): FieldKind {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = name.trim().replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  if (words.includes("type") || compact.endsWith("type")) return "type";
  if (RELATION_COMPOUNDS.has(compact)) return "relation";
  return words.some((word) => RELATION_WORDS.has(word)) ? "relation" : "other";
}

/** A reference under a relation field: trimmed and uppercased, and it must be a key or numeric id. */
function relatedRef(value: string | number): string {
  const ref = String(value).trim().toUpperCase();
  if (ISSUE_KEY.test(ref) || NUMERIC_ID.test(ref)) return ref;
  throw new GuardRejection(RELATED_ISSUE_SHAPE);
}

/**
 * Every issue reference inside a field object.
 * - Anywhere: an exact uppercase key-shaped string (for example OPS-1).
 * - Under a relation field: the field's value, each element of an array under it, and every
 *   `key`/`id`, normalised by relatedRef. An object there must carry `key` or `id`, unless it
 *   only holds further relation fields (a link's outwardIssue); a self-only object is refused.
 * Numeric ids elsewhere (priority, components, versions) are not issues and are ignored.
 * `position` is true when the value itself stands where a related issue is expected.
 */
function nestedReferences(value: unknown, refs: string[], relation = false, depth = 0, position = false): void {
  if (depth > MAX_DEPTH) throw new GuardRejection("These Jira fields are nested too deeply to check.");
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number") {
    if (position) refs.push(relatedRef(value));
    else if (typeof value === "string" && ISSUE_KEY.test(value)) refs.push(value);
    return;
  }
  if (Array.isArray(value)) { for (const item of value) nestedReferences(item, refs, relation, depth + 1, position); return; }
  if (!isObject(value)) return;
  const entries = Object.entries(value);
  if (position && !Object.hasOwn(value, "key") && !Object.hasOwn(value, "id") && !entries.some(([key]) => fieldKind(key) === "relation")) {
    throw new GuardRejection(RELATED_ISSUE_SHAPE);
  }
  for (const [key, item] of entries) fieldReferences(key, item, refs, relation, depth);
}

/** One property of an object at `depth`, walked by its field kind. */
function fieldReferences(key: string, item: unknown, refs: string[], relation: boolean, depth: number): void {
  const lower = key.trim().toLowerCase();
  if (TEXT_FIELDS.has(lower)) return;
  const kind = fieldKind(key);
  if (kind === "type") typeReferences(item, refs, relation, depth + 1);
  else if (kind === "relation") nestedReferences(item, refs, true, depth + 1, true);
  else nestedReferences(item, refs, relation, depth + 1, relation && (lower === "key" || lower === "id"));
}

/** A type field's own scalar properties, which name the type, not an issue. */
const TYPE_OWN_PROPERTIES = new Set(["id", "name", "inward", "outward", "self", "description"]);

/**
 * A type field's value. A scalar value and the type's own scalar properties are not reference
 * positions (an exact uppercase key is still checked). Anything nested keeps the surrounding
 * relation flag and is walked normally, so a wrapper inside a link's type cannot hide a reference.
 */
function typeReferences(value: unknown, refs: string[], relation: boolean, depth: number): void {
  if (depth > MAX_DEPTH) throw new GuardRejection("These Jira fields are nested too deeply to check.");
  if (Array.isArray(value)) { nestedReferences(value, refs, relation, depth, false); return; }
  if (!isObject(value)) { nestedReferences(value, refs, false, depth, false); return; }
  for (const [key, item] of Object.entries(value)) {
    const scalar = typeof item === "string" || typeof item === "number";
    if (scalar && TYPE_OWN_PROPERTIES.has(key.trim().toLowerCase())) nestedReferences(item, refs, false, depth + 1, false);
    else fieldReferences(key, item, refs, relation, depth);
  }
}

/** Every issue the call names that must be in the project; throws on a project change. */
function issueReferences(tool: string, args: Readonly<Record<string, unknown>>, projectKey: string): string[] {
  const refs: string[] = [];
  if (KEYED_TOOLS.has(tool)) refs.push(issueRef(args.issueIdOrKey, projectKey));
  if (tool === "createJiraIssue" && args.parent !== undefined) refs.push(...parentRefs(args.parent, projectKey));
  if (tool === "editJiraIssue") {
    for (const anchor of RANK_ANCHORS) if (args[anchor] !== undefined) refs.push(issueRef(args[anchor], projectKey));
  }
  for (const field of FIELD_OBJECTS[tool] ?? []) {
    const values = args[field];
    if (!isObject(values)) continue;
    for (const [name, value] of Object.entries(values)) {
      const lower = name.trim().toLowerCase();
      if (lower === "project" || lower === "pid") throw new GuardRejection("This connector cannot change an issue's project.");
      if (lower === "issuelinks") throw new GuardRejection("This connector cannot link issues, because a link can reach an issue in another project.");
      if (lower === "parent" || lower === "parent link") refs.push(...parentRefs(value, projectKey));
    }
    nestedReferences(values, refs);
  }
  const unique = [...new Set(refs)];
  if (unique.length > MAX_REFERENCES) throw new GuardRejection(`This call names more than ${MAX_REFERENCES} Jira issues. Split it into smaller calls.`);
  return unique;
}

/** True when `key` is exactly `<projectKey>-<number>`; no pattern is built from configuration. */
function isKeyInProject(key: string, projectKey: string): boolean {
  const prefix = `${projectKey}-`;
  return key.startsWith(prefix) && /^[1-9][0-9]*$/.test(key.slice(prefix.length));
}

function dataKey(parsed: unknown): string | undefined {
  return isObject(parsed) && isObject(parsed.data) && typeof parsed.data.key === "string" ? parsed.data.key : undefined;
}

/**
 * The live getJiraIssue result (2026-09-24) is `{ data: { id, key, fields } }`. No other shape is
 * trusted. When the result carries both structured and text forms, they must name the same key.
 */
function issueKeyOf(result: McpToolResult): string | undefined {
  const text = (result.content ?? []).filter((entry) => entry.type === "text").map((entry) => entry.text ?? "").join("\n");
  let fromText: string | undefined;
  if (text !== "") {
    try { fromText = dataKey(JSON.parse(text)); } catch { return undefined; }
    if (fromText === undefined) return undefined;
  }
  if (result.structuredContent === undefined) return fromText;
  const fromStructured = dataKey(result.structuredContent);
  return fromText === undefined || fromText === fromStructured ? fromStructured : undefined;
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
    // Belt and braces: the binder sets projectKey on a project-scoped create and the engine refuses a
    // model-supplied bound name before any guard runs, so this only matters if a scope and connector disagree.
    if (tool === "createJiraIssue" && args.projectKey !== undefined && args.projectKey !== projectKey) {
      throw new GuardRejection(`This connector works only in Jira project ${projectKey}.`);
    }
    for (const ref of issueReferences(tool, args, projectKey)) {
      // A minimal fields list keeps the reply small; data.key still arrives with it (verified live 2026-09-24).
      const result = await connection.call("getJiraIssue", { cloudId: jira.cloudId, issueIdOrKey: ref, fields: ["summary"] });
      if (result.isError) throw new GuardRejection(`Could not read Jira issue ${ref} to check its project. It may not exist, or AgentX's Jira account cannot see it.`);
      const key = issueKeyOf(result);
      if (key === undefined) throw new GuardRejection(`Could not confirm which project Jira issue ${ref} is in, so AgentX did not run this call.`);
      if (!isKeyInProject(key, projectKey)) {
        throw new GuardRejection(`Jira issue ${ref} is not in project ${projectKey}. This connector works only in ${projectKey}.`);
      }
    }
  },
};

const MAX_SEARCH_NOTE = 512;
const SEND_THE_REST = "send only the rest of the query.";

/**
 * The approvals as presented, with a sentence on a project-scoped search that says AgentX adds the
 * project filter, so a model that names another project learns why nothing matches. An admin
 * description override is left exactly as it is.
 */
export function jiraApprovals<Approval extends { name: string; description?: string | undefined }>(
  approvals: readonly Approval[],
  scopes: readonly JiraScope[],
): Array<Approval & { note?: string }> {
  const keyed = scopes.filter((scope): scope is JiraScope & { projectKey: string } => scope.projectKey !== undefined);
  if (keyed.length === 0 || keyed.length !== scopes.length) return [...approvals];
  const keys = [...new Set(keyed.map((scope) => scope.projectKey))];
  let note = keys.length === 1
    ? `AgentX limits every search to project ${keys[0]!}; ${SEND_THE_REST}`
    : `AgentX limits every search to the project of the chosen target (${keyed.map((scope) => `${scope.alias}: ${scope.projectKey}`).join(", ")}); ${SEND_THE_REST}`;
  if (note.length > MAX_SEARCH_NOTE) note = `AgentX limits every search to the project of the chosen target; ${SEND_THE_REST}`;
  return approvals.map((approval) => approval.name === "searchJiraIssuesUsingJql" && approval.description === undefined ? { ...approval, note } : approval);
}

export function jiraConnector(credentials: CredentialProvider<JiraScope>, options: { projectScoped: boolean }): ConnectorDefinition<JiraScope> {
  return {
    label: "Jira",
    endpoint: JIRA_MCP_ENDPOINT,
    permissionsHint: "the service account's API token (complete, not expired), API token authentication in the Rovo MCP server settings, and the service account's Jira project access",
    credentials,
    binder: jiraBinder(options.projectScoped),
    guards: [jiraProjectGuard],
    attributionKeys: ["description", "commentBody"],
    itemArguments: ["issueIdOrKey"],
  };
}
