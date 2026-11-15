/** Security ratchet: no execution, git history, module resolution, or guessed aliases. */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import type { InventorySource } from "./company-inventory-scan.js";

export const MEMBER_FORWARDER = "packages/broker/src/aws/company-member-forwarding.ts";
const contract = "packages/broker/src/developer/company-member-contract.ts";
const operator = "packages/broker/src/developer/company-operator.ts";
const store = "packages/broker/src/developer/company-membership.ts";
const kinds = new Set(["company-member-revoke", "company-member-role-set", "company-member-list"]);
const fail: () => never = () => { throw new Error("Company member boundary unclassifiable."); };
type Caps = { files: number; bytes: number; nodes: number; sites: number; entries: number; milliseconds: number };
const defaults: Caps = { files: 4_000, bytes: 40_000_000, nodes: 10_000_000, sites: 100_000, entries: 100_000, milliseconds: 10_000 };

function budget(caps: Partial<Caps>) {
  const limits = { ...defaults, ...caps };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 0) fail();
  const used = { files: 0, bytes: 0, nodes: 0, sites: 0, entries: 0 };
  const start = performance.now();
  return (kind?: keyof typeof used, amount = 1): void => {
    if (performance.now() - start >= limits.milliseconds) fail();
    if (kind !== undefined && (used[kind] += amount) > limits[kind]) fail();
  };
}
type Budget = ReturnType<typeof budget>;

/** The loader and AST scanner share ONE budget, including directory entries and wall time. */
function* loadMemberSources(root: string, spend: Budget): Generator<InventorySource> {
  const directories = [join(root, "packages/broker/src")];
  while (directories.length > 0) {
    spend();
    const directory = directories.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      spend("entries");
      if (entry.isSymbolicLink()) fail();
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) {
        spend("files");
        const size = lstatSync(path).size;
        spend("bytes", size);
        const text = readFileSync(path, "utf8");
        if (Buffer.byteLength(text) !== size) fail();
        yield { path: relative(root, path).split("\\").join("/"), text };
      }
    }
  }
}

export function scanMemberBoundary(root: string, caps: Partial<Caps> = {}) {
  const spend = budget(caps);
  try { return analyze(loadMemberSources(root, spend), spend); } catch { return fail(); }
}

export function memberBoundary(sources: readonly InventorySource[], caps: Partial<Caps> = {}) {
  const spend = budget(caps);
  function* inputs() {
    for (const source of sources) {
      spend("files");
      spend("bytes", Buffer.byteLength(source.text));
      yield source;
    }
  }
  try { return analyze(inputs(), spend); } catch { return fail(); }
}

// These exports are schemas, validators and refusal text, NOT kind constants. Any
// new/unknown export (including aliases), namespace, require, or re-export is refused.
// A future kind constant must be reviewed explicitly; it cannot silently acquire
// permission through an import alias or an owner-module filename.
const contractImports = new Set([
  "CompanyMember", "CompanyMemberRefusal", "MemberListInput", "MemberPersonId", "MemberReply", "CompanyMemberReply",
  "MEMBER_LAST_OWNER", "MEMBER_REVOKED", "MEMBER_ONLY_OWNER", "MEMBER_STEP_UP", "memberCursor", "memberCursorPerson",
]);

function checkContractImport(node: ts.StringLiteralLike): void {
  if (!/(?:^|\/)company-member-contract(?:\.[cm]?[jt]s)?$/.test(node.text)) return;
  const parent = node.parent;
  if (!ts.isImportDeclaration(parent) || parent.moduleSpecifier !== node) fail();
  const clause = parent.importClause;
  if (clause === undefined || clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) fail();
  for (const specifier of clause.namedBindings.elements) {
    if (!contractImports.has((specifier.propertyName ?? specifier.name).text)) fail();
  }
}

type StringValue = { text?: string; pieces: readonly (string | undefined)[]; fragment: boolean };
const unknown: StringValue = { pieces: [undefined], fragment: false };
const literal = (text: string): StringValue => ({
  text, pieces: [text],
  // Punctuation alone (e.g. a UUID template's hyphens) is not a member-kind building block.
  fragment: text.length >= 3 && [...kinds].some((kind) => kind.includes(text)),
});

/** Bottom-up, cached string folding: no execution or unbounded alias expansion. */
function stringValue(node: ts.Node, value: (child: ts.Node) => StringValue, spend: Budget): StringValue {
  const combine = (parts: StringValue[]): StringValue => {
    const pieces = parts.flatMap((part) => part.pieces);
    spend("nodes", pieces.length);
    // Concatenation cannot remove known characters. Keep intermediate values
    // bounded even for a huge left-associated expression or nested templates.
    if (pieces.reduce((length, piece) => length + (piece?.length ?? 0), 0) > 64) return literal("<long non-member string>");
    const text = pieces.every((piece) => piece !== undefined) ? pieces.join("") : undefined;
    return text === undefined
      ? { pieces: pieces.filter((piece, index) => piece !== undefined || index === 0 || pieces[index - 1] !== undefined), fragment: parts.some((part) => part.fragment) }
      : literal(text);
  };
  if (ts.isStringLiteralLike(node)) return literal(node.text);
  if (ts.isArrayLiteralExpression(node)) {
    const joined = combine(node.elements.flatMap((element, index) => index === 0 ? [value(element)] : [literal("-"), value(element)]));
    // An inline .join is folded by its parent. Stored/transformed arrays of
    // member-kind pieces are otherwise unclassifiable; never drop their taint.
    const memberPieces = joined.text === undefined ? couldBeMember(joined, spend)
      : joined.text.includes("company-member") && [...kinds].some((kind) => kind.startsWith(joined.text!));
    if (memberPieces) return { pieces: [undefined], fragment: true };
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return value(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return combine([value(node.left), value(node.right)]);
  if (ts.isTemplateExpression(node)) return combine([literal(node.head.text), ...node.templateSpans.flatMap((span) => [value(span.expression), literal(span.literal.text)])]);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "join" && ts.isArrayLiteralExpression(node.expression.expression)) {
    const separator = node.arguments.length === 0 ? literal(",") : node.arguments.length === 1 ? value(node.arguments[0]!) : unknown;
    return combine(node.expression.expression.elements.flatMap((element, index) => index === 0 ? [value(element)] : [separator, value(element)]));
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const receiver = value(node.expression.expression);
    if (receiver.pieces.some((piece) => piece?.includes("company-member"))) return { pieces: [undefined], fragment: true };
  }
  return unknown;
}

function couldBeMember(value: StringValue, spend: Budget): boolean {
  if (!value.fragment) return false;
  // A small finite match, not a regex with backtracking: unknowns can stand for
  // any string. Known parts must still fit a complete member kind in order.
  for (const kind of kinds) {
    let positions = new Set([0]);
    for (const piece of value.pieces) {
      const next = new Set<number>();
      for (const position of positions) {
        spend("nodes");
        if (piece === undefined) for (let end = position; end <= kind.length; end++) next.add(end);
        else if (kind.startsWith(piece, position)) next.add(position + piece.length);
      }
      positions = next;
    }
    if (positions.has(kind.length)) return true;
  }
  return false;
}

function stringContainer(node: ts.Node): boolean {
  if (ts.isArrayLiteralExpression(node)) return ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === "join" && ts.isCallExpression(node.parent.parent);
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)
    || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    || ts.isTemplateExpression(node) || ts.isTemplateSpan(node)
    || (ts.isPropertyAccessExpression(node) && node.name.text === "join")
    || (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "join");
}

function kindRole(node: ts.Node, file: ts.SourceFile): string | undefined {
  // Only exact literal roles are allow-listed. Concatenations/templates/aliases
  // receive no schema/case exception even in an identity-side owner module.
  if (!ts.isStringLiteral(node)) return undefined;
  const parent = node.parent;
  const path = file.fileName;
  if ([contract, operator, MEMBER_FORWARDER].includes(path)) {
    if (ts.isCallExpression(parent) && print(parent.expression, file) === "z.literal" && parent.arguments.length === 1) return "schema";
    if (ts.isCaseClause(parent) && parent.expression === node && path !== MEMBER_FORWARDER) return "case";
  }
  if ([operator, MEMBER_FORWARDER].includes(path) && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && print(parent.left, file) === "input.kind" && parent.right === node) return "comparison";
  if (path === MEMBER_FORWARDER) {
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && print(parent.left, file) === "input.data.kind" && parent.right === node) return "comparison";
    if (ts.isCallExpression(parent) && print(parent.expression, file) === "action" && parent.arguments[1] === node && parent.arguments.length === 2) return "action";
  }
  if (path === store) {
    const argument = ts.isConditionalExpression(parent) ? parent : node;
    const call = argument.parent;
    if (ts.isCallExpression(call) && print(call.expression, file) === "this.writeMember" && call.arguments[2] === argument) return "audit";
  }
  return undefined;
}

const authorityNames = new Set(["Request", "Caller", "CompanyMember", "GetCommand", "membershipKey", "deps", "input", "authenticated", "response", "member", "forwarded", "JSON", "Buffer", "z"]);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const print = (node: ts.Node, file: ts.SourceFile) => printer.printNode(ts.EmitHint.Unspecified, node, file);

/**
 * Pin the authority slice, not tokens or a file digest: bindings, every use/escape
 * of the read/validated row/payload, and their enclosing control flow. Unrelated
 * declarations and comments do not enter these facts. Retaining a safe line while
 * adding a shadow, mutation, alias, spread or alternate invoke changes the facts.
 */
function authorityFact(node: ts.Identifier, file: ts.SourceFile, spend: Budget): { unit: ts.Node; fact: string } {
  let unit: ts.Node = node;
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    spend("nodes");
    if (ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isFunctionLike(parent)) break;
    if (ts.isIfStatement(parent)) break;
    unit = parent;
    if (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isImportDeclaration(parent)
      || ts.isExpressionStatement(parent) || ts.isReturnStatement(parent)) break;
  }
  const context: string[] = [];
  for (let current = unit; current.parent !== undefined; current = current.parent) {
    spend("nodes");
    const parent = current.parent;
    if (ts.isFunctionLike(parent)) {
      context.push(`function:${parent.name === undefined ? "anonymous" : print(parent.name, file)}(${parent.parameters.map((p) => print(p.name, file)).join(",")})`);
    } else if (ts.isIfStatement(parent)) {
      context.push(`if:${print(parent.expression, file)}:${parent.thenStatement === current ? "then" : parent.elseStatement === current ? "else" : "condition"}`);
    } else if (ts.isTryStatement(parent)) {
      context.push(`try:${parent.tryBlock === current ? "body" : parent.catchClause === current ? "catch" : "finally"};catch:${parent.catchClause === undefined ? "none" : print(parent.catchClause, file)};finally:${parent.finallyBlock === undefined ? "none" : print(parent.finallyBlock, file)}`);
    } else if (ts.isConditionalExpression(parent)) {
      context.push(`conditional:${print(parent.condition, file)}:${parent.whenTrue === current ? "true" : parent.whenFalse === current ? "false" : "condition"}`);
    } else if (ts.isIterationStatement(parent, false) || ts.isSwitchStatement(parent) || ts.isCaseClause(parent)) {
      // A new loop/switch around authority is unsupported, not silently ignored.
      fail();
    }
  }
  const fact = `${context.reverse().join(" > ")} | ${ts.SyntaxKind[unit.kind]}: ${print(unit, file)}`;
  spend("bytes", Buffer.byteLength(fact));
  return { unit, fact };
}

function analyze(sources: Iterable<InventorySource>, spend: Budget) {
  const roles: string[] = [];
  let helper: string[] | undefined;
  const paths = new Set<string>();
  for (const source of sources) {
    spend();
    if (paths.has(source.path) || !source.path.startsWith("packages/broker/src/")) fail();
    paths.add(source.path);
    const file = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true);
    spend();
    if ((file as ts.SourceFile & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length) fail();
    const nodes: ts.Node[] = [];
    const pending: ts.Node[] = [file];
    while (pending.length > 0) {
      spend("nodes");
      const node = pending.pop()!;
      nodes.push(node);
      ts.forEachChild(node, (child) => { pending.push(child); });
    }
    const constants = new Map<string, ts.VariableDeclaration[]>();
    for (const node of nodes) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const declarations = constants.get(node.name.text) ?? [];
        declarations.push(node);
        constants.set(node.name.text, declarations);
      }
    }
    const values = new Map<ts.Node, StringValue>();
    const resolving = new Set<ts.Node>();
    const valueOf = (node: ts.Node): StringValue => {
      spend();
      const cached = values.get(node);
      if (cached !== undefined) return cached;
      // No guessed scope/alias binding: only unique immutable local declarations
      // are folded. Whole kind constants and unresolved member prefixes are still
      // rejected at their definition, including mutable/ambiguous declarations.
      if (resolving.has(node) || resolving.size > 256) return unknown;
      resolving.add(node);
      let value: StringValue;
      const declarations = ts.isIdentifier(node) ? constants.get(node.text) : undefined;
      const declaration = declarations?.length === 1 ? declarations[0] : undefined;
      if (declaration?.initializer !== undefined && ts.isVariableDeclarationList(declaration.parent)
        && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) value = valueOf(declaration.initializer);
      else if (declarations !== undefined) {
        // Ambiguous or mutable aliases carry member fragments as unknown, never
        // as a guessed safe value. Only compositions consume this taint below.
        const fragment = declarations.some((entry) => entry.initializer !== undefined && valueOf(entry.initializer).fragment);
        value = { pieces: [undefined], fragment };
      } else value = stringValue(node, valueOf, spend);
      resolving.delete(node);
      values.set(node, value);
      return value;
    };
    const facts = new Map<ts.Node, string>();
    for (const node of nodes.reverse()) {
      spend();
      const value = valueOf(node);
      if (ts.isStringLiteralLike(node)) checkContractImport(node);
      if (source.path === MEMBER_FORWARDER && ts.isIdentifier(node) && authorityNames.has(node.text)) {
        spend("sites");
        const { unit, fact } = authorityFact(node, file, spend);
        facts.set(unit, fact);
      }
      // An identifier by itself may also be a declaration/property name. Its
      // folded value is consumed by enclosing string expressions, not classified
      // as an extra literal site. Definitions of whole kind constants are checked.
      if (ts.isIdentifier(node)) continue;
      // Check a complete expression once. Its leaves remain represented in the
      // folded value. An unresolvable composition containing a kind fragment fails.
      if (!kinds.has(value.text ?? "") && node.parent !== undefined && stringContainer(node.parent)) continue;
      if (value.text !== undefined && kinds.has(value.text)) {
        spend("sites");
        const role = kindRole(node, file);
        if (role === undefined) fail();
        roles.push(`${source.path} | ${value.text} | ${role}`);
      } else if (value.text === undefined ? couldBeMember(value, spend) : value.text.includes("company-member") && [...kinds].some((kind) => kind.startsWith(value.text!))) {
        fail();
      }
    }
    if (source.path === MEMBER_FORWARDER) helper = [...facts.values()];
  }
  spend();
  return { helper, roles: roles.sort() };
}
