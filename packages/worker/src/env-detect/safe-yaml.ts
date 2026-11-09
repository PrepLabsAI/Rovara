// Safe YAML for the dependency detectors (test services D1, D2, D3; design test-services.md 3.2 notes). A repository's YAML is untrusted text: this reads it under fixed limits, and says "refused" with a fixed reason
// instead of ever building a very large object. Nothing here runs anything; a custom tag is just a value.
//
// Limits (all checked BEFORE the document becomes a JavaScript value, on the parsed tree, with alias expansion counted but never done):
//   - the text is at most 256 KiB, and has at most 4 documents (only the first is read);
//   - at most 32 anchors and 64 aliases;
//   - an alias that leads to an alias that leads to an alias ... is followed at most 8 deep;
//   - the document, with every alias counted as the copy it stands for, has at most 20,000 nodes (so a "billion laughs" tree is refused, not built);
//   - a collection nests at most 32 deep;
//   - a repeated key is refused (the library's default), and the library's own alias-count guard stays on.
import { LineCounter, isAlias, isMap, isPair, isScalar, isSeq, parseAllDocuments, type Document, type Node, type Pair } from "yaml";

export const YAML_LIMITS = { maxBytes: 256 * 1_024, maxDocuments: 4, maxAnchors: 32, maxAliases: 64, maxAliasDepth: 8, maxNodes: 20_000, maxDepth: 32, maxAliasCount: 50 } as const;

export type YamlRefusal = "too_large" | "too_many_documents" | "too_many_anchors" | "too_many_aliases" | "alias_depth" | "too_many_nodes" | "too_deep" | "invalid";

export interface SafeYaml {
  readonly document: Document.Parsed;
  /** The line (1-based) of a node, or 1. */
  lineOf(node: unknown): number;
  /** A node as a plain value, with aliases and merge keys resolved. Bounded, because the tree was checked first. */
  toPlain(node: unknown): unknown;
}

export type SafeYamlResult = { ok: true; value: SafeYaml } | { ok: false; reason: YamlRefusal };

const refuse = (reason: YamlRefusal): SafeYamlResult => ({ ok: false, reason });

/** How many documents the text starts: a line `---` (or `--- ` with content) at column 0. Counted on the text so a flood of them is refused before it is parsed. */
function documentStarts(text: string): number {
  return [...text.matchAll(/^---(?=\s|$)/gmu)].length;
}

class Refused extends Error {
  constructor(readonly reason: YamlRefusal) { super(reason); }
}

/** Checks the tree: anchors, aliases, alias depth, expanded size and nesting. Memoised per node, so an alias bomb costs one visit per node, not one per copy. */
function checkTree(document: Document.Parsed): void {
  let anchors = 0;
  let aliases = 0;
  const sizes = new Map<unknown, number>();
  const depths = new Map<unknown, number>();
  const aliasDepths = new Map<unknown, number>();
  const active = new Set<unknown>();
  const visit = (node: unknown): { size: number; depth: number; aliasDepth: number } => {
    if (node === null || node === undefined) return { size: 1, depth: 0, aliasDepth: 0 };
    if (sizes.has(node)) return { size: sizes.get(node)!, depth: depths.get(node)!, aliasDepth: aliasDepths.get(node)! };
    if (active.has(node)) throw new Refused("alias_depth");
    active.add(node);
    let size = 1;
    let depth = 0;
    let aliasDepth = 0;
    const anchored = isScalar(node) || isMap(node) || isSeq(node) ? node.anchor : undefined;
    if (anchored !== undefined && anchored !== "") { anchors += 1; if (anchors > YAML_LIMITS.maxAnchors) throw new Refused("too_many_anchors"); }
    if (isAlias(node)) {
      aliases += 1;
      if (aliases > YAML_LIMITS.maxAliases) throw new Refused("too_many_aliases");
      const target = node.resolve(document);
      const inner = visit(target);
      size = 1 + inner.size;
      depth = inner.depth;
      aliasDepth = 1 + inner.aliasDepth;
      if (aliasDepth > YAML_LIMITS.maxAliasDepth) throw new Refused("alias_depth");
    } else if (isMap(node) || isSeq(node)) {
      let childDepth = 0;
      for (const item of node.items as unknown[]) {
        const parts = isPair(item) ? [item.key, item.value] : [item];
        for (const part of parts) {
          const inner = visit(part);
          size += inner.size;
          childDepth = Math.max(childDepth, inner.depth);
          aliasDepth = Math.max(aliasDepth, inner.aliasDepth);
        }
        if (size > YAML_LIMITS.maxNodes) throw new Refused("too_many_nodes");
      }
      depth = 1 + childDepth;
    }
    if (size > YAML_LIMITS.maxNodes) throw new Refused("too_many_nodes");
    if (depth > YAML_LIMITS.maxDepth) throw new Refused("too_deep");
    active.delete(node);
    sizes.set(node, size);
    depths.set(node, depth);
    aliasDepths.set(node, aliasDepth);
    return { size, depth, aliasDepth };
  };
  visit(document.contents);
}

/** Parses the first document of a YAML text under the limits above. Never throws. */
export function parseSafeYaml(text: string): SafeYamlResult {
  if (Buffer.byteLength(text) > YAML_LIMITS.maxBytes) return refuse("too_large");
  if (documentStarts(text) > YAML_LIMITS.maxDocuments) return refuse("too_many_documents");
  try {
    const lineCounter = new LineCounter();
    const documents = parseAllDocuments(text, { lineCounter, merge: true, prettyErrors: false, uniqueKeys: true, strict: true });
    const list = Array.isArray(documents) ? documents : [documents];
    if (list.length > YAML_LIMITS.maxDocuments) return refuse("too_many_documents");
    const first = list[0];
    if (first === undefined || first.errors.length > 0) return refuse("invalid");
    checkTree(first);
    const document = first;
    return {
      ok: true,
      value: {
        document,
        lineOf: (node) => {
          const range = (node as { range?: [number, number, number] | null } | null | undefined)?.range;
          return range === undefined || range === null ? 1 : lineCounter.linePos(range[0]).line;
        },
        toPlain: (node) => {
          try {
            if (isPair(node)) return undefined;
            return (node as Node | null)?.toJS(document, { maxAliasCount: YAML_LIMITS.maxAliasCount }) as unknown;
          } catch { return undefined; }
        },
      },
    };
  } catch (error) {
    return refuse(error instanceof Refused ? error.reason : "invalid");
  }
}

/** The fixed words for a refusal, shown as a note. Never repository text. */
export const YAML_REFUSAL_WORDS: Record<YamlRefusal, string> = {
  too_large: "is larger than 256 KiB",
  too_many_documents: "holds more than 4 documents",
  too_many_anchors: "uses more than 32 anchors",
  too_many_aliases: "uses more than 64 aliases",
  alias_depth: "nests aliases more than 8 deep",
  too_many_nodes: "expands to more than 20,000 values",
  too_deep: "nests more than 32 levels",
  invalid: "could not be read as YAML",
};

/** An own property of a plain value, or undefined. Never reads the prototype chain. */
export function ownGet(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

/** The own entries of a plain object (empty for anything else). */
export function ownEntries(value: unknown): Array<[string, unknown]> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [];
}

/** The pair of a map node whose key is `key`, or undefined. */
export function pairOf(map: unknown, key: string): Pair | undefined {
  if (!isMap(map)) return undefined;
  for (const item of map.items) if (isScalar(item.key) && item.key.value === key) return item;
  return undefined;
}
