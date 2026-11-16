// General fakes slice 2b: the hosted fake-helper program has no outbound socket ANYWHERE in its import graph, judged on the parsed code (not a text search). The graph starts at the program and follows relative imports and
// the contracts package's NARROW general-fakes-helper entry; the contracts barrel (index.ts, which re-exports modules that call fetch) must not be reachable. The program reads its set from a read-only file and answers
// the one sandbox that calls it: it never needs to open a connection of its own, and a future change that gives it one fails here.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repoResolver, walkImportGraph } from "../support/import-graph.js";

const root = resolve(import.meta.dirname, "../..");
describe("the fake helper program's import graph", () => {
  const graph = walkImportGraph(resolve(root, "packages/worker/src/general-fakes-helper.ts"), repoResolver(root));
  const rel = graph.files.map((file) => file.slice(root.length + 1));
  it("is a real walk: the program, the shared server and the narrow contracts entry, and never the barrel or the launcher", () => {
    expect(rel).toContain("packages/worker/src/general-fakes-helper.ts");
    expect(rel).toContain("packages/worker/src/general-fakes-server.ts");
    expect(rel).toContain("packages/contracts/src/general-fakes-helper-entry.ts");
    expect(rel).toContain("packages/contracts/src/general-fakes-set.ts");
    expect(rel).toContain("packages/contracts/src/openapi-fake.ts");
    expect(rel).not.toContain("packages/contracts/src/index.ts");
    expect(rel.filter((file) => /general-fakes-hosted|general-fakes-round|run-network|docker|child/u.test(file))).toEqual([]);
  });
  it("has no import, call or construction that can open an outbound connection", () => {
    expect(graph.violations).toEqual([]);
  });
  it("imports only what a file-reading, server-only program needs from node", () => {
    const allowed = new Set(["node:fs", "node:net", "node:http", "node:crypto", "node:util"]);
    const modules = new Set<string>();
    for (const file of graph.files) for (const match of readFileSync(file, "utf8").matchAll(/from "(node:[a-z/]+)"/gu)) modules.add(match[1]!);
    expect([...modules].filter((name) => !allowed.has(name))).toEqual([]);
    expect(modules.has("node:http")).toBe(true);
  });
  it("the helper's only relative imports are the shared server", () => {
    const source = readFileSync(resolve(root, "packages/worker/src/general-fakes-helper.ts"), "utf8");
    const relative = [...source.matchAll(/from "(\.[^"]+)"/gu)].map((match) => match[1]);
    expect(relative).toEqual(["./general-fakes-server.js"]);
    const bare = [...source.matchAll(/from "(@[^"]+)"/gu)].map((match) => match[1]);
    expect(bare).toEqual(["@agentx/contracts/general-fakes-helper"]);
  });
});
