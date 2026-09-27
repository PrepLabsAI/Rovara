// Amazon States Language (JSONata) for the EC2 session provisioner and deleter (issue #83, design in
// #76). The provisioner starts from a ProvisioningInput and the deleter from a DeletionInput
// (packages/broker/src/aws/sessions.ts). Each step that records progress calls the session steps
// Lambda, which applies the SESSION transition conditionally on the generation.

type State = Record<string, unknown>;

export interface SessionStateMachineProps {
  /** The session steps Lambda. */
  stepsFunctionArn: string;
  /** Encrypts workspace volumes. */
  workspaceKeyArn: string;
  /** Tag values every instance and volume carries; IAM scopes terminate, attach and delete by them. */
  environmentTag: string;
  resourcePrefix: string;
}

/** Health probes every 10 seconds, for up to 10 minutes. */
export const PROBE_INTERVAL_SECONDS = 10;
export const PROBE_ATTEMPTS = 60;
/** How long the machines wait for a volume or instance to change state: 60 checks. */
const STATE_WAIT_CHECKS = 60;
/** Block device name the workspace volume attaches under; the boot script finds it by volume ID. */
export const WORKSPACE_DEVICE = "/dev/sdf";

/** Retries an idempotent call on any error: throttling and brief EC2 inconsistency are common. */
const RETRY_IDEMPOTENT = [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2 }];

const ec2 = (action: string) => `arn:aws:states:::aws-sdk:ec2:${action}`;

function tags(props: SessionStateMachineProps, name: string, extra: Array<{ Key: string; Value: string }>) {
  return [
    { Key: "Name", Value: name },
    { Key: "Application", Value: "AgentX" },
    { Key: "DeploymentMode", Value: "ec2-ebs" },
    { Key: "Environment", Value: props.environmentTag },
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
        Next: "RunInstance",
      }),
      RunInstance: {
        Type: "Task",
        Resource: ec2("runInstances"),
        Arguments: {
          LaunchTemplate: { LaunchTemplateId: "{% $launchTemplateId %}", Version: "$Default" },
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
          waits: 0,
        },
        Retry: RETRY_IDEMPOTENT,
        Catch: [toCleanup],
        Next: "RecordInstance",
      },
      RecordInstance: step(props, {
        action: "recordInstance",
        workspaceId: "{% $workspaceId %}",
        generation: "{% $generation %}",
        instanceId: "{% $instanceId %}",
        privateIp: "{% $privateIp %}",
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
