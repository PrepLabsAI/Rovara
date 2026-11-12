// Spec 062 Phase 7c2: the channel API's Lambda: the neutral channel ingress, with the built-in Slack adapter's router
// (Phase 7c2) and press handlers (Phase 7c3) when the deployment routes Slack through the channel API. Phase 7c3b: a
// ChatGPT connection handed off by a submitted form finishes in an asynchronous invoke of this same Lambda.
import { channelApiHandler, type ChannelIngressEvent } from "./channel-ingress.js";
import { isHandedOffChatGptFinish, type HandedOffChatGptFinish } from "./slack-chatgpt.js";
import { createAwsSlackChannelPresses, createAwsSlackChatGptFinish } from "./slack-channel-presses.js";
import { createAwsSlackChannelRouter } from "./slack-channel-router.js";

const slackOn = () => process.env.BUILT_IN_ADAPTER === "enabled";

const api = channelApiHandler(
  () => (slackOn() ? { slack: createAwsSlackChannelRouter() } : {}),
  () => (slackOn() ? { slack: createAwsSlackChannelPresses() } : {}),
);
let finish: ReturnType<typeof createAwsSlackChatGptFinish> | undefined;

export const handler = async (event: ChannelIngressEvent | HandedOffChatGptFinish) => {
  if (isHandedOffChatGptFinish(event)) {
    if (!slackOn()) throw new Error("Slack does not go through the channel API here");
    finish ??= createAwsSlackChatGptFinish();
    return { outcome: await finish(event) };
  }
  return api(event);
};
