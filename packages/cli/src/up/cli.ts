// Port lane L4: `rovara up`, the local runtime in one process, and `rovara up --check`, its doctor. No task flow and no pages yet: this
// starts the HTTP server on 127.0.0.1 over the plug-in registry, the Docker worker machines, and one implicit company.
import { homedir } from "node:os";
import { join } from "node:path";
import { agentXError } from "@agentx/contracts";
import { SERVER_FILE_NAME, SESSION_TOKEN_FILE_NAME, createDockerRunner, defaultStateDirectory, readOwnerFile, startLocalRuntime, type DockerRunner, type LocalRuntime, type LocalRuntimeOptions } from "@agentx/broker/local";
import type { Command } from "commander";
import type { TextWriter } from "../init/prompts.js";
import { runUpChecks, upChecksText, type UpCheck, type UpCheckServices } from "./checks.js";

export const DEFAULT_LOCAL_WORKER_IMAGE = "rovara-worker:local";

export interface UpCommandContext {
  home?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  stdout: TextWriter;
  stderr: TextWriter;
  version: string;
  fetch: typeof fetch;
  docker?: DockerRunner;
  /** Tests substitute these; the real ones start the server and wait for Ctrl-C. */
  start?: (options: LocalRuntimeOptions) => Promise<LocalRuntime>;
  waitForShutdown?: () => Promise<void>;
  checkServices?: Partial<UpCheckServices>;
}

interface UpOptions {
  check?: boolean;
  port?: string;
  config?: string;
  stateDir?: string;
  workerImage?: string;
  thisMachine?: boolean;
}

function parsePort(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const port = Number(text);
  if (!/^\d{1,5}$/.test(text) || port > 65_535) throw agentXError("CONFIG_INVALID", "--port must be a number from 0 to 65535");
  return port;
}

function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

/**
 * `rovara open [task]`: asks the running `rovara up` to open the review page in your browser (a task's plan, or the list of what waits for you). The address carries your page session and can
 * approve, so it is never sent here or printed: the running process opens the browser itself.
 */
export function registerOpenCommand(program: Command, context: Pick<UpCommandContext, "home" | "stdout" | "fetch">): void {
  program
    .command("open [task]")
    .description("open the local review page for a task (or for everything that waits for you) in your browser; `rovara up` must be running")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (task: string | undefined, options: { stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      if (task !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(task)) throw agentXError("CONFIG_INVALID", "name a task by its id (a UUID), or leave it out");
      const stateDirectory = options.stateDir ?? defaultStateDirectory(context.home ?? homedir());
      const server = await readOwnerFile(join(stateDirectory, SERVER_FILE_NAME), { private: false, label: "server file" }).catch(() => undefined);
      const secret = await readOwnerFile(join(stateDirectory, SESSION_TOKEN_FILE_NAME), { private: true, label: "session token" }).catch(() => undefined);
      let url: string | undefined;
      try { url = server === undefined ? undefined : (JSON.parse(server.text) as { url?: unknown }).url as string | undefined; } catch { url = undefined; }
      if (url === undefined || secret === undefined || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw agentXError("RUNTIME_UNAVAILABLE", "Rovara is not running here. Start it with `rovara up` first.");
      let response: Response;
      try {
        response = await context.fetch(`${url}/v1/local/pages/open`, {
          method: "POST", headers: { authorization: `Bearer ${secret.text.trim()}`, "content-type": "application/json" },
          body: JSON.stringify({ path: task === undefined ? "/" : `/plan/${task}` }), signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw agentXError("RUNTIME_UNAVAILABLE", "Rovara is not answering at its address. Start it again with `rovara up`.");
      }
      const body = (await response.json().catch(() => ({}))) as { opened?: unknown; error?: { message?: unknown } };
      if (!response.ok || body.opened !== true) throw agentXError("RUNTIME_UNAVAILABLE", typeof body.error?.message === "string" ? body.error.message : "Rovara would not open the page; is `rovara up` running with this state folder?");
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data: { opened: true } })}\n` : "Opened in your browser.\n");
    });
}

export function registerUpCommand(program: Command, context: UpCommandContext): void {
  program
    .command("up")
    .description("run Rovara on this computer: one local process on 127.0.0.1 with Docker workers (--check verifies Docker, keys, GitHub and the port)")
    .option("--check", "check what `rovara up` needs and say how to fix each problem; starts nothing")
    .option("--port <port>", "the port on 127.0.0.1 (default: a free one)")
    .option("--config <path>", "the plug-in config (default: ~/.rovara/config.json, made on first run); never put it inside a repository")
    .option("--state-dir <path>", "the folder for config, keys and workspaces (default: ~/.rovara)")
    .option("--worker-image <image>", `the worker image (default: $ROVARA_WORKER_IMAGE or ${DEFAULT_LOCAL_WORKER_IMAGE})`)
    .option("--this-machine", "name the worker-on-this-machine adapter as allowed (it is not built yet)")
    .action(async (options: UpOptions, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      const environment = context.environment ?? process.env;
      const stateDirectory = options.stateDir ?? defaultStateDirectory(context.home ?? homedir());
      const workerImage = options.workerImage ?? environment.ROVARA_WORKER_IMAGE ?? DEFAULT_LOCAL_WORKER_IMAGE;
      const port = parsePort(options.port);
      const docker = context.docker ?? createDockerRunner(environment);
      const checkServices = (verifyGithub: boolean): UpCheckServices => ({
        docker, environment, stateDirectory, configPath: options.config, workerImage, port, fetch: context.fetch, verifyGithub, cwd: context.cwd ?? process.cwd(), home: context.home ?? homedir(), ...context.checkServices,
      });

      if (options.check === true) {
        const checks = await runUpChecks(checkServices(true));
        const failed = checks.filter((check) => check.status === "fail").length;
        context.stdout.write(globals.json ? `${JSON.stringify({ ok: failed === 0, data: { checks } })}\n` : upChecksText(checks));
        if (failed > 0) throw agentXError("CONFIG_INVALID", `${failed} ${failed === 1 ? "check" : "checks"} failed; fix what each one names, then run rovara up --check again`);
        return;
      }

      // The quick check: problems are told, never blocking (Docker is needed only when a task starts).
      const notes = (await runUpChecks(checkServices(false)).catch((): UpCheck[] => [])).filter((check) => check.status !== "ok");
      for (const note of notes) context.stderr.write(`note: ${note.summary}${note.fix === undefined ? "" : ` ${note.fix}`}\n`);

      const runtime = await (context.start ?? startLocalRuntime)({
        stateDirectory,
        configPath: options.config,
        cwd: context.cwd ?? process.cwd(),
        environment,
        port,
        workerImage,
        thisMachine: options.thisMachine === true,
        docker,
        version: context.version,
        ...(context.checkServices?.gh === undefined ? {} : { gh: context.checkServices.gh }),
        fetch: context.fetch,
      });
      const summary = {
        url: runtime.url,
        port: runtime.port,
        config: runtime.configPath,
        sessionTokenFile: runtime.sessionTokenPath,
        wiring: runtime.wiring(),
      };
      context.stdout.write(globals.json
        ? `${JSON.stringify({ ok: true, data: summary })}\n`
        : `Rovara is running at ${runtime.url} (this computer only).\nconfig:        ${runtime.configPath}\nsession token: ${runtime.sessionTokenPath} (send it as "Authorization: Bearer <token>")\nworker image:  ${workerImage}\nreview pages:  ${runtime.pagesUrl} (run \`rovara open\` to open them in your browser; a plan is approved there, by you)\nPress Ctrl-C to stop; running workers are stopped and their workspaces kept.\n`);
      try {
        await (context.waitForShutdown ?? untilSignal)();
      } finally {
        await runtime.stop();
      }
      context.stderr.write(`Rovara stopped. Your files are in ${join(stateDirectory, "workspaces")}.\n`);
    });
}
