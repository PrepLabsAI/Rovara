import { expect, it } from "vitest";
import * as contracts from "@agentx/contracts";
import { log } from "../../packages/broker/src/core/task-flow/support.js";
import { createHarness } from "../support/task-flow-harness.js";
const A = `org_${"a".repeat(20)}`, B = `org_${"b".repeat(20)}`;
it("the helper owns the company field and drops a foreign org field", () => {
  const lines: unknown[] = [];
  contracts.companyLog(A, (line) => lines.push(line))({ event: "test", companyId: B, orgId: B, marker: "mine" });
  expect(lines).toEqual([{ companyId: A, event: "test", marker: "mine" }]);
  expect(Object.keys(lines[0] as object)[0]).toBe("companyId");
});
it("two flows log their own company and canary only", () => {
  for (const [own, other] of [[A, B], [B, A]]) {
    const h = createHarness(); const lines: unknown[] = [];
    h.deps.companyId = own!; h.deps.log = (entry) => { lines.push(entry); };
    log(h.deps, { event: "test", marker: `canary-${own}`, companyId: other, orgId: other });
    expect(lines).toEqual([{ companyId: own, component: "task-flow", event: "test", marker: `canary-${own}` }]);
    expect(JSON.stringify(lines)).not.toContain(other!);
  }
});
it("fails closed: unusable logger company", () => {
  expect(() => contracts.companyLog("bad-canary", () => undefined)).toThrow("invalid company");
});

// One bounded scan, shared by the repository ratchet and its generated-input checks.
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const MAX_FILES = 1600, MAX_BYTES = 20 * 1024 * 1024, MAX_MS = 30_000; // files: 1200 -> 1600 when the batch of 2026-11-16 put 1205 sources under the roots
const roots = ["packages/broker/src", "packages/aws-adapters/src", "packages/local-adapters/src"];
function scan(sources: readonly { path: string; source: string }[], clock = () => performance.now(), began = clock()): Record<string, number> {
  let bytes = 0;
  if (sources.length > MAX_FILES) throw new Error("unclassifiable");
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const { path, source } of sources) {
    bytes += Buffer.byteLength(source);
    if (bytes > MAX_BYTES || clock() - began > MAX_MS) throw new Error("unclassifiable");
    let file: ts.SourceFile;
    try { file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true); } catch { throw new Error("unclassifiable"); }
    if ((file as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length > 0) throw new Error("unclassifiable");
    let count = 0; const stack: ts.Node[] = [file]; let visited = 0;
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (++visited % 1024 === 0 && clock() - began > MAX_MS) throw new Error("unclassifiable");
      if (ts.isIdentifier(node) && node.text === "console") {
        const access = node.parent;
        if (!ts.isPropertyAccessExpression(access) || access.expression !== node) throw new Error("unclassifiable");
        if (["log", "warn", "error"].includes(access.name.text)) {
          let callable: ts.Node = access;
          if (ts.isBinaryExpression(callable.parent) && callable.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && callable.parent.right === callable) callable = callable.parent;
          while (ts.isParenthesizedExpression(callable.parent)) callable = callable.parent;
          if (!ts.isCallExpression(callable.parent) || callable.parent.expression !== callable) throw new Error("unclassifiable");
          count++;
        }
      }
      // A write to the process's own streams is a log line too (`process.stderr.write(...)`, `process.stdout.write(...)`): counted like a console call, so a sink that moved off
      // `console` stays under review. Only the direct call form is accepted; an alias of a stream or of its `write` cannot be classified.
      if (ts.isIdentifier(node) && node.text === "process" && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && ["stderr", "stdout"].includes(node.parent.name.text)) {
        const stream = node.parent;
        const write = stream.parent;
        if (!ts.isPropertyAccessExpression(write) || write.expression !== stream || write.name.text !== "write" || !ts.isCallExpression(write.parent) || write.parent.expression !== write) throw new Error("unclassifiable");
        count++;
      }
      ts.forEachChild(node, (child) => { stack.push(child); });
    }
    if (count > 0) Object.defineProperty(counts, path, { value: count, enumerable: true });
  }
  if (clock() - began > MAX_MS) throw new Error("unclassifiable");
  return counts;
}
function ratchet(counts: Record<string, number>, allowed: Record<string, number>): void {
  for (const [file, count] of Object.entries(counts)) if (count > (Object.hasOwn(allowed, file) ? allowed[file]! : 0)) throw new Error(`Company logging needs review: ${file}`);
}
function sources(began: number): { path: string; source: string }[] {
  const paths: string[] = []; const pending = [...roots]; let bytes = 0;
  while (pending.length > 0) {
    if (performance.now() - began > MAX_MS) throw new Error("unclassifiable");
    const folder = pending.pop()!;
    for (const file of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, file.name);
      if (file.isSymbolicLink()) throw new Error("unclassifiable");
      if (file.isDirectory()) pending.push(path);
      else if (path.endsWith(".ts")) { paths.push(path); bytes += statSync(path).size; }
      if (paths.length > MAX_FILES || bytes > MAX_BYTES || pending.length > MAX_FILES) throw new Error("unclassifiable");
    }
  }
  return paths.sort().map((path) => ({ path, source: readFileSync(path, "utf8") }));
}
it("ratchets every existing console call in the scoped source inventory", () => {
  const allowed = JSON.parse(readFileSync(new URL("../fixtures/company-log-sites.json", import.meta.url), "utf8")) as Record<string, number>;
  const began = performance.now();
  ratchet(scan(sources(began), () => performance.now(), began), allowed);
});
it("refuses an unlisted log call with fixed file words", () => {
  expect(() => ratchet(scan([{ path: "new.ts", source: 'console.log("secret-canary")' }]), {})).toThrow("Company logging needs review: new.ts");
});
it("counts a direct write to stderr or stdout as a log call, and refuses an alias of a stream or of its write", () => {
  expect(scan([{ path: "w.ts", source: 'process.stderr.write("a\\n"); process.stdout.write("b"); console.log("c");' }])).toEqual({ "w.ts": 3 });
  expect(() => ratchet(scan([{ path: "w.ts", source: 'process.stderr.write("secret-canary")' }]), {})).toThrow("Company logging needs review: w.ts");
  for (const source of ['const err = process.stderr; err.write("x")', 'const write = process.stderr.write;', 'process.stderr.on("error", () => undefined)']) expect(() => scan([{ path: "x.ts", source }])).toThrow("unclassifiable");
});
it("unparsable syntax and console aliases fail as unclassifiable", () => {
  for (const source of ['const broken = {', 'const logger = console; logger.log("x")', 'const { log } = console;', 'console["log"]("x")', 'const log = console.log;']) expect(() => scan([{ path: "x.ts", source }])).toThrow("unclassifiable");
});
it("one total byte/file/time budget; a large input remains bounded", () => {
  const source = 'console.log("x");\n'.repeat(20_000);
  const began = performance.now(); expect(scan([{ path: "large.ts", source }])).toEqual({ "large.ts": 20_000 }); expect(performance.now() - began).toBeLessThan(10_000);
  expect(() => scan(Array.from({ length: MAX_FILES + 1 }, () => ({ path: "x.ts", source: "" })))).toThrow("unclassifiable");
  expect(() => scan([{ path: "x.ts", source: " ".repeat(MAX_BYTES / 2 + 1) }, { path: "y.ts", source: " ".repeat(MAX_BYTES / 2 + 1) }])).toThrow("unclassifiable");
  let now = 0; expect(() => scan([{ path: "x.ts", source: "" }], () => { now += MAX_MS + 1; return now; })).toThrow("unclassifiable");
});

it("counts the existing nullish console fallback call without guessing aliases", () => {
  expect(scan([{ path: "fallback.ts", source: '(deps.log ?? console.warn)("x");' }])).toEqual({ "fallback.ts": 1 });
});

it("accepts the stated total file and byte maximum", () => {
  const chunk = Math.floor(MAX_BYTES / MAX_FILES);
  const inputs = Array.from({ length: MAX_FILES }, (_, i) => ({ path: `file-${i}.ts`, source: " ".repeat(i === 0 ? MAX_BYTES - chunk * (MAX_FILES - 1) : chunk) }));
  expect(scan(inputs)).toEqual({});
});
import { runDispatchOnce } from "../../packages/broker/src/core/task-flow/dispatch.js";
it("two real dispatch flows capture only the consumer company and no foreign canary", async () => {
  for (const [own, other] of [[A, B], [B, A]] as const) {
    const h = createHarness(); h.deps.companyId = own; const lines: Record<string, unknown>[] = [];
    h.deps.log = (line) => { lines.push(line); };
    await (await h.queues.queue("task-dispatch")).enqueue({ body: { v: 1, companyId: other, workspaceId: `canary-${other}`, operationId: `canary-${other}` } });
    expect((await runDispatchOnce(h.deps)).foreign).toBe(1);
    expect(lines).toEqual([{ companyId: own, component: "task-flow", event: "task_flow.dispatch_foreign" }]);
    expect(JSON.stringify(lines)).not.toContain(other);
  }
});
