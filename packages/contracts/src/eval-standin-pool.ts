// L4-EINT: the join of the stand-in writer (E7) and the outside-HTTP stand-in (E6). The writer is asked for sample answers by OPERATION; the stand-in picks one by hashing the request. Both sides need the same operation name,
// so it is made here from the three things that name an operation: the method, the host and the path template (a pure hash, no value of any request).
//   - `standInOperationsOf`: the operations a host's OpenAPI description lists, with the shape of the example answer the description's own schema gives (shape only), as the writer's request wants them;
//   - `standInPoolRoutes`: the writer's stored answers, by those same names, as the stand-in's pools.
import { sha256Hex } from "./web-hash.js";
import { serializeOpenApiFake, type OpenApiFake } from "./openapi-fake.js";
import type { EvalStandInPoolRoute } from "./eval-standin-engine.js";
import { STANDIN_LIMITS, type StandInOperationSeam, type StandInShape, type StandInWriterSet } from "./standin-writer.js";

/** The name of one outside operation: `o` and 24 hex characters (fits the writer's id shape). */
export const standInOperationId = (method: string, host: string, template: string): string => `o${sha256Hex(`rovara-standin-op/v1\n${method.toUpperCase()} ${host.toLowerCase()} ${template}`).slice(0, 24)}`;

/** The shape of a JSON value: names and kinds only (the value is dropped). Undefined for what a shape cannot hold (an empty list, a too-deep value). */
export function standInShapeOfValue(value: unknown, depth = 0): StandInShape | undefined {
  if (depth > 8) return undefined;
  if (value === null) return { type: "null" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "string") return { type: "string" };
  if (Array.isArray(value)) {
    const items = value.length === 0 ? undefined : standInShapeOfValue(value[0], depth + 1);
    return items === undefined ? undefined : { type: "array", items };
  }
  if (typeof value === "object") {
    const fields: Array<{ name: string; required: boolean; shape: StandInShape }> = [];
    for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
      const shape = standInShapeOfValue(child, depth + 1);
      if (shape !== undefined) fields.push({ name, required: true, shape });
    }
    return fields.length === 0 ? undefined : { type: "object", fields };
  }
  return undefined;
}

/** The operations of a host's built OpenAPI description that the writer can write answers for (a method it takes, an answer with a shape), at most the writer's limit, in a fixed order. */
export function standInOperationsOf(host: string, fake: OpenApiFake): StandInOperationSeam[] {
  const operations = serializeOpenApiFake(fake)?.operations ?? [];
  const out: StandInOperationSeam[] = [];
  for (const operation of operations) {
    const method = operation.method.toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || operation.answer === "unsupported" || operation.answer.body === undefined) continue;
    const shape = standInShapeOfValue(operation.answer.body);
    if (shape === undefined || shape.type !== "object") continue;
    out.push({ id: standInOperationId(method, host, operation.template), host, method: method as StandInOperationSeam["method"], path: operation.template, shape });
    if (out.length >= STANDIN_LIMITS.operations) break;
  }
  return out;
}

/** The writer's stored answers as pools for this host's operations: only an operation the host's description lists and the set has answers for. */
export function standInPoolRoutes(host: string, fake: OpenApiFake | undefined, set: StandInWriterSet | undefined): EvalStandInPoolRoute[] {
  if (fake === undefined || set === undefined) return [];
  const operations = serializeOpenApiFake(fake)?.operations ?? [];
  const out: EvalStandInPoolRoute[] = [];
  for (const operation of operations) {
    const method = operation.method.toUpperCase();
    const answers = Object.hasOwn(set.answers, standInOperationId(method, host, operation.template)) ? set.answers[standInOperationId(method, host, operation.template)] : undefined;
    const objects = (answers ?? []).filter((answer): answer is Record<string, unknown> => typeof answer === "object" && answer !== null && !Array.isArray(answer));
    if (objects.length > 0) out.push({ method, template: operation.template, answers: objects });
  }
  return out;
}
