// DEC 254o (b), guided onboarding L2-2 PR 18a: the infrastructure half of Slack company mode (per-company bot tokens for every workspace but the install's own). Every grant here is
// a separate IAM policy resource. #1614: company mode is the only mode, so the SlackCompanyWorkspaces switch and its condition are gone and the grants are unconditional.
import { ArnFormat, type CfnCondition, Stack, aws_iam as iam } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { AgentXNaming } from "./naming.js";

/** The State-table rows a company-mode reader needs to find a team's company (slack-workspace-binding.ts requireCompany: the team's binding and the backfill marker). */
export const SLACK_BINDING_READ_KEYS = ["SLACK_TEAM#*", "SLACK_WORKSPACE_BINDING"] as const;

/**
 * DEC 254zzz80 (R2-F1, owner-approved IAM): a NAMED company's Slack channel bindings, `ORG#<company>#SLACK_BINDING#<team>` / `CHANNEL#<channel>` (company id: org_ + exactly 20
 * characters). The Slack Lambda reads one by key (company-layout.ts namedCompanySlackBinding) for the team's company; nothing else under ORG#.
 */
export const COMPANY_SLACK_CHANNEL_BINDING_KEYS = ["ORG#org_????????????????????#SLACK_BINDING#*"] as const;

/**
 * DEC 254zzz80 (R2-F1 lane 1 review M2; NEW IAM, needs the owner's OK): a NAMED company's project partition, `ORG#<company>#PROJECT#<name>`. The Slack Lambda and the channel API
 * ask only whether the company holds the project (slack-company-wiring.ts getProject reads its `REV#` rows): Query, keys plus `companyId` and `candidate`, never a definition.
 * IAM cannot narrow the sort key here, so the grant covers EVERY sort key in that partition (`REV#…`, `META`, `SELECTION`, `SETUP_HOST_*`, `AUTOMATIC_RUNS…` and any later
 * one), limited to those four attributes: those rows' keys and their `companyId`/`candidate` values (if any) are readable, nothing else of them.
 */
export const COMPANY_PROJECT_REVISION_KEYS = ["ORG#org_????????????????????#PROJECT#*"] as const;

export interface SlackCompanyWorkspacesProps {
  readonly naming: AgentXNaming;
}

export class SlackCompanyWorkspaces extends Construct {
  private readonly env: string;

  constructor(scope: Construct, id: string, props: SlackCompanyWorkspacesProps) {
    super(scope, id);
    // #1171: the legacy deployment (production) too; its secret family is agentx/production/slack-workspaces/*, the path DeveloperIdentity writes there (developer-signin.ts props.env).
    this.env = props.naming.env ?? "production";
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

  /** One inline policy resource on the role (and, when given, only while `also` holds). A separate resource, not the role's default policy. */
  grant(id: string, role: iam.IRole, statements: iam.PolicyStatement[], also?: CfnCondition): iam.CfnPolicy {
    const policy = new iam.CfnPolicy(this, id, {
      policyName: `slack-company-workspaces-${id.replace(/[^A-Za-z0-9]/g, "").toLowerCase()}`,
      roles: [role.roleName],
      policyDocument: new iam.PolicyDocument({ statements }),
    });
    if (also !== undefined) policy.cfnOptions.condition = also;
    return policy;
  }
}
