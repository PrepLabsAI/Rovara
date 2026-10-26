import { z } from "zod";
import { REQUALIFY_TAGS } from "./runtime-requalify.js";
import {
  E2E_QUALIFICATION_PROFILE_ID,
  ec2WorkerUserData,
  type Ec2RuntimeBinding,
} from "./session.js";

/**
 * How a qualification runner is launched, shared by the operator's script (`scripts/test-qualify-runtime.ts`) and the automatic renewal
 * (AR-2). Moved out of the script so both render the same boot, the same launch request and the same tags: a runner of either kind is one the
 * next renewal may retire.
 */

/** The runner's instance type: the launch template must be this shape or the launch is refused. */
export const QUALIFICATION_INSTANCE_TYPE = "m6g.large";
export const QUALIFICATION_VOLUME_DEVICE = "/dev/sdf";
/** The worker uploads ready.json once it answers /ping: boot, volume attach and image pulls take a few minutes. */
export const QUALIFICATION_READY_TIMEOUT_MS = 20 * 60_000;
/** The web/API challenge lives 60 minutes: registration is refused after that. */
export const QUALIFICATION_POLL_TIMEOUT_MS = 60 * 60_000;

/** The SSM setting (under the environment's worker settings prefix) that names the AMI the last renewal qualified. AR-4 reads it when it launches task workers. */
export const QUALIFIED_AMI_SETTING_NAME = "worker-qualified-ami";

/** Extra reason codes of the renewal's step machine, beside REQUALIFY_REASON_CODES. */
export const REQUALIFY_STEP_REASON_CODES = ["settings-changed", "unexpected-error"] as const;

/** Where a renewal's drain request lives. While it exists, the dispatchers of application checks and project setup defer (AR-3 reads it). */
export const requalifyHoldKey = (profileId: string) => ({ pk: `RUNTIME_REQUALIFY#${profileId}`, sk: "HOLD" });
export const RequalifyHoldSchema = z.object({
  entityType: z.literal("RUNTIME_REQUALIFY_HOLD"), runId: z.string().uuid(), acquiredAt: z.string().datetime(), until: z.string().datetime(),
}).strict();

export interface QualificationSettings {
  workerImage: string;
  /** Required to qualify, though optional in the worker settings: the web/API runtime needs it. */
  executorImage?: string | undefined;
  modelProvider: string;
  modelId: string;
  promptCacheRetention: "short" | "long";
  openRouterSecretArn?: string | undefined;
  openRouterProviders?: string | undefined;
  anthropicSecretArn?: string | undefined;
  openaiSecretArn?: string | undefined;
}

/** What is read from the live stack: nothing about the TEST installation is written into code. */
export interface QualificationFacts {
  region: string;
  artifactBucket: string;
  controlPlaneUrl: string;
  invokePublicKey: string;
  logGroupName: string;
  launchTemplateId: string;
  /** The unique ID (AROA...) of the worker instance role: the first half of the instance's `${aws:userid}`, which scopes its grant. */
  workerRoleId: string;
  /** The binding `agentx project add` registers for this foundation: every worker subnet. The challenge, and so the registered rows, carry it. */
  binding: Ec2RuntimeBinding;
  /** The one subnet of the binding the worker is launched into. */
  subnet: { availabilityZone: string; subnetId: string };
  volumeSizeGiB: number;
  settings: QualificationSettings;
}

/** The worker's boot configuration for the qualification instance, rendered by the product's own user data helper. */
export function renderQualificationUserData(
  facts: QualificationFacts,
  run: { workspaceId: string; volumeId: string; qualification: { profile: typeof E2E_QUALIFICATION_PROFILE_ID } },
  bootScript: string,
): string {
  const { settings } = facts;
  if (settings.executorImage === undefined) {
    throw new Error("the worker settings have no executor image, which the web/API runtime needs; deploy it first (test-deploy --only executor-image)");
  }
  return ec2WorkerUserData({
    workspaceId: run.workspaceId,
    generation: 1,
    volumeId: run.volumeId,
    expectNewVolume: true,
    workerImage: settings.workerImage,
    executorImage: settings.executorImage,
    invokePublicKey: facts.invokePublicKey,
    controlPlaneUrl: facts.controlPlaneUrl,
    modelProvider: settings.modelProvider,
    modelId: settings.modelId,
    promptCacheRetention: settings.promptCacheRetention,
    ...(settings.openRouterSecretArn ? { openRouterSecretArn: settings.openRouterSecretArn } : {}),
    ...(settings.openRouterProviders ? { openRouterProviders: settings.openRouterProviders } : {}),
    ...(settings.anthropicSecretArn ? { anthropicSecretArn: settings.anthropicSecretArn } : {}),
    ...(settings.openaiSecretArn ? { openaiSecretArn: settings.openaiSecretArn } : {}),
    logGroupName: facts.logGroupName,
    e2eQualification: { bucket: facts.artifactBucket, roleId: facts.workerRoleId, profile: run.qualification.profile },
  }, bootScript);
}

export interface QualificationRunInstancesInput {
  ClientToken: string;
  MinCount: 1;
  MaxCount: 1;
  /** Set by the renewal to the AMI it pinned; the script leaves it to the launch template. */
  ImageId?: string;
  LaunchTemplate: { LaunchTemplateId: string; Version: string };
  SubnetId: string;
  UserData: string;
  TagSpecifications: Array<{ ResourceType: "instance"; Tags: Array<{ Key: string; Value: string }> }>;
}

/** The tags a renewal-managed volume carries: the three that IAM requires to attach, terminate or delete it, and the run. */
export function qualificationVolumeTags(run: { env: string; runId: string }): Record<string, string> {
  return {
    Application: "AgentX",
    [REQUALIFY_TAGS.deploymentModeKey]: REQUALIFY_TAGS.deploymentModeValue,
    [REQUALIFY_TAGS.environmentKey]: run.env,
    [REQUALIFY_TAGS.managedKey]: REQUALIFY_TAGS.managedValue,
    "agentx:run": run.runId,
    [REQUALIFY_TAGS.runKey]: run.runId,
    "agentx:runtime-purpose": "web-api-qualification",
  };
}

/** One instance from the environment's own launch template: its instance type, profile and security group stay the template's. */
export function buildRunInstancesInput(
  facts: QualificationFacts,
  run: { env: string; runId: string; revision: string; userData: string; imageId?: string | undefined },
): QualificationRunInstancesInput {
  return {
    ClientToken: run.runId,
    MinCount: 1,
    MaxCount: 1,
    ...(run.imageId === undefined ? {} : { ImageId: run.imageId }),
    LaunchTemplate: { LaunchTemplateId: facts.launchTemplateId, Version: "$Default" },
    SubnetId: facts.subnet.subnetId,
    UserData: run.userData,
    TagSpecifications: [{
      ResourceType: "instance",
      Tags: [
        { Key: "Application", Value: "AgentX" },
        // Not the launch template's ec2-ebs: the session reconciler ends an ec2-ebs instance of this environment that no session owns once it is
        // 15 minutes old, which would end this one mid-qualification. The request's tags override the template's for the same key.
        { Key: REQUALIFY_TAGS.deploymentModeKey, Value: REQUALIFY_TAGS.deploymentModeValue },
        { Key: REQUALIFY_TAGS.environmentKey, Value: run.env },
        { Key: "Name", Value: `agentx-${run.env}-web-api-qualification-${run.runId.slice(0, 8)}` },
        { Key: "agentx:env", Value: run.env },
        { Key: "agentx:run", Value: run.runId },
        { Key: REQUALIFY_TAGS.runKey, Value: run.runId },
        // The renewal may retire only what carries this tag; the script's runner carries it too, so the next renewal can replace it.
        { Key: REQUALIFY_TAGS.managedKey, Value: REQUALIFY_TAGS.managedValue },
        { Key: "agentx:revision", Value: run.revision },
        { Key: "agentx:runtime-purpose", Value: "web-api-qualification" },
      ],
    }],
  };
}

/** The launch template must be the reviewed shape: refuse anything else instead of overriding it. Returns a fixed message, or undefined when it is right. */
export function launchTemplateShapeProblem(template: { InstanceType?: string | undefined; MetadataOptions?: { HttpTokens?: string | undefined; HttpPutResponseHopLimit?: number | undefined } | undefined; UserData?: string | undefined; IamInstanceProfile?: unknown } | undefined): string | undefined {
  if (template === undefined) return "the launch template's default version was not found";
  if (template.InstanceType !== QUALIFICATION_INSTANCE_TYPE || template.MetadataOptions?.HttpTokens !== "required" || template.MetadataOptions.HttpPutResponseHopLimit !== 1 || template.UserData !== undefined || template.IamInstanceProfile === undefined) {
    return `the launch template is not ${QUALIFICATION_INSTANCE_TYPE} with IMDSv2 required, hop limit 1, an instance profile and no user data of its own; stop for review`;
  }
  return undefined;
}
