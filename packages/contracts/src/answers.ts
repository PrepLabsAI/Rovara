// Smart Just answer (lead 4, J1; DEC 254z-amend, 254z-amend2): the shapes and fixed words of the ONE answer service every door (Slack, Linear, the web app, `agentx mcp`) calls.
//
//   POST /v1/app/projects/{project}/answers     ask one question (or a follow-up in a thread); answers with the answer object below
//
// The answer object is the same everywhere: a short answer built only from sentences whose source Code found again in the code at the project's current commit, one honest outcome (answered, partly
// answered, not found; never a score), the sources, the wiki pages read, and at most one action whose words are fixed here. The model writes none of the buttons. Refusals are fixed words that repeat
// nothing the caller sent.
import { z } from "zod";
import { WikiCommitSchema, WikiIdSchema, WikiPageIdSchema, WikiPathSchema, WikiRepoSchema, WikiTaskIdSchema } from "./wiki-store.js";

/** The route the doors call (hosted core and `rovara up`): POST, body `AnswerRequest`, answer `AnswerResponse`. `{project}` is the project's name. */
export const ANSWER_ROUTE_PATH = "/v1/app/projects/{project}/answers";

// ---- Limits (placeholders: named so the owner can tune them after the first real measurements) --------------------------------------------------------------------------------------------

export const ANSWER_LIMITS = {
  /** Tool calls the model may make for one answer; the next one is refused and the model is told to answer. */
  toolCalls: 8,
  /** Different code files one answer may open. */
  codeFiles: 6,
  /** Lines of one code read. */
  linesPerRead: 200,
  /** A code line longer than this is cut. */
  lineChars: 400,
  /** One tool result, in UTF-8 bytes, after framing is applied to the text. */
  resultBytes: 8_192,
  /** Wiki pages one search reads the text of (the rest are matched on title and summary only). */
  searchPageReads: 40,
  /** Hits one search shows. */
  searchHits: 5,
  /** Model turns for one answer (the tool calls and the final answer, with room for one badly formed reply). */
  modelTurns: 10,
  /** The most the model may write in one turn. */
  outputTokens: 1_500,
  /** The longest an answer may take, start to end. */
  wallClockMs: 60_000,
  /** The most input and output tokens one answer may use when the model is not priced (the dollar ceiling cannot be told then). */
  tokenCeiling: 200_000,
  /** The size of what the model is shown in one turn, in bytes. */
  transcriptBytes: 80_000,
  /** Sentences kept in an answer and sources shown. */
  sentences: 12,
  sources: 8,
  citationsPerSentence: 3,
  /** Wiki claims one answer may flag as out of date. */
  flagsPerAnswer: 3,
} as const;

/** PLACEHOLDER (owner DEC 254z-amend2): the most one answer may cost, in cents. Reserved with the gateway before the model is called. */
export const ANSWER_COST_CEILING_CENTS = 15;
/** PLACEHOLDER (owner DEC 254z-amend): answers one person may ask in an hour, across the company's projects. */
export const ANSWERS_PER_PERSON_PER_HOUR = 20;
/** Thread memory: the last turns kept and for how long after the last message. */
export const ANSWER_THREAD_TURNS = 6;
export const ANSWER_THREAD_HOURS = 24;

// ---- The request ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const NO_CONTROL_BUT_NEWLINES = /^(?:[^\p{Cc}\p{Cf}]|\n)*$/u;
export const ANSWER_CHANNELS = ["slack", "web", "linear", "mcp"] as const;
export type AnswerChannel = (typeof ANSWER_CHANNELS)[number];

/** The body of the route. A repeat of the same request id from the same person is the same answer and spends nothing. */
export const AnswerRequestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u),
  question: z.string().trim().min(1).max(1_000).regex(NO_CONTROL_BUT_NEWLINES),
  /** A follow-up names its thread (the id an earlier answer returned, or the channel's own thread id). Absent: a new thread. */
  threadId: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/u).optional(),
  channel: z.enum(ANSWER_CHANNELS).default("web"),
  /** What the door knows of the message (a Linear issue's title and text): information for the answer, never an instruction. */
  context: z.string().max(4_000).regex(NO_CONTROL_BUT_NEWLINES).optional(),
  /** Optional task context, loaded by Code under the asker's live read authority. */
  taskId: WikiTaskIdSchema.optional(),
}).strict();
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;

// ---- The answer -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** `not_set_up`: no model is set up here (hosted: the gateway's answers purpose is not wired yet). Nothing was spent, nothing was recorded, and no action is offered. */
export const ANSWER_OUTCOMES = ["answered", "partly", "not_found", "not_set_up"] as const;
export type AnswerOutcome = (typeof ANSWER_OUTCOMES)[number];

/** The words the engine says, fixed in code. The model writes none of them. */
export const ANSWER_WORDS = {
  notSetUp: "Answers are not set up here yet.",
  notFound: "I don't know. The wiki and the code I can read do not cover this.",
  partly: "I could not confirm all of this, so I left out what I could not find in the code.",
  wikiOutdated: "I checked the code: the wiki was out of date here.",
  ranOut: "I ran out of room before I could finish. A task can dig deeper.",
  taskButton: "Start a Quick task",
  projectNotFound: "project not found",
  rate: "You've asked a lot of questions lately. Try again a little later.",
  unavailable: "Couldn't answer that just now.",
  limitReached: "This project has reached its spending limit for now.",
  /** The company's monthly answers limit or budget has no room (the gateway's `answers_paused`), or one answer cannot fit it. */
  paused: "Answers are paused for this month.",
  badRequest: "An answer needs a request ID and a question of 1 to 1,000 characters.",
} as const;

export const AnswerCodeCitationSchema = z.object({
  /** The number the answer's text uses: `[1]`. */
  n: z.number().int().min(1).max(ANSWER_LIMITS.sources),
  repo: WikiRepoSchema,
  path: WikiPathSchema,
  line: z.number().int().min(1),
  lineEnd: z.number().int().min(1).optional(),
  /** The commit the source was found at: the project's current commit of that repository, never a commit the model named. */
  commit: WikiCommitSchema,
}).strict();
export const AnswerTaskCitationSchema = z.object({
  n: z.number().int().min(1).max(ANSWER_LIMITS.sources),
  kind: z.literal("task_state"),
  taskId: WikiTaskIdSchema,
  /** Copied from the bounded, redacted task context Code actually showed. */
  quote: z.string().min(20).max(600),
}).strict();
export const AnswerCitationSchema = z.union([AnswerCodeCitationSchema, AnswerTaskCitationSchema]);
export type AnswerCitation = z.infer<typeof AnswerCitationSchema>;

export const AnswerActionSchema = z.object({
  kind: z.literal("quick_task"),
  /** Fixed words (`ANSWER_WORDS.taskButton`). */
  label: z.literal(ANSWER_WORDS.taskButton),
  /** A suggested title for the task, made inert; the click is the person's own Start, with every normal check. */
  title: z.string().min(1).max(120),
}).strict();
export type AnswerAction = z.infer<typeof AnswerActionSchema>;

export const AnswerResponseSchema = z.object({
  answerId: WikiIdSchema.optional(),
  threadId: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/u),
  outcome: z.enum(ANSWER_OUTCOMES),
  /** The sentences that survived the check, with `[n]` markers. Empty when the outcome is `not_found` or `not_set_up`. */
  text: z.string().max(6_000),
  /** One fixed line, only when it applies. */
  honesty: z.string().max(300).optional(),
  /** What the model said it could not confirm (made inert); shown on the answer page, never as a claim. */
  unconfirmed: z.array(z.string().max(200)).max(3),
  sources: z.array(AnswerCitationSchema).max(ANSWER_LIMITS.sources),
  wikiPages: z.array(z.object({ pageId: WikiPageIdSchema, title: z.string().max(120) }).strict()).max(20),
  /** At most one, and only when the answer points at a change or the engine could not answer. Absent for `not_set_up`. */
  action: AnswerActionSchema.optional(),
}).strict();
export type AnswerResponse = z.infer<typeof AnswerResponseSchema>;

/** GET /v1/app/projects/{project}/tasks/{taskId}/answers: only this asker's retained turns. */
export const AnswerHistoryResponseSchema = z.object({
  entries: z.array(z.object({
    answerId: WikiIdSchema, threadId: z.string().max(100).optional(),
    question: z.string().max(2_000), answer: z.string().max(6_000), createdAt: z.string().datetime(),
    sources: z.array(AnswerCitationSchema).max(ANSWER_LIMITS.sources),
  }).strict()).max(1_000),
  more: z.boolean(),
}).strict();
export type AnswerHistoryResponse = z.infer<typeof AnswerHistoryResponseSchema>;
