import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Task 4.3a, test case 12 (Ruling DB-10): the worker never loads the agent's side of the model channel. The agent step driver (Task 4.3b) and the AI SDK run in the executor,
// which has no key and no network but the app's; the worker is the only holder of the provider. The worker's static import graph, followed through every workspace package it
// imports, must never reach the executor subpath, the executor's channel client, an agent module, the AI SDK or e2e's agent.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The module specifiers a source file imports or re-exports statically, or imports by `import("...")`, with comments removed. */
export function specifiersOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const found = new Set<string>();
  for (const match of code.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s*)?["']([^"']+)["']/g)) found.add(match[1]!);
  for (const match of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.add(match[1]!);
  return [...found];
}

const WORKSPACE = /^@agentx\/([a-z-]+)(?:\/(.+))?$/;
const BANNED_FILE = /(?:^|\/)executor\/(?:model-channel|agent-[a-z-]+)\.ts$/;
const BANNED_SPECIFIER = /^(?:ai|@ai-sdk\/.+|e2e\/agent|@agentx\/verifier\/executor)(?:\/.*)?$/;

/** Resolves a specifier to a source file of this repository, or null for an external package. */
function resolveSource(from: string, specifier: string, packagesDir: string): string | null {
  const candidates = (base: string) => [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ""), `${base}.ts`, join(base, "index.ts")];
  if (specifier.startsWith(".")) return candidates(resolve(dirname(from), specifier)).find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
  const workspace = WORKSPACE.exec(specifier);
  if (workspace === null) return null;
  const [, name, subpath] = workspace;
  const src = join(packagesDir, name!, "src");
  if (subpath === undefined) return [join(src, "index.ts")].find((path) => existsSync(path)) ?? null;
  return candidates(join(src, `${subpath}.js`)).find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

export interface GraphFinding { file: string; specifier: string; why: string }

/** Walks the static import graph from every .ts file under `entryDir`, through workspace packages, and reports what it must not reach. */
export function walkImportGraph(entryDir: string, packagesDir: string): { visited: Set<string>; externals: Set<string>; findings: GraphFinding[] } {
  const visited = new Set<string>();
  const externals = new Set<string>();
  const findings: GraphFinding[] = [];
  const queue: string[] = [];
  const sourcesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sourcesUnder(join(dir, entry.name)) : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [join(dir, entry.name)] : []));
  queue.push(...sourcesUnder(entryDir));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const shown = relative(packagesDir, file);
    if (BANNED_FILE.test(file.replaceAll("\\", "/"))) findings.push({ file: shown, specifier: "(the file itself)", why: "a module of the agent's side of the channel is in the graph" });
    for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
      if (BANNED_SPECIFIER.test(specifier)) findings.push({ file: shown, specifier, why: "banned module" });
      const target = resolveSource(file, specifier, packagesDir);
      if (target === null) { if (!specifier.startsWith(".")) externals.add(specifier); continue; }
      if (!visited.has(target)) queue.push(target);
    }
  }
  return { visited, externals, findings };
}

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("the worker's static import graph", () => {
  const packagesDir = join(ROOT, "packages");
  const graph = walkImportGraph(join(packagesDir, "worker", "src"), packagesDir);

  it("never reaches the executor subpath, the channel client, an agent module, the AI SDK or e2e's agent", () => {
    expect(graph.findings).toEqual([]);
  });

  it("is a graph the walker really followed (positive controls): the worker's modules, the verifier through its main entry, and the model runtime with its provider layer", () => {
    const files = [...graph.visited].map((path) => relative(packagesDir, path).replaceAll("\\", "/"));
    for (const expected of ["worker/src/e2e-model-channel-session.ts", "worker/src/workflow-e2e-application-checks.ts", "verifier/src/host/docker-application-host.ts", "verifier/src/executor/redact.ts",
      "model-runtime/src/e2e-route.ts", "contracts/src/e2e-model-channel.ts"]) expect(files, expected).toContain(expected);
    expect(graph.externals.has("@earendil-works/pi-ai")).toBe(true);
    // The executor's own run, host and channel client are not in it.
    expect(files).not.toContain("verifier/src/executor/model-channel.ts");
    expect(files).not.toContain("verifier/src/executor/run.ts");
  });

  it("the detector finds each kind of violation when one is planted", () => {
    const planted = mkdtempSync(join(tmpdir(), "rovara-boundary-"));
    temporary.push(planted);
    const packages = join(planted, "packages");
    mkdirSync(join(packages, "worker", "src"), { recursive: true });
    mkdirSync(join(packages, "verifier", "src", "executor"), { recursive: true });
    writeFileSync(join(packages, "verifier", "src", "index.ts"), 'export { helper } from "./executor/model-channel.js";\n');
    writeFileSync(join(packages, "verifier", "src", "executor", "model-channel.ts"), "export const helper = 1;\n");
    const plant = (body: string) => { writeFileSync(join(packages, "worker", "src", "main.ts"), body); return walkImportGraph(join(packages, "worker", "src"), packages).findings; };
    expect(plant('import { x } from "@agentx/verifier/executor";\n').map((item) => item.specifier)).toContain("@agentx/verifier/executor");
    expect(plant('import { generateText } from "ai";\n').map((item) => item.specifier)).toContain("ai");
    expect(plant('import { createAnthropic } from "@ai-sdk/anthropic";\n').map((item) => item.specifier)).toContain("@ai-sdk/anthropic");
    expect(plant('const agent = await import("e2e/agent");\n').map((item) => item.specifier)).toContain("e2e/agent");
    // A banned module reached through the verifier's main entry, which the worker does import.
    expect(plant('import { helper } from "@agentx/verifier";\n').map((item) => item.why)).toContain("a module of the agent's side of the channel is in the graph");
    // A relative import of the file.
    expect(plant('export * from "../../verifier/src/executor/model-channel.js";\n').length).toBeGreaterThan(0);
    // And what is not a violation is not reported: a comment that mentions it, an unrelated package whose name merely starts with "ai".
    expect(plant('// import { generateText } from "ai";\nimport { x } from "airtable";\n')).toEqual([]);
  });
});
