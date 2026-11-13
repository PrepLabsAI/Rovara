// `rovara playbook show | check | init | open`: How we work on this computer. How we work is a file in the project's repository, `.rovara/playbook.yaml`, reviewed in a pull request like any other change.
//
//  - `show <project>` asks the running `rovara up` what the project runs now: the file as it is on the repository's default branch, and the effective process (every value says where it comes from).
//  - `check [file]` reads a file in this folder (default `.rovara/playbook.yaml`) and says whether Rovara can use it. It needs nothing running: do it before you commit.
//  - `init` writes a starter file (all commented) in this folder, and never replaces one that is there.
//  - `open <project>` opens the local page, where a draft can be tried before it is made.
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HowWeWorkViewReaderSchema, PLAYBOOK_FILE_MAX_BYTES, PLAYBOOK_FILE_PATH, PLAYBOOK_FILE_TEMPLATE, agentXError } from "@rovara-code/contracts";
import { parsePlaybookText, playbookIsEmpty } from "@rovara-code/core/local";
import type { Command } from "commander";
import type { TextWriter } from "../init/prompts.js";
import { terminalSafe } from "../session/app-request.js";
import { requireLocalRuntime } from "./local-runtime.js";

export interface PlaybookCommandContext {
  home?: string;
  cwd?: string;
  stdout: TextWriter;
  fetch: typeof fetch;
}

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

async function call(context: PlaybookCommandContext, stateDir: string | undefined, path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<unknown> {
  const { url, secret } = await requireLocalRuntime(context.home ?? homedir(), stateDir);
  let response: Response;
  try {
    response = await context.fetch(`${url}${path}`, {
      method: init.method ?? "GET", headers: { authorization: `Bearer ${secret}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }), signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "Rovara is not answering at its address. Start it again with `rovara up`.");
  }
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: unknown } };
  if (!response.ok) throw agentXError(response.status === 404 ? "NOT_FOUND" : "RUNTIME_UNAVAILABLE", terminalSafe(typeof body.error?.message === "string" ? body.error.message : `Rovara answered ${response.status}`));
  return body;
}

const projectArgument = (name: string): string => {
  if (!PROJECT.test(name)) throw agentXError("CONFIG_INVALID", "that is not a project name; run `rovara --env local projects` to see yours");
  return name;
}

type Problems = Array<{ path: string; message: string }>;
const problemLines = (problems: Problems): string => problems.map((problem) => `  ${terminalSafe(problem.path)}: ${terminalSafe(problem.message)}`).join("\n");

/** What `show` prints for a view: the file's state, the rules for the whole process and the text each stage is told. */
function showText(answer: { view: { project: string; playbookRevision: number; rules: Array<{ value: string; source: string }>; stages: Array<{ name: string; knows: { instructions: Array<{ value: string; source: string }>; note?: string | undefined } }> }; file: { status: string; commit?: string; repository?: string; reason?: string; problems?: Problems } }): string {
  const lines = [`${terminalSafe(answer.view.project)}  (How we work revision ${String(answer.view.playbookRevision)})`];
  const file = answer.file;
  if (file.status === "none") lines.push(`No ${PLAYBOOK_FILE_PATH} in the repository: Rovara Code runs as it is.`);
  else if (file.status === "ok") lines.push(`${PLAYBOOK_FILE_PATH} in ${terminalSafe(file.repository ?? "")} at ${terminalSafe((file.commit ?? "").slice(0, 12))} (the default branch)`);
  else if (file.status === "invalid") lines.push(`${PLAYBOOK_FILE_PATH} cannot be used, so no step of this project starts until it is fixed on the default branch:`, problemLines(file.problems ?? []));
  else lines.push(`${PLAYBOOK_FILE_PATH} could not be read just now (${terminalSafe(file.reason ?? "")}). Steps wait and try again.`);
  if (answer.view.rules.length > 0) lines.push("", "Rules for the whole process:", ...answer.view.rules.map((row) => `  ${terminalSafe(row.value)}`));
  const wholeProcess = new Set(answer.view.rules.map((row) => row.value));
  for (const stage of answer.view.stages) {
    // The rules for the whole process were listed above; a stage lists what is written for it alone.
    const own = stage.knows.instructions.filter((row) => row.source === "project" && !wholeProcess.has(row.value));
    if (own.length === 0) continue;
    lines.push("", `${terminalSafe(stage.name)}:`, ...own.map((row) => `  ${terminalSafe(row.value)}`));
  }
  return `${lines.join("\n")}\n`;
}

async function readDraft(path: string): Promise<string> {
  const found = await lstat(path).catch(() => undefined);
  if (found === undefined) throw agentXError("NOT_FOUND", `there is no ${path} here. \`rovara playbook init\` writes a starter file.`);
  if (!found.isFile()) throw agentXError("CONFIG_INVALID", "the playbook must be a regular file, not a link or a folder");
  if (found.size > PLAYBOOK_FILE_MAX_BYTES) throw agentXError("CONFIG_INVALID", `the file is larger than ${String(PLAYBOOK_FILE_MAX_BYTES)} bytes`);
  return readFile(path, "utf8");
}

export function registerPlaybookCommands(program: Command, context: PlaybookCommandContext): void {
  const playbook = program.command("playbook").description("how we work: the project's way of working, a file in its repository (.rovara/playbook.yaml); show it, check a file, start one, or open the page");
  playbook
    .command("show")
    .description("what a project runs now: the file on the repository's default branch and the process it makes (`rovara up` must be running)")
    .argument("<project>", "the project's name")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (project: string, options: { stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      const answer = await call(context, options.stateDir, `/v1/local/playbook/${projectArgument(project)}`) as Parameters<typeof showText>[0] & { view: unknown };
      if (!HowWeWorkViewReaderSchema.safeParse(answer.view).success) throw agentXError("RUNTIME_UNAVAILABLE", "Rovara answered with something unexpected; is this `rovara` as new as the one running?");
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data: answer })}\n` : showText(answer));
    });
  playbook
    .command("check")
    .description("say whether Rovara can use a playbook file, and what it sets (reads the file in this folder; nothing needs to be running)")
    .argument("[file]", `the file (default: ${PLAYBOOK_FILE_PATH})`)
    .action(async (file: string | undefined, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      const path = resolve(context.cwd ?? process.cwd(), file ?? PLAYBOOK_FILE_PATH);
      const parsed = parsePlaybookText(await readDraft(path));
      if (!parsed.ok) {
        if (globals.json) context.stdout.write(`${JSON.stringify({ ok: false, error: { code: "CONFIG_INVALID", message: "the playbook file cannot be used", problems: parsed.problems } })}\n`);
        throw agentXError("CONFIG_INVALID", globals.json ? "the playbook file cannot be used" : `the playbook file cannot be used:\n${problemLines(parsed.problems)}`);
      }
      const stages = Object.keys(parsed.file.stages ?? {});
      const summary = playbookIsEmpty(parsed.file) ? "It sets nothing yet: Rovara Code runs as it is."
        : `It sets ${[parsed.file.rules === undefined ? undefined : "rules for the whole process", stages.length === 0 ? undefined : `rules for ${stages.join(", ")}`, parsed.file.designReview === undefined ? undefined : `design review (${parsed.file.designReview.mode})`].filter((part) => part !== undefined).join(", ")}.`;
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data: { valid: true, rules: parsed.file.rules !== undefined, stages, designReview: parsed.file.designReview?.mode ?? null } })}\n` : `${PLAYBOOK_FILE_PATH} can be used. ${summary}\n`);
    });
  playbook
    .command("init")
    .description(`write a starter ${PLAYBOOK_FILE_PATH} in this folder (everything commented; never replaces a file)`)
    .action(async (_options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      const path = join(context.cwd ?? process.cwd(), PLAYBOOK_FILE_PATH);
      await mkdir(dirname(path), { recursive: true });
      try {
        // `wx`: the file is made only if there is none, and never through a link someone left there.
        const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
        try { await handle.writeFile(PLAYBOOK_FILE_TEMPLATE, "utf8"); } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw agentXError("CONFIG_INVALID", `${PLAYBOOK_FILE_PATH} is already here; edit it, then run \`rovara playbook check\``);
        throw error;
      }
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data: { written: PLAYBOOK_FILE_PATH } })}\n` : `Wrote ${PLAYBOOK_FILE_PATH}. Edit it, run \`rovara playbook check\`, and open a pull request: Rovara reads it from the default branch.\n`);
    });
  playbook
    .command("open")
    .description("open the How we work page in your browser, where a draft can be tried before it is made (`rovara up` must be running)")
    .argument("[project]", "the project's name (default: the list of projects)")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (project: string | undefined, options: { stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      // The page address allows letters, digits, `-`, `_` and `/`: a project name with a dot opens the list, where it is linked.
      const named = project === undefined ? undefined : projectArgument(project);
      const path = named !== undefined && /^[A-Za-z0-9_-]+$/u.test(named) ? `/how-we-work/${named}` : "/how-we-work";
      await call(context, options.stateDir, "/v1/local/pages/open", { method: "POST", body: { path } });
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data: { opened: true } })}\n` : "Opened How we work in your browser.\n");
    });
}
