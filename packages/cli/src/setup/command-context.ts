// What every setup day-2 command needs: the environment's settings from SSM (FR-004), an admin
// session (the same check init uses), the secrets store, prompts, and the injected services.
// main.ts builds the real one; tests pass their own through CliDependencies.setup.
import { agentXError } from "@agentx/contracts";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Command } from "commander";
import { openSystemBrowser } from "../auth.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { realSetupServices } from "../init/commands.js";
import { secretsManagerInitSecrets, type InitSecrets } from "../init/context.js";
import { processPrompter, unattendedPrompter, type Prompter, type TextWriter } from "../init/prompts.js";
import { formatSuccess } from "../output.js";
import type { TokenStore } from "../token-store.js";
import { openAdminSession } from "./admin-session.js";
import type { AdminSession, SetupServices } from "./services.js";

export interface SetupRun {
  env: string; settings: EnvironmentSettings; session: AdminSession; secrets: InitSecrets;
  services: SetupServices; prompter: Prompter; write: (line: string) => void;
  /** Waiting for a person (a channel invite, a mention), injected so tests do not wait. */
  sleep: (ms: number) => Promise<void>; now: () => number;
  /** The command's result: JSON with the global --json, otherwise `text`. */
  print: (result: unknown, text: string) => void;
}

export interface SetupCommandContext {
  /** Settings, AWS clients and an admin session for the command's --env and --region. */
  open(command: Command): Promise<SetupRun>;
  /** The same without the admin session, for a command that only talks to AWS (F19). */
  openAws(command: Command): Promise<Omit<SetupRun, "session">>;
}

/** No terminal to ask on: a question with a default takes it, but a choice among several (which
 * repository, say) is never guessed; it needs its flag. */
function noTerminalPrompter(): Prompter {
  const unattended = unattendedPrompter();
  return {
    ask: (question, options) => unattended.ask(question, options),
    confirm: (question, options) => unattended.confirm(question, options),
    secret: (question, options) => unattended.secret(question, options),
    async choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: { flag: string; defaultValue: T; unattendedRefusal?: string }): Promise<T> {
      if (choices.length === 1) return options.defaultValue;
      throw agentXError("CONFIG_INVALID", options.unattendedRefusal ?? `${question} needs an answer; with no terminal, pass ${options.flag}`);
    },
  };
}

/** The real context: settings from SSM in --region (default: the AWS configuration's), clients in
 * the settings' region, and the admin session init uses. Your own OIDC's admin claim is not in the
 * settings, so a day-2 command relies on the admin route's own check. */
export function realSetupContext(input: {
  parameterStore: (region?: string) => ParameterStore; fetch: typeof fetch; tokenStore: TokenStore;
  stdout: TextWriter; stderr: TextWriter;
}): SetupCommandContext {
  const openAws = async (command: Command): Promise<Omit<SetupRun, "session">> => {
    const globals = command.optsWithGlobals<{ env: string; json: boolean; configDir: string; region?: string }>();
    const settings = await readEnvironmentSettings(input.parameterStore(globals.region), globals.env);
    if (settings === undefined) {
      throw agentXError("CONFIG_INVALID", `environment ${globals.env} has no settings in ${globals.region ?? "your AWS configuration's region"}; pass --region, or run agentx env list`);
    }
    return {
      env: globals.env, settings,
      secrets: secretsManagerInitSecrets(new SecretsManagerClient({ region: settings.region })),
      services: realSetupServices({ region: settings.region, fetch: input.fetch, configDir: globals.configDir, tokenStore: input.tokenStore }),
      prompter: process.stdin.isTTY === true ? processPrompter(input.stderr) : noTerminalPrompter(),
      write: (line) => { input.stderr.write(`${line}\n`); },
      sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
      now: Date.now,
      print: (result, text) => { input.stdout.write(globals.json ? formatSuccess(result, true) : text); },
    };
  };
  return {
    openAws,
    async open(command) {
      const run = await openAws(command);
      const session = await openAdminSession({
        settings: run.settings, services: run.services, write: run.write, now: run.now,
        // A browser that will not open (CloudShell, SSH) never stops the command: the address is
        // already printed.
        openBrowser: async (url) => {
          try { await openSystemBrowser(url); } catch { run.write("could not open a browser; open the address above"); }
        },
      });
      return { ...run, session };
    },
  };
}
