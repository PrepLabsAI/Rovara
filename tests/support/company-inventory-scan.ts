/** Bounded compiler-API inventory. No source is executed and no git history is read. */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";

export const INVENTORY_LIMITS = { files: 4_000, bytes: 40_000_000, items: 100_000, nodes: 10_000_000 } as const;
type Limits = { [K in keyof typeof INVENTORY_LIMITS]: number };
export interface InventorySource { path: string; text: string }
export interface ForwardingSite { site: string; expression: string; reason: string; constructors: string }
export interface CompanyInventory { records: string[]; routes: string[]; gateway: string[]; forwarding: string[] }
export function forwardingCoverage(markdown: string): ForwardingSite[] {
  return markdown.split("\n").filter((line) => line.startsWith("| forwarding |")).map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const [, site, expression, reason, constructors] = cells;
    if (cells.length !== 5 || !site || !expression || !reason || !constructors) fail("invalid row");
    return { site, expression: expression.replaceAll("&#10;", "\n").replaceAll("&#124;", "|").replaceAll("&amp;", "&"), reason, constructors };
  });
}
function fail(reason: string, name?: string): never { throw new Error(`Company inventory ${reason}${name === undefined ? "." : `: ${/^[A-Za-z0-9_#*/{}:+. -]{1,256}$/.test(name) ? name : "unclassifiable"}`}`); }
const loadedBudgets = new WeakMap<readonly InventorySource[], ReturnType<typeof budget>>();
const dispatch = /\/(?:broker|company-member-routes|github-connect-routes|github-account-link-routes|linear-connect-routes|linear-app-webhook|company-engine-model-routes|company-learning-model-routes|developer-routes|developer-tasks|admin-reads|admin-changes|task-web|task-web-api|slack-[^/]+|swebench|connector-metrics|web-session|task-plan-document|feedback-review-web|channel-link-web|lambda)\.ts$/;

function budget(overrides: Partial<Limits> = {}) {
  const limits = { ...INVENTORY_LIMITS, ...overrides };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 0)) fail("limit exceeded");
  const used = { files: 0, bytes: 0, items: 0, nodes: 0 };
  return (kind?: keyof typeof used, count = 1): void => {
    used.nodes++;
    if (kind !== undefined) used[kind] += count;
    if (used.nodes > limits.nodes || used.files > limits.files || used.bytes > limits.bytes || used.items > limits.items) fail("limit exceeded");
  };
}

/** Read each source once, with ONE file/byte/item/node-visit budget for the complete walk. */
export function loadCompanySources(root: string): InventorySource[] {
  const tick = budget();
  const sources: InventorySource[] = [];
  const walk = (directory: string): void => {
    tick();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      tick("items");
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("unclassifiable");
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        tick("files"); tick("bytes", lstatSync(full).size);
        sources.push({ path: relative(root, full).split("\\").join("/"), text: readFileSync(full, "utf8") });
      }
    }
  };
  try {
    walk(join(root, "packages/broker/src"));
    walk(join(root, "packages/aws-adapters/src"));
    walk(join(root, "packages/contracts/src"));
    walk(join(root, "infra/lib"));
  } catch (error) {
    if (error instanceof Error && error.message === "Company inventory limit exceeded.") throw error;
    fail("unclassifiable");
  }
  loadedBudgets.set(sources, tick);
  return sources;
}

/** Expand only the bounded path-regexp grammar used by dispatch. Unsupported syntax refuses the entire scan. */
function regexPaths(literal: string, tick: () => void): string[] {
  const end = literal.lastIndexOf("/");
  let input = literal.slice(1, end).replaceAll("\\/", "/");
  if (!input.startsWith("^/v1/") && !input.startsWith("^/review/")) return [];
  if (!input.endsWith("$")) fail("unclassifiable");
  input = input.slice(1, -1);
  let position = 0;
  const sequence = (): string[] => {
    let values = [""];
    let alternatives: string[] = [];
    while (position < input.length && input[position] !== ")") {
      tick();
      if (input[position] === "|") { alternatives.push(...values); values = [""]; position++; continue; }
      let piece: string[];
      if (input[position] === "(") {
        position++;
        if (input.slice(position, position + 2) === "?:") position += 2;
        piece = sequence();
        if (input[position++] !== ")") fail("unclassifiable");
        if (input[position] === "?") { piece.push(""); position++; }
      } else if (input[position] === "[") {
        const close = input.indexOf("]", position + 1);
        if (close === -1) fail("unclassifiable");
        position = close + 1;
        if (input[position] === "+" || input[position] === "*") position++;
        else if (input[position] === "{") {
          const brace = input.indexOf("}", position);
          if (brace === -1 || !/^\{\d+(,\d+)?\}$/.test(input.slice(position, brace + 1))) fail("unclassifiable");
          position = brace + 1;
        }
        piece = ["{id}"];
      } else {
        const c = input[position++]!;
        if (!/^[A-Za-z0-9_/-]$/.test(c)) fail("unclassifiable");
        piece = [c];
      }
      if (values.length * piece.length > 1_000) fail("limit exceeded");
      values = values.flatMap((prefix) => piece.map((suffix) => prefix + suffix));
    }
    alternatives = [...alternatives, ...values];
    if (alternatives.length > 1_000) fail("limit exceeded");
    return alternatives;
  };
  const paths = sequence();
  if (position !== input.length) fail("unclassifiable");
  return paths.map((path) => path.replace(/\{id\}(?:-?\{id\})+/g, "{id}").replace("/dev/tasks/{id}", "/dev/tasks/{taskId}"));
}

export function scanCompanySources(sources: readonly InventorySource[], limits: Partial<Limits> = {}, forwarding: readonly ForwardingSite[] = []): CompanyInventory {
  const tick = loadedBudgets.get(sources) ?? budget(limits);
  const records = new Set<string>(); const routes = new Set<string>(); const gateway = new Set<string>();
  const covered = new Map<string, ForwardingSite>();
  const usedForwarding = new Set<string>();
  for (const entry of forwarding) {
    tick("items");
    if (covered.has(entry.site) || !entry.reason || !entry.constructors) fail("invalid row");
    covered.set(entry.site, entry);
  }
  const files = new Map<string, ts.SourceFile>();
  for (const source of sources) {
    if (!loadedBudgets.has(sources)) { tick("files"); tick("bytes", Buffer.byteLength(source.text)); }
    tick();
    const file = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true);
    if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length !== 0) fail("unclassifiable");
    if (files.has(source.path)) fail("unclassifiable");
    files.set(source.path, file);
  }
  const host: ts.CompilerHost = {
    getSourceFile: (name) => files.get(name), getDefaultLibFileName: () => "", writeFile: () => undefined,
    getCurrentDirectory: () => "", getDirectories: () => [], fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name)?.text, getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    resolveModuleNames: (names, containing) => names.map((name) => {
      const path = name === "@agentx/contracts" ? "packages/contracts/src/index.ts"
        : name.startsWith(".") ? normalize(join(dirname(containing), name)).replace(/\.js$/, ".ts") : undefined;
      return path !== undefined && files.has(path) ? { resolvedFileName: path } : undefined;
    }),
  };
  const checker = ts.createProgram([...files.keys()], { noLib: true, noResolve: false, target: ts.ScriptTarget.Latest }, host).getTypeChecker();
  // Property aliases are not constants if any source assigns them after construction.
  const written = new Set<ts.Symbol>();
  const writes = (node: ts.Node): void => {
    tick();
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const target = node.left;
      if (ts.isPropertyAccessExpression(target)) {
        const symbol = checker.getSymbolAtLocation(target.name);
        if (symbol !== undefined) written.add(symbol);
      } else if (ts.isElementAccessExpression(target)) {
        const key = checker.getTypeAtLocation(target.argumentExpression);
        const owner = checker.getTypeAtLocation(target.expression);
        const properties = key.isStringLiteral() ? [owner.getProperty(key.value)] : owner.getProperties();
        for (const symbol of properties) { tick(); if (symbol !== undefined) written.add(symbol); }
      }
    }
    ts.forEachChild(node, writes);
  };
  for (const file of files.values()) writes(file);
  const add = (set: Set<string>, value: string): void => { if (!set.has(value)) { tick("items"); set.add(value); } };
  for (const source of sources) {
    const file = files.get(source.path)!;
    // Contract imports are read once for resolution; only key builders belong to the record inventory.
    const keysFile = source.path.startsWith("packages/contracts/src/") && /(?:keys|company-scope)\.ts$/.test(source.path);
    const recordFile = source.path.startsWith("packages/broker/src/") || source.path.startsWith("packages/aws-adapters/src/") || keysFile;
    const routeFile = source.path.startsWith("packages/broker/src/aws/") && dispatch.test(source.path);
    const gatewayFile = source.path.startsWith("infra/lib/");
    const declarationOf = (node: ts.Node): ts.Declaration | undefined => {
      let symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
      if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
      if (symbol !== undefined && written.has(symbol)) return undefined;
      return symbol?.valueDeclaration;
    };
    const immutable = (declaration: ts.VariableDeclaration): boolean => ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
    const unalias = (node: ts.Node, seen = new Set<ts.Node>()): ts.Node => {
      tick();
      if (seen.has(node) || seen.size > 100) fail("unclassifiable");
      seen.add(node);
      if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) return unalias(node.expression, seen);
      if (ts.isIdentifier(node)) {
        const decl = declarationOf(node);
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer) { if (!immutable(decl)) return node; return unalias(decl.initializer, seen); }
      }
      return node;
    };
    const cover = (node: ts.Node, field: string, value: ts.Node): void => {
      const site = `${source.path}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${file.getLineAndCharacterOfPosition(node.getStart()).character + 1}:${field}`;
      const row = covered.get(site);
      if (!row || row.expression !== value.getText(file) || usedForwarding.has(site)) fail("unclassifiable");
      usedForwarding.add(site);
    };
    const literal = (node: ts.Node, seen = new Set<ts.Node>()): string[] | undefined => {
      if (ts.isStringLiteralLike(node)) return [node.text];
      if (ts.isUnionTypeNode(node)) {
        const values = node.types.map((part) => literal(part, new Set(seen)));
        return values.some((part) => part === undefined) ? undefined : values.flat() as string[];
      }
      if (ts.isPropertyAccessExpression(node) && !seen.has(node)) {
        seen.add(node);
        const declaration = declarationOf(node.name);
        if (declaration && ts.isPropertyAssignment(declaration)) return literal(declaration.initializer, seen);
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) { if (!immutable(declaration)) return undefined; return literal(declaration.initializer, seen); }
      }
      if (ts.isLiteralTypeNode(node)) return literal(node.literal, seen);
      if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) return literal(node.expression, seen);
      if (ts.isConditionalExpression(node)) {
        const left = literal(node.whenTrue, new Set(seen)); const right = literal(node.whenFalse, new Set(seen));
        return left === undefined || right === undefined ? undefined : [...left, ...right];
      }
      tick();
      if (seen.size > 100) fail("unclassifiable");
      if (ts.isIdentifier(node) && !seen.has(node)) {
        seen.add(node);
        const declaration = declarationOf(node);
        if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) { if (!immutable(declaration)) return undefined; return literal(declaration.initializer, seen); }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "literal" && node.arguments.length === 1) return literal(node.arguments[0]!, seen);
      return undefined;
    };
    const constructsKey = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
      tick();
      if (seen.has(node) || seen.size > 100) return false;
      const next = new Set(seen); next.add(node);
      if (ts.isIdentifier(node)) {
        const declaration = declarationOf(node);
        return declaration !== undefined && constructsKey(declaration, next);
      }
      if (ts.isVariableDeclaration(node)) return node.initializer !== undefined && constructsKey(node.initializer, next);
      if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) return constructsKey(node.expression, next);
      if (ts.isStringLiteralLike(node)) return node.text.length > 0;
      if (ts.isTemplateExpression(node)) return node.head.text.length > 0 || literal(node.templateSpans[0]!.expression) !== undefined;
      if (ts.isConditionalExpression(node)) return constructsKey(node.whenTrue, next) && constructsKey(node.whenFalse, next);
      if (ts.isCallExpression(node)) return constructsKey(ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression, next);
      if (ts.isPropertyAccessExpression(node) && node.name.text === "pk") return constructsKey(node.expression, next);
      if (ts.isObjectLiteralExpression(node)) {
        const pk = node.properties.find((entry) => ts.isPropertyAssignment(entry) && entry.name.getText() === "pk");
        return pk !== undefined && ts.isPropertyAssignment(pk) && constructsKey(pk.initializer, next);
      }
      if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
        if (!node.body) return false;
        if (!ts.isBlock(node.body)) return constructsKey(node.body, next);
        const returns: ts.Expression[] = [];
        const collect = (child: ts.Node): void => {
          tick();
          if (ts.isReturnStatement(child)) { if (child.expression) returns.push(child.expression); return; }
          if (ts.isFunctionLike(child)) return;
          ts.forEachChild(child, collect);
        };
        collect(node.body);
        return returns.length > 0 && returns.every((entry) => constructsKey(entry, next));
      }
      return false;
    };
    const visit = (node: ts.Node): void => {
      tick();
      if (recordFile && ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const target = node.left;
        const names = ts.isPropertyAccessExpression(target) ? [target.name.text] : ts.isElementAccessExpression(target) ? literal(target.argumentExpression) : [];
        if (names?.some((name) => ["pk", "sk", "entityType"].includes(name))) fail("unclassifiable");
      }
      if (recordFile && (ts.isPropertyAssignment(node) || ts.isPropertySignature(node) || ts.isShorthandPropertyAssignment(node)) && node.name !== undefined) {
        const names = ts.isComputedPropertyName(node.name) ? literal(node.name.expression) : ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? [node.name.text] : [];
        if (names === undefined || names.length > 1) { cover(node, "computed", node.name); }
        const field = names?.[0];
        const value = ts.isPropertyAssignment(node) ? node.initializer : ts.isShorthandPropertyAssignment(node) ? node.name : node.type;
        const assignment = !ts.isPropertySignature(node);
        if (field === "entityType" && value !== undefined) {
          const values = literal(value);
          if (values !== undefined) for (const entry of values) add(records, `entity:${entry}`);
          else if (assignment) cover(node, field, value);
        }
        if ((field === "pk" || field === "sk") && assignment && value) {
          const expr = unalias(value);
          const keyLiteral = (entry: ts.Node): string[] | undefined => {
            if (ts.isTemplateExpression(entry)) {
              if (entry.head.text || field === "sk") return [entry.head.text];
              const first = entry.templateSpans[0]!;
              return literal(first.expression)?.map((prefix) => prefix + first.literal.text);
            }
            if (ts.isConditionalExpression(entry)) {
              const left = keyLiteral(entry.whenTrue); const right = keyLiteral(entry.whenFalse);
              return left && right ? [...left, ...right] : undefined;
            }
            return literal(entry);
          };
          const values = keyLiteral(expr);
          if (values !== undefined) {
            if (field === "pk") for (const entry of values) {
              if (!entry) cover(node, field, value);
              else add(records, `pk:${entry.split("#")[0]!}`);
            }
          } else if (field === "sk" && ts.isObjectLiteralExpression(expr)) {
            // Query predicates are not stored sort keys. Their fields are still traversed below.
            if (!expr.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText() === "op")) cover(node, field, value);
          } else if (ts.isCallExpression(expr) && !["String", "text"].includes(expr.expression.getText())) {
            const declaration = declarationOf(ts.isPropertyAccessExpression(expr.expression) ? expr.expression.name : expr.expression);
            if (declaration && (ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration)) && declaration.name && ts.isIdentifier(declaration.name) && constructsKey(declaration)) {
              if (field === "pk") add(records, `builder:${declaration.getSourceFile().fileName}:${declaration.name.text}`);
            } else cover(node, field, value);
          } else cover(node, field, value);
        }
      }
      if (routeFile) {
        if (ts.isStringLiteralLike(node) && (node.text.startsWith("/v1/") || node.text.startsWith("/review/"))) add(routes, node.text);
        if (ts.isRegularExpressionLiteral(node)) for (const path of regexPaths(node.text, tick)) add(routes, path);
      }
      if (gatewayFile && ts.isStringLiteralLike(node) && /^(?:ANY|GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD) \/.+/.test(node.text)) add(gateway, node.text);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  if (usedForwarding.size !== covered.size) fail("stale forwarding");
  return { records: [...records].sort(), routes: [...routes].sort(), gateway: [...gateway].sort(), forwarding: [...usedForwarding].sort() };
}

export function validateCompanyInventory(inventory: CompanyInventory, markdown: string, checkedRoutes: readonly string[]): void {
  const classes = ["company-scoped", "install-wide", "needs-company"];
  const present = { record: new Set(inventory.records), route: new Set(inventory.routes), gateway: new Set(inventory.gateway) };
  const seen = { record: new Set<string>(), route: new Set<string>(), gateway: new Set<string>() };
  const counts = { record: [0, 0, 0], route: [0, 0, 0] };
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| record |") && !line.startsWith("| route |") && !line.startsWith("| gateway |")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const [kind, identity, classification, table, checked, methods, reason] = cells;
    if ((kind !== "record" && kind !== "route" && kind !== "gateway") || identity === undefined || classification === undefined || !classes.includes(classification) || !["State table", "sign-in table", "other"].includes(table ?? "") || !["yes", "no"].includes(checked ?? "") || methods === undefined || !reason || cells.length !== 7) fail("invalid row");
    const identities = kind === "record" ? identity.split("; ") : [identity];
    for (const entry of identities) {
      if (!present[kind].has(entry)) fail("stale", entry);
      if (seen[kind].has(entry)) fail("invalid row");
      seen[kind].add(entry);
    }
    if (checked === "yes" && (kind !== "route" || !methods.split(", ").some((method) => checkedRoutes.includes(`${method} ${identity}`)))) fail("unchecked", identity);
    const group = counts[kind === "record" ? "record" : "route"];
    const at = classes.indexOf(classification);
    group[at] = group[at]! + 1;
  }
  for (const kind of ["record", "route", "gateway"] as const) for (const identity of present[kind]) if (!seen[kind].has(identity)) fail("missing", identity);
  const count = (values: number[], label: string) => `${values.reduce((sum, n) => sum + n, 0)} ${label}: ${values[0]} company-scoped, ${values[1]} install-wide, ${values[2]} needs-company.`;
  if (markdown.split("\n")[0] !== `${count(counts.record, "record kinds")} ${count(counts.route, "routes")}`) fail("count differs");
}
