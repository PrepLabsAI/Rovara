// agentx project add, channel add, connector add and alerts test (phase 15d2): day-2 forms of
// init's finishing steps, built on the same setup/ modules.
import type { Command } from "commander";
import { definedEntries } from "../signin/cli.js";
import type { SetupCommandContext } from "./command-context.js";
import { addProject } from "./project-add.js";
import { installationToken } from "./project-files.js";

interface ProjectAddFlags { repository?: string; projectName?: string; setupCommand?: string; testCommand?: string }

/** Every setup command reads the environment's settings from SSM in this region (F8). */
function withRegion(command: Command): Command {
  return command.option("--region <region>", "AWS region of the environment; defaults to your AWS configuration");
}

export function registerSetupCommands(program: Command, context: SetupCommandContext): void {
  const project = program.command("project").description("AgentX projects");
  withRegion(project
    .command("add")
    .description("register a new project from a repository the GitHub App sees, on EC2 workers"))
    .option("--repository <owner/name>", "the repository")
    .option("--project-name <name>", "the project's name (default: the repository's)")
    .option("--setup-command <command>", "the setup command, or \"\" for none")
    .option("--test-command <command>", "the test command, or \"\" for none")
    .action(async (options: ProjectAddFlags & { region?: string }, command: Command) => {
      const run = await context.open(command);
      const githubToken = await installationToken({ env: run.env, secrets: run.secrets, github: run.services.github, nowSeconds: Math.floor(Date.now() / 1000) });
      const flags = definedEntries<ProjectAddFlags>({ repository: options.repository, projectName: options.projectName, setupCommand: options.setupCommand, testCommand: options.testCommand });
      const result = await addProject({ env: run.env, session: run.session, githubToken, prompter: run.prompter, write: run.write, services: run.services, flags });
      run.print(result, `Registered project ${result.name} (revision ${result.revision}); file ${result.file}\n`);
    });
}
