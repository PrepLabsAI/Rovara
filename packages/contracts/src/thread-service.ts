// Spec 062 Phase 5b: the orchestrator service routes' messages under neutral names. They serve every conversation,
// a Slack thread's or an adapter's; the schemas are the same objects as their Slack-named originals, so the wire
// format does not change.
import {
  SlackCommentAnsweredRequestSchema,
  SlackThreadNoteAnsweredRequestSchema,
  SlackThreadNoteAnsweredResultSchema,
  SlackThreadPrepareResultSchema,
  SlackThreadWorkspaceResultSchema,
  SlackWorkspaceCloseCompleteResultSchema,
  SlackWorkspaceCloseStartResultSchema,
  SlackWorkspaceLimitSchema,
} from "./slack.js";
import type { z } from "zod";

export const WorkspaceLimitSchema = SlackWorkspaceLimitSchema;
export const ThreadWorkspaceResultSchema = SlackThreadWorkspaceResultSchema;
export const ThreadPrepareResultSchema = SlackThreadPrepareResultSchema;
export const WorkspaceCloseStartResultSchema = SlackWorkspaceCloseStartResultSchema;
export const WorkspaceCloseCompleteResultSchema = SlackWorkspaceCloseCompleteResultSchema;
export const CommentAnsweredRequestSchema = SlackCommentAnsweredRequestSchema;
export const ThreadNoteAnsweredRequestSchema = SlackThreadNoteAnsweredRequestSchema;
export const ThreadNoteAnsweredResultSchema = SlackThreadNoteAnsweredResultSchema;

export type WorkspaceLimit = z.infer<typeof WorkspaceLimitSchema>;
export type ThreadWorkspaceResult = z.infer<typeof ThreadWorkspaceResultSchema>;
export type ThreadPrepareResult = z.infer<typeof ThreadPrepareResultSchema>;
export type WorkspaceCloseStartResult = z.infer<typeof WorkspaceCloseStartResultSchema>;
export type WorkspaceCloseCompleteResult = z.infer<typeof WorkspaceCloseCompleteResultSchema>;
export type CommentAnsweredRequest = z.infer<typeof CommentAnsweredRequestSchema>;
export type ThreadNoteAnsweredRequest = z.infer<typeof ThreadNoteAnsweredRequestSchema>;
