// Spec 062 Phase 7c2: the channel API's Lambda: the neutral channel ingress, with the built-in Slack adapter's router
// (Phase 7c2) and press handlers (Phase 7c3) when the deployment routes Slack through the channel API.
import { channelApiHandler } from "./channel-ingress.js";
import { createAwsSlackChannelPresses } from "./slack-channel-presses.js";
import { createAwsSlackChannelRouter } from "./slack-channel-router.js";

const slackOn = () => process.env.BUILT_IN_ADAPTER === "enabled";

export const handler = channelApiHandler(
  () => (slackOn() ? { slack: createAwsSlackChannelRouter() } : {}),
  () => (slackOn() ? { slack: createAwsSlackChannelPresses() } : {}),
);
