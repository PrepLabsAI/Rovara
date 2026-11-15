// Engine host (migration plan v3.2 lane E2): the core engine switch's deployment half. Named environments only: the legacy template has none of it. Ported from the monolith's core-engine
// construct; the switch is a stack parameter of its own and a plain broker variable (Code's broker does not pack its settings).
//
// What is here:
//   - the `CoreEngine` stack parameter (default `off`), passed to the broker as ROVARA_CORE_ENGINE;
//   - the core dispatch queue and its dead-letter queue, with a redrive limit above the core's own retry budget (CORE_DISPATCH_MAX_RECEIVES). Fixed per-environment names, so the broker can build
//     both URLs. The broker may send to, receive from, delete from and change the visibility of both (the core's `queue` point runs inside the broker; the queue adapter reads and re-sends dead letters itself),
//     by the queues' own resource policies;
//   - a schedule per scheduled row of the core's job table (CORE_JOB_SCHEDULES), in a group of their own, that invokes the broker with `{ source: "agentx.core-job", job: <name> }` through a role
//     of its own. The role trusts only the scheduler for THIS group and may invoke the broker function and nothing else. The schedules always exist and are ENABLED only while `CoreEngine` is not
//     `off`: switching on or off changes a state, never creates or deletes a resource;
//   - an alarm on the dead-letter queue.
//
// Not here yet (a later R2 step, with the broker wiring after the second mainline sync): the dispatcher's event source mapping on the core queue and its grants. Until then nothing consumes the
// queue and nothing sends to it, and the broker has no branch for a scheduled core job event yet, so the CLI accepts only `off` (CORE_ENGINE_BROKER_WIRED); the schedules stay DISABLED.
import { CfnCondition, CfnParameter, Duration, Fn, Stack, Token, aws_cloudwatch as cloudwatch, aws_iam as iam, type aws_lambda as lambda, aws_scheduler as scheduler, aws_sqs as sqs, type aws_cloudwatch_actions as cloudwatchActions } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  CORE_DISPATCH_ATTEMPTS_MAX, CORE_DISPATCH_MAX_RECEIVES, CORE_ENGINE_DEFAULT, CORE_ENGINE_PARAMETER_MAX_LENGTH, CORE_ENGINE_PARAMETER_PATTERN, CORE_ENGINE_VARIABLE, CORE_JOB_EVENT_SOURCE, CORE_JOB_SCHEDULES,
  coreDispatchDeadLetterName, coreDispatchQueueName, type CoreJobSchedule,
} from "@agentx/contracts";
import type { AgentXNaming } from "./naming.js";

/** The stack parameter that holds the switch. */
export const CORE_ENGINE_PARAMETER = "CoreEngine";

/** The broker's actions on the core dispatch queue and its dead letters. */
export const CORE_BROKER_QUEUE_ACTIONS = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"] as const;

/** The queue's visibility timeout, as the DispatchQueue's; the core extends it per message while a step starts. */
export const CORE_DISPATCH_VISIBILITY_TIMEOUT = Duration.minutes(2);

/** The health route reads this alarm by name (HEALTH_ALARM_SUFFIXES). */
export const CORE_DISPATCH_DEAD_LETTERS_ALARM = "CoreDispatchDeadLetters";

export interface CoreEngineProps {
  readonly naming: AgentXNaming;
  /** The environment's name (a named environment only). */
  readonly env: string;
  /** The broker function: the schedules' target, and the principal that uses the queues. */
  readonly broker: lambda.Function;
  readonly notifyOperator: cloudwatchActions.SnsAction;
}

export class CoreEngine extends Construct {
  readonly parameter: CfnParameter;
  readonly queue: sqs.Queue;
  readonly deadLetters: sqs.Queue;
  readonly scheduleGroup: scheduler.CfnScheduleGroup;
  readonly invokeRole: iam.Role;
  readonly schedules: scheduler.CfnSchedule[] = [];
  readonly isOn: CfnCondition;
  private readonly brokerFunctionArn: string;

  constructor(scope: Construct, id: string, props: CoreEngineProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { env, broker } = props;
    this.brokerFunctionArn = broker.functionArn;
    if (new Set(CORE_JOB_SCHEDULES.map((entry) => entry.job)).size !== CORE_JOB_SCHEDULES.length) throw new Error("core engine: a job is scheduled once");
    if (CORE_DISPATCH_MAX_RECEIVES <= CORE_DISPATCH_ATTEMPTS_MAX) throw new Error("core engine: the dispatch queue's redrive limit must be above the core's retry budget");

    // Declared on the stack itself, so the parameter's name is exactly CORE_ENGINE_PARAMETER (written out: tests/contract/config-keys.test.ts reads the declaration).
    this.parameter = new CfnParameter(stack, "CoreEngine", {
      type: "String",
      default: CORE_ENGINE_DEFAULT,
      allowedPattern: CORE_ENGINE_PARAMETER_PATTERN,
      maxLength: CORE_ENGINE_PARAMETER_MAX_LENGTH,
      description: "off: every new task runs the spec 056 workflow (the default); on: new tasks of every company start on the core engine; on:<company id>[:<company id>]: only those companies' new tasks do; drain: no new task starts on the core and its running tasks finish there",
    });
    broker.addEnvironment(CORE_ENGINE_VARIABLE, this.parameter.valueAsString);

    // #663 review: only the core dispatch queue may send its dead letters here (RedriveAllowPolicy). Its ARN is built from its fixed name, not referenced, because the queue's own redrive
    // policy already references this queue (a reference back would be a cycle).
    const dispatchQueueArn = stack.formatArn({ service: "sqs", resource: coreDispatchQueueName(env) });
    this.deadLetters = new sqs.Queue(this, "DeadLetterQueue", {
      queueName: coreDispatchDeadLetterName(env), encryption: sqs.QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14),
      redriveAllowPolicy: { redrivePermission: sqs.RedrivePermission.BY_QUEUE, sourceQueues: [sqs.Queue.fromQueueArn(this, "DispatchQueueSource", dispatchQueueArn)] },
      // #663 review: every request over TLS (the queue policy denies aws:SecureTransport false).
      enforceSSL: true,
    });
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: coreDispatchQueueName(env),
      deadLetterQueue: { queue: this.deadLetters, maxReceiveCount: CORE_DISPATCH_MAX_RECEIVES },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: CORE_DISPATCH_VISIBILITY_TIMEOUT,
      enforceSSL: true,
    });
    // Exactly these two queues, granted on each queue's own resource policy, not on the broker's role: the broker role's inline policy is at IAM's size limit (one more statement there makes
    // CDK split it into a managed policy, which the deploy role may not create). Same account, so the queue policy alone grants it; the permissions boundary still bounds the role (it allows sqs).
    for (const queue of [this.queue, this.deadLetters]) {
      queue.addToResourcePolicy(new iam.PolicyStatement({ sid: "BrokerUsesCoreDispatchQueue", principals: [new iam.ArnPrincipal(broker.role!.roleArn)], actions: [...CORE_BROKER_QUEUE_ACTIONS], resources: [queue.queueArn] }));
    }
    new cloudwatch.Alarm(this, "DeadLettersAlarm", {
      alarmName: props.naming.alarmName(CORE_DISPATCH_DEAD_LETTERS_ALARM),
      alarmDescription: "A core engine dispatch message exhausted its receives and is in the core dispatch dead-letter queue, so its task may hold its workspace. Check the broker logs for the operation ID, then redrive or purge the queue.",
      metric: this.deadLetters.metricApproximateNumberOfMessagesVisible({ statistic: "Maximum", period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(props.notifyOperator);

    // The schedules run only while the switch is not off. A condition, so the resources stay and only their state changes.
    this.isOn = new CfnCondition(this, "CoreEngineIsOn", { expression: Fn.conditionNot(Fn.conditionEquals(this.parameter.valueAsString, "off")) });
    this.scheduleGroup = new scheduler.CfnScheduleGroup(this, "ScheduleGroup");
    // EventBridge Scheduler sets aws:SourceArn to the schedule GROUP's ARN, so that is what the trust names.
    this.invokeRole = new iam.Role(this, "InvokeRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": stack.account, "aws:SourceArn": this.scheduleGroup.attrArn } } }),
      description: "EventBridge Scheduler invokes the broker for the core engine's scheduled jobs",
    });
    this.invokeRole.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [broker.functionArn] }));
    const state = Token.asString(Fn.conditionIf(this.isOn.logicalId, "ENABLED", "DISABLED"));
    for (const entry of CORE_JOB_SCHEDULES) this.schedules.push(this.schedule(entry, state));
  }

  private schedule(entry: CoreJobSchedule, state: string): scheduler.CfnSchedule {
    const logical = entry.job.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
    return new scheduler.CfnSchedule(this, `Job${logical}`, {
      description: `Core engine job ${entry.job}`,
      groupName: this.scheduleGroup.ref,
      scheduleExpression: entry.rate,
      flexibleTimeWindow: { mode: "OFF" },
      state,
      target: {
        arn: this.brokerFunctionArn,
        roleArn: this.invokeRole.roleArn,
        input: JSON.stringify({ source: CORE_JOB_EVENT_SOURCE, job: entry.job }),
        // Async invoke: the scheduler sees only a failed Invoke call. A job runs again on the next tick, so a late retry has no value.
        retryPolicy: { maximumRetryAttempts: 1, maximumEventAgeInSeconds: 120 },
      },
    });
  }
}
