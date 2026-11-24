import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { applyLegacyRuntimeBoundary, legacyRuntimeBoundaryName, legacyRuntimeBoundaryStatements } from "../../infra/lib/legacy-runtime-boundary.js";
import { environmentNaming, legacyNaming } from "../../infra/lib/naming.js";
import { AGENTX_BETA_RELEASE_PROJECT_NAME, AGENTX_RELEASE_PROJECT_NAME } from "../../infra/lib/release-pipeline.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { legacyProductionStacks } from "../support/template-snapshot.js";
import { withoutLegacyRuntimeBoundary } from "../support/legacy-runtime-boundary-template.js";

skipLambdaBundling();

// DEC 254zzz443: the deployment that predates environments (no agentxEnv) has no permissions boundary, so a runtime role that was ever granted
// cloudformation:* or iam:* by mistake could rewrite the account. Fix A caps every runtime role with a deny-only boundary. These tests prove which
// roles carry it, what each deny stops, that the worker's one PassRole to EC2 still passes, and that no existing allow of any runtime role is denied.

type Json = Record<string, unknown>;
type Statement = { Sid?: string; Effect: string; Action?: string | string[]; NotAction?: string | string[]; Resource?: unknown; NotResource?: unknown; Condition?: Record<string, Record<string, string>> };
type TemplateJson = { Resources: Record<string, { Type: string; Properties: Json }> };

const ACCOUNT = "123456789012";
const WORKER_ROLE = `arn:aws:iam::${ACCOUNT}:role/AgentXProductionFoundation-Ec2WorkersInstanceRole-ABC123`;
const STACK_PARTS = { AgentXControlPlane: "control-plane", AgentXProductionFoundation: "foundation", AgentXSlackOrchestrator: "slack" } as const;
/** Every role of the release pipeline stack: the deployer, never bounded. */
const PIPELINE_STACK = "AgentXReleasePipeline";

const templates = new Map<string, TemplateJson>();
beforeAll(() => {
  for (const stack of legacyProductionStacks()) templates.set(stack.stackName, Template.fromStack(stack).toJSON() as TemplateJson);
}, 300_000);

const template = (name: string): TemplateJson => {
  const found = templates.get(name);
  if (found === undefined) throw new Error(`no ${name} template`);
  return found;
};
const rolesOf = (name: string) => Object.entries(template(name).Resources).filter(([, r]) => r.Type === "AWS::IAM::Role");
const boundaryOf = (name: string) => {
  const policies = Object.entries(template(name).Resources).filter(([, r]) => r.Type === "AWS::IAM::ManagedPolicy");
  expect(policies, `${name} has one managed policy`).toHaveLength(1);
  const [id, policy] = policies[0]!;
  return { id, properties: policy.Properties, statements: (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement };
};

/** Resolves the intrinsics the boundary and the role policies use to a plain string (an unknown reference becomes a marker that matches no ARN pattern). */
function resolve(value: unknown): string {
  if (typeof value === "string") return value;
  const node = value as Json;
  if ("Ref" in node) {
    const ref = node.Ref as string;
    if (ref === "AWS::Partition") return "aws";
    if (ref === "AWS::Region") return "us-east-1";
    if (ref === "AWS::AccountId") return ACCOUNT;
    if (ref === "Ec2WorkerInstanceRoleArn") return WORKER_ROLE;
    return `<Ref:${ref}>`;
  }
  if ("Fn::Join" in node) {
    const [separator, parts] = node["Fn::Join"] as [string, unknown[]];
    return parts.map(resolve).join(separator);
  }
  if ("Fn::GetAtt" in node) return `<GetAtt:${(node["Fn::GetAtt"] as string[]).join(".")}>`;
  return `<${Object.keys(node).join(",")}>`;
}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const glob = (pattern: string, text: string, ignoreCase: boolean): boolean => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, ignoreCase ? "i" : "").test(text);

interface Request { readonly action: string; readonly resource: string; readonly passedToService?: string }

/** The statements of `statements` that explicitly deny the request. Only the condition shape the boundary uses is supported. */
function denyingStatements(statements: readonly Statement[], request: Request, actionOnly = false): string[] {
  return statements.filter((statement) => {
    if (statement.Effect !== "Deny") return false;
    const actionMatches = statement.Action !== undefined
      ? list(statement.Action).some((pattern) => glob(pattern as string, request.action, true))
      : !list(statement.NotAction).some((pattern) => glob(pattern as string, request.action, true));
    if (!actionMatches) return false;
    // actionOnly: the deny's action list alone (a near-miss check; the resource and the condition are what set an allow apart).
    if (actionOnly) return statement.Action !== undefined || request.action.toLowerCase().startsWith("cloudformation:");
    const resourceMatches = statement.Resource !== undefined
      ? list(statement.Resource).some((pattern) => glob(resolve(pattern), request.resource, false))
      : !list(statement.NotResource).some((pattern) => glob(resolve(pattern), request.resource, false));
    if (!resourceMatches) return false;
    for (const [operator, keys] of Object.entries(statement.Condition ?? {})) {
      if (operator !== "StringNotEquals") throw new Error(`unsupported condition operator ${operator}`);
      for (const [key, expected] of Object.entries(keys)) {
        if (key !== "iam:PassedToService") throw new Error(`unsupported condition key ${key}`);
        // A missing key makes a negated operator true.
        if (request.passedToService === expected) return false;
      }
    }
    return true;
  }).map((statement) => statement.Sid ?? "?");
}

const stackArn = `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/AgentXControlPlane/0a1b2c3d`;
const changeSetArn = `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/cs/0a1b2c3d`;
const cdkRole = (kind: string) => `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-${kind}-${ACCOUNT}-us-east-1`;

describe("legacy runtime boundary: which roles carry it", () => {
  it("is on every runtime role of the control plane, foundation and Slack orchestrator, pointing at that stack's own policy (29 roles, an in-place property)", () => {
    let roles = 0;
    for (const [stackName, part] of Object.entries(STACK_PARTS)) {
      const boundary = boundaryOf(stackName);
      expect(boundary.properties.ManagedPolicyName).toBe(legacyRuntimeBoundaryName(legacyNaming(), part));
      expect(boundary.properties.ManagedPolicyName).toBe(`agentx-production-runtime-boundary-${part}`);
      const stackRoles = rolesOf(stackName);
      expect(stackRoles.length, stackName).toBeGreaterThan(0);
      for (const [id, role] of stackRoles) {
        roles += 1;
        expect(role.Properties.PermissionsBoundary, `${stackName} ${id}`).toStrictEqual({ Ref: boundary.id });
      }
    }
    expect(roles).toBe(29);
    expect([rolesOf("AgentXControlPlane").length, rolesOf("AgentXProductionFoundation").length, rolesOf("AgentXSlackOrchestrator").length]).toEqual([26, 2, 1]);
  });

  it("names the worker's instance role, the Slack task role and the Lambda roles among the bounded roles", () => {
    const ids = (name: string) => rolesOf(name).map(([id]) => id);
    expect(ids("AgentXProductionFoundation").some((id) => id.startsWith("Ec2WorkersInstanceRole"))).toBe(true);
    expect(ids("AgentXControlPlane").filter((id) => id.startsWith("SlackOrchestratorTaskRole"))).toHaveLength(1);
    expect(ids("AgentXControlPlane").filter((id) => id.startsWith("BrokerServiceRole"))).toHaveLength(1);
    expect(ids("AgentXSlackOrchestrator").filter((id) => id.startsWith("ExecutionRole"))).toHaveLength(1);
  });

  it("is on no release pipeline role, and no other legacy stack gets a boundary policy", () => {
    const pipeline = rolesOf(PIPELINE_STACK);
    expect(pipeline).toHaveLength(6);
    for (const [id, role] of pipeline) expect(role.Properties.PermissionsBoundary, id).toBeUndefined();
    for (const stackName of [PIPELINE_STACK, "AgentXProductionRuntime"]) {
      expect(JSON.stringify(template(stackName)), stackName).not.toContain("PermissionsBoundary");
      expect(Object.values(template(stackName).Resources).filter((r) => r.Type === "AWS::IAM::ManagedPolicy"), stackName).toEqual([]);
    }
  });

  it("changes nothing else: taking out the policy and the property returns each template to its recorded shape, and no role has a changed name or path", () => {
    for (const stackName of Object.keys(STACK_PARTS)) {
      const full = template(stackName);
      const stripped = withoutLegacyRuntimeBoundary(full);
      const before = Object.keys(full.Resources).length;
      expect(Object.keys(stripped.Resources).length, stackName).toBe(before - 1);
      // The stripped roles keep every other property byte for byte (a RoleName or Path change would be a replacement).
      for (const [id, role] of rolesOf(stackName)) {
        const rest = { ...role.Properties };
        delete rest.PermissionsBoundary;
        expect(stripped.Resources[id]!.Properties, id).toStrictEqual(rest);
      }
    }
  });

  it("is not part of a named environment (it has its own boundary), and the helper refuses one", () => {
    const app = buildAgentXApp({ agentxEnv: "staging" });
    for (const stack of app.node.children.filter((c): c is Stack => Stack.isStack(c))) {
      expect(JSON.stringify(Template.fromStack(stack).toJSON()), stack.stackName).not.toContain("runtime-boundary");
    }
    const stack = new Stack(new App(), "Named");
    expect(() => applyLegacyRuntimeBoundary(stack, environmentNaming("staging"), "slack")).toThrow(/predates named environments/);
  });

  it("refuses a role that already has a boundary instead of overwriting it", () => {
    const stack = new Stack(new App(), "Existing");
    new iam.CfnRole(stack, "Role", { assumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] }, permissionsBoundary: "arn:aws:iam::123456789012:policy/other" });
    applyLegacyRuntimeBoundary(stack, legacyNaming(), "slack");
    expect(() => Template.fromStack(stack)).toThrow(/already has a permissions boundary/);
  });

  it("needs the worker role parameter in the control plane (no silent PassRole deny without its exception)", () => {
    expect(() => applyLegacyRuntimeBoundary(new Stack(new App(), "NoParameter"), legacyNaming(), "control-plane")).toThrow(/Ec2WorkerInstanceRoleArn/);
  });
});

describe("legacy runtime boundary: the statements", () => {
  it("keeps AllowAll first, so each role's own policy stays its ceiling, and has no KMS deny (the provisioner needs kms:CreateGrant)", () => {
    for (const stackName of Object.keys(STACK_PARTS)) {
      const { statements } = boundaryOf(stackName);
      expect(statements[0]).toStrictEqual({ Sid: "AllowAll", Effect: "Allow", Action: "*", Resource: "*" });
      expect(statements.slice(1).every((s) => s.Effect === "Deny"), stackName).toBe(true);
      expect(JSON.stringify(statements), stackName).not.toMatch(/kms:/i);
    }
  });

  it("the three copies are the same except for the PassRole exception, which only the control plane has", () => {
    const sids = (name: string) => boundaryOf(name).statements.map((s) => s.Sid);
    expect(sids("AgentXProductionFoundation")).toEqual(sids("AgentXSlackOrchestrator"));
    expect(boundaryOf("AgentXProductionFoundation").statements).toEqual(boundaryOf("AgentXSlackOrchestrator").statements);
    const controlPlane = boundaryOf("AgentXControlPlane").statements;
    expect(controlPlane.find((s) => s.Sid === "DenyPassRoleExceptWorkerRole")).toStrictEqual({
      Sid: "DenyPassRoleExceptWorkerRole", Effect: "Deny", Action: "iam:PassRole", NotResource: { Ref: "Ec2WorkerInstanceRoleArn" },
    });
    for (const stackName of ["AgentXProductionFoundation", "AgentXSlackOrchestrator"]) {
      expect(boundaryOf(stackName).statements.find((s) => s.Sid === "DenyPassRole")).toStrictEqual({ Sid: "DenyPassRole", Effect: "Deny", Action: "iam:PassRole", Resource: "*" });
      expect(JSON.stringify(boundaryOf(stackName).statements)).not.toContain("Ec2WorkerInstanceRoleArn");
    }
    expect(legacyRuntimeBoundaryStatements().length).toBeGreaterThan(8);
  });

  it("lists the boundary-removal actions in a statement of their own", () => {
    const statement = boundaryOf("AgentXProductionFoundation").statements.find((s) => s.Sid === "DenyBoundaryChanges")!;
    expect(statement.Resource).toBe("*");
    expect(statement.Action).toEqual(expect.arrayContaining(["iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary", "iam:DeletePolicy", "iam:CreatePolicyVersion"]));
  });

  const cases: ReadonlyArray<{ group: string; denied: readonly Request[]; allowed: readonly Request[] }> = [
    {
      group: "IAM changes",
      denied: ["CreateRole", "DeleteRole", "PutRolePolicy", "AttachRolePolicy", "DetachRolePolicy", "UpdateAssumeRolePolicy", "UpdateRole", "TagRole", "UntagRole", "TagPolicy", "UntagPolicy",
        "CreatePolicy", "CreatePolicyVersion", "DeletePolicy", "CreateInstanceProfile", "AddRoleToInstanceProfile", "CreateUser", "AttachUserPolicy", "CreateAccessKey"]
        .map((name) => ({ action: `iam:${name}`, resource: `arn:aws:iam::${ACCOUNT}:role/anything` })),
      allowed: ["GetRole", "ListRoles", "ListAttachedRolePolicies", "GetRolePolicy", "SimulatePrincipalPolicy"].map((name) => ({ action: `iam:${name}`, resource: `arn:aws:iam::${ACCOUNT}:role/anything` })),
    },
    {
      group: "removing or changing a boundary",
      denied: ["DeleteRolePermissionsBoundary", "PutRolePermissionsBoundary", "DeleteUserPermissionsBoundary", "PutUserPermissionsBoundary", "SetDefaultPolicyVersion", "DeletePolicyVersion"]
        .map((name) => ({ action: `iam:${name}`, resource: `arn:aws:iam::${ACCOUNT}:role/agentx-runtime` })),
      allowed: [],
    },
    {
      group: "CloudFormation changes",
      denied: [
        ...["UpdateStack", "CreateStack", "DeleteStack", "CreateChangeSet", "ExecuteChangeSet", "DeleteChangeSet", "SetStackPolicy", "CancelUpdateStack", "ContinueUpdateRollback", "UpdateTerminationProtection", "SignalResource", "DetectStackDrift", "DetectStackResourceDrift"]
          .map((name) => ({ action: `cloudformation:${name}`, resource: stackArn })),
        { action: "cloudformation:ExecuteChangeSet", resource: changeSetArn },
        ...["RegisterType", "SetTypeConfiguration", "CreateStackSet", "ActivateType", "PublishType", "ImportStacksToStackSet"].map((name) => ({ action: `cloudformation:${name}`, resource: "*" })),
      ],
      allowed: [
        ...["DescribeStacks", "DescribeStackEvents", "GetTemplate", "ListStackResources", "GetTemplateSummary"].map((name) => ({ action: `cloudformation:${name}`, resource: stackArn })),
        { action: "cloudformation:ListStacks", resource: "*" },
      ],
    },
    {
      group: "assuming or passing the CDK deployer roles",
      denied: [
        ...["deploy-role", "cfn-exec-role", "file-publishing-role", "image-publishing-role", "lookup-role"].flatMap((kind) => [
          { action: "sts:AssumeRole", resource: cdkRole(kind) },
          { action: "iam:PassRole", resource: cdkRole(kind), passedToService: "cloudformation.amazonaws.com" },
          { action: "iam:PassRole", resource: cdkRole(kind), passedToService: "ec2.amazonaws.com" },
        ]),
        { action: "sts:AssumeRole", resource: "arn:aws:iam::123456789012:role/cdk-hnb659fds-deploy-role-123456789012-us-east-1" },
        // Opus IAM review: the pipeline's SourceActionRole trusts the account root and writes the source the release build deploys.
        { action: "sts:AssumeRole", resource: `arn:aws:iam::${ACCOUNT}:role/AgentXReleasePipeline-SourceActionRole4344B1D1-ABC` },
        { action: "sts:AssumeRole", resource: `arn:aws:iam::${ACCOUNT}:role/some/path/cdk-hnb659fds-deploy-role-${ACCOUNT}-us-east-1` },
      ],
      allowed: [
        { action: "sts:AssumeRole", resource: `arn:aws:iam::${ACCOUNT}:role/agentx-company-secrets` },
        { action: "sts:AssumeRole", resource: `arn:aws:iam::${ACCOUNT}:role/AgentXControlPlane-CompanySecretsRole63E074C9-ABC` },
        { action: "sts:AssumeRole", resource: `arn:aws:iam::${ACCOUNT}:role/agentx-production-img-push` },
      ],
    },
    {
      group: "Lambda code and configuration changes",
      denied: ["UpdateFunctionCode", "UpdateFunctionConfiguration", "PublishLayerVersion", "AddPermission", "CreateFunction", "DeleteFunction", "PublishVersion", "CreateAlias", "UpdateAlias", "PutFunctionConcurrency",
        "CreateEventSourceMapping", "UpdateEventSourceMapping", "RemovePermission", "CreateFunctionUrlConfig"]
        .map((name) => ({ action: `lambda:${name}`, resource: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:agentx-broker` })),
      allowed: ["InvokeFunction", "GetFunction", "ListFunctions"].map((name) => ({ action: `lambda:${name}`, resource: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:agentx-broker` })),
    },
    {
      group: "resource-policy changes",
      denied: [
        ...["SetRepositoryPolicy", "DeleteRepositoryPolicy"].map((name) => ({ action: `ecr:${name}`, resource: `arn:aws:ecr:us-east-1:${ACCOUNT}:repository/rovara-env/production/x` })),
        ...["PutBucketPolicy", "DeleteBucketPolicy", "PutBucketAcl", "PutBucketPublicAccessBlock"].map((name) => ({ action: `s3:${name}`, resource: "arn:aws:s3:::agentx-artifacts" })),
        { action: "s3:PutObjectAcl", resource: "arn:aws:s3:::agentx-artifacts/key" },
        ...["PutResourcePolicy", "DeleteResourcePolicy"].map((name) => ({ action: `secretsmanager:${name}`, resource: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:agentx/x` })),
        // Opus IAM review (REVIEW-OPUS-PROD-EXPOSURE section 4): the creation template's repository policy is the saved-env read isolation.
        ...["CreateRepositoryCreationTemplate", "UpdateRepositoryCreationTemplate", "DeleteRepositoryCreationTemplate", "PutReplicationConfiguration"].map((name) => ({ action: `ecr:${name}`, resource: `arn:aws:ecr:us-east-1:${ACCOUNT}:repository/rovara-env/production/x` })),
      ],
      allowed: [
        { action: "ecr:BatchGetImage", resource: `arn:aws:ecr:us-east-1:${ACCOUNT}:repository/x` },
        { action: "s3:GetObject", resource: "arn:aws:s3:::agentx-artifacts/key" },
        { action: "s3:PutObject", resource: "arn:aws:s3:::agentx-artifacts/key" },
        { action: "secretsmanager:GetSecretValue", resource: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:agentx/x` },
      ],
    },
    {
      group: "running commands or tasks, and building state machines",
      denied: [
        ...["SendCommand", "StartSession", "StartAutomationExecution"].map((name) => ({ action: `ssm:${name}`, resource: `arn:aws:ec2:us-east-1:${ACCOUNT}:instance/i-0123` })),
        ...["RunTask", "StartTask", "ExecuteCommand", "RegisterTaskDefinition"].map((name) => ({ action: `ecs:${name}`, resource: `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/x:1` })),
        ...["CreateStateMachine", "UpdateStateMachine", "DeleteStateMachine"].map((name) => ({ action: `states:${name}`, resource: `arn:aws:states:us-east-1:${ACCOUNT}:stateMachine:x` })),
        ...["CreateProject", "UpdateProject"].map((name) => ({ action: `codebuild:${name}`, resource: `arn:aws:codebuild:us-east-1:${ACCOUNT}:project/agentx-x` })),
        ...["CreateService", "UpdateService"].map((name) => ({ action: `ecs:${name}`, resource: `arn:aws:ecs:us-east-1:${ACCOUNT}:service/agentx/x` })),
        ...["CreateAssociation", "UpdateAssociation", "CreateDocument", "PutParameter", "DeleteParameter"].map((name) => ({ action: `ssm:${name}`, resource: `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/agentx/production/worker-image` })),
        ...["SendSSHPublicKey", "OpenTunnel"].map((name) => ({ action: `ec2-instance-connect:${name}`, resource: `arn:aws:ec2:us-east-1:${ACCOUNT}:instance/i-0123` })),
        ...["CreateLaunchTemplateVersion", "ModifyLaunchTemplate", "ModifyInstanceAttribute"].map((name) => ({ action: `ec2:${name}`, resource: `arn:aws:ec2:us-east-1:${ACCOUNT}:launch-template/lt-0123` })),
      ],
      allowed: [
        { action: "states:StartExecution", resource: `arn:aws:states:us-east-1:${ACCOUNT}:stateMachine:x` },
        { action: "ec2:RunInstances", resource: `arn:aws:ec2:us-east-1:${ACCOUNT}:instance/*` },
        { action: "ec2:TerminateInstances", resource: `arn:aws:ec2:us-east-1:${ACCOUNT}:instance/i-0123` },
        { action: "ssm:GetParameter", resource: `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/agentx/production/x` },
      ],
    },
    {
      group: "the release CodeBuild projects",
      denied: [AGENTX_RELEASE_PROJECT_NAME, AGENTX_BETA_RELEASE_PROJECT_NAME].flatMap((project) =>
        ["StartBuild", "StopBuild", "BatchGetBuilds", "UpdateProject", "DeleteProject"].map((name) => ({ action: `codebuild:${name}`, resource: `arn:aws:codebuild:us-east-1:${ACCOUNT}:project/${project}` }))),
      allowed: ["StartBuild", "BatchGetBuilds"].map((name) => ({ action: `codebuild:${name}`, resource: `arn:aws:codebuild:us-east-1:${ACCOUNT}:project/agentx-feature-gate` })),
    },
    {
      group: "organization and account changes",
      denied: [{ action: "organizations:CreateAccount", resource: "*" }, { action: "organizations:LeaveOrganization", resource: "*" }, { action: "account:CloseAccount", resource: "*" }],
      allowed: [],
    },
  ];
  for (const { group, denied, allowed } of cases) {
    it(`${group}: denied in all three stacks' boundaries, and what the roles do stays allowed`, () => {
      expect(denied.length).toBeGreaterThan(0);
      for (const stackName of Object.keys(STACK_PARTS)) {
        const { statements } = boundaryOf(stackName);
        for (const request of denied) expect(denyingStatements(statements, request), `${stackName} ${JSON.stringify(request)}`).not.toEqual([]);
        for (const request of allowed) expect(denyingStatements(statements, request), `${stackName} ${JSON.stringify(request)}`).toEqual([]);
      }
    });
  }

  it("PassRole: the worker's role to EC2 still passes in the control plane (and only there); the same role to any other service, and any other role, does not", () => {
    const controlPlane = boundaryOf("AgentXControlPlane").statements;
    expect(denyingStatements(controlPlane, { action: "iam:PassRole", resource: WORKER_ROLE, passedToService: "ec2.amazonaws.com" })).toEqual([]);
    for (const service of ["lambda.amazonaws.com", "ecs-tasks.amazonaws.com", "states.amazonaws.com", "cloudformation.amazonaws.com", "codebuild.amazonaws.com"]) {
      expect(denyingStatements(controlPlane, { action: "iam:PassRole", resource: WORKER_ROLE, passedToService: service }), service).toEqual(["DenyWorkerRolePassToOtherServices"]);
    }
    expect(denyingStatements(controlPlane, { action: "iam:PassRole", resource: WORKER_ROLE }), "no service key").toEqual(["DenyWorkerRolePassToOtherServices"]);
    for (const resource of [`arn:aws:iam::${ACCOUNT}:role/agentx-admin`, `arn:aws:iam::${ACCOUNT}:role/AgentXProductionFoundation-VpcFlowLogRole`, cdkRole("cfn-exec-role")]) {
      expect(denyingStatements(controlPlane, { action: "iam:PassRole", resource, passedToService: "ec2.amazonaws.com" }), resource).not.toEqual([]);
    }
    for (const stackName of ["AgentXProductionFoundation", "AgentXSlackOrchestrator"]) {
      expect(denyingStatements(boundaryOf(stackName).statements, { action: "iam:PassRole", resource: WORKER_ROLE, passedToService: "ec2.amazonaws.com" }), stackName).toEqual(["DenyPassRole"]);
    }
  });

  it("the release projects are named so the broker's agentx-* project grant cannot reach them", () => {
    for (const project of [AGENTX_RELEASE_PROJECT_NAME, AGENTX_BETA_RELEASE_PROJECT_NAME]) {
      expect(glob("agentx-*", project, false), project).toBe(false);
      expect(glob("release-*", project, false), project).toBe(true);
    }
  });
});

describe("legacy runtime boundary: it denies no permission a runtime role has today", () => {
  const WORKER_ROLE_BY_NAME = "<worker instance role, by name>";

/** Every Allow of every runtime role: its AWS::IAM::Policy resources and inline policies, as [role, action, resource, condition]. */
  function allowsOf(stackName: string): Array<{ role: string; action: string; resources: string[]; passedToService?: string }> {
    const found: Array<{ role: string; action: string; resources: string[]; passedToService?: string }> = [];
    const resources = template(stackName).Resources;
    const collect = (roleIds: string[], statements: Statement[]) => {
      for (const statement of statements) {
        expect(statement.Effect).toBe("Allow");
        expect(statement.NotAction, "no NotAction allow").toBeUndefined();
        const conditionValue = statement.Condition?.StringEquals?.["iam:PassedToService"];
        for (const role of roleIds) {
          for (const action of list(statement.Action) as string[]) {
            found.push({ role, action, resources: list(statement.Resource).map(resolve), ...(conditionValue === undefined ? {} : { passedToService: conditionValue }) });
          }
        }
      }
    };
    for (const [, resource] of Object.entries(resources)) {
      if (resource.Type === "AWS::IAM::Policy") {
        // The control plane attaches the model-key reads to the worker's instance role by name (Fn::Select of its ARN parameter); that role is the foundation's.
        const roleIds = (resource.Properties.Roles as Array<{ Ref?: string }>).map((r) => r.Ref ?? WORKER_ROLE_BY_NAME);
        collect(roleIds, (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
      }
    }
    for (const [id, role] of rolesOf(stackName)) {
      for (const policy of (role.Properties.Policies ?? []) as Array<{ PolicyDocument: { Statement: Statement[] } }>) collect([id], policy.PolicyDocument.Statement);
    }
    return found;
  }

  it("walks every allow of every runtime role: none is denied, and the near-misses are exactly the documented ones", () => {
    let walked = 0;
    const nearMisses: string[] = [];
    for (const stackName of Object.keys(STACK_PARTS)) {
      const roleIds = new Set(rolesOf(stackName).map(([id]) => id));
      for (const allow of allowsOf(stackName)) {
        const byName = allow.role === WORKER_ROLE_BY_NAME;
        expect(byName || roleIds.has(allow.role), `${allow.role} is a role of ${stackName}`).toBe(true);
        // A policy attached to the worker role by name is capped by the foundation's boundary, where that role lives.
        const { statements } = boundaryOf(byName ? "AgentXProductionFoundation" : stackName);
        for (const resource of allow.resources) {
          walked += 1;
          const denied = denyingStatements(statements, { action: allow.action, resource, ...(allow.passedToService === undefined ? {} : { passedToService: allow.passedToService }) });
          expect(denied, `${stackName} ${allow.role} ${allow.action} on ${resource}`).toEqual([]);
          // A near-miss: the same action under a deny whose resource or condition set it apart.
          const sameAction = denyingStatements(statements, { action: allow.action, resource: "*" }, true);
          if (sameAction.length > 0) nearMisses.push(`${allow.role.replace(/[0-9A-F]{8}$/, "")} ${allow.action} ${sameAction.join("+")}`);
        }
      }
    }
    expect(walked).toBeGreaterThan(400);
    expect([...new Set(nearMisses)].sort()).toEqual([
      "BrokerServiceRole codebuild:BatchGetBuilds DenyReleaseProjects",
      "BrokerServiceRole codebuild:StartBuild DenyReleaseProjects",
      "SessionsProvisionerRole iam:PassRole DenyPassRoleExceptWorkerRole+DenyWorkerRolePassToOtherServices+DenyDeployerRoles",
    ].sort());
  });

  it("the broker's CodeBuild grant is on agentx-* projects only, and the provisioner's PassRole is the worker role to EC2 only", () => {
    const allows = allowsOf("AgentXControlPlane");
    const codebuild = allows.filter((a) => a.action.startsWith("codebuild:"));
    expect(codebuild.map((a) => a.action).sort()).toEqual(["codebuild:BatchGetBuilds", "codebuild:StartBuild"]);
    for (const a of codebuild) expect(a.resources).toEqual([`arn:aws:codebuild:us-east-1:${ACCOUNT}:project/agentx-*`]);
    const passRole = allows.filter((a) => a.action === "iam:PassRole");
    expect(passRole).toHaveLength(1);
    expect(passRole[0]!.role).toMatch(/^SessionsProvisionerRole/);
    expect(passRole[0]).toMatchObject({ action: "iam:PassRole", resources: [WORKER_ROLE], passedToService: "ec2.amazonaws.com" });
    // No runtime role of any stack has an action the boundary treats as a deployer or IAM capability.
    for (const stackName of Object.keys(STACK_PARTS)) {
      for (const a of allowsOf(stackName)) expect(a.action, `${stackName} ${a.role}`).not.toMatch(/^(iam:(?!PassRole$|Get|List|Simulate)|cloudformation:|lambda:(?!Invoke|Get|List)|organizations:|account:|ssm:(Send|Start)|ecs:)/i);
    }
  });
});
