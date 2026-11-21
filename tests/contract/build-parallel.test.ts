// #1339: `npm run build` (scripts/build-parallel.ts) builds the TypeScript projects side by side, each after the projects it references. It is only as
// correct as the reference graph: a project that imports a workspace package it does not reference could be built before that package.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAll, buildOrder, readGraph, type Graph, type RunResult } from "../../scripts/build-parallel.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const graphOf = (entries: Record<string, string[]>): Graph => new Map(Object.entries(entries));

describe("the parallel build's schedule", () => {
  it("orders each project after the projects it references, and refuses a cycle", () => {
    const order = buildOrder(graphOf({ app: ["lib", "core"], lib: ["core"], core: [] }));
    expect(order).toEqual(["core", "lib", "app"]);
    expect(() => buildOrder(graphOf({ a: ["b"], b: ["a"] }))).toThrow(/cycle: a -> b -> a/u);
  });

  it("starts a project only after all its references built, never more than the limit at once", async () => {
    const graph = graphOf({ core: [], a: ["core"], b: ["core"], c: ["core"], top: ["a", "b", "c"] });
    const finished = new Set<string>();
    let running = 0, peak = 0;
    const result = await buildAll(graph, 2, async (project): Promise<RunResult> => {
      for (const reference of graph.get(project)!) expect(finished.has(reference), `${project} before ${reference}`).toBe(true);
      running += 1; peak = Math.max(peak, running);
      await new Promise((settle) => setTimeout(settle, 5));
      running -= 1; finished.add(project);
      return { ok: true, output: "" };
    });
    expect(result).toEqual({ failed: [], skipped: [] });
    expect(finished.size).toBe(5);
    expect(peak).toBe(2);
  });

  it("on a failure starts nothing new, names the failed project with its output, and lists what it never built", async () => {
    const graph = graphOf({ core: [], broken: ["core"], fine: ["core"], top: ["broken", "fine"] });
    const result = await buildAll(graph, 1, async (project) => (project === "broken" ? { ok: false, output: "error TS2307" } : { ok: true, output: "" }));
    expect(result.failed).toEqual([{ project: "broken", output: "error TS2307" }]);
    expect(result.skipped).toEqual(["fine", "top"]);
  });
});

describe("the repository's reference graph", () => {
  const graph = readGraph(ROOT);

  it("holds every project the root tsconfig references, with no cycle", () => {
    const root = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")) as { references: { path: string }[] };
    for (const { path } of root.references) expect(graph.has(path), path).toBe(true);
    expect(buildOrder(graph)).toHaveLength(graph.size);
  });

  it("references, in each project, every workspace package its package.json depends on (packages/verifier once did not)", () => {
    const projectOf = new Map<string, string>();
    for (const project of graph.keys()) {
      const name = (JSON.parse(readFileSync(join(ROOT, project, "package.json"), "utf8")) as { name: string }).name;
      projectOf.set(name, project);
    }
    for (const project of graph.keys()) {
      const manifest = JSON.parse(readFileSync(join(ROOT, project, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
      const workspace = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })
        .map((name) => projectOf.get(name)).filter((dependency): dependency is string => dependency !== undefined && dependency !== project);
      for (const dependency of workspace) expect(graph.get(project), `${project} depends on ${dependency}`).toContain(dependency);
    }
  });

  it("is what npm run build and the type check run", () => {
    const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(scripts.build).toBe("node scripts/build-parallel.ts");
    expect(scripts["typecheck:all"]).toMatch(/^node scripts\/build-parallel\.ts --pretty false && /u);
  });
});
