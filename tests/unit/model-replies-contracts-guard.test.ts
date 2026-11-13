// TE-F2 part A is PURE and ADDITIVE: the new contract files open no socket, read no clock, use no randomness and import no Node module of their own (the digest and prompt hash go through F0a's `sha256HexOf`);
// and nothing outside `packages/contracts/src` and the tests calls them until part B (the helper) lands.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const CONTRACTS = join(root, "packages/contracts/src");
const NEW_FILES = [
  "model-sse-named", "model-family-vectors", "model-family-openai-ops", "model-family-gemini-extra", "model-family-anthropic", "model-family-cohere", "model-served-family", "model-request-facts", "model-render", "model-failure-pack",
  "model-families", "model-reply-provenance", "model-reply-set", "model-serve-replies",
];
const read = (path: string): string => readFileSync(path, "utf8");
/** The code of a file: comments and string literals blanked, so a word in prose or in a fixed sentence is not a call. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "").replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/gu, '""');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/u.test(name)) out.push(path);
  }
  return out;
}

describe("the new files are pure", () => {
  for (const name of NEW_FILES) {
    it(`${name}.ts: no Node import, no network, no clock, no randomness`, () => {
      const text = read(join(CONTRACTS, `${name}.ts`));
      const source = code(text);
      expect(text, "no node: import").not.toMatch(/from\s+["']node:/u);
      expect(text, "no bare Node module import").not.toMatch(/from\s+["'](?:fs|net|http|https|tls|dns|dgram|child_process|crypto|os|path|url)["']/u);
      for (const forbidden of [/\bfetch\s*\(/u, /\bDate\.now\b/u, /\bnew Date\b/u, /\bMath\.random\b/u, /\bsetTimeout\b/u, /\bsetInterval\b/u, /\bprocess\./u, /\brequire\s*\(/u, /\bimport\s*\(/u, /\bperformance\./u, /\bXMLHttpRequest\b/u, /\bWebSocket\b/u, /\bEventSource\b/u]) {
        expect(source, `${name}.ts ${String(forbidden)}`).not.toMatch(forbidden);
      }
    });
  }
  it("the guard sees a violation (positive control)", () => {
    expect(code('const x = fetch("a");')).toMatch(/\bfetch\s*\(/u);
    expect(code('const x = "fetch(1)";')).not.toMatch(/\bfetch\s*\(/u);
    expect(code("// Date.now()\nconst y = 1;")).not.toMatch(/\bDate\.now\b/u);
  });
});

describe("the only callers are part B's helper files", () => {
  const files = walk(root).filter((path) => {
    const rel = path.slice(root.length + 1);
    if (rel.startsWith("packages/contracts/src/")) return false;
    if (rel.startsWith("tests/unit/model-")) return false;
    // part B (TE-F2): the helper program, its reply-set loader, the failure runner, and their tests and support (the worker reads the contracts through the package name)
    if (/^packages\/worker\/src\/model-(?:helper|reply|failure)/u.test(rel) || /^tests\/(?:unit\/worker-model-|support\/model-)/u.test(rel)) return false;
    return rel.startsWith("packages/") || rel.startsWith("scripts/") || rel.startsWith("infra/") || rel.startsWith("tests/");
  });
  const SYMBOLS = [
    "serveModelRequestWithReplies", "replyCountsTowardProof", "MODEL_FAMILY_REGISTRY", "buildFailureAnswer", "FailureSpecSchema", "ModelReplySetSchema", "ModelReplySetFileSchema", "stampReplyProvenance", "selectModelReply",
    "parseModelReplySetFileBytes", "routeAnthropicRequest", "routeCohereRequest", "buildAnthropicMessage", "buildCohereChat", "buildOpenAiResponse", "readModelRequestFacts",
  ];
  it("nothing outside packages/contracts/src, the model tests and part B's helper files names a new file or export", () => {
    expect(files.length).toBeGreaterThan(100); // the walk really looked
    const hits: string[] = [];
    for (const path of files) {
      if (path.endsWith("model-replies-contracts-guard.test.ts")) continue;
      const text = read(path);
      for (const name of NEW_FILES) if (new RegExp(`/${name}(?:\\.js|\\.ts)?["']`, "u").test(text)) hits.push(`${path.slice(root.length + 1)} imports ${name}`);
      for (const symbol of SYMBOLS) if (new RegExp(`\\b${symbol}\\b`, "u").test(text)) hits.push(`${path.slice(root.length + 1)} uses ${symbol}`);
    }
    expect(hits).toEqual([]);
  });
});
