// OE-c1: nothing outside the SWE-bench runner reaches into packages/worker/src/swebench/. The Docker client the product
// shares lives in packages/worker/src/docker-cli.ts; this guard is the proof the folder can be deleted (OE-d) without
// touching product files.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const SKIP = new Set(["node_modules", "dist", ".git", "coverage"]);
// A module specifier that names a file inside a `swebench/` folder: "./swebench/run.js", "../swebench/x.js", ".../src/swebench/y.js".
const SWEBENCH_SPECIFIER = /["'`][^"'`\s]*\bswebench\/[a-z][a-z0-9-]*(?:\.js)?["'`]/g;

function walk(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** The SWE-bench runner itself, and the tests of it, may import the folder; everything else may not. */
function mayImportSwebench(file: string): boolean {
  if (file.startsWith("packages/worker/src/swebench/")) return true;
  if (file === "packages/worker/src/swebench-main.ts") return true;
  if (file.startsWith("tests/") && /(^|\/)[^/]*(swebench|secbench)[^/]*$/.test(file)) return true;
  // Characterizes the pi session through the runner's agent; leaves with the runner (OE-c2/OE-d).
  return file === "tests/integration/pi-worker-characterization.test.ts";
}

describe("the SWE-bench folder is isolated", () => {
  it("is imported by the runner and its own tests only", () => {
    const own = relative(root, join(root, "tests", "unit", "swebench-folder-isolated.test.ts")).split(sep).join("/");
    const offenders: string[] = [];
    for (const base of ["packages", "scripts", "infra", "tests"]) {
      for (const path of walk(join(root, base))) {
        const file = relative(root, path).split(sep).join("/");
        if (file === own || mayImportSwebench(file)) continue;
        const lines = readFileSync(path, "utf8").split("\n");
        lines.forEach((line, index) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (/\b(import|from|require|vi\.mock|vi\.doMock|vi\.importActual)\b/.test(line) && SWEBENCH_SPECIFIER.test(line)) offenders.push(`${file}:${String(index + 1)}`);
          SWEBENCH_SPECIFIER.lastIndex = 0;
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
