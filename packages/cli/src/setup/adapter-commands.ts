// Spec 062 FR-051: `agentx adapter add|list|remove|bind|unbind|unlink`, an administrator's tools for channel adapters.
// `agentx channel add` stays the Slack channel binding it has always been.
import { writeFile } from "node:fs/promises";
import { AgentXNameSchema, StepUpKindSchema, agentXError, type ChannelAdapterRecord, type StepUpKind } from "@agentx/contracts";
import type { Command } from "commander";
import { bindAdapterSpace, listAdapters, registerAdapter, removeAdapter, unbindAdapterSpace, unlinkAdapterUser } from "../admin/channel-adapters.js";
import type { SetupCommandContext } from "./command-context.js";

export interface AdapterAddOptions {
  callbackUrl: string;
  projects: string;
  buttons: string;
  maxText: string;
  threads?: boolean;
  edits?: boolean;
  proactive?: boolean;
  stepUp: string;
  rotate?: boolean;
  secretFile?: string;
}

/** `--projects web,billing`: the projects an adapter may serve. */
export function projectsOption(value: string): string[] {
  const names = [...new Set(value.split(",").map((name) => name.trim()).filter((name) => name.length > 0))];
  if (names.length === 0) throw agentXError("CONFIG_INVALID", "--projects needs at least one project name");
  for (const name of names) if (!AgentXNameSchema.safeParse(name).success) throw agentXError("CONFIG_INVALID", `--projects ${name} is not a project name; use lower-case letters, digits and hyphens`);
  return names;
}

/** The root program's global --project, which `adapter bind` takes for the space's project. */
function globalProject(command: Command): string {
  const project = command.optsWithGlobals<{ project?: string }>().project;
  if (project === undefined || project === "") throw agentXError("CONFIG_INVALID", "--project is required: the project the space works on");
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("CONFIG_INVALID", `--project ${project} is not a project name; use lower-case letters, digits and hyphens`);
  return project;
}

function whole(value: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw agentXError("CONFIG_INVALID", `${flag} must be a whole number from ${min} to ${max}`);
  return Number(value);
}

/** FR-032: `--step-up plan_approval,admin` (the default), one of them, or `none`. */
export function stepUpOption(value: string): StepUpKind[] {
  if (value.trim() === "none") return [];
  const kinds = value.split(",").map((kind) => kind.trim()).filter((kind) => kind.length > 0);
  const parsed = kinds.map((kind) => StepUpKindSchema.safeParse(kind));
  if (kinds.length === 0 || parsed.some((result) => !result.success)) throw agentXError("CONFIG_INVALID", "--step-up must be plan_approval, admin, both separated by a comma, or none");
  return [...new Set(kinds as StepUpKind[])];
}

export function adapterRegistration(options: AdapterAddOptions) {
  return {
    callbackUrl: options.callbackUrl,
    capabilities: {
      threads: options.threads === true,
      buttons: whole(options.buttons, "--buttons", 0, 10),
      edits: options.edits === true,
      maxTextLength: whole(options.maxText, "--max-text", 200, 100_000),
      proactive: options.proactive === true,
    },
    projects: projectsOption(options.projects),
    stepUp: stepUpOption(options.stepUp),
  };
}

const describe = (adapter: ChannelAdapterRecord) =>
  `${adapter.channel}  ${adapter.callbackUrl}  projects: ${adapter.projects.join(", ")}  step-up: ${adapter.stepUp.length === 0 ? "none" : adapter.stepUp.join(", ")}`;

export function registerAdapterCommands(program: Command, context: SetupCommandContext): void {
  const adapter = program.command("adapter").description("channel adapters (WhatsApp and others) that reach AgentX through the channel API");
  const withRegion = (command: Command) => command.option("--region <region>", "AWS region of the environment; defaults to your AWS configuration");

  withRegion(adapter.command("add <channel>")
    .description("register a channel adapter, or change one; prints its signing secret once, when it is made"))
    .requiredOption("--callback-url <url>", "the public https URL Rovara sends the adapter's events to")
    .requiredOption("--projects <names>", "the projects the adapter may serve, separated by commas")
    .option("--buttons <n>", "the most reply buttons one message can show (0 for none)", "0")
    .option("--max-text <n>", "the longest message the adapter can show", "4096")
    .option("--threads", "the adapter shows threads")
    .option("--edits", "the adapter can edit a message it posted")
    .option("--proactive", "the adapter can message a conversation first")
    .option("--step-up <kinds>", "decisions only a signed-in person can make on the task page: plan_approval, admin, both, or none", "plan_approval,admin")
    .option("--rotate", "replace the signing secret")
    .option("--secret-file <path>", "write a new signing secret to this file (mode 600) instead of printing it")
    .action(async (channel: string, options: AdapterAddOptions, command: Command) => {
      const registration = adapterRegistration(options);
      const run = await context.open(command);
      const result = await registerAdapter(run.session, { channel, registration, ...(options.rotate === true ? { rotate: true } : {}) }, run.services.fetch);
      let secretLine = "The signing secret is unchanged.\n";
      if (result.signingSecret !== undefined) {
        if (options.secretFile !== undefined) {
          await writeFile(options.secretFile, `${result.signingSecret}\n`, { mode: 0o600 });
          secretLine = `Wrote the signing secret to ${options.secretFile}. Give it to the adapter; Rovara does not show it again.\n`;
        } else {
          secretLine = `Signing secret (shown once; give it to the adapter, Rovara does not show it again):\n${result.signingSecret}\n`;
        }
      }
      const printed = options.secretFile === undefined ? result : { adapter: result.adapter, signingSecretFile: options.secretFile };
      run.print(printed, `Registered ${describe(result.adapter)}\n${secretLine}`);
    });

  withRegion(adapter.command("list").description("list the registered channel adapters"))
    .action(async (_options: unknown, command: Command) => {
      const run = await context.open(command);
      const adapters = await listAdapters(run.session, run.services.fetch);
      run.print({ adapters }, adapters.length === 0 ? "No channel adapters are registered.\n" : `${adapters.map(describe).join("\n")}\n`);
    });

  withRegion(adapter.command("remove <channel>").description("remove a channel adapter; its signing secret stops working at once"))
    .action(async (channel: string, _options: unknown, command: Command) => {
      const run = await context.open(command);
      await removeAdapter(run.session, channel, run.services.fetch);
      run.print({ removed: channel }, `Removed the ${channel} adapter.\n`);
    });

  withRegion(adapter.command("bind <channel>").description("bind one of the adapter's spaces (a group or chat) to the --project, which the adapter must serve"))
    .requiredOption("--tenant <id>", "the adapter's tenant, such as its business phone number")
    .requiredOption("--space <id>", "the space, such as a group's ID")
    .action(async (channel: string, options: { tenant: string; space: string }, command: Command) => {
      const projectName = globalProject(command);
      const run = await context.open(command);
      const result = await bindAdapterSpace(run.session, { channel, tenant: options.tenant, space: options.space, projectName }, run.services.fetch);
      run.print(result, `Bound ${channel} space ${options.space} to ${projectName}.\n`);
    });

  withRegion(adapter.command("unbind <channel>").description("unbind an adapter space; its messages then run nothing"))
    .requiredOption("--tenant <id>", "the adapter's tenant")
    .requiredOption("--space <id>", "the space")
    .action(async (channel: string, options: { tenant: string; space: string }, command: Command) => {
      const run = await context.open(command);
      await unbindAdapterSpace(run.session, { channel, tenant: options.tenant, space: options.space }, run.services.fetch);
      run.print({ unbound: { channel, ...options } }, `Unbound ${channel} space ${options.space}.\n`);
    });

  withRegion(adapter.command("unlink <channel>").description("remove a channel user's link to their Rovara sign-in; they must link again before acting"))
    .requiredOption("--tenant <id>", "the adapter's tenant")
    .requiredOption("--user <id>", "the channel user's ID")
    .action(async (channel: string, options: { tenant: string; user: string }, command: Command) => {
      const run = await context.open(command);
      await unlinkAdapterUser(run.session, { channel, tenant: options.tenant, userId: options.user }, run.services.fetch);
      run.print({ unlinked: { channel, tenant: options.tenant, userId: options.user } }, `Unlinked ${channel} user ${options.user}.\n`);
    });
}
