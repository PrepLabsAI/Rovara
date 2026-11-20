import { describe, expect, it } from "vitest";
import {
  AFFECTED_SHARDS, FULL_SHARDS, MAX_EXTRA_TESTS, affectedPackages, fullReason, linuxRuns, planCi, planOutputs, relatedTests, type PackageInfo, type PlanInput,
} from "../../scripts/ci-plan.js";

// Paths here are made up on purpose: a real path named in a test would make that file run full CI.
const packages: PackageInfo[] = [
  { dir: "packages/core-a", name: "@sample/core-a", dependencies: [] },
  { dir: "packages/mid-b", name: "@sample/mid-b", dependencies: ["@sample/core-a"] },
  { dir: "packages/leaf-c", name: "@sample/leaf-c", dependencies: ["@sample/mid-b"] },
  { dir: "packages/other-d", name: "@sample/other-d", dependencies: [] },
];
const testSources = new Map<string, string>([
  ["tests/unit/uses-a.test.ts", 'import { x } from "@sample/core-a";'],
  ["tests/unit/uses-c.test.ts", 'import { x } from "@sample/leaf-c";'],
  ["tests/unit/uses-d.test.ts", 'import { x } from "@sample/other-d";'],
  ["tests/contract/reads-script.test.ts", 'readFileSync("scripts/sample-tool.ts", "utf8")'],
  ["tests/unit/plain.test.ts", "expect(1).toBe(1);"],
]);
const input = (overrides: Partial<PlanInput>): PlanInput => ({ event: "pull_request", labels: [], title: "Sample change", changed: ["packages/other-d/src/x.ts"], testSources, packages, ...overrides });

describe("which runs are FULL", () => {
  it("is every run that is not a pull request: a push to code/next and a manual run (the emulator check runs in a push, not in a manual run: DEC 254zn)", () => {
    for (const event of ["push", "workflow_dispatch"]) {
      const plan = planCi(input({ event, changed: [] }));
      // #1189: neither a push to code/next nor a manual run runs the Linux runtime check by itself (a manual run only when asked: its `linux` input).
      expect(plan, event).toMatchObject({ mode: "full", tests: "all", lint: "all", linux: false, device: event === "push", release: true, docsOnly: false, shards: FULL_SHARDS });
    }
  });

  it("is a pull request with the full-ci label, or one titled Batch or Sync mainline", () => {
    expect(fullReason({ event: "pull_request", labels: ["full-ci"], title: "x" })).toMatch(/full-ci/);
    expect(fullReason({ event: "pull_request", labels: [], title: "Batch 7: things" })).toMatch(/Batch/);
    expect(fullReason({ event: "pull_request", labels: [], title: "Sync mainline into code/next" })).toMatch(/Sync mainline/);
    expect(planCi(input({ labels: ["bug", "full-ci"] })).mode).toBe("full");
  });

  it("is not a pull request with a similar title or another label", () => {
    expect(fullReason({ event: "pull_request", labels: ["full"], title: "Batching the sends" })).toBeUndefined();
    expect(fullReason({ event: "pull_request", labels: [], title: "Fix: Batch job" })).toBeUndefined();
    expect(fullReason({ event: "pull_request", labels: [], title: "batch 1" })).toBeUndefined();
  });

  it("runs everything even when the change is Markdown only, so a full run is never thinner than a full run", () => {
    const plan = planCi(input({ labels: ["full-ci"], changed: ["docs/sample/guide.md"] }));
    expect(plan).toMatchObject({ mode: "full", docsOnly: false, tests: "all", lint: "all", linux: false, release: true, device: false, deviceRequired: false });
  });
});

describe("the affected plan of an ordinary pull request", () => {
  it("runs the tests the change can reach, in 2 shards, with lint on the changed files only", () => {
    const plan = planCi(input({ changed: ["packages/other-d/src/x.ts"] }));
    expect(plan).toMatchObject({ mode: "affected", tests: "changed", shards: AFFECTED_SHARDS, lint: "changed", linux: false, release: false, docsOnly: false });
  });

  it("adds the tests that name the changed file, or a package the change reaches (a package's tests import its built output, not its source)", () => {
    expect(planCi(input({ changed: ["scripts/sample-tool.ts"] })).extraTests).toEqual(["tests/contract/reads-script.test.ts"]);
    // core-a is imported by mid-b, which leaf-c imports: a change to core-a reaches the tests of all three
    expect(planCi(input({ changed: ["packages/core-a/src/x.ts"] })).extraTests).toEqual(["tests/unit/uses-a.test.ts", "tests/unit/uses-c.test.ts"]);
    expect(planCi(input({ changed: ["packages/leaf-c/src/x.ts"] })).extraTests).toEqual(["tests/unit/uses-c.test.ts"]);
    expect(planCi(input({ changed: ["packages/other-d/src/x.ts"] })).extraTests).toEqual(["tests/unit/uses-d.test.ts"]);
  });

  it("finds the packages a change reaches through their dependencies, however deep", () => {
    expect(affectedPackages(["packages/core-a/src/x.ts"], packages).map((pkg) => pkg.dir)).toEqual(["packages/core-a", "packages/mid-b", "packages/leaf-c"]);
    expect(affectedPackages(["docs/x.md"], packages)).toEqual([]);
    expect(relatedTests(["tests/unit/plain.test.ts"], packages, testSources)).toEqual(["tests/unit/plain.test.ts"]);
  });

  it("falls back to the whole suite when something every test shares changes", () => {
    for (const shared of ["package.json", "package-lock.json", "vitest.config.ts", "vitest.native-p0.config.ts", "tests/support/sample-helper.ts", "tsconfig.base.json", ".node-version", ".github/workflows/ci.yml", "tests/.timings/vitest-durations.json", "packages/core-a/package.json", "scripts/ci-plan.ts", "eslint.config.js"]) {
      const plan = planCi(input({ changed: ["packages/other-d/src/x.ts", shared] }));
      expect(plan, shared).toMatchObject({ mode: "affected", tests: "all", shards: FULL_SHARDS, extraTests: [] });
      expect(plan.testsReason, shared).toContain(shared);
    }
  });

  it("falls back to the whole suite when no changed file is listed, or too many tests name the change", () => {
    expect(planCi(input({ changed: [] }))).toMatchObject({ tests: "all", lint: "all", linux: false, release: true });
    const many = new Map<string, string>([...Array.from({ length: MAX_EXTRA_TESTS + 1 }, (_, index) => [`tests/unit/t${index}.test.ts`, 'import "@sample/other-d";'] as const)]);
    const plan = planCi(input({ testSources: many, changed: ["packages/other-d/src/x.ts"] }));
    expect(plan).toMatchObject({ tests: "all", shards: FULL_SHARDS });
    expect(plan.testsReason).toMatch(/whole suite/);
  });

  it("lints everything when the lint settings, the compiler settings or the toolchain change, nothing when no TypeScript file changed", () => {
    for (const shared of ["eslint.config.js", "scripts/lint-shards.ts", "tsconfig.lint.json", "package.json", "package-lock.json", ".node-version", "packages/core-a/package.json"]) {
      expect(planCi(input({ changed: [shared] })).lint, shared).toBe("all");
    }
    expect(planCi(input({ changed: ["environments/sample/Dockerfile"] })).lint).toBe("none");
    expect(planCi(input({ changed: ["docs/sample/guide.md", "packages/other-d/src/x.ts"] })).lint).toBe("changed");
  });

  it("never runs the Linux runtime check, whatever the change (#1192: it runs in the production release)", () => {
    for (const changed of ["packages/worker/src/x.ts", "packages/verifier/src/x.ts", "environments/e2e-executor/Dockerfile", "tests/linux/sample.test.ts", "packages/broker/src/x.ts"]) {
      expect(planCi(input({ changed: [changed] })).linux, changed).toBe(false);
    }
  });


  it("runs the device emulator check, and requires it, only when device code changes: the device executor image, the device code and tests, the CI image list (DEC 254zn quarantine)", () => {
    for (const area of ["environments/device-executor/Dockerfile", "packages/contracts/src/device-evidence.ts", "packages/verifier/src/executor/device-android.ts", "packages/verifier/src/host/device-executor.ts", "tests/linux/device-evidence-emulator.test.ts", "tests/fixtures/device-evidence-app/build.sh", "tests/support/device-kvm.ts", "scripts/ci-images.ts", ".github/ci-images.json"]) {
      const plan = planCi(input({ changed: [area] }));
      expect(plan.device, area).toBe(true);
      expect(plan.deviceRequired, area).toBe(true);
      expect(planCi(input({ changed: [area, "unrelated.txt"], labels: ["full-ci"] })).deviceRequired, `${area} in a full-ci run`).toBe(true);
    }
    // not device code: the shared files that used to plan the job (the workflow, the plan and gate scripts, the manifests, tsconfig) no longer do
    for (const elsewhere of ["packages/worker/src/x.ts", "packages/verifier/src/x.ts", "packages/verifier/src/executor/browser-evidence.ts", "environments/e2e-executor/Dockerfile", "tests/linux/sample.test.ts", "tests/unit/plain.test.ts", "docs/sample/guide.md",
      "scripts/ci-plan.ts", "scripts/ci-gate.ts", ".github/workflows/ci.yml", "package.json", "package-lock.json", ".node-version", "tsconfig.base.json"]) {
      const plan = planCi(input({ changed: [elsewhere] }));
      expect(plan.device, elsewhere).toBe(false);
      expect(plan.deviceRequired, elsewhere).toBe(false);
    }
    // an unreadable (empty) changed-file list on a pull request: the job runs, but is never required
    expect(planCi(input({ changed: [] }))).toMatchObject({ device: true, deviceRequired: false });
  });

  it("runs the device emulator check once, non-blocking, in a push to code/next, a scheduled run and a Batch pull request, and never in a manual run, a label-only full run or a Sync mainline run", () => {
    for (const run of [input({ event: "push", changed: [] }), input({ title: "Batch 12: things", changed: ["packages/other-d/src/x.ts"] })]) {
      expect(planCi(run), `${run.event} ${run.title}`).toMatchObject({ device: true, deviceRequired: false, mode: "full" });
    }
    // #1185: the scheduled run is the nightly Linux runtime run, not a full suite; it still runs the emulator check, non-blocking.
    expect(planCi(input({ event: "schedule", changed: [] }))).toMatchObject({ device: true, deviceRequired: false, mode: "affected", linux: false });
    for (const run of [input({ event: "workflow_dispatch", changed: [] }), input({ labels: ["full-ci"] }), input({ title: "Sync mainline into code/next" }), input({ title: "Batching the sends" })]) {
      expect(planCi(run), `${run.event} ${run.title}`).toMatchObject({ device: false, deviceRequired: false });
    }
  });

  it("runs the release check only when release or build files change", () => {
    for (const area of ["scripts/release/build.ts", "scripts/release-common.ts", "infra/lib/sample.ts", "environments/base/Dockerfile", "package.json", "tsconfig.base.json", ".github/workflows/ci.yml"]) {
      expect(planCi(input({ changed: [area] })).release, area).toBe(true);
    }
    for (const elsewhere of ["packages/other-d/src/x.ts", "tests/unit/plain.test.ts", "scripts/sample-tool.ts"]) {
      expect(planCi(input({ changed: [elsewhere] })).release, elsewhere).toBe(false);
    }
  });

  it("runs nothing but the plan for a Markdown-only change that no test reads, and runs everything else for one a test reads", () => {
    const docs = planCi(input({ changed: ["docs/sample/guide.md"] }));
    expect(docs).toMatchObject({ mode: "affected", docsOnly: true, tests: "none", lint: "none", linux: false, device: false, release: false, shards: 1 });
    const read = planCi(input({ changed: ["docs/sample/read.md"], testSources: new Map([["tests/unit/reads-doc.test.ts", 'readFile("docs/sample/read.md")']]) }));
    expect(read.docsOnly).toBe(false);
    expect(read.tests).toBe("changed");
    expect(read.extraTests).toEqual(["tests/unit/reads-doc.test.ts"]);
  });
});

describe("the outputs the workflow reads", () => {
  it("are strings, with a shard list that is never empty", () => {
    expect(planOutputs(planCi(input({ changed: ["packages/other-d/src/x.ts"] })))).toEqual({
      mode: "affected", docs_only: "false", tests: "changed", shards: "[1,2]", lint: "changed", linux: "false", device: "false", device_required: "false", release: "false",
    });
    expect(planOutputs(planCi(input({ changed: ["tests/linux/device-evidence-emulator.test.ts"] })))).toMatchObject({ device: "true", device_required: "true" });
    expect(planOutputs(planCi(input({ event: "push", changed: [] }))).shards).toBe("[1,2,3,4,5,6,7,8]");
    const docs = planOutputs(planCi(input({ changed: ["docs/sample/guide.md"] })));
    expect(docs).toMatchObject({ docs_only: "true", tests: "none", shards: "[1]" });
  });
});

// #1192: the Linux runtime check no longer runs in CI (for mainline or code/next); the production release runs it before the deploy. Only a manual run asks for it.
describe("when the Linux runtime check runs", () => {
  it("never runs for a pull request (into mainline or code/next), a push, a label, the nightly run or a FULL run", () => {
    for (const run of [
      input({ changed: ["packages/worker/src/x.ts"] }), input({ title: "Batch 3: things", changed: ["tests/linux/x.test.ts"] }), input({ changed: [] }),
      input({ labels: ["linux-ci"] }), input({ labels: ["full-ci"] }), input({ event: "push", changed: [] }), input({ event: "schedule", changed: [] }),
      input({ event: "workflow_dispatch", changed: [] }),
    ]) expect(planCi(run).linux, JSON.stringify({ event: run.event, labels: run.labels, title: run.title })).toBe(false);
    expect(linuxRuns({ event: "pull_request", forceLinux: true })).toBe(false);
  });
  it("runs only when a manual run asks for it (its linux input)", () => {
    expect(planCi(input({ event: "workflow_dispatch", changed: [], forceLinux: true })).linux).toBe(true);
    expect(linuxRuns({ event: "workflow_dispatch", forceLinux: true })).toBe(true);
  });
  it("keeps the nightly run cheap: no tests, lint, release or Linux check (it still runs the device emulator check, non-blocking)", () => {
    const plan = planCi(input({ event: "schedule", changed: [] }));
    expect(plan).toMatchObject({ mode: "affected", tests: "none", lint: "none", release: false, linux: false, docsOnly: false });
    expect(planOutputs(plan)).toMatchObject({ linux: "false", tests: "none" });
  });
});
