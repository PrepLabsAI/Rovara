// Spec 062 Phase 5b: the control-plane routes only a Slack thread uses: SWE-bench runs and eval batches, and the
// batch watcher's client. The conversation-level client is thread-api.ts.
import {
  EvalBatchSlackStartRequestSchema,
  EvalBatchSlackStartResultSchema,
  EvalBatchThreadResultSchema,
  EvalBatchWatchDropRequestSchema,
  EvalBatchWatchDropResultSchema,
  EvalBatchWatchListSchema,
  EvalBatchWatchUpdateRequestSchema,
  EvalBatchWatchUpdateResultSchema,
  SwebenchRunSchema,
  SwebenchStartRequestSchema,
  SwebenchStartResultSchema,
  type SlackThread,
} from "@rovara-code/contracts";
import type { EvalBatchStartApi } from "./eval-batch-command.js";
import type { EvalBatchWatchApi } from "./eval-batch-watcher.js";
import type { ThreadServiceApi } from "./processor.js";
import type { SwebenchApi } from "./swebench-command.js";
import { serviceRequestWith } from "./thread-api.js";

/** A Slack thread's service API: the conversation's, with SWE-bench and eval batch routes where the control plane has them. */
export interface SlackThreadServiceApi extends ThreadServiceApi {
  /** Spec 043: absent where the control plane has no SWE-bench routes. */
  startSwebenchRun?: SwebenchApi["startSwebenchRun"];
  getSwebenchRun?: SwebenchApi["getSwebenchRun"];
  /** Spec 052 FR-002: absent where the control plane has no batch routes. */
  startEvalBatch?: EvalBatchStartApi["startEvalBatch"];
  updateEvalBatchWatch?: NonNullable<EvalBatchStartApi["updateEvalBatchWatch"]>;
}

/** Adds the Slack thread's SWE-bench and eval batch routes to a conversation client. */
export function withSlackThreadRoutes(base: ThreadServiceApi, options: { controlPlaneUrl: string; signedFetch: typeof fetch }): SlackThreadServiceApi {
  const request = (method: string, path: string, body: unknown, failure: string) => serviceRequestWith(options.signedFetch, `${options.controlPlaneUrl}${path}`, method, body, failure);
  return {
    ...base,
    async startSwebenchRun(input) {
      const body = SwebenchStartRequestSchema.parse(input);
      return SwebenchStartResultSchema.parse(await request("POST", "/v1/evals/swebench", body, "SWE-bench run request failed"));
    },
    async getSwebenchRun(runId) {
      const response = await request("GET", `/v1/evals/swebench/${encodeURIComponent(runId)}`, undefined, "SWE-bench run lookup failed");
      return SwebenchRunSchema.parse(response.run);
    },
    async startEvalBatch(input) {
      const body = EvalBatchSlackStartRequestSchema.parse(input);
      return EvalBatchSlackStartResultSchema.parse(await request("POST", "/v1/evals/batches", body, "eval batch request failed"));
    },
    async updateEvalBatchWatch(batchId, revision, change) {
      const body = EvalBatchWatchUpdateRequestSchema.parse({ revision, change });
      return EvalBatchWatchUpdateResultSchema.parse(await request("POST", `/v1/evals/batches/${encodeURIComponent(batchId)}/watch`, body, "eval batch watch record failed"));
    },
  };
}

/**
 * Spec 052 Task 6: the batch watcher's client. The list is the Slack service's own; a batch's thread
 * and posts are recorded acting for the batch's thread (a CLI batch's placeholder until its thread
 * is opened) and its requester, so the broker can check the batch is that thread's.
 */
export function createEvalBatchWatchApi(options: {
  controlPlaneUrl: string;
  signedFetchFor: (scope?: { thread: SlackThread; userId: string }) => typeof fetch;
}): EvalBatchWatchApi {
  const { controlPlaneUrl, signedFetchFor } = options;
  const path = (batchId: string, action: string) => `${controlPlaneUrl}/v1/evals/batches/${encodeURIComponent(batchId)}/${action}`;
  return {
    async listBatches() {
      return EvalBatchWatchListSchema.parse(await serviceRequestWith(signedFetchFor(), `${controlPlaneUrl}/v1/evals/batches/active`, "GET", undefined, "eval batch list failed"));
    },
    async dropWatch(batch, reason) {
      const signed = signedFetchFor({ thread: batch.thread, userId: batch.createdBy.userId });
      const body = EvalBatchWatchDropRequestSchema.parse({ reason });
      return EvalBatchWatchDropResultSchema.parse(await serviceRequestWith(signed, path(batch.batchId, "drop"), "POST", body, "eval batch watch drop failed"));
    },
    async recordThread(batch, threadTs) {
      const signed = signedFetchFor({ thread: batch.thread, userId: batch.createdBy.userId });
      return EvalBatchThreadResultSchema.parse(await serviceRequestWith(signed, path(batch.batchId, "thread"), "POST", { threadTs }, "eval batch thread record failed"));
    },
    async updateWatch(batch, revision, change) {
      const signed = signedFetchFor({ thread: batch.thread, userId: batch.createdBy.userId });
      const body = EvalBatchWatchUpdateRequestSchema.parse({ revision, change });
      return EvalBatchWatchUpdateResultSchema.parse(await serviceRequestWith(signed, path(batch.batchId, "watch"), "POST", body, "eval batch watch record failed"));
    },
  };
}
