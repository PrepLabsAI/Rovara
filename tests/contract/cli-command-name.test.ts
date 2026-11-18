// Naming phase 1: the command is `rovara`; `agentx` stays as an alias for the same file. No help text names the old command.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { createCliProgram } from "../../packages/cli/src/main.js";

const OLD_COMMAND = /(?<![\w@/.-])agentx (?=--|[a-z])/;
interface Manifest { bin?: Record<string, string>; scripts: Record<string, string> }
const read = async (path: string) => JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), "utf8")) as Manifest;

function everyCommand(command: Command): Command[] {
  return [command, ...command.commands.flatMap(everyCommand)];
}

describe("the CLI command name", () => {
  it("the source workspace and the repository script offer rovara and keep agentx, both running the same file", async () => {
    const cli = await read("packages/cli/package.json");
    expect(cli.bin).toEqual({ rovara: "./dist/bin.js", agentx: "./dist/bin.js" });
    const root = await read("package.json");
    expect(root.scripts.rovara).toBe("node packages/cli/dist/bin.js");
    expect(root.scripts.agentx).toBe(root.scripts.rovara);
  });

  it("the program is called rovara and no command's help or usage names the old command", () => {
    const program = createCliProgram();
    expect(program.name()).toBe("rovara");
    const commands = everyCommand(program);
    expect(commands.length).toBeGreaterThan(50);
    for (const command of commands) {
      const text = `${command.helpInformation()}\n${command.description()}\n${command.usage()}`;
      expect(text, command.name()).not.toMatch(OLD_COMMAND);
    }
  });
});
