// Lane L8: sessions from the command line. `agentx sessions`, `agentx session start | show | follow | unfollow | comment | tell | answer | stop | retry |
// take-over | share`, each one or two signed-in calls to the broker's /v1/app routes. The broker decides who may do
// what; a refusal (SESSION_LEVEL_REQUIRED, FORBIDDEN, LOCAL_AGENT_NOT_ALLOWED, ...) is printed as the server wrote it, made safe for a terminal.
// Left out of Cloud's file: the Live wall, `home` (Cloud's web feed), `session merge` (merge belongs to the merge lane and the code host's own button)
// and `session link --linear` (a tracker is an adapter; decision 51).
//
// A take-over and a share with the whole company answer `202 NEEDS_CONFIRMATION`: they wait for the person on a confirmation page. That answer is
// not an expired sign-in. It is printed as a link and exits 0, and it never goes near a fresh sign-in (`withFreshSignIn` is not used here).
// Nothing in this file decides an approval (R66).
import { randomUUID } from "node:crypto";
import {
  AGENTX_NAME_PATTERN, CLI_PACKAGE_NAME, INTENT_NOT_WAITING_MESSAGE, LEVEL_WORDS, YOUR_CALL_WORDS, NeedsConfirmationReaderSchema, SESSION_LEVELS, SessionIdSchema, sessionTaskStatus, taskStatusText, TASK_VIEW_HEADER, TASK_VIEW_VERSION, agentXError, sessionLink,
  type SessionLevel,
} from "@agentx/contracts";
import type { DeveloperSessionDeps } from "../developer/session.js";
import { appRequest, clean, developerRef, list, result, seg, str, type AppResult } from "./app-request.js";

type Body = Record<string, unknown>;

/** The longest text one comment or message may hold (the control plane's limit). */
const TEXT_MAX = 10_000;
/** The characters a web address may hold. Anything else (a space, a control or bidi character, a quote) is not printed. */
const SAFE_URL = /^https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%[\]-]+$/;
/** The hosts of an install on this computer, whose local pages are plain http. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);
const URL_MAX = 2048;
const UNEXPECTED = `AgentX answered with something unexpected; try again, or upgrade: npx ${CLI_PACKAGE_NAME}@latest whoami`;

/**
 * A server's web address, only when it is plainly an https address (or, when the install itself is on this computer's loopback, an http one) on the
 * control plane's own origin (the environment's URL) with no user name or password in it. This is where a person is told to sign in or decide, so a link to another host, port or `host@evil` address is never printed.
 */
export function safeUrl(value: unknown, origin: string): string | undefined {
  if (typeof value !== "string" || value.length > URL_MAX || !SAFE_URL.test(value)) return undefined;
  try {
    const url = new URL(value);
    const base = new URL(origin);
    const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && base.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && LOOPBACK_HOSTS.has(base.hostname));
    return schemeOk && url.username === "" && url.password === "" && url.origin === base.origin ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A session ID the person typed; one that cannot be a session is refused before anything is sent. */
function sessionIdOf(id: string): string {
  if (!SessionIdSchema.safeParse(id).success) throw agentXError("CONFIG_INVALID", "that is not a session ID; run agentx sessions to see yours");
  return id;
}

const sessionPath = (id: string, rest = "") => `/v1/app/sessions/${seg(sessionIdOf(id))}${rest}`;

/** The link to a session: the server's own when it is a plain https address, else built from the ID. */
const linkOf = (origin: string, sessionId: string, given?: unknown): string => safeUrl(given, origin) ?? sessionLink(origin, sessionId);

/** UX2 slice 2: a session's status in the one status model's words, from its summary (`display` when the server wrote one). */
const statusWords = (status: unknown, display?: unknown): string => (typeof status === "string" ? clean(taskStatusText(sessionTaskStatus({ status, display }))) : "Status unavailable");
const levelWords = (level: unknown): string => (typeof level === "string" && level in LEVEL_WORDS ? LEVEL_WORDS[level as SessionLevel] : str(level, "unknown"));
const money = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "unknown");
const nameOf = (value: unknown): string => str((value as Body | undefined)?.name, "someone");

// ---- a take-over and a company share wait for a person

/**
 * The text for a `202 NEEDS_CONFIRMATION` answer: what would change, then the link where the person confirms it. Only a plain https address is ever
 * printed; an answer without one is an unexpected answer, not a confirmation.
 */
function confirmationOf(answer: { env: string; url: string; body: Body }): AppResult {
  const parsed = NeedsConfirmationReaderSchema.safeParse(answer.body);
  if (!parsed.success || safeUrl(parsed.data.confirmUrl, answer.url) === undefined) {
    throw agentXError("RUNTIME_UNAVAILABLE", UNEXPECTED);
  }
  const { confirmUrl, changes } = parsed.data;
  const lines = ["This waits for you to confirm it. Nothing has changed yet.", ...changes.map((change) => `  - ${clean(change)}`), `Confirm this in your browser: ${confirmUrl}`, ""];
  return result(answer, { status: parsed.data.status, confirmUrl, changes }, lines.join("\n"));
}

// ---- the lists

const tileLine = (tile: Body): string => `  ${str(tile.sessionId)}  ${statusWords((tile.summary as Body | undefined)?.status, (tile.summary as Body | undefined)?.display)}  ${str(tile.title)}${tile.project === undefined ? "" : `  ${str(tile.project)}`}  ${nameOf(tile.owner)}`;

export async function sessionsList(
  deps: DeveloperSessionDeps, env: string | undefined, input: { mine?: boolean; shared?: boolean; project?: string; cursor?: string },
): Promise<AppResult> {
  const cursor = input.cursor === undefined ? "" : `&cursor=${encodeURIComponent(input.cursor)}`;
  const chosen = [input.mine === true, input.shared === true, input.project !== undefined].filter(Boolean).length;
  if (chosen > 1) throw agentXError("CONFIG_INVALID", "give one of --mine, --shared and --project");
  const scope = input.shared === true ? "shared=me" : input.project !== undefined ? `project=${seg(input.project)}` : "owner=me";
  const answer = await appRequest(deps, env, `/v1/app/sessions?${scope}${cursor}`);
  const sessions = list(answer.body.sessions);
  const next = typeof answer.body.next === "string" ? answer.body.next : undefined;
  const flag = input.shared === true ? " --shared" : input.project !== undefined ? ` --project ${str(input.project)}` : "";
  const lines = sessions.length === 0 ? [`No sessions here on ${answer.env}.`] : [`Sessions on ${answer.env} (${answer.url}):`, ...sessions.map(tileLine)];
  return result(answer, { sessions, ...(next === undefined ? {} : { next }) }, `${[...lines, ...(next === undefined ? [] : [`More: agentx sessions${flag} --cursor ${str(next)}`])].join("\n")}\n`);
}

// ---- one session

/** A session's header in a few lines, with its link. */
function headline(origin: string, view: Body, fallbackId: string): string[] {
  const sessionId = typeof view.sessionId === "string" && SessionIdSchema.safeParse(view.sessionId).success ? view.sessionId : fallbackId;
  const where = view.where as Body | undefined;
  const placed = where?.kind === "mac" ? `on ${str(where.label, "a Mac")}'s Mac${where.offline === true ? " (offline)" : ""}` : "on a worker machine";
  return [
    `${str(view.title, "(no title)")}`,
    `  ${linkOf(origin, sessionId, view.link)}`,
    `  ${statusWords(view.status, view.display)}${view.step === undefined ? "" : `: ${str(view.step)}`}`,
    `  ${view.project === undefined ? "" : `project ${str(view.project)}; `}owned by ${nameOf(view.owner)}; runs ${placed}`,
  ];
}

export async function sessionShow(deps: DeveloperSessionDeps, env: string | undefined, id: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, sessionPath(id));
  const view = (answer.body.session ?? {}) as Body;
  const you = (view.you ?? {}) as Body;
  const cost = (view.cost ?? {}) as Body;
  const approvals = list(view.approvals);
  const lines = [
    ...headline(answer.url, view, id),
    `  spent ${money(cost.spentUsd)}; you ${levelWords(you.level)}${you.owner === true ? " (you own it)" : ""}${you.following === true ? "; you follow it" : ""}`,
    ...(view.peek === undefined ? [] : [`  now: ${str(view.peek)}`]),
    ...(approvals.length === 0 ? [] : ["  waiting for you:", ...approvals.map((approval) => `    - ${str(approval.title)}: ${safeUrl(approval.confirmUrl, answer.url) ?? "(open it in the app)"}`)]),
  ];
  return result(answer, answer.body, `${lines.join("\n")}\n`);
}

export async function sessionFollow(deps: DeveloperSessionDeps, env: string | undefined, id: string, follow: boolean): Promise<AppResult> {
  const answer = await appRequest(deps, env, sessionPath(id, "/follow"), { method: follow ? "POST" : "DELETE" });
  const text = answer.body.following === true ? `You are following ${sessionIdOf(id)}. You will be told when it needs you.` : `You are no longer following ${sessionIdOf(id)}.`;
  return result(answer, answer.body, `${text}\n${linkOf(answer.url, id)}\n`);
}

/** `comment` (people read it) or `tell` (a message to the agent: the next step reads it). */
export async function sessionSay(deps: DeveloperSessionDeps, env: string | undefined, id: string, kind: "comment" | "steer", text: string): Promise<AppResult> {
  if (text.trim() === "") throw agentXError("CONFIG_INVALID", `give the ${kind === "comment" ? "comment" : "message"} as text`);
  if ([...text].length > TEXT_MAX) throw agentXError("CONFIG_INVALID", `the text is longer than ${TEXT_MAX.toLocaleString("en-US")} characters`);
  const answer = await appRequest(deps, env, sessionPath(id, "/messages"), { method: "POST", body: { requestId: randomUUID(), kind, text } });
  const delivery = (answer.body.delivery ?? {}) as Body;
  const fate = kind === "comment" ? "Commented."
    : delivery.state === "queued" ? "Queued: the agent reads your message at its next step."
      : delivery.state === "delivered" ? "Delivered to the agent."
        : delivery.state === "not_delivered" ? `Not delivered${delivery.reason === undefined ? "" : `: ${str(delivery.reason)}`}.`
          : "Sent to the agent.";
  return result(answer, answer.body, `${fate}\n${linkOf(answer.url, id)}\n`);
}

/** `stop` and `retry`: each answers the session that carries on, which for a retry may be a new one. */
export async function sessionControl(deps: DeveloperSessionDeps, env: string | undefined, id: string, action: "stop" | "retry"): Promise<AppResult> {
  const answer = await appRequest(deps, env, sessionPath(id, `/${action}`), { method: "POST", body: { requestId: randomUUID() } });
  const view = (answer.body.session ?? {}) as Body;
  const fresh = typeof view.sessionId === "string" && view.sessionId !== id;
  const first = action === "stop" ? (answer.body.stop === "NOTHING_RUNNING" ? (typeof answer.body.message === "string" && answer.body.message !== "" ? answer.body.message : "Nothing was running to stop.") : "Stop requested.") : fresh ? "Started a new session." : "Retrying.";
  return result(answer, answer.body, `${[first, ...headline(answer.url, view, id)].join("\n")}\n`);
}

/** `take-over`: asks for it. The answer is always a link where the asker confirms it (202); nothing changes before that. */
export async function sessionTakeOver(deps: DeveloperSessionDeps, env: string | undefined, id: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, sessionPath(id, "/take-over"), { method: "POST", body: { requestId: randomUUID() } });
  if (answer.status !== 202) throw agentXError("RUNTIME_UNAVAILABLE", UNEXPECTED);
  return confirmationOf(answer);
}

// ---- sharing

export async function sessionShare(deps: DeveloperSessionDeps, env: string | undefined, id: string, input: { with?: string; level?: string }): Promise<AppResult> {
  sessionIdOf(id);
  if (input.with === undefined || input.with.trim() === "") throw agentXError("CONFIG_INVALID", "say who with --with <email|project:<name>|company>");
  if (input.level === undefined || !(SESSION_LEVELS as readonly string[]).includes(input.level)) throw agentXError("CONFIG_INVALID", `say how much with --level ${SESSION_LEVELS.join("|")}`);
  const level = input.level as SessionLevel;
  const target = input.with.trim();
  let principal: Body;
  let who: string;
  if (target.toLowerCase() === "company") {
    principal = { kind: "org" };
    who = "everyone in your company";
  } else if (target.toLowerCase().startsWith("project:")) {
    const project = target.slice("project:".length);
    if (!AGENTX_NAME_PATTERN.test(project)) throw agentXError("CONFIG_INVALID", "--with project:<name> needs a project's exact name");
    principal = { kind: "project", project };
    who = `the ${project} project`;
  } else {
    const member = await developerRef(deps, env, target);
    principal = { kind: "member", developerId: member.developerId };
    who = clean(member.name);
  }
  const answer = await appRequest(deps, env, sessionPath(id, "/shares"), { method: "PUT", body: { requestId: randomUUID(), principal, level } });
  if (answer.status === 202 || answer.body.status === "NEEDS_CONFIRMATION") return confirmationOf(answer);
  if (answer.body.share === undefined) throw agentXError("RUNTIME_UNAVAILABLE", UNEXPECTED);
  return result(answer, answer.body, `Shared with ${who} (${LEVEL_WORDS[level]}).\n${linkOf(answer.url, id)}\n`);
}

// ---- starting work (slice 5)

/** The longest instructions one start carries (the control plane's limit is checked there again). */
const INSTRUCTIONS_MAX_BYTES = 65_536;

/**
 * `session start --project <name> <instructions>` starts Rovara Code on a project, as the signed-in person (the control plane decides whether they may, and at whose cost), and prints the task and
 * the link to its page. `--workflow quick|full` asks for the plan-first workflow. The request id is new for each call; the control plane answers a repeat of one start with the same task.
 */
export async function sessionStart(deps: DeveloperSessionDeps, env: string | undefined, input: { project?: string | undefined; instructions: string; title?: string | undefined; workflow?: string | undefined }): Promise<AppResult> {
  const project = input.project?.trim();
  if (project === undefined || project === "" || project.length > 200) throw agentXError("CONFIG_INVALID", "name the project with --project <name>");
  const instructions = input.instructions.trim();
  if (instructions === "" || Buffer.byteLength(instructions, "utf8") > INSTRUCTIONS_MAX_BYTES) throw agentXError("CONFIG_INVALID", "give the instructions, at most 65,536 bytes");
  if (input.title !== undefined && input.title.length > 120) throw agentXError("CONFIG_INVALID", "--title is at most 120 characters");
  if (input.workflow !== undefined && input.workflow !== "quick" && input.workflow !== "full") throw agentXError("CONFIG_INVALID", "--workflow is quick or full");
  const answer = await appRequest(deps, env, "/v1/dev/tasks", {
    method: "POST",
    body: {
      requestId: randomUUID(), project, instructions, client: "agentx-cli",
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.workflow === undefined ? {} : { workflow: true, workflowPath: input.workflow === "full" ? "FULL" : "QUICK" }),
    },
  });
  const task = answer.body.task as Body | undefined;
  if (task === undefined || typeof task.taskId !== "string") throw agentXError("RUNTIME_UNAVAILABLE", UNEXPECTED);
  const sessionId = typeof task.sessionId === "string" && SessionIdSchema.safeParse(task.sessionId).success ? task.sessionId : undefined;
  const link = sessionId === undefined ? undefined : linkOf(answer.url, sessionId, task.sessionUrl);
  return result(answer, { taskId: task.taskId, ...(sessionId === undefined ? {} : { sessionId }), ...(link === undefined ? {} : { link }) },
    `Started task ${str(task.taskId)} on ${clean(project)}.\n${link === undefined ? "Follow it with agentx sessions." : `Follow it here: ${link}`}\n`);
}

// ---- naming a session by its task

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The session a person named: a session ID, or a task ID, whose session is asked for. */
async function sessionOfRef(deps: DeveloperSessionDeps, env: string | undefined, ref: string): Promise<string> {
  if (SessionIdSchema.safeParse(ref).success) return ref;
  if (!TASK_ID.test(ref)) throw agentXError("CONFIG_INVALID", "give a session ID (ses_...) from agentx sessions, or a task ID");
  const answer = await appRequest(deps, env, `/v1/dev/tasks/${seg(ref)}`);
  const sessionId = (answer.body.task as Body | undefined)?.sessionId;
  if (typeof sessionId !== "string" || !SessionIdSchema.safeParse(sessionId).success) throw agentXError("CONFIG_INVALID", "that task has no session, so there is nothing to link; start the work from the app or with agentx session start to get a session");
  return sessionId;
}

// ---- Rovara Code's questions (Plan 6 Task 5, with the Task 25 slice)

interface AskedQuestion { id: string; text: string; options: Array<{ id: string; label: string }>; recommended?: string }

/** The round and the questions a task waits on, from its view; undefined when it is not waiting for answers. The questions are a model's words: they are made safe for a terminal where they are printed. */
function askedQuestions(task: Body): { round: number; questions: AskedQuestion[] } | undefined {
  const workflow = (task.workflow ?? {}) as Body;
  const intent = (workflow.intent ?? {}) as Body;
  const assessment = (intent.assessment ?? {}) as Body;
  if (workflow.stage !== "UNDERSTAND" || workflow.state !== "WAITING" || assessment.kind !== "questions" || typeof intent.rounds !== "number") return undefined;
  const questions = list(assessment.questions).flatMap((question): AskedQuestion[] => (typeof question.id === "string" && typeof question.text === "string" ? [{
    id: question.id, text: question.text,
    options: list(question.options).flatMap((option) => (typeof option.id === "string" && typeof option.label === "string" ? [{ id: option.id, label: option.label }] : [])),
    ...(typeof question.recommended === "string" ? { recommended: question.recommended } : {}),
  }] : []));
  return questions.length === 0 ? undefined : { round: intent.rounds, questions };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * `session answer <task-or-session> [--q1 <option|text> [--q2 ...]]` answers the questions Rovara Code asked before it plans, on the route the app uses
 * (`POST /v1/app/sessions/{id}/answers`): the person needs "can use" on the session, and the control plane decides every refusal and prints it as it wrote it. An answer that names an option (its
 * letter or its words) picks it; anything else is the person's own words ("your call" leaves the question to Rovara). With no answer given the command only shows the questions and how to answer them.
 * `answers[0]` is the answer to question 1.
 */
export async function sessionAnswer(
  deps: DeveloperSessionDeps, env: string | undefined, ref: string, input: { answers: ReadonlyArray<string | undefined> },
): Promise<AppResult> {
  const id = await sessionOfRef(deps, env, ref);
  const read = await appRequest(deps, env, sessionPath(id), { headers: { [TASK_VIEW_HEADER]: TASK_VIEW_VERSION } });
  const view = (read.body.session ?? {}) as Body;
  const body = (view.body ?? {}) as Body;
  if (body.kind !== "task") throw agentXError("INTENT_NOT_WAITING", INTENT_NOT_WAITING_MESSAGE);
  const asked = askedQuestions((body.task ?? {}) as Body);
  if (asked === undefined) throw agentXError("INTENT_NOT_WAITING", INTENT_NOT_WAITING_MESSAGE);
  const { round, questions } = asked;
  const given = input.answers.flatMap((answer, index) => (answer === undefined ? [] : [{ index, answer }]));
  const beyond = given.find((entry) => entry.index >= questions.length);
  if (beyond !== undefined) throw agentXError("CONFIG_INVALID", `This task asks ${plural(questions.length, "question", "questions")}, so there is no --q${beyond.index + 1}.`);
  if (given.length === 0) {
    const flags = questions.map((question, index) => `--q${index + 1} <${[...question.options.map((option) => option.id), "your own words"].join("|")}>`).join(" ");
    const lines = [
      `Rovara has ${plural(questions.length, "question", "questions")} before it plans ${clean(str(view.title, "this task"))}:`,
      ...questions.flatMap((question, index) => [
        `  ${index + 1}. ${clean(question.text)}`,
        ...question.options.map((option) => `     ${clean(option.id)}) ${clean(option.label)}${question.recommended === option.id ? " (recommended)" : ""}`),
      ]),
      `Answer them all: agentx session answer ${id} ${flags}`,
      `Say "${YOUR_CALL_WORDS}" for any you don't mind.`,
      linkOf(read.url, id, view.link),
    ];
    return result(read, { round, questions, link: linkOf(read.url, id, view.link) }, `${lines.join("\n")}\n`);
  }
  const answers = given.map(({ index, answer }) => {
    const question = questions[index]!;
    const said = answer.trim().toLowerCase();
    const option = question.options.find((candidate) => candidate.id.toLowerCase() === said || candidate.label.trim().toLowerCase() === said);
    return option === undefined ? { questionId: question.id, text: answer } : { questionId: question.id, optionId: option.id };
  });
  const sent = await appRequest(deps, env, sessionPath(id, "/answers"), { method: "POST", body: { requestId: randomUUID(), round, answers } });
  const after = (sent.body.session ?? {}) as Body;
  return result(sent, sent.body, `${[`Answered. Rovara is planning again with your ${plural(answers.length, "answer", "answers")}.`, linkOf(sent.url, id, after.link ?? view.link)].join("\n")}\n`);
}
