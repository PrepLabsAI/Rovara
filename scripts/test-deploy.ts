// One-command, plan-first deploy of a build to an allowlisted TEST installation.
//
//   npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test [--apply]
//     [--only control-plane-code,broker,dispatcher,worker-image,executor-image,qualification-transport]
//   npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --only model-fallback-settings [--apply]
//   npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --only e2e-agent-settings [--apply]
//   npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --only e2e-agent-model --e2e-model <model id or default> [--apply]
//   npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --check
//
// `--check [--json]` is read-only and exits 0 only when every check passes (1: findings, 2: the check could not run). It looks for
// control-plane Lambdas not on head's code (by provenance: the deployed S3Key names the commit, and git says whether anything the
// bundle comes from changed since), IAM grants and environment variables head needs that the deployed stack lacks, READY catalog rows
// about to expire, a qualified runner and worker that match this build (including the agent-steps feature), and the e2e model route
// for the installation's provider, read from its `worker-model-provider` SSM setting (approval; for Bedrock, model access and agreement
// through read-only control-plane calls and the worker role's invoke grants; for Anthropic, OpenAI or OpenRouter, the secret ARN setting
// and the worker role's grant on it). No model is invoked and no secret is read. `--apply` of Lambda code runs the IAM and environment parts
// first and refuses on a gap (stale code is expected before a deploy); it never applies IAM or stack changes itself.
// Without --apply it prints the plan and exits 0 (it only reads: DescribeStacks for the current
// parameters). With --apply it runs the plan. The plan reproduces the P0 TEST procedure: every
// CloudFormation step is a change set that changes only the named Lambda code, image parameter or
// added resource, and sets every other parameter to UsePreviousValue. A change set whose changes
// are not exactly the expected ones is deleted, never executed. Credentials come from
// `aws login --profile <profile>` only.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStackResourceCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  type Change,
  type DescribeChangeSetCommandOutput,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { GetFunctionConfigurationCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { build as bundle } from "esbuild";
import { LAMBDA_BUNDLE_OPTIONS, checkLambdaBundles, lambdaLoadError } from "./lambda-load-check.js";
import { CDK_CONSTRUCT_IDS, cdkAppArguments } from "../packages/cli/src/deploy/cdk-engine.js";
import { environmentSettingsPrefix, environmentStackName } from "../packages/contracts/src/environments.js";
import { E2E_AGENT_RECOMMENDED_MODELS, eligibleE2EAgentModel } from "../packages/contracts/src/e2e-agent-models.js";
import { KEYED_MODEL_PROVIDERS, MODEL_PROVIDERS, isKeyedModelProvider, type ModelProvider } from "../packages/contracts/src/model-providers.js";
import { deriveE2EAgentRoute, e2eAgentRouteDefinitionDigest } from "../packages/model-runtime/src/e2e-route-derive.js";
import { WORKER_SETTING_PARAMETERS } from "../packages/contracts/src/session.js";
import { WEB_API_RUNTIME_PROFILE_ID } from "../packages/contracts/src/e2e-web-api-qualification.js";
import { e2eRuntimeRenewCommand } from "../packages/contracts/src/e2e-runtime-expiry.js";
import {
  Runner,
  assertDigestImage,
  buildAndPushImage,
  describeStack,
  profileArgs,
  smokeTestExecutor,
  smokeTestWorker,
  stackExists,
  stackOutput,
  stackParameter,
  verifyRepositoryImage,
  type ReleaseOptions,
} from "./release-common.js";
import { deterministicZip } from "./release/zip.js";
import {
  E2E_MODEL_ROUTE_ID,
  deriveE2EModelRoute,
  e2eModelChoice,
  evaluateEnvironmentDrift,
  evaluateIamDrift,
  evaluateTestDeployCheck,
  formatFindings,
  iamEvaluationNotes,
  lambdaRoleIds,
  matchBedrockQuotas,
  parseDeployedCodeKey,
  parseRunnerStatus,
  sourcePathsFor,
  tier3Request,
  type CheckResult,
  type CatalogRowFact,
  type E2EModelRoute,
  type Finding,
  type ModelAccessFacts,
  type ModelAvailabilityFact,
  type ModelChoiceFacts,
  type ModelRouteCheck,
  type QuotaFacts,
  type RunnerFacts,
  type SettingFact,
} from "./test-deploy-check.js";

/**
 * `control-plane-code` rebuilds every packaged control-plane Lambda (CONTROL_PLANE_LAMBDAS) in one change set; `broker` and
 * `dispatcher` rebuild just those two, and are contained in `control-plane-code`.
 */
export type DeployUnit = "control-plane-code" | "broker" | "dispatcher" | "worker-image" | "executor-image" | "qualification-transport" | "e2e-agent-settings" | "e2e-agent-model" | "model-fallback-settings";
export const DEPLOY_UNITS: readonly DeployUnit[] = ["control-plane-code", "broker", "dispatcher", "worker-image", "executor-image", "qualification-transport", "e2e-agent-settings", "e2e-agent-model", "model-fallback-settings"];
/** What a normal TEST deploy changes: all control-plane code, so no function is left on old code, and the worker image. */
export const DEFAULT_DEPLOY_UNITS: readonly DeployUnit[] = ["control-plane-code", "worker-image"];
const DEFAULT_REGION = "us-east-1";
const ALLOWLIST_ERROR = "test-deploy only targets allowlisted TEST installations";

export type StackKind = "control-plane" | "runtime";
/** The parameter values each stack has today. NoEcho values come back masked; only the keys matter for them. */
export type StackParameters = Record<StackKind, Readonly<Record<string, string>>>;
/** What exists before planning: the revision being deployed and where the build step writes its zips. */
export interface BuiltArtifacts {
  revision: string;
  outputDir: string;
}

export type StepOutputName = "sha256Hex" | "sha256Base64" | "s3Key" | "s3ObjectVersion" | "imageUri";
/** A value an earlier step produces: the plan is made before anything is built or pushed. */
export interface StepRef {
  fromStep: string;
  output: StepOutputName;
}
/** A parameter of a change set: its previous value, the output of an earlier step, or a literal the plan itself carries (the chosen AI navigation model). */
export type ParameterSpec = { key: string; usePreviousValue: true } | { key: string; value: StepRef } | { key: string; literal: string };

export interface ChangeExpectation {
  action: "Add" | "Modify";
  logicalIds?: readonly string[];
  logicalIdPrefixes?: readonly string[];
  /** Modify only: the only attributes (as `Properties.<Name>`) the change may touch. */
  allowedAttributes?: readonly string[];
  /** Modify only: attributes by logical ID, for a change set whose resources are not changed in the same way (the broker's Environment, a policy's PolicyDocument). Falls back to `allowedAttributes`. */
  allowedAttributesByLogicalId?: Readonly<Record<string, readonly string[]>>;
  /**
   * Modify only, for Lambda code units (`logicalIds`): also accept a Modify of any other resource when every one of its
   * Details is a Dynamic ResourceAttribute re-evaluation caused by `<code unit>.Arn`. A code-only update cannot change a
   * function's Arn, so these are CloudFormation's conservative no-ops; anything else is still refused.
   */
  allowArnReevaluations?: boolean;
  /** With allowArnReevaluations: the only resources among `logicalIds` whose Arn may cause a re-evaluation (default: all of them). A role policy has no Arn to re-evaluate. */
  arnSources?: readonly string[];
}
export interface ObservedDetail {
  evaluation?: string;
  changeSource?: string;
  causingEntity?: string;
}
export interface ObservedChange {
  action: string;
  logicalId: string;
  type?: string;
  replacement?: string;
  attributes?: readonly string[];
  /** One entry per change-set Detail, in the same order as `attributes`. */
  details?: readonly ObservedDetail[];
}

export type IdentityMode = "cognito" | "oidc";
/** What a synth of head is taken from: the CDK construct, its context and the identity mode the deploy engine passes. */
export interface LiftSynthPlan {
  construct: string;
  cdkContext: Readonly<Record<string, string>>;
  /** The synth runs with the app and context the deploy engine passes, which depend on this. */
  identityMode: IdentityMode;
}

export type TemplatePlan =
  | { source: "previous" }
  | { source: "lambda-code"; patches: ReadonlyArray<{ logicalId: string; zip: string }> }
  | {
      source: "lift-resources";
      logicalIdPrefix: string;
      /** Synthesized parameters to add to the deployed template with the lifted resources. */
      parameterNames?: readonly string[];
      construct: string;
      cdkContext: Readonly<Record<string, string>>;
      /** The synth runs with the app and context the deploy engine passes, which depend on this. */
      identityMode: IdentityMode;
    }
  | ({
      /**
       * The deployed template with exactly the declared additions taken from a synth of head: environment variables of a Lambda, and an SSM parameter's ARN in the
       * `ssm:GetParameters` statement of a role policy. Anything else that differs between head and the deployed template refuses (`liftDeclaredSettings`).
       */
      source: "lift-declared";
      environment: ReadonlyArray<{ logicalId: string; variable: string }>;
      grants: ReadonlyArray<{ logicalId: string; parameterName: string }>;
    } & LiftSynthPlan);

export type DeployStep =
  | { id: string; kind: "build-lambda-zip"; unit: LambdaUnit; logicalId: string; entry: string; zipPath: string; extraFiles?: ReadonlyArray<ExtraFile> }
  | { id: string; kind: "upload-artifact"; bucketFromStack: "access"; logicalId: string; from: string; keyPrefix: string }
  | { id: string; kind: "ecr-push"; image: "worker" | "executor"; repositoryUri: string; revision: string }
  | {
      id: string;
      kind: "create-change-set";
      stack: string;
      stackKind: StackKind;
      changeSetPrefix: string;
      template: TemplatePlan;
      parameters: readonly ParameterSpec[];
      expect: ChangeExpectation;
    }
  | { id: string; kind: "execute-change-set"; stack: string; createdBy: string }
  | { id: string; kind: "verify-lambda-code"; stack: string; logicalId: string; expectedSha256Base64: StepRef }
  | { id: string; kind: "verify-stack-resources"; stack: string; createdBy: string; logicalIdPrefix: string; expectedStatus: string }
  | { id: string; kind: "verify-stack-parameter"; stack: string; key: string; expected: StepRef | { literal: string } }
  | { id: string; kind: "verify-lambda-environment"; stack: string; logicalId: string; key: string; expected: { literal: string } };

/** A file the release bundle holds beside the handler (`packagedFunction`'s extraFiles): repo-relative source, name in the zip. */
export interface ExtraFile {
  from: string;
  name: string;
}
interface LambdaSpec {
  logicalId: string;
  entry: string;
  extraFiles?: ReadonlyArray<ExtraFile>;
}
/**
 * Every control-plane stack Lambda built with `packagedFunction` (infra/lib), by its logical ID in the deployed template. They all
 * bundle broker and contracts code, so a TEST deploy that leaves one behind leaves it parsing documents with old contracts. The
 * installer's setup page is in another stack and is not here; a unit test keeps this list equal to the infra's entries.
 */
export const CONTROL_PLANE_LAMBDAS = {
  broker: { logicalId: "BrokerE1355FD6", entry: "packages/broker/src/aws/broker.ts" },
  dispatcher: { logicalId: "DispatcherD4A12972", entry: "packages/broker/src/aws/dispatcher.ts" },
  "plan-evidence": { logicalId: "PlanEvidence3615C4CB", entry: "packages/broker/src/aws/plan-evidence-handler.ts" },
  "outbox-publisher": { logicalId: "OutboxPublisherD572F72E", entry: "packages/broker/src/aws/outbox-publisher.ts" },
  "slack-ingress": { logicalId: "SlackIngress5C88FFA0", entry: "packages/broker/src/aws/slack-ingress.ts" },
  "eval-batch-tick": { logicalId: "EvalBatchTickA4585B04", entry: "packages/broker/src/aws/eval-batch-tick.ts" },
  "developer-sign-in": { logicalId: "DeveloperSignInFunction10B62B05", entry: "packages/broker/src/aws/developer-identity.ts" },
  "developer-task-notifier": { logicalId: "DeveloperTaskNotifierFunction551419CC", entry: "packages/broker/src/aws/developer-task-notifier.ts" },
  "sessions-steps": {
    logicalId: "SessionsSteps3B98DD2B", entry: "packages/broker/src/aws/session-steps.ts",
    extraFiles: [{ from: "packages/worker/ec2/boot.sh", name: "boot.sh" }],
  },
  "sessions-reaper": { logicalId: "SessionsReaper8FEF958E", entry: "packages/broker/src/aws/session-reaper.ts" },
  "sessions-reconciler": { logicalId: "SessionsReconciler4316A0A2", entry: "packages/broker/src/aws/session-reconciler.ts" },
} as const satisfies Record<string, LambdaSpec>;
/**
 * Repo-built control-plane Lambdas that test-deploy does not move, with why. The proof function is invoked through a published
 * Lambda version (its ARN is the Dispatcher's TASK_PERSON_PROOF_FUNCTION_ARN), and a version is immutable: new code in the function
 * changes nothing that runs, and a new version is a template change this script does not make. A contract test requires every
 * repo-built Lambda of the synthesized control-plane template to be in exactly one of this and CONTROL_PLANE_LAMBDAS.
 */
export const CONTROL_PLANE_LAMBDAS_NOT_DEPLOYED: Readonly<Record<string, string>> = {
  TaskPersonProofFunction817A5A36: "invoked through a published Lambda version, which a code-only change set cannot move; it needs a CDK deploy",
};
export type LambdaUnit = keyof typeof CONTROL_PLANE_LAMBDAS;
const LAMBDAS: Readonly<Record<LambdaUnit, LambdaSpec>> = CONTROL_PLANE_LAMBDAS;
const LAMBDA_UNITS = Object.keys(CONTROL_PLANE_LAMBDAS) as LambdaUnit[];
/** The Lambda units a deploy of `units` moves: `control-plane-code` is all of them. */
export function lambdaUnitsFor(units: readonly DeployUnit[]): LambdaUnit[] {
  const allCode = units.includes("control-plane-code");
  return LAMBDA_UNITS.filter((unit) => allCode || units.some((chosen) => chosen === unit));
}
function buildStepFor(unit: LambdaUnit, zipPath: string): Extract<DeployStep, { kind: "build-lambda-zip" }> {
  const { logicalId, entry, extraFiles } = LAMBDAS[unit];
  return { id: `build-${unit}`, kind: "build-lambda-zip", unit, logicalId, entry, zipPath, ...(extraFiles === undefined ? {} : { extraFiles }) };
}
const QUALIFICATION = { logicalIdPrefix: "E2eQualificationTransport", construct: CDK_CONSTRUCT_IDS["control-plane"], context: { "agentx:e2eQualificationTransport": "enabled" } } as const;
const WORKER_IMAGE_PARAMETER = "WorkerImageUri";
const EXECUTOR_IMAGE_PARAMETER = "ExecutorImageUri";
const EXECUTOR_SETTING = { logicalIdPrefix: "WorkerExecutorImageParameter", construct: CDK_CONSTRUCT_IDS.runtime } as const;
/** The AI navigation model setting (Task 4.10): a runtime stack parameter and the SSM parameter it fills. */
const E2E_AGENT_MODEL_PARAMETER = "E2eAgentModelId";
const E2E_AGENT_MODEL_SETTING = { logicalIdPrefix: "WorkerE2eAgentModelParameter", construct: CDK_CONSTRUCT_IDS.runtime } as const;
/** The model fallback setting (Task 4.10D, MODEL3): a runtime stack parameter (default `none`) and the SSM parameter it fills. */
const MODEL_FALLBACK_PARAMETER = "ModelFallback";
const MODEL_FALLBACK_SETTING = { logicalIdPrefix: "WorkerModelFallbackParameter", construct: CDK_CONSTRUCT_IDS.runtime } as const;
/**
 * What the `e2e-agent-settings` unit changes in the deployed control-plane stack, and nothing else: the broker's `AGENTX_E2E_AGENT_SETTINGS_PREFIX` variable (PREFIXGAP) and the ARNs of the
 * `worker-e2e-agent-model` (4.10A) and `worker-model-fallback` (4.10D) parameters in the `ssm:GetParameters` statement of the two role policies that read every worker setting (the broker's
 * and the session steps'; the eval batch tick reads neither, 4.10A review M-2 and 4.10D, so TEST's deployed policy of it already is head's). All are declared IAM and environment changes of
 * the head templates. A setting's ARN may be granted before its SSM parameter exists (`model-fallback-settings` adds that one on the runtime stack).
 */
export const E2E_AGENT_SETTINGS_UNIT = {
  broker: CONTROL_PLANE_LAMBDAS.broker.logicalId,
  variable: "AGENTX_E2E_AGENT_SETTINGS_PREFIX",
  policies: ["BrokerServiceRoleDefaultPolicyDDFD9E7E", "SessionsStepsServiceRoleDefaultPolicy9F4B87C9"],
  settings: ["e2eAgentModel", "modelFallback"],
} as const satisfies { broker: string; variable: string; policies: readonly string[]; settings: ReadonlyArray<keyof typeof WORKER_SETTING_PARAMETERS> };

/**
 * The executor image's repository: the worker's, with its own name changed (`.../worker` to `.../executor`, `.../agentx-worker` to
 * `.../agentx-executor`). Only the repository's last path segment is renamed, so the worker's registry and path stay what they are.
 */
export function executorRepositoryUri(workerRepositoryUri: string): string {
  const slash = workerRepositoryUri.lastIndexOf("/");
  const name = workerRepositoryUri.slice(slash + 1);
  if (slash < 0 || !name.includes("worker")) {
    throw new Error(`cannot derive the executor repository from ${workerRepositoryUri}: its name has no "worker" to replace; create the executor repository beside it and push the image by hand`);
  }
  return `${workerRepositoryUri.slice(0, slash + 1)}${name.slice(0, name.lastIndexOf("worker"))}executor${name.slice(name.lastIndexOf("worker") + "worker".length)}`;
}

export function loadAllowlist(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(new URL("./test-deploy.allowlist.json", import.meta.url), "utf8"));
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) throw new Error("test-deploy.allowlist.json must be an array of environment names");
  return parsed;
}

/** The stacks this deploy may touch, named the way the CLI names a named environment's stacks. */
export function resolveTestStacks(env: string): Record<StackKind, string> {
  return { "control-plane": environmentStackName(env, "control-plane"), runtime: environmentStackName(env, "runtime") };
}

/** The access stack owns the versioned artifact bucket the deployed Lambda code and the change-set templates live in. */
export function resolveAccessStack(env: string): string {
  return environmentStackName(env, "access");
}

/** The only AWS reads the bucket guards make; `Runner` satisfies it and the tests pass a fake. */
export type AwsReader = Pick<Runner, "aws">;

/**
 * The bucket code zips and change-set templates are uploaded to: the access stack's `ArtifactBucketName`. Refuses unless S3
 * reports its versioning `Enabled`, because Lambda code and change sets are pinned to object versions.
 */
export function resolveArtifactBucket(runner: AwsReader, region: string, env: string): string {
  const stack = resolveAccessStack(env);
  const bucket = stackOutput(describeStack(runner, region, stack), "ArtifactBucketName");
  const versioning = JSON.parse(runner.aws(["s3api", "get-bucket-versioning", "--bucket", bucket, "--region", region, "--output", "json"]).stdout) as { Status?: string };
  if (versioning.Status !== "Enabled") {
    throw new Error(`s3://${bucket} (ArtifactBucketName of ${stack}) has versioning ${versioning.Status ?? "never enabled"}, not Enabled; refusing to upload anything to it`);
  }
  return bucket;
}

/** The template a stack was last deployed from, as CloudFormation holds it (`Original`: before the transforms). */
export function deployedTemplateOf(runner: AwsReader, region: string, stack: string): CfnTemplate {
  const body = runner.aws(["cloudformation", "get-template", "--stack-name", stack, "--template-stage", "Original", "--query", "TemplateBody", "--region", region, "--output", "json"]).stdout;
  return JSON.parse(body) as CfnTemplate;
}

/**
 * As `resolveArtifactBucket`, and the control-plane stack's deployed `logicalId` Lambda must already read its code from that bucket.
 * A function the release pipeline deployed names its bucket through a stack parameter (`{ Ref }`); that parameter's current value
 * is the bucket. One an earlier TEST deploy replaced names it literally.
 */
export function resolveCodeArtifactBucket(runner: AwsReader, region: string, env: string, logicalId: string): string {
  const bucket = resolveArtifactBucket(runner, region, env);
  const stack = resolveTestStacks(env)["control-plane"];
  const template = deployedTemplateOf(runner, region, stack);
  const declared = (template.Resources?.[logicalId]?.Properties?.Code as { S3Bucket?: unknown } | undefined)?.S3Bucket;
  let deployed: string | undefined;
  if (typeof declared === "string") deployed = declared;
  else if (declared !== null && typeof declared === "object" && Object.keys(declared).length === 1 && typeof (declared as { Ref?: unknown }).Ref === "string") {
    const parameter = (declared as { Ref: string }).Ref;
    deployed = describeStack(runner, region, stack).Parameters?.find((candidate) => candidate.ParameterKey === parameter)?.ParameterValue;
  }
  if (typeof deployed !== "string") throw new Error(`the deployed ${logicalId} in ${stack} has no literal Code S3Bucket, or one given by a parameter, to compare with ${bucket}; stop for review`);
  if (deployed !== bucket) {
    throw new Error(`the deployed ${logicalId} reads its code from s3://${deployed}, but the access stack's ArtifactBucketName is s3://${bucket}; refusing to upload code to a bucket the function does not use`);
  }
  return bucket;
}

export function planTestDeploy(
  input: { env: string; only: DeployUnit[]; artifacts: BuiltArtifacts; previous: StackParameters; identityMode?: IdentityMode; e2eModel?: string; region?: string },
  allowlist: readonly string[] = loadAllowlist(),
): DeployStep[] {
  if (!allowlist.includes(input.env)) throw new Error(ALLOWLIST_ERROR);
  const units = DEPLOY_UNITS.filter((unit) => input.only.includes(unit));
  if (units.length === 0) throw new Error("nothing to deploy: --only names no deploy unit");
  const identityMode = input.identityMode ?? "cognito";
  if (units.includes("qualification-transport") && units.some((unit) => unit === "broker" || unit === "dispatcher" || unit === "control-plane-code")) {
    throw new Error("qualification-transport changes the control-plane template; run it on its own, apart from control-plane-code, broker and dispatcher");
  }
  // These two change a stack's template or settings by themselves: each runs on its own, so the exact-change guard of one never has to judge another's changes.
  for (const unit of ["e2e-agent-settings", "e2e-agent-model", "model-fallback-settings"] as const) {
    if (units.includes(unit) && units.length > 1) throw new Error(`${unit} changes a stack template or setting; run it on its own, apart from the other units`);
  }
  if (input.e2eModel !== undefined && !units.includes("e2e-agent-model")) throw new Error("--e2e-model goes only with the e2e-agent-model unit");
  const { revision } = input.artifacts;
  if (!/^[a-f0-9]{7,40}$/.test(revision)) throw new Error("the revision must be a hexadecimal git commit");
  const stacks = resolveTestStacks(input.env);
  const usePrevious = (kind: StackKind): ParameterSpec[] =>
    Object.keys(input.previous[kind]).sort().map((key) => ({ key, usePreviousValue: true }));
  const steps: DeployStep[] = [];

  // The image setting goes first, as the release pipeline does: the Broker change comes after it.
  if (units.includes("worker-image")) {
    const current = input.previous.runtime[WORKER_IMAGE_PARAMETER];
    if (current === undefined) throw new Error(`the runtime stack has no ${WORKER_IMAGE_PARAMETER} parameter to take the ECR repository from`);
    assertDigestImage(current);
    const repositoryUri = current.slice(0, current.indexOf("@"));
    steps.push({ id: "push-worker-image", kind: "ecr-push", image: "worker", repositoryUri, revision });
    const image: StepRef = { fromStep: "push-worker-image", output: "imageUri" };
    steps.push(
      {
        id: "change-set-runtime",
        kind: "create-change-set",
        stack: stacks.runtime,
        stackKind: "runtime",
        changeSetPrefix: `test-deploy-runtime-${revision.slice(0, 12)}`,
        template: { source: "previous" },
        parameters: usePrevious("runtime").map((parameter) => (parameter.key === WORKER_IMAGE_PARAMETER ? { key: parameter.key, value: image } : parameter)),
        expect: { action: "Modify", logicalIdPrefixes: ["WorkerImageParameter"], allowedAttributes: ["Properties.Value"] },
      },
      { id: "execute-runtime", kind: "execute-change-set", stack: stacks.runtime, createdBy: "change-set-runtime" },
      { id: "verify-runtime-image", kind: "verify-stack-parameter", stack: stacks.runtime, key: WORKER_IMAGE_PARAMETER, expected: image },
    );
  }

  if (units.includes("executor-image")) {
    const current = input.previous.runtime[WORKER_IMAGE_PARAMETER];
    if (current === undefined) throw new Error(`the runtime stack has no ${WORKER_IMAGE_PARAMETER} parameter to take the ECR repository from`);
    assertDigestImage(current);
    const repositoryUri = executorRepositoryUri(current.slice(0, current.indexOf("@")));
    steps.push({ id: "push-executor-image", kind: "ecr-push", image: "executor", repositoryUri, revision });
    const image: StepRef = { fromStep: "push-executor-image", output: "imageUri" };
    // A runtime stack deployed before the web/API runtime has neither the parameter nor its SSM setting: the first change set adds
    // both, lifted from a synth of the runtime stack, and changes nothing else. Afterwards it changes only the parameter's value.
    const exists = input.previous.runtime[EXECUTOR_IMAGE_PARAMETER] !== undefined;
    const previousKeys = Object.keys(input.previous.runtime).filter((key) => key !== EXECUTOR_IMAGE_PARAMETER);
    steps.push(
      {
        id: "change-set-executor",
        kind: "create-change-set",
        stack: stacks.runtime,
        stackKind: "runtime",
        changeSetPrefix: `test-deploy-executor-${revision.slice(0, 12)}`,
        template: exists
          ? { source: "previous" }
          : { source: "lift-resources", logicalIdPrefix: EXECUTOR_SETTING.logicalIdPrefix, parameterNames: [EXECUTOR_IMAGE_PARAMETER], construct: EXECUTOR_SETTING.construct, cdkContext: {}, identityMode },
        parameters: [
          { key: EXECUTOR_IMAGE_PARAMETER, value: image },
          ...previousKeys.sort().map((key): ParameterSpec => ({ key, usePreviousValue: true })),
        ],
        expect: exists
          ? { action: "Modify", logicalIdPrefixes: [EXECUTOR_SETTING.logicalIdPrefix], allowedAttributes: ["Properties.Value"] }
          : { action: "Add", logicalIdPrefixes: [EXECUTOR_SETTING.logicalIdPrefix] },
      },
      { id: "execute-executor", kind: "execute-change-set", stack: stacks.runtime, createdBy: "change-set-executor" },
      { id: "verify-executor-image", kind: "verify-stack-parameter", stack: stacks.runtime, key: EXECUTOR_IMAGE_PARAMETER, expected: image },
    );
  }

  if (units.includes("model-fallback-settings")) {
    // A runtime stack deployed before 4.10D has neither the parameter nor its SSM setting: the change set adds both, lifted from a synth of the runtime stack, and changes nothing else. The
    // value stays none (no fallback, the worker fails by name when a keyed provider's secret is missing); `agentx config set models.fallback` is how an owner chooses one afterwards.
    if (input.previous.runtime[MODEL_FALLBACK_PARAMETER] !== undefined) {
      throw new Error(`the runtime stack already has ${MODEL_FALLBACK_PARAMETER}; model-fallback-settings only adds it. Change its value with agentx config set models.fallback`);
    }
    const previousKeys = Object.keys(input.previous.runtime);
    steps.push(
      {
        id: "change-set-model-fallback",
        kind: "create-change-set",
        stack: stacks.runtime,
        stackKind: "runtime",
        changeSetPrefix: `test-deploy-model-fallback-${revision.slice(0, 12)}`,
        template: { source: "lift-resources", logicalIdPrefix: MODEL_FALLBACK_SETTING.logicalIdPrefix, parameterNames: [MODEL_FALLBACK_PARAMETER], construct: MODEL_FALLBACK_SETTING.construct, cdkContext: {}, identityMode },
        parameters: [
          { key: MODEL_FALLBACK_PARAMETER, literal: "none" },
          ...previousKeys.sort().map((key): ParameterSpec => ({ key, usePreviousValue: true })),
        ],
        expect: { action: "Add", logicalIdPrefixes: [MODEL_FALLBACK_SETTING.logicalIdPrefix] },
      },
      { id: "execute-model-fallback", kind: "execute-change-set", stack: stacks.runtime, createdBy: "change-set-model-fallback" },
      { id: "verify-model-fallback", kind: "verify-stack-parameter", stack: stacks.runtime, key: MODEL_FALLBACK_PARAMETER, expected: { literal: "none" } },
    );
  }

  if (units.includes("e2e-agent-model")) {
    if (input.e2eModel === undefined) throw new Error("e2e-agent-model needs --e2e-model <model id or default>");
    const provider = input.previous.runtime["ModelProvider"] ?? "amazon-bedrock";
    const region = input.region ?? DEFAULT_REGION;
    const known = (MODEL_PROVIDERS as readonly string[]).includes(provider) ? provider as ModelProvider : undefined;
    if (input.e2eModel !== "default" && (known === undefined || eligibleE2EAgentModel(known, input.e2eModel, region) === null)) {
      throw new Error(`--e2e-model ${JSON.stringify(input.e2eModel)} is not a model Rovara can use with ${provider} in ${region}; choose a model of its table (agentx project model-check discover lists them) or default`);
    }
    // A runtime stack deployed before the setting has neither the parameter nor its SSM setting: the first change set adds both, lifted from a synth of the runtime stack, and changes nothing else.
    const exists = input.previous.runtime[E2E_AGENT_MODEL_PARAMETER] !== undefined;
    const previousKeys = Object.keys(input.previous.runtime).filter((key) => key !== E2E_AGENT_MODEL_PARAMETER);
    steps.push(
      {
        id: "change-set-e2e-agent-model",
        kind: "create-change-set",
        stack: stacks.runtime,
        stackKind: "runtime",
        changeSetPrefix: `test-deploy-e2e-model-${revision.slice(0, 12)}`,
        template: exists
          ? { source: "previous" }
          : { source: "lift-resources", logicalIdPrefix: E2E_AGENT_MODEL_SETTING.logicalIdPrefix, parameterNames: [E2E_AGENT_MODEL_PARAMETER], construct: E2E_AGENT_MODEL_SETTING.construct, cdkContext: {}, identityMode },
        parameters: [
          { key: E2E_AGENT_MODEL_PARAMETER, literal: input.e2eModel },
          ...previousKeys.sort().map((key): ParameterSpec => ({ key, usePreviousValue: true })),
        ],
        expect: exists
          ? { action: "Modify", logicalIdPrefixes: [E2E_AGENT_MODEL_SETTING.logicalIdPrefix], allowedAttributes: ["Properties.Value"] }
          : { action: "Add", logicalIdPrefixes: [E2E_AGENT_MODEL_SETTING.logicalIdPrefix] },
      },
      { id: "execute-e2e-agent-model", kind: "execute-change-set", stack: stacks.runtime, createdBy: "change-set-e2e-agent-model" },
      { id: "verify-e2e-agent-model", kind: "verify-stack-parameter", stack: stacks.runtime, key: E2E_AGENT_MODEL_PARAMETER, expected: { literal: input.e2eModel } },
    );
  }

  if (units.includes("e2e-agent-settings")) {
    const parameterNames = E2E_AGENT_SETTINGS_UNIT.settings.map((setting) => `${environmentSettingsPrefix(input.env)}${WORKER_SETTING_PARAMETERS[setting]}`);
    const { broker, variable, policies } = E2E_AGENT_SETTINGS_UNIT;
    steps.push(
      {
        id: "change-set-e2e-agent-settings",
        kind: "create-change-set",
        stack: stacks["control-plane"],
        stackKind: "control-plane",
        changeSetPrefix: `test-deploy-e2e-settings-${revision.slice(0, 12)}`,
        template: {
          source: "lift-declared", construct: QUALIFICATION.construct, cdkContext: QUALIFICATION.context, identityMode,
          environment: [{ logicalId: broker, variable }], grants: policies.flatMap((logicalId) => parameterNames.map((parameterName) => ({ logicalId, parameterName }))),
        },
        parameters: usePrevious("control-plane"),
        expect: {
          action: "Modify", logicalIds: [broker, ...policies], allowedAttributes: [],
          allowedAttributesByLogicalId: { [broker]: ["Properties.Environment"], ...Object.fromEntries(policies.map((logicalId) => [logicalId, ["Properties.PolicyDocument"]])) },
          // CloudFormation lists every resource that reads the Broker's Arn as a Dynamic re-evaluation (API integration, invoke permission, schedules, role policies) when the Broker changes at
          // all; the same no-op re-evaluations control-plane-code accepts, on the same terms (never a Static detail, another cause, or a replacement).
          allowArnReevaluations: true, arnSources: [broker],
        },
      },
      { id: "execute-e2e-agent-settings", kind: "execute-change-set", stack: stacks["control-plane"], createdBy: "change-set-e2e-agent-settings" },
      // Read back what the change set moved: the broker runs with the variable, not merely UPDATE_COMPLETE.
      { id: "verify-e2e-agent-settings", kind: "verify-lambda-environment", stack: stacks["control-plane"], logicalId: broker, key: variable, expected: { literal: environmentSettingsPrefix(input.env) } },
    );
  }

  // One change set holds every Lambda code change of the run, so the exact-change guard has one list of code units to check.
  const lambdas = lambdaUnitsFor(units);
  if (lambdas.length > 0) {
    for (const unit of lambdas) {
      const { logicalId } = LAMBDAS[unit];
      steps.push(
        buildStepFor(unit, join(input.artifacts.outputDir, `${unit}-${revision}.zip`)),
        { id: `upload-${unit}`, kind: "upload-artifact", bucketFromStack: "access", logicalId, from: `build-${unit}`, keyPrefix: `test-deploy/${revision}/${logicalId}-` },
      );
    }
    const logicalIds = lambdas.map((unit) => LAMBDAS[unit].logicalId);
    steps.push(
      {
        id: "change-set-control-plane",
        kind: "create-change-set",
        stack: stacks["control-plane"],
        stackKind: "control-plane",
        changeSetPrefix: `test-deploy-control-plane-${revision.slice(0, 12)}`,
        template: { source: "lambda-code", patches: lambdas.map((unit) => ({ logicalId: LAMBDAS[unit].logicalId, zip: `upload-${unit}` })) },
        parameters: usePrevious("control-plane"),
        expect: { action: "Modify", logicalIds, allowedAttributes: ["Properties.Code"], allowArnReevaluations: true },
      },
      { id: "execute-control-plane", kind: "execute-change-set", stack: stacks["control-plane"], createdBy: "change-set-control-plane" },
      ...lambdas.map((unit): DeployStep => ({
        id: `verify-${unit}`,
        kind: "verify-lambda-code",
        stack: stacks["control-plane"],
        logicalId: LAMBDAS[unit].logicalId,
        expectedSha256Base64: { fromStep: `build-${unit}`, output: "sha256Base64" },
      })),
    );
  }

  if (units.includes("qualification-transport")) {
    steps.push(
      {
        id: "change-set-qualification-transport",
        kind: "create-change-set",
        stack: stacks["control-plane"],
        stackKind: "control-plane",
        changeSetPrefix: `test-deploy-qualification-${revision.slice(0, 12)}`,
        template: { source: "lift-resources", logicalIdPrefix: QUALIFICATION.logicalIdPrefix, construct: QUALIFICATION.construct, cdkContext: QUALIFICATION.context, identityMode },
        parameters: usePrevious("control-plane"),
        expect: { action: "Add", logicalIdPrefixes: [QUALIFICATION.logicalIdPrefix] },
      },
      { id: "execute-qualification-transport", kind: "execute-change-set", stack: stacks["control-plane"], createdBy: "change-set-qualification-transport" },
      // Read back what the change set added: the standing grant exists and is complete, not merely "UPDATE_COMPLETE".
      { id: "verify-qualification-transport", kind: "verify-stack-resources", stack: stacks["control-plane"], createdBy: "change-set-qualification-transport", logicalIdPrefix: QUALIFICATION.logicalIdPrefix, expectedStatus: "CREATE_COMPLETE" },
    );
  }
  return steps;
}

/** The one CausingEntity a code unit's Arn re-evaluation may name. */
const arnOf = (logicalId: string) => `${logicalId}.Arn`;

/**
 * Throws, listing every change that is not an expected one, when a change set holds more than it should. Returns the logical ids
 * accepted only as no-op `<code unit>.Arn` re-evaluations (empty unless the expectation allows them).
 */
export function assertOnlyExpectedChanges(changes: readonly ObservedChange[], expected: ChangeExpectation): { noOpReevaluations: string[] } {
  if (changes.length === 0) throw new Error("the change set has no changes; nothing to apply");
  const matchesId = (logicalId: string) =>
    (expected.logicalIds ?? []).includes(logicalId) || (expected.logicalIdPrefixes ?? []).some((prefix) => logicalId.startsWith(prefix));
  const labelOf = (change: ObservedChange) => `${change.action} ${change.logicalId}${change.type ? ` (${change.type})` : ""}`;
  const problems: string[] = [];
  // The code units whose own change is exactly the expected one: only their Arn re-evaluations may be accepted.
  const exactUnits = new Set<string>();
  const arnSources = expected.arnSources ?? expected.logicalIds ?? [];
  const reevaluations: ObservedChange[] = [];
  const unitChanges: ObservedChange[] = [];
  for (const change of changes) {
    if (change.action !== expected.action || !matchesId(change.logicalId)) {
      if (expected.allowArnReevaluations === true && expected.action === "Modify" && change.action === "Modify") reevaluations.push(change);
      else problems.push(labelOf(change));
    } else unitChanges.push(change);
  }
  // Pass 1: each code unit's own change. With Arn re-evaluations allowed, a unit may also carry Dynamic ResourceAttribute details
  // (it reads another unit's Arn, as the Broker reads the sign-in function's); they are judged in pass 2, once it is known which
  // units are changed only in Code.
  const crossDetails = new Map<string, ObservedDetail[]>();
  const baseClean = new Set<string>();
  for (const change of unitChanges) {
    const label = labelOf(change);
    const before = problems.length;
    if (change.replacement !== undefined && change.replacement !== "" && change.replacement !== "False") problems.push(`${label}: would replace the resource (Replacement ${change.replacement})`);
    const attributes = change.attributes ?? [];
    const details = change.details ?? [];
    if (expected.allowArnReevaluations === true) {
      const isOwn = (detail: ObservedDetail) => detail.evaluation === "Static" && detail.changeSource === "DirectModification";
      const isCross = (detail: ObservedDetail) => detail.evaluation === "Dynamic" && detail.changeSource === "ResourceAttribute";
      if (details.length === 0) problems.push(`${label}: its change details are not reported, so they cannot be checked`);
      else if (details.some((detail) => !isOwn(detail) && !isCross(detail))) problems.push(`${label}: has a change that is not a Static DirectModification`);
      else if (!details.some(isOwn)) problems.push(`${label}: has no Static DirectModification of its own, only re-evaluations`);
      else if (expected.allowedAttributes !== undefined || expected.allowedAttributesByLogicalId !== undefined) {
        // Only the unit's own (Static) details name what it changes; attributes and details are reported in the same order.
        const own = attributes.length === details.length ? attributes.filter((_, index) => isOwn(details[index]!)) : attributes;
        const allowed = expected.allowedAttributesByLogicalId?.[change.logicalId] ?? expected.allowedAttributes ?? [];
        const extra = own.filter((attribute) => !allowed.includes(attribute));
        if (own.length === 0) problems.push(`${label}: changed attributes are not reported, so they cannot be checked`);
        else if (extra.length > 0) problems.push(`${label}: also changes ${extra.join(", ")}`);
      }
      crossDetails.set(change.logicalId, details.filter(isCross));
    } else if (expected.allowedAttributes !== undefined || expected.allowedAttributesByLogicalId !== undefined) {
      const allowed = expected.allowedAttributesByLogicalId?.[change.logicalId] ?? expected.allowedAttributes ?? [];
      const extra = attributes.filter((attribute) => !allowed.includes(attribute));
      if (attributes.length === 0) problems.push(`${label}: changed attributes are not reported, so they cannot be checked`);
      else if (extra.length > 0) problems.push(`${label}: also changes ${extra.join(", ")}`);
    }
    if (problems.length === before) baseClean.add(change.logicalId);
  }
  // Pass 2: a unit's re-evaluation of another unit's Arn is a no-op only when that other unit is in this change set and changed
  // only in Code. A Static detail, any other cause, the unit's own Arn, or a unit that is not clean is refused.
  for (const change of unitChanges) {
    if (!baseClean.has(change.logicalId)) continue;
    const label = labelOf(change);
    const bad = (crossDetails.get(change.logicalId) ?? []).filter((detail) =>
      !(detail.causingEntity !== undefined && [...baseClean].some((unit) => unit !== change.logicalId && arnSources.includes(unit) && detail.causingEntity === arnOf(unit))));
    if (bad.length > 0) problems.push(`${label}: re-evaluates on ${bad.map((detail) => detail.causingEntity ?? "no entity").join(", ")}, which is not the Arn of another code unit changed only in Code`);
    else exactUnits.add(change.logicalId);
  }
  const noOpReevaluations: string[] = [];
  for (const change of reevaluations) {
    const label = labelOf(change);
    const details = change.details ?? [];
    const causedByExactUnit = (detail: ObservedDetail) =>
      detail.evaluation === "Dynamic" && detail.changeSource === "ResourceAttribute"
      && arnSources.some((unit) => exactUnits.has(unit) && detail.causingEntity === arnOf(unit));
    let unsafe: string | undefined;
    if (details.length === 0) unsafe = "its change details are not reported, so they cannot be checked";
    else if (change.replacement === "True") unsafe = `would replace the resource (Replacement ${change.replacement})`;
    else if (!details.every(causedByExactUnit)) unsafe = "has a change that is not a Dynamic re-evaluation of the Arn of a code unit changed only in Code";
    if (unsafe === undefined) noOpReevaluations.push(change.logicalId);
    else problems.push(`${label}: ${unsafe}`);
  }
  for (const logicalId of expected.logicalIds ?? []) {
    if (!changes.some((change) => change.logicalId === logicalId && change.action === expected.action)) problems.push(`missing the expected ${expected.action} ${logicalId}`);
  }
  if (problems.length > 0) {
    const accepted = noOpReevaluations.length === 0 ? "" : `; accepted separately as no-op re-evaluations caused by ${arnSources.map(arnOf).join(", ")}: ${noOpReevaluations.join(", ")}`;
    throw new Error(`the change set holds unexpected changes: ${problems.join("; ")}${accepted}`);
  }
  return { noOpReevaluations };
}

export interface CfnResource {
  Type?: string;
  Properties?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface CfnTemplate {
  Parameters?: Record<string, unknown>;
  Resources?: Record<string, CfnResource>;
  [key: string]: unknown;
}

function references(node: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) node.forEach((item) => references(item, found));
  else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "Ref" && typeof value === "string") found.add(value);
      else if (key === "Fn::GetAtt") found.add(String(Array.isArray(value) ? value[0] : String(value).split(".")[0]));
      else references(value, found);
    }
  }
  return found;
}

/** The deployed template plus only the synthesized resources whose logical ID starts with `prefix`.
 * Taking the rest from the deployed template keeps unrelated code and configuration byte for byte. */
export function liftResources(deployed: CfnTemplate, synthesized: CfnTemplate, prefix: string, parameterNames: readonly string[] = []): CfnTemplate {
  const lifted = Object.entries(synthesized.Resources ?? {}).filter(([logicalId]) => logicalId.startsWith(prefix));
  if (lifted.length === 0) throw new Error(`the synthesized template has no resource starting with ${prefix}; the CDK context flag was not honoured`);
  const liftedParameters = parameterNames.map((name): [string, unknown] => {
    const parameter = synthesized.Parameters?.[name];
    if (parameter === undefined) throw new Error(`the synthesized template has no parameter ${name}`);
    return [name, parameter];
  });
  const liftedIds = new Set([...lifted.map(([logicalId]) => logicalId), ...liftedParameters.map(([name]) => name)]);
  for (const [logicalId, resource] of lifted) {
    for (const name of references(resource)) {
      if (name.startsWith("AWS::") || liftedIds.has(name) || name in (deployed.Resources ?? {}) || name in (deployed.Parameters ?? {})) continue;
      throw new Error(`${logicalId} refers to ${name}, which the deployed stack does not have; deploy it with CDK instead`);
    }
  }
  return {
    ...deployed,
    ...(liftedParameters.length === 0 ? {} : { Parameters: { ...deployed.Parameters, ...Object.fromEntries(liftedParameters) } }),
    Resources: { ...deployed.Resources, ...Object.fromEntries(lifted) },
  };
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, inner: unknown) => (inner !== null && typeof inner === "object" && !Array.isArray(inner)
  ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : inner));
const asRecord = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

/**
 * The deployed template with exactly the declared additions taken from head's (`lift-declared`), and every other byte of it as it is:
 * - each `environment` entry: the Lambda's environment variable, which head sets and the deployed function lacks; the other variables of head and the deployed function must be equal;
 * - each `grants` entry: the ARN of an SSM parameter in the `ssm:GetParameters` statement of a role policy (several entries may name the same policy, and are judged together); the rest of
 *   head's policy (its other statements, resources and roles) must be equal to the deployed policy's, whatever the order of its statements and of their Action and Resource lists.
 * A resource that is already as head has it is left alone (a re-run). Anything head and the deployed template differ by beyond that refuses, naming the resource: this change set is
 * allow-listed to the declared additions and must never carry another IAM or environment change along with them.
 */
export function liftDeclaredSettings(
  deployed: CfnTemplate,
  head: CfnTemplate,
  declared: { environment: ReadonlyArray<{ logicalId: string; variable: string }>; grants: ReadonlyArray<{ logicalId: string; parameterName: string }> },
): CfnTemplate {
  const resources: Record<string, CfnResource> = { ...(deployed.Resources ?? {}) };
  const need = (logicalId: string, template: CfnTemplate, where: string): CfnResource => {
    const resource = template.Resources?.[logicalId];
    if (resource === undefined) throw new Error(`${logicalId} is not in ${where}; stop for review`);
    return resource;
  };
  for (const { logicalId, variable } of declared.environment) {
    const deployedResource = need(logicalId, deployed, "the deployed template");
    const headResource = need(logicalId, head, "head's template");
    const deployedVariables = asRecord(asRecord(deployedResource.Properties?.Environment)?.Variables) ?? {};
    const headVariables = asRecord(asRecord(headResource.Properties?.Environment)?.Variables);
    if (headVariables === undefined || !(variable in headVariables)) throw new Error(`head's ${logicalId} does not set ${variable}; stop for review`);
    const { [variable]: headValue, ...headRest } = headVariables;
    const { [variable]: deployedValue, ...deployedRest } = deployedVariables;
    if (canonical(headRest) !== canonical(deployedRest)) throw new Error(`head's ${logicalId} differs from the deployed function by more than the declared ${variable}: its other environment variables differ; deploy those with their own unit first`);
    // Everything but the environment is the deployed resource's, byte for byte; head's other properties must be the deployed ones. The code is the one thing allowed to differ: it
    // is moved by the code units, and this change set keeps the deployed function's.
    const strip = (resource: CfnResource) => { const { Environment: _environment, Code: _code, ...rest } = resource.Properties ?? {}; void _environment; void _code; return canonical(rest); };
    if (strip(headResource) !== strip(deployedResource)) throw new Error(`head's ${logicalId} differs from the deployed function by more than the declared ${variable}: another property differs; deploy that with its own unit first`);
    if (deployedValue !== undefined && canonical(deployedValue) !== canonical(headValue)) throw new Error(`the deployed ${logicalId} already sets ${variable} to another value than head's; stop for review`);
    resources[logicalId] = { ...deployedResource, Properties: { ...(deployedResource.Properties ?? {}), Environment: { ...(asRecord(deployedResource.Properties?.Environment) ?? {}), Variables: { ...deployedVariables, [variable]: headValue } } } };
  }
  // One policy can take several declared ARNs: they are judged together, against the deployed policy, so each is not compared with a deployed policy that still lacks the others.
  const grantsByPolicy = new Map<string, string[]>();
  for (const { logicalId, parameterName } of declared.grants) grantsByPolicy.set(logicalId, [...(grantsByPolicy.get(logicalId) ?? []), parameterName]);
  for (const [logicalId, parameterNames] of grantsByPolicy) {
    const deployedResource = need(logicalId, deployed, "the deployed template");
    const headResource = need(logicalId, head, "head's template");
    for (const [where, resource] of [["the deployed template", deployedResource], ["head's template", headResource]] as const) {
      if (resource.Type !== "AWS::IAM::Policy") throw new Error(`${logicalId} is not an AWS::IAM::Policy in ${where}; stop for review`);
    }
    // A declared ARN is matched only as the exact entry CDK synthesizes (partition, region and account refs, then exactly `:parameter<name>`): a wildcard, a longer name that starts with the
    // declared one, or an ARN of another region or account is a different grant, stays in the comparison, and so refuses.
    const exactArns = parameterNames.map((parameterName) => canonical({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ssm:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:parameter${parameterName}`]] }));
    const named = parameterNames.join(", ");
    const statementsOf = (properties: Record<string, unknown> | undefined): Array<Record<string, unknown>> => ((asRecord(properties?.PolicyDocument)?.Statement ?? []) as Array<Record<string, unknown>>);
    const entriesOf = (statement: Record<string, unknown>): unknown[] => (Array.isArray(statement.Resource) ? statement.Resource : []);
    const occurrences = (statement: Record<string, unknown>, exact: string): number => entriesOf(statement).filter((entry) => canonical(entry) === exact).length;
    const actionKey = (statement: Record<string, unknown>): string => canonical(Array.isArray(statement.Action) ? (statement.Action as unknown[]).map((entry) => canonical(entry)).sort() : statement.Action);
    // Every declared ARN is in head's policy exactly once, all of them in the one same statement.
    const holders = new Set(exactArns.map((exact, position) => {
      const where = statementsOf(headResource.Properties).flatMap((statement, index) => (occurrences(statement, exact) > 0 ? [index] : []));
      const statement = statementsOf(headResource.Properties)[where[0] ?? 0];
      if (where.length !== 1 || statement === undefined || occurrences(statement, exact) !== 1) throw new Error(`head's ${logicalId} has no grant for ${parameterNames[position]} in exactly one statement; stop for review`);
      return where[0]!;
    }));
    if (holders.size !== 1) throw new Error(`head's ${logicalId} does not hold ${named} in one statement; stop for review`);
    // Only statements of the holder's Action (ssm:GetParameters) may have the declared ARNs taken out: the same ARN in a statement of another Action is not the declared grant.
    const holderAction = actionKey(statementsOf(headResource.Properties)[[...holders][0]!]!);
    if (exactArns.every((exact) => statementsOf(deployedResource.Properties).some((statement) => occurrences(statement, exact) > 0))) {
      // Already granted in the deployed policy (a re-run): it must be head's policy exactly, or something else changed and this unit is not the way to apply it.
      if (canonical(headResource.Properties) !== canonical(deployedResource.Properties)) throw new Error(`head's ${logicalId} differs from the deployed policy by more than the declared grant for ${named}: the deployed policy already has it, and another statement, resource or role differs; stop for review (Tier 3)`);
      continue;
    }
    // Head's policy with the declared ARNs taken out must be the deployed policy with the same ARNs taken out (a half-applied policy has some of them): nothing else of it differs. IAM reads the
    // statements, and the Action and Resource lists inside them, as sets, and a synth orders them by how the code granted them (TEST's deployed Broker policy holds head's statements in another
    // order), so the comparison ignores the order of the statements and of those lists. Every other property (name, roles, conditions, effects) is compared exactly.
    const normalised = (properties: Record<string, unknown> | undefined): string => {
      const copy = JSON.parse(JSON.stringify(properties ?? {})) as Record<string, unknown>;
      const document = asRecord(copy.PolicyDocument);
      if (document !== undefined && Array.isArray(document.Statement)) {
        const statements = (document.Statement as Array<Record<string, unknown>>).map((statement) => {
          const listed = { ...statement };
          if (Array.isArray(listed.Resource) && actionKey(statement) === holderAction) listed.Resource = (listed.Resource as unknown[]).filter((entry) => !exactArns.includes(canonical(entry)));
          for (const key of ["Action", "Resource"]) if (Array.isArray(listed[key])) listed[key] = (listed[key] as unknown[]).map((entry) => canonical(entry)).sort();
          return canonical(listed);
        });
        document.Statement = statements.sort();
      }
      return canonical(copy);
    };
    if (normalised(headResource.Properties) !== normalised(deployedResource.Properties)) {
      throw new Error(`head's ${logicalId} differs from the deployed policy by more than the declared grant for ${named}: another statement, resource or role differs; stop for review (Tier 3)`);
    }
    resources[logicalId] = { ...deployedResource, Properties: { ...(deployedResource.Properties ?? {}), PolicyDocument: headResource.Properties?.PolicyDocument } };
  }
  return { ...deployed, Resources: resources };
}

/** The arguments of `npx cdk synth <construct>` for a lifted template: the profile, and the app and context the repo's deploy engine passes. */
export function liftSynthArguments(
  plan: LiftSynthPlan,
  input: { env: string; region: string; profile: string; outDir: string },
): string[] {
  return [
    "--no-install", "cdk", "synth", plan.construct, "--exclusively", "--quiet", "--no-notices", "--no-version-reporting",
    ...cdkAppArguments({ env: input.env, region: input.region, identityMode: plan.identityMode }),
    ...Object.entries(plan.cdkContext).flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    "--output", input.outDir,
    ...profileArgs(input.profile),
  ];
}

export interface StackUpdateState {
  status: string;
  /** When the stack was last updated (or created, if never updated). */
  lastUpdatedTime?: Date | undefined;
}

export interface StackWaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Waits for the stack's own update to finish after ExecuteChangeSet. CloudFormation removes an executed change set, so the change set
 * cannot be polled; the stack is watched instead. A settled status only counts once `lastUpdatedTime` is newer than `since` (recorded before
 * executing), so UPDATE_COMPLETE left by an earlier deploy is never taken as this one's success. The settled status must be UPDATE_COMPLETE;
 * anything else (UPDATE_ROLLBACK_*, ...) is an error naming the status and, when `describeFailure` finds one, the reason.
 */
export async function waitForStackUpdate(
  read: () => Promise<StackUpdateState>,
  since: Date | undefined,
  options: StackWaitOptions & { describeFailure?: () => Promise<string | undefined> } = {},
): Promise<void> {
  const { timeoutMs = 30 * 60_000, intervalMs = 5_000, sleep: wait = sleep, now = Date.now, describeFailure } = options;
  const deadline = now() + timeoutMs;
  const minutes = Math.round(timeoutMs / 60_000);
  for (;;) {
    const { status, lastUpdatedTime } = await read();
    const started = since === undefined || (lastUpdatedTime !== undefined && lastUpdatedTime.getTime() > since.getTime());
    if (started && !status.endsWith("_IN_PROGRESS")) {
      if (status === "UPDATE_COMPLETE") return;
      const reason = await describeFailure?.();
      throw new Error(`the stack is ${status} after the change set was executed${reason ? `: ${reason}` : ""}; read its events in CloudFormation`);
    }
    if (now() > deadline) {
      throw new Error(started
        ? `the stack is still ${status} after ${minutes} minutes; check CloudFormation`
        : `the stack update did not start within ${minutes} minutes (the stack is ${status}, last updated ${lastUpdatedTime?.toISOString() ?? "never"}); check CloudFormation`);
    }
    await wait(intervalMs);
  }
}

/** The earliest failed stack event of the update that began after `since`: the root cause, before the cancellations and the rollback it triggered. */
export function firstFailureReason(
  events: ReadonlyArray<{ Timestamp?: Date | undefined; LogicalResourceId?: string | undefined; ResourceStatus?: string | undefined; ResourceStatusReason?: string | undefined }>,
  since: Date | undefined,
): string | undefined {
  const failed = events
    .filter((event) => event.ResourceStatus?.endsWith("_FAILED") && event.Timestamp !== undefined && (since === undefined || event.Timestamp.getTime() > since.getTime()))
    .sort((left, right) => left.Timestamp!.getTime() - right.Timestamp!.getTime())[0];
  if (failed === undefined) return undefined;
  return `${failed.LogicalResourceId ?? "the stack"} ${failed.ResourceStatus}${failed.ResourceStatusReason ? `: ${failed.ResourceStatusReason}` : ""}`;
}

/** Records the stack's last update time, executes the change set, and waits on the stack (see waitForStackUpdate). Never reads the change set again. */
export async function executeChangeSetAndWait(
  cloudFormation: Pick<CloudFormationClient, "send">,
  identity: { StackName: string; ChangeSetName: string },
  options: StackWaitOptions = {},
): Promise<void> {
  const readStack = async (): Promise<StackUpdateState> => {
    const stack = (await cloudFormation.send(new DescribeStacksCommand({ StackName: identity.StackName }))).Stacks?.[0];
    if (stack === undefined) throw new Error(`stack ${identity.StackName} does not exist`);
    return { status: stack.StackStatus ?? "", lastUpdatedTime: stack.LastUpdatedTime ?? stack.CreationTime };
  };
  const since = (await readStack()).lastUpdatedTime;
  await cloudFormation.send(new ExecuteChangeSetCommand(identity));
  await waitForStackUpdate(readStack, since, {
    ...options,
    describeFailure: async () => firstFailureReason((await cloudFormation.send(new DescribeStackEventsCommand({ StackName: identity.StackName }))).StackEvents ?? [], since),
  });
}

/** Reads each named resource back with DescribeStackResource and requires its status; returns the IDs checked. */
export async function verifyStackResources(
  describe: (logicalId: string) => Promise<{ ResourceStatus?: string | undefined; PhysicalResourceId?: string | undefined } | undefined>,
  logicalIds: readonly string[],
  expectedStatus: string,
): Promise<string[]> {
  if (logicalIds.length === 0) throw new Error("there is no resource to verify: the change set added none");
  for (const logicalId of logicalIds) {
    const resource = await describe(logicalId);
    if (resource === undefined) throw new Error(`${logicalId} is not in the stack`);
    if (resource.ResourceStatus !== expectedStatus) throw new Error(`${logicalId} is ${resource.ResourceStatus ?? "in no known status"}, not ${expectedStatus}`);
  }
  return [...logicalIds];
}

/** A copy of `template` whose named Lambda functions run the given S3 code; everything else is untouched. */
export function patchLambdaCode(
  template: CfnTemplate,
  patches: ReadonlyArray<{ logicalId: string; code: { S3Bucket: string; S3Key: string; S3ObjectVersion: string } }>,
): CfnTemplate {
  const copy = JSON.parse(JSON.stringify(template)) as CfnTemplate;
  for (const { logicalId, code } of patches) {
    const resource = copy.Resources?.[logicalId];
    if (resource === undefined) throw new Error(`the deployed template has no resource ${logicalId}`);
    if (resource.Type !== "AWS::Lambda::Function" || resource.Properties === undefined || !("Code" in resource.Properties)) {
      throw new Error(`${logicalId} is not a Lambda function with a Code property; stop for review`);
    }
    resource.Properties.Code = code;
  }
  return copy;
}

export interface TestDeployArgs {
  env: string;
  profile: string;
  region: string;
  apply: boolean;
  /** Read-only: report stale code, IAM drift, catalog and runner problems, and change nothing. */
  check: boolean;
  /** With --check: print the report as one JSON line at the end of stdout. */
  json: boolean;
  only: DeployUnit[];
  /** With --only e2e-agent-model: the AI navigation model to set, or `default`. */
  e2eModel?: string;
}

/**
 * Splits argv into the options a script knows. Every option is `--name` (a flag) or `--name value`; a bare word, a repeated option
 * and an unknown option are errors, so a mistyped command never runs as a different one.
 */
export function parseOptions(argv: readonly string[], spec: { values: readonly string[]; flags: readonly string[] }): { values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) throw new Error(`unexpected argument ${argument}; every input is an option (--name value)`);
    if (spec.flags.includes(argument)) {
      if (flags.has(argument)) throw new Error(`${argument} was given twice`);
      flags.add(argument);
    } else if (spec.values.includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (values.has(argument)) throw new Error(`${argument} was given twice`);
      values.set(argument, value);
      index += 1;
    } else {
      throw new Error(`unknown option ${argument}`);
    }
  }
  return { values, flags };
}

export function parseTestDeployArgs(argv: readonly string[]): TestDeployArgs {
  const { values, flags } = parseOptions(argv, { values: ["--env", "--profile", "--region", "--only", "--e2e-model"], flags: ["--apply", "--check", "--json"] });
  const env = values.get("--env");
  if (env === undefined) throw new Error("--env is required");
  const profile = values.get("--profile");
  if (profile === undefined) throw new Error("--profile is required");
  const onlyValue = values.get("--only");
  if (flags.has("--check") && flags.has("--apply")) throw new Error("--check is read-only; it cannot be combined with --apply");
  if (flags.has("--json") && !flags.has("--check")) throw new Error("--json only goes with --check");
  if (flags.has("--check") && onlyValue !== undefined) throw new Error("--check checks every unit; it does not take --only");
  const e2eModel = values.get("--e2e-model");
  if (flags.has("--check") && e2eModel !== undefined) throw new Error("--check is read-only; it does not take --e2e-model");
  const only = onlyValue === undefined ? [...DEFAULT_DEPLOY_UNITS] : onlyValue.split(",").map((name) => {
    const unit = DEPLOY_UNITS.find((candidate) => candidate === name.trim());
    if (unit === undefined) throw new Error(`unknown deploy unit ${name}; expected one of ${DEPLOY_UNITS.join(", ")}`);
    return unit;
  });
  if (e2eModel !== undefined && !(only.length === 1 && only[0] === "e2e-agent-model")) throw new Error("--e2e-model goes only with --only e2e-agent-model");
  if (only.includes("e2e-agent-model") && e2eModel === undefined) throw new Error("e2e-agent-model needs --e2e-model <model id or default>");
  return { env, profile, region: values.get("--region") ?? DEFAULT_REGION, apply: flags.has("--apply"), check: flags.has("--check"), json: flags.has("--json"), only, ...(e2eModel === undefined ? {} : { e2eModel }) };
}

function describeRef(ref: StepRef): string {
  return `<${ref.fromStep}.${ref.output}>`;
}

export function formatPlan(steps: readonly DeployStep[]): string {
  return steps.map((step, index) => {
    const head = `${index + 1}. [${step.id}]`;
    switch (step.kind) {
      case "build-lambda-zip": return `${head} build ${step.logicalId} zip from ${step.entry}${(step.extraFiles ?? []).map((file) => ` plus ${file.name} from ${file.from}`).join("")} -> ${step.zipPath}`;
      case "upload-artifact": return `${head} upload ${step.from} zip to the access stack's versioned artifact bucket (after checking versioning is Enabled and that ${step.logicalId} already reads its code from it) under ${step.keyPrefix}<sha256>.zip`;
      case "ecr-push": return `${head} build the ${step.image} image and push it to the existing repository ${step.repositoryUri} (tag test-*), then pin its digest; test-deploy never creates a repository, and stops if this one is missing`;
      case "create-change-set": {
        const changed = step.parameters.flatMap((parameter) => ("value" in parameter ? [`${parameter.key}=${describeRef(parameter.value)}`] : "literal" in parameter ? [`${parameter.key}=${parameter.literal}`] : []));
        const template = step.template.source === "previous" ? "previous template"
          : step.template.source === "lambda-code" ? `deployed template with Code replaced for ${step.template.patches.map((patch) => patch.logicalId).join(", ")}`
          : step.template.source === "lift-declared"
            ? `deployed template plus only ${[...step.template.environment.map((entry) => `${entry.logicalId} environment variable ${entry.variable}`), ...step.template.grants.map((entry) => `the ssm:GetParameters grant for ${entry.parameterName} in ${entry.logicalId}`)].join(", ")}, taken from a CDK synth of ${step.template.construct} (identity=${step.template.identityMode}, ${Object.entries(step.template.cdkContext).map(([key, value]) => `${key}=${value}`).join(", ")}); refuses if head differs from the deployed template by anything more`
          : `deployed template plus ${step.template.logicalIdPrefix}*${(step.template.parameterNames ?? []).length === 0 ? "" : ` and parameter ${(step.template.parameterNames ?? []).join(", ")}`} from a CDK synth of ${step.template.construct} (${[`identity=${step.template.identityMode}`, ...Object.entries(step.template.cdkContext).map(([key, value]) => `${key}=${value}`)].join(", ")})`;
        const allowed = [...(step.expect.logicalIds ?? []), ...(step.expect.logicalIdPrefixes ?? []).map((prefix) => `${prefix}*`)].join(", ");
        const reevaluations = step.expect.allowArnReevaluations === true
          ? `, plus Modify entries accepted only as no-op re-evaluations caused by ${(step.expect.arnSources ?? step.expect.logicalIds ?? []).map(arnOf).join(", ")} (every detail Dynamic ResourceAttribute, never a replacement; a code unit may carry such a detail only when another listed code unit's Arn causes it)`
          : "";
        return `${head} create change set on ${step.stack}: ${template}; ${step.parameters.length} parameters, ${changed.length === 0 ? "all UsePreviousValue" : `changing only ${changed.join(", ")}`}; abort unless the only changes are ${step.expect.action} ${allowed}${reevaluations}`;
      }
      case "execute-change-set": return `${head} execute the change set from ${step.createdBy} on ${step.stack} and wait for UPDATE_COMPLETE`;
      case "verify-stack-resources": return `${head} verify with DescribeStackResource that every ${step.logicalIdPrefix}* resource ${step.createdBy} added in ${step.stack} is ${step.expectedStatus}`;
      case "verify-lambda-code": return `${head} verify ${step.logicalId} CodeSha256 equals ${describeRef(step.expectedSha256Base64)}`;
      case "verify-stack-parameter": return `${head} verify ${step.stack} parameter ${step.key} equals ${"literal" in step.expected ? step.expected.literal : describeRef(step.expected)}`;
      case "verify-lambda-environment": return `${head} verify ${step.logicalId} runs with environment variable ${step.key}=${step.expected.literal} (GetFunctionConfiguration)`;
    }
  }).join("\n");
}

// ---------------------------------------------------------------------------------------------
// The thin --apply executor. Nothing below runs in the unit tests: they exercise the plan and guards.
// ---------------------------------------------------------------------------------------------

interface ApplyContext {
  runner: Runner;
  options: ReleaseOptions;
  region: string;
  env: string;
  revision: string;
  cloudFormation: CloudFormationClient;
  lambda: LambdaClient;
  outputs: Map<string, Record<string, string>>;
  built: boolean;
  /** Where the build writes its zips and where the described change sets are kept. */
  outputDir: string;
}

const SETTLED_STACK_STATUSES: ReadonlySet<string> = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE"]);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sha256 = (data: Buffer) => createHash("sha256").update(data);

function outputOf(context: ApplyContext, ref: StepRef): string {
  const value = context.outputs.get(ref.fromStep)?.[ref.output];
  if (value === undefined) throw new Error(`step ${ref.fromStep} did not produce ${ref.output}`);
  return value;
}

function recordOutput(context: ApplyContext, id: string, values: Record<string, string>): void {
  context.outputs.set(id, { ...context.outputs.get(id), ...values });
}

function runNpmBuild(context: ApplyContext): void {
  if (context.built) return;
  context.runner.run("npm", ["run", "build"]);
  context.built = true;
}

/** Uploads one object that must not already exist with other bytes, and reads back its version and checksum. */
function putVerifiedObject(context: ApplyContext, bucket: string, key: string, file: string, contentType: string): string {
  const data = readFileSync(file);
  const checksum = sha256(data).digest("base64");
  const head = (version?: string) => context.runner.aws([
    "s3api", "head-object", "--bucket", bucket, "--key", key, "--checksum-mode", "ENABLED", ...(version ? ["--version-id", version] : []),
    "--region", context.region, "--output", "json",
  ], true);
  let found = head();
  if (found.status !== 0) {
    context.runner.aws([
      "s3api", "put-object", "--bucket", bucket, "--key", key, "--body", file, "--content-type", contentType,
      "--checksum-algorithm", "SHA256", "--checksum-sha256", checksum, "--if-none-match", "*", "--region", context.region, "--output", "json",
    ]);
    found = head();
  }
  if (found.status !== 0) throw new Error(`could not read back s3://${bucket}/${key}`);
  const object = JSON.parse(found.stdout) as { VersionId?: string; ChecksumSHA256?: string; ContentLength?: number };
  if (!object.VersionId || object.VersionId === "null") throw new Error(`s3://${bucket}/${key} has no version ID; the bucket must be versioned`);
  if (object.ChecksumSHA256 !== checksum || object.ContentLength !== data.length) throw new Error(`s3://${bucket}/${key} differs from the local file; refusing to reuse it`);
  return object.VersionId;
}

async function describeStackSdk(context: ApplyContext, stackName: string): Promise<Stack> {
  const stack = (await context.cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
  if (stack === undefined) throw new Error(`stack ${stackName} does not exist`);
  return stack;
}

/**
 * Saves the change set as described, every page of its changes, before anything executes it: CloudFormation removes an executed change set, so this file is the
 * only record a fixture can later be refreshed from (B13). A change set holds resource changes and parameter keys, no secret (NoEcho values come back masked). Returns the path.
 */
export function saveDescribedChangeSet(directory: string, described: Partial<DescribeChangeSetCommandOutput>, changes: readonly Change[]): string {
  mkdirSync(directory, { recursive: true });
  const name = `${described.StackName ?? "stack"}-${described.ChangeSetName ?? "change-set"}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const path = join(directory, `change-set-${name}.json`);
  // The first page of changes, the paging token and the SDK metadata are not part of the record; `changes` holds every page.
  const header = Object.fromEntries(Object.entries(described).filter(([key]) => key !== "$metadata" && key !== "Changes" && key !== "NextToken"));
  // Owner-only: the record holds nothing secret today, but it sits in a shared temp directory. `mode` applies only to a new file, so an old one is narrowed too.
  writeFileSync(path, `${JSON.stringify({ ...header, Changes: changes }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Runs the save; if it throws, deletes the change set (best effort) and fails, so a change set that could not be recorded is never left to be executed later. */
export async function saveChangeSetOrDrop(save: () => string, drop: () => Promise<unknown>): Promise<string> {
  try {
    return save();
  } catch (error) {
    await drop().catch(() => undefined);
    throw new Error(`the change set could not be saved (${error instanceof Error ? error.message : String(error)}). It was deleted and nothing was applied.`, { cause: error });
  }
}

export function observedChanges(changes: readonly Change[]): ObservedChange[] {
  return changes.map((change) => {
    const resource = change.ResourceChange;
    const attributes = (resource?.Details ?? []).map((detail) => {
      const attribute = detail.Target?.Attribute ?? "";
      return attribute === "Properties" ? `Properties.${detail.Target?.Name ?? ""}` : attribute;
    });
    const details = (resource?.Details ?? []).map((detail): ObservedDetail => ({
      ...(detail.Evaluation === undefined ? {} : { evaluation: detail.Evaluation }),
      ...(detail.ChangeSource === undefined ? {} : { changeSource: detail.ChangeSource }),
      ...(detail.CausingEntity === undefined ? {} : { causingEntity: detail.CausingEntity }),
    }));
    return {
      action: resource?.Action ?? "",
      logicalId: resource?.LogicalResourceId ?? "",
      ...(resource?.ResourceType === undefined ? {} : { type: resource.ResourceType }),
      ...(resource?.Replacement === undefined ? {} : { replacement: resource.Replacement }),
      attributes,
      details,
    };
  });
}

function synthesizeLiftSource(context: ApplyContext, plan: LiftSynthPlan): CfnTemplate {
  runNpmBuild(context);
  const outDir = mkdtempSync(join(tmpdir(), "test-deploy-synth-"));
  context.runner.run("npx", liftSynthArguments(plan, { env: context.env, region: context.region, profile: context.options.profile ?? "", outDir }));
  return JSON.parse(readFileSync(join(outDir, `${plan.construct}.template.json`), "utf8")) as CfnTemplate;
}

async function createChangeSet(context: ApplyContext, step: Extract<DeployStep, { kind: "create-change-set" }>): Promise<void> {
  const stack = await describeStackSdk(context, step.stack);
  const status = stack.StackStatus ?? "";
  if (!SETTLED_STACK_STATUSES.has(status)) {
    throw new Error(`stack ${step.stack} is ${status}; it must be in a settled state first`);
  }
  const have = new Set((stack.Parameters ?? []).map((parameter) => parameter.ParameterKey));
  // A parameter the lifted template itself adds is new; every other one must already be on the stack.
  const added = new Set(step.template.source === "lift-resources" ? step.template.parameterNames ?? [] : []);
  const unknown = step.parameters.filter((parameter) => !have.has(parameter.key) && !added.has(parameter.key));
  if (unknown.length > 0) throw new Error(`${step.stack} has no parameter ${unknown.map((parameter) => parameter.key).join(", ")}`);

  let templateUrl: string | undefined;
  if (step.template.source !== "previous") {
    const deployedBody = (await context.cloudFormation.send(new GetTemplateCommand({ StackName: step.stack, TemplateStage: "Original" }))).TemplateBody ?? "";
    let deployed: CfnTemplate;
    try { deployed = JSON.parse(deployedBody) as CfnTemplate; } catch { throw new Error(`the deployed template of ${step.stack} is not JSON; stop for review`); }
    const prepared = step.template.source === "lambda-code"
      ? patchLambdaCode(deployed, step.template.patches.map((patch) => {
        const upload = context.outputs.get(patch.zip);
        if (upload?.bucket === undefined || upload.s3Key === undefined || upload.s3ObjectVersion === undefined) throw new Error(`step ${patch.zip} did not upload`);
        return { logicalId: patch.logicalId, code: { S3Bucket: upload.bucket, S3Key: upload.s3Key, S3ObjectVersion: upload.s3ObjectVersion } };
      }))
      : step.template.source === "lift-declared"
        ? liftDeclaredSettings(deployed, synthesizeLiftSource(context, step.template), { environment: step.template.environment, grants: step.template.grants })
        : liftResources(deployed, synthesizeLiftSource(context, step.template), step.template.logicalIdPrefix, step.template.parameterNames);
    const body = Buffer.from(`${JSON.stringify(prepared, null, 2)}\n`);
    const bucket = resolveArtifactBucket(context.runner, context.region, context.env);
    const key = `test-deploy/${context.revision}/${step.stackKind}-template-${sha256(body).digest("hex")}.json`;
    const file = join(mkdtempSync(join(tmpdir(), "test-deploy-template-")), "template.json");
    writeFileSync(file, body);
    const version = putVerifiedObject(context, bucket, key, file, "application/json");
    templateUrl = `https://${bucket}.s3.${context.region}.amazonaws.com/${key}?versionId=${encodeURIComponent(version)}`;
  }

  const changeSetName = `${step.changeSetPrefix}-${Math.floor(Date.now() / 1000)}`;
  const identity = { StackName: step.stack, ChangeSetName: changeSetName };
  await context.cloudFormation.send(new CreateChangeSetCommand({
    ...identity,
    ChangeSetType: "UPDATE",
    ...(templateUrl === undefined ? { UsePreviousTemplate: true } : { TemplateURL: templateUrl }),
    Parameters: step.parameters.map((parameter) => ("value" in parameter
      ? { ParameterKey: parameter.key, ParameterValue: outputOf(context, parameter.value) }
      : "literal" in parameter ? { ParameterKey: parameter.key, ParameterValue: parameter.literal }
      : { ParameterKey: parameter.key, UsePreviousValue: true })),
    Capabilities: stack.Capabilities ?? [],
    Description: `TEST fast-lane deploy ${context.revision.slice(0, 12)} (scripts/test-deploy.ts)`,
  }));
  const deadline = Date.now() + 10 * 60_000;
  let described = await context.cloudFormation.send(new DescribeChangeSetCommand(identity));
  while (described.Status !== "CREATE_COMPLETE" && described.Status !== "FAILED") {
    if (Date.now() > deadline) { await context.cloudFormation.send(new DeleteChangeSetCommand(identity)); throw new Error(`change set ${changeSetName} took too long to prepare; deleted`); }
    await sleep(3_000);
    described = await context.cloudFormation.send(new DescribeChangeSetCommand(identity));
  }
  const dropChangeSet = () => context.cloudFormation.send(new DeleteChangeSetCommand(identity)).catch(() => undefined);
  if (described.Status === "FAILED") {
    await dropChangeSet();
    const reason = described.StatusReason ?? "";
    if (/didn't contain changes|No updates are to be performed/.test(reason)) {
      console.log(`no changes for ${step.stack}: already applied; the verify steps still run`);
      recordOutput(context, step.id, { status: "no-changes" });
      return;
    }
    throw new Error(`change set ${changeSetName} failed: ${reason}`);
  }
  const changes: Change[] = [...(described.Changes ?? [])];
  for (let token = described.NextToken; token !== undefined;) {
    const page = await context.cloudFormation.send(new DescribeChangeSetCommand({ ...identity, NextToken: token }));
    changes.push(...(page.Changes ?? []));
    token = page.NextToken;
  }
  console.log(`change set ${changeSetName} saved to ${await saveChangeSetOrDrop(() => saveDescribedChangeSet(context.outputDir, described, changes), dropChangeSet)}`);
  const observed = observedChanges(changes);
  console.log(`change set ${changeSetName}:\n${observed.map((change) => `  ${change.action} ${change.logicalId} ${change.type ?? ""} ${(change.attributes ?? []).join(",")}`).join("\n")}`);
  try {
    const { noOpReevaluations } = assertOnlyExpectedChanges(observed, step.expect);
    if (noOpReevaluations.length > 0) console.log(`accepted as no-op re-evaluations caused by ${(step.expect.arnSources ?? step.expect.logicalIds ?? []).map(arnOf).join(", ")}: ${noOpReevaluations.join(", ")}`);
  } catch (error) {
    await dropChangeSet();
    throw new Error(`${error instanceof Error ? error.message : String(error)}. The change set was deleted and nothing was applied.`, { cause: error });
  }
  recordOutput(context, step.id, { status: "created", changeSetName, addedLogicalIds: JSON.stringify(observed.filter((change) => change.action === "Add").map((change) => change.logicalId)) });
}

async function executeChangeSet(context: ApplyContext, step: Extract<DeployStep, { kind: "execute-change-set" }>): Promise<void> {
  const created = context.outputs.get(step.createdBy);
  if (created?.status === "no-changes") return;
  if (created?.changeSetName === undefined) throw new Error(`step ${step.createdBy} created no change set`);
  const identity = { StackName: step.stack, ChangeSetName: created.changeSetName };
  await executeChangeSetAndWait(context.cloudFormation, identity);
}

/** Pushes to a repository that must already exist: describing it is the check, and nothing here creates one. */
function assertRepositoryExists(context: ApplyContext, repository: string): void {
  const found = context.runner.aws(["ecr", "describe-repositories", "--repository-names", repository, "--region", context.region, "--output", "json"], true);
  if (found.status !== 0) {
    throw new Error(`the ECR repository ${repository} does not exist (or cannot be read) and test-deploy never creates one; create it with the worker repository's settings, then run this again`);
  }
}

/** Builds the repo, then bundles and loads each Lambda `units` moves (scripts/lambda-load-check.ts); throws, changing nothing, if one does not load. */
export async function assertLambdasLoad(context: ApplyContext, units: readonly DeployUnit[]): Promise<void> {
  runNpmBuild(context);
  const entries = lambdaUnitsFor(units).map((unit) => ({ name: unit, entry: LAMBDAS[unit].entry }));
  console.log(`\n== lambda-load-check (${entries.length} bundle(s))`);
  const report = await checkLambdaBundles({ root: process.cwd(), entries });
  for (const result of report.results) console.log(`${result.status} ${result.name}: ${result.detail}`);
  if (!report.ok) throw lambdaLoadError(report);
}

/** Bundles one control-plane Lambda the way the release does and writes its zip; the zip's sha256 is what Lambda reports as CodeSha256 (base64). */
async function buildLambdaZip(context: ApplyContext, step: Extract<DeployStep, { kind: "build-lambda-zip" }>): Promise<{ sha256Hex: string; sha256Base64: string; inputs: string[] }> {
  runNpmBuild(context);
  const result = await bundle({
    ...LAMBDA_BUNDLE_OPTIONS, entryPoints: [step.entry], outfile: "index.js", write: false, metafile: true,
  });
  const file = (name: string) => {
    const output = result.outputFiles.find((candidate) => candidate.path.endsWith(`/${name}`));
    if (output === undefined) throw new Error(`esbuild produced no ${name} for ${step.entry}`);
    return Buffer.from(output.contents);
  };
  // The release bundle holds the handler, its source map and any extra files copied beside it.
  const zip = deterministicZip([
    { path: "index.js", data: file("index.js") },
    { path: "index.js.map", data: file("index.js.map") },
    ...(step.extraFiles ?? []).map((extra) => ({ path: extra.name, data: readFileSync(extra.from) })),
  ]);
  mkdirSync(join(step.zipPath, ".."), { recursive: true });
  writeFileSync(step.zipPath, zip);
  return { sha256Hex: sha256(zip).digest("hex"), sha256Base64: sha256(zip).digest("base64"), inputs: Object.keys(result.metafile.inputs) };
}

async function applyStep(context: ApplyContext, step: DeployStep): Promise<void> {
  console.log(`\n== ${step.id}`);
  switch (step.kind) {
    case "build-lambda-zip": {
      const { inputs: _inputs, ...built } = await buildLambdaZip(context, step);
      void _inputs;
      recordOutput(context, step.id, { zipPath: step.zipPath, ...built });
      console.log(`${step.zipPath} sha256 ${built.sha256Hex}`);
      return;
    }
    case "upload-artifact": {
      const built = context.outputs.get(step.from);
      if (built?.zipPath === undefined || built.sha256Hex === undefined) throw new Error(`step ${step.from} built nothing`);
      const bucket = resolveCodeArtifactBucket(context.runner, context.region, context.env, step.logicalId);
      const key = `${step.keyPrefix}${built.sha256Hex}.zip`;
      const version = putVerifiedObject(context, bucket, key, built.zipPath, "application/zip");
      recordOutput(context, step.id, { bucket, s3Key: key, s3ObjectVersion: version });
      return;
    }
    case "ecr-push": {
      // Only the repository the runtime stack already uses: ensureRepository would create or change one.
      const repository = step.repositoryUri.slice(step.repositoryUri.indexOf("/") + 1);
      const options = { ...context.options, repository };
      if (step.image === "executor") assertRepositoryExists(context, repository);
      const imageUri = await buildAndPushImage(context.runner, options, step.image === "worker"
        ? { repository, repositoryUri: step.repositoryUri, dockerfile: "environments/base/Dockerfile", localName: "agentx-worker", smokeTest: smokeTestWorker, tagPrefix: "test-" }
        : { repository, repositoryUri: step.repositoryUri, dockerfile: "environments/e2e-executor/Dockerfile", localName: "agentx-executor", smokeTest: smokeTestExecutor, tagPrefix: "test-" },
      step.revision);
      verifyRepositoryImage(context.runner, options, imageUri);
      recordOutput(context, step.id, { imageUri });
      console.log(imageUri);
      return;
    }
    case "create-change-set": return createChangeSet(context, step);
    case "execute-change-set": return executeChangeSet(context, step);
    case "verify-lambda-code": {
      const resource = (await context.cloudFormation.send(new DescribeStackResourceCommand({ StackName: step.stack, LogicalResourceId: step.logicalId }))).StackResourceDetail;
      const configuration = await context.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: resource?.PhysicalResourceId }));
      const expected = outputOf(context, step.expectedSha256Base64);
      if (configuration.CodeSha256 !== expected) throw new Error(`${step.logicalId} CodeSha256 ${configuration.CodeSha256} does not equal the zip's ${expected}`);
      console.log(`${step.logicalId} runs ${expected}`);
      return;
    }
    case "verify-stack-resources": {
      const created = context.outputs.get(step.createdBy);
      let logicalIds: string[] = (JSON.parse(created?.addedLogicalIds ?? "[]") as string[]).filter((logicalId) => logicalId.startsWith(step.logicalIdPrefix));
      if (logicalIds.length === 0 && created?.status === "no-changes") {
        // Already applied by an earlier run: find the resources it left by their prefix.
        const resources = await context.cloudFormation.send(new DescribeStackResourcesCommand({ StackName: step.stack }));
        logicalIds = (resources.StackResources ?? []).map((resource) => resource.LogicalResourceId ?? "").filter((logicalId) => logicalId.startsWith(step.logicalIdPrefix));
      }
      const described = async (logicalId: string) => (await context.cloudFormation.send(new DescribeStackResourceCommand({ StackName: step.stack, LogicalResourceId: logicalId }))).StackResourceDetail;
      const checked = await verifyStackResources(described, logicalIds, step.expectedStatus);
      console.log(`${checked.join(", ")} ${step.expectedStatus}`);
      return;
    }
    case "verify-stack-parameter": {
      const actual = (await describeStackSdk(context, step.stack)).Parameters?.find((parameter) => parameter.ParameterKey === step.key)?.ParameterValue;
      const expected = "literal" in step.expected ? step.expected.literal : outputOf(context, step.expected);
      if (actual !== expected) throw new Error(`${step.stack} ${step.key} is ${actual ?? "missing"}, not ${expected}`);
      console.log(`${step.key} is ${expected}`);
      return;
    }
    case "verify-lambda-environment": {
      const resource = (await context.cloudFormation.send(new DescribeStackResourceCommand({ StackName: step.stack, LogicalResourceId: step.logicalId }))).StackResourceDetail;
      const configuration = await context.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: resource?.PhysicalResourceId }));
      const actual = configuration.Environment?.Variables?.[step.key];
      if (actual !== step.expected.literal) throw new Error(`${step.logicalId} ${step.key} is ${actual ?? "not set"}, not ${step.expected.literal}`);
      console.log(`${step.logicalId} runs with ${step.key}=${actual}`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// --check: the read-only gatherer. Every AWS call below is one of CHECK_READ_VERBS, and the reader refuses any other before it reaches
// the CLI: cloudformation describe-stacks, get-template and list-stack-resources; lambda get-function; dynamodb query and scan (COUNT);
// ec2 describe-instances; iam get-role; s3api get-object; bedrock get-inference-profile and get-foundation-model-availability; and
// ssm get-parameter (no decryption), and service-quotas list-service-quotas for the Bedrock tokens-per-minute hint. The head synth and build are injected so the unit tests run without either.
// ---------------------------------------------------------------------------------------------

/** The catalog rows' key: the profile the web/API runtime registers its web and API rows under. */
const CATALOG_PROFILE_PREFIX = `PROFILE#${WEB_API_RUNTIME_PROFILE_ID}#`;
const CATALOG_ID_VARIABLE = "AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID";

/** The only AWS verbs `--check` runs, as `<service> <operation>`. Every one reads; no secret, no KMS, no model invocation. */
export const CHECK_READ_VERBS: ReadonlySet<string> = new Set([
  "cloudformation describe-stacks", "cloudformation get-template", "cloudformation list-stack-resources",
  "lambda get-function",
  "dynamodb query", "dynamodb scan",
  "ec2 describe-instances",
  "iam get-role",
  "s3api get-object",
  "bedrock get-inference-profile", "bedrock get-foundation-model-availability",
  "ssm get-parameter",
  "service-quotas list-service-quotas",
]);

/** The reader the check gathers through: it refuses any verb outside CHECK_READ_VERBS, so a later edit cannot add a write or a secret read by accident. */
export function readOnlyAws(runner: AwsReader): AwsReader {
  return {
    aws(args: readonly string[], allowFailure?: boolean) {
      const verb = `${args[0] ?? ""} ${args[1] ?? ""}`;
      if (!CHECK_READ_VERBS.has(verb)) throw new Error(`test-deploy --check is read-only and "aws ${verb.trim()}" is not a read it runs`);
      return runner.aws(args, allowFailure);
    },
  };
}

export interface CheckReaders {
  runner: AwsReader;
  region: string;
  env: string;
  /** The control-plane template head synthesizes. */
  headTemplate: () => CfnTemplate;
  /** The head build of every control-plane Lambda: its zip sha256 (base64) and the repo paths the bundle comes from, by logical ID. */
  builtZips: () => Promise<{ shas: Record<string, string>; sources: Record<string, string[]> }>;
  headRevision: string;
  /** Whether any of `paths` differs between `revision` and head; undefined when git cannot tell. */
  changedSince: (revision: string, paths: readonly string[]) => boolean | undefined;
}

type CheckFacts = Omit<Parameters<typeof evaluateTestDeployCheck>[0], "now">;

function awsJson<T>(readers: Pick<CheckReaders, "runner" | "region">, args: readonly string[], allowFailure = false): T | undefined {
  const result = readers.runner.aws([...args, "--region", readers.region, "--output", "json"], allowFailure);
  if (result.status !== 0) return undefined;
  return JSON.parse(result.stdout) as T;
}

/** The deployed Lambdas' CodeSha256 by logical ID, for every control-plane Lambda this script moves. list-stack-resources pages through all of them; describe-stack-resources stops at 100 and the stack has more. */
function deployedCodeShas(readers: CheckReaders, stack: string): Record<string, string> {
  const resources = awsJson<Array<[string, string]>>(readers, ["cloudformation", "list-stack-resources", "--stack-name", stack, "--query", "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].[LogicalResourceId,PhysicalResourceId]"]) ?? [];
  const physical = new Map(resources);
  const shas: Record<string, string> = {};
  for (const { logicalId } of Object.values(CONTROL_PLANE_LAMBDAS)) {
    const functionName = physical.get(logicalId);
    if (functionName === undefined) continue;
    const sha = awsJson<string>(readers, ["lambda", "get-function", "--function-name", functionName, "--query", "Configuration.CodeSha256"]);
    if (typeof sha === "string") shas[logicalId] = sha;
  }
  return shas;
}

interface CatalogRead extends CatalogRowFact {
  endpoint?: string;
}

/** The web and API rows of the web/API profile in the feature-verifier catalog. The state table is read directly: the admin API has no catalog read route. */
function readCatalogRows(readers: CheckReaders, table: string, catalogId: string): CatalogRead[] {
  const result = awsJson<{ Items?: Array<Record<string, { S?: string }>> }>(readers, [
    "dynamodb", "query", "--table-name", table, "--consistent-read",
    "--key-condition-expression", "pk = :pk AND begins_with(sk, :prefix)",
    "--expression-attribute-values", JSON.stringify({ ":pk": { S: `E2E_FEATURE_VERIFIER#${catalogId}` }, ":prefix": { S: CATALOG_PROFILE_PREFIX } }),
    "--expression-attribute-names", JSON.stringify({ "#s": "state" }),
    "--projection-expression", "sk, #s, expiresAt, endpoint",
  ]);
  if (result === undefined) throw new Error(`cannot read the feature-verifier catalog from ${table}`);
  return (result.Items ?? []).map((item) => ({
    sk: item.sk?.S ?? "", state: item.state?.S ?? "", expiresAt: item.expiresAt?.S ?? "",
    ...(item.endpoint?.S === undefined ? {} : { endpoint: item.endpoint.S }),
  }));
}

/**
 * The qualified runner's facts, from the status.json its qualification hook uploaded under `e2e-runtime/<worker role ID>:<instance ID>/`.
 * The instance is the running qualification worker at the web row's endpoint; nothing connects to it.
 */
function readRunnerFacts(readers: CheckReaders, input: { bucket: string; foundationStack: string; endpoint: string | undefined; deployedExecutorImage: string | undefined }): { facts: RunnerFacts | undefined; notes: string[] } {
  const none = (note: string) => ({ facts: undefined, notes: [note] });
  if (input.endpoint === undefined) return none("the catalog's web row has no endpoint, so no runner could be found");
  const host = /^https?:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/.exec(input.endpoint)?.[1];
  if (host === undefined) return none(`the catalog's web row endpoint ${input.endpoint} is not a private IP address, so no runner could be found`);
  const instances = awsJson<string[]>(readers, [
    "ec2", "describe-instances",
    "--filters", `Name=private-ip-address,Values=${host}`, "Name=tag:DeploymentMode,Values=e2e-qualification", "Name=instance-state-name,Values=running",
    "--query", "Reservations[].Instances[].InstanceId",
  ]) ?? [];
  const [instanceId] = instances;
  if (instances.length !== 1 || instanceId === undefined) return none(`${instances.length} running qualification instances have the private IP ${host}; expected exactly one`);
  const roleArn = stackOutput(describeStack(readers.runner, readers.region, input.foundationStack), "Ec2WorkerInstanceRoleArn");
  const roleId = awsJson<string>(readers, ["iam", "get-role", "--role-name", roleArn.slice(roleArn.lastIndexOf("/") + 1), "--query", "Role.RoleId"]);
  if (typeof roleId !== "string") return none(`the worker role ${roleArn} could not be read`);
  const key = `e2e-runtime/${roleId}:${instanceId}/status.json`;
  const file = join(mkdtempSync(join(tmpdir(), "test-deploy-check-")), "status.json");
  const fetched = readers.runner.aws(["s3api", "get-object", "--bucket", input.bucket, "--key", key, "--region", readers.region, file], true);
  if (fetched.status !== 0) return none(`s3://${input.bucket}/${key} could not be read: ${fetched.stderr.trim().slice(0, 200)}`);
  const status = parseRunnerStatus(readFileSync(file, "utf8"));
  if (status === undefined) return none(`s3://${input.bucket}/${key} is not a qualification status`);
  if (status.state !== "SUCCEEDED") return none(`the runner ${instanceId} qualification status is ${status.state} (${status.reason}), not SUCCEEDED`);
  return {
    facts: { deployedExecutorImage: input.deployedExecutorImage, executorImage: status.executorImage, invocationFeatures: status.invocationFeatures },
    notes: [`runner ${instanceId} (${host}) qualified: ${status.reason}`],
  };
}

/** The last line of a failed read-only call's stderr, bounded. */
const failureText = (stderr: string): string => stderr.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? "no error text";

/** `us.`, `eu.`, `apac.` and the other geography prefixes of a system-defined cross-region inference profile id; a foundation model id has none. */
const INFERENCE_PROFILE_ID = /^(us|us-gov|eu|apac|global|jp|au|ca)\./;

/**
 * Whether Bedrock lists the route's model for this account and region, from two control-plane reads: get-inference-profile (for a profile:
 * its status and the foundation models behind it; needs bedrock:GetInferenceProfile) and get-foundation-model-availability (authorization,
 * entitlement, agreement and region; needs bedrock:GetFoundationModelAvailability). These were chosen over list-foundation-models, which lists
 * every model Bedrock offers in the region whether or not the account may use it, and over any invocation, which this check must never make.
 * A denied or failing read is `unverifiable`, never a pass.
 */
function readModelAccess(readers: CheckReaders, route: E2EModelRoute): { access: ModelAccessFacts; profileArn: string | undefined; modelArns: string[] } {
  const read = (args: readonly string[]): { value: Record<string, unknown> } | { failure: ModelAccessFacts } => {
    const result = readers.runner.aws([...args, "--region", readers.region, "--output", "json"], true);
    if (result.status === 0) return { value: JSON.parse(result.stdout) as Record<string, unknown> };
    const text = failureText(result.stderr);
    // A model or profile Bedrock does not know is a definite answer; anything else (AccessDenied, throttling, no network) leaves it unknown.
    return { failure: /ResourceNotFound|ValidationException/.test(text) && !/AccessDenied/.test(text) ? { state: "not-found", detail: text } : { state: "unverifiable", reason: text } };
  };
  // The e2e default on Bedrock is always a geography inference profile (a test pins that): its status, and the foundation models in every Region it routes to.
  const profile = read(["bedrock", "get-inference-profile", "--inference-profile-identifier", route.modelId]);
  if ("failure" in profile) return { access: profile.failure, profileArn: undefined, modelArns: [] };
  const profileStatus = typeof profile.value.status === "string" ? profile.value.status : "UNKNOWN";
  const profileArn = typeof profile.value.inferenceProfileArn === "string" ? profile.value.inferenceProfileArn : undefined;
  const modelArns = (Array.isArray(profile.value.models) ? profile.value.models : [])
    .flatMap((entry) => typeof (entry as { modelArn?: unknown }).modelArn === "string" ? [(entry as { modelArn: string }).modelArn] : []);
  const modelIds = [...new Set(modelArns.map((arn) => arn.slice(arn.indexOf("foundation-model/") + "foundation-model/".length)).filter((id) => id !== ""))];
  const models: ModelAvailabilityFact[] = [];
  for (const modelId of modelIds) {
    const availability = read(["bedrock", "get-foundation-model-availability", "--model-id", modelId]);
    if ("failure" in availability) return { access: availability.failure, profileArn, modelArns };
    const text = (key: string) => (typeof availability.value[key] === "string" ? availability.value[key] : undefined);
    const agreement = (availability.value.agreementAvailability as { status?: unknown } | undefined)?.status;
    models.push({
      modelId, authorizationStatus: text("authorizationStatus"), entitlementAvailability: text("entitlementAvailability"), regionAvailability: text("regionAvailability"),
      agreementStatus: typeof agreement === "string" ? agreement : undefined,
    });
  }
  return { access: { state: "checked", profileStatus, models }, profileArn, modelArns };
}

/**
 * Whether the broker's route registry holds the route. Task 4.2 keeps `E2E_MODEL_ROUTE_LATEST#<routeId>` rows in the state table under the
 * project's partition key, and the check does not know the project, so it counts rows by sort key with a filtered scan (read-only).
 */
function readRouteApproval(readers: CheckReaders, table: string, routeId: string): ModelRouteCheck["approval"] {
  const result = readers.runner.aws([
    "dynamodb", "scan", "--table-name", table, "--select", "COUNT",
    "--filter-expression", "sk = :sk", "--expression-attribute-values", JSON.stringify({ ":sk": { S: `E2E_MODEL_ROUTE_LATEST#${routeId}` } }),
    "--region", readers.region, "--output", "json",
  ], true);
  if (result.status !== 0) return { unreadable: failureText(result.stderr) };
  return { approved: ((JSON.parse(result.stdout) as { Count?: number }).Count ?? 0) > 0 };
}

/**
 * One worker setting from SSM (`/agentx/<env>/<name>`), through `ssm get-parameter` without decryption: these settings hold an id or an ARN,
 * never a secret. A parameter that does not exist reads as no value; a denied or failed read is unverifiable, never a pass.
 */
function readWorkerSetting(readers: CheckReaders, name: string): SettingFact {
  const result = readers.runner.aws(["ssm", "get-parameter", "--name", `${environmentSettingsPrefix(readers.env)}${name}`, "--region", readers.region, "--output", "json"], true);
  if (result.status === 0) {
    const value = (JSON.parse(result.stdout) as { Parameter?: { Value?: unknown } }).Parameter?.Value;
    return { state: "read", value: typeof value === "string" ? value : undefined };
  }
  const text = failureText(result.stderr);
  return /ParameterNotFound/.test(text) && !/AccessDenied/.test(text) ? { state: "read", value: undefined } : { state: "unverifiable", reason: text };
}

/**
 * The Bedrock tokens-per-minute quotas of the route's model, from `service-quotas list-service-quotas` (needs servicequotas:ListServiceQuotas on the operator profile): a hint.
 * A denied or failed read is `unverifiable`, which is information in the check, never an error.
 */
function readBedrockQuotas(readers: CheckReaders, route: E2EModelRoute): QuotaFacts {
  const result = readers.runner.aws([
    "service-quotas", "list-service-quotas", "--service-code", "bedrock",
    "--query", "Quotas[?contains(QuotaName, 'tokens per minute')].[QuotaCode,QuotaName,Value]", "--region", readers.region, "--output", "json",
  ], true);
  if (result.status !== 0) return { state: "unverifiable", reason: failureText(result.stderr) };
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { return { state: "unverifiable", reason: "the answer was not JSON" }; }
  if (!Array.isArray(parsed)) return { state: "unverifiable", reason: "the answer was not a list of quotas" };
  const rows = parsed.flatMap((row): Array<[string, string, number]> => Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "string" && typeof row[2] === "number" ? [[row[0], row[1], row[2]]] : []);
  return { state: "read", ...matchBedrockQuotas(rows, route, eligibleE2EAgentModel("amazon-bedrock", route.modelId, readers.region)?.label) };
}

/** One row of the broker's registry partition by key (`dynamodb query`, consistent, read-only): its item as DynamoDB JSON, undefined when absent, or why it could not be read. */
function readRegistryRow(readers: CheckReaders, table: string, sk: string, projection: string, names: Record<string, string>): { item: Record<string, { S?: string }> | undefined } | { unreadable: string } {
  const result = readers.runner.aws([
    "dynamodb", "query", "--table-name", table, "--consistent-read", "--key-condition-expression", "pk = :pk AND sk = :sk",
    "--expression-attribute-values", JSON.stringify({ ":pk": { S: "E2E_MODEL_ROUTES" }, ":sk": { S: sk } }),
    ...(Object.keys(names).length === 0 ? [] : ["--expression-attribute-names", JSON.stringify(names)]), "--projection-expression", projection, "--region", readers.region, "--output", "json",
  ], true);
  if (result.status !== 0) return { unreadable: failureText(result.stderr) };
  return { item: (JSON.parse(result.stdout) as { Items?: Array<Record<string, { S?: string }>> }).Items?.[0] };
}

/**
 * Whether a passing driving test exists for the exact definition the installation would approve (Task 4.10): the broker's `E2E_MODEL_ROUTE_CANARY#<routeId>#<digest>` row with
 * `test: "driving/v1"`, where the digest is the one the broker derives from this installation's settings and the recorded request shape. A route that cannot be derived is judged
 * by the other findings, not here.
 */
function readRouteTested(readers: CheckReaders, input: { table: string; installation: Parameters<typeof deriveE2EAgentRoute>[0] }): ModelRouteCheck["tested"] {
  const modelId = input.installation.e2eModel ?? DEFAULT_E2E_AGENT_MODELS_FOR(input.installation.provider);
  if (modelId === undefined) return undefined;
  const shape = readRegistryRow(readers, input.table, `E2E_MODEL_ROUTE_SHAPE#${E2E_MODEL_ROUTE_ID}#${modelId}`, "payloadShape", {});
  if ("unreadable" in shape) return { unreadable: shape.unreadable };
  const payloadShape = shape.item?.payloadShape?.S;
  const derived = deriveE2EAgentRoute({ ...input.installation, ...(payloadShape === "minimal" ? { payloadShape: "minimal" as const } : {}) });
  if (derived.status === "unavailable") return undefined;
  const row = readRegistryRow(readers, input.table, `E2E_MODEL_ROUTE_CANARY#${E2E_MODEL_ROUTE_ID}#${e2eAgentRouteDefinitionDigest(derived.definition)}`, "#t", { "#t": "test" });
  if ("unreadable" in row) return { unreadable: row.unreadable };
  return { tested: row.item?.test?.S === "driving/v1" };
}

const DEFAULT_E2E_AGENT_MODELS_FOR = (provider: string | undefined): string | undefined =>
  provider !== undefined && (MODEL_PROVIDERS as readonly string[]).includes(provider) ? E2E_AGENT_RECOMMENDED_MODELS[provider as ModelProvider] : undefined;

/**
 * The route's checks, for the installation's provider: approval, the installation's choice of AI navigation model (`worker-e2e-agent-model`; a model the table does not list is
 * `model-route-choice-unsupported`), whether the route has a passing driving test, and either Bedrock (reads only, with the tokens-per-minute hint) or the keyed provider's secret
 * ARN, with the worker instance role's grants.
 */
export function readModelRoute(readers: CheckReaders, input: { table: string; foundationStack: string; roleArn: string; controlPlaneTemplate: CfnTemplate; controlPlaneParameters: Record<string, string> }): ModelRouteCheck {
  const approval = (routeId: string) => readRouteApproval(readers, input.table, routeId);
  const providerSetting = readWorkerSetting(readers, WORKER_SETTING_PARAMETERS.modelProvider);
  if (providerSetting.state === "unverifiable") return { provider: { state: "unverifiable", reason: `worker-model-provider could not be read: ${providerSetting.reason}` }, approval: approval(E2E_MODEL_ROUTE_ID) };
  const provider = providerSetting.value?.trim();
  if (provider === undefined || !(MODEL_PROVIDERS as readonly string[]).includes(provider)) {
    return { provider: { state: "unverifiable", reason: provider === undefined ? "the worker-model-provider setting does not exist" : `worker-model-provider is ${JSON.stringify(provider)}, which is not one of ${MODEL_PROVIDERS.join(", ")}` }, approval: approval(E2E_MODEL_ROUTE_ID) };
  }
  const modelProvider = provider as ModelProvider;
  const choiceSetting = readWorkerSetting(readers, WORKER_SETTING_PARAMETERS.e2eAgentModel);
  const choice: ModelChoiceFacts = choiceSetting.state === "unverifiable"
    ? { state: "unverifiable", reason: `worker-e2e-agent-model could not be read: ${choiceSetting.reason}` }
    : e2eModelChoice(modelProvider, choiceSetting.value, readers.region);
  const route = deriveE2EModelRoute(modelProvider, choice.state === "chosen" ? choice.modelId : undefined);
  const foundationTemplate = deployedTemplateOf(readers.runner, readers.region, input.foundationStack);
  const output = (foundationTemplate as { Outputs?: Record<string, { Value?: { "Fn::GetAtt"?: unknown } }> }).Outputs?.Ec2WorkerInstanceRoleArn?.Value?.["Fn::GetAtt"];
  const roleLogicalId = Array.isArray(output) && typeof output[0] === "string" ? output[0] : undefined;
  if (roleLogicalId === undefined) throw new Error(`${input.foundationStack}'s Ec2WorkerInstanceRoleArn output is not a GetAtt of a role, so the worker instance role cannot be found in its template`);
  // The installation as the broker reads it, for the digest of the definition it would approve: the secret ARN of a keyed provider and OpenRouter's allowlist are settings too.
  const keyedSettings = isKeyedModelProvider(route.provider) ? {
    secretArn: readWorkerSetting(readers, WORKER_SETTING_PARAMETERS[KEYED_MODEL_PROVIDERS[route.provider].workerSetting]),
    ...(route.provider === "openrouter" ? { openRouterProviders: readWorkerSetting(readers, WORKER_SETTING_PARAMETERS.openRouterProviders) } : {}),
  } : undefined;
  const settingValue = (fact: SettingFact | undefined): string | undefined => (fact?.state === "read" && fact.value !== undefined && fact.value.trim() !== "" && fact.value !== "none" ? fact.value.trim() : undefined);
  const installation = {
    provider: modelProvider, region: readers.region,
    ...(settingValue(keyedSettings?.secretArn) === undefined ? {} : { secretArn: settingValue(keyedSettings?.secretArn)! }),
    ...(settingValue(keyedSettings?.openRouterProviders) === undefined ? {} : { openRouterProviders: settingValue(keyedSettings?.openRouterProviders)! }),
    ...(choice.state === "chosen" ? { e2eModel: choice.modelId } : {}),
  };
  const tested = choice.state === "unsupported" || choice.state === "unverifiable" ? undefined : readRouteTested(readers, { table: input.table, installation });
  const [, partition = "aws", , , accountId = ""] = input.roleArn.split(":");
  const roleName = input.roleArn.slice(input.roleArn.lastIndexOf("/") + 1);
  // An unsupported or unreadable choice has no route to look at: the finding says so, and nothing else about it is read.
  if (choice.state === "unsupported" || choice.state === "unverifiable") return { choice, provider: { state: "known", route }, approval: approval(route.routeId) };
  if (isKeyedModelProvider(route.provider) && keyedSettings !== undefined) {
    return {
      choice, tested, provider: { state: "known", route }, approval: approval(route.routeId),
      keyed: {
        secretArn: keyedSettings.secretArn,
        ...(keyedSettings.openRouterProviders === undefined ? {} : { openRouterProviders: keyedSettings.openRouterProviders }),
        iam: {
          foundationTemplate, roleLogicalId, roleName, controlPlaneTemplate: input.controlPlaneTemplate,
          scope: { partition, region: readers.region, accountId, parameters: input.controlPlaneParameters },
        },
      },
    };
  }
  const scope = { partition, region: readers.region, accountId };
  const { access, profileArn, modelArns } = readModelAccess(readers, route);
  // What the route invokes: the profile (when it uses one) and each foundation model behind it, in every Region the profile routes to.
  // Without Bedrock's answer, the profile's own ARN and the model in this region.
  const profileResource = [profileArn ?? `arn:${partition}:bedrock:${readers.region}:${accountId}:inference-profile/${route.modelId}`];
  const modelResources = modelArns.length > 0 ? modelArns : [`arn:${partition}:bedrock:${readers.region}::foundation-model/${route.modelId.replace(INFERENCE_PROFILE_ID, "")}`];
  return {
    choice, tested, quota: readBedrockQuotas(readers, route),
    provider: { state: "known", route }, approval: approval(route.routeId),
    bedrock: { access, iam: { foundationTemplate, roleLogicalId, resources: [...new Set([...profileResource, ...modelResources])], scope } },
  };
}

/** Everything `evaluateTestDeployCheck` needs but the time, read from the live installation and the head build. */
export async function gatherCheckFacts(unchecked: CheckReaders): Promise<{ facts: CheckFacts; notes: string[] }> {
  const readers: CheckReaders = { ...unchecked, runner: readOnlyAws(unchecked.runner) };
  const stacks = resolveTestStacks(readers.env);
  const controlPlane = describeStack(readers.runner, readers.region, stacks["control-plane"]);
  const deployedTemplate = deployedTemplateOf(readers.runner, readers.region, stacks["control-plane"]);
  const catalogId = (deployedTemplate.Resources?.[CONTROL_PLANE_LAMBDAS.broker.logicalId]?.Properties?.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables?.[CATALOG_ID_VARIABLE];
  if (typeof catalogId !== "string") throw new Error(`the deployed Broker has no literal ${CATALOG_ID_VARIABLE}, so the feature-verifier catalog cannot be found`);
  const catalog = readCatalogRows(readers, stackOutput(controlPlane, "StateTableName"), catalogId);
  const deployedExecutorImage = stackParameter(describeStack(readers.runner, readers.region, stacks.runtime), EXECUTOR_IMAGE_PARAMETER);
  const web = catalog.find((row) => row.sk.endsWith("#web"));
  const runner = readRunnerFacts(readers, { bucket: stackOutput(controlPlane, "ArtifactBucketName"), foundationStack: environmentStackName(readers.env, "foundation"), endpoint: web?.endpoint, deployedExecutorImage });
  const foundationStack = environmentStackName(readers.env, "foundation");
  const controlPlaneParameters: Record<string, string> = {};
  for (const parameter of controlPlane.Parameters ?? []) if (parameter.ParameterKey) controlPlaneParameters[parameter.ParameterKey] = parameter.ParameterValue ?? "";
  const modelRoute = readModelRoute(readers, {
    table: stackOutput(controlPlane, "StateTableName"), foundationStack,
    roleArn: stackOutput(describeStack(readers.runner, readers.region, foundationStack), "Ec2WorkerInstanceRoleArn"),
    controlPlaneTemplate: deployedTemplate, controlPlaneParameters,
  });
  const lambdaCodeShas = deployedCodeShas(readers, stacks["control-plane"]);
  const built = await readers.builtZips();
  // Only a Lambda whose zip differs from head's, and whose key proves where its code came from, needs a look at what changed since.
  const inputsChanged: Record<string, boolean | undefined> = {};
  for (const [logicalId, sha] of Object.entries(built.shas)) {
    const deployedSha = lambdaCodeShas[logicalId];
    if (deployedSha === undefined || deployedSha === sha) continue;
    const key = (deployedTemplate.Resources?.[logicalId]?.Properties?.Code as { S3Key?: unknown } | undefined)?.S3Key;
    const provenance = parseDeployedCodeKey(typeof key === "string" ? key : undefined, logicalId, deployedSha);
    if ("revision" in provenance) inputsChanged[logicalId] = readers.changedSince(provenance.revision, built.sources[logicalId] ?? []);
  }
  const headTemplate = readers.headTemplate();
  return {
    facts: {
      headTemplate,
      deployedTemplate,
      lambdaCodeShas,
      builtZipShas: built.shas,
      headRevision: readers.headRevision,
      inputsChanged,
      catalogRows: catalog.map(({ sk, state, expiresAt }) => ({ sk, state, expiresAt })),
      runnerFacts: runner.facts,
      modelRoute,
    },
    notes: [...runner.notes, ...iamEvaluationNotes(headTemplate, deployedTemplate)],
  };
}

/**
 * Refuses a deploy of Lambda code that cannot work on the deployed function: a role one of its Lambdas runs as lacks a grant head needs, or the
 * function lacks an environment variable head sets. The new code would run and fail (AccessDenied as SessionsSteps did in the M1.2 demo, or a
 * missing setting), and a code-only change set can fix neither. The message carries the statements for a Tier 3 request. IAM is never applied here.
 */
export function assertCheckAllowsApply(findings: readonly Finding[], units: readonly DeployUnit[], headTemplate: CfnTemplate): void {
  const roles = lambdaRoleIds(headTemplate);
  const moving = lambdaUnitsFor(units).map((unit) => LAMBDAS[unit].logicalId);
  const deployingRoles = new Set(moving.flatMap((logicalId) => roles[logicalId] ?? []));
  const grants = findings.filter((finding) => finding.kind === "iam-missing-grant" && finding.roleLogicalId !== undefined && deployingRoles.has(finding.roleLogicalId));
  const environments = findings.filter((finding) => finding.kind === "lambda-env-missing" && moving.includes(finding.subject));
  if (grants.length + environments.length === 0) return;
  const named = [...new Set([
    ...grants.map((finding) => `${finding.kind} ${finding.label} (needs Tier 3 approval)`),
    ...environments.map((finding) => `${finding.kind} ${finding.label} (needs a control-plane stack update: ${(finding.missing ?? []).join(", ")})`),
  ])];
  const details = [
    ...(grants.length === 0 ? [] : [`Tier 3 request, the exact statements to add (this script never applies IAM):\n${tier3Request(grants)}`]),
    ...environments.map((finding) => finding.message),
  ];
  throw new Error(`deploy check failed: ${named.join("; ")}\n\n${details.join("\n\n")}`);
}

function builtLambdaZips(context: ApplyContext): CheckReaders["builtZips"] {
  return async () => {
    const shas: Record<string, string> = {};
    const sources: Record<string, string[]> = {};
    for (const unit of LAMBDA_UNITS) {
      const step = buildStepFor(unit, join(context.outputDir, `${unit}-${context.revision}.zip`));
      const built = await buildLambdaZip(context, step);
      shas[step.logicalId] = built.sha256Base64;
      sources[step.logicalId] = sourcePathsFor(built.inputs, (step.extraFiles ?? []).map((extra) => extra.from));
    }
    return { shas, sources };
  };
}

/** `git diff --quiet <revision> HEAD -- <paths>`: 0 is unchanged, 1 changed, anything else (an unknown revision) is that git cannot tell. */
function gitChangedSince(runner: Runner): CheckReaders["changedSince"] {
  return (revision, paths) => {
    const result = runner.capture("git", ["diff", "--quiet", revision, "HEAD", "--", "package-lock.json", ...paths], true);
    return result.status === 0 ? false : result.status === 1 ? true : undefined;
  };
}

/** Head's control-plane template: the engine's synth with the standing qualification transport, as TEST runs it. */
function synthesizeHeadTemplate(context: ApplyContext, identityMode: IdentityMode): CfnTemplate {
  return synthesizeLiftSource(context, { construct: QUALIFICATION.construct, cdkContext: QUALIFICATION.context, identityMode });
}

function checkContext(args: TestDeployArgs, runner: Runner, options: ReleaseOptions, revision: string, outputDir: string): ApplyContext {
  return {
    runner, options, region: args.region, env: args.env, revision,
    cloudFormation: new CloudFormationClient({ region: args.region, profile: args.profile }),
    lambda: new LambdaClient({ region: args.region, profile: args.profile }),
    outputs: new Map(), built: false, outputDir,
  };
}

function currentParameters(runner: Runner, region: string, stack: string): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const parameter of describeStack(runner, region, stack).Parameters ?? []) if (parameter.ParameterKey) parameters[parameter.ParameterKey] = parameter.ParameterValue ?? "";
  return parameters;
}

/** The check found problems (as opposed to being unable to run): exit 1. */
export class DeployCheckFindingsError extends Error {
  constructor(readonly errors: number) {
    super(`TEST deploy check failed: ${errors} problem(s) above`);
  }
}

/** Exit 1 for findings, 2 when `--check` could not run (an unreadable stack, a git or build failure, a bad option), 1 for a failure of any other mode. */
export function checkExitCode(argv: readonly string[], error: unknown): number {
  if (error instanceof DeployCheckFindingsError) return 1;
  return argv.includes("--check") ? 2 : 1;
}

/** The machine-readable report of a check. */
export function checkReport(result: CheckResult, notes: readonly string[], context: { env: string; revision: string }) {
  const count = (severity: Finding["severity"]) => result.findings.filter((finding) => finding.severity === severity).length;
  return { ok: result.ok, env: context.env, revision: context.revision, errors: count("error"), warnings: count("warning"), infos: count("info"), findings: result.findings, notes: [...notes] };
}

/** `--check`: gathers the facts read-only, prints every finding, and fails when one is an error. */
async function runCheck(args: TestDeployArgs, runner: Runner, options: ReleaseOptions, build: { revision: string; identityMode: IdentityMode; outputDir: string }): Promise<void> {
  // With --json stdout ends in the report; everything else this script prints goes to stderr.
  const say = args.json ? (text: string) => console.error(text) : (text: string) => console.log(text);
  if (runner.capture("git", ["status", "--porcelain"]).stdout.trim() !== "") throw new Error("the working tree is dirty; commit first so the check compares the deployed code with the head build");
  say(`TEST deploy check for ${args.env} (${args.region}), revision ${build.revision}`);
  const context = checkContext(args, runner, options, build.revision, build.outputDir);
  const { facts, notes } = await gatherCheckFacts({
    runner, region: args.region, env: args.env,
    headTemplate: () => synthesizeHeadTemplate(context, build.identityMode),
    builtZips: builtLambdaZips(context),
    headRevision: build.revision,
    changedSince: gitChangedSince(runner),
  });
  for (const note of notes) say(note);
  const result = evaluateTestDeployCheck({ ...facts, now: new Date(), renewCommand: e2eRuntimeRenewCommand({ env: args.env, profile: args.profile }) });
  say(`\n${formatFindings(result.findings)}`);
  const request = tier3Request(result.findings);
  if (request !== "") say(`\nTier 3 request, the exact statements to add (this script never applies IAM):\n${request}`);
  if (args.json) console.log(JSON.stringify(checkReport(result, notes, { env: args.env, revision: build.revision })));
  if (!result.ok) throw new DeployCheckFindingsError(result.findings.filter((finding) => finding.severity === "error").length);
  say("\nTEST deploy check passed.");
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseTestDeployArgs(argv);
  if (!loadAllowlist().includes(args.env)) throw new Error(ALLOWLIST_ERROR);
  const options: ReleaseOptions = { region: args.region, repository: "", profile: args.profile, allowDirty: false, skipChecks: false, dryRun: !args.apply };
  const runner = new Runner(options);
  const revision = runner.capture("git", ["rev-parse", "HEAD"]).stdout.trim();
  // The identity stack exists only for a Cognito environment; the engine's synth context differs for an own-OIDC one.
  const identityMode = stackExists(runner, args.region, environmentStackName(args.env, "identity")) ? "cognito" : "oidc";
  const outputDir = join(tmpdir(), `test-deploy-${revision.slice(0, 12)}`);
  if (args.check) return runCheck(args, runner, options, { revision, identityMode, outputDir });
  const stacks = resolveTestStacks(args.env);
  const needsRuntime = args.only.includes("worker-image") || args.only.includes("executor-image") || args.only.includes("e2e-agent-model") || args.only.includes("model-fallback-settings");
  const previous: StackParameters = {
    "control-plane": currentParameters(runner, args.region, stacks["control-plane"]),
    runtime: needsRuntime ? currentParameters(runner, args.region, stacks.runtime) : {},
  };
  const steps = planTestDeploy({ env: args.env, only: args.only, artifacts: { revision, outputDir }, previous, identityMode, region: args.region, ...(args.e2eModel === undefined ? {} : { e2eModel: args.e2eModel }) });
  console.log(`TEST deploy plan for ${args.env} (${args.region}), revision ${revision}\n${formatPlan(steps)}`);
  if (!args.apply) {
    console.log("\nDry run: nothing was changed. Add --apply to run this plan.");
    return;
  }
  if (runner.capture("git", ["status", "--porcelain"]).stdout.trim() !== "") throw new Error("the working tree is dirty; commit first so the deployed bytes match the revision");
  const context = checkContext(args, runner, options, revision, outputDir);
  // Before anything is pushed or changed: new Lambda code must not go onto a role that lacks a grant head needs.
  if (steps.some((step) => step.kind === "build-lambda-zip")) {
    const headTemplate = synthesizeHeadTemplate(context, identityMode);
    const deployedTemplate = deployedTemplateOf(runner, args.region, resolveTestStacks(args.env)["control-plane"]);
    const drift = [...evaluateIamDrift(headTemplate, deployedTemplate), ...evaluateEnvironmentDrift(headTemplate, deployedTemplate)];
    console.log(`\n${formatFindings(drift)}`);
    assertCheckAllowsApply(drift, args.only, headTemplate);
  }
  // Also before anything is pushed or changed: every Lambda this deploy moves must load. A bundle that crashes at init (acb278a1: import.meta in
  // CJS) would otherwise replace working code on TEST, and a code-only change set has nothing that stops it.
  if (steps.some((step) => step.kind === "build-lambda-zip")) await assertLambdasLoad(context, args.only);
  for (const step of steps) await applyStep(context, step);
  console.log("\nTEST deploy complete.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = checkExitCode(process.argv.slice(2), error);
  });
}
