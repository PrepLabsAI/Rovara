import * as ts from "typescript";

const MAX_SOURCE_FILE_BYTES = 512 * 1024;

export type E2EPortableExportKind = "callable" | "data" | "unresolved";
export type E2EPortableSourceInspection = Readonly<{ parseable: boolean; exports: readonly Readonly<{ name: string; kind: E2EPortableExportKind }>[] }>;

function scriptKindFor(ext: string): ts.ScriptKind | undefined {
  if (ext === "tsx") return ts.ScriptKind.TSX;
  if (ext === "jsx") return ts.ScriptKind.JSX;
  if (ext === "js" || ext === "mjs" || ext === "cjs") return ts.ScriptKind.JS;
  if (ext === "ts") return ts.ScriptKind.TS;
  return undefined;
}

function collectTopLevelBindings(file: ts.SourceFile): { declarations: Map<string, ts.Expression>; directCallable: Set<string> } {
  const declarations = new Map<string, ts.Expression>();
  const directCallable = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) directCallable.add(statement.name.text);
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) declarations.set(declaration.name.text, declaration.initializer);
    }
  }
  return { declarations, directCallable };
}

function resolveExpressionKind(
  expression: ts.Expression,
  declarations: ReadonlyMap<string, ts.Expression>,
  directCallable: ReadonlySet<string>,
  visited = new Set<string>(),
  budget = { steps: 0 },
): E2EPortableExportKind {
  if (++budget.steps > 128) return "unresolved";
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return "callable";
  if (ts.isClassExpression(expression)) return "data";
  if (!ts.isIdentifier(expression)) return "data";
  const name = expression.text;
  if (directCallable.has(name)) return "callable";
  if (visited.has(name)) return "unresolved";
  const value = declarations.get(name);
  if (!value) return "unresolved";
  const next = new Set(visited);
  next.add(name);
  return resolveExpressionKind(value, declarations, directCallable, next, budget);
}

function recordNamedExports(
  statement: ts.ExportDeclaration,
  declarations: ReadonlyMap<string, ts.Expression>,
  directCallable: ReadonlySet<string>,
  output: Map<string, E2EPortableExportKind>,
): void {
  if (statement.isTypeOnly || statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) return;
  for (const element of statement.exportClause.elements) {
    if (element.isTypeOnly) continue;
    const name = element.name.text;
    const localName = element.propertyName?.text ?? name;
    const value = declarations.get(localName);
    const kind: E2EPortableExportKind = directCallable.has(localName)
      ? "callable"
      : value
        ? resolveExpressionKind(value, declarations, directCallable, new Set([localName]))
        : "unresolved";
    output.set(name, kind);
  }
}

function recordVariableExports(
  statement: ts.VariableStatement,
  isDefault: boolean,
  declarations: ReadonlyMap<string, ts.Expression>,
  directCallable: ReadonlySet<string>,
  output: Map<string, E2EPortableExportKind>,
): void {
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const exportName = isDefault ? "default" : declaration.name.text;
    output.set(exportName, resolveExpressionKind(declaration.initializer, declarations, directCallable, new Set([declaration.name.text])));
  }
}

function recordModifiedExport(
  statement: ts.Statement,
  declarations: ReadonlyMap<string, ts.Expression>,
  directCallable: ReadonlySet<string>,
  output: Map<string, E2EPortableExportKind>,
): void {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
  if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return;
  const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  if (ts.isFunctionDeclaration(statement) && statement.body && (statement.name || isDefault)) {
    output.set(isDefault ? "default" : statement.name!.text, "callable");
  } else if (ts.isClassDeclaration(statement)) {
    output.set(isDefault ? "default" : statement.name?.text ?? "default", "data");
  } else if (ts.isVariableStatement(statement)) {
    recordVariableExports(statement, isDefault, declarations, directCallable, output);
  }
}

/** Bounded AST-only capability classification; it never loads or evaluates candidate code. */
export function inspectE2EPortableSource(source: string, path: string): E2EPortableSourceInspection {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_FILE_BYTES) return { parseable: false, exports: [] };
  const kind = scriptKindFor(path.slice(path.lastIndexOf(".") + 1).toLowerCase());
  if (kind === undefined) return { parseable: false, exports: [] };
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0) return { parseable: false, exports: [] };
  const { declarations, directCallable } = collectTopLevelBindings(file);
  const output = new Map<string, E2EPortableExportKind>();
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) output.set("default", resolveExpressionKind(statement.expression, declarations, directCallable));
    } else if (ts.isExportDeclaration(statement)) {
      recordNamedExports(statement, declarations, directCallable, output);
    } else {
      recordModifiedExport(statement, declarations, directCallable, output);
    }
  }
  return { parseable: true, exports: [...output].map(([name, value]) => ({ name, kind: value })).sort((a, b) => a.name.localeCompare(b.name)) };
}
