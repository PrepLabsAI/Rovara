import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DockerCli } from "../../packages/verifier/src/host/docker-application-host.js";

type Resource = { kind: "container" | "network"; name: string; labels: Record<string, string>; state: "running" | "exited"; exitCode: number; logs: string };
type Result = { code: number; stdout: string; stderr: string };

/**
 * A recording Docker that keeps containers and networks in memory. The executor "container" is whatever `onExecutor`
 * does with the mounted out directory; the app "container" stays running until `exitDuringExecutor` ends it.
 */
export class FakeDockerCli implements DockerCli {
  readonly calls: string[][] = [];
  readonly timeouts: number[] = [];
  private readonly resources = new Map<string, Resource>();
  private readonly build = { exitCode: 0 };
  private hanging: "executor" | null = null;
  private executorExit = 0;
  private appExit: { code: number; logs: string } | null = null;
  private releaseExecutor: ((code: number) => void) | null = null;
  /** Writes the files a finished executor would leave in its out directory. */
  onExecutor: (outDir: string, args: string[]) => void | Promise<void> = () => undefined;
  logs = new Map<string, string>();
  /** The order of the moments a test may need to compare: an executor finishing, and containers being force-removed. */
  readonly events: string[] = [];
  networkCreateFails = false;
  /** Images the host does not hold: `image inspect` fails for them until they are pulled. */
  readonly missingImages = new Set<string>();
  /** `docker pull` calls that fail before one succeeds, and whether the image is on the host by the time the first of them reports failure (another process pulled it). */
  pullFailures = 0;
  imageArrivesDuringFailedPull = false;
  pullStderr = "pull access denied";
  appStartFails = false;
  /** When set, the executor "container" ignores the abort signal and finishes (with its normal output) only once this promise settles: the test, not a timer, decides when. */
  executorIgnoresAbortUntil: Promise<void> | null = null;
  /** Settles once the executor "container" is running (hung, gated or about to write its output): the point at which a test may cancel or expire the run. */
  readonly executorStarted: Promise<void>;
  private markExecutorStarted: () => void = () => undefined;
  /** The `timeoutMs` the host gave the executor's `docker run`, which is where the host's deadline reaches Docker. */
  executorTimeoutMs: number | null = null;
  buildOutput = "";
  executorStdout = "executor said hello\n";
  /** When set, starting a mock or sinkhole container fails, as `docker run` does when the image or the mounts are unusable. */
  mockStartFails = false;
  /** The host directory the mock containers write their ledgers to (the mount at /out/mock), once the first mock container was started. */
  mockOutDir: string | null = null;
  /** Origins whose mock container "died" when the executor started: the host must notice before it trusts any ledger. */
  readonly mocksDyingDuringExecutor = new Set<string>();
  /** Appends lines to an origin's ledger as the mock container would while the executor runs. */
  appendMockLedger(origin: string, lines: readonly unknown[]): void {
    if (this.mockOutDir === null) throw new Error("no mock container was started");
    appendFileSync(join(this.mockOutDir, `${origin}.jsonl`), lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join(""));
  }

  constructor() { this.executorStarted = new Promise<void>((resolve) => { this.markExecutorStarted = resolve; }); }

  failOn(what: "build", code: number): void { this.build.exitCode = code; void what; }
  hangOn(what: "executor"): void { this.hanging = what; }
  exitCodeOfExecutor(code: number): void { this.executorExit = code; }
  exitDuringExecutor(what: "app", code: number, logs: string): void { void what; this.appExit = { code, logs }; this.hanging = "executor"; }
  /** A labeled resource whose creation time is missing or unreadable: the sweep must leave it alone. */
  seedUnlabeled(runId: string, created: string): void {
    const labels: Record<string, string> = { "rovara.run": runId, ...(created === "" ? {} : { "rovara.created": created }) };
    this.resources.set(`rovara-app-${runId}`, { kind: "container", name: `rovara-app-${runId}`, labels, state: "running", exitCode: 0, logs: "" });
  }
  seedStale(input: { runId: string; ageMs: number; now: number }): void {
    const labels = { "rovara.run": input.runId, "rovara.created": String(input.now - input.ageMs) };
    this.resources.set(`rovara-app-${input.runId}`, { kind: "container", name: `rovara-app-${input.runId}`, labels, state: "running", exitCode: 0, logs: "" });
    for (const name of [`rovara-e2e-${input.runId}`, `rovara-e2e-build-${input.runId}`]) this.resources.set(name, { kind: "network", name, labels, state: "running", exitCode: 0, logs: "" });
  }

  liveResources(label: string): string[] {
    const [key, value] = label.split("=");
    return [...this.resources.values()].filter((item) => item.labels[key!] === value).map((item) => item.name);
  }
  networks(): string[] { return [...this.resources.values()].filter((item) => item.kind === "network").map((item) => item.name); }
  /** The arguments of the `docker run` call that created the named kind of container. */
  argsFor(kind: "app" | "executor" | "build"): string[] {
    const found = this.calls.find((args) => args[0] === "run" && args.includes("--name") && args[args.indexOf("--name") + 1]!.startsWith(`rovara-${kind}-`));
    if (!found) throw new Error(`no ${kind} container was started`);
    return found;
  }
  /** The arguments of the `docker run` call that started the mock (or, with `unbound`, the sinkhole) of one origin. */
  mockArgsFor(origin: string): string[] {
    const found = this.calls.find((args) => args[0] === "run" && args.includes("--name") && /^rovara-mock-.+/.test(args[args.indexOf("--name") + 1]!)
      && args[args.indexOf("--origin") + 1] === origin);
    if (!found) throw new Error(`no mock container was started for ${origin}`);
    return found;
  }
  /** Every origin that has a mock or sinkhole container, in the order they were started. */
  mockOrigins(): string[] {
    return this.calls.filter((args) => args[0] === "run" && args.includes("--name") && /^rovara-mock-/.test(args[args.indexOf("--name") + 1]!)).map((args) => args[args.indexOf("--origin") + 1]!);
  }
  /** The timeout each build container was given, in order (the first is the source copy). */
  buildTimeouts(): number[] { return this.calls.flatMap((args, index) => (args[0] === "run" && args.includes("--name") && args[args.indexOf("--name") + 1]!.startsWith("rovara-build-") ? [this.timeouts[index]!] : [])); }
  call(prefix: string): string[] {
    const words = prefix.split(" ");
    const found = this.calls.find((args) => words.every((word, index) => args[index] === word));
    if (!found) throw new Error(`no docker call starts with "${prefix}"`);
    return found;
  }
  mountsFor(kind: "app" | "executor"): string[] {
    const args = this.argsFor(kind);
    return args.flatMap((value, index) => (args[index - 1] === "-v" ? [value] : []));
  }

  private mark(args: string[]): Record<string, string> {
    const labels: Record<string, string> = {};
    args.forEach((value, index) => { if (args[index - 1] === "--label") { const [key, ...rest] = value.split("="); labels[key!] = rest.join("="); } });
    return labels;
  }
  private match(resource: Resource, filter: string | undefined): boolean {
    if (!filter) return true;
    const [key, value] = filter.replace(/^label=/, "").split("=");
    return value === undefined ? key! in resource.labels : resource.labels[key!] === value;
  }
  private list(kind: Resource["kind"], args: string[]): Result {
    const filter = args[args.indexOf("--filter") + 1];
    const format = args[args.indexOf("--format") + 1] ?? "";
    const rows = [...this.resources.values()].filter((item) => item.kind === kind && this.match(item, filter))
      .map((item) => (format.includes("\t") ? `${item.name}\t${item.labels["rovara.run"] ?? ""}\t${item.labels["rovara.created"] ?? ""}` : item.name));
    return { code: 0, stdout: rows.join("\n"), stderr: "" };
  }

  async run(args: string[], opts: { signal: AbortSignal; timeoutMs: number }): Promise<Result> {
    this.calls.push(args);
    this.timeouts.push(opts.timeoutMs);
    const [command, sub] = args;
    if (command === "network" && sub === "create") {
      if (this.networkCreateFails) return { code: 1, stdout: "", stderr: "network create refused" };
      const name = args[args.length - 1]!;
      this.resources.set(name, { kind: "network", name, labels: this.mark(args), state: "running", exitCode: 0, logs: "" });
      return { code: 0, stdout: name, stderr: "" };
    }
    if (command === "network" && sub === "rm") {
      const removed = args.slice(2).map((name) => this.resources.delete(name));
      return removed.every(Boolean) ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "No such network" };
    }
    if (command === "network" && sub === "ls") return this.list("network", args);
    if (command === "ps") return this.list("container", args);
    if (command === "kill") {
      for (const name of args.slice(1)) {
        const item = this.resources.get(name);
        if (item) { item.state = "exited"; item.exitCode = 137; }
        this.events.push(`kill ${name}`);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "rm") {
      for (const name of args.slice(2)) {
        this.resources.delete(name);
        this.events.push(`rm ${name}`);
        if (name.startsWith("rovara-executor-")) this.releaseExecutor?.(137);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "inspect") {
      const item = this.resources.get(args[args.length - 1]!);
      return item ? { code: 0, stdout: `${item.state} ${item.exitCode}`, stderr: "" } : { code: 1, stdout: "", stderr: "No such object" };
    }
    if (command === "logs") return { code: 0, stdout: "", stderr: this.resources.get(args[args.length - 1]!)?.logs ?? this.logs.get(args[args.length - 1]!) ?? "" };
    if (command === "image" && sub === "inspect") return this.missingImages.has(args[2]!) ? { code: 1, stdout: "", stderr: "No such image" } : { code: 0, stdout: "", stderr: "" };
    if (command === "pull") {
      if (this.pullFailures > 0) {
        this.pullFailures -= 1;
        if (this.imageArrivesDuringFailedPull) this.missingImages.delete(args[1]!);
        return { code: 1, stdout: "", stderr: this.pullStderr };
      }
      this.missingImages.delete(args[1]!);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "run") return this.runContainer(args, opts);
    return { code: 0, stdout: "", stderr: "" };
  }

  private async runContainer(args: string[], opts: { signal: AbortSignal; timeoutMs: number }): Promise<Result> {
    const name = args.includes("--name") ? args[args.indexOf("--name") + 1]! : "";
    if (name.startsWith("rovara-app-")) {
      if (this.appStartFails) return { code: 125, stdout: "", stderr: "docker: Error response from daemon: cannot start the app container" };
      this.resources.set(name, { kind: "container", name, labels: this.mark(args), state: "running", exitCode: 0, logs: "" });
      return { code: 0, stdout: "container-id", stderr: "" };
    }
    if (name.startsWith("rovara-mock-")) {
      if (this.mockStartFails) return { code: 125, stdout: "", stderr: "docker: Error response from daemon: cannot start the mock container" };
      this.resources.set(name, { kind: "container", name, labels: this.mark(args), state: "running", exitCode: 0, logs: "" });
      const mount = args.find((value, index) => args[index - 1] === "-v" && value.endsWith(":/out/mock"));
      if (mount === undefined) return { code: 125, stdout: "", stderr: "docker: the mock container has no ledger mount" };
      this.mockOutDir = mount.replace(/:\/out\/mock$/, "");
      mkdirSync(this.mockOutDir, { recursive: true });
      // The mock opens its ledger before it listens, which is what the host waits for.
      writeFileSync(join(this.mockOutDir, `${args[args.indexOf("--origin") + 1]}.jsonl`), "", { flag: "a" });
      return { code: 0, stdout: "container-id", stderr: "" };
    }
    if (name.startsWith("rovara-build-")) {
      const index = Number(name.split("-").at(-1));
      const failing = index > 0 && this.build.exitCode !== 0;
      return { code: failing ? this.build.exitCode : 0, stdout: failing ? this.buildOutput : "", stderr: "" };
    }
    if (name.startsWith("rovara-executor-")) {
      this.resources.set(name, { kind: "container", name, labels: this.mark(args), state: "running", exitCode: 0, logs: "" });
      this.executorTimeoutMs = opts.timeoutMs;
      this.markExecutorStarted();
      const outMount = args.find((value, index) => args[index - 1] === "-v" && value.endsWith(":/out"))!.replace(/:\/out$/, "");
      for (const origin of this.mocksDyingDuringExecutor) {
        const mock = [...this.resources.values()].find((item) => item.name.startsWith("rovara-mock-") && item.name.endsWith(`-${origin}`));
        if (mock) { mock.state = "exited"; mock.exitCode = 2; }
      }
      if (this.appExit) {
        const app = [...this.resources.values()].find((item) => item.name.startsWith("rovara-app-"))!;
        setTimeout(() => { app.state = "exited"; app.exitCode = this.appExit!.code; app.logs = this.appExit!.logs; }, 15);
      }
      if (this.hanging === "executor") {
        const code = await new Promise<number>((resolve) => {
          this.releaseExecutor = resolve;
          const timer = setTimeout(() => resolve(124), opts.timeoutMs);
          opts.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(130); }, { once: true });
        });
        return { code, stdout: "", stderr: "" };
      }
      if (this.executorIgnoresAbortUntil !== null) await this.executorIgnoresAbortUntil;
      await this.onExecutor(outMount, args);
      this.events.push("executor finished");
      return { code: this.executorExit, stdout: this.executorStdout, stderr: "" };
    }
    // Anything else (the throwaway root cleanup container) just succeeds.
    return { code: 0, stdout: "", stderr: "" };
  }
}

/** The files `runE2EExecutor` leaves behind for a run that ended with `exitCode`; shards stay empty. */
export function writeExecutorOutput(outDir: string, input: { exitCode: 0 | 1 | 2; reason: string | null; runId: string; groupId: string }): void {
  mkdirSync(join(outDir, "observations"), { recursive: true });
  writeFileSync(join(outDir, "executor-result.json"), JSON.stringify({ schemaVersion: "e2e-executor-result/v1", exitCode: input.exitCode, reason: input.reason,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    node: { version: "v22.23.2", execPath: "/usr/local/bin/node", platform: "linux", arch: "arm64" }, runId: input.runId, groupId: input.groupId, shards: [] }));
  writeFileSync(join(outDir, "report.json"), "{}");
  writeFileSync(join(outDir, "secret.txt"), "unscanned output");
}
