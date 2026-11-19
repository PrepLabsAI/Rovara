// Web task channel C8, option b (DEC 254zm(3)): the attention email's own small sender function (packages/broker/src/aws/attention-email-sender.ts). Named environments only, inside the core engine.
//
// OFF BY DEFAULT, and off builds nothing: the function, its log group, its role, the role's one policy and the broker's right to invoke it are each under the `AttentionEmailIsOn` condition
// (`CoreAttentionEmail` = `on`), so with the default `off` the template creates none of them. Switching on adds them; switching off deletes them.
//
// The grants, and nothing else:
//   - the function's role: ses:SendEmail on the ONE identity `CoreAttentionEmailSender` names, with ses:FromAddress pinned to it (the step-up statement's shape, a different identity). No
//     ses:SendRawEmail, no wildcard, no other service (its X-Ray and log writes are the function defaults);
//   - the broker: lambda:InvokeFunction on this one function, granted on the FUNCTION's resource policy (an AWS::Lambda::Permission naming the broker's role), not on the broker's role, which is at
//     IAM's size limit. Same account, so the function policy alone grants it; the permissions boundary still bounds the broker's role (it allows lambda);
//   - the broker's environment grows by the packed switch only (`ae=off`, 7 bytes at worst): the function's name is fixed (`coreAttentionEmailFunctionName`) and derived by the broker, and the web
//     app's host goes to the sender function alone (the broker writes the email's links on a reserved placeholder origin that the sender replaces with `https://<host>`).
// A template rule refuses `on` without a sender identity, or with the step-up sender's exact identity, so the two do not share an identity's reputation. It does NOT separate them fully: SES's
// suppression list, complaint-rate review and sending pause are per account, so a complaint about attention mail can still suppress step-up codes to that address (an SES account setting, outside this template).
import { CfnCondition, CfnParameter, CfnResource, CfnRule, Duration, Fn, Stack, aws_iam as iam, type aws_lambda as lambda } from "aws-cdk-lib";
import { Construct } from "constructs";
import { ATTENTION_EMAIL_FUNCTION_VARIABLE, CORE_MODEL_GATEWAY_HOST_MAX_LENGTH, CORE_MODEL_GATEWAY_HOST_PATTERN, coreAttentionEmailFunctionName } from "@agentx/contracts";
import { addBrokerSetting, addDerivedBrokerVariable } from "./broker-names.js";
import { packagedFunction } from "./control-plane.js";
import { STEP_UP_EMAIL_SENDER_PATTERN } from "./developer-signin.js";
import type { AgentXNaming } from "./naming.js";

export const ATTENTION_EMAIL_PARAMETER = "CoreAttentionEmail";
export const ATTENTION_EMAIL_HOST_PARAMETER = "CoreAttentionEmailHost";
export const ATTENTION_EMAIL_SENDER_PARAMETER = "CoreAttentionEmailSender";

export interface AttentionEmailProps {
  readonly naming: AgentXNaming;
  readonly env: string;
  readonly broker: lambda.Function;
}

export class AttentionEmail extends Construct {
  readonly parameter: CfnParameter;
  readonly host: CfnParameter;
  readonly sender: CfnParameter;
  readonly isOn: CfnCondition;
  readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: AttentionEmailProps) {
    super(scope, id);
    const stack = Stack.of(this);
    // Declared on the stack itself, so the parameters' names are exactly these (the CLI keeps them across upgrades).
    this.parameter = new CfnParameter(stack, ATTENTION_EMAIL_PARAMETER, { type: "String", default: "off", allowedValues: ["off", "on"], description: "Attention email (web task channel C8). off (the default): no email is sent, no unsubscribe route is served and no sender function exists; on: people with no chat are told by email from CoreAttentionEmailSender" });
    this.host = new CfnParameter(stack, ATTENTION_EMAIL_HOST_PARAMETER, { type: "String", default: "", maxLength: CORE_MODEL_GATEWAY_HOST_MAX_LENGTH, allowedPattern: CORE_MODEL_GATEWAY_HOST_PATTERN, description: "The web app's host (no scheme, path or credentials), where the attention email's links point; empty keeps the attention email off" });
    this.sender = new CfnParameter(stack, ATTENTION_EMAIL_SENDER_PARAMETER, { type: "String", default: "", maxLength: 254, allowedPattern: STEP_UP_EMAIL_SENDER_PATTERN, description: "The verified Amazon SES email identity (one address, with no default configuration set) that sends attention email; never the StepUpEmailSender identity" });
    addBrokerSetting(props.broker, props.naming, "coreAttentionEmail", this.parameter.valueAsString);
    const functionName = coreAttentionEmailFunctionName(props.env);
    addDerivedBrokerVariable(props.broker, props.naming, ATTENTION_EMAIL_FUNCTION_VARIABLE, functionName);

    this.isOn = new CfnCondition(this, "AttentionEmailIsOn", { expression: Fn.conditionEquals(this.parameter.valueAsString, "on") });
    const stepUp = stack.node.tryFindChild("StepUpEmailSender");
    if (!(stepUp instanceof CfnParameter)) throw new Error("attention email: a named environment declares StepUpEmailSender first");
    new CfnRule(this, "AttentionEmailOwnSender", {
      ruleCondition: Fn.conditionEquals(this.parameter.valueAsString, "on"),
      assertions: [
        { assert: Fn.conditionNot(Fn.conditionEquals(this.sender.valueAsString, "")), assertDescription: "CoreAttentionEmail on needs CoreAttentionEmailSender, a verified SES identity of its own" },
        { assert: Fn.conditionNot(Fn.conditionEquals(this.sender.valueAsString, stepUp.valueAsString)), assertDescription: "CoreAttentionEmailSender must not be the StepUpEmailSender identity" },
        { assert: Fn.conditionNot(Fn.conditionEquals(this.host.valueAsString, "")), assertDescription: "CoreAttentionEmail on needs CoreAttentionEmailHost, the web app's host" },
      ],
    });

    const sender = this.sender.valueAsString;
    this.function = packagedFunction(this, "Sender", "packages/broker/src/aws/attention-email-sender.ts", {
      ATTENTION_EMAIL_FROM: sender,
      ATTENTION_EMAIL_LINK_ORIGIN: `https://${this.host.valueAsString}`,
    }, Duration.seconds(10), [], 256);
    (this.function.node.defaultChild as lambda.CfnFunction).functionName = functionName;
    this.function.addToRolePolicy(new iam.PolicyStatement({
      sid: "AttentionEmailSend",
      actions: ["ses:SendEmail"],
      resources: [stack.formatArn({ service: "ses", resource: "identity", resourceName: sender })],
      conditions: { StringEquals: { "ses:FromAddress": sender } },
    }));
    // The broker's right to invoke it, on the function's own policy (not the broker's role).
    this.function.addPermission("BrokerInvokes", { principal: new iam.ArnPrincipal(props.broker.role!.roleArn), action: "lambda:InvokeFunction" });
    // Off builds nothing: every resource of this construct (the function, its log group, role, policy and permission) exists only while the email is on.
    for (const child of this.node.findAll()) if (child instanceof CfnResource) child.cfnOptions.condition = this.isOn;
  }
}
