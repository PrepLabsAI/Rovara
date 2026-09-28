import { describe, expect, it } from "vitest";
import { createCliProgram } from "../../packages/cli/src/main.js";

describe("AgentX executable command surface", () => {
  it("exposes administration and developer sign-in; developer tasks come from AI tools", () => {
    const program = createCliProgram();

    expect(program.commands.map((command) => command.name())).toEqual(["login", "logout", "whoami", "signin", "admin", "env", "deploy", "init"]);

    const admin = program.commands.find((command) => command.name() === "admin");
    expect(admin?.commands.map((command) => command.name())).toEqual(["project", "workspace", "slack", "credential", "turns"]);
    expect(subcommands(admin, "project")).toEqual(["register"]);
    expect(subcommands(admin, "workspace")).toEqual(["cancel", "stop"]);
    expect(subcommands(admin, "slack")).toEqual(["bind", "unbind"]);
    expect(subcommands(admin, "credential")).toEqual(["register", "authorize", "list"]);
    expect(subcommands(admin, "turns")).toEqual(["export"]);

    expect(subcommands(program, "signin")).toEqual(["show", "enable", "disable", "check"]);

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

    // --orchestrator-model reappears, but only on `init` (an install-time Bedrock model choice, not
    // the retired ad-hoc runtime-routing flag this guard was originally written against): every
    // other command, including the root program itself, must never carry it.
    for (const command of allCommands(program)) {
      if (command.name() === "init") continue;
      expect(command.options.map((option) => option.long)).not.toContain("--orchestrator-model");
    }
    const init = program.commands.find((command) => command.name() === "init");
    expect(init?.options.map((option) => option.long)).toContain("--orchestrator-model");
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
