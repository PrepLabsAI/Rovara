// SM-A is an offline, pure discovery helper. Callers supply response payload files for
// ONE model; no filesystem reads, Python execution, model calls, store or proof wiring.
// Supported inference: a sole literal return in output_fn (preferred), or predict_fn
// when output_fn is absent. Dynamic code is explicitly unsupported, never guessed.
// Supported output schemas: type, properties, required, items, minimum and maximum.
// Unsupported keywords refuse that candidate rather than silently weakening its shape.
export const SAGEMAKER_CONTRACT_LIMITS = { files: 64, characters: 65_536, depth: 12, nodes: 256 } as const;
export type SageMakerSourceKind = "fixture" | "inference" | "output_schema";
export interface SageMakerSource { kind: SageMakerSourceKind; path: string; pointer: string }
export type SageMakerShape = { source: SageMakerSource } & (
  | { type: "object"; fields: { name: string; required: boolean; shape: SageMakerShape }[] }
  | { type: "array"; items: SageMakerShape }
  | { type: "number" | "integer"; minimum?: number; maximum?: number }
  | { type: "string" | "boolean" | "null" }
);
export interface SageMakerContract { source: SageMakerSource; shape: SageMakerShape }
export interface SageMakerContractFile { kind: SageMakerSourceKind; path: string; content: string | null }
type Reason = "selected" | "lower_priority" | "unreadable" | "too_large" | "invalid_json" | "unsupported_inference" | "unsupported_shape";
interface InputResult { index: number; reason: Reason }
export type SageMakerContractResult =
  | { status: "found"; contract: SageMakerContract; inputs: InputResult[] }
  | { status: "not_found"; message: "No contract found"; reason: "too_many_inputs" | "no_supported_input"; inputs: InputResult[] };
const kinds: SageMakerSourceKind[] = ["fixture", "inference", "output_schema"];
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const pointer = (name: string) => name.replaceAll("~", "~0").replaceAll("/", "~1");
function child(source: SageMakerSource, part: string): SageMakerSource { return { ...source, pointer: `${source.pointer}/${part}` }; }
const unsupported = (): never => { throw new Error("unsupported_shape"); };
interface Budget { nodes: number }
function count(depth: number, budget: Budget): void {
  if (depth > SAGEMAKER_CONTRACT_LIMITS.depth || ++budget.nodes > SAGEMAKER_CONTRACT_LIMITS.nodes) unsupported();
}
function signature(shape: SageMakerShape): string {
  if (shape.type === "object") return JSON.stringify([shape.type, shape.fields.map((field) => [field.name, signature(field.shape)]).sort()]);
  if (shape.type === "array") return JSON.stringify([shape.type, signature(shape.items)]);
  return shape.type;
}
function fromValue(value: unknown, source: SageMakerSource, depth: number, budget: Budget): SageMakerShape {
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
    const shapes = value.map((entry, i) => fromValue(entry, child(source, String(i)), depth + 1, budget));
    const first = shapes[0]!;
    if (shapes.some((entry) => signature(entry) !== signature(first))) unsupported();
    return { type: "array", source, items: first };
  }
  if (!object(value)) return unsupported();
  return { type: "object", source, fields: Object.entries(value).map(([name, entry]) => ({ name, required: true, shape: fromValue(entry, child(source, pointer(name)), depth + 1, budget) })) };
}
function fromSchema(value: unknown, source: SageMakerSource, depth: number, budget: Budget): SageMakerShape {
  count(depth, budget);
  if (!object(value)) return unsupported();
  const allowed = value.type === "object" ? ["type", "properties", "required"] : value.type === "array" ? ["type", "items"] : value.type === "number" || value.type === "integer" ? ["type", "minimum", "maximum"] : ["type"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) unsupported();
  if (value.type === "object") {
    if (!object(value.properties)) return unsupported();
    const properties = value.properties;
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((key: unknown) => typeof key !== "string" || !Object.hasOwn(properties, key)))) unsupported();
    const required = new Set(Array.isArray(value.required) ? value.required as string[] : []);
    return { type: "object", source, fields: Object.entries(properties).map(([name, entry]) => ({ name, required: required.has(name), shape: fromSchema(entry, child(source, `properties/${pointer(name)}`), depth + 1, budget) })) };
  }
  if (value.type === "array") return { type: "array", source, items: fromSchema(value.items, child(source, "items"), depth + 1, budget) };
  if (value.type === "number" || value.type === "integer") {
    const shape: SageMakerShape = { type: value.type, source };
    for (const key of ["minimum", "maximum"] as const) {
      const n = value[key];
      if (n !== undefined) {
        if (typeof n !== "number" || !Number.isFinite(n)) unsupported();
        shape[key] = n as number;
      }
    }
    const low = shape.minimum ?? Math.min(0, shape.maximum ?? 0);
    const high = shape.maximum ?? Math.max(1, low);
    if (low > high || (shape.type === "integer" && Math.ceil(low) > Math.floor(high))) unsupported();
    return shape;
  }
  if (value.type === "string" || value.type === "boolean" || value.type === "null") return { type: value.type, source };
  return unsupported();
}
function inferenceLiteral(text: string): { value: unknown; pointer: string } | null {
  if (text.includes('"""') || text.includes("'''") || /^\s*@/m.test(text)) return null;
  // Anchored top-level functions only. A selected output_fn must itself be understood;
  // predict_fn can describe an intermediate shape that output_fn changes.
  const functions = [...text.matchAll(/^def (output_fn|predict_fn)\([^\n]*\):[^\S\n]*\n((?:(?:[ \t]+[^\n]*|)[\n]|[ \t]+[^\n]*$)*)/gm)];
  const namedOutput = /^def output_fn\b/m.test(text);
  const name = namedOutput ? "output_fn" : "predict_fn";
  const selected = functions.filter((entry) => entry[1] === name);
  if (selected.length !== 1) return null;
  const body = selected[0]![2]!.trim();
  if (!body.startsWith("return ")) return null;
  const expression = body.slice(7).trim();
  // Tokenise, never evaluate. Single-quoted strings with escapes are not supported.
  const token = /\s*("(?:[^"\\\r\n]|\\.)*"|'[^'\\\r\n]*'|True\b|False\b|None\b|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:])/y;
  const parts: string[] = [];
  let offset = 0;
  while (offset < expression.length) {
    token.lastIndex = offset;
    const match = token.exec(expression);
    if (match === null) return null;
    const word = match[1]!;
    parts.push(word.startsWith("'") ? JSON.stringify(word.slice(1, -1)) : word === "True" ? "true" : word === "False" ? "false" : word === "None" ? "null" : word);
    offset = token.lastIndex;
  }
  try { return { value: JSON.parse(parts.join("")) as unknown, pointer: `${name}/return` }; } catch { return null; }
}

/** Inputs must be classified by the caller for one model. All decisions are indexed
 * back to the input list; no raw response values or inference source are retained. */
export function findSageMakerContract(files: readonly SageMakerContractFile[]): SageMakerContractResult {
  if (files.length > SAGEMAKER_CONTRACT_LIMITS.files) return { status: "not_found", message: "No contract found", reason: "too_many_inputs", inputs: [] };
  const inputs: InputResult[] = files.map((_, index) => ({ index, reason: "lower_priority" }));
  let contract: SageMakerContract | undefined;
  for (const kind of kinds) {
    for (const [index, file] of files.entries()) {
      if (file.kind !== kind || contract !== undefined) continue;
      const result = inputs[index]!;
      if (file.content === null) { result.reason = "unreadable"; continue; }
      if (file.content.length > SAGEMAKER_CONTRACT_LIMITS.characters || file.path.length > 2048) { result.reason = "too_large"; continue; }
      let value: unknown;
      let location = "";
      if (kind === "inference") {
        const literal = inferenceLiteral(file.content);
        if (literal === null) { result.reason = "unsupported_inference"; continue; }
        value = literal.value; location = literal.pointer;
      } else {
        try { value = JSON.parse(file.content) as unknown; } catch { result.reason = "invalid_json"; continue; }
      }
      const source = { kind, path: file.path, pointer: location };
      try {
        const shape = (kind === "output_schema" ? fromSchema : fromValue)(value, source, 0, { nodes: 0 });
        contract = { source, shape };
        result.reason = "selected";
      } catch { result.reason = "unsupported_shape"; }
    }
  }
  return contract === undefined ? { status: "not_found", message: "No contract found", reason: "no_supported_input", inputs } : { status: "found", contract, inputs };
}

/** Validate the normalized contract at the generator/config boundary too. */
export function isSageMakerContract(value: unknown): value is SageMakerContract {
  const keys = (entry: Record<string, unknown>, allowed: string[]) => Object.keys(entry).every((key) => allowed.includes(key));
  const validSource = (source: unknown): source is SageMakerSource => object(source) && keys(source, ["kind", "path", "pointer"]) && kinds.includes(source.kind as SageMakerSourceKind) && typeof source.path === "string" && source.path.length <= 2048 && typeof source.pointer === "string" && source.pointer.length <= SAGEMAKER_CONTRACT_LIMITS.characters;
  const budget = { nodes: 0 };
  function valid(shape: unknown, depth: number): boolean {
    count(depth, budget);
    if (!object(shape) || !validSource(shape.source)) return false;
    const allowed = shape.type === "object" ? ["fields"] : shape.type === "array" ? ["items"] : shape.type === "number" || shape.type === "integer" ? ["minimum", "maximum"] : [];
    if (!keys(shape, ["type", "source", ...allowed])) return false;
    switch (shape.type) {
      case "object": return Array.isArray(shape.fields) && shape.fields.length <= SAGEMAKER_CONTRACT_LIMITS.nodes && new Set(shape.fields.map((field: unknown) => object(field) ? field.name : undefined)).size === shape.fields.length && shape.fields.every((field: unknown) => object(field) && keys(field, ["name", "required", "shape"]) && typeof field.name === "string" && typeof field.required === "boolean" && valid(field.shape, depth + 1));
      case "array": return valid(shape.items, depth + 1);
      case "number": case "integer": {
        const numeric = fromSchema(Object.fromEntries(Object.entries(shape).filter(([key]) => key !== "source")), shape.source, 0, { nodes: 0 });
        return numeric.type === shape.type;
      }
      case "string": case "boolean": case "null": return true;
      default: return false;
    }
  }
  try { return object(value) && keys(value, ["source", "shape"]) && validSource(value.source) && valid(value.shape, 0); } catch { return false; }
}
