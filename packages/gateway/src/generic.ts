import { itemPathHolders, parseItemPath, type ItemPathStep, type McpAuth, type McpConnectorConfig, type OwnershipRule } from "@agentx/contracts";
import { checkEndpointAddresses, type AddressLookup } from "./endpoint.js";
import { GuardRejection, type Binder, type ConnectorDefinition, type CredentialProvider, type Guard, type GuardedItemTools, type GuardInput } from "./types.js";
import { isObject, resultText } from "./util.js";

/**
 * Spec 055: a connector described by data. The binder, the ownership guard and the definition below
 * serve the generic `mcp` type and the Linear preset alike; Jira and Asana keep their own guards.
 */

/** Which tool arguments the server fills, each from a named scope value. */
export interface BindSpec {
  readonly required?: Readonly<Record<string, string>> | undefined;
  readonly optional?: Readonly<Record<string, string>> | undefined;
}

/** A binder over `{ alias, ...values }` scopes: required arguments are Binder.properties, optional ones optionalProperties. */
export function genericBinder<Scope extends object>(spec: BindSpec): Binder<Scope> {
  const required = Object.entries(spec.required ?? {});
  const optional = Object.entries(spec.optional ?? {});
  const all = [...required, ...optional];
  return {
    properties: required.map(([argument]) => argument),
    ...(optional.length > 0 ? { optionalProperties: optional.map(([argument]) => argument) } : {}),
    bind: (scope) => Object.fromEntries(all.map(([argument, value]) => [argument, (scope as Record<string, unknown>)[value]])),
  };
}

/** The words an ownership guard's standard messages use. */
export interface OwnershipNames { vendor: string; scopeNoun: string }

const MAX_ID_LENGTH = 128;
const DEFAULT_MAX_LOOKUPS = 10;

/** A reference path's item-path steps, and whether its last value is a list of IDs (a trailing `[]`). */
function referencePath(path: string): { steps: ItemPathStep[]; list: boolean } {
  const list = path.endsWith("[]");
  const steps = parseItemPath(list ? path.slice(0, -2) : path);
  if (steps === undefined) throw new Error(`malformed reference path ${path}`);
  return { steps, list };
}

class InvalidReference extends Error {}

/**
 * Every value a reference path names in a call's arguments. Absent and null mean no reference, and
 * so does an empty list. A value of the wrong shape on the way, or at the end, is an invalid
 * reference, so the caller refuses it rather than missing what it holds.
 */
function referencedValues(args: unknown, path: string): unknown[] {
  const { steps, list } = referencePath(path);
  let current: unknown[] = [args];
  for (const [index, step] of steps.entries()) {
    const last = index === steps.length - 1;
    const next: unknown[] = [];
    for (const holder of current) {
      if (!isObject(holder) || Array.isArray(holder)) throw new InvalidReference();
      const value = Object.hasOwn(holder, step.name) ? holder[step.name] : undefined;
      if (value === undefined || value === null) continue;
      if (step.each || (last && list)) {
        if (!Array.isArray(value)) throw new InvalidReference();
        next.push(...(value as unknown[]));
      } else next.push(value);
    }
    current = next;
  }
  return current;
}

/** Whether a reference path names anything at all, without judging its shape (for requiredTools). */
function referencesSomething(args: Readonly<Record<string, unknown>>, path: string): boolean {
  try { return referencedValues(args, path).length > 0; } catch { return true; }
}

/**
 * The strings a result field path reaches, and whether the result answers the question at all: the
 * last property exists, or a list on the way is empty (the item is in no scope). A scalar path must
 * end in a string. Never throws.
 */
function fieldValues(value: unknown, path: string): { found: boolean; values: string[] } {
  const { steps, list } = referencePath(path);
  const multiple = list || steps.some((step) => step.each);
  let current: unknown[] = [value];
  let reachedEnd = false;
  let emptyOnTheWay = false;
  for (const [index, step] of steps.entries()) {
    const last = index === steps.length - 1;
    const next: unknown[] = [];
    for (const holder of current) {
      if (!isObject(holder) || Array.isArray(holder) || !Object.hasOwn(holder, step.name)) continue;
      const item = holder[step.name];
      if (step.each || (last && list)) {
        if (!Array.isArray(item)) continue;
        if (last) reachedEnd = true;
        else if (item.length === 0) emptyOnTheWay = true;
        next.push(...(item as unknown[]));
      } else if (item !== undefined) {
        if (last) reachedEnd = true;
        next.push(item);
      }
    }
    current = next;
  }
  const values = current.filter((entry): entry is string => typeof entry === "string");
  return { found: emptyOnTheWay || (reachedEnd && (multiple || values.length > 0)), values };
}

/** The values present at an item path (null included, undefined not), for refuse and require rules. */
function presentValues(args: Record<string, unknown>, path: string): unknown[] {
  const last = parseItemPath(path)?.at(-1)?.name;
  if (last === undefined) return [];
  return itemPathHolders(args, path).flatMap((holder) => Object.hasOwn(holder, last) && holder[last] !== undefined ? [holder[last]] : []);
}

function fill(message: string, values: Record<"alias" | "argument" | "tool" | "vendor", string>): string {
  return message.replace(/\{(alias|argument|tool|vendor)\}/g, (_match, key: keyof typeof values) => values[key]);
}

/** The tools an ownership rule checks and the arguments through which a tool names an item (#49). */
export function ownershipGuardedTools(rule: OwnershipRule): GuardedItemTools {
  const firstSteps = Object.values(rule.references).flat().map((path) => path.split(/[.[]/)[0]!);
  return Object.freeze({
    tools: Object.freeze(Object.keys(rule.references)),
    targetArguments: Object.freeze([...new Set(rule.targetArguments ?? firstSteps)]),
  });
}

/**
 * The declarative guard (spec 055 FR-007, FR-008). The credential may reach more than the scope, so
 * before a call that names an existing item, read the item and refuse unless it, or a parent within
 * `parent.maxDepth`, belongs to the scope. Nothing is sent otherwise, and anything unreadable refuses.
 */
export function ownershipGuard(rule: OwnershipRule, names: OwnershipNames): Guard {
  const { vendor, scopeNoun } = names;
  const noun = rule.itemNoun;
  const plural = rule.itemNounPlural ?? `${noun}s`;
  const maxLookups = rule.maxLookups ?? DEFAULT_MAX_LOOKUPS;
  const active = new Set([
    ...Object.keys(rule.references),
    ...(rule.refuse ?? []).flatMap((entry) => entry.tools),
    ...(rule.require ?? []).flatMap((entry) => entry.tools),
  ]);
  const noScope = `The ${vendor} ${scopeNoun} check could not run, so the request was not sent.`;
  const invalid = `Invalid ${vendor} ${noun} ID.`;
  const same = (left: string, right: string) => rule.caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;

  function scopeOf(scope: unknown): { alias: string; expected: string } {
    if (!isObject(scope) || typeof scope.alias !== "string" || scope.alias === "") throw new GuardRejection(noScope);
    const expected = scope[rule.equals];
    if (typeof expected !== "string" || expected === "") throw new GuardRejection(noScope);
    return { alias: scope.alias, expected };
  }

  /** The IDs the call names, in rule order; repeats count once (ignoring case when the rule does). */
  function idsOf(tool: string, args: Readonly<Record<string, unknown>>): string[] {
    const found = new Map<string, string>();
    for (const path of rule.references[tool] ?? []) {
      let values: unknown[];
      try { values = referencedValues(args, path); } catch { throw new GuardRejection(invalid); }
      for (const id of values) {
        if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) throw new GuardRejection(invalid);
        const key = rule.caseInsensitive ? id.toLowerCase() : id;
        if (!found.has(key)) found.set(key, id);
      }
    }
    if (found.size > maxLookups) throw new GuardRejection(`This ${vendor} request references more than ${maxLookups} ${plural}, so it was not sent.`);
    return [...found.values()];
  }

  async function confirm(connection: GuardInput["connection"], id: string, alias: string, expected: string, lookups: { left: number; read: Map<string, unknown> }): Promise<void> {
    const shown = JSON.stringify(id.slice(0, 64));
    const unconfirmed = () => new GuardRejection(`Could not confirm that ${vendor} ${noun} ${shown} is in the ${alias} ${scopeNoun}, so the request was not sent.`);
    const notIn = () => new GuardRejection(`${vendor} ${noun} ${shown} is not in the ${alias} ${scopeNoun} this connector may use.`);
    let current = id;
    for (let depth = 0; ; depth += 1) {
      let item = lookups.read.get(current);
      if (item === undefined) {
        if (lookups.left <= 0) throw new GuardRejection(`This ${vendor} request needs more than ${maxLookups} ${noun} checks. Split it into smaller requests.`);
        lookups.left -= 1;
        const result = await connection.call(rule.lookup.tool, { ...rule.lookup.arguments, [rule.lookup.argument]: current });
        if (result.isError) throw new GuardRejection(`${vendor} ${noun} ${shown} was not found or this connector cannot see it.`);
        try { item = JSON.parse(resultText(result)) as unknown; } catch { throw unconfirmed(); }
        if (item === undefined || item === null) throw unconfirmed();
        lookups.read.set(current, item);
      }
      const field = fieldValues(item, rule.field);
      if (!field.found) throw unconfirmed();
      if (field.values.some((value) => same(value, expected))) return;
      if (rule.parent === undefined) throw notIn();
      // No parent (absent or null) means the item is simply not in the scope.
      const next = fieldValues(item, rule.parent.field).values[0];
      if (next === undefined) throw notIn();
      if (next.length === 0 || next.length > MAX_ID_LENGTH) throw unconfirmed();
      if (depth >= rule.parent.maxDepth) throw notIn();
      current = next;
    }
  }

  return {
    requiredTools(tool, args) {
      const paths = rule.references[tool];
      return paths !== undefined && paths.some((path) => referencesSomething(args, path)) ? [rule.lookup.tool] : [];
    },
    async check({ tool, arguments: args, connection, scope }) {
      if (!active.has(tool)) return;
      const { alias, expected } = scopeOf(scope);
      for (const entry of rule.refuse ?? []) {
        if (!entry.tools.includes(tool)) continue;
        const refuseAny = !Object.hasOwn(entry, "equals");
        const argument = entry.arguments.find((path) => presentValues(args, path).some((value) => refuseAny || value === entry.equals));
        if (argument !== undefined) throw new GuardRejection(fill(entry.message, { alias, argument, tool, vendor }));
      }
      for (const entry of rule.require ?? []) {
        if (entry.tools.includes(tool) && presentValues(args, entry.argument).length === 0) {
          throw new GuardRejection(fill(entry.message, { alias, argument: entry.argument, tool, vendor }));
        }
      }
      const lookups = { left: maxLookups, read: new Map<string, unknown>() };
      for (const id of idsOf(tool, args)) await confirm(connection, id, alias, expected, lookups);
    },
  };
}

/** The runtime scope of a generic connector: its alias and its values, as the binder and guard read them. */
export type GenericScope = { alias: string } & Record<string, string>;

/** A generic `mcp` connector's scopes as runtime scope objects. */
export function genericScopes(config: Pick<McpConnectorConfig, "scopes">): Array<{ alias: string; scope: GenericScope }> {
  return config.scopes.map((scope) => ({ alias: scope.alias, scope: { ...scope.values, alias: scope.alias } }));
}

/** The engine definition of a generic `mcp` connector (spec 055). */
export function mcpConnector(
  config: McpConnectorConfig,
  credentials: CredentialProvider<GenericScope>,
  options: { lookup?: AddressLookup } = {},
): ConnectorDefinition<GenericScope> {
  const endpoint = new URL(config.endpoint);
  const scoping = config.scoping;
  const auth: McpAuth | undefined = config.auth;
  return {
    label: config.vendor,
    endpoint,
    permissionsHint: config.permissionsHint ?? `the ${config.vendor} credential's permissions`,
    credentials,
    binder: genericBinder(config.bind ?? {}),
    guards: scoping.mode === "ownership" ? [ownershipGuard(scoping, { vendor: config.vendor, scopeNoun: config.scopeNoun ?? "scope" })] : [],
    ...(config.attributionKeys ? { attributionKeys: config.attributionKeys } : {}),
    ...(config.itemArguments ? { itemArguments: config.itemArguments } : {}),
    ...(scoping.mode === "ownership" ? { guardedItemTools: ownershipGuardedTools(scoping) } : {}),
    ...(auth && (auth.header !== undefined || auth.prefix !== undefined) ? { auth } : {}),
    verifyEndpoint: () => checkEndpointAddresses(endpoint, options.lookup),
  };
}
