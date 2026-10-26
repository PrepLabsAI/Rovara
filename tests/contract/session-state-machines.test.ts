import { describe, expect, it } from "vitest";
import { WORKER_AMI_ID_PATTERN } from "../../packages/broker/src/aws/worker-ami.js";
import {
  PROBE_ATTEMPTS,
  PROBE_INTERVAL_SECONDS,
  deleterDefinition,
  provisionerDefinition,
} from "../../infra/lib/session-state-machines.js";

type State = { Type: string; Next?: string; Default?: string; Choices?: Array<{ Next: string }>; Catch?: Array<{ Next: string }>; Retry?: unknown[]; Resource?: string; Arguments?: Record<string, unknown> };
type Definition = { StartAt: string; QueryLanguage: string; States: Record<string, State> };

const props = { stepsFunctionArn: "arn:aws:lambda:us-east-1:111122223333:function:steps", workspaceKeyArn: "arn:aws:kms:us-east-1:111122223333:key/k", environmentTag: "production", resourcePrefix: "agentx-production", workerAmiParameterName: "/agentx/production/worker-qualified-ami" };
const provisioner = provisionerDefinition(props) as unknown as Definition;
const deleter = deleterDefinition(props) as unknown as Definition;

const targets = (state: State) => [state.Next, state.Default, ...(state.Choices ?? []).map((c) => c.Next), ...(state.Catch ?? []).map((c) => c.Next)].filter((t): t is string => t !== undefined);

describe.each([["provisioner", provisioner], ["deleter", deleter]] as const)("%s state machine", (_name, definition) => {
  it("uses JSONata, names only states that exist and reaches every state", () => {
    expect(definition.QueryLanguage).toBe("JSONata");
    const names = new Set(Object.keys(definition.States));
    for (const state of Object.values(definition.States)) for (const target of targets(state)) expect(names).toContain(target);
    const reached = new Set<string>();
    const visit = (name: string) => {
      if (reached.has(name)) return;
      reached.add(name);
      targets(definition.States[name]!).forEach(visit);
    };
    visit(definition.StartAt);
    expect([...names].filter((name) => !reached.has(name))).toEqual([]);
  });
});

describe("provisioner", () => {
  const states = provisioner.States;

  it.each(["staging", "production", undefined])("tags instance and workspace volume creation for environment %s", (env) => {
    const definition = provisionerDefinition({ ...props, ...(env === undefined ? {} : { env }) }) as unknown as Definition;
    for (const [stateName, resourceType] of [["CreateVolume", "volume"], ["RunInstance", "instance"]]) {
      const specs = definition.States[stateName!]!.Arguments!.TagSpecifications as Array<{ ResourceType: string; Tags: Array<{ Key: string; Value: string }> }>;
      const tags = specs.find((spec) => spec.ResourceType === resourceType)!.Tags;
      expect(tags).toEqual(expect.arrayContaining([
        { Key: "Environment", Value: props.environmentTag },
        { Key: "DeploymentMode", Value: "ec2-ebs" },
        { Key: "agentx:workspace", Value: "{% $workspaceId %}" },
      ]));
      expect(tags.filter((tag) => tag.Key === "agentx:env")).toEqual(env === undefined ? [] : [{ Key: "agentx:env", Value: env }]);
    }
  });

  it("creates the volume only when the session has none, idempotently per generation", () => {
    expect(states.HasVolume!.Choices![0]).toMatchObject({ Next: "CreateVolume" });
    expect(states.HasVolume!.Default).toBe("LaunchConfiguration");
    expect(states.CreateVolume!.Arguments).toMatchObject({ Encrypted: true, KmsKeyId: props.workspaceKeyArn, ClientToken: "{% $clientToken %}" });
    expect(states.RunInstance!.Arguments).toMatchObject({ ClientToken: "{% $clientToken %}", MinCount: 1, MaxCount: 1 });
    expect(JSON.stringify(states.Start)).toContain("'ws-' & $states.input.workspaceId & '-gen-'");
  });

  it("attaches after launch, without retrying a call that is not idempotent", () => {
    expect(states.AttachVolume!.Resource).toBe("arn:aws:states:::aws-sdk:ec2:attachVolume");
    expect(states.AttachVolume!.Retry).toBeUndefined();
    expect(states.AttachVolume!.Arguments).toMatchObject({ Device: "/dev/sdf" });
  });

  it("probes /ping every 10 seconds for up to 10 minutes before marking ready", () => {
    expect([PROBE_INTERVAL_SECONDS, PROBE_ATTEMPTS]).toEqual([10, 60]);
    expect(states.WaitToProbe).toMatchObject({ Type: "Wait", Seconds: 10, Next: "ProbePing" });
    expect(JSON.stringify(states.WorkerHealthy)).toContain("$probes < 60");
    expect(states.WorkerHealthy!.Choices![0]!.Next).toBe("MarkReady");
    expect(JSON.stringify(states.ProbeTimedOut)).toContain("within 10 minutes");
  });

  // #211: the probe step throws when a failed boot reports itself on /ping. That error must reach
  // MarkFailed with its text in well under a minute, not after the 10 minute probe window.
  it("fails the provisioning within a minute of a probe error, keeping the error's text", () => {
    const probe = states.ProbePing!;
    const retry = probe.Retry as Array<{ ErrorEquals: string[]; IntervalSeconds: number; MaxAttempts: number; BackoffRate: number }>;
    expect(retry).toHaveLength(1);
    const { IntervalSeconds, MaxAttempts, BackoffRate } = retry[0]!;
    const retryWaitSeconds = Array.from({ length: MaxAttempts }, (_, attempt) => IntervalSeconds * BackoffRate ** attempt).reduce((a, b) => a + b, 0);
    expect(PROBE_INTERVAL_SECONDS + retryWaitSeconds).toBeLessThan(60);
    expect(probe.Catch).toEqual([{ ErrorEquals: ["States.ALL"], Next: "Cleanup", Assign: { failure: "{% $states.errorOutput.Error & ': ' & $states.errorOutput.Cause %}" } }]);
    expect((states.MarkFailed!.Arguments!.Payload as Record<string, unknown>).error).toBe("{% $substring($string($failure), 0, 4000) %}");
  });

  it("sends every failure through cleanup: terminate any instance, keep the volume, mark failed", () => {
    for (const [name, state] of Object.entries(states)) {
      if (state.Type !== "Task" || name === "MarkFailed" || name === "TerminateInstance") continue;
      // The AMI pin is optional: an absent parameter launches unpinned; every other fault cleans up.
      if (name === "ReadQualifiedAmi") continue;
      expect(state.Catch?.map((c) => c.Next), name).toEqual(["Cleanup"]);
    }
    expect(states.Cleanup!.Choices![0]!.Next).toBe("TerminateInstance");
    expect(states.TerminateInstance!.Next).toBe("MarkFailed");
    expect(states.TerminateInstance!.Catch![0]!.Next).toBe("MarkFailed");
    expect(JSON.stringify(provisioner)).not.toContain("deleteVolume");
  });
});

describe("provisioner: pinned worker AMI (AUTOREQUALIFY AR-4)", () => {
  const states = provisioner.States as unknown as Record<string, State & { Assign?: Record<string, unknown>; Catch?: Array<{ ErrorEquals: string[]; Next: string }> }>;
  const NOT_FOUND = "Ssm.ParameterNotFoundException";

  it("reads the pin after the launch configuration and before launching, by the environment's parameter name only", () => {
    expect(states.LaunchConfiguration!.Next).toBe("ReadQualifiedAmi");
    const read = states.ReadQualifiedAmi!;
    expect(read.Resource).toBe("arn:aws:states:::aws-sdk:ssm:getParameter");
    // Plain read: a pin is an AMI ID, never a secret, so no WithDecryption.
    expect(read.Arguments).toEqual({ Name: props.workerAmiParameterName });
    expect(read.Next).toBe("QualifiedAmiWellFormed");
  });

  it("launches unpinned only when the parameter does not exist, without retrying that answer", () => {
    const read = states.ReadQualifiedAmi!;
    expect(read.Catch).toEqual([
      { ErrorEquals: [NOT_FOUND], Next: "RunInstance" },
      expect.objectContaining({ ErrorEquals: ["States.ALL"], Next: "Cleanup" }),
    ]);
    // First retrier matches the not-found answer with zero attempts, ahead of the catch-all retrier.
    const retry = read.Retry as unknown as Array<{ ErrorEquals: string[]; MaxAttempts?: number }>;
    expect(retry[0]).toMatchObject({ ErrorEquals: [NOT_FOUND], MaxAttempts: 0 });
    expect(retry.slice(1).every((retrier) => !retrier.ErrorEquals.includes(NOT_FOUND))).toBe(true);
  });

  it("launches the pinned AMI when the value is an AMI ID, and fails the provisioning when it is not", () => {
    const choice = states.QualifiedAmiWellFormed!;
    expect(choice.Choices![0]!.Next).toBe("RunInstancePinned");
    expect(choice.Default).toBe("QualifiedAmiMalformed");
    expect(states.QualifiedAmiMalformed!.Next).toBe("Cleanup");
    const condition = (choice.Choices![0] as unknown as { Condition: string }).Condition;
    // The state machine's own pattern is the broker's pattern.
    const embedded = /\/(.+)\//.exec(condition)![1]!;
    expect(embedded).toBe(WORKER_AMI_ID_PATTERN.source);
    expect(JSON.stringify(states.QualifiedAmiMalformed)).not.toContain("qualifiedAmi");
  });

  it("differs from the unpinned launch by the ImageId alone, with the same idempotency token and tags", () => {
    const unpinned = states.RunInstance!;
    const pinned = states.RunInstancePinned!;
    expect(unpinned.Arguments).not.toHaveProperty("ImageId");
    expect(pinned.Arguments).toMatchObject({ ImageId: "{% $qualifiedAmi %}", ClientToken: "{% $clientToken %}" });
    const rest: Record<string, unknown> = { ...pinned.Arguments };
    delete rest.ImageId;
    expect(rest).toEqual(unpinned.Arguments);
    expect({ ...pinned, Arguments: undefined }).toEqual({ ...unpinned, Arguments: undefined });
    expect(pinned.Next).toBe("RecordInstance");
    expect(pinned.Catch!.map((c) => c.Next)).toEqual(["Cleanup"]);
  });

  it("starts with no pin held, so a retried execution never reuses an earlier value", () => {
    expect(states.Start!.Assign).toMatchObject({ qualifiedAmi: null });
  });
});

describe("deleter", () => {
  const states = deleter.States;

  it("terminates, waits for termination, deletes the volume and records DELETED", () => {
    expect(states.TerminateInstance!.Next).toBe("WaitForTermination");
    expect(states.InstanceTerminated!.Choices![0]!.Next).toBe("HasVolume");
    expect(states.VolumeDetached!.Choices![0]!.Next).toBe("DeleteVolume");
    expect(states.DeleteVolume!.Next).toBe("MarkDeleted");
    expect(states.MarkDeleted!.Next).toBe("Deleted");
  });

  it("treats an instance or volume that is already gone as deleted, and anything else as a failure", () => {
    for (const name of ["TerminateInstance", "DescribeInstance"]) expect(states[name]!.Catch![0]!.Next).toBe("InstanceAlreadyGone");
    for (const name of ["DescribeVolume", "DeleteVolume"]) expect(states[name]!.Catch![0]!.Next).toBe("VolumeAlreadyGone");
    expect(JSON.stringify(states.InstanceAlreadyGone)).toContain("InvalidInstanceID.NotFound");
    expect(JSON.stringify(states.VolumeAlreadyGone)).toContain("InvalidVolume.NotFound");
    expect(states.VolumeAlreadyGone!.Default).toBe("DeletionFailed");
  });
});
