// Which modules of @rovara-code/contracts a browser may load. Used by tests/contract/package-entries.test.ts to prove that the
// browser-safe entry (packages/contracts/src/browser.ts) never reaches a Node built-in, and by anyone regenerating that entry.
//
// A module is browser-safe when nothing it imports, directly or through its own relative imports, is a Node built-in (`node:*`), the
// `typescript` package, or a use of the Node globals `Buffer`, `process` or `require` outside a comment. This is a conservative reading:
// a module may be left out that would run in a browser, never the other way round.
//
// Node runs this file directly, so only erasable syntax and only Node's own modules.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
const NODE_GLOBALS = /^[^/*\n]*\b(?:Buffer\b|process\.|require\()/m;

/** Every .ts file under `directory`, as paths relative to it. */
export const sourceFiles = (directory: string, base = directory): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(directory, entry.name), base) : entry.name.endsWith(".ts") ? [normalize(relative(base, join(directory, entry.name)))] : []);

/** The module a relative specifier names, as a path relative to the source folder, or null when it names no file there. */
const resolveRelative = (from: string, specifier: string, files: ReadonlySet<string>): string | null => {
  const target = normalize(join(dirname(from), specifier));
  const candidates = [target.endsWith(".js") ? `${target.slice(0, -3)}.ts` : `${target}.ts`, join(target.replace(/\.js$/, ""), "index.ts")];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
};

/** A checker over one source folder: `reason(entry)` is the first thing that stops `entry` (a path relative to the folder) from running in a browser, or null. */
export function browserChecker(srcDir: string): { files: ReadonlySet<string>; reason: (entry: string) => string | null } {
  const files = new Set(sourceFiles(srcDir));
  const memo = new Map<string, string | null>();
  const visit = (file: string, stack: readonly string[]): string | null => {
    if (memo.has(file)) return memo.get(file) ?? null;
    if (stack.includes(file)) return null;
    const text = readFileSync(join(srcDir, file), "utf8");
    let reason: string | null = NODE_GLOBALS.test(text) ? `${file}: uses a Node global (Buffer, process or require)` : null;
    for (const match of text.matchAll(IMPORT)) {
      if (reason !== null) break;
      const specifier = match[1]!;
      if (specifier.startsWith(".")) {
        const next = resolveRelative(file, specifier, files);
        if (next !== null) reason = visit(next, [...stack, file]);
      } else if (specifier.startsWith("node:") || specifier === "typescript") {
        reason = `${file}: imports ${specifier}`;
      }
    }
    memo.set(file, reason);
    return reason;
  };
  return { files, reason: (entry) => visit(normalize(entry), []) };
}

/** The `export * from` modules of index.ts that are browser-safe, in index order. */
export function browserSafeIndexModules(srcDir: string): string[] {
  const checker = browserChecker(srcDir);
  const index = readFileSync(join(srcDir, "index.ts"), "utf8");
  return [...index.matchAll(/^export \* from "(\.\/[^"]+)";$/gm)]
    .map((match) => match[1]!)
    .filter((specifier) => {
      const file = resolveRelative("index.ts", specifier, checker.files);
      return file !== null && checker.reason(file) === null;
    });
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const srcDir = process.argv[2] ?? "packages/contracts/src";
  if (!existsSync(join(srcDir, "index.ts"))) throw new Error(`no index.ts in ${srcDir}`);
  for (const specifier of browserSafeIndexModules(srcDir)) process.stdout.write(`export * from "${specifier}";\n`);
}
