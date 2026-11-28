// R5 step 1 (DEC 254zzz444; DESIGN briefs/codex/company-secret-scope/DESIGN.md): the role the hosted Slack service (the orchestrator, which runs the AI turns) assumes with ONE session tag
// `rovara:org` to read ONE company's Slack bot token. After the service looked up a team's company in the binding row it mints a session tagged with THAT company, and the session's only
// grant is GetSecretValue on `agentx/<env>/slack-workspaces/${aws:PrincipalTag/rovara:org}/*`: code holding company A's session that asks for company B's token gets AccessDenied.
// IAM fences a wrong session (a bug, a steered tool), not a compromised process (see company-secrets.ts, same limit).
//
// Additive (release 1): the orchestrator KEEPS its family-wide read (slackCompany.tokenRead()), and the service falls back to it while SLACK_COMPANY_TOKEN_FALLBACK=shared. Release 2 drops both.
// #1614: company mode is the only mode, so the role and its policy always exist.
// Trust: the orchestrator's role ARN, sts:AssumeRole + sts:TagSession, only with exactly the one company tag, and with no transitive tag keys (sts:TransitiveTagKeys absent), so a caller cannot make
// the company tag travel into a role chain. A same-account trust that names a role ARN needs no statement in the orchestrator's own policy; the RUNTIME permissions boundary allows the assume
// (access-policies.ts `SlackTokenReader`, built from contracts slackTokenReaderBoundaryStatement), and the deploy boundary and the service role list the fixed-name lookup.
import { ArnFormat, Stack, aws_iam as iam } from "aws-cdk-lib";
import { Construct } from "constructs";
import { slackTokenReaderRoleName } from "@agentx/contracts";
import { COMPANY_TAG_KEY, companyTagTrustConditions } from "./company-secrets.js";
import type { AgentXNaming } from "./naming.js";
import type { SlackCompanyWorkspaces } from "./slack-company-workspaces.js";

/** The shared company-tag trust conditions (company-secrets.ts) plus: no transitive tag keys may be requested. Null "true" = the key is absent from the request. */
function trustConditions() {
  const base = companyTagTrustConditions();
  return { ...base, Null: { ...base.Null, "sts:TransitiveTagKeys": "true" } };
}

export interface SlackCompanyTokenReaderProps {
  readonly naming: AgentXNaming;
  readonly slackCompany: SlackCompanyWorkspaces;
  /** The only principal that may assume the role. */
  readonly readerRole: iam.IRole;
}

export class SlackCompanyTokenReader extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: SlackCompanyTokenReaderProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const env = props.naming.env ?? "production";
    this.role = new iam.Role(this, "Role", {
      roleName: slackTokenReaderRoleName(env),
      description: "The hosted Slack service acting for one company: that company's Slack bot token only (session tag rovara:org)",
      assumedBy: new iam.PrincipalWithConditions(new iam.ArnPrincipal(props.readerRole.roleArn).withSessionTags(), trustConditions()),
    });
    const ownCompany = new iam.PolicyStatement({
      sid: "ReadOwnCompanySlackToken",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `agentx/${env}/slack-workspaces/\${aws:PrincipalTag/${COMPANY_TAG_KEY}}/*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      conditions: { Null: { [`aws:PrincipalTag/${COMPANY_TAG_KEY}`]: "false" } },
    });
    props.slackCompany.grant("SlackTokenReader", this.role, [ownCompany]);
  }
}
