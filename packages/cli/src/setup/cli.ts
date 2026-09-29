// agentx project add, channel add, connector add and alerts test (phase 15d2): day-2 forms of
// init's finishing steps, built on the same setup/ modules.
import { agentXError, AgentXNameSchema } from "@agentx/contracts";
import type { Command } from "commander";
import { readSlackBotToken } from "../init/slack-app.js";
import { definedEntries, secretSource } from "../signin/cli.js";
import { alertsTopicArn, sendTestAlarm } from "./alerts.js";
import { addChannel } from "./channel-add.js";
import type { SetupCommandContext } from "./command-context.js";
import { addAsana } from "./connectors/asana.js";
import { addJira } from "./connectors/jira.js";
import { addLinear } from "./connectors/linear.js";
import type { ConnectorAddInput } from "./connectors/revision.js";
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
        await waitForThreadedReply({
          env: run.env, session: run.session, fetch: run.services.fetch, teamId: identity.teamId, channelId: bound.channelId, channelName: bound.channelName, botUserId: identity.botUserId,
          rerun: `agentx --env ${run.env} channel add --project ${projectName} --channel ${bound.channelName}`, write: run.write, sleep: run.sleep, now: run.now,
        });
      }
      run.print({ ...bound, projectName }, `Bound #${bound.channelName} to ${projectName}\n`);
    });

  // agentx connector add linear|jira|asana, the words FR-036 uses.
  const connector = program.command("connector").description("connect a project to Linear, Jira or Asana");
  const connectorAdd = connector.command("add").description("add a connector to a project");
  withRegion(connectorAdd.command("linear"))
    .description("add Linear to a project: guide, key, test read, team, new revision")
    .option("--linear-key-file <path>", "file holding the Linear API key")
    .option("--linear-key-env <NAME>", "environment variable holding the Linear API key")
    .option("--linear-team <id or key>", "the team the project may use")
    .action(async (options: { linearKeyFile?: string; linearKeyEnv?: string; linearTeam?: string }, command: Command) => {
      const projectName = projectOption(command, "the project to connect Linear to");
      const run = await context.open(command);
      const flags = definedEntries<Pick<ConnectorAddInput["flags"], "linearTeam" | "linearKey">>({
        linearTeam: options.linearTeam, linearKey: secretSource(options.linearKeyFile, options.linearKeyEnv),
      });
      const result = await addLinear({ env: run.env, session: run.session, projectName, secrets: run.secrets, prompter: run.prompter, processEnv: process.env, write: run.write, services: run.services, flags });
      run.print(result, `Linear connected to ${projectName} (revision ${result.revision})\n`);
    });

  withRegion(connectorAdd.command("jira"))
    .description("add Jira to a project: guide, service account token, project check, new revision")
    .option("--jira-site <site>", "the <site> in <site>.atlassian.net")
    .option("--jira-project <key>", "the Jira project key")
    .option("--jira-token-file <path>", "file holding the API token")
    .option("--jira-token-env <NAME>", "environment variable holding the API token")
    .action(async (options: { jiraSite?: string; jiraProject?: string; jiraTokenFile?: string; jiraTokenEnv?: string }, command: Command) => {
      const projectName = projectOption(command, "the project to connect Jira to");
      const run = await context.open(command);
      const flags = definedEntries<Pick<ConnectorAddInput["flags"], "jiraSite" | "jiraProject" | "jiraToken">>({
        jiraSite: options.jiraSite, jiraProject: options.jiraProject, jiraToken: secretSource(options.jiraTokenFile, options.jiraTokenEnv),
      });
      const result = await addJira({ env: run.env, session: run.session, projectName, secrets: run.secrets, prompter: run.prompter, processEnv: process.env, write: run.write, services: run.services, flags });
      // addJira already printed the warning, if any; the result (and --json) carry it too. Exit 0 either way.
      run.print(result, `Jira connected to ${projectName} (revision ${result.revision})${result.warning === undefined ? "" : ", with the warning above"}\n`);
    });

  withRegion(connectorAdd.command("asana"))
    .description("add Asana to a project: guide, app client, the bot user's sign-in (no browser opened here), project check, new revision")
    .option("--asana-client-id <id>", "the Asana MCP app's Client ID")
    .option("--asana-client-secret-file <path>", "file holding the app's Client secret")
    .option("--asana-client-secret-env <NAME>", "environment variable holding the app's Client secret")
    .option("--asana-bot-email <email>", "the bot user's email; a sign-in by any other account is refused")
    .option("--asana-project <gid>", "the Asana project's GID")
    .action(async (options: { asanaClientId?: string; asanaClientSecretFile?: string; asanaClientSecretEnv?: string; asanaBotEmail?: string; asanaProject?: string }, command: Command) => {
      const projectName = projectOption(command, "the project to connect Asana to");
      const run = await context.open(command);
      const flags = definedEntries<Pick<ConnectorAddInput["flags"], "asanaClientId" | "asanaClientSecret" | "asanaBotEmail" | "asanaProject">>({
        asanaClientId: options.asanaClientId, asanaClientSecret: secretSource(options.asanaClientSecretFile, options.asanaClientSecretEnv),
        asanaBotEmail: options.asanaBotEmail, asanaProject: options.asanaProject,
      });
      const result = await addAsana({ env: run.env, session: run.session, projectName, secrets: run.secrets, prompter: run.prompter, processEnv: process.env, write: run.write, services: run.services, flags });
      run.print(result, `Asana connected to ${projectName} (revision ${result.revision})\n`);
    });

  // FR-046: needs no admin session, only AWS (SetAlarmState on this one alarm, Task 1), so openAws.
  const alerts = program.command("alerts").description("AgentX alerts");
  withRegion(alerts.command("test"))
    .description("send a test alarm to the alert address and ask whether it arrived (FR-046)")
    .action(async (_options: unknown, command: Command) => {
      const run = await context.openAws(command);
      const topicArn = await alertsTopicArn({
        stackOutputs: run.services.stackOutputs, stackName: run.settings.stacks["control-plane"],
        next: `run agentx init --env ${run.env} to update it, then run agentx alerts test`,
      });
      const shownAs = run.settings.alertAddress ?? "the alert address";
      await sendTestAlarm({ api: run.services.alerts, topicArn, env: run.env, shownAs, prompter: run.prompter, write: run.write, sleep: run.sleep, now: run.now });
      run.print({ sent: true }, "The test alarm arrived.\n");
    });
}
