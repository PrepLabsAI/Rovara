import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { swebenchEvalDefinition } from "../../infra/lib/swebench-eval-definition.js";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };

describe("the SWE-bench eval stack (spec 043 FR-016, FR-017)", () => {
  let resources: Record<string, Resource>;
  let parameters: string[];

  beforeAll(() => {
    const app = buildAgentXApp({ agentxEval: "enabled" });
    const stack = app.node.children.find((c): c is Stack => Stack.isStack(c) && c.stackName === "AgentXEval")!;
    const template = Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource>; Parameters: Record<string, unknown> };
    resources = template.Resources;
    parameters = Object.keys(template.Parameters);
  }, 240_000);

  const ofType = (type: string) => Object.values(resources).filter((r) => r.Type === type);
  const statements = (roleLogicalPrefix: string) => Object.entries(resources)
    .filter(([, r]) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties.Roles).includes(roleLogicalPrefix))
    .flatMap(([, r]) => (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement);

  it("exists only when asked for, so no release deploys it", () => {
    const stacks = buildAgentXApp().node.children.filter((c): c is Stack => Stack.isStack(c)).map((s) => s.stackName);
    expect(stacks).not.toContain("AgentXEval");
  }, 240_000);

  it("takes the foundation's and control plane's values as parameters", () => {
    expect(parameters).toEqual(expect.arrayContaining(["VpcId", "PrivateSubnetIds", "ControlPlaneUrl", "ArtifactBucketName", "StateTableName", "OpenRouterSecretArn"]));
    expect(JSON.stringify(resources)).not.toContain("Fn::ImportValue");
  });

  it("launches x86 instances that read their run from tags and terminate themselves on shutdown", () => {
    const [template] = ofType("AWS::EC2::LaunchTemplate");
    const data = template!.Properties.LaunchTemplateData as Record<string, unknown>;
    expect(data).toMatchObject({
      ImageId: "resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
      InstanceType: "m7i.xlarge",
      InstanceInitiatedShutdownBehavior: "terminate",
      MetadataOptions: { HttpTokens: "required", HttpPutResponseHopLimit: 1, InstanceMetadataTags: "enabled" },
      BlockDeviceMappings: [{ Ebs: { VolumeSize: 150, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true } }],
    });
    // The boot script is in the template; the run's capability never is.
    expect(JSON.stringify(data.UserData)).toContain("agentx-eval-run");
    expect(JSON.stringify(data.UserData)).not.toContain("capability=");
  });

  it("allows HTTPS egress only, and no ingress", () => {
    const [group] = ofType("AWS::EC2::SecurityGroup");
    expect(group!.Properties.SecurityGroupIngress).toBeUndefined();
    expect(group!.Properties.SecurityGroupEgress).toEqual([expect.objectContaining({ IpProtocol: "tcp", FromPort: 443, ToPort: 443 }) as unknown]);
  });

  it("lets the instance read only launch files and write only under evals/", () => {
    const instance = statements("InstanceRole");
    const s3 = instance.filter((st) => [st.Action].flat().some((action) => action.startsWith("s3:")));
    expect(s3.map((st) => [st.Action, JSON.stringify(st.Resource)])).toEqual([
      ["s3:GetObject", expect.stringContaining("/evals/*/launch.json") as unknown],
      ["s3:PutObject", expect.stringContaining("/evals/*") as unknown],
    ]);
    expect([...new Set(instance.flatMap((st) => [st.Action].flat()))].filter((action) => action.startsWith("dynamodb:") || action.startsWith("states:"))).toEqual([]);
  });

  it("lets the state machine terminate only eval instances of this environment", () => {
    const machine = statements("StateMachineRole");
    const terminate = machine.find((st) => [st.Action].flat().includes("ec2:TerminateInstances"))!;
    expect(terminate.Condition?.StringEquals).toEqual({ "aws:ResourceTag/DeploymentMode": "swebench-eval", "aws:ResourceTag/Environment": "production" });
    const [stateMachine] = ofType("AWS::StepFunctions::StateMachine");
    expect(stateMachine!.Properties.StateMachineName).toBe("agentx-production-swebench-eval");
  });

  it("publishes its settings where the broker reads them", () => {
    const settings = ofType("AWS::SSM::Parameter").map((p) => p.Properties.Name);
    expect(settings).toEqual(["/agentx/production/eval/settings"]);
  });
});

describe("the eval state machine (spec 043 FR-006)", () => {
  const definition = swebenchEvalDefinition({ launchTemplateId: "lt-1", stateTableName: "state", environmentTag: "production", resourcePrefix: "agentx-production" }) as {
    StartAt: string; States: Record<string, { Type: string; Next?: string; Default?: string; Choices?: Array<{ Condition: string; Next: string }>; Catch?: Array<{ ErrorEquals: string[]; Next: string }>; Arguments?: Record<string, unknown> }>;
  };
  const exits = (name: string) => {
    const state = definition.States[name]!;
    return [state.Next, state.Default, ...(state.Choices ?? []).map((c) => c.Next), ...(state.Catch ?? []).map((c) => c.Next)].filter((next): next is string => next !== undefined);
  };

  it("reaches every state, and every path ends through the terminate step", () => {
    const reachable = new Set<string>();
    const visit = (name: string) => {
      if (reachable.has(name)) return;
      reachable.add(name);
      for (const next of exits(name)) visit(next);
    };
    visit(definition.StartAt);
    expect([...reachable].sort()).toEqual(Object.keys(definition.States).sort());
    const ends = Object.entries(definition.States).filter(([, state]) => state.Type === "Succeed" || state.Type === "Fail").map(([name]) => name);
    expect(ends.sort()).toEqual(["Done", "SlotReleaseFailed"]);
    // Spec 052: a release that fails still terminates the instance, then fails the execution.
    const intoFailure = Object.keys(definition.States).filter((name) => exits(name).includes("SlotReleaseFailed"));
    expect(intoFailure.sort()).toEqual(["ReleaseFailed", "TerminateBeforeFailing"]);
    expect(definition.States.ReleaseFailed!.Choices).toEqual([{ Condition: "{% $instanceId = null %}", Next: "SlotReleaseFailed" }]);
    expect(definition.States.ReleaseFailed!.Default).toBe("TerminateBeforeFailing");
  });

  it("launches once per run and marks a run it ends only while the run is active", () => {
    const text = JSON.stringify(definition);
    expect(text).toContain("\"ClientToken\":\"{% $runId %}\"");
    expect(text).toContain("#status = :active0 OR #status = :active1 OR #status = :active2");
  });

  it("releases the run's slot and the shared counter with the run's end, exactly once (spec 052 FR-005)", () => {
    const items = definition.States.EndRun!.Arguments!.TransactItems as Array<Record<string, Record<string, unknown>>>;
    expect(items.map((item) => Object.keys(item)[0])).toEqual(["Update", "Delete", "Update"]);
    expect(items[1]!.Delete).toMatchObject({ Key: { pk: { S: "SWEBENCH#SLOT" }, sk: { S: "{% 'RUN#' & $runId %}" } }, ConditionExpression: "attribute_exists(pk)" });
    expect(items[2]!.Update).toMatchObject({
      Key: { pk: { S: "SWEBENCH#SLOTS" }, sk: { S: "COUNTER" } },
      UpdateExpression: "SET #count = #count - :one",
      ConditionExpression: "#count > :zero",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":one": { N: "1" }, ":zero": { N: "0" } },
    });
    expect(JSON.stringify(items)).not.toContain("SWEBENCH#ACTIVE");
    // A run from before spec 052 holds no slot: it is ended with the one-run lock it held, and no decrement.
    const legacy = definition.States.EndRunWithoutSlot!.Arguments!.TransactItems as Array<Record<string, Record<string, unknown>>>;
    expect(legacy.map((item) => Object.keys(item)[0])).toEqual(["Update", "Delete"]);
    expect(legacy[0]!.Update).toEqual(items[0]!.Update);
    expect(legacy[1]!.Delete).toMatchObject({
      Key: { pk: { S: "SWEBENCH#ACTIVE" }, sk: { S: "LOCK" } },
      ConditionExpression: "attribute_not_exists(pk) OR runId = :runId",
      ExpressionAttributeValues: { ":runId": { S: "{% $runId %}" } },
    });
  });

  it("goes straight to terminate only for a cancelled release; any other error fails the execution after terminating", () => {
    expect(definition.States.EndRun!.Catch).toEqual([
      expect.objectContaining({ ErrorEquals: ["DynamoDb.TransactionCanceledException"], Next: "ReadEnded" }),
      expect.objectContaining({ ErrorEquals: ["States.ALL"], Next: "ReleaseFailed" }),
    ]);
    // A cancelled release is read back: a run already terminal was released by the broker; a run
    // with no slot item began under the one-run lock; a held slot is tried again, then fails.
    expect(exits("ReadEnded").sort()).toEqual(["ReleaseFailed", "Released"]);
    expect(definition.States.Released!.Choices!.map((choice) => choice.Next)).toEqual(["Terminate", "EndRunWithoutSlot", "EndRunAgain"]);
    expect(definition.States.Released!.Default).toBe("ReleaseFailed");
    expect(exits("EndRunAgain")).toEqual(["EndRun"]);
    expect(definition.States.EndRunWithoutSlot!.Catch).toEqual([
      expect.objectContaining({ ErrorEquals: ["DynamoDb.TransactionCanceledException"], Next: "ReadEnded" }),
      expect.objectContaining({ ErrorEquals: ["States.ALL"], Next: "ReleaseFailed" }),
    ]);
    // A transaction's conflicts arrive as TransactionCanceledException, so no retry names TransactionConflictException.
    const text = JSON.stringify(definition);
    expect(text).not.toContain("TransactionConflictException");
    expect(text).not.toContain("DynamoDB.");
  });
});
