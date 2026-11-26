// Spec 062 Phase 5b: the control-plane routes only a Slack thread uses. The conversation-level client is thread-api.ts.
import {
  SLACK_ANSWER_SERVICE_PATH,
  SlackAnswerAskSchema,
  SlackAnswerResultSchema,
  type SlackAnswerAsk,
  type SlackAnswerResult,
} from "@agentx/contracts";
import type { ThreadServiceApi } from "./processor.js";
import { serviceRequestWith } from "./thread-api.js";

/** A Slack thread's service API: the conversation's, with the Slack-only answer route. */
export interface SlackThreadServiceApi extends ThreadServiceApi {
  /** Lead 4 J2: the smart Just answer for this Slack thread and member (`POST /v1/service/answers`); the control plane decides who may ask and which project. Absent where the control plane has no such route. */
  askAnswer?(input: SlackAnswerAsk): Promise<SlackAnswerResult>;
}

/** Adds the Slack thread's own routes to a conversation client. */
export function withSlackThreadRoutes(base: ThreadServiceApi, options: { controlPlaneUrl: string; signedFetch: typeof fetch }): SlackThreadServiceApi {
  const request = (method: string, path: string, body: unknown, failure: string) => serviceRequestWith(options.signedFetch, `${options.controlPlaneUrl}${path}`, method, body, failure);
  return {
    ...base,
    async askAnswer(input) {
      const body = SlackAnswerAskSchema.parse(input);
      try {
        return SlackAnswerResultSchema.parse(await request("POST", SLACK_ANSWER_SERVICE_PATH, body, "answer request failed"));
      } catch (error) {
        // A control plane that does not serve answers for this thread (no such route, an unlinked account, an unbound channel) is a decline: the request goes the way it always did.
        if (error instanceof Error && /: (?:FORBIDDEN|NOT_FOUND)\b/u.test(error.message)) return { status: "declined", reason: "not_available" };
        throw error;
      }
    },
  };
}
