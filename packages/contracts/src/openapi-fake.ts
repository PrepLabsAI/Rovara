// General fakes slice 1 (owner decision 234; plan lanes TE-G2 and TE-G6): the OpenAPI adapter of the generic contract finder (service-contract.ts, PR 589). It turns a parsed OpenAPI 3.x description
// into one answer per operation: the operation's lowest 2xx JSON answer schema goes through the finder's own schema subset (`findServiceContract`) and its labelled mock config (`generateServiceMock`), whose
// "typical" output is the answer. Everything it cannot fake EXACTLY is refused per operation (`operation_unsupported`) and never guessed: enums, compositions, nullable values, additional properties, refs
// to other files, ref cycles, non-JSON answers, operations with no 2xx answer, and schemas past the finder's node and depth limits. A document that is not an OpenAPI 3 description, or past the operation
// limit, is `spec_unreadable` as a WHOLE (never partly served). Annotation keywords (description, example, format, default, ...) are dropped before the finder sees the schema, so no example value from the
// description is ever copied into an answer: answers are the finder's synthetic values ("example", mid-range numbers).
// Pure: the caller parses the file (YAML or JSON) and supplies the value. No filesystem, network or clock.
import { findServiceContract, type ContractAdapter } from "./service-contract.js";
import { generateServiceMock } from "./service-contract-mock.js";

export const OPENAPI_FAKE_LIMITS = {
  operations: 256,
  /** `$ref` hops and schema nodes expanded across the WHOLE document, so a ref chain cannot make building slow. */
  documentNodes: 20_000,
  /** Nodes one operation's answer may expand to (the finder refuses past 256 anyway). */
  operationNodes: 256,
  depth: 12,
  pathCharacters: 2_048,
} as const;
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;
const ANNOTATIONS = new Set(["description", "title", "example", "examples", "format", "deprecated", "readOnly", "writeOnly", "xml", "externalDocs", "default"]);

export type OpenApiFakeAnswer = { status: number; body: unknown };
interface Operation { method: string; pattern: RegExp; literalSegments: number; segments: number; answer: OpenApiFakeAnswer | "unsupported" }
export type OpenApiFake =
  | { status: "built"; basePath: string; operations: readonly Operation[] }
  | { status: "not_built"; reason: "spec_unreadable" };
export type OpenApiFakeResult =
  | { kind: "served"; status: number; body: unknown }
  | { kind: "cannot_answer"; reason: "operation_unknown" | "operation_unsupported" };

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const pointerPart = (name: string) => name.replaceAll("~", "~0").replaceAll("/", "~1");
class Unsupported extends Error {}
const refuse = (): never => { throw new Unsupported("unsupported"); };

interface Budget { document: { nodes: number }; operation: number }
/** The schema in the finder's subset, with local component refs inlined. Throws `Unsupported` for anything else. */
function normalize(schema: unknown, components: Record<string, unknown>, depth: number, budget: Budget, refs: readonly string[]): unknown {
  if (++budget.document.nodes > OPENAPI_FAKE_LIMITS.documentNodes || ++budget.operation > OPENAPI_FAKE_LIMITS.operationNodes || depth > OPENAPI_FAKE_LIMITS.depth || !object(schema)) refuse();
  const record = schema as Record<string, unknown>;
  if (Object.hasOwn(record, "$ref")) {
    const ref = record.$ref;
    const match = typeof ref === "string" ? /^#\/components\/schemas\/([A-Za-z0-9._-]{1,128})$/u.exec(ref) : null;
    if (match === null || refs.includes(match[1]!) || Object.keys(record).some((key) => key !== "$ref" && !ANNOTATIONS.has(key) && !key.startsWith("x-"))) return refuse();
    if (!Object.hasOwn(components, match[1]!)) return refuse();
    return normalize(components[match[1]!], components, depth, budget, [...refs, match[1]!]);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (ANNOTATIONS.has(key) || key.startsWith("x-") || (key === "nullable" && value === false)) continue;
    out[key] = value;
  }
  if (out.type === undefined && Object.hasOwn(out, "properties")) out.type = "object";
  if (out.type === "object") {
    if (out.properties === undefined) out.properties = {};
    if (!object(out.properties)) return refuse();
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([name, entry]) => [name, normalize(entry, components, depth + 1, budget, refs)]));
  } else if (out.type === "array") {
    out.items = normalize(out.items, components, depth + 1, budget, refs);
  }
  // Every other keyword (enum, oneOf, nullable, additionalProperties, ...) reaches the finder, whose subset refuses it.
  return out;
}

function adapterFor(pointer: string): ContractAdapter {
  return {
    service: "openapi",
    kinds: ["output_schema"],
    errorCases: [],
    errorRateKeys: [],
    read: ({ content }) => {
      try { return { status: "ok", form: "schema", value: JSON.parse(content) as unknown, pointer }; } catch { return { status: "unsupported", reason: "invalid_json" }; }
    },
  };
}

/** The status and answer of one operation, or "unsupported". */
function answerOf(operation: unknown, where: string, path: string, components: Record<string, unknown>, responsesComponents: Record<string, unknown>, document: { nodes: number }): OpenApiFakeAnswer | "unsupported" {
  try {
    if (!object(operation) || !object(operation.responses)) return refuse();
    const statuses = Object.keys(operation.responses).filter((key) => /^2\d\d$/u.test(key)).sort();
    const status = statuses[0];
    if (status === undefined) return refuse();
    let response = operation.responses[status];
    if (object(response) && Object.hasOwn(response, "$ref")) {
      const match = typeof response.$ref === "string" ? /^#\/components\/responses\/([A-Za-z0-9._-]{1,128})$/u.exec(response.$ref) : null;
      if (match === null || !Object.hasOwn(responsesComponents, match[1]!)) return refuse();
      response = responsesComponents[match[1]!];
      // One hop only: a response that is itself a ref is refused, never answered as "no body".
      if (object(response) && Object.hasOwn(response, "$ref")) return refuse();
    }
    if (!object(response)) return refuse();
    const content = response.content;
    if (content === undefined || (object(content) && Object.keys(content).length === 0)) return { status: Number(status), body: undefined };
    if (!object(content)) return refuse();
    const media = Object.keys(content).find((type) => /^application\/(?:[a-z0-9.-]+\+)?json$/u.test(type.split(";")[0]!.trim().toLowerCase()));
    if (media === undefined) return refuse();
    const mediaObject = content[media];
    if (!object(mediaObject) || mediaObject.schema === undefined) return refuse();
    const schema = normalize(mediaObject.schema, components, 0, { document, operation: 0 }, []);
    const pointer = `${where}/responses/${status}/content/${pointerPart(media)}/schema`;
    const adapter = adapterFor(pointer);
    const found = findServiceContract(adapter, [{ kind: "output_schema", path, content: JSON.stringify(schema) }]);
    if (found.status !== "found") return refuse();
    return { status: Number(status), body: generateServiceMock(adapter, found.contract).outputs[0].body };
  } catch {
    return "unsupported";
  }
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function patternOf(template: string): { pattern: RegExp; literalSegments: number; segments: number } | undefined {
  const parts = template.split("/").slice(1);
  let literal = 0;
  const source: string[] = [];
  for (const part of parts) {
    if (!/\{/u.test(part)) { literal += 1; source.push(escapeRegex(part)); continue; }
    if (!/^(?:[^{}]*\{[A-Za-z0-9._-]{1,64}\})+[^{}]*$/u.test(part)) return undefined;
    source.push(part.split(/\{[A-Za-z0-9._-]{1,64}\}/u).map(escapeRegex).join("[^/]+"));
  }
  return { pattern: new RegExp(`^/${source.join("/")}$`, "u"), literalSegments: literal, segments: parts.length };
}

function basePathOf(servers: unknown): string {
  if (!Array.isArray(servers) || !object(servers[0]) || typeof servers[0].url !== "string") return "";
  const url = servers[0].url;
  if (url.includes("{") || url.length > OPENAPI_FAKE_LIMITS.pathCharacters) return "";
  let path = "";
  if (/^https?:\/\//iu.test(url)) {
    try { path = new URL(url).pathname; } catch { return ""; }
  } else if (url.startsWith("/")) path = url;
  return path.replace(/\/+$/u, "");
}

/** Builds the fake for one parsed OpenAPI 3.x document. `path` is where it came from (kept only as the contract's provenance, never shown). */
export function buildOpenApiFake(document: unknown, path: string): OpenApiFake {
  const unreadable = { status: "not_built", reason: "spec_unreadable" } as const;
  if (!object(document) || typeof document.openapi !== "string" || !/^3\.\d+(?:\.\d+)?$/u.test(document.openapi) || !object(document.paths)) return unreadable;
  const componentsRoot = object(document.components) ? document.components : {};
  const components = object(componentsRoot.schemas) ? componentsRoot.schemas : {};
  const responses = object(componentsRoot.responses) ? componentsRoot.responses : {};
  const entries = Object.entries(document.paths);
  let count = 0;
  for (const [template, item] of entries) {
    if (!template.startsWith("/") || template.length > OPENAPI_FAKE_LIMITS.pathCharacters || !object(item)) return unreadable;
    count += METHODS.filter((method) => Object.hasOwn(item, method)).length + (Object.hasOwn(item, "$ref") ? 1 : 0);
  }
  if (count > OPENAPI_FAKE_LIMITS.operations) return unreadable;
  const budget = { nodes: 0 };
  const operations: Operation[] = [];
  for (const [template, item] of entries) {
    const matcher = patternOf(template);
    const where = `/paths/${pointerPart(template)}`;
    const record = item as Record<string, unknown>;
    // A path item that is a ref (or a template this adapter cannot match) has operations it cannot list: every call to that path is unsupported, never unknown.
    if (matcher === undefined || Object.hasOwn(record, "$ref")) {
      operations.push({ method: "*", ...(matcher ?? { pattern: new RegExp(`^${escapeRegex(template)}$`, "u"), literalSegments: 0, segments: 0 }), answer: "unsupported" });
      continue;
    }
    for (const method of METHODS) {
      if (!Object.hasOwn(record, method)) continue;
      operations.push({ method, ...matcher, answer: answerOf(record[method], `${where}/${method}`, path, components, responses, budget) });
    }
  }
  // OpenAPI: concrete paths match before templated ones.
  operations.sort((a, b) => b.literalSegments - a.literalSegments || a.segments - b.segments);
  return { status: "built", basePath: basePathOf(document.servers), operations };
}

/** The fake's answer to one call. The query and fragment are ignored; the server's base path is tried stripped first. */
export function answerOpenApiFake(fake: OpenApiFake, method: string, requestPath: string): OpenApiFakeResult {
  if (fake.status !== "built" || typeof method !== "string" || typeof requestPath !== "string" || requestPath.length > OPENAPI_FAKE_LIMITS.pathCharacters) return { kind: "cannot_answer", reason: "operation_unknown" };
  const path = requestPath.split(/[?#]/u)[0]!;
  const candidates = fake.basePath !== "" && (path === fake.basePath || path.startsWith(`${fake.basePath}/`)) ? [path.slice(fake.basePath.length) || "/", path] : [path];
  const verb = method.toLowerCase();
  for (const candidate of candidates) {
    const onPath = fake.operations.filter((operation) => operation.pattern.test(candidate));
    if (onPath.length === 0) continue;
    // The most specific template that has this method; a path whose operations cannot be listed is unsupported.
    const best = onPath[0]!;
    // Two different templates equally specific for this path (`/a/{x}` and `/{y}/b` for `/a/b`): refused, never picked by document order.
    if (onPath.some((operation) => operation.pattern.source !== best.pattern.source && operation.literalSegments === best.literalSegments && operation.segments === best.segments)) return { kind: "cannot_answer", reason: "operation_unsupported" };
    const sameTemplate = onPath.filter((operation) => operation.pattern.source === best.pattern.source);
    const operation = sameTemplate.find((entry) => entry.method === verb) ?? sameTemplate.find((entry) => entry.method === "*");
    if (operation === undefined) return { kind: "cannot_answer", reason: "operation_unknown" };
    if (operation.answer === "unsupported") return { kind: "cannot_answer", reason: "operation_unsupported" };
    return { kind: "served", status: operation.answer.status, body: structuredClone(operation.answer.body) };
  }
  return { kind: "cannot_answer", reason: "operation_unknown" };
}
