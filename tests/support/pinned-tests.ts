import ts from "typescript";

type Pin = { path: string; minimumTests: number; reason: string; decision: string; "replaced-by"?: string };
type PendingRestore = Pin & { restoringLane: string; deletedBy: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function testPath(value: unknown): value is string {
  return typeof value === "string" && /^tests\/(?:[\w-]+\/)*[\w-]+\.test\.tsx?$/.test(value);
}

function isPin(value: unknown): value is Pin {
  return record(value) && testPath(value.path) && Number.isSafeInteger(value.minimumTests) && Number(value.minimumTests) >= 1 &&
    typeof value.reason === "string" && value.reason.trim() !== "" && typeof value.decision === "string" && value.decision.trim() !== "" &&
    (value["replaced-by"] === undefined || (testPath(value["replaced-by"]) && value["replaced-by"] !== value.path));
}

function isPendingRestore(value: unknown): value is PendingRestore {
  return record(value) &&
    typeof value.restoringLane === "string" && /^RESTORE-8F1BE0A80 item [123]$/.test(value.restoringLane) &&
    typeof value.deletedBy === "string" && /^[a-f0-9]{7,40}$/.test(value.deletedBy) &&
    isPin(value) && value["replaced-by"] === undefined;
}

function pendingRestores(value: Record<string, unknown>): PendingRestore[] | undefined {
  if (value.pendingRestore === undefined) return [];
  return Array.isArray(value.pendingRestore) && value.pendingRestore.every(isPendingRestore) ? value.pendingRestore : undefined;
}

/** Historical entries remain as tombstones when replaced; their reviewed floors cannot shrink. */
export function validatePinnedHistory(current: unknown, prior: unknown): string[] {
  const pins = (value: unknown): Pin[] | undefined => record(value) && value.version === 1 && Array.isArray(value.tests) && value.tests.length > 0 && value.tests.every(isPin) ? value.tests : undefined;
  const before = pins(prior);
  const after = pins(current);
  const pendingBefore = record(prior) ? pendingRestores(prior) : undefined;
  const pendingAfter = record(current) ? pendingRestores(current) : undefined;
  if (!before || !after || !pendingBefore || !pendingAfter) return ["Invalid pinned test registry history"];
  const byPath = new Map(after.map((pin) => [pin.path, pin]));
  const findings = before.flatMap((pin) => {
    const next = byPath.get(pin.path);
    if (!next) return [`${pin.path}: historical pin removed; retain it with replaced-by when moving`];
    return next.minimumTests < pin.minimumTests ? [`${pin.path}: minimum lowered from ${pin.minimumTests} to ${next.minimumTests}`] : [];
  });
  const pendingByPath = new Map(pendingAfter.map((pin) => [pin.path, pin]));
  for (const pin of pendingBefore) {
    const next = byPath.get(pin.path) ?? pendingByPath.get(pin.path);
    if (!next) findings.push(`${pin.path}: pending restore removed; retain it until promoted to active`);
    else if (next.minimumTests < pin.minimumTests) findings.push(`${pin.path}: minimum lowered from ${pin.minimumTests} to ${next.minimumTests}`);
  }
  return findings;
}

/** Counts declarations, not expanded data rows. No test code is imported or evaluated. */
export function countRunnableTests(source: string, fileName = "pinned.test.ts"): number {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "vitest" || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) names.set(element.name.text, (element.propertyName ?? element.name).text);
      }
    }
  }

  function callKind(expression: ts.Expression): { kind: string; disabled: boolean } | undefined {
    if (ts.isIdentifier(expression)) {
      const kind = names.get(expression.text);
      return kind ? { kind, disabled: false } : undefined;
    }
    if (ts.isCallExpression(expression) || ts.isTaggedTemplateExpression(expression)) return callKind(ts.isCallExpression(expression) ? expression.expression : expression.tag);
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    if (ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)) return { kind: expression.name.text, disabled: false };
    const parent = callKind(expression.expression);
    if (!parent) return undefined;
    return { kind: parent.kind, disabled: parent.disabled || ["skip", "todo", "skipIf", "runIf"].includes(expression.name.text) };
  }

  let count = 0;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const info = callKind(node.expression);
      if (info && ["it", "test", "describe"].includes(info.kind)) {
        // A data-table factory has no title/callback pair; only the outer registration counts.
        const callback = node.arguments[1];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          if (info.disabled) return;
          if (info.kind !== "describe") {
            if (!ts.isBlock(callback.body) || callback.body.statements.some((statement) => !ts.isEmptyStatement(statement))) count++;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return count;
}

/** readSource returns undefined for a missing file; other I/O errors must propagate. */
export function validatePinnedTests(registry: unknown, readSource: (path: string) => string | undefined): string[] {
  if (!record(registry) || registry.version !== 1 || !Array.isArray(registry.tests) || registry.tests.length === 0) return ["Invalid pinned test registry: expected version 1 and nonempty tests"];
  const findings: string[] = [];
  const historical = new Set<string>();
  const effective = new Set<string>();
  for (const [index, value] of (registry.tests as unknown[]).entries()) {
    if (!isPin(value)) {
      findings.push(`Invalid pinned test entry ${index}`);
      continue;
    }
    const pin = value;
    const target = pin["replaced-by"] ?? pin.path;
    if (historical.has(pin.path) || effective.has(target)) findings.push(`${pin.path}: duplicate pinned path or replacement`);
    historical.add(pin.path);
    effective.add(target);
    const source = readSource(target);
    if (source === undefined) {
      findings.push(`${target}: missing pinned test file${pin["replaced-by"] ? ` (replaces ${pin.path})` : ""}`);
      continue;
    }
    const count = countRunnableTests(source, target);
    if (count < pin.minimumTests) findings.push(`${target}: ${count} runnable declarations, minimum ${pin.minimumTests}`);
  }
  const pending = pendingRestores(registry);
  if (!pending) findings.push("Invalid pending restore list");
  else for (const pin of pending) {
    if (historical.has(pin.path) || effective.has(pin.path)) findings.push(`${pin.path}: duplicate pending or active path`);
    historical.add(pin.path);
    if (readSource(pin.path) !== undefined) findings.push(`promote ${pin.path} to active`);
  }
  return findings;
}
