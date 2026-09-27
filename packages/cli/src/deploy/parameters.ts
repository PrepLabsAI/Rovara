// The install/upgrade deploy parameter model as pure functions: no AWS SDK calls, no CDK imports.
// It turns the operator's answers, a release manifest, and the stack outputs collected so far into
// the exact CloudFormation Parameters map for one environment stack. The caller (phase 15d's `agentx
// init`/`agentx upgrade`) reads secrets and calls CloudFormation; this file only computes values.
import { CONTROL_PLANE_FOUNDATION_PARAMETERS, ImageDigest, environmentStackName } from "@agentx/contracts";
import type { ReleaseManifest, StackPart } from "@agentx/contracts";

export type StackOutputs = Record<string, string>;

export type DeployPart = StackPart;

export interface InstallAnswers {
  env: string;
  region: string;
  account: string;
  /** default "aws" */
  partition?: string;
  release: ReleaseManifest;
  models: { orchestrator: string; classifier: string; worker: string };
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
  github: { account: string; appId: string; installationId: string; privateKeySecretArn: string; credentialRef?: string };
  /** The value; the caller reads it from Secrets Manager, never logs it. */
  callbackSigningKey: string;
  permissionsBoundaryArn?: string;
  operatorPrincipalArn?: string;
  /** Testing only, until the first published release exists: a private-ECR image digest used as-is
   * instead of mapping the release's public image through the pull-through cache. */
  images?: { worker?: string; slack?: string };
}

/** The shortest callback signing key the control plane accepts. */
const MIN_CALLBACK_SIGNING_KEY_LENGTH = 32;

/** The parameter names whose values must never be printed: every NoEcho template parameter. */
export const SECRET_PARAMETERS: ReadonlySet<string> = new Set(["CallbackSigningKey"]);

/** Fresh install order: the control plane needs the GitHub App before the runtime needs the control plane's URL. */
export function installOrder(identityMode: "cognito" | "oidc"): DeployPart[] {
  const order: DeployPart[] = ["access", "foundation", "identity", "control-plane", "runtime", "slack"];
  return withoutIdentityWhenOidc(order, identityMode);
}

/** Upgrade order: the runtime deploys before the control plane, as the release pipeline does, so the worker (the tolerant side of the window) parses strictly first. */
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

/** Throws the exact message a missing stack output must report. */
function required(outputs: Partial<Record<DeployPart, StackOutputs>>, part: DeployPart, name: string, env: string): string {
  const value = outputs[part]?.[name];
  if (value === undefined) throw new Error(`stack ${environmentStackName(env, part)} has no output ${name}`);
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

/** Parameters for one stack. Throws a clear error naming the missing input or output. */
export function stackParameters(part: DeployPart, answers: InstallAnswers, outputs: Partial<Record<DeployPart, StackOutputs>>): Record<string, string> {
  const boundary = answers.permissionsBoundaryArn ?? "";
  const base: Record<string, string> = {
    PermissionsBoundaryArn: boundary,
    ...packageParameters(answers.release, part, outputs, answers.env),
  };

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
        OidcIssuer: oidc.issuer,
        OidcAudience: oidc.audience,
        ...adminParameters(answers.identity),
        CallbackSigningKey: answers.callbackSigningKey,
        GitHubAppAccount: answers.github.account,
        GitHubAppId: answers.github.appId,
        GitHubAppInstallationId: answers.github.installationId,
        GitHubAppPrivateKeySecretArn: answers.github.privateKeySecretArn,
        ...(answers.github.credentialRef === undefined ? {} : { GitHubAppCredentialRef: answers.github.credentialRef }),
        // The EC2 session lifecycle (#83) runs in the foundation's network with its key and role.
        ...Object.fromEntries(CONTROL_PLANE_FOUNDATION_PARAMETERS.map((name) => [name, required(outputs, "foundation", name, answers.env)])),
      };
    }

    case "runtime": {
      return {
        ...base,
        WorkerImageUri: resolvedImage(answers, "worker", outputs),
        ControlPlaneUrl: required(outputs, "control-plane", "ApiEndpoint", answers.env),
        ModelProvider: "amazon-bedrock",
        ModelId: answers.models.worker,
        CapacityProviderArn: required(outputs, "foundation", "CapacityProviderArn", answers.env),
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
        VpcId: required(outputs, "foundation", "VpcId", answers.env),
        PrivateSubnetIds: required(outputs, "foundation", "PrivateSubnetIds", answers.env),
        ModelProvider: "amazon-bedrock",
        ModelId: answers.models.orchestrator,
        GateClassifierModelId: answers.models.classifier,
      };
    }
  }
}
