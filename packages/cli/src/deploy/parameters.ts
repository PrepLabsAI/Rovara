// The install/upgrade deploy parameter model as pure functions: no AWS SDK calls, no CDK imports.
// It turns the operator's answers, a release manifest, and the stack outputs collected so far into
// the exact CloudFormation Parameters map for one environment stack. The caller (phase 15d's `agentx
// init`/`agentx upgrade`) reads secrets and calls CloudFormation; this file only computes values.
import { environmentStackName } from "@agentx/contracts";
import type { ReleaseManifest } from "@agentx/contracts";

export type StackOutputs = Record<string, string>;

export type DeployPart = "access" | "foundation" | "identity" | "runtime" | "control-plane" | "slack";

export interface InstallAnswers {
  env: string;
  region: string;
  account: string;
  /** default "aws" */
  partition?: string;
  release: ReleaseManifest;
  models: { orchestrator: string; classifier: string; worker: string };
  identity: { mode: "cognito" } | { mode: "oidc"; issuer: string; audience: string };
  github: { account: string; appId: string; installationId: string; privateKeySecretArn: string; credentialRef?: string };
  /** The value; the caller reads it from Secrets Manager, never logs it. */
  callbackSigningKey: string;
  permissionsBoundaryArn?: string;
  operatorPrincipalArn?: string;
}

/** The parameter names whose values must never be printed. */
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

/** public.ecr.aws/<alias>/<repo>@sha256:<d> → <account>.dkr.ecr.<region>.amazonaws.com/<prefix>/<alias>/<repo>@sha256:<d> */
export function privateImageUri(publicRef: string, target: { account: string; region: string; prefix: string }): string {
  if (!publicRef.startsWith(PUBLIC_ECR_PREFIX)) {
    throw new Error(`image ${publicRef} is not a ${PUBLIC_ECR_PREFIX} reference`);
  }
  const rest = publicRef.slice(PUBLIC_ECR_PREFIX.length);
  if (!/@sha256:[a-f0-9]{64}$/.test(rest)) {
    throw new Error(`image ${publicRef} is not pinned to a digest`);
  }
  return `${target.account}.dkr.ecr.${target.region}.amazonaws.com/${target.prefix}/${rest}`;
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

/** Every release package deployed with `part`: the asset parameters that stack's template declares. */
function packageParameters(release: ReleaseManifest, part: DeployPart, outputs: Partial<Record<DeployPart, StackOutputs>>, env: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pkg of release.packages) {
    if (!pkg.parts.includes(part)) continue;
    params[pkg.bucketParameter] = required(outputs, "access", "ArtifactBucketName", env);
    params[pkg.keyParameter] = pkg.keyParameterValue;
    params[pkg.hashParameter] = pkg.assetId;
  }
  return params;
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
      const oidc =
        answers.identity.mode === "cognito"
          ? { issuer: required(outputs, "identity", "Issuer", answers.env), audience: required(outputs, "identity", "Audience", answers.env) }
          : { issuer: answers.identity.issuer, audience: answers.identity.audience };
      return {
        ...base,
        OidcIssuer: oidc.issuer,
        OidcAudience: oidc.audience,
        CallbackSigningKey: answers.callbackSigningKey,
        GitHubAppAccount: answers.github.account,
        GitHubAppId: answers.github.appId,
        GitHubAppInstallationId: answers.github.installationId,
        GitHubAppPrivateKeySecretArn: answers.github.privateKeySecretArn,
        ...(answers.github.credentialRef === undefined ? {} : { GitHubAppCredentialRef: answers.github.credentialRef }),
      };
    }

    case "runtime": {
      const prefix = required(outputs, "access", "PullThroughPrefix", answers.env);
      return {
        ...base,
        WorkerImageUri: privateImageUri(requiredImage(answers.release, "worker"), { account: answers.account, region: answers.region, prefix }),
        ControlPlaneUrl: required(outputs, "control-plane", "ApiEndpoint", answers.env),
        ModelProvider: "amazon-bedrock",
        ModelId: answers.models.worker,
        CapacityProviderArn: required(outputs, "foundation", "CapacityProviderArn", answers.env),
      };
    }

    case "slack": {
      const prefix = required(outputs, "access", "PullThroughPrefix", answers.env);
      return {
        ...base,
        OrchestratorImageUri: privateImageUri(requiredImage(answers.release, "slack"), { account: answers.account, region: answers.region, prefix }),
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
