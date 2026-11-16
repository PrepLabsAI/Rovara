import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { GATED_JOBS, gateVerdict, needsVerdict } from "../../scripts/ci-gate.js";

interface Job {
  name?: string;
  permissions?: unknown;
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: number;
  strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
  steps: Array<{ id?: string; name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; "timeout-minutes"?: number }>;
}
interface Workflow {
  on?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: string | boolean };
  jobs: Record<string, Job>;
}

const workflow = async () => YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;

describe("CI runs its checks side by side (a Markdown-only change skips them all)", () => {
  it("splits the tests across shards that each run on their own machine, and a failing shard does not hide the others", async () => {
    const test = (await workflow()).jobs.test!;
    expect(test.strategy?.["fail-fast"]).toBe(false);
    expect(test.strategy?.matrix?.shard).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(test.steps.some((step) => step.run === "npm test -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}")).toBe(true);
  });

  it("keeps the quick checks, the tests and the Linux runtime check in jobs of their own, none waiting on another (only the gate waits), and no job left over from before", async () => {
    const { jobs } = await workflow();
    expect(Object.keys(jobs).sort()).toEqual(["linux-runtime", "live-aws", "local", "port-guard", "quick", "test"]);
    for (const [name, job] of Object.entries(jobs)) if (name !== "local") expect(job.needs, name).toBeUndefined();
  });

  it("puts the old scope, checks and release jobs into `quick`, one after another with their own commands, conditions and time limits, on one checkout and one install", async () => {
    const quick = (await workflow()).jobs.quick! as Job & { "runs-on"?: string };
    expect(quick["runs-on"]).toBe("ubuntu-latest");
    // Read-only like the workflow's default: no permissions of its own, so nothing the merged jobs lacked.
    expect(quick.permissions).toBeUndefined();
    expect(JSON.stringify(quick)).not.toContain("secrets.");
    expect(quick.steps.filter((step) => (step.uses ?? "").startsWith("actions/checkout"))).toHaveLength(1);
    expect(quick.steps.filter((step) => step.run === "npm ci" || step.name === "checks: npm ci")).toHaveLength(1);
    const GUARD = "steps.scope.outputs.docs_only != 'true'";
    const parts = quick.steps.filter((step) => step.run !== undefined).map((step) => [step.name, step.if, step["timeout-minutes"], step.run] as const);
    expect(parts).toEqual([
      ["scope: Docs-only change?", "github.event_name == 'pull_request'", 5, expect.stringContaining("node scripts/ci-docs-only.ts")],
      ["scope: Markdown-only change", "steps.scope.outputs.docs_only == 'true'", 5, expect.stringContaining("Only Markdown that no test reads changed")],
      ["checks: npm ci", GUARD, 15, "npm ci"],
      ["checks: npm run typecheck", GUARD, 15, "npm run typecheck"],
      ["checks: npm run typecheck:all", GUARD, 15, "npm run typecheck:all"],
      ["checks: npm run lint", GUARD, 15, "npm run lint"],
      ["release: npm run build", GUARD, 15, "npm run build"],
      ["release: npm run infra:synth", GUARD, 15, "npm run infra:synth"],
      ["release: Release builds are reproducible", GUARD, 15, expect.stringContaining("npm run release:verify -- \"$RUNNER_TEMP/release-a\"")],
    ]);
    // The job's own limit is the sum of the old jobs' (scope 5 + checks 15 + release 15), and each step may take at most its old job's limit.
    expect(quick["timeout-minutes"]).toBe(35);
  });

  it("runs the Linux runtime check on an ARM64 runner, behind the same Markdown-only skip as the other heavy jobs", async () => {
    const job = (await workflow()).jobs["linux-runtime"] as Job & { "runs-on"?: string };
    expect(job["runs-on"]).toBe("ubuntu-24.04-arm");
    expect(job.if).toBe("github.event.pull_request.draft != true");
    // Every step after the docs-only check carries its condition, so a Markdown-only change leaves this job green with its steps skipped.
    const afterScope = job.steps.slice(job.steps.findIndex((step) => step.id === "scope") + 1);
    expect(afterScope.length).toBeGreaterThan(10);
    for (const step of afterScope) expect(step.if, step.name ?? step.run).toBe("steps.scope.outputs.docs_only != 'true'");
    const run = job.steps.map((step) => step.run ?? "").join("\n");
    // The job installs the firewall by running the heredoc inside boot.sh as it is (never a copy of the rules), before anything builds or runs a container.
    const firewall = job.steps.map((step) => step.run ?? "").find((text) => text.includes("<<'FIREWALL'"))!;
    expect(firewall).toContain("packages/worker/ec2/boot.sh");
    expect(firewall).toContain("sudo bash");
    expect(firewall).not.toContain("iptables -I");
    expect(run.indexOf("<<'FIREWALL'")).toBeGreaterThanOrEqual(0);
    expect(run.indexOf("<<'FIREWALL'")).toBeLessThan(run.indexOf('docker build -f "$RUNNER_TEMP/e2e-executor.Dockerfile" -t rovara-e2e-executor:ci .'));
    // The Dockerfile it builds is the e2e-executor one with its FROM lines pointed at the pulled copy of the same digest (tests/contract/ci-images.test.ts).
    expect(run).toContain('node scripts/ci-images.ts dockerfile environments/e2e-executor/Dockerfile "$RUNNER_TEMP/e2e-executor.Dockerfile"');
    // The smoke check is the shared definition in scripts/executor-smoke.ts (the one the release path and test-deploy use), never a copy of its flags: it runs after
    // `npm ci` and `npm run build`, which the script needs, and before the Linux tests.
    const smoke = run.split("\n").find((line) => line.includes("executor-smoke.ts"))!;
    expect(smoke.trim()).toBe("npx tsx scripts/executor-smoke.ts rovara-e2e-executor:ci");
    expect(run).not.toMatch(/executor\/smoke\.js|seccomp=|--cap-drop|--read-only/);
    expect(run.indexOf("npm ci")).toBeLessThan(run.indexOf("executor-smoke.ts"));
    expect(run.indexOf("npm run build")).toBeLessThan(run.indexOf("executor-smoke.ts"));
    expect(run.indexOf("executor-smoke.ts")).toBeLessThan(run.indexOf("npx vitest run tests/linux"));
    expect(run).not.toMatch(/seccomp=unconfined|--privileged|--cap-add|--no-sandbox/);
    expect(run).toContain("npx vitest run tests/linux");
  });

  it("runs the Docker 25 DNS regression test once, in its own step under the same gate as the other Linux tests, and keeps it out of the generic step", async () => {
    const job = (await workflow()).jobs["linux-runtime"] as Job & { steps: { name?: string; run?: string; env?: Record<string, string> }[] };
    const generic = job.steps.find((step) => (step.run ?? "").startsWith("npx vitest run tests/linux"))!;
    expect(generic.run).toContain("--exclude tests/linux/e2e-docker25-dns.test.ts");
    // Task 4.3a: the model channel test has a step of its own too (it builds a derived executor image), so the generic step does not run it a second time.
    expect(generic.run).toContain("--exclude tests/linux/e2e-model-channel.test.ts");
    // Task 4.3b: the agent step tests (twenty real runs of one case among them) have a step of their own, so the generic step does not run them a second time.
    expect(generic.run).toContain("--exclude tests/linux/e2e-agent.test.ts");
    // Task 4.5: the three agent qualification probes (real runs of the scripted model behind the production probe runner) have a step of their own as well.
    expect(generic.run).toContain("--exclude tests/linux/e2e-agent-probes.test.ts");
    const agentProbes = job.steps.find((candidate) => (candidate.run ?? "").includes("tests/linux/e2e-agent-probes.test.ts") && candidate !== generic)!;
    expect(agentProbes.run).toBe("npx vitest run tests/linux/e2e-agent-probes.test.ts");
    expect(agentProbes.name).toMatch(/Agent qualification probes/);
    expect(agentProbes.env).toEqual({ ROVARA_DOCKER: "1", ROVARA_EXECUTOR_IMAGE: "rovara-e2e-executor:ci" });
    const agent = job.steps.find((candidate) => (candidate.run ?? "").includes("tests/linux/e2e-agent.test.ts") && candidate !== generic)!;
    expect(agent.run).toBe("npx vitest run tests/linux/e2e-agent.test.ts");
    expect(agent.name).toMatch(/Agent steps/);
    expect(agent.env).toEqual({ ROVARA_DOCKER: "1", ROVARA_EXECUTOR_IMAGE: "rovara-e2e-executor:ci" });
    const journeys = job.steps.find((candidate) => (candidate.run ?? "").includes("tests/e2e/m1-4-journeys.test.ts"))!;
    expect(journeys.run).toBe("npx vitest run --config vitest.native-p0.config.ts tests/e2e/m1-4-journeys.test.ts");
    expect(journeys.env).toEqual({ ROVARA_DOCKER: "1", ROVARA_EXECUTOR_IMAGE: "rovara-e2e-executor:ci" });
    const model = job.steps.find((candidate) => (candidate.run ?? "").includes("tests/linux/e2e-model-channel.test.ts") && candidate !== generic)!;
    expect(model.run).toBe("npx vitest run tests/linux/e2e-model-channel.test.ts");
    expect(model.name).toMatch(/Model channel/);
    expect(model.env).toEqual({ ROVARA_DOCKER: "1", ROVARA_EXECUTOR_IMAGE: "rovara-e2e-executor:ci" });
    const order = job.steps.map((candidate) => candidate.run ?? "");
    expect(order.indexOf(model.run!)).toBeGreaterThan(order.indexOf(generic.run!));
    const step = job.steps.find((candidate) => (candidate.run ?? "").includes("tests/linux/e2e-docker25-dns.test.ts") && candidate !== generic)!;
    expect(step.run).toBe("npx vitest run tests/linux/e2e-docker25-dns.test.ts");
    expect(step.name).toMatch(/Docker 25/);
    expect(step.env).toEqual({ ROVARA_DOCKER: "1", ROVARA_EXECUTOR_IMAGE: "rovara-e2e-executor:ci" });
    const steps = job.steps.map((candidate) => candidate.run ?? "");
    expect(steps.indexOf(step.run!)).toBeGreaterThan(steps.indexOf(generic.run!));
    // It starts its own Docker 25 (Docker in Docker); the runner's daemon, iptables and sysctls are what the other steps set up and are not touched by it.
    const test = readFileSync("tests/linux/e2e-docker25-dns.test.ts", "utf8");
    expect(readFileSync("tests/support/linux-dind.ts", "utf8")).toMatch(/"public\.ecr\.aws\/docker\/library\/docker:25\.0\.5-dind@sha256:[0-9a-f]{64}"/);
    expect(test).toContain('describe.runIf(process.env.ROVARA_DOCKER === "1")');
  });

  it("smoke-tests the executor image from CI and from the release path through one definition, with the production sandbox flags", async () => {
    const shared = readFileSync("scripts/executor-smoke.ts", "utf8");
    // The smoke command takes its sandbox and limit flags from the verifier's executor definition (what the Docker host builds its executor command from) and
    // checks the profile with the host's own verification; it adds only the network and the run-and-remove flags.
    expect(shared).toContain("executorContainerArgs(verifyExecutorSeccompProfile(profilePath))");
    expect(shared).toContain('"--network", "none"');
    expect(shared).not.toMatch(/--cap-drop|seccomp=|--read-only/);
    const container = readFileSync("packages/verifier/src/host/executor-container.ts", "utf8");
    for (const flag of ["--init", "--cap-drop=ALL", "no-new-privileges", "seccomp=${seccompProfile}", "--read-only", "--tmpfs", "--memory", "--pids-limit", "--cpus"]) expect(container, flag).toContain(flag);
    expect(readFileSync("packages/verifier/src/host/docker-application-host.ts", "utf8")).toContain("...executorContainerArgs(seccompProfile)");
    // The release path (and so test-deploy, which takes smokeTestExecutor from it) builds its command from that definition and spells no flags of its own.
    const release = readFileSync("scripts/release-common.ts", "utf8");
    const body = release.slice(release.indexOf("export async function smokeTestExecutor"), release.indexOf("export async function smokeTestWorker"));
    expect(body).toContain("executorSmokeDockerArgs(image)");
    expect(body).not.toMatch(/--network|--cap-drop|seccomp|smoke\.js/);
    // The production release loads release-common.ts before it builds, and the smoke module reads the built contracts.
    expect(release).not.toMatch(/^import .*executor-smoke/m);
    expect(readFileSync("scripts/test-deploy.ts", "utf8")).toContain("smokeTest: smokeTestExecutor");
  });

  it("lets the Ubuntu runner create unprivileged user namespaces for Chromium's sandbox before it builds or runs a container, and says production does not need that", async () => {
    const job = (await workflow()).jobs["linux-runtime"] as Job;
    const step = job.steps.find((candidate) => (candidate.run ?? "").includes("apparmor_restrict_unprivileged_userns"))!;
    expect(step.run).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
    expect(step.run).toContain("Amazon Linux 2023");
    const run = job.steps.map((candidate) => candidate.run ?? "").join("\n");
    expect(run.indexOf("apparmor_restrict_unprivileged_userns")).toBeLessThan(run.indexOf("docker build -f"));
  });

  it("gives every job but the manual live-AWS one a time limit, so a hung runner fails in minutes and not after six hours", async () => {
    const { jobs } = await workflow();
    for (const [name, job] of Object.entries(jobs)) {
      if (name !== "live-aws") expect(job["timeout-minutes"], name).toBeGreaterThan(0);
    }
  });

  it("runs on pull requests and by hand, on a push to code/next only and never on a push to mainline, and skips a draft until it is ready", async () => {
    const parsed = await workflow();
    expect(parsed.on).toEqual({
      workflow_dispatch: null,
      pull_request: { types: ["opened", "synchronize", "reopened", "ready_for_review"] },
      push: { branches: ["code/next"] },
    });
    for (const name of ["quick", "test", "linux-runtime"]) expect(parsed.jobs[name]!.if, name).toBe("github.event.pull_request.draft != true");
  });

  it("supersedes a pull request's run in progress when it is pushed again, and never cancels a manual run", async () => {
    const { concurrency } = await workflow();
    expect(concurrency?.group).toContain("github.ref");
    expect(concurrency?.["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it("reports one check called local that waits for quick, the shards and the Linux runtime check, so it cannot go green while one is missing", async () => {
    const { jobs } = await workflow();
    const gate = jobs.local!;
    expect(gate.name).toBeUndefined();
    expect(gate.if).toBe("always() && github.event.pull_request.draft != true");
    // port-guard (the Rovara Code port's check, tests/contract/port-guard-ci.test.ts) runs on code/next only; a skipped job would fail the gate on mainline's pull requests.
    const others = Object.keys(jobs).filter((name) => name !== "local" && name !== "live-aws" && name !== "port-guard").sort();
    expect([...(gate.needs as string[])].sort()).toEqual(others);
    expect([...(gate.needs as string[])].sort()).toEqual([...GATED_JOBS].sort());
    expect(gate["timeout-minutes"]).toBe(5);
    const run = gate.steps.map((step) => step.run ?? "").join("\n");
    expect(run).toContain("node scripts/ci-gate.ts");
    expect(gate.steps.some((step) => step.env?.NEEDS === "${{ toJSON(needs) }}")).toBe(true);
  });
});

describe("the gate behind the local check", () => {
  const ran = { quick: "success", test: "success", "linux-runtime": "success" };

  it("passes when every job succeeded", () => {
    expect(gateVerdict({ docsOnly: false, results: ran }).ok).toBe(true);
  });

  it("fails when any job failed, was cancelled or was skipped", () => {
    for (const result of ["failure", "cancelled", "skipped"]) {
      for (const job of GATED_JOBS) {
        expect(gateVerdict({ docsOnly: false, results: { ...ran, [job]: result } }), `${job} ${result}`).toEqual({ ok: false, reason: `${job} was ${result}, not success` });
      }
    }
  });

  it("passes a Markdown-only change only when every job succeeded (their heavy steps are skipped inside the jobs)", () => {
    expect(gateVerdict({ docsOnly: true, results: ran })).toEqual({ ok: true, reason: "Markdown-only change; every job succeeded with its heavy steps skipped" });
    expect(gateVerdict({ docsOnly: true, results: { ...ran, test: "skipped" } }).ok).toBe(false);
    expect(gateVerdict({ docsOnly: true, results: { ...ran, quick: "failure" } }).ok).toBe(false);
  });

  it("fails a gate that is missing a job it should judge", () => {
    expect(gateVerdict({ docsOnly: false, results: { quick: "success" } })).toEqual({ ok: false, reason: "test was missing" });
    expect(gateVerdict({ docsOnly: false, results: {} }).ok).toBe(false);
    expect(gateVerdict({ docsOnly: false, results: { test: "success", "linux-runtime": "success" } })).toEqual({ ok: false, reason: "quick was missing" });
  });

  it("reads the needs context GitHub provides", () => {
    const needs = JSON.stringify({
      quick: { result: "success", outputs: { docs_only: "false" } },
      test: { result: "success", outputs: {} },
      "linux-runtime": { result: "success", outputs: {} },
    });
    expect(needsVerdict(needs)).toEqual({ ok: true, reason: "3 jobs succeeded" });
    const markdownOnly = JSON.stringify({
      quick: { result: "success", outputs: { docs_only: "true" } },
      test: { result: "success", outputs: {} },
      "linux-runtime": { result: "success", outputs: {} },
    });
    expect(needsVerdict(markdownOnly).reason).toMatch(/^Markdown-only change/);
    const manualRun = JSON.stringify({
      quick: { result: "success", outputs: {} },
      test: { result: "success", outputs: {} },
      "linux-runtime": { result: "success", outputs: {} },
    });
    expect(needsVerdict(manualRun).ok).toBe(true);
    expect(needsVerdict("not json").ok).toBe(false);
    expect(needsVerdict(JSON.stringify({ quick: { result: "success", outputs: {} } })).ok).toBe(false);
  });
});
