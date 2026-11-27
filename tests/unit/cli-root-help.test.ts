// Issue #1598: `rovara --help` ends with where the docs are, for people and for AI agents.
// A subcommand's help stays as it was.
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { createCliProgram, ROOT_HELP_DOCS_LINES } from "../../packages/cli/src/main.js";

/** Everything `<command> --help` prints, captured instead of written to stdout. */
function printedHelp(command: Command): string {
  let output = "";
  command.configureOutput({ writeOut: (text) => { output += text; }, writeErr: (text) => { output += text; } });
  command.outputHelp();
  return output;
}

const DOCS = "Docs: https://github.com/PrepLabsAI/Rovara/blob/mainline/docs/cli-reference.md";
const AGENT_DOCS = "Docs for AI agents: https://rovara.dev/llms.txt";

describe("root --help", () => {
  it("ends with the CLI reference and the docs for AI agents", () => {
    expect(ROOT_HELP_DOCS_LINES).toEqual([DOCS, AGENT_DOCS]);
    const help = printedHelp(createCliProgram());
    expect(help.trimEnd().split("\n").slice(-2)).toEqual([DOCS, AGENT_DOCS]);
    expect(help).toContain("Rovara Code: sign in, deploy and administer");
  });

  it("leaves a subcommand's help unchanged", () => {
    for (const path of [["login"], ["init"], ["admin", "workspace"]]) {
      let command: Command | undefined = createCliProgram();
      for (const name of path) command = command?.commands.find((candidate) => candidate.name() === name);
      expect(command, path.join(" ")).toBeDefined();
      const help = printedHelp(command!);
      expect(help).toBe(command!.helpInformation());
      expect(help).not.toContain("Docs:");
      expect(help).not.toContain("llms.txt");
    }
  });
});
