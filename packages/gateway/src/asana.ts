import { ASANA_PROJECT_TOOL_ACCESS, OAUTH_AUTHORIZATION_PROFILES } from "@agentx/contracts";
import { GuardRejection, type Binder, type ConnectorDefinition, type CredentialProvider, type Guard, type GuardInput } from "./types.js";
import { isObject, resultText } from "./util.js";

/** Asana's hosted MCP server. OAuth only: a bot user's access token, refreshed by oauth-refresh-token. */
export const ASANA_MCP_ENDPOINT = new URL("https://mcp.asana.com/v2/mcp");
export const ASANA_TOKEN_ENDPOINT = new URL(OAUTH_AUTHORIZATION_PROFILES.asana.tokenUrl);

/** An Asana project a connector may address, by the alias the model sees and the project's GID. */
export interface AsanaProjectScope { alias: string; projectGid: string }

/**
 * The argument through which an Asana tool names one existing task, for spec 014's action gate
 * (`ConnectorDefinition.itemArguments`, most specific first). update_tasks names its tasks inside
 * `tasks[].task`; see ASANA_TASK_REFERENCES.
 */
export const ASANA_ITEM_ARGUMENTS = ["task_id"] as const;

/**
 * Asana names the project `project` (get_tasks), `project_id` (get_project), `default_project`
 * (create_tasks) and `projects_any` (search_tasks). Each is bound, where the tool has it, to the
 * scope's project GID, so a list, a search and a create can only reach that project.
 */
export const asanaBinder: Binder<AsanaProjectScope> = {
  properties: [],
  optionalProperties: ["project", "project_id", "default_project", "projects_any"],
  bind: (scope) => ({ project: scope.projectGid, project_id: scope.projectGid, default_project: scope.projectGid, projects_any: scope.projectGid }),
};

/** A path into a tool's arguments; "*" is each element of an array. */
type ArgumentPath = readonly string[];

/**
 * Where each guarded tool names an existing task. Every task named here is read with get_task and
 * must be in the scope's project (or be a subtask of one that is) before the call is sent.
 */
export const ASANA_TASK_REFERENCES: Readonly<Record<string, readonly ArgumentPath[]>> = {
  get_task: [["task_id"]],
  get_task_stories: [["task_id"]],
  add_comment: [["task_id"]],
  create_tasks: [["tasks", "*", "parent"]],
  update_tasks: [
    ["tasks", "*", "task"], ["tasks", "*", "parent"],
    ["tasks", "*", "add_dependencies", "*"], ["tasks", "*", "remove_dependencies", "*"],
    ["tasks", "*", "add_dependents", "*"], ["tasks", "*", "remove_dependents", "*"],
  ],
};

/** Arguments that would reach outside the project or move a task between projects. */
const REFUSED_ARGUMENTS: Readonly<Record<string, readonly ArgumentPath[]>> = {
  get_tasks: [["tag"], ["section"], ["user_task_list"], ["assignee"]],
  create_tasks: [["tasks", "*", "section_id"], ["tasks", "*", "assignee_section"]],
  update_tasks: [["tasks", "*", "add_projects"], ["tasks", "*", "remove_projects"], ["tasks", "*", "assignee_section"]],
};

const GID = /^[1-9][0-9]{0,19}$/;
/** The most get_task reads one call may cost, parents included. */
const MAX_LOOKUPS = 10;
/** How far up the parent chain a subtask is followed to find its project. */
const MAX_PARENT_DEPTH = 3;
const NO_SCOPE = "The Asana project check could not run, so the request was not sent.";
const INVALID_GID = "Pass the Asana task ID (the long number in the task's URL), not a URL, name or other text.";

function scopeOf(scope: unknown): AsanaProjectScope {
  if (!isObject(scope) || typeof scope.alias !== "string" || scope.alias === "" || typeof scope.projectGid !== "string" || !GID.test(scope.projectGid)) throw new GuardRejection(NO_SCOPE);
  return { alias: scope.alias, projectGid: scope.projectGid };
}

/**
 * Every value at a path, with the concrete path it was found at. Absent, null and [] are skipped.
 * Where the path expects an array or an object and finds anything else, that value is returned
 * instead, so the caller refuses it rather than missing what it holds.
 */
function valuesAt(value: unknown, path: ArgumentPath, at: string[] = []): Array<{ value: unknown; at: string }> {
  if (value === undefined || value === null) return [];
  if (path.length === 0) return Array.isArray(value) && value.length === 0 ? [] : [{ value, at: at.join(".") }];
  const [head, ...rest] = path;
  if (head === "*") {
    if (!Array.isArray(value)) return [{ value, at: at.join(".") }];
    return value.flatMap((item, index) => valuesAt(item, rest, [...at, String(index)]));
  }
  if (!isObject(value)) return [{ value, at: at.join(".") }];
  return valuesAt(value[head!], rest, [...at, head!]);
}

/** The task GIDs the call names, after refusing arguments that could leave the project. */
function taskReferences(tool: string, args: Readonly<Record<string, unknown>>, project: AsanaProjectScope): string[] {
  for (const path of REFUSED_ARGUMENTS[tool] ?? []) {
    const found = valuesAt(args, path)[0];
    if (found !== undefined) {
      throw new GuardRejection(`This Asana connector works only in the ${project.alias} project, so ${found.at} is not allowed on ${tool}.${tool === "get_tasks" ? " Use search_tasks to filter by assignee." : ""}`);
    }
  }
  if (tool === "create_tasks") {
    for (const { value } of valuesAt(args, ["tasks", "*", "project_id"])) {
      if (value !== project.projectGid) throw new GuardRejection(`This Asana connector creates tasks only in the ${project.alias} project. Leave project_id out.`);
    }
  }
  const references = new Set<string>();
  for (const path of ASANA_TASK_REFERENCES[tool] ?? []) {
    for (const { value } of valuesAt(args, path)) {
      if (typeof value !== "string" || !GID.test(value)) throw new GuardRejection(INVALID_GID);
      references.add(value);
    }
  }
  if (references.size > MAX_LOOKUPS) throw new GuardRejection(`This Asana request names more than ${MAX_LOOKUPS} tasks. Split it into smaller requests.`);
  return [...references];
}

/** The live get_task result is `{ data: { gid, projects: [{ gid }], parent, memberships } }`; nothing else is trusted. */
function taskOf(text: string): { gid: string; projects: string[]; parent: string | undefined } | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const data = isObject(parsed) && isObject(parsed.data) ? parsed.data : undefined;
  if (!data || typeof data.gid !== "string") return undefined;
  const projects = new Set<string>();
  let listed = false;
  if (Array.isArray(data.projects)) {
    listed = true;
    for (const entry of data.projects) if (isObject(entry) && typeof entry.gid === "string") projects.add(entry.gid);
  }
  if (Array.isArray(data.memberships)) {
    listed = true;
    for (const entry of data.memberships) if (isObject(entry) && isObject(entry.project) && typeof entry.project.gid === "string") projects.add(entry.project.gid);
  }
  if (!listed) return undefined;
  const parent = isObject(data.parent) && typeof data.parent.gid === "string" ? data.parent.gid : undefined;
  return { gid: data.gid, projects: [...projects], parent };
}

/**
 * Reads the task with get_task and refuses unless it, or a parent up to three levels up, is in the
 * scope's project. Subtasks are often in no project themselves; Asana shows them to whoever can
 * see the parent. Fails closed on an error, an unreadable result or a different task.
 */
async function confirmInProject(connection: GuardInput["connection"], gid: string, project: AsanaProjectScope, budget: { left: number }): Promise<void> {
  let current = gid;
  for (let depth = 0; depth <= MAX_PARENT_DEPTH; depth += 1) {
    if (budget.left <= 0) throw new GuardRejection(`This Asana request needs more than ${MAX_LOOKUPS} task checks. Split it into smaller requests.`);
    budget.left -= 1;
    const result = await connection.call("get_task", { task_id: current, include_subtasks: false, include_comments: false });
    if (result.isError) throw new GuardRejection(`Asana task ${gid} was not found or this connector cannot see it.`);
    const task = taskOf(resultText(result));
    if (task === undefined || task.gid !== current) throw new GuardRejection(`Could not confirm that Asana task ${gid} is in the ${project.alias} project, so the request was not sent.`);
    if (task.projects.includes(project.projectGid)) return;
    if (task.parent === undefined) break;
    current = task.parent;
  }
  throw new GuardRejection(`Asana task ${gid} is not in the ${project.alias} project this connector may use.`);
}

/**
 * The bot user may see more than the project scopes. Only the tools in ASANA_PROJECT_TOOL_ACCESS
 * run; before a call reads or changes an existing task, every task it names is confirmed in the
 * scope's project, so nothing is sent otherwise.
 */
export const asanaProjectGuard: Guard = {
  requiredTools: (tool) => Object.hasOwn(ASANA_TASK_REFERENCES, tool) && tool !== "get_task" ? ["get_task"] : [],
  async check({ tool, arguments: args, connection, scope }) {
    const project = scopeOf(scope);
    if (!Object.hasOwn(ASANA_PROJECT_TOOL_ACCESS, tool)) throw new GuardRejection(`${tool} cannot be limited to an Asana project, so this connector does not run it.`);
    const budget = { left: MAX_LOOKUPS };
    for (const gid of taskReferences(tool, args, project)) await confirmInProject(connection, gid, project, budget);
  },
};

export function asanaConnector(credentials: CredentialProvider<AsanaProjectScope>): ConnectorDefinition<AsanaProjectScope> {
  return {
    label: "Asana",
    endpoint: ASANA_MCP_ENDPOINT,
    permissionsHint: "the bot user's sign-in (run agentx admin credential authorize again if it was revoked) and its access to the Asana project",
    credentials,
    binder: asanaBinder,
    guards: [asanaProjectGuard],
    attributionKeys: ["text"],
  };
}
