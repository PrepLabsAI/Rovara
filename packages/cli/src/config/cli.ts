// The `agentx config` command group (FR-048, FR-049), kept out of main.ts. Builds real AWS clients
// only when a test has not overridden them.
import { agentXError } from "@agentx/contracts";
import { BudgetsClient } from "@aws-sdk/client-budgets";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SNSClient } from "@aws-sdk/client-sns";
import { STSClient } from "@aws-sdk/client-sts";
import type { Command } from "commander";
import { askToApply } from "../admin/changes.js";
import { realCommandRunner } from "../deploy/commands.js";
import { cloudFormationStackReader, stsCallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { secretsManagerInitSecrets } from "../init/context.js";
import { awsPrerequisiteChecks } from "../init/prerequisites.js";
import { processPrompter, unattendedPrompter, type Prompter, type TextWriter } from "../init/prompts.js";
import { formatSuccess } from "../output.js";
import { awsAlertsApi } from "../setup/alerts.js";
import { secretSource } from "../signin/cli.js";
import { runConfigGet, runConfigList, runConfigSet, type ConfigRow, type ConfigServices } from "./commands.js";
import { CONFIG_KEYS } from "./keys.js";

export interface ConfigCommandContext {
  overrides?: Partial<ConfigServices>;
  parameterStore: (region?: string) => ParameterStore;
  fetch: typeof fetch;
  /** Spec 025 FR-053: this computer's unexpired admin sign-in for an environment (the workspace limits change through the admin change path). */
  adminSession?: ConfigServices["adminSession"];
  stdout: TextWriter;
  stderr: TextWriter;
}

/** The keys that change through the admin change path (spec 025 FR-053), not a stack update. */
const CONFIG_KEYS_BY_CHANGE_PATH = new Set(CONFIG_KEYS.filter((entry) => entry.target.kind === "control-plane-setting").map((entry) => entry.key));

const rowText = (rows: ConfigRow[]) => rows.map((row) => `${row.key.padEnd(28)} ${row.value}\n${" ".repeat(29)}${row.where}`).join("\n");

export function registerConfigCommands(program: Command, context: ConfigCommandContext): void {
  const config = program.command("config").description("list, read and change an environment's settings: models, limits, Slack, alerts and the budget (operator role)");
  const services = (region: string | undefined, yes: boolean, prompter?: Prompter): ConfigServices => {
    const overrides = context.overrides ?? {};
    const aws = region === undefined ? {} : { region };
    const store = overrides.store ?? context.parameterStore(region);
    const adminSession = overrides.adminSession ?? context.adminSession;
    return {
      store,
      secrets: overrides.secrets ?? secretsManagerInitSecrets(new SecretsManagerClient(aws)),
      cloudFormation: overrides.cloudFormation ?? new CloudFormationClient(aws),
      stacks: overrides.stacks ?? cloudFormationStackReader(new CloudFormationClient(aws)),
      identity: overrides.identity ?? stsCallerIdentity(new STSClient(aws)),
      // Built for the environment's region once its settings are read. Only converse and openRouter
      // are used; the account is not needed for them.
      checks: overrides.checks ?? ((environmentRegion) => awsPrerequisiteChecks({ region: environmentRegion, account: "000000000000", store, runner: realCommandRunner(context.stderr), fetch: context.fetch })),
      alerts: overrides.alerts ?? awsAlertsApi({ sns: new SNSClient(aws), cloudWatch: new CloudWatchClient(aws), budgets: new BudgetsClient({ region: "us-east-1" }) }),
      prompter: overrides.prompter ?? prompter ?? (yes || process.stdin.isTTY !== true ? unattendedPrompter() : processPrompter(context.stderr)),
      processEnv: overrides.processEnv ?? process.env,
      write: overrides.write ?? ((line) => { context.stderr.write(`${line}\n`); }),
      now: overrides.now ?? Date.now,
      sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); })),
      ...(overrides.pollMs === undefined ? {} : { pollMs: overrides.pollMs }),
      ...(adminSession === undefined ? {} : { adminSession }),
      fetch: overrides.fetch ?? context.fetch,
    };
  };
  /**
   * Spec 025 E17 (SC-005): a workspace limits change applies only on a yes. Without --yes it needs a
   * terminal (checked before anything is planned), and the prompt treats Ctrl-C or the end of input
   * as no answer, so the change is declined as cancelled. Every other key keeps its prompter.
   */
  const limitsPrompter = (key: string, yes: boolean): Prompter | undefined => {
    if (yes || context.overrides?.prompter !== undefined) return undefined;
    if (!CONFIG_KEYS_BY_CHANGE_PATH.has(key)) return undefined;
    if (process.stdin.isTTY !== true) throw agentXError("CONFIG_INVALID", `${key} needs a yes: run the command in a terminal to answer its prompt, or pass --yes`);
    return { ...processPrompter(context.stderr), confirm: (question) => askToApply(question, { input: process.stdin, output: process.stderr, signals: process }) };
  };
  const globals = (command: Command) => command.optsWithGlobals<{ env: string; json: boolean }>();
  const regionOption = ["--region <region>", "AWS region of the environment; defaults to your AWS configuration"] as const;

  config.command("list").description("every key, its value, and where it lives").option(...regionOption)
    .action(async (options: { region?: string }, command: Command) => {
      const rows = await runConfigList(services(options.region, false), globals(command).env);
      context.stdout.write(globals(command).json ? formatSuccess(rows, true) : `${rowText(rows)}\n`);
    });
  config.command("get").description("one key's value").argument("<key>").option(...regionOption)
    .action(async (key: string, options: { region?: string }, command: Command) => {
      const row = await runConfigGet(services(options.region, false), globals(command).env, key);
      context.stdout.write(globals(command).json ? formatSuccess(row, true) : `${row.value}\n`);
    });
  config.command("set").description("change one key: shows the change and asks first; model keys are tested first")
    .argument("<key>").argument("[value]")
    .option("--value-file <path>", "file holding the value (for a webhook alert address, which is a secret)")
    .option("--value-env <NAME>", "environment variable holding the value (for a webhook alert address)")
    .option("--yes", "apply without asking; the change is still printed", false)
    .option(...regionOption)
    .action(async (key: string, value: string | undefined, options: { valueFile?: string; valueEnv?: string; yes: boolean; region?: string }, command: Command) => {
      if (value !== undefined && (options.valueFile !== undefined || options.valueEnv !== undefined)) {
        throw agentXError("CONFIG_INVALID", "give the value once: on the command line, or with --value-file or --value-env");
      }
      const source = secretSource(options.valueFile, options.valueEnv);
      const result = await runConfigSet(services(options.region, options.yes, limitsPrompter(key, options.yes)), globals(command).env, {
        key, yes: options.yes, ...(value === undefined ? {} : { value }), ...(source === undefined ? {} : { valueSource: source }),
      });
      context.stdout.write(globals(command).json ? formatSuccess(result, true) : result.changed ? `${key} changed.\n` : "Nothing to change.\n");
    });
}
