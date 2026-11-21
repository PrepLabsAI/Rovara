// Code that has become too complex (issue #1294). Each function gets a cognitive complexity score, which measures how hard its control flow is to read
// (G. Ann Campbell, "Cognitive Complexity", SonarSource 2017):
// - +1 for each if, ternary, switch, loop and catch, plus 1 more for each level of nesting it sits in;
// - +1 for else and else if (no nesting increment);
// - +1 for each run of like logical operators (`a && b && c` is 1, `a && b || c` is 2);
// - +1 for a break or continue to a label.
// Each function is scored by itself: a nested function or callback is its own entry, and its body does not add to the function around it (SonarJS adds it).
// The top level of a module is scored as one more entry, `(top level)`.
//
// `report` (on demand, not in CI) ranks files by excess x churn: the code that is both hard to read and changed often, where a refactor pays off most.
// `check` (CI) is a ratchet. A file's excess is the sum, over its functions, of the score above THRESHOLD. A file whose excess
// goes up, or a new file with any, fails. A lower excess passes with a reminder to run `update`, which only ever lowers tests/complexity-baseline.json.
// A renamed file keeps its excess under its new path: move its entry in the baseline by hand.
// Node runs this file directly. It loads TypeScript, a dev dependency, only to parse: there's no type-checked program, so it reads the whole repository in seconds.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type * as TypeScript from "typescript";

export const THRESHOLD = 15;
export const BASELINE_PATH = "tests/complexity-baseline.json";
/** The production code the check covers: package sources, infrastructure and scripts. Tests and fixtures are left out. */
export const SOURCE_PATHSPECS = [":(glob)packages/*/src/**", "infra", "scripts"];

export interface FunctionScore { name: string; line: number; score: number }
export interface FileScore { file: string; lines: number; functions: FunctionScore[]; excess: number }
export type Counts = Record<string, number>;
export interface Comparison { pass: boolean; lines: string[]; raised: string[]; lowered: string[] }

const require = createRequire(import.meta.url);
let typescript: typeof TypeScript | undefined;
function ts(): typeof TypeScript {
  typescript ??= require("typescript") as typeof TypeScript;
  return typescript;
}

/** Whether a repository path is production TypeScript this check covers. */
export function isSourceFile(path: string): boolean {
  if (!/\.(ts|tsx|mts|cts)$/u.test(path) || /\.d\.[cm]?ts$/u.test(path)) return false;
  if (/(^|\/)(dist|node_modules|fixtures?|__snapshots__|tests?)\//u.test(path)) return false;
  return !/\.(test|spec)\.[cm]?tsx?$/u.test(path);
}

/** Every function's score in one source text, the top level included (when it has any). */
export function scoreSource(text: string, fileName = "source.ts"): FunctionScore[] {
  const t = ts();
  const source = t.createSourceFile(fileName, text, t.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? t.ScriptKind.TSX : t.ScriptKind.TS);
  const results: FunctionScore[] = [];
  const lineOf = (node: TypeScript.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const isFunction = (node: TypeScript.Node): node is TypeScript.FunctionLikeDeclaration =>
    t.isFunctionDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunction(node) || t.isMethodDeclaration(node)
    || t.isConstructorDeclaration(node) || t.isGetAccessorDeclaration(node) || t.isSetAccessorDeclaration(node);
  const isLogical = (node: TypeScript.Node): node is TypeScript.BinaryExpression =>
    t.isBinaryExpression(node) && [t.SyntaxKind.AmpersandAmpersandToken, t.SyntaxKind.BarBarToken, t.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind);
  const unparen = (node: TypeScript.Node): TypeScript.Node => {
    let current = node;
    while (t.isParenthesizedExpression(current)) current = current.expression;
    return current;
  };
  /** The operators of a logical chain, left to right, through parentheses. */
  const operators = (node: TypeScript.Node, into: TypeScript.SyntaxKind[]): TypeScript.SyntaxKind[] => {
    const inner = unparen(node);
    if (!isLogical(inner)) return into;
    operators(inner.left, into);
    into.push(inner.operatorToken.kind);
    operators(inner.right, into);
    return into;
  };
  const nameOf = (node: TypeScript.FunctionLikeDeclaration): string => {
    const owner = (name: string) => {
      const parent = node.parent;
      return parent !== undefined && (t.isClassDeclaration(parent) || t.isClassExpression(parent)) && parent.name !== undefined ? `${parent.name.text}.${name}` : name;
    };
    if (t.isConstructorDeclaration(node)) return owner("constructor");
    if (node.name !== undefined) return owner(node.name.getText(source));
    const parent = node.parent;
    if (t.isVariableDeclaration(parent) || t.isPropertyAssignment(parent) || t.isPropertyDeclaration(parent)) return owner(parent.name.getText(source));
    if (t.isCallExpression(parent)) return `(callback in ${parent.expression.getText(source).slice(0, 40)})`;
    // A factory's `return async (event) => { ... }`: named after the function that returns it.
    if (t.isReturnStatement(parent) || (t.isArrowFunction(parent) && parent.body === node)) {
      let outer: TypeScript.Node | undefined = parent;
      while (outer !== undefined && !isFunction(outer)) outer = outer.parent;
      if (outer !== undefined) return `(returned by ${nameOf(outer)})`;
    }
    return "(anonymous)";
  };

  /** Scores one function body (or the top level); a nested function is queued as its own entry. */
  const isNodeList = (body: TypeScript.Node | readonly TypeScript.Node[]): body is readonly TypeScript.Node[] => Array.isArray(body);
  const score = (body: TypeScript.Node | readonly TypeScript.Node[]): number => {
    let total = 0;
    const visit = (node: TypeScript.Node, nesting: number): void => {
      if (isFunction(node)) {
        measure(node);
        return;
      }
      if (t.isIfStatement(node)) {
        visitIf(node, nesting, false);
        return;
      }
      if (t.isConditionalExpression(node)) {
        total += 1 + nesting;
        visit(node.condition, nesting);
        visit(node.whenTrue, nesting + 1);
        visit(node.whenFalse, nesting + 1);
        return;
      }
      if (t.isSwitchStatement(node)) {
        total += 1 + nesting;
        visit(node.expression, nesting);
        for (const clause of node.caseBlock.clauses) clause.forEachChild((child) => { visit(child, nesting + 1); });
        return;
      }
      if (t.isForStatement(node) || t.isForInStatement(node) || t.isForOfStatement(node) || t.isWhileStatement(node) || t.isDoStatement(node)) {
        total += 1 + nesting;
        node.forEachChild((child) => { visit(child, child === node.statement ? nesting + 1 : nesting); });
        return;
      }
      if (t.isCatchClause(node)) {
        total += 1 + nesting;
        visit(node.block, nesting + 1);
        return;
      }
      if ((t.isBreakStatement(node) || t.isContinueStatement(node)) && node.label !== undefined) total += 1;
      if (isLogical(node) && !isLogical(unparen(parentThroughParens(node)))) {
        const ops = operators(node, []);
        total += ops.filter((op, index) => index === 0 || op !== ops[index - 1]).length;
      }
      node.forEachChild((child) => { visit(child, nesting); });
    };
    const visitIf = (node: TypeScript.IfStatement, nesting: number, elseIf: boolean): void => {
      total += elseIf ? 1 : 1 + nesting;
      visit(node.expression, nesting);
      visit(node.thenStatement, nesting + 1);
      const otherwise = node.elseStatement;
      if (otherwise === undefined) return;
      if (t.isIfStatement(otherwise)) {
        visitIf(otherwise, nesting, true);
        return;
      }
      total += 1;
      visit(otherwise, nesting + 1);
    };
    const nodes: readonly TypeScript.Node[] = isNodeList(body) ? body : [body];
    for (const node of nodes) visit(node, 0);
    return total;
  };
  const parentThroughParens = (node: TypeScript.Node): TypeScript.Node => {
    let parent = node.parent;
    while (parent !== undefined && t.isParenthesizedExpression(parent)) parent = parent.parent;
    return parent ?? node;
  };
  const measure = (node: TypeScript.FunctionLikeDeclaration): void => {
    if (node.body === undefined) return;
    const entry: FunctionScore = { name: nameOf(node), line: lineOf(node), score: 0 };
    results.push(entry);
    entry.score = score(node.body);
  };

  // The top level of the module, as one more entry (left out when it has no branches).
  const topLevel: FunctionScore = { name: "(top level)", line: 1, score: 0 };
  results.push(topLevel);
  topLevel.score = score(source.statements);
  if (topLevel.score === 0) results.splice(results.indexOf(topLevel), 1);
  return results.sort((a, b) => a.line - b.line);
}

/** The amount by which the file's functions go over THRESHOLD, added up. */
export function excessOf(functions: readonly FunctionScore[], threshold = THRESHOLD): number {
  return functions.reduce((sum, entry) => sum + Math.max(0, entry.score - threshold), 0);
}

export function scoreFile(file: string, text: string): FileScore {
  const functions = scoreSource(text, file);
  return { file, lines: text.split("\n").length, functions, excess: excessOf(functions) };
}

/** The tracked production files, from git (so untracked scratch files are never counted). */
export function listSourceFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z", "--", ...SOURCE_PATHSPECS], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  return result.stdout.split("\0").filter((path) => path !== "" && isSourceFile(path)).sort();
}

/** Commits per file over the last `days` days, from one `git log`. */
export function parseChurn(log: string): Counts {
  const counts: Counts = {};
  for (const line of log.split("\n")) {
    const path = line.trim();
    if (path !== "") counts[path] = (counts[path] ?? 0) + 1;
  }
  return counts;
}
function churn(days: number): Counts {
  const result = spawnSync("git", ["log", `--since=${days}.days`, "--no-merges", "--name-only", "--format=", "--", ...SOURCE_PATHSPECS], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git log failed: ${result.stderr.trim()}`);
  return parseChurn(result.stdout);
}

export interface ReportRow extends FileScore { commits: number; hotspot: number }
/** Files with any excess, ranked by excess x (1 + commits), or by excess alone. */
export function rankFiles(files: readonly FileScore[], commits: Counts, sort: "hotspot" | "complexity"): ReportRow[] {
  return files
    .filter((file) => file.excess > 0)
    .map((file) => ({ ...file, commits: commits[file.file] ?? 0, hotspot: file.excess * (1 + (commits[file.file] ?? 0)) }))
    .sort((a, b) => (sort === "hotspot" ? b.hotspot - a.hotspot : 0) || b.excess - a.excess || a.file.localeCompare(b.file));
}

export function formatReport(rows: readonly ReportRow[], options: { top: number; days: number; sort: string; worst: number }): string {
  const shown = rows.slice(0, options.top);
  const out = [
    `Code to refactor first: ${options.sort === "hotspot" ? `excess complexity x (1 + commits in the last ${options.days} days)` : "excess complexity"}.`,
    `Excess is the sum, over a file's functions, of each function's cognitive complexity above ${THRESHOLD}. ${rows.length} files have any.`,
    "",
  ];
  shown.forEach((row, index) => {
    const over = row.functions.filter((entry) => entry.score > THRESHOLD).sort((a, b) => b.score - a.score);
    out.push(`${String(index + 1).padStart(2)}. ${row.file}  (excess ${row.excess}, ${over.length} functions over ${THRESHOLD}, ${row.lines} lines, ${row.commits} commits)`);
    for (const entry of over.slice(0, options.worst)) out.push(`      ${String(entry.score).padStart(4)}  ${row.file}:${entry.line}  ${entry.name}`);
    if (over.length > options.worst) out.push(`            ... and ${over.length - options.worst} more`);
  });
  return out.join("\n");
}

export function parseBaseline(text: string): Counts {
  const parsed = JSON.parse(text) as unknown;
  const files = (parsed as { files?: unknown }).files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) throw new Error(`${BASELINE_PATH} must be {"files": {"<path>": <excess>}}`);
  for (const [file, value] of Object.entries(files)) {
    if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${BASELINE_PATH}: ${file} must have a positive whole number`);
  }
  return files as Counts;
}
export function formatBaseline(counts: Counts): string {
  const files = Object.fromEntries(Object.entries(counts).filter(([, value]) => value > 0).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify({ files }, null, 2)}\n`;
}

/** The ratchet: no file's excess may go up, and a file not in the baseline may have none. */
export function compareToBaseline(baseline: Counts, current: Counts): Comparison {
  const raised: string[] = [];
  const lowered: string[] = [];
  for (const [file, excess] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (excess > allowed) raised.push(allowed === 0
      ? `${file} has excess complexity ${excess} and no baseline entry: split the functions over ${THRESHOLD} (npm run complexity:report -- --file ${file}). If the file was renamed, move its entry in ${BASELINE_PATH}.`
      : `${file} has excess complexity ${excess}, more than its baseline of ${allowed}: simplify the function you changed (npm run complexity:report -- --file ${file}).`);
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const excess = current[file] ?? 0;
    if (excess < allowed) lowered.push(`${file} is down to ${excess} from ${allowed}. Run npm run complexity:update and commit ${BASELINE_PATH}.`);
  }
  const lines = raised.length > 0
    ? [`Complexity ratchet: ${raised.length} file(s) more complex than ${BASELINE_PATH} allows.`, ...raised, ...(lowered.length > 0 ? ["", ...lowered] : [])]
    : [`Complexity ratchet: no file more complex than ${BASELINE_PATH} allows.`, ...lowered];
  return { pass: raised.length === 0, lines, raised, lowered };
}
/** `update` only lowers: an entry drops to the current excess (removed at 0, or when the file is gone); nothing is raised or added. */
export function lowerBaseline(baseline: Counts, current: Counts): Counts {
  return Object.fromEntries(Object.entries(baseline).map(([file, allowed]) => [file, Math.min(allowed, current[file] ?? 0)]));
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}
function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive whole number`);
  return parsed;
}

function scoreRepository(): FileScore[] {
  return listSourceFiles().map((file) => scoreFile(file, readFileSync(file, "utf8")));
}
function excessCounts(files: readonly FileScore[]): Counts {
  return Object.fromEntries(files.filter((file) => file.excess > 0).map((file) => [file.file, file.excess]));
}

/** `report`: the ranking, or one file's every function over the threshold with `--file`. */
function report(argv: readonly string[]): void {
  const sort = flag(argv, "--sort") ?? "hotspot";
  if (sort !== "hotspot" && sort !== "complexity") throw new Error("--sort must be hotspot or complexity");
  const days = positive(flag(argv, "--days"), 90, "--days");
  const only = flag(argv, "--file");
  const rows = rankFiles(only === undefined ? scoreRepository() : [scoreFile(only, readFileSync(only, "utf8"))], churn(days), sort);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const limits = only === undefined
    ? { top: positive(flag(argv, "--top"), 25, "--top"), worst: positive(flag(argv, "--worst"), 5, "--worst") }
    : { top: 1, worst: Number.MAX_SAFE_INTEGER };
  console.log(formatReport(rows, { ...limits, days, sort }));
}

/** `check`: the CI ratchet, with an annotation on the pull request for each file that got worse. */
function check(): number {
  const result = compareToBaseline(parseBaseline(readFileSync(BASELINE_PATH, "utf8")), excessCounts(scoreRepository()));
  (result.pass ? console.log : console.error)(result.lines.join("\n"));
  if (process.env.GITHUB_ACTIONS === "true") for (const line of result.raised) console.log(`::error file=${BASELINE_PATH}::${line}`);
  return result.pass ? 0 : 1;
}

/** `update` lowers the baseline where files got simpler; `init` writes it from scratch (once, when the check was introduced). */
function writeBaseline(mode: "update" | "init"): void {
  const current = excessCounts(scoreRepository());
  const next = mode === "init" ? current : lowerBaseline(parseBaseline(readFileSync(BASELINE_PATH, "utf8")), current);
  writeFileSync(BASELINE_PATH, formatBaseline(next));
  console.log(`Wrote ${BASELINE_PATH}: ${Object.values(next).filter((excess) => excess > 0).length} files.`);
}

// Usage, from the repository root:
//   node scripts/complexity.ts report [--top 25] [--days 90] [--sort hotspot|complexity] [--worst 5] [--file <path>] [--json]
//   node scripts/complexity.ts check | update | init
if (process.argv[1]?.endsWith("complexity.ts")) {
  const [mode, ...argv] = process.argv.slice(2);
  if (mode === "report") report(argv);
  else if (mode === "check") process.exitCode = check();
  else if (mode === "update" || mode === "init") writeBaseline(mode);
  else throw new Error("usage: node scripts/complexity.ts report|check|update|init");
}
