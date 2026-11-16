import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { docsOnlyChange } from "../../scripts/ci-plan.js";

interface Step { id?: string; name?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; "timeout-minutes"?: number }
interface Job { needs?: string | string[]; if?: string; steps: Step[] }
interface Workflow { jobs: Record<string, Job> }

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

  it("is decided by the plan job, from the merge commit's first parent, before any install, and a manual run or a push never reaches it", async () => {
    const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;
    const plan = workflow.jobs.plan!;
    expect(plan.steps[0]).toMatchObject({ uses: "actions/checkout@v5", with: { "fetch-depth": 2 } });
    const step = plan.steps.find((candidate) => candidate.id === "plan")!;
    expect(step.run).toContain('if [ "$CI_EVENT" = pull_request ]');
    expect(step.run).toContain("git diff --name-only HEAD^1 HEAD");
    expect(step.run).toContain('node "$PLAN_SCRIPT"');
    expect(plan.steps.some((candidate) => candidate.run === "npm ci")).toBe(false);
  });

  it("skips the heavy jobs through the plan: `quick` and the shards by their own condition, never by a step that leaves the job green", async () => {
    const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;
    expect(workflow.jobs.quick!.if).toBe("needs.plan.outputs.docs_only != 'true'");
    for (const job of ["build", "test"]) expect(workflow.jobs[job]!.if, job).toBe("needs.plan.outputs.tests != 'none'");
    expect(workflow.jobs["linux-runtime"]!.if).toBe("needs.plan.outputs.linux == 'true'");
  });
});
