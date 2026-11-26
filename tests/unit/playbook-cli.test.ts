// `rovara playbook check | init`: the project's How we work file (`.rovara/playbook.yaml`) is checked and started in the folder the command runs in. Neither needs a running install.
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { PLAYBOOK_FILE_PATH } from "@agentx/contracts";
import { registerPlaybookCommands } from "../../packages/cli/src/playbook/cli.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

const FILE = "version: 1\nrules: |\n  PROJECT-RULE: always mention the ticket.\nstages:\n  plan:\n    instructions: |\n      PLAN-RULE: name every file.\n";

async function folder(): Promise<{ project: string; cli: (...argv: string[]) => Promise<string> }> {
  const project = await mkdtemp(join(tmpdir(), "rovara-playbook-"));
  cleanup.push(() => rm(project, { recursive: true, force: true }));
  const cli = async (...argv: string[]): Promise<string> => {
    const out: string[] = [];
    const program = new Command().exitOverride().option("--json", "", false);
    registerPlaybookCommands(program, { cwd: project, stdout: { write: (text: string) => { out.push(text); return true; } } });
    await program.parseAsync(["node", "rovara", ...argv]);
    return out.join("");
  };
  return { project, cli };
}

describe("rovara playbook", () => {
  it("init writes the starter once and never over a file; check reads it without anything running", async () => {
    const { project, cli } = await folder();
    expect(await cli("playbook", "init")).toContain("Wrote .rovara/playbook.yaml");
    expect((await readFile(join(project, PLAYBOOK_FILE_PATH), "utf8"))).toContain("version: 1");
    await expect(cli("playbook", "init")).rejects.toThrow(/already here/u);
    expect(await cli("playbook", "check")).toContain("can be used. It sets nothing yet");
    await writeFile(join(project, PLAYBOOK_FILE_PATH), FILE);
    expect(await cli("playbook", "check")).toContain("It sets rules for the whole process, rules for plan.");
    expect(JSON.parse(await cli("--json", "playbook", "check"))).toEqual({ ok: true, data: { valid: true, rules: true, stages: ["plan"], designReview: null } });
    await writeFile(join(project, PLAYBOOK_FILE_PATH), "version: 1\nstages:\n  pull_request:\n    instructions: x");
    await expect(cli("playbook", "check")).rejects.toThrow(/stages\.pull_request: Rules for this stage aren't used yet\./u);
  });

  it("check and init refuse a link and a folder, never follow them", async () => {
    const { project, cli } = await folder();
    await mkdir(join(project, ".rovara"), { recursive: true });
    await writeFile(join(project, "elsewhere.yaml"), FILE);
    await symlink(join(project, "elsewhere.yaml"), join(project, PLAYBOOK_FILE_PATH));
    await expect(cli("playbook", "check")).rejects.toThrow(/regular file/u);
    await expect(cli("playbook", "init")).rejects.toThrow();
    expect((await lstat(join(project, PLAYBOOK_FILE_PATH))).isSymbolicLink()).toBe(true);
    await expect(cli("playbook", "check", ".rovara")).rejects.toThrow(/regular file/u);
    await expect(cli("playbook", "check", "missing.yaml")).rejects.toThrow(/there is no/u);
  });

  it("has only check and init: show and open went with rovara up", () => {
    const program = new Command();
    registerPlaybookCommands(program, { stdout: { write: () => true } });
    expect(program.commands.find((command) => command.name() === "playbook")!.commands.map((command) => command.name())).toEqual(["check", "init"]);
  });
});
