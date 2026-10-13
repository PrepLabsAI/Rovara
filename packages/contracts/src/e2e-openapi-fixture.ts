import { canonicalJson } from "./canonical-json.js";

/** Budgets are shared across every operation, parameter and response in one source contract. */
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 2_048;
const MAX_FIXTURE_DEPTH = 32;
const MAX_FIXTURE_NODES = 4_096;
const MAX_FIXTURE_LITERAL_BYTES = 65_536;
const MAX_DESCRIPTOR_BYTES = 262_144;
const MAX_PARAMETERS = 128;
const MAX_ARRAY_FIXTURE_ITEMS = 4_096;

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }

export type E2EFixtureSchema = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  properties?: Record<string, E2EFixtureSchema>;
  required?: string[];
  items?: E2EFixtureSchema;
  enum?: Array<string | number | boolean>;
  format?: "date" | "date-time" | "email" | "uuid";
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: false;
};

export type E2EOpenApiFixtureParameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema: E2EFixtureSchema;
  fixtureValue: string | number | boolean | null | unknown[] | Record<string, unknown>;
};

export type E2EOpenApiFixtureDescriptor = {
  version: "openapi-json-fixture-v1";
  semantics: "schema-witness-v2";
  operations: Array<{
    operationId: string;
    method: string;
    path: string;
    parameters: E2EOpenApiFixtureParameter[];
    requestSchema: E2EFixtureSchema | null;
    requestFixture: unknown;
    responses: Array<{ status: number; schema: E2EFixtureSchema; fixture: string | number | boolean | null | unknown[] | Record<string, unknown> }>;
  }>;
};

type SchemaBudget = { nodes: number };
type FixtureBudget = { nodes: number; literalBytes: number };

function satisfiesFormat(value: string, format: NonNullable<E2EFixtureSchema["format"]>): boolean {
  if (format === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  if (format === "date-time") {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value);
    if (!match || !satisfiesFormat(match[1]!, "date") || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime());
  }
  if (format === "email") {
    const [local, domain, extra] = value.split("@");
    return extra === undefined && local !== undefined && local.length > 0 && local.length <= 64 && domain !== undefined && domain.length <= 253 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) && /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(domain);
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isFixtureValue(schema: E2EFixtureSchema, value: unknown, depth = 0): boolean {
  if (depth > MAX_FIXTURE_DEPTH) return false;
  if (schema.enum && !schema.enum.some((candidate) => canonicalJson(candidate) === canonicalJson(value))) return false;
  if (schema.type === "object") {
    if (!object(value)) return false;
    const properties = schema.properties ?? {};
    if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
    return Object.entries(value).every(([key, item]) => Object.hasOwn(properties, key) && isFixtureValue(properties[key]!, item, depth + 1));
  }
  if (schema.type === "array") return Array.isArray(value)
    && (schema.minItems === undefined || value.length >= schema.minItems)
    && (schema.maxItems === undefined || value.length <= schema.maxItems)
    && value.every((item) => isFixtureValue(schema.items!, item, depth + 1));
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    const length = [...value].length;
    return (schema.minLength === undefined || length >= schema.minLength)
      && (schema.maxLength === undefined || length <= schema.maxLength)
      && (schema.format === undefined || satisfiesFormat(value, schema.format));
  }
  if (schema.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return (schema.type !== "integer" || Number.isInteger(value))
    && (schema.minimum === undefined || value >= schema.minimum)
    && (schema.maximum === undefined || value <= schema.maximum);
}

function fixtureValue(schema: E2EFixtureSchema, budget: FixtureBudget, depth = 0): unknown {
  if (depth > MAX_FIXTURE_DEPTH || ++budget.nodes > MAX_FIXTURE_NODES) return undefined;
  let value: unknown;
  if (schema.enum !== undefined) {
    value = schema.enum.find((candidate) => isFixtureValue(schema, candidate, depth));
    if (value === undefined) return undefined;
  } else if (schema.type === "object") {
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const name of [...(schema.required ?? [])].sort()) {
      if (!Object.hasOwn(schema.properties ?? {}, name)) return undefined;
      const child = fixtureValue(schema.properties![name]!, budget, depth + 1);
      if (child === undefined) return undefined;
      Object.defineProperty(record, name, { value: child, enumerable: true, writable: true, configurable: true });
    }
    value = record;
  } else if (schema.type === "array") {
    const count = schema.minItems ?? 0;
    if (count > MAX_ARRAY_FIXTURE_ITEMS || count > MAX_FIXTURE_NODES - budget.nodes) return undefined;
    const list: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      const item = fixtureValue(schema.items!, budget, depth + 1);
      if (item === undefined) return undefined;
      list.push(item);
    }
    value = list;
  } else if (schema.type === "string") {
    const minimum = schema.minLength ?? 0;
    if (schema.format === "uuid") value = "00000000-0000-4000-8000-000000000000";
    else if (schema.format === "date") value = "2000-01-01";
    else if (schema.format === "date-time") value = "2000-01-01T00:00:00Z";
    else if (schema.format === "email") {
      const localLength = Math.max(1, minimum - "@b.co".length);
      if (localLength > 64) return undefined;
      value = `${"a".repeat(localLength)}@b.co`;
    } else {
      if (minimum > MAX_FIXTURE_LITERAL_BYTES) return undefined;
      value = "x".repeat(minimum);
    }
    if (schema.maxLength !== undefined && [...String(value)].length > schema.maxLength) return undefined;
  } else if (schema.type === "boolean") value = false;
  else {
    const minimum = schema.minimum ?? (schema.type === "integer" ? -1_000_000 : -1_000_000);
    const maximum = schema.maximum ?? 1_000_000;
    const lower = schema.type === "integer" ? Math.ceil(minimum) : minimum;
    const upper = schema.type === "integer" ? Math.floor(maximum) : maximum;
    if (lower > upper) return undefined;
    value = lower <= 0 && upper >= 0 ? 0 : lower > 0 ? lower : upper;
  }
  if (typeof value === "string") {
    budget.literalBytes += Buffer.byteLength(value, "utf8");
    if (budget.literalBytes > MAX_FIXTURE_LITERAL_BYTES) return undefined;
  }
  return isFixtureValue(schema, value, depth) ? value : undefined;
}

function parseSchema(value: unknown, schemaBudget: SchemaBudget, depth = 0): E2EFixtureSchema | undefined {
  if (!object(value) || depth > MAX_SCHEMA_DEPTH || ++schemaBudget.nodes > MAX_SCHEMA_NODES) return undefined;
  const allowed = new Set(["type", "properties", "required", "items", "enum", "format", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "additionalProperties"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  const type = value.type;
  if (!(typeof type === "string" && ["object", "array", "string", "number", "integer", "boolean"].includes(type))) return undefined;
  const schema: E2EFixtureSchema = { type: type as E2EFixtureSchema["type"] };
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 32 || value.enum.some((item) => item === null || !["string", "number", "boolean"].includes(typeof item) || typeof item === "number" && !Number.isFinite(item))) return undefined;
    if (value.enum.some((item) => type === "string" ? typeof item !== "string" : type === "boolean" ? typeof item !== "boolean" : type === "number" ? typeof item !== "number" : type === "integer" ? typeof item !== "number" || !Number.isInteger(item) : true)) return undefined;
    schema.enum = value.enum as Array<string | number | boolean>;
  }
  if (value.format !== undefined) {
    if (type !== "string" || typeof value.format !== "string" || !["date", "date-time", "email", "uuid"].includes(value.format)) return undefined;
    schema.format = value.format as NonNullable<E2EFixtureSchema["format"]>;
  }
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) {
    const bound = value[key];
    if (bound === undefined) continue;
    const lengthBound = key === "minLength" || key === "maxLength";
    const itemBound = key === "minItems" || key === "maxItems";
    const numericBound = key === "minimum" || key === "maximum";
    if (typeof bound !== "number" || !Number.isFinite(bound) || Math.abs(bound) > 1_000_000
      || lengthBound && type !== "string" || itemBound && type !== "array" || numericBound && !["number", "integer"].includes(type)
      || (lengthBound || itemBound) && (!Number.isInteger(bound) || bound < 0)) return undefined;
    schema[key] = bound;
  }
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum
    || schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength
    || schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) return undefined;
  if (value.additionalProperties !== undefined) {
    if (value.additionalProperties !== false) return undefined;
    schema.additionalProperties = false;
  }
  if (type === "object") {
    if (!object(value.properties) || Object.keys(value.properties).length > 32) return undefined;
    const properties: Record<string, E2EFixtureSchema> = Object.create(null) as Record<string, E2EFixtureSchema>;
    for (const [name, child] of Object.entries(value.properties)) {
      if (name.length === 0 || name.length > 120) return undefined;
      const parsed = parseSchema(child, schemaBudget, depth + 1);
      if (!parsed) return undefined;
      Object.defineProperty(properties, name, { value: parsed, enumerable: true, writable: true, configurable: true });
    }
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.length > 32
      || value.required.some((name) => typeof name !== "string" || !Object.hasOwn(properties, name))
      || new Set(value.required).size !== value.required.length)) return undefined;
    schema.properties = properties;
    if (Array.isArray(value.required)) schema.required = [...value.required as string[]].sort();
  } else if (type === "array") {
    const items = parseSchema(value.items, schemaBudget, depth + 1);
    if (!items) return undefined;
    schema.items = items;
  } else if (value.properties !== undefined || value.required !== undefined || value.items !== undefined || value.additionalProperties !== undefined) return undefined;
  return schema;
}

const pathKeys = new Set(["summary", "description", "parameters"]);
const operationKeys = new Set(["operationId", "responses", "requestBody", "parameters", "summary", "description", "deprecated", "tags"]);

function parseParameters(value: unknown, schemaBudget: SchemaBudget, fixtureBudget: FixtureBudget): E2EOpenApiFixtureParameter[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PARAMETERS) return undefined;
  const result: E2EOpenApiFixtureParameter[] = [];
  for (const item of value) {
    if (!object(item) || Object.keys(item).some((key) => !["name", "in", "required", "schema", "description", "deprecated"].includes(key))
      || typeof item.name !== "string" || item.name.length === 0 || item.name.length > 120
      || !["path", "query", "header", "cookie"].includes(String(item.in))
      || item.required !== undefined && typeof item.required !== "boolean"
      || item.in === "path" && item.required !== true) return undefined;
    const schema = parseSchema(item.schema, schemaBudget);
    if (!schema) return undefined;
    const fixture = fixtureValue(schema, fixtureBudget);
    if (fixture === undefined) return undefined;
    result.push({ name: item.name, in: item.in as E2EOpenApiFixtureParameter["in"], required: item.required === true, schema, fixtureValue: fixture as E2EOpenApiFixtureParameter["fixtureValue"] });
  }
  return result;
}

function mergeParameters(pathParameters: E2EOpenApiFixtureParameter[], operationParameters: E2EOpenApiFixtureParameter[]): E2EOpenApiFixtureParameter[] | undefined {
  const merged = new Map<string, E2EOpenApiFixtureParameter>();
  for (const parameter of pathParameters) merged.set(`${parameter.in}\0${parameter.name}`, parameter);
  for (const parameter of operationParameters) merged.set(`${parameter.in}\0${parameter.name}`, parameter);
  if (merged.size > MAX_PARAMETERS) return undefined;
  return [...merged.values()].sort((a, b) => a.in.localeCompare(b.in) || a.name.localeCompare(b.name));
}

function jsonDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== "object") return depth;
  const children: unknown[] = Array.isArray(value) ? value as unknown[] : Object.values(value);
  return children.reduce<number>((maximum, child) => Math.max(maximum, jsonDepth(child, depth + 1)), depth);
}

/**
 * Parse a strict, bounded OpenAPI JSON subset and produce a deterministic witness for every
 * consumed schema. The witness is fixture data, never an expected application result.
 */
export function createE2EOpenApiFixtureDescriptor(bytes: Uint8Array): E2EOpenApiFixtureDescriptor | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_BYTES) return undefined;
  let document: unknown;
  try { document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return undefined; }
  if (!object(document) || Object.keys(document).some((key) => !["openapi", "info", "paths"].includes(key))
    || typeof document.openapi !== "string" || !/^3\.(?:0|1)\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(document.openapi)
    || !object(document.info) || typeof document.info.title !== "string" || document.info.title.length === 0
    || typeof document.info.version !== "string" || document.info.version.length === 0 || !object(document.paths)) return undefined;
  const entries = Object.entries(document.paths);
  if (entries.length === 0 || entries.length > 64) return undefined;
  const schemaBudget: SchemaBudget = { nodes: 0 };
  const fixtureBudget: FixtureBudget = { nodes: 0, literalBytes: 0 };
  const operations: E2EOpenApiFixtureDescriptor["operations"] = [];
  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  for (const [path, pathItem] of entries) {
    if (!path.startsWith("/") || path.length > 512 || path.includes("..") || !object(pathItem)
      || Object.keys(pathItem).some((key) => !methods.has(key.toLowerCase()) && !pathKeys.has(key))) return undefined;
    const pathParameters = parseParameters(pathItem.parameters, schemaBudget, fixtureBudget);
    if (!pathParameters) return undefined;
    const methodsForPath = Object.entries(pathItem).filter(([key]) => methods.has(key.toLowerCase()));
    if (methodsForPath.length === 0) return undefined;
    for (const [rawMethod, rawOperation] of methodsForPath) {
      if (!object(rawOperation) || Object.keys(rawOperation).some((key) => !operationKeys.has(key)) || !object(rawOperation.responses)) return undefined;
      const method = rawMethod.toUpperCase();
      const operationId = typeof rawOperation.operationId === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(rawOperation.operationId) ? rawOperation.operationId : `${method} ${path}`;
      const operationParameters = parseParameters(rawOperation.parameters, schemaBudget, fixtureBudget);
      const parameters = operationParameters && mergeParameters(pathParameters, operationParameters);
      if (!parameters) return undefined;
      const pathVariables = [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!);
      if (new Set(pathVariables).size !== pathVariables.length || pathVariables.some((name) => !parameters.some((parameter) => parameter.in === "path" && parameter.name === name))
        || parameters.some((parameter) => parameter.in === "path" && !pathVariables.includes(parameter.name))) return undefined;
      let requestSchema: E2EFixtureSchema | null = null;
      let requestFixture: E2EOpenApiFixtureDescriptor["operations"][number]["requestFixture"] = null;
      if (rawOperation.requestBody !== undefined) {
        const body = rawOperation.requestBody;
        if (!object(body) || Object.keys(body).some((key) => !["required", "description", "content"].includes(key))
          || body.required !== undefined && typeof body.required !== "boolean" || !object(body.content)
          || Object.keys(body.content).length !== 1 || !object(body.content["application/json"])) return undefined;
        const content = body.content["application/json"];
        if (Object.keys(content).some((key) => key !== "schema")) return undefined;
        const parsed = parseSchema(content.schema, schemaBudget);
        if (!parsed) return undefined;
        const fixture = fixtureValue(parsed, fixtureBudget);
        if (fixture === undefined) return undefined;
        requestSchema = parsed;
        requestFixture = fixture;
      }
      const responses: E2EOpenApiFixtureDescriptor["operations"][number]["responses"] = [];
      for (const [statusText, responseValue] of Object.entries(rawOperation.responses)) {
        if (!/^2\d\d$/.test(statusText) || !object(responseValue)
          || Object.keys(responseValue).some((key) => !["description", "content"].includes(key))
          || !object(responseValue.content) || Object.keys(responseValue.content).length !== 1 || !object(responseValue.content["application/json"])) return undefined;
        const content = responseValue.content["application/json"];
        if (Object.keys(content).some((key) => key !== "schema")) return undefined;
        const schema = parseSchema(content.schema, schemaBudget);
        if (!schema) return undefined;
        const fixture = fixtureValue(schema, fixtureBudget);
        if (fixture === undefined) return undefined;
        responses.push({ status: Number(statusText), schema, fixture: fixture as E2EOpenApiFixtureDescriptor["operations"][number]["responses"][number]["fixture"] });
      }
      if (responses.length === 0) return undefined;
      responses.sort((a, b) => a.status - b.status);
      operations.push({ operationId, method, path, parameters, requestSchema, requestFixture, responses });
    }
  }
  if (operations.length > 320 || new Set(operations.map((operation) => operation.operationId)).size !== operations.length) return undefined;
  const descriptor: E2EOpenApiFixtureDescriptor = { version: "openapi-json-fixture-v1", semantics: "schema-witness-v2", operations };
  try {
    if (Buffer.byteLength(canonicalJson(descriptor), "utf8") > MAX_DESCRIPTOR_BYTES || jsonDepth(descriptor) > 64) return undefined;
  } catch { return undefined; }
  return descriptor;
}
