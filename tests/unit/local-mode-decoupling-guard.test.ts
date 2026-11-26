// Issue #1538: `rovara up` (local laptop mode) is gone. Its runtime (`packages/broker/src/local/`) and its pages (`packages/broker/src/core/local-pages/`) were deleted in phase 3, after phase 1 made
// the hosted product and the core import nothing of them. Held by reading the code itself: the folders stay deleted, the `@agentx/broker/local` export stays gone, and no source file outside the
// local adapters package imports `@agentx/local-adapters` (phase 4 retires that package).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const PACKAGES = join(REPO, "packages");
const DELETED_DIRS = ["packages/broker/src/local", "packages/broker/src/core/local-pages"];
const LOCAL_SPECIFIER = /^@agentx\/(?:local-adapters|broker\/local)(?:\/|$)/u;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gmu;

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:ts|tsx|mts)$/u.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

const rel = (path: string): string => relative(REPO, path).split("\\").join("/");
const all = readdirSync(PACKAGES, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => sources(join(PACKAGES, entry.name, "src")));
const checked = all.filter((file) => !rel(file).startsWith("packages/local-adapters/"));

describe("local mode stays removed (#1538)", () => {
  it("reads the sources (the walk finds the hosted roots)", () => {
    const names = new Set(all.map(rel));
    for (const file of ["packages/broker/src/aws/core-engine-root.ts", "packages/broker/src/core-host/dev-routes.ts", "packages/broker/src/core/page-views.ts"]) expect(names.has(file), file).toBe(true);
    expect(checked.length).toBeGreaterThan(1_000);
  });

  it("the laptop runtime and its pages are not brought back, and the broker no longer exports ./local", () => {
    for (const dir of DELETED_DIRS) expect(existsSync(join(REPO, dir)), dir).toBe(false);
    const exports = (JSON.parse(readFileSync(join(PACKAGES, "broker/package.json"), "utf8")) as { exports: Record<string, string> }).exports;
    expect(Object.keys(exports)).not.toContain("./local");
  });

  it("no source file imports the deleted folders, @agentx/broker/local or @agentx/local-adapters", () => {
    const deleted = DELETED_DIRS.map((dir) => `${dir}/`);
    const offenders = checked.flatMap((file) => [...readFileSync(file, "utf8").matchAll(SPECIFIER)].map((match) => match[1]!).filter((specifier) => {
      if (LOCAL_SPECIFIER.test(specifier)) return true;
      if (!specifier.startsWith(".")) return false;
      const target = `${rel(resolve(file, "..", specifier))}/`;
      return deleted.some((dir) => target.startsWith(dir));
    }).map((specifier) => `${rel(file)}: ${specifier}`));
    expect(offenders).toEqual([]);
  });
});
