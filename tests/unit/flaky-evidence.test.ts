// TE-C6, the evidence side: the pure facts (`flakyOnChangeOf`, the one fixed line), the asked-for `tests` fields (old files and packs without them still read), the worker's raw writer, the broker's pack builder and the line a
// pull request carries.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EvidenceChecksTestsReadSchema, EvidenceChecksTestsSchema, EvidencePackSchema, EvidenceRawSchema, FLAKY_ON_RERUN_MAX, flakyOnChangeOf, flakyRerunLine,
  type CheckEntry, type EvidenceEnvironment, type ProjectCommand,
} from "../../packages/contracts/src/index.js";
import { buildEvidencePack, type EvidenceBuildInput } from "../../packages/broker/src/core/proof/evidence-pack.js";
import { evidenceLines, flakyLine } from "../../packages/broker/src/core/proof/evidence-lines.js";
import { collectEvidenceRaw } from "../../packages/worker/src/verification/evidence-raw.js";

const DIGEST = "c".repeat(64);
const ID_A = "tests/test_cart.py::test_total";
const ID_B = "tests/test_cart.py::test_tax";

describe("flakyOnChangeOf", () => {
  it.each([
    ["a test the base does not name", [ID_A], [ID_B], [ID_A]],
    ["a test the base already has as flaky is not flaky on this change", [ID_A], [ID_A], []],
    ["a base that is not known counts every test as passed on the base", [ID_A, ID_B], undefined, [ID_A, ID_B]],
    ["an empty base set is a known set with nothing flaky", [ID_A], [], [ID_A]],
    ["each test once, in the order given", [ID_B, ID_A, ID_B], [], [ID_B, ID_A]],
    ["nothing rerun-flaky means nothing on change", [], [ID_A], []],
  ] as const)("%s", (_name, rerun, base, expected) => {
    expect(flakyOnChangeOf(rerun, base as readonly string[] | undefined)).toEqual(expected);
  });

  it("lists at most the evidence's limit", () => {
    const many = Array.from({ length: FLAKY_ON_RERUN_MAX + 10 }, (_, index) => `t.py::t${String(index)}`);
    expect(flakyOnChangeOf(many, [])).toHaveLength(FLAKY_ON_RERUN_MAX);
  });

  it("skips anything that is not a plain test id string", () => {
    expect(flakyOnChangeOf(["", ID_A, 5 as unknown as string], [])).toEqual([ID_A]);
  });
});

describe("the one fixed line", () => {
  it("is a count in fixed words, one test or many, and nothing for none", () => {
    expect(flakyRerunLine(1)).toBe("1 test was flaky (passed on rerun); not counted against this change.");
    expect(flakyRerunLine(2)).toBe("2 tests were flaky (passed on rerun); not counted against this change.");
    expect(flakyRerunLine(1_234)).toBe("1,234 tests were flaky (passed on rerun); not counted against this change.");
    for (const none of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) expect(flakyRerunLine(none), String(none)).toBeUndefined();
  });
});

const tests = (over: Record<string, unknown> = {}) => ({ total: 3, passed: 1, failed: 2, skipped: 0, errored: 0, names: [{ name: ID_A, status: "failed" }, { name: ID_B, status: "failed" }, { name: "t.py::ok", status: "passed" }], newTests: [], ...over });

describe("the asked-for fields of a check's tests part", () => {
  it("are written and read together, never one alone, and never more than the failing tests", () => {
    for (const schema of [EvidenceChecksTestsSchema, EvidenceChecksTestsReadSchema]) {
      expect(schema.safeParse(tests({ flakyOnRerun: [ID_A], flakyOnRerunCount: 1 })).success).toBe(true);
    }
    const raw = (checkTests: unknown) => EvidenceRawSchema.safeParse({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "readiness:0", tests: checkTests }] }).success;
    expect(raw(tests({ flakyOnRerun: [ID_A], flakyOnRerunCount: 1 }))).toBe(true);
    expect(raw(tests({ flakyOnRerun: [ID_A] }))).toBe(false);
    expect(raw(tests({ flakyOnRerunCount: 1 }))).toBe(false);
    expect(raw(tests({ flakyOnRerun: [ID_A, ID_B], flakyOnRerunCount: 1 }))).toBe(false);
    expect(raw(tests({ flakyOnRerun: [ID_A], flakyOnRerunCount: 3 }))).toBe(false);
    expect(raw(tests({ flakyOnRerun: Array.from({ length: FLAKY_ON_RERUN_MAX + 1 }, (_, index) => `t.py::t${String(index)}`), flakyOnRerunCount: 51 }))).toBe(false);
  });

  it("a file or pack written without them reads as it always did", () => {
    expect(EvidenceRawSchema.safeParse({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "readiness:0", tests: tests() }] }).success).toBe(true);
    expect(EvidenceChecksTestsSchema.parse(tests())).not.toHaveProperty("flakyOnRerun");
    expect(EvidenceChecksTestsReadSchema.parse(tests())).not.toHaveProperty("flakyOnRerun");
  });
});

describe("the worker's raw writer", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "flaky-evidence-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const JUNIT = `<?xml version="1.0"?><testsuites><testsuite name="pytest" tests="3">
<testcase classname="tests.test_cart" name="test_total" file="tests/test_cart.py"><failure message="x">x</failure></testcase>
<testcase classname="tests.test_cart" name="test_tax" file="tests/test_cart.py"><failure message="x">x</failure></testcase>
<testcase classname="tests.test_cart" name="test_ok" file="tests/test_cart.py"/></testsuite></testsuites>`;
  const command: ProjectCommand = { executable: "pytest", args: ["--junitxml=report.xml"], cwd: ".", timeoutSeconds: 60 };
  const failed: CheckEntry = { id: "readiness:0", label: "pytest", source: "project", before: "passed", after: "failed", class: "regression", output: "", durationMs: 5, exitCode: 1 };
  const collect = async (flaky?: Map<string, { checkId: string; flaky: string[]; failing: string[] }>) => {
    await writeFile(join(root, "report.xml"), JUNIT);
    return collectEvidenceRaw({ rootPath: root, commands: [command], entries: [failed], candidateDigest: DIGEST, repositories: [], ...(flaky === undefined ? {} : { flaky }) });
  };

  it("names the tests that passed on the rerun, with their count, and the result fits the schema", async () => {
    const raw = await collect(new Map([["readiness:0", { checkId: "readiness:0", flaky: [ID_B], failing: [ID_A] }]]));
    expect(raw?.checks[0]?.tests).toMatchObject({ failed: 2, flakyOnRerun: [ID_B], flakyOnRerunCount: 1 });
    expect(EvidenceRawSchema.safeParse(raw).success).toBe(true);
  });

  it("writes neither key without the rerun's result (the plan did not ask), and ignores a flaky id the report does not show failing", async () => {
    expect((await collect())?.checks[0]?.tests).not.toHaveProperty("flakyOnRerun");
    expect((await collect(new Map()))?.checks[0]?.tests).not.toHaveProperty("flakyOnRerunCount");
    const odd = await collect(new Map([["readiness:0", { checkId: "readiness:0", flaky: ["tests/test_cart.py::test_ok", "tests/test_cart.py::not_there"], failing: [] }]]));
    expect(odd?.checks[0]?.tests).not.toHaveProperty("flakyOnRerun");
  });
});

// ---- the broker's pack and the pull request's line

const environment: EvidenceEnvironment = { tier: "sandbox", envRevision: 3, services: [], data: "synthetic", accounts: [] };
const entry = (over: Partial<CheckEntry> = {}): CheckEntry => ({ id: "readiness:0", label: "pytest -q", source: "project", before: "passed", after: "failed", class: "regression", output: "", durationMs: 900, exitCode: 1, ...over });
const rawFor = (checkTests: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "readiness:0", tests: checkTests }] });
const build = (checkTests: Record<string, unknown>, over: Partial<CheckEntry> = {}) => buildEvidencePack({ candidateDigest: DIGEST, rawText: rawFor(checkTests), checks: [entry(over)], checkKinds: new Map([["readiness:0", "test"]]), environment, storedArtifacts: new Map() } satisfies EvidenceBuildInput);

describe("the pack", () => {
  it("carries the ids that passed on the rerun and their count; the pack still fits its schema", () => {
    const built = build(tests({ flakyOnRerun: [ID_B], flakyOnRerunCount: 1 }));
    expect(built.problems).toEqual([]);
    expect(built.pack?.checks[0]?.tests).toMatchObject({ flakyOnRerun: [ID_B], flakyOnRerunCount: 1 });
    expect(EvidencePackSchema.safeParse(built.pack).success).toBe(true);
    // A reader built for the tolerant view parses the same check, with or without the keys.
    expect(EvidenceChecksTestsReadSchema.safeParse(built.pack?.checks[0]?.tests).success).toBe(true);
  });

  it("drops a flaky claim a check that did not fail, or a report that does not show failing, cannot back, and keeps the tests", () => {
    // More flaky tests than failing ones cannot be true: the raw file itself is refused.
    const impossible = build(tests({ total: 3, passed: 3, failed: 0, names: [{ name: ID_A, status: "passed" }], flakyOnRerun: [ID_A], flakyOnRerunCount: 1 }), { after: "passed", class: "passing", exitCode: 0 });
    expect(impossible.problems).toContain("raw_unreadable");
    // A passing check whose report shows failing tests is a disagreement the pack already refuses whole (the claim cannot survive it).
    const passingCheck = build(tests({ flakyOnRerun: [ID_A], flakyOnRerunCount: 1 }), { after: "passed", class: "passing", exitCode: 0 });
    expect(passingCheck.problems).toContain("tests_disagree_with_check");
    expect(passingCheck.pack?.checks[0]?.tests).toBeUndefined();
    const notFailing = build(tests({ flakyOnRerun: ["t.py::ok"], flakyOnRerunCount: 1 }));
    expect(notFailing.problems).toContain("tests_disagree_with_check");
    expect(notFailing.pack?.checks[0]?.tests).toMatchObject({ total: 3, failed: 2 });
    expect(notFailing.pack?.checks[0]?.tests).not.toHaveProperty("flakyOnRerun");
  });

  it("scans and cleans the ids like every other test name", () => {
    const secret = `ghp_${"Ab1Cd2Ef3Gh4".repeat(3)}`;
    const built = build(tests({ names: [{ name: `t.py::leak ${secret}`, status: "failed" }, { name: ID_B, status: "failed" }], flakyOnRerun: [`t.py::leak ${secret}`], flakyOnRerunCount: 1 }));
    expect(JSON.stringify(built.pack)).not.toContain(secret);
  });
});

describe("the line a pull request carries", () => {
  const withCounts = (...counts: Array<number | undefined>) => ({
    ...build(tests()).pack!, checks: counts.map((count, index) => ({ ...build(tests()).pack!.checks[0]!, checkId: `readiness:${String(index)}`, tests: { ...tests(), names: [], ...(count === undefined ? {} : { flakyOnRerun: [ID_A], flakyOnRerunCount: count }) } })),
  }) as never;

  it("is one fixed line with the count across the checks, and nothing when there were none", () => {
    expect(flakyLine(withCounts(1))).toBe("1 test was flaky (passed on rerun); not counted against this change.");
    expect(flakyLine(withCounts(2, undefined, 1))).toBe("3 tests were flaky (passed on rerun); not counted against this change.");
    expect(flakyLine(withCounts(undefined))).toBeUndefined();
  });

  it("is in the proof section at every shrink level, and never names a test", () => {
    const pack = withCounts(1);
    for (const level of [0, 1, 2, 3, 4]) {
      const { lines } = evidenceLines({ pack, mode: "summary" }, DIGEST, level);
      expect(lines.filter((line) => line.includes("flaky")), String(level)).toEqual(["1 test was flaky (passed on rerun); not counted against this change."]);
      expect(lines.join("\n")).not.toContain("test_total");
    }
  });
});
