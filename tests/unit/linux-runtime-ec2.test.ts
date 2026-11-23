import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bootstrapScript, formatReport, linuxRuntimeSteps, parseArgs, parseSummary, parseVitestFiles, runOnEc2, shellQuote, ssmCommands, stepsScript, userData,
  type Aws, type Options, type RunDeps,
} from "../../scripts/linux-runtime-ec2.js";

// #1199: CI's linux-runtime job on a temporary EC2 machine, its steps read from the workflow itself.
const COMMIT = "a".repeat(40);
const WORKFLOW = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

const job = (steps: string): string => `jobs:\n  linux-runtime:\n    runs-on: x\n    steps:\n${steps}`;

describe("the runner's arguments", () => {
  it("reads run with its defaults and flags, and refuses what it cannot use", () => {
    expect(parseArgs(["run", "--commit", COMMIT])).toMatchObject({ command: "run", commit: COMMIT, instanceType: "m7g.2xlarge", region: "us-east-1", keepGoing: false, maxMinutes: 90, volumeGb: 60 });
    expect(parseArgs(["run", "--commit", COMMIT, "--instance-type", "c7g.4xlarge", "--keep-going", "--max-minutes", "60", "--subnet", "subnet-1"])).toMatchObject({ instanceType: "c7g.4xlarge", keepGoing: true, maxMinutes: 60, subnet: "subnet-1" });
    expect(parseArgs(["setup"]).command).toBe("setup");
    expect(() => parseArgs(["run"])).toThrow(/--commit/u);
    expect(() => parseArgs(["run", "--commit", "abc123"])).toThrow(/40-character/u);
    expect(() => parseArgs(["run", "--commit", COMMIT, "--max-minutes", "0"])).toThrow(/whole number/u);
    expect(() => parseArgs(["run", "--commit", COMMIT, "--bogus"])).toThrow(/unknown flag/u);
    expect(() => parseArgs(["launch"])).toThrow(/usage/u);
  });
});

describe("the steps, read from ci.yml", () => {
  it("keeps run steps whose uses metadata is not an action string", () => {
    for (const uses of [null, 4, false, {}]) {
      const workflow = JSON.stringify({ jobs: { "linux-runtime": { steps: [{ name: "run", uses, run: "echo ready" }] } } });
      expect(linuxRuntimeSteps(workflow)).toEqual({ steps: [{ name: "run", run: "echo ready", env: {} }], replaced: [], skipped: [] });
    }
  });
  it("are the real linux-runtime job's run steps, in order, with checkout and setup-node replaced and the GHCR login and GitHub artifact archival explicitly skipped", () => {
    const plan = linuxRuntimeSteps(WORKFLOW);
    expect(plan.replaced).toEqual([expect.stringMatching(/^actions\/checkout@/u), expect.stringMatching(/^actions\/setup-node@/u)]);
    expect(plan.skipped).toEqual([expect.stringMatching(/GHCR/u), "Upload close retention Linux mutations"]);
    const runs = plan.steps.map((step) => step.run).join("\n");
    expect(runs).toContain("npm ci");
    expect(runs).toContain("npm run build");
    expect(runs).toContain("scripts/executor-smoke.ts");
    expect(plan.steps.at(-1)!.run).toContain("tests/linux/worker-sandbox-egress.test.ts");
    expect(plan.steps.find((step) => step.run.includes("vitest run tests/linux --exclude"))!.env).toMatchObject({ ROVARA_DOCKER: "1", ROVARA_EXECUTOR_IMAGE: "rovara-e2e-executor:ci" });
  });

  it("acknowledges exactly the manual JSON artifact archive and refuses changed actions, paths, conditions or options", () => {
    const archive = { name: "Upload close retention Linux mutations", uses: "actions/upload-artifact@v4", if: "always() && github.event_name == 'workflow_dispatch'", with: { name: "close-retention-linux-mutants", path: "linux-mutants.json", "if-no-files-found": "error" } };
    const yaml = (step: unknown) => JSON.stringify({ jobs: { "linux-runtime": { steps: [step] } } });
    expect(linuxRuntimeSteps(yaml(archive))).toEqual({ steps: [], replaced: [], skipped: [archive.name] });
    for (const change of [{ uses: "actions/upload-artifact@v3" }, { name: "other archive" }, { if: "always()" }, { with: { ...archive.with, path: "**/*" } }, { with: { ...archive.with, name: "other" } }, { with: { ...archive.with, "if-no-files-found": "ignore" } }]) {
      expect(() => linuxRuntimeSteps(yaml({ ...archive, ...change }))).toThrow(/does not reproduce/u);
    }
  });

  it("refuses an action it does not reproduce, a workflow expression, or a step condition, so a change to the job is never silently missed", () => {
    expect(() => linuxRuntimeSteps(job("      - uses: actions/cache@v4\n"))).toThrow(/actions\/cache/u);
    expect(() => linuxRuntimeSteps(job("      - run: echo ${{ github.sha }}\n"))).toThrow(/expression/u);
    expect(() => linuxRuntimeSteps(job("      - run: echo hi\n        if: always()\n"))).toThrow(/if/u);
    expect(() => linuxRuntimeSteps("jobs: {}\n")).toThrow(/no linux-runtime job/u);
  });

  it("reproduces only CI-REL-LAYOUT's after-setup condition: each check runs after the named setup step passed, even after a sibling failed", () => {
    const plan = linuxRuntimeSteps(WORKFLOW);
    const setup = plan.steps.findIndex((step) => step.run.includes("scripts/executor-smoke.ts"));
    const checks = plan.steps.filter((step) => step.run.startsWith("npx vitest run"));
    expect(checks.length).toBe(8);
    for (const check of checks) expect(check.afterStep, check.name).toBe(setup);
    expect(plan.steps.slice(0, setup + 1).every((step) => step.afterStep === undefined)).toBe(true);
    const gated = "      - name: setup\n        id: s1\n        run: echo setup\n      - name: check\n        if: (success() || failure()) && steps.s1.outcome == 'success'\n        run: echo check\n";
    expect(linuxRuntimeSteps(job(gated)).steps.map((step) => step.afterStep)).toEqual([undefined, 0]);
    // Every other condition still refuses: other expressions, an unknown id, a later step's id, and the other unsupported keys.
    for (const condition of ["always()", "success() || failure()", "(success() || failure()) && steps.nope.outcome == 'success'", "(success() || failure()) && steps.s1.outcome == 'failure'", "failure()"]) {
      expect(() => linuxRuntimeSteps(job(`      - name: setup\n        id: s1\n        run: echo setup\n      - name: check\n        if: ${JSON.stringify(condition)}\n        run: echo check\n`)), condition).toThrow(/does not reproduce/u);
    }
    expect(() => linuxRuntimeSteps(job("      - name: check\n        if: (success() || failure()) && steps.s1.outcome == 'success'\n        run: echo check\n      - name: setup\n        id: s1\n        run: echo setup\n"))).toThrow(/does not reproduce/u);
    expect(() => linuxRuntimeSteps(job("      - name: setup\n        id: s1\n        run: echo setup\n      - name: check\n        if: (success() || failure()) && steps.s1.outcome == 'success'\n        continue-on-error: true\n        run: echo check\n"))).toThrow(/does not reproduce/u);
  });
});

describe("what the instance runs", () => {
  it("halts itself after the time limit", () => {
    expect(userData(75)).toBe('#!/bin/bash\nshutdown -h +75 "rovara linux-runtime runner: time limit"\n');
  });

  it("checks out exactly the commit, from the repository, as the runner user, and takes Node from .node-version", () => {
    const script = bootstrapScript("o/r", COMMIT);
    expect(script).toContain(`git fetch -q --depth 2 origin ${COMMIT}`);
    expect(script).toContain("https://github.com/o/r.git");
    expect(script).toContain(`test "$(git rev-parse HEAD)" = ${COMMIT}`);
    expect(script).toContain(".node-version");
    expect(script).toContain("docker-buildx-plugin");
    expect(script.split("\n")[0]).toBe("set -euxo pipefail");
  });

  it("runs each step as the runner under bash -eo pipefail with its own env and the GITHUB_ENV lines, and records each result", () => {
    const script = stepsScript([{ name: "one's step", run: "echo $X\n", env: { X: "it's" } }, { name: "two", run: "false", env: {} }], false);
    expect(script).toContain("export X='it'\\''s'");
    expect(script).toContain("exec bash --noprofile --norc -eo pipefail /var/tmp/rovara/steps/01.sh");
    expect(script).toContain("sudo -u runner -H bash $W/steps/02.run");
    expect(script).toContain('done < "$GITHUB_ENV"');
    // Without --keep-going a step after a failure is recorded as skipped, as Actions skips it.
    expect(script).toContain("else printf '%s\\tskipped\\t0\\t%s\\n' 02 'two' >> $W/summary.tsv; fi");
    expect(stepsScript([{ name: "two", run: "false", env: {} }], true)).not.toContain("skipped");
    expect(() => stepsScript([{ name: "x", run: "ROVARA_STEP_01_EOF", env: {} }], false)).toThrow(/delimiter/u);
    expect(() => stepsScript([{ name: "x", run: "true", env: { "A-B": "1" } }], false)).toThrow(/env name/u);
  });

  it("runs a gated check when its setup step passed, whatever its siblings did, and skips it when setup failed", () => {
    const script = stepsScript([{ name: "setup", run: "true", env: {} }, { name: "a", run: "false", env: {}, afterStep: 0 }, { name: "b", run: "true", env: {}, afterStep: 0 }, { name: "plain", run: "true", env: {} }], false);
    expect(script).toContain("st=passed; ok_01=1;");
    // Gated checks test the setup step's own result, not the shared failed flag, so check b still runs after check a fails.
    expect(script.match(/if \[ "\$\{ok_01:-0\}" = 1 \]; then echo "::rovara-step-begin 0[23] /gu)).toHaveLength(2);
    // An ungated step keeps Actions' default: it is skipped after any failure.
    expect(script).toContain('if [ "$failed" = 0 ]; then echo "::rovara-step-begin 04 ');
    expect(stepsScript([{ name: "setup", run: "true", env: {} }, { name: "a", run: "true", env: {}, afterStep: 0 }], true)).not.toContain("ok_01:-0");
  });

  it("sends the script base64-encoded, so no quoting reaches SSM's shell", () => {
    const [write, run] = ssmCommands("echo 'hi'\n");
    expect(write).toBe(`echo ${Buffer.from("echo 'hi'\n").toString("base64")} | base64 -d > /var/tmp/rovara-command.sh`);
    expect(run).toBe("bash /var/tmp/rovara-command.sh");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe("the results", () => {
  it("reads the per-step summary and vitest's per-file lines", () => {
    expect(parseSummary("noise\n::rovara-summary-begin\n01\tpassed\t12\tBuild\n02\tfailed\t30\tTests\n::rovara-summary-end\n")).toEqual([
      { id: "01", status: "passed", seconds: 12, name: "Build" },
      { id: "02", status: "failed", seconds: 30, name: "Tests" },
    ]);
    expect(parseSummary("no summary")).toEqual([]);
    const files = parseVitestFiles(" ✓ tests/linux/a.test.ts (3 tests) 120ms\n ❯ tests/linux/b.test.ts (4 tests | 2 failed) 9s\n ↓ tests/linux/c.test.ts (1 test | 1 skipped)\n");
    expect(files.map((file) => [file.file, file.outcome])).toEqual([["tests/linux/a.test.ts", "passed"], ["tests/linux/b.test.ts", "failed"], ["tests/linux/c.test.ts", "skipped"]]);
    // As CI=true prints it: coloured.
    expect(parseVitestFiles(" \u001b[32m✓\u001b[39m tests/linux/d.test.ts \u001b[2m(\u001b[22m\u001b[2m1 test\u001b[22m\u001b[2m)\u001b[22m 9ms\n")).toEqual([{ file: "tests/linux/d.test.ts", outcome: "passed", detail: "1 test" }]);
  });
});

// A fake AWS: answers each CLI call by its service and operation.
function fakeAws(answers: Record<string, (args: readonly string[]) => unknown>): Aws & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    call(args) {
      calls.push([...args]);
      const answer = answers[`${args[0]} ${args[1]}`];
      if (answer === undefined) throw new Error(`unexpected aws ${args[0]} ${args[1]}`);
      return answer(args);
    },
  };
}

function deps(aws: Aws, over: Partial<RunDeps> = {}): RunDeps & { logs: string[]; signal: { cleanup?: () => void; removed: boolean } } {
  let clock = 1_700_000_000_000;
  const logs: string[] = [];
  const signal: { cleanup?: () => void; removed: boolean } = { removed: false };
  return {
    aws, logs, signal,
    log: (line) => logs.push(line),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    workflowAt: () => WORKFLOW,
    writeLog: () => undefined,
    onSignal: (cleanup) => { signal.cleanup = cleanup; return () => { signal.removed = true; }; },
    ...over,
  };
}

const OPTIONS: Options = { ...parseArgs(["run", "--commit", COMMIT]), keepGoing: true };
const SUMMARY = (status: string) => `::rovara-summary-begin\n${linuxRuntimeSteps(WORKFLOW).steps.map((step, i) => `${String(i + 1).padStart(2, "0")}\t${status}\t10\t${step.name}`).join("\n")}\n::rovara-summary-end\n`;

function launchingAws(stepsOutput: string, stepsStatus = "Success") {
  let sent = 0;
  return fakeAws({
    "ssm get-parameter": () => "ami-0123456789abcdef0",
    "ec2 describe-vpcs": () => "vpc-1",
    "ec2 describe-security-groups": () => "sg-1",
    "ec2 describe-instance-type-offerings": () => ["us-east-1a", "us-east-1b"],
    "ec2 describe-subnets": () => [["subnet-b", "us-east-1b"], ["subnet-e", "us-east-1e"]],
    "ec2 run-instances": () => "i-0123456789abcdef0",
    "ssm describe-instance-information": () => "Online",
    "ssm send-command": () => `cmd-${++sent}`,
    "logs get-log-events": () => { throw new Error("no stream yet"); },
    "ssm get-command-invocation": (args) => (args[3] === "cmd-1" ? { Status: "Success", StandardOutputContent: "v22" } : { Status: stepsStatus, StandardOutputContent: stepsOutput }),
    "ec2 terminate-instances": () => ({}),
  });
}

describe("one run", () => {
  it("launches one tagged, self-halting, inbound-less instance, runs the bootstrap then the steps over SSM, and terminates it", async () => {
    const aws = launchingAws(`${SUMMARY("passed")} ✓ tests/linux/a.test.ts (2 tests) 1s\n`);
    const d = deps(aws);
    const report = await runOnEc2(OPTIONS, d);
    expect(report).toMatchObject({ ok: true, instanceId: "i-0123456789abcdef0", files: [{ file: "tests/linux/a.test.ts", outcome: "passed" }] });
    const launch = aws.calls.find((call) => call[1] === "run-instances")!;
    expect(launch).toEqual(expect.arrayContaining(["--instance-initiated-shutdown-behavior", "terminate", "--subnet-id", "subnet-b", "--security-group-ids", "sg-1", "--instance-type", "m7g.2xlarge"]));
    expect(launch.join(" ")).toContain("Key=rovara:purpose,Value=linux-runtime");
    expect(launch.join(" ")).toContain("HttpTokens=required");
    expect(launch[launch.indexOf("--user-data") + 1]).toContain("shutdown -h +90");
    expect(aws.calls.filter((call) => call[1] === "send-command")).toHaveLength(2);
    expect(aws.calls.at(-1)).toEqual(["ec2", "terminate-instances", "--instance-ids", "i-0123456789abcdef0"]);
    expect(d.signal.removed).toBe(true);
    expect(formatReport(report)).toContain("PASSED");
  });

  it("is a failure, and still terminates, when a step fails", async () => {
    const aws = launchingAws(SUMMARY("failed"), "Failed");
    const report = await runOnEc2(OPTIONS, deps(aws));
    expect(report.ok).toBe(false);
    expect(aws.calls.filter((call) => call[1] === "terminate-instances")).toHaveLength(1);
  });

  it("terminates the instance when anything after the launch throws", async () => {
    const aws = launchingAws("");
    const failing = fakeAws({ ...Object.fromEntries(["ssm get-parameter", "ec2 describe-vpcs", "ec2 describe-security-groups", "ec2 describe-instance-type-offerings", "ec2 describe-subnets", "ec2 run-instances", "ec2 terminate-instances"].map((key) => [key, (args: readonly string[]) => aws.call(args)])), "ssm describe-instance-information": () => { throw new Error("throttled"); } });
    const report = await runOnEc2(OPTIONS, deps(failing));
    expect(report.ok).toBe(false);
    expect(report.error).toContain("throttled");
    expect(failing.calls.at(-1)).toEqual(["ec2", "terminate-instances", "--instance-ids", "i-0123456789abcdef0"]);
  });

  it("terminates once, from the signal handler, on Ctrl-C mid-run, and not again from the finally block", async () => {
    const aws = launchingAws(SUMMARY("passed"));
    const d = deps(aws);
    let interrupted = false;
    d.sleep = async () => { if (!interrupted && d.signal.cleanup) { interrupted = true; d.signal.cleanup(); } };
    await runOnEc2(OPTIONS, d);
    expect(aws.calls.filter((call) => call[1] === "terminate-instances")).toHaveLength(1);
  });

  it("launches nothing without the setup's security group", async () => {
    const aws = fakeAws({ "ssm get-parameter": () => "ami-1", "ec2 describe-vpcs": () => "vpc-1", "ec2 describe-security-groups": () => null });
    const report = await runOnEc2(OPTIONS, deps(aws));
    expect(report.error).toContain("setup");
    expect(aws.calls.some((call) => call[1] === "run-instances" || call[1] === "terminate-instances")).toBe(false);
  });
});
