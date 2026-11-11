export { SLACK_CAPABILITIES, SlackChannel, type SlackChannelOptions } from "./adapter.js";
export { slackChannelPlugin, SLACK_CHANNEL_NAME, type SlackChannelPluginOptions } from "./plugin.js";
export { NO_THREAD, escapeText, renderEvent } from "./format.js";
export { decisionOf, messageOf, textOf } from "./events.js";
export { SlackApiError, slackWeb, type SlackWeb } from "./web.js";
export { SOCKET_QUEUE_MAX, startSocket, type SocketFactory, type SocketLike } from "./socket.js";
