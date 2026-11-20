// #1199: CI's `linux-runtime` job on a temporary EC2 machine, launched for one run and terminated after it.
//
// Why: the suite needs a Linux kernel >= 5.9 with real Docker, and CodeBuild's ARM hosts run 4.14 (#1193). Since #1192 the job no longer runs on
// every pull request; the release is to run it before it deploys (#1192 part 2). This is the runner that can do that: one Graviton machine running
// Ubuntu 24.04 (GitHub's `ubuntu-24.04-arm` image is Ubuntu 24.04 too), driven over SSM Run Command: no SSH key, no inbound rule.
//
// No drift from CI: the steps are READ from .github/workflows/ci.yml (the `linux-runtime` job of the checked-out commit) and run in order, as the
// `runner` user with passwordless sudo, under bash -eo pipefail, with each step's own `env:`, RUNNER_TEMP and a GITHUB_ENV file between steps,
// exactly as Actions runs them. The two `uses:` steps are what this script's bootstrap does instead (checkout at the commit with depth 2; Node
// from .node-version). The GHCR login step is skipped (it needs the workflow's token; the image pull then falls back to the upstream registry, as
// a fork's pull request does). Any other `uses:` step, or a step that reads a `${{ }}` expression, is refused, so a change to the job cannot be
// silently missed here.
//
// Cost safety, three layers: the script terminates the instance in a finally block and on SIGINT/SIGTERM; the instance halts itself after
// --max-minutes (`shutdown -h +N` in its user data, with shutdown behaviour = terminate); and it is tagged with its expiry time.
//
// The AWS calls go through the `aws` CLI (a script under scripts/ may not import the EC2 or SSM SDK clients: port-guard's cloud-aws rule).
//
// Usage (the default AWS profile's account, us-east-1):
//   node scripts/linux-runtime-ec2.ts setup                       the instance role + profile, security group (no inbound) and log group, idempotent
//   node scripts/linux-runtime-ec2.ts run --commit <sha> [--instance-type m7g.2xlarge] [--keep-going] [--max-minutes 90] [--log-dir <dir>]
//   node scripts/linux-runtime-ec2.ts plan --commit <sha>         print the bootstrap and step scripts it would send, launch nothing
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export const RUNNER_NAME = "rovara-linux-runtime-ci";
export const PURPOSE_TAG = { key: "rovara:purpose", value: "linux-runtime" } as const;
export const LOG_GROUP = "/rovara/linux-runtime-ci";
export const DEFAULT_INSTANCE_TYPE = "m7g.2xlarge";
export const DEFAULT_REPOSITORY = "PrepLabsAI/Rovara";
export const AMI_PARAMETER = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id";
const WORK = "/var/tmp/rovara";
const REPO_DIR = "/home/runner/repo";
const SHA = /^[0-9a-f]{40}$/u;

export interface Options {
  command: "setup" | "run" | "plan";
  region: string;
  commit?: string;
  repository: string;
  instanceType: string;
  keepGoing: boolean;
  maxMinutes: number;
  volumeGb: number;
  logDir: string;
  subnet?: string;
}

export function parseArgs(argv: readonly string[]): Options {
  const [command, ...rest] = argv;
  if (command !== "setup" && command !== "run" && command !== "plan") throw new Error("usage: linux-runtime-ec2.ts setup | run --commit <sha> [...] | plan --commit <sha>");
  const options: Options = { command, region: "us-east-1", repository: DEFAULT_REPOSITORY, instanceType: DEFAULT_INSTANCE_TYPE, keepGoing: false, maxMinutes: 90, volumeGb: 60, logDir: "linux-runtime-ec2-logs" };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const value = (): string => {
      const next = rest[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--commit") options.commit = value();
    else if (flag === "--region") options.region = value();
    else if (flag === "--repository") options.repository = value();
    else if (flag === "--instance-type") options.instanceType = value();
    else if (flag === "--log-dir") options.logDir = value();
    else if (flag === "--subnet") options.subnet = value();
    else if (flag === "--keep-going") options.keepGoing = true;
    else if (flag === "--max-minutes" || flag === "--volume-gb") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a whole number`);
      if (flag === "--max-minutes") options.maxMinutes = n;
      else options.volumeGb = n;
    } else throw new Error(`unknown flag ${flag}`);
  }
  if (command !== "setup" && (options.commit === undefined || !SHA.test(options.commit))) throw new Error("--commit needs a full 40-character commit sha");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.repository)) throw new Error("--repository is owner/name");
  if (!/^[a-z0-9]+[a-z0-9-]*\.[a-z0-9]+$/u.test(options.instanceType)) throw new Error("--instance-type looks wrong");
  return options;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The steps, read from the workflow.

export interface Step { name: string; run: string; env: Record<string, string> }
export interface WorkflowSteps { steps: Step[]; replaced: string[]; skipped: string[] }

/** The bootstrap does these instead; anything else a `uses:` step brings is refused. */
const REPLACED_ACTIONS = [/^actions\/checkout@/u, /^actions\/setup-node@/u];

export function linuxRuntimeSteps(workflowYaml: string): WorkflowSteps {
  const workflow = parseYaml(workflowYaml) as { jobs?: Record<string, { steps?: Array<Record<string, unknown>> }> };
  const job = workflow.jobs?.["linux-runtime"];
  if (job?.steps === undefined) throw new Error("ci.yml has no linux-runtime job with steps");
  const out: WorkflowSteps = { steps: [], replaced: [], skipped: [] };
  job.steps.forEach((raw, index) => {
    const uses = typeof raw.uses === "string" ? raw.uses : undefined;
    const run = typeof raw.run === "string" ? raw.run : undefined;
    const name = typeof raw.name === "string" ? raw.name : (run?.split("\n")[0] ?? uses ?? `step ${index + 1}`);
    if (uses !== undefined) {
      if (!REPLACED_ACTIONS.some((pattern) => pattern.test(uses))) throw new Error(`linux-runtime step "${name}" uses ${uses}, which this runner does not reproduce`);
      out.replaced.push(uses);
      return;
    }
    if (run === undefined) throw new Error(`linux-runtime step "${name}" has neither run nor uses`);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries((raw.env as Record<string, unknown> | undefined) ?? {})) env[key] = String(value);
    const expression = [run, ...Object.values(env)].some((text) => text.includes("${{"));
    if (expression) {
      // Only the GHCR login may be skipped: its failure is already tolerated in CI (the pull then comes from the upstream registry).
      if (/docker login ghcr\.io/u.test(run)) { out.skipped.push(name); return; }
      throw new Error(`linux-runtime step "${name}" reads a workflow expression, which this runner cannot supply`);
    }
    if (raw.if !== undefined || raw["continue-on-error"] !== undefined || raw.shell !== undefined || raw["working-directory"] !== undefined) {
      throw new Error(`linux-runtime step "${name}" sets if/continue-on-error/shell/working-directory, which this runner does not reproduce`);
    }
    out.steps.push({ name, run, env });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What the instance runs.

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The instance halts (and so terminates) itself after this many minutes, whatever happens to the machine that launched it. */
export function userData(maxMinutes: number): string {
  return `#!/bin/bash\nshutdown -h +${maxMinutes} "rovara linux-runtime runner: time limit"\n`;
}

/** Packages, Docker (Docker's own apt repository, as GitHub's image has), the runner user, the checkout at the commit and Node from .node-version. */
export function bootstrapScript(repository: string, commit: string): string {
  return [
    "set -euxo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "APT='apt-get -o DPkg::Lock::Timeout=600 -y -q'",
    "$APT update",
    "$APT install ca-certificates curl git build-essential python3 jq xz-utils",
    "install -m 0755 -d /etc/apt/keyrings",
    "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list',
    "$APT update",
    "$APT install docker-ce docker-ce-cli containerd.io docker-buildx-plugin",
    "systemctl enable --now docker",
    "id runner >/dev/null 2>&1 || useradd -m -s /bin/bash runner",
    "usermod -aG docker runner",
    "echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner && chmod 0440 /etc/sudoers.d/runner",
    `mkdir -p ${WORK}/steps ${WORK}/runner-temp && : > ${WORK}/github-env && chown -R runner:runner ${WORK}`,
    `sudo -u runner -H bash -euxo pipefail -c ${shellQuote(`git init -q ${REPO_DIR} && cd ${REPO_DIR} && git remote add origin https://github.com/${repository}.git && git fetch -q --depth 2 origin ${commit} && git checkout -q --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = ${commit}`)}`,
    `NODE_VERSION=$(tr -d 'v \\n' < ${REPO_DIR}/.node-version)`,
    'curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" | tar -xJ -C /opt',
    'ln -sfn "/opt/node-v${NODE_VERSION}-linux-arm64" /opt/node',
    "/opt/node/bin/node --version && docker version --format '{{.Server.Version}}' && uname -r",
  ].join("\n");
}

/** The workflow's steps, in order, each as its own file, run as `runner` the way Actions runs a `run:` step; a summary line per step. */
export function stepsScript(steps: readonly Step[], keepGoing: boolean): string {
  const lines = [
    "set -uo pipefail",
    `W=${WORK}`,
    ": > $W/summary.tsv",
    "failed=0",
  ];
  steps.forEach((step, index) => {
    const n = String(index + 1).padStart(2, "0");
    const delimiter = `ROVARA_STEP_${n}_EOF`;
    if (step.run.split("\n").includes(delimiter)) throw new Error(`step "${step.name}" contains the delimiter ${delimiter}`);
    const exports = Object.entries(step.env).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error(`step "${step.name}" has env name ${key}`);
      return `export ${key}=${shellQuote(value)}`;
    });
    const wrapper = [
      "export HOME=/home/runner USER=runner CI=true PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      `export RUNNER_TEMP=$W/runner-temp GITHUB_ENV=$W/github-env GITHUB_WORKSPACE=${REPO_DIR} GITHUB_REPOSITORY_OWNER=${shellQuote(DEFAULT_REPOSITORY.split("/")[0]!)}`,
      // GITHUB_ENV lines from the steps before (simple NAME=value lines, which is what the job's steps write).
      'while IFS= read -r line; do case "$line" in [A-Za-z_]*=*) export "$line" ;; esac; done < "$GITHUB_ENV"',
      ...exports,
      `cd ${REPO_DIR}`,
      `exec bash --noprofile --norc -eo pipefail $W/steps/${n}.sh`,
    ];
    lines.push(
      `cat > $W/steps/${n}.sh <<'${delimiter}'`, step.run.replace(/\n$/u, ""), delimiter,
      `cat > $W/steps/${n}.run <<'${delimiter}'`, ...wrapper.map((line) => line.replaceAll("$W", WORK)), delimiter,
      `chown runner:runner $W/steps/${n}.sh $W/steps/${n}.run`,
    );
    const guard = keepGoing ? "" : 'if [ "$failed" = 0 ]; then ';
    const close = keepGoing ? "" : `; else printf '%s\\tskipped\\t0\\t%s\\n' ${n} ${shellQuote(step.name)} >> $W/summary.tsv; fi`;
    lines.push(
      `${guard}echo "::rovara-step-begin ${n} "${shellQuote(step.name)}; s=$(date +%s); sudo -u runner -H bash $W/steps/${n}.run 2>&1; rc=$?; e=$(( $(date +%s) - s )); ` +
        `if [ $rc = 0 ]; then st=passed; else st=failed; failed=1; fi; printf '%s\\t%s\\t%s\\t%s\\n' ${n} "$st" "$e" ${shellQuote(step.name)} >> $W/summary.tsv; echo "::rovara-step-end ${n} $st $e"${close}`,
    );
  });
  lines.push("echo '::rovara-summary-begin'", "cat $W/summary.tsv", "echo '::rovara-summary-end'", 'exit "$failed"');
  return lines.join("\n");
}

/** One SSM command: the script, sent base64 so no quoting reaches the shell. */
export function ssmCommands(script: string): string[] {
  return [`echo ${Buffer.from(script).toString("base64")} | base64 -d > /var/tmp/rovara-command.sh`, "bash /var/tmp/rovara-command.sh"];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Results.

export interface StepResult { id: string; status: "passed" | "failed" | "skipped"; seconds: number; name: string }
export function parseSummary(text: string): StepResult[] {
  const begin = text.indexOf("::rovara-summary-begin"), end = text.indexOf("::rovara-summary-end");
  if (begin < 0 || end < begin) return [];
  return text.slice(begin, end).split("\n").slice(1).filter((line) => line.includes("\t")).map((line) => {
    const [id, status, seconds, ...name] = line.split("\t");
    return { id: id!, status: status as StepResult["status"], seconds: Number(seconds), name: name.join("\t") };
  });
}

export interface FileResult { file: string; outcome: "passed" | "failed" | "skipped"; detail: string }
/** vitest's default reporter prints one line per test file: ✓ passed, ❯ or × with failures, ↓ skipped. */
export function parseVitestFiles(log: string): FileResult[] {
  const results = new Map<string, FileResult>();
  for (const line of log.split("\n")) {
    const match = /^\s*(✓|❯|×|↓)\s+(\S+\.test\.ts)\s+\(([^)]*)\)/u.exec(line);
    if (match === null) continue;
    const [, mark, file, detail] = match;
    const outcome = mark === "✓" ? "passed" : mark === "↓" ? "skipped" : /failed/u.test(detail!) || mark === "×" ? "failed" : "passed";
    results.set(file!, { file: file!, outcome, detail: detail! });
  }
  return [...results.values()];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// AWS, through the CLI.

export interface Aws {
  call(args: readonly string[]): unknown;
}

export function awsCli(region: string): Aws {
  return {
    call(args) {
      const result = spawnSync("aws", [...args, "--region", region, "--output", "json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
      if (result.status !== 0) throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.error?.message || "").trim()}`);
      const text = result.stdout.trim();
      return text === "" ? undefined : (JSON.parse(text) as unknown);
    },
  };
}

function setup(aws: Aws, log: (line: string) => void): void {
  const exists = (args: string[]): boolean => { try { aws.call(args); return true; } catch { return false; } };
  if (!exists(["iam", "get-role", "--role-name", RUNNER_NAME])) {
    const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }] };
    aws.call(["iam", "create-role", "--role-name", RUNNER_NAME, "--assume-role-policy-document", JSON.stringify(trust), "--description", "Temporary linux-runtime CI machine: SSM Run Command and its own log group only (#1199)", "--tags", `Key=${PURPOSE_TAG.key},Value=${PURPOSE_TAG.value}`]);
    log(`created role ${RUNNER_NAME}`);
  }
  aws.call(["iam", "attach-role-policy", "--role-name", RUNNER_NAME, "--policy-arn", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"]);
  // The command output goes to one log group; SSM's agent needs these to stream it (DescribeLogGroups takes no resource).
  const logs = {
    Version: "2012-10-17",
    Statement: [
      { Sid: "RunOutput", Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"], Resource: [`arn:aws:logs:*:*:log-group:${LOG_GROUP}`, `arn:aws:logs:*:*:log-group:${LOG_GROUP}:*`] },
      { Sid: "FindLogGroup", Effect: "Allow", Action: ["logs:DescribeLogGroups"], Resource: "*" },
    ],
  };
  aws.call(["iam", "put-role-policy", "--role-name", RUNNER_NAME, "--policy-name", "run-output", "--policy-document", JSON.stringify(logs)]);
  if (!exists(["iam", "get-instance-profile", "--instance-profile-name", RUNNER_NAME])) {
    aws.call(["iam", "create-instance-profile", "--instance-profile-name", RUNNER_NAME]);
    aws.call(["iam", "add-role-to-instance-profile", "--instance-profile-name", RUNNER_NAME, "--role-name", RUNNER_NAME]);
    log(`created instance profile ${RUNNER_NAME}`);
  }
  const group = aws.call(["logs", "describe-log-groups", "--log-group-name-prefix", LOG_GROUP, "--query", `logGroups[?logGroupName=='${LOG_GROUP}'] | [0].logGroupName`]);
  if (group !== LOG_GROUP) {
    aws.call(["logs", "create-log-group", "--log-group-name", LOG_GROUP]);
    aws.call(["logs", "put-retention-policy", "--log-group-name", LOG_GROUP, "--retention-in-days", "30"]);
    log(`created log group ${LOG_GROUP}`);
  }
  const vpc = defaultVpc(aws);
  if (securityGroup(aws, vpc) === undefined) {
    const created = aws.call(["ec2", "create-security-group", "--group-name", RUNNER_NAME, "--vpc-id", vpc, "--description", "linux-runtime CI machine: no inbound rule, outbound only (#1199)", "--tag-specifications", `ResourceType=security-group,Tags=[{Key=${PURPOSE_TAG.key},Value=${PURPOSE_TAG.value}}]`]) as { GroupId: string };
    log(`created security group ${created.GroupId} (no inbound rule)`);
  }
  log("setup done");
}

function defaultVpc(aws: Aws): string {
  const vpc = aws.call(["ec2", "describe-vpcs", "--filters", "Name=isDefault,Values=true", "--query", "Vpcs[0].VpcId"]);
  if (typeof vpc !== "string") throw new Error("no default VPC in this region");
  return vpc;
}
function securityGroup(aws: Aws, vpc: string): string | undefined {
  const id = aws.call(["ec2", "describe-security-groups", "--filters", `Name=vpc-id,Values=${vpc}`, `Name=group-name,Values=${RUNNER_NAME}`, "--query", "SecurityGroups[0].GroupId"]);
  return typeof id === "string" ? id : undefined;
}
/** A default subnet (public, outbound internet) in an availability zone that offers the instance type. */
function subnetFor(aws: Aws, vpc: string, instanceType: string): string {
  const zones = aws.call(["ec2", "describe-instance-type-offerings", "--location-type", "availability-zone", "--filters", `Name=instance-type,Values=${instanceType}`, "--query", "InstanceTypeOfferings[].Location"]) as string[];
  const subnets = aws.call(["ec2", "describe-subnets", "--filters", `Name=vpc-id,Values=${vpc}`, "Name=default-for-az,Values=true", "--query", "Subnets[].[SubnetId,AvailabilityZone]"]) as Array<[string, string]>;
  const subnet = subnets.sort((a, b) => a[1].localeCompare(b[1])).find(([, zone]) => zones.includes(zone));
  if (subnet === undefined) throw new Error(`no default subnet in a zone offering ${instanceType}`);
  return subnet[0];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// One run.

export interface RunDeps {
  aws: Aws;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  workflowAt: (commit: string) => string;
  writeLog: (name: string, text: string) => void;
  /** Called with the cleanup to run on SIGINT/SIGTERM; returns the function that removes it. */
  onSignal: (cleanup: () => void) => () => void;
}

export interface RunReport {
  instanceId?: string;
  ok: boolean;
  timings: { launchToReady?: number; bootstrap?: number; steps?: number; total: number };
  steps: StepResult[];
  files: FileResult[];
  error?: string;
}

interface Invocation { Status: string; StandardOutputContent?: string; StandardErrorContent?: string; ResponseCode?: number }

export async function runOnEc2(options: Options, deps: RunDeps): Promise<RunReport> {
  const { aws, log } = deps;
  const commit = options.commit!;
  const plan = linuxRuntimeSteps(deps.workflowAt(commit));
  const started = deps.now();
  const report: RunReport = { ok: false, timings: { total: 0 }, steps: [], files: [] };
  let terminated = false;
  const terminate = (): void => {
    if (report.instanceId === undefined || terminated) return;
    terminated = true;
    try {
      aws.call(["ec2", "terminate-instances", "--instance-ids", report.instanceId]);
      log(`terminated ${report.instanceId}`);
    } catch (error) {
      log(`COULD NOT TERMINATE ${report.instanceId}: ${(error as Error).message} (it halts itself after ${options.maxMinutes} minutes)`);
    }
  };
  const removeSignal = deps.onSignal(terminate);
  try {
    const ami = aws.call(["ssm", "get-parameter", "--name", AMI_PARAMETER, "--query", "Parameter.Value"]) as string;
    const vpc = defaultVpc(aws);
    const group = securityGroup(aws, vpc);
    if (group === undefined) throw new Error("run `linux-runtime-ec2.ts setup` first (no security group)");
    const subnet = options.subnet ?? subnetFor(aws, vpc, options.instanceType);
    const runId = `${commit.slice(0, 9)}-${Math.floor(started / 1000)}`;
    const expires = new Date(started + options.maxMinutes * 60_000).toISOString();
    const tags = `{Key=Name,Value=${RUNNER_NAME}-${runId}},{Key=${PURPOSE_TAG.key},Value=${PURPOSE_TAG.value}},{Key=rovara:expires-at,Value=${expires}},{Key=rovara:commit,Value=${commit}}`;
    const launched = aws.call([
      "ec2", "run-instances",
      "--image-id", ami, "--instance-type", options.instanceType, "--count", "1",
      "--subnet-id", subnet, "--security-group-ids", group, "--associate-public-ip-address",
      "--iam-instance-profile", `Name=${RUNNER_NAME}`,
      "--instance-initiated-shutdown-behavior", "terminate",
      "--metadata-options", "HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled",
      "--block-device-mappings", JSON.stringify([{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: options.volumeGb, VolumeType: "gp3", Iops: 6000, Throughput: 500, DeleteOnTermination: true } }]),
      "--user-data", userData(options.maxMinutes),
      "--tag-specifications", `ResourceType=instance,Tags=[${tags}]`, `ResourceType=volume,Tags=[${tags}]`,
      "--query", "Instances[0].InstanceId",
    ]);
    if (typeof launched !== "string") throw new Error("run-instances returned no instance id");
    report.instanceId = launched;
    log(`launched ${launched} (${options.instanceType}, ${ami}, ${subnet}); halts itself by ${expires}`);

    for (;;) {
      if (deps.now() - started > 15 * 60_000) throw new Error("the instance did not come online in SSM within 15 minutes");
      const online = aws.call(["ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${launched}`, "--query", "InstanceInformationList[0].PingStatus"]);
      if (online === "Online") break;
      await deps.sleep(5_000);
    }
    report.timings.launchToReady = (deps.now() - started) / 1000;
    log(`online in SSM after ${report.timings.launchToReady.toFixed(0)}s`);

    const send = async (label: string, script: string, timeoutSeconds: number): Promise<{ invocation: Invocation; log: string; seconds: number }> => {
      const t0 = deps.now();
      const commandId = aws.call([
        "ssm", "send-command", "--instance-ids", launched, "--document-name", "AWS-RunShellScript", "--comment", `linux-runtime ${label}`,
        "--parameters", JSON.stringify({ commands: ssmCommands(script), executionTimeout: [String(timeoutSeconds)] }),
        "--cloud-watch-output-config", `CloudWatchLogGroupName=${LOG_GROUP},CloudWatchOutputEnabled=true`,
        "--query", "Command.CommandId",
      ]) as string;
      const stream = `${commandId}/${launched}/aws-runShellScript/stdout`;
      let token: string | undefined, text = "";
      const drain = (): void => {
        for (let page = 0; page < 50; page++) {
          let events: { events: Array<{ message: string }>; nextForwardToken: string } | undefined;
          try {
            events = aws.call(["logs", "get-log-events", "--log-group-name", LOG_GROUP, "--log-stream-name", stream, "--start-from-head", ...(token ? ["--next-token", token] : [])]) as typeof events;
          } catch { return; } // the stream appears once the first output is written
          if (events === undefined || events.nextForwardToken === token) return;
          token = events.nextForwardToken;
          for (const event of events.events) { text += `${event.message}\n`; for (const line of event.message.split("\n")) if (line.startsWith("::rovara-step") || /^\s*(✓|❯|×)\s+\S+\.test\.ts/u.test(line)) log(`  ${line.trim()}`); }
          if (events.events.length === 0) return;
        }
      };
      for (;;) {
        await deps.sleep(10_000);
        drain();
        let invocation: Invocation;
        try {
          invocation = aws.call(["ssm", "get-command-invocation", "--command-id", commandId, "--instance-id", launched]) as Invocation;
        } catch { continue; } // briefly not found right after send-command
        if (!["Pending", "InProgress", "Delayed"].includes(invocation.Status)) {
          await deps.sleep(5_000); // the agent's last upload
          drain();
          const seconds = (deps.now() - t0) / 1000;
          deps.writeLog(`${label}.log`, text || (invocation.StandardOutputContent ?? ""));
          if (invocation.StandardErrorContent) deps.writeLog(`${label}.stderr.log`, invocation.StandardErrorContent);
          return { invocation, log: text || (invocation.StandardOutputContent ?? ""), seconds };
        }
      }
    };

    const boot = await send("bootstrap", bootstrapScript(options.repository, commit), 1800);
    report.timings.bootstrap = boot.seconds;
    log(`bootstrap ${boot.invocation.Status} in ${boot.seconds.toFixed(0)}s`);
    if (boot.invocation.Status !== "Success") throw new Error(`bootstrap ${boot.invocation.Status}: ${(boot.invocation.StandardErrorContent ?? "").slice(-2000)}`);

    if (plan.skipped.length > 0) log(`skipped (needs the workflow token): ${plan.skipped.join("; ")}`);
    const remaining = Math.max(300, Math.floor((started + options.maxMinutes * 60_000 - deps.now()) / 1000) - 120);
    const run = await send("steps", stepsScript(plan.steps, options.keepGoing), remaining);
    report.timings.steps = run.seconds;
    report.steps = parseSummary(run.log);
    report.files = parseVitestFiles(run.log);
    report.ok = run.invocation.Status === "Success" && report.steps.length === plan.steps.length && report.steps.every((step) => step.status === "passed");
    log(`steps ${run.invocation.Status} in ${run.seconds.toFixed(0)}s`);
  } catch (error) {
    report.error = (error as Error).message;
    log(`error: ${report.error}`);
  } finally {
    terminate();
    removeSignal();
    report.timings.total = (deps.now() - started) / 1000;
  }
  return report;
}

export function formatReport(report: RunReport): string {
  const m = (s: number | undefined): string => (s === undefined ? "-" : `${(s / 60).toFixed(1)} min`);
  const lines = [
    `linux-runtime on EC2 (${report.instanceId ?? "no instance"}): ${report.ok ? "PASSED" : "FAILED"}${report.error ? ` (${report.error})` : ""}`,
    `  launch -> SSM ready ${m(report.timings.launchToReady)}, bootstrap ${m(report.timings.bootstrap)}, CI steps ${m(report.timings.steps)}, total ${m(report.timings.total)}`,
    ...report.steps.map((step) => `  ${step.status.padEnd(7)} ${m(step.seconds).padStart(9)}  ${step.name}`),
    ...report.files.filter((file) => file.outcome !== "passed").map((file) => `  file ${file.outcome}: ${file.file} (${file.detail})`),
    `  test files: ${report.files.filter((f) => f.outcome === "passed").length} passed, ${report.files.filter((f) => f.outcome === "failed").length} failed, ${report.files.filter((f) => f.outcome === "skipped").length} skipped`,
  ];
  return lines.join("\n");
}

function workflowAt(commit: string): string {
  const shown = spawnSync("git", ["show", `${commit}:.github/workflows/ci.yml`], { encoding: "utf8" });
  if (shown.status !== 0) throw new Error(`cannot read ci.yml at ${commit} (fetch it first): ${shown.stderr.trim()}`);
  return shown.stdout;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const aws = awsCli(options.region);
  const log = (line: string): void => { process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`); };
  if (options.command === "setup") { setup(aws, log); return 0; }
  if (options.command === "plan") {
    const plan = linuxRuntimeSteps(workflowAt(options.commit!));
    process.stdout.write(`# replaced: ${plan.replaced.join(", ")}\n# skipped: ${plan.skipped.join("; ")}\n# --- bootstrap ---\n${bootstrapScript(options.repository, options.commit!)}\n# --- steps ---\n${stepsScript(plan.steps, options.keepGoing)}\n`);
    return 0;
  }
  mkdirSync(options.logDir, { recursive: true });
  const report = await runOnEc2(options, {
    aws, log,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    workflowAt,
    writeLog: (name, text) => writeFileSync(join(options.logDir, name), text),
    onSignal: (cleanup) => {
      const handler = (signal: NodeJS.Signals): void => { log(`${signal}: terminating the instance`); cleanup(); process.exit(130); };
      process.on("SIGINT", handler);
      process.on("SIGTERM", handler);
      return () => { process.off("SIGINT", handler); process.off("SIGTERM", handler); };
    },
  });
  writeFileSync(join(options.logDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${formatReport(report)}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("linux-runtime-ec2.ts")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => { process.stderr.write(`${(error as Error).message}\n`); process.exit(2); });
}

