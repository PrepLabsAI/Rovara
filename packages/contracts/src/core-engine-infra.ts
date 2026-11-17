/**
 * Engine host (migration plan v3.2 lane E2): the deployment half of the core engine switch, as plain data for the CDK app (infra/lib/core-engine.ts), the CLI and the broker. The app cannot read the
 * broker's job table (packages/broker/src/core-host/jobs.ts), so the schedules are listed here and tests/contract/core-engine-infrastructure.test.ts holds the two equal.
 */

/** The broker's switch variable (core-host/flags.ts reads it). The stack parameter `CoreEngine` sets it. */
export const CORE_ENGINE_VARIABLE = "ROVARA_CORE_ENGINE";

/** The `source` of the event a core job schedule sends to the broker (CORE_SCHEDULE_SOURCE in core-host/jobs.ts). */
export const CORE_JOB_EVENT_SOURCE = "agentx.core-job";

export interface CoreJobSchedule {
  /** The job's name in the broker's CORE_JOBS table: the event is `{ source: "agentx.core-job", job: <name> }`. */
  readonly job: string;
  /** EventBridge Scheduler's rate expression. One minute is its shortest rate. */
  readonly rate: string;
}

/** Every CORE_JOBS row whose trigger is a schedule. The `outbox-relay` row is a stream trigger, not a schedule: only its backstop is here. */
export const CORE_JOB_SCHEDULES: readonly CoreJobSchedule[] = [
  { job: "outbox-relay-backstop", rate: "rate(1 minute)" },
  { job: "dispatch-sweep", rate: "rate(1 minute)" },
  { job: "run-watch", rate: "rate(1 minute)" },
  { job: "merge-tracking", rate: "rate(1 minute)" },
  { job: "session-sweep", rate: "rate(5 minutes)" },
  { job: "notify-deliver", rate: "rate(5 minutes)" },
  { job: "admission-hold-sweep", rate: "rate(15 minutes)" },
  { job: "automation-stop", rate: "rate(1 minute)" },
  { job: "person-erase-resume", rate: "rate(15 minutes)" },
  // #684: the lessons job (core-host/jobs.ts), one schedule per scheduled row.
  { job: "lessons", rate: "rate(5 minutes)" },
  // M7 slice 2: the after-merge watcher's pass (core-host/jobs.ts).
  { job: "after-merge", rate: "rate(1 minute)" },
];

/**
 * What the `CoreEngine` parameter may be: `off`, `on` (every company), `on:<company id>[:<company id>]` or `drain` (no new task on the core, its running tasks served to the end), the shape the
 * broker's parseCoreSwitch reads (core-host/flags.ts). A company id is `org_` and twenty lowercase letters or digits; at most two here. The pattern admits no comma, equals sign, slash or space.
 */
export const CORE_ENGINE_PARAMETER_PATTERN = "^(off|on|drain|on:org_[0-9a-z]{20}(:org_[0-9a-z]{20})?)$";
export const CORE_ENGINE_PARAMETER_MAX_LENGTH = 64;
export const CORE_ENGINE_DEFAULT = "off";
/**
 * Whether the broker runs the core engine. True since L6: the broker wiring has landed and, with the switch off (and not draining), the broker builds nothing and reads no core
 * setting. While false the CLI refused every value but `off`. Turning the engine on still takes the explicit switch AND an allowed-companies list (default `none` refuses every company;
 * CORE-SWITCHON-MONEY-CAP-GUARD: the founders' company only until #737/#743 are proven on staging). The stack parameter already takes every value, so this needs no template change.
 */
export const CORE_ENGINE_BROKER_WIRED = true;

/**
 * Core switch-on blocker (2026-11-17): where the core engine's model calls go on an AWS install, as stack parameters of their own, so `agentx upgrade` keeps them like the other core
 * settings (a template overlay was dropped by every upgrade). Both the broker and the dispatcher get them packed in AGENTX_SETTINGS (broker-environment.ts: a URL's slashes cannot
 * be packed, so the stack holds the gateway's HOST and the function gets `https://<host>`), and core-host/gateway-model-access.ts reads the variables. Both empty (the default):
 * nothing is built and the core refuses the switch by name, as before. The CLI (`agentx config set coreEngine.modelGatewayUrl` / `coreEngine.agentModel`) checks a value before any
 * deploy; these patterns are the stack's own last check and keep out every packing separator. A value set past the CLI (the console) that the broker still refuses, such as an explicit
 * :443 port, fails closed: the core refuses in fixed words. The lengths are what the broker's 4 KB has room for.
 */
export const CORE_MODEL_GATEWAY_URL_VARIABLE = "ROVARA_CORE_MODEL_GATEWAY_URL";
export const CORE_AGENT_MODEL_VARIABLE = "ROVARA_CORE_AGENT_MODEL";
export const CORE_MODEL_GATEWAY_HOST_PARAMETER = "CoreModelGatewayHost";
export const CORE_AGENT_MODEL_PARAMETER = "CoreAgentModel";
/** Empty, or the gateway's host: lowercase DNS labels (at least two) and an optional port. No scheme, credentials, path, query or fragment: the origin is always https. */
export const CORE_MODEL_GATEWAY_HOST_PATTERN = "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:[1-9][0-9]{0,4})?)?$";
export const CORE_MODEL_GATEWAY_HOST_MAX_LENGTH = 56;
/**
 * DEC 254f: the agent models besides Claude that Cloud's model gateway offers (Rovara's AI, through Bedrock Converse), each named exactly by the Bedrock id it calls. Pinned from
 * the gateway's offered list as deployed to staging on 2026-11-17 (ROVARA_AI_US_CONVERSE_MODELS, in its order); each passed the gateway's agent-loop test and a real tool call.
 * The core engine's agent model may be one of these or an Anthropic id; any other Bedrock id is refused (the gateway would refuse it too, after the switch was set). When Cloud's list
 * changes, this list changes with it.
 */
export const CORE_GATEWAY_CONVERSE_AGENT_MODELS: readonly string[] = Object.freeze([
  "qwen.qwen3-coder-480b-a35b-v1:0", "qwen.qwen3-coder-30b-a3b-v1:0", "qwen.qwen3-235b-a22b-2507-v1:0", "mistral.devstral-2-123b", "mistral.mistral-large-3-675b-instruct",
  "deepseek.v3-v1:0", "moonshotai.kimi-k2.5", "zai.glm-5", "zai.glm-4.7", "us.amazon.nova-2-lite-v1:0", "openai.gpt-oss-120b-1:0", "openai.gpt-oss-20b-1:0", "us.amazon.nova-pro-v1:0",
  "moonshot.kimi-k2-thinking", "minimax.minimax-m2.5", "us.moonshotai.kimi-k3", "us.moonshotai.kimi-k3.1",
]);
/** Whether `value` is exactly one of the gateway's offered Bedrock agent models (no trimming, no case folding). */
export const isGatewayConverseAgentModel = (value: string): boolean => CORE_GATEWAY_CONVERSE_AGENT_MODELS.includes(value);
const escapeForPattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/**
 * Empty, an Anthropic model id (`claude-...`, as the gateway's agent route names it; not a Bedrock `us.anthropic....` id), or exactly one of CORE_GATEWAY_CONVERSE_AGENT_MODELS
 * (each escaped: no wildcard, so no packing separator can pass).
 */
export const CORE_AGENT_MODEL_PATTERN = `^(claude-[a-z0-9][a-z0-9.-]{0,31}|${CORE_GATEWAY_CONVERSE_AGENT_MODELS.map(escapeForPattern).join("|")})?$`;
export const CORE_AGENT_MODEL_MAX_LENGTH = 40;

/** The core's most dispatch attempts for one message (DISPATCH_ATTEMPTS_MAX in core/task-flow/dispatch.ts). The queue's redrive limit must be above it, or SQS dead-letters a message the core still retries. */
export const CORE_DISPATCH_ATTEMPTS_MAX = 20;
/** The core dispatch queue's redrive limit: above the core's own retry budget. */
export const CORE_DISPATCH_MAX_RECEIVES = CORE_DISPATCH_ATTEMPTS_MAX + 1;

/** The core's dispatch queue and its dead letters, by fixed per-environment names (named environments only). */
export const coreDispatchQueueName = (env: string): string => `agentx-${env}-core-dispatch`;
export const coreDispatchDeadLetterName = (env: string): string => `agentx-${env}-core-dispatch-dead`;

/**
 * Engine host step 4: the dispatcher is the core dispatch queue's consumer (its own event source mapping, apart from the spec 056 DispatchQueue's). The CDK app sets these on the dispatcher
 * (named environments only); the dispatcher's core router (packages/broker/src/aws/worker-machines/dispatcher-core.ts) reads them. Absent (the legacy template): the router is not installed.
 */
export const CORE_DISPATCH_QUEUE_ARN_VARIABLE = "CORE_DISPATCH_QUEUE_ARN";
export const CORE_DISPATCH_QUEUE_URL_VARIABLE = "CORE_DISPATCH_QUEUE_URL";
export const CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE = "CORE_DISPATCH_DEAD_LETTER_URL";
/** One core record per dispatcher invocation, so a slow EC2 start of one message never runs another past the function's timeout. */
export const CORE_DISPATCH_BATCH_SIZE = 1;
