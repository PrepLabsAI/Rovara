import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { GATED_JOBS } from "../../scripts/ci-gate.js";

interface Job {
  name?: string;
  permissions?: unknown;
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: number;
  strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] | string } };
  steps: Array<{ id?: string; name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; "timeout-minutes"?: number }>;
}
interface Workflow {
  on?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: string | boolean };
  jobs: Record<string, Job>;
}

const workflow = async () => YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;

describe("CI runs its checks side by side, as the plan says (a Markdown-only change skips them all)", () => {
  it("has the jobs of the plan-driven CI, each waiting only on the plan (and the build, for the tests), and no job left over from before", async () => {
    const { jobs } = await workflow();
    expect(Object.keys(jobs).sort()).toEqual(["build", "ci-mode", "device-runtime", "linux-runtime", "live-aws", "local", "plan", "port-guard", "quick", "test"]);
    expect(jobs.plan!.needs).toBeUndefined();
    for (const name of ["ci-mode", "quick", "build", "linux-runtime", "device-runtime"]) expect(jobs[name]!.needs, name).toBe("plan");
    expect(jobs.test!.needs).toEqual(["plan", "build"]);
    expect(jobs["port-guard"]!.needs).toBeUndefined();
  });

  it("puts the old scope, checks and release jobs into `quick`: one after another with their own commands, conditions and time limits, on one checkout and one install", async () => {
    const quick = (await workflow()).jobs.quick! as Job & { "runs-on"?: string };
    expect(quick["runs-on"]).toBe("ubuntu-latest");
    // Read-only like the workflow's default: no permissions of its own, so nothing the merged jobs lacked.
    expect(quick.permissions).toBeUndefined();
    expect(JSON.stringify(quick)).not.toContain("secrets.");
    // A Markdown-only change (the plan says so) skips the job whole; a manual run and a push never do.
    expect(quick.if).toBe("needs.plan.outputs.docs_only != 'true'");
    expect(quick.steps.filter((step) => (step.uses ?? "").startsWith("actions/checkout"))).toHaveLength(1);
    expect(quick.steps.filter((step) => step.name === "checks: npm ci")).toHaveLength(1);
    const parts = quick.steps.filter((step) => step.run !== undefined).map((step) => [step.name, step.if, step["timeout-minutes"], step.run] as const);
    expect(parts).toEqual([
      ["checks: npm ci", undefined, 15, "npm ci"],
      ["checks: npm run typecheck", undefined, 15, "npm run typecheck"],
      ["checks: npm run typecheck:all", undefined, 15, "npm run typecheck:all"],
      ["checks: npm run lint", "needs.plan.outputs.lint == 'all'", 15, "npm run lint"],
      ["checks: lint the changed files", "needs.plan.outputs.lint == 'changed'", 15, expect.stringContaining('node scripts/lint-shards.ts --files "$RUNNER_TEMP/changed.txt"')],
      ["release: npm run build", "needs.plan.outputs.release == 'true'", 15, "npm run build"],
      ["release: npm run infra:synth", "needs.plan.outputs.release == 'true'", 15, "npm run infra:synth"],
      ["release: Release builds are reproducible", "needs.plan.outputs.release == 'true'", 15, expect.stringContaining("npm run release:verify -- \"$RUNNER_TEMP/release-a\"")],
    ]);
    // The job's own limit is the sum of the old jobs' (scope 5 + checks 15 + release 15), and each step may take at most its old job's limit.
    expect(quick["timeout-minutes"]).toBe(35);
  });

  it("builds once in its own job and hands the output to the test shards as an artifact, instead of each shard building", async () => {
    const { jobs } = await workflow();
    const build = jobs.build!;
    expect(build.if).toBe("needs.plan.outputs.tests != 'none'");
    expect(build.steps.map((step) => step.run).filter(Boolean)).toContain("npm run build");
    expect(build.steps.some((step) => (step.uses ?? "").startsWith("actions/upload-artifact@"))).toBe(true);
    const test = jobs.test!;
    expect(test.steps.some((step) => (step.uses ?? "").startsWith("actions/download-artifact@"))).toBe(true);
    expect(test.steps.every((step) => step.run !== "npm run build")).toBe(true);
    // The artifact is unpacked before any test runs.
    const order = test.steps.map((step) => step.name ?? step.uses ?? step.run ?? "");
    expect(order.indexOf("Unpack the build output")).toBeGreaterThan(-1);
    expect(order.indexOf("Unpack the build output")).toBeLessThan(order.findIndex((name) => name.startsWith("Tests (")));
  });

  it("runs the whole suite in the shards of a full run and only the tests a change can reach otherwise, from the plan", async () => {
    const test = (await workflow()).jobs.test as Job & { strategy: { matrix: { shard: string } } };
    expect(test.strategy["fail-fast"]).toBe(false);
    expect(test.strategy.matrix.shard).toBe("${{ fromJSON(needs.plan.outputs.shards) }}");
    const all = test.steps.find((step) => step.name === "Tests (the whole suite)")!;
    expect(all.if).toBe("needs.plan.outputs.tests == 'all'");
    // #1200: $AS_TESTER is empty on GitHub's runner and drops root to an ordinary account on CodeBuild's.
    expect(all.run).toBe("$AS_TESTER npm test -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}");
    const changed = test.steps.find((step) => step.name === "Tests (the ones this change can reach)")!;
    expect(changed.if).toBe("needs.plan.outputs.tests == 'changed'");
    expect(changed.run).toContain("$AS_TESTER npm test -- --changed HEAD^1 --passWithNoTests --shard=${{ matrix.shard }}/${{ strategy.job-total }}");
    expect(changed.run).toContain("xargs $AS_TESTER npm test -- --passWithNoTests --shard=${{ matrix.shard }}/${{ strategy.job-total }}");
  });

  // #1200: a pull request into mainline from this repository runs its shards on the account's CodeBuild runner (infra/lib/ci-runner.ts); a fork's and
  // every other run use GitHub's free runner. The tests run as an ordinary account there, since CodeBuild runs the job as root.
  it("runs the shards of a same-repository pull request into mainline on the CodeBuild runner, as an ordinary account, and everything else on GitHub's", async () => {
    const test = (await workflow()).jobs.test as Job & { "runs-on"?: string };
    expect(test["runs-on"]).toBe("${{ (github.event_name == 'pull_request' && github.base_ref == 'mainline' && github.event.pull_request.head.repo.full_name == github.repository) && format('codebuild-rovara-ci-tests-{0}-{1}', github.run_id, github.run_attempt) || 'ubuntu-latest' }}");
    const order = test.steps.map((step) => step.name ?? step.uses ?? "");
    const asTester = test.steps.find((step) => step.name === "Run the tests as an ordinary account (CodeBuild only)")!;
    expect(order.indexOf(asTester.name!)).toBeGreaterThan(order.indexOf("Unpack the build output"));
    expect(order.indexOf(asTester.name!)).toBeLessThan(order.findIndex((name) => name.startsWith("Tests (")));
    expect(asTester.run).toContain('if [ "$(id -u)" != 0 ]; then exit 0; fi');
    expect(asTester.run).toContain("AS_TESTER=setpriv --reuid=65534 --regid=65534 --clear-groups");
    const gitleaks = test.steps.find((step) => step.name === "Install gitleaks 8.30.1 (checksum pinned)")!;
    expect(gitleaks.run).toContain("gitleaks_8.30.1_linux_${arch}.tar.gz");
    // Every other job stays on GitHub's runners.
    for (const [name, job] of Object.entries((await workflow()).jobs)) {
      if (name !== "test") expect(String((job as { "runs-on"?: string })["runs-on"]), name).not.toContain("codebuild");
    }
  });

  it("reports a check called `ci-mode (full)` only in a full run, for the merge to require", async () => {
    const mode = (await workflow()).jobs["ci-mode"]!;
    expect(mode.name).toBe("ci-mode (full)");
    expect(mode.if).toBe("needs.plan.outputs.mode == 'full'");
  });

  it("makes the plan the first job: from the event, the labels, the title and the changed files, with no install", async () => {
    const { jobs } = await workflow();
    const plan = jobs.plan!;
    expect(plan.if).toBe("github.event.pull_request.draft != true");
    expect(plan.steps.every((step) => step.run !== "npm ci")).toBe(true);
    const step = plan.steps.find((candidate) => candidate.id === "plan")!;
    expect(step.env).toEqual({
      CI_EVENT: "${{ github.event_name }}",
      CI_LABELS: "${{ toJSON(github.event.pull_request.labels.*.name) }}",
      CI_TITLE: "${{ github.event.pull_request.title }}",
      CI_FORCE_LINUX: "${{ github.event.inputs.linux }}",
      CI_BASE_REF: "${{ github.base_ref }}",
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    });
    expect(step.run).toContain("git diff --name-only HEAD^1 HEAD");
    expect(step.run).toContain('node "$PLAN_SCRIPT"');
    // Untrusted text (the title) reaches the script through the environment, never spliced into the shell.
    expect(step.run).not.toContain("github.event.pull_request.title");
  });

  it("runs the Linux runtime check on an ARM64 runner, behind the same Markdown-only skip as the other heavy jobs", async () => {
    const job = (await workflow()).jobs["linux-runtime"] as Job & { "runs-on"?: string };
    expect(job["runs-on"]).toBe("ubuntu-24.04-arm");
    // Only when the plan says its area changed (always in a full run).
    expect(job.if).toBe("needs.plan.outputs.linux == 'true'");
    expect(job.steps.every((step) => step.if === undefined)).toBe(true);
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
    // L4-NETG: the sandbox-egress boot stage restarts Docker and walls docker0, so it never runs beside another Linux test file: out of the generic step, in a step of its own that comes after every other Docker step of the job.
    expect(generic.run).toContain("--exclude tests/linux/worker-sandbox-egress.test.ts");
    const egress = job.steps.find((candidate) => (candidate.run ?? "").includes("tests/linux/worker-sandbox-egress.test.ts") && candidate !== generic)!;
    expect(egress.run).toBe("npx vitest run tests/linux/worker-sandbox-egress.test.ts");
    expect(egress.name).toMatch(/Sandbox egress gateway/);
    expect(egress.env).toEqual({ ROVARA_DOCKER: "1", ROVARA_EXECUTOR_IMAGE: "rovara-e2e-executor:ci" });
    // It only isolates: no step is removed or made optional, and the generic step still runs every other Linux test.
    expect(job.steps.some((candidate) => (candidate as { "continue-on-error"?: unknown })["continue-on-error"] !== undefined)).toBe(false);
    expect(job.steps.indexOf(egress)).toBe(job.steps.length - 1);
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
      // #1185: a manual run may ask for the Linux runtime check; the nightly schedule runs it on mainline.
      workflow_dispatch: { inputs: { linux: { description: "Also run the Linux runtime check (#1185)", type: "boolean", default: false } } },
      pull_request: { types: ["opened", "synchronize", "reopened", "ready_for_review", "labeled"] },
      push: { branches: ["code/next"] },
      schedule: [{ cron: "0 6 * * *" }],
    });
    // Every job but the plan hangs off it (or the gate does), so a draft's skipped plan skips them all.
    expect(parsed.jobs.plan!.if).toBe("github.event.pull_request.draft != true");
  });

  it("supersedes a pull request's run in progress when it is pushed again, and never cancels a manual run", async () => {
    const { concurrency } = await workflow();
    expect(concurrency?.group).toContain("github.ref");
    expect(concurrency?.["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it("reports one check called local that waits for every other job, so it cannot go green while one is missing", async () => {
    const { jobs } = await workflow();
    const gate = jobs.local!;
    expect(gate.name).toBeUndefined();
    expect(gate.if).toBe("always() && github.event.pull_request.draft != true");
    // port-guard (the Rovara Code port's check, tests/contract/port-guard-ci.test.ts) runs on code/next only; a skipped job would fail the gate on mainline's pull requests.
    // device-runtime (DEC 244, tests/contract/device-executor-image.test.ts) is informational until its first real run has been read, so the gate does not wait for it yet.
    const others = Object.keys(jobs).filter((name) => name !== "local" && name !== "live-aws" && name !== "port-guard" && name !== "device-runtime").sort();
    expect([...(gate.needs as string[])].sort()).toEqual(others);
    expect([...(gate.needs as string[])].sort()).toEqual(["plan", ...GATED_JOBS].sort());
    expect(gate["timeout-minutes"]).toBe(5);
    const run = gate.steps.map((step) => step.run ?? "").join("\n");
    expect(run).toContain('node "$GATE_SCRIPT"');
    expect(gate.steps.some((step) => step.env?.NEEDS === "${{ toJSON(needs) }}")).toBe(true);
  });
});

describe("on a pull request CI judges the change with the base branch's plan and gate, never the pull request's own copy (DEC 242 follow-up)", () => {
  const BASE = "${{ github.event.pull_request.base.sha }}";

  /** Every step that runs the plan or the gate script, with the job it is in. */
  async function runners(script: "ci-plan.ts" | "ci-gate.ts") {
    const { jobs } = await workflow();
    return Object.entries(jobs).flatMap(([job, { steps }]) => steps.filter((step) => (step.run ?? "").includes(script)).map((step) => ({ job, step })));
  }

  it("takes ci-plan.ts from the base sha in the plan job and in the test shards' related-tests step, on pull requests only", async () => {
    const found = await runners("ci-plan.ts");
    expect(found.map(({ job }) => job).sort()).toEqual(["plan", "test"]);
    for (const { job, step } of found) {
      expect(step.env?.BASE_SHA, job).toBe(BASE);
      expect(step.env?.CI_EVENT, job).toBe("${{ github.event_name }}");
      const run = step.run!;
      expect(run, job).toContain('if [ "$CI_EVENT" = pull_request ]; then');
      expect(run, job).toContain('git fetch --no-tags --depth=1 origin "$BASE_SHA"');
      expect(run, job).toContain('git show "$BASE_SHA:scripts/ci-plan.ts" > "$PLAN_SCRIPT"');
      // The checkout's copy is the default only: a push or a manual run has no base sha.
      expect(run, job).toContain("PLAN_SCRIPT=scripts/ci-plan.ts");
      expect(run, job).toContain('node "$PLAN_SCRIPT"');
      // No run of the pull request's own copy is left.
      expect(run.replace(/^\s*#.*$/gm, ""), job).not.toMatch(/node\s+scripts\/ci-plan\.ts/);
      // The base copy is read before the script runs.
      expect(run.indexOf("git show"), job).toBeLessThan(run.indexOf('node "$PLAN_SCRIPT"'));
    }
  });

  it("takes ci-gate.ts from the base sha in the local job, on pull requests only", async () => {
    const found = await runners("ci-gate.ts");
    expect(found.map(({ job }) => job)).toEqual(["local"]);
    const { step } = found[0]!;
    expect(step.env?.BASE_SHA).toBe(BASE);
    expect(step.env?.CI_EVENT).toBe("${{ github.event_name }}");
    expect(step.env?.NEEDS).toBe("${{ toJSON(needs) }}");
    const run = step.run!;
    expect(run).toContain('if [ "$CI_EVENT" = pull_request ]; then');
    expect(run).toContain('git fetch --no-tags --depth=1 origin "$BASE_SHA"');
    expect(run).toContain('git show "$BASE_SHA:scripts/ci-gate.ts" > "$GATE_SCRIPT"');
    expect(run).toContain("GATE_SCRIPT=scripts/ci-gate.ts");
    expect(run.replace(/^\s*#.*$/gm, "")).not.toMatch(/node\s+scripts\/ci-gate\.ts/);
    expect(run.indexOf("git show")).toBeLessThan(run.indexOf('node "$GATE_SCRIPT"'));
  });

  it("falls back to the checkout's copy only when the base branch does not have the script at all, which a pull request cannot arrange", async () => {
    for (const [script, name] of [["ci-plan.ts", "plan"], ["ci-gate.ts", "local"]] as const) {
      const run = (await runners(script)).find(({ job }) => job === name)!.step.run!;
      expect(run).toContain(`git cat-file -e "$BASE_SHA:scripts/${script}"`);
    }
  });
});
