// Spec 062 FR-040: the texts the processor posts in a Slack thread, as constants. Each is the core text function
// with SLACK_FORMAT, so Slack's words are pinned while the core stays surface-neutral.
import { yesToAllText } from "./confirmations.js";
import { newWorkspaceMessage, preparationSlowMessage, stillPreparingMessage, workspaceUnconfirmedMessage } from "./messages.js";
import { SLACK_FORMAT } from "./slack-format.js";

export const NEW_WORKSPACE_MESSAGE = newWorkspaceMessage(SLACK_FORMAT);
export const STILL_PREPARING_MESSAGE = stillPreparingMessage(SLACK_FORMAT);
export const PREPARATION_SLOW_MESSAGE = preparationSlowMessage(SLACK_FORMAT);
export const WORKSPACE_UNCONFIRMED_MESSAGE = workspaceUnconfirmedMessage(SLACK_FORMAT);
export const YES_TO_ALL_TEXT = yesToAllText(SLACK_FORMAT);
