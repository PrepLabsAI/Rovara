import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ChannelEventSchema, RegisteredChannelIdSchema, publicHttpsUrlProblem, steppedUpNote, usableWebhookSecret, webhookHeaders, type ChannelAdapterRecord, type ChannelEvent, type MessagePart } from "@agentx/contracts";
import { checkEndpointAddresses, EndpointRefused } from "@agentx/gateway";
import { adapterForChannel, builtInAdapterFromEnvironment } from "./channel-adapters.js";

/**
 * Spec 062 FR-022, FR-023: delivers queued events to each adapter's callback URL, signed with its secret. At least
 * once: the event's `id` is the `webhook-id` and is stable across retries, so the adapter drops a repeat. A failure
 * that may pass (a timeout, 408, 429, 5xx, an unreadable secret) is retried with a growing delay and then
 * dead-lettered by the queue; one that will not (a refused URL, another 4xx, a redirect, an adapter since removed)
 * is dropped and logged.
 *
 * The queue is FIFO, one group per conversation, so events arrive in the order they were sent. Once an event in a
 * group is to be retried, the batch's later events in that group are retried with it, never delivered ahead of it.
 */

const SEND_TIMEOUT_MS = 10_000;
const MAX_DELAY_SECONDS = 900;

export interface ChannelEventSenderDependencies {
  getAdapter(channel: string): Promise<ChannelAdapterRecord | undefined>;
  getSecret(secretName: string): Promise<string | undefined>;
  fetch: typeof fetch;
  /** Throws EndpointRefused when the callback host resolves to a non-public address. */
  checkAddresses(url: URL): Promise<void>;
  /** Delays a retried message's next attempt. */
  delay?(receiptHandle: string, seconds: number): Promise<void>;
  now(): number;
  log?(entry: Record<string, unknown>): void;
}

export interface SqsRecord { messageId: string; body: string; receiptHandle?: string; attributes?: { ApproximateReceiveCount?: string; MessageGroupId?: string } }

type Outcome = "delivered" | "dropped" | "retry";

/** FR-023 at the last step: text cut to the adapter's limit, and no actions on a kind the adapter steps up. */
export function fitEventToAdapter(event: ChannelEvent, adapter: Pick<ChannelAdapterRecord, "capabilities" | "stepUp">): ChannelEvent {
  const limit = adapter.capabilities.maxTextLength;
  const cut = (text: string, max = limit) => (text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`);
  if (event.type === "approval_request") {
    const { actions, ...rest } = event.data;
    const steppedUp = event.data.kind !== "other" && adapter.stepUp.includes(event.data.kind);
    // The note is added after the cut, so a long text never cuts it off.
    const note = steppedUpNote(rest.taskUrl);
    const link = steppedUp && actions !== undefined && !rest.text.includes(note) ? `\n\n${note}` : "";
    // An adapter with fewer buttons than actions gets none; the text says how to reply.
    const keep = !steppedUp && actions !== undefined && actions.length <= adapter.capabilities.buttons;
    return { ...event, data: { ...rest, text: `${cut(rest.text, limit - link.length)}${link}`, ...(keep ? { actions } : {}) } };
  }
  if (event.type === "message" || event.type === "direct") {
    const { actions, parts, ...rest } = event.data;
    const fittedParts = fitActionParts(parts, adapter.capabilities);
    const fitted: ChannelEvent = { ...event, data: { ...rest, text: cut(rest.text), ...(fittedParts === undefined ? {} : { parts: fittedParts }), ...fitActions(actions, adapter.capabilities) } };
    return fitted;
  }
  if ("text" in event.data && typeof event.data.text === "string") return { ...event, data: { ...event.data, text: cut(event.data.text) } } as ChannelEvent;
  return event;
}

/**
 * FR-070: a message's actions as the adapter can show them. Form buttons go without `forms`; and with more actions than
 * the adapter's buttons, none go, since the text stands on its own.
 */
function fitActions(actions: Extract<ChannelEvent, { type: "message" }>["data"]["actions"], capabilities: ChannelAdapterRecord["capabilities"]): { actions?: NonNullable<typeof actions> } {
  if (actions === undefined) return {};
  const shown = capabilities.forms === true ? actions : actions.filter((action) => action.type !== "form");
  return shown.length === 0 || shown.length > capabilities.buttons ? {} : { actions: shown };
}

/** Phase 7c: an `actions` part as the adapter can show it, by the same rule; one with nothing left goes. */
function fitActionParts(parts: Extract<ChannelEvent, { type: "message" }>["data"]["parts"], capabilities: ChannelAdapterRecord["capabilities"]): typeof parts {
  if (parts === undefined) return undefined;
  const fitted = parts.flatMap((part): MessagePart[] => {
    if (part.type !== "actions") return [part];
    const kept = fitActions(part.actions, capabilities).actions;
    return kept === undefined ? [] : [{ ...part, actions: kept }];
  });
  return fitted.length === 0 ? undefined : fitted;
}

/**
 * FR-070: why an event cannot go to this adapter at all. A private or direct message to an adapter that cannot keep it
 * private is dropped, never shown to the whole conversation.
 */
export function unsendableReason(event: ChannelEvent, adapter: Pick<ChannelAdapterRecord, "capabilities">): string | undefined {
  if (event.type === "direct" && adapter.capabilities.direct !== true) return "direct_unsupported";
  if (event.type === "message" && event.data.audience?.kind === "ephemeral" && adapter.capabilities.ephemeral !== true) return "ephemeral_unsupported";
  // code/next's one-person progress note (a one-use link code) is the same: never posted for everyone.
  if (event.type === "progress" && event.data.onlyTo !== undefined && adapter.capabilities.ephemeral !== true) return "ephemeral_unsupported";
  return undefined;
}

export function createChannelEventSender(deps: ChannelEventSenderDependencies) {
  const log = (entry: Record<string, unknown>) => (deps.log === undefined ? console.log(JSON.stringify({ component: "channel-events", ...entry })) : deps.log(entry));

  async function deliver(record: SqsRecord): Promise<Outcome> {
    let event: ChannelEvent;
    try {
      const parsed = ChannelEventSchema.safeParse(JSON.parse(record.body));
      // An event labelled `slack` reaches only the deployment's built-in adapter (FR-073); with none configured, `getAdapter` finds no registered adapter for that id and it is dropped below.
      if (!parsed.success) { log({ event: "dropped", reason: "invalid_event" }); return "dropped"; }
      event = parsed.data;
    } catch {
      log({ event: "dropped", reason: "invalid_json" });
      return "dropped";
    }
    const adapter = await deps.getAdapter(event.channel);
    if (adapter === undefined) { log({ event: "dropped", reason: "adapter_removed", channel: event.channel, eventId: event.id }); return "dropped"; }
    // The hosted product serves `slack` on its own path: only the deployment's built-in adapter (FR-073) may take an event with that id, never a registered webhook adapter's record, however one was found.
    if (!RegisteredChannelIdSchema.safeParse(event.channel).success && adapter.builtIn !== true) { log({ event: "dropped", reason: "invalid_event" }); return "dropped"; }
    const problem = publicHttpsUrlProblem(adapter.callbackUrl, "callbackUrl");
    if (problem !== undefined) { log({ event: "dropped", reason: "callback_refused", channel: event.channel, eventId: event.id }); return "dropped"; }
    const url = new URL(adapter.callbackUrl);
    try {
      await deps.checkAddresses(url);
    } catch (error) {
      if (error instanceof EndpointRefused) { log({ event: "dropped", reason: "callback_not_public", channel: event.channel, eventId: event.id }); return "dropped"; }
      log({ event: "retry", reason: "callback_unresolved", channel: event.channel, eventId: event.id });
      return "retry";
    }
    const secret = await deps.getSecret(adapter.secretName);
    if (secret === undefined) { log({ event: "retry", reason: "secret_unavailable", channel: event.channel, eventId: event.id }); return "retry"; }

    const unsendable = unsendableReason(event, adapter);
    if (unsendable !== undefined) { log({ event: "dropped", reason: unsendable, channel: event.channel, eventId: event.id }); return "dropped"; }
    const body = JSON.stringify(fitEventToAdapter(event, adapter));
    const headers = { "content-type": "application/json", ...webhookHeaders({ secret, id: event.id, timestamp: Math.floor(deps.now() / 1000), body }) };
    let status: number;
    try {
      const response = await deps.fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      status = response.status;
    } catch (error) {
      log({ event: "retry", reason: "send_failed", channel: event.channel, eventId: event.id, errorName: error instanceof Error ? error.name : "UnknownError" });
      return "retry";
    }
    if (status >= 200 && status < 300) { log({ event: "delivered", channel: event.channel, eventId: event.id, type: event.type }); return "delivered"; }
    if (status === 408 || status === 429 || status >= 500) { log({ event: "retry", reason: "status", status, channel: event.channel, eventId: event.id }); return "retry"; }
    log({ event: "dropped", reason: "status", status, channel: event.channel, eventId: event.id });
    return "dropped";
  }

  return async (event: { Records?: SqsRecord[] }): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
    const failures: Array<{ itemIdentifier: string }> = [];
    const heldGroups = new Set<string>();
    for (const record of event.Records ?? []) {
      const group = record.attributes?.MessageGroupId;
      if (group !== undefined && heldGroups.has(group)) {
        // Behind an event that is being retried: it waits, so the conversation stays in order.
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }
      let outcome: Outcome;
      try { outcome = await deliver(record); } catch (error) {
        log({ event: "retry", reason: "unexpected", errorName: error instanceof Error ? error.name : "UnknownError" });
        outcome = "retry";
      }
      if (outcome !== "retry") continue;
      if (group !== undefined) heldGroups.add(group);
      failures.push({ itemIdentifier: record.messageId });
      const receives = Number(record.attributes?.ApproximateReceiveCount ?? "1");
      if (deps.delay !== undefined && record.receiptHandle !== undefined) {
        const seconds = Math.min(MAX_DELAY_SECONDS, 10 * 2 ** Math.max(0, receives - 1));
        try { await deps.delay(record.receiptHandle, seconds); } catch { log({ event: "delay_failed" }); }
      }
    }
    return { batchItemFailures: failures };
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function createAwsChannelEventSender() {
  const clientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfiguration));
  const secretsManager = new SecretsManagerClient(clientConfiguration);
  const sqs = new SQSClient(clientConfiguration);
  const tableName = requiredEnvironment("STATE_TABLE_NAME");
  const queueUrl = requiredEnvironment("CHANNEL_EVENT_QUEUE_URL");
  const builtIn = builtInAdapterFromEnvironment(process.env);
  const registry = process.env.CHANNEL_ADAPTERS === "enabled";
  return createChannelEventSender({
    getAdapter: (channel) => adapterForChannel({ documentClient, tableName }, channel, { builtIn, registry }),
    async getSecret(secretName) {
      try {
        const value = (await secretsManager.send(new GetSecretValueCommand({ SecretId: secretName }))).SecretString;
        return usableWebhookSecret(value);
      } catch {
        return undefined;
      }
    },
    fetch,
    checkAddresses: (url) => checkEndpointAddresses(url),
    async delay(receiptHandle, seconds) {
      await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }));
    },
    now: Date.now,
  });
}

let awsSender: ReturnType<typeof createChannelEventSender> | undefined;

export const handler = (event: { Records?: SqsRecord[] }) => {
  awsSender ??= createAwsChannelEventSender();
  return awsSender(event);
};
