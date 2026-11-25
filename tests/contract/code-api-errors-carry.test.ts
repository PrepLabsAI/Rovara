// F3 cut 1: the error file moved from packages/contracts/src/errors.ts to packages/code-api/src/errors.ts. A branch that was cut before the move and merges after it can add a code, a message or a status to the
// OLD file, and a text merge then quietly keeps the one-line re-export and drops the addition. This reads the old file as it is on the base branch (CODE_API_CARRY_BASE, default origin/code/next), runs it,
// and requires the package to carry everything in it: every code in the same order, every status, every exported message (value or behaviour) and the error classes. It is a transition guard: when the base
// already holds the re-export (after this move lands) or the ref cannot be read (a shallow checkout), there is nothing to compare and the test skips; tests/contract/code-api-errors.test.ts is the permanent pin.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { z } from "zod";
import * as codeApi from "@preplabsai/rovara-code-api/errors";

const BASE = process.env.CODE_API_CARRY_BASE ?? "origin/code/next";
const OLD_FILE = "packages/contracts/src/errors.ts";

function baseSource(): string | undefined {
  try {
    const source = execFileSync("git", ["show", `${BASE}:${OLD_FILE}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 });
    return source.includes("export const AgentXErrorCodeSchema") ? source : undefined;
  } catch {
    return undefined;
  }
}

/** Run the old file (it imports only zod) and return its exports. */
function load(source: string): Record<string, unknown> {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports: Record<string, unknown> = {};
  const require = createRequire(import.meta.url);
  const run = runInNewContext(`(function (exports, require) {${outputText}\n})`) as (target: Record<string, unknown>, load: (name: string) => unknown) => void;
  run(exports, (name: string) => (name === "zod" ? { z } : require(name)));
  return exports;
}

const source = baseSource();

describe.skipIf(source === undefined)(`the Code API error file carries everything the old contracts file has on ${BASE}`, () => {
  const old = load(source ?? "") as typeof codeApi;

  it("drops no code, keeps their order, and changes no status", () => {
    const codes = old.AgentXErrorCodeSchema.options;
    const kept = codeApi.AgentXErrorCodeSchema.options;
    const dropped = codes.filter((code) => !kept.includes(code));
    expect(dropped).toEqual([]);
    expect(kept.slice(0, codes.length)).toEqual(codes);
    const changed = codes.filter((code) => codeApi.errorStatus(code) !== old.errorStatus(code)).map((code) => [code, old.errorStatus(code), codeApi.errorStatus(code)]);
    expect(changed).toEqual([]);
    expect(codeApi.errorStatus("NOT_A_CODE" as never)).toBe(old.errorStatus("NOT_A_CODE" as never));
  });

  it("drops no export, and every message keeps its words", () => {
    const missing = Object.keys(old).filter((name) => !(name in codeApi));
    expect(missing).toEqual([]);
    for (const [name, value] of Object.entries(old)) {
      const now = (codeApi as Record<string, unknown>)[name];
      if (typeof value === "string" || Array.isArray(value)) expect(now, name).toEqual(value);
      else if (typeof value === "function" && name !== "AgentXError" && name !== "agentXError" && name !== "errorStatus") {
        expect((now as (...args: unknown[]) => unknown)("a", 1, 2, 3, "c"), name).toEqual((value as (...args: unknown[]) => unknown)("a", 1, 2, 3, "c"));
      }
    }
  });

  it("builds the same error for every code, with the same detail", () => {
    for (const code of old.AgentXErrorCodeSchema.options) {
      for (const detail of [undefined, { reason: "stale", writes: "none" }] as const) {
        const before = old.agentXError(code, "x", detail);
        const now = codeApi.agentXError(code, "x", detail);
        expect([now.name, now.code, now.statusCode, now.message, now.detail]).toEqual([before.name, before.code, before.statusCode, before.message, before.detail]);
      }
    }
  });
});
