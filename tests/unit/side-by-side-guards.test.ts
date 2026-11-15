// TE-F10: nothing outside the lane's own files calls it yet, the lane's modules use no effectful API (no clock, no randomness, no file, no network), and the judge module never names the things it must not be given.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FILES = ["side-by-side", "side-by-side-run", "side-by-side-judge", "side-by-side-judge-pin", "side-by-side-render"];
const SRC = "packages/contracts/src";
const read = (name: string): string => readFileSync(join(SRC, `${name}.ts`), "utf8");
const walk = (dir: string, found: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (/\.(?:ts|tsx|js|mjs)$/u.test(entry.name)) found.push(path);
  }
  return found;
};

describe("no callers yet", () => {
  it("nothing outside packages/contracts (and tests) imports the side-by-side files or uses their exports", () => {
    const names = FILES.flatMap((file) => [...read(file).matchAll(/^export (?:declare )?(?:const|(?:async )?function|type|interface|class) ([A-Za-z0-9_]+)/gmu)].map((match) => match[1]!));
    expect(names.length).toBeGreaterThan(30);
    expect(names).toEqual(expect.arrayContaining(["runSideBySide", "renderSideBySide", "SIDE_BY_SIDE_JUDGE_ROLE", "evalSetCaseSource"]));
    const offenders: string[] = [];
    for (const root of ["packages", "scripts", "infra"]) {
      let files: string[];
      try {
        files = walk(root);
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.startsWith("packages/contracts/")) continue;
        const text = readFileSync(file, "utf8");
        if (/side-by-side/u.test(text) || names.some((name) => new RegExp(`\\b${name}\\b`, "u").test(text))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("is reachable only through the contracts barrel: no other contracts file imports the lane's modules", () => {
    const importers = walk(SRC).filter((file) => !FILES.some((name) => file.endsWith(`/${name}.ts`)) && /from\s+["']\.\/side-by-side/u.test(readFileSync(file, "utf8")));
    expect(importers).toEqual([join(SRC, "index.ts")]);
  });
});

describe("the modules use no effectful API", () => {
  it.each(FILES)("%s has no clock, randomness, file, process, child process, network or dynamic import", (file) => {
    const code = read(file).replace(/\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(code).not.toMatch(/node:(?:fs|http|https|net|child_process|dns|tls|os)|\bprocess\.|\bDate\b|\bMath\.random|\bperformance\b|\beval\(|new Function|\bimport\(|\bfetch\(|\bsetTimeout\b|crypto\.randomUUID/u);
    // The one randomness the lane has: the run-scoped default of the A/B order seed, in the runner only.
    if (file !== "side-by-side-run") expect(code).not.toMatch(/randomBytes/u);
  });
  it("draws randomness in exactly one place: the default A/B order seed of a run", () => {
    expect([...read("side-by-side-run").matchAll(/randomBytes\(/gu)]).toHaveLength(1);
    expect(read("side-by-side-run")).toMatch(/input\.orderSeed \?\? randomBytes\(16\)/u);
  });
  it("seeds its choices from a hash only", () => {
    expect(read("side-by-side")).toMatch(/createHash\("sha256"\)/u);
  });
});

describe("the judge module is independent by construction", () => {
  it("never names a prompt, a diff, a test, a file path, a task request or a model", () => {
    const code = read("side-by-side-judge").replace(/\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(code).not.toMatch(/\b(?:prompt|diff|tests?|filePath|path|taskRequest|request|model|frame|report|plan)\b/iu);
  });
});
