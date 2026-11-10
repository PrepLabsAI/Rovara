import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

interface Step { name?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { if?: string; needs?: string | string[]; steps: Step[]; permissions?: unknown }
interface Workflow { on: Record<string, unknown>; permissions?: unknown; jobs: Record<string, Job> }

const workflow = async () => YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;

describe("CI runs on code/next and checks the port there (docs/porting.md), and mainline's pull requests run as before", () => {
  it("keeps the pull request and manual triggers as they were and adds a push to code/next only", async () => {
    const { on } = await workflow();
    expect(Object.keys(on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(on.pull_request).toEqual({ types: ["opened", "synchronize", "reopened", "ready_for_review"] });
    expect(on.push).toEqual({ branches: ["code/next"] });
  });

  it("leaves the `local` gate waiting for exactly the jobs it waited for", async () => {
    const { jobs } = await workflow();
    expect(jobs.local!.needs).toEqual(["scope", "checks", "test", "release", "linux-runtime"]);
  });

  it("runs the guard over the commits code/next holds beyond mainline, on a push to code/next or a pull request into it, with no secret", async () => {
    const { jobs } = await workflow();
    const job = jobs["port-guard"]!;
    expect(job.if).toBe(
      "github.event_name == 'push' || (github.event_name == 'pull_request' && github.base_ref == 'code/next' && github.event.pull_request.draft != true)",
    );
    expect(job.needs).toBeUndefined();
    const run = job.steps.map((step) => step.run ?? "").join("\n");
    expect(run).toContain("npm run port:guard -- --range origin/mainline..HEAD");
    // on a pull request the base branch's copy of the guard judges, and a second strict run flags edits to the guard itself
    expect(run).toContain("git show origin/code/next:scripts/port-guard.ts");
    expect(run).toContain('node "$RUNNER_TEMP/port-guard.ts" --range origin/code/next..HEAD');
    // the guard reads its boundary data from beside itself, so the base branch's copy of that file travels with it
    expect(run).toContain('git show origin/code/next:scripts/boundary-allowlist.json > "$RUNNER_TEMP/boundary-allowlist.json"');
    // and it fails closed: no `|| cp` falls back to the checkout's own copy of the data
    expect(run).not.toMatch(/boundary-allowlist\.json[^\n]*\|\|/);
    expect(run).not.toMatch(/cp scripts\/boundary-allowlist/);
    expect(run).not.toMatch(/cp scripts\/port-guard/);
    expect(run).not.toMatch(/port-guard\.ts"? *\|\|/);
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(JSON.stringify(job)).not.toContain("secrets.");
    // the downloaded scanner is pinned by version and checked against a checksum before it runs
    expect(run).toMatch(/gitleaks\/releases\/download\/v\d+\.\d+\.\d+\//);
    expect(run).toMatch(/[0-9a-f]{64} {2}\S+gitleaks\.tar\.gz" \| sha256sum --check/);
  });

  it("installs the same pinned gitleaks in the test job, so the secret-scan tests in port-guard.test.ts run there and do not fail for a missing scanner", async () => {
    const { jobs } = await workflow();
    const install = (name: string) => jobs[name]!.steps.find((step) => /^Install gitleaks/.test(step.name ?? ""))?.run;
    expect(install("test")).toBeDefined();
    expect(install("test")).toBe(install("port-guard"));
  });

  it("gives no other job a secret or a wider permission than before", async () => {
    const source = await readFile(".github/workflows/ci.yml", "utf8");
    expect([...source.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1])).toEqual(["GITHUB_TOKEN"]);
  });
});
