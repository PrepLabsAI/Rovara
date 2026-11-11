import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSync } from "esbuild";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// packages/contracts/package.json says `"sideEffects": false`: a bundler (esbuild, Vite, Rollup) may drop any module of the package whose exports nobody uses, along with its imports. That is
// what keeps a small Lambda or a browser page from carrying the whole barrel, and the TypeScript compiler that one file imports. It is only true while no module does anything at load time
// beyond building its own values. So this test lists every top-level statement that is not a declaration, an import or an export; a new one fails here until it is read and added.
const SRC = "packages/contracts/src";

/** Top-level statements that run code and are not a plain declaration, import or export. */
const EFFECTS = new Map<string, string>([
  ["e2e-safe-data.ts", "a check of the typed-array intrinsics that throws when the runtime lacks them; it changes nothing"],
  ["owner-starter-images.ts", "parses the module's own built-in list against its schema at load, so a bad entry throws; it changes nothing outside the module"],
  ["public-suffix-rules.ts", "freezes the module's own rule set (its add, delete and clear methods); it touches no other object"],
]);

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []));
}

describe("the contracts package is free of side effects", () => {
  it("says so in its package.json", () => {
    const manifest = JSON.parse(readFileSync("packages/contracts/package.json", "utf8")) as { sideEffects?: unknown };
    expect(manifest.sideEffects).toBe(false);
  });

  it("has no module that runs code at load time, apart from the three listed", () => {
    const found = new Map<string, string[]>();
    for (const path of walk(SRC)) {
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        const declaration = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement) || ts.isVariableStatement(statement)
          || ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
          || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement) || ts.isEmptyStatement(statement);
        if (declaration) continue;
        const name = path.slice(SRC.length + 1);
        found.set(name, [...(found.get(name) ?? []), statement.getText(source).slice(0, 60)]);
      }
    }
    expect([...found.keys()].sort()).toEqual([...EFFECTS.keys()].sort());
  });

  it("lets a bundler drop the barrel and the TypeScript compiler from a program that uses one small module", () => {
    // `errors.ts` needs only zod. The compiler is imported by one contracts file (e2e-catalog.ts); with the flag the bundle never loads it.
    const result = buildSync({
      stdin: { contents: 'export { agentXError } from "./errors.js";', resolveDir: join(process.cwd(), SRC), loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", write: false, metafile: true,
      logLevel: "silent", external: ["zod", "@aws-crypto/sha256-js"], tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((input) => input.includes("node_modules/typescript/"))).toBe(false);
    expect(inputs.length).toBeLessThan(40);
  });
});
