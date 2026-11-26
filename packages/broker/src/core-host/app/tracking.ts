// The merge tracking service's names that other modules read through this file (`services/merge-tracking.ts` is the host-neutral service), and the milestone hook over a store.
// The laptop's own composition of the service (`createLocalTracking`, polled by `rovara up`) was removed with local mode (issue #1538).
import { createMilestoneService } from "../../services/merge-tracking.js";

export {
  CLOSED_OUTSIDE, MERGED_OUTSIDE, SWEEP_MAX_MS, SWEEP_MAX_REQUESTS, SWEEP_MAX_ROWS, TRACKING_FAILURE_MAX_MS, TRACKING_POLL_MS, TRACKING_QUIET_MAX_MS, createReadBudget, createRepositoryResolver, sessionTimeline,
} from "../../services/merge-tracking.js";

/** The milestone hook: the service's, over a store. */
export const createLocalMilestones = createMilestoneService;
