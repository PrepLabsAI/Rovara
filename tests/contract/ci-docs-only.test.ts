import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { docsOnlyChange } from "../../scripts/ci-docs-only.js";

interface Step { id?: string; name?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown> }
interface Workflow { jobs: Record<string, { steps: Step[] }> }

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

  it("runs the check on pull requests only, from the merge commit's first parent, before npm ci", async () => {
    const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;
    const steps = workflow.jobs.local!.steps;
    expect(steps[0]).toMatchObject({ uses: "actions/checkout@v5", with: { "fetch-depth": 2 } });
    const scope = steps.find((step) => step.id === "scope")!;
    expect(scope.if).toBe("github.event_name == 'pull_request'");
    expect(scope.run).toContain("git diff --name-only HEAD^1 HEAD");
    expect(scope.run).toContain("node scripts/ci-docs-only.ts");
    expect(steps.indexOf(scope)).toBeLessThan(steps.findIndex((step) => step.run === "npm ci"));
  });

  it("guards every heavy step with the check, so a push to mainline or a manual run always runs them", async () => {
    const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;
    const steps = workflow.jobs.local!.steps;
    const heavy = steps.filter((step) => step.run !== undefined && step.id !== "scope" && step.name !== "Markdown-only change");
    expect(heavy.map((step) => step.name ?? step.run)).toEqual(["npm ci", "npm run typecheck", "npm run typecheck:all", "npm run lint", "npm test", "npm run infra:synth", "Release builds are reproducible"]);
    for (const step of heavy) expect(step.if, step.name ?? step.run).toBe("steps.scope.outputs.docs_only != 'true'");
    const setupNode = steps.find((step) => step.uses === "actions/setup-node@v5")!;
    expect(setupNode.if).toBeUndefined();
  });
});
