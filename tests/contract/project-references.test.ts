// #1339: `tsc -b` builds a project after the projects its tsconfig references. A project that imports a workspace package without referencing it builds
// only by luck of the root tsconfig's order (packages/verifier imported @agentx/contracts that way), and `tsc -b <that project>` on a clean tree fails.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");

function referencesOf(project: string): string[] {
  const file = join(ROOT, project, "tsconfig.json");
  const read = ts.readConfigFile(file, (path) => ts.sys.readFile(path));
  if (read.error !== undefined) throw new Error(`${project}/tsconfig.json does not parse`);
  const references = (read.config as { references?: { path: string }[] }).references ?? [];
  return references.map((reference) => relative(ROOT, resolve(dirname(file), reference.path)).replaceAll("\\", "/"));
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as T;

describe("the TypeScript project references", () => {
  const projects = referencesOf("");

  it("reference, in each project the root builds, every workspace package its package.json depends on", () => {
    const projectOf = new Map(projects.map((project) => [readJson<{ name: string }>(`${project}/package.json`).name, project]));
    for (const project of projects) {
      const manifest = readJson<Record<string, Record<string, string> | undefined>>(`${project}/package.json`);
      const workspace = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })
        .map((name) => projectOf.get(name))
        .filter((dependency): dependency is string => dependency !== undefined && dependency !== project);
      const references = referencesOf(project);
      for (const dependency of workspace) expect(references, `${project} depends on ${dependency}`).toContain(dependency);
    }
  });

  it("only point at projects the root builds", () => {
    for (const project of projects) for (const reference of referencesOf(project)) expect(projects, `${project} -> ${reference}`).toContain(reference);
  });
});
