// Amazon States Language (JSONata) for the EC2 session provisioner and deleter (issue #83, design in
// #76). The provisioner starts from a ProvisioningInput and the deleter from a DeletionInput
// (packages/broker/src/aws/sessions.ts). Each step that records progress calls the session steps
// Lambda, which applies the SESSION transition conditionally on the generation.
import { MACHINE_LAUNCH_AMI_PARAMETERS } from "@agentx/contracts";

type State = Record<string, unknown>;

export interface SessionStateMachineProps {
  /** The session steps Lambda. */
  stepsFunctionArn: string;
  /** Encrypts workspace volumes. */
  workspaceKeyArn: string;
  /** Tag values every instance and volume carries; IAM scopes terminate, attach and delete by them. */
  environmentTag: string;
  /** Named install environment; absent for legacy deployments, as in app-level tagging. */
  env?: string;
  resourcePrefix: string;
  /**
   * AUTOREQUALIFY AR-4: the SSM parameter holding the AMI the test machine was qualified on. Workers
   * launch from it once it exists (`/agentx/<env>/worker-qualified-ami`, broker/src/aws/worker-ami.ts).
   */
  workerAmiParameterName: string;
}

/** Health probes every 10 seconds, for up to 10 minutes. */
export const PROBE_INTERVAL_SECONDS = 10;
export const PROBE_ATTEMPTS = 60;
/** How long the machines wait for a volume or instance to change state: 60 checks. */
const STATE_WAIT_CHECKS = 60;
/** Block device name the workspace volume attaches under; the boot script finds it by volume ID. */
export const WORKSPACE_DEVICE = "/dev/sdf";

/**
 * An EC2 AMI ID, the pattern of WORKER_AMI_ID_PATTERN in packages/broker/src/aws/worker-ami.ts
 * (infra does not import the broker; tests/contract/session-state-machines.test.ts keeps them equal).
 */
export const AMI_ID_PATTERN_SOURCE = "^ami-[0-9a-f]{8}([0-9a-f]{9})?$";
const PARAMETER_NOT_FOUND = "Ssm.ParameterNotFoundException";

/** Retries an idempotent call on any error: throttling and brief EC2 inconsistency are common. */
const RETRY_IDEMPOTENT = [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2 }];

const ec2 = (action: string) => `arn:aws:states:::aws-sdk:ec2:${action}`;
const ssm = (action: string) => `arn:aws:states:::aws-sdk:ssm:${action}`;

function tags(props: SessionStateMachineProps, name: string, extra: Array<{ Key: string; Value: string }>) {
  return [
    { Key: "Name", Value: name },
    { Key: "Application", Value: "AgentX" },
    { Key: "DeploymentMode", Value: "ec2-ebs" },
    { Key: "Environment", Value: props.environmentTag },
    ...(props.env === undefined ? [] : [{ Key: "agentx:env", Value: props.env }]),
    ...extra,
  ];
}

function step(props: SessionStateMachineProps, payload: Record<string, unknown>, rest: State): State {
  return {
    Type: "Task",
    Resource: "arn:aws:states:::lambda:invoke",
    Arguments: { FunctionName: props.stepsFunctionArn, Payload: payload },
    Retry: RETRY_IDEMPOTENT,
    ...rest,
  };
}

/** Records the failure text for the cleanup path. */
const toCleanup = { ErrorEquals: ["States.ALL"], Next: "Cleanup", Assign: { failure: "{% $states.errorOutput.Error & ': ' & $states.errorOutput.Cause %}" } };

/**
 * DEC 254zb: what a sized launch (the input's `machine`) sets on top of the template. arm64 keeps the template's AMI (or the AR-4 pin, qualified on arm64);
 * x86_64 boots the public x86 Amazon Linux 2023 AMI, resolved by EC2 at launch, never the arm64 pin. The type is bounded by the provisioner's IAM allow-list.
 */
type Sizing = "none" | "arm64" | "x86_64";

/**
 * The EC2 error codes that mean "this size cannot launch here now" and that create no instance: no capacity, the type is not offered in the zone, or a
 * vCPU / instance quota. EC2 errors reach Step Functions as a generic Ec2.Ec2Exception, so the code is looked for in the error and its cause.
 */
export const SIZE_UNAVAILABLE_CODES = ["InsufficientInstanceCapacity", "Unsupported", "VcpuLimitExceeded", "InstanceLimitExceeded"] as const;
/** The fixed reason a session records when its sized launch fell back to the template's default size. */
export const MACHINE_FALLBACK_REASON = "size-unavailable";

/** Launches the worker from the launch template; `pinned` also overrides its AMI with the qualified one; `sizing` adds the chosen type (and the x86 AMI). */
function runInstance(props: SessionStateMachineProps, workspaceTags: Array<{ Key: string; Value: string }>, pinned: boolean, sizing: Sizing = "none"): State {
  return {
    Type: "Task",
    Resource: ec2("runInstances"),
    Arguments: {
      LaunchTemplate: { LaunchTemplateId: "{% $launchTemplateId %}", Version: "$Default" },
      ...(pinned ? { ImageId: "{% $qualifiedAmi %}" } : {}),
      ...(sizing === "x86_64" ? { ImageId: `resolve:ssm:${MACHINE_LAUNCH_AMI_PARAMETERS.x86_64}` } : {}),
      ...(sizing === "none" ? {} : { InstanceType: "{% $machine.instanceType %}" }),
      MinCount: 1,
      MaxCount: 1,
      SubnetId: "{% $subnetId %}",
      UserData: "{% $userData %}",
      ClientToken: "{% $clientToken %}",
      TagSpecifications: [{
        ResourceType: "instance",
        Tags: tags(props, `${props.resourcePrefix}-worker`, [...workspaceTags, { Key: "agentx:generation", Value: "{% $string($generation) %}" }]),
      }],
    },
    Assign: {
      instanceId: "{% $states.result.Instances[0].InstanceId %}",
      privateIp: "{% $states.result.Instances[0].PrivateIpAddress %}",
      instanceType: "{% $states.result.Instances[0].InstanceType %}",
      waits: 0,
    },
    Retry: RETRY_IDEMPOTENT,
    // A sized launch that cannot get its size falls back to the default size (SizedLaunchFailed); every other failure cleans up as before.
    Catch: sizing === "none" ? [toCleanup] : [{ ...toCleanup, Next: "SizedLaunchFailed", Assign: { ...toCleanup.Assign, lastError: "{% $states.errorOutput %}" } }],
    Next: "RecordInstance",
  };
}

/** AUTOREQUALIFY AR-4's pin read, for the default (`suffix` "") and the sized arm64 (`suffix` "Sized") launches: the same states and the same fallbacks. */
function pinStates(props: SessionStateMachineProps, suffix: "" | "Sized"): Record<string, State> {
  return {
    [`ReadQualifiedAmi${suffix}`]: {
      Type: "Task",
      Resource: ssm("getParameter"),
      Arguments: { Name: props.workerAmiParameterName },
      Assign: { qualifiedAmi: "{% $states.result.Parameter.Value %}" },
      Retry: [{ ErrorEquals: [PARAMETER_NOT_FOUND], MaxAttempts: 0 }, ...RETRY_IDEMPOTENT],
      Catch: [{ ErrorEquals: [PARAMETER_NOT_FOUND], Next: `RunInstance${suffix}` }, { ErrorEquals: ["States.ALL"], Next: `QualifiedAmiReadFailed${suffix}` }],
      Next: `QualifiedAmiWellFormed${suffix}`,
    },
    [`QualifiedAmiWellFormed${suffix}`]: {
      Type: "Choice",
      Choices: [{ Condition: `{% $count($match($qualifiedAmi, /${AMI_ID_PATTERN_SOURCE}/)) > 0 %}`, Next: `RunInstancePinned${suffix}` }],
      Default: `QualifiedAmiMalformed${suffix}`,
    },
    [`QualifiedAmiReadFailed${suffix}`]: { Type: "Pass", Assign: { qualifiedAmi: null, pinFallback: "qualified-ami-read-failed" }, Next: `RunInstance${suffix}` },
    [`QualifiedAmiMalformed${suffix}`]: { Type: "Pass", Assign: { qualifiedAmi: null, pinFallback: "qualified-ami-malformed" }, Next: `RunInstance${suffix}` },
  };
}

export function provisionerDefinition(props: SessionStateMachineProps): State {
  const workspaceTags = [{ Key: "agentx:workspace", Value: "{% $workspaceId %}" }];
  return {
    Comment: "Provisions one generation of an ec2-ebs workspace session",
    QueryLanguage: "JSONata",
    StartAt: "Start",
    States: {
      Start: {
        Type: "Pass",
        Assign: {
          workspaceId: "{% $states.input.workspaceId %}",
          generation: "{% $states.input.generation %}",
          availabilityZone: "{% $states.input.availabilityZone %}",
          subnetId: "{% $states.input.subnetId %}",
          launchTemplateId: "{% $states.input.launchTemplateId %}",
          volumeId: "{% $states.input.volumeId %}",
          volumeSizeGiB: "{% $states.input.volumeSizeGiB %}",
          volumeType: "{% $states.input.volumeType %}",
          qualifiedAmi: null,
          pinFallback: null,
          // DEC 254zb: the chosen size ({ instanceType, chip }), absent or null for the template's default size (today's launch, unchanged).
          machine: "{% $exists($states.input.machine) ? $states.input.machine : null %}",
          machineFallback: null,
          instanceType: null,
          // The execution name: CreateVolume and RunInstances are idempotent per generation.
          clientToken: "{% 'ws-' & $states.input.workspaceId & '-gen-' & $string($states.input.generation) %}",
          expectNewVolume: false,
          instanceId: null,
          waits: 0,
          failure: null,
        },
        Next: "HasVolume",
      },
      HasVolume: {
        Type: "Choice",
        Choices: [{ Condition: "{% $volumeId = null %}", Next: "CreateVolume" }],
        Default: "LaunchConfiguration",
      },
      CreateVolume: {
        Type: "Task",
        Resource: ec2("createVolume"),
        Arguments: {
          AvailabilityZone: "{% $availabilityZone %}",
          Size: "{% $volumeSizeGiB %}",
          VolumeType: "{% $volumeType %}",
          Encrypted: true,
          KmsKeyId: props.workspaceKeyArn,
          ClientToken: "{% $clientToken %}",
          TagSpecifications: [{ ResourceType: "volume", Tags: tags(props, `${props.resourcePrefix}-workspace`, workspaceTags) }],
        },
        Assign: { volumeId: "{% $states.result.VolumeId %}", expectNewVolume: true, waits: 0 },
        Retry: RETRY_IDEMPOTENT,
        Catch: [toCleanup],
        Next: "WaitForVolume",
      },
      WaitForVolume: { Type: "Wait", Seconds: 5, Next: "DescribeVolume" },
      DescribeVolume: {
        Type: "Task",
        Resource: ec2("describeVolumes"),
        Arguments: { VolumeIds: ["{% $volumeId %}"] },
        Assign: { volumeState: "{% $states.result.Volumes[0].State %}", waits: "{% $waits + 1 %}" },
        Retry: RETRY_IDEMPOTENT,
        Catch: [toCleanup],
        Next: "VolumeAvailable",
      },
      VolumeAvailable: {
        Type: "Choice",
        Choices: [
          { Condition: "{% $volumeState = 'available' %}", Next: "RecordVolume" },
          { Condition: `{% $volumeState = 'creating' and $waits < ${STATE_WAIT_CHECKS} %}`, Next: "WaitForVolume" },
        ],
        Default: "VolumeNotCreated",
      },
      VolumeNotCreated: { Type: "Pass", Assign: { failure: "{% 'volume ' & $volumeId & ' did not become available (' & $volumeState & ')' %}" }, Next: "Cleanup" },
      RecordVolume: step(props, { action: "recordVolume", workspaceId: "{% $workspaceId %}", generation: "{% $generation %}", volumeId: "{% $volumeId %}" }, {
        Catch: [toCleanup],
        Next: "LaunchConfiguration",
      }),
      LaunchConfiguration: step(props, {
        action: "launchConfiguration",
        workspaceId: "{% $workspaceId %}",
        generation: "{% $generation %}",
        volumeId: "{% $volumeId %}",
        expectNewVolume: "{% $expectNewVolume %}",
      }, {
        Assign: { userData: "{% $states.result.Payload.userData %}" },
        Catch: [toCleanup],
        Next: "SizeChosen",
      }),
      // DEC 254zb: no chosen size takes today's path (the pin read, then the template's type). arm64 sizes keep the pin; x86 sizes never use it.
      SizeChosen: {
        Type: "Choice",
        Choices: [
          { Condition: "{% $exists($machine.chip) and $machine.chip = 'x86_64' %}", Next: "RunInstanceX86" },
          { Condition: "{% $exists($machine.chip) and $machine.chip = 'arm64' %}", Next: "ReadQualifiedAmiSized" },
        ],
        Default: "ReadQualifiedAmi",
      },
      // AUTOREQUALIFY AR-4: workers boot from the AMI the test machine was qualified on, so a renewal
      // causes no kernel drift. The pin must never stop a worker from starting: no parameter yet (before
      // the first automatic requalification), any read fault whatever its error name, and a value that is
      // not an AMI ID all launch from the launch template's AMI as before. The last two record a fixed
      // reason (pinFallback) in the execution, and the reconciler reports an unreadable pin.
      ...pinStates(props, ""),
      RunInstance: runInstance(props, workspaceTags, false),
      RunInstancePinned: runInstance(props, workspaceTags, true),
      ...pinStates(props, "Sized"),
      RunInstanceSized: runInstance(props, workspaceTags, false, "arm64"),
      RunInstancePinnedSized: runInstance(props, workspaceTags, true, "arm64"),
      RunInstanceX86: runInstance(props, workspaceTags, false, "x86_64"),
      // A size that cannot launch here now falls back ONCE to the default launch, under its own idempotency token (the sized call's token never
      // names a different request), and the session records the fixed reason so the task can say so. Any other error fails as before.
      SizedLaunchFailed: {
        Type: "Choice",
        Choices: [{
          Condition: `{% ${SIZE_UNAVAILABLE_CODES.map((code) => `$contains($string($lastError.Error) & ' ' & $string($lastError.Cause), '${code}')`).join(" or ")} %}`,
          Next: "SizeUnavailable",
        }],
        Default: "Cleanup",
      },
      SizeUnavailable: {
        Type: "Pass",
        Assign: { machine: null, machineFallback: MACHINE_FALLBACK_REASON, failure: null, clientToken: "{% $clientToken & '-std' %}" },
        Next: "ReadQualifiedAmi",
      },
      RecordInstance: step(props, {
        action: "recordInstance",
        workspaceId: "{% $workspaceId %}",
        generation: "{% $generation %}",
        instanceId: "{% $instanceId %}",
        privateIp: "{% $privateIp %}",
        instanceType: "{% $instanceType %}",
        machineFallback: "{% $machineFallback %}",
      }, { Catch: [toCleanup], Next: "WaitForRunning" }),
      WaitForRunning: { Type: "Wait", Seconds: 5, Next: "DescribeInstance" },
      DescribeInstance: {
        Type: "Task",
        Resource: ec2("describeInstances"),
        Arguments: { InstanceIds: ["{% $instanceId %}"] },
        Assign: { instanceState: "{% $states.result.Reservations[0].Instances[0].State.Name %}", waits: "{% $waits + 1 %}" },
        Retry: RETRY_IDEMPOTENT,
        Catch: [toCleanup],
        Next: "InstanceRunning",
      },
      InstanceRunning: {
        Type: "Choice",
        Choices: [
          { Condition: "{% $instanceState = 'running' %}", Next: "AttachVolume" },
          { Condition: `{% $instanceState = 'pending' and $waits < ${STATE_WAIT_CHECKS} %}`, Next: "WaitForRunning" },
        ],
        Default: "InstanceNotRunning",
      },
      InstanceNotRunning: { Type: "Pass", Assign: { failure: "{% 'instance ' & $instanceId & ' did not reach running (' & $instanceState & ')' %}" }, Next: "Cleanup" },
      // Attached after launch, so terminating the instance never deletes the workspace volume.
      AttachVolume: {
        Type: "Task",
        Resource: ec2("attachVolume"),
        Arguments: { Device: WORKSPACE_DEVICE, InstanceId: "{% $instanceId %}", VolumeId: "{% $volumeId %}" },
        Assign: { waits: 0 },
        Catch: [toCleanup],
        Next: "WaitForAttachment",
      },
      WaitForAttachment: { Type: "Wait", Seconds: 3, Next: "DescribeAttachment" },
      DescribeAttachment: {
        Type: "Task",
        Resource: ec2("describeVolumes"),
        Arguments: { VolumeIds: ["{% $volumeId %}"] },
        Assign: { attachmentState: "{% $exists($states.result.Volumes[0].Attachments[0].State) ? $states.result.Volumes[0].Attachments[0].State : 'none' %}", waits: "{% $waits + 1 %}" },
        Retry: RETRY_IDEMPOTENT,
        Catch: [toCleanup],
        Next: "VolumeAttached",
      },
      VolumeAttached: {
        Type: "Choice",
        Choices: [
          { Condition: "{% $attachmentState = 'attached' %}", Next: "StartProbing" },
          { Condition: `{% $waits < ${STATE_WAIT_CHECKS} %}`, Next: "WaitForAttachment" },
        ],
        Default: "VolumeNotAttached",
      },
      VolumeNotAttached: { Type: "Pass", Assign: { failure: "{% 'volume ' & $volumeId & ' did not attach (' & $attachmentState & ')' %}" }, Next: "Cleanup" },
      StartProbing: { Type: "Pass", Assign: { probes: 0 }, Next: "WaitToProbe" },
      WaitToProbe: { Type: "Wait", Seconds: PROBE_INTERVAL_SECONDS, Next: "ProbePing" },
      ProbePing: step(props, { action: "probePing", privateIp: "{% $privateIp %}" }, {
        Assign: { healthy: "{% $states.result.Payload.healthy %}", probes: "{% $probes + 1 %}" },
        Catch: [toCleanup],
        Next: "WorkerHealthy",
      }),
      WorkerHealthy: {
        Type: "Choice",
        Choices: [
          { Condition: "{% $healthy %}", Next: "MarkReady" },
          { Condition: `{% $probes < ${PROBE_ATTEMPTS} %}`, Next: "WaitToProbe" },
        ],
        Default: "ProbeTimedOut",
      },
      ProbeTimedOut: {
        Type: "Pass",
        Assign: { failure: `worker did not answer /ping within ${(PROBE_ATTEMPTS * PROBE_INTERVAL_SECONDS) / 60} minutes` },
        Next: "Cleanup",
      },
      MarkReady: step(props, { action: "markReady", workspaceId: "{% $workspaceId %}", generation: "{% $generation %}" }, {
        Catch: [toCleanup],
        Next: "Provisioned",
      }),
      Provisioned: { Type: "Succeed" },
      // Any failure: terminate the instance if one was launched, keep the volume, mark FAILED.
      Cleanup: {
        Type: "Choice",
        Choices: [{ Condition: "{% $instanceId != null %}", Next: "TerminateInstance" }],
        Default: "MarkFailed",
      },
      TerminateInstance: {
        Type: "Task",
        Resource: ec2("terminateInstances"),
        Arguments: { InstanceIds: ["{% $instanceId %}"] },
        Retry: RETRY_IDEMPOTENT,
        // An instance that cannot be terminated is left to the reconciler; the session still fails.
        Catch: [{ ErrorEquals: ["States.ALL"], Next: "MarkFailed" }],
        Next: "MarkFailed",
      },
      MarkFailed: step(props, {
        action: "markFailed",
        workspaceId: "{% $workspaceId %}",
        generation: "{% $generation %}",
        error: "{% $substring($string($failure), 0, 4000) %}",
      }, { Next: "ProvisioningFailed" }),
      ProvisioningFailed: { Type: "Fail", Error: "ProvisioningFailed", Cause: "{% $string($failure) %}" },
    },
  };
}

/**
 * Continues when an EC2 call failed only because the resource is already gone. EC2 errors reach
 * Step Functions as a generic Ec2.Ec2Exception, so the code is looked for in the error and its
 * cause, and EC2's "does not exist" message is accepted too.
 */
function ignoreGone(code: string, next: string, otherwise: string): State {
  const text = "$string($lastError.Error) & ' ' & $string($lastError.Cause)";
  return {
    Type: "Choice",
    Choices: [{ Condition: `{% $contains(${text}, '${code}') or $contains(${text}, 'does not exist') %}`, Next: next }],
    Default: otherwise,
  };
}

const rememberError = (next: string) => ({ ErrorEquals: ["States.ALL"], Next: next, Assign: { lastError: "{% $states.errorOutput %}" } });

export function deleterDefinition(props: SessionStateMachineProps): State {
  return {
    Comment: "Deletes a closed ec2-ebs workspace's instance and volume",
    QueryLanguage: "JSONata",
    StartAt: "Start",
    States: {
      Start: {
        Type: "Pass",
        Assign: {
          workspaceId: "{% $states.input.workspaceId %}",
          instanceId: "{% $states.input.instanceId %}",
          volumeId: "{% $states.input.volumeId %}",
          waits: 0,
          lastError: null,
        },
        Next: "HasInstance",
      },
      HasInstance: {
        Type: "Choice",
        Choices: [{ Condition: "{% $instanceId != null %}", Next: "TerminateInstance" }],
        Default: "HasVolume",
      },
      TerminateInstance: {
        Type: "Task",
        Resource: ec2("terminateInstances"),
        Arguments: { InstanceIds: ["{% $instanceId %}"] },
        Retry: RETRY_IDEMPOTENT,
        Catch: [rememberError("InstanceAlreadyGone")],
        Next: "WaitForTermination",
      },
      InstanceAlreadyGone: ignoreGone("InvalidInstanceID.NotFound", "HasVolume", "DeletionFailed"),
      WaitForTermination: { Type: "Wait", Seconds: 10, Next: "DescribeInstance" },
      DescribeInstance: {
        Type: "Task",
        Resource: ec2("describeInstances"),
        Arguments: { InstanceIds: ["{% $instanceId %}"] },
        Assign: { instanceState: "{% $states.result.Reservations[0].Instances[0].State.Name %}", waits: "{% $waits + 1 %}" },
        Retry: RETRY_IDEMPOTENT,
        Catch: [rememberError("InstanceAlreadyGone")],
        Next: "InstanceTerminated",
      },
      InstanceTerminated: {
        Type: "Choice",
        Choices: [
          { Condition: "{% $instanceState = 'terminated' %}", Next: "HasVolume" },
          { Condition: `{% $waits < ${STATE_WAIT_CHECKS} %}`, Next: "WaitForTermination" },
        ],
        Default: "DeletionFailed",
      },
      HasVolume: {
        Type: "Choice",
        Choices: [{ Condition: "{% $volumeId != null %}", Next: "ResetWaits" }],
        Default: "MarkDeleted",
      },
      ResetWaits: { Type: "Pass", Assign: { waits: 0 }, Next: "WaitForDetach" },
      WaitForDetach: { Type: "Wait", Seconds: 5, Next: "DescribeVolume" },
      DescribeVolume: {
        Type: "Task",
        Resource: ec2("describeVolumes"),
        Arguments: { VolumeIds: ["{% $volumeId %}"] },
        Assign: { volumeState: "{% $states.result.Volumes[0].State %}", waits: "{% $waits + 1 %}" },
        Retry: RETRY_IDEMPOTENT,
        Catch: [rememberError("VolumeAlreadyGone")],
        Next: "VolumeDetached",
      },
      VolumeAlreadyGone: ignoreGone("InvalidVolume.NotFound", "MarkDeleted", "DeletionFailed"),
      VolumeDetached: {
        Type: "Choice",
        Choices: [
          { Condition: "{% $volumeState = 'available' %}", Next: "DeleteVolume" },
          { Condition: "{% $volumeState = 'deleted' or $volumeState = 'deleting' %}", Next: "MarkDeleted" },
          { Condition: `{% $waits < ${STATE_WAIT_CHECKS} %}`, Next: "WaitForDetach" },
        ],
        Default: "DeletionFailed",
      },
      DeleteVolume: {
        Type: "Task",
        Resource: ec2("deleteVolume"),
        Arguments: { VolumeId: "{% $volumeId %}" },
        Retry: RETRY_IDEMPOTENT,
        Catch: [rememberError("VolumeAlreadyGone")],
        Next: "MarkDeleted",
      },
      MarkDeleted: step(props, { action: "markDeleted", workspaceId: "{% $workspaceId %}" }, { Next: "Deleted" }),
      Deleted: { Type: "Succeed" },
      // Left DELETING for the reconciler; the failed-executions alarm tells the operator.
      DeletionFailed: { Type: "Fail", Error: "DeletionFailed", Cause: "{% $string($lastError) %}" },
    },
  };
}
