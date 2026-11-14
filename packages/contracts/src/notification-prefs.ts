// UX2 slice 2 item 5 (OWNER DECISION 4): how each person hears that a task needs them (a decision waiting, blocked, paused for budget, ready to merge, failed, done for a follower), whether the task was
// started in Slack or on the web. Each person picks Slack direct messages, email or both on their account page (`GET`/`PUT /v1/app/me/notifications`); the default is Slack when their Slack is linked,
// else email. Email is sent only through the install's existing sign-in notice sender; where none is configured the email choice is offered as unavailable.
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

export const NOTIFY_CHANNELS = ["slack", "email", "both"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/** At most one message per person per channel in this many minutes: what happens in between is batched into the next one, so a busy task never floods anyone. */
export const NOTIFY_BATCH_MINUTES = 15;
/** The most tasks one message lists; more are counted ("and 3 more"). */
export const NOTIFY_ITEMS_MAX = 10;
/** The account page's address for the setting (the "change how I'm notified" link). */
export const NOTIFY_SETTINGS_PATH = "/app/account#notifications";
/** What the setting says when the install has no email sender. */
export const NOTIFY_EMAIL_UNAVAILABLE = "Email isn't set up here; we'll use Slack.";

/** `PUT /v1/app/me/notifications`. Choosing email (or both) again turns email back on after an unsubscribe. `emailUnsubscribed: true` is the email's unsubscribe. */
export const NotificationPrefsBodySchema = z.union([
  z.object({ channel: z.enum(NOTIFY_CHANNELS) }).strict(),
  z.object({ emailUnsubscribed: z.literal(true) }).strict(),
]);
export type NotificationPrefsBody = z.infer<typeof NotificationPrefsBodySchema>;

/**
 * What the person's setting is and what it means now: `channel` is what they chose (or the default when `chosen` is false); `slackLinked` and `emailAvailable` (the install has an email sender and the
 * person has an address) say whether each channel can reach them; `emailUnsubscribed` is set by the email's unsubscribe link; `effective` is where messages actually go.
 */
export const NotificationPrefsViewSchema = z.object({
  channel: z.enum(NOTIFY_CHANNELS),
  chosen: z.boolean(),
  slackLinked: z.boolean(),
  emailAvailable: z.boolean(),
  emailUnsubscribed: z.boolean(),
  effective: z.object({ slack: z.boolean(), email: z.boolean() }).strict(),
}).strict();
export type NotificationPrefsView = z.infer<typeof NotificationPrefsViewSchema>;
export const NotificationPrefsViewReaderSchema = forwardReader(NotificationPrefsViewSchema);

/** The default channel: Slack when the person's Slack is linked, else email. */
export const defaultNotifyChannel = (slackLinked: boolean): NotifyChannel => (slackLinked ? "slack" : "email");

/** Where messages go for a setting: the chosen channels that can reach the person. When email is chosen but can't be sent (no sender here, or the person unsubscribed), Slack is used if linked ("we'll use Slack"). */
export function effectiveNotify(input: { channel: NotifyChannel; slackLinked: boolean; emailAvailable: boolean; emailUnsubscribed: boolean }): { slack: boolean; email: boolean } {
  const email = (input.channel === "email" || input.channel === "both") && input.emailAvailable && !input.emailUnsubscribed;
  const slackChosen = input.channel === "slack" || input.channel === "both" || (input.channel === "email" && (!input.emailAvailable || input.emailUnsubscribed));
  return { slack: slackChosen && input.slackLinked, email };
}
