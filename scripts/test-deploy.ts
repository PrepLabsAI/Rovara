// One-command, plan-first deploy of a build to an allowlisted TEST installation.
//
//   npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test [--apply]
//     [--only broker,dispatcher,worker-image,executor-image,qualification-transport]
//
// Without --apply it prints the plan and exits 0 (it only reads: DescribeStacks for the current
// parameters). With --apply it runs the plan. The plan reproduces the P0 TEST procedure: every
// CloudFormation step is a change set that changes only the named Lambda code, image parameter or
// added resource, and sets every other parameter to UsePreviousValue. A change set whose changes
// are not exactly the expected ones is deleted, never executed. Credentials come from
// `aws login --profile <profile>` only.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStackResourceCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  type Change,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { GetFunctionConfigurationCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { build as bundle } from "esbuild";
import { CDK_CONSTRUCT_IDS, cdkAppArguments } from "../packages/cli/src/deploy/cdk-engine.js";
import { environmentStackName } from "../packages/contracts/src/environments.js";
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
  verifyRepositoryImage,
  type ReleaseOptions,
} from "./release-common.js";
import { deterministicZip } from "./release/zip.js";

export type DeployUnit = "broker" | "dispatcher" | "worker-image" | "executor-image" | "qualification-transport";
export const DEPLOY_UNITS: readonly DeployUnit[] = ["broker", "dispatcher", "worker-image", "executor-image", "qualification-transport"];
const DEFAULT_UNITS: readonly DeployUnit[] = ["broker", "dispatcher", "worker-image"];
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
export type ParameterSpec = { key: string; usePreviousValue: true } | { key: string; value: StepRef };

export interface ChangeExpectation {
  action: "Add" | "Modify";
  logicalIds?: readonly string[];
  logicalIdPrefixes?: readonly string[];
  /** Modify only: the only attributes (as `Properties.<Name>`) the change may touch. */
  allowedAttributes?: readonly string[];
}
export interface ObservedChange {
  action: string;
  logicalId: string;
  type?: string;
  replacement?: string;
  attributes?: readonly string[];
}

export type IdentityMode = "cognito" | "oidc";
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
    };

export type DeployStep =
  | { id: string; kind: "build-lambda-zip"; unit: "broker" | "dispatcher"; logicalId: string; entry: string; zipPath: string }
  | { id: string; kind: "upload-artifact"; bucketFromStack: StackKind; from: string; keyPrefix: string }
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
  | { id: string; kind: "verify-stack-parameter"; stack: string; key: string; expected: StepRef };

const LAMBDAS = {
  broker: { logicalId: "BrokerE1355FD6", entry: "packages/broker/src/aws/broker.ts" },
  dispatcher: { logicalId: "DispatcherD4A12972", entry: "packages/broker/src/aws/dispatcher.ts" },
} as const;
const QUALIFICATION = { logicalIdPrefix: "E2eQualificationTransport", construct: CDK_CONSTRUCT_IDS["control-plane"], context: { "agentx:e2eQualificationTransport": "enabled" } } as const;
const WORKER_IMAGE_PARAMETER = "WorkerImageUri";
const EXECUTOR_IMAGE_PARAMETER = "ExecutorImageUri";
const EXECUTOR_SETTING = { logicalIdPrefix: "WorkerExecutorImageParameter", construct: CDK_CONSTRUCT_IDS.runtime } as const;

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

export function planTestDeploy(
  input: { env: string; only: DeployUnit[]; artifacts: BuiltArtifacts; previous: StackParameters; identityMode?: IdentityMode },
  allowlist: readonly string[] = loadAllowlist(),
): DeployStep[] {
  if (!allowlist.includes(input.env)) throw new Error(ALLOWLIST_ERROR);
  const units = DEPLOY_UNITS.filter((unit) => input.only.includes(unit));
  if (units.length === 0) throw new Error("nothing to deploy: --only names no deploy unit");
  const identityMode = input.identityMode ?? "cognito";
  if (units.includes("qualification-transport") && units.some((unit) => unit === "broker" || unit === "dispatcher")) {
    throw new Error("qualification-transport changes the control-plane template; run it on its own, apart from broker and dispatcher");
  }
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

  const lambdas = (["broker", "dispatcher"] as const).filter((unit) => units.includes(unit));
  if (lambdas.length > 0) {
    for (const unit of lambdas) {
      const { logicalId, entry } = LAMBDAS[unit];
      steps.push(
        { id: `build-${unit}`, kind: "build-lambda-zip", unit, logicalId, entry, zipPath: join(input.artifacts.outputDir, `${unit}-${revision}.zip`) },
        { id: `upload-${unit}`, kind: "upload-artifact", bucketFromStack: "control-plane", from: `build-${unit}`, keyPrefix: `test-deploy/${revision}/${logicalId}-` },
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
        expect: { action: "Modify", logicalIds, allowedAttributes: ["Properties.Code"] },
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

/** Throws, listing every change that is not an expected one, when a change set holds more than it should. */
export function assertOnlyExpectedChanges(changes: readonly ObservedChange[], expected: ChangeExpectation): void {
  if (changes.length === 0) throw new Error("the change set has no changes; nothing to apply");
  const matchesId = (logicalId: string) =>
    (expected.logicalIds ?? []).includes(logicalId) || (expected.logicalIdPrefixes ?? []).some((prefix) => logicalId.startsWith(prefix));
  const problems: string[] = [];
  for (const change of changes) {
    const label = `${change.action} ${change.logicalId}${change.type ? ` (${change.type})` : ""}`;
    if (change.action !== expected.action || !matchesId(change.logicalId)) {
      problems.push(label);
      continue;
    }
    if (change.replacement !== undefined && change.replacement !== "" && change.replacement !== "False") problems.push(`${label}: would replace the resource (Replacement ${change.replacement})`);
    if (expected.allowedAttributes !== undefined) {
      const attributes = change.attributes ?? [];
      const extra = attributes.filter((attribute) => !(expected.allowedAttributes ?? []).includes(attribute));
      if (attributes.length === 0) problems.push(`${label}: changed attributes are not reported, so they cannot be checked`);
      else if (extra.length > 0) problems.push(`${label}: also changes ${extra.join(", ")}`);
    }
  }
  for (const logicalId of expected.logicalIds ?? []) {
    if (!changes.some((change) => change.logicalId === logicalId && change.action === expected.action)) problems.push(`missing the expected ${expected.action} ${logicalId}`);
  }
  if (problems.length > 0) throw new Error(`the change set holds unexpected changes: ${problems.join("; ")}`);
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

/** The arguments of `npx cdk synth <construct>` for a lifted template: the profile, and the app and context the repo's deploy engine passes. */
export function liftSynthArguments(
  plan: Extract<TemplatePlan, { source: "lift-resources" }>,
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

export interface ChangeSetExecutionState {
  ExecutionStatus?: string | undefined;
  StatusReason?: string | undefined;
}

/**
 * Waits for one change set's own execution to complete. It reads the change set's ExecutionStatus and nothing else: a stack that
 * already says UPDATE_COMPLETE from an earlier deploy is never taken as this change set's success. AVAILABLE and EXECUTE_IN_PROGRESS
 * keep waiting (right after ExecuteChangeSet the status may still read AVAILABLE); every other status but EXECUTE_COMPLETE is an error.
 */
export async function waitForChangeSetExecution(
  describe: () => Promise<ChangeSetExecutionState>,
  options: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<void> {
  const { timeoutMs = 30 * 60_000, intervalMs = 5_000, sleep: wait = sleep, now = Date.now } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const { ExecutionStatus: status, StatusReason: reason } = await describe();
    if (status === "EXECUTE_COMPLETE") return;
    if (status === "EXECUTE_FAILED" || status === "UNAVAILABLE" || status === "OBSOLETE") {
      throw new Error(`the change set ended ${status}${reason ? `: ${reason}` : ""}; read the stack's events in CloudFormation`);
    }
    if (status !== "AVAILABLE" && status !== "EXECUTE_IN_PROGRESS") throw new Error(`the change set reports ${status ?? "no execution status"}, which is not one this deploy knows`);
    if (now() > deadline) throw new Error(`the change set is still ${status} after ${Math.round(timeoutMs / 60_000)} minutes; check CloudFormation`);
    await wait(intervalMs);
  }
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
  only: DeployUnit[];
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
  const { values, flags } = parseOptions(argv, { values: ["--env", "--profile", "--region", "--only"], flags: ["--apply"] });
  const env = values.get("--env");
  if (env === undefined) throw new Error("--env is required");
  const profile = values.get("--profile");
  if (profile === undefined) throw new Error("--profile is required");
  const onlyValue = values.get("--only");
  const only = onlyValue === undefined ? [...DEFAULT_UNITS] : onlyValue.split(",").map((name) => {
    const unit = DEPLOY_UNITS.find((candidate) => candidate === name.trim());
    if (unit === undefined) throw new Error(`unknown deploy unit ${name}; expected one of ${DEPLOY_UNITS.join(", ")}`);
    return unit;
  });
  return { env, profile, region: values.get("--region") ?? DEFAULT_REGION, apply: flags.has("--apply"), only };
}

function describeRef(ref: StepRef): string {
  return `<${ref.fromStep}.${ref.output}>`;
}

export function formatPlan(steps: readonly DeployStep[]): string {
  return steps.map((step, index) => {
    const head = `${index + 1}. [${step.id}]`;
    switch (step.kind) {
      case "build-lambda-zip": return `${head} build ${step.logicalId} zip from ${step.entry} -> ${step.zipPath}`;
      case "upload-artifact": return `${head} upload ${step.from} zip to the control-plane artifact bucket under ${step.keyPrefix}<sha256>.zip`;
      case "ecr-push": return `${head} build the ${step.image} image and push it to the existing repository ${step.repositoryUri} (tag test-*), then pin its digest; test-deploy never creates a repository, and stops if this one is missing`;
      case "create-change-set": {
        const changed = step.parameters.flatMap((parameter) => ("value" in parameter ? [`${parameter.key}=${describeRef(parameter.value)}`] : []));
        const template = step.template.source === "previous" ? "previous template"
          : step.template.source === "lambda-code" ? `deployed template with Code replaced for ${step.template.patches.map((patch) => patch.logicalId).join(", ")}`
          : `deployed template plus ${step.template.logicalIdPrefix}*${(step.template.parameterNames ?? []).length === 0 ? "" : ` and parameter ${(step.template.parameterNames ?? []).join(", ")}`} from a CDK synth of ${step.template.construct} (${[`identity=${step.template.identityMode}`, ...Object.entries(step.template.cdkContext).map(([key, value]) => `${key}=${value}`)].join(", ")})`;
        const allowed = [...(step.expect.logicalIds ?? []), ...(step.expect.logicalIdPrefixes ?? []).map((prefix) => `${prefix}*`)].join(", ");
        return `${head} create change set on ${step.stack}: ${template}; ${step.parameters.length} parameters, ${changed.length === 0 ? "all UsePreviousValue" : `changing only ${changed.join(", ")}`}; abort unless the only changes are ${step.expect.action} ${allowed}`;
      }
      case "execute-change-set": return `${head} execute the change set from ${step.createdBy} on ${step.stack} and wait for UPDATE_COMPLETE`;
      case "verify-stack-resources": return `${head} verify with DescribeStackResource that every ${step.logicalIdPrefix}* resource ${step.createdBy} added in ${step.stack} is ${step.expectedStatus}`;
      case "verify-lambda-code": return `${head} verify ${step.logicalId} CodeSha256 equals ${describeRef(step.expectedSha256Base64)}`;
      case "verify-stack-parameter": return `${head} verify ${step.stack} parameter ${step.key} equals ${describeRef(step.expected)}`;
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

function observedChanges(changes: readonly Change[]): ObservedChange[] {
  return changes.map((change) => {
    const resource = change.ResourceChange;
    const attributes = (resource?.Details ?? []).map((detail) => {
      const attribute = detail.Target?.Attribute ?? "";
      return attribute === "Properties" ? `Properties.${detail.Target?.Name ?? ""}` : attribute;
    });
    return {
      action: resource?.Action ?? "",
      logicalId: resource?.LogicalResourceId ?? "",
      ...(resource?.ResourceType === undefined ? {} : { type: resource.ResourceType }),
      ...(resource?.Replacement === undefined ? {} : { replacement: resource.Replacement }),
      attributes,
    };
  });
}

function synthesizeLiftSource(context: ApplyContext, plan: Extract<TemplatePlan, { source: "lift-resources" }>): CfnTemplate {
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
      : liftResources(deployed, synthesizeLiftSource(context, step.template), step.template.logicalIdPrefix, step.template.parameterNames);
    const body = Buffer.from(`${JSON.stringify(prepared, null, 2)}\n`);
    const bucket = stackOutput(describeStack(context.runner, context.region, step.stack), "ArtifactBucketName");
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
  const observed = observedChanges(changes);
  console.log(`change set ${changeSetName}:\n${observed.map((change) => `  ${change.action} ${change.logicalId} ${change.type ?? ""} ${(change.attributes ?? []).join(",")}`).join("\n")}`);
  try {
    assertOnlyExpectedChanges(observed, step.expect);
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
  await context.cloudFormation.send(new ExecuteChangeSetCommand(identity));
  // The change set's own ExecutionStatus, never the stack's: a stack still saying UPDATE_COMPLETE from before is not this deploy's success.
  await waitForChangeSetExecution(() => context.cloudFormation.send(new DescribeChangeSetCommand(identity)));
  const status = (await describeStackSdk(context, step.stack)).StackStatus ?? "";
  if (status !== "UPDATE_COMPLETE") throw new Error(`${step.stack} is ${status} after its change set completed; read its events in CloudFormation`);
}

/** Pushes to a repository that must already exist: describing it is the check, and nothing here creates one. */
function assertRepositoryExists(context: ApplyContext, repository: string): void {
  const found = context.runner.aws(["ecr", "describe-repositories", "--repository-names", repository, "--region", context.region, "--output", "json"], true);
  if (found.status !== 0) {
    throw new Error(`the ECR repository ${repository} does not exist (or cannot be read) and test-deploy never creates one; create it with the worker repository's settings, then run this again`);
  }
}

async function applyStep(context: ApplyContext, step: DeployStep): Promise<void> {
  console.log(`\n== ${step.id}`);
  switch (step.kind) {
    case "build-lambda-zip": {
      runNpmBuild(context);
      const result = await bundle({
        entryPoints: [step.entry], outfile: "index.js", bundle: true, platform: "node", target: "node22", minify: true, sourcemap: true, external: [], write: false,
      });
      const file = (name: string) => {
        const output = result.outputFiles.find((candidate) => candidate.path.endsWith(`/${name}`));
        if (output === undefined) throw new Error(`esbuild produced no ${name} for ${step.entry}`);
        return Buffer.from(output.contents);
      };
      const zip = deterministicZip([{ path: "index.js", data: file("index.js") }, { path: "index.js.map", data: file("index.js.map") }]);
      mkdirSync(join(step.zipPath, ".."), { recursive: true });
      writeFileSync(step.zipPath, zip);
      recordOutput(context, step.id, { zipPath: step.zipPath, sha256Hex: sha256(zip).digest("hex"), sha256Base64: sha256(zip).digest("base64") });
      console.log(`${step.zipPath} sha256 ${context.outputs.get(step.id)?.sha256Hex}`);
      return;
    }
    case "upload-artifact": {
      const built = context.outputs.get(step.from);
      if (built?.zipPath === undefined || built.sha256Hex === undefined) throw new Error(`step ${step.from} built nothing`);
      const bucket = stackOutput(describeStack(context.runner, context.region, resolveTestStacks(context.env)[step.bucketFromStack]), "ArtifactBucketName");
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
      const expected = outputOf(context, step.expected);
      if (actual !== expected) throw new Error(`${step.stack} ${step.key} is ${actual ?? "missing"}, not ${expected}`);
      console.log(`${step.key} is ${expected}`);
      return;
    }
  }
}

function currentParameters(runner: Runner, region: string, stack: string): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const parameter of describeStack(runner, region, stack).Parameters ?? []) if (parameter.ParameterKey) parameters[parameter.ParameterKey] = parameter.ParameterValue ?? "";
  return parameters;
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseTestDeployArgs(argv);
  if (!loadAllowlist().includes(args.env)) throw new Error(ALLOWLIST_ERROR);
  const options: ReleaseOptions = { region: args.region, repository: "", profile: args.profile, allowDirty: false, skipChecks: false, dryRun: !args.apply };
  const runner = new Runner(options);
  const revision = runner.capture("git", ["rev-parse", "HEAD"]).stdout.trim();
  const stacks = resolveTestStacks(args.env);
  const needsRuntime = args.only.includes("worker-image") || args.only.includes("executor-image");
  const previous: StackParameters = {
    "control-plane": currentParameters(runner, args.region, stacks["control-plane"]),
    runtime: needsRuntime ? currentParameters(runner, args.region, stacks.runtime) : {},
  };
  // The identity stack exists only for a Cognito environment; the engine's synth context differs for an own-OIDC one.
  const identityMode = stackExists(runner, args.region, environmentStackName(args.env, "identity")) ? "cognito" : "oidc";
  const steps = planTestDeploy({ env: args.env, only: args.only, artifacts: { revision, outputDir: join(tmpdir(), `test-deploy-${revision.slice(0, 12)}`) }, previous, identityMode });
  console.log(`TEST deploy plan for ${args.env} (${args.region}), revision ${revision}\n${formatPlan(steps)}`);
  if (!args.apply) {
    console.log("\nDry run: nothing was changed. Add --apply to run this plan.");
    return;
  }
  if (runner.capture("git", ["status", "--porcelain"]).stdout.trim() !== "") throw new Error("the working tree is dirty; commit first so the deployed bytes match the revision");
  const context: ApplyContext = {
    runner, options, region: args.region, env: args.env, revision,
    cloudFormation: new CloudFormationClient({ region: args.region, profile: args.profile }),
    lambda: new LambdaClient({ region: args.region, profile: args.profile }),
    outputs: new Map(), built: false,
  };
  for (const step of steps) await applyStep(context, step);
  console.log("\nTEST deploy complete.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
