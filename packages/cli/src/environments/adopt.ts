import { DescribeStacksCommand, type CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { GetCallerIdentityCommand, type STSClient } from "@aws-sdk/client-sts";
import { agentXError, DEFAULT_ENVIRONMENT, type StackPart } from "@agentx/contracts";
import { ModelsAnswersSchema } from "../deploy/answer-schemas.js";
import { writeEnvironmentCache } from "./cache.js";
import { withEnvironmentLock } from "./lock.js";
import type { ParameterStore } from "./parameter-store.js";
import { readEnvironmentSettings, settingsParameterName, writeEnvironmentSettings, type EnvironmentSettings } from "./settings.js";

/**
 * Must equal infra/lib/naming.ts LEGACY_STACK_NAMES (a test compares them). The legacy deployment
 * predates the identity and access stacks, so it has no entry for either here; adopted settings
 * leave stacks.identity and stacks.access unset.
 */
export const ADOPTED_STACK_NAMES: Record<Exclude<StackPart, "identity" | "access">, string> = {
  foundation: "AgentXProductionFoundation",
  runtime: "AgentXProductionRuntime",
  "control-plane": "AgentXControlPlane",
  slack: "AgentXSlackOrchestrator",
};

export interface StackDescription {
  outputs: Record<string, string>;
  parameters: Record<string, string>;
  status: string;
}

export interface StackReader {
  /** DescribeStacks for one stack; undefined when it does not exist. */
  describe(stackName: string): Promise<StackDescription | undefined>;
}

export interface CallerIdentity {
  get(): Promise<{ account: string; arn: string }>;
}

export function cloudFormationStackReader(client: CloudFormationClient): StackReader {
  return {
    async describe(stackName) {
      try {
        const { Stacks } = await client.send(new DescribeStacksCommand({ StackName: stackName }));
        const stack = Stacks?.[0];
        if (!stack) return undefined;
        return {
          status: stack.StackStatus ?? "UNKNOWN",
          outputs: Object.fromEntries(
            (stack.Outputs ?? []).flatMap((output) => (output.OutputKey && output.OutputValue !== undefined ? [[output.OutputKey, output.OutputValue]] : [])),
          ),
          parameters: Object.fromEntries(
            (stack.Parameters ?? []).flatMap((parameter) => (parameter.ParameterKey && parameter.ParameterValue !== undefined ? [[parameter.ParameterKey, parameter.ParameterValue]] : [])),
          ),
        };
      } catch (error) {
        if (error instanceof Error && error.name === "ValidationError" && /does not exist/.test(error.message)) return undefined;
        throw error;
      }
    },
  };
}

export function stsCallerIdentity(client: STSClient): CallerIdentity {
  return {
    async get() {
      const { Account, Arn } = await client.send(new GetCallerIdentityCommand({}));
      if (!Account || !Arn) throw agentXError("RUNTIME_UNAVAILABLE", "AWS did not return the caller identity");
      return { account: Account, arn: Arn };
    },
  };
}

/** Healthy means settled in a *_COMPLETE state other than a rollback or a deletion. */
function isHealthyStatus(status: string): boolean {
  return status.endsWith("_COMPLETE") && status !== "ROLLBACK_COMPLETE" && status !== "DELETE_COMPLETE";
}

async function healthyStack(stacks: StackReader, name: string): Promise<StackDescription> {
  const stack = await stacks.describe(name);
  if (stack === undefined) throw agentXError("CONFIG_INVALID", `stack ${name} was not found in this account and region; nothing changed`);
  if (!isHealthyStatus(stack.status)) {
    throw agentXError("CONFIG_INVALID", `stack ${name} is ${stack.status}; fix it before adopting; nothing changed`);
  }
  return stack;
}

function required(stack: StackDescription, stackName: string, kind: "outputs" | "parameters", key: string): string {
  const value = stack[kind][key];
  if (value === undefined || value === "") {
    throw agentXError("CONFIG_INVALID", `stack ${stackName} has no ${kind === "outputs" ? "output" : "parameter"} ${key}; nothing changed`);
  }
  return value;
}

/**
 * `agentx --env <env> env adopt --region <region>`: register the existing deployment identified by
 * the fixed legacy stack names as environment `<env>`, reading its CloudFormation stacks and
 * writing settings to SSM. Never changes any stack. Refuses, writing nothing, when a stack is
 * missing or unhealthy, an output or parameter is missing, or the environment already has settings.
 * The adopted deployment keeps the legacy stack names, which developer sign-in refuses, so adopt
 * never reads its Slack secret or records a Slack team ID.
 */
export async function adoptEnvironment(input: {
  env: string;
  region: string;
  clientId?: string;
  stacks: StackReader;
  identity: CallerIdentity;
  store: ParameterStore;
  home: string;
  now?: () => number;
}): Promise<EnvironmentSettings> {
  if (input.env !== DEFAULT_ENVIRONMENT) {
    throw agentXError("CONFIG_INVALID", "only the production environment can adopt the deployment that predates environments; nothing changed");
  }
  const now = input.now ?? Date.now;
  const caller = await input.identity.get();
  return withEnvironmentLock({ store: input.store, env: input.env, holder: caller.arn, command: "env adopt", now }, async () => {
    if ((await readEnvironmentSettings(input.store, input.env)) !== undefined) {
      throw agentXError("CONFIG_INVALID", `environment ${input.env} already has settings; nothing changed`);
    }
    const names = ADOPTED_STACK_NAMES;
    await healthyStack(input.stacks, names.foundation);
    const runtime = await healthyStack(input.stacks, names.runtime);
    const control = await healthyStack(input.stacks, names["control-plane"]);
    const slack = await healthyStack(input.stacks, names.slack);
    const issuer = required(control, names["control-plane"], "parameters", "OidcIssuer");
    const audience = required(control, names["control-plane"], "parameters", "OidcAudience");
    const providers = {
      orchestrator: slack.parameters.ModelProvider ?? "amazon-bedrock",
      classifier: slack.parameters.GateClassifierProvider ?? "amazon-bedrock",
      worker: runtime.parameters.ModelProvider ?? "amazon-bedrock",
    };
    const secretArn = slack.parameters.OpenRouterSecretArn || runtime.parameters.OpenRouterSecretArn;
    const routing = slack.parameters.OpenRouterProviders || runtime.parameters.OpenRouterProviders;
    if (slack.parameters.OpenRouterSecretArn && runtime.parameters.OpenRouterSecretArn && slack.parameters.OpenRouterSecretArn !== runtime.parameters.OpenRouterSecretArn) {
      throw agentXError("CONFIG_INVALID", "OpenRouter secret references differ between worker and Slack stacks; align them before adopting");
    }
    const models = ModelsAnswersSchema.parse({
      orchestrator: required(slack, names.slack, "parameters", "ModelId"),
      classifier: required(slack, names.slack, "parameters", "GateClassifierModelId"),
      worker: required(runtime, names.runtime, "parameters", "ModelId"),
      ...(Object.values(providers).some((provider) => provider !== "amazon-bedrock") ? { providers } : {}),
      ...(secretArn ? { openRouter: { secretArn, ...(routing ? { providers: routing.split(",") } : {}) } } : {}),
    });
    const settings: EnvironmentSettings = {
      schemaVersion: 1,
      env: input.env,
      account: caller.account,
      region: input.region,
      engine: "cdk",
      version: "unversioned",
      naming: "legacy",
      stacks: { ...names },
      controlPlaneUrl: required(control, names["control-plane"], "outputs", "ApiEndpoint"),
      identity: { mode: issuer.startsWith("https://cognito-idp.") ? "cognito" : "oidc", issuer, audience, clientId: input.clientId ?? audience },
      models,
      updatedAt: new Date(now()).toISOString(),
    };
    await writeEnvironmentSettings(input.store, settings, { createOnly: true });
    try {
      await writeEnvironmentCache(input.home, settings);
    } catch (error) {
      const detail = errnoDetail(error);
      throw agentXError(
        "RUNTIME_UNAVAILABLE",
        `settings for ${input.env} were saved to ${settingsParameterName(input.env)}, but the local cache could not be written${detail}; run agentx --env ${input.env} env use`,
      );
    }
    return settings;
  });
}

/** The failed write's error class and, for a Node filesystem error, its code (e.g. ENOTDIR) — never its message, which may include a local path. */
function errnoDetail(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const code = "code" in error && typeof (error as NodeJS.ErrnoException).code === "string" ? (error as NodeJS.ErrnoException).code : undefined;
  return ` (${error.name}${code ? `: ${code}` : ""})`;
}
