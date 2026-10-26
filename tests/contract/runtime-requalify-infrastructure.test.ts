// AUTOREQUALIFY (AR-2): the renewal's infrastructure. Authority is the point: it may end only what carries the three renewal tags, launch only from the
// environment's template, and never sign or read a secret. All of it is Add-only (logical-ID prefix RuntimeRequalify) and off unless the context says "enabled".
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { REQUALIFY_LOGICAL_ID_PREFIX, requalifyDefinition } from "../../infra/lib/runtime-requalify.js";
import { REQUALIFY_SCHEDULE_LOGICAL_ID } from "../../scripts/test-deploy-requalify.js";
import { checkLambdaBundles } from "../../scripts/lambda-load-check.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
const ENV = "agentxlivetest123";

function controlPlane(context: Record<string, unknown>): Record<string, Resource> {
  const stack = buildAgentXApp({ agentxEnv: ENV, ...context }).node.children.filter((child): child is Stack => Stack.isStack(child)).find((candidate) => candidate.stackName === `agentx-${ENV}-control-plane`);
  if (stack === undefined) throw new Error("no control-plane stack");
  return Template.fromStack(stack).toJSON().Resources as Record<string, Resource>;
}

describe("the renewal's infrastructure", () => {
  let off: Record<string, Resource>;
  let on: Record<string, Resource>;
  beforeAll(() => {
    off = controlPlane({});
    on = controlPlane({ "agentx:autoRequalify": "enabled" });
  }, 240_000);

  const added = () => Object.keys(on).filter((id) => !(id in off));
  const stepsId = () => Object.entries(on).find(([id, resource]) => resource.Type === "AWS::Lambda::Function" && id.startsWith(`${REQUALIFY_LOGICAL_ID_PREFIX}Steps`))![0];
  const roleId = () => (on[stepsId()]!.Properties["Role"] as { "Fn::GetAtt": [string] })["Fn::GetAtt"][0];
  const statements = (): Statement[] => Object.values(on)
    .filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties["Roles"]).includes(roleId()))
    .flatMap((resource) => (resource.Properties["PolicyDocument"] as { Statement: Statement[] }).Statement);
  const withAction = (action: string) => statements().filter((statement) => [statement.Action].flat().includes(action));
  const tagConditions = (statement: Statement) => statement.Condition?.["StringEquals"] ?? {};

  it("is off by default and, when on, adds only resources with the RuntimeRequalify prefix (an Add-only change set)", () => {
    expect(Object.keys(off).filter((id) => id.startsWith(REQUALIFY_LOGICAL_ID_PREFIX))).toEqual([]);
    expect(added().length).toBeGreaterThan(5);
    expect(added().filter((id) => !id.startsWith(REQUALIFY_LOGICAL_ID_PREFIX))).toEqual([]);
    // Nothing that existed before was changed by the flag.
    for (const id of Object.keys(off)) expect(JSON.stringify(on[id]), id).toBe(JSON.stringify(off[id]));
    // Only the exact string turns it on.
    expect(Object.keys(controlPlane({ "agentx:autoRequalify": true })).filter((id) => id.startsWith(REQUALIFY_LOGICAL_ID_PREFIX))).toEqual([]);
  });

  it("may end an instance or delete a volume only if it carries all three renewal tags and this environment", () => {
    for (const action of ["ec2:TerminateInstances", "ec2:DeleteVolume", "ec2:AttachVolume"]) {
      const found = withAction(action);
      expect(found.length, action).toBeGreaterThan(0);
      for (const statement of found) {
        expect(tagConditions(statement), action).toEqual({
          "aws:ResourceTag/DeploymentMode": "e2e-qualification", "aws:ResourceTag/Environment": ENV, "aws:ResourceTag/agentx:requalify-managed": "true",
        });
        expect(JSON.stringify(statement.Resource), action).toMatch(/:(instance|volume)\/\*/);
      }
    }
    // Nothing destructive is granted anywhere without those conditions (a statement listing one of the actions among others counts too).
    for (const statement of statements()) {
      const destructive = [statement.Action].flat().filter((action) => ["ec2:TerminateInstances", "ec2:DeleteVolume", "ec2:DeleteSnapshot", "ec2:StopInstances"].includes(action));
      if (destructive.length > 0) expect(Object.keys(tagConditions(statement)).length, JSON.stringify(statement)).toBe(3);
    }
  });

  it("launches only from the environment's launch template, with the three renewal tags on what it creates", () => {
    const runOnInstance = withAction("ec2:RunInstances").filter((statement) => JSON.stringify(statement.Resource).includes(":instance/*"));
    expect(runOnInstance).toHaveLength(1);
    const condition = runOnInstance[0]!.Condition!;
    expect(JSON.stringify(condition["ArnEquals"])).toContain("ec2:LaunchTemplate");
    expect(condition["StringEquals"]).toEqual({ "aws:RequestTag/DeploymentMode": "e2e-qualification", "aws:RequestTag/Environment": ENV, "aws:RequestTag/agentx:requalify-managed": "true" });
    const create = withAction("ec2:CreateVolume");
    expect(create).toHaveLength(1);
    expect(create[0]!.Condition!["StringEquals"]).toEqual({ "aws:RequestTag/DeploymentMode": "e2e-qualification", "aws:RequestTag/Environment": ENV, "aws:RequestTag/agentx:requalify-managed": "true" });
    // Amazon's own images only.
    const image = withAction("ec2:RunInstances").find((statement) => JSON.stringify(statement.Resource).includes("::image/*"));
    expect(image?.Condition?.["StringEquals"]).toEqual({ "ec2:Owner": "amazon" });
    // Tags are written only as part of creating the volume or the instance.
    expect(withAction("ec2:CreateTags")[0]!.Condition!["StringEquals"]).toEqual({ "ec2:CreateAction": ["CreateVolume", "RunInstances"] });
  });

  it("may use the workspace key only through EC2 (EBS), and create grants only for AWS resources", () => {
    const kms = statements().filter((statement) => [statement.Action].flat().some((action) => action.startsWith("kms:") && action !== "kms:GetPublicKey"));
    expect(kms.length).toBeGreaterThan(0);
    for (const statement of kms) {
      expect(JSON.stringify(statement.Condition?.["StringEquals"]), JSON.stringify(statement.Action)).toContain("kms:ViaService");
      expect(JSON.stringify(statement.Condition?.["StringEquals"])).toMatch(/ec2\./);
    }
    const create = kms.filter((statement) => [statement.Action].flat().includes("kms:CreateGrant"));
    expect(create).toHaveLength(1);
    expect(create[0]!.Condition?.["Bool"]).toEqual({ "kms:GrantIsForAWSResource": "true" });
  });

  it("never signs, never reads a secret, and passes only the worker role to EC2", () => {
    const all = statements().flatMap((statement) => [statement.Action].flat());
    expect(all.filter((action) => /kms:Sign|kms:Verify|secretsmanager:|ssm:GetParametersByPath|iam:Create|iam:Put|iam:Attach|sts:/.test(action))).toEqual([]);
    expect(withAction("kms:GetPublicKey")).toHaveLength(1);
    const pass = withAction("iam:PassRole");
    expect(pass).toHaveLength(1);
    expect(pass[0]!.Condition).toEqual({ StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } });
    // SSM: reads the AMI and the worker settings, writes exactly one setting, and never with decryption.
    const put = withAction("ssm:PutParameter");
    expect(put).toHaveLength(1);
    // Exactly the one parameter AR-4's provisioner and reconciler read: <worker settings prefix>worker-qualified-ami.
    expect(JSON.stringify(put[0]!.Resource)).toContain(`parameter/agentx/${ENV}/worker-qualified-ami`);
    expect([put[0]!.Resource].flat()).toHaveLength(1);
    expect(all).not.toContain("ssm:GetParameterHistory");
  });

  it("reads and writes the State table only under the renewal's key prefixes", () => {
    const state = withAction("dynamodb:PutItem");
    expect(state).toHaveLength(1);
    expect(state[0]!.Condition!["ForAllValues:StringLike"]).toEqual({ "dynamodb:LeadingKeys": ["E2E_FEATURE_VERIFIER#*", "RUNTIME_INSTALL_CHALLENGE#*", "RUNTIME_INSTALLATION_EVIDENCE#*", "RUNTIME_REQUALIFY*", "E2E_MODEL_ROUTES"] });
    // The drain (AR-3) only reads: Query and GetItem under the sessions index and the workspace, setup-marker and setup-execution keys; no write action is granted there.
    const drain = withAction("dynamodb:Query");
    expect(drain).toHaveLength(1);
    expect([drain[0]!.Action].flat().sort()).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
    expect(drain[0]!.Condition!["ForAllValues:StringLike"]).toEqual({ "dynamodb:LeadingKeys": ["READY", "WORKSPACE#*", "RUNTIME_REQUALIFY_WORK#*", "PROJECT_SETUP#*"] });
    expect(JSON.stringify(drain[0]!.Resource)).toContain("/index/bySessionState");
    // Objects: the runner's prefix and the content-addressed evidence, nothing else; listing only under the runner prefix.
    const objects = withAction("s3:PutObject").flatMap((statement) => JSON.stringify(statement.Resource));
    expect(objects.join(" ")).toMatch(/e2e-runtime\/\*/);
    expect(objects.join(" ")).toMatch(/runtime-installations\/sha256\/\*/);
    expect(objects.join(" ")).not.toMatch(/"\/\*"|\/private\//);
    expect(withAction("s3:DeleteObject")).toHaveLength(1);
    expect(withAction("s3:ListBucket")[0]!.Condition).toEqual({ StringLike: { "s3:prefix": ["e2e-runtime/*"] } });
  });

  it("runs as one Lambda (5 minute calls) behind a 3 hour machine, started daily, with an alarm for six days without a renewal", () => {
    expect(on[stepsId()]!.Properties["Timeout"]).toBe(300);
    const machines = Object.entries(on).filter(([, resource]) => resource.Type === "AWS::StepFunctions::StateMachine" && JSON.stringify(resource.Properties).includes("RuntimeRequalify"));
    expect(machines).toHaveLength(1);
    expect(JSON.stringify(machines[0]![1].Properties)).toContain('\\"TimeoutSeconds\\":10800');
    const schedules = Object.values(on).filter((resource) => resource.Type === "AWS::Scheduler::Schedule" && JSON.stringify(resource.Properties["Target"]).includes(stepsId()));
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.Properties["ScheduleExpression"]).toBe("cron(0 6 * * ? *)");
    expect(JSON.stringify(schedules[0]!.Properties["Target"])).toContain('{\\"action\\":\\"due\\"}');
    const stale = Object.values(on).find((resource) => resource.Type === "AWS::CloudWatch::Alarm" && JSON.stringify(resource.Properties).includes("RequalifySucceeded"));
    expect(stale?.Properties).toMatchObject({ EvaluationPeriods: 6, Period: 86400, ComparisonOperator: "LessThanThreshold", Threshold: 1, TreatMissingData: "breaching" });
    // The Lambda may start only the renewal machine.
    expect(JSON.stringify(withAction("states:StartExecution")[0]!.Resource)).toContain("-runtime-requalify");
  });
});

describe("the daily schedule is created disabled (AR-5 review I1)", () => {
  const schedulesOf = (resources: Record<string, Resource>) => Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::Scheduler::Schedule" && JSON.stringify(resource).includes("RuntimeRequalify"));

  it("so no renewal can start just because the infrastructure exists; only the explicit context (set by the requalify-schedule unit's CDK equivalent) enables it", () => {
    const disabled = schedulesOf(controlPlane({ "agentx:autoRequalify": "enabled" }));
    expect(disabled).toHaveLength(1);
    expect(disabled[0]![1].Properties["State"]).toBe("DISABLED");
    // Only the exact string turns the schedule on, as for the renewal itself.
    expect(schedulesOf(controlPlane({ "agentx:autoRequalify": "enabled", "agentx:autoRequalifySchedule": true }))[0]![1].Properties["State"]).toBe("DISABLED");
    const enabled = schedulesOf(controlPlane({ "agentx:autoRequalify": "enabled", "agentx:autoRequalifySchedule": "enabled" }));
    expect(enabled[0]![1].Properties["State"]).toBe("ENABLED");
    // The schedule's logical ID is the one the requalify-schedule unit changes.
    expect(disabled[0]![0]).toBe(REQUALIFY_SCHEDULE_LOGICAL_ID);
  });
});

describe("the renewal's step machine", () => {
  const definition = requalifyDefinition("arn:aws:lambda:us-east-1:111122223333:function:steps") as { StartAt: string; TimeoutSeconds: number; States: Record<string, Record<string, unknown>> };

  it("bounds the whole run, and every task catches its failures into the failure path", () => {
    expect(definition.TimeoutSeconds).toBe(10_800);
    const tasks = Object.entries(definition.States).filter(([, state]) => state["Type"] === "Task");
    expect(tasks.length).toBeGreaterThanOrEqual(20);
    for (const [name, state] of tasks) {
      expect(state["Catch"], name).toEqual([expect.objectContaining({ ErrorEquals: ["States.ALL"], ResultPath: "$.error" })]);
      expect(JSON.stringify(state["Parameters"]), name).toContain('"state.$":"$"');
    }
  });

  it("never lets a Wait loop run unbounded: every polling phase has a timeout branch", () => {
    for (const [name, state] of Object.entries(definition.States).filter(([stateName]) => stateName.endsWith("Choice") && stateName.startsWith("Await"))) {
      const nexts = (state["Choices"] as Array<{ StringEquals: string; Next: string }>).map((choice) => [choice.StringEquals, choice.Next]);
      expect(nexts.map(([status]) => status).sort(), name).toEqual(["failed", "ready", "timeout", "waiting"]);
      expect((Object.fromEntries(nexts) as Record<string, string>)["timeout"], name).toMatch(/^Reason|^CleanupFailedReason/);
    }
  });
});

describe("the renewal's Lambda bundle", () => {
  it("loads (or stops at a missing environment variable only), like every control-plane Lambda", async () => {
    const report = await checkLambdaBundles({ root: process.cwd(), entries: [{ name: "runtime-requalify", entry: "packages/broker/src/aws/runtime-requalify-handler.ts" }] });
    expect(report.results.map((result) => result.name)).toEqual(["runtime-requalify"]);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  }, 120_000);
});
