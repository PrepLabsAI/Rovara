import { classifyString, tokenShapedSubstrings, type ClassifiedValue, type CredentialTier } from "./credential-classifier.js";

/**
 * Classifies what a storage entry holds (MIDSTEP-2): the whole value, and, when the value is JSON (compact or pretty, an object, an array, or a string that is itself JSON), every string
 * leaf on its own, by the path of keys down to it and by its value. So a token inside `{"user":"maya","token":"..."}` is a strong credential, not just the whole blob; a draft inside the
 * same blob is not. A JSON blob as a whole is weak (scrubbed); its leaves carry the judgement.
 *
 * Bounded: a text over 1 MiB is not parsed, and a structure of more than 50 000 nodes or nested deeper than 12 levels stops the walk; both fall back to the token-shaped substrings of the raw
 * text (a JWT, a long opaque run), which is a cruder but still bounded cover.
 */
const MAX_PARSE_CHARS = 1_048_576;
const MAX_NODES = 50_000;
const MAX_DEPTH = 12;
const MAX_NESTED_JSON = 4;
/** A weak value longer than this is not registered (its spellings would cost more than the scrub is worth); a strong one is bounded by the sync. */
const MAX_WEAK_CHARS = 65_536;
const MAX_WEAK_LEAVES = 200;

interface Walk { out: Map<string, CredentialTier>; nodes: number; weakLeaves: number; overflow: boolean }

function put(walk: Walk, item: ClassifiedValue): void {
  if (item.tier === "weak" && item.value.length > MAX_WEAK_CHARS) return;
  if (walk.out.get(item.value) !== "strong") walk.out.set(item.value, item.tier);
}

/** The parsed value when the text is a JSON object or array within the parse limit, else undefined. `oversized` when it looks like one but is too large to parse. */
function parseContainer(text: string): { parsed: unknown } | { oversized: true } | undefined {
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return undefined;
  if (text.length > MAX_PARSE_CHARS) return { oversized: true };
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? { parsed } : undefined;
  } catch { return undefined; }
}

/** The key a JSON leaf is judged by: its own key, and its parent's when its own says nothing (`{"token":{"value":"..."}}`). A credential word higher up does not make every leaf below it one (`{"auth":{"plan":"pro-annual"}}`). */
const GENERIC_KEYS = new Set(["value", "val", "v", "data", "raw", "string", "str", "content", "body", "item", "0", "1"]);
function leafName(parent: string, key: string): string {
  return GENERIC_KEYS.has(key.toLowerCase()) ? `${parent} ${key}` : key;
}

function visitString(walk: Walk, path: string, text: string, depth: number, nested: number, top: boolean): void {
  const container = nested < MAX_NESTED_JSON ? parseContainer(text) : undefined;
  if (container !== undefined) {
    // The blob itself is only scrubbed; what is secret inside it is judged leaf by leaf.
    if (text.trim().length >= 16) put(walk, { value: text, tier: "weak" });
    if ("oversized" in container) { walk.overflow = true; return; }
    visitNode(walk, path, container.parsed, depth + 1, nested + 1);
    return;
  }
  for (const item of classifyString(path, text)) {
    // A sentence in a JSON leaf is text, not a token; only a top-level plain value is scrubbed on length alone, as it always was.
    if (item.tier === "weak" && !top && (/\s/.test(item.value) || walk.weakLeaves >= MAX_WEAK_LEAVES)) continue;
    if (item.tier === "weak" && !top) walk.weakLeaves += 1;
    put(walk, item);
  }
}

function visitNode(walk: Walk, path: string, node: unknown, depth: number, nested: number): void {
  if (walk.overflow) return;
  walk.nodes += 1;
  if (walk.nodes > MAX_NODES || depth > MAX_DEPTH) { walk.overflow = true; return; }
  if (typeof node === "string") { visitString(walk, path, node, depth, nested, false); return; }
  if (Array.isArray(node)) { for (const item of node) visitNode(walk, path, item, depth + 1, nested); return; }
  if (node !== null && typeof node === "object") for (const [key, child] of Object.entries(node)) visitNode(walk, leafName(path, key), child, depth + 1, nested);
}

function finish(walk: Walk, raw: string): ClassifiedValue[] {
  if (walk.overflow) for (const candidate of tokenShapedSubstrings(raw)) put(walk, { value: candidate, tier: "strong" });
  return [...walk.out].map(([value, tier]) => ({ value, tier }));
}

/** Every value worth registering in one local or session storage entry, each with its tier. */
export function classifyStorageEntry(entry: { name: string; value: string }): ClassifiedValue[] {
  const walk: Walk = { out: new Map(), nodes: 0, weakLeaves: 0, overflow: false };
  visitString(walk, entry.name, entry.value, 0, 0, true);
  return finish(walk, entry.value);
}

/** The same for an already-decoded structure (an IndexedDB record): its string leaves by key path under `rootName`. */
export function classifyStructure(rootName: string, node: unknown, rawForFallback: () => string): ClassifiedValue[] {
  const walk: Walk = { out: new Map(), nodes: 0, weakLeaves: 0, overflow: false };
  visitNode(walk, rootName, node, 0, 0);
  return finish(walk, walk.overflow ? rawForFallback() : "");
}

/** The cookie fix's boolean, kept for callers that only ask "is this entry itself a credential": the whole value is classified strong. */
export function isStrongStorageValue(entry: { name: string; value: string }): boolean {
  return classifyStorageEntry(entry).some((item) => item.tier === "strong" && item.value === entry.value);
}
