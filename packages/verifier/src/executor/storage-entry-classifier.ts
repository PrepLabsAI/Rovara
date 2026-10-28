import { classifyString, credentialKey, isOpaqueToken, tierWins, tokenShapedSubstrings, type ClassifiedValue, type CredentialTier } from "./credential-classifier.js";

/**
 * Classifies what a storage entry holds (MIDSTEP-2): the whole value, and, when the value is JSON (compact or pretty, an object, an array, or a string that is itself JSON), every string
 * leaf on its own, by the path of keys down to it and by its value. So a token inside `{"user":"maya","token":"..."}` is a strong credential, not just the whole blob; a draft inside the
 * same blob is not. A JSON blob as a whole is not registered; its leaves carry the judgement. A leaf is weak only when it is an opaque token (never a route, URL, date, email, UUID or slug), and
 * strong under a neutral key only with a base64 mix (a pure hex id is not registered): see `ClassifyOptions.leaf`. A stored JSON string (`JSON.stringify(token)`) is unwrapped and its inner value classified too.
 *
 * Bounded: a text over 1 MiB is not parsed, and a structure of more than 50 000 nodes or nested deeper than 12 levels stops the walk; both fall back to the token-shaped substrings of the raw
 * text (a JWT, a long opaque run), which is a cruder but still bounded cover.
 */
const MAX_PARSE_CHARS = 1_048_576;
const MAX_NODES = 50_000;
const MAX_DEPTH = 12;
const MAX_NESTED_JSON = 4;
/** A weak value longer than this is not registered (its spellings would cost more than the scrub is worth); the model's view then fails closed (`overflow`). A strong one is bounded by the sync. */
const MAX_WEAK_CHARS = 65_536;
/** Weak leaves of one entry that are written for the evidence scrub; the leaves after them are registered for the model's mask only (`mask`), up to MAX_MASK_LEAVES, then the view fails closed. */
const MAX_WEAK_LEAVES = 200;
const MAX_MASK_LEAVES = 5_000;

interface Walk { visitor: boolean; out: Map<string, CredentialTier>; nodes: number; weakLeaves: number; maskLeaves: number; overflow: boolean; viewOverflow: boolean }

function put(walk: Walk, item: ClassifiedValue): void {
  if ((item.tier === "weak" || item.tier === "scrub") && item.value.length > MAX_WEAK_CHARS) {
    // A scrub-only value is never shown to the model as a mask, so only a value that would be masked fails the view closed.
    if (item.tier === "weak") walk.viewOverflow = true;
    return;
  }
  if (tierWins(item.tier, walk.out.get(item.value))) walk.out.set(item.value, item.tier);
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
const SHORT_KEYS = new Set(["id", "key", "k", "at", "rt", "t", "sid", "ref"]);
const GENERIC_KEYS = new Set(["value", "val", "v", "data", "raw", "string", "str", "content", "body", "item", "0", "1"]);
function leafName(parent: string, key: string): string {
  return GENERIC_KEYS.has(key.toLowerCase()) ? `${parent} ${key}` : key;
}

/** A JSON string literal (`"eyJ..."`, what `JSON.stringify(token)` stores): the inner string, else undefined. */
function parseQuoted(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 3 || trimmed.length > MAX_PARSE_CHARS || trimmed[0] !== '"' || trimmed[trimmed.length - 1] !== '"') return undefined;
  try { const parsed: unknown = JSON.parse(trimmed); return typeof parsed === "string" ? parsed : undefined; } catch { return undefined; }
}

function visitString(walk: Walk, path: string, text: string, depth: number, nested: number, top: boolean): void {
  const container = nested < MAX_NESTED_JSON ? parseContainer(text) : undefined;
  const quoted = container === undefined && nested < MAX_NESTED_JSON ? parseQuoted(text) : undefined;
  if (quoted !== undefined) {
    // The quoted form is registered as it is stored, and the bare inner value is classified under the same key: a page shows the token, not its quotes.
    for (const item of classifyString(path, text, { ...(top ? {} : { leaf: true }), visitor: walk.visitor })) put(walk, item);
    visitString(walk, path, quoted, depth + 1, nested + 1, false);
    return;
  }
  if (container !== undefined) {
    // What is secret inside the blob is judged leaf by leaf; the blob itself is not registered (its text is not in a page).
    if ("oversized" in container) { walk.overflow = true; return; }
    visitNode(walk, path, container.parsed, depth + 1, nested + 1);
    return;
  }
  for (const item of classifyString(path, text, { ...(top ? {} : { leaf: true }), visitor: walk.visitor })) {
    // A sentence in a JSON leaf is text, not a token; only a top-level plain value is scrubbed on length alone, as it always was.
    if (item.tier === "weak" && !top && /\s/.test(item.value)) continue;
    if (item.tier === "weak" && !top) {
      walk.weakLeaves += 1;
      // Past the evidence cap a weak leaf is still masked for the model; only past the mask bound does the view fail closed.
      if (walk.weakLeaves > MAX_WEAK_LEAVES) {
        if (walk.maskLeaves >= MAX_MASK_LEAVES) { walk.viewOverflow = true; continue; }
        walk.maskLeaves += 1;
        put(walk, { value: item.value, tier: "mask" });
        continue;
      }
    }
    put(walk, item);
  }
}

function visitNode(walk: Walk, path: string, node: unknown, depth: number, nested: number): void {
  if (walk.overflow) return;
  walk.nodes += 1;
  if (walk.nodes > MAX_NODES || depth > MAX_DEPTH) { walk.overflow = true; return; }
  if (typeof node === "string") { visitString(walk, path, node, depth, nested, false); return; }
  if (Array.isArray(node)) { for (const item of node) visitNode(walk, path, item, depth + 1, nested); return; }
  if (node !== null && typeof node === "object") {
    for (const [key, child] of Object.entries(node)) {
      // A short neutral key under a credential key (`{"session":{"id":"..."}}`, `{"auth":{"key":"..."}}`) takes the parent's credential reading, for an opaque value; `{"auth":{"plan":..}}` does not.
      if (typeof child === "string" && SHORT_KEYS.has(key.toLowerCase()) && isOpaqueToken(child.trim()) && credentialKey(path).credential) {
        walk.nodes += 1;
        visitString(walk, path, child, depth + 1, nested, false);
        continue;
      }
      visitNode(walk, leafName(path, key), child, depth + 1, nested);
    }
  }
}

function finish(walk: Walk, raw: string): ClassifiedValue[] {
  if (walk.overflow) for (const candidate of tokenShapedSubstrings(raw)) put(walk, { value: candidate, tier: "strong" });
  const items = [...walk.out].map(([value, tier]) => ({ value, tier }));
  if (walk.viewOverflow) items.push({ value: "", tier: "overflow" });
  return items;
}

/** Every value worth registering in one local or session storage entry, each with its tier. */
export function classifyStorageEntry(entry: { name: string; value: string }, options: { visitor?: boolean } = {}): ClassifiedValue[] {
  const walk: Walk = { visitor: options.visitor === true, out: new Map(), nodes: 0, weakLeaves: 0, maskLeaves: 0, overflow: false, viewOverflow: false };
  visitString(walk, entry.name, entry.value, 0, 0, true);
  return finish(walk, entry.value);
}

/** The same for an already-decoded structure (an IndexedDB record): its string leaves by key path under `rootName`. */
export function classifyStructure(rootName: string, node: unknown, rawForFallback: () => string, options: { visitor?: boolean } = {}): ClassifiedValue[] {
  const walk: Walk = { visitor: options.visitor === true, out: new Map(), nodes: 0, weakLeaves: 0, maskLeaves: 0, overflow: false, viewOverflow: false };
  visitNode(walk, rootName, node, 0, 0);
  return finish(walk, walk.overflow ? rawForFallback() : "");
}

/** The cookie fix's boolean, kept for callers that only ask "is this entry itself a credential": the whole value is classified strong. */
export function isStrongStorageValue(entry: { name: string; value: string }): boolean {
  return classifyStorageEntry(entry).some((item) => item.tier === "strong" && item.value === entry.value);
}
