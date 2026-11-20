// TE-MR2b: test selection across repositories (the pure planner). Safety first: a skipped test that should have run is a FAIL, so every unknown is the whole check, and an edge is never dropped because the candidate no longer shows it.
import { describe, expect, it } from "vitest";
import { type ProjectCommand, type RepositoryCoverageMap } from "@agentx/contracts";
import { planRepositorySelections, type RepositorySelectionInput } from "../../packages/worker/src/verification/multi-repo-selection.js";
import type { ChangedPath } from "../../packages/worker/src/verification/selection.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const FRESH = "2026-11-02T08:00:00.000Z";
const command = (cwd: string): ProjectCommand => ({ cwd, executable: "pytest", args: ["-q"], timeoutSeconds: 600 });
const config = { method: "coverage_map" as const, alwaysRun: ["lint"], fullSuiteOn: ["poetry.lock"] };
const tests = (repositoryId: string, count: number, prefix = "t") => Array.from({ length: count }, (_, i) => ({ repositoryId, id: `tests/test_${prefix}${String(i)}.py::test_x` }));
const entry = (repositoryId: string, path: string, list: Array<{ repositoryId: string; id: string }>) => ({ repositoryId, path, tests: list });
const modified = (path: string): ChangedPath => ({ path, status: "modified" });
const checks = [
  { id: "svc-unit", kind: "test" as const, repositoryId: "service", command: command("service"), selectArgs: ["{tests}"] },
  { id: "lib-unit", kind: "test" as const, repositoryId: "lib", command: command("lib"), selectArgs: ["{tests}"] },
  { id: "lint", kind: "lint" as const, repositoryId: "service", command: { ...command("service"), executable: "ruff" }, selectArgs: undefined },
];
// service has 12 tests, lib has 12 tests. lib's source is touched by 2 of service's tests and 1 of lib's.
const map = (over: RepositoryCoverageMap["entries"] = []): RepositoryCoverageMap => ({
  builtAt: FRESH,
  entries: [
    entry("lib", "src/lib.py", [{ repositoryId: "service", id: "tests/test_s0.py::test_x" }, { repositoryId: "service", id: "tests/test_s1.py::test_x" }, { repositoryId: "lib", id: "tests/test_l0.py::test_x" }]),
    entry("lib", "src/other.py", [{ repositoryId: "lib", id: "tests/test_l1.py::test_x" }]),
    entry("service", "src/svc.py", tests("service", 12, "s").slice(2, 3)),
    entry("service", "src/rest.py", tests("service", 12, "s").slice(3)),
    entry("lib", "src/rest.py", tests("lib", 12, "l").slice(2)),
    ...over,
  ],
});
const edge = (consumer: string, provider: string, source: "base" | "candidate" | "both" = "both") => ({ consumer, provider, language: "node" as const, source });
const base = (over: Partial<RepositorySelectionInput> = {}): RepositorySelectionInput => ({
  config, checks, changes: new Map([["lib", [modified("src/lib.py")]]]), map: map(), facts: { edges: [edge("service", "lib")], notes: [], complete: true, unknown: [] },
  repositories: ["service", "lib"], now: NOW, ...over,
});
const planned = (over: Partial<RepositorySelectionInput> = {}) => planRepositorySelections(base(over));

describe("cross-repository selection fails closed", () => {
  const unchanged = (result: ReturnType<typeof planned>, id: string, reason: string) => {
    const one = result.get(id)!;
    expect(one.command).toEqual(checks.find((c) => c.id === id)!.command);
    expect(one.selection).toMatchObject({ method: "full", fallbackReason: reason });
  };
  it("a path that is not in the map, a stale map and a path that changes what every test means run the whole check", () => {
    unchanged(planned({ changes: new Map([["lib", [modified("src/brand_new.py")]]]) }), "svc-unit", "unknown_file");
    expect(planned({ map: { ...map(), builtAt: "2026-10-01T00:00:00.000Z" } }).get("svc-unit")!.selection).toMatchObject({ method: "full", fallbackReason: "map_stale" });
    unchanged(planned({ changes: new Map([["lib", [modified("poetry.lock")]]]) }), "svc-unit", "full_suite_on_path");
    unchanged(planned({ changes: new Map([["lib", [modified("src/lib.py"), modified("package.json")]]]) }), "svc-unit", "full_suite_on_path");
    unchanged(planned({ changes: new Map([["lib", [modified("src/lib.py")]], ["service", [modified(".github/workflows/ci.yml")]]]) }), "svc-unit", "full_suite_on_path");
  });
  it("a changed file with a path that could be mistaken for another repository's key runs the whole check", () => {
    unchanged(planned({ changes: new Map([["service", [modified("\u0001lib\u0001src/lib.py")]]]) }), "svc-unit", "unknown_file");
    unchanged(planned({ changes: new Map([["lib", [{ path: "src/new.py", oldPath: "\u0001x", status: "renamed" }]]]) }), "svc-unit", "unknown_file");
  });
  it("a check of a repository the task does not hold, or a method that is not repository-aware, runs whole", () => {
    unchanged(planned({ repositories: ["lib"] }), "svc-unit", "unknown_file");
    unchanged(planned({ config: { ...config, method: "import_graph" } }), "svc-unit", "map_missing");
    unchanged(planned({ config: { ...config, method: "declared", declared: [{ glob: "src/*", tests: ["tests/*"] }] } }), "svc-unit", "map_missing");
  });
  it("hostile paths and repository ids do not throw or reach another repository's entries", () => {
    for (const path of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const result = planned({ changes: new Map([["lib", [modified(path)]]]) });
      unchanged(result, "svc-unit", "unknown_file");
    }
    const hostile = planned({ checks: [{ ...checks[0]!, repositoryId: "__proto__" }], repositories: ["__proto__", "lib"], facts: { edges: [edge("__proto__", "lib")], notes: [], complete: true, unknown: [] } });
    expect(hostile.get("svc-unit")!.selection).toMatchObject({ method: "full" });
  });
});
