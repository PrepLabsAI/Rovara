// Every DynamoDB expression the broker writes as a plain string names a reserved word (`error`, `status`, `state`, `result`, `name`, ...) only through an #alias. The real service refuses the others
// with a ValidationException, and the in-memory fakes did not (until the validating client): `dispatcher.ts`'s project setup `markFailed` set `error = :error` and would have failed on first use.
// This reads the source, so an expression the tests never run is checked too.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { assertNoReservedWords } from "../support/validating-document-client.js";

const FIELDS = new Set(["UpdateExpression", "ConditionExpression", "KeyConditionExpression", "FilterExpression", "ProjectionExpression"]);

function sources(folder: string, found: string[] = []): string[] {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

/** Each expression written as a literal (a string or a template with no substitution), as `file:line: text`. */
export function literalExpressions(path: string, text = readFileSync(path, "utf8")): Array<{ where: string; expression: string }> {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found: Array<{ where: string; expression: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && FIELDS.has(node.name.getText(file)) && (ts.isStringLiteralLike(node.initializer))) {
      found.push({ where: `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`, expression: node.initializer.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const unaliased = (items: Array<{ where: string; expression: string }>): string[] => items.filter(({ expression }) => {
  try { assertNoReservedWords(expression); return false; } catch { return true; }
}).map(({ where, expression }) => `${where}: ${expression}`);

describe("DynamoDB expressions name reserved words through aliases", () => {
  it("dispatcher.ts: every literal expression, including the project setup lifecycle's two markFailed writes", () => {
    const expressions = literalExpressions("packages/broker/src/aws/dispatcher.ts");
    expect(expressions.length).toBeGreaterThan(10);
    expect(unaliased(expressions)).toEqual([]);
    // The two that were wrong: the setup execution's `error`.
    const failed = expressions.filter(({ expression }) => expression.startsWith("SET #state = :failed"));
    expect(failed.length).toBe(2);
    for (const { expression } of failed) expect(expression).toContain("#error = :error");
  });

  it("everything under packages/*/src", () => {
    const all = ["broker", "aws-adapters", "worker", "contracts", "code-api", "orchestrator", "gateway", "slack-service", "verifier", "mcp", "cli", "model-runtime"].flatMap((name) => sources(`packages/${name}/src`)).flatMap((path) => literalExpressions(path));
    expect(all.length).toBeGreaterThan(200);
    expect(unaliased(all)).toEqual([]);
  });

  it("recognises the mistake it exists for (the check is not vacuous)", () => {
    expect(unaliased(literalExpressions("x.ts", 'const a = { UpdateExpression: "SET #state = :failed, updatedAt = :now, error = :error" };'))).toHaveLength(1);
    expect(unaliased(literalExpressions("x.ts", 'const a = { ConditionExpression: "status = :s" };'))).toHaveLength(1);
    expect(unaliased(literalExpressions("x.ts", 'const a = { UpdateExpression: "SET #status = :s, #result = :r, #error = :e, #state = :t" };'))).toEqual([]);
  });
});
