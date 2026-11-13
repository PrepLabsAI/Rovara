// `rovara setup-agent start | status | stop | journal | use | check | discard | open <project>`: a setup run of a project on the `rovara up` running here, from the terminal.
//
// What a terminal may not do: type a command into the run, allow a website, and approve the commands a run found. Those are the owner's own acts on the setup page (`open`), because this command holds the same login an AI
// tool may hold. `use` only makes the verified commands a candidate and starts the check on a fresh workspace; the approval is on the page.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { agentXError } from "@rovara-code/contracts";
import type { Command } from "commander";
import type { TextWriter } from "../init/prompts.js";
import { terminalSafe } from "../session/app-request.js";
import { requireLocalRuntime } from "./local-runtime.js";

export interface SetupAgentCommandContext {
  home?: string;
  stdout: TextWriter;
  fetch: typeof fetch;
}

async function call(context: SetupAgentCommandContext, stateDir: string | undefined, path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<Record<string, unknown>> {
  const { url, secret } = await requireLocalRuntime(context.home ?? homedir(), stateDir);
  let response: Response;
  try {
    response = await context.fetch(`${url}${path}`, {
      method: init.method ?? "GET", headers: { authorization: `Bearer ${secret}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }), signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "Rovara is not answering at its address. Start it again with `rovara up`.");
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: unknown } };
  if (!response.ok) throw agentXError(response.status === 404 ? "NOT_FOUND" : response.status === 409 ? "WORKSPACE_BUSY" : "RUNTIME_UNAVAILABLE", terminalSafe(typeof body.error?.message === "string" ? body.error.message : `Rovara answered ${String(response.status)}.`));
  return body;
}

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const projectPath = (project: string): string => {
  if (!PROJECT.test(project)) throw agentXError("CONFIG_INVALID", "that is not a project name");
  return `/v1/app/projects/${project}`;
};

export function registerSetupAgentCommands(program: Command, context: SetupAgentCommandContext): void {
  const group = program.command("setup-agent").description("set a project up with Rovara: it runs the project's setup and test commands in a sandbox and shows you what worked (`rovara up` must be running)");
  const common = (command: Command): Command => command.argument("<project>", "the project's name").option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)");
  const show = (command: Command, data: Record<string, unknown>, text: string): void => {
    const globals = command.optsWithGlobals<{ json: boolean }>();
    context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data })}\n` : `${text}\n`);
  };
  const statusText = (view: Record<string, unknown>): string => {
    const proposal = view["proposal"] as Record<string, unknown> | undefined;
    const items = proposal === undefined ? 0 : ["repositories", "setup", "tests", "checks"].reduce((total, name) => total + (Array.isArray(proposal[name]) ? (proposal[name] as unknown[]).length : 0), 0);
    return [`setup run: ${terminalSafe(String(view["status"]))}${typeof view["failure"] === "string" ? ` (${terminalSafe(view["failure"])})` : ""}`, ...(items > 0 ? [`${String(items)} suggestions found${view["verified"] === true ? ", checked against the repository" : ""}. \`rovara setup-agent use <project>\` makes them a candidate; you approve it on the page (\`rovara setup-agent open <project>\`).`] : [])].join("\n");
  };
  common(group.command("start").description("start a setup run (it spends model money, within its limits)")).action(async (project: string, options: { stateDir?: string }, command: Command) => {
    const view = await call(context, options.stateDir, `${projectPath(project)}/setup-agent`, { method: "POST", body: { requestId: randomUUID() } });
    show(command, { setupAgent: view }, `Rovara is setting ${terminalSafe(project)} up.\n${statusText(view)}`);
  });
  common(group.command("status").description("where the project's setup run stands")).action(async (project: string, options: { stateDir?: string }, command: Command) => {
    const view = await call(context, options.stateDir, `${projectPath(project)}/setup-agent`);
    show(command, { setupAgent: view }, statusText(view));
  });
  common(group.command("stop").description("stop the project's setup run (what it learned is kept when the worker reports it)")).action(async (project: string, options: { stateDir?: string }, command: Command) => {
    const view = await call(context, options.stateDir, `${projectPath(project)}/setup-agent/stop`, { method: "POST", body: { requestId: randomUUID() } });
    show(command, { setupAgent: view }, statusText(view));
  });
  common(group.command("journal").description("the commands the run ran, in order")).option("--after <n>", "only entries after this position", "0").action(async (project: string, options: { stateDir?: string; after: string }, command: Command) => {
    const answer = await call(context, options.stateDir, `${projectPath(project)}/setup-agent/journal?after=${encodeURIComponent(options.after)}`);
    const entries = (answer["entries"] as Array<Record<string, unknown>> | undefined) ?? [];
    show(command, answer, entries.length === 0 ? "Nothing was run yet." : entries.map((entry) => `${String(entry["n"])}  ${entry["exitCode"] === 0 ? "ok " : "fail"}  ${terminalSafe(String(entry["command"]))}`).join("\n"));
  });
  common(group.command("use").description("make the run's confirmed commands a candidate and check them on a fresh workspace (you approve them on the page)")).action(async (project: string, options: { stateDir?: string }, command: Command) => {
    const view = await call(context, options.stateDir, `${projectPath(project)}/setup-agent`);
    const answer = await call(context, options.stateDir, `${projectPath(project)}/setup-agent/confirm`, { method: "POST", body: { requestId: randomUUID(), expectedRevision: view["basedOnRevision"] } });
    show(command, answer, "Rovara is checking those commands on a fresh workspace. When the check passes, approve them on the setup page: `rovara setup-agent open " + terminalSafe(project) + "`.");
  });
  common(group.command("check").description("check the project's own setup and test commands on a fresh workspace")).action(async (project: string, options: { stateDir?: string }, command: Command) => {
    const answer = await call(context, options.stateDir, `${projectPath(project)}/setup-check`, { method: "POST", body: { requestId: randomUUID() } });
    show(command, answer, "Rovara is checking the project's setup.");
  });
  common(group.command("discard").description("drop a setup waiting for your approval")).action(async (project: string, options: { stateDir?: string }, command: Command) => {
    const answer = await call(context, options.stateDir, `${projectPath(project)}/setup-agent/discard`, { method: "POST", body: {} });
    show(command, answer, answer["discarded"] === true ? "That setup was discarded." : "There was no setup waiting.");
  });
  common(group.command("open").description("open the project's setup page in your browser: type a command, allow a website, approve what Rovara found")).action(async (project: string, options: { stateDir?: string }, command: Command) => {
    projectPath(project);
    await call(context, options.stateDir, "/v1/local/pages/open", { method: "POST", body: { path: `/setup/${project}` } });
    show(command, { opened: true }, "Opened the setup page in your browser.");
  });
}
