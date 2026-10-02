// What every init step receives. Every AWS, vendor, browser, clock and prompt dependency is here,
// so tests replace all of them and nothing reaches AWS, GitHub or Slack.
import { DescribeStacksCommand, type CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DescribeSecretCommand, PutSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { PreparedDeployment } from "../deploy/commands.js";
import type { LoadedRelease } from "../deploy/release.js";
import { secretsManagerValueStore, type SecretValueStore } from "../deploy/signing-key.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { AdminSession, SetupServices } from "../setup/services.js";
import type { SigninFlags } from "../signin/collect.js";
import type { CliInvocation } from "./cli-command.js";
import type { InitAnswers } from "./install-state.js";
import type { Prompter, SecretSource } from "./prompts.js";
import type { WizardCard } from "./ui/protocol.js";

export interface InitSecrets extends SecretValueStore {
  /** PutSecretValue on an existing secret. */
  put(name: string, value: string): Promise<void>;
  /** The secret's full ARN, or undefined when it does not exist. */
  arn(name: string): Promise<string | undefined>;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

export function secretsManagerInitSecrets(client: SecretsManagerClient): InitSecrets {
  const base = secretsManagerValueStore(client);
  return {
    get: (name) => base.get(name),
    create: (name, value) => base.create(name, value),
    async put(name, value) {
      await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    },
    async arn(name) {
      try {
        return (await client.send(new DescribeSecretCommand({ SecretId: name }))).ARN;
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") return undefined;
        throw error;
      }
    },
  };
}

export interface StackStatusReader {
  /** The stack's StackStatus, or undefined when it does not exist. */
  status(stackName: string): Promise<string | undefined>;
  /** The stack's parameters, or undefined when it does not exist. Optional: a reader without it
   * skips the checks that need it. */
  parameters?(stackName: string): Promise<Record<string, string> | undefined>;
}

export function cloudFormationStatusReader(client: CloudFormationClient): StackStatusReader {
  const describe = async (stackName: string) => {
    try {
      return (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
    } catch (error) {
      if (errorName(error) === "ValidationError" && /does not exist/.test((error as Error).message)) return undefined;
      throw error;
    }
  };
  return {
    async status(stackName) {
      return (await describe(stackName))?.StackStatus;
    },
    async parameters(stackName) {
      const stack = await describe(stackName);
      if (stack === undefined) return undefined;
      return Object.fromEntries((stack.Parameters ?? []).map((parameter) => [parameter.ParameterKey ?? "", parameter.ParameterValue ?? ""]));
    },
  };
}

export interface SecretFlags {
  slackBotToken?: SecretSource; slackSigningSecret?: SecretSource; githubPrivateKey?: SecretSource;
  slackClientSecret?: SecretSource; oidcClientSecret?: SecretSource;
}
export interface PreMadeGitHubApp { appId: string; installationId: string }

/** Phase 15d2's answers for the finishing steps, from flags (every one also has a prompt). */
export interface FinishFlags {
  adminEmail?: string; projectName?: string; repository?: string; setupCommand?: string; testCommand?: string; channel?: string;
  connectors?: string; linearKey?: SecretSource; jiraToken?: SecretSource; jiraSite?: string; jiraProject?: string;
  asanaClientId?: string; asanaClientSecret?: SecretSource; asanaBotEmail?: string; asanaProject?: string; linearTeam?: string;
}

/** The install page, with --ui only. Steps show what they are doing on it, next to the lines they
 * already write; with no page, every step behaves exactly as before. */
export interface InstallSurface {
  card(card: WizardCard): void;
  /** Drops the page's run link (the button the run waits on), when what it opened has failed. */
  clearLink?(): void;
}

/** Where the GitHub App's manifest form is served and GitHub's redirect is received: the terminal
 * path's one-time listener (github-app.ts's startManifestListener), or the wizard's own address
 * with --ui (FR-030). */
export interface ManifestHost { port: number; startUrl: string; redirectUrl: string; code: Promise<string>; close(): void }
export type OpenManifestHost = (input: { state: string; page: (redirectUrl: string, nonce?: string) => string; timeoutMs: number }) => Promise<ManifestHost>;

// write, now and sleep are function-typed properties rather than methods, so steps can pass them
// on (as `write: context.write`) without an unbound-method lint error.
export interface InitContext {
  env: string;
  answers: InitAnswers;
  release: LoadedRelease;
  holder: string;
  store: ParameterStore;
  secrets: InitSecrets;
  prompter: Prompter;
  /** One progress line (to stderr). */
  write: (line: string) => void;
  /** Absent with --no-browser. Never throws: false means no browser opened (init already said so),
   * and the step carries on without it. */
  openBrowser?: (url: string) => Promise<boolean>;
  /** With --ui only: the page's cards. Undefined on the terminal path, and every use is `?.`. */
  surface?: InstallSurface;
  /** With --ui only: the wizard serves the GitHub App flow itself. */
  manifestHost?: OpenManifestHost;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetch: typeof fetch;
  processEnv: NodeJS.ProcessEnv;
  secretFlags: SecretFlags;
  /** The developer sign-in change to apply (spec 025 R6): one CloudFormation client, shared by the
   * developer-signin step and reused by nothing else. */
  cloudFormation: { send(command: unknown): Promise<unknown> };
  signinFlags: SigninFlags;
  preMadeGitHubApp?: PreMadeGitHubApp;
  /** Built on first use and reused by every deploy step in this run. */
  deployment(): Promise<PreparedDeployment>;
  stackStatus: StackStatusReader;
  home: string;
  /** True when this run already ran checkPrerequisites before the plan. */
  prerequisitesPassed: boolean;
  runPrerequisites(): Promise<void>;
  /** Phase 15d2's injected interfaces (setup/services.ts). */
  setup: SetupServices;
  /** The admin's control-plane session: the stored token when still good, else a new sign-in.
   * Not memoized: each call reads the token store and checks the admin route once. */
  adminSession: () => Promise<AdminSession>;
  /** Phase 15d2's answers for the finishing steps, from flags (every one also has a prompt). */
  flags: FinishFlags;
  /** Issue #222 and spec 048 FR-059 and FR-061: the command this CLI runs as, so every command the
   * steps show (the developer sign-in line, the ready screen) works as shown. */
  cliInvocation: CliInvocation;
}
