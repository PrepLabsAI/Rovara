// AUTOREQUALIFY (AR-5): the deploy tooling against the real synthesized templates. What requalify-infra lifts is exactly the renewal's resources, the registered Lambda ID is CDK's, and the IAM
// statements the check prints for the AR-3 and AR-4 grants are the ones the infra emits.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { QUALIFIED_AMI_SETTING_NAME } from "../../packages/contracts/src/index.js";
import {
  CONTROL_PLANE_LAMBDAS, assertCheckAllowsApply, assertOnlyExpectedChanges, liftResources, patchLiftedCode, plannedRequalifyGrants, type CfnTemplate, type ObservedChange,
} from "../../scripts/test-deploy.js";
import { evaluateIamDrift, tier3Request } from "../../scripts/test-deploy-check.js";
import { REQUALIFY_INFRA, REQUALIFY_LAMBDA } from "../../scripts/test-deploy-requalify.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const ENV = "agentxlivetest123";
type Resource = { Type: string; Properties?: Record<string, unknown> };

function controlPlane(context: Record<string, unknown>): CfnTemplate {
  const stack = buildAgentXApp({ agentxEnv: ENV, ...context }).node.children.filter((child): child is Stack => Stack.isStack(child)).find((candidate) => candidate.stackName === `agentx-${ENV}-control-plane`);
  if (stack === undefined) throw new Error("no control-plane stack");
  return Template.fromStack(stack).toJSON();
}

describe("the renewal's deploy units against the synthesized control-plane stack", () => {
  // As TEST runs it today (the standing qualification transport on), and with the renewal on top.
  let deployed: CfnTemplate;
  let head: CfnTemplate;
  beforeAll(() => {
    deployed = controlPlane({ "agentx:e2eQualificationTransport": "enabled" });
    head = controlPlane(REQUALIFY_INFRA.context);
  }, 240_000);
  const clone = (template: CfnTemplate): CfnTemplate => JSON.parse(JSON.stringify(template)) as CfnTemplate;
  const policiesOf = (template: CfnTemplate) => Object.entries(template.Resources ?? {}).filter(([, resource]) => resource.Type === "AWS::IAM::Policy") as Array<[string, Resource]>;

  it("registers the renewal's Lambda under the logical ID CDK gives it, and only on a stack that has the renewal", () => {
    const lambdas = (template: CfnTemplate) => Object.entries(template.Resources ?? {}).filter(([, resource]) => resource.Type === "AWS::Lambda::Function" && (resource.Properties?.Code as { ZipFile?: unknown } | undefined)?.ZipFile === undefined).map(([id]) => id);
    expect(lambdas(head).filter((id) => !lambdas(deployed).includes(id))).toEqual([REQUALIFY_LAMBDA.logicalId]);
    expect(lambdas(deployed)).not.toContain(REQUALIFY_LAMBDA.logicalId);
    expect(Object.values(CONTROL_PLANE_LAMBDAS).map((lambda) => lambda.logicalId)).not.toContain(REQUALIFY_LAMBDA.logicalId);
    expect(head.Resources?.[REQUALIFY_LAMBDA.logicalId]?.Type).toBe("AWS::Lambda::Function");
  });

  it("bundles boot.sh beside the handler exactly as the infra does", () => {
    expect(REQUALIFY_LAMBDA.entry).toBe("packages/broker/src/aws/runtime-requalify-handler.ts");
    expect(REQUALIFY_LAMBDA.extraFiles).toEqual([{ from: "packages/worker/ec2/boot.sh", name: "boot.sh" }]);
  });

  it("lifts into the deployed template only the RuntimeRequalify resources, every reference of them resolved, and judges as Add-only", () => {
    const lifted = liftResources(deployed, head, REQUALIFY_INFRA.logicalIdPrefix);
    const before = Object.keys(deployed.Resources ?? {});
    const after = Object.keys(lifted.Resources ?? {});
    const added = after.filter((id) => !before.includes(id));
    expect(added.length).toBeGreaterThan(5);
    expect(added.filter((id) => !id.startsWith("RuntimeRequalify"))).toEqual([]);
    for (const id of before) expect(JSON.stringify(lifted.Resources?.[id]), id).toBe(JSON.stringify(deployed.Resources?.[id]));
    const observed: ObservedChange[] = added.map((logicalId) => ({ action: "Add", logicalId, type: lifted.Resources?.[logicalId]?.Type as string }));
    expect(() => assertOnlyExpectedChanges(observed, { action: "Add", logicalIdPrefixes: [REQUALIFY_INFRA.logicalIdPrefix] })).not.toThrow();
    // A change set that also changed an existing resource is refused: the guard is Add-only.
    expect(() => assertOnlyExpectedChanges([...observed, { action: "Modify", logicalId: CONTROL_PLANE_LAMBDAS.broker.logicalId, type: "AWS::Lambda::Function", attributes: ["Properties.Code"] }], { action: "Add", logicalIdPrefixes: [REQUALIFY_INFRA.logicalIdPrefix] })).toThrow(/unexpected changes/);
  });

  it("runs the uploaded zip in the lifted Lambda instead of the CDK asset nobody published", () => {
    const lifted = liftResources(deployed, head, REQUALIFY_INFRA.logicalIdPrefix);
    const code = { S3Bucket: "artifact-bucket", S3Key: `test-deploy/0123456789ab/${REQUALIFY_LAMBDA.logicalId}-${"c".repeat(64)}.zip`, S3ObjectVersion: "v1" };
    const patched = patchLiftedCode(lifted, [{ logicalId: REQUALIFY_LAMBDA.logicalId, code }]);
    expect(patched.Resources?.[REQUALIFY_LAMBDA.logicalId]?.Properties?.Code).toEqual(code);
    expect(lifted.Resources?.[REQUALIFY_LAMBDA.logicalId]?.Properties?.Code).not.toEqual(code);
    // Everything else of the lifted Lambda is the synthesized resource's.
    const { Code: _patched, ...restPatched } = patched.Resources?.[REQUALIFY_LAMBDA.logicalId]?.Properties ?? {};
    const { Code: _lifted, ...restLifted } = lifted.Resources?.[REQUALIFY_LAMBDA.logicalId]?.Properties ?? {};
    void _patched; void _lifted;
    expect(restPatched).toEqual(restLifted);
  });

  it("prints the AR-4 grants as the exact Tier 3 statements: ssm:GetParameter on the pin for the provisioner's and the reconciler's roles, and nothing wider", () => {
    const pin = `parameter/agentx/${ENV}/${QUALIFIED_AMI_SETTING_NAME}`;
    const withoutPin = clone(deployed);
    let removed = 0;
    for (const [, policy] of policiesOf(withoutPin)) {
      const document = policy.Properties?.PolicyDocument as { Statement: unknown[] };
      const kept = document.Statement.filter((statement) => !JSON.stringify(statement).includes(QUALIFIED_AMI_SETTING_NAME));
      removed += document.Statement.length - kept.length;
      document.Statement = kept;
    }
    expect(removed).toBe(2);
    const findings = evaluateIamDrift(deployed, withoutPin).filter((finding) => finding.kind === "iam-missing-grant");
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding.statements).toHaveLength(1);
      expect(finding.statements![0]).toMatchObject({ Effect: "Allow", Action: "ssm:GetParameter" });
      expect(JSON.stringify(finding.statements![0]!.Resource)).toContain(pin);
      expect(JSON.stringify(finding.statements![0]!.Resource)).not.toContain("*");
    }
    const roles = findings.map((finding) => finding.roleLogicalId ?? "");
    expect(roles.some((role) => role.startsWith("SessionsProvisioner"))).toBe(true);
    expect(roles.some((role) => role.startsWith("SessionsReconciler"))).toBe(true);
    const text = tier3Request(findings);
    expect(text.match(/ssm:GetParameter"/g)).toHaveLength(2);
    // The reconciler is a code unit control-plane-code moves, so the apply refuses until the grants are in.
    expect(() => assertCheckAllowsApply(findings, ["control-plane-code"], deployed)).toThrow(/iam-missing-grant SessionsReconciler/);
  });

  it("prints the AR-3 DrainRead grant as the exact Tier 3 statement of the renewal's role, and the whole renewal role set before the unit is deployed", () => {
    const withoutDrain = clone(head);
    for (const [, policy] of policiesOf(withoutDrain)) {
      const document = policy.Properties?.PolicyDocument as { Statement: Array<{ Sid?: string }> };
      document.Statement = document.Statement.filter((statement) => statement.Sid !== "DrainRead");
    }
    const findings = evaluateIamDrift(head, withoutDrain).filter((finding) => finding.kind === "iam-missing-grant");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.roleLogicalId).toMatch(/^RuntimeRequalifyStepsServiceRole/);
    const [statement] = findings[0]!.statements ?? [];
    expect(statement).toMatchObject({ Effect: "Allow", Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["READY", "WORKSPACE#*", "RUNTIME_REQUALIFY_WORK#*", "PROJECT_SETUP#*"] } } });
    expect([statement?.Action].flat().sort()).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
    expect(JSON.stringify(findings[0]!.statements)).not.toMatch(/dynamodb:(Put|Update|Delete|Batch|Transact)/);
    expect(tier3Request(findings)).toContain("PROJECT_SETUP#*");
    // Before the unit exists on the stack, the check lists every statement of the renewal's roles, and none of any other role.
    const planned = plannedRequalifyGrants(head, deployed);
    expect(planned.length).toBeGreaterThan(1);
    for (const finding of planned) expect(finding.roleLogicalId).toMatch(/^RuntimeRequalify/);
    const text = tier3Request(planned);
    for (const needle of ["ec2:RunInstances", "ec2:TerminateInstances", "ssm:PutParameter", "dynamodb:Query", "states:StartExecution"]) expect(text, needle).toContain(needle);
    expect(text).not.toContain("kms:Sign");
    // Once the stack has the renewal, head against itself is clean and the code deploy is not blocked.
    expect(plannedRequalifyGrants(head, head)).toEqual([]);
    expect(evaluateIamDrift(head, head)).toEqual([]);
  });
});
