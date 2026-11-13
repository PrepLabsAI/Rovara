// Guard test 2 of the modular split (docs/modular/move-map.md): an API report per package.
//
// For every workspace package with entries, packages/<name>/api-report.txt lists what each named entry exports: one line per exported name,
// `<kind> <name>`, sorted. The test builds the same list from the package's built declarations (dist/**/*.d.ts, so run `tsc -b` first) and
// fails when it differs from the checked-in report. A name that appears or disappears is then a visible line in the pull request, not a
// side effect of a refactor. To accept a change on purpose:
//
//   UPDATE_API_REPORT=1 npx vitest run tests/contract/package-api-report.test.ts
//
// This is an exported-symbol snapshot, not a signature check: a changed type of an unchanged name does not show here (the typecheck and the
// tests catch that). The reports are not part of the packed package (`files` in each package.json lists dist and what runs).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const update = process.env.UPDATE_API_REPORT === "1";

interface Manifest { name: string; main?: string; exports?: string | Record<string, string | { types?: string; default?: string }> }
const packageDirectories = readdirSync(join(root, "packages"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `packages/${entry.name}`).sort();

/** `{ entry specifier suffix ("." for the root): path of the entry's declaration file }`. */
function entryDeclarations(directory: string, manifest: Manifest): Map<string, string> {
  const result = new Map<string, string>();
  const add = (key: string, target: string | undefined): void => {
    if (target !== undefined) result.set(key, join(root, directory, target.replace(/\.js$/, ".d.ts")));
  };
  if (manifest.exports === undefined) {
    add(".", manifest.main);
  } else if (typeof manifest.exports === "string") {
    add(".", manifest.exports);
  } else {
    for (const [key, value] of Object.entries(manifest.exports)) add(key, typeof value === "string" ? value : value.default);
  }
  return result;
}

function kindOf(symbol: ts.Symbol): string {
  const flags = symbol.flags;
  if (flags & ts.SymbolFlags.Class) return "class";
  if (flags & ts.SymbolFlags.Function) return "function";
  if (flags & ts.SymbolFlags.Enum) return "enum";
  if (flags & ts.SymbolFlags.Variable) return "const";
  if (flags & ts.SymbolFlags.Module) return "namespace";
  if (flags & ts.SymbolFlags.Interface) return "interface";
  if (flags & ts.SymbolFlags.TypeAlias) return "type";
  return "other";
}

/** `{ name: "<kind> <name>" lines }` for each entry of a package, from its built declarations. */
function apiOf(declarations: ReadonlyMap<string, string>, checkerFor: (file: string) => { checker: ts.TypeChecker; source: ts.SourceFile }): Map<string, string[]> {
  const api = new Map<string, string[]>();
  for (const [key, file] of declarations) {
    const { checker, source } = checkerFor(file);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    const lines = moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol).map((exported) => {
      const resolved = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      return `${kindOf(resolved)} ${exported.name}`;
    });
    const nameOf = (line: string): string => line.slice(line.indexOf(" ") + 1);
    api.set(key, [...new Set(lines)].sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : a < b ? -1 : a > b ? 1 : 0)));
  }
  return api;
}

function render(name: string, api: ReadonlyMap<string, string[]>): string {
  return [`# ${name}: exported names per named entry (tests/contract/package-api-report.test.ts; refresh with UPDATE_API_REPORT=1)`, ...[...api].flatMap(([key, lines]) => ["", `## ${key}`, ...lines])].join("\n") + "\n";
}

describe("API report per package", () => {
  const built = packageDirectories.filter((directory) => existsSync(join(root, directory, "dist")));
  it("has built every package (run tsc -b first)", () => {
    expect(built).toEqual(packageDirectories);
  });

  // One program over every entry of every package keeps the whole check to one parse of the declarations.
  const manifests = new Map(packageDirectories.map((directory) => [directory, JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")) as Manifest]));
  const declarationsByPackage = new Map(packageDirectories.map((directory) => [directory, entryDeclarations(directory, manifests.get(directory)!)]));
  const allFiles = [...declarationsByPackage.values()].flatMap((declarations) => [...declarations.values()]).filter((file) => existsSync(file));
  const program = ts.createProgram(allFiles, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    skipLibCheck: true,
    noEmit: true,
    strict: true,
    types: ["node"],
    typeRoots: [join(root, "node_modules/@types")],
  });
  const checker = program.getTypeChecker();
  const checkerFor = (file: string): { checker: ts.TypeChecker; source: ts.SourceFile } => {
    const source = program.getSourceFile(file);
    if (source === undefined) throw new Error(`no declaration file ${file}; run tsc -b`);
    return { checker, source };
  };

  it.each(packageDirectories)("%s exports what its api-report.txt says", (directory) => {
    const manifest = manifests.get(directory)!;
    const declarations = declarationsByPackage.get(directory)!;
    for (const file of declarations.values()) expect(existsSync(file), `${file} (run tsc -b)`).toBe(true);
    const text = render(manifest.name, apiOf(declarations, checkerFor));
    const reportPath = join(root, directory, "api-report.txt");
    if (update) writeFileSync(reportPath, text);
    expect(existsSync(reportPath), `${directory}/api-report.txt is missing; create it with UPDATE_API_REPORT=1`).toBe(true);
    expect(text).toBe(readFileSync(reportPath, "utf8"));
  });

  it("notices a name that is added or removed", () => {
    const before = render("x", new Map([[".", ["function a", "const b"]]]));
    expect(render("x", new Map([[".", ["function a", "const b", "function c"]]]))).not.toBe(before);
    expect(render("x", new Map([[".", ["function a"]]]))).not.toBe(before);
    expect(render("x", new Map([[".", ["function a", "const b"]]]))).toBe(before);
  });
});
