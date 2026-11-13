// Generates two named entries of `@rovara-code/core` (docs/modular/move-map.md, "The host and plug-in kit entries"):
//
//   packages/core/src/host.ts        `@rovara-code/core/host`        every name the laptop app (`src/local/`) takes from a file outside `local/` (and outside the lessons package)
//   packages/core/src/plugin-kit.ts  `@rovara-code/core/plugin-kit`  every name the Slack and GitHub plug-ins take from a core file outside their own folders
//
// Both files are written out, one `export { ... } from "./path.js"` per module, with no `export *`. They add files only: no area barrel is edited, so the lanes that add
// exports to `core/sessions/index.ts` and the rest do not collide with them. `tests/contract/core-entries-generated.test.ts` fails when a file differs from what this script
// writes, which is the same as failing when `local/` imports a name `host.ts` does not have, or when `host.ts` exports a name nobody imports.
//
// Usage (from the repository root, Node 22):
//   node scripts/generate-core-entries.ts          write both files
//   node scripts/generate-core-entries.ts --check  exit 1 if either file is out of date
//
// Only erasable syntax and Node's own modules (plus the `typescript` package), so Node runs this file directly.
//
// How a name finds its module. Normally it is the file the importer named. When `local/` already imports a name through `../host.js` (the later step that rewrites local's
// imports to this entry), the module is taken from the current `host.ts`. When two files are named for one name (a barrel `index.ts` and the file it re-exports from), the
// file that the other re-exports from wins, and the script stops if the two are not a re-export of one another: that would be two different things under one name.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export const DEFAULT_SOURCE = "packages/core/src";

/** Plug-in folders whose imports out of the folder make up `./plugin-kit` (paths under the source root, trailing slash). */
export const PLUGIN_FOLDERS: readonly string[] = ["plugins/channel/slack/", "plugins/code-host/github/", "plugins/check-runner/github-actions/"];

/** Files the plug-ins take that move with the plug-in (GitHub only), so they are not part of the kit (move map, "The GitHub and Slack plug-ins"). */
export const MOVES_WITH_PLUGIN: readonly string[] = ["agents/github-agent-tools.ts", "github-job-log.ts", "github-pull-status.ts"];

/** Names the kit offers although no plug-in file imports them today: the move map names `secretReader` (the base of `contextSecretReader`) for a plug-in written outside core. */
export const PLUGIN_KIT_EXTRAS: ReadonlyArray<{ module: string; name: string }> = [{ module: "plugins/module-support.ts", name: "secretReader" }];

interface Use { module: string; name: string; typeOnly: boolean }
export interface GeneratedEntries { host: string; pluginKit: string; hostNames: number; pluginKitNames: number }

function sourceFiles(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(path);
  }
  return found.sort();
}

function resolveModule(root: string, from: string, specifier: string): string | undefined {
  const target = resolve(dirname(join(root, from)), specifier);
  for (const candidate of [target.replace(/\.js$/u, ".ts"), `${target}.ts`, join(target, "index.ts")]) {
    if (existsSync(candidate)) return relative(root, candidate).split("\\").join("/");
  }
  return undefined;
}

/** The names one file takes from other files of the source root by a relative specifier: named imports, `export { } from`, and `const { } = await import()`. */
function namesTaken(root: string, file: string): Array<{ to: string; names: Array<{ name: string; typeOnly: boolean }> }> {
  const parsed = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
  const taken: Array<{ to: string; names: Array<{ name: string; typeOnly: boolean }> }> = [];
  const add = (specifier: string, names: Array<{ name: string; typeOnly: boolean }>): void => {
    if (!specifier.startsWith(".")) return;
    const to = resolveModule(root, file, specifier);
    if (to === undefined) return;
    if (names.length > 0) taken.push({ to, names });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.name !== undefined && node.moduleSpecifier.text.startsWith(".")) throw new Error(`${file}: a default import of ${node.moduleSpecifier.text} cannot be named in an entry`);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings) && node.moduleSpecifier.text.startsWith(".")) throw new Error(`${file}: a namespace import of ${node.moduleSpecifier.text} cannot be named in an entry`);
      const names = bindings !== undefined && ts.isNamedImports(bindings)
        ? bindings.elements.map((element) => ({ name: (element.propertyName ?? element.name).text, typeOnly: clause?.isTypeOnly === true || element.isTypeOnly })) : [];
      add(node.moduleSpecifier.text, names);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      // `export * from` has no names to list: that module is already reached through its own entry.
      const clause = node.exportClause;
      const names = clause !== undefined && ts.isNamedExports(clause)
        ? clause.elements.map((element) => ({ name: (element.propertyName ?? element.name).text, typeOnly: node.isTypeOnly || element.isTypeOnly })) : [];
      add(node.moduleSpecifier.text, names);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) {
      const pattern = ts.isAwaitExpression(node.parent) && ts.isVariableDeclaration(node.parent.parent) ? node.parent.parent.name : undefined;
      const names = pattern !== undefined && ts.isObjectBindingPattern(pattern)
        ? pattern.elements.map((element) => ({ name: (element.propertyName ?? element.name).getText(), typeOnly: false })) : [];
      add(node.arguments[0].text, names);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return taken;
}

/** The module an existing generated entry file takes each name from. */
function currentMapping(root: string, file: string): Map<string, string> {
  const mapping = new Map<string, string>();
  if (!existsSync(join(root, file))) return mapping;
  for (const taken of namesTaken(root, file)) for (const { name } of taken.names) mapping.set(name, taken.to);
  return mapping;
}

/** Does `module` re-export `name` from `from`, by `export { name } from` or `export * from`? */
function reexports(root: string, module: string, name: string, from: string): boolean {
  const parsed = ts.createSourceFile(module, readFileSync(join(root, module), "utf8"), ts.ScriptTarget.Latest, true);
  return parsed.statements.some((statement) => {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
    if (resolveModule(root, module, statement.moduleSpecifier.text) !== from) return false;
    const clause = statement.exportClause;
    return clause === undefined || (ts.isNamedExports(clause) && clause.elements.some((element) => element.name.text === name));
  });
}

/** One module per name: the file that every other candidate re-exports from; stops on two candidates that are not a re-export of one another. */
function chooseModule(root: string, name: string, candidates: readonly string[]): string {
  if (candidates.length === 1) return candidates[0]!;
  const sources = candidates.filter((candidate) => candidates.every((other) => other === candidate || reexports(root, other, name, candidate)));
  if (sources.length !== 1) throw new Error(`the name ${name} is taken from ${candidates.join(" and ")}, which are not one re-exporting the other; two different things under one name cannot share an entry`);
  return sources[0]!;
}

const HEADER = (entry: string, source: string, script: string): string => [
  `// GENERATED by scripts/generate-core-entries.ts: do not edit. Regenerate with \`node scripts/generate-core-entries.ts\`; tests/contract/core-entries-generated.test.ts fails when this file is out of date.`,
  `// \`@rovara-code/core/${entry}\`: ${source}`,
  `// ${script}`,
  "",
].join("\n");

function render(entry: string, source: string, note: string, chosen: ReadonlyMap<string, { module: string; typeOnly: boolean }>): string {
  const byModule = new Map<string, string[]>();
  for (const [name, { module, typeOnly }] of [...chosen].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    byModule.set(module, [...(byModule.get(module) ?? []), typeOnly ? `type ${name}` : name]);
  }
  const lines: string[] = [];
  for (const [module, names] of [...byModule].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const target = `"./${module.replace(/\.ts$/u, ".js")}"`;
    const one = `export { ${names.join(", ")} } from ${target};`;
    if (one.length <= 170) { lines.push(one); continue; }
    lines.push("export {");
    let line = "  ";
    for (const name of names) {
      if (line.length + name.length + 2 > 168 && line.trim() !== "") { lines.push(line.trimEnd()); line = "  "; }
      line += `${name}, `;
    }
    lines.push(line.trimEnd(), `} from ${target};`);
  }
  return `${HEADER(entry, source, note)}${lines.join("\n")}\n`;
}

function choose(root: string, uses: readonly Use[]): Map<string, { module: string; typeOnly: boolean }> {
  const byName = new Map<string, Use[]>();
  for (const use of uses) byName.set(use.name, [...(byName.get(use.name) ?? []), use]);
  const chosen = new Map<string, { module: string; typeOnly: boolean }>();
  for (const [name, found] of byName) {
    const module = chooseModule(root, name, [...new Set(found.map((use) => use.module))].sort());
    // A name that any importer uses as a value is exported as a value; only when every importer takes it as a type is it a type export.
    chosen.set(name, { module, typeOnly: found.every((use) => use.typeOnly) });
  }
  return chosen;
}

export function generateEntries(root: string = DEFAULT_SOURCE): GeneratedEntries {
  const files = sourceFiles(root).map((file) => relative(root, file).split("\\").join("/"));
  const hostMapping = currentMapping(root, "host.ts");
  const kitMapping = currentMapping(root, "plugin-kit.ts");

  const hostUses: Use[] = [];
  const kitUses: Use[] = PLUGIN_KIT_EXTRAS.map((extra) => ({ ...extra, typeOnly: false }));
  for (const file of files) {
    const inLocal = file.startsWith("local/");
    const plugin = PLUGIN_FOLDERS.find((folder) => file.startsWith(folder));
    if (!inLocal && plugin === undefined) continue;
    for (const { to, names } of namesTaken(root, file)) {
      for (const { name, typeOnly } of names) {
        if (inLocal) {
          // `local/` taking a name through the entry itself (after its imports are rewritten): the module is the one the entry already names it from.
          if (to === "host.ts") {
            const module = hostMapping.get(name);
            if (module === undefined) throw new Error(`${file} imports ${name} from host.js, which does not export it; import it from its own file once and regenerate`);
            hostUses.push({ module, name, typeOnly });
          } else if (!to.startsWith("local/") && !to.startsWith("lessons/")) hostUses.push({ module: to, name, typeOnly });
        } else if (plugin !== undefined) {
          if (to === "plugin-kit.ts") {
            const module = kitMapping.get(name);
            if (module === undefined) throw new Error(`${file} imports ${name} from plugin-kit.js, which does not export it; import it from its own file once and regenerate`);
            kitUses.push({ module, name, typeOnly });
          } else if (!PLUGIN_FOLDERS.some((folder) => to.startsWith(folder)) && !MOVES_WITH_PLUGIN.includes(to)) kitUses.push({ module: to, name, typeOnly });
        }
      }
    }
  }
  const host = choose(root, hostUses);
  const kit = choose(root, kitUses);
  return {
    host: render("host", "what the laptop app (`src/local/`) takes from the rest of core, written out.", "The names come from the imports of local/; one file is named once per name. Everything is a named export: there is no star export.", host),
    pluginKit: render("plugin-kit", "what the Slack and GitHub plug-ins take from core, so they can leave it.", "The names come from the imports of plugins/channel/slack, plugins/code-host/github and plugins/check-runner/github-actions, plus `secretReader` (the move map).", kit),
    hostNames: host.size,
    pluginKitNames: kit.size,
  };
}

function main(): void {
  const check = process.argv.includes("--check");
  const generated = generateEntries();
  const targets: Array<[string, string]> = [[join(DEFAULT_SOURCE, "host.ts"), generated.host], [join(DEFAULT_SOURCE, "plugin-kit.ts"), generated.pluginKit]];
  let stale = false;
  for (const [path, text] of targets) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (current === text) continue;
    if (check) { console.error(`${path} is out of date; run: node scripts/generate-core-entries.ts`); stale = true; } else { writeFileSync(path, text); console.log(`wrote ${path}`); }
  }
  console.log(`host: ${generated.hostNames} names; plugin-kit: ${generated.pluginKitNames} names`);
  if (stale) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
