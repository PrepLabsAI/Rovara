import type { Binder } from "./types.js";
import { isObject } from "./util.js";

type BinderNames = Pick<Binder<unknown>, "properties" | "optionalProperties">;

/** Every property the server controls. A model-supplied value for any of them is refused. */
export function boundNames(binder: BinderNames): string[] {
  return [...new Set([...binder.properties, ...(binder.optionalProperties ?? [])])];
}

/**
 * Removes the server-bound properties from a flattened object schema, in place.
 * Returns the names removed, which are the values a call on this tool sends, or why the tool cannot be offered.
 */
export function removeBoundProperties(schema: Record<string, unknown>, binder: BinderNames): { bound: string[] } | { unbindable: string } {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required as string[] : [];
  const missing = binder.properties.find((name) => {
    const property = properties[name];
    return !(isObject(property) && property.type === "string" && required.includes(name));
  });
  if (missing !== undefined) return { unbindable: `missing server-bound property ${missing}` };
  const present = (binder.optionalProperties ?? []).filter((name) => !binder.properties.includes(name) && (Object.hasOwn(properties, name) || required.includes(name)));
  const untyped = present.find((name) => {
    const property = properties[name];
    return !(isObject(property) && property.type === "string");
  });
  if (untyped !== undefined) return { unbindable: `server-bound property ${untyped} is not a string` };
  const bound = [...binder.properties, ...present];
  for (const name of bound) delete properties[name];
  schema.required = required.filter((name) => !bound.includes(name));
  return { bound };
}
