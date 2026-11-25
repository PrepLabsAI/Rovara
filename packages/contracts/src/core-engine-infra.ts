import { GatewayModelIdentitySchema } from "./gateway-model-identity.js";
/**
 * Engine host (migration plan v3.2 lane E2): the deployment half of the core engine, as plain data for the CDK app (infra/lib/core-engine.ts), the CLI and the broker. The app cannot read the
 * broker's job table (packages/broker/src/core-host/jobs.ts), so the schedules are listed here and tests/contract/core-engine-infrastructure.test.ts holds the two equal.
 */

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
  // L4-P1 (owner DEC 254zzl): the upkeep night, hourly (core-host/jobs.ts). ENABLED only while the `CoreSystemRuns` flag is not off (infra/lib/core-engine.ts): merging this changes nothing until an operator turns it on.
  { job: "upkeep-night", rate: "rate(1 hour)" },
];

/**
 * Core run stop relay (lane CORE-RUN-STOP-RELAY, G1): the variable the infrastructure sets to `on` where the core's outbox stream relay is deployed (the State table's stream reader, the developer
 * task notifier, invokes the core broker with each outbox insert: infra/lib/developer-task-notifier.ts; the broker relays it: aws/core-outbox-stream.ts; the 1-minute `outbox-relay-backstop` schedule
 * is the fallback). The core's hosted admission declares `enforcesCost: true` (so work with no one present may start) only where it reads exactly `on` (core-host/hosted-modules.ts `runStopWiredFrom`).
 * Packed for the broker and the dispatcher as the setting `coreOutboxStreamRelay` (broker-environment.ts), a constant: the relay is part of the same template, never an operator choice.
 */
export const CORE_OUTBOX_STREAM_RELAY_VARIABLE = "ROVARA_CORE_OUTBOX_STREAM_RELAY";
export const CORE_OUTBOX_STREAM_RELAY_ON = "on";

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
 * DEC 254g: the core engine's agent model is ANY model the model gateway offers (an Anthropic engine name for Claude, or a Bedrock id for every other model), not a list Code holds.
 * The gateway is the authority: `agentx config set coreEngine.agentModel` checks a non-Claude id against the gateway's LIVE offered-models answer before any deploy, and at run time the
 * gateway refuses an id it does not offer (the step then fails as "model not offered"). This pattern is only the stack's own last check of a WELL-FORMED id: lowercase letters, digits
 * and `. _ : -`, starting with a letter or digit; OpenRouter also uses exactly one slash in `vendor/model`. No URL, ARN, `@`, space, quote, comma or `=` (so no
 * credentials and no packing separator).
 */
export const CORE_AGENT_MODEL_PATTERN = "^([a-z0-9][a-z0-9._:-]{0,63}|[a-z0-9][a-z0-9._-]{0,62}/[a-z0-9][a-z0-9._-]{0,62})?$";
export const CORE_AGENT_MODEL_MAX_LENGTH = 127;
/** A Claude model keeps its own rule: exactly its Anthropic engine name (`claude-...`, as the gateway's agent route names it), never a Bedrock `us.anthropic....` id. */
export const CORE_CLAUDE_AGENT_MODEL = /^claude-[a-z0-9][a-z0-9.-]{0,31}$/u;
/**
 * Whether `value` is a well-formed core agent model id (DEC 254g): the stack pattern, not empty, and, when it names Claude or Anthropic at all, exactly a Claude engine name. No trimming
 * or case folding. Whether the gateway OFFERS it is the gateway's to say (config set asks it live; the gateway refuses at run time).
 */
export function isCoreAgentModelId(value: string): boolean {
  if (typeof value !== "string" || value === "" || value.length > CORE_AGENT_MODEL_MAX_LENGTH || !new RegExp(CORE_AGENT_MODEL_PATTERN, "u").test(value)) return false;
  if (value.includes("/")) return GatewayModelIdentitySchema.shape.modelId.safeParse(value).success;
  return /claude|anthropic/u.test(value) ? CORE_CLAUDE_AGENT_MODEL.test(value) : true;
}
/**
 * DEC 254n(1), 243c (live switches check 2026-11-18): the per-company agent model CHOICE (setup's "AI and spending" model picker). The broker reads ROVARA_CORE_AGENT_MODEL_CHOICE and offers the
 * choice only where it is exactly `on` (core-host/offered-models-http.ts); nothing in infra set it, so no hosted install could turn it on (the runbook's template overlay was dropped by every
 * upgrade). It is now the stack parameter `CoreAgentModelChoice` (`off`, the default, or `on`), packed for the BROKER only (`mx`; the dispatcher reads no choice setting), kept across upgrades
 * and set with `agentx config set coreEngine.agentModelChoice on`. Default off: DEC 254n(1) does not say default on, and the runbook keeps it off until the offered-models route is qualified.
 */
export const CORE_AGENT_MODEL_CHOICE_VARIABLE = "ROVARA_CORE_AGENT_MODEL_CHOICE";
export const CORE_AGENT_MODEL_CHOICE_PARAMETER = "CoreAgentModelChoice";
export const CORE_AGENT_MODEL_CHOICE_VALUES = ["off", "on"] as const;
export const CORE_AGENT_MODEL_CHOICE_DEFAULT = "off";
/**
 * DEC 254zzn(2) (lead 4, L4-AM): the hosted ANSWERS model, a stack parameter of its own (`CoreAnswersModel`, the broker's ROVARA_CORE_ANSWERS_MODEL, packed `aa`). Empty (the default) means
 * hosted answers and the hosted start-box classifier run on the install's agent model exactly as before; set, they run on this model and ONLY they do (a coding task or any other core step
 * keeps ROVARA_CORE_AGENT_MODEL). The gateway's answers purpose runs on the company's own Anthropic account, so the value is a Claude engine name (never a Bedrock `us.anthropic....` id, never a
 * non-Claude model): the pattern is the stack's own last check and keeps out every packing separator. Whether the gateway OFFERS it is the gateway's to say, as for the agent model's Claude
 * branch (the gateway refuses at run time and the answer is then "unavailable"). The length is `claude-` plus CORE_CLAUDE_AGENT_MODEL's 32 characters, which is all the broker's 4 KB needs.
 */
export const CORE_ANSWERS_MODEL_VARIABLE = "ROVARA_CORE_ANSWERS_MODEL";
export const CORE_ANSWERS_MODEL_PARAMETER = "CoreAnswersModel";
export const CORE_ANSWERS_MODEL_PATTERN = "^(claude-[a-z0-9][a-z0-9.-]{0,31})?$";
export const CORE_ANSWERS_MODEL_MAX_LENGTH = 39;
/** Whether `value` is a well-formed answers model id: a Claude engine name that is also a well-formed core agent model id. No trimming or case folding; empty is not an id (it means "use the agent model"). */
export function isCoreAnswersModelId(value: string): boolean {
  return typeof value === "string" && value.length <= CORE_ANSWERS_MODEL_MAX_LENGTH && new RegExp(CORE_ANSWERS_MODEL_PATTERN, "u").test(value) && value !== "" && isCoreAgentModelId(value);
}
/**
 * DEC 254zzz58, 254zzz63: the hosted lessons' LEARNING model, a stack parameter of its own (`CoreLearningModel`, the broker's ROVARA_CORE_LEARNING_MODEL, packed `lm`), separate from the task
 * agent model. It is the INSTALL default; a company may choose its own (contracts company-learning-model.ts), which wins for that company. Empty (the default) means
 * CORE_LEARNING_MODEL_DEFAULT (Claude Haiku 5.5); set, it is ONE Claude engine name. Only the learning calls (the reflector, the curator's judge, the outcome judge) use it (every task step keeps
 * ROVARA_CORE_AGENT_MODEL). The gateway's learning route used here is Anthropic Messages on the company's own Anthropic account, so the value is a Claude engine name, never a Bedrock id and
 * never a non-Claude model: the same rule and length as the answers model.
 */
export const CORE_LEARNING_MODEL_VARIABLE = "ROVARA_CORE_LEARNING_MODEL";
export const CORE_LEARNING_MODEL_PARAMETER = "CoreLearningModel";
export const CORE_LEARNING_MODEL_PATTERN = CORE_ANSWERS_MODEL_PATTERN;
export const CORE_LEARNING_MODEL_MAX_LENGTH = CORE_ANSWERS_MODEL_MAX_LENGTH;
/** DEC 254zzz63: the learning model when neither the company nor the install chose one: Claude Haiku 5.5, by the model gateway's own name for it. */
export const CORE_LEARNING_MODEL_DEFAULT = "claude-haiku-5-5";
/** Whether `value` is a well-formed learning model id: a Claude engine name (the answers model's rule). Empty is not an id (it means CORE_LEARNING_MODEL_DEFAULT). */
export function isCoreLearningModelId(value: string): boolean {
  return isCoreAnswersModelId(value);
}
/**
 * DEC 254g: the broker's admin read of the models the model gateway offers the caller's company (`OfferedAgentModels`), for `agentx config set coreEngine.agentModel`. Only the broker
 * may sign the gateway's service token (the task key's policy permits only its role), so the CLI asks the broker with its admin sign-in.
 */
export const CORE_OFFERED_MODELS_ADMIN_PATH = "/v1/admin/core/offered-models";

/** The core's most dispatch attempts for one message (DISPATCH_ATTEMPTS_MAX in core/task-flow/dispatch.ts). The queue's redrive limit must be above it, or SQS dead-letters a message the core still retries. */
export const CORE_DISPATCH_ATTEMPTS_MAX = 20;
/** The core dispatch queue's redrive limit: above the core's own retry budget. */
export const CORE_DISPATCH_MAX_RECEIVES = CORE_DISPATCH_ATTEMPTS_MAX + 1;

/** The core's dispatch queue and its dead letters, by fixed per-environment names (named environments only). */
export const coreDispatchQueueName = (env: string): string => `agentx-${env}-core-dispatch`;
export const coreDispatchDeadLetterName = (env: string): string => `agentx-${env}-core-dispatch-dead`;

/**
 * L4-SQS (journey audit B3c): the lessons reflection queue and its dead letters, by fixed per-environment names (named environments only), so the broker builds both URLs from AGENTX_ENV and its
 * 4 KB grows by nothing (DERIVED_BROKER_VARIABLES). The queue's visibility timeout and redrive limit are the core's own constants (LESSONS_REFLECT_VISIBILITY_SECONDS, LESSONS_REFLECT_MAX_RECEIVES).
 */
export const coreLessonsReflectQueueName = (env: string): string => `agentx-${env}-lessons-reflect`;
export const coreLessonsReflectDeadLetterName = (env: string): string => `agentx-${env}-lessons-reflect-dead`;
/** The variables the broker reads the reflection queue's URLs as (derived; the dispatcher is given neither: it neither sends to nor reads this queue). */
export const CORE_LESSONS_REFLECT_QUEUE_URL_VARIABLE = "CORE_LESSONS_REFLECT_QUEUE_URL";
export const CORE_LESSONS_REFLECT_DEAD_LETTER_URL_VARIABLE = "CORE_LESSONS_REFLECT_DEAD_LETTER_URL";

/**
 * Web task channel C8 (option b, DEC 254zm(3)): the attention email's own small sender function, by a fixed per-environment name, so the broker builds it from AGENTX_ENV and its 4 KB grows by nothing.
 * The function exists only while the `CoreAttentionEmail` stack parameter is `on` (infra/lib/attention-email.ts); the broker invokes it by its function policy, never by a grant on the broker's role.
 */
export const coreAttentionEmailFunctionName = (env: string): string => `agentx-${env}-attention-email`;
/** The variable the broker reads the sender function's name as (derived, DERIVED_BROKER_VARIABLES). */
export const ATTENTION_EMAIL_FUNCTION_VARIABLE = "ATTENTION_EMAIL_FUNCTION_NAME";

/**
 * Engine host step 4: the dispatcher is the core dispatch queue's consumer (its own event source mapping, apart from the spec 056 DispatchQueue's). The CDK app sets these on the dispatcher
 * (named environments only); the dispatcher's core router (packages/broker/src/aws/worker-machines/dispatcher-core.ts) reads them. Absent (the legacy template): the router is not installed.
 */
export const CORE_DISPATCH_QUEUE_ARN_VARIABLE = "CORE_DISPATCH_QUEUE_ARN";
export const CORE_DISPATCH_QUEUE_URL_VARIABLE = "CORE_DISPATCH_QUEUE_URL";
export const CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE = "CORE_DISPATCH_DEAD_LETTER_URL";
/** One core record per dispatcher invocation, so a slow EC2 start of one message never runs another past the function's timeout. */
export const CORE_DISPATCH_BATCH_SIZE = 1;
