// Lead 4 J2 (DEC 254z, 254zza): the smart Just answer for a Slack thread, on the Slack service's IAM-signed route family:
//
//   POST /v1/service/answers   { requestId, question }   ->   answered(answer, attach?) | declined(reason) | refused(reason)
//
// Who and what are decided HERE, from the verified Slack thread and member, never from the body (which names only a request id and the person's words):
//  - the person is the company-linked member the Slack account is, read live (an account nobody owns in the company asks nothing: `not_available`);
//  - the project is the one the thread's channel is bound to, read live by the Slack identity (an unbound channel never reaches this function), and it must be one of the person's company's projects;
//  - a thread that holds a task is never answered here (the task's own buttons drive it);
//  - the company is the Slack workspace's own, so another company's wiki, code and rows are never in reach (the core mounts its runtime for that company only);
//  - the role on the project is read live by the answer service itself (any role asks, a viewer too); no role, no project and another company's project all read as `no_role`;
//  - the answer's thread is the Slack thread (`slackAnswerThreadId`), shared, because everyone who reads the Slack thread has read every answer in it.
// Nothing here echoes what a caller sent. A fault is a fixed reason; the Slack service then says its own fixed words.
import { ANSWER_WORDS, AgentXError, agentXError, SLACK_ANSWER_ATTACH_MAX, SlackAnswerAskSchema, SlackAnswerResultSchema, slackAnswerThreadId, type AnswerResponse, type SlackAnswerResult, type SlackChannelBinding, type SlackRequester, type SlackThread } from "@agentx/contracts";
import type { SlackThreadAnswer, SlackThreadAnswerInput } from "../core-host/dev-routes.js";
import type { CoreAppEntry } from "./core-app-routes.js";
import { slackCompanyPerson, slackCompanyProject, type SlackCompanyDependencies } from "./slack-person.js";

export interface SlackAnswerDeps {
  /** The company-linked person this Slack account is, live; undefined: nobody (or a link that cannot be read). Never throws into the route. */
  person(teamId: string, userId: string): Promise<{ companyId: string; personId: string } | undefined>;
  /** Whether the project is one of the company's (the channel's binding named it). */
  projectInCompany(teamId: string, project: string): Promise<boolean>;
  /** The core's in-process answer; absent or `undefined`: answers are not served here. */
  ask: ((input: SlackThreadAnswerInput) => Promise<SlackThreadAnswer | undefined>) | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/**
 * The route's seams over the hosted Slack wiring: the person is the company-linked member a Slack account is (the same resolver every hosted Slack path uses; an account nobody owns, an unknown workspace or a
 * link that cannot be read is nobody), the project must be one of that workspace's own company's, and the answer is the core's in process (`undefined`: this deployment's core serves none).
 */
export function slackAnswerDeps(input: { company: SlackCompanyDependencies; core: Pick<CoreAppEntry, "answerForSlackThread"> | undefined; log?: SlackAnswerDeps["log"] }): SlackAnswerDeps {
  const answer = input.core?.answerForSlackThread;
  return {
    async person(teamId, userId) {
      try {
        const person = await slackCompanyPerson(input.company, teamId, userId);
        return person.kind === "linked" ? { companyId: person.companyId, personId: person.personId } : undefined;
      } catch { return undefined; }
    },
    projectInCompany: (teamId, project) => slackCompanyProject(input.company, teamId, project),
    ask: answer === undefined ? undefined : (request) => answer.call(input.core, request),
    log: input.log,
  };
}

/**
 * The route's entry from the verified Slack service identity: the project is the one the thread's channel is bound to (the identity read it live), the person is the verified requester, a thread that holds a
 * task is never answered, and a caller that is not a Slack thread is refused before anything is read.
 */
export async function askSlackAnswerForIdentity(
  wiring: { company: SlackCompanyDependencies; core: Pick<CoreAppEntry, "answerForSlackThread"> | undefined; log?: SlackAnswerDeps["log"] },
  identity: { slack?: { thread: SlackThread; requester: SlackRequester; binding: SlackChannelBinding } | undefined; sharedTask?: unknown },
  body: unknown,
): Promise<SlackAnswerResult> {
  const slack = identity.slack;
  if (slack === undefined) throw agentXError("FORBIDDEN", "only a Slack thread may ask for an answer");
  return askSlackAnswer(slackAnswerDeps(wiring), { thread: slack.thread, userId: slack.requester.userId, boundProject: slack.binding.projectName, taskThread: identity.sharedTask !== undefined, body });
}

export interface SlackAnswerCall {
  thread: SlackThread;
  userId: string;
  /** The project the thread's channel is bound to (from the verified identity). */
  boundProject: string;
  /** True when the thread holds a task. */
  taskThread: boolean;
  body: unknown;
}

const declined = (reason: "not_available" | "no_role" | "bad_question"): SlackAnswerResult => ({ status: "declined", reason });
const refused = (reason: "rate" | "limit_reached" | "unavailable"): SlackAnswerResult => ({ status: "refused", reason });

function withoutAction(answer: AnswerResponse): AnswerResponse {
  const copy = { ...answer };
  delete copy.action;
  return copy;
}

/** The words after `CODE: ` in an AgentXError's message. */
const wordsOf = (error: AgentXError): string => error.message.slice(error.code.length + 2);

export async function askSlackAnswer(deps: SlackAnswerDeps, call: SlackAnswerCall): Promise<SlackAnswerResult> {
  const log = (event: string, extra: Record<string, unknown> = {}): void => deps.log?.({ component: "slack-answers", event, ...extra });
  const parsed = SlackAnswerAskSchema.safeParse(call.body);
  if (!parsed.success) return declined("bad_question");
  if (call.taskThread) return declined("not_available");
  let person: { companyId: string; personId: string } | undefined;
  try { person = await deps.person(call.thread.teamId, call.userId); } catch { person = undefined; }
  if (person === undefined) return declined("not_available");
  let inCompany: boolean;
  try { inCompany = await deps.projectInCompany(call.thread.teamId, call.boundProject); } catch { inCompany = false; }
  if (!inCompany || deps.ask === undefined) return declined("not_available");
  try {
    const served = await deps.ask({
      companyId: person.companyId, personId: person.personId, project: call.boundProject,
      threadId: slackAnswerThreadId(call.thread), requestId: parsed.data.requestId, question: parsed.data.question,
    });
    if (served === undefined) return declined("not_available");
    // A button only with its attached context, and the context only with a button.
    const attach = served.answer.outcome !== "not_set_up" && served.answer.action !== undefined && served.attach !== undefined && served.attach.length <= SLACK_ANSWER_ATTACH_MAX ? served.attach : undefined;
    const answer = attach === undefined ? withoutAction(served.answer) : served.answer;
    return SlackAnswerResultSchema.parse({ status: "answered", answer, ...(attach === undefined ? {} : { attach }) });
  } catch (error) {
    if (error instanceof AgentXError) {
      log("answer.refused", { code: error.code });
      if (error.code === "NOT_FOUND") return declined("no_role");
      if (error.code === "CONFIG_INVALID") return declined("bad_question");
      if (error.code === "TOO_MANY_REQUESTS") {
        const words = wordsOf(error);
        return refused(words === ANSWER_WORDS.rate ? "rate" : words === ANSWER_WORDS.limitReached ? "limit_reached" : "unavailable");
      }
      return refused("unavailable");
    }
    log("answer.failed", { error: error instanceof Error ? error.name : "unknown" });
    return refused("unavailable");
  }
}
