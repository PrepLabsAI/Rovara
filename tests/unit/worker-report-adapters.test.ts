import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EvidenceChecksTestsSchema, EvidenceChecksTestsReadSchema } from "../../packages/contracts/src/evidence.js";
import { evidenceTests, parseTestReport } from "../../packages/worker/src/verification/test-report.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/report-adapters/${name}`, import.meta.url), "utf8");

describe("TE-IF4 adapter fixtures", () => {
  it.each([
    ["junit.xml", "junit"], ["jest.json", "json"], ["go.jsonl", "gotest"], ["trx.xml", "trx"], ["ctrf.json", "ctrf"],
  ])("reads %s and emits existing evidence counts", (file, format) => {
    const report = parseTestReport(fixture(file));
    expect(report).toMatchObject({ format, total: 4, passed: 1, failed: 1, skipped: 1, errored: 1 });
    const part = evidenceTests(report!);
    expect(EvidenceChecksTestsSchema.safeParse(part).success).toBe(true);
    expect(EvidenceChecksTestsReadSchema.parse(part)).toEqual(part);
  });

  it("keeps a JSON string containing XML out of the XML parser", () => {
    expect(parseTestReport(JSON.stringify({ results: { tests: [] }, message: '<testsuite><testcase name="fake"/></testsuite>' }))).toBeUndefined();
  });
});

// Golden output captured from the pinned TE-B3 writer before refactoring.
it.each(["junit.xml", "jest.json", "go.jsonl"])("preserves the old %s output byte for byte", (file) => {
  expect(JSON.stringify(parseTestReport(fixture(file)), null, 2) + "\n").toBe(fixture(`${file}.expected.json`));
});
