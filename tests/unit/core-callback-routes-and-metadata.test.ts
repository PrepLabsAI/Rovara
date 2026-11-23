// Two boundaries that a lenient fake hid. (1) A worker callback's action name must match the core's route patterns: `e2e-admission` and `e2e-evidence` have a digit, and patterns that allowed only
// letters and hyphens sent those callbacks to the old routes (404), so no browser round could ever read its admission. (2) Every object metadata name the broker's code writes must be valid for the
// REAL S3 adapter (lower-case letters, digits and . _ -): the in-memory stores accept anything, and a camelCase name made the evidence upload a 500 on the hosted install.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { S3ObjectStorage } from "../../packages/aws-adapters/src/s3/index.js";
import { CORE_CALLBACK } from "../../packages/broker/src/aws/core-engine-root.js";
import { ROUTE, SERVED_ACTIONS } from "../../packages/broker/src/services/callbacks.js";

const BROKER_SRC = join(import.meta.dirname, "../../packages/broker/src");

/** Every action name a worker can post: the core's served set, the worker-facing union type, and the alternation of the old broker's route. */
function callbackNames(): string[] {
  const union = /export type CallbackAction =([^;]+);/u.exec(readFileSync(join(BROKER_SRC, "callbacks.ts"), "utf8"))?.[1] ?? "";
  const fromUnion = [...union.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
  const legacy = /operations\/\(\[0-9a-f-\]\+\)\/\(([^)]+)\)\$/u.exec(readFileSync(join(BROKER_SRC, "aws/broker.ts"), "utf8").split("\n").find((line) => line.includes("const callback = /^\\/v1\\/internal\\/workspaces")) ?? "")?.[1] ?? "";
  return [...new Set([...SERVED_ACTIONS, ...fromUnion, ...legacy.split("|")])].filter((name) => name !== "");
}

describe("the core's callback routes", () => {
  const workspace = randomUUID();
  const operation = randomUUID();
  const pathOf = (name: string) => `/v1/internal/workspaces/${workspace}/operations/${operation}/${name}`;

  it("knows the names (a digit among them), so the checks below are not empty", () => {
    const names = callbackNames();
    expect(names.length).toBeGreaterThan(20);
    expect(names).toEqual(expect.arrayContaining(["events", "result", "e2e-admission", "e2e-evidence"]));
  });
  it("every callback name matches the core root's route pattern", () => {
    expect(callbackNames().filter((name) => !CORE_CALLBACK.test(pathOf(name)))).toEqual([]);
    expect(CORE_CALLBACK.exec(pathOf("e2e-admission"))?.[1]).toBe(workspace);
  });
  it("every callback name matches the callback service's route pattern, and names the action", () => {
    expect(callbackNames().filter((name) => ROUTE.exec(pathOf(name))?.[3] !== name)).toEqual([]);
  });
  it("still refuses a name that is not lower-case letters, digits and hyphens", () => {
    for (const bad of ["Events", "e2e_admission", "e2e admission", "../result", ""]) {
      expect(CORE_CALLBACK.test(pathOf(bad)), bad).toBe(false);
      expect(ROUTE.test(pathOf(bad)), bad).toBe(false);
    }
  });
});

/** The metadata names written by every `metadata: { ... }` literal under the broker's source: the keys of the object, at its top level. */
function metadataNamesWritten(): Array<{ file: string; name: string }> {
  const found: Array<{ file: string; name: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!path.endsWith(".ts")) continue;
      const text = readFileSync(path, "utf8");
      for (const hit of text.matchAll(/\bmetadata: \{/gu)) {
        let depth = 1;
        let index = hit.index + hit[0].length;
        let top = "";
        for (; index < text.length && depth > 0; index += 1) {
          const character = text[index]!;
          if (character === "{" || character === "(" || character === "[") depth += 1;
          else if (character === "}" || character === ")" || character === "]") depth -= 1;
          if (depth === 1 && character !== "}") top += character;
        }
        // Split the top level at commas that are not inside a nested bracket or a string.
        for (const part of splitTopLevel(top)) {
          const key = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*(?::|$)/u.exec(part);
          if (key !== null) found.push({ file: path.slice(BROKER_SRC.length + 1), name: key[1] ?? key[2] ?? key[3]! });
        }
      }
    }
  };
  walk(BROKER_SRC);
  return found;
}
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const character of text) {
    if (quote !== undefined) { current += character; if (character === quote) quote = undefined; continue; }
    if (character === '"' || character === "'" || character === "`") { quote = character; current += character; continue; }
    if (character === ",") { parts.push(current); current = ""; continue; }
    current += character;
  }
  parts.push(current);
  return parts;
}

describe("the object metadata the broker writes, on the real S3 adapter's rules", () => {
  const s3 = new S3ObjectStorage({ client: { send: async () => ({}) }, bucket: "artifacts" });
  const accepted = async (name: string) => s3.put("key", new Uint8Array([1]), { contentType: "application/json", metadata: { [name]: "x" }, retention: "task-document" }).then(() => true, () => false);

  it("finds the writes (the evidence uploads among them), so the check is not empty", () => {
    const written = metadataNamesWritten();
    expect(written.length).toBeGreaterThan(10);
    expect(written).toEqual(expect.arrayContaining([{ file: "core/e2e/callbacks.ts", name: "sha256" }, { file: "core/e2e/callbacks.ts", name: "group-run-id" }]));
  });
  it("every metadata name written passes the S3 adapter's own validation", async () => {
    const refused: string[] = [];
    for (const { file, name } of metadataNamesWritten()) if (!(await accepted(name))) refused.push(`${file}: ${name}`);
    expect(refused).toEqual([]);
  });
  it("the adapter refuses what the scan is looking for (camelCase, underscore-leading, spaces)", async () => {
    for (const bad of ["groupRunId", "_x", "a b", "Task"]) expect(await accepted(bad), bad).toBe(false);
  });
});
