import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkerInvocation } from "@agentx/contracts";
import type { FixtureEdit, FixtureMode } from "../fixture-worker.js";

const execFileAsync = promisify(execFile);

export interface IsolatedRuntimeConfig {
  /** Runtime CLI used by the orchestrator only. Its socket is never given to a worker. */
  docker: string;
  dockerHost: string;
  image: string;
  /** Aggregate ceiling for one invocation, well inside the approved envelope. */
  memoryBytes: number;
  pidsLimit: number;
  deadlineMs: number;
  scratchBytes: number;
}

export const DEFAULT_ISOLATED_IMAGE = "agentx-fixture-worker:lane-b";

/** Resolve runtime configuration from the environment, with the approved ceilings. */
export function resolveIsolatedRuntimeConfig(environment: NodeJS.ProcessEnv): IsolatedRuntimeConfig {
  return {
    docker:
      environment.CHARTERARC_DOCKER ??
      "/Users/abhishekgarg/Documents/ChatGPT/ManagedSDLC/.local/toolchain/bin/docker",
    dockerHost:
      environment.DOCKER_HOST ??
      "unix:///Users/abhishekgarg/.colima/charterarc-team-tasks/docker.sock",
    image: environment.CHARTERARC_FIXTURE_IMAGE ?? DEFAULT_ISOLATED_IMAGE,
    // One container per invocation, 2 GiB of the 6 GiB aggregate ceiling.
    memoryBytes: 2 * 1024 * 1024 * 1024,
    pidsLimit: 256,
    deadlineMs: 10 * 60 * 1000,
    scratchBytes: 512 * 1024 * 1024,
  };
}

/**
 * What this boundary actually enforces.
 *
 * `enforcedScope` is false and stays false. A container denies the network and confines
 * the filesystem the worker can see, but nothing here denies a write to an arbitrary
 * path *inside* that filesystem, which is what a path allowlist would have to mean. A
 * sparse checkout would not change that: paths that do not exist yet can still be
 * created, and rejecting a candidate after the writes happened is detection, not
 * containment. Requests that require it are refused instead.
 */
export function isolatedCapabilities(): {
  enforcedScope: false;
  enforcedScopeGap: string;
  enforcedDeadline: false;
  enforcedDeadlineNote: string;
  observedLive: false;
} {
  return {
    enforcedScope: false,
    enforcedScopeGap:
      "no independent runtime boundary denies writes or escapes per path; container filesystem " +
      "confinement is not path containment and capture-time refusal is detection, not containment",
    enforcedDeadline: false,
    enforcedDeadlineNote:
      "the orchestrator terminates the container and its children on deadline, which is real " +
      "termination; it is not the same as a per-job deadline enforced inside the executor, and " +
      "no ManagedSDLC capability flag is set from it",
    observedLive: false,
  };
}

export interface IsolatedRunResult {
  cid: string;
  exitCode: number;
  outcome: "completed" | "timed_out" | "unknown";
  operationId: string;
  workspaceId: string;
  /** Minted by the host for this exact operation and fence; never sent to the container. */
  callbackCapability: string;
  events: Array<{ type: string; payload: unknown }>;
  artifacts: Array<{ name: string; mediaType: string; content: string; id?: string }>;
  terminal: { operationId: string; status: "SUCCEEDED" | "FAILED"; result?: unknown; error?: string };
  cleanup: "removed" | "unknown";
  stderr: string;
}

export interface DenialReport {
  externalNetwork: "denied" | "reachable" | "unknown";
  hostGateway: "denied" | "reachable" | "unknown";
  runtimeSocket: "denied" | "reachable" | "unknown";
  otherRunNetwork: "denied" | "reachable" | "unknown";
}

const DEFAULT_EDITS: FixtureEdit[] = [
  { path: "src/filter.txt", correct: "all|open|done+pagination\n", defective: "all|open|done\n" },
  { path: "src/isolation.txt", correct: "team-scoped\n", defective: "team-scoped\n" },
];

/**
 * Runs the fixture worker in an invocation-owned container.
 *
 * Every container is created with no network, no added capabilities, no host mount, a
 * read-only root filesystem and a tmpfs scratch. Identity is the runtime-issued
 * container id returned at create time; nothing here inspects or terminates by name,
 * because a name is not proof that the thing you are killing is the thing you made.
 */
export class IsolatedFixtureRuntime {
  constructor(private readonly config: IsolatedRuntimeConfig) {}

  static async probe(config: IsolatedRuntimeConfig): Promise<{ available: boolean; reason?: string; serverVersion?: string }> {
    try {
      const version = await execFileAsync(config.docker, ["version", "--format", "{{.Server.Version}}"], {
        env: { ...process.env, DOCKER_HOST: config.dockerHost },
        timeout: 30_000,
      });
      const image = await execFileAsync(config.docker, ["image", "inspect", config.image, "--format", "{{.Id}}"], {
        env: { ...process.env, DOCKER_HOST: config.dockerHost },
        timeout: 30_000,
      }).catch(() => undefined);
      if (!image) return { available: false, reason: `image ${config.image} is not built on this daemon` };
      return { available: true, serverVersion: version.stdout.trim() };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : "runtime unavailable" };
    }
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, DOCKER_HOST: this.config.dockerHost };
  }

  private baseCreateArgs(label: string): string[] {
    return [
      "create",
      "--label", `charterarc.lane=b`,
      "--label", `charterarc.invocation=${label}`,
      "--network", "none",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--tmpfs", `/scratch:rw,size=${Math.floor(this.config.scratchBytes / (1024 * 1024))}m,mode=1777`,
      "--tmpfs", "/tmp:rw,size=64m,mode=1777",
      "--memory", String(this.config.memoryBytes),
      "--pids-limit", String(this.config.pidsLimit),
      "--cpus", "2",
    ];
  }

  /**
   * Run one task invocation in its own container.
   *
   * The workspace and the invocation are streamed in on stdin and the produced events,
   * artifacts and terminal record are streamed back on stdout. Nothing is mounted and
   * nothing is baked in per job, so the image is identical for every run.
   */
  async runTask(input: {
    invocation: WorkerInvocation;
    workspacePath: string;
    mode: FixtureMode;
    edits?: readonly FixtureEdit[];
    deadlineMs?: number;
  }): Promise<IsolatedRunResult> {
    const label = randomUUID();
    const staging = await mkdtemp(join(tmpdir(), "agentx-iso-stage-"));
    try {
      await writeFile(join(staging, "invocation.json"), JSON.stringify(input.invocation));
      await writeFile(join(staging, "edits.json"), JSON.stringify(input.edits ?? DEFAULT_EDITS));

      const created = await execFileAsync(
        this.config.docker,
        [
          ...this.baseCreateArgs(label),
          "--env", `FIXTURE_MODE=${input.mode}`,
          "--interactive",
          this.config.image,
        ],
        { env: this.env(), timeout: 60_000 },
      );
      const cid = created.stdout.trim();

      const payload = await this.buildPayload(staging, input.workspacePath);
      const run = await this.startAndStream(cid, payload, input.deadlineMs ?? this.config.deadlineMs);
      const cleanup = await this.cleanupOutcomeFor(cid);

      if (run.outcome !== "completed") {
        return {
          cid, exitCode: run.exitCode, outcome: run.outcome, operationId: input.invocation.operationId,
          workspaceId: input.invocation.workspaceId,
          callbackCapability: input.invocation.callbackCapability,
          events: [], artifacts: [],
          terminal: { operationId: input.invocation.operationId, status: "FAILED", error: run.outcome },
          cleanup, stderr: run.stderr,
        };
      }

      const extracted = await this.extract(run.stdout);
      return {
        cid, exitCode: run.exitCode, outcome: "completed", operationId: input.invocation.operationId,
        workspaceId: input.invocation.workspaceId,
        callbackCapability: input.invocation.callbackCapability,
        events: extracted.events, artifacts: extracted.artifacts, terminal: extracted.terminal,
        cleanup, stderr: run.stderr,
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** Tar of `{invocation.json, edits.json, workspace/}` for the container's stdin. */
  private async buildPayload(staging: string, workspacePath: string): Promise<Buffer> {
    const archive = join(staging, "payload.tar");
    await execFileAsync("tar", ["-c", "-f", archive, "-C", staging, "invocation.json", "edits.json"], {
      timeout: 60_000,
    });
    await execFileAsync("tar", ["-r", "-f", archive, "-C", workspacePath, "--transform", "s,^\\.,workspace,", "."], {
      timeout: 300_000,
    }).catch(async () => {
      // BSD tar has no --transform; stage the workspace under the expected name instead.
      await execFileAsync("cp", ["-R", workspacePath, join(staging, "workspace")], { timeout: 300_000 });
      await execFileAsync("tar", ["-r", "-f", archive, "-C", staging, "workspace"], { timeout: 300_000 });
    });
    const { readFile } = await import("node:fs/promises");
    return readFile(archive);
  }

  private startAndStream(
    cid: string,
    payload: Buffer,
    deadlineMs: number,
  ): Promise<{ exitCode: number; outcome: "completed" | "timed_out"; stdout: Buffer; stderr: string }> {
    return new Promise((resolvePromise) => {
      const child = spawn(this.config.docker, ["start", "--attach", "--interactive", cid], {
        env: this.env(), stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Terminate by runtime-issued id, never by name.
        void execFileAsync(this.config.docker, ["kill", cid], { env: this.env(), timeout: 60_000 })
          .catch(() => undefined);
      }, deadlineMs);
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolvePromise({
          exitCode: code ?? -1,
          outcome: timedOut ? "timed_out" : "completed",
          stdout: Buffer.concat(chunks),
          stderr,
        });
      });
      child.stdin.end(payload);
    });
  }

  private async extract(stdout: Buffer): Promise<{
    events: IsolatedRunResult["events"];
    artifacts: IsolatedRunResult["artifacts"];
    terminal: IsolatedRunResult["terminal"];
  }> {
    const directory = await mkdtemp(join(tmpdir(), "agentx-iso-out-"));
    try {
      const archive = join(directory, "out.tar");
      await writeFile(archive, stdout);
      await execFileAsync("tar", ["-x", "-f", archive, "-C", directory], { timeout: 120_000 });
      const { readFile, readdir } = await import("node:fs/promises");
      const events = JSON.parse(await readFile(join(directory, "events.json"), "utf8")) as
        IsolatedRunResult["events"];
      const index = JSON.parse(await readFile(join(directory, "artifacts.json"), "utf8")) as
        Array<{ file: string; name: string }>;
      const terminal = JSON.parse(await readFile(join(directory, "terminal.json"), "utf8")) as
        IsolatedRunResult["terminal"];
      const names = new Set(await readdir(join(directory, "artifacts")).catch(() => []));
      const artifacts: IsolatedRunResult["artifacts"] = [];
      for (const entry of index) {
        if (!names.has(entry.file)) continue;
        artifacts.push(
          JSON.parse(await readFile(join(directory, "artifacts", entry.file), "utf8")) as
            IsolatedRunResult["artifacts"][number],
        );
      }
      return { events, artifacts, terminal };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Remove one invocation-owned container and say what we actually know.
   *
   * A removal we could not confirm is `unknown`. It is never reported as success,
   * because an uncertain cleanup is exactly the state that must not pass a gate.
   */
  async cleanupOutcomeFor(cid: string): Promise<"removed" | "unknown"> {
    // Observe that the container is there before claiming to have removed it. `rm
    // --force` succeeds on an id that never existed, so trusting its exit status would
    // report a clean removal of something this process never owned or saw.
    const existed = await execFileAsync(this.config.docker, ["inspect", cid], {
      env: this.env(), timeout: 30_000,
    }).then(() => true).catch(() => false);
    if (!existed) return "unknown";

    try {
      await execFileAsync(this.config.docker, ["rm", "--force", cid], { env: this.env(), timeout: 60_000 });
    } catch {
      return "unknown";
    }
    // And observe that it is gone afterwards. Anything else is an uncertain cleanup,
    // which is exactly the state that must not pass a gate.
    const stillPresent = await execFileAsync(this.config.docker, ["inspect", cid], {
      env: this.env(), timeout: 30_000,
    }).then(() => true).catch(() => false);
    return stillPresent ? "unknown" : "removed";
  }

  /** Run a bounded probe container and return its exit status and output. */
  private async probeContainer(argv: string[], network?: string): Promise<{ exitCode: number; output: string }> {
    const label = randomUUID();
    const args = [...this.baseCreateArgs(label)];
    if (network !== undefined) {
      const index = args.indexOf("--network");
      args[index + 1] = network;
    }
    const created = await execFileAsync(
      this.config.docker,
      [...args, "--entrypoint", "sh", this.config.image, "-c", argv.join(" ")],
      { env: this.env(), timeout: 60_000 },
    );
    const cid = created.stdout.trim();
    try {
      const result = await execFileAsync(this.config.docker, ["start", "--attach", cid], {
        env: this.env(), timeout: 120_000,
      }).catch((error: { code?: number; stdout?: string; stderr?: string }) => ({
        stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code,
      }));
      const inspected = await execFileAsync(
        this.config.docker, ["inspect", cid, "--format", "{{.State.ExitCode}}"],
        { env: this.env(), timeout: 30_000 },
      );
      return {
        exitCode: Number.parseInt(inspected.stdout.trim(), 10),
        output: `${result.stdout ?? ""}${"stderr" in result ? result.stderr ?? "" : ""}`,
      };
    } finally {
      await this.cleanupOutcomeFor(cid);
    }
  }

  /**
   * Demonstrate the denials this boundary claims.
   *
   * Each is a real container attempting the reach and failing, not an assertion about a
   * flag. `--network none` is the mechanism; the probes are what make it evidence.
   */
  async probeDenials(): Promise<DenialReport> {
    const unreachable = (result: { exitCode: number }) => (result.exitCode === 0 ? "reachable" : "denied");
    const external = await this.probeContainer([
      "getent hosts example.com >/dev/null 2>&1 && echo RESOLVED && exit 0; exit 9",
    ]);
    const gateway = await this.probeContainer([
      "node -e \"require('net').connect({host:'host.docker.internal',port:2375})" +
        ".on('connect',()=>process.exit(0)).on('error',()=>process.exit(9))\" >/dev/null 2>&1; " +
        "test $? -eq 0 && exit 0; exit 9",
    ]);
    const socket = await this.probeContainer(["test -S /var/run/docker.sock && exit 0; exit 9"]);
    // Another run's network must not be joinable. The evidence is the interface list
    // itself: with only loopback present there is no attachment to any other run's
    // network to begin with. /sys/class/net is always there, unlike `ip`, so this probe
    // cannot pass merely because a tool is missing.
    const otherRun = await this.probeContainer([
      "ls /sys/class/net | grep -qv '^lo$' && exit 0; exit 9",
    ]);
    return {
      externalNetwork: unreachable(external),
      hostGateway: unreachable(gateway),
      runtimeSocket: unreachable(socket),
      otherRunNetwork: unreachable(otherRun),
    };
  }

  /** Start a long-running container and prove the deadline terminates it. */
  async runUntilDeadline(input: { sleepSeconds: number; deadlineMs: number }): Promise<{
    cid: string; outcome: "timed_out" | "completed"; terminated: boolean; observedRunning: boolean;
  }> {
    const label = randomUUID();
    const created = await execFileAsync(
      this.config.docker,
      [
        ...this.baseCreateArgs(label),
        "--entrypoint", "sh", this.config.image, "-c",
        `sleep ${input.sleepSeconds} & wait`,
      ],
      { env: this.env(), timeout: 60_000 },
    );
    const cid = created.stdout.trim();
    const run = await this.startAndStream(cid, Buffer.alloc(0), input.deadlineMs);
    const running = await execFileAsync(
      this.config.docker, ["inspect", cid, "--format", "{{.State.Running}}"],
      { env: this.env(), timeout: 30_000 },
    ).then((value) => value.stdout.trim() === "true").catch(() => false);
    await this.cleanupOutcomeFor(cid);
    return {
      cid,
      outcome: run.outcome,
      terminated: run.outcome === "timed_out" && !running,
      observedRunning: running,
    };
  }

  /**
   * Record a run whose outcome we could not observe.
   *
   * It writes nothing to the operation. A host that cannot see what a worker did must
   * not turn its own recovery policy into evidence that the work failed its checks.
   */
  async recordUnobservedRun(operationId: string): Promise<{ operationId: string; outcome: "unknown" }> {
    return { operationId, outcome: "unknown" };
  }
}
