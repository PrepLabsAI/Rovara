// The browser and API checks in `core/e2e` are built on the ports: keeping a coding run's source, verifying a round or settling a record must not load a cloud client. The check follows every
// value import (type imports are erased) from each file of the folder and fails on a cloud SDK anywhere in the closure.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const folder = resolve("packages/broker/src/core/e2e");

/** Every way a module is loaded: `import x from`, `export x from`, a side-effect `import "x"`, and a dynamic `import("x")` (type imports are erased). */
function specifiersOf(text: string): string[] {
  return [
    ...[...text.matchAll(/^(?:import|export)\s+(?!type\b)[^"';]*?from\s+"([^"]+)"/gmu)].map((match) => match[1]!),
    ...[...text.matchAll(/^import\s+"([^"]+)"/gmu)].map((match) => match[1]!),
    ...[...text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/gu)].map((match) => match[1]!),
  ];
}

function closureOf(entries: readonly string[]): { files: Set<string>; sdk: string[] } {
  const files = new Set<string>();
  const sdk: string[] = [];
  const walk = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const text = readFileSync(file, "utf8");
    const specifiers = specifiersOf(text);
    for (const specifier of specifiers) {
      if (specifier.startsWith("@aws-sdk/")) sdk.push(`${file.replace(`${resolve(".")}/`, "")} -> ${specifier}`);
      else if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier.replace(/\.js$/u, ".ts"));
        if (existsSync(target)) walk(target);
      }
    }
  };
  entries.forEach(walk);
  return { files, sdk };
}

describe("core/e2e", () => {
  it("sees a module however it is loaded, and not a type import", () => {
    const text = [
      'import { a } from "@aws-sdk/client-s3";', 'import {\n  b,\n  c,\n} from "@aws-sdk/lib-dynamodb";', 'export { d } from "./d.js";', 'import "@aws-sdk/client-sqs";',
      'const e = await import("@aws-sdk/client-ssm");', 'import type { f } from "@aws-sdk/client-sts";', 'export type { g } from "./g.js";',
    ].join("\n");
    expect(specifiersOf(text)).toEqual(["@aws-sdk/client-s3", "@aws-sdk/lib-dynamodb", "./d.js", "@aws-sdk/client-sqs", "@aws-sdk/client-ssm"]);
  });

  it("pulls in no cloud SDK, however deep its imports go", () => {
    const entries = readdirSync(folder).filter((name) => name.endsWith(".ts")).map((name) => join(folder, name));
    const { files, sdk } = closureOf(entries);
    expect(files.size).toBeGreaterThan(entries.length);
    expect(sdk).toEqual([]);
  });
});
