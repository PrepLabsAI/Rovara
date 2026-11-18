// L4-U5d: the words said privately to the person who replied in a Slack thread whose task the core owns (`core-host/chat-thread-input.ts`). Fixed: nothing in them comes from the reply, the task or a model.
// Kept in a file of its own (constants only) so the ingress, which runs apart from the broker, can read them without loading it. The broker answers a CODE (`ThreadInputNotice`); the ingress maps it to these words.

/** What the broker says happened to a reply in a core task's thread, besides `captured`, `duplicate`, `refused` and `small_talk`. Only these are read; anything else is not a notice. */
export const THREAD_INPUT_NOTICES = ["answers_saved", "plan_note_saved", "note_saved", "not_allowed", "answers_unclear", "rate_limited", "not_saved"] as const;
export type ThreadInputNotice = typeof THREAD_INPUT_NOTICES[number];

export const THREAD_INPUT_WORDS: Readonly<Record<ThreadInputNotice, string>> = {
  answers_saved: "Thanks. I gave your answers to the task, and it is planning again.",
  plan_note_saved: "Saved as a note for the plan. To ask for changes to it, use Request changes on the task page.",
  note_saved: "Saved for the next step.",
  not_allowed: "Only the person who owns this task can add to it from Slack. Ask them, or open the task page.",
  answers_unclear: "This task is waiting for answers. Reply with one numbered line for each question, like `1. a` or `2. your own words`, or say `your call`. You can also answer on the task page.",
  rate_limited: "You have sent a lot of messages to this task in the last hour. Wait a little, then try again.",
  not_saved: "I couldn't save this reply for the task. It may be closed, or it already has as many replies as I keep.",
};

export const isThreadInputNotice = (value: unknown): value is ThreadInputNotice => typeof value === "string" && (THREAD_INPUT_NOTICES as readonly string[]).includes(value);
