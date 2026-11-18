// HW5b (owner decision 2026-11-18): the hosted Slack plan card matches the laptop's. A low or medium risk plan's card has Approve and Request changes buttons (`plugins/channel/slack/format.ts`, the SAME card the laptop posts); this is the
// hosted press side, run by the interactivity Lambda AFTER it verified Slack's signature and that the clicking account is a linked member of the workspace's company (`slack-interactivity.ts`, `slack-action-classes.ts`):
//
//   Approve           becomes a press the broker takes (`slack-core-decision.ts`, the ONE new route) and the core decides (`core-host/chat-decision.ts`); the card is updated in place when it was decided.
//   Request changes   opens the same box the laptop opens ("What should change?"); the words typed in it are the reason of the request for changes, sent by the person who opened it, from the workspace they opened it in.
//
// This file decides nothing: a press is a request (an answer of `refused` says which fixed words to show, privately; nothing here is told why beyond the code). A high risk plan's card has no such button, and a forged `rovara_decide_*` for
// anything else (Reject, Skip) is not in the member class (`slack-action-classes.ts`), so the interactivity gate refuses it before it reaches here; the core refuses it again.
import { SLACK_CHANNEL } from "@agentx/contracts";
import { z } from "zod";
import { ACTION_PREFIX, CHANGES_CALLBACK, CHANGES_INPUT, changesModal, cleanChatText, escapeText } from "../plugins/channel/slack/index.js";
import { decisionRefusalWords } from "../core/channel/sink.js";
import type { SlackActionHandler, SlackBlockAction } from "./slack-interactivity.js";
import type { SlackCorePressAnswer } from "./slack-core-decision.js";

export const CORE_APPROVE_ACTION = `${ACTION_PREFIX}APPROVE`;
export const CORE_CHANGES_ACTION = `${ACTION_PREFIX}REQUEST_CHANGES`;

const ButtonValueSchema = z.object({ r: z.string().uuid(), v: z.number().int().positive(), d: z.string().regex(/^[a-f0-9]{64}$/u), o: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "SKIP"]) }).strict();
const Id = z.string().min(1).max(64);
const Ts = z.string().regex(/^\d{10}\.\d{6}$/u);
/** What the box carries for itself: the laptop's (`ChangesContext`), plus where the card is (`m`) and its words (`x`), so the card can be updated in place once the request is taken. Slack returns it as given (the person cannot edit it). */
const ContextSchema = z.object({
  r: z.string().uuid(), v: z.number().int().positive(), d: z.string().regex(/^[a-f0-9]{64}$/u), t: Id, s: Id, h: Ts, u: Id, w: Id, m: Ts, x: z.string().max(1_500),
}).strict();
type Context = z.infer<typeof ContextSchema>;

const EXPIRED_WORDS = "That button expired. Open the task page to decide.";
const NOT_HERE_WORDS = "That could not be applied from here. Open the task page and decide there.";
const NOT_SAVED_WORDS = "I couldn't take that. Press the button again, or decide on the task page.";
const EDITING_FAILED_WORDS = "I couldn't save this. Try again in a moment.";
/** Words the card says once it was decided (no names, no ids). */
export const APPROVED_CARD_WORDS = "Approved in Slack.";
export const CHANGES_CARD_WORDS = "Changes requested in Slack.";
const SECTION_MAX = 3_000;
/** The words the chat asks of the broker, and what a request for changes may hold. */
const REASON_MAX = 500;

export interface CorePlanPressDeps {
  /** Asks the broker (`slack-core-decision.ts`); throws when the broker itself failed (nothing was decided: the person may press again). */
  ask(press: { conversation: { channel: string; tenant: string; space: string; thread: string }; actor: { channel: string; tenant: string; userId: string }; eventId: string; requestId: string; expectedRevision: number; artifactDigest: string; decision: "APPROVE" | "REQUEST_CHANGES"; reason: string }, timeoutMs: number): Promise<SlackCorePressAnswer>;
  openView(triggerId: string, view: Record<string, unknown>, timeoutMs?: number): Promise<void>;
  respondEphemeral(responseUrl: string, text: string): Promise<void>;
  /** Replaces the card's message in place (Slack's `chat.update`, with the company's own token). */
  update(input: { channel: string; ts: string; text: string; blocks: unknown[] }): Promise<void>;
  now?: () => number;
  log?: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;
}

/** The card, once decided: its own words, no buttons, one line that says what was done. */
function decidedCard(text: string, done: string): { text: string; blocks: unknown[] } {
  const body = [...text].slice(0, SECTION_MAX).join("");
  return {
    text: `${body}\n${done}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: body === "" ? escapeText(done) : body } }, { type: "context", elements: [{ type: "mrkdwn", text: escapeText(done) }] }],
  };
}

/** What the box shows on its one input (its error), as Slack's own answer to the submission. */
function fieldError(text: string): Record<string, unknown> {
  const errors: Record<string, string> = {};
  errors[CHANGES_INPUT] = text;
  return { response_action: "errors", errors };
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

export function corePlanPressHandler(deps: CorePlanPressDeps): SlackActionHandler {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const tell = async (responseUrl: string, text: string): Promise<void> => { try { await deps.respondEphemeral(responseUrl, text); } catch (error) { log("core_plan_press.respond_failed", { errorName: errorName(error) }); } };
  return {
    matches: (actionId) => actionId === CORE_APPROVE_ACTION || actionId === CORE_CHANGES_ACTION,
    async handle(action: SlackBlockAction): Promise<void> {
      let value: z.infer<typeof ButtonValueSchema>;
      try { value = ButtonValueSchema.parse(JSON.parse(action.value)); } catch { await tell(action.responseUrl, EXPIRED_WORDS); return; }
      // The button's own name and its value must say the same answer.
      if (action.actionId !== `${ACTION_PREFIX}${value.o}`) { await tell(action.responseUrl, EXPIRED_WORDS); return; }
      // The person's own workspace is the thread's (a guest from a shared channel, or a click through another workspace, gets nothing).
      if (action.userTeamId !== action.thread.teamId || (action.workspaceTeamId !== "" && action.workspaceTeamId !== action.thread.teamId)) { log("core_plan_press.other_workspace", {}); await tell(action.responseUrl, NOT_HERE_WORDS); return; }
      if (value.o === "REQUEST_CHANGES") {
        // The box asks for the words; what is decided is decided when it is sent. The press's trigger is good for a few seconds only.
        const context: Context = { r: value.r, v: value.v, d: value.d, t: action.thread.teamId, s: action.thread.channelId, h: action.thread.threadTs, u: action.userId, w: action.userTeamId, m: action.messageTs, x: [...action.messageText].slice(0, 1_500).join("") };
        const view = { ...(changesModal({ r: value.r, v: value.v, d: value.d, t: context.t, s: context.s, h: context.h, u: context.u, w: context.w }) as Record<string, unknown>), private_metadata: JSON.stringify(context) };
        try {
          await deps.openView(action.triggerId, view, Math.max(500, 2_500 - (now() - action.requestStartedAt)));
        } catch (error) {
          log("core_plan_press.box_failed", { errorName: errorName(error) });
          await tell(action.responseUrl, EXPIRED_WORDS);
        }
        return;
      }
      if (value.o !== "APPROVE") { await tell(action.responseUrl, NOT_HERE_WORDS); return; }
      // Slack's own id for this press: the same for every copy and retry of it, so it acts once.
      const eventId = /^[A-Za-z0-9._-]{1,128}$/u.test(action.triggerId) ? action.triggerId : action.actionTs ?? "";
      let answer: SlackCorePressAnswer;
      try {
        answer = await deps.ask({
          conversation: { channel: SLACK_CHANNEL, tenant: action.thread.teamId, space: action.thread.channelId, thread: action.thread.threadTs },
          actor: { channel: SLACK_CHANNEL, tenant: action.userTeamId, userId: action.userId }, eventId, requestId: value.r, expectedRevision: value.v, artifactDigest: value.d, decision: "APPROVE", reason: "Pressed in chat.",
        }, Math.max(500, 2_400 - (now() - action.requestStartedAt)));
      } catch (error) {
        // Nothing is known to be decided: the person may press again (a press that did commit is answered again as the repeat it is).
        log("core_plan_press.failed", { errorName: errorName(error) });
        await tell(action.responseUrl, NOT_SAVED_WORDS);
        return;
      }
      log("core_plan_press.answered", { decision: "APPROVE", status: answer.status, ...(answer.status === "refused" ? { reason: answer.reason } : {}) });
      if (answer.status === "refused") { await tell(action.responseUrl, decisionRefusalWords(answer.reason)); return; }
      if (answer.status === "duplicate") return;
      try { await deps.update({ channel: action.thread.channelId, ts: action.messageTs, ...decidedCard(action.messageText, APPROVED_CARD_WORDS) }); } catch (error) { log("core_plan_press.card_update_failed", { errorName: errorName(error) }); }
    },
  };
}

/**
 * The box's submission (`view_submission` of `CHANGES_CALLBACK`): the words typed are the reason of a request for changes. Undefined for any other form. The answer is Slack's own: the box clears, or shows what to fix on its one input. Only the
 * person who opened the box, from the workspace they opened it in, may send what is in it.
 */
export function corePlanSubmission(deps: CorePlanPressDeps): (payload: Record<string, unknown>) => Promise<Record<string, unknown> | undefined> {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
  return async (payload) => {
    const view = asRecord(payload.view);
    if (view.callback_id !== CHANGES_CALLBACK) return undefined;
    const started = now();
    let context: Context;
    try { context = ContextSchema.parse(JSON.parse(typeof view.private_metadata === "string" ? view.private_metadata : "")); } catch { log("core_plan_press.box_unreadable", {}); return { response_action: "clear" }; }
    const user = asRecord(payload.user);
    if (user.id !== context.u || user.team_id !== context.w || context.t !== context.w) { log("core_plan_press.box_other_person", {}); return { response_action: "clear" }; }
    const typed = asRecord(asRecord(asRecord(asRecord(view.state).values)[CHANGES_INPUT])["text"]).value;
    // The words are made safe the way the laptop makes them: no mention, no control character, one space between words, and cut.
    const reason = cleanChatText(typeof typed === "string" ? typed.slice(0, 20_000) : "", "U00000000", REASON_MAX);
    if (reason === "") return fieldError("Say what should change.");
    const eventId = typeof view.id === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(view.id) ? view.id : "";
    let answer: SlackCorePressAnswer;
    try {
      answer = await deps.ask({
        conversation: { channel: SLACK_CHANNEL, tenant: context.t, space: context.s, thread: context.h }, actor: { channel: SLACK_CHANNEL, tenant: context.w, userId: context.u },
        eventId, requestId: context.r, expectedRevision: context.v, artifactDigest: context.d, decision: "REQUEST_CHANGES", reason,
      }, Math.max(500, 2_600 - (now() - started)));
    } catch (error) {
      log("core_plan_press.failed", { errorName: errorName(error) });
      return fieldError(EDITING_FAILED_WORDS);
    }
    log("core_plan_press.answered", { decision: "REQUEST_CHANGES", status: answer.status, ...(answer.status === "refused" ? { reason: answer.reason } : {}) });
    if (answer.status === "refused") return fieldError(decisionRefusalWords(answer.reason));
    if (answer.status === "decided") {
      try { await deps.update({ channel: context.s, ts: context.m, ...decidedCard(context.x, CHANGES_CARD_WORDS) }); } catch (error) { log("core_plan_press.card_update_failed", { errorName: errorName(error) }); }
    }
    return { response_action: "clear" };
  };
}

/**
 * The press side's seams over the interactivity Lambda's own parts: the broker invoke (the route of `slack-core-decision.ts`), Slack's Web API with THIS company's token (`views.open` for the box, `chat.update` for the card), and the
 * private answer. Company mode only (the caller passes nothing otherwise). Kept here, and called on one line, so the interactivity file's line numbers (the company inventory's reviewed sites) do not move.
 */
export function corePlanDepsFrom(input: {
  invokeBroker(event: Record<string, unknown>, timeoutMs: number): Promise<{ statusCode?: number | undefined; body?: string | undefined }>;
  api(method: "views.open" | "chat.update", body: unknown, timeoutMs?: number): Promise<void>;
  respondEphemeral(responseUrl: string, text: string): Promise<void>;
  log: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;
}): CorePlanPressDeps {
  return {
    async ask(press, timeoutMs) {
      const answer = await input.invokeBroker({ source: "agentx.slack-ingress", action: "core-plan-press", press }, timeoutMs);
      if (answer.statusCode !== 200) throw new Error("the broker did not take the press");
      const body = JSON.parse(answer.body ?? "") as { status?: unknown; reason?: unknown } | null;
      if (body?.status === "decided" || body?.status === "duplicate") return { status: body.status };
      if (body?.status === "refused" && typeof body.reason === "string") return { status: "refused", reason: body.reason.slice(0, 64) };
      throw new Error("the broker's answer could not be read");
    },
    openView: async (triggerId, view, timeoutMs) => { await input.api("views.open", { trigger_id: triggerId, view }, timeoutMs); },
    respondEphemeral: (responseUrl, text) => input.respondEphemeral(responseUrl, text),
    update: async (update) => { await input.api("chat.update", update); },
    log: input.log,
  };
}
