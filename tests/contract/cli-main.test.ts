import { describe, expect, it } from "vitest";
import { createCliProgram } from "../../packages/cli/src/main.js";

describe("AgentX executable command surface", () => {
  it("exposes developer and administrator workflows without runtime routing options", () => {
    const program = createCliProgram();
    const rootCommands = program.commands.map((command) => command.name());
    expect(rootCommands).toEqual(expect.arrayContaining(["login", "status", "conversation", "pr", "cancel", "admin"]));

    const pullRequest = program.commands.find((command) => command.name() === "pr");
    expect(pullRequest?.commands.map((command) => command.name())).toContain("create");

    const admin = program.commands.find((command) => command.name() === "admin");
    const adminCommands = admin?.commands.map((command) => command.name()) ?? [];
    expect(adminCommands).toEqual(expect.arrayContaining(["project", "workspace"]));

    const optionNames = allCommands(program).flatMap((command) =>
      command.options.map((option) => option.long),
    );
    expect(optionNames).not.toContain("--runtime-session-id");
  });
});

function allCommands(root: ReturnType<typeof createCliProgram>): typeof root[] {
  return [root, ...root.commands.flatMap((command) => allCommands(command))];
}
