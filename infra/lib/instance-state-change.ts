import { Duration, aws_events as events, aws_events_targets as targets, aws_iam as iam, type aws_dynamodb as dynamodb, type aws_lambda as lambda } from "aws-cdk-lib";
import { Construct } from "constructs";
import { packagedFunction } from "./control-plane.js";
import type { AgentXNaming } from "./naming.js";

/** The EC2 states that end a worker (packages/broker/src/aws/instance-state-change.ts ENDED_INSTANCE_STATES; tests/contract/instance-state-change-infrastructure.test.ts holds the two equal). */
export const INSTANCE_ENDED_STATES = ["stopping", "shutting-down", "terminated"] as const;
/** The State table actions the handler's code uses (the reconciler's `markLost` and `failActiveOperation`): reads and conditional writes on session, workspace and operation rows. A transaction is authorised by the item actions it holds (Update, Put, ConditionCheck): `dynamodb:TransactWriteItems` is not an IAM action. No Scan, no batch, no delete. */
export const INSTANCE_STATE_CHANGE_TABLE_ACTIONS = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:PutItem", "dynamodb:ConditionCheckItem"] as const;

/**
 * A named environment's rule name. It is chosen to fall under the ONE EventBridge pattern the environment's deploy role and its boundary already allow (`rule/agentx-<env>-*-service-failures`,
 * access-policies.ts EcsFailureEventsRule), so the access stack, which a platform team deploys and reviews, does not change and need not be redeployed before this control plane: no wider
 * `events:*` grant, no new statement (the deploy boundary has 25 characters of headroom at the longest environment name, so a second statement does not fit). At most 60 characters at the longest name.
 *
 * DECISION (WORKER-DELIVERY-IDENTITY, 2026-11-25): the name says "service-failures" although the rule is not an ECS rule; the coupling (a rule of this environment must be named into that pattern or its
 * deploy is refused) lives here and in tests/contract/instance-state-change-infrastructure.test.ts, which fails if either side moves. FOLLOW-UP: once the four `Resource: *` denies are merged and the
 * boundary has room, give the access stack its own `agentx-<env>-*-instance-events` statement (platform-team deploy ordering: access stack first), then rename this rule.
 */
export function instanceStateChangeRuleName(env: string): string {
  return `agentx-${env}-worker-instance-service-failures`;
}

export interface InstanceStateChangeProps {
  naming: AgentXNaming;
  state: dynamodb.Table;
}

/**
 * WORKER-DELIVERY-IDENTITY step 0 (ii): an EC2 instance that is stopping, shutting down or terminated marks the READY session that holds it lost within seconds, instead of at the reconciler's next
 * run (up to 10 minutes). EventBridge's EC2 state-change event carries no tags, so the rule cannot be scoped to this environment's workers; the scope is the function's lookup, which touches only an
 * instance a READY session in this environment's State table names. The function holds no EC2 permission and no network path (it reads and writes the State table only, which is why it is not in the
 * VPC). The reconciler stays as the backstop: EventBridge delivery is best effort.
 */
export class InstanceStateChange extends Construct {
  readonly handler: lambda.Function;
  readonly rule: events.Rule;

  constructor(scope: Construct, id: string, props: InstanceStateChangeProps) {
    super(scope, id);
    this.handler = packagedFunction(this, "Function", "packages/broker/src/aws/instance-state-change-lambda.ts", {
      STATE_TABLE_NAME: props.state.tableName,
      AGENTX_METRICS_NAMESPACE: props.naming.metricsNamespace,
    }, Duration.seconds(30));
    this.handler.addToRolePolicy(new iam.PolicyStatement({
      sid: "MarkLostSessions",
      actions: [...INSTANCE_STATE_CHANGE_TABLE_ACTIONS],
      resources: [props.state.tableArn, `${props.state.tableArn}/index/*`],
    }));
    this.rule = new events.Rule(this, "Rule", {
      // A named environment's deploy role may create a rule of exactly this name (see instanceStateChangeRuleName); the legacy install is deployed by an operator and takes a generated name.
      ...(props.naming.env === undefined ? {} : { ruleName: instanceStateChangeRuleName(props.naming.env) }),
      description: "Marks the READY EC2 session of an instance that is stopping, shutting down or terminated lost, and fails its running operation (the reconciler's repair, within seconds)",
      eventPattern: {
        source: ["aws.ec2"],
        detailType: ["EC2 Instance State-change Notification"],
        detail: { state: [...INSTANCE_ENDED_STATES] },
      },
      targets: [new targets.LambdaFunction(this.handler, { retryAttempts: 2 })],
    });
  }
}
