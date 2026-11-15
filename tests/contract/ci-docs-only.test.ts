import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { docsOnlyChange } from "../../scripts/ci-docs-only.js";

interface Step { id?: string; name?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; "timeout-minutes"?: number }
interface Job { needs?: string | string[]; if?: string; steps: Step[] }
interface Workflow { jobs: Record<string, Job> }

const DOCS_ONLY_GUARD = "steps.scope.outputs.docs_only != 'true'";

const noTests = new Map<string, string>([["tests/contract/example.test.ts", "expect(1).toBe(1);"]]);

// Paths here are made up on purpose: a real path named in a test would make that file run full CI.
describe("the docs-only check (CI skips the heavy steps for a Markdown-only pull request)", () => {
  it("is docs-only when every changed file is Markdown under specs/ or docs/, or the root README", () => {
    expect(docsOnlyChange(["specs/000-sample/plans/notes.md", "docs/sample/guide.md", "README.md"], noTests)).toEqual({ docsOnly: true, reason: "3 Markdown files, none read by a test" });
  });

  it("is not docs-only when any file is not Markdown, or is Markdown outside specs/ and docs/", () => {
    expect(docsOnlyChange(["docs/sample/guide.md", "packages/sample/src/main.ts"], noTests)).toEqual({ docsOnly: false, reason: "packages/sample/src/main.ts is not a Markdown file under specs/ or docs/" });
    expect(docsOnlyChange([".specify/sample/notes.md"], noTests).docsOnly).toBe(false);
    expect(docsOnlyChange(["packages/sample/README.md"], noTests).docsOnly).toBe(false);
    expect(docsOnlyChange(["specs/000-sample/data.json"], noTests).docsOnly).toBe(false);
  });

  it("is not docs-only when a test mentions a changed file, so a guide a test reads still runs the suite", () => {
    const tests = new Map([["tests/contract/sample.test.ts", 'const guide = await readFile("docs/sample/read-by-a-test.md", "utf8");']]);
    expect(docsOnlyChange(["docs/sample/read-by-a-test.md"], tests)).toEqual({ docsOnly: false, reason: "docs/sample/read-by-a-test.md is mentioned in tests/contract/sample.test.ts" });
  });

  it("is not docs-only for an empty change, a path outside the repo, or a Windows-style path", () => {
    expect(docsOnlyChange([], noTests)).toEqual({ docsOnly: false, reason: "no changed files" });
    expect(docsOnlyChange(["docs/../packages/sample/x.md"], noTests).docsOnly).toBe(false);
    expect(docsOnlyChange(["docs\\notes.md"], noTests).docsOnly).toBe(false);
  });

  it("runs the check on pull requests only, from the merge commit's first parent, before any install, in every job that does heavy work", async () => {
    const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;
    const copies: string[] = [];
    for (const job of ["quick", "test", "linux-runtime"]) {
      const steps = workflow.jobs[job]!.steps;
      expect(steps[0], job).toMatchObject({ uses: "actions/checkout@v5", with: { "fetch-depth": 2 } });
      const scope = steps.find((step) => step.id === "scope")!;
      expect(scope.if, job).toBe("github.event_name == 'pull_request'");
      expect(scope.run, job).toContain("git diff --name-only HEAD^1 HEAD");
      expect(scope.run, job).toContain("node scripts/ci-docs-only.ts");
      expect(scope["timeout-minutes"], job).toBe(5);
      copies.push(scope.run!);
      // Nothing is installed or built before the check, and only the checkout and Node's setup come first.
      const before = steps.slice(0, steps.indexOf(scope));
      expect(before.every((step) => step.uses?.startsWith("actions/")), job).toBe(true);
    }
    expect(new Set(copies).size).toBe(1);
  });

  it("guards every heavy step with the check, so a manual run always runs them, and keeps each job's check name present on a Markdown-only change", async () => {
    const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;
    const heavySteps = (job: string) => workflow.jobs[job]!.steps.filter((step) => step.run !== undefined && step.id !== "scope").map((step) => step.name ?? step.run);
    expect(heavySteps("quick")).toEqual([
      "scope: Markdown-only change",
      "checks: npm ci",
      "checks: npm run typecheck",
      "checks: npm run typecheck:all",
      "checks: npm run lint",
      "release: npm run build",
      "release: npm run infra:synth",
      "release: Release builds are reproducible",
    ]);
    expect(heavySteps("test")).toEqual(["npm ci", "Install gitleaks 8.30.1 (checksum pinned)", "npm run build", "npm test -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}"]);
    for (const job of ["quick", "test", "linux-runtime"]) {
      const steps = workflow.jobs[job]!.steps;
      const after = steps.slice(steps.findIndex((step) => step.id === "scope") + 1);
      for (const step of after) {
        if (step.name === "scope: Markdown-only change") expect(step.if).toBe("steps.scope.outputs.docs_only == 'true'");
        else expect(step.if, `${job}: ${step.name ?? step.run}`).toBe(DOCS_ONLY_GUARD);
      }
      // A skipped step still lets the job succeed; a job-level docs-only condition would leave a required check missing.
      expect(workflow.jobs[job]!.needs, job).toBeUndefined();
      expect(workflow.jobs[job]!.if, job).toBe("github.event.pull_request.draft != true");
    }
  });
});
