// Service mocks (E8): the small JSON schema the recorder infers from recorded bodies, the check a request or response is held to, and the deterministic synthetic answer a `schema_synth` mock gives. The schema
// subset is `ServiceMockJsonSchema` (contracts), bounded in depth and size. Pure; no I/O.
import {
  SERVICE_MOCK_SCHEMA_MAX_DEPTH,
  SERVICE_MOCK_SCHEMA_MAX_NODES,
  ServiceMockJsonSchemaSchema,
  type ServiceMockJsonSchema,
} from "@agentx/contracts";
import type { SyntheticGenerator } from "../data-guard.js";

type Type = ServiceMockJsonSchema["type"];
const FORMATS: ReadonlyArray<{ format: NonNullable<ServiceMockJsonSchema["format"]>; test: RegExp }> = [
  { format: "date-time", test: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u },
  { format: "date", test: /^\d{4}-\d{2}-\d{2}$/u },
  { format: "uuid", test: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu },
  { format: "email", test: /^[^@\s]{1,64}@[^@\s]{1,255}$/u },
];

function typeOf(value: unknown): Type | undefined {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string": return "string";
    case "boolean": return "boolean";
    case "number": return Number.isFinite(value) ? (Number.isInteger(value) ? "integer" : "number") : undefined;
    case "object": return "object";
    default: return undefined;
  }
}

function infer(samples: readonly unknown[], depth: number): ServiceMockJsonSchema | undefined {
  if (samples.length === 0 || depth > SERVICE_MOCK_SCHEMA_MAX_DEPTH) return undefined;
  const types = new Set(samples.map(typeOf));
  if (types.has(undefined)) return undefined;
  // integers and numbers together are numbers; any other mix has no one type, so the part is left unconstrained.
  if (types.size === 2 && types.has("integer") && types.has("number")) types.delete("integer");
  if (types.size !== 1) return undefined;
  const type = [...types][0] as Type;
  if (type === "object") {
    const objects = samples as Array<Record<string, unknown>>;
    const keys = [...new Set(objects.flatMap((object) => Object.keys(object)))].sort().slice(0, 256);
    const properties: Record<string, ServiceMockJsonSchema> = {};
    for (const key of keys) {
      const child = infer(objects.filter((object) => key in object).map((object) => object[key]), depth + 1);
      if (child !== undefined) properties[key] = child;
    }
    const required = keys.filter((key) => objects.every((object) => key in object));
    return { type, properties, ...(required.length === 0 ? {} : { required }) };
  }
  if (type === "array") {
    const items = infer((samples as unknown[][]).flat(), depth + 1);
    return items === undefined ? { type } : { type, items };
  }
  if (type === "string") {
    const strings = samples as string[];
    const format = FORMATS.find((candidate) => strings.every((text) => candidate.test.test(text)))?.format;
    return format === undefined ? { type } : { type, format };
  }
  return { type };
}

/** The schema of the recorded bodies (each parsed as JSON), or null when there are none or they do not share a shape. Never exceeds the contract's depth and size limits (null instead). */
export function inferJsonSchema(samples: readonly unknown[]): ServiceMockJsonSchema | null {
  const schema = infer(samples, 1);
  if (schema === undefined) return null;
  const checked = ServiceMockJsonSchemaSchema.safeParse(schema);
  return checked.success && countNodes(checked.data) <= SERVICE_MOCK_SCHEMA_MAX_NODES ? checked.data : null;
}

function countNodes(schema: ServiceMockJsonSchema): number {
  return 1 + Object.values(schema.properties ?? {}).reduce((sum, child) => sum + countNodes(child), 0) + (schema.items === undefined ? 0 : countNodes(schema.items));
}

/** Whether a value satisfies the schema. Unknown extra properties are fine unless `additionalProperties: false`. */
export function schemaAccepts(schema: ServiceMockJsonSchema, value: unknown, depth = 1): boolean {
  if (depth > SERVICE_MOCK_SCHEMA_MAX_DEPTH) return false;
  const actual = typeOf(value);
  const okType = actual === schema.type || (schema.type === "number" && actual === "integer");
  if (!okType) return false;
  if (schema.enum !== undefined && !schema.enum.includes(value as string | number | boolean)) return false;
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    const format = FORMATS.find((candidate) => candidate.format === schema.format);
    if (format !== undefined && !format.test.test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && !value.every((item) => schemaAccepts(schema.items as ServiceMockJsonSchema, item, depth + 1))) return false;
  } else if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    if ((schema.required ?? []).some((key) => !(key in object))) return false;
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in object && !schemaAccepts(child, object[key], depth + 1)) return false;
    if (schema.additionalProperties === false && Object.keys(object).some((key) => schema.properties?.[key] === undefined)) return false;
  }
  return true;
}

/** A deterministic value that satisfies the schema: the same generator state gives the same answer. */
export function synthesizeFromSchema(schema: ServiceMockJsonSchema, generator: SyntheticGenerator, depth = 1): unknown {
  if (depth > SERVICE_MOCK_SCHEMA_MAX_DEPTH) return null;
  if (schema.enum !== undefined && schema.enum.length > 0) return generator.pick(schema.enum);
  switch (schema.type) {
    case "null": return null;
    case "boolean": return generator.int(0, 1) === 1;
    case "integer": {
      const low = Math.ceil(schema.minimum ?? 0);
      const high = Math.floor(schema.maximum ?? low + 1_000);
      return generator.int(low, Math.max(low, Math.min(high, low + 1_000)));
    }
    case "number": {
      const low = schema.minimum ?? 0;
      const high = Math.max(low, Math.min(schema.maximum ?? low + 1, low + 1));
      return low + (high - low) * (generator.int(0, 1_000) / 1_000);
    }
    case "string": {
      let text = schema.format === "date-time" ? "2026-01-01T00:00:00.000Z" : schema.format === "date" ? "2026-01-01" : schema.format === "uuid" ? generator.uuid() : schema.format === "email" ? generator.email() : generator.id("synthetic");
      if (schema.minLength !== undefined && text.length < schema.minLength) text = text.padEnd(schema.minLength, "x");
      if (schema.maxLength !== undefined && text.length > schema.maxLength) text = text.slice(0, schema.maxLength);
      return text;
    }
    case "array": {
      const count = Math.min(schema.maxItems ?? Number.MAX_SAFE_INTEGER, Math.max(schema.minItems ?? 0, schema.items === undefined ? 0 : 1));
      return Array.from({ length: count }, () => (schema.items === undefined ? null : synthesizeFromSchema(schema.items, generator, depth + 1)));
    }
    case "object": {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(schema.properties ?? {})) result[key] = synthesizeFromSchema(child, generator, depth + 1);
      for (const key of schema.required ?? []) if (!(key in result)) result[key] = null;
      return result;
    }
  }
}
