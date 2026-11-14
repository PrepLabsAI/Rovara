// Which values a forward-compatible reader (`forward-reader.ts`) gave as "unknown". The word is also an ordinary string, so a bare search for it would take a title or a
// message for the reader's marker; this walks the strict schema beside the value and counts only the places where the reader can have written the marker: an enum, and
// the kind of a union whose kind it did not know.
import type { z } from "zod";
import { UNKNOWN } from "./forward-reader.js";

type Def = { type: string } & Record<string, unknown>;
const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value`, read by `forwardReader(schema)` (or a reader built from the same shape), holds the reader's "unknown" marker anywhere the marker can be. */
export function readsAsUnknown(schema: z.ZodType, value: unknown): boolean {
  if (value === undefined) return false;
  const def = defOf(schema);
  switch (def.type) {
    case "enum":
      return value === UNKNOWN && !(schema as unknown as z.ZodEnum).options.includes(UNKNOWN);
    case "object": {
      if (!isRecord(value)) return false;
      const shape = (schema as unknown as z.ZodObject).shape as Record<string, z.ZodType>;
      return Object.entries(shape).some(([key, field]) => readsAsUnknown(field, value[key]));
    }
    case "array":
      return Array.isArray(value) && value.some((item) => readsAsUnknown(def.element as z.ZodType, item));
    case "record":
      return isRecord(value) && Object.values(value).some((item) => readsAsUnknown(def.valueType as z.ZodType, item));
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
      return readsAsUnknown(def.innerType as z.ZodType, value);
    case "union": {
      const options = def.options as z.ZodType[];
      if (typeof def.discriminator === "string") return isRecord(value) && value[def.discriminator] === UNKNOWN;
      return options.some((option) => readsAsUnknown(option, value));
    }
    default:
      return false;
  }
}
