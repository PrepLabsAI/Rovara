// L4-HARD (b), owner 2026-11-18: who can assume the customer-installed operator role. A principal of ANOTHER account needs sts:ExternalId; a whole-account
// (`:root`) principal is refused; the documented same-account default stays. Proven three ways: the parameter patterns and the CloudFormation Rule, a request
// simulation over the synthesized trust policy (resolved for each parameter choice, from code), and the pure refusal the CLI gives before any deploy.
import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { OPERATOR_EXTERNAL_ID_PATTERN, OPERATOR_EXTERNAL_ID_PATTERN_SOURCE, OPERATOR_PRINCIPAL_PATTERN_SOURCE, operatorTrustProblem } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { stackParameters, type InstallAnswers } from "../../packages/cli/src/deploy/parameters.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const ACCOUNT = "123456789012";
const OTHER = "210987654321";
const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
const access = stacksOf(buildAgentXApp({ agentxEnv: "staging" })).find((s) => s.stackName === "agentx-staging-access")!;
const template = Template.fromStack(access).toJSON() as {
  Parameters: Record<string, { AllowedPattern: string; ConstraintDescription?: string }>;
  Conditions: Record<string, unknown>;
  Rules?: Record<string, unknown>;
  Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
};
const operatorRole = Object.values(template.Resources).find((r) => r.Type === "AWS::IAM::Role" && r.Properties.RoleName === "agentx-staging-operator")!;

// ---- a small resolver for the trust policy: conditions, Fn::If, Ref, Fn::Join, AWS::NoValue
type Params = { OperatorPrincipalArn: string; OperatorExternalId: string };
function resolve(value: unknown, params: Params): unknown {
  const conditions: Record<string, boolean> = {
    HasOperatorPrincipal: params.OperatorPrincipalArn !== "",
    HasOperatorExternalId: params.OperatorPrincipalArn !== "" && params.OperatorExternalId !== "",
  };
  const go = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(go).filter((x) => x !== NO_VALUE);
    if (v === null || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1) {
      const [k] = keys as [string];
      if (k === "Ref") {
        const name = o.Ref as string;
        if (name === "AWS::NoValue") return NO_VALUE;
        if (name === "AWS::AccountId") return ACCOUNT;
        if (name === "AWS::Partition") return "aws";
        if (name in params) return params[name as keyof Params];
        throw new Error(`no value for ${name}`);
      }
      if (k === "Fn::If") { const [c, a, b] = o["Fn::If"] as [string, unknown, unknown]; if (!(c in conditions)) throw new Error(`unknown condition ${c}`); return go(conditions[c] ? a : b); }
      if (k === "Fn::Join") { const [sep, parts] = o["Fn::Join"] as [string, unknown[]]; return parts.map(go).join(sep); }
    }
    return Object.fromEntries(Object.entries(o).map(([key, val]) => [key, go(val)]));
  };
  return go(value);
}
const NO_VALUE = Symbol("NoValue");

interface Caller { arn: string; account: string; externalId?: string }
/** IAM's trust evaluation for sts:AssumeRole: an Allow whose principal matches the caller (a `:root` principal means any principal of that account) and whose conditions hold. */
function canAssume(params: Params, caller: Caller): boolean {
  const trust = resolve(operatorRole.Properties.AssumeRolePolicyDocument, params) as { Statement: Array<{ Principal: { AWS: string }; Condition?: { StringEquals?: Record<string, string> } }> };
  return trust.Statement.some((st) => {
    const principal = st.Principal.AWS;
    const rootOf = /^arn:aws:iam::(\d{12}):root$/u.exec(principal)?.[1];
    const principalMatches = rootOf !== undefined ? caller.account === rootOf : caller.arn === principal;
    const conditions = st.Condition?.StringEquals ?? {};
    const holds = Object.entries(conditions).every(([key, want]) => (key === "aws:PrincipalAccount" ? caller.account === want : key === "sts:ExternalId" ? caller.externalId === want : false));
    return principalMatches && holds;
  });
}

const sameRole = `arn:aws:iam::${ACCOUNT}:role/platform`;
const otherRole = `arn:aws:iam::${OTHER}:role/outside`;
const EXT = "ext-4f9c2a7e";
const none: Params = { OperatorPrincipalArn: "", OperatorExternalId: "" };

describe("the operator role's trust: same-account default; another account only with its external id; never a whole account", () => {
  it("parameters: one role or user (no :root, no assumed-role, no sts ARN), an optional external id of STS's alphabet", () => {
    const principal = new RegExp(template.Parameters.OperatorPrincipalArn!.AllowedPattern, "u");
    const id = new RegExp(template.Parameters.OperatorExternalId!.AllowedPattern, "u");
    expect(template.Parameters.OperatorPrincipalArn!.AllowedPattern).toBe(OPERATOR_PRINCIPAL_PATTERN_SOURCE);
    expect(template.Parameters.OperatorExternalId!.AllowedPattern).toBe(OPERATOR_EXTERNAL_ID_PATTERN_SOURCE);
    for (const ok of ["", sameRole, otherRole, `arn:aws:iam::${ACCOUNT}:user/ops`, `arn:aws:iam::${ACCOUNT}:role/team/platform`, `arn:aws-us-gov:iam::${ACCOUNT}:role/x`]) expect(principal.test(ok), ok).toBe(true);
    for (const bad of [`arn:aws:iam::${ACCOUNT}:root`, `arn:aws:iam::${OTHER}:root`, `arn:aws:sts::${ACCOUNT}:assumed-role/x/y`, `arn:aws:iam::${ACCOUNT}:group/g`, `arn:aws:iam::123:role/x`, `arn:aws:iam::${ACCOUNT}:role/`, "*", ACCOUNT, ` ${sameRole}`]) expect(principal.test(bad), bad).toBe(false);
    for (const ok of ["", EXT, "a1", "x".repeat(1224), "a+b=c,d.e@f:g/h-i_j"]) expect(id.test(ok), ok).toBe(true);
    for (const bad of ["a", "x".repeat(1225), "has space", "semi;colon", "quote\"", "new\nline"]) expect(id.test(bad), bad).toBe(false);
    expect(OPERATOR_EXTERNAL_ID_PATTERN.test(EXT)).toBe(true);
    // CloudFormation's own message on a refusal says what is wanted.
    expect(template.Parameters.OperatorPrincipalArn!.ConstraintDescription).toMatch(/ONE IAM role or user.*:root\) is refused/u);
    expect(template.Parameters.OperatorExternalId!.ConstraintDescription).toMatch(/2 to 1224 characters/u);
  });

  it("has a Rule: an external id with no principal is refused with words", () => {
    const describing: unknown = expect.stringMatching(/only used with OperatorPrincipalArn/u);
    expect(template.Rules!.OperatorExternalIdNeedsPrincipal).toEqual({
      RuleCondition: { "Fn::Not": [{ "Fn::Equals": [{ Ref: "OperatorExternalId" }, ""] }] },
      Assertions: [{ Assert: { "Fn::Not": [{ "Fn::Equals": [{ Ref: "OperatorPrincipalArn" }, ""] }] }, AssertDescription: describing }],
    });
    expect(template.Conditions.HasOperatorExternalId).toEqual({ "Fn::And": [{ Condition: "HasOperatorPrincipal" }, { "Fn::Not": [{ "Fn::Equals": [{ Ref: "OperatorExternalId" }, ""] }] }] });
  });

  it("trust statements: this account's principal (root by default, or the one named) with aws:PrincipalAccount = this account; the named principal with its id only when one is set", () => {
    const statements = (operatorRole.Properties.AssumeRolePolicyDocument as { Statement: unknown[] }).Statement;
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatchObject({ Sid: "OperatorOfThisAccount", Condition: { StringEquals: { "aws:PrincipalAccount": { Ref: "AWS::AccountId" } } } });
    expect(statements[1]).toEqual({ "Fn::If": ["HasOperatorExternalId", {
      Sid: "NamedOperatorWithExternalId", Effect: "Allow", Action: "sts:AssumeRole", Principal: { AWS: { Ref: "OperatorPrincipalArn" } },
      Condition: { StringEquals: { "sts:ExternalId": { Ref: "OperatorExternalId" } } },
    }, { Ref: "AWS::NoValue" }] });
  });

  const sameAccountCaller: Caller = { arn: `arn:aws:iam::${ACCOUNT}:role/anyone`, account: ACCOUNT };
  const named: Caller = { arn: sameRole, account: ACCOUNT };
  const outsider: Caller = { arn: otherRole, account: OTHER };
  const cases: Array<[string, Params, Caller, boolean]> = [
    // the documented default: this account's own principals (which still need an allow in their own IAM policy)
    ["default: a principal of this account", none, sameAccountCaller, true],
    ["default: a principal of ANOTHER account (even one that knows the account id)", none, outsider, false],
    ["default: another account's principal presenting an id", none, { ...outsider, externalId: EXT }, false],
    // a named same-account role
    ["named same-account role: that role, no id needed", { OperatorPrincipalArn: sameRole, OperatorExternalId: "" }, named, true],
    ["named same-account role: another role of this account", { OperatorPrincipalArn: sameRole, OperatorExternalId: "" }, sameAccountCaller, false],
    ["named same-account role: a principal of another account", { OperatorPrincipalArn: sameRole, OperatorExternalId: "" }, outsider, false],
    // a named cross-account role WITHOUT an id: nobody can assume (a mistake that fails closed; the CLI refuses it before deploy)
    ["cross-account role, no id: that role", { OperatorPrincipalArn: otherRole, OperatorExternalId: "" }, outsider, false],
    ["cross-account role, no id: that role presenting an id", { OperatorPrincipalArn: otherRole, OperatorExternalId: "" }, { ...outsider, externalId: EXT }, false],
    ["cross-account role, no id: a principal of this account", { OperatorPrincipalArn: otherRole, OperatorExternalId: "" }, sameAccountCaller, false],
    // a named cross-account role WITH its id
    ["cross-account role + id: that role with the id", { OperatorPrincipalArn: otherRole, OperatorExternalId: EXT }, { ...outsider, externalId: EXT }, true],
    ["cross-account role + id: that role without the id", { OperatorPrincipalArn: otherRole, OperatorExternalId: EXT }, outsider, false],
    ["cross-account role + id: that role with a wrong id", { OperatorPrincipalArn: otherRole, OperatorExternalId: EXT }, { ...outsider, externalId: "ext-wrong" }, false],
    ["cross-account role + id: another role of that account", { OperatorPrincipalArn: otherRole, OperatorExternalId: EXT }, { arn: `arn:aws:iam::${OTHER}:role/other`, account: OTHER, externalId: EXT }, false],
    ["cross-account role + id: a principal of this account", { OperatorPrincipalArn: otherRole, OperatorExternalId: EXT }, { ...sameAccountCaller, externalId: EXT }, false],
  ];
  it.each(cases)("simulation: %s", (_name, params, caller, expected) => {
    expect(canAssume(params, caller)).toBe(expected);
  });

  it("the simulation can fail: the same request is allowed once the guard it exercises is removed (control)", () => {
    // Drop aws:PrincipalAccount from the first statement and a cross-account principal named in the parameter gets in with no id; the guard is what refuses it.
    const stripped = structuredClone(operatorRole.Properties.AssumeRolePolicyDocument) as { Statement: Array<{ Condition?: unknown }> };
    delete stripped.Statement[0]!.Condition;
    const saved = operatorRole.Properties.AssumeRolePolicyDocument;
    operatorRole.Properties.AssumeRolePolicyDocument = stripped;
    try { expect(canAssume({ OperatorPrincipalArn: otherRole, OperatorExternalId: "" }, outsider)).toBe(true); } finally { operatorRole.Properties.AssumeRolePolicyDocument = saved; }
    expect(canAssume({ OperatorPrincipalArn: otherRole, OperatorExternalId: "" }, outsider)).toBe(false);
  });
});

describe("operatorTrustProblem: what the CLI and upgrade refuse before any deploy", () => {
  const problem = (principal: string | undefined, externalId?: string) => operatorTrustProblem({ principal, externalId, account: ACCOUNT });
  it("accepts the default, a same-account role or user (with or without an id), and another account's role with an id", () => {
    expect(problem(undefined)).toBeUndefined();
    expect(problem("")).toBeUndefined();
    expect(problem(sameRole)).toBeUndefined();
    expect(problem(`arn:aws:iam::${ACCOUNT}:user/ops`)).toBeUndefined();
    expect(problem(sameRole, EXT)).toBeUndefined();
    expect(problem(otherRole, EXT)).toBeUndefined();
  });
  it("refuses a whole account (this one or another), another account's principal without an id, an id alone, and a malformed principal or id", () => {
    expect(problem(`arn:aws:iam::${ACCOUNT}:root`)).toMatch(/whole account \(:root\)/u);
    expect(problem(`arn:aws:iam::${OTHER}:root`, EXT)).toMatch(/whole account \(:root\)/u);
    expect(problem(otherRole)).toMatch(/another AWS account \(210987654321\).*needs an external id \(--operator-external-id\)/u);
    expect(problem(undefined, EXT)).toMatch(/only used with an operator principal/u);
    expect(problem(`arn:aws:sts::${ACCOUNT}:assumed-role/x/y`)).toMatch(/ARN of one IAM role or user/u);
    expect(problem("*")).toMatch(/ARN of one IAM role or user/u);
    expect(problem(otherRole, "x")).toMatch(/2 to 1224 characters/u);
    expect(problem(otherRole, "bad id")).toMatch(/2 to 1224 characters/u);
  });

  const answers = (extra: Partial<InstallAnswers>): InstallAnswers => ({
    env: "staging", region: "us-east-1", account: ACCOUNT, models: { orchestrator: "a", classifier: "b", worker: "c" }, identity: { mode: "cognito" },
    github: { privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:k-AbCdEf" }, callbackSigningKey: "k".repeat(32), release: { version: "1.0.0" }, ...extra,
  } as unknown as InstallAnswers);
  it("stackParameters is the backstop for every caller: the access stack never gets a refused pair, and the id goes through only when set", () => {
    const params = (extra: Partial<InstallAnswers>) => stackParameters("access", answers(extra), {}, { packages: false });
    expect(params({})).toEqual({ PermissionsBoundaryArn: "", OperatorPrincipalArn: "" });
    expect(params({ operatorPrincipalArn: sameRole })).toEqual({ PermissionsBoundaryArn: "", OperatorPrincipalArn: sameRole });
    expect(params({ operatorPrincipalArn: otherRole, operatorExternalId: EXT })).toEqual({ PermissionsBoundaryArn: "", OperatorPrincipalArn: otherRole, OperatorExternalId: EXT });
    expect(() => params({ operatorPrincipalArn: `arn:aws:iam::${ACCOUNT}:root` })).toThrow(/whole account/u);
    expect(() => params({ operatorPrincipalArn: otherRole })).toThrow(/needs an external id/u);
    expect(() => params({ operatorExternalId: EXT })).toThrow(/only used with an operator principal/u);
  });
});
