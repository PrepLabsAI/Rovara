// L4-E56: the eval stand-in helper program has no outbound socket ANYWHERE in its import graph, judged on the parsed code (not a text search). The graph starts at the program and follows relative imports and the contracts
// package's NARROW eval-standin-helper entry; the contracts barrel (index.ts, which re-exports modules that call fetch) must not be reachable. The program serves TLS, so `https` and `tls` are allowed, but only their SERVER
// names (`createServer`, `createSecureContext`, the types); a `connect`, a `request` or a `get` is still a violation (the walker flags every connect call and every import of a name that is not on the list).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repoResolver, walkImportGraph } from "../support/import-graph.js";

const root = resolve(import.meta.dirname, "../..");
const SERVER_TLS = {
  https: new Set(["createServer", "Server"]),
  tls: new Set(["createSecureContext", "SecureContext"]),
};
describe("the stand-in helper program's import graph", () => {
  const graph = walkImportGraph(resolve(root, "packages/worker/src/eval-standin-helper.ts"), repoResolver(root), { serverOnly: SERVER_TLS });
  const rel = graph.files.map((file) => file.slice(root.length + 1));
  it("is a real walk: the program, the shared server, the authority and the narrow contracts entry, and never the barrel, the launcher or docker", () => {
    expect(rel).toContain("packages/worker/src/eval-standin-helper.ts");
    expect(rel).toContain("packages/worker/src/eval-standin-server.ts");
    expect(rel).toContain("packages/worker/src/run-ca.ts");
    expect(rel).toContain("packages/contracts/src/eval-standin-helper-entry.ts");
    expect(rel).toContain("packages/contracts/src/eval-standin-engine.ts");
    expect(rel).toContain("packages/contracts/src/eval-standin-set.ts");
    expect(rel).not.toContain("packages/contracts/src/index.ts");
    expect(rel.filter((file) => /eval-standin-hosted|eval-standin-round|eval-standin-cassettes|run-network|docker|child/u.test(file))).toEqual([]);
  });
  it("has no import, call or construction that can open an outbound connection", () => {
    expect(graph.violations).toEqual([]);
  });
  it("is strict about TLS: without the server-only allowance the same graph is refused, and a client name from https or tls is a violation", () => {
    const strict = walkImportGraph(resolve(root, "packages/worker/src/eval-standin-helper.ts"), repoResolver(root));
    expect(strict.violations.map((violation) => violation.rule).sort()).toEqual(expect.arrayContaining(["imports node:https", "imports node:tls"]));
    const narrow = walkImportGraph(resolve(root, "packages/worker/src/eval-standin-helper.ts"), repoResolver(root), { serverOnly: { https: new Set(["Server"]), tls: new Set(["SecureContext"]) } });
    expect(narrow.violations.map((violation) => violation.rule)).toEqual(expect.arrayContaining(["imports createServer from node:https", "imports createSecureContext from node:tls"]));
  });
  it("imports only what a file-reading, server-only program needs from node", () => {
    const allowed = new Set(["node:fs", "node:net", "node:http", "node:https", "node:tls", "node:crypto", "node:util"]);
    const modules = new Set<string>();
    for (const file of graph.files) for (const match of readFileSync(file, "utf8").matchAll(/from "(node:[a-z/]+)"/gu)) modules.add(match[1]!);
    expect([...modules].filter((name) => !allowed.has(name))).toEqual([]);
    expect(modules.has("node:https")).toBe(true);
  });
  it("the helper's only relative imports are the shared server and the authority, and its only package import is the narrow entry (and the yaml-free engine)", () => {
    const source = readFileSync(resolve(root, "packages/worker/src/eval-standin-helper.ts"), "utf8");
    expect([...source.matchAll(/from "(\.[^"]+)"/gu)].map((match) => match[1])).toEqual(["./run-ca.js", "./eval-standin-server.js"]);
    expect([...source.matchAll(/from "(@[^"]+)"/gu)].map((match) => match[1])).toEqual(["@agentx/contracts/eval-standin-helper"]);
  });
  it("never reaches the repository's own files or its yaml reader (the helper reads one pinned set, nothing else)", () => {
    expect(rel.filter((file) => /eval-standin-round|general-fakes-round/u.test(file))).toEqual([]);
    const source = readFileSync(resolve(root, "packages/worker/src/eval-standin-helper.ts"), "utf8");
    expect(source).not.toMatch(/process\.env/u);
  });
});
