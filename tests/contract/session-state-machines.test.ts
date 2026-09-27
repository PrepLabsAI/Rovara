import { describe, expect, it } from "vitest";
import {
  PROBE_ATTEMPTS,
  PROBE_INTERVAL_SECONDS,
  deleterDefinition,
  provisionerDefinition,
} from "../../infra/lib/session-state-machines.js";

type State = { Type: string; Next?: string; Default?: string; Choices?: Array<{ Next: string }>; Catch?: Array<{ Next: string }>; Retry?: unknown[]; Resource?: string; Arguments?: Record<string, unknown> };
type Definition = { StartAt: string; QueryLanguage: string; States: Record<string, State> };

const props = { stepsFunctionArn: "arn:aws:lambda:us-east-1:111122223333:function:steps", workspaceKeyArn: "arn:aws:kms:us-east-1:111122223333:key/k", environmentTag: "production", resourcePrefix: "agentx-production" };
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

  it("sends every failure through cleanup: terminate any instance, keep the volume, mark failed", () => {
    for (const [name, state] of Object.entries(states)) {
      if (state.Type !== "Task" || name === "MarkFailed" || name === "TerminateInstance") continue;
      expect(state.Catch?.map((c) => c.Next), name).toEqual(["Cleanup"]);
    }
    expect(states.Cleanup!.Choices![0]!.Next).toBe("TerminateInstance");
    expect(states.TerminateInstance!.Next).toBe("MarkFailed");
    expect(states.TerminateInstance!.Catch![0]!.Next).toBe("MarkFailed");
    expect(JSON.stringify(provisioner)).not.toContain("deleteVolume");
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
