// DEC 254zg (a), 254zc (6), 254b (b): Code's company layer as ONE stack parameter. Until now COMPANY_SIGNIN was a variable the code read and no infrastructure set, so no deploy could
// turn it on. CompanySignIn (default "disabled") is the single source: every function that reads COMPANY_SIGNIN gets it from the CompanySignInOn condition, and every grant only the
// company layer needs is a separate IAM policy resource under that condition, so the off template holds no such grant. CompanySelfServe (default "disabled") is the second, separate
// switch: self-serve company create is served only while BOTH are enabled, so self-serve stays closed while company sign-in is on (the switch-on order: close self-serve, migrate the
// members, then company sign-in on). #1129: the legacy deployment (production) has both too, off by default. `agentx config set company.signIn` / `company.selfServe` flip them.
import { CfnCondition, CfnParameter, Fn, Token, aws_iam as iam, type Stack, type aws_lambda as lambda } from "aws-cdk-lib";
import { Construct } from "constructs";

export const COMPANY_SIGNIN_PARAMETER = "CompanySignIn";
export const COMPANY_SELF_SERVE_PARAMETER = "CompanySelfServe";
export const COMPANY_SIGNIN_VARIABLE = "COMPANY_SIGNIN";
export const COMPANY_SELF_SERVE_VARIABLE = "COMPANY_SELF_SERVE";

export interface CompanySignInParameters {
  readonly signIn: CfnParameter;
  readonly selfServe: CfnParameter;
}

/** Declared on the stack itself, so the parameter names are exactly these (tests/contract/config-keys.test.ts reads the declarations). */
export function companySignInParameters(stack: Stack): CompanySignInParameters {
  return {
    signIn: new CfnParameter(stack, "CompanySignIn", {
      type: "String", default: "disabled", allowedValues: ["enabled", "disabled"],
      description: "enabled: Code's company layer is on (company membership sign-in, invites, Add to Slack); disabled: it is off and no company-only grant exists. Close self-serve and migrate the members first",
    }),
    selfServe: new CfnParameter(stack, "CompanySelfServe", {
      type: "String", default: "disabled", allowedValues: ["enabled", "disabled"],
      description: "enabled: a person with an invite code may create their own company, only while CompanySignIn is enabled too; disabled: self-serve create is refused",
    }),
  };
}

export class CompanySignInSwitch extends Construct {
  readonly isOn: CfnCondition;
  readonly selfServeOn: CfnCondition;

  constructor(scope: Construct, id: string, parameters: CompanySignInParameters) {
    super(scope, id);
    this.isOn = new CfnCondition(this, "On", { expression: Fn.conditionEquals(parameters.signIn.valueAsString, "enabled") });
    // Self-serve needs both: on its own it is never served.
    this.selfServeOn = new CfnCondition(this, "SelfServeOn", { expression: Fn.conditionAnd(this.isOn, Fn.conditionEquals(parameters.selfServe.valueAsString, "enabled")) });
  }

  /** COMPANY_SIGNIN's value: "enabled" only while CompanySignInOn holds. */
  get value(): string {
    return Token.asString(Fn.conditionIf(this.isOn.logicalId, "enabled", "disabled"));
  }

  /** The broker's packed switch flag (BrokerSettingSpec.switchFlag): "1" only while CompanySignInOn holds. */
  get flag(): string {
    return Token.asString(Fn.conditionIf(this.isOn.logicalId, "1", "0"));
  }

  /** COMPANY_SELF_SERVE's value: "enabled" only while both switches are on. */
  get selfServeValue(): string {
    return Token.asString(Fn.conditionIf(this.selfServeOn.logicalId, "enabled", "disabled"));
  }

  /** Gives a function COMPANY_SIGNIN from the switch. */
  addTo(fn: lambda.Function): void {
    fn.addEnvironment(COMPANY_SIGNIN_VARIABLE, this.value);
  }

  /** One inline policy resource on the role, created only while company sign-in is on: a separate resource, so the off template's default policies stay as they are. */
  grant(id: string, role: iam.IRole, statements: iam.PolicyStatement[]): iam.CfnPolicy {
    const policy = new iam.CfnPolicy(this, id, {
      policyName: `company-signin-${id.replace(/[^A-Za-z0-9]/g, "").toLowerCase()}`,
      roles: [role.roleName],
      policyDocument: new iam.PolicyDocument({ statements }),
    });
    policy.cfnOptions.condition = this.isOn;
    return policy;
  }
}
