// DEC 254o (b), guided onboarding L2-2 PR 18a: the infrastructure half of Slack company mode (per-company bot tokens for every workspace but the install's own).
// One stack parameter, SlackCompanyWorkspaces (default "disabled"), named environments only. Every grant here is a separate IAM policy resource carrying the
// SlackCompanyWorkspacesOn condition, so with the switch off CloudFormation creates none of them and no role gains anything; each Slack consumer only gets the
// switch's value as SLACK_COMPANY_WORKSPACES ("disabled" while off; the code also requires COMPANY_SIGNIN=enabled before it acts on it).
import { ArnFormat, CfnCondition, CfnParameter, Fn, Stack, Token, aws_iam as iam } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { AgentXNaming } from "./naming.js";

export const SLACK_COMPANY_WORKSPACES_PARAMETER = "SlackCompanyWorkspaces";
export const SLACK_COMPANY_WORKSPACES_VARIABLE = "SLACK_COMPANY_WORKSPACES";

/** The State-table rows a company-mode reader needs to find a team's company (slack-workspace-binding.ts requireCompany: the team's binding and the backfill marker). */
export const SLACK_BINDING_READ_KEYS = ["SLACK_TEAM#*", "SLACK_WORKSPACE_BINDING"] as const;

/**
 * DEC 254zzz80 (R2-F1, owner-approved IAM): a NAMED company's Slack channel bindings, `ORG#<company>#SLACK_BINDING#<team>` / `CHANNEL#<channel>` (company id: org_ + exactly 20
 * characters). The Slack Lambda reads one by key (company-layout.ts namedCompanySlackBinding) for the team's company; nothing else under ORG#.
 */
export const COMPANY_SLACK_CHANNEL_BINDING_KEYS = ["ORG#org_????????????????????#SLACK_BINDING#*"] as const;

/**
 * DEC 254zzz80 (R2-F1 lane 1 review M2; NEW IAM, needs the owner's OK): a NAMED company's project revisions, `ORG#<company>#PROJECT#<name>` / `REV#...`. The Slack Lambda and the
 * channel API ask only whether the company holds the project (slack-company-wiring.ts getProject): Query, keys plus `companyId` and `candidate`, never a definition.
 */
export const COMPANY_PROJECT_REVISION_KEYS = ["ORG#org_????????????????????#PROJECT#*"] as const;

export interface SlackCompanyWorkspacesProps {
  readonly naming: AgentXNaming;
  /** DEC 254zg (a), 254zk: the company sign-in condition; the switch is on only while this holds too. */
  readonly requires?: CfnCondition;
}

export class SlackCompanyWorkspaces extends Construct {
  readonly parameter: CfnParameter;
  readonly isOn: CfnCondition;
  private readonly env: string;

  constructor(scope: Construct, id: string, props: SlackCompanyWorkspacesProps) {
    super(scope, id);
    if (props.naming.env === undefined) throw new Error("Slack company mode exists only in named environments");
    this.env = props.naming.env;
    const stack = Stack.of(this);
    // Written out (SLACK_COMPANY_WORKSPACES_PARAMETER): tests/contract/config-keys.test.ts reads the declaration for agentx config set slack.companyWorkspaces.
    this.parameter = new CfnParameter(stack, "SlackCompanyWorkspaces", {
      type: "String",
      default: "disabled",
      allowedValues: ["enabled", "disabled"],
      description: "enabled: Slack workspaces other than SlackTeamId use their company's own bot token and company checks (needs company sign-in); disabled: only the install's workspace is served, as before",
    });
    const asked = Fn.conditionEquals(this.parameter.valueAsString, "enabled");
    this.isOn = new CfnCondition(this, "On", { expression: props.requires === undefined ? asked : Fn.conditionAnd(asked, props.requires) });
  }

  /** The switch's value for a consumer's SLACK_COMPANY_WORKSPACES variable: "enabled" only while the condition holds. */
  get value(): string {
    return Token.asString(Fn.conditionIf(this.isOn.logicalId, "enabled", "disabled"));
  }

  /** The broker's packed switch flag (BrokerSettingSpec.switchFlag): "1" only while the condition holds. */
  get flag(): string {
    return Token.asString(Fn.conditionIf(this.isOn.logicalId, "1", "0"));
  }

  /** The family of per-company bot token secrets (DeveloperIdentity writes them: developer-signin.ts). */
  secretFamilyArn(): string {
    return Stack.of(this).formatArn({ service: "secretsmanager", resource: "secret", resourceName: `agentx/${this.env}/slack-workspaces/*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME });
  }

  /** Read-only GetSecretValue on the token family. */
  tokenRead(): iam.PolicyStatement {
    return new iam.PolicyStatement({ sid: "ReadSlackWorkspaceTokens", actions: ["secretsmanager:GetSecretValue"], resources: [this.secretFamilyArn()] });
  }

  /** GetItem on exactly the given State-table partitions (never a Query, Scan or write). */
  stateReads(table: { readonly tableArn: string }, sid: string, keys: readonly string[]): iam.PolicyStatement {
    return new iam.PolicyStatement({
      sid,
      actions: ["dynamodb:GetItem"],
      resources: [table.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...keys] }, Null: { "dynamodb:LeadingKeys": "false" } },
    });
  }

  /**
   * One inline policy resource on the role, created only while the switch is on (and, when given, only while `also` holds too). A separate resource, not the role's
   * default policy, so the off template's default policies stay as they are.
   */
  grant(id: string, role: iam.IRole, statements: iam.PolicyStatement[], also?: CfnCondition): iam.CfnPolicy {
    const policy = new iam.CfnPolicy(this, id, {
      policyName: `slack-company-workspaces-${id.replace(/[^A-Za-z0-9]/g, "").toLowerCase()}`,
      roles: [role.roleName],
      policyDocument: new iam.PolicyDocument({ statements }),
    });
    policy.cfnOptions.condition = also === undefined ? this.isOn
      : new CfnCondition(this, `${id}On`, { expression: Fn.conditionAnd(this.isOn, also) });
    return policy;
  }
}
