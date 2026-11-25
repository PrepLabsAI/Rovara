// CANARY-SESSION (briefs/arch-cleanup/CANARY-SESSION-PLAN.md): the function that mints the beta canary person's session (packages/broker/src/aws/canary-session.ts).
//
// It exists ONLY in beta, and only when the deploy names all four placement values (arch ruling 2026-11-25: they are PLACEMENT configuration, rows in packages/contracts/src/canary-session-placement.ts).
// Production's deploy never sets them, its release path REFUSES a control plane that holds the environment value (scripts/release-production.ts assertNoCanaryPlacement), and a template rule refuses
// any partial or non-beta set:
//   CanarySessionPlacementEnvironment (`beta` or empty), CanarySessionPerson (the canary person: 64 hex), CanarySessionCompany (the canary company), CanarySessionStepRoleName (the NAME of the one role that may invoke it, in this stack's own account:
//   its pattern pins the name's ending). The token issuer is NOT a parameter: it is read from this stack (the sign-in function's own issuer).
// Every resource of the construct (the function, its log group, role, role policy, invoke permission, metric filters and alarms) is under the `CanarySessionIsOn` condition, so with the defaults the
// template creates none of them, and the one existing statement it touches (the developer token key's deny, which names the sign-in function's role) reads exactly as before.
//
// Who may call it: the function's resource policy holds ONE permission, lambda:InvokeFunction for the step role. There is no API Gateway route or integration, no function URL, no event
// source and no other permission, and no role in this stack is granted invoke on it. (Same account: any principal here whose own identity policy allows lambda:InvokeFunction on this ARN, an
// account administrator for one, can also call it. The blast radius is bounded by what the function can mint: one fixed member, one fixed company, 30 minutes. The caller is not visible to the
// function and CloudTrail records no Lambda data events here, so "a call from anything but the step role" is guarded by the resource policy and watched by volume: the alarms below.)
//
// What the role may do, and nothing else: read the canary person's and company's own rows and the company's member list on the sign-in table; write SESSION# and REFRESH# rows (a session
// start) and CANARY_MINT# counters; sign with, and read the public half of, the developer token key. No secret, no other table, no other service. IAM cannot bind a SESSION# write or a
// signature to one person, so the one-person bound is this function's CODE: the role has the same minting authority as the sign-in function's.
import { ArnFormat, CfnCondition, CfnOutput, CfnParameter, CfnResource, CfnRule, Duration, Fn, Stack, aws_cloudwatch as cloudwatch, aws_cloudwatch_actions as cloudwatchActions, aws_iam as iam, aws_logs as logs, type aws_dynamodb as dynamodb, type aws_kms as kms, type aws_lambda as lambda, type aws_sns as sns } from "aws-cdk-lib";
import { Construct } from "constructs";
import { CANARY_SESSION_PLACEMENT_PARAMETERS, CANARY_SESSION_PLACEMENT_ROWS, CANARY_SESSION_PLACEMENT_STAGE } from "@agentx/contracts";
import { packagedFunction } from "./control-plane.js";
import type { AgentXNaming } from "./naming.js";

/** The four parameters, declared from their placement rows (packages/contracts/src/canary-session-placement.ts). */
export const CANARY_SESSION_PARAMETERS = CANARY_SESSION_PLACEMENT_PARAMETERS;
export const CANARY_SESSION_OUTPUT = "CanarySessionFunctionArn";
/** The most mints in one hour a deploy-time canary makes (a run mints 1 to 3 times; two runs in an hour at most): from this many, the alarm fires. The function's own counter stops at 20. */
export const CANARY_MINTS_ALARM_THRESHOLD = 7;
/** All calls in an hour (mints, ends, refusals), from this many the alarm fires. */
export const CANARY_INVOCATIONS_ALARM_THRESHOLD = 15;

export interface CanarySessionParameters {
  readonly environment: CfnParameter;
  readonly person: CfnParameter;
  readonly company: CfnParameter;
  readonly stepRoleName: CfnParameter;
}

/** The CloudFormation properties of one placement parameter, read from its row (empty by default: the function does not exist). */
function placementParameter(name: string): { type: string; default: string; allowedPattern: string; description: string } {
  const placement = CANARY_SESSION_PLACEMENT_ROWS.find((candidate) => candidate.parameter === name);
  if (placement === undefined) throw new Error(`${name} has no placement row (packages/contracts/src/canary-session-placement.ts)`);
  return { type: "String", default: "", allowedPattern: placement.pattern, description: `PLACEMENT, operator only, beta only. ${placement.description}` };
}

/**
 * Declared on the stack itself, so the parameter names are exactly the rows'. The four are CloudFormation parameters on purpose (arch ruling 2026-11-25: the production lock is a template condition,
 * and a condition can only test a whole parameter), so each is declared by its own name here, which is also what scripts/settings-growth-baseline.json names.
 */
export function canarySessionParameters(stack: Stack): CanarySessionParameters {
  return {
    environment: new CfnParameter(stack, "CanarySessionPlacementEnvironment", placementParameter("CanarySessionPlacementEnvironment")),
    person: new CfnParameter(stack, "CanarySessionPerson", placementParameter("CanarySessionPerson")),
    company: new CfnParameter(stack, "CanarySessionCompany", placementParameter("CanarySessionCompany")),
    stepRoleName: new CfnParameter(stack, "CanarySessionStepRoleName", placementParameter("CanarySessionStepRoleName")),
  };
}

export interface CanarySessionProps {
  readonly naming: AgentXNaming;
  readonly env: string;
  readonly parameters: CanarySessionParameters;
  /** The install's token issuer, as the sign-in function signs for it: READ from the stack, never a parameter. */
  readonly issuer: string;
  readonly table: dynamodb.Table;
  readonly tokenKey: kms.IKey;
  /** The operator alerts topic (the control plane's own): the mint and invocation alarms send there. */
  readonly alerts: sns.ITopic;
}

export class CanarySession extends Construct {
  readonly isOn: CfnCondition;
  readonly function: lambda.Function;
  /** The function's fixed name: known before the stack exists, so the canary stack can name its ARN. */
  readonly functionName: string;

  constructor(scope: Construct, id: string, props: CanarySessionProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const p = props.parameters;
    const all = [p.environment, p.person, p.company, p.stepRoleName];
    const present = (parameter: CfnParameter) => Fn.conditionNot(Fn.conditionEquals(parameter.valueAsString, ""));
    const everythingGiven = Fn.conditionAnd(Fn.conditionEquals(p.environment.valueAsString, CANARY_SESSION_PLACEMENT_STAGE), ...all.slice(1).map(present));
    this.isOn = new CfnCondition(this, "CanarySessionIsOn", { expression: everythingGiven });
    // A partial set, or any value that is not beta, fails the deploy instead of quietly building nothing.
    new CfnRule(this, "CanarySessionAllOrNothing", {
      ruleCondition: Fn.conditionOr(...all.map(present)),
      assertions: [{ assert: everythingGiven, assertDescription: "the canary session placement values are all set, with CanarySessionPlacementEnvironment beta, or all empty" }],
    });

    this.functionName = `${props.naming.resourcePrefix}-canary-session`;
    const developerId = p.person.valueAsString;
    const companyId = p.company.valueAsString;
    const fn = this.function = packagedFunction(this, "Function", "packages/broker/src/aws/canary-session.ts", {
      AGENTX_ENV: props.env,
      DEVELOPER_TOKEN_ISSUER: props.issuer,
      DEVELOPER_SIGNIN_TABLE_NAME: props.table.tableName,
      DEVELOPER_TOKEN_KEY_ARN: props.tokenKey.keyArn,
      CANARY_ENVIRONMENT: p.environment.valueAsString,
      CANARY_ISSUER: props.issuer,
      CANARY_DEVELOPER_ID: developerId,
      CANARY_COMPANY_ID: companyId,
    }, Duration.seconds(15), [], 256);
    (fn.node.defaultChild as lambda.CfnFunction).functionName = this.functionName;

    const table = props.table.tableArn;
    const key = (...parts: string[]) => Fn.join("", parts);
    const leading = (operator: "ForAllValues:StringEquals" | "ForAllValues:StringLike", keys: string[]) => ({ [operator]: { "dynamodb:LeadingKeys": keys }, Null: { "dynamodb:LeadingKeys": "false" } });
    const allow = (sid: string, actions: string[], resources: string[], conditions?: Record<string, Record<string, unknown>>) => fn.addToRolePolicy(new iam.PolicyStatement({ sid, actions, resources, ...(conditions === undefined ? {} : { conditions }) }));
    // The canary person's own rows and the canary company's own rows, by exact key (checked as a session start reads them: store.getDeveloper, company.membership / companyExists / hasOwnIssuer).
    allow("ReadCanaryPersonAndCompany", ["dynamodb:GetItem"], [table], leading("ForAllValues:StringEquals", [
      key("DEVELOPER#", developerId), key("COMPANY_MEMBER#", developerId), key("ORG#", companyId, "#COMPANY"), key("ORG#", companyId, "#SIGNIN_ISSUER"),
    ]));
    allow("ListCanaryCompanyMembers", ["dynamodb:Query"], [table], leading("ForAllValues:StringEquals", [key("ORG#", companyId, "#MEMBERS")]));
    // A session start is one TransactWriteItems of two Puts (SESSION# and REFRESH#, each authorized as PutItem); a revoke is one UpdateItem on SESSION#.
    allow("StartSession", ["dynamodb:PutItem"], [table], leading("ForAllValues:StringLike", ["SESSION#*", "REFRESH#*"]));
    allow("EndSession", ["dynamodb:UpdateItem"], [table], leading("ForAllValues:StringLike", ["SESSION#*"]));
    allow("MintCounter", ["dynamodb:GetItem", "dynamodb:UpdateItem"], [table], leading("ForAllValues:StringLike", ["CANARY_MINT#*"]));
    // The access token: the developer token key, signing RS256 over the raw input (developer/tokens.ts kmsTokenSigner) and reading its public half for the kid.
    allow("SignAccessToken", ["kms:Sign"], [props.tokenKey.keyArn], { StringEquals: { "kms:SigningAlgorithm": "RSASSA_PKCS1_V1_5_SHA_256", "kms:MessageType": "RAW" } });
    allow("ReadTokenKey", ["kms:GetPublicKey"], [props.tokenKey.keyArn]);

    // The only way in: one permission, for the step role. Nothing else is ever added to this function's policy.
    // The ARN is built here with this stack's own partition and account: no other account's role can be typed in.
    fn.addPermission("StepRoleInvokes", { principal: new iam.ArnPrincipal(Stack.of(this).formatArn({ service: "iam", region: "", resource: "role", resourceName: p.stepRoleName.valueAsString, arnFormat: ArnFormat.SLASH_RESOURCE_NAME })), action: "lambda:InvokeFunction" });
    // The fixed name is not enough for the canary stack: its parameter takes the ARN, which this output carries.
    this.watch(fn, props);
    const output = new CfnOutput(stack, CANARY_SESSION_OUTPUT, { value: fn.functionArn, description: "The canary session function's ARN: the canary stack's SessionFunctionArn parameter" });
    output.condition = this.isOn;
    // Off builds nothing: every resource of this construct (function, log group, role, policy, permission) exists only while the settings are all given.
    for (const child of this.node.findAll()) if (child instanceof CfnResource) child.cfnOptions.condition = this.isOn;
  }

  /**
   * Arch ruling 3: every mint is logged (`signin.canary_session`) and ALARMED when it is more than a deploy-time canary makes, or any call is refused, or the function is called more than a run needs.
   * The alarms read the function's own log lines and its Lambda metrics; they send to the operator alerts topic. (The caller's identity is not in the event, so this is volume, not a caller check.)
   */
  private watch(fn: lambda.Function, props: CanarySessionProps): void {
    const { naming } = props;
    const notify = new cloudwatchActions.SnsAction(props.alerts);
    const count = (id: string, metricName: string, event: string) => {
      new logs.MetricFilter(this, id, { logGroup: fn.logGroup, metricNamespace: naming.metricsNamespace, metricName, filterPattern: logs.FilterPattern.stringValue("$.event", "=", event), metricValue: "1" });
      return new cloudwatch.Metric({ namespace: naming.metricsNamespace, metricName, statistic: "Sum", period: Duration.hours(1) });
    };
    const alarm = (id: string, suffix: string, description: string, metric: cloudwatch.IMetric, threshold: number) => new cloudwatch.Alarm(this, id, {
      alarmName: naming.alarmName(suffix), alarmDescription: description, metric, threshold, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notify);
    alarm("MintsAlarm", "CanarySessionMints", `The canary session function minted ${CANARY_MINTS_ALARM_THRESHOLD} or more sessions in an hour: more than deploy-time use. Check who invoked it (the step role is the only allowed caller) and the pipeline runs.`,
      count("MintFilter", "CanarySessionMints", "signin.canary_session"), CANARY_MINTS_ALARM_THRESHOLD);
    alarm("RefusalsAlarm", "CanarySessionRefused", "The canary session function refused a request (not set up, a person or company check, or the hourly mint limit). A deploy-time canary is never refused when it is set up.",
      count("RefusalFilter", "CanarySessionRefusals", "signin.canary_refused"), 1);
    alarm("InvocationsAlarm", "CanarySessionInvocations", `The canary session function was called ${CANARY_INVOCATIONS_ALARM_THRESHOLD} or more times in an hour: more than a canary run needs.`,
      fn.metricInvocations({ period: Duration.hours(1), statistic: "Sum" }), CANARY_INVOCATIONS_ALARM_THRESHOLD);
  }

  /** What the token key's deny lets sign: the sign-in function's role, and this function's role only while it exists. */
  signerRoles(identityRoleArn: string): unknown {
    return Fn.conditionIf(this.isOn.logicalId, [identityRoleArn, this.function.role!.roleArn], identityRoleArn);
  }
}

/** The function, where it applies (the legacy layout, with developer tasks, and its parameters declared); undefined elsewhere. Kept out of DeveloperSignIn's constructor (the complexity limit). */
export function canarySessionWhere(withTasks: boolean, scope: Construct, id: string, parameters: CanarySessionParameters | undefined, props: Omit<CanarySessionProps, "parameters" | "alerts"> & { alerts: sns.ITopic | undefined }): CanarySession | undefined {
  if (!withTasks || props.naming.env !== undefined || parameters === undefined) return undefined;
  if (props.alerts === undefined) throw new Error("the canary session function needs the operator alerts topic");
  return new CanarySession(scope, id, { ...props, alerts: props.alerts, parameters });
}

/** The parameters, only where asked (the legacy layout): declared after every other parameter of the sign-in server. */
export function canaryParametersWhere(stack: Stack, applies: boolean | undefined): { canary?: CanarySessionParameters } {
  return applies === true ? { canary: canarySessionParameters(stack) } : {};
}

/** What the developer token key's deny lets sign: the sign-in function's role, and the canary function's only while it exists. */
export function tokenSigners(canary: CanarySession | undefined, identityRoleArn: string): unknown {
  return canary === undefined ? identityRoleArn : canary.signerRoles(identityRoleArn);
}
