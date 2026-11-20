import "./prompt-change-offline.js";
import { expect, it } from "vitest";
import { detectPromptChanges } from "../../packages/contracts/src/prompt-change-detect.js";
import { PROMPT_CHANGE_BASES, PROMPT_CHANGE_KINDS, PROMPT_CHANGE_VERBS, PromptChangeReportSchema } from "../../packages/contracts/src/prompt-change.js";
const report = () => detectPromptChanges({ files: [{ path: "ai/a.ts", before: "", after: "temperature: 0.2", wholeFile: true }] }).report;
it("strict schema checks every enum, finite values and kind-specific echo fields", () => {
  const value = report();
  for (const [key, bad] of [["kind", "bogus"], ["verb", "bogus"], ["basis", "bogus"], ["family", "bogus"], ["settingKey", "bogus"], ["after", Infinity], ["after", NaN], ["after", "untrusted"], ["line", -1], ["fingerprintAfter", "bad"]]) {
    expect(PromptChangeReportSchema.safeParse({ ...value, items: [{ ...value.items[0], [key as string]: bad }] }).success).toBe(false);
  }
  for (const key of ["status", "coverage", "schemaVersion"]) expect(PromptChangeReportSchema.safeParse({ ...value, [key]: "bogus" }).success).toBe(false);
  expect(PromptChangeReportSchema.safeParse({ ...value, incompleteReasons: ["bogus"] }).success).toBe(false);
  expect(PromptChangeReportSchema.safeParse({ ...value, items: [{ ...value.items[0], kind: "prompt_text" }] }).success).toBe(false);
  expect(PromptChangeReportSchema.safeParse({ ...value, status: "none_found", coverage: "partial" }).success).toBe(false);
  expect(PROMPT_CHANGE_KINDS).toHaveLength(11); expect(PROMPT_CHANGE_VERBS).toHaveLength(4); expect(PROMPT_CHANGE_BASES).toHaveLength(5);
});
