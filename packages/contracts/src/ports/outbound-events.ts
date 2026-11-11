// Port lane P6 (item R3, owner decisions 40 and 61): the `outbound-events` plug-in point. Rovara emits an event for what happens to a task, with references to its artifacts, so that a lightweight adapter
// (an internal issue tracker, a dashboard, a chat tool) can follow along WITHOUT a change to Rovara.
//
// ONE protocol, not two (decision 61): an outbound event is signed exactly like the channel events (spec 062 phase 3, `channel-adapter.ts`), with Standard Webhooks: the `webhook-id` header is the event's `id`,
// `webhook-timestamp` is in seconds, and `webhook-signature` is `v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">` made with the adapter's secret (`whsec_...`). The body is the event as JSON. An adapter that already
// verifies a channel event verifies this one with the same code. The envelope has the same `version`, `id` (`evt_...`, stable across retries, so a receiver drops a repeat) and `createdAt`.
//
// What this file holds: the event shape, the signing helpers and the adapter interface. What it does not: a sender over HTTP (an adapter, with its own address and secret rules), a retry queue, a dead-letter queue, and
// the rules for who may register one. Timers, realtime push and email notices are their own points (`scheduler`, `realtime`, `email`), not outbound events.
import { z } from "zod";
import { ChannelOpaqueIdSchema } from "../conversation.js";
import { signWebhook, verifyWebhook, webhookHeaders, channelEventId, type WebhookVerification } from "../channel-adapter.js";
import { canonicalJson } from "../canonical-json.js";
import { OpenEventTypeSchema } from "../open-ids.js";
import { CODE_MILESTONE_KINDS, type CodeMilestoneKind } from "../rovara-code.js";
import { AgentXNameSchema } from "../names.js";

export const OUTBOUND_EVENT_VERSION = 1;
/** The most JSON bytes of an event's `data`. Events carry facts and references, not documents. */
export const OUTBOUND_EVENT_DATA_MAX_BYTES = 16 * 1_024;
export const OUTBOUND_EVENT_ARTIFACTS_MAX = 50;

/** An event type: the same shape as any open event type (dotted lower-case words). Milestones are `task.<milestone>`. */
export const OutboundEventTypeSchema = OpenEventTypeSchema;

/** The event type for a task milestone (`plan_ready` is `task.plan_ready`). */
export function outboundEventTypeOfMilestone(kind: CodeMilestoneKind): string {
  return `task.${kind}`;
}
/** The event types the task milestones give, in the milestones' order. */
export const OUTBOUND_MILESTONE_EVENT_TYPES: readonly string[] = CODE_MILESTONE_KINDS.map((kind) => outboundEventTypeOfMilestone(kind));

/**
 * A reference to an artifact (a plan, a check report, review findings, a pull request), never its content. A receiver that may see it reads it from Rovara with its own access (the `url`, when there is one,
 * is a page that checks who is asking); the `digest` says which exact version the event is about.
 */
export const OutboundArtifactRefSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_.-]{0,39}$/u),
  id: z.string().min(1).max(200),
  digest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  url: z.string().max(2_048).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "an https link without credentials").optional(),
}).strict();
export type OutboundArtifactRef = z.infer<typeof OutboundArtifactRefSchema>;

const dataSize = (data: unknown): number => Buffer.byteLength(canonicalJson(data));

export const OutboundEventSchema = z.object({
  version: z.literal(OUTBOUND_EVENT_VERSION),
  /** Stable across retries, so a receiver drops a repeat (it is also the `webhook-id`). Same shape as a channel event's. */
  id: z.string().regex(/^evt_[A-Za-z0-9_-]{16,64}$/u),
  type: OutboundEventTypeSchema,
  /** The company the event is about (Code: its one implicit company). */
  company: z.string().min(1).max(128),
  project: AgentXNameSchema.optional(),
  /** What the event is about, in the sender's words: usually `{ kind: "task", id }`. */
  subject: z.object({ kind: z.string().regex(/^[a-z][a-z0-9_.-]{0,39}$/u), id: ChannelOpaqueIdSchema }).strict().optional(),
  createdAt: z.string().datetime(),
  /** Facts for the receiver, as FLAT JSON: names with a text, number, true/false or null value, no nesting. Never a secret, a token or a document. */
  data: z.record(z.string().min(1).max(100), z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).refine((data) => dataSize(data) <= OUTBOUND_EVENT_DATA_MAX_BYTES, `data is at most ${String(OUTBOUND_EVENT_DATA_MAX_BYTES)} bytes`).default({}),
  artifacts: z.array(OutboundArtifactRefSchema).max(OUTBOUND_EVENT_ARTIFACTS_MAX).default([]),
}).strict();
export type OutboundEvent = z.infer<typeof OutboundEventSchema>;
export type OutboundEventInput = z.input<typeof OutboundEventSchema>;

/** A new event id, in the shape channel events use. */
export function outboundEventId(): string {
  return channelEventId();
}

/** The signed message for an event: the exact body, and the three Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`), as for a channel event. Throws for an event that is not valid. */
export function signOutboundEvent(input: { secret: string; event: OutboundEventInput; timestamp: number }): { body: string; headers: Record<string, string> } {
  const event = OutboundEventSchema.parse(input.event);
  const body = JSON.stringify(event);
  return { body, headers: webhookHeaders({ secret: input.secret, id: event.id, timestamp: input.timestamp, body }) };
}

export type OutboundVerification = { ok: true; event: OutboundEvent } | Exclude<WebhookVerification, { ok: true }> | { ok: false; reason: "bad_event" } | { ok: false; reason: "id_mismatch" };

/** What a receiver does: checks the signature and the time, then the event, and that the `webhook-id` header is the event's `id`. The same check as for a channel event, then the event's own shape. */
export function verifyOutboundEvent(input: { secret: string; headers: Record<string, string | undefined>; body: string; nowSeconds: number; toleranceSeconds?: number }): OutboundVerification {
  const checked = verifyWebhook(input);
  if (!checked.ok) return checked;
  let json: unknown;
  try {
    json = JSON.parse(input.body);
  } catch {
    return { ok: false, reason: "bad_event" };
  }
  const parsed = OutboundEventSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "bad_event" };
  if (parsed.data.id !== checked.id) return { ok: false, reason: "id_mismatch" };
  return { ok: true, event: parsed.data };
}

/** The signature of an outbound event body, for a receiver that wants to compare it itself. The same function a channel event is signed with. */
export const signOutboundBody = signWebhook;

/** What an `outbound-events` adapter is: it sends events somewhere (a webhook, a bus, a file) and nothing else. */
export interface OutboundEventsAdapter {
  /** Which event types it wants; absent: every type. Rovara does not call `deliver` for a type it does not accept. */
  accepts?(type: string): boolean;
  /**
   * Sends one event. AT LEAST ONCE: the same `event.id` may arrive again after a failure, so a receiver (and the adapter) drops a repeat. A rejection means "not delivered; try again". The event is
   * already a valid `OutboundEvent`, built by Rovara; the adapter signs it with its own secret (`signOutboundEvent`) when it sends over HTTP.
   */
  deliver(event: OutboundEvent): Promise<void>;
}
