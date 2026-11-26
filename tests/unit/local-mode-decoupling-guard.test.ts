// Issue #1538 phase 1: the hosted product and the core import nothing of `rovara up` (local laptop mode), so the local code can be deleted without touching them. Held by reading the code itself:
// no source file outside the local code imports (statically, dynamically or for a type) the broker's `local/` folder, the local pages (`core/local-pages/`), `@agentx/broker/local` or
// `@agentx/local-adapters`. The local code itself, the `rovara up` command (`packages/cli/src/up/`) and the local adapters package may.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const PACKAGES = join(REPO, "packages");
const LOCAL_DIRS = ["packages/broker/src/local/", "packages/broker/src/core/local-pages/"];
/** Where local code lives and may import local code. */
const ALLOWED = [...LOCAL_DIRS, "packages/local-adapters/", "packages/cli/src/up/"];
const LOCAL_PACKAGES = /^@agentx\/(?:local-adapters|broker\/local)(?:\/|$)/u;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gmu;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:ts|tsx|mts)$/u.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

const all = readdirSync(PACKAGES, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => sources(join(PACKAGES, entry.name, "src")));
const rel = (path: string): string => relative(REPO, path).split("\\").join("/");
const checked = all.filter((file) => !ALLOWED.some((dir) => rel(file).startsWith(dir)));

function reachesLocal(file: string, specifier: string): boolean {
  if (LOCAL_PACKAGES.test(specifier)) return true;
  if (!specifier.startsWith(".")) return false;
  const target = rel(resolve(dirname(file), specifier));
  return LOCAL_DIRS.some((dir) => `${target}/`.startsWith(dir) || target.startsWith(dir));
}

describe("hosted and core code import nothing of local mode (#1538)", () => {
  it("reads the sources (the walk finds the hosted roots and the local code)", () => {
    const names = new Set(all.map(rel));
    for (const file of ["packages/broker/src/aws/core-engine-root.ts", "packages/broker/src/core-host/dev-routes.ts", "packages/broker/src/local/runtime.ts", "packages/broker/src/core/local-pages/views.ts"]) expect(names.has(file), file).toBe(true);
    expect(checked.length).toBeGreaterThan(1_000);
  });

  it("no file outside the local code imports the broker's local folder, the local pages, @agentx/broker/local or @agentx/local-adapters", () => {
    const offenders = checked.flatMap((file) => [...readFileSync(file, "utf8").matchAll(SPECIFIER)].map((match) => match[1]!).filter((specifier) => reachesLocal(file, specifier)).map((specifier) => `${rel(file)}: ${specifier}`));
    expect(offenders).toEqual([]);
  });
});
