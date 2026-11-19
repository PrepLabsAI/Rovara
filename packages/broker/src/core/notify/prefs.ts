// A person's notification settings (lane P4; experience items S-11 and S-12). One row per person in the document store, on the hosted product's key (`NOTIFY_PREFS#<company>` / `DEV#<person>`), so
// neither product moves data when the other reads it. The row holds:
//
//   targets / muted       Code's places to be told (a conversation on a channel an adapter serves) and the mute (lane L6b).
//   channel               WHERE: the hosted product's stored choice, with its stored words. `slack` means "chat" (the channel adapters), `email` the email port, `both` both. Absent: the default, chat when the
//                         person can be reached in a chat, else email (`defaultNotifyChannel`). Email is used only when the email port says it can send (`capabilities.available`) and the person has an address;
//                         otherwise an email choice falls back to chat (`effectiveNotify`, the hosted product's rule).
//   emailUnsubscribed     The email's own unsubscribe (the hosted product's key): email stops, the choice stays.
//   quietHours / timeZone Personal quiet hours (`HH:MM` to `HH:MM`, may cross midnight) in the person's time zone (an IANA name; UTC when absent). What is not urgent waits until they end, then goes in one batch.
//   digestAt              A daily digest at this local time: what is not urgent waits for it and goes as one message. Absent: the normal batching (`NOTIFY_BATCH_MINUTES`).
//
// Every attribute is written only when it is part of the change, so a write by one product never clears what the other set.
import { z } from "zod";
import { ConversationRefSchema, NOTIFY_CHANNELS, change, conversationSubject, type DocumentStore, type NotifyChannel, type OrgId, type UpdateOp } from "@agentx/contracts";

export const NOTIFY_TARGETS_MAX = 5;

export const prefsKey = (orgId: string, developerId: string) => ({ pk: `NOTIFY_PREFS#${orgId}`, sk: `DEV#${developerId}` });

/** Where a person is told: a conversation on a channel an adapter serves. */
export const NotifyTargetSchema = z.object({ channel: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/u), conversation: ConversationRefSchema }).strict()
  .refine((target) => target.conversation.channel === target.channel, { message: "the conversation is on another channel", path: ["conversation"] });
export type NotifyTarget = z.infer<typeof NotifyTargetSchema>;

/** A local time of day, `HH:MM` on a 24-hour clock. */
export const ClockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
/** Quiet hours: from `start` to `end`, local time; an `end` before the `start` crosses midnight. A zero-length span is refused (it would mean nothing, or everything). */
export const QuietHoursSchema = z.object({ start: ClockTimeSchema, end: ClockTimeSchema }).strict().refine((span) => span.start !== span.end, { message: "quiet hours must not start and end at the same time" });
export type QuietHours = z.infer<typeof QuietHoursSchema>;

/** Whether the runtime knows the time zone (an IANA name such as `Europe/Berlin`). */
export function isTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/u.test(value)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}
export const TimeZoneSchema = z.string().refine(isTimeZone, { message: "not a time zone this install knows" });

/**
 * A change to the settings. A field that is absent is left as it is; `null` clears a setting (back to its default). `targets` replaces the whole list.
 */
export const NotifyPrefsBodySchema = z.object({
  targets: z.array(NotifyTargetSchema).max(NOTIFY_TARGETS_MAX).optional(),
  muted: z.boolean().optional(),
  channel: z.enum(NOTIFY_CHANNELS).nullable().optional(),
  emailUnsubscribed: z.boolean().optional(),
  quietHours: QuietHoursSchema.nullable().optional(),
  timeZone: TimeZoneSchema.nullable().optional(),
  digestAt: ClockTimeSchema.nullable().optional(),
}).strict();
export type NotifyPrefsBody = z.infer<typeof NotifyPrefsBodySchema>;

export interface NotifyPrefs {
  targets: NotifyTarget[];
  muted: boolean;
  /** The stored choice; undefined is the default (`defaultNotifyChannel`). */
  channel?: NotifyChannel | undefined;
  emailUnsubscribed: boolean;
  quietHours?: QuietHours | undefined;
  /** An IANA name; undefined reads as UTC. */
  timeZone?: string | undefined;
  digestAt?: string | undefined;
}

export const notifyTargetKey = (target: NotifyTarget): string => `${target.channel}:${conversationSubject(target.conversation)}`;

/** The settings as stored. A row of another company, or a field that does not parse, reads as the default for that field (never as an error: a bad row must not stop anyone being told). */
export async function readNotifyPrefs(store: Pick<DocumentStore, "get">, orgId: string, developerId: string): Promise<NotifyPrefs> {
  const item = await store.get(prefsKey(orgId, developerId));
  if (item === undefined || item["orgId"] !== orgId) return { targets: [], muted: false, emailUnsubscribed: false };
  const targets = z.array(NotifyTargetSchema).max(NOTIFY_TARGETS_MAX).safeParse(item["targets"] ?? []);
  const channel = z.enum(NOTIFY_CHANNELS).safeParse(item["channel"]);
  const quiet = QuietHoursSchema.safeParse(item["quietHours"]);
  const zone = typeof item["timeZone"] === "string" && isTimeZone(item["timeZone"]) ? item["timeZone"] : undefined;
  const digestAt = ClockTimeSchema.safeParse(item["digestAt"]);
  return {
    targets: targets.success ? targets.data : [], muted: item["muted"] === true, emailUnsubscribed: item["emailUnsubscribed"] === true,
    ...(channel.success ? { channel: channel.data } : {}), ...(quiet.success ? { quietHours: quiet.data } : {}), ...(zone === undefined ? {} : { timeZone: zone }), ...(digestAt.success ? { digestAt: digestAt.data } : {}),
  };
}

/**
 * Changes a person's settings. Only the fields in the body are written; `null` removes one. Choosing email (or both) again turns email back on after an unsubscribe, as on the hosted account page.
 * A body the schema refuses is an error. Answers the settings as they now stand.
 */
export async function writeNotifyPrefs(deps: { store: Pick<DocumentStore, "get" | "update">; now: () => Date }, orgId: OrgId, developerId: string, body: unknown): Promise<NotifyPrefs> {
  const parsed = NotifyPrefsBodySchema.parse(body);
  const ops: UpdateOp[] = [change.setIfAbsent("entityType", "NOTIFY_PREFS"), change.set("orgId", orgId), change.set("developerId", developerId), change.set("updatedAt", deps.now().toISOString())];
  if (parsed.targets !== undefined) {
    const unique = [...new Map(parsed.targets.map((target) => [notifyTargetKey(target), target] as const)).values()];
    ops.push(change.set("targets", JSON.parse(JSON.stringify(unique)) as never));
  }
  if (parsed.muted !== undefined) ops.push(change.set("muted", parsed.muted));
  const setOrRemove = (name: string, value: unknown): void => {
    if (value === undefined) return;
    ops.push(value === null ? change.remove(name) : change.set(name, JSON.parse(JSON.stringify(value)) as never));
  };
  setOrRemove("channel", parsed.channel);
  setOrRemove("quietHours", parsed.quietHours);
  setOrRemove("timeZone", parsed.timeZone);
  setOrRemove("digestAt", parsed.digestAt);
  const emailBack = parsed.channel === "email" || parsed.channel === "both";
  if (parsed.emailUnsubscribed === true && !emailBack) ops.push(change.set("emailUnsubscribed", true));
  else if (parsed.emailUnsubscribed === false || emailBack) ops.push(change.remove("emailUnsubscribed"));
  await deps.store.update({ key: prefsKey(orgId, developerId), ops });
  return readNotifyPrefs(deps.store, orgId, developerId);
}
