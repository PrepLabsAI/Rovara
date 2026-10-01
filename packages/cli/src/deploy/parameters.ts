// The install/upgrade deploy parameter model as pure functions: no AWS SDK calls, no CDK imports.
// It turns the operator's answers, a release manifest, and the stack outputs collected so far into
// the exact CloudFormation Parameters map for one environment stack. The caller (phase 15d's `agentx
// init`/`agentx upgrade`) reads secrets and calls CloudFormation; this file only computes values.
import { CONTROL_PLANE_FOUNDATION_PARAMETERS, ImageDigest, KEYED_MODEL_PROVIDERS, KEYED_PROVIDER_IDS, environmentStackName } from "@agentx/contracts";
import type { ReleaseManifest, StackPart } from "@agentx/contracts";
import { signInStackParameters, type StoredDeveloperSignIn } from "../signin/settings.js";

import { providerSecretArn, type ModelsAnswers } from "./answer-schemas.js";

export type StackOutputs = Record<string, string>;

export type DeployPart = StackPart;

export interface InstallAnswers {
  env: string;
  region: string;
  account: string;
  /** default "aws" */
  partition?: string;
  release: ReleaseManifest;
  models: ModelsAnswers;
  identity:
    | { mode: "cognito" }
    | {
        mode: "oidc";
        issuer: string;
        audience: string;
        /** Required together: bringing your own OIDC provider means there is no identity stack's fixed admin group to fall back on. */
        adminClaim?: string;
        adminValues?: string[];
        /** Required to write environment settings (the deploy orchestrator's clientId for `agentx login`): bringing
         * your own OIDC provider means there is no identity stack's ClientId output to read it from instead. */
        clientId?: string;
      };
  // account and installationId are what `agentx init` set up; the control plane no longer takes them (#123).
  github: { account?: string; appId: string; installationId?: string; privateKeySecretArn: string; credentialRef?: string };
  /** The value; the caller reads it from Secrets Manager, never logs it. */
  callbackSigningKey: string;
  permissionsBoundaryArn?: string;
  operatorPrincipalArn?: string;
  /** Testing only, until the first published release exists: a private-ECR image digest used as-is
   * instead of mapping the release's public image through the pull-through cache. */
  images?: { worker?: string; slack?: string };
  /** the control plane's SlackAppPostedMessages (spec 014 FR-012); template default accept */
  slackAppPostedMessages?: "accept" | "ignore";
  /** Spec 025 R7: the stored developer sign-in; deployEnvironment reads it from SSM when absent. */
  developerSignIn?: StoredDeveloperSignIn;
  /** FR-047's budget; absent means none (the template's BudgetMonthlyUsd default, 0). */
  budget?: { monthlyUsd: number; scope: "tag" | "account" };
}

/** The shortest callback signing key the control plane accepts. */
const MIN_CALLBACK_SIGNING_KEY_LENGTH = 32;

/** The parameter names whose values must never be printed: every NoEcho template parameter. */
export const SECRET_PARAMETERS: ReadonlySet<string> = new Set(["CallbackSigningKey"]);

/**
 * Stack parameters an operator sets after install (the budget question, agentx config set) that an
 * upgrade's answers do not carry. An upgrade keeps each one's deployed value unless its answers set
 * it, so no upgrade resets them to the template default. Models are not here: they live in the
 * settings, which the upgrade's answers read.
 */
export const OPERATOR_PARAMETERS: Readonly<Record<DeployPart, readonly string[]>> = {
  access: [],
  foundation: [],
  identity: [],
  runtime: [],
  "control-plane": ["BudgetMonthlyUsd", "BudgetScope", "SlackAppPostedMessages", "SlackThreadTurnsPerMinute", "SlackMemberWorkspaceLimit", "SlackOrganizationWorkspaceLimit", "McpConfirmElicitation"],
  slack: ["SlowTurnMinutes"],
};

/** Fresh install order: the control plane needs the GitHub App. The `runtime` part is the EC2 worker settings (#117); the control plane reads them only when it boots a worker. */
export function installOrder(identityMode: "cognito" | "oidc"): DeployPart[] {
  const order: DeployPart[] = ["access", "foundation", "identity", "control-plane", "runtime", "slack"];
  return withoutIdentityWhenOidc(order, identityMode);
}

/** Upgrade order: the worker settings deploy before the control plane, as the release pipeline does, so workers booted from then on (the tolerant side of the window) run the new image first. */
export function upgradeOrder(identityMode: "cognito" | "oidc"): DeployPart[] {
  const order: DeployPart[] = ["access", "foundation", "identity", "runtime", "control-plane", "slack"];
  return withoutIdentityWhenOidc(order, identityMode);
}

function withoutIdentityWhenOidc(order: DeployPart[], identityMode: "cognito" | "oidc"): DeployPart[] {
  return identityMode === "oidc" ? order.filter((part) => part !== "identity") : order;
}

const PUBLIC_ECR_PREFIX = "public.ecr.aws/";

/** ECR's own DNS suffix per partition (not every partition's general service-endpoint suffix: aws-us-gov's ECR is still under amazonaws.com). */
const ECR_HOST_SUFFIX: Readonly<Record<string, string>> = {
  aws: "amazonaws.com",
  "aws-cn": "amazonaws.com.cn",
  "aws-us-gov": "amazonaws.com",
};

function ecrHostSuffix(partition: string): string {
  const suffix = ECR_HOST_SUFFIX[partition];
  if (suffix === undefined) throw new Error(`unknown partition ${partition}; expected aws, aws-cn, or aws-us-gov`);
  return suffix;
}

/** public.ecr.aws/<alias>/<repo>@sha256:<d> → <account>.dkr.ecr.<region>.<ecr host suffix for partition, default aws>/<prefix>/<alias>/<repo>@sha256:<d> */
export function privateImageUri(publicRef: string, target: { account: string; region: string; prefix: string; partition?: string }): string {
  if (!publicRef.startsWith(PUBLIC_ECR_PREFIX)) {
    throw new Error(`image ${publicRef} is not a ${PUBLIC_ECR_PREFIX} reference`);
  }
  const rest = publicRef.slice(PUBLIC_ECR_PREFIX.length);
  if (!/@sha256:[a-f0-9]{64}$/.test(rest)) {
    throw new Error(`image ${publicRef} is not pinned to a digest`);
  }
  const hostSuffix = ecrHostSuffix(target.partition ?? "aws");
  return `${target.account}.dkr.ecr.${target.region}.${hostSuffix}/${target.prefix}/${rest}`;
}

/** A stack output a later stack's parameters need is missing: typed, so upgrade --export can say what to do instead. */
export class MissingStackOutputError extends Error {
  constructor(readonly stackName: string, readonly output: string) {
    super(`stack ${stackName} has no output ${output}`);
    this.name = "MissingStackOutputError";
  }
}

/** Throws the exact message a missing stack output must report. */
function required(outputs: Partial<Record<DeployPart, StackOutputs>>, part: DeployPart, name: string, env: string): string {
  const value = outputs[part]?.[name];
  if (value === undefined) throw new MissingStackOutputError(environmentStackName(env, part), name);
  return value;
}

/** Throws the exact message a release missing an image digest must report. */
function requiredImage(release: ReleaseManifest, which: "worker" | "slack"): string {
  const digest = release.images[which];
  if (digest === undefined) throw new Error(`release ${release.version} has no ${which} image digest`);
  return digest;
}

/** Throws the exact message a non-digest image override must report; otherwise returns it as-is. */
function checkedImageOverride(uri: string, which: "worker" | "slack"): string {
  if (!ImageDigest.safeParse(uri).success) throw new Error(`image override for ${which} must be referenced by digest`);
  return uri;
}

/**
 * The image URI for `which`: the answers' override when given (validated to be a digest
 * reference, used as-is), otherwise the release's public image mapped through the account's
 * pull-through cache. Only the non-override path needs the access stack's `PullThroughPrefix`
 * output, so an override lets `runtime`/`slack` resolve without it.
 */
function resolvedImage(answers: InstallAnswers, which: "worker" | "slack", outputs: Partial<Record<DeployPart, StackOutputs>>): string {
  const override = answers.images?.[which];
  if (override !== undefined) return checkedImageOverride(override, which);
  const prefix = required(outputs, "access", "PullThroughPrefix", answers.env);
  return privateImageUri(requiredImage(answers.release, which), imageTarget(answers, prefix));
}

/** Every release package deployed with `part`: the asset parameters that stack's template declares. */
function packageParameters(release: ReleaseManifest, part: DeployPart, outputs: Partial<Record<DeployPart, StackOutputs>>, env: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pkg of release.packages) {
    // The access stack is the one template the service role cannot deploy itself, so it is
    // synthesized without the legacy asset-parameter machinery and has no ArtifactBucketName
    // output of its own to resolve pkg.bucketParameter against (required() below would throw a
    // confusing "stack agentx-<env>-access has no output ArtifactBucketName" instead of naming
    // the actual problem: the release manifest itself is wrong).
    if (pkg.parts.includes("access")) {
      throw new Error(`release package ${pkg.assetId} lists "access" among its parts, but the access stack carries no zip assets`);
    }
    if (!pkg.parts.includes(part)) continue;
    params[pkg.bucketParameter] = required(outputs, "access", "ArtifactBucketName", env);
    params[pkg.keyParameter] = pkg.keyParameterValue;
    params[pkg.hashParameter] = pkg.assetId;
  }
  return params;
}

/** The `privateImageUri` target for `answers`, carrying the partition through only when given (exactOptionalPropertyTypes forbids `partition: undefined`). */
function imageTarget(answers: InstallAnswers, prefix: string): { account: string; region: string; prefix: string; partition?: string } {
  return {
    account: answers.account,
    region: answers.region,
    prefix,
    ...(answers.partition === undefined ? {} : { partition: answers.partition }),
  };
}

/** Throws when your own OIDC provider is given without naming its administrators; returns nothing for Cognito, whose template defaults (cognito:groups / ["agentx-admin"]) already match the identity stack's admin group. */
function adminParameters(identity: InstallAnswers["identity"]): Record<string, string> {
  if (identity.mode === "cognito") return {};
  const { adminClaim, adminValues } = identity;
  if (adminClaim === undefined || adminValues === undefined) {
    throw new Error("bringing your own OIDC provider requires adminClaim and adminValues (the claim and values that mark AgentX administrators)");
  }
  if (adminClaim === "" || adminValues.length === 0) {
    // An empty claim or an empty value list would pass the undefined check above but leave the
    // install with no administrators: every login would fail the claim check silently.
    throw new Error("bringing your own OIDC provider requires a non-empty adminClaim and adminValues (the claim and values that mark AgentX administrators)");
  }
  return { AdminClaim: adminClaim, AdminValues: JSON.stringify(adminValues) };
}

/** Parameters for one stack. Throws a clear error naming the missing input or output. The release's
 * package parameters belong to its published templates only: a cdk deploy synthesizes from source and
 * uploads its own assets, and CloudFormation refuses a parameter its template does not declare, so
 * the cdk engine passes `packages: false` (Task 20 live check). The option is required so every
 * caller chooses (review M5). */
export function stackParameters(part: DeployPart, answers: InstallAnswers, outputs: Partial<Record<DeployPart, StackOutputs>>, options: { packages: boolean }): Record<string, string> {
  const boundary = answers.permissionsBoundaryArn ?? "";
  const base: Record<string, string> = {
    PermissionsBoundaryArn: boundary,
    ...(options.packages ? packageParameters(answers.release, part, outputs, answers.env) : {}),
  };

  const openRouter = answers.models.openRouter;
  // Each keyed provider's secret ARN, for the stacks that declare <Provider>SecretArn; only when
  // configured, so an older template without the parameter is never sent it.
  const secret = Object.fromEntries(KEYED_PROVIDER_IDS.flatMap((provider) => {
    const arn = providerSecretArn(answers.models, provider);
    return arn === undefined ? [] : [[KEYED_MODEL_PROVIDERS[provider].stackParameter, arn]];
  }));
  const routing = openRouter?.providers ? { OpenRouterProviders: openRouter.providers.join(",") } : {};
  switch (part) {
    case "access":
      return { ...base, OperatorPrincipalArn: answers.operatorPrincipalArn ?? "" };

    case "foundation":
    case "identity":
      return base;

    case "control-plane": {
      if (answers.callbackSigningKey.length < MIN_CALLBACK_SIGNING_KEY_LENGTH) {
        // Never include the value: it is a secret.
        throw new Error(`the callback signing key must be at least ${MIN_CALLBACK_SIGNING_KEY_LENGTH} characters`);
      }
      const oidc =
        answers.identity.mode === "cognito"
          ? { issuer: required(outputs, "identity", "Issuer", answers.env), audience: required(outputs, "identity", "Audience", answers.env) }
          : { issuer: answers.identity.issuer, audience: answers.identity.audience };
      return {
        ...base,
        ...secret,
        OidcIssuer: oidc.issuer,
        OidcAudience: oidc.audience,
        ...adminParameters(answers.identity),
        CallbackSigningKey: answers.callbackSigningKey,
        GitHubAppId: answers.github.appId,
        GitHubAppPrivateKeySecretArn: answers.github.privateKeySecretArn,
        ...(answers.github.credentialRef === undefined ? {} : { GitHubAppCredentialRef: answers.github.credentialRef }),
        // The EC2 session lifecycle (#83) runs in the foundation's network with its key and role.
        ...Object.fromEntries(CONTROL_PLANE_FOUNDATION_PARAMETERS.map((name) => [name, required(outputs, "foundation", name, answers.env)])),
        ...(answers.slackAppPostedMessages === undefined ? {} : { SlackAppPostedMessages: answers.slackAppPostedMessages }),
        ...(answers.budget === undefined ? {} : { BudgetMonthlyUsd: String(answers.budget.monthlyUsd), BudgetScope: answers.budget.scope }),
        // F24: only when a stored sign-in choice is actually given; the template's own defaults
        // (sign-in off) are otherwise left untouched, and only the seven keys the control-plane
        // template declares (infra/lib/developer-signin.ts) are ever added here.
        ...(answers.developerSignIn === undefined ? {} : signInStackParameters(answers.developerSignIn)),
      };
    }

    case "runtime": {
      return {
        ...base,
        WorkerImageUri: resolvedImage(answers, "worker", outputs),
        ModelProvider: answers.models.providers?.worker ?? "amazon-bedrock",
        ModelId: answers.models.worker,
        ...secret, ...routing,
      };
    }

    case "slack": {
      return {
        ...base,
        OrchestratorImageUri: resolvedImage(answers, "slack", outputs),
        TaskRoleArn: required(outputs, "control-plane", "SlackOrchestratorTaskRoleArn", answers.env),
        ControlPlaneUrl: required(outputs, "control-plane", "ApiEndpoint", answers.env),
        SlackRequestQueueUrl: required(outputs, "control-plane", "SlackRequestQueueUrl", answers.env),
        SlackThreadsTableName: required(outputs, "control-plane", "SlackThreadsTableName", answers.env),
        TurnRecordsTableName: required(outputs, "control-plane", "TurnRecordsTableName", answers.env),
        ThreadSessionBucketName: required(outputs, "control-plane", "SlackThreadSessionBucketName", answers.env),
        SlackSecretArn: required(outputs, "control-plane", "SlackSecretArn", answers.env),
        OperatorAlertsTopicArn: required(outputs, "control-plane", "OperatorAlertsTopicArn", answers.env),
        VpcId: required(outputs, "foundation", "VpcId", answers.env),
        PrivateSubnetIds: required(outputs, "foundation", "PrivateSubnetIds", answers.env),
        ModelProvider: answers.models.providers?.orchestrator ?? "amazon-bedrock",
        ModelId: answers.models.orchestrator,
        ...secret, ...routing,
        ...(answers.models.providers?.classifier ? { GateClassifierProvider: answers.models.providers.classifier } : {}),
        GateClassifierModelId: answers.models.classifier,
      };
    }
  }
}
