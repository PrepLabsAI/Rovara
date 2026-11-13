// The host-neutral service layer. Each service is a factory that takes the core's ports (the document store, the queue, the channel and email points, the approvers, the audit sink, the metering, the code hosts by
// the registry) and options, and returns the service. A host composes the same services over its own adapters; the rules that differ by host (who a person is on the code host, the project's code settings, the words
// of a notice, who decides as the owner) are options the host passes, never defaults hidden in the service. The local app (`local/app`) composes from this layer with its laptop rules.
//
//   merge tracking  `createMergeTrackingService`: reads the pull requests of tasks waiting for their merge, on a sweep or a wake, and records a merge once.
//   sessions        `createSessionService`: the projector over the store's change feed, the sweep and the refresh of a session's summary.
//   notices         `createNoticeService`: queue what needs a person and deliver it, batched, through the channel and email points.
//   decisions       `createDecisionService`: the one approval gate over the workflow document, and the actions the surfaces call.
//   callbacks       `createCallbackService`: the endpoints a worker posts to (events, artifacts, the result, the pull request).
export {
  CLOSED_OUTSIDE, MERGED_OUTSIDE, SWEEP_MAX_MS, SWEEP_MAX_REQUESTS, SWEEP_MAX_ROWS, TRACKING_FAILURE_MAX_MS, TRACKING_POLL_MS, TRACKING_QUIET_MAX_MS,
  createMergeTrackingService, createMilestoneService, createReadBudget, createRepositoryResolver, sessionTimeline,
  type MergeTrackingService, type MergeTrackingServiceOptions,
} from "./merge-tracking.js";
export { createSessionService, type SessionService, type SessionServiceOptions } from "./sessions.js";
export { createNoticeService, type NoticeService, type NoticeServiceOptions } from "./notices.js";
export { createDecisionService, type DecisionService, type DecisionServiceOptions } from "./decisions.js";
export { createCallbackHandler as createCallbackService, type CallbackDeps as CallbackServiceOptions } from "./callbacks.js";
