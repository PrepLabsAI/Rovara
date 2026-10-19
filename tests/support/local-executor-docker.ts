import { spawn, type ChildProcess } from "node:child_process";
import { cp } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { runE2EExecutor } from "../../packages/verifier/src/executor/run.js";
import { FakeDockerCli } from "./fake-docker-cli.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
  });
}

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
      const command = started[1] === "--input-type=module" ? ["node", "server.mjs"] : started;
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
      const server = spawn(command[0] === "node" ? process.execPath : command[0]!, command.slice(1), { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] });
      server.stdout?.on("data", (chunk: Buffer) => { this.appOutput += chunk.toString(); });
      server.stderr?.on("data", (chunk: Buffer) => { this.appOutput += chunk.toString(); });
      this.appOutput += `spawn ${command.join(" ")} in ${workDir} on ${port} with ${Object.keys(env).join(",")}\n`;
      this.children.push(server);
      try {
        const result = await runE2EExecutor({ planPath: join(workspace, "plan.json"), outDir, signal: AbortSignal.timeout(240_000), localAppUpstream: `http://127.0.0.1:${port}` });
        this.exitCodeOfExecutor(result.exitCode);
      } finally { server.kill("SIGKILL"); }
    };
  }

  /** Stops any app process a test left running. */
  stop(): void { for (const child of this.children.splice(0)) child.kill("SIGKILL"); }
}
