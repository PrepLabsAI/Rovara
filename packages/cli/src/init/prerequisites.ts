// FR-015: everything init checks before it creates anything. Every problem is collected and
// reported together, with what to change; cdk bootstrap (which creates the CDKToolkit stack) is
// offered only when every other check has passed.
import { BedrockAgentCoreControlClient, ListAgentRuntimesCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { agentXError, AgentXError } from "@agentx/contracts";
import { assertCdkBootstrapped, type CommandRunner } from "../deploy/cdk-engine.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { InitAnswers } from "./install-state.js";
import type { Prompter } from "./prompts.js";

export interface PrerequisiteChecks {
  /** A one-token Bedrock Converse call. */
  converse(modelId: string): Promise<void>;
  /** A read-only AgentCore control-plane call in the region (ListAgentRuntimes, 1 result). */
  agentCore(): Promise<void>;
  /** The command's --version output, or undefined when it is not installed. */
  commandVersion(command: string): Promise<string | undefined>;
  cdkBootstrapped(): Promise<boolean>;
  runCdkBootstrap(): Promise<void>;
  oidcDiscovery(issuer: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;
}

export type ModelRole = "orchestrator" | "classifier" | "worker";

export const DEDICATED_ACCOUNT_NOTE =
  "AgentX recommends a dedicated AWS account for each install: environments that share an account are not a security boundary against each other.";

const errorName = (error: unknown) => (error instanceof Error ? error.name : "");
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** True when the error means the service has no endpoint in the region: an SDK client refuses to
 * even build a request (UnknownEndpoint / EndpointError), or DNS resolution for the regional
 * hostname failed outright (ENOTFOUND), rather than the request reaching AWS and being refused. */
export function endpointMissing(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    const record = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (record.name === "UnknownEndpoint" || record.name === "EndpointError" || record.code === "ENOTFOUND") return true;
    if (typeof record.message === "string" && /getaddrinfo ENOTFOUND/.test(record.message)) return true;
    current = record.cause;
  }
  return false;
}

function profilePrefix(region: string): string {
  if (region.startsWith("eu-")) return "eu.";
  if (region.startsWith("ap-")) return "apac.";
  return "us.";
}

/** Turns a failed one-token Converse call into a message that says what to change, for the four
 * failures a new account hits in practice (Review Focus 5): the Anthropic use-case form, a model
 * id that must be called through an inference profile, an id Bedrock does not recognize in this
 * region, and access simply not being enabled for the model. */
export function modelCheckProblem(input: { modelId: string; role: ModelRole; region: string; error: unknown }): string {
  const { modelId, role, region, error } = input;
  const name = errorName(error);
  const message = errorMessage(error);
  if (endpointMissing(error)) return `Amazon Bedrock is not available in ${region}`;
  if (name === "AccessDeniedException" && /use case/i.test(message)) {
    return `${modelId}: Anthropic models need a one-time use-case form in this account. Open the Bedrock console in ${region}, Model catalog, choose the model and submit the form, then run agentx init again`;
  }
  if (name === "ValidationException" && /on-demand throughput/i.test(message)) {
    return `${modelId} must be called through an inference profile in ${region}; use ${profilePrefix(region)}${modelId} instead (--${role}-model)`;
  }
  if (name === "ResourceNotFoundException" || (name === "ValidationException" && /model identifier is invalid/i.test(message))) {
    return `${modelId} is not a Bedrock model id available in ${region}; check the id, or choose another with --${role}-model`;
  }
  if (name === "AccessDeniedException") {
    return `${modelId}: this account or your credentials cannot call it in ${region} (${message}). Enable access in the Bedrock console (Model access), or choose another model with --${role}-model`;
  }
  if (name === "ThrottlingException") return `Bedrock throttled the check of ${modelId}; wait a minute and run agentx init again`;
  return `${modelId} did not answer a one-token test call in ${region}: ${message}`;
}

function nodeVersionOk(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

/** Everything `agentx init` must confirm before it creates a single resource: the account and
 * region can run AgentCore, each distinct model answers, the identity provider (when self-hosted)
 * agrees with itself, and the chosen engine's tooling is in place. Every problem found is collected
 * and reported together (FR-015): a person fixing an account should not have to run init five
 * times to hear about a fifth thing wrong each time. */
export async function checkPrerequisites(input: {
  answers: InitAnswers; releaseRegions: readonly string[]; caller: { account: string; arn: string };
  checks: PrerequisiteChecks; prompter: Prompter; write: (line: string) => void;
}): Promise<void> {
  const { answers, checks, write } = input;
  const { region } = answers;
  const problems: string[] = [];
  write(`AWS account ${input.caller.account} as ${input.caller.arn}`);
  write(DEDICATED_ACCOUNT_NOTE);

  // Task 7 (F6) gives every command one shared `assertReleaseCoversRegion` helper; this check is
  // deliberately kept to this one inline line rather than pre-empting that helper.
  if (!input.releaseRegions.includes(region)) {
    problems.push(`this release does not cover region ${region}; it covers: ${input.releaseRegions.join(", ") || "no region"}`);
  }

  try {
    await checks.agentCore();
    write(`ok AgentCore Runtime is available in ${region}`);
  } catch (error) {
    if (errorName(error).startsWith("AccessDenied")) write(`ok AgentCore Runtime answers in ${region}`);
    else if (endpointMissing(error)) problems.push(`Amazon Bedrock AgentCore Runtime is not available in ${region}`);
    else problems.push(`could not reach AgentCore Runtime in ${region}: ${errorMessage(error)}`);
  }

  const roles: Array<[ModelRole, string]> = [
    ["orchestrator", answers.models.orchestrator],
    ["classifier", answers.models.classifier],
    ["worker", answers.models.worker],
  ];
  const seen = new Set<string>();
  for (const [role, modelId] of roles) {
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    try {
      try {
        await checks.converse(modelId);
      } catch (error) {
        if (errorName(error) !== "ThrottlingException") throw error;
        await checks.sleep(2000);
        await checks.converse(modelId);
      }
      write(`ok ${modelId} answers`);
    } catch (error) {
      problems.push(modelCheckProblem({ modelId, role, region, error }));
    }
  }

  if (answers.identity.mode === "oidc") {
    const issuer = answers.identity.issuer.replace(/\/$/, "");
    const url = `${issuer}/.well-known/openid-configuration`;
    try {
      const document = (await checks.oidcDiscovery(answers.identity.issuer)) as { issuer?: unknown };
      const named = typeof document.issuer === "string" ? document.issuer.replace(/\/$/, "") : undefined;
      if (named !== issuer) problems.push(`the OIDC discovery document at ${url} names issuer ${named ?? "nothing"}, not ${issuer}`);
      else write(`ok OIDC discovery at ${url}`);
    } catch (error) {
      problems.push(`could not read the OIDC discovery document at ${url}: ${errorMessage(error)}`);
    }
  }

  let needsBootstrap = false;
  if (answers.engine === "cdk") {
    const node = await checks.commandVersion("node");
    if (node === undefined || !nodeVersionOk(node)) problems.push(`the cdk engine needs Node 22.19 or later (found ${node?.trim() ?? "no node"})`);
    if ((await checks.commandVersion("npx")) === undefined) problems.push("the cdk engine needs npx (it comes with npm)");
    needsBootstrap = !(await checks.cdkBootstrapped());
  }

  // cdk bootstrap creates the CDKToolkit stack (Review Focus 5's sibling concern): offered only
  // once every other check has passed, so init never asks to create something before it is sure
  // nothing else is going to stop the run anyway.
  if (needsBootstrap && problems.length === 0) {
    const target = `aws://${answers.account}/${region}`;
    write(`CDK is not bootstrapped in ${region}. cdk bootstrap creates the CDKToolkit stack (an S3 bucket, an ECR repository and deploy roles) that the cdk engine needs.`);
    if (await input.prompter.confirm(`Run cdk bootstrap ${target} now?`, { defaultValue: false })) {
      await checks.runCdkBootstrap();
      write(`ok CDK bootstrapped in ${region}`);
    } else {
      problems.push(`CDK is not bootstrapped in ${region}; run npx cdk bootstrap ${target}, or use --engine templates, which needs no bootstrap`);
    }
  }

  if (problems.length > 0) {
    throw agentXError("CONFIG_INVALID", `init cannot start; nothing was created:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}

export function awsPrerequisiteChecks(input: { region: string; account: string; store: ParameterStore; runner: CommandRunner; fetch: typeof fetch }): PrerequisiteChecks {
  const bedrock = new BedrockRuntimeClient({ region: input.region });
  const agentCore = new BedrockAgentCoreControlClient({ region: input.region });
  return {
    async converse(modelId) {
      await bedrock.send(new ConverseCommand({ modelId, messages: [{ role: "user", content: [{ text: "Reply with OK." }] }], inferenceConfig: { maxTokens: 1 } }));
    },
    async agentCore() {
      await agentCore.send(new ListAgentRuntimesCommand({ maxResults: 1 }));
    },
    async commandVersion(command) {
      try {
        return (await input.runner.run(command, ["--version"], { cwd: process.cwd(), display: `${command} --version` })).stdout;
      } catch {
        return undefined;
      }
    },
    async cdkBootstrapped() {
      try {
        await assertCdkBootstrapped({ store: input.store, region: input.region });
        return true;
      } catch (error) {
        // F11: assertCdkBootstrapped throws this one AgentXError only when the bootstrap
        // parameter itself was not found (never bootstrapped); every other failure it can throw
        // (access denied, throttled, any other read error) is a plain Error that already carries
        // its own context, and must be rethrown rather than read as "not bootstrapped" (reading it
        // that way would send someone to run cdk bootstrap when what actually needs fixing is
        // their credentials).
        if (error instanceof AgentXError && error.code === "CONFIG_INVALID" && /is not bootstrapped/.test(error.message)) return false;
        throw error;
      }
    },
    async runCdkBootstrap() {
      const target = `aws://${input.account}/${input.region}`;
      await input.runner.run("npx", ["cdk", "bootstrap", target], { cwd: process.cwd(), display: `npx cdk bootstrap ${target}` });
    },
    async oidcDiscovery(issuer) {
      const response = await input.fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  };
}
