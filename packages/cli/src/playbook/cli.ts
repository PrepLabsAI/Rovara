// `rovara playbook check | init`: How we work, a file in the project's repository (`.rovara/playbook.yaml`), reviewed in a pull request like any other change. Rovara reads it from the default branch.
//
//  - `check [file]` reads a file in this folder (default `.rovara/playbook.yaml`) and says whether Rovara can use it. It needs nothing running: do it before you commit.
//  - `init` writes a starter file (all commented) in this folder, and never replaces one that is there.
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PLAYBOOK_FILE_MAX_BYTES, PLAYBOOK_FILE_PATH, PLAYBOOK_FILE_TEMPLATE, agentXError } from "@agentx/contracts";
import { parsePlaybookText, playbookIsEmpty } from "@agentx/broker/core";
import type { Command } from "commander";
import type { TextWriter } from "../init/prompts.js";
import { terminalSafe } from "../session/app-request.js";

export interface PlaybookCommandContext {
  cwd?: string;
  stdout: TextWriter;
}

type Problems = Array<{ path: string; message: string }>;
const problemLines = (problems: Problems): string => problems.map((problem) => `  ${terminalSafe(problem.path)}: ${terminalSafe(problem.message)}`).join("\n");

async function readDraft(path: string): Promise<string> {
  const found = await lstat(path).catch(() => undefined);
  if (found === undefined) throw agentXError("NOT_FOUND", `there is no ${path} here. \`rovara playbook init\` writes a starter file.`);
  if (!found.isFile()) throw agentXError("CONFIG_INVALID", "the playbook must be a regular file, not a link or a folder");
  if (found.size > PLAYBOOK_FILE_MAX_BYTES) throw agentXError("CONFIG_INVALID", `the file is larger than ${String(PLAYBOOK_FILE_MAX_BYTES)} bytes`);
  return readFile(path, "utf8");
}

export function registerPlaybookCommands(program: Command, context: PlaybookCommandContext): void {
  const playbook = program.command("playbook").description("how we work: the project's way of working, a file in its repository (.rovara/playbook.yaml); check a file or start one");
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
}
