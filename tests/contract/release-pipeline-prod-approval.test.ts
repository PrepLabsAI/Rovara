// PROD-APPROVAL-BOUND (DEC 254zzz506): every production deploy needs the owner's explicit approval FOR THAT RUN. Before, the disabled transition into Production was the only approval, and
// enabling it was not bound to one run: enabled while no run waited, or left open because the Production Code Preflight failed before its first command, it let the NEXT run in unapproved.
// A CodePipeline manual approval belongs to one execution. It sits right after the read-only Code Preflight (which closes the transition first, so the gate is closed whatever the approval's outcome)
// and before every other Production action. Synthesized template only: no AWS.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  AGENTX_PRODUCTION_APPROVAL_ACTION,
  AGENTX_PRODUCTION_APPROVAL_TIMEOUT_HOURS,
  AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME,
  AGENTX_PRODUCTION_STAGE,
  PROMOTION_GATE_REASON,
  ReleasePipelineStack,
} from "../../infra/lib/release-pipeline.js";

interface Action {
  Name: string;
  RunOrder: number;
  RoleArn?: { "Fn::GetAtt": [string, string] };
  TimeoutInMinutes?: number;
  ActionTypeId: { Category: string; Owner: string; Provider: string; Version: string };
  Configuration: Record<string, unknown>;
}
interface Pipeline {
  Stages: Array<{ Name: string; Actions: Action[] }>;
  DisableInboundStageTransitions?: Array<{ StageName: string; Reason: string }>;
}
interface Statement { Effect: string; Action?: string | string[]; NotAction?: string | string[]; Principal?: unknown }
interface Resource { Type: string; Properties: Record<string, unknown> }

const template = Template.fromStack(new ReleasePipelineStack(new App(), "ProdApprovalPipeline", { env: { region: "us-east-1" } }));
const resources = template.toJSON().Resources as Record<string, Resource>;
const pipeline = (Object.values(template.findResources("AWS::CodePipeline::Pipeline"))[0] as { Properties: Pipeline }).Properties;
const production = pipeline.Stages.find((stage) => stage.Name === AGENTX_PRODUCTION_STAGE)!;
const approval = production.Actions.find((action) => action.Name === AGENTX_PRODUCTION_APPROVAL_ACTION)!;
const asList = (value: string | string[] | undefined): string[] => (value === undefined ? [] : [value].flat());

/** Every policy statement any resource of the template carries: role default policies, inline role policies, managed policies, and resource policies (a role's own trust statements are separate). */
const statements = (): Statement[] =>
  Object.values(resources).flatMap((resource) => {
    const out: Statement[] = [];
    const document = (resource.Properties.PolicyDocument ?? undefined) as { Statement?: Statement[] } | undefined;
    if (document?.Statement !== undefined) out.push(...document.Statement);
    for (const inline of (resource.Properties.Policies ?? []) as Array<{ PolicyDocument: { Statement: Statement[] } }>) out.push(...inline.PolicyDocument.Statement);
    return out;
  });
/** An IAM action pattern (`codepipeline:Put*`, `*`) matches this concrete action. */
const matches = (pattern: string, action: string): boolean =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, "iu").test(action);
/** Actions that would let an identity of this template approve, open the gate, or start, retry or rewind a run. */
const PIPELINE_CONTROL_ACTIONS = [
  "codepipeline:PutApprovalResult",
  "codepipeline:EnableStageTransition",
  "codepipeline:DisableStageTransition", // only the Production Code Preflight may close the gate (the next test pins that)
  "codepipeline:StartPipelineExecution",
  "codepipeline:RetryStageExecution",
  "codepipeline:RollbackStage",
  "codepipeline:StopPipelineExecution",
  "codepipeline:UpdatePipeline",
  "codepipeline:PutActionRevision",
  "codepipeline:OverrideStageCondition",
  "codepipeline:PutJobSuccessResult",
] as const;

describe("every Production deploy waits for its own approval", () => {
  it("closes the gate first (the read-only Code Preflight, run order 1), then holds one manual approval, before every other Production action", () => {
    expect(approval).toBeDefined();
    expect(approval.ActionTypeId).toEqual({ Category: "Approval", Owner: "AWS", Provider: "Manual", Version: "1" });
    const codePreflight = production.Actions.find((action) => action.Name === "CodePreflight")!;
    expect(production.Actions[0]).toBe(codePreflight);
    expect(codePreflight.RunOrder).toBe(1);
    expect(JSON.stringify(codePreflight.Configuration.ProjectName)).toContain("ProductionCodePreflight");
    expect(production.Actions[1]).toBe(approval);
    expect(approval.RunOrder).toBe(2);
    const others = production.Actions.filter((action) => action !== approval && action !== codePreflight);
    expect(others.length).toBeGreaterThan(0);
    for (const action of others) expect(approval.RunOrder, `${action.Name} must run after the approval`).toBeLessThan(action.RunOrder);
    // No other action of the stage may share the approval's run order (a same-order action would start beside it, before the approval), and the run orders are contiguous.
    expect(new Set(production.Actions.map((action) => action.RunOrder)).size).toBe(production.Actions.length);
    expect(production.Actions.map((action) => action.RunOrder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(production.Actions.map((action) => `${action.RunOrder}:${action.Name}`)).toEqual([
      "1:CodePreflight", "2:ApproveProduction", "3:Preflight", "4:CloudImage", "5:CloudGateway", "6:GatewayCheck", "7:ReleaseProduction", "8:CloudWebApp", "9:CloudProof",
    ]);
  });

  it("lets the step that runs before the approval clone but not push: UseConnection is denied for a provider action that needs write permission (read_write), on both prefixes", () => {
    const roleId = Object.keys(resources).find((id) => resources[id]!.Type === "AWS::IAM::Role" && /^ProductionCodePreflightRole/u.test(id))!;
    const policyOf = (id: string): Array<Statement & { Sid?: string; Resource?: unknown; Condition?: unknown }> =>
      Object.values(resources).filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes(`"${id}"`))
        .flatMap((policy) => (policy.Properties.PolicyDocument as { Statement: Array<Statement & { Sid?: string }> }).Statement);
    const connection = { Ref: "GitHubConnectionArn" };
    const denies = policyOf(roleId).filter((statement) => statement.Effect === "Deny");
    // One Deny per action prefix (a condition key belongs to its own service prefix). StringEquals read_write, not StringNotEquals read_only: a clone whose request lacks the key is not denied
    // (the key is not verified against a live clone), so Production cannot break at its first action; a push request carries read_write.
    expect(denies).toEqual([
      { Sid: "ReadOnlyConnectionUse", Effect: "Deny", Action: "codeconnections:UseConnection", Resource: connection, Condition: { StringEquals: { "codeconnections:ProviderPermissionsRequired": "read_write" } } },
      { Sid: "ReadOnlyConnectionUseLegacy", Effect: "Deny", Action: "codestar-connections:UseConnection", Resource: connection, Condition: { StringEquals: { "codestar-connections:ProviderPermissionsRequired": "read_write" } } },
    ]);
    // The role still has the Allow the clone needs (CDK's own unconditioned one and the template's), so the Deny is what stops a write: it must cover every Allow of UseConnection on this role.
    const allows = policyOf(roleId).filter((statement) => statement.Effect === "Allow" && asList(statement.Action).some((action) => /UseConnection$/u.test(action)));
    expect(allows.length).toBeGreaterThan(0);
    for (const allow of allows) {
      expect(JSON.stringify(allow.Resource), "an Allow of UseConnection on another connection would escape the Deny").toBe(JSON.stringify(connection));
      for (const action of asList(allow.Action)) expect(denies.some((deny) => deny.Action === action), `${action} must be denied when it needs write permission`).toBe(true);
    }
    // The Beta Code Preflight is not given the Deny (Beta is not gated by the owner's approval, and its clone is unchanged).
    const beta = Object.keys(resources).find((id) => resources[id]!.Type === "AWS::IAM::Role" && /^BetaCodePreflightRole/u.test(id))!;
    expect(policyOf(beta).filter((statement) => statement.Effect === "Deny")).toEqual([]);
  });

  it("closes the transition BEFORE the approval, so a rejected or timed-out run leaves it closed, and the only action that runs before the approval is read-only", () => {
    const codePreflight = production.Actions.find((action) => action.Name === "CodePreflight")!;
    expect(codePreflight.RunOrder).toBeLessThan(approval.RunOrder);
    // The project's first command closes the gate (the build spec is a join around the port-guard parameter; its install commands are literal text).
    const project = Object.values(resources).find((resource) => resource.Type === "AWS::CodeBuild::Project" && resource.Properties.Name === AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME)!;
    const spec = (project.Properties.Source as { BuildSpec: string | { "Fn::Join": [string, unknown[]] } }).BuildSpec;
    const text = typeof spec === "string" ? spec : spec["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "<token>")).join("");
    const commands = (JSON.parse(text) as { phases: { install: { commands: string[] } } }).phases.install.commands;
    expect(commands[0]).toBe(`aws codepipeline disable-stage-transition --pipeline-name AgentXProductionRelease --stage-name ${AGENTX_PRODUCTION_STAGE} --transition-type Inbound --reason "${PROMOTION_GATE_REASON}"`);
    // Nothing that runs before the approval may write: the Code Preflight's role holds reads, logs and reports, plus the one right to close the gate.
    const roleId = Object.keys(resources).find((id) => resources[id]!.Type === "AWS::IAM::Role" && /^ProductionCodePreflightRole/u.test(id))!;
    const own = Object.values(resources).filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes(`"${roleId}"`));
    const granted = own.flatMap((policy) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement).flatMap((statement) => asList(statement.Action));
    expect(granted.length).toBeGreaterThan(0);
    for (const action of granted) {
      expect(action, "a role that runs before the approval may only read, log, report or close the gate").toMatch(/^(codepipeline:DisableStageTransition|logs:(CreateLogGroup|CreateLogStream|PutLogEvents)|codebuild:(CreateReportGroup|CreateReport|UpdateReport|BatchPutTestCases|BatchPutCodeCoverages)|ssm:GetParameter|kms:Decrypt|(codeconnections|codestar-connections):UseConnection|s3:(GetObject\*|GetBucket\*|List\*))$/u);
    }
  });

  it("is the only approval in the pipeline, and no earlier stage can reach a Production action", () => {
    const approvals = pipeline.Stages.flatMap((stage) => stage.Actions.map((action) => ({ stage: stage.Name, action }))).filter(({ action }) => action.ActionTypeId.Category === "Approval");
    expect(approvals.map(({ stage, action }) => `${stage}/${action.Name}`)).toEqual([`${AGENTX_PRODUCTION_STAGE}/${AGENTX_PRODUCTION_APPROVAL_ACTION}`]);
    expect(pipeline.Stages.map((stage) => stage.Name)).toEqual(["Source", "Beta", AGENTX_PRODUCTION_STAGE]);
    // Every other action of Production is a build: the approval is the only gate, and nothing in it could approve for a person.
    expect(production.Actions.filter((action) => action !== approval).map((action) => action.ActionTypeId.Category)).toEqual(Array(production.Actions.length - 1).fill("Build"));
  });

  it("keeps the transition into Production disabled as well, with a reason that names both steps", () => {
    // The transition holds the run that waits (a newer run replaces it in SUPERSEDED mode); the approval releases it. Neither replaces the other.
    expect(pipeline.DisableInboundStageTransitions).toEqual([{ StageName: AGENTX_PRODUCTION_STAGE, Reason: PROMOTION_GATE_REASON }]);
    expect(PROMOTION_GATE_REASON).toContain("enable this transition");
    expect(PROMOTION_GATE_REASON).toContain(AGENTX_PRODUCTION_APPROVAL_ACTION);
    expect(PROMOTION_GATE_REASON).toMatch(/^[a-zA-Z0-9!@ ().*?-]{1,300}$/u);
    template.hasResourceProperties("AWS::CodePipeline::Pipeline", { ExecutionMode: "SUPERSEDED" });
  });

  it("names this run in the approval: the execution, the Code commit, the Cloud commit and the variables that decide what the run does", () => {
    const text = String(approval.Configuration.CustomData);
    expect(text).toContain("#{codepipeline.PipelineExecutionId}");
    expect(text).toContain("#{CodeSource.CommitId}");
    expect(text).toContain("#{CloudSourceVariables.CommitId}");
    // The Cloud commit is the Cloud SOURCE commit of this run, not "the commit Beta resolved its Cloud ref from" (a Code-push run with no tag on it deploys Beta's last-good tag instead).
    expect(text).toContain("the Cloud source commit of this run");
    expect(text).not.toMatch(/resolved its Cloud ref/u);
    expect(text).toContain("Beta's Preflight log");
    for (const name of ["CLOUD_REF", "CLOUD_PROD", "CODE_RELEASE", "PIPELINE_MODE", "CODE_ROLLBACK_TARGET"]) expect(text).toContain(`#{variables.${name}}`);
    // Every reference resolves in a Production action that runs before the approval was needed: an unresolved one would fail the approval action itself.
    for (const reference of text.match(/#\{[^}]+\}/gu) ?? []) {
      expect(reference).toMatch(/^#\{(codepipeline\.PipelineExecutionId|CodeSource\.CommitId|CloudSourceVariables\.CommitId|variables\.(CLOUD_REF|CLOUD_PROD|CODE_RELEASE|PIPELINE_MODE|CODE_ROLLBACK_TARGET))\}$/u);
    }
    // CodePipeline refuses an action configuration value over 1000 characters; the text is unresolved here and the resolved values are short (a uuid, two 40-hex shas, five short words).
    const resolved = text
      .replace("#{codepipeline.PipelineExecutionId}", "00000000-0000-0000-0000-000000000000")
      .replace(/#\{(CodeSource|CloudSourceVariables)\.CommitId\}/gu, "0".repeat(40))
      .replace("#{variables.CODE_ROLLBACK_TARGET}", "0".repeat(40))
      .replace(/#\{variables\.[A-Z_]+\}/gu, "from-trigger");
    expect(resolved.length).toBeLessThanOrEqual(1000);
    expect(text.length).toBeLessThanOrEqual(1000);
    // Nothing secret or private: no account id, host or domain.
    expect(text).not.toMatch(/\b[0-9]{12}\b|execute-api|rovara\.dev/u);
  });

  it("times out an unanswered approval after a day, and sends no notification (no topic, no address)", () => {
    expect(AGENTX_PRODUCTION_APPROVAL_TIMEOUT_HOURS).toBe(24);
    expect(approval.TimeoutInMinutes).toBe(AGENTX_PRODUCTION_APPROVAL_TIMEOUT_HOURS * 60);
    expect(Object.keys(approval.Configuration).sort()).toEqual(["CustomData"]);
    template.resourceCountIs("AWS::SNS::Topic", 0);
    template.resourceCountIs("AWS::SNS::Subscription", 0);
  });
});

describe("no role this template creates can approve, open the gate, or start, retry or rewind a run", () => {
  it("grants no pipeline control action to anyone: only the Production Code Preflight closes the gate, and the Beta Preflight reads state", () => {
    const allowed = statements().filter((statement) => statement.Effect === "Allow");
    // No NotAction allow (it would grant everything but the listed actions).
    expect(allowed.filter((statement) => statement.NotAction !== undefined)).toEqual([]);
    const granted = allowed.flatMap((statement) => asList(statement.Action));
    for (const action of PIPELINE_CONTROL_ACTIONS) {
      const holders = granted.filter((pattern) => matches(pattern, action));
      // The single exception is the Production Code Preflight's own right to CLOSE the gate again; it can neither approve nor open it.
      expect(holders, action).toEqual(action === "codepipeline:DisableStageTransition" ? ["codepipeline:DisableStageTransition"] : []);
    }
    expect(granted.filter((pattern) => pattern === "*" || /^codepipeline:\*$/iu.test(pattern))).toEqual([]);
    expect(granted.filter((pattern) => pattern.toLowerCase().startsWith("codepipeline:")).sort()).toEqual([
      "codepipeline:DisableStageTransition", "codepipeline:GetPipelineExecution", "codepipeline:GetPipelineState", "codepipeline:ListActionExecutions",
    ]);
  });

  it("gives the approval action's role no permission at all, and lets only the pipeline role assume it", () => {
    const roleId = approval.RoleArn!["Fn::GetAtt"][0];
    const role = resources[roleId]!;
    expect(role.Type).toBe("AWS::IAM::Role");
    expect(role.Properties.Policies).toBeUndefined();
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    const attached = Object.values(resources).filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes(`"${roleId}"`));
    expect(attached).toEqual([]);
    const trust = (role.Properties.AssumeRolePolicyDocument as { Statement: Statement[] }).Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0]!.Principal).toEqual({ AWS: { "Fn::GetAtt": [expect.stringMatching(/^PipelineRole/u), "Arn"] } });
    // No role of the template carries a managed policy or an inline policy that could add what the default policies leave out.
    expect(Object.values(resources).filter((resource) => resource.Type === "AWS::IAM::ManagedPolicy")).toEqual([]);
    for (const resource of Object.values(resources).filter((candidate) => candidate.Type === "AWS::IAM::Role")) expect(resource.Properties.ManagedPolicyArns).toBeUndefined();
  });
});
