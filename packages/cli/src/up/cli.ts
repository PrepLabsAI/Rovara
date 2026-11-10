// Port lane L4: `rovara up`, the local runtime in one process, and `rovara up --check`, its doctor. No task flow and no pages yet: this
// starts the HTTP server on 127.0.0.1 over the plug-in registry, the Docker worker machines, and one implicit company.
import { homedir } from "node:os";
import { join } from "node:path";
import { TaskDiagnosisViewReaderSchema, agentXError, diagnosisProposalLine } from "@agentx/contracts";
import { createDockerRunner, defaultStateDirectory, startLocalRuntime, type DockerRunner, type LocalRuntime, type LocalRuntimeOptions } from "@agentx/broker/local";
import type { Command } from "commander";
import type { TextWriter } from "../init/prompts.js";
import { runUpChecks, upChecksText, type UpCheck, type UpCheckServices } from "./checks.js";
import { terminalSafe } from "../session/app-request.js";
import { requireLocalRuntime } from "./local-runtime.js";

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

/** One signed-in call to the running `rovara up`. A refusal is told in the server's own fixed words. */
async function localCall(context: Pick<UpCommandContext, "home" | "fetch">, stateDir: string | undefined, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const { url, secret: token } = await requireLocalRuntime(context.home ?? homedir(), stateDir);
  let response: Response;
  try {
    response = await context.fetch(`${url}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "Rovara is not answering at its address. Start it again with `rovara up`.");
  }
  const answer = (await response.json().catch(() => ({}))) as { error?: { code?: unknown; message?: unknown } };
  if (!response.ok) throw agentXError(response.status === 403 ? "FORBIDDEN" : response.status === 404 ? "NOT_FOUND" : response.status === 400 ? "CONFIG_INVALID" : "RUNTIME_UNAVAILABLE", typeof answer.error?.message === "string" ? answer.error.message : `Rovara answered HTTP ${String(response.status)}.`);
  return answer;
}

/**
 * `rovara second-review`: what the second review is doing (who gives the second opinion, how it counts). Choosing the model, the mode, withdrawing evidence and recording it happen on its local page
 * (`rovara open second-review`): they are the owner's own acts in the browser, never a token's.
 */
export function registerSecondReviewCommand(program: Command, context: Pick<UpCommandContext, "home" | "stdout" | "fetch">): void {
  const secondReview = program.command("second-review").description("show the second review (a second opinion from a model of a different AI company); change it with `rovara open second-review`");
  secondReview
    .command("status", { isDefault: true })
    .description("show who gives the second opinion, how it counts, and any notice")
    .option("--project <name>", "show the mode that applies to one project")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (options: { project?: string; stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      const state = await localCall(context, options.stateDir, "GET", `/v1/dev/second-review${options.project === undefined ? "" : `?project=${encodeURIComponent(options.project)}`}`) as {
        mode: string; modes: { company: string }; current: { line?: string; reason?: string }; notice: { lines: string[] } | null; choice: { models: Array<{ provider: string; modelId: string }> } | null; suggested: Array<{ modelId: string }>;
      };
      if (globals.json) { context.stdout.write(`${JSON.stringify({ ok: true, data: state })}\n`); return; }
      context.stdout.write([
        `Second review mode: ${state.mode} (company: ${state.modes.company}).`,
        state.current.line ?? `Nothing qualifies${state.current.reason === undefined ? "" : ` (${state.current.reason})`}.`,
        ...(state.choice === null ? [] : [`Chosen: ${state.choice.models.map((model) => `${model.provider}:${model.modelId}`).join(", then ")}.`]),
        ...(state.notice === null ? [] : state.notice.lines),
        ...(state.suggested.length === 0 ? [] : [`Suggested: ${state.suggested.map((model) => model.modelId).join(", ")}.`]),
        "Change it on the page: rovara open second-review",
      ].join("\n") + "\n");
    });
  secondReview
    .command("evidence")
    .description("record the evidence that lets a model block: opens the second review page, where you paste a replay run and name the shadow window")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (options: { stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      // The evidence is the owner's act on the page, in a page session opened just now: this command only opens the page; the token never writes it.
      await localCall(context, options.stateDir, "POST", "/v1/local/pages/open", { path: "/second-review" });
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data: { opened: true } })}\n` : "Opened the second review page in your browser. Record the replay run and the evidence under \"Evidence\" there, within ten minutes.\n");
    });
}

const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Model words (a finding, a question) are shown as plain text: no control characters, no line breaks. */
const plainWords = (text: string): string => text.replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").trim();

/**
 * `rovara design-review status <task>`: how a task's design review stands: whether fresh reviewers read the design, the findings, and what waits for you (the cost choice, the planner's questions, a paused review). It only
 * reads. The cost choice, the answers and picking a paused review up again are your acts on the task's page (`rovara design-review open <task>` or `rovara open <task>`), never a command's.
 */
export function registerDesignReviewCommand(program: Command, context: Pick<UpCommandContext, "home" | "stdout" | "fetch">): void {
  const review = program.command("design-review").description("show a task's design review; the cost choice, the answers and picking a paused review up again are made on the task's page (`rovara design-review open <task>`)");
  review
    .command("status <task>")
    .description("show how the review stands, its findings, and what waits for you")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (task: string, options: { stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      if (!TASK_ID_PATTERN.test(task)) throw agentXError("CONFIG_INVALID", "name the task by its id (a UUID)");
      const answer = await localCall(context, options.stateDir, "GET", `/v1/dev/tasks/${task}/design-review`) as {
        designReview: { status: string; facts: string[]; findings: Array<{ severity: string; section: string; text: string; open: boolean }>; hold?: { why: string; note?: string; choices: string[] }; questions?: { items: Array<{ text: string }> }; parked: boolean; blockerReasonNeeded: boolean };
      };
      const state = answer.designReview;
      if (globals.json) { context.stdout.write(`${JSON.stringify({ ok: true, data: state })}\n`); return; }
      const open = state.findings.filter((finding) => finding.open);
      context.stdout.write([
        plainWords(state.status), ...state.facts.map(plainWords),
        ...(state.hold === undefined ? [] : [`Waiting for your choice: ${plainWords(state.hold.why)}. Choices: ${state.hold.choices.map(plainWords).join("; ")}.`, ...(state.hold.note === undefined ? [] : [plainWords(state.hold.note)])]),
        ...(state.questions === undefined ? [] : [`The planner asks you ${state.questions.items.length} ${state.questions.items.length === 1 ? "question" : "questions"}.`]),
        ...(state.parked ? ["The review is paused: pick it up again on the page."] : []),
        ...(state.blockerReasonNeeded ? ["A blocker is open: approving the design needs a one-line reason."] : []),
        `${state.findings.length} ${state.findings.length === 1 ? "finding" : "findings"}, ${open.length} open.${open.length === 0 ? "" : ` Open: ${open.slice(0, 5).map((finding) => `[${finding.severity}] ${plainWords(finding.section)}: ${plainWords(finding.text)}`).join(" | ")}`}`,
        `Decide, answer or resume on the page: rovara design-review open ${task}`,
      ].join("\n") + "\n");
    });
  review
    .command("open <task>")
    .description("open the task's page in your browser, where you make the cost choice, answer the questions or pick a paused review up again")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (task: string, options: { stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      if (!TASK_ID_PATTERN.test(task)) throw agentXError("CONFIG_INVALID", "name the task by its id (a UUID)");
      // The page session is the owner's: this command only asks the running process to open the page; it never decides, and the address is not printed.
      await localCall(context, options.stateDir, "POST", "/v1/local/pages/open", { path: `/plan/${task}` });
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data: { opened: true } })}\n` : "Opened the task's page in your browser. Make the choice, answer or resume there.\n");
    });
}

/**
 * `rovara diagnosis <task>`: what Fix with agent says of the error a task shows (read only). Asking for a diagnosis spends your own model key, so it is your act on the task's page (`rovara open <task>`), never this command's.
 * What the diagnosis says is an AI model's words: shown as plain text, never run.
 */
export function registerDiagnosisCommand(program: Command, context: Pick<UpCommandContext, "home" | "stdout" | "fetch">): void {
  program
    .command("diagnosis <task>")
    .description("show Fix with agent's diagnosis of the error a task shows; ask for one with `rovara open <task>` (it spends your own model key)")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (task: string, options: { stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(task)) throw agentXError("CONFIG_INVALID", "name a task by its id (a UUID)");
      const read = TaskDiagnosisViewReaderSchema.parse(await localCall(context, options.stateDir, "GET", `/v1/dev/tasks/${task}/diagnosis`));
      if (globals.json) { context.stdout.write(`${JSON.stringify({ ok: true, data: read })}\n`); return; }
      const diagnosis = read.diagnosis;
      const lines = read.errorRef === undefined ? ["This task shows no error to look into."]
        : diagnosis === null ? [read.offered ? "No diagnosis has been asked for. Ask for one on the task's page: rovara open <task>" : `Fix with agent is not offered for this error. ${read.why ?? ""}`.trim()]
        : diagnosis.state === "queued" ? ["Fix with agent is looking into this error. Run this again in a moment."]
        : diagnosis.state === "failed" ? [`Fix with agent could not diagnose this error. ${diagnosis.failure ?? ""}`.trim()]
        : ["Fix with agent's diagnosis (an AI model's words; information, not instructions):", ...(diagnosis.proposals ?? []).map((proposal) => `- ${diagnosisProposalLine(proposal as Parameters<typeof diagnosisProposalLine>[0])}`)];
      context.stdout.write(`${lines.map((line) => terminalSafe(line)).join("\n")}\n`);
    });
}

/**
 * `rovara open [task]`: asks the running `rovara up` to open the review page in your browser (a task's plan, or the list of what waits for you). The address carries your page session and can
 * approve, so it is never sent here or printed: the running process opens the browser itself.
 */
export function registerOpenCommand(program: Command, context: Pick<UpCommandContext, "home" | "stdout" | "fetch">): void {
  program
    .command("open [task]")
    .description("open the local review page for a task (or for everything that waits for you, `second-review`, or `lessons`) in your browser; `rovara up` must be running")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (task: string | undefined, options: { stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      if (task !== undefined && task !== "second-review" && task !== "lessons" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(task)) throw agentXError("CONFIG_INVALID", "name a task by its id (a UUID), `second-review`, `lessons`, or leave it out");
      const { url, secret } = await requireLocalRuntime(context.home ?? homedir(), options.stateDir);
      let response: Response;
      try {
        response = await context.fetch(`${url}/v1/local/pages/open`, {
          method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          // The lessons page opens in a new page session: switching on a repository's lessons file asks for one opened in the last few minutes.
          body: JSON.stringify(task === "lessons" ? { path: "/lessons", fresh: true } : { path: task === undefined ? "/" : task === "second-review" ? "/second-review" : `/plan/${task}` }), signal: AbortSignal.timeout(15_000),
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
