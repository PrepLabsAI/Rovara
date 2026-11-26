import { coreEngineParameters, type CoreEngineAnswers } from "./core-engine-answers.js";
// The install/upgrade deploy parameter model as pure functions: no AWS SDK calls, no CDK imports.
// It turns the operator's answers, a release manifest, and the stack outputs collected so far into
// the exact CloudFormation Parameters map for one environment stack. The caller (phase 15d's `agentx
// init`/`agentx upgrade`) reads secrets and calls CloudFormation; this file only computes values.
import { CODE_SETTING_ROWS, CONTROL_PLANE_FOUNDATION_PARAMETERS, EGRESS_ADDRESSES_PARAMETER_PATTERN, PUBLIC_API_URL_PARAMETER, ImageDigest, NAT_EGRESS_ADDRESSES_OUTPUT, KEYED_MODEL_PROVIDERS, KEYED_PROVIDER_IDS, environmentPullThroughPrefix, environmentStackName, operatorParametersFromRows, operatorTrustProblem } from "@agentx/contracts";
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
  /** Required for install; upgrades may keep the installed pair. */
  coreEngine?: CoreEngineAnswers;
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
  // appId absent: only an upgrade's answers may leave it out, and deployEnvironment then fills in the
  // control plane's deployed GitHubAppId (possibly "") before any parameters are computed.
  github: { account?: string; appId?: string; installationId?: string; privateKeySecretArn: string; credentialRef?: string };
  /** The value; the caller reads it from Secrets Manager, never logs it. */
  callbackSigningKey: string;
  permissionsBoundaryArn?: string;
  operatorPrincipalArn?: string;
  /** The sts:ExternalId the operator principal must present: required when that principal belongs to another account (contracts operatorTrustProblem). */
  operatorExternalId?: string;
  /** Testing only, until the first published release exists: a private-ECR image digest used as-is
   * instead of mapping the release's public image through the pull-through cache. */
  images?: { worker?: string; slack?: string; gateway?: string };
  /** Self-hosted Model Gateway options (issue #1554): optional custom TLS cert/host and the control plane's task-purpose JWKS key IDs. */
  gateway?: { certificateArn?: string; host?: string; taskKeyIds?: string };
  /** the control plane's SlackAppPostedMessages (spec 014 FR-012); template default accept */
  slackAppPostedMessages?: "accept" | "ignore";
  /** Spec 025 R7: the stored developer sign-in; deployEnvironment reads it from SSM when absent. */
  developerSignIn?: StoredDeveloperSignIn;
  /** FR-047's budget; absent means none (the template's BudgetMonthlyUsd default, 0). */
  budget?: { monthlyUsd: number; scope: "tag" | "account" };
  /** The install in the cloud: the setup page's address, for the identity stack's sign-in callback
   * and invitation email. Absent everywhere else (the template's default, empty). */
  setupPageUrl?: string;
  /**
   * CODE-PUBLIC-URL (DEC 254zzz505): the install's permanent public address, an https origin (empty: the API's own host). Absent: the deployed value is kept. deployEnvironment fills it in from
   * the address stack's PublicApiOrigin output (public-api-url.ts) and gives it to the foundation (its DNS firewall must allow the host), the control plane and the Slack service.
   * It is a settings row of F1's install layer (install-rows.ts, `install.control-plane.PublicApiUrl`); OPERATOR_PARAMETERS and the broker's packed setting are derived from it.
   */
  publicApiUrl?: string;
  /** CODE-PUBLIC-URL: this install is declared to have an address stack; a deploy that finds none is refused. */
  requirePublicApiAddress?: boolean;
}

/** The shortest callback signing key the control plane accepts. */
const MIN_CALLBACK_SIGNING_KEY_LENGTH = 32;

/** The parameter names whose values must never be printed: every NoEcho template parameter. */
export const SECRET_PARAMETERS: ReadonlySet<string> = new Set(["CallbackSigningKey"]);

/**
 * Stack parameters an operator sets after install (the budget question, agentx config set) that an
 * upgrade's answers do not carry. An upgrade keeps each one's deployed value unless its answers set
 * it, so no upgrade resets them to the template default. Models are not here: they live in the
 * settings, which the upgrade's answers read (the OpenRouter key's ARN is, because the settings may hold none).
 *
 * Derived from Code's install rows (packages/contracts/src/settings/install-rows.ts: a row's `kept` position puts its parameter, and the parameters of the stacks it is copied to,
 * in this list). The rows carry each parameter's template description, not the history of why it is kept (the DEC comments that sat in the old literal are gone); the golden test
 * (tests/contract/settings-install-golden.test.ts) holds this to the list it replaced plus the L1a-1 differences, each stated with its reason there.
 * Since L1a-1 this list is not what stops a reset: every engine carries a parameter an upgrade does not supply (deploy/carry.ts). It is what an upgrade sends EXPLICITLY (from the deployed
 * value, unless the answers or the stored sign-in supply one), reports by config key when a release drops it, and reads for the gateway preflight.
 */
export const OPERATOR_PARAMETERS: Readonly<Record<DeployPart, readonly string[]>> = operatorParametersFromRows(CODE_SETTING_ROWS);

/** Fresh install order: control-plane publishes JWKS before gateway, gateway deploys & seeds prices before control-plane is wired and runtime activates workers. */
export function installOrder(identityMode: "cognito" | "oidc", options: { includeGateway?: boolean } = {}): DeployPart[] {
  const includeGateway = options.includeGateway ?? true;
  const order: DeployPart[] = includeGateway
    ? ["access", "foundation", "identity", "control-plane", "gateway", "runtime", "slack"]
    : ["access", "foundation", "identity", "control-plane", "runtime", "slack"];
  return withoutIdentityWhenOidc(order, identityMode);
}

/** Upgrade order: gateway (when self-hosted) updates alongside the price-serving broker before worker activation. */
export function upgradeOrder(identityMode: "cognito" | "oidc", options: { includeGateway?: boolean } = {}): DeployPart[] {
  const includeGateway = options.includeGateway ?? true;
  const order: DeployPart[] = includeGateway
    ? ["access", "foundation", "identity", "control-plane", "gateway", "runtime", "slack"]
    : ["access", "foundation", "identity", "control-plane", "runtime", "slack"];
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
/** Each named output the part has, as a parameter of the same name; a missing one is left out. */
function optionalOutputs(outputs: Partial<Record<DeployPart, StackOutputs>>, part: DeployPart, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.flatMap((name) => {
    const value = outputs[part]?.[name];
    return typeof value === "string" && value.length > 0 ? [[name, value]] : [];
  }));
}

/** CODE-PUBLIC-URL: the PublicApiUrl parameter (foundation and control plane) when the answers have a value; nothing otherwise (the deployed value is kept, or the template's empty default). */
function publicApiUrlParameter(answers: Pick<InstallAnswers, "publicApiUrl">): Record<string, string> {
  return answers.publicApiUrl === undefined ? {} : { [PUBLIC_API_URL_PARAMETER]: answers.publicApiUrl };
}

/** CODE-PUBLIC-URL: where the Slack service reaches the control plane: the install's public address when it has one, else the API's own endpoint. */
function orchestratorControlPlaneUrl(answers: Pick<InstallAnswers, "publicApiUrl">, endpoint: () => string): string {
  return answers.publicApiUrl === undefined || answers.publicApiUrl === "" ? endpoint() : answers.publicApiUrl;
}

/** The control plane's NatEgressAddresses parameter from the foundation's output of the same name, or nothing. */
function egressAddressesParameter(foundation: StackOutputs | undefined): Record<string, string> {
  const value = foundation?.[NAT_EGRESS_ADDRESSES_OUTPUT];
  return typeof value === "string" && value.length > 0 && new RegExp(EGRESS_ADDRESSES_PARAMETER_PATTERN, "u").test(value) ? { [NAT_EGRESS_ADDRESSES_OUTPUT]: value } : {};
}

function required(outputs: Partial<Record<DeployPart, StackOutputs>>, part: DeployPart, name: string, env: string): string {
  const value = outputs[part]?.[name];
  if (value === undefined) throw new MissingStackOutputError(environmentStackName(env, part), name);
  return value;
}

/** Throws the exact message a release missing an image digest must report. */
function requiredImage(release: ReleaseManifest, which: "worker" | "slack" | "gateway"): string {
  const digest = release.images[which];
  if (digest === undefined) throw new Error(`release ${release.version} has no ${which} image digest`);
  return digest;
}

/** Throws the exact message a non-digest image override must report; otherwise returns it as-is. */
function checkedImageOverride(uri: string, which: "worker" | "slack" | "gateway"): string {
  if (!ImageDigest.safeParse(uri).success) throw new Error(`image override for ${which} must be referenced by digest`);
  return uri;
}

/** L4-IAM: the one sentence every refusal of an off-prefix worker image uses (fixed words, no echo). */
export const WORKER_IMAGE_OFF_PREFIX = "the worker image override must be in this account's ECR, in this region, in a repository under the environment's image prefix (agentx-<env>/): the worker role reads only that prefix";

/**
 * L4-IAM: the worker role reads images only under the environment's ECR pull-through prefix (`agentx-<env>/`) and its test-service copies, so a worker image anywhere else
 * would deploy cleanly and then fail every instance boot ("could not download the worker image"). Returns the fixed refusal, or undefined when the image is inside.
 * `init` and `upgrade` call this when they read `--worker-image` (before anything is deployed); `stackParameters` repeats it as a backstop.
 */
export function workerImageProblem(uri: string, scope: Pick<InstallAnswers, "env" | "account" | "region" | "partition">): string | undefined {
  const suffix = ECR_HOST_SUFFIX[scope.partition ?? "aws"];
  if (suffix === undefined) throw new Error(`unknown AWS partition ${scope.partition}`);
  return uri.startsWith(`${scope.account}.dkr.ecr.${scope.region}.${suffix}/${environmentPullThroughPrefix(scope.env)}/`) ? undefined : WORKER_IMAGE_OFF_PREFIX;
}

function checkedWorkerOverride(uri: string, answers: Pick<InstallAnswers, "env" | "account" | "region" | "partition">): string {
  checkedImageOverride(uri, "worker");
  const problem = workerImageProblem(uri, answers);
  if (problem !== undefined) throw new Error(problem);
  return uri;
}

/**
 * The image URI for `which`: the answers' override when given (validated to be a digest
 * reference, used as-is), otherwise the release's public image mapped through the account's
 * pull-through cache. Only the non-override path needs the access stack's `PullThroughPrefix`
 * output, so an override lets `runtime`/`slack` resolve without it.
 */
function resolvedImage(answers: InstallAnswers, which: "worker" | "slack" | "gateway", outputs: Partial<Record<DeployPart, StackOutputs>>): string {
  const override = answers.images?.[which];
  if (override !== undefined) return which === "worker" ? checkedWorkerOverride(override, answers) : checkedImageOverride(override, which);
  const prefix = required(outputs, "access", "PullThroughPrefix", answers.env);
  return privateImageUri(requiredImage(answers.release, which), imageTarget(answers, prefix));
}

/**
 * The browser executor image the worker pulls at boot, from the release through the image cache like the worker's own. A release that
 * carries none (every release before the web/API runtime) supplies no value: the runtime stack's `ExecutorImageUri` defaults to "none",
 * and workers then boot without `EXECUTOR_IMAGE`.
 */
function executorImageParameter(answers: InstallAnswers, outputs: Partial<Record<DeployPart, StackOutputs>>): { ExecutorImageUri?: string } {
  const executor = answers.release.images.executor;
  if (executor === undefined) return {};
  return { ExecutorImageUri: privateImageUri(executor, imageTarget(answers, required(outputs, "access", "PullThroughPrefix", answers.env))) };
}

/** The Slack execution role is granted pull access only to the same-account, same-region ECR repo selected for this image. */
function ecrRepositoryName(uri: string, answers: Pick<InstallAnswers, "account" | "region" | "partition">): string {
  const suffix = ECR_HOST_SUFFIX[answers.partition ?? "aws"];
  if (suffix === undefined) throw new Error(`unknown AWS partition ${answers.partition}`);
  const host = `${answers.account}.dkr.ecr.${answers.region}.${suffix}/`;
  if (!uri.startsWith(host)) throw new Error("the Slack image must be in a private ECR repository in this AWS account and region");
  const repository = uri.slice(host.length).split("@", 1)[0] ?? "";
  // Export bundles render values they cannot know until the access stack is deployed as markers.
  // Preserve this one known marker prefix while still validating every image-derived path segment.
  const markerPrefix = "{{output:access.PullThroughPrefix}}/";
  const repositoryPath = repository.startsWith(markerPrefix) ? repository.slice(markerPrefix.length) : repository;
  if (!repositoryPath || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(repositoryPath)) {
    throw new Error("the Slack image has an invalid ECR repository name");
  }
  return repository;
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

function validateControlPlaneAnswers(answers: InstallAnswers): asserts answers is InstallAnswers & { github: InstallAnswers["github"] & { appId: string } } {
  if (answers.callbackSigningKey.length < MIN_CALLBACK_SIGNING_KEY_LENGTH) {
    // Never include the value: it is a secret.
    throw new Error(`the callback signing key must be at least ${MIN_CALLBACK_SIGNING_KEY_LENGTH} characters`);
  }
  if (answers.github.appId === undefined) {
    throw new Error("the answers name no GitHub App id (github.appId); an install needs one, and an upgrade keeps the deployed one");
  }
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
      // Backstop for every caller (init, upgrade, export, resume): a whole-account or cross-account principal without its external id never reaches the template.
      {
        const problem = operatorTrustProblem({ principal: answers.operatorPrincipalArn, externalId: answers.operatorExternalId, account: answers.account });
        if (problem !== undefined) throw new Error(problem);
      }
      return { ...base, OperatorPrincipalArn: answers.operatorPrincipalArn ?? "",
        // Always sent (F1 L1a-1 review R2): left out, the one carry rule would keep a deployed external id after the principal is cleared, which the stack's own rule refuses.
        OperatorExternalId: answers.operatorExternalId ?? "" };

    case "foundation":
      return { ...base, ...publicApiUrlParameter(answers) };

    case "identity":
      // Always sent (F1 L1a-1 review B1): empty on every install but a cloud one, and after an upgrade. Left out, the one carry rule would keep the installer's address for good (a dead
      // callback and logout URL on the CLI client, and "finish at <dead URL>" in every invitation).
      return { ...base, SetupPageUrl: answers.setupPageUrl ?? "" };

    case "control-plane": {
      validateControlPlaneAnswers(answers);
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
        ...(answers.coreEngine === undefined ? {} : coreEngineParameters(answers.coreEngine, { allowDeferredGateway: true })),
        ...(outputs.gateway?.GatewayHost !== undefined && (answers.coreEngine?.modelGatewayUrl.trim() ?? "") === "" ? { CoreModelGatewayHost: outputs.gateway.GatewayHost } : {}),
        GitHubAppId: answers.github.appId,
        GitHubAppPrivateKeySecretArn: answers.github.privateKeySecretArn,
        ...(answers.github.credentialRef === undefined ? {} : { GitHubAppCredentialRef: answers.github.credentialRef }),
        // The EC2 session lifecycle (#83) runs in the foundation's network with its key and role.
        ...Object.fromEntries(CONTROL_PLANE_FOUNDATION_PARAMETERS.map((name) => [name, required(outputs, "foundation", name, answers.env)])),
        // L4-EGR: Rovara's outbound addresses, once the foundation outputs them (named environments only: the legacy foundation never does, and CloudFormation refuses a parameter its template
        // does not declare). A value that is not a short comma-separated list of addresses is not passed (the template's AllowedPattern would stop the deploy); the parameter keeps its default, empty.
        ...egressAddressesParameter(outputs.foundation),
        ...(answers.slackAppPostedMessages === undefined ? {} : { SlackAppPostedMessages: answers.slackAppPostedMessages }),
        ...(answers.budget === undefined ? {} : { BudgetMonthlyUsd: String(answers.budget.monthlyUsd), BudgetScope: answers.budget.scope }),
        // F24: only when a stored sign-in choice is actually given; the template's own defaults
        // (sign-in off) are otherwise left untouched, and only the seven keys the control-plane
        // template declares (infra/lib/developer-signin.ts) are ever added here.
        ...(answers.developerSignIn === undefined ? {} : signInStackParameters(answers.developerSignIn)),
        ...publicApiUrlParameter(answers),
      };
    }

    case "gateway": {
      const gatewayImage = resolvedImage(answers, "gateway", outputs);
      const workerProvider = answers.models.providers?.worker ?? "amazon-bedrock";
      const standaloneProvider = workerProvider === "amazon-bedrock" ? "bedrock" : workerProvider;
      const capMicros = answers.budget !== undefined && answers.budget.monthlyUsd > 0
        ? String(answers.budget.monthlyUsd * 1_000_000)
        : "100000000";
      const taskKeyIds = answers.gateway?.taskKeyIds;
      if (taskKeyIds === undefined || taskKeyIds.trim() === "") {
        throw new Error(`self-hosted gateway requires the control plane's task-token JWKS key IDs (gateway.taskKeyIds)`);
      }
      return {
        ...base,
        GatewayImageUri: gatewayImage,
        GatewayImageRepositoryName: ecrRepositoryName(gatewayImage, answers),
        VpcId: required(outputs, "foundation", "VpcId", answers.env),
        PrivateSubnetIds: required(outputs, "foundation", "PrivateSubnetIds", answers.env),
        CodeUrl: orchestratorControlPlaneUrl(answers, () => required(outputs, "control-plane", "ApiEndpoint", answers.env)),
        CodeTaskKeyIds: taskKeyIds,
        OperatorAlertsTopicArn: required(outputs, "control-plane", "OperatorAlertsTopicArn", answers.env),
        DefaultCompanyCapMicros: capMicros,
        StandaloneProvider: standaloneProvider,
        ...(answers.gateway?.certificateArn === undefined ? {} : { CertificateArn: answers.gateway.certificateArn }),
        ...(answers.gateway?.host === undefined ? {} : { GatewayHost: answers.gateway.host }),
        ...secret,
      };
    }

    case "runtime": {
      return {
        ...base,
        WorkerImageUri: resolvedImage(answers, "worker", outputs),
        ...executorImageParameter(answers, outputs),
        ModelProvider: answers.models.providers?.worker ?? "amazon-bedrock",
        ModelId: answers.models.worker,
        ...secret, ...routing,
      };
    }

    case "slack": {
      const slackImage = resolvedImage(answers, "slack", outputs);
      return {
        ...base,
        OrchestratorImageUri: slackImage,
        OrchestratorImageRepositoryName: ecrRepositoryName(slackImage, answers),
        TaskRoleArn: required(outputs, "control-plane", "SlackOrchestratorTaskRoleArn", answers.env),
        // CODE-PUBLIC-URL: the orchestrator reaches the control plane at the install's public address where it has one (its host is on the firewall's list), else the API's own host.
        ControlPlaneUrl: orchestratorControlPlaneUrl(answers, () => required(outputs, "control-plane", "ApiEndpoint", answers.env)),
        SlackRequestQueueUrl: required(outputs, "control-plane", "SlackRequestQueueUrl", answers.env),
        // Spec 062: present once the control plane has the channel API.
        ...optionalOutputs(outputs, "control-plane", ["ChannelRequestQueueUrl", "ChannelEventQueueUrl", "SlackAdapterCommandsUrl", "SlackAdapterSecretName"]),
        // L2-2 PR 18d: Slack company mode's inputs (the control plane always outputs them, DEC 254zk). The switch itself (SlackCompanyWorkspacesState) is the operator's, set with
        // agentx config set slack.companyWorkspaces and kept across upgrades (OPERATOR_PARAMETERS), so an upgrade never turns it off behind the control plane's back.
        SlackCompanyStateTableName: "", SlackCompanyTeamId: "",
        ...optionalOutputs(outputs, "control-plane", ["SlackCompanyStateTableName", "SlackCompanyTeamId"]),
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
        // Always sent (F1 L1a-1 review R1): the answers drop `providers` when every role uses Bedrock, and the one carry rule would then keep an old provider beside a Bedrock model id.
        GateClassifierProvider: answers.models.providers?.classifier ?? "amazon-bedrock",
        GateClassifierModelId: answers.models.classifier,
      };
    }
  }
}
