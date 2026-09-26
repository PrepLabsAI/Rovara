import { describe, expect, it } from "vitest";
import { createCliProgram } from "../../packages/cli/src/main.js";

describe("AgentX executable command surface", () => {
  it("exposes administration only; developers work through Slack", () => {
    const program = createCliProgram();

    expect(program.commands.map((command) => command.name())).toEqual(["login", "admin", "env"]);

    const admin = program.commands.find((command) => command.name() === "admin");
    expect(admin?.commands.map((command) => command.name())).toEqual(["project", "workspace", "slack", "credential", "turns"]);
    expect(subcommands(admin, "project")).toEqual(["register"]);
    expect(subcommands(admin, "workspace")).toEqual(["stop"]);
    expect(subcommands(admin, "slack")).toEqual(["bind", "unbind"]);
    expect(subcommands(admin, "credential")).toEqual(["register", "authorize", "list"]);
    expect(subcommands(admin, "turns")).toEqual(["export"]);

    const env = program.commands.find((command) => command.name() === "env");
    expect(env?.commands.map((command) => command.name())).toEqual(["list", "use", "adopt"]);
  });

  it("keeps no developer workflow or runtime routing option", () => {
    const program = createCliProgram();
    const rootCommands = program.commands.map((command) => command.name());

    // `slack` survives only as an administrator subcommand, never as a developer command.
    for (const retired of ["status", "conversation", "pr", "cancel", "slack"]) {
      expect(rootCommands).not.toContain(retired);
    }
    expect(allCommands(program).map((command) => command.name())).not.toContain("prepare");

    const optionNames = allCommands(program).flatMap((command) =>
      command.options.map((option) => option.long),
    );
    expect(optionNames).not.toContain("--runtime-session-id");
    expect(optionNames).not.toContain("--prompt");
    expect(optionNames).not.toContain("--orchestrator-model");
  });
});

function subcommands(
  admin: ReturnType<typeof createCliProgram> | undefined,
  group: string,
): string[] {
  const command = admin?.commands.find((candidate) => candidate.name() === group);
  return command?.commands.map((candidate) => candidate.name()) ?? [];
}

function allCommands(root: ReturnType<typeof createCliProgram>): typeof root[] {
  return [root, ...root.commands.flatMap((command) => allCommands(command))];
}
