// What every init step receives. Every AWS, vendor, browser, clock and prompt dependency is here,
// so tests replace all of them and nothing reaches AWS, GitHub or Slack.
import { DescribeStacksCommand, type CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DescribeSecretCommand, PutSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { PreparedDeployment } from "../deploy/commands.js";
import type { LoadedRelease } from "../deploy/release.js";
import { secretsManagerValueStore, type SecretValueStore } from "../deploy/signing-key.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { SigninFlags } from "../signin/collect.js";
import type { InitAnswers } from "./install-state.js";
import type { Prompter, SecretSource } from "./prompts.js";

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
}

export function cloudFormationStatusReader(client: CloudFormationClient): StackStatusReader {
  return {
    async status(stackName) {
      try {
        return (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
      } catch (error) {
        if (errorName(error) === "ValidationError" && /does not exist/.test((error as Error).message)) return undefined;
        throw error;
      }
    },
  };
}

export interface SecretFlags {
  slackBotToken?: SecretSource; slackSigningSecret?: SecretSource; githubPrivateKey?: SecretSource;
  slackClientSecret?: SecretSource; oidcClientSecret?: SecretSource;
}
export interface PreMadeGitHubApp { appId: string; installationId: string }

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
}
