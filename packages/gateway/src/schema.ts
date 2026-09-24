import { isObject } from "./util.js";

export type FlattenResult = { schema: Record<string, unknown> } | { unsupported: string };

const MAX_DEPTH = 64;
/** Bounds expansion of shared `$ref`s while resolving, before memory can grow with it. */
const MAX_NODES = 20_000;
/** Keywords that describe rather than constrain; the first value wins when parts are merged. */
const ANNOTATIONS = new Set(["description", "title", "examples", "default", "$comment", "deprecated"]);
/** Identifiers mean nothing once references are inlined, and repeating one makes the schema invalid. */
const IDENTIFIERS = new Set(["$id", "$anchor", "$dynamicAnchor"]);

class Unsupported extends Error {}

/**
 * Inline local `$ref`s and merge `allOf` parts so policy narrowing can reason about one plain
 * object schema. The vendor's original schema still validates every call.
 */
export function flattenSchema(input: Record<string, unknown>): FlattenResult {
  try {
    const resolved = resolveNode(input, input, [], 0, { remaining: MAX_NODES });
    if (!isObject(resolved)) return { unsupported: "schema is not an object" };
    return { schema: resolved };
  } catch (error) {
    if (error instanceof Unsupported) return { unsupported: error.message };
    throw error;
  }
}

function resolveNode(node: unknown, root: Record<string, unknown>, stack: readonly string[], depth: number, budget: { remaining: number }): unknown {
  if (depth > MAX_DEPTH) throw new Unsupported(`schema nesting exceeds ${MAX_DEPTH} levels`);
  if (Array.isArray(node)) return node.map((item) => resolveNode(item, root, stack, depth + 1, budget));
  if (!isObject(node)) return node;
  budget.remaining -= 1;
  if (budget.remaining < 0) throw new Unsupported(`flattened schema exceeds ${MAX_NODES} nodes`);
  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    if (ref === "#" || stack.includes(ref)) throw new Unsupported(`recursive reference ${ref}`);
    const target = resolveNode(lookup(root, ref), root, [...stack, ref], depth + 1, budget);
    const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$ref"));
    if (Object.keys(siblings).length === 0) return target;
    return mergeAll([resolveNode(siblings, root, stack, depth + 1, budget), target]);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$defs" || key === "definitions" || IDENTIFIERS.has(key)) continue;
    out[key] = key === "properties" && isObject(value)
      ? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, resolveNode(schema, root, stack, depth + 1, budget)]))
      : resolveNode(value, root, stack, depth + 1, budget);
  }
  if (!Array.isArray(out.allOf)) return out;
  const parts = out.allOf as unknown[];
  delete out.allOf;
  return mergeAll([out, ...parts]);
}

function lookup(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Unsupported(`external reference ${ref}`);
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let decoded: string;
    try { decoded = decodeURIComponent(raw); } catch { throw new Unsupported(`malformed reference ${ref}`); }
    const segment = decoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(node) || !Object.hasOwn(node, segment)) throw new Unsupported(`unresolvable reference ${ref}`);
    node = node[segment];
  }
  return node;
}

function mergeAll(parts: readonly unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const part of parts) {
    if (!isObject(part)) throw new Unsupported("allOf member is not an object schema");
    for (const [key, value] of Object.entries(part)) {
      if (key === "properties") {
        if (!isObject(value)) throw new Unsupported("properties is not an object");
        const target: Record<string, unknown> = isObject(merged.properties) ? merged.properties : {};
        for (const [name, schema] of Object.entries(value)) {
          if (Object.hasOwn(target, name) && JSON.stringify(target[name]) !== JSON.stringify(schema)) {
            throw new Unsupported(`conflicting definitions of property ${name}`);
          }
          target[name] = schema;
        }
        merged.properties = target;
      } else if (key === "required") {
        if (!Array.isArray(value)) throw new Unsupported("required is not an array");
        const existing = Array.isArray(merged.required) ? merged.required as unknown[] : [];
        merged.required = [...new Set([...existing, ...(value as unknown[])])];
      } else if (key === "additionalProperties") {
        // Narrowing sets its own additionalProperties; the vendor schema still validates the call.
        continue;
      } else if (Object.hasOwn(merged, key)) {
        if (ANNOTATIONS.has(key)) continue;
        if (JSON.stringify(merged[key]) !== JSON.stringify(value)) throw new Unsupported(`conflicting ${key}`);
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}
