// Smart Just answer in Slack (lead 4, J2; DEC 254z, 254zza): what the Slack service asks the control plane to answer, and what comes back. The Slack service never reads the wiki or the code and never
// decides who may ask: it sends the question, and the broker decides from the verified Slack thread and the verified Slack member.
//
//   POST /v1/service/answers   (the Slack service's IAM-signed route family, acting for one Slack thread and one member)
//
// Rules the route keeps (aws/slack-answers.ts):
//  - the project is the one the thread's CHANNEL is bound to (read live); the body can name no project, company, person or thread, and an unbound channel is never answered;
//  - the person is the company-linked member the Slack account is (read live); a Slack account that is nobody's in the company asks nothing;
//  - the role on the project is read live by the answer service itself (J1); no role reads as "declined", and the Slack service then does what it did before this lane;
//  - the thread's memory is the Slack thread (everyone who reads the thread has read every answer in it), keyed by company AND project.
import { z } from "zod";
import { ANSWER_WORDS, AnswerRequestSchema, AnswerResponseSchema } from "./answers.js";
import { WORKFLOW_PATH_QUICK_ACTION } from "./slack-routing.js";

/** The route as the Slack service calls it (the control plane client adds its own `/v1/service` rewrite). */
export const SLACK_ANSWER_SERVICE_PATH = "/v1/answers";

/** The longest framed text of an answer that is attached to the task a person starts from it. */
export const SLACK_ANSWER_ATTACH_MAX = 10_000;
/** The longest message the door sends: a longer one is not a question this door answers (the answer service takes at most this many characters). */
export const SLACK_ANSWER_QUESTION_MAX = 1_000;

/** The body: the request's id (a UUID the Slack service derived from the Slack event, so a redelivery is the same answer and spends nothing) and the person's words. Nothing else is read. */
export const SlackAnswerAskSchema = z.object({
  requestId: z.string().uuid(),
  question: AnswerRequestSchema.shape.question,
}).strict();
export type SlackAnswerAsk = z.infer<typeof SlackAnswerAskSchema>;

/**
 * Why no answer was made here, with nothing said to the person: the Slack service then does what it did before (the chat agent answers a question, the card offers the choices).
 *  - `not_available`: answers are not served for this thread (no company workspace, an unbound channel, a thread that holds a task, a core that does not serve answers, an account nobody owns);
 *  - `no_role`: the person has no role on the project (the answer service read it live);
 *  - `bad_question`: the words are not a question the answer service takes.
 */
export const SLACK_ANSWER_DECLINES = ["not_available", "no_role", "bad_question"] as const;
/** Why an answer could not be made, said to the person in fixed words (the answer service's own, `ANSWER_WORDS`). */
export const SLACK_ANSWER_REFUSALS = ["rate", "limit_reached", "unavailable"] as const;

export const SlackAnswerResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("answered"),
    /** One of the answer service's outcomes. `not_set_up` (no answers model here yet) is shown in its fixed words, with no button and no attached context. */
    answer: AnswerResponseSchema,
    /**
     * The answer as DATA for the task the person starts from it (the question, the answer, the sources, the pages read, framed as untrusted by the answer service). Present only when the answer
     * carries the one button and the asker may still attach it; without it there is no button.
     */
    attach: z.string().min(1).max(SLACK_ANSWER_ATTACH_MAX).optional(),
  }).strict(),
  z.object({ status: z.literal("declined"), reason: z.enum(SLACK_ANSWER_DECLINES) }).strict(),
  z.object({ status: z.literal("refused"), reason: z.enum(SLACK_ANSWER_REFUSALS) }).strict(),
]);
export type SlackAnswerResult = z.infer<typeof SlackAnswerResultSchema>;

/** The Slack thread's id as the answer service keeps its memory: workspace, channel and thread, so two workspaces of one company never share a thread. Only characters the answer service takes. */
export function slackAnswerThreadId(thread: { teamId: string; channelId: string; threadTs: string }): string {
  return `${thread.teamId}.${thread.channelId}.${thread.threadTs}`;
}

/** The words the Slack door says itself (the answer's own words are the answer service's). */
export const SLACK_ANSWER_WORDS = {
  looking: "Looking...",
} as const;

/** The most one Slack section holds is 3,000 characters; an answer is cut into sections below that. */
const SECTION_MAX = 2_900;
/** The most sections one answer shows (Slack allows 50 blocks); a longer answer is cut, and the answer page has the rest. */
const SECTIONS_MAX = 6;

/** Text cut into Slack sections, at line breaks where it can, never more than `SECTIONS_MAX` of them. */
export function slackAnswerSections(text: string): string[] {
  const sections: string[] = [];
  let rest = text.trim();
  while (rest.length > 0 && sections.length < SECTIONS_MAX) {
    if (rest.length <= SECTION_MAX) { sections.push(rest); rest = ""; break; }
    const at = Math.max(rest.lastIndexOf("\n", SECTION_MAX), rest.lastIndexOf(" ", SECTION_MAX));
    const end = at > SECTION_MAX / 2 ? at : SECTION_MAX;
    sections.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest.length > 0) sections[sections.length - 1] = `${sections[sections.length - 1]!.slice(0, SECTION_MAX - 1)}…`;
  return sections.length === 0 ? [ANSWER_WORDS.unavailable] : sections;
}

/**
 * The one message an answer is in Slack: the answer's words (already made safe for Slack by the Slack service), and, only when a choice was saved for it, the one button. The button is the existing Quick
 * choice (`WORKFLOW_PATH_QUICK_ACTION` on this saved choice), so only the person who asked can press it and the start is their own Start press with every normal check.
 */
export function slackAnswerCard(input: { text: string; button?: { requesterId: string; choiceId: string } }): { text: string; blocks: Array<Record<string, unknown>> } {
  const sections = slackAnswerSections(input.text);
  const blocks: Array<Record<string, unknown>> = sections.map((section) => ({ type: "section", text: { type: "mrkdwn", text: section } }));
  if (input.button !== undefined) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Only <@${input.button.requesterId}> can start a task from this answer.` }] });
    blocks.push({ type: "actions", elements: [{ type: "button", action_id: WORKFLOW_PATH_QUICK_ACTION, style: "primary", text: { type: "plain_text", text: ANSWER_WORDS.taskButton }, value: JSON.stringify({ choiceId: input.button.choiceId }) }] });
  }
  return { text: sections.join("\n"), blocks };
}
