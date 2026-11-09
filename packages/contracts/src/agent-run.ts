import { z } from "zod";

export const RUN_INPUT_TEXT_MAX_BYTES = 8192;

export const RUN_INPUT_CONTEXT_MAX = 10;

export const RUN_INPUT_REF_MAX = 512;

export const RUN_INPUT_TITLE_MAX = 200;

export const RUN_INPUT_BODY_MAX_BYTES = 16_384;

export const RUN_CONTEXT_KINDS = ["ticket", "pull_request", "deploy", "alert", "report", "text"] as const;

export const utf8 = new TextEncoder();

export function boundedBytes(max: number) {
  return z.string().min(1).refine((text) => utf8.encode(text).length <= max, `must be at most ${max} bytes`);
}

export const RunContextItemSchema = z.object({
  kind: z.enum(RUN_CONTEXT_KINDS),
  ref: z.string().min(1).max(RUN_INPUT_REF_MAX),
  title: z.string().min(1).max(RUN_INPUT_TITLE_MAX).optional(),
  body: boundedBytes(RUN_INPUT_BODY_MAX_BYTES).optional(),
}).strict();

/** The request an agent run is given: the text, and information from elsewhere that is shown as information only. */
export const RunInputSchema = z.object({
  text: boundedBytes(RUN_INPUT_TEXT_MAX_BYTES),
  context: z.array(RunContextItemSchema).max(RUN_INPUT_CONTEXT_MAX).optional(),
}).strict();

export const AGENT_RUN_STATES = ["RUNNING", "WAITING_FOR_APPROVAL", "PAUSED_BUDGET", "COMPLETE", "FAILED", "CANCELLED"] as const;

export const AGENT_RUN_STEP_STATUSES = ["pending", "running", "waiting", "done", "failed"] as const;

export const AGENT_REPORT_MAX_BYTES = 32_768;

/** What a run's end reason starts with when the run ended because its report could not be checked against what the agent did; the words after it say why. */
export const UNVERIFIED_END_PREFIX = "Unverified, needs a person: ";

const TOOL_FAILURE_SHAPE = { tool: z.string().min(1).max(100), message: z.string().max(300) };
const TOOLS_SHAPE = { calls: z.number().int().min(0), failed: z.number().int().min(0) };

/** The tool calls of an agent step and the ones that failed, as the worker recorded them: the message is the tool's own words, redacted and cut. */
export const AgentStepToolsSchema = z.object({
  ...TOOLS_SHAPE,
  failures: z.array(z.object(TOOL_FAILURE_SHAPE).strict()).max(10),
}).strict();

/**
 * What the worker found when it compared an agent step's report with the tool calls it made (worker `checkGrounding`). `unverified`: the report cites things no successful
 * call returned, imitates tool calls in text, or rests on tool calls that failed; `reasons` say which. A worker that lists `task.agentGrounding.v1` sends it with every step;
 * an older worker sends none. The broker reads it tolerantly (a field a newer worker adds is ignored, the verdict is required), so the worker can grow it before the broker does.
 */
export const AgentStepGroundingSchema = z.object({
  verdict: z.enum(["grounded", "unverified"]),
  reasons: z.array(z.string().min(1).max(300)).max(10),
  tools: z.object({ ...TOOLS_SHAPE, failures: z.array(z.object(TOOL_FAILURE_SHAPE)).max(10) }),
});
