// Spec 062 Phase 7c2: the channel API's Lambda: the neutral channel ingress, with the built-in Slack adapter's router
// when the deployment routes Slack through the channel API.
import { channelApiHandler } from "./channel-ingress.js";
import { createAwsSlackChannelRouter } from "./slack-channel-router.js";

export const handler = channelApiHandler(() => (process.env.BUILT_IN_ADAPTER === "enabled" ? { slack: createAwsSlackChannelRouter() } : {}));
