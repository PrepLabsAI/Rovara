// TE-MR2b: how the worker applies a plan that carries the repository-qualified map. Two-repository changes keep running in full until the selection is proven (the switch is off); with it on, the diff the worker computed
// itself, per repository, and the dependency facts derived from the repositories' own manifests decide. Anything else is today's behaviour.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestEnvTaskPlanSchema, type CandidateRepository, type ProjectCommand, type TestEnvTaskPlan } from "@agentx/contracts";

const changes = vi.hoisted(() => ({ byDirectory: new Map<string, Array<{ path: string; status: "ADDED" | "MODIFIED" | "DELETED" | "UNPLACEABLE"; hunks: never[] }>>(), throwFor: new Set<string>() }));
vi.mock("../../packages/worker/src/verification/diff.js", () => ({
  candidateChanges: vi.fn(async (input: { directory: string }) => {
    if (changes.throwFor.has(input.directory)) throw new Error("git failed");
    return changes.byDirectory.get(input.directory) ?? [];
  }),
}));
const { applyTestEnvironmentPlan } = await import("../../packages/worker/src/verification/test-env-plan.js");
const { MULTI_REPO_SELECTION_LIVE } = await import("../../packages/worker/src/verification/multi-repo-selection.js");
const { isolatedGitEnvironment } = await import("../../packages/worker/src/git.js");

const NOW = new Date("2026-11-02T12:00:00.000Z");
const FRESH = "2026-11-02T08:00:00.000Z";
const TREE = "b".repeat(40);
const cmd = (cwd: string): ProjectCommand => ({ cwd, executable: "pytest", args: ["-q"], timeoutSeconds: 600 });
const readiness = [cmd("service"), cmd("lib")];
const testsOf = (repositoryId: string, count: number, prefix: string) => Array.from({ length: count }, (_, i) => ({ repositoryId, id: `tests/test_${prefix}${String(i)}.py::test_x` }));
const repositoryCoverageMap = {
  builtAt: FRESH,
  entries: [
    { repositoryId: "lib", path: "src/lib.py", tests: [...testsOf("service", 2, "s"), ...testsOf("lib", 1, "l")] },
    { repositoryId: "service", path: "src/rest.py", tests: testsOf("service", 12, "r") },
    { repositoryId: "lib", path: "src/rest.py", tests: testsOf("lib", 12, "q") },
  ],
};
const plan = (over: Record<string, unknown> = {}): TestEnvTaskPlan => TestEnvTaskPlanSchema.parse({
  revision: 2, digest: "d".repeat(64), roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] },
  checks: [{ id: "svc", kind: "test", repositoryId: "service", selectArgs: ["{tests}"] }, { id: "lib", kind: "test", repositoryId: "lib", selectArgs: ["{tests}"] }],
  repositoryCoverageMap, ...over,
});
const BASE = "a".repeat(40);
const directories = { service: "/work/service", lib: "/work/lib" };
const repos = [{ repositoryId: "service", directory: directories.service, baseCommitSha: BASE }, { repositoryId: "lib", directory: directories.lib, baseCommitSha: BASE }];
const candidate = (...ids: string[]): CandidateRepository[] => ids.map((repositoryId) => ({ repositoryId, commitSha: "c".repeat(40), treeSha: TREE, baseCommitSha: BASE }));
const facts = (over: Record<string, unknown> = {}) => ({ edges: [{ consumer: "service", provider: "lib", language: "node", source: "both" }], notes: [], complete: true, unknown: [], ...over });
const apply = (over: { plan?: TestEnvTaskPlan; live?: boolean; derive?: (repositories: unknown) => Promise<unknown> } = {}) => applyTestEnvironmentPlan({
  readiness, plan: over.plan ?? plan(), repositories: repos, candidateBefore: candidate("service", "lib"), now: NOW,
  multiRepo: { live: over.live ?? true, ...(over.derive === undefined ? { derive: async () => facts() } : { derive: over.derive }) } as never,
});
const modified = (path: string) => ({ path, status: "MODIFIED" as const, hunks: [] });

beforeEach(() => { changes.byDirectory.clear(); changes.throwFor.clear(); });

describe("a change in two repositories", () => {
  it("is off by default in production: the switch is a constant, and false", () => { expect(MULTI_REPO_SELECTION_LIVE).toBe(false); });

  it("runs every test check in full, as before, when the switch is off, even with the map and the facts", async () => {
    changes.byDirectory.set(directories.lib, [modified("src/lib.py")]);
    changes.byDirectory.set(directories.service, [modified("src/rest.py")]);
    const off = (await apply({ live: false }))!;
    expect(off.readiness).toEqual(readiness);
    expect(off.selection).toMatchObject({ method: "full", fallbackReason: "unknown_file" });
  });

  it("without the switch argument, production takes the constant (off): the whole check", async () => {
    changes.byDirectory.set(directories.lib, [modified("src/lib.py")]);
    changes.byDirectory.set(directories.service, [modified("src/rest.py")]);
    const result = (await applyTestEnvironmentPlan({ readiness, plan: plan(), repositories: repos, candidateBefore: candidate("service", "lib"), now: NOW }))!;
    expect(result.readiness).toEqual(readiness);
  });

  it("with the switch on, selects each repository's tests from the provider's change and its own", async () => {
    changes.byDirectory.set(directories.lib, [modified("src/lib.py")]);
    changes.byDirectory.set(directories.service, [{ path: "src/rest.py", status: "MODIFIED", hunks: [] }]);
    const applied = (await apply())!;
    // service: its own src/rest.py (12 tests) and the provider's change (2 more) are all 14 of its tests: over the 40% line, so the whole check.
    expect(applied.readiness[0]).toEqual(readiness[0]);
    expect(applied.selection).toMatchObject({ method: "coverage_map" });
    // lib: its own change selects lib's one test; service's change is ignored (service is not a provider of lib, and both are fully known).
    expect(applied.readiness[1]!.args).toEqual(["-q", "tests/test_l0.py::test_x"]);
  });

  it("with the switch on, a provider-only change narrows the consumer's check to the tests that touch it", async () => {
    changes.byDirectory.set(directories.lib, [modified("src/lib.py")]);
    const applied = (await apply())!;
    expect(applied.readiness[0]!.args).toEqual(["-q", "tests/test_s0.py::test_x", "tests/test_s1.py::test_x"]);
    // lib's own check: lib changed src/lib.py, one lib test touches it.
    expect(applied.readiness[1]!.args).toEqual(["-q", "tests/test_l0.py::test_x"]);
    expect(applied.selection).toMatchObject({ method: "coverage_map", selected: 3 });
  });

  it("a map that arrives with the repository-less one is not possible, and a repository-less map is never read for two repositories", async () => {
    changes.byDirectory.set(directories.lib, [modified("src/lib.py")]);
    changes.byDirectory.set(directories.service, [modified("src/rest.py")]);
    const old = plan({ repositoryCoverageMap: undefined, coverageMap: { builtAt: FRESH, files: { "src/lib.py": ["tests/test_s0.py::test_x"] } }, checks: [{ id: "svc", kind: "test", selectArgs: ["{tests}"] }, { id: "lib", kind: "test", selectArgs: ["{tests}"] }] });
    const result = (await apply({ plan: old }))!;
    expect(result.readiness).toEqual(readiness);
    expect(result.selection?.fallbackReason).toBe("unknown_file");
  });

  it("falls back to the whole check when the facts are unavailable, when a diff cannot be read, or when the derivation throws", async () => {
    changes.byDirectory.set(directories.lib, [modified("src/lib.py")]);
    for (const derive of [async () => undefined, async () => { throw new Error("boom"); }, async () => facts({ complete: false, edges: [] })]) {
      const result = (await apply({ derive }))!;
      expect(result.readiness).toEqual(readiness);
      expect(result.selection).toMatchObject({ method: "full" });
    }
    changes.throwFor.add(directories.lib);
    const unreadable = (await apply())!;
    expect(unreadable.readiness).toEqual(readiness);
    expect(unreadable.selection).toMatchObject({ method: "full", fallbackReason: "unknown_file" });
  });

  it("a single repository task, and a plan without the map, are exactly today's path (the facts are never derived)", async () => {
    const derive = vi.fn(async () => facts());
    changes.byDirectory.set(directories.service, [modified("src/rest.py")]);
    const single = await applyTestEnvironmentPlan({ readiness: [readiness[0]!], plan: plan({ repositoryCoverageMap: undefined, checks: [{ id: "svc", kind: "test", selectArgs: ["{tests}"] }] }), repositories: [repos[0]!], candidateBefore: candidate("service"), now: NOW, multiRepo: { live: true, derive } as never });
    expect(single?.selection?.fallbackReason).toBe("map_missing");
    await applyTestEnvironmentPlan({ readiness: [readiness[0]!], plan: plan({ checks: [{ id: "svc", kind: "test", repositoryId: "service", selectArgs: ["{tests}"] }] }), repositories: [repos[0]!], candidateBefore: candidate("service"), now: NOW, multiRepo: { live: true, derive } as never });
    expect(derive).not.toHaveBeenCalled();
  });
});

describe("with the real manifests of two repositories", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd, env: isolatedGitEnvironment(cwd), encoding: "utf8" }).trim();
  async function world(manifests: Record<string, Record<string, string>>) {
    const root = realpathSync.native(await mkdtemp(join(process.env.TMPDIR ?? join(process.cwd(), "node_modules"), "mr2b-plan-"))); roots.push(root);
    const made: Array<{ repositoryId: string; directory: string; baseCommitSha: string }> = [];
    for (const [name, files] of Object.entries(manifests)) {
      const directory = join(root, name); await mkdir(directory); git(directory, "init", "-q"); await writeFile(join(directory, "keep"), "x");
      for (const [path, text] of Object.entries(files)) await writeFile(join(directory, path), text);
      git(directory, "add", "."); git(directory, "commit", "-qm", "base");
      made.push({ repositoryId: name, directory, baseCommitSha: git(directory, "rev-parse", "HEAD") });
    }
    return made;
  }
  const run = (made: Awaited<ReturnType<typeof world>>) => applyTestEnvironmentPlan({ readiness, plan: plan(), repositories: made, candidateBefore: candidate(...made.map((m) => m.repositoryId)), now: NOW, multiRepo: { live: true } });

  it("narrows the consumer's check from its own package.json dependency on the provider", async () => {
    const made = await world({ service: { "package.json": JSON.stringify({ name: "svc", dependencies: { "lib-pkg": "*" } }) }, lib: { "package.json": JSON.stringify({ name: "lib-pkg" }) } });
    changes.byDirectory.set(made[1]!.directory, [modified("src/lib.py")]);
    const applied = (await run(made))!;
    expect(applied.readiness[0]!.args).toEqual(["-q", "tests/test_s0.py::test_x", "tests/test_s1.py::test_x"]);
  });

  it("an edge the candidate removed from the consumer's manifest still relates the two: the consumer's tests still run", async () => {
    const made = await world({ service: { "package.json": JSON.stringify({ name: "svc", dependencies: { "lib-pkg": "*" } }) }, lib: { "package.json": JSON.stringify({ name: "lib-pkg" }) } });
    await writeFile(join(made[0]!.directory, "package.json"), JSON.stringify({ name: "svc" }));
    changes.byDirectory.set(made[1]!.directory, [modified("src/lib.py")]);
    const applied = (await run(made))!;
    expect(applied.readiness[0]!.args).toEqual(["-q", "tests/test_s0.py::test_x", "tests/test_s1.py::test_x"]);
  });

  it("no edge in either source and a Maven repository: the whole check, never a skip", async () => {
    const made = await world({ service: { "pom.xml": "<project/>" }, lib: { "package.json": JSON.stringify({ name: "lib-pkg" }) } });
    changes.byDirectory.set(made[1]!.directory, [modified("src/lib.py")]);
    const applied = (await run(made))!;
    expect(applied.readiness[0]).toEqual(readiness[0]);
    // lib's own check is still narrowed by lib's own change: the unknown repository only costs ITS checks their narrowing.
    expect(applied.readiness[1]!.args).toEqual(["-q", "tests/test_l0.py::test_x"]);
  });
});
