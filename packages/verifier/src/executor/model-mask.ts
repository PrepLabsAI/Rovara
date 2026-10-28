/**
 * Masks the text of a model-bound call (MIDSTEP-2 MASKMAYBE).
 *
 * A value the executor registered evidence-only ("weak": probably app data, possibly a secret) is not a reason to refuse a model call, but the model must not read it either. Every string of the
 * call (page snapshot, URL, earlier tool call and result, system and user prompt, a tool's name or schema text, an object key) goes through `mask`, which replaces a weak value with `<session>`,
 * the placeholder the evidence scrub uses. The call keeps its shape: only strings change, so it still passes the channel schema and the step goes on.
 *
 * Pure: no I/O. Depth is bounded; a call nested deeper than the channel ever carries is refused by the caller (it throws `ModelMaskDepthError`).
 */
export class ModelMaskDepthError extends Error {
  constructor() { super("the model call is nested deeper than the executor masks"); this.name = "ModelMaskDepthError"; }
}

const MAX_DEPTH = 64;

function walk(node: unknown, mask: (text: string) => string, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new ModelMaskDepthError();
  if (typeof node === "string") return mask(node);
  if (Array.isArray(node)) return node.map((item) => walk(item, mask, depth + 1));
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) out[mask(key)] = walk(child, mask, depth + 1);
    return out;
  }
  return node;
}

/** A copy of `call` with `mask` applied to every string (keys included). */
export function maskModelCall<T>(call: T, mask: (text: string) => string): T {
  return walk(call, mask, 0) as T;
}
