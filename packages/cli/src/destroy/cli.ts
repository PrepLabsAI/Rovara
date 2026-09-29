// The `agentx destroy` command (FR-055), kept out of main.ts. It needs admin credentials (question 7)
// and an explicit --env, and it reads each typed confirmation from the terminal or, when stdin is not
// a terminal, from piped stdin (question 11). No flag skips the typed name.
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { STSClient } from "@aws-sdk/client-sts";
import { agentXError } from "@agentx/contracts";
import type { Command } from "commander";
import { stsCallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { TextWriter } from "../init/prompts.js";
import { formatSuccess } from "../output.js";
import { environmentProjectFiles } from "../setup/project-add.js";
import type { TokenStore } from "../token-store.js";
import { awsDestroyApi } from "./aws.js";
import { runDestroy, type DestroyDependencies } from "./run.js";

/** One answer per line, from a terminal or a pipe. End of input answers "", which every typed
 * confirmation refuses. */
export function lineReader(input: { stdin: Readable; stderr: TextWriter }): { ask(question: string): Promise<string>; close(): void } {
  const rl = createInterface({ input: input.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question) {
      input.stderr.write(question);
      const next = await lines.next();
      return next.done === true ? "" : String(next.value);
    },
    close() { rl.close(); },
  };
}

/** The environment's project files destroy removes. A file that could not be read, or read as YAML,
 * is skipped and named: its register line may still name the environment's launch template, but
 * agentx destroy never deletes a file it could not read. */
export async function destroyProjectFiles(input: { configDir: string; env: string; write: (line: string) => void }): Promise<Array<{ path: string; launchTemplateId: string }>> {
  const found: Array<{ path: string; launchTemplateId: string }> = [];
  for (const file of await environmentProjectFiles(input.configDir, input.env)) {
    if (file.error !== undefined) {
      const why = file.error === "invalid-yaml" ? "it is not valid YAML" : `it could not be read (${file.errorCode ?? "unknown"})`;
      input.write(`Skipping ${file.path}: ${why}, so agentx destroy leaves it; delete it by hand if it belongs to ${input.env}`);
      continue;
    }
    found.push({ path: file.path, launchTemplateId: file.launchTemplateId });
  }
  return found;
}

/** --region, or the region your AWS configuration names; undefined when neither gives one. */
async function configuredRegion(flag: string | undefined): Promise<string | undefined> {
  if (flag !== undefined) return flag;
  try {
    return await new STSClient({}).config.region();
  } catch {
    return undefined;
  }
}

export interface DestroyCommandContext {
  overrides?: Partial<DestroyDependencies>;
  parameterStore: (region?: string) => ParameterStore;
  stdin: Readable;
  home: string;
  tokenStore: TokenStore;
  stdout: TextWriter;
  stderr: TextWriter;
}

export function registerDestroyCommand(program: Command, context: DestroyCommandContext): void {
  program
    .command("destroy")
    .description("remove one named environment from this AWS account: its stacks, workers, kept data, secrets and settings, in order (admin credentials; you type its name to confirm)")
    .option("--region <region>", "AWS region of the environment; defaults to your AWS configuration")
    .option("--keep-data", "keep the tables, buckets, secrets, Cognito user pool and KMS keys; remove the rest", false)
    .action(async (options: { region?: string; keepData: boolean }, command: Command) => {
      if (command.getOptionValueSourceWithGlobals("env") !== "cli") {
        throw agentXError("CONFIG_INVALID", "agentx destroy requires an explicit --env, so it can never remove production by default; run agentx --env <name> destroy");
      }
      const globals = command.optsWithGlobals<{ env: string; json: boolean; configDir: string }>();
      const overrides = context.overrides ?? {};
      // Every client, the settings store and the plan use this one region, so runDestroy's check
      // against the environment's own region covers everything it touches.
      const region = overrides.region ?? await configuredRegion(options.region);
      if (region === undefined) throw agentXError("CONFIG_INVALID", "agentx destroy could not find an AWS region in your configuration; pass --region <the environment's region>");
      const aws = { region };
      const write = overrides.write ?? ((line: string) => { context.stderr.write(`${line}\n`); });
      const reader = overrides.confirmLine === undefined ? lineReader({ stdin: context.stdin, stderr: context.stderr }) : undefined;
      try {
        const deps: DestroyDependencies = {
          store: overrides.store ?? context.parameterStore(region),
          api: overrides.api ?? awsDestroyApi({
            cloudFormation: new CloudFormationClient(aws), ec2: new EC2Client(aws), s3: new S3Client(aws), dynamodb: new DynamoDBClient(aws),
            logs: new CloudWatchLogsClient(aws), cognito: new CognitoIdentityProviderClient(aws), kms: new KMSClient(aws), secrets: new SecretsManagerClient(aws),
          }),
          identity: overrides.identity ?? stsCallerIdentity(new STSClient(aws)),
          confirmLine: overrides.confirmLine ?? ((question) => reader!.ask(question)),
          write,
          sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); })),
          now: overrides.now ?? Date.now,
          home: overrides.home ?? context.home,
          projectFiles: overrides.projectFiles ?? ((env) => destroyProjectFiles({ configDir: globals.configDir, env, write })),
          tokenStore: overrides.tokenStore ?? context.tokenStore,
          region,
        };
        const result = await runDestroy({ env: globals.env, keepData: options.keepData }, deps);
        context.stdout.write(globals.json ? formatSuccess(result, true) : result.removed
          ? `${[`Removed environment ${result.env}.`, ...result.manualSteps.map((step) => `  ${step}`)].join("\n")}\n`
          : `Nothing to remove for environment ${result.env}.\n`);
      } finally {
        reader?.close();
      }
    });
}
