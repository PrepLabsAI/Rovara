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

// ---- newer evidence (TE-A2): the reader rule for the evidence pack's later versions.

/** What a reader prints when evidence has parts, kinds, values or a version it does not know. */
export const NEWER_EVIDENCE_WORDS = "Newer evidence, open in Rovara";

/** The own keys of `value` (when it is an object) that are not in `known`. Unknown keys are kept by a forward-compatible reader and reported with this. */
export function unknownKeysOf(value: unknown, known: readonly string[]): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !known.includes(key));
}

/**
 * What `tolerantRead` gives for a value of an enum it does not know. It is NOT "unknown": that is a real value of some enums (a check outcome), so a reader could not tell the two apart.
 * Nothing in the evidence pack has a real value "newer".
 */
export const NEWER_VALUE = "newer" as const;

/** What a tolerant reader gives for a strict type: objects keep unknown fields, and a string-literal union may read as `NEWER_VALUE`. */
export type TolerantRead<T> = T extends string
  ? string extends T ? T : T | typeof NEWER_VALUE
  : T extends readonly (infer Item)[]
    ? Array<TolerantRead<Item>>
    : T extends object
      ? { [Key in keyof T]: TolerantRead<T[Key]> } & { [other: string]: unknown }
      : T;

/** What a tolerant read met that its strict schema does not know. `note` is called once per place, with the path. */
export interface TolerantReport {
  /** A key the schema does not have (kept in the value). */
  unknownKey(path: string): void;
  /** A value of an enum the schema does not know (read as `NEWER_VALUE`). */
  newerValue(path: string): void;
  /** An optional part that could not be read at all and was left out. */
  unreadable(path: string): void;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const KEY_SHOWN_MAX = 60;
/** A key of untrusted data as it may appear in a reported path: cut, and every character that is not a letter, digit, `_`, `$` or `-` written as `_`, so a path can carry no markup, mention or link. */
export function safePathKey(key: string): string {
  const shown = key.slice(0, KEY_SHOWN_MAX).replace(/[^\w$-]/gu, "_");
  return key.length > KEY_SHOWN_MAX ? `${shown}...` : shown;
}

function lengthLimits(def: Def): { min: number; max: number } {
  let min = 0;
  let max = Number.POSITIVE_INFINITY;
  for (const check of (def.checks as { _zod: { def: { check: string; minimum?: number; maximum?: number } } }[] | undefined) ?? []) {
    const rule = check._zod.def;
    if (rule.check === "max_length" && rule.maximum !== undefined) max = Math.min(max, rule.maximum);
    if (rule.check === "min_length" && rule.minimum !== undefined) min = Math.max(min, rule.minimum);
  }
  return { min, max };
}

/** Sets an own property without ever running a setter: a `__proto__` key becomes an ordinary own property and never changes the prototype. */
export function setOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export type TolerantResult = { ok: true; value: unknown } | { ok: false };

/**
 * Reads `value` by the strict `schema` as far as it can be read, for a reader of data a NEWER writer may have extended. A value the strict schema accepts is returned as the schema gives it. Otherwise the schema is walked:
 *   - an object keeps its unknown keys (reported by path, and never able to change a prototype: `__proto__` is an ordinary own key) and reads its known keys; an optional key that cannot be read is left out and reported,
 *     a required one makes the object unreadable;
 *   - an enum value the schema does not know reads as `NEWER_VALUE` and is reported;
 *   - an array keeps the strict length limits, and one element that cannot be read makes the array unreadable (never a silently shorter list);
 *   - everything else (strings, numbers, literals) is read by the strict schema itself, so every bound and pattern holds.
 * Refinements (`superRefine`) are not run on a walked object: a caller that needs a cross-check makes it on the result.
 */
export function tolerantRead(schema: z.ZodType, value: unknown, path: string, report: TolerantReport): TolerantResult {
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
      return value === undefined ? { ok: true, value: undefined } : tolerantRead(def.innerType as z.ZodType, value, path, report);
    case "nullable":
      return value === null ? { ok: true, value: null } : tolerantRead(def.innerType as z.ZodType, value, path, report);
    case "enum": {
      const options = (schema as unknown as z.ZodEnum).options as readonly unknown[];
      if (typeof value !== "string") return { ok: false };
      if (options.includes(value)) return { ok: true, value };
      report.newerValue(path);
      return { ok: true, value: NEWER_VALUE };
    }
    case "object": {
      const strict = schema.safeParse(value);
      if (strict.success) return { ok: true, value: strict.data };
      if (!isPlainRecord(value)) return { ok: false };
      const shape = (schema as unknown as z.ZodObject).shape as Record<string, z.ZodType>;
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape)) {
        const present = Object.hasOwn(value, key) ? value[key] : undefined;
        const read = tolerantRead(field, present, path === "" ? key : `${path}.${key}`, report);
        if (read.ok) {
          if (read.value !== undefined) setOwnProperty(out, key, read.value);
        } else if (defOf(field).type === "optional" && present !== undefined) report.unreadable(path === "" ? key : `${path}.${key}`);
        else return { ok: false };
      }
      for (const key of Object.keys(value)) {
        if (Object.hasOwn(shape, key)) continue;
        setOwnProperty(out, key, value[key]);
        report.unknownKey(`${path === "" ? "" : `${path}.`}${safePathKey(key)}`);
      }
      return { ok: true, value: out };
    }
    case "array": {
      const strict = schema.safeParse(value);
      if (strict.success) return { ok: true, value: strict.data };
      if (!Array.isArray(value)) return { ok: false };
      const { min, max } = lengthLimits(def);
      if (value.length > max || value.length < min) return { ok: false };
      const out: unknown[] = [];
      for (const [index, item] of value.entries()) {
        const read = tolerantRead(def.element as z.ZodType, item, `${path}[${String(index)}]`, report);
        if (!read.ok) return { ok: false };
        out.push(read.value);
      }
      return { ok: true, value: out };
    }
    default: {
      const strict = schema.safeParse(value);
      return strict.success ? { ok: true, value: strict.data } : { ok: false };
    }
  }
}
