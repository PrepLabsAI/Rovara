// #342: what a task's thread is told when the task left its owner's ChatGPT plan for the install's
// default model. Fixed words, the owner's mention and a link; never the plan's account or a token.
import { CHATGPT_USAGE_URL } from "@agentx/contracts";

export type ChatGptFallbackReason = "limit" | "revoked" | "model";

/** The warning, addressed to the plan's owner when their Slack user is known (`slackUserId`). */
export function chatGptFallbackText(reason: ChatGptFallbackReason, slackUserId?: string): string {
  const subject = slackUserId === undefined ? "The ChatGPT plan this task ran on" : `<@${slackUserId}>, your ChatGPT plan`;
  switch (reason) {
    case "limit":
      return `${subject} reached its usage limit, so I finished this on this Rovara's default model. Tasks on that plan use the default for the next hour, then try the plan again. Usage: <${CHATGPT_USAGE_URL}|chatgpt.com/settings/usage>`;
    case "revoked":
      return `${slackUserId === undefined ? "The ChatGPT connection this task ran on" : `<@${slackUserId}>, your ChatGPT connection`} no longer works (it was revoked or expired), so I finished this on this Rovara's default model. Mention me with \`connect chatgpt\` to connect again.`;
    case "model":
      return `${subject} no longer allows the model this task was using, so I finished it on this Rovara's default model. The next task picks a model the plan allows.`;
  }
}
