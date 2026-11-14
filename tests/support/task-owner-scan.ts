// The scan behind `task-owner-reads.test.ts` (Plan 5 Task 12a, hardened in the 12a review): a TypeScript pass that finds every read of a task's owner fields.
// It is a module of its own so a test can run it on a small program and prove a bypass is caught.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/** The fields of a task that say who the task belongs to or who started it. */
export const OWNER_FIELDS: ReadonlySet<string> = new Set(["developerId", "developerName", "slackUserId", "provider", "ownerKey", "startedBy"]);
/** The fields only the raw `currentOwner` text scan covers; an untyped read of it is a hit too. */
const UNTYPED_FIELDS: ReadonlySet<string> = new Set([...OWNER_FIELDS, "currentOwner"]);
/** Reaching any of these, as a call, in the function is how a read of an owner goes through the one function. */
export const OWNER_FUNCTIONS: ReadonlySet<string> = new Set([
  "effectiveTaskOwner", "tryEffectiveTaskOwner", "ownerActorIdOf", "ownerNameOfActor", "ownerFenceOf", "ownerCallerOf", "ownerIndexRowOf", "ownerSlackUserOf", "ownerDisplayName", "isTaskOwner",
]);

export interface Hit {
  /** `<root prefix><path under the root>`: `developer/task-people.ts`, or `contracts/...` for the contracts package. */
  file: string;
  /** The enclosing functions, outermost first, joined by `>`; a function sharing its name with an earlier one in the file carries `#<n>`. */
  fn: string;
  field: string;
  /** `typed`: on a `DeveloperTaskRecord`. `untyped`: on an item, a record, `any` or `unknown`, where the type cannot say it is a task. `call`: a `taskOwnerKey(` call. */
  kind: "typed" | "untyped" | "call";
  /** The function that holds the read: where a call of an owner function has to be. */
  scope: ts.Node;
  line: number;
}

export interface Root { dir: string; prefix: string }

/** The source the guard covers: the broker's and the contracts package's. */
export const guardedRoots = (packagesDir: string): Root[] => [{ dir: path.join(packagesDir, "broker/src"), prefix: "" }, { dir: path.join(packagesDir, "contracts/src"), prefix: "contracts/" }];

export function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") && !full.endsWith(".d.ts") ? [full] : [];
  });
}

export function programOf(tsconfig: string): ts.Program {
  const config = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); } });
  if (config === undefined) throw new Error(`${tsconfig} can't be read`);
  return ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, noEmit: true, composite: false, incremental: false, declaration: false, declarationMap: false } });
}

const isFunctionLike = (node: ts.Node): node is ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression =>
  ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);

/** The name a function is known by: its declaration's, or the variable or property an arrow is assigned to; undefined for an anonymous callback. */
function declaredName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) return node.name.getText();
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent))) return node.parent.name.getText();
  return undefined;
}

/** The nearest named function holding `node`, as the node a call has to be inside. */
function scopeOf(node: ts.Node): ts.Node | undefined {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (isFunctionLike(current) && declaredName(current) !== undefined) return ts.isVariableDeclaration(current.parent) || ts.isPropertyAssignment(current.parent) ? current.parent : current;
  }
  return undefined;
}

/** The enclosing named functions, outermost first. */
function chainOf(node: ts.Node): string {
  const names: string[] = [];
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (isFunctionLike(current)) {
      const name = declaredName(current);
      if (name !== undefined) names.unshift(name);
    }
  }
  return names.length === 0 ? "<top>" : names.join(">");
}

const isTaskRecordField = (symbol: ts.Symbol | undefined): boolean => (symbol?.declarations ?? []).some((declaration) => ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "DeveloperTaskRecord");

/** Whether the type cannot say what record it is: `any`, `unknown`, or a type with a string index signature (an item, a record). */
function isUntyped(checker: ts.TypeChecker, type: ts.Type): boolean {
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
  if (type.isUnion()) return type.types.some((member) => isUntyped(checker, member));
  return checker.getIndexInfoOfType(type, ts.IndexKind.String) !== undefined;
}

/**
 * Whether an untyped read could be of a task: the receiver is named for one, or it sits in a function that loads a task row (`taskKey(`, a `DEVTASK#` key). A cast
 * (`as unknown as ...`, `as Record<string, unknown>`) hides the type, so this is what the name and the function say.
 */
function looksLikeATask(receiver: ts.Node, scope: ts.Node): boolean {
  return /task|devtask|\bmeta\b/iu.test(receiver.getText()) || /\btaskKey\(|DEVTASK#|\btaskPointerKey\(/u.test(scope.getText());
}

/** Fields whose presence on a structural type says it describes a task (or its workspace): a `{ taskId; developerId }` is a task by shape. */
const TASK_SHAPE_FIELDS: readonly string[] = ["taskId", "workspaceId"];

/**
 * Whether a read of an owner field on something that is not a `DeveloperTaskRecord` is a read of a task by shape: the field is declared (a literal type such as
 * `{ developerId: string }`, an inline parameter type), and the receiver is named for a task or its type carries the task's id or workspace.
 */
function isStructuralTask(checker: ts.TypeChecker, receiver: ts.Node, field: ts.Symbol | undefined): boolean {
  // Declared in an object type that is not the task record: an anonymous literal (`{ developerId: string }`, an inline parameter or cast type), or a named interface or alias
  // (`interface TaskLike { developerId: string }`). Such a type counts only when the receiver is named for a task or the type carries a task's id or workspace (below): a
  // named type for something else has its own meaning and its own rows.
  if (!(field?.declarations ?? []).some((declaration) => ts.isTypeLiteralNode(declaration.parent) || ts.isInterfaceDeclaration(declaration.parent))) return false;
  // `task.startedBy?.developerId` is the continuation of the read of `.startedBy`, which is counted already.
  let inner = receiver;
  while (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
  if (ts.isPropertyAccessExpression(inner) && UNTYPED_FIELDS.has(inner.name.text)) return false;
  const named = ts.isIdentifier(inner) ? inner.text : ts.isPropertyAccessExpression(inner) ? inner.name.text : undefined;
  if (named !== undefined && /task/iu.test(named)) return true;
  const type = checker.getTypeAtLocation(receiver);
  const shapes = type.isUnion() ? type.types : [type];
  return shapes.some((shape) => TASK_SHAPE_FIELDS.some((name) => shape.getProperty(name) !== undefined));
}

/** Whether the receiver is a cast (`(x as unknown as { developerId: string }).developerId`), which hides what `x` is from the type checker. */
function isCast(receiver: ts.Node): boolean {
  let node = receiver;
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

/** Every hit in the files of `roots` (the program's own files that live under one of them). */
export function scanProgram(program: ts.Program, roots: readonly Root[]): Hit[] {
  const checker = program.getTypeChecker();
  const hits: Hit[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const root = roots.find((candidate) => source.fileName.startsWith(`${candidate.dir}${path.sep}`));
    if (root === undefined) continue;
    const file = `${root.prefix}${path.relative(root.dir, source.fileName).split(path.sep).join("/")}`;
    const seen = new Map<string, Set<ts.Node>>();
    /** Two functions of one name in a file are told apart by their order, so a read in the second is not covered by a row for the first. */
    const qualified = (node: ts.Node): string => {
      const chain = chainOf(node);
      const scope = scopeOf(node) ?? source;
      const nodes = seen.get(chain) ?? new Set<ts.Node>();
      seen.set(chain, nodes);
      nodes.add(scope);
      return [...nodes].indexOf(scope) === 0 ? chain : `${chain}#${String([...nodes].indexOf(scope) + 1)}`;
    };
    const add = (node: ts.Node, field: string, kind: Hit["kind"]) => hits.push({ file, fn: qualified(node), field, kind, scope: scopeOf(node) ?? source, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && (OWNER_FIELDS.has(node.name.text) || UNTYPED_FIELDS.has(node.name.text))) {
        if (OWNER_FIELDS.has(node.name.text) && isTaskRecordField(checker.getSymbolAtLocation(node.name))) add(node, `.${node.name.text}`, "typed");
        else if ((isUntyped(checker, checker.getTypeAtLocation(node.expression)) || isCast(node.expression)) && looksLikeATask(node.expression, scopeOf(node) ?? source)) add(node, `.${node.name.text}`, "untyped");
        else if (OWNER_FIELDS.has(node.name.text) && isStructuralTask(checker, node.expression, checker.getSymbolAtLocation(node.name))) add(node, `.${node.name.text}`, "typed");
      } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && UNTYPED_FIELDS.has(node.argumentExpression.text)) {
        const key = node.argumentExpression.text;
        if (OWNER_FIELDS.has(key) && isTaskRecordField(checker.getSymbolAtLocation(node.argumentExpression))) add(node, `.${key}`, "typed");
        else if ((isUntyped(checker, checker.getTypeAtLocation(node.expression)) || isCast(node.expression)) && looksLikeATask(node.expression, scopeOf(node) ?? source)) add(node, `.${key}`, "untyped");
        else if (OWNER_FIELDS.has(key) && isStructuralTask(checker, node.expression, checker.getSymbolAtLocation(node.argumentExpression))) add(node, `.${key}`, "typed");
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const name = node.propertyName ?? node.name;
        if (ts.isIdentifier(name) && UNTYPED_FIELDS.has(name.text)) {
          const type = checker.getTypeAtLocation(node.parent);
          if (OWNER_FIELDS.has(name.text) && isTaskRecordField(type.getProperty(name.text))) add(node, `.${name.text}`, "typed");
          else if (isUntyped(checker, type) && looksLikeATask(node.parent.parent, scopeOf(node) ?? source)) add(node, `.${name.text}`, "untyped");
          else if (OWNER_FIELDS.has(name.text) && isStructuralTask(checker, node.parent, type.getProperty(name.text))) add(node, `.${name.text}`, "typed");
        }
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "taskOwnerKey") add(node, "taskOwnerKey()", "call");
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return hits;
}

/** Whether the node contains an actual call of an owner function: `effectiveTaskOwner(task)` or `x.ownerFenceOf(task)`, never the name in a comment, a string or an unused reference. */
export function callsOwnerFunction(scope: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name !== undefined && OWNER_FUNCTIONS.has(name)) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

export const hitKey = (hit: Pick<Hit, "file" | "fn" | "field">): string => `${hit.file}::${hit.fn}::${hit.field}`;

/**
 * The key of each hit, in the order given: the second read of one field in one function is `<key>@2`, the third `@3`. A row covers exactly the reads it counts, so a new read of a
 * field the function already reads is a read no row covers.
 */
export function keysOf(hits: readonly Pick<Hit, "file" | "fn" | "field">[]): string[] {
  const seen = new Map<string, number>();
  return hits.map((hit) => {
    const base = hitKey(hit);
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    return nth === 1 ? base : `${base}@${String(nth)}`;
  });
}

export type Klass = "authority" | "owner-actor" | "attribution" | "index" | "principal" | "history" | "money" | "caller-actor" | "shape" | "other-record";
/** The classes whose reads decide something about the owner: their function must call an owner function. */
export const NEEDS_THE_FUNCTION: ReadonlySet<Klass> = new Set(["authority", "owner-actor", "attribution", "index"]);
export type Row = readonly [file: string, fn: string, klass: Klass, ...fields: string[]];

/** A row names its fields; `.developerId*2` covers two reads of that field in the function. */
export function rowsOf(table: readonly Row[]): Map<string, Klass> {
  const rows = new Map<string, Klass>();
  for (const [file, fn, klass, ...fields] of table) {
    for (const entry of fields) {
      const counted = /^(.*)\*([0-9]+)$/u.exec(entry);
      const field = counted?.[1] ?? entry;
      for (let nth = 1; nth <= Number(counted?.[2] ?? 1); nth += 1) rows.set(`${file}::${fn}::${field}${nth === 1 ? "" : `@${String(nth)}`}`, klass);
    }
  }
  return rows;
}

/** The reads no row classifies, the rows no read matches, and the reads that carry authority in a function that never calls an owner function. */
export function problemsOf(hits: readonly Hit[], rows: ReadonlyMap<string, Klass>): { unclassified: string[]; stale: string[]; notRouted: string[] } {
  const keys = keysOf(hits);
  const found = new Set(keys);
  const notRouted = new Set<string>();
  for (const [index, hit] of hits.entries()) {
    const klass = rows.get(keys[index]!);
    if (klass === undefined || !NEEDS_THE_FUNCTION.has(klass) || callsOwnerFunction(hit.scope)) continue;
    notRouted.add(`${hit.file}::${hit.fn} (${klass}, line ${String(hit.line)})`);
  }
  return { unclassified: [...found].filter((key) => !rows.has(key)).sort(), stale: [...rows.keys()].filter((key) => !found.has(key)).sort(), notRouted: [...notRouted].sort() };
}
