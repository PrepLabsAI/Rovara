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
    expect(Object.keys(jobs).sort()).toEqual(["build", "ci-mode", "device-runtime", "linux-runtime", "live-aws", "local", "nightly-tests", "plan", "port-guard", "quick", "release-check", "test", "typecheck"]);
    expect(jobs.plan!.needs).toBeUndefined();
    for (const name of ["ci-mode", "quick", "typecheck", "build", "linux-runtime", "device-runtime", "release-check"]) expect(jobs[name]!.needs, name).toBe("plan");
    expect(jobs.test!.needs).toEqual(["plan", "build"]);
    expect(jobs["port-guard"]!.needs).toBeUndefined();
    expect(jobs["nightly-tests"]!.needs).toBeUndefined();
  });

  it("runs the nightly-only tests once a night, and in a pull request only when its change reaches them", async () => {
    const { jobs } = await workflow();
    const nightly = jobs["nightly-tests"]!;
    expect(nightly.if).toBe("github.event_name == 'schedule'");
    expect(nightly.steps.map((step) => step.run ?? "").join("\n")).toContain("npm run test:nightly");
    const changed = jobs.test!.steps.find((step) => step.name === "Tests (the ones this change can reach)")!;
    expect(changed.env?.ROVARA_NIGHTLY_TESTS).toBe("1");
    for (const step of jobs.test!.steps.filter((item) => item.name !== changed.name)) expect(step.env?.ROVARA_NIGHTLY_TESTS, step.name).toBeUndefined();
  });

  it("puts the checks into `quick`: one after another with their own commands, conditions and time limits, on one checkout and one install", async () => {
    const quick = (await workflow()).jobs.quick! as Job & { "runs-on"?: string };
    expect(quick["runs-on"]).toBe("ubuntu-latest");
    // Read-only like the workflow's default: no permissions of its own, so nothing the merged jobs lacked.
    expect(quick.permissions).toBeUndefined();
    expect(JSON.stringify(quick)).not.toContain("secrets.");
    // A Markdown-only change (the plan says so) skips the job whole; a manual run and a push never do.
    // #1262: a merge-queue reuse stands on the pull request's own pass, so it skips the checks too.
    expect(quick.if).toBe("needs.plan.outputs.docs_only != 'true' && needs.plan.outputs.mode != 'reuse'");
    expect(quick.steps.filter((step) => (step.uses ?? "").startsWith("actions/checkout"))).toHaveLength(1);
    expect(quick.steps.filter((step) => step.name === "checks: npm ci")).toHaveLength(1);
    const parts = quick.steps.filter((step) => step.run !== undefined).map((step) => [step.name, step.if, step["timeout-minutes"], step.run] as const);
    expect(parts).toEqual([
      ["checks: npm ci", undefined, 15, "npm ci"],
      ["checks: npm run build", undefined, 15, "npm run build"],
      ["checks: npm run lint", "needs.plan.outputs.lint == 'all'", 15, "npm run lint"],
      ["checks: lint the changed files", "needs.plan.outputs.lint == 'changed'", 15, expect.stringContaining('node scripts/lint-shards.ts --files "$RUNNER_TEMP/changed.txt"')],
      // #1294: the complexity ratchet, on every run that has checks (it parses only, a few seconds).
      ["checks: complexity ratchet", undefined, 5, "node scripts/complexity.ts check"],
    ]);
    // The type check and the release check are jobs of their own (below).
    expect(quick.steps.some((step) => (step.run ?? "").includes("typecheck"))).toBe(false);
    expect(quick["timeout-minutes"]).toBe(30);
  });

  it("runs the type check as its own job beside `quick`, whenever `quick` runs", async () => {
    const { jobs } = await workflow();
    const typecheck = jobs.typecheck! as Job & { "runs-on"?: string };
    expect(typecheck["runs-on"]).toBe("ubuntu-latest");
    expect(typecheck.permissions).toBeUndefined();
    expect(JSON.stringify(typecheck)).not.toContain("secrets.");
    expect(typecheck.if).toBe(jobs.quick!.if);
    const parts = typecheck.steps.filter((step) => step.run !== undefined).map((step) => [step.name, step.if, step["timeout-minutes"], step.run] as const);
    expect(parts).toEqual([
      ["typecheck: npm ci", undefined, 15, "npm ci"],
      ["typecheck: npm run typecheck:all", undefined, 15, "npm run typecheck:all"],
    ]);
  });

  it("runs the release check as its own job beside `quick`, when the plan says the release area changed", async () => {
    const release = (await workflow()).jobs["release-check"]! as Job & { "runs-on"?: string };
    expect(release.if).toBe("needs.plan.outputs.release == 'true'");
    expect(release["runs-on"]).toBe("ubuntu-latest");
    expect(release.permissions).toBeUndefined();
    expect(JSON.stringify(release)).not.toContain("secrets.");
    const parts = release.steps.filter((step) => step.run !== undefined).map((step) => [step.name, step.if, step["timeout-minutes"], step.run] as const);
    expect(parts).toEqual([
      ["release: npm ci", undefined, 15, "npm ci"],
      ["release: npm run build", undefined, 15, "npm run build"],
      ["release: npm run infra:synth", undefined, 15, "npm run infra:synth"],
      ["release: Release builds are reproducible", undefined, 15, expect.stringContaining("npm run release:verify -- \"$RUNNER_TEMP/release-a\"")],
    ]);
    expect(release["timeout-minutes"]).toBe(35);
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
    // #1259: against the pull request's base (the merge commit's first parent) or the merge queue's base (merge_group.base_sha).
    expect(changed.run).toContain("DIFF_BASE=HEAD^1");
    expect(changed.run).toContain('if [ "$CI_EVENT" = merge_group ]; then DIFF_BASE="$BASE_SHA"; fi');
    expect(changed.run).toContain('$AS_TESTER npm test -- --changed "$DIFF_BASE" --passWithNoTests --shard=${{ matrix.shard }}/${{ strategy.job-total }}');
    expect(changed.run).toContain("xargs $AS_TESTER npm test -- --passWithNoTests --shard=${{ matrix.shard }}/${{ strategy.job-total }}");
  });

  // #1200, #1278: the plan picks the runner (ci-plan.ts testRunner): an urgent same-repository pull request into mainline, or its merge-queue run, runs its
  // shards on the account's CodeBuild runner (infra/lib/ci-runner.ts); every other run uses GitHub's free runner. The tests run as an ordinary account on
  // CodeBuild, since it runs the job as root.
  it("runs the shards on the CodeBuild runner only when the plan says so, as an ordinary account there, and everything else on GitHub's", async () => {
    const test = (await workflow()).jobs.test as Job & { "runs-on"?: string; needs?: string[] };
    expect(test.needs).toContain("plan");
    expect(test["runs-on"]).toBe("${{ needs.plan.outputs.runner == 'codebuild' && format('codebuild-rovara-ci-tests-{0}-{1}', github.run_id, github.run_attempt) || 'ubuntu-latest' }}");
    const order = test.steps.map((step) => step.name ?? step.uses ?? "");
    const asTester = test.steps.find((step) => step.name === "Run the tests as an ordinary account (CodeBuild only)")!;
    expect(order.indexOf(asTester.name!)).toBeGreaterThan(order.indexOf("Unpack the build output"));
    expect(order.indexOf(asTester.name!)).toBeLessThan(order.findIndex((name) => name.startsWith("Tests (")));
    expect(asTester.run).toContain('if [ "$(id -u)" != 0 ]; then exit 0; fi');
    expect(asTester.run).toContain('as="setpriv --reuid=65534 --regid=65534 --clear-groups"');
    // A GitHub runner's environment: short HOME and TMPDIR (socket paths), enterable PATH only, no AWS_* or npm_* variables, a writable step summary.
    expect(asTester.run).toContain('echo "AS_TESTER=$as env $unset_vars HOME=/tmp/h TMPDIR=/tmp/t PATH=$tester_path GITHUB_STEP_SUMMARY=/tmp/h/step-summary.md /usr/bin/python3 /tmp/h/reaper.py" >> "$GITHUB_ENV"');
    // the container's PID 1 does not reap orphans: the tests run under a child subreaper
    expect(asTester.run).toContain("ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)");
    // the application spool's ancestry check: nothing above the checkout writable by others
    expect(asTester.run).toContain('while [ "$path" != / ]; do chmod go-w "$path"; path="$(dirname "$path")"; done');
    expect(asTester.run).toContain("grep -oiE '^(aws|npm)_[a-z0-9_]*'");
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
      // #1262: what a merge-queue reuse is proven against, and the token that reads the merge commit's statuses.
      CI_QUEUE_HEAD_REF: "${{ github.event.merge_group.head_ref }}",
      CI_REPOSITORY: "${{ github.repository }}",
      GH_TOKEN: "${{ github.token }}",
      // #1278: a fork's pull request never runs on CodeBuild.
      CI_SAME_REPO: "${{ github.event.pull_request.head.repo.full_name == github.repository }}",
      // #1259: the merge queue's base for a merge-queue run.
      CI_BASE_REF: "${{ github.base_ref || github.event.merge_group.base_ref }}",
      BASE_SHA: "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}",
    });
    expect(step.run).toContain("git diff --name-only HEAD^1 HEAD");
    expect(step.run).toContain('git diff --name-only "$BASE_SHA" HEAD');
    expect(step.run).toContain('node "$PLAN_SCRIPT"');
    // Untrusted text (the title) reaches the script through the environment, never spliced into the shell.
    expect(step.run).not.toContain("github.event.pull_request.title");
    // #1262: reading statuses, and (#1278) a merge-queue run's pull request labels, is all the plan widens its token for; it passes the reused run
    // and the test runner on.
    expect(plan.permissions).toEqual({ contents: "read", statuses: "read", issues: "read", "pull-requests": "read" });
    expect((plan as Job & { outputs?: Record<string, string> }).outputs?.reuse_run).toBe("${{ steps.plan.outputs.reuse_run }}");
    expect((plan as Job & { outputs?: Record<string, string> }).outputs?.runner).toBe("${{ steps.plan.outputs.runner }}");
  });

  it("runs the Linux runtime check on an ARM64 runner, behind the same Markdown-only skip as the other heavy jobs", async () => {
    const job = (await workflow()).jobs["linux-runtime"] as Job & { "runs-on"?: string };
    expect(job["runs-on"]).toBe("ubuntu-24.04-arm");
    // Only when the plan says its area changed (always in a full run).
    expect(job.if).toBe("needs.plan.outputs.linux == 'true'");
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

  it("runs independent Linux checks after a failed check, only after setup and the executor smoke check succeed", async () => {
    const job = (await workflow()).jobs["linux-runtime"]!;
    const firstTest = job.steps.findIndex((step) => (step.run ?? "").startsWith("npx vitest run"));
    expect(firstTest).toBeGreaterThan(0);
    const setup = job.steps.slice(0, firstTest);
    // Setup remains sequential: failed checkout, firewall, image build or package build skips the smoke check.
    expect(setup.every((step) => step.if === undefined)).toBe(true);
    expect(setup.filter((step) => step.id !== undefined).map((step) => step.id)).toEqual(["runtime_setup"]);
    expect(setup.at(-1)).toMatchObject({
      id: "runtime_setup",
      run: "npx tsx scripts/executor-smoke.ts rovara-e2e-executor:ci",
    });
    const checks = job.steps.slice(firstTest);
    expect(checks.map((step) => step.name)).toEqual([
      "Linux runtime tests",
      "Docker 25 DNS regression (dind 25.0.5)",
      "Model channel (scripted route)",
      "Agent steps (scripted route)",
      "Agent qualification probes (scripted route)",
      "Mid-step values never reach the model (scripted route)",
      "Native browser journey",
      "Native M1.3 journeys",
      "Native M1.4 journeys",
      "Sandbox egress gateway (boot stage on real Docker)",
    ]);
    for (const step of checks) {
      expect(step.run, step.name).toMatch(/^npx vitest run /u);
      // The status functions remove Actions' implicit success() gate; the outcome keeps failed/skipped setup closed.
      // Neither status function is true after cancellation, unlike always().
      expect(step.if, step.name).toBe("(success() || failure()) && steps.runtime_setup.outcome == 'success'");
    }
  });

  it("runs the Docker 25 DNS regression test once, in its own step under the same gate as the other Linux tests, and keeps it out of the generic step", async () => {
    const job = (await workflow()).jobs["linux-runtime"] as Job & { steps: { name?: string; run?: string; env?: Record<string, string> }[] };
    const generic = job.steps.find((step) => (step.run ?? "").startsWith("npx vitest run tests/linux"))!;
    // Vitest 5.0.3 drops CLI --exclude under test.projects, so the shared step must name the single-project Linux config or every exclusion below is ignored.
    // Exactly these seven files run in steps of their own; one more exclusion would silently drop a Linux test from CI, so the whole command is pinned.
    const excluded = ["e2e-docker25-dns", "e2e-model-channel", "e2e-agent", "e2e-agent-probes", "e2e-midstep-carriers", "device-evidence-emulator", "worker-sandbox-egress"];
    expect(generic.run).toBe(`npx vitest run tests/linux ${excluded.map((name) => `--exclude tests/linux/${name}.test.ts`).join(" ")} --config vitest.linux.config.ts`);
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

  it("runs on pull requests, merge-queue runs and by hand, never on a push (#1295: code/next has a merge queue too), and skips a draft until it is ready", async () => {
    const parsed = await workflow();
    expect(parsed.on).toEqual({
      // #1185: a manual run may ask for the Linux runtime check; the nightly schedule runs it on mainline.
      workflow_dispatch: { inputs: { linux: { description: "Also run the Linux runtime check (#1185)", type: "boolean", default: false } } },
      pull_request: { types: ["opened", "synchronize", "reopened", "ready_for_review", "labeled"] },
      // #1259, #1295: the merge queues on mainline and code/next.
      merge_group: { types: ["checks_requested"] },
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
    // nightly-tests runs only on the nightly schedule, so a pull request's gate never waits for it.
    const others = Object.keys(jobs).filter((name) => name !== "local" && name !== "live-aws" && name !== "port-guard" && name !== "device-runtime" && name !== "nightly-tests").sort();
    expect([...(gate.needs as string[])].sort()).toEqual(others);
    expect([...(gate.needs as string[])].sort()).toEqual(["plan", ...GATED_JOBS].sort());
    expect(gate["timeout-minutes"]).toBe(5);
    const run = gate.steps.map((step) => step.run ?? "").join("\n");
    expect(run).toContain('node "$GATE_SCRIPT"');
    expect(gate.steps.some((step) => step.env?.NEEDS === "${{ toJSON(needs) }}")).toBe(true);
  });

  // #1262: the gate marks the merge commit it judged, for the merge queue to reuse; only a same-repository pull request into mainline or code/next (#1295), never a fork's.
  it("marks a same-repository pull request's tested merge commit (into mainline or code/next, the two queued branches) with the gate's verdict, as status ci/local, with only statuses: write", async () => {
    const { jobs } = await workflow();
    const gate = jobs.local!;
    expect(gate.permissions).toEqual({ contents: "read", statuses: "write" });
    expect(gate.steps.find((step) => step.name === "Every job passed?")?.id).toBe("gate");
    const mark = gate.steps.find((step) => step.name === "Mark the tested merge commit for the merge queue")!;
    expect(mark.if).toBe("always() && github.event_name == 'pull_request' && (github.base_ref == 'mainline' || github.base_ref == 'code/next') && github.event.pull_request.head.repo.full_name == github.repository && (steps.gate.outcome == 'success' || steps.gate.outcome == 'failure')");
    expect(mark.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      REPOSITORY: "${{ github.repository }}",
      TESTED: "${{ github.sha }}",
      VERDICT: "${{ steps.gate.outcome }}",
      RUN_URL: "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    });
    expect(mark.run).toContain('gh api --method POST "repos/$REPOSITORY/statuses/$TESTED" -f state="$VERDICT" -f context=ci/local');
    // A failed mark costs the reuse only, never the gate.
    expect(mark.run).toContain("|| echo \"::warning::");
    // The mark comes after the verdict.
    expect(gate.steps.indexOf(mark)).toBeGreaterThan(gate.steps.findIndex((step) => step.id === "gate"));
  });
});

describe("on a pull request CI judges the change with the base branch's plan and gate, never the pull request's own copy (DEC 242 follow-up)", () => {
  // #1259: a merge-queue run is judged the same way, from the queue's base.
  const BASE = "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}";

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
      expect(run, job).toContain('if [ "$CI_EVENT" = pull_request ] || [ "$CI_EVENT" = merge_group ]; then');
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
    expect(run).toContain('if [ "$CI_EVENT" = pull_request ] || [ "$CI_EVENT" = merge_group ]; then');
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

// #1259: a merge-queue group may hold several pull requests, so its changed files (for the lint, the plan and the related tests) are taken against the queue's
// base, never just the group commit's first parent.
describe("the merge queue's run (merge_group)", () => {
  it("lints the changed files against the queue's base", async () => {
    const quick = (await workflow()).jobs.quick!;
    const lint = quick.steps.find((step) => step.name === "checks: lint the changed files")!;
    expect(lint.env).toEqual({ CI_EVENT: "${{ github.event_name }}", BASE_SHA: "${{ github.event.merge_group.base_sha }}" });
    expect(lint.run).toContain("DIFF_BASE=HEAD^1");
    expect(lint.run).toContain('if [ "$CI_EVENT" = merge_group ]; then git fetch --no-tags --depth=1 origin "$BASE_SHA"; DIFF_BASE="$BASE_SHA"; fi');
    expect(lint.run).toContain('git diff --name-only "$DIFF_BASE" HEAD > "$RUNNER_TEMP/changed.txt"');
  });
  it("runs the port guard only in code/next's queue (it checks what code/next holds beyond mainline, #1295) and never cancels a queued run", async () => {
    const parsed = await workflow();
    expect(parsed.jobs["port-guard"]!.if).toContain("github.event_name == 'merge_group' && github.event.merge_group.base_ref == 'refs/heads/code/next'");
    expect((parsed as unknown as { concurrency: { "cancel-in-progress": string } }).concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  });
});
