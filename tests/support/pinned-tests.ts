import ts from "typescript";

/**
 * A reviewed change to a pin that history would otherwise refuse (D1-2, DEC 254zzz457: a test goes with its subject). `lowered`: `minimumTests` is the new floor and `from` the floor it
 * replaced. `retired`: the pin is a tombstone: it binds no file and no count, and keeps its last floor (`from`) so history stays readable. Both carry the deciding decision and a reason.
 */
type Reviewed = { kind: "lowered" | "retired"; from: number; decision: string; reason: string };
type Pin = { path: string; minimumTests: number; reason: string; decision: string; "replaced-by"?: string; restoreTarget?: number; reviewed?: Reviewed };
type PendingRestore = Pin & { restoringLane: string; deletedBy: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function testPath(value: unknown): value is string {
  return typeof value === "string" && /^tests\/(?:[\w-]+\/)*[\w-]+\.test\.tsx?$/.test(value);
}

function isReviewed(value: unknown): value is Reviewed {
  return record(value) && (value.kind === "lowered" || value.kind === "retired") && Number.isSafeInteger(value.from) && Number(value.from) >= 1 &&
    typeof value.decision === "string" && /^DEC [0-9a-z]+$/.test(value.decision) && typeof value.reason === "string" && value.reason.trim() !== "";
}

function isPin(value: unknown): value is Pin {
  return record(value) && (value.reviewed === undefined || (isReviewed(value.reviewed) && (value.reviewed.kind === "retired" ? value.minimumTests === value.reviewed.from : Number(value.minimumTests) < value.reviewed.from))) && testPath(value.path) && Number.isSafeInteger(value.minimumTests) && Number(value.minimumTests) >= 1 &&
    typeof value.reason === "string" && value.reason.trim() !== "" && typeof value.decision === "string" && value.decision.trim() !== "" &&
    (value["replaced-by"] === undefined || (testPath(value["replaced-by"]) && value["replaced-by"] !== value.path)) &&
    (value.restoreTarget === undefined || (Number.isSafeInteger(value.restoreTarget) && Number(value.restoreTarget) >= 1));
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
    // A reviewed retirement keeps the floor it had; a reviewed lowering names the floor it replaced, EXACTLY (a free number could excuse any drop). One lowering per change: a second one names the new floor.
    if (next.reviewed?.kind === "retired") return next.reviewed.from === pin.minimumTests ? [] : [`${pin.path}: retired with a floor of ${next.reviewed.from}, not the held ${pin.minimumTests}`];
    if (next.minimumTests < pin.minimumTests) return next.reviewed?.kind === "lowered" && next.reviewed.from === pin.minimumTests ? [] : [`${pin.path}: minimum lowered from ${pin.minimumTests} to ${next.minimumTests}`];
    return [];
  });
  const pendingByPath = new Map(pendingAfter.map((pin) => [pin.path, pin]));
  for (const pin of pendingBefore) {
    const next = byPath.get(pin.path) ?? pendingByPath.get(pin.path);
    if (!next) findings.push(`${pin.path}: pending restore removed; retain it until promoted to active`);
    else if (next.minimumTests < pin.minimumTests) findings.push(`${pin.path}: minimum lowered from ${pin.minimumTests} to ${next.minimumTests}`);
  }
  return findings;
}

/** Read-only git adapter shared by the boundary and shallow-checkout regression tests. */
export function validatePinnedGitHistory(current: unknown, git: (args: string[]) => string): string[] {
  const findings: string[] = [];
  // HEAD catches uncommitted edits; HEAD^1 is CI's merge base, including depth-2 checkouts.
  // Other available parents and the cached target also protect local lanes, without fetching.
  for (const ref of ["HEAD", "HEAD^1", "HEAD^2", "origin/code/next"]) {
    try { git(["rev-parse", "--verify", ref]); }
    catch (error) {
      if (ref !== "HEAD" && (error as { status?: number }).status === 128) continue;
      throw error;
    }
    // A valid ref without a registry is first installation, not permission to discard a row.
    if (git(["ls-tree", "--name-only", ref, "--", "tests/pinned-tests.json"]).trim() === "") continue;
    const prior: unknown = JSON.parse(git(["show", `${ref}:tests/pinned-tests.json`]));
    findings.push(...validatePinnedHistory(current, prior).map((finding) => `${ref}: ${finding}`));
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
    // A retired pin is a tombstone: it binds no file (the file may be gone) and no count.
    if (pin.reviewed?.kind === "retired") {
      if (historical.has(pin.path) || pin["replaced-by"] !== undefined) findings.push(`${pin.path}: duplicate pinned path or replacement`);
      // Only a test file that is gone can be retired: a live file is never unpinned by editing the registry.
      if (readSource(pin.path) !== undefined) findings.push(`${pin.path}: retired, but the test file still exists`);
      historical.add(pin.path);
      continue;
    }
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
    if (pin.restoreTarget !== undefined && count >= pin.restoreTarget && pin.minimumTests < pin.restoreTarget) {
      findings.push(`${target}: restored to ${count} runnable declarations; raise minimumTests to at least ${pin.restoreTarget}`);
    }
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
