import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { runE2EExecutor } from "../../packages/verifier/src/executor/run.js";
import type { InspectChromiumSandboxInput } from "../../packages/verifier/src/executor/chromium-sandbox.js";
import { localGuardInvocation } from "./agent-probe-guard.js";
import { FakeDockerCli } from "./fake-docker-cli.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
  });
}

/**
 * Where the executor would read Chromium's renderers from `/proc`, this machine (macOS) has no such thing, and its own Chromium sandbox is a different one.
 * The double answers with the facts a sandboxed Linux renderer shows, so a probe run here records an attestation of the right shape. It is never evidence that
 * a sandbox is on: the real attestation is read in the Linux CI job (`tests/linux`), on a real kernel, and a Linux host here reads its own `/proc`.
 */
export const standInChromiumSandbox: ((input: InspectChromiumSandboxInput) => Promise<never>) | undefined = process.platform === "linux" ? undefined
  : async (input) => ({ schemaVersion: "e2e-executor-chromium-sandbox/v1", runId: input.runId, groupId: input.groupId,
    browser: { pid: input.browserPid, nsPidDepth: 1, seccompFilters: 1, uidMap: "0 0 4294967295" },
    renderers: [{ pid: input.browserPid + 1, nsPidDepth: 2, seccompFilters: 2, uidMap: "0 1000 1" }] } as never);

/**
 * A Docker double whose "executor container" is the real executor running on this machine: it starts the staged candidate app as a local
 * process with the environment the host gave the app container, then runs the real `runE2EExecutor` (real Chromium for web probes) against it.
 * Everything else the production Docker host does (staging, seed, plan, snapshot, readback, cleanup) runs for real around it. It needs a
 * built verifier (`npm run build`) and, for web probes, a Playwright Chromium; Docker itself is not used. Build commands only succeed
 * or fail as `failOn("build", code)` says.
 */
export class LocalExecutorDocker extends FakeDockerCli {
  private readonly children: ChildProcess[] = [];
  /** What the local app process and the executor said, kept for a failing test to show. */
  appOutput = "";

  constructor() {
    super();
    this.onExecutor = async (outDir) => {
      const workspace = dirname(outDir);
      // The most recent app container: one double serves every probe of a qualification in turn.
      const app = [...this.calls].reverse().find((args) => args[0] === "run" && args.includes("--name") && args[args.indexOf("--name") + 1]!.startsWith("rovara-app-"))!;
      // The host ends the app container's arguments with the blanked environment, the image, then the recipe's program and arguments.
      const image = app.lastIndexOf("NODE_OPTIONS=") + 1;
      // The app-host probe starts the app behind a guard that reads this container's route table and times out against the host firewall. This double has
      // neither, so it starts the app itself, which is all the guard does once the host is walled off; the real guard runs only in the Linux CI job.
      const started = app.slice(image + 1);
      // The isolation probe's guard is run here too, on this machine's seams (see `localGuardInvocation`): the guard is what serves the page that probe ends on.
      const guardScript = started[1] === "--input-type=module" && started[3]?.includes("model-proxy") ? started[3] : null;
      const guard = guardScript === null ? null : localGuardInvocation(guardScript, await mkdtemp(join(tmpdir(), "rovara-local-guard-")));
      const command = guard !== null ? ["node", ...guard.args] : started[1] === "--input-type=module" ? ["node", "server.mjs"] : started;
      const workDir = app.at(app.indexOf("-w") + 1)!.replace(/^\/app/, join(workspace, "app"));
      // The read-only owned mount is a directory inside the app, where the app expects it.
      await cp(join(workspace, "owned"), join(workspace, "app", ".owned"), { recursive: true });
      const port = await freePort();
      const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
      app.forEach((value, index) => {
        if (app[index - 1] !== "-e" || !value.includes("=")) return;
        const [name, ...rest] = value.split("=");
        const text = rest.join("=");
        if (text !== "") env[name!] = text.replace("/app/.owned/", `${join(workspace, "app", ".owned")}/`);
      });
      env.APP_PORT = String(port);
      if (guard !== null) Object.assign(env, guard.env);
      const server = spawn(command[0] === "node" ? process.execPath : command[0]!, command.slice(1), { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] });
      server.stdout?.on("data", (chunk: Buffer) => { this.appOutput += chunk.toString(); });
      server.stderr?.on("data", (chunk: Buffer) => { this.appOutput += chunk.toString(); });
      this.appOutput += `spawn ${command.join(" ")} in ${workDir} on ${port} with ${Object.keys(env).join(",")}\n`;
      this.children.push(server);
      // A group with an agent step (Task 4.5): the host opened the model channel's socket under the run's workspace, where the container would mount it. The executor reads the socket path
      // from its plan in a container; run on this machine it takes the test seam instead.
      const plan = JSON.parse(await readFile(join(workspace, "plan.json"), "utf8")) as { modelChannel?: unknown };
      try {
        const result = await runE2EExecutor({ planPath: join(workspace, "plan.json"), outDir, signal: AbortSignal.timeout(240_000), localAppUpstream: `http://127.0.0.1:${port}`,
          ...(plan.modelChannel === undefined ? {} : { modelSocketPath: join(workspace, "model", "model.sock") }),
          ...(standInChromiumSandbox ? { inspectChromiumSandbox: standInChromiumSandbox } : {}) });
        this.exitCodeOfExecutor(result.exitCode);
      } finally { server.kill("SIGKILL"); }
    };
  }

  /** Stops any app process a test left running. */
  stop(): void { for (const child of this.children.splice(0)) child.kill("SIGKILL"); }
}
