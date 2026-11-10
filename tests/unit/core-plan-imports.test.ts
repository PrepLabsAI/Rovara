// The plan code in `core/plan` is built on the ports: building a planning prompt, reading an answer or storing a plan must not load a cloud client. The check follows every value import (type
// imports are erased) from each file of the folder and fails on a cloud SDK anywhere in the closure.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const folder = resolve("packages/broker/src/core/plan");

function closureOf(entries: readonly string[]): { files: Set<string>; sdk: string[] } {
  const files = new Set<string>();
  const sdk: string[] = [];
  const walk = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/^(?:import|export)\s+(?!type\b)[^"';]*?from\s+"([^"]+)"/gmu)) {
      const specifier = match[1]!;
      if (specifier.startsWith("@aws-sdk/")) sdk.push(`${file} -> ${specifier}`);
      else if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier.replace(/\.js$/u, ".ts"));
        if (existsSync(target)) walk(target);
      }
    }
  };
  entries.forEach(walk);
  return { files, sdk };
}

describe("core/plan", () => {
  it("pulls in no cloud SDK, however deep its imports go", () => {
    const entries = readdirSync(folder).filter((name) => name.endsWith(".ts")).map((name) => join(folder, name));
    const { files, sdk } = closureOf(entries);
    expect(files.size).toBeGreaterThan(entries.length);
    expect(sdk).toEqual([]);
  });

  it("the moved helpers are still exported where the hosted product reads them", async () => {
    const answers = await import("../../packages/broker/src/developer/owner-answers.js");
    const keys = await import("../../packages/broker/src/developer/plan-evidence-jobs.js");
    const shared = await import("../../packages/broker/src/aws/broker-shared.js");
    expect(typeof answers.ownerAnswersSentence).toBe("function");
    expect(typeof answers.planOwnerAnswers).toBe("function");
    expect(typeof keys.planEvidenceSources).toBe("function");
    expect(typeof keys.planCitesCode).toBe("function");
    expect(typeof shared.planDocumentInstructions).toBe("function");
    expect(typeof shared.planChecksInstructions).toBe("function");
    expect(typeof shared.PLAN_PHASE_LIMITS).toBe("string");
  });
});
