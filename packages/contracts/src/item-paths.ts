import { z } from "zod";

/** The most steps an item argument path may have, so resolving one is bounded. */
export const ITEM_PATH_MAX_STEPS = 4;

/**
 * Where a connector's tools name an existing item (feature 014): an argument name (`id`), a name
 * inside an object argument (`fields.key`), or a name inside each object of an array argument
 * (`tasks[].task`). A step is 1 to 64 of A-Z, a-z, 0-9, `_` and `-`; a path has at most
 * ITEM_PATH_MAX_STEPS steps (the `{0,3}` below); `[]` only ever comes before a `.`, so the named
 * value itself is never an array.
 */
export const ItemPathSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}(?:(?:\.|\[\]\.)[A-Za-z0-9_-]{1,64}){0,3}$/u);

/** One step of a path. `each` means the value at this step is an array whose objects the next step reads. */
export interface ItemPathStep { name: string; each: boolean }

/** The steps of a well-formed path, or undefined for a malformed one. */
export function parseItemPath(path: string): ItemPathStep[] | undefined {
  if (!ItemPathSchema.safeParse(path).success) return undefined;
  return path.split(".").map((part) => part.endsWith("[]") ? { name: part.slice(0, -2), each: true } : { name: part, each: false });
}

/** Why a connector's declared item arguments cannot be used: malformed, duplicated, none or more than 16. */
export function itemPathProblems(paths: readonly string[] | undefined): string[] {
  if (paths === undefined) return [];
  const problems: string[] = [];
  if (paths.length === 0 || paths.length > 16) problems.push("declare 1 to 16 item argument paths");
  for (const [index, path] of paths.entries()) {
    if (parseItemPath(path) === undefined) problems.push(`malformed item argument path ${JSON.stringify(path.slice(0, 80))}`);
    else if (paths.indexOf(path) !== index) problems.push(`duplicate item argument path ${path}`);
  }
  return problems;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A value that names something: not undefined, null or the empty string. */
function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/**
 * The objects that hold a path's last step in a call's arguments: the arguments themselves for a
 * name, the object at `a` for `a.b`, and each object of the array at `a` for `a[].b`. A value of any
 * other shape, and a malformed path, holds nothing. It never reads deeper than the path's own steps.
 */
export function itemPathHolders(args: Record<string, unknown>, path: string): Array<Record<string, unknown>> {
  const steps = parseItemPath(path);
  if (steps === undefined) return [];
  let holders: Array<Record<string, unknown>> = [args];
  for (const step of steps.slice(0, -1)) {
    holders = holders.flatMap((holder) => {
      const value = Object.hasOwn(holder, step.name) ? holder[step.name] : undefined;
      if (step.each) return Array.isArray(value) ? value.filter(isPlainObject) : [];
      return isPlainObject(value) ? [value] : [];
    });
  }
  return holders;
}

/** The present values a path names in a call's arguments; empty when it is missing, empty or malformed. */
export function itemPathValues(args: Record<string, unknown>, path: string): unknown[] {
  const last = parseItemPath(path)?.at(-1)?.name;
  if (last === undefined) return [];
  return itemPathHolders(args, path).flatMap((holder) => Object.hasOwn(holder, last) && isPresent(holder[last]) ? [holder[last]] : []);
}

/** Whether a tool's input schema offers a path: each step a declared property, read through `items` after `[]`. */
export function schemaHasItemPath(inputSchema: Record<string, unknown>, path: string): boolean {
  const steps = parseItemPath(path);
  if (steps === undefined) return false;
  let schema: unknown = inputSchema;
  for (const step of steps) {
    const properties = isPlainObject(schema) && isPlainObject(schema.properties) ? schema.properties : undefined;
    if (properties === undefined || !Object.hasOwn(properties, step.name)) return false;
    schema = properties[step.name];
    if (step.each) schema = isPlainObject(schema) ? schema.items : undefined;
  }
  return true;
}
