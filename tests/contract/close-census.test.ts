// The close census (CORE-CLOSE-PREVIEW): every call that closes a task or deletes what its workspace holds is classified in `close-census.ts`. A new one fails here until it is.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOSER_CENSUS, CLOSER_CENSUS_CALLS, CLOSER_CENSUS_SKIP } from "../../packages/broker/src/core/task-flow/close-census.js";

const root = join(import.meta.dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "testing", ".git"]);
function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/u.test(entry) && !entry.endsWith(".d.ts")) yield path;
  }
}
/** Lines that are only comments are not code. */
const codeOf = (text: string): string => text.split("\n").filter((line) => !/^\s*(?:\/\/|\/\*|\*)/u.test(line)).join("\n");

function scan(): Map<string, number> {
  const found = new Map<string, number>();
  for (const pkg of readdirSync(join(root, "packages"))) {
    if (SKIP_DIRS.has(pkg)) continue;
    const src = join(root, "packages", pkg, "src");
    try { statSync(src); } catch { continue; }
    for (const file of sources(src)) {
      const name = relative(root, file);
      if ((CLOSER_CENSUS_SKIP as readonly string[]).includes(name)) continue;
      const text = codeOf(readFileSync(file, "utf8"));
      for (const call of CLOSER_CENSUS_CALLS) {
        const count = text.split(call).length - 1;
        if (count > 0) found.set(`${name}\u0000${call}`, count);
      }
    }
  }
  return found;
}

describe("the closer census", () => {
  const found = scan();
  const table = new Map(CLOSER_CENSUS.map((entry) => [`${entry.file}\u0000${entry.call}`, entry]));

  it("classifies every closer and deleter in the source: nothing unclassified, nothing stale", () => {
    const unclassified = [...found].filter(([key]) => !table.has(key)).map(([key, count]) => `${key.replace("\u0000", "  ")} x${count}`);
    expect(unclassified, "a new closer or deleter: add it to close-census.ts with its mode").toEqual([]);
    const stale = CLOSER_CENSUS.filter((entry) => !found.has(`${entry.file}\u0000${entry.call}`)).map((entry) => `${entry.file}  ${entry.call}`);
    expect(stale, "a classified call that is gone: remove its row").toEqual([]);
    const wrongCount = CLOSER_CENSUS.filter((entry) => found.get(`${entry.file}\u0000${entry.call}`) !== entry.count).map((entry) => `${entry.file}  ${entry.call} table ${String(entry.count)} source ${String(found.get(`${entry.file}\u0000${entry.call}`))}`);
    expect(wrongCount, "an extra call of a classified kind: classify it").toEqual([]);
  });
  it("gives every row a mode and a note, and lists no row twice", () => {
    expect(table.size).toBe(CLOSER_CENSUS.length);
    for (const entry of CLOSER_CENSUS) {
      expect(entry.note.length).toBeGreaterThan(20);
      expect(["person", "system", "exempt-by-type", "not-a-closer", "definition", "out-of-scope"]).toContain(entry.mode);
    }
  });
  it("Slack reaches no core closer: its Stop stops a step only", () => {
    const slack = readFileSync(join(root, "packages/broker/src/aws/slack-core-stop.ts"), "utf8");
    expect(slack).not.toMatch(/closeTask\(|closeLoadedTask\(|machines\.terminate\(/u);
  });
});
