// Internal helper shared by the wire schemas (developer.ts, admin.ts). Not re-exported from
// index.ts: it is a building block for schemas, not part of the contract.
import { z } from "zod";

interface IntrospectableDef {
  type: string;
  innerType?: z.ZodTypeAny;
  defaultValue?: unknown;
}

/**
 * F6: rebuilds a zod object schema so every nested object accepts unknown keys, not only the
 * outermost one (a plain `.passthrough()` only loosens the schema it is called on; a strict
 * sub-object such as `DeveloperTaskPolicySchema.shareMode`, wrapped in `.default()`, stays
 * strict). Walks `.shape` recursively, unwrapping `.default()`/`.optional()`/`.nullable()` and
 * rewrapping the loosened inner type the same way, so the field list is still defined exactly
 * once, in the schema passed in.
 */
export function looseCopy<Output>(schema: z.ZodType<Output>): z.ZodType<Output> {
  const def = (schema as unknown as { _zod: { def: IntrospectableDef } })._zod.def;
  if (def.type === "object") {
    const shape = (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
    const loosened: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(shape)) loosened[key] = looseCopy(value);
    return z.object(loosened).passthrough() as unknown as z.ZodType<Output>;
  }
  if (def.type === "default" && def.innerType) {
    return looseCopy(def.innerType).default(def.defaultValue as never) as unknown as z.ZodType<Output>;
  }
  if (def.type === "optional" && def.innerType) {
    return looseCopy(def.innerType).optional() as unknown as z.ZodType<Output>;
  }
  if (def.type === "nullable" && def.innerType) {
    return looseCopy(def.innerType).nullable() as unknown as z.ZodType<Output>;
  }
  return schema;
}
