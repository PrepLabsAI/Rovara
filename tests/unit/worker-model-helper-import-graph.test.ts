// TE-F2 part B (L3): the helper program has no outbound socket ANYWHERE in its import graph, judged on the parsed code (not a text search). The graph starts at the program and follows relative imports and the contracts package's
// NARROW model-helper entry; the contracts barrel (index.ts, which re-exports modules that call fetch) must not be reachable.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repoResolver, walkImportGraph } from "../support/import-graph.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = resolve(import.meta.dirname, "../..");
describe("the helper program's import graph", () => {
  const graph = walkImportGraph(resolve(root, "packages/worker/src/model-helper.ts"), repoResolver(root));
  it("is large enough to be a real walk, reaches the contracts only through the narrow entry, and never reaches the barrel", () => {
    const rel = graph.files.map((file) => file.slice(root.length + 1));
    expect(rel.length).toBeGreaterThan(20);
    expect(rel).toContain("packages/contracts/src/model-helper-entry.ts");
    expect(rel).toContain("packages/worker/src/model-helper-http.ts");
    expect(rel).not.toContain("packages/contracts/src/index.ts");
    expect(rel.filter((file) => /channel-command-client|setup-draft/u.test(file))).toEqual([]);
  });
  it("has no import, call or construction that can open an outbound connection", () => {
    expect(graph.violations).toEqual([]);
  });
  it("the walker does see renamed default imports, namespace imports, export-from, dynamic import, require and fetch (positive controls)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsig-"));
    try {
      const cases: Record<string, string> = {
        "a.ts": 'import n from "node:net"; n.connect(1);',
        "b.ts": 'import * as h from "node:http"; h.get("x");',
        "c.ts": 'import { connect as c } from "node:net"; c(1);',
        "d.ts": 'export { lookup } from "node:dns";',
        "e.ts": 'const m = await import("node:tls");',
        "f.ts": 'const r = require("node:https");',
        "g.ts": 'await fetch("http://x");',
        "h.ts": 'import { request } from "node:http"; void request;',
        "i.ts": 'import { spawn } from "child_process"; void spawn;',
        "j.ts": 'import { createServer, type Server } from "node:net"; void createServer;',
      };
      const expected = { "a.ts": true, "b.ts": true, "c.ts": true, "d.ts": true, "e.ts": true, "f.ts": true, "g.ts": true, "h.ts": true, "i.ts": true, "j.ts": false } as const;
      for (const [name, text] of Object.entries(cases)) {
        writeFileSync(join(dir, name), text);
        const result = walkImportGraph(join(dir, name), () => undefined);
        expect(result.violations.length > 0, name).toBe(expected[name as keyof typeof expected]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
