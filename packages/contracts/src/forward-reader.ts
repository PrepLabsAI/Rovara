// Forward-compatible readers, shared by the chain session views (chain-session.ts) and the agent session views (session-views.ts).
import { z } from "zod";

export const UNKNOWN = "unknown" as const;

/**
 * A value of an enum that reads a string a newer server added as "unknown". A missing or non-string value stays an error.
 * Plan 4 and Plan 5 each had their own: Plan 4's was `z.enum(values).catch("unknown")`, which also turned a missing or malformed value into "unknown";
 * this one (Plan 5's) is the shared definition, so a value that is missing stays an error for both.
 */
export function openEnum<const T extends readonly [string, ...string[]]>(values: T): z.ZodType<T[number] | typeof UNKNOWN> {
  return z.string().transform((value): T[number] | typeof UNKNOWN => ((values as readonly string[]).includes(value) ? value : UNKNOWN));
}

/** What a reader gives for a strict type: objects keep unknown fields, and a string-literal union may read as "unknown". */
export type ForwardReader<T> = T extends string
  ? string extends T ? T : T | typeof UNKNOWN
  : T extends readonly (infer Item)[]
    ? Array<ForwardReader<Item>>
    : T extends object
      ? { [Key in keyof T]: ForwardReader<T[Key]> } & { [other: string]: unknown }
      : T;

type Def = { type: string } & Record<string, unknown>;
const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/**
 * The reader for a strict schema: objects become `looseObject`s, enums become `openEnum`s, an object variant of a discriminated union with a
 * kind the schema doesn't know is read with `kind: "unknown"` and its other fields kept, and everything else (strings, numbers, literals,
 * arrays, optionals) is rebuilt around the same pieces. Length and pattern rules on plain values are kept.
 */
export function forwardReader<S extends z.ZodType>(schema: S): z.ZodType<ForwardReader<z.output<S>>> {
  return readerOf(schema) as z.ZodType<ForwardReader<z.output<S>>>;
}

export function readerOf(schema: z.ZodType): z.ZodType {
  const def = defOf(schema);
  switch (def.type) {
    case "object": {
      const shape: Record<string, z.ZodType> = (schema as unknown as z.ZodObject).shape;
      return z.looseObject(Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, readerOf(field)])));
    }
    case "enum":
      return openEnum((schema as unknown as z.ZodEnum).options as unknown as readonly [string, ...string[]]);
    case "array":
      return z.array(readerOf(def.element as z.ZodType));
    case "optional":
      return readerOf(def.innerType as z.ZodType).optional();
    case "union": {
      const options = def.options as z.ZodType[];
      if (typeof def.discriminator !== "string") {
        // RULING Q41: an open enum must not swallow a valid sibling ID or another known enum value.
        const known = options.map(option => defOf(option).type === "enum" ? option : readerOf(option));
        const fallbacks = options.filter(option => defOf(option).type === "enum").map(readerOf);
        return z.union([...known, ...fallbacks] as unknown as [z.ZodType, z.ZodType]);
      }
      const discriminator = def.discriminator;
      const known = options.flatMap((option) => [...((option as unknown as z.ZodObject).shape[discriminator] as unknown as z.ZodLiteral).values]);
      const unknownVariant = z.looseObject({ [discriminator]: z.string().refine((value) => !known.includes(value)).transform((): typeof UNKNOWN => UNKNOWN) });
      return z.union([...options.map(readerOf), unknownVariant] as unknown as [z.ZodType, z.ZodType]);
    }
    default:
      return schema;
  }
}
