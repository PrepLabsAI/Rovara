// Company separation for secrets (lane T6; DEFERRED T6-SECRETS-IAM-20261114-v2): the role the broker assumes, tagged with ONE company, to read and write that company's secrets.
// The legacy deployment (production) has it too since #1129. Nothing assumes it yet (the T6 code that does is a later step); it is created now so the IAM can be reviewed, simulated and
// previewed before any staging run.
//
// The shape, and why:
//   - Trust: only the broker's role may assume it (sts:AssumeRole) and tag the session (sts:TagSession), and only with exactly one tag, `rovara:org`, whose value looks like a company id.
//     IAM's StringLike is a glob, so `org_` and twenty `?` pins the length and prefix, not the character set; the broker checks the full grammar (OrgIdSchema `^org_[0-9a-z]{20}$`) before
//     it calls STS. IAM fences a wrong session, not a compromised broker: membership in code is the authority on which company a person acts for.
//     Same account, and the trust policy names the broker's role ARN: the broker's own inline policy needs no statement (it is at its size pin), but its permissions boundary must
//     allow sts:AssumeRole and sts:TagSession (a deploy-time check, listed in the PR).
//   - Reads and writes (GetSecretValue, DescribeSecret, PutSecretValue, and DeleteSecret, which must keep its recovery window) are fenced by the secret's NAME only: `agentx/<env>/<family>/${aws:PrincipalTag/rovara:org}/*` for the
//     company families (org-connectors, org-hooks). No aws:ResourceTag condition on them, so the company's own missing secret is ResourceNotFoundException (not AccessDenied) and its
//     untagged older secrets stay usable; another company's path, existing or not, is AccessDenied.
//   - CreateSecret: the company's own path AND the request's `rovara:org` tag equal to the session's.
//   - CreateSecret for a company's package token (`pkgreg_*` under org-connectors): an UNTAGGED create on exactly that name (PRIVATE-PACKAGES P1b), so no TagResource is needed; see CreateOwnCompanyRegistrySecrets.
//   - RestoreSecret on the company's own `pkgreg_*` only (RestoreOwnCompanyRegistrySecrets): the token's secret is adopted and restored, never force-deleted or recreated.
//   - TagResource / UntagResource: NOT allowed, and no Deny either. A tagged CreateSecret also needs TagResource authorization (CreateSecret API reference: "If you include tags in the
//     secret, you also need secretsmanager:TagResource"), and no documented condition key tells a TagResource made as part of CreateSecret from a direct one, so allowing it would allow
//     retagging an existing secret. Until that discriminator is verified (AWS docs + the IAM policy simulator), a tagged create is refused here: deployment of tagged creates stays
//     blocked and the constraint goes back to the owner. No unconditional Deny on TagResource is added, so a later, verified create-only allow is not overridden.
import { ArnFormat, Stack, aws_iam as iam } from "aws-cdk-lib";
import { companySecretsRoleName } from "@agentx/contracts";
import { Construct } from "constructs";

/** The session tag that carries the company. */
export const COMPANY_TAG_KEY = "rovara:org";
/** IAM glob for a company id: `org_` and exactly twenty characters (the broker checks the character set). */
export const COMPANY_TAG_VALUE_GLOB = `org_${"?".repeat(20)}`;
/** The secret-name families that belong to one company (packages/broker/src/core-host/code-modules.ts COMPANY_SECRET_PATHS). */
export const COMPANY_SECRET_FAMILIES = ["org-connectors", "org-hooks"] as const;
/** The leaf a company's package token is created under (PRIVATE-PACKAGES P1b): `pkgreg_<hostKey>`, created WITHOUT tags (see `CreateOwnCompanyRegistrySecrets`). */
export const COMPANY_REGISTRY_SECRET_LEAF_GLOB = "pkgreg_*";
/** The read and write actions the name fence covers. */
export const COMPANY_SECRET_USE_ACTIONS = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:PutSecretValue"] as const;

/** The trust conditions of a role a session may take only with exactly the one company tag (shared with the Slack token reader role, slack-company-token-reader.ts). */
export function companyTagTrustConditions() {
  return {
    Null: { [`aws:RequestTag/${COMPANY_TAG_KEY}`]: "false", "aws:TagKeys": "false" },
    "ForAllValues:StringEquals": { "aws:TagKeys": [COMPANY_TAG_KEY] },
    StringLike: { [`aws:RequestTag/${COMPANY_TAG_KEY}`]: COMPANY_TAG_VALUE_GLOB },
  };
}

export interface CompanySecretsProps {
  /** The environment's name ("production" for the legacy deployment). */
  readonly env: string;
  /** The broker's role: the only principal that may assume the role. */
  readonly brokerRole: iam.IRole;
}

export class CompanySecrets extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: CompanySecretsProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const principalCompany = `\${aws:PrincipalTag/${COMPANY_TAG_KEY}}`;
    const tagConditions = companyTagTrustConditions();
    const brokerArn = props.brokerRole.roleArn;
    // The trust: one statement, sts:AssumeRole and sts:TagSession together, each only with exactly the one company tag.
    this.role = new iam.Role(this, "Role", {
      // A fixed name (like the saved environment image roles): the broker's permissions boundary names this one role (`AssumeCompanySecretsRole`, contracts access-policies.ts) and the deploy role looks it up by name.
      roleName: companySecretsRoleName(props.env),
      description: "The broker acting for one company: that company's secrets only (session tag rovara:org)",
      assumedBy: new iam.PrincipalWithConditions(new iam.ArnPrincipal(brokerArn).withSessionTags(), tagConditions),
    });
    const companyArns = COMPANY_SECRET_FAMILIES.map((family) => stack.formatArn({
      service: "secretsmanager", resource: "secret", resourceName: `agentx/${props.env}/${family}/${principalCompany}/*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    }));
    const sessionHasCompany = { Null: { [`aws:PrincipalTag/${COMPANY_TAG_KEY}`]: "false" } };
    this.role.addToPolicy(new iam.PolicyStatement({ sid: "UseOwnCompanySecrets", actions: [...COMPANY_SECRET_USE_ACTIONS], resources: companyArns, conditions: sessionHasCompany }));
    // A delete always keeps the recovery window (never ForceDeleteWithoutRecovery), so a wrong delete can be undone.
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: "DeleteOwnCompanySecretsRecoverably",
      actions: ["secretsmanager:DeleteSecret"],
      resources: companyArns,
      conditions: { ...sessionHasCompany, Bool: { "secretsmanager:ForceDeleteWithoutRecovery": "false" } },
    }));
    // PRIVATE-PACKAGES P1b: the company's package token per registry host, `agentx/<env>/org-connectors/<company>/pkgreg_*`, created WITHOUT tags: a tagged create needs TagResource (above), and this role has none. The
    // NAME is the fence (the company is the session's own tag in the resource, the leaf is `pkgreg_*`), and `aws:TagKeys` must be absent so this statement can never create a tagged secret or become the tagging path.
    // Reads, version writes and recoverable deletes of these names are already covered by the name fence above; nothing else is added.
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: "CreateOwnCompanyRegistrySecrets",
      actions: ["secretsmanager:CreateSecret"],
      resources: [stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `agentx/${props.env}/org-connectors/${principalCompany}/${COMPANY_REGISTRY_SECRET_LEAF_GLOB}`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      conditions: { Null: { [`aws:PrincipalTag/${COMPANY_TAG_KEY}`]: "false", "aws:TagKeys": "true" } },
    }));
    // The company's package token is ADOPTED, not recreated: a secret scheduled for deletion (a removal's recovery window, or a delete whose row write failed) is restored before a new version is written into it.
    // Exactly like the statement above: the company's own org (the session tag in the resource), `pkgreg_*` only, no other family and no other name.
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: "RestoreOwnCompanyRegistrySecrets",
      actions: ["secretsmanager:RestoreSecret"],
      resources: [stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `agentx/${props.env}/org-connectors/${principalCompany}/${COMPANY_REGISTRY_SECRET_LEAF_GLOB}`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      conditions: sessionHasCompany,
    }));
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: "CreateOwnCompanySecrets",
      actions: ["secretsmanager:CreateSecret"],
      resources: companyArns,
      conditions: {
        ...sessionHasCompany,
        StringEquals: { [`aws:RequestTag/${COMPANY_TAG_KEY}`]: principalCompany },
        "ForAllValues:StringEquals": { "aws:TagKeys": [COMPANY_TAG_KEY] },
      },
    }));
    // Hardening (Opus review of P1b, F2): IAM's `*` matches `/`, so `pkgreg_*` would also let the role create an untagged secret at a NESTED name (`pkgreg_x/y`) inside its own company's prefix. The adapter refuses
    // that name before any call; this Deny makes IAM refuse it too. A Deny on a resource pattern needs no condition key. The org segment is `*` here (a Deny may be wider than the Allow); a leaf is never nested.
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: "DenyNestedCompanyRegistrySecrets",
      effect: iam.Effect.DENY,
      actions: ["secretsmanager:CreateSecret"],
      resources: [stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `agentx/${props.env}/org-connectors/*/${COMPANY_REGISTRY_SECRET_LEAF_GLOB}/*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }));
  }
}
