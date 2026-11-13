// L4 hardening: ONE module writes a project's design review setting onto its PROJECT_PLAYBOOK item,
// packages/core/src/core/design-review/playbook-store.ts, because it is the one place that validates the setting with the strict schema, holds it to the company's lock, and pins what it read in the condition.
// A raw write anywhere else would skip all three and could store a value the readers can only read as Off. This scan reads every non-test source file of the packages, infra and scripts and fails on any file other
// than the store that BOTH names the playbook item (its entity type or its key builder) AND writes (a Put, Update, transaction or batch). Reading the item and building a ConditionCheck on it are fine.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const THE_WRITER = "packages/core/src/core/design-review/playbook-store.ts";

const NAMES_THE_ITEM = /\bPROJECT_PLAYBOOK\b|\bprojectPlaybookKey\s*\(|PLAYBOOK#/u;
const WRITES = /\b(?:PutCommand|UpdateCommand|BatchWriteCommand|TransactWriteCommand|PutItemCommand|UpdateItemCommand)\b|\bkind\s*:\s*"put"|\.transact\(|\.put\(|\bPut\s*:|\bUpdate\s*:|\bUpdateExpression\b/u;
/** An expression that sets or removes the `designReview` attribute, wherever it is. */
const EXPRESSION_ON_SETTING = /UpdateExpression\s*:\s*(["'`])(?:(?!\1).)*\bdesignReview\b/u;

const EXPRESSION_NAME_OF_SETTING = /["']#\w+["']\s*:\s*["']designReview["']/u;

/** The reasons a file (path and text) breaks the one-writer rule. Pure, so the bypass cases below can prove it. */
function singleWriterProblems(file: string, text: string): string[] {
  if (file === THE_WRITER) return [];
  const problems: string[] = [];
  if (NAMES_THE_ITEM.test(text) && WRITES.test(text)) problems.push("writes an item it names as the project playbook");
  if (EXPRESSION_ON_SETTING.test(text)) problems.push("updates a designReview attribute by expression");
  // An expression attribute NAME that is the setting's own, in a file that writes a playbook item. (`workflow.designReview` on a task record is a path, not a name value, and is not matched.)
  if (NAMES_THE_ITEM.test(text) && WRITES.test(text) && EXPRESSION_NAME_OF_SETTING.test(text)) problems.push("names the designReview attribute in an expression of a file that writes a playbook item");
  return problems;
}

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { if (!["node_modules", "dist", "cdk.out", "coverage", ".git"].includes(entry.name)) sources(relative, found); } else if (/\.(?:ts|tsx|mts|js|mjs)$/u.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name)) found.push(relative);
  }
  return found;
}
const roots = [...readdirSync(path.join(ROOT, "packages")).map((name) => `packages/${name}`), "infra", "scripts"].filter((dir) => { try { readdirSync(path.join(ROOT, dir)); return true; } catch { return false; } });

describe("only the playbook store writes a project's design review setting", () => {
  const files = roots.flatMap((dir) => sources(dir));

  it("scans the source tree, and the scan is live: the store itself is what it would flag", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(THE_WRITER);
    const text = readFileSync(path.join(ROOT, THE_WRITER), "utf8");
    // Positive control: under any other name, the store's own text breaks the rule (it names the item and writes it).
    expect(singleWriterProblems("packages/core/src/elsewhere.ts", text)).toEqual(["writes an item it names as the project playbook"]);
    expect(singleWriterProblems(THE_WRITER, text)).toEqual([]);
  });

  it("no other source file writes a PROJECT_PLAYBOOK item or a designReview attribute", () => {
    const offenders = files.map((file) => ({ file, problems: singleWriterProblems(file, readFileSync(path.join(ROOT, file), "utf8")) })).filter((entry) => entry.problems.length > 0);
    expect(offenders).toEqual([]);
  });

  it.each([
    ["a raw Put of the playbook item", 'await client.send(new PutCommand({ TableName: t, Item: { ...projectPlaybookKey(org, p), entityType: "PROJECT_PLAYBOOK", designReview } }));'],
    ["a transaction Put by entity type", 'TransactItems: [{ Put: { TableName: t, Item: { pk, sk: "META", entityType: "PROJECT_PLAYBOOK", designReview: x } } }]'],
    ["an Update by key", "new UpdateCommand({ Key: projectPlaybookKey(org, p), UpdateExpression: \"SET designReview = :d\" })"],
    ["an update expression on the attribute alone", 'const expression = { UpdateExpression: "SET #x.designReview = :d" };'],
    ["an expression attribute name for the setting beside the playbook key", 'new UpdateCommand({ Key: projectPlaybookKey(org, p), ExpressionAttributeNames: { "#d": "designReview" } });'],
  ])("the scan catches %s", (_name, text) => {
    expect(singleWriterProblems("packages/core/src/somewhere/new-writer.ts", text).length).toBeGreaterThan(0);
  });

  it("does not flag a task record's workflow.designReview, nor the attribute name where no playbook item is named", () => {
    expect(singleWriterProblems("packages/core/src/t.ts", 'new UpdateCommand({ Key: taskKey, UpdateExpression: "SET #w = :w", ExpressionAttributeNames: { "#w": "workflow" }, ConditionExpression: "attribute_exists(workflow.designReview)" })')).toEqual([]);
    expect(singleWriterProblems("packages/core/src/u.ts", 'const names = { "#d": "designReview" }; new UpdateCommand({ Key: taskKey, UpdateExpression: "SET workflow.#d = :v" })')).toEqual([]);
  });

  it("and lets through reading the item and a ConditionCheck on it", () => {
    expect(singleWriterProblems("packages/core/src/x.ts", "const found = await send(new GetCommand({ Key: projectPlaybookKey(org, p) }));")).toEqual([]);
    expect(singleWriterProblems("packages/core/src/y.ts", "return { ConditionCheck: { TableName: t, Key: projectPlaybookKey(org, p), ConditionExpression: '#revision = :r' } };")).toEqual([]);
  });
});
