// The repository-id check is STRUCTURE. Every exported function of the lessons file code that takes a `RepoFileTarget` wraps it in `guardTarget` first, and a guarded host calls nothing
// (but `repositoryIdentity`) until the id the host reports is the id the place pins. A test enumerates the functions, so a path added later cannot skip the check.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { RepositoryMismatch, guardTarget, headOf, readOwnPr, repositoryIdOfPlace, verifyRepository } from "../../../packages/lessons/src/repo-file-host.js";
import { FakeRepoHost, passSetup } from "./repo-file-helpers.js";

const dir = join(import.meta.dirname, "../../../packages/lessons/src");
const source = (name: string): string => readFileSync(join(dir, name), "utf8");

/**
 * THE STRUCTURAL CHECK, on the TypeScript AST with types (not on text). In the lessons file code, a "host use" is any expression whose type is `CodeHost` that is not just the receiver of a capability probe (`host.x !== undefined`,
 * `repositoryIdentity`, `kind`...): a call, an alias (`const h = target.host`), a destructured method, a handle passed on. Whatever it is called and whatever the parameter is named:
 * - an EXPORTED function or exported arrow const that has a `RepoFileTarget` parameter and a host use must wrap that parameter first (`const t = guardTarget(param)` as a top-level statement, with the raw parameter not used again; or
 * `assertGuarded(param)` for the shared helpers that are handed a guarded target);
 * - an exported function with a host use and no target parameter is not allowed;
 * - an internal function with a host use may only be referenced from functions that are themselves safe (a fixpoint over the file).
 * The implementation of the guard itself (`verifyRaw`, `guardTarget`, `verifyRepository`, `assertGuarded`) is the one named exemption.
 */
const EXEMPT = new Set(["repo-file-host.ts#verifyRaw", "repo-file-host.ts#guardTarget", "repo-file-host.ts#verifyRepository", "repo-file-host.ts#assertGuarded"]);
const PROBE_NAMES = new Set(["repositoryIdentity", "kind", "capabilities", "events"]);

function analyse(program: ts.Program, fileNames: readonly string[]): { violations: string[]; guarded: string[] } {
  const checker = program.getTypeChecker();
  const violations: string[] = [];
  const guarded: string[] = [];
  const isNamed = (node: ts.Node, name: string): boolean => {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(node));
    return type.getSymbol()?.name === name || type.aliasSymbol?.name === name;
  };
  const isUndefinedCompare = (node: ts.Node): boolean => ts.isBinaryExpression(node)
    && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)
    && (ts.isIdentifier(node.right) && node.right.text === "undefined" || ts.isIdentifier(node.left) && node.left.text === "undefined");
  const nameOf = (node: ts.PropertyAccessExpression): string => node.name.text;

  for (const fileName of fileNames) {
    const source = program.getSourceFile(fileName);
    if (source === undefined) throw new Error(`not in the program: ${fileName}`);
    const base = fileName.slice(fileName.lastIndexOf("/") + 1);
    type Unit = { name: string; node: ts.FunctionLikeDeclaration; exported: boolean };
    const units: Unit[] = [];
    for (const statement of source.statements) {
      const exported = (ts.getCombinedModifierFlags(statement as unknown as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined) units.push({ name: statement.name.text, node: statement, exported });
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const init = declaration.initializer;
          if (ts.isIdentifier(declaration.name) && init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) units.push({ name: declaration.name.text, node: init, exported });
        }
      }
    }
    const unitOf = (node: ts.Node): Unit | undefined => units.find((unit) => node.pos >= unit.node.pos && node.end <= unit.node.end);

    /** Host uses inside a unit (nested closures included). */
    const hostUses = (unit: Unit): ts.Node[] => {
      const found: ts.Node[] = [];
      const visit = (node: ts.Node): void => {
        if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && isNamed(node, "CodeHost")) {
          const parent = node.parent;
          const declaresName = (ts.isBindingElement(parent) || ts.isParameter(parent) || ts.isVariableDeclaration(parent)) && parent.name === node;
          const isMember = ts.isPropertyAccessExpression(parent) && parent.name === node;
          const benign = ts.isPropertyAccessExpression(parent) && parent.expression === node && (PROBE_NAMES.has(nameOf(parent)) || isUndefinedCompare(parent.parent) || (ts.isNonNullExpression(parent.parent) ? false : false));
          if (!declaresName && !isMember && !benign) found.push(node);
        }
        // const { deleteBranch } = target.host
        if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && ts.isVariableDeclaration(node.parent.parent) && node.parent.parent.initializer !== undefined
          && isNamed(node.parent.parent.initializer, "CodeHost")) found.push(node);
        // const { host } = target
        if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && ts.isVariableDeclaration(node.parent.parent) && node.parent.parent.initializer !== undefined
          && isNamed(node.parent.parent.initializer, "RepoFileTarget") && (node.propertyName ?? node.name).getText() === "host" && !isOnlyProbed(node)) found.push(node);
        ts.forEachChild(node, visit);
      };
      const isOnlyProbed = (element: ts.BindingElement): boolean => {
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol === undefined) return false;
        let probed = true;
        const check = (node: ts.Node): void => {
          if (ts.isIdentifier(node) && node !== element.name && checker.getSymbolAtLocation(node) === symbol) {
            const parent = node.parent;
            if (!(ts.isPropertyAccessExpression(parent) && parent.expression === node && (PROBE_NAMES.has(nameOf(parent)) || isUndefinedCompare(parent.parent)))) probed = false;
          }
          ts.forEachChild(node, check);
        };
        check(unit.node);
        return probed;
      };
      if (unit.node.body !== undefined) visit(unit.node.body);
      return found;
    };

    /** Does the unit wrap each RepoFileTarget parameter first? */
    const guards = (unit: Unit): { needs: boolean; ok: boolean } => {
      const params = unit.node.parameters.filter((parameter) => isNamed(parameter, "RepoFileTarget"));
      if (params.length === 0) return { needs: false, ok: false };
      const body = unit.node.body;
      if (body === undefined || !ts.isBlock(body)) return { needs: true, ok: false };
      let ok = true;
      for (const parameter of params) {
        const symbol = checker.getSymbolAtLocation(parameter.name);
        const callTo = (statement: ts.Statement): "guardTarget" | "assertGuarded" | undefined => {
          const call = ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.initializer : ts.isExpressionStatement(statement) ? statement.expression : undefined;
          const expression = call !== undefined && ts.isAwaitExpression(call) ? call.expression : call;
          if (expression === undefined || !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return undefined;
          const callee = expression.expression.text;
          const argument = expression.arguments[0];
          if ((callee !== "guardTarget" && callee !== "assertGuarded") || argument === undefined || !ts.isIdentifier(argument) || checker.getSymbolAtLocation(argument) !== symbol) return undefined;
          return callee;
        };
        const kind = body.statements.map(callTo).find((k) => k !== undefined);
        if (kind === undefined) { ok = false; continue; }
        if (kind === "guardTarget") {
          // The raw parameter is not used again: everything after the guard works on the guarded one.
          let uses = 0;
          const count = (node: ts.Node): void => { if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) uses += 1; ts.forEachChild(node, count); };
          count(body);
          if (uses !== 1) ok = false;
        }
      }
      return { needs: true, ok };
    };

    const safe = new Set<string>();
    for (const unit of units) {
      const key = `${base}#${unit.name}`;
      if (EXEMPT.has(key)) { safe.add(unit.name); continue; }
      const uses = hostUses(unit);
      const { needs, ok } = guards(unit);
      if (unit.exported) {
        if (uses.length > 0 && !(needs && ok)) violations.push(`${key}: exported and uses the code host without guarding its RepoFileTarget parameter`);
        // A function that takes a target and does not guard it is not a safe place to call an internal function from.
        else if (!needs || ok) { safe.add(unit.name); if (needs) guarded.push(key); }
      }
    }
    // Internal functions that use the host: referenced only from safe functions (a fixpoint).
    const internal = units.filter((unit) => !unit.exported && !EXEMPT.has(`${base}#${unit.name}`));
    let changed = true;
    const okInternal = new Set<string>();
    while (changed) {
      changed = false;
      for (const unit of internal) {
        if (okInternal.has(unit.name)) continue;
        const references: ts.Node[] = [];
        const find = (node: ts.Node): void => {
          if (ts.isIdentifier(node) && node.text === unit.name && node !== (unit.node.parent as ts.VariableDeclaration | undefined)?.name && !(ts.isFunctionDeclaration(unit.node) && unit.node.name === node)) references.push(node);
          ts.forEachChild(node, find);
        };
        find(source);
        const callers = references.map((reference) => unitOf(reference));
        // (An internal function nobody calls is dead code and harmless.)
        if (callers.every((caller) => caller !== undefined && caller.name !== unit.name && (safe.has(caller.name) || okInternal.has(caller.name)))) { okInternal.add(unit.name); safe.add(unit.name); changed = true; }
      }
    }
    for (const unit of internal) if (!okInternal.has(unit.name) && hostUses(unit).length + (guards(unit).needs ? 1 : 0) > 0) violations.push(`${base}#${unit.name}: handles the code host or a target and is reachable from a function that does not guard its target`);
  }
  return { violations, guarded };
}

describe("the repository-id guard is enforced structurally (TypeScript AST, with types)", () => {
  const lessonsFiles = readdirSync(dir).filter((name) => name.endsWith(".ts") && (/^repo-file-.*\.ts$/u.test(name) || source(name).includes("RepoFileTarget"))).map((name) => join(dir, name)).sort();
  const virtualPath = join(dir, "virtual-probe.ts");
  const probeSource = `
import type { CodeHost } from "@rovara-code/contracts";
import { assertGuarded, guardTarget, type RepoFileTarget } from "./repo-file-host.js";
export async function okEntry(deps: unknown, target: RepoFileTarget): Promise<unknown> { const t = guardTarget(target); return t.host.baseBranchHead(t.repository, "x", t.scope); }
export async function okAlias(target: RepoFileTarget): Promise<void> { const t = guardTarget(target); const h = t.host; await h.deleteBranch!(t.repository, "b", t.scope); }
export async function okAssert(target: RepoFileTarget): Promise<unknown> { assertGuarded(target); return target.host.baseBranchHead(target.repository, "x", target.scope); }
export function probesOnly(target: RepoFileTarget): boolean { return target.host.commitFiles !== undefined && target.host.deleteBranch !== undefined; }
export const arrowEntry = async (target: RepoFileTarget): Promise<unknown> => { return target.host.baseBranchHead(target.repository, "x", target.scope); };
export async function renamedParam(repo: RepoFileTarget): Promise<void> { await repo.host.deleteBranch!(repo.repository, "b", repo.scope); }
export async function aliased(t: RepoFileTarget): Promise<void> { const h = t.host; await h.deleteBranch!(t.repository, "b", t.scope); }
export async function destructuredMethod(t: RepoFileTarget): Promise<void> { const { deleteBranch } = t.host; await deleteBranch(t.repository, "b", t.scope); }
export async function destructuredHost(t: RepoFileTarget): Promise<unknown> { const { host } = t; return host.baseBranchHead(t.repository, "x", t.scope); }
export async function guardUsedRaw(target: RepoFileTarget): Promise<unknown> { const t = guardTarget(target); void t; return target.host.baseBranchHead(target.repository, "x", target.scope); }
export async function commentOnly(target: RepoFileTarget): Promise<unknown> { /* guardTarget(target) */ return target.host.baseBranchHead(target.repository, "x", target.scope); }
function helper(host: CodeHost): Promise<string> { return host.baseBranchHead({ url: "u" }, "x", {} as never); }
export function viaHelper(host: CodeHost): Promise<string> { return helper(host); }
export async function guardedViaHelper(target: RepoFileTarget): Promise<void> { const t = guardTarget(target); await inner(t); }
function inner(t: RepoFileTarget): Promise<string> { return t.host.baseBranchHead(t.repository, "x", t.scope); }
export const unreachableGuard = (target: RepoFileTarget): Promise<void> => { return inner(target).then(() => undefined); };
`;
  const options = ((): ts.CompilerOptions => {
    const config = ts.readConfigFile(join(dir, "../../../../tsconfig.base.json"), (path) => ts.sys.readFile(path));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(dir, "../.."));
    const { rootDir: _rootDir, outDir: _outDir, ...rest } = parsed.options;
    void _rootDir; void _outDir;
    return { ...rest, noEmit: true, composite: false, declaration: false, declarationMap: false, incremental: false };
  })();
  const compilerHost = ts.createCompilerHost(options);
  const realGet = compilerHost.getSourceFile.bind(compilerHost);
  compilerHost.getSourceFile = (name, ...rest) => (name === virtualPath ? ts.createSourceFile(name, probeSource, ts.ScriptTarget.ES2023, true) : realGet(name, ...rest));
  const realExists = compilerHost.fileExists.bind(compilerHost);
  compilerHost.fileExists = (name) => name === virtualPath || realExists(name);
  const program = ts.createProgram([...lessonsFiles, virtualPath], options, compilerHost);

  it("flags the ways around the guard: an exported arrow, a renamed parameter, an alias, a destructured method or host, a raw use after the guard, a comment, a helper reached from an unguarded function", () => {
    const { violations } = analyse(program, [virtualPath]);
    expect(violations.map((v) => v.split(":")[0]!.replace("virtual-probe.ts#", "")).sort()).toEqual(
      ["aliased", "arrowEntry", "commentOnly", "destructuredHost", "destructuredMethod", "guardUsedRaw", "helper", "inner", "renamedParam", "viaHelper"].sort(),
    );
  });

  it("accepts the guarded forms (a guard then an alias, assertGuarded, a probe-only function, a helper reached only from a guarded one)", () => {
    const { guarded } = analyse(program, [virtualPath]);
    expect(guarded.map((k) => k.replace("virtual-probe.ts#", "")).sort()).toEqual(["guardedViaHelper", "okAlias", "okAssert", "okEntry"]);
  });

  it("the lessons file code has no unguarded host use, and the guarded entry points are exactly the known ones", () => {
    const { violations, guarded } = analyse(program, lessonsFiles);
    expect(violations).toEqual([]);
    expect(guarded.sort()).toEqual([
      "repo-file-erase.ts#closeAllRovaraPrs", "repo-file-erase.ts#sweepErasures", "repo-file-host.ts#freshBranchName", "repo-file-host.ts#headOf", "repo-file-host.ts#readOwnPr",
      "repo-file-pass.ts#finishClosings", "repo-file-pass.ts#runRepoFilePass", "repo-file-pass.ts#runRetireRead", "repo-file-pass.ts#switchRepoFileOff",
    ].sort());
  });
});

describe("a guarded host", () => {
  it("calls nothing but repositoryIdentity until the id matches, reads the identity once, and refuses everything on a mismatch", async () => {
    const w = passSetup();
    const guarded = guardTarget(w.target);
    expect(guardTarget(guarded)).toBe(guarded);
    await guarded.host.baseBranchHead(guarded.repository, "main", guarded.scope);
    await guarded.host.baseBranchHead(guarded.repository, "main", guarded.scope);
    expect(w.host.calls.filter((c) => c === "repositoryIdentity")).toHaveLength(1);
    expect(w.host.calls.indexOf("repositoryIdentity")).toBeLessThan(w.host.calls.indexOf("baseBranchHead"));
    expect((await verifyRepository(guarded)).ok).toBe(true);
    expect(w.host.calls.filter((c) => c === "repositoryIdentity")).toHaveLength(1);

    const other = new FakeRepoHost();
    other.repoId = "4242";
    const stranger = guardTarget({ ...w.target, host: other as never });
    for (const call of [
      () => stranger.host.baseBranchHead(stranger.repository, "main", stranger.scope),
      () => stranger.host.fileAtRevision(stranger.repository, ".rovara/lessons.md", "a".repeat(40), stranger.scope),
      () => stranger.host.updateChangeRequest({ repository: stranger.repository, id: "1", url: "" }, { state: "closed" }, stranger.scope),
      () => stranger.host.deleteBranch!(stranger.repository, "rovara/lessons-000000000001", stranger.scope),
      () => stranger.host.getChangeRequest({ repository: stranger.repository, id: "1", url: "" }, stranger.scope),
    ]) await expect(call()).rejects.toBeInstanceOf(RepositoryMismatch);
    expect(other.calls.filter((c) => c !== "repositoryIdentity")).toEqual([]);
    expect(other.calls.filter((c) => c === "repositoryIdentity")).toHaveLength(1);
    expect((await verifyRepository(stranger)).ok).toBe(false);
  });

  it("a guarded target is bound to ONE place; pointing it at another throws, it does not keep the first verdict", async () => {
    const w = passSetup();
    const guarded = guardTarget(w.target);
    expect((await verifyRepository(guarded)).ok).toBe(true);
    const moved = { ...guarded, place: "github:repo/9999" };
    expect(() => guardTarget(moved)).toThrow(RepositoryMismatch);
    expect(() => verifyRepository(moved)).toThrow(RepositoryMismatch);
    expect(guardTarget(guarded)).toBe(guarded);
  });

  it("the shared helpers are handed a guarded target and refuse a raw one", async () => {
    const w = passSetup();
    expect(() => headOf(w.target, "main")).toThrow(RepositoryMismatch);
    await expect(readOwnPr(w.target, "1", "rovara/lessons-000000000001")).rejects.toBeInstanceOf(RepositoryMismatch);
    expect(w.host.calls).toEqual([]);
    const guarded = guardTarget(w.target);
    expect(await headOf(guarded, "main")).toBeDefined();
  });

  it("treats a host that will not describe the repository, and a place that pins no id, as a mismatch", async () => {
    const w = passSetup();
    w.host.failCalls.add("repositoryIdentity");
    expect((await verifyRepository(w.target)).ok).toBe(false);
    w.host.failCalls.delete("repositoryIdentity");
    expect((await verifyRepository({ ...w.target, place: "github:somewhere" })).ok).toBe(false);
    expect(repositoryIdOfPlace("github:repo/1001")).toBe("1001");
    expect(repositoryIdOfPlace("github:somewhere")).toBeUndefined();
  });
});
