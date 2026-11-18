// Engine host (migration plan v3.2 lane E2): the core engine switch's deployment half. Named environments only: the legacy template has none of it. Ported from the monolith's core-engine
// construct; the switch is a stack parameter of its own and a plain broker variable (Code's broker does not pack its settings).
//
// What is here:
//   - the `CoreEngine` stack parameter (default `off`), packed for the broker (AGENTX_SETTINGS `sw`, read as ROVARA_CORE_ENGINE) and given to the dispatcher whole;
//   - the core dispatch queue and its dead-letter queue, with a redrive limit above the core's own retry budget (CORE_DISPATCH_MAX_RECEIVES). Fixed per-environment names, so the broker can build
//     both URLs. The broker may send to, receive from, delete from and change the visibility of both (the core's `queue` point runs inside the broker; the queue adapter reads and re-sends dead letters itself),
//     by the queues' own resource policies;
//   - a schedule per scheduled row of the core's job table (CORE_JOB_SCHEDULES), in a group of their own, that invokes the broker with `{ source: "agentx.core-job", job: <name> }` through a role
//     of its own. The role trusts only the scheduler for THIS group and may invoke the broker function and nothing else. The schedules always exist and are ENABLED only while `CoreEngine` is not
//     `off`: switching the schedules on or off changes a state, never creates or deletes one. (Step 4's dispatcher policy under `CoreEngineIsOn` IS added on switch-on and removed on
//     switch-off: a switch-on change set shows that one IAM policy Add, the dispatcher's environment Modify and the mapping's Enabled flag. Its grant may take a few seconds to apply
//     after the mapping is enabled; a first core batch that meets AccessDenied on the deleter comes back and is retried.)
//   - an alarm on the dead-letter queue;
//   - (web task channel C8, option b) the attention email: CoreAttentionEmail (default off), CoreAttentionEmailHost and CoreAttentionEmailSender, and the small sender function the broker invokes,
//     which with its role and invoke permission exists only while CoreAttentionEmail is on (attention-email.ts);
//   - the `CoreAnswersModel` parameter (L4-AM, default empty = the agent model; broker only, packed `aa`, ROVARA_CORE_ANSWERS_MODEL, hosted answers and classifier only)
//   - the `CoreLearningModel` parameter (DEC 254zzz58, default empty = the first Claude model the gateway offers the company; broker only, packed `lm`, ROVARA_CORE_LEARNING_MODEL, lessons learning only)
//   - the `CoreModelGatewayHost` and `CoreAgentModel` parameters (default empty), packed for the broker and the dispatcher, which read them as ROVARA_CORE_MODEL_GATEWAY_URL
//     (`https://<host>`) and ROVARA_CORE_AGENT_MODEL.
//
//   - (step 4, `connectDispatcher`) the dispatcher as the queue's consumer: an event source mapping of its own, ENABLED only while `CoreEngine` is not `off`, so a core message never reaches
//     the spec 056 dispatch code; its reads of this queue; and, only while the switch is not off, the deleter start (the core ends an orphan machine) and the
//     callback signing key (the core issues a worker's capability and repository grant on the dispatcher, so they are the ones the broker verifies).
//
// The broker wiring is now present (CORE_ENGINE_BROKER_WIRED): the CLI accepts the reviewed switch values, and schedules and mapping are enabled by the named switch.
import { CfnCondition, CfnParameter, Duration, Fn, Stack, Token, aws_cloudwatch as cloudwatch, aws_iam as iam, aws_lambda as lambda, aws_scheduler as scheduler, aws_sqs as sqs, type aws_cloudwatch_actions as cloudwatchActions } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  CORE_AGENT_MODEL_MAX_LENGTH, CORE_AGENT_MODEL_PATTERN, CORE_ANSWERS_MODEL_MAX_LENGTH, CORE_ANSWERS_MODEL_PATTERN, CORE_LEARNING_MODEL_MAX_LENGTH, CORE_LEARNING_MODEL_PATTERN, CORE_MODEL_GATEWAY_HOST_MAX_LENGTH, CORE_MODEL_GATEWAY_HOST_PATTERN,
  TEST_SERVICES_PARAMETER_DEFAULT, TEST_SERVICES_PARAMETER_VALUES, TEST_SERVICE_IMAGES_PARAMETER_DEFAULT, TEST_SERVICE_IMAGES_PARAMETER_VALUES, CORE_DISPATCH_ATTEMPTS_MAX, CORE_DISPATCH_BATCH_SIZE, CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE, CORE_DISPATCH_MAX_RECEIVES, CORE_DISPATCH_QUEUE_ARN_VARIABLE, CORE_DISPATCH_QUEUE_URL_VARIABLE, CORE_ENGINE_DEFAULT, CORE_ENGINE_PARAMETER_MAX_LENGTH, CORE_ENGINE_PARAMETER_PATTERN, CORE_ENGINE_VARIABLE, CORE_JOB_EVENT_SOURCE, CORE_JOB_SCHEDULES, POLICY_HOOK_PARAMETER_MAX_LENGTH,
  coreDispatchDeadLetterName, coreDispatchQueueName, SYSTEM_RUNS_DEFAULT, SYSTEM_RUNS_PARAMETER_PATTERN, UPKEEP_NIGHT_JOB, type CoreJobSchedule,
} from "@agentx/contracts";
import type { AgentXNaming } from "./naming.js";
import { addBrokerSetting, addPackedSetting } from "./broker-names.js";
import { AttentionEmail } from "./attention-email.js";

/** The stack parameter that holds the switch. */
export const CORE_ENGINE_PARAMETER = "CoreEngine";
/** DEC 254z-amend3: the stack parameter that holds the test services switch. */
export const TEST_SERVICES_PARAMETER = "TestServices";
/** DEC 254zm: the stack parameter that says the install's copies of the starter images are in place (`mirrored`), so Code's workers run test services. */
export const TEST_SERVICE_IMAGES_PARAMETER = "TestServiceImages";

/** The broker's actions on the core dispatch queue and its dead letters. */
export const CORE_BROKER_QUEUE_ACTIONS = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"] as const;

/** The dispatcher's actions on the core dispatch queue: the event source mapping's reads, and the core's own visibility change of a message it will try again. Not send, and not the dead letters. */
export const CORE_DISPATCHER_QUEUE_ACTIONS = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"] as const;

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
  readonly dispatcher: lambda.Function;
  readonly notifyOperator: cloudwatchActions.SnsAction;
}

export class CoreEngine extends Construct {
  readonly parameter: CfnParameter;
  private readonly allowedCompanies: CfnParameter;
  private readonly taskCap: CfnParameter;
  private readonly companyDayCap: CfnParameter;
  private readonly policyHook: CfnParameter;
  private readonly lessons: CfnParameter;
  private readonly systemRuns: CfnParameter;
  private readonly modelGatewayHost: CfnParameter;
  private readonly agentModel: CfnParameter;
  /** DEC 254z-amend3: the install's test services switch ("1" on, the default; "0" off), packed for the broker and the dispatcher (`td`) and given to the session steps whole. */
  readonly testServices: CfnParameter;
  /** DEC 254zm: `none` (the default) or `mirrored`, packed for the broker and the dispatcher (`ti`) and given whole to the session steps. */
  readonly testServiceImages: CfnParameter;
  private readonly answersModel: CfnParameter;
  private readonly learningModel: CfnParameter;
  readonly queue: sqs.Queue;
  readonly deadLetters: sqs.Queue;
  readonly scheduleGroup: scheduler.CfnScheduleGroup;
  readonly invokeRole: iam.Role;
  readonly schedules: scheduler.CfnSchedule[] = [];
  readonly isOn: CfnCondition;
  readonly attentionEmail: AttentionEmail;
  readonly systemRunsOn: CfnCondition;
  private readonly brokerFunctionArn: string;

  constructor(scope: Construct, id: string, props: CoreEngineProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { env, broker, dispatcher } = props;
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
    this.allowedCompanies = new CfnParameter(stack, "CoreAllowedCompanies", { type: "String", default: "none", maxLength: 64, allowedPattern: "^(none|all|org_[0-9a-z]{20}(:org_[0-9a-z]{20})?)$", description: "Core engine admission: none (safe default), all, or up to two company ids" });
    this.taskCap = new CfnParameter(stack, "CoreTaskCapUsd", { type: "String", default: "5", maxLength: 4, allowedPattern: "^([1-9][0-9]{0,2}|1000)$", description: "Core engine per-task cap in whole USD, from 1 to 1000" });
    this.companyDayCap = new CfnParameter(stack, "CoreCompanyDayCapUsd", { type: "String", default: "25", maxLength: 4, allowedPattern: "^([1-9][0-9]{0,2}|1000)$", description: "Core engine per-company UTC-day cap in whole USD, from 1 to 1000" });
    this.policyHook = new CfnParameter(stack, "CorePolicyHook", { type: "String", default: "", maxLength: POLICY_HOOK_PARAMETER_MAX_LENGTH, allowedPattern: "^[ -~]*$", description: "Optional policy-hook settings JSON; empty disables the hook" });
    this.lessons = new CfnParameter(stack, "CoreLessons", { type: "String", default: "off", maxLength: 64, allowedPattern: "^(off|on|on:org_[0-9a-z]{20}(:org_[0-9a-z]{20})?)$", description: "Core lessons switch, default off" });
    for (const [key, value] of [["coreTaskCap", this.taskCap.valueAsString], ["coreCompanyDayCap", this.companyDayCap.valueAsString], ["coreLessons", this.lessons.valueAsString]] as const) {
      addBrokerSetting(broker, props.naming, key, value);
      addPackedSetting(dispatcher, key, value);
    }
    // L4-P1 (owner DEC 254zzl): the per-company flag of system-started runs, default off (written out: tests/contract/config-keys.test.ts reads the declaration). It also holds the hourly `upkeep-night` schedule off (below).
    // L4-P2: also packed for the dispatcher (an environment value only, no IAM): its setup gate before a build can RETRY a re-check, and that retry must stop when the flag (or the company's consent) goes off.
    this.systemRuns = new CfnParameter(stack, "CoreSystemRuns", { type: "String", default: SYSTEM_RUNS_DEFAULT, maxLength: 64, allowedPattern: SYSTEM_RUNS_PARAMETER_PATTERN, description: "Core system-started runs (Rovara's own setup re-check and nightly check): off (the default), on, or on:<company id>[:<company id>]. Also enables the hourly upkeep-night schedule" });
    addBrokerSetting(broker, props.naming, "coreSystemRuns", this.systemRuns.valueAsString);
    addPackedSetting(dispatcher, "coreSystemRuns", this.systemRuns.valueAsString);
    addBrokerSetting(broker, props.naming, "coreAllowedCompanies", this.allowedCompanies.valueAsString);
    addPackedSetting(dispatcher, "coreAllowedCompanies", this.allowedCompanies.valueAsString);
    broker.addEnvironment("ROVARA_POLICY_HOOK", this.policyHook.valueAsString);
    dispatcher.addEnvironment("ROVARA_POLICY_HOOK", this.policyHook.valueAsString);
    // Core switch-on blocker (2026-11-17): the model gateway's host and the agent model, for both functions (core-host/gateway-model-access.ts). Stack parameters, so an upgrade keeps them
    // (OPERATOR_PARAMETERS); packed, because the broker's 4 KB has no room for two more variables (a host has no separator; the broker reads `https://<host>`). Both empty (the
    // default): the core refuses the switch by name, as before.
    this.modelGatewayHost = new CfnParameter(stack, "CoreModelGatewayHost", { type: "String", default: "", maxLength: CORE_MODEL_GATEWAY_HOST_MAX_LENGTH, allowedPattern: CORE_MODEL_GATEWAY_HOST_PATTERN, description: "Core engine model gateway host, reached over https (no scheme, path or credentials); empty (the default) leaves the core refused" });
    this.agentModel = new CfnParameter(stack, "CoreAgentModel", { type: "String", default: "", maxLength: CORE_AGENT_MODEL_MAX_LENGTH, allowedPattern: CORE_AGENT_MODEL_PATTERN, description: "Core engine agent model, any model the model gateway offers by its exact id, such as claude-sonnet-4-6 or zai.glm-5; empty (the default) leaves the core refused" });
    for (const [key, value] of [["coreModelGateway", this.modelGatewayHost.valueAsString], ["coreAgentModel", this.agentModel.valueAsString]] as const) {
      addBrokerSetting(broker, props.naming, key, value);
      addPackedSetting(dispatcher, key, value);
    }
    // DEC 254z-amend3: test services, ON by default with the owner's opt-out "0". A stack parameter, so an upgrade keeps what the operator set (OPERATOR_PARAMETERS); packed (`td`, read as ROVARA_TEST_SERVICES)
    // for the broker and the dispatcher, where the core reads it, and given whole to the session steps (control-plane.ts). Code's workers cannot run test services yet, so while it is on the broker and the
    // dispatcher say "not available here" (aws/hosted-test-services.ts).
    this.testServices = new CfnParameter(stack, TEST_SERVICES_PARAMETER, { type: "String", default: TEST_SERVICES_PARAMETER_DEFAULT, allowedValues: [...TEST_SERVICES_PARAMETER_VALUES], description: "Test services: 1 on (the default), 0 off" });
    addBrokerSetting(broker, props.naming, "testServices", this.testServices.valueAsString);
    addPackedSetting(dispatcher, "testServices", this.testServices.valueAsString);
    // DEC 254zm: whether the five starter copies are in place. `none` until the operator copied and checked them (scripts/test-services-mirror.ts), then `mirrored`: kept across upgrades (OPERATOR_PARAMETERS).
    this.testServiceImages = new CfnParameter(stack, "TestServiceImages", { type: "String", default: TEST_SERVICE_IMAGES_PARAMETER_DEFAULT, allowedValues: [...TEST_SERVICE_IMAGES_PARAMETER_VALUES], description: "Test service images: none (the default) or mirrored once the starter copies are checked" });
    addBrokerSetting(broker, props.naming, "testServiceImages", this.testServiceImages.valueAsString);
    addPackedSetting(dispatcher, "testServiceImages", this.testServiceImages.valueAsString);
    // L4-AM (DEC 254zzn(2)): the hosted answers model, for the BROKER only (the answers and the start-box classifier run there; the dispatcher runs coding steps, which keep the agent model). A
    // stack parameter, so an upgrade keeps it (OPERATOR_PARAMETERS); packed (`aa`), because the broker's 4 KB has no room for another variable. Empty (the default): answers and the
    // classifier use the agent model, exactly as before. A Claude engine name only (the answers purpose runs on the company's own Anthropic account). No IAM, no secret.
    this.answersModel = new CfnParameter(stack, "CoreAnswersModel", { type: "String", default: "", maxLength: CORE_ANSWERS_MODEL_MAX_LENGTH, allowedPattern: CORE_ANSWERS_MODEL_PATTERN, description: "Core engine hosted answers model, a Claude model id such as claude-haiku-4-5 used for the Just answer and the start-box classifier only; empty (the default) uses the agent model" });
    addBrokerSetting(broker, props.naming, "coreAnswersModel", this.answersModel.valueAsString);
    // DEC 254zzz58: the hosted lessons' learning model, for the BROKER only (the lessons' learning calls run there), separate from the agent model. A stack parameter (OPERATOR_PARAMETERS keeps it
    // across upgrades), packed (`lm`). Empty (the default): the first Claude model the model gateway offers the company. A Claude engine name only (the learning route used is the company's own
    // Anthropic account). No IAM, no secret: the broker already reads the offered models and mints learning tokens with its task key.
    this.learningModel = new CfnParameter(stack, "CoreLearningModel", { type: "String", default: "", maxLength: CORE_LEARNING_MODEL_MAX_LENGTH, allowedPattern: CORE_LEARNING_MODEL_PATTERN, description: "Core engine hosted lessons learning model, a Claude model id such as claude-haiku-4-5 used for lessons learning only; empty (the default) uses the first Claude model the model gateway offers the company" });
    addBrokerSetting(broker, props.naming, "coreLearningModel", this.learningModel.valueAsString);

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
    // Packed (core switch-on blocker, 2026-11-17: room for the gateway settings); the dispatcher keeps its own variable (connectDispatcher).
    addBrokerSetting(broker, props.naming, "coreEngine", this.parameter.valueAsString);
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
    // The upkeep night (L4-P1) is enabled only while the engine is not off AND system runs are not off: the resource is there, its state follows the flag (default DISABLED, so merging this changes nothing).
    this.systemRunsOn = new CfnCondition(this, "CoreSystemRunsIsOn", { expression: Fn.conditionAnd(Fn.conditionNot(Fn.conditionEquals(this.parameter.valueAsString, "off")), Fn.conditionNot(Fn.conditionEquals(this.systemRuns.valueAsString, "off"))) });
    const upkeepState = Token.asString(Fn.conditionIf(this.systemRunsOn.logicalId, "ENABLED", "DISABLED"));
    for (const entry of CORE_JOB_SCHEDULES) this.schedules.push(this.schedule(entry, entry.job === UPKEEP_NIGHT_JOB ? upkeepState : state));
    // Web task channel C8 (option b): the attention email's own sender function, OFF by default and absent from the template while off (attention-email.ts).
    this.attentionEmail = new AttentionEmail(this, "AttentionEmail", { naming: props.naming, env, broker });
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

  /**
   * Lane E2 step 4: the dispatcher is the core dispatch queue's consumer (packages/broker/src/aws/worker-machines/dispatcher-core.ts routes the queue's records to the core).
   *   - an event source mapping of its own on this queue (apart from the DispatchQueue's), one record per invocation, reporting batch item failures, ENABLED only while the switch is not off;
   *   - its reads of this queue, on its role (one statement): Lambda checks the function role's own permissions when it creates the mapping, even a disabled one, so the reads are
   *     there whatever the switch says. Exactly this queue, never send and never the dead letters. The dispatcher's role is not the broker's (which is at IAM's size limit);
   *   - only while the switch is not off (a policy of its own under `CoreEngineIsOn`): the deleter's start (the core ends a machine it started for a workspace that closed meanwhile).
   *     No ec2:TerminateInstances: the core's dispatch never stops a machine, and a stop claimed elsewhere is finished by the idle reaper;
   *   - the switch, the queue's names and the workers' placement (subnets, launch template) as plain variables, and the callback signing key's secret name only while the switch is not off (an empty value otherwise, and no grant to read it), so an off dispatcher can read no
   *     key it does not use. The key is never an environment value.
   */
  connectDispatcher(dispatcher: lambda.Function, props: { deleterArn: string; callbackSigningKeySecret: { secretName: string; secretArn: string }; workerSubnets: string; workerLaunchTemplateId: string }): lambda.CfnEventSourceMapping {
    dispatcher.addEnvironment(CORE_DISPATCH_QUEUE_ARN_VARIABLE, this.queue.queueArn);
    dispatcher.addEnvironment(CORE_DISPATCH_QUEUE_URL_VARIABLE, this.queue.queueUrl);
    dispatcher.addEnvironment(CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE, this.deadLetters.queueUrl);
    dispatcher.addEnvironment(CORE_ENGINE_VARIABLE, this.parameter.valueAsString);
    // Where a core workspace's worker runs: the install's own workers, as the broker places a sign-in client's project (never a binding a company writes).
    dispatcher.addEnvironment("EC2_WORKER_SUBNETS", props.workerSubnets);
    dispatcher.addEnvironment("EC2_WORKER_LAUNCH_TEMPLATE_ID", props.workerLaunchTemplateId);
    dispatcher.addEnvironment("CALLBACK_SIGNING_KEY_SECRET_ID", Token.asString(Fn.conditionIf(this.isOn.logicalId, props.callbackSigningKeySecret.secretName, "")));
    dispatcher.addToRolePolicy(new iam.PolicyStatement({ sid: "ConsumeCoreDispatchQueue", actions: [...CORE_DISPATCHER_QUEUE_ACTIONS], resources: [this.queue.queueArn] }));
    const corePolicy = new iam.Policy(this, "DispatcherCorePolicy", {
      roles: [dispatcher.role!],
      statements: [
        new iam.PolicyStatement({ sid: "CoreStartSessionDeleter", actions: ["states:StartExecution"], resources: [props.deleterArn] }),
        // The callback signing key, by name, exactly that secret, and only while the switch is not off (with the ARN itself).
        new iam.PolicyStatement({ sid: "ReadCallbackSigningKey", actions: ["secretsmanager:GetSecretValue"], resources: [props.callbackSigningKeySecret.secretArn] }),
      ],
    });
    (corePolicy.node.defaultChild as iam.CfnPolicy).cfnOptions.condition = this.isOn;
    const mapping = new lambda.CfnEventSourceMapping(this, "DispatcherMapping", {
      functionName: dispatcher.functionName,
      eventSourceArn: this.queue.queueArn,
      batchSize: CORE_DISPATCH_BATCH_SIZE,
      functionResponseTypes: ["ReportBatchItemFailures"],
      enabled: Fn.conditionIf(this.isOn.logicalId, true, false),
    });
    // The mapping is created after the grant that lets the role read the queue.
    const policy = dispatcher.role?.node.tryFindChild("DefaultPolicy");
    if (policy !== undefined) mapping.node.addDependency(policy);
    return mapping;
  }
}
