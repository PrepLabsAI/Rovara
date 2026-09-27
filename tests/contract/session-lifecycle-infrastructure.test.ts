import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CONTROL_PLANE_FOUNDATION_PARAMETERS } from "../../packages/contracts/src/session.js";
import { buildAgentXApp } from "../../infra/lib/app.js";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };

describe("EC2 session lifecycle infrastructure (issue #83)", () => {
  let template: Template;
  let resources: Record<string, Resource>;
  let assemblyDir: string;

  beforeAll(() => {
    const app = buildAgentXApp();
    const control = app.node.children.find((c): c is Stack => Stack.isStack(c) && c.stackName === "AgentXControlPlane")!;
    template = Template.fromStack(control);
    resources = template.toJSON().Resources as Record<string, Resource>;
    assemblyDir = app.synth().directory;
  }, 240_000);

  const ofType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);
  const roleStatements = (roleId: string) => ofType("AWS::IAM::Policy")
    .filter(([, p]) => JSON.stringify(p.Properties.Roles).includes(roleId))
    .flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
  const actions = (statements: Statement[]) => new Set(statements.flatMap((s) => [s.Action].flat()));
  const stepsId = () => ofType("AWS::Lambda::Function").find(([id]) => id.startsWith("SessionsSteps"))![0];

  it("takes the foundation's EC2 values as parameters, not cross-stack imports", () => {
    const parameters = Object.keys(template.toJSON().Parameters as object);
    expect(parameters).toEqual(expect.arrayContaining([...CONTROL_PLANE_FOUNDATION_PARAMETERS]));
    expect(JSON.stringify(template.toJSON())).not.toContain("Fn::ImportValue");
  });

  it("runs the step Lambda in the private subnets with the session manager's security group, with boot.sh bundled", () => {
    const steps = resources[stepsId()]!;
    expect(steps.Properties.VpcConfig).toEqual({
      SubnetIds: { "Fn::Split": [",", { Ref: "PrivateSubnetIds" }] },
      SecurityGroupIds: [{ Ref: "SessionManagerSecurityGroupId" }],
    });
    const environment = (steps.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(environment).toMatchObject({ WORKER_SETTINGS_PREFIX: "/agentx/production/", WORKER_LOG_GROUP_NAME: "/agentx/production/worker" });
    expect(Object.keys(environment)).toEqual(expect.arrayContaining(["STATE_TABLE_NAME", "INVOKE_SIGNING_KEY_ARN", "CONTROL_PLANE_URL"]));
    // Exactly one bundled Lambda carries the boot script, next to its handler.
    const bundles = readdirSync(assemblyDir).filter((name) => name.startsWith("asset.") && existsSync(join(assemblyDir, name, "index.js")));
    const withBootScript = bundles.filter((name) => existsSync(join(assemblyDir, name, "boot.sh")));
    expect(withBootScript).toHaveLength(1);
  }, 240_000);

  it("lets the step Lambda read only the worker settings and the signing key's public key", () => {
    const roleId = (resources[stepsId()]!.Properties.Role as { "Fn::GetAtt": [string] })["Fn::GetAtt"][0];
    const statements = roleStatements(roleId);
    expect(actions(statements)).toContain("kms:GetPublicKey");
    expect(actions(statements)).not.toContain("kms:Sign");
    const ssm = statements.find((s) => [s.Action].flat().includes("ssm:GetParameters"))!;
    expect(JSON.stringify(ssm.Resource)).toContain("/agentx/production/worker-");
  });

  it("creates the provisioner and deleter with scoped roles, never ec2:* or unconditioned destructive actions", () => {
    const machines = ofType("AWS::StepFunctions::StateMachine");
    expect(machines).toHaveLength(2);
    for (const [, machine] of machines) {
      const roleId = (machine.Properties.RoleArn as { "Fn::GetAtt": [string] })["Fn::GetAtt"][0];
      const statements = roleStatements(roleId);
      expect([...actions(statements)].filter((a) => a.endsWith(":*"))).toEqual([]);
      for (const statement of statements) {
        const destructive = [statement.Action].flat().filter((a) => ["ec2:TerminateInstances", "ec2:DeleteVolume", "ec2:AttachVolume"].includes(a));
        if (destructive.length > 0) {
          expect(statement.Condition?.StringEquals).toMatchObject({ "aws:ResourceTag/DeploymentMode": "ec2-ebs", "aws:ResourceTag/Environment": "production" });
        }
      }
    }
  });

  it("launches only from the worker launch template and passes only the worker instance role", () => {
    const statements = ofType("AWS::IAM::Policy").flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
    const launch = statements.find((s) => s.Sid === "LaunchFromTemplate")!;
    expect(JSON.stringify(launch.Condition)).toContain("ec2:LaunchTemplate");
    expect(JSON.stringify(launch.Condition)).toContain("Ec2WorkerLaunchTemplateId");
    const pass = statements.find((s) => s.Sid === "PassInstanceRole")!;
    expect(pass.Resource).toEqual({ Ref: "Ec2WorkerInstanceRoleArn" });
    expect(pass.Condition).toEqual({ StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } });
    const create = statements.find((s) => s.Sid === "CreateWorkspaceVolume")!;
    expect(create.Condition).toEqual({ StringEquals: { "aws:RequestTag/DeploymentMode": "ec2-ebs", "aws:RequestTag/Environment": "production" } });
  });

  it("runs the idle reaper every minute, one run at a time, in the VPC, terminating only its own instances (#85)", () => {
    const [reaperId, reaper] = ofType("AWS::Lambda::Function").find(([id]) => id.startsWith("SessionsReaper"))!;
    expect(reaper.Properties.ReservedConcurrentExecutions).toBe(1);
    expect(reaper.Properties.VpcConfig).toEqual({
      SubnetIds: { "Fn::Split": [",", { Ref: "PrivateSubnetIds" }] },
      SecurityGroupIds: [{ Ref: "SessionManagerSecurityGroupId" }],
    });
    expect((reaper.Properties.Environment as { Variables: Record<string, unknown> }).Variables).toMatchObject({ AGENTX_METRICS_NAMESPACE: "AgentX" });
    const [[, schedule]] = ofType("AWS::Scheduler::Schedule") as [[string, Resource]];
    expect(schedule.Properties.ScheduleExpression).toBe("rate(1 minute)");
    expect(JSON.stringify(schedule.Properties.Target)).toContain(reaperId);
    const roleId = (reaper.Properties.Role as { "Fn::GetAtt": [string] })["Fn::GetAtt"][0];
    const statements = roleStatements(roleId);
    const terminate = statements.find((st) => [st.Action].flat().includes("ec2:TerminateInstances"))!;
    expect(terminate.Condition?.StringEquals).toMatchObject({ "aws:ResourceTag/DeploymentMode": "ec2-ebs", "aws:ResourceTag/Environment": "production" });
    expect(actions(statements)).toContain("states:StartExecution");
    expect([...actions(statements)].filter((a) => a.endsWith(":*"))).toEqual([]);
  });

  it("alarms the operator when either state machine fails or times out", () => {
    const alarms = ofType("AWS::CloudWatch::Alarm").filter(([, a]) => String(a.Properties.AlarmName).startsWith("AgentXSession"));
    expect(alarms.map(([, a]) => a.Properties.AlarmName).sort()).toEqual(["AgentXSessionDeleterFailures", "AgentXSessionProvisionerFailures", "AgentXSessionReaperErrors"]);
    for (const [, alarm] of alarms) expect(JSON.stringify(alarm.Properties.AlarmActions)).toContain("OperatorAlerts");
  });
});
