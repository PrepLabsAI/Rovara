// The engine boundary (phase 2b, step 4). The engine is the set of files that `@rovara-code/core` becomes once the laptop app, the GitHub and Slack plug-ins and the hosted
// control plane leave it: every file under `core/`, `services/` and `ports/` plus the helpers named in `engine-boundary-files.txt`. A file of that set may import only files of
// that set (and packages). So the engine never reaches `local/`, `lessons/`, the GitHub or Slack plug-in, or the AWS control plane, and the package split stays possible.
//
// The check reads every relative import of every engine file with the TypeScript parser: `import`, `export ... from`, `import()` with a string, and `import type`. Types count,
// because a type import is how one file once carried 122 AWS control-plane files into the engine (`TransactItems`). It does not type-check and does not see string module ids.
//
// When this test fails on a new import, either keep the code inside the engine (move or copy the small helper, or take it as a parameter), or, if the helper really belongs to
// the engine, add its file to `engine-boundary-files.txt` in the same change. Do not add an entry to PENDING: those are the known edges the later steps remove.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE = resolve("packages/core/src");
const LIST = resolve("tests/contract/engine-boundary-files.txt");
const ENGINE_FOLDERS = ["core", "services", "ports"];

/**
 * Edges that exist today and that a later step of phase 2b removes (`from -> to`, paths under packages/core/src, no line numbers). Each one fails the test if it stops
 * existing, so this list can only shrink.
 */
const PENDING: ReadonlyArray<{ edge: string; removedBy: string }> = [
  { edge: "plugins/index.ts -> plugins/code-host/github/index.ts", removedBy: "step 10: the GitHub package" },
  { edge: "plugins/index.ts -> plugins/code-host/github/plugin.ts", removedBy: "step 10: the GitHub package" },
  { edge: "plugins/index.ts -> plugins/code-host/github/provider.ts", removedBy: "step 10: the GitHub package" },
  { edge: "plugins/index.ts -> plugins/check-runner/github-actions/index.ts", removedBy: "step 10: the GitHub package" },
  { edge: "plugins/index.ts -> plugins/check-runner/github-actions/plugin.ts", removedBy: "step 10: the GitHub package" },
  { edge: "plugins/index.ts -> plugins/channel/slack/index.ts", removedBy: "step 9: the Slack package" },
];

interface Edge { from: string; line: number; to: string; typeOnly: boolean }

function sourceFiles(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

const relativeToSource = (path: string): string => relative(SOURCE, path).split("\\").join("/");

function listedFiles(): string[] {
  return readFileSync(LIST, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
}

/** The engine file set: the three engine folders by folder, and the listed helpers. */
function engineFiles(): { files: Set<string>; listed: string[] } {
  const listed = listedFiles();
  const files = new Set(listed);
  for (const folder of ENGINE_FOLDERS) for (const file of sourceFiles(join(SOURCE, folder))) files.add(relativeToSource(file));
  return { files, listed };
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const target = resolve(dirname(join(SOURCE, from)), specifier);
  for (const candidate of [target.replace(/\.js$/u, ".ts"), `${target}.ts`, join(target, "index.ts")]) {
    if (existsSync(candidate)) return relativeToSource(candidate);
  }
  return undefined;
}

function importsOf(file: string): Edge[] {
  const text = readFileSync(join(SOURCE, file), "utf8");
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edges: Edge[] = [];
  const add = (specifier: string, node: ts.Node, typeOnly: boolean): void => {
    if (!specifier.startsWith(".")) return;
    const to = resolveRelative(file, specifier);
    if (to !== undefined) edges.push({ from: file, line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1, to, typeOnly });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names = clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
      add(node.moduleSpecifier.text, node, clause?.isTypeOnly === true || (names.length > 0 && names.every((name) => name.isTypeOnly)));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, node, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) {
      add(node.arguments[0].text, node, false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node.argument.literal.text, node, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return edges;
}

/** Every import from an engine file to a file outside the engine set. */
function edgesOut(files: ReadonlySet<string>): Edge[] {
  return [...files].sort().flatMap((file) => importsOf(file).filter((edge) => !files.has(edge.to)));
}

const edgeKey = (edge: Edge): string => `${edge.from} -> ${edge.to}`;

describe("the engine boundary", () => {
  const { files, listed } = engineFiles();

  it("lists only files that exist, in order, once each", () => {
    const missing = listed.filter((file) => !existsSync(join(SOURCE, file)));
    expect(missing, `engine-boundary-files.txt names files that do not exist (renamed or deleted? update the list):\n${missing.join("\n")}`).toEqual([]);
    expect([...listed].sort(), "engine-boundary-files.txt must be sorted").toEqual(listed);
    expect(new Set(listed).size, "engine-boundary-files.txt names a file twice").toBe(listed.length);
    const folderEntries = listed.filter((file) => ENGINE_FOLDERS.some((folder) => file.startsWith(`${folder}/`)));
    expect(folderEntries, "files under core/, services/ and ports/ belong to the engine by folder; do not list them").toEqual([]);
  });

  it("has no import from an engine file to a file outside the engine", () => {
    const pending = new Map(PENDING.map((entry) => [entry.edge, entry]));
    const seen = new Set<string>();
    const fresh: string[] = [];
    for (const edge of edgesOut(files)) {
      seen.add(edgeKey(edge));
      if (pending.has(edgeKey(edge))) continue;
      fresh.push(`  ${edge.from}:${edge.line} imports ${edge.to}${edge.typeOnly ? " (type only)" : ""}`);
    }
    expect(fresh, [
      "An engine file imports a file outside the engine boundary. The engine (core/, services/, ports/ and the files in tests/contract/engine-boundary-files.txt) may import only itself.",
      "Keep the code inside the engine, or add the target to engine-boundary-files.txt if it really belongs there. The new edges follow",
    ].join("\n")).toEqual([]);
    const gone = PENDING.filter((entry) => !seen.has(entry.edge)).map((entry) => `  ${entry.edge} (${entry.removedBy})`);
    expect(gone, "These known edges no longer exist, so remove them from PENDING in tests/contract/engine-boundary.test.ts").toEqual([]);
  });
});
