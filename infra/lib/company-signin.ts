// #1614: company mode is the only mode. The company layer once had two stack switches (CompanySignIn and CompanySelfServe, DEC 254zg (a)) so it could ship turned off and be
// switched on after an install's members moved; production runs it on, the old engine is gone (#1325), and the off state could not run a task (#1612), so both are gone.
// What stays is how the layer's grants are added: each a separate inline policy resource on the role (unconditional now), so the role's default policy stays as it is.
// Self-serve company create is decided by the stored self-serve setting alone (company-invites.ts), still behind an operator's invite code.
import { aws_iam as iam } from "aws-cdk-lib";
import { Construct } from "constructs";

export class CompanySignInGrants extends Construct {
  /** One inline policy resource on the role for a company-layer grant. */
  grant(id: string, role: iam.IRole, statements: iam.PolicyStatement[]): iam.CfnPolicy {
    return new iam.CfnPolicy(this, id, {
      policyName: `company-signin-${id.replace(/[^A-Za-z0-9]/g, "").toLowerCase()}`,
      roles: [role.roleName],
      policyDocument: new iam.PolicyDocument({ statements }),
    });
  }
}
