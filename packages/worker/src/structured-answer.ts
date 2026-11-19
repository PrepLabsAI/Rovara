// Structured answers (Pi feature audit, recommendation 2): a reviewer, the plan check, Understand and a design-review reviewer deliver their answer by calling ONE tool whose parameter schema Pi
// validates, instead of writing JSON (or a fenced block) inside free text. Pi refuses an answer that does not match the schema and the model fixes it in the same run, so the "Answer again"
// text retry is only the fallback. With strict sampling the provider itself produces the schema where it supports that (`constrainedSampling: prefer`: a provider or model without strict tool
// support, or a schema its strict mode cannot hold, takes the tool as an ordinary non-strict tool); `terminate: true` ends the run on the accepted call, with no extra model turn.
//
// What does not change: each step's result contract. The tool turns the accepted arguments back into the exact text the step's own reader already reads (a JSON object, or a fenced block), and
// `check` is that same reader, so the schema can only be stricter than the reader's rules, never different from them. A caller takes the accepted text first and its text parse after.
//
// Flip-back: ROVARA_STRUCTURED_ANSWERS=0 offers no answer tool at all, and every step behaves as it did before this change (text answer, text parse, text retry). Kept for one release.
import { validateToolArguments } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";

/** The setting that turns structured answers off (`0`, `false` or `off`). Anything else, or nothing, leaves them on. */
export const STRUCTURED_ANSWERS_ENVIRONMENT = "ROVARA_STRUCTURED_ANSWERS";

export function structuredAnswersEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment[STRUCTURED_ANSWERS_ENVIRONMENT]?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

/**
 * How many refused answer calls in a row a session allows before it is told to answer in plain text instead (the text parse and its one retry then take over). Pi's own schema refusals never
 * reach the tool, so the session counts them from the tool's result events (pi-session.ts).
 */
export const ANSWER_REFUSALS_MAX = 3;

/** What a session is told after `ANSWER_REFUSALS_MAX` refused answers: stop using the tool and answer the way the prompt describes. */
export const ANSWER_TEXT_FALLBACK_NOTE = "The answer tool refused your last answers. Do not call it again. Write your answer as plain text, in exactly the form your instructions describe.";

/** The line a prompt carries when its step has an answer tool: how to deliver the answer, and what to do when the tool cannot be used. */
export function answerToolInstruction(toolName: string): string {
  return `Deliver your final answer by calling the ${toolName} tool once, with the answer as its arguments. Do not also write the answer as text. If the tool is not available to you, or it keeps refusing your answer, write the answer as plain text in the form described above.`;
}

/** A tool parameter schema from a zod schema, as plain JSON Schema (draft 7), inlined, in the input form: what the model sends. */
export function answerSchemaOf(schema: z.ZodType): TSchema {
  // Plain JSON through and through: zod's result carries a `~standard` property (functions) that Pi's strict-schema copy (structuredClone) cannot clone, and a provider would never be sent.
  const json = JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any", reused: "inline" }))) as Record<string, unknown>;
  delete json["$schema"];
  return Type.Unsafe(json);
}

export interface AnswerChannelSpec {
  /** The tool's name: `submit_<what>`. */
  name: string;
  /** What the model is told about the tool: what the answer is and when to call it. */
  description: string;
  /** The answer's schema: the root must be an object. */
  parameters: TSchema;
  /** The text the step's own reader reads, made from the (Pi-validated) arguments: a JSON object, or a fenced block. */
  render(args: unknown): string;
  /** The step's own reader on that text: undefined when it reads, otherwise the problem in fixed words the model can fix (never the model's own text). */
  check(text: string): string | undefined;
}

export interface AnswerChannel {
  readonly tool: ToolDefinition;
  /** The accepted answer's text, once: it is cleared as it is taken. Undefined when no answer was accepted since the last take. */
  take(): string | undefined;
}

/** A JSON value with every null-valued object property removed (a null inside a list stays), keys sorted: what the arguments mean when a null says "left out". */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, withoutNulls(entry)]));
  }
  return value;
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, sorted(entry)]));
  return value;
}

/** What a model is told when Pi would have changed its answer's types to make it fit: the answer must be sent as the schema says, not corrected for it. */
export const ANSWER_COERCED_MESSAGE = "Your answer has a value of the wrong type (for example a number or the word \"true\" where the schema asks for another type). Send every value exactly as the schema says.";

/**
 * Pi checks tool arguments after changing them: it drops an optional field that is null, and converts a primitive to the type the schema asks for ("true" or 1 to true, "12" to 12). A null optional field is
 * how a strict provider says "left out", so that stays; a converted value would let a reader accept an answer it refuses as text (a finding's `"advisory":"true"` becoming advisory). So the raw arguments
 * the model sent are checked here, before Pi's own check, and an answer Pi would convert is refused. What `execute` then renders is what the raw arguments say, nulls left out.
 */
function refuseConvertedArguments(parameters: TSchema, name: string, raw: unknown): void {
  let validated: unknown;
  try { validated = validateToolArguments({ name, description: "", parameters }, { type: "toolCall", id: "answer", name, arguments: raw as never }); } catch { return; /* Pi refuses it with its own words */ }
  if (JSON.stringify(sorted(validated)) !== JSON.stringify(withoutNulls(raw))) throw new Error(ANSWER_COERCED_MESSAGE);
}

/**
 * One answer tool and what it accepted. A refused answer throws, so the model sees an error and calls the tool again in the same run; an accepted one is kept and ends the run (`terminate`).
 */
export function createAnswerChannel(spec: AnswerChannelSpec): AnswerChannel {
  let accepted: string | undefined;
  const tool = defineTool({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    // Prefer: where the provider supports strict tools and the schema fits its strict subset the answer is produced as the schema; otherwise Pi sends an ordinary tool.
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    prepareArguments: (raw) => { refuseConvertedArguments(spec.parameters, spec.name, raw); return raw; },
    execute: async (_toolCallId, args) => {
      const text = spec.render(args);
      const problem = spec.check(text);
      if (problem !== undefined) throw new Error(problem);
      accepted = text;
      return { content: [{ type: "text" as const, text: "Answer received. Do not write anything else." }], details: undefined, terminate: true };
    },
  }) as ToolDefinition;
  return { tool, take: () => { const text = accepted; accepted = undefined; return text; } };
}

/** A fenced block with an info string around a JSON value: the form the plan check, Understand and design-review readers take. */
export function fencedBlock(infoString: string, value: unknown): string {
  return `\`\`\`${infoString}\n${JSON.stringify(value)}\n\`\`\`\n`;
}
