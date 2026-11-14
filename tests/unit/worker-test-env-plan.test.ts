// Test environment (wire-testenv): the worker applies the environment's plan to a verification run: test selection by the diff the worker computes itself, the round's budget, and what it reports of the selection.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestEnvTaskPlanSchema, type CandidateRepository, type ProjectCommand, type TestEnvTaskPlan } from "@agentx/contracts";

const changes = vi.hoisted(() => ({ byDirectory: new Map<string, Array<{ path: string; status: "ADDED" | "MODIFIED" | "DELETED" | "UNPLACEABLE"; hunks: never[] }>>(), throwFor: new Set<string>() }));
vi.mock("../../packages/worker/src/verification/diff.js", () => ({
  candidateChanges: vi.fn(async (input: { directory: string }) => {
    if (changes.throwFor.has(input.directory)) throw new Error("git failed");
    return changes.byDirectory.get(input.directory) ?? [];
  }),
}));
const { applyTestEnvironmentPlan } = await import("../../packages/worker/src/verification/test-env-plan.js");
const { collectEvidenceRaw } = await import("../../packages/worker/src/verification/evidence-raw.js");

const cmd = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const BASE = "a".repeat(40), TREE = "b".repeat(40);
const repos = [{ repositoryId: "service", directory: "/work/service", baseCommitSha: BASE }];
const candidate = (...ids: string[]): CandidateRepository[] => ids.map((repositoryId) => ({ repositoryId, commitSha: "c".repeat(40), treeSha: TREE, baseCommitSha: BASE }));
const NOW = new Date("2026-11-02T12:00:00.000Z");
const FRESH = "2026-11-02T08:00:00.000Z";
const map = { builtAt: FRESH, files: { "src/score.py": ["tests/test_score.py::test_a", "tests/test_score.py::test_b"], "src/rank.py": ["tests/test_rank.py::test_c"], "src/util.py": ["tests/test_score.py::test_a", "tests/test_rank.py::test_c", "tests/test_util.py::test_d"],
  "src/misc.py": Array.from({ length: 10 }, (_, index) => `tests/test_misc.py::test_m${String(index)}`) } };
const plan = (over: Partial<TestEnvTaskPlan> = {}): TestEnvTaskPlan => TestEnvTaskPlanSchema.parse({
  revision: 2, digest: "d".repeat(64), roundBudgetMin: 30,
  selection: { method: "coverage_map", alwaysRun: ["lint"], fullSuiteOn: ["poetry.lock"] },
  checks: [{ id: "unit", kind: "test", selectArgs: ["{tests}"] }, { id: "lint", kind: "lint" }],
  coverageMap: map,
  ...over,
});
const readiness = [cmd("pytest", ["-q"]), cmd("ruff", ["check"]), cmd("make", ["extra"])];
const apply = (over: { readiness?: ProjectCommand[]; plan?: TestEnvTaskPlan; repositories?: typeof repos; candidateBefore?: CandidateRepository[] } = {}) =>
  applyTestEnvironmentPlan({ readiness: over.readiness ?? readiness, plan: over.plan ?? plan(), repositories: over.repositories ?? repos, candidateBefore: over.candidateBefore ?? candidate("service"), now: NOW });

beforeEach(() => { changes.byDirectory.clear(); changes.throwFor.clear(); });

describe("test selection for a task", () => {
  it("runs the tests that touch the changed file, adds them only where the maintainer approved, and leaves every other command as it was", async () => {
    changes.byDirectory.set("/work/service", [{ path: "src/score.py", status: "MODIFIED", hunks: [] }]);
    const applied = (await apply())!;
    expect(applied.readiness[0]).toEqual({ ...readiness[0]!, args: ["-q", "tests/test_score.py::test_a", "tests/test_score.py::test_b"] });
    expect(applied.readiness[1]).toEqual(readiness[1]);
    expect(applied.readiness[2]).toEqual(readiness[2]);
    expect(applied.readiness).toHaveLength(readiness.length);
    expect(applied.selection).toMatchObject({ method: "coverage_map", selected: 2, total: 14, mapAgeHours: 4 });
    expect(applied).toMatchObject({ revision: 2, budgetMs: 30 * 60_000 });
    // The approved placeholder never stays in a command.
    expect(applied.readiness.flatMap((command) => command.args)).not.toContain("{tests}");
  });

  it("runs the whole check, with the reason, when there is no map", async () => {
    changes.byDirectory.set("/work/service", [{ path: "src/score.py", status: "MODIFIED", hunks: [] }]);
    const applied = (await apply({ plan: plan({ coverageMap: undefined }) }))!;
    expect(applied.readiness).toEqual(readiness);
    expect(applied.selection).toEqual({ method: "full", selected: 0, total: 0, fallbackReason: "map_missing" });
  });

  it("runs the whole check when the map is stale, a changed file is unknown, or a path changes what every test means", async () => {
    changes.byDirectory.set("/work/service", [{ path: "src/score.py", status: "MODIFIED", hunks: [] }]);
    expect((await apply({ plan: plan({ coverageMap: { ...map, builtAt: "2026-10-01T00:00:00.000Z" } }) }))!.selection?.fallbackReason).toBe("map_stale");
    changes.byDirectory.set("/work/service", [{ path: "src/brand_new.py", status: "ADDED", hunks: [] }]);
    const unknown = (await apply())!;
    expect(unknown.readiness).toEqual(readiness);
    expect(unknown.selection?.fallbackReason).toBe("unknown_file");
    changes.byDirectory.set("/work/service", [{ path: "poetry.lock", status: "MODIFIED", hunks: [] }, { path: "src/score.py", status: "MODIFIED", hunks: [] }]);
    expect((await apply())!.selection?.fallbackReason).toBe("full_suite_on_path");
  });

  it("runs the whole check when the diff cannot be read, or the change spans two repositories", async () => {
    changes.throwFor.add("/work/service");
    const unreadable = (await apply())!;
    expect(unreadable.readiness).toEqual(readiness);
    expect(unreadable.selection).toEqual({ method: "full", selected: 0, total: 0, fallbackReason: "unknown_file" });
    changes.throwFor.clear();
    changes.byDirectory.set("/work/service", [{ path: "src/score.py", status: "MODIFIED", hunks: [] }]);
    changes.byDirectory.set("/work/other", [{ path: "src/score.py", status: "MODIFIED", hunks: [] }]);
    const two = (await apply({ repositories: [...repos, { repositoryId: "other", directory: "/work/other", baseCommitSha: BASE }], candidateBefore: candidate("service", "other") }))!;
    expect(two.readiness).toEqual(readiness);
    expect(two.selection?.fallbackReason).toBe("unknown_file");
    // A start commit or a tree that is not a commit id is not asked of git.
    expect((await apply({ repositories: [{ repositoryId: "service", directory: "/work/service", baseCommitSha: "not-a-sha" }] }))!.selection?.fallbackReason).toBe("unknown_file");
    expect((await apply({ candidateBefore: [] }))!.selection?.fallbackReason).toBe("unknown_file");
  });

  it("a selection that picked no test is the whole check, never 'run nothing'", async () => {
    // Nothing changed at all: an empty selection must not be reported as zero tests while the command runs every test.
    const none = (await apply())!;
    expect(none.readiness).toEqual(readiness);
    expect(none.selection).toEqual({ method: "full", selected: 0, total: 0, fallbackReason: "unknown_file" });
  });

  it("a check that always runs, and a check without a template, run in full and carry no selection", async () => {
    changes.byDirectory.set("/work/service", [{ path: "src/score.py", status: "MODIFIED", hunks: [] }]);
    const noTemplate = (await apply({ plan: plan({ checks: [{ id: "unit", kind: "test" }, { id: "lint", kind: "lint" }] }) }))!;
    expect(noTemplate.readiness).toEqual(readiness);
    expect(noTemplate.selection?.fallbackReason).toBe("no_template");
    const always = (await apply({ plan: plan({ selection: { method: "coverage_map", alwaysRun: ["unit"], fullSuiteOn: [] } }) }))!;
    expect(always.readiness).toEqual(readiness);
    expect(always.selection).toBeUndefined();
  });

  it("always adds the tests that failed in the last nightly", async () => {
    changes.byDirectory.set("/work/service", [{ path: "src/rank.py", status: "MODIFIED", hunks: [] }]);
    const applied = (await apply({ plan: plan({ lastNightlyFailures: ["tests/test_util.py::test_d"] }) }))!;
    expect(applied.readiness[0]!.args).toEqual(["-q", "tests/test_rank.py::test_c", "tests/test_util.py::test_d"]);
  });

  it("never passes a test id that reads as an argument file (@file) or an option, whatever the map says", async () => {
    changes.byDirectory.set("/work/service", [{ path: "src/score.py", status: "MODIFIED", hunks: [] }]);
    for (const id of ["@args.txt", "-x"]) {
      const hostile = { builtAt: FRESH, files: { ...map.files, "src/score.py": [id, "tests/test_score.py::test_a"] } };
      const applied = (await apply({ plan: plan({ coverageMap: hostile }) }))!;
      expect(applied.readiness, id).toEqual(readiness);
      expect(applied.selection?.fallbackReason, id).toBe("over_selected");
    }
  });

  it("is ignored whole when the run has fewer commands than the plan has checks", async () => {
    expect(await apply({ readiness: [cmd("pytest", ["-q"])] })).toBeUndefined();
  });

  it("sets the round's budget from the plan", async () => {
    changes.byDirectory.set("/work/service", [{ path: "src/score.py", status: "MODIFIED", hunks: [] }]);
    expect((await apply({ plan: plan({ roundBudgetMin: 90 }) }))!.budgetMs).toBe(90 * 60_000);
  });
});

describe("what the evidence reports of the selection", () => {
  const DIGEST = "e".repeat(64);
  const JUNIT = `<?xml version="1.0"?><testsuites><testsuite name="pytest" tests="3">
<testcase classname="t" name="test_a" file="tests/test_score.py" time="0.01"/>
<testcase classname="t" name="test_b" file="tests/test_score.py" time="0.01"/>
<testcase classname="t" name="test_c" file="tests/test_rank.py" time="0.01"/>
</testsuite></testsuites>`;
  const passed = { id: "readiness:0", label: "pytest", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 100, exitCode: 0 } as never;
  const raw = async (selection: Parameters<typeof collectEvidenceRaw>[0]["selection"]) => {
    const root = await mkdtemp(join(tmpdir(), "te-plan-"));
    try {
      await writeFile(join(root, "report.xml"), JUNIT);
      return await collectEvidenceRaw({ rootPath: root, commands: [{ ...cmd("pytest", ["--junitxml=report.xml"]), cwd: "." }], entries: [passed], candidateDigest: DIGEST, repositories: [], selection });
    } finally { await rm(root, { recursive: true, force: true }); }
  };

  it("keeps a narrowed selection as it is", async () => {
    expect((await raw({ method: "coverage_map", selected: 3, total: 40, mapAgeHours: 4 }))?.selection).toEqual({ method: "coverage_map", selected: 3, total: 40, mapAgeHours: 4 });
  });

  it("for a fallback keeps only the reason: the counts are what the reports measured, so the file is never inconsistent", async () => {
    expect((await raw({ method: "full", selected: 0, total: 0, fallbackReason: "map_missing" }))?.selection).toEqual({ method: "full", selected: 3, total: 3, fallbackReason: "map_missing" });
  });

  it("with no plan, is the whole check, as before", async () => {
    expect((await raw(undefined))?.selection).toEqual({ method: "full", selected: 3, total: 3 });
  });
});
