// Spec 062 Phase 5b: the Slack adapter's side of the request processor. processSlackRequest runs a Slack thread's
// request through the surface-neutral core (processor.ts) with what only Slack has: its subject and format, the
// Details button on a reply, the hidden turn record, and the eval batch and SWE-bench commands.
import {
  detailsButtonValue,
  detailsReplyBlocks,
  parseEvalBatchCommand,
  parseSwebenchCommand,
  slackThreadSubject,
  type SlackRequestMessage,
  type SlackThread,
  type TurnRecord,
} from "@agentx/contracts";
import { deterministicUuid } from "./ids.js";
import { TurnHandedOffError } from "./interrupted-turn.js";
import { runEvalBatchCommand } from "./eval-batch-command.js";
import {
  processConversationRequest,
  type FinishedTurn,
  type ProcessorDependencies as ConversationDependencies,
  type ProcessorMessage,
  type ServiceLog,
  type SurfaceCommand,
} from "./processor.js";
import { SLACK_FORMAT } from "./slack-format.js";
import type { SlackThreadServiceApi } from "./slack-thread-api.js";
import { runSwebenchCommand } from "./swebench-command.js";
import { buildTurnRecord, emitTurnMetrics, type TurnRecordSink } from "./turn-records.js";

export * from "./processor.js";
export type { SlackThreadServiceApi } from "./slack-thread-api.js";

/** A Slack thread's processor dependencies: the core's, with Slack's defaults and its own extras. */
export type ProcessorDependencies = Omit<ConversationDependencies<SlackThread>, "api" | "subjectOf" | "format" | "postReplyEnd" | "onFinished" | "commands"> & {
  api: (message: ProcessorMessage<SlackThread>) => SlackThreadServiceApi;
  subjectOf?: ConversationDependencies<SlackThread>["subjectOf"];
  format?: ConversationDependencies<SlackThread>["format"];
  /** Where one hidden record per finished Slack event goes; without it nothing is recorded. */
  turnRecords?: TurnRecordSink;
  /** Posts a message with Block Kit blocks. The reply's Details button needs it (spec 014 FR-024); without it, replies are text only. */
  postWithBlocks?: (thread: SlackThread, text: string, blocks: unknown[]) => Promise<void>;
  /**
   * Spec 062 Phase 7b: posts a reply's last chunk with its Details button named by `value`, the way the surface shows
   * it (an event for the built-in Slack adapter). Takes the place of postWithBlocks.
   */
  postDetails?: (thread: SlackThread, text: string, value: string) => Promise<void>;
};

export function processSlackRequest(
  message: ProcessorMessage<SlackThread>,
  dependencies: ProcessorDependencies,
  options: Parameters<typeof processConversationRequest<SlackThread>>[2],
): Promise<void> {
  const log: ServiceLog = dependencies.log ?? (() => undefined);
  const { turnRecords, postWithBlocks, postDetails, api: apiFor, ...rest } = dependencies;
  const details = postDetails ?? (postWithBlocks === undefined ? undefined : (thread: SlackThread, text: string, value: string) => postWithBlocks(thread, text, detailsReplyBlocks(text, value)));
  // One client per request, for the core and for Slack's commands alike.
  const api = apiFor(message);
  return processConversationRequest(message, {
    ...rest,
    api: () => api,
    subjectOf: dependencies.subjectOf ?? slackThreadSubject,
    format: dependencies.format ?? SLACK_FORMAT,
    commands: slackCommands(api, message),
    ...(details === undefined || turnRecords === undefined ? {} : { postReplyEnd: detailsReply(details, log) }),
    ...(turnRecords === undefined ? {} : { onFinished: (turn: FinishedTurn<SlackThread>) => recordTurn(turnRecords, log, turn) }),
  }, options);
}

/**
 * Spec 014 FR-024: the last chunk of a reply that followed tool calls carries a Details button naming its turn record. A
 * Slack refusal of the blocks (an API error answer such as invalid_blocks, so nothing was posted) never costs the member
 * the reply: the text is posted on its own. Any other failure (a network error, a timeout, an unreadable answer) may come
 * after Slack posted the message, so it is thrown like any failed post rather than risking the reply twice.
 */
function detailsReply(postDetails: NonNullable<ProcessorDependencies["postDetails"]>, log: ServiceLog): NonNullable<ConversationDependencies<SlackThread>["postReplyEnd"]> {
  return async (thread, text, { recorder, message }) => {
    let calls: number;
    try {
      calls = recorder.observation().calls.length;
    } catch {
      // The record's own write reports a broken recorder; the reply just goes without a button.
      return "not_posted";
    }
    if (calls === 0) return "not_posted";
    const value = detailsButtonValue(message);
    if (value === undefined) return "not_posted";
    try {
      await postDetails(thread, text, value);
      return "posted";
    } catch (error) {
      const refusal = slackRefusal(error);
      log("reply.details_failed", { eventId: message.eventId, errorName: errorName(error), ...(refusal === undefined ? {} : { slackError: refusal }) });
      if (refusal === undefined) throw error;
      return "not_posted";
    }
  };
}

/** Slack's eval batch (spec 052) and SWE-bench (spec 043) commands, on this request's client. */
function slackCommands(api: SlackThreadServiceApi, message: ProcessorMessage<SlackThread>): ReadonlyArray<SurfaceCommand<SlackThread>> {
  const evalBatch: SurfaceCommand<SlackThread> = (request) => {
    const command = parseEvalBatchCommand(request.text);
    if (command === undefined) return undefined;
    return {
      disposition: "eval_batch",
      run: async (context) => {
        // Spec 052 FR-002: a batch is recorded and announced here; the batch watcher posts the rest.
        if (api.startEvalBatch === undefined) throw new Error("eval batches are unavailable in this deployment");
        await runEvalBatchCommand(command, {
          startEvalBatch: (input) => api.startEvalBatch!(input),
          ...(api.listProjectModels === undefined ? {} : { listProjectModels: () => api.listProjectModels!() }),
          ...(api.updateEvalBatchWatch === undefined ? {} : { updateEvalBatchWatch: (batchId, revision, change) => api.updateEvalBatchWatch!(batchId, revision, change) }),
        }, { post: context.post, redelivered: context.redelivered, ...(context.now === undefined ? {} : { now: context.now }), log: context.log });
      },
    };
  };
  const swebench: SurfaceCommand<SlackThread> = (request) => {
    const command = parseSwebenchCommand(request.text);
    if (command === undefined) return undefined;
    return {
      disposition: "swebench_run",
      run: async (context) => {
        if (api.startSwebenchRun === undefined || api.getSwebenchRun === undefined) throw new Error("SWE-bench runs are unavailable in this deployment");
        if (context.handoff?.aborted === true) throw new TurnHandedOffError();
        // Issue 157: the wait is handed off at the deadline like a turn; the redelivery resumes the same run.
        await context.untilHandoff(runSwebenchCommand(command, {
          startSwebenchRun: (input) => api.startSwebenchRun!(input),
          getSwebenchRun: (runId) => api.getSwebenchRun!(runId),
          ...(api.listProjectModels === undefined ? {} : { listProjectModels: () => api.listProjectModels!() }),
        }, {
          // The same run for a redelivered event.
          requestId: deterministicUuid(`${message.eventId}:swebench`),
          post: context.post,
          // A redelivered event resumes waiting for the run it started; the thread already has its notice.
          announce: !context.redelivered,
          ...(context.sleep === undefined ? {} : { sleep: context.sleep }),
        }));
      },
    };
  };
  return [evalBatch, swebench];
}

/**
 * Builds, validates, fits and writes the record inside one try: any failure, including a record
 * that fails its schema, is logged by event ID and error class with a metric, and never reaches the
 * member, who already has their reply. Record contents are never logged.
 *
 * Turn metrics are emitted in their own try, separate from the write: a turn that ran the
 * orchestrator is counted whether or not its record could be written (including a write that throws
 * or times out), but a turn whose record never built has nothing to derive metrics from. A failure
 * while emitting metrics is reported on its own event, never mislabelled as a write failure.
 */
async function recordTurn(sink: TurnRecordSink, log: ServiceLog, turn: FinishedTurn<SlackThread>): Promise<void> {
  const { recorder, ...input } = turn;
  const message = input.message as SlackRequestMessage;
  let record: TurnRecord | undefined;
  let duplicate = false;
  try {
    record = buildTurnRecord({ ...input, message, observation: recorder.observation() });
    duplicate = await sink.write(record) === "duplicate";
  } catch (error) {
    // recordTurn must never throw: it runs after the member already has their reply, so a logging failure here must
    // not skip threads.finish and invite a redelivery that would post the reply again.
    try {
      log("turn_record.write_failed", { eventId: message.eventId, errorName: errorName(error) });
    } catch {
      // Logging itself failed; nothing left to report to.
    }
    try {
      log("metric", { metric: "TurnRecordWriteFailed", count: 1 });
    } catch {
      // Logging itself failed; nothing left to report to.
    }
  }
  if (duplicate) {
    // Outside the write try, so a logging failure here is never reported as a write failure.
    try {
      log("turn_record.duplicate", { eventId: message.eventId });
    } catch {
      // Logging itself failed; nothing left to report to.
    }
  }
  if (record !== undefined && !duplicate) {
    try {
      emitTurnMetrics(record, log);
    } catch (error) {
      try {
        log("turn_metrics.emit_failed", { eventId: message.eventId, errorName: errorName(error) });
      } catch {
        // Logging itself failed; nothing left to report to.
      }
    }
  }
}

/**
 * Slack's error code when chat.postMessage answered with a refusal ("Slack chat.postMessage failed:
 * invalid_blocks"), so the message was not posted; undefined for anything else, including an HTTP
 * status with no error code. Codes are lowercase identifiers and carry no user text.
 */
function slackRefusal(error: unknown): string | undefined {
  const match = error instanceof Error ? /^Slack chat\.postMessage failed: ([a-z_]{1,64})$/.exec(error.message) : null;
  return match?.[1];
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
