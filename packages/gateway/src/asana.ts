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

/**
 * The keys a create_tasks or update_tasks `tasks[]` item may carry: exactly the ones Asana's
 * recorded items schema lists (tests pin them to tests/fixtures/vendors/asana-tools.json). The
 * gateway's schema check closes only the top level, so the guard refuses every other item key.
 */
export const ASANA_CREATE_TASK_ITEM_KEYS = [
  "name", "project_id", "parent", "html_notes", "notes", "assignee", "due_on", "due_at", "resource_subtype", "completed",
  "approval_status", "section_id", "assignee_section", "followers", "start_on", "start_at", "custom_fields",
] as const;
export const ASANA_UPDATE_TASK_ITEM_KEYS = [
  "task", "name", "assignee", "assignee_section", "due_on", "start_on", "notes", "html_notes", "completed", "approval_status",
  "parent", "add_projects", "remove_projects", "add_dependencies", "remove_dependencies", "add_dependents", "remove_dependents",
  "add_followers", "remove_followers", "custom_fields",
] as const;
const TASK_ITEM_KEYS: Readonly<Record<string, readonly string[]>> = { create_tasks: ASANA_CREATE_TASK_ITEM_KEYS, update_tasks: ASANA_UPDATE_TASK_ITEM_KEYS };
/** update_tasks item keys whose value is a list of strings (task, user or project identifiers). */
const STRING_LIST_ITEM_KEYS: ReadonlySet<string> = new Set(["remove_projects", "add_dependencies", "remove_dependencies", "add_dependents", "remove_dependents", "add_followers", "remove_followers"]);
/** The keys a date custom field value may carry. */
const DATE_VALUE_KEYS: ReadonlySet<string> = new Set(["date", "date_time"]);
/** search_tasks custom_fields keys: a custom field GID and a search operator. */
const SEARCH_CUSTOM_FIELD_KEY = /^[1-9][0-9]{0,19}\.(?:value|is_set|not_value|starts_with|ends_with|contains|less_than|greater_than|before|after)$/;
const HTML_COMMENT_REFUSED = "This Asana connector posts comments as plain text only. Pass text instead of html_text.";

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
 * Every value at a path, with the concrete path it was found at. Absent, null and [] are skipped,
 * except that with `keepNull` an explicit null at the end of the path is returned.
 * Where the path expects an array or an object and finds anything else, that value is returned
 * instead, so the caller refuses it rather than missing what it holds.
 */
function valuesAt(value: unknown, path: ArgumentPath, at: string[] = [], keepNull = false): Array<{ value: unknown; at: string }> {
  if (value === null && keepNull && path.length === 0) return [{ value, at: at.join(".") }];
  if (value === undefined || value === null) return [];
  if (path.length === 0) return Array.isArray(value) && value.length === 0 ? [] : [{ value, at: at.join(".") }];
  const [head, ...rest] = path;
  if (head === "*") {
    if (!Array.isArray(value)) return [{ value, at: at.join(".") }];
    return value.flatMap((item, index) => valuesAt(item, rest, [...at, String(index)], keepNull));
  }
  if (!isObject(value)) return [{ value, at: at.join(".") }];
  return valuesAt(value[head!], rest, [...at, head!], keepNull);
}

/** A plain object's own keys, symbols and non-enumerable keys included; undefined for anything else. */
function ownKeys(value: unknown): string[] | undefined {
  if (!isObject(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return Reflect.ownKeys(value).map(String);
}

const isPlain = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);

/** Parses a JSON-string argument into a plain object, or refuses. */
function jsonObject(text: unknown, at: string, tool: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = typeof text === "string" ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  if (ownKeys(parsed) === undefined) throw new GuardRejection(`${at} on ${tool} must be a JSON object, so the request was not sent.`);
  return parsed as Record<string, unknown>;
}

/** A task custom field map: custom field GID keys; string, number, null, string-list or date values. */
function checkTaskCustomFields(fields: unknown, at: string, tool: string): void {
  const keys = ownKeys(fields);
  if (keys === undefined) throw new GuardRejection(`${at} on ${tool} must map custom field GIDs to values.`);
  for (const key of keys) {
    if (!GID.test(key)) throw new GuardRejection(`${at}.${key.slice(0, 64)} is not allowed on ${tool}: custom field keys are custom field GIDs.`);
    const value = (fields as Record<string, unknown>)[key];
    if (isPlain(value) && typeof value !== "boolean") continue;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) continue;
    const valueKeys = ownKeys(value);
    if (valueKeys !== undefined && valueKeys.every((name) => DATE_VALUE_KEYS.has(name) && typeof (value as Record<string, unknown>)[name] === "string")) continue;
    throw new GuardRejection(`${at}.${key} on ${tool} is not a custom field value this connector allows, so it is not allowed.`);
  }
}

/**
 * Refuses any structure the guard cannot reason about. Top-level values are plain except `tasks`
 * on create_tasks and update_tasks; each task item carries only the catalog's keys, with plain
 * values except the string lists, add_projects (refused elsewhere) and custom fields. JSON-string
 * custom_fields are parsed and checked the same way.
 */
function checkShape(tool: string, args: Readonly<Record<string, unknown>>): void {
  if (tool === "add_comment" && args.html_text !== undefined) throw new GuardRejection(HTML_COMMENT_REFUSED);
  const itemKeys = TASK_ITEM_KEYS[tool];
  for (const key of ownKeys(args) ?? []) {
    const value = args[key];
    if (itemKeys !== undefined && key === "tasks") continue;
    if (!isPlain(value)) throw new GuardRejection(`${key.slice(0, 64)} is not allowed on ${tool}: this connector accepts only plain values there.`);
  }
  if (tool === "search_tasks" && args.custom_fields !== undefined) {
    const fields = jsonObject(args.custom_fields, "custom_fields", tool);
    for (const key of ownKeys(fields)!) {
      if (!SEARCH_CUSTOM_FIELD_KEY.test(key) || !isPlain(fields[key]) || fields[key] === null) {
        throw new GuardRejection(`custom_fields.${key.slice(0, 64)} is not allowed on search_tasks: use a custom field GID and an operator, such as 1200456789012345.value, with a plain value.`);
      }
    }
  }
  if (itemKeys === undefined || args.tasks === undefined) return;
  if (!Array.isArray(args.tasks)) throw new GuardRejection(`tasks is not allowed on ${tool} unless it is a list of tasks.`);
  args.tasks.forEach((item: unknown, index) => {
    const at = `tasks.${index}`;
    const keys = ownKeys(item);
    if (keys === undefined) throw new GuardRejection(`${at} is not allowed on ${tool} unless it is a task object.`);
    if (tool === "update_tasks") {
      const task = (item as Record<string, unknown>).task;
      if (typeof task !== "string" || !GID.test(task)) throw new GuardRejection(INVALID_GID);
    }
    for (const key of keys) {
      if (!itemKeys.includes(key)) throw new GuardRejection(`${at}.${key.slice(0, 64)} is not allowed on ${tool}.`);
      const value = (item as Record<string, unknown>)[key];
      if (key === "custom_fields") {
        if (value !== null) checkTaskCustomFields(typeof value === "string" ? jsonObject(value, `${at}.custom_fields`, tool) : value, `${at}.custom_fields`, tool);
      } else if (STRING_LIST_ITEM_KEYS.has(key)) {
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new GuardRejection(`${at}.${key} is not allowed on ${tool} unless it is a list of IDs.`);
      } else if (key !== "add_projects" && !isPlain(value)) {
        throw new GuardRejection(`${at}.${key} is not allowed on ${tool}: this connector accepts only plain values there.`);
      }
    }
  });
}

/** The task GIDs the call names, after refusing arguments that could leave the project. */
function taskReferences(tool: string, args: Readonly<Record<string, unknown>>, project: AsanaProjectScope): string[] {
  for (const path of REFUSED_ARGUMENTS[tool] ?? []) {
    const found = valuesAt(args, path, [], true)[0];
    if (found !== undefined) {
      throw new GuardRejection(`This Asana connector works only in the ${project.alias} project, so ${found.at} is not allowed on ${tool}.${tool === "get_tasks" ? " Use search_tasks to filter by assignee." : ""}`);
    }
  }
  if (tool === "create_tasks") {
    for (const { value } of valuesAt(args, ["tasks", "*", "project_id"], [], true)) {
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
  if (data.parent !== undefined && data.parent !== null && !(isObject(data.parent) && typeof data.parent.gid === "string" && GID.test(data.parent.gid))) return undefined;
  const parent = isObject(data.parent) ? data.parent.gid as string : undefined;
  return { gid: data.gid, projects: [...projects], parent };
}

type AsanaTask = NonNullable<ReturnType<typeof taskOf>>;

/** One check's get_task reads: the lookup budget, and every task already read, so a shared parent chain costs one read. */
interface Lookups { left: number; read: Map<string, AsanaTask> }

/**
 * Reads the task with get_task and refuses unless it, or a parent up to three levels up, is in the
 * scope's project. Subtasks are often in no project themselves; Asana shows them to whoever can
 * see the parent. With `direct`, the task itself must be in the project, because the call removes
 * its parent. Fails closed on an error, an unreadable result or a different task.
 */
async function confirmInProject(connection: GuardInput["connection"], gid: string, project: AsanaProjectScope, lookups: Lookups, direct: boolean): Promise<void> {
  let current = gid;
  for (let depth = 0; depth <= MAX_PARENT_DEPTH; depth += 1) {
    let task = lookups.read.get(current);
    if (task === undefined) {
      if (lookups.left <= 0) throw new GuardRejection(`This Asana request needs more than ${MAX_LOOKUPS} task checks. Split it into smaller requests.`);
      lookups.left -= 1;
      const result = await connection.call("get_task", { task_id: current, include_subtasks: false, include_comments: false });
      if (result.isError) throw new GuardRejection(`Asana task ${gid} was not found or this connector cannot see it.`);
      const read = taskOf(resultText(result));
      if (read === undefined || read.gid !== current) throw new GuardRejection(`Could not confirm that Asana task ${gid} is in the ${project.alias} project, so the request was not sent.`);
      lookups.read.set(current, read);
      task = read;
    }
    if (task.projects.includes(project.projectGid)) {
      if (direct && depth > 0) throw new GuardRejection(`Asana task ${gid} is in the ${project.alias} project only through its parent, so this connector does not remove its parent.`);
      return;
    }
    if (task.parent === undefined) break;
    current = task.parent;
  }
  throw new GuardRejection(`Asana task ${gid} is not in the ${project.alias} project this connector may use.`);
}

/** update_tasks items that set parent to null: those tasks must be in the project themselves. */
function parentRemoved(tool: string, args: Readonly<Record<string, unknown>>): Set<string> {
  const removed = new Set<string>();
  if (tool !== "update_tasks" || !Array.isArray(args.tasks)) return removed;
  for (const item of args.tasks) if (isObject(item) && Object.hasOwn(item, "parent") && item.parent === null && typeof item.task === "string") removed.add(item.task);
  return removed;
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
    checkShape(tool, args);
    const references = taskReferences(tool, args, project);
    const removed = parentRemoved(tool, args);
    const lookups: Lookups = { left: MAX_LOOKUPS, read: new Map() };
    for (const gid of references) await confirmInProject(connection, gid, project, lookups, removed.has(gid));
  },
};

export function asanaConnector(credentials: CredentialProvider<AsanaProjectScope>): ConnectorDefinition<AsanaProjectScope> {
  return {
    label: "Asana",
    endpoint: ASANA_MCP_ENDPOINT,
    permissionsHint: "the bot user's access to the Asana project",
    credentials,
    binder: asanaBinder,
    guards: [asanaProjectGuard],
    attributionKeys: ["text"],
  };
}
