// TE-F11 assertions are answer shape and the request's declared type/required/enum constraints, never the customer's test assertions.
import type { ModelReplyResponse } from "./model-reply-set.js";
import { argsSkeleton, boundedJson, objectOf, type CheckedAnswer, type ReplyCheckObject } from "./model-reply-check-read.js";

export const REPLY_DRIFT_REASONS = ["finish_changed", "tool_names_changed", "tool_args_shape_changed", "text_json_shape_changed", "declared_shape_failed"] as const;
export type ReplyDriftReason = (typeof REPLY_DRIFT_REASONS)[number];
/** Only type, required and enum are assertions; properties/items navigate them. All other keywords are ignored.
 * Deferred: $ref/$defs, allOf/anyOf/oneOf/not, additionalProperties, format/pattern, string/numeric/array bounds,
 * const, dependentRequired, patternProperties, unevaluatedProperties, nullable and tool-choice constraints.
 */
export const REPLY_DECLARED_SCHEMA_KEYWORDS = ["type", "required", "enum", "properties", "items"] as const;
const typeOf = (value: unknown): string => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const topShape = (text: string): string | undefined => {
  const object = objectOf(boundedJson(text)?.value);
  return object === undefined ? undefined : JSON.stringify(Object.keys(object).sort().map((key) => [key, typeOf(object[key])]));
};
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  const left = objectOf(a); const right = objectOf(b);
  return left !== undefined && right !== undefined && Object.keys(left).length === Object.keys(right).length && Object.keys(left).every((k) => Object.hasOwn(right, k) && equal(left[k], right[k]));
};
function validates(value: unknown, schema: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  const s = objectOf(schema); if (s === undefined) return true;
  const types: unknown[] = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type];
  if (types.length > 0 && !types.some((type) => typeof type === "string" && (type.toLowerCase() === typeOf(value) || (type.toLowerCase() === "integer" && typeof value === "number" && Number.isInteger(value))))) return false;
  if (Array.isArray(s.enum) && !s.enum.some((candidate) => equal(value, candidate))) return false;
  const record = objectOf(value);
  if (record !== undefined) {
    if (Array.isArray(s.required) && !s.required.every((key) => typeof key === "string" && Object.hasOwn(record, key))) return false;
    const properties = objectOf(s.properties);
    if (properties !== undefined && !Object.keys(properties).every((key) => !Object.hasOwn(record, key) || validates(record[key], properties[key], depth + 1))) return false;
  }
  if (Array.isArray(value) && s.items !== undefined && !value.every((item) => validates(item, s.items, depth + 1))) return false;
  return true;
}
function declaredFits(answer: CheckedAnswer, request: ReplyCheckObject, wire: string): boolean {
  const declarations = new Map<string, unknown>();
  const tools = Array.isArray(request.tools) ? request.tools : [];
  for (const entry of tools) {
    const tool = objectOf(entry);
    const fn = wire === "openai" ? objectOf(tool?.function) : tool;
    if (typeof fn?.name === "string") declarations.set(fn.name, wire === "anthropic" ? fn.input_schema : fn.parameters);
    if (wire === "gemini" && Array.isArray(tool?.functionDeclarations)) for (const item of tool.functionDeclarations) {
      const f = objectOf(item); if (typeof f?.name === "string") declarations.set(f.name, f.parameters);
    }
  }
  for (const call of answer.toolCalls) if (declarations.size > 0 && (!declarations.has(call.name) || !validates(call.args, declarations.get(call.name)))) return false;
  const schema = wire === "openai" ? objectOf(objectOf(request.response_format)?.json_schema)?.schema : wire === "gemini" ? objectOf(request.generationConfig)?.responseSchema : undefined;
  if (schema !== undefined) { const parsed = boundedJson(answer.text); if (parsed === undefined || !validates(parsed.value, schema)) return false; }
  return true;
}
export function compareReplyCheckShape(expected: ModelReplyResponse, answer: CheckedAnswer, request: ReplyCheckObject, wire: string): ReplyDriftReason[] {
  const reasons: ReplyDriftReason[] = [];
  if (expected.finish !== answer.finish) reasons.push("finish_changed");
  const oldTools = expected.toolCalls ?? [];
  const names = (tools: readonly { name: string }[]) => JSON.stringify([...new Set(tools.map((t) => t.name))].sort());
  if (names(oldTools) !== names(answer.toolCalls)) reasons.push("tool_names_changed");
  const shapes = (tools: readonly { name: string; args: ReplyCheckObject }[], name: string) => JSON.stringify([...new Set(tools.filter((t) => t.name === name).map((t) => argsSkeleton(t.args)))].sort());
  if (oldTools.some((t) => answer.toolCalls.some((real) => real.name === t.name) && shapes(oldTools, t.name) !== shapes(answer.toolCalls, t.name))) reasons.push("tool_args_shape_changed");
  if (topShape(expected.text) !== topShape(answer.text)) reasons.push("text_json_shape_changed");
  if (!declaredFits(answer, request, wire)) reasons.push("declared_shape_failed");
  return reasons;
}
