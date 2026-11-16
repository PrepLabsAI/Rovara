// Moved from packages/broker/src/core/test-env (PR 589) so the worker can build fakes too (general fakes, DEC 234); the broker path re-exports it.
// Generic "find an outside service's contract" (plan lane TE-G6, owner call O10: outside services are generic).
// A ContractAdapter turns one kind of repo file for ONE service into a parsed value; this module does the rest:
// pick the best supported source, build the answer shape, keep per-field provenance, and validate the result.
// Pure and offline: callers supply file contents; no filesystem reads, code execution, network, store or proof wiring.
// Supported shapes: type, properties, required, items, minimum and maximum. Anything else refuses that candidate
// rather than silently weakening its shape. Nothing calls this in production yet (SageMaker is the first adapter).
export const CONTRACT_LIMITS = { files: 64, characters: 65_536, depth: 12, nodes: 256 } as const;
export type ContractSourceKind = "fixture" | "inference" | "output_schema";
export interface ContractSource { kind: ContractSourceKind; path: string; pointer: string }
export type AnswerShape = { source: ContractSource } & (
  | { type: "object"; fields: { name: string; required: boolean; shape: AnswerShape }[] }
  | { type: "array"; items: AnswerShape }
  | { type: "number" | "integer"; minimum?: number; maximum?: number }
  | { type: "string" | "boolean" | "null" }
);
export interface ServiceContract { source: ContractSource; shape: AnswerShape }
export interface ContractFile { kind: ContractSourceKind; path: string; content: string | null }
export type ContractReason = "selected" | "lower_priority" | "invalid_input" | "unreadable" | "too_large" | "invalid_json" | "unsupported_inference" | "unsupported_shape";
export interface ContractInputResult { index: number; reason: ContractReason }
export type ContractResult =
  | { status: "found"; contract: ServiceContract; inputs: ContractInputResult[] }
  | { status: "not_found"; message: "No contract found"; reason: "too_many_inputs" | "no_supported_input"; inputs: ContractInputResult[] };

/** What an adapter says about one file. "example" is a sample answer (shape inferred from its types);
 * "schema" is a JSON-Schema subset (shape taken from it). Anything the adapter cannot understand exactly is "unsupported". */
export type AdapterRead =
  | { status: "ok"; form: "example" | "schema"; value: unknown; pointer: string }
  | { status: "unsupported"; reason: "invalid_json" | "unsupported_inference" };
/** One outside service's way of finding its contract. `kinds` is the priority order: the first supported file of the
 * first kind wins. `errorCases` are the labelled failure answers the mock config carries (fixed words, no echoed input).
 * A `read` that throws or returns anything unexpected counts as unsupported, never as a guess. */
export interface ContractAdapter {
  service: string;
  kinds: readonly ContractSourceKind[];
  errorCases: readonly { scenario: string; status?: number }[];
  /** Keys of the independent error rates a mock config carries (each 0 to 1, summing to at most 1; all default to 0). */
  errorRateKeys: readonly string[];
  read(file: { kind: ContractSourceKind; path: string; content: string }): AdapterRead;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const pointer = (name: string) => name.replaceAll("~", "~0").replaceAll("/", "~1");
function child(source: ContractSource, part: string): ContractSource { return { ...source, pointer: `${source.pointer}/${part}` }; }
const unsupported = (): never => { throw new Error("unsupported_shape"); };
interface Budget { nodes: number }
function count(depth: number, budget: Budget): void {
  if (depth > CONTRACT_LIMITS.depth || ++budget.nodes > CONTRACT_LIMITS.nodes) unsupported();
}
function signature(shape: AnswerShape): string {
  if (shape.type === "object") return JSON.stringify([shape.type, shape.fields.map((field) => [field.name, signature(field.shape)]).sort()]);
  if (shape.type === "array") return JSON.stringify([shape.type, signature(shape.items)]);
  return shape.type;
}
export function shapeFromValue(value: unknown, source: ContractSource, depth: number, budget: Budget): AnswerShape {
  count(depth, budget);
  if (value === null) return { type: "null", source };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) unsupported();
    return { type: "number", source };
  }
  if (typeof value === "string") return { type: "string", source };
  if (typeof value === "boolean") return { type: "boolean", source };
  if (Array.isArray(value)) {
    if (value.length === 0) unsupported();
    const shapes = value.map((entry, i) => shapeFromValue(entry, child(source, String(i)), depth + 1, budget));
    const first = shapes[0]!;
    if (shapes.some((entry) => signature(entry) !== signature(first))) unsupported();
    return { type: "array", source, items: first };
  }
  if (!object(value)) return unsupported();
  return { type: "object", source, fields: Object.entries(value).map(([name, entry]) => ({ name, required: true, shape: shapeFromValue(entry, child(source, pointer(name)), depth + 1, budget) })) };
}
export function shapeFromSchema(value: unknown, source: ContractSource, depth: number, budget: Budget): AnswerShape {
  count(depth, budget);
  if (!object(value)) return unsupported();
  const allowed = value.type === "object" ? ["type", "properties", "required"] : value.type === "array" ? ["type", "items"] : value.type === "number" || value.type === "integer" ? ["type", "minimum", "maximum"] : ["type"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) unsupported();
  if (value.type === "object") {
    if (!object(value.properties)) return unsupported();
    const properties = value.properties;
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((key: unknown) => typeof key !== "string" || !Object.hasOwn(properties, key)))) unsupported();
    const required = new Set(Array.isArray(value.required) ? value.required as string[] : []);
    return { type: "object", source, fields: Object.entries(properties).map(([name, entry]) => ({ name, required: required.has(name), shape: shapeFromSchema(entry, child(source, `properties/${pointer(name)}`), depth + 1, budget) })) };
  }
  if (value.type === "array") return { type: "array", source, items: shapeFromSchema(value.items, child(source, "items"), depth + 1, budget) };
  if (value.type === "number" || value.type === "integer") {
    const shape: AnswerShape = { type: value.type, source };
    for (const key of ["minimum", "maximum"] as const) {
      const n = value[key];
      if (n !== undefined) {
        if (typeof n !== "number" || !Number.isFinite(n)) unsupported();
        shape[key] = n as number;
      }
    }
    const minimum = shape.type === "integer" && shape.minimum !== undefined ? Math.ceil(shape.minimum) : shape.minimum;
    const maximum = shape.type === "integer" && shape.maximum !== undefined ? Math.floor(shape.maximum) : shape.maximum;
    const low = minimum ?? Math.min(0, maximum ?? 0);
    const high = maximum ?? Math.max(1, low);
    if (low > high) unsupported();
    return shape;
  }
  if (value.type === "string" || value.type === "boolean" || value.type === "null") return { type: value.type, source };
  return unsupported();
}

/** Inputs must be classified by the caller for one service. All decisions are indexed
 * back to the input list; no raw response values or inference source are retained. */
export function findServiceContract(adapter: ContractAdapter, files: readonly ContractFile[]): ContractResult {
  if (files.length > CONTRACT_LIMITS.files) return { status: "not_found", message: "No contract found", reason: "too_many_inputs", inputs: [] };
  const inputs: ContractInputResult[] = files.map((file, index) => ({
    index,
    reason: !object(file) || !adapter.kinds.includes(file.kind) || typeof file.path !== "string" || (typeof file.content !== "string" && file.content !== null) ? "invalid_input" : "lower_priority",
  }));
  let contract: ServiceContract | undefined;
  for (const kind of adapter.kinds) {
    for (const [index, file] of files.entries()) {
      const result = inputs[index]!;
      if (result.reason === "invalid_input" || file.kind !== kind || contract !== undefined) continue;
      if (file.content === null) { result.reason = "unreadable"; continue; }
      if (file.content.length > CONTRACT_LIMITS.characters || file.path.length > 2048) { result.reason = "too_large"; continue; }
      let read: AdapterRead;
      try { read = adapter.read({ kind, path: file.path, content: file.content }); } catch { result.reason = "unsupported_shape"; continue; }
      if (!object(read) || (read.status !== "ok" && read.status !== "unsupported")) { result.reason = "unsupported_shape"; continue; }
      if (read.status === "unsupported") { result.reason = read.reason === "invalid_json" ? "invalid_json" : "unsupported_inference"; continue; }
      if ((read.form !== "example" && read.form !== "schema") || typeof read.pointer !== "string" || read.pointer.length > CONTRACT_LIMITS.characters) { result.reason = "unsupported_shape"; continue; }
      const source = { kind, path: file.path, pointer: read.pointer };
      try {
        const shape = (read.form === "schema" ? shapeFromSchema : shapeFromValue)(read.value, source, 0, { nodes: 0 });
        contract = { source, shape };
        result.reason = "selected";
      } catch { result.reason = "unsupported_shape"; }
    }
  }
  return contract === undefined ? { status: "not_found", message: "No contract found", reason: "no_supported_input", inputs } : { status: "found", contract, inputs };
}

/** Validate the normalized contract at the generator/config boundary too. */
export function isServiceContract(value: unknown): value is ServiceContract {
  const sourceKinds: readonly string[] = ["fixture", "inference", "output_schema"];
  const keys = (entry: Record<string, unknown>, allowed: string[]) => Object.keys(entry).every((key) => allowed.includes(key));
  const validSource = (source: unknown): source is ContractSource => object(source) && keys(source, ["kind", "path", "pointer"]) && sourceKinds.includes(source.kind as string) && typeof source.path === "string" && source.path.length <= 2048 && typeof source.pointer === "string" && source.pointer.length <= CONTRACT_LIMITS.characters;
  const budget = { nodes: 0 };
  function valid(shape: unknown, depth: number): boolean {
    count(depth, budget);
    if (!object(shape) || !validSource(shape.source)) return false;
    const allowed = shape.type === "object" ? ["fields"] : shape.type === "array" ? ["items"] : shape.type === "number" || shape.type === "integer" ? ["minimum", "maximum"] : [];
    if (!keys(shape, ["type", "source", ...allowed])) return false;
    switch (shape.type) {
      case "object": return Array.isArray(shape.fields) && shape.fields.length <= CONTRACT_LIMITS.nodes && new Set(shape.fields.map((field: unknown) => object(field) ? field.name : undefined)).size === shape.fields.length && shape.fields.every((field: unknown) => object(field) && keys(field, ["name", "required", "shape"]) && typeof field.name === "string" && typeof field.required === "boolean" && valid(field.shape, depth + 1));
      case "array": return valid(shape.items, depth + 1);
      case "number": case "integer": {
        const numeric = shapeFromSchema(Object.fromEntries(Object.entries(shape).filter(([key]) => key !== "source")), shape.source, 0, { nodes: 0 });
        return numeric.type === shape.type;
      }
      case "string": case "boolean": case "null": return true;
      default: return false;
    }
  }
  try { return object(value) && keys(value, ["source", "shape"]) && validSource(value.source) && valid(value.shape, 0); } catch { return false; }
}
