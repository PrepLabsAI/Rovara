import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

interface Step { if?: string; "continue-on-error"?: unknown; name?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { "continue-on-error"?: unknown; if?: string; needs?: string | string[]; steps: Step[]; permissions?: unknown }
interface Workflow { on: Record<string, unknown>; permissions?: unknown; jobs: Record<string, Job> }

const workflow = async () => YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;

describe("CI runs on code/next and checks the port there (docs/porting.md), and mainline's pull requests run as before", () => {
  it("keeps the pull request and manual triggers as they were and adds a push to code/next only", async () => {
    const { on } = await workflow();
    // #1185 added the nightly run (the device emulator check); its cron is pinned in ci-parallel.test.ts.
    expect(Object.keys(on).sort()).toEqual(["pull_request", "push", "schedule", "workflow_dispatch"]);
    expect(on.pull_request).toEqual({ types: ["opened", "synchronize", "reopened", "ready_for_review", "labeled"] });
    expect(on.push).toEqual({ branches: ["code/next"] });
  });

  it("keeps the port guard a check of its own, outside `quick` and the `local` gate, with nothing waiting on it", async () => {
    const { jobs } = await workflow();
    expect(jobs.local!.needs).toEqual(["plan", "quick", "build", "test", "linux-runtime", "ci-mode", "release-check"]);
    expect(Object.keys(jobs).sort()).toEqual(["build", "ci-mode", "device-runtime", "linux-runtime", "live-aws", "local", "nightly-tests", "plan", "port-guard", "quick", "release-check", "test"]);
    for (const [name, job] of Object.entries(jobs)) expect(JSON.stringify(job.needs ?? []), name).not.toContain("port-guard");
    expect(jobs.quick!.steps.map((step) => step.run ?? "").join("\n")).not.toContain("port-guard");
  });

  it("keeps Linux failures fatal while allowing independent checks to report, without changing other jobs' step gates", async () => {
    const { jobs } = await workflow();
    const linux = jobs["linux-runtime"]!;
    expect(linux["continue-on-error"]).toBeUndefined();
    for (const step of linux.steps) expect(step["continue-on-error"], step.name).toBeUndefined();
    const checks = linux.steps.filter((step) => (step.run ?? "").startsWith("npx vitest run"));
    expect(checks).toHaveLength(10);
    for (const step of checks) {
      expect(step.if, step.name).toBe("(success() || failure()) && steps.runtime_setup.outcome == 'success'");
    }
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "linux-runtime") continue;
      for (const step of job.steps) expect(step.if ?? "", name).not.toContain("success() || failure()");
    }
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
    // the strict run skips private-name findings only on commits already public on mainline (plan v3.2), and names no other public base
    const strict = job.steps.find((step) => /^Edits to the guard/.test(step.name ?? ""))?.run ?? "";
    expect(strict.trim()).toBe('node "$RUNNER_TEMP/port-guard.ts" --range origin/code/next..HEAD --public-base refs/remotes/origin/mainline');
    expect([...run.matchAll(/--public-base (\S+)/g)].map((match) => match[1])).toEqual(["refs/remotes/origin/mainline"]);
    // the guard reads its boundary data from beside itself, so the base branch's copy of that file travels with it
    expect(run).toContain('git show origin/code/next:scripts/boundary-allowlist.json > "$RUNNER_TEMP/boundary-allowlist.json"');
    // and it fails closed: no `|| cp` falls back to the checkout's own copy of the data
    expect(run).not.toMatch(/boundary-allowlist\.json[^\n]*\|\|/);
    expect(run).not.toMatch(/cp scripts\/boundary-allowlist/);
    expect(run).not.toMatch(/cp scripts\/port-guard/);
    // the accepted findings travel from code/next the same way, never from the pull request's checkout
    expect(run).toContain('git show origin/code/next:scripts/port-guard-accepted.json > "$RUNNER_TEMP/port-guard-accepted.json"');
    expect(run).not.toMatch(/--accepted/);
    expect(run).not.toMatch(/port-guard\.ts"? *\|\|/);
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(JSON.stringify(job)).not.toContain("secrets.");
    // the downloaded scanner is pinned by version and checked against a checksum before it runs
    expect(run).toMatch(/gitleaks\/releases\/download\/v\d+\.\d+\.\d+\//);
    // #1200: the arm64 or the x64 build, for the runner, each with its pinned checksum.
    expect(run).toMatch(/arch=arm64; sum=[0-9a-f]{64}; else arch=x64; sum=[0-9a-f]{64}; fi/);
    expect(run).toContain('echo "${sum}  $RUNNER_TEMP/gitleaks.tar.gz" | sha256sum --check -');
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

  it("plans the device emulator job like linux-runtime, keeps it out of the local gate until its first run has been read, and gives it no secret, no token and no permission beyond the workflow's contents: read (DEC 248)", async () => {
    const { jobs, permissions } = await workflow();
    const job = jobs["device-runtime"]!;
    expect(job.needs).toBe("plan");
    expect(job.if).toBe("needs.plan.outputs.device == 'true'");
    // quarantine (DEC 254zn): non-blocking unless the change touches device files
    expect((job as { "continue-on-error"?: string })["continue-on-error"]).toBe("${{ needs.plan.outputs.device_required != 'true' }}");
    expect(jobs["linux-runtime"]!.if).toBe("needs.plan.outputs.linux == 'true'");
    expect(jobs.local!.needs).not.toContain("device-runtime");
    expect(permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|GITHUB_TOKEN|docker login|id-token|aws-actions|AWS_/u);
    const runs = job.steps.map((step) => step.run ?? "").join("\n");
    expect(runs).toContain("node scripts/ci-images.ts pull --github-env node-build");
    expect(job.steps.map((step) => step.run).filter((run) => run?.includes("vitest"))).toEqual(['JAVA_HOME="$JAVA_HOME_17_X64" npx vitest run tests/linux/device-evidence-emulator.test.ts']);
    // the ARM Linux job leaves the emulator test to this one
    expect(jobs["linux-runtime"]!.steps.map((step) => step.run ?? "").join("\n")).toContain("--exclude tests/linux/device-evidence-emulator.test.ts");
  });
});
