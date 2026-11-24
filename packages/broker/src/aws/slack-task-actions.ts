// S1: the hosted press side of the task action registry. A card in a core task's thread carries buttons named `rovara_task:<action>`; this is what the interactivity Lambda does with a press, AFTER it verified Slack's signature and that the
// clicking account is a linked member of the workspace's company (`slack-interactivity.ts`, `slack-action-classes.ts`: the prefix is the member class, fine-grained rights are Code's). It decides NOTHING:
//   - a button that needs no form is a request to the core at once (`core-task-action`, in process on the broker side); the core judges it for whoever pressed (the linked person, who they are to the task, what is offered now, the
//     revision and digest the card named, the confirm digest) and the answer here is only words: done (the card gets one line, "Done in Slack: ..."), already done, or a REFUSAL, shown ONLY to the presser (ephemeral), never in the channel;
//   - a button that opens a form (its value says so: layout only) opens a loading view at once (a trigger is good for seconds), asks the core to DESCRIBE the move for the presser first (a refusal instead of a form, so a public card leaks
//     no finding text, close preview or money to someone who may not act), then shows the form the core's spec describes, with the confirm above its fields when the move has one;
//   - a submitted form is described again with what was entered: when the move now needs its confirm, the form is shown again with the confirm and what was typed (the digest of what it showed rides in the form); a submit that carries
//     the matching digest is the press. The core refuses a missing or wrong digest before any write, whatever this file does.
// Nothing here compares a message or checks a role. The Stop button of an older card (`agentx_workflow_stop`) is taken here only for a task the core owns (the old path refuses a core task); a task of the old workflow keeps its old path.
import { WORKFLOW_STOP_ACTION, ACTION_WORDS, SLACK_CHANNEL, TaskActionValueSchema, taskActionOfButtonId, type ActionOffer, type ActionResult, type ActionValues, type TaskActionId } from "@agentx/contracts";
import {
  TASK_ACTION_EXPIRED_WORDS, TASK_ACTION_FORM, TASK_ACTION_REPLAYED_WORDS, escapeText, loadingTaskModal, messageTaskModal, taskActionDoneLine, taskActionModal, taskActionRefusalWords, taskFormContextOf, valuesOfSubmission, type TaskFormContext,
} from "../plugins/channel/slack/index.js";
import type { TaskActionAnswer, TaskActionInput } from "../core-host/task-action-routes.js";
import type { SlackActionHandler, SlackBlockAction } from "./slack-interactivity.js";
import { slackWebFetch } from "./slack-web.js";
import { ownerOfTaskId } from "./engine-boundary.js";

/** What the press asks of the broker: the same shape the core takes, plus the answer's `notLinked` (the account is linked to nobody). */
export type TaskActionAsk = (press: TaskActionInput, timeoutMs: number) => Promise<TaskActionAnswer | { notLinked: true }>;

export interface TaskActionPressDeps {
  ask: TaskActionAsk;
  /** Whether the core owns this task (an older card's Stop button is taken here only then). */
  isCoreTask(taskId: string): Promise<boolean>;
  /** Opens a view for a press's trigger; answers the view's id (to update it once the core has described the move). */
  openView(triggerId: string, view: Record<string, unknown>, timeoutMs?: number): Promise<string | undefined>;
  updateView(viewId: string, view: Record<string, unknown>): Promise<void>;
  /** Says something to the presser only (Slack's response_url), with the buttons of what they may do next when there are any. */
  respondEphemeral(responseUrl: string, text: string, blocks?: unknown[]): Promise<void>;
  /** Replaces the card's message in place (Slack's `chat.update`, with the company's own token). */
  update(input: { channel: string; ts: string; text: string; blocks: unknown[] }): Promise<void>;
  /** The notice an unlinked account is shown (its link instructions); absent: the plain words. */
  linkNotice?(thread: SlackBlockAction["thread"], userId: string): Promise<string | undefined>;
  now?: () => number;
  log?: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;
}

const SECTION_MAX = 3_000;
/** Slack lets a view open for three seconds after a press; the core gets most of them. */
const TRIGGER_MS = 2_700;
const NOT_TAKEN_WORDS = "I couldn't take that. Press the button again.";
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

interface Pressed { id: TaskActionId; taskId: string; revision: number; digest?: string | undefined; dialog: boolean }

/** The action a button names and what it was shown, from its id and value; undefined for a button this release does not know (answered as expired). */
export function pressedOf(action: Pick<SlackBlockAction, "actionId" | "value">): Pressed | undefined {
  if (action.actionId === WORKFLOW_STOP_ACTION) {
    // The Stop button of the card a request that started on its own was given: its value is the task alone; a stop is the same whatever step runs.
    try {
      const taskId = (JSON.parse(action.value) as { taskId?: unknown }).taskId;
      return typeof taskId === "string" && /^[0-9a-f-]{36}$/u.test(taskId) ? { id: "task.stop", taskId, revision: 0, dialog: false } : undefined;
    } catch { return undefined; }
  }
  const id = taskActionOfButtonId(action.actionId);
  if (id === undefined) return undefined;
  try {
    const value = TaskActionValueSchema.parse(JSON.parse(action.value));
    return { id, taskId: value.t, revision: value.r, digest: value.d, dialog: value.n === 1 };
  } catch { return undefined; }
}

const presserOf = (action: SlackBlockAction) => ({
  conversation: { channel: SLACK_CHANNEL, tenant: action.thread.teamId, space: action.thread.channelId, thread: action.thread.threadTs },
  actor: { channel: SLACK_CHANNEL, tenant: action.userTeamId, userId: action.userId },
});

/** The card once the move was taken: its own words, no buttons, one line that says what was done. */
function decidedCard(text: string, done: string): { text: string; blocks: unknown[] } {
  const body = [...text].slice(0, SECTION_MAX).join("");
  return { text: `${body}\n${done}`, blocks: [{ type: "section", text: { type: "mrkdwn", text: body === "" ? escapeText(done) : body } }, { type: "context", elements: [{ type: "mrkdwn", text: escapeText(done) }] }] };
}

/** The ephemeral buttons of what the person may do next (the People view offers taking over): each is a button of the same registry, judged again at its press. */
function nextBlocks(next: readonly ActionOffer[], taskId: string, said: string): unknown[] {
  const elements = next.slice(0, 5).map((offer) => ({
    type: "button", action_id: `rovara_task:${offer.id}`, text: { type: "plain_text", text: offer.label.slice(0, 70) },
    value: JSON.stringify({ t: taskId, r: offer.binding.revision, ...(offer.binding.digest === undefined ? {} : { d: offer.binding.digest }), ...(offer.needsDialog ? { n: 1 } : {}) }),
  }));
  return [{ type: "section", text: { type: "mrkdwn", text: escapeText(said).slice(0, SECTION_MAX) } }, ...(elements.length === 0 ? [] : [{ type: "actions", elements }])];
}

export function taskActionPressHandler(deps: TaskActionPressDeps): SlackActionHandler & { claims(action: SlackBlockAction): Promise<boolean> } {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const tell = async (responseUrl: string, text: string, blocks?: unknown[]): Promise<void> => {
    try { await deps.respondEphemeral(responseUrl, text, blocks); } catch (error) { log("task_action.respond_failed", { errorName: errorName(error) }); }
  };
  const remaining = (action: SlackBlockAction): number => Math.max(500, TRIGGER_MS - (now() - action.requestStartedAt));

  /** What a result becomes: the card's line, or private words. Never anything in the channel for a refusal. */
  async function settle(action: SlackBlockAction, id: TaskActionId, taskId: string, result: ActionResult | { notLinked: true }): Promise<void> {
    if ("notLinked" in result) { await tell(action.responseUrl, (await deps.linkNotice?.(action.thread, action.userId).catch(() => undefined)) ?? taskActionRefusalWords("not_linked")); return; }
    if (result.status === "refused") { await tell(action.responseUrl, taskActionRefusalWords(result.reason, result.writes)); return; }
    if (result.status === "replayed") { await tell(action.responseUrl, TASK_ACTION_REPLAYED_WORDS); return; }
    if (result.said !== undefined) { const next = result.status === "done" ? result.next : undefined; await tell(action.responseUrl, result.said, next === undefined ? undefined : nextBlocks(next, taskId, result.said)); return; }
    try { await deps.update({ channel: action.thread.channelId, ts: action.messageTs, ...decidedCard(action.messageText, taskActionDoneLine(id)) }); } catch (error) { log("task_action.card_update_failed", { errorName: errorName(error) }); }
  }

  async function direct(action: SlackBlockAction, pressed: Pressed): Promise<void> {
    let answer: TaskActionAnswer | { notLinked: true };
    try {
      answer = await deps.ask({
        mode: "perform", actionId: pressed.id, taskId: pressed.taskId, binding: { revision: pressed.revision, ...(pressed.digest === undefined ? {} : { digest: pressed.digest }) },
        requestKey: `button:${action.messageTs}:${action.actionTs ?? ""}:${action.actionId}:${action.userId}`, ...presserOf(action),
      }, 2_800);
    } catch (error) {
      // Nothing is known to be done: the person may press again (a press that did commit is answered again as the repeat it is).
      log("task_action.failed", { errorName: errorName(error) });
      await tell(action.responseUrl, NOT_TAKEN_WORDS);
      return;
    }
    if ("notLinked" in answer) { await settle(action, pressed.id, pressed.taskId, answer); return; }
    if (answer.mode !== "perform") { await tell(action.responseUrl, NOT_TAKEN_WORDS); return; }
    // The core wants a form or a confirm the card did not say it needed: while the trigger lives, open it (the press is described, not made).
    if (answer.result.status === "refused" && answer.result.reason === "needs_input" && action.triggerId !== "" && now() - action.requestStartedAt < TRIGGER_MS - 500) { await dialog(action, pressed); return; }
    log("task_action.answered", { action: pressed.id, status: answer.result.status, ...(answer.result.status === "refused" ? { reason: answer.result.reason, writes: answer.result.writes } : {}) });
    await settle(action, pressed.id, pressed.taskId, answer.result);
  }

  async function dialog(action: SlackBlockAction, pressed: Pressed): Promise<void> {
    const label = ACTION_WORDS[pressed.id].label;
    let viewId: string | undefined;
    try { viewId = await deps.openView(action.triggerId, loadingTaskModal(label), remaining(action)); } catch (error) {
      log("task_action.open_failed", { errorName: errorName(error) });
      await tell(action.responseUrl, TASK_ACTION_EXPIRED_WORDS);
      return;
    }
    const show = async (view: Record<string, unknown>): Promise<void> => { if (viewId !== undefined) await deps.updateView(viewId, view).catch((error: unknown) => log("task_action.update_failed", { errorName: errorName(error) })); };
    let answer: TaskActionAnswer | { notLinked: true };
    try {
      answer = await deps.ask({ mode: "describe", actionId: pressed.id, taskId: pressed.taskId, binding: { revision: pressed.revision, ...(pressed.digest === undefined ? {} : { digest: pressed.digest }) }, ...presserOf(action) }, 2_800);
    } catch (error) {
      log("task_action.describe_failed", { errorName: errorName(error) });
      await show(messageTaskModal(label, NOT_TAKEN_WORDS));
      return;
    }
    if ("notLinked" in answer) { await show(messageTaskModal(label, (await deps.linkNotice?.(action.thread, action.userId).catch(() => undefined)) ?? taskActionRefusalWords("not_linked"))); return; }
    if (answer.mode !== "describe") { await show(messageTaskModal(label, NOT_TAKEN_WORDS)); return; }
    const description = answer.description;
    // A refusal is answered INSTEAD of a form: someone who may not act sees no finding, no close preview, no figure.
    if (description.status === "refused") { await show(messageTaskModal(label, taskActionRefusalWords(description.reason))); return; }
    const context: TaskFormContext = {
      a: pressed.id, t: pressed.taskId, r: pressed.revision, ...(pressed.digest === undefined ? {} : { d: pressed.digest }), ...(description.confirmDigest === undefined ? {} : { c: description.confirmDigest }),
      s: action.thread.teamId, h: action.thread.channelId, ts: action.thread.threadTs, u: action.userId, w: action.userTeamId, m: action.messageTs, x: action.messageText,
    };
    await show(taskActionModal({ label: description.label, spec: description.spec, confirm: description.confirm, context }));
  }

  return {
    matches: (actionId) => taskActionOfButtonId(actionId) !== undefined,
    async claims(action) {
      if (taskActionOfButtonId(action.actionId) !== undefined) return true;
      if (action.actionId !== WORKFLOW_STOP_ACTION) return false;
      const pressed = pressedOf(action);
      // A stamp that cannot be read is claimed too: the older path would refuse a core task with "Only the task owner can stop this task", which is not true; `handle` says the real reason.
      return pressed !== undefined && await deps.isCoreTask(pressed.taskId).catch(() => true);
    },
    async handle(action) {
      const pressed = pressedOf(action);
      if (pressed === undefined) { await tell(action.responseUrl, TASK_ACTION_EXPIRED_WORDS); return; }
      // The person's own workspace is the thread's (a guest from a shared channel, or a click through another workspace, gets nothing); the core checks it again.
      if (action.userTeamId !== action.thread.teamId || (action.workspaceTeamId !== "" && action.workspaceTeamId !== action.thread.teamId)) { log("task_action.other_workspace", {}); await tell(action.responseUrl, taskActionRefusalWords("not_found")); return; }
      // An older Stop card whose task's engine could not be read: nothing was done, and the person is told so (a stable reason), not that they are not the owner.
      if (action.actionId === WORKFLOW_STOP_ACTION && !(await deps.isCoreTask(pressed.taskId).catch(() => false))) { await tell(action.responseUrl, taskActionRefusalWords("unavailable")); return; }
      if (pressed.dialog && action.triggerId !== "") await dialog(action, pressed); else await direct(action, pressed);
    },
  };
}

/** What a form submission is judged as: the form's own context, the person who sent it, what was entered, and who the core is told is pressing. */
interface Submitted { context: TaskFormContext; label: string; values: ActionValues; presser: ReturnType<typeof presserOf2>; binding: { revision: number; digest?: string } }
const presserOf2 = (context: TaskFormContext) => ({ conversation: { channel: SLACK_CHANNEL, tenant: context.s, space: context.h, thread: context.ts }, actor: { channel: SLACK_CHANNEL, tenant: context.w, userId: context.u } });
type View = Record<string, unknown>;
const refusedView = (label: string, text: string): View => ({ response_action: "update", view: messageTaskModal(label, text) });

/** The form shown again: with the confirm (and what was typed), and a note above it. */
function formAgain(sent: Submitted, note: string, shown: { confirmDigest?: string | undefined; confirm?: Parameters<typeof taskActionModal>[0]["confirm"]; spec?: Parameters<typeof taskActionModal>[0]["spec"] }): View {
  return { response_action: "update", view: taskActionModal({ label: sent.label, spec: shown.spec ?? { fields: [] }, confirm: shown.confirm, context: { ...sent.context, ...(shown.confirmDigest === undefined ? {} : { c: shown.confirmDigest }) }, values: sent.values, note }) };
}

/** What the core would show for what was entered (a move that needs its confirm now shows it first), then the move itself when the confirm that was shown is the one carried. */
async function submitForm(deps: TaskActionPressDeps, sent: Submitted, viewId: string): Promise<View> {
  const { context } = sent;
  const described = await deps.ask({ mode: "describe", actionId: context.a, taskId: context.t, binding: sent.binding, values: sent.values, ...sent.presser }, 2_000);
  if ("notLinked" in described) return refusedView(sent.label, taskActionRefusalWords("not_linked"));
  if (described.mode !== "describe") return refusedView(sent.label, NOT_TAKEN_WORDS);
  const description = described.description;
  if (description.status === "refused") return refusedView(sent.label, taskActionRefusalWords(description.reason));
  if (description.confirm !== undefined && description.confirmDigest !== context.c) return formAgain(sent, "Review this, then press the button again to go ahead.", description);
  const requestKey = `view:${viewId}:${context.a}:${String(context.r)}:${context.d ?? ""}`;
  const done = await deps.ask({ mode: "perform", actionId: context.a, taskId: context.t, binding: sent.binding, values: sent.values, ...(context.c === undefined ? {} : { confirmDigest: context.c }), requestKey, ...sent.presser }, 2_600);
  if ("notLinked" in done) return refusedView(sent.label, taskActionRefusalWords("not_linked"));
  if (done.mode !== "perform") return refusedView(sent.label, NOT_TAKEN_WORDS);
  return await settleSubmitted(deps, sent, done.result, { ...description, confirmDigest: context.c });
}

/** What a performed submission becomes: the form closes (the card gets its one line), or it is shown again, or it says why not. */
async function settleSubmitted(deps: TaskActionPressDeps, sent: Submitted, result: ActionResult, shown: Parameters<typeof formAgain>[2]): Promise<View> {
  const { context } = sent;
  const log = deps.log ?? (() => undefined);
  log("task_action.answered", { action: context.a, status: result.status, ...(result.status === "refused" ? { reason: result.reason, writes: result.writes } : {}) });
  if (result.status === "refused") return result.reason === "needs_input" ? formAgain(sent, "Fill in what is needed, then press the button again.", shown) : refusedView(sent.label, taskActionRefusalWords(result.reason, result.writes));
  if (result.status === "replayed") return { response_action: "clear" };
  if (result.said !== undefined) return refusedView(sent.label, result.said);
  try { await deps.update({ channel: context.h, ts: context.m, ...decidedCard(context.x ?? "", taskActionDoneLine(context.a)) }); } catch (error) { log("task_action.card_update_failed", { errorName: errorName(error) }); }
  return { response_action: "clear" };
}

/**
 * The form's submission (`view_submission` of `TASK_ACTION_FORM`): undefined for any other form. The answer is Slack's own: the form closes, or is shown again (with the confirm, or a note). Only the person who opened the form, from the
 * workspace they opened it in, may send what is in it.
 */
export function taskActionSubmission(deps: TaskActionPressDeps): (payload: Record<string, unknown>) => Promise<Record<string, unknown> | undefined> {
  const log = deps.log ?? (() => undefined);
  const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
  return async (payload) => {
    const view = asRecord(payload.view);
    if (view.callback_id !== TASK_ACTION_FORM) return undefined;
    const context = taskFormContextOf(view);
    const user = asRecord(payload.user);
    if (context === undefined || user.id !== context.u || user.team_id !== context.w || context.s !== context.w) { log("task_action.form_refused", {}); return { response_action: "clear" }; }
    const sent: Submitted = { context, label: ACTION_WORDS[context.a].label, values: valuesOfSubmission(view), presser: presserOf2(context), binding: { revision: context.r, ...(context.d === undefined ? {} : { digest: context.d }) } };
    try {
      return await submitForm(deps, sent, typeof view.id === "string" ? view.id : "");
    } catch (error) {
      log("task_action.failed", { errorName: errorName(error) });
      return refusedView(sent.label, NOT_TAKEN_WORDS);
    }
  };
}

/**
 * The press side's seams over the interactivity Lambda's own parts: the broker invoke (the route of `slack-core-task-action.ts`), Slack's Web API with THIS company's token (`views.open` for the form, `views.update` once the core has
 * described the move, `chat.update` for the card), and the private answer. Company mode only (the caller passes nothing otherwise). Kept here, and called on one line, so the interactivity file's line numbers (the company inventory's reviewed sites) do not move.
 */
export function taskActionDepsFrom(input: {
  invokeBroker(event: Record<string, unknown>, timeoutMs: number): Promise<{ statusCode?: number | undefined; body?: string | undefined }>;
  api(method: "views.open" | "views.update" | "chat.update", body: unknown, timeoutMs?: number): Promise<unknown>;
  respondEphemeral(responseUrl: string, text: string, blocks?: unknown[]): Promise<void>;
  isCoreTask(taskId: string): Promise<boolean>;
  linkNotice?: TaskActionPressDeps["linkNotice"];
  log: NonNullable<TaskActionPressDeps["log"]>;
}): TaskActionPressDeps {
  return {
    async ask(press, timeoutMs) {
      const answer = await input.invokeBroker({ source: "agentx.slack-ingress", action: "core-task-action", press }, timeoutMs);
      if (answer.statusCode !== 200) throw new Error("the broker did not take the press");
      const body = JSON.parse(answer.body ?? "") as { mode?: unknown; notLinked?: unknown } | null;
      if (body?.notLinked === true) return { notLinked: true };
      if (body?.mode === "describe" || body?.mode === "perform") return body as TaskActionAnswer;
      throw new Error("the broker's answer could not be read");
    },
    isCoreTask: (taskId) => input.isCoreTask(taskId),
    openView: async (triggerId, view, timeoutMs) => {
      const opened = await input.api("views.open", { trigger_id: triggerId, view }, timeoutMs) as { view?: { id?: unknown } } | undefined;
      return typeof opened?.view?.id === "string" ? opened.view.id : undefined;
    },
    updateView: async (viewId, view) => { await input.api("views.update", { view_id: viewId, view }); },
    respondEphemeral: (url, text, blocks) => input.respondEphemeral(url, text, blocks),
    update: async (update) => { await input.api("chat.update", update); },
    ...(input.linkNotice === undefined ? {} : { linkNotice: input.linkNotice }),
    log: input.log,
  };
}

/** Slack's Web API with the answer's body (`views.open` answers the view's id), for the form's two steps. Fails on a refusal as `slackApi` does. */
export async function slackApiResult(token: string, method: string, body: unknown, fetchImplementation: typeof fetch = fetch, timeoutMs = 2_000): Promise<unknown> {
  const response = await slackWebFetch(method, token, { body, signal: AbortSignal.timeout(timeoutMs), redirect: "error" }, fetchImplementation);
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok || result["ok"] !== true) throw new Error(`Slack ${method} failed: ${typeof result["error"] === "string" ? result["error"] : `HTTP ${String(response.status)}`}`);
  return result;
}

/** A press's answer to the presser alone, with the buttons of what they may do next when there are any (Slack's response_url). */
export async function respondEphemeralBlocks(responseUrl: string, text: string, blocks?: unknown[], fetchImplementation: typeof fetch = fetch): Promise<void> {
  const response = await fetchImplementation(responseUrl, {
    method: "POST", signal: AbortSignal.timeout(2_000), redirect: "error", headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text, ...(blocks === undefined ? {} : { blocks }) }),
  });
  if (!response.ok) throw new Error(`Slack response_url failed: HTTP ${String(response.status)}`);
}

/** The registry's handler when it claims this press, else nothing (the older handlers take it). A claim that fails is no claim. */
export async function registryHandlerFor(handler: { claims(action: SlackBlockAction): Promise<boolean>; handle(action: SlackBlockAction): Promise<void> } | undefined, action: SlackBlockAction): Promise<{ matches: () => boolean; handle: (value: SlackBlockAction) => Promise<void> } | undefined> {
  if (handler === undefined || !(await handler.claims(action).catch(() => false))) return undefined;
  return { matches: () => true, handle: (value) => handler.handle(value) };
}

/** The registry's form submission and the plan card's own (`corePlan`, when the host has one) as one: the first that takes the form answers it; nothing when neither exists. */
export function firstSubmission<Plan>(registry: ((payload: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>) | undefined, plan: Plan | undefined, planSubmission: (plan: Plan) => (payload: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>): ((payload: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>) | undefined {
  const present = [registry, plan === undefined ? undefined : planSubmission(plan)].filter((handler): handler is NonNullable<typeof handler> => handler !== undefined);
  if (present.length === 0) return undefined;
  return async (payload) => {
    for (const handler of present) { const taken = await handler(payload); if (taken !== undefined) return taken; }
    return undefined;
  };
}

/**
 * The interactivity Lambda's registry press side, in company mode only (`enabled`): the handler and the form's submission over the broker invoke, Slack's Web API with THIS company's token, and the state table's engine stamp (an older card's
 * Stop button is taken only for a task the core owns). One line at the call site, so the interactivity file's reviewed sites do not move.
 */
export function awsTaskActionPress(input: {
  enabled: boolean;
  invokeBroker(event: Record<string, unknown>, timeoutMs: number): Promise<{ statusCode?: number | undefined; body?: string | undefined }>;
  token(): Promise<string>;
  /** The state table, whose engine stamp says whether the core owns a task (an older card's Stop button is taken only then). */
  stateTable: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string | undefined };
  log: NonNullable<TaskActionPressDeps["log"]>;
}): { handler: ReturnType<typeof taskActionPressHandler>; submission: ReturnType<typeof taskActionSubmission> } | undefined {
  if (!input.enabled) return undefined;
  const deps = taskActionDepsFrom({
    invokeBroker: (event, timeoutMs) => input.invokeBroker(event, timeoutMs), api: async (method, body, timeoutMs) => slackApiResult(await input.token(), method, body, fetch, timeoutMs),
    respondEphemeral: (url, text, blocks) => respondEphemeralBlocks(url, text, blocks), log: input.log,
    isCoreTask: async (taskId) => input.stateTable.tableName !== undefined && await ownerOfTaskId({ documentClient: input.stateTable.documentClient, tableName: input.stateTable.tableName }, taskId) === "core",
  });
  return { handler: taskActionPressHandler(deps), submission: taskActionSubmission(deps) };
}
