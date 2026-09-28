// agentx project add, channel add, connector add and alerts test (phase 15d2): day-2 forms of
// init's finishing steps, built on the same setup/ modules.
import { agentXError, AgentXNameSchema } from "@agentx/contracts";
import type { Command } from "commander";
import { readSlackBotToken } from "../init/slack-app.js";
import { definedEntries } from "../signin/cli.js";
import { addChannel } from "./channel-add.js";
import type { SetupCommandContext } from "./command-context.js";
import { addProject } from "./project-add.js";
import { installationToken } from "./project-files.js";
import { waitForThreadedReply } from "./reply-watch.js";

interface ProjectAddFlags { repository?: string; projectName?: string; setupCommand?: string; testCommand?: string }

/** Every setup command reads the environment's settings from SSM in this region (F8). */
function withRegion(command: Command): Command {
  return command.option("--region <region>", "AWS region of the environment; defaults to your AWS configuration");
}

/** F9: the root program's global --project, which it takes before or after the subcommand. */
function projectOption(command: Command, what: string): string {
  const project = command.optsWithGlobals<{ project?: string }>().project;
  if (project === undefined || project === "") throw agentXError("CONFIG_INVALID", `--project is required; pass --project <name>, ${what}`);
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("CONFIG_INVALID", `--project ${project} is not a project name; use lower-case letters, digits and hyphens`);
  return project;
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

  const channel = program.command("channel").description("Slack channels bound to AgentX projects");
  withRegion(channel
    .command("add")
    .description("bind a Slack channel to the --project, invite the bot, and check a mention gets a threaded reply"))
    .option("--channel <name>", "the channel's name")
    .option("--no-check", "bind only; skip waiting for a reply")
    .action(async (options: { channel?: string; check: boolean }, command: Command) => {
      const projectName = projectOption(command, "the project to bind the channel to");
      const run = await context.open(command);
      const botToken = await readSlackBotToken(run.secrets, run.env);
      const identity = await run.services.slackIdentity(botToken);
      const bound = await addChannel({
        session: run.session, botToken, teamId: identity.teamId, botUserId: identity.botUserId, projectName,
        prompter: run.prompter, write: run.write, sleep: run.sleep, now: run.now, services: run.services, flags: definedEntries<{ channel?: string }>({ channel: options.channel }),
      });
      if (options.check) {
        await waitForThreadedReply({ session: run.session, fetch: run.services.fetch, teamId: identity.teamId, channelId: bound.channelId, channelName: bound.channelName, botUserId: identity.botUserId, write: run.write, sleep: run.sleep, now: run.now });
      }
      run.print({ ...bound, projectName }, `Bound #${bound.channelName} to ${projectName}\n`);
    });
}
