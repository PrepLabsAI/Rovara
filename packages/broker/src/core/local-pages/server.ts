// Lane L8: the local review pages' HTTP server (owner decision 45.8). Small server-rendered pages for what is too long or too visual for a terminal or an
// editor: a plan with line comments, a design review with its mockups, the lessons, and the proof report. It binds 127.0.0.1 only, on a port the
// system picks (or the caller names), serves no script, keeps no cookie, and asks nothing of a request before `guard.ts` has passed it.
//
// A page write is one verified form: the session token is in the path, the form token binds the exact content shown, and an approval is not
// decided here. The server builds an `ApprovalProof` from the page session (`local-session`) and hands it, with the action, to the task flow, whose
// `Approvers` seam decides. The proof is good for the one request, revision and digest the form names.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LOCAL_SESSION_METHOD } from "../../ports/policy-defaults.js";
import { STAGE_IDS, STAGE_REFERENCE, StepThinkingLevelSchema, type ApprovalProof, type StageId } from "@agentx/contracts";
import { FailureLimiter, FormTokens, LocalPageSessions, refuseRequest, type FormBinding } from "./guard.js";
import { pagePolicy } from "./html.js";
import { renderConnections, renderSources } from "./connection-pages.js";
import { renderAutomation, renderDesignReview, renderIndex, renderLessons, renderPlanPage, renderProof, renderScriptTokens, renderSecondReview, renderChat, renderTestEnvironment, type PageContext } from "./pages.js";
import { renderHowWeWork, renderHowWeWorkIndex } from "./how-we-work-page.js";
import { renderModelSelection } from "./models-page.js";
import { renderSetupIndex, renderSetupPage } from "./setup-page.js";
import type { ApprovalOffer, AutomationPageAction, ConnectionPageAction, LocalActionResult, LocalPageActions, LocalPageData, ModelSelectionPageAction, SecondReviewPageAction } from "./views.js";

export interface LocalPagesServer {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  port: number;
  sessions: LocalPageSessions;
  /** The address of a page in the owner's session, opened on the first call and reused until it ends (`fresh` opens another). The token is in the address: a person's terminal only, never an MCP result, a file or a pull request, since whoever holds it can approve. */
  link(path?: string, options?: { ttlMs?: number; label?: string; fresh?: boolean }): string;
  /** The same, for a session that already exists. */
  linkIn(token: string, path?: string): string;
  /**
   * An address for a browser to be opened on, that holds no session: `<origin>/s/once/<code>`. The code is good for ONE request within `ttlMs` (30 s by default); that request is
   * answered with a redirect to the real address. So the address that sits in the process list while the browser starts is spent by the time anyone reads it.
   * `fresh`: the redirect opens a NEW page session instead of reusing the owner's, so the page it lands on can ask for a session opened a few minutes ago (making a script token does).
   */
  onceLink(path?: string, options?: { ttlMs?: number; label?: string; fresh?: boolean }): string;
  close(): Promise<void>;
}

export interface LocalPagesOptions {
  data: LocalPageData;
  actions: LocalPageActions;
  port?: number;
  now?: () => number;
  /** For tests: the session store, so a test can mint a known token. */
  sessions?: LocalPageSessions;
}

/** The longest body a form may send (a comment or a note is at most 4,000 characters; this leaves room for the fields). */
export const MAX_BODY_BYTES = 32 * 1024;
const TEXT_MAX = 4000;
const TASK_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID = "[A-Za-z0-9_-]{1,100}";
const PROJECT = "[A-Za-z0-9][A-Za-z0-9_.-]{0,127}";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** a page session this young may make a script token (Cloud asks for a sign-in made in the last few minutes for the same reason: the credential lasts for weeks). */
export const SCRIPT_TOKEN_FRESH_MS = 10 * 60 * 1000;

/** The sentences a page shows after a write. The address carries a code, never text. */
const NOTICES: Record<string, string> = {
  approved: "Approved.",
  changes: "Your changes were sent.",
  rejected: "Rejected.",
  commented: "Comment added.",
  retried: "Rovara is running that step again.",
  diagnosing: "Fix with agent is looking into this error. Reload this page in a moment.",
  attached: "That thread is attached. A writer's comment there can decide this plan.",
  answered: "Your answers were sent.",
  chosen: "Done. Rovara carries on with the design review.",
  resumed: "Picked up again.",
  lesson: "Lesson updated.",
  lessonrepo: "Saved. A switched-on repository gets its first pull request within a day.",
  lessonretire: "Saved. Lessons you confirmed are retired by the next nightly pass; lessons you kept are proposed back in the next pull request.",
  lessonlocal: "Saved. Local coding tools follow the new setting on their next call.",
  lessonlocalfresh: "Letting lessons leave Rovara needs a page you opened in the last few minutes. Run `rovara open lessons` to open one.",
  lessonfresh: "Switching a repository's lessons file on, or retiring lessons that went missing from it, needs a page you opened in the last few minutes. Run `rovara open lessons` to open one.",
  revoked: "That script token is revoked.",
  envapproved: "Approved. Tasks that start from now on use it.",
  imageapproved: "Approved and pinned. Test services use it from the next `rovara up`.",
  imageremoved: "Removed. It stops being offered from the next `rovara up`.",
  imagefresh: "Approving or removing a service image needs a page you opened in the last few minutes. Run `rovara test-env open <project>` to open one.",
  imagerefused: "That image was not approved: Rovara could not pull and pin it, it is built in already, or it is not a kind Rovara can run.",
  linked: "That chat account is linked to you.",
  unlinked: "That chat account is no longer linked.",
  bound: "That space is bound to the project.",
  unbound: "That space is not bound any more.",
  noticed: "You will be told there.",
  unnoticed: "You will not be told there any more.",
  muted: "Notices are muted.",
  unmuted: "Notices are on again.",
  scheduled: "Saved: when you are told.",
  badcode: "That code is not valid: it may have expired or been used. Message Rovara in the chat again for a new one.",
  chatfresh: "Changing chat settings needs a page you opened in the last few minutes. Run `rovara chat` to open one.",
  setupdone: "Done.",
  setupoff: "Setting a project up with Rovara is off on this install.",
  tokenfresh: "Making a token needs a page you opened in the last few minutes. Run `rovara token create` to open one.",
  saved: "Saved.",
  acknowledged: "Acknowledged and recorded.",
  reauth: "That change needs a recent sign-in. Close this page and run `rovara open second-review` again, then make the change within ten minutes.",
  modelreauth: "That change needs a recent sign-in. Close this page and run `rovara open models` again, then make the change within ten minutes.",
  stale: "It changed while you were looking. Read it again, then decide.",
  refused: "That was not accepted.",
  invalid: "That was not understood.",
  missing: "That is no longer there.",
  form: "That form has expired or was already used. Read the page again.",
};
/** A project name as a path segment: the names a project can have, nothing else. */
const PROJECT_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]{0,99}";

type Route = { method: "GET" | "POST"; pattern: RegExp; handle: (request: Req, match: RegExpExecArray) => Promise<Reply> };
interface Req { session: { id: string; token: string; createdAt: number }; url: URL; form: URLSearchParams | undefined; base: string; origin: string }
type Reply = { status: number; type: string; body: string | Uint8Array; headers?: Record<string, string> };

const html = (body: string, status = 200): Reply => ({ status, type: "text/html; charset=utf-8", body });
const redirect = (location: string): Reply => ({ status: 303, type: "text/plain; charset=utf-8", body: "", headers: { location } });
const notFound = (): Reply => ({ status: 404, type: "text/plain; charset=utf-8", body: "not found\n" });

function noticeOf(url: URL): string | undefined {
  const code = url.searchParams.get("n");
  return code === null || !Object.hasOwn(NOTICES, code) ? undefined : NOTICES[code];
}

const outcomeCode = (result: LocalActionResult, success: string): string => (result.ok ? success : result.reason === "stale" ? "stale" : result.reason === "not_found" ? "missing" : result.reason === "invalid" ? "invalid" : result.reason === "reauth" ? "reauth" : "refused");


/** The change a Connections or Sources form asks for, or undefined when it is not one these pages offer. Every value is checked again by the contract's schemas where it is used. */
function connectionActionOf(op: string, form: URLSearchParams | undefined): { action: ConnectionPageAction; subject: string; requestId?: string } | undefined {
  const get = (name: string): string => form?.get(name) ?? "";
  const requestId = get("requestId");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  const connectionId = /^con_[0-9a-z]{20}$/u;
  const serverId = /^mcp[a-z0-9]{6,24}$/u;
  // eslint-disable-next-line no-control-regex -- a project name is one line of plain text
  const projectName = (value: string): boolean => value !== "" && value.length <= 200 && !/[\u0000-\u001f]/u.test(value);
  switch (op) {
    case "save": {
      const type = get("type");
      if (!uuid.test(requestId) || !/^[a-z]{3,20}$/u.test(type)) return undefined;
      const fields: Record<string, string> = {};
      for (const [name, value] of form?.entries() ?? []) if (name.startsWith("f_") && name.length <= 40 && value.length <= 9000) fields[name.slice(2)] = value;
      const access = get("access") === "read_write" ? "read_write" : "read";
      return { action: { op, requestId, type, fields, access }, subject: type, requestId };
    }
    case "remove": case "check":
      return uuid.test(requestId) && connectionId.test(get("connectionId")) ? { action: { op, requestId, connectionId: get("connectionId") }, subject: get("connectionId"), requestId } : undefined;
    case "server-add":
      return get("label") !== "" && get("label").length <= 200 && get("address") !== "" && get("address").length <= 2048 && get("token").length <= 4096
        ? { action: { op, label: get("label"), address: get("address"), token: get("token") }, subject: "new" } : undefined;
    case "server-approve": case "server-disable": case "server-remove":
      return serverId.test(get("serverId")) ? { action: { op, serverId: get("serverId") }, subject: get("serverId") } : undefined;
    case "server-reapprove":
      return serverId.test(get("serverId")) && get("toolsHash") !== "" && get("toolsHash").length <= 100 ? { action: { op, serverId: get("serverId"), toolsHash: get("toolsHash") }, subject: get("serverId") } : undefined;
    case "source-remove":
      return projectName(get("project")) && /^[a-z][a-z0-9]{1,15}$/u.test(get("sourceId")) ? { action: { op, project: get("project"), sourceId: get("sourceId") }, subject: `${get("project")}:${get("sourceId")}` } : undefined;
    case "source-confirm": case "source-reject":
      return projectName(get("project")) && uuid.test(get("changeId")) ? { action: { op, project: get("project"), changeId: get("changeId") }, subject: `${get("project")}:${get("changeId")}` } : undefined;
    case "source-propose": {
      const project = get("project");
      if (!projectName(project) || !/^(?:connection:con_[0-9a-z]{20}|server:mcp[a-z0-9]{6,24})$/u.test(get("server"))) return undefined;
      const tools: Array<{ name: string; schemaHash: string; attested: boolean; role: string }> = [];
      for (const index of form?.getAll("tool") ?? []) {
        if (!/^\d{1,3}$/u.test(index)) return undefined;
        const name = get(`tool_name_${index}`), schemaHash = get(`tool_hash_${index}`);
        if (name === "" || name.length > 200 || !/^[0-9a-f]{64}$/u.test(schemaHash)) return undefined;
        tools.push({ name, schemaHash, attested: get(`attest_${index}`) === "1", role: get(`role_${index}`) });
      }
      return {
        action: { op, project, server: get("server"), sourceId: get("sourceId"), label: get("label"), stages: form?.getAll("stage") ?? [], tools, quotes: get("quotes"), retention: get("retention"), sendCodeSnippets: get("sendCodeSnippets") === "1" },
        subject: `${project}:new`,
      };
    }
    default: return undefined;
  }
}

/** A model as a second-review form names it: `provider::modelId` (a provider id never holds a colon). */
function modelRefOf(value: string | null | undefined): { provider: string; modelId: string } | undefined {
  if (value === null || value === undefined) return undefined;
  const at = value.indexOf("::");
  const provider = value.slice(0, at), modelId = value.slice(at + 2);
  return at > 0 && /^[a-z][a-z0-9-]{0,39}$/u.test(provider) && modelId.length > 0 && modelId.length <= 256 ? { provider, modelId } : undefined;
}

/** The change a second-review form asks for, or undefined when it is not one this page offers. */
function secondReviewActionOf(op: string, form: URLSearchParams | undefined): SecondReviewPageAction | undefined {
  const get = (name: string): string => form?.get(name) ?? "";
  switch (op) {
    case "choose": {
      const primary = modelRefOf(get("primary"));
      const backup = get("backup") === "" ? undefined : modelRefOf(get("backup"));
      return primary === undefined || (get("backup") !== "" && backup === undefined) ? undefined : { action: "choose", primary, ...(backup === undefined ? {} : { backup }) };
    }
    case "clear": return { action: "clear" };
    case "context": return get("context") === "change_only" || get("context") === "same_as_first" ? { action: "context", context: get("context") as "change_only" | "same_as_first" } : undefined;
    case "mode": {
      const mode = get("mode");
      const scope = get("scope");
      if (!(mode === "off" || mode === "shadow" || mode === "on" || (scope === "project" && mode === "inherit"))) return undefined;
      if (scope === "company") return { action: "mode", scope, mode };
      return scope === "project" && /^[A-Za-z0-9_.-]{1,64}$/u.test(get("project")) ? { action: "mode", scope, project: get("project"), mode } : undefined;
    }
    case "cancel-mode": return /^[A-Za-z0-9_-]{1,100}$/u.test(get("changeId")) ? { action: "cancel-mode", changeId: get("changeId") } : undefined;
    case "withdraw": { const model = modelRefOf(get("model")); return model === undefined ? undefined : { action: "withdraw", model }; }
    case "replay": {
      const text = get("run");
      if (text === "" || text.length > 30_000) return undefined;
      try { return { action: "replay", run: JSON.parse(text) as unknown }; } catch { return undefined; }
    }
    case "verdict": {
      const model = modelRefOf(get("model"));
      const time = (name: string): string => { const value = get(name); return Number.isNaN(Date.parse(value)) ? "" : new Date(value).toISOString(); };
      return model === undefined || !/^[A-Za-z0-9._:-]{1,64}$/u.test(get("run")) || time("from") === "" || time("to") === "" ? undefined : { action: "verdict", model, replayRunId: get("run"), startedAt: time("from"), endedAt: time("to") };
    }
    case "notice-seen": return /^[a-f0-9]{32}$/u.test(get("key")) ? { action: "notice-seen", key: get("key") } : undefined;
    default: return undefined;
  }
}
/** The change a model-setting form asks for, or undefined when it is not one this page offers. A group of steps that share a setting is named by any one of them. */
function modelSelectionActionOf(op: string, form: URLSearchParams | undefined): ModelSelectionPageAction | undefined {
  const get = (name: string): string => form?.get(name) ?? "";
  const expectedRevision = /^\d{1,9}$/u.test(get("revision")) ? Number(get("revision")) : undefined;
  if (expectedRevision === undefined) return undefined;
  if (op === "review-default") return get("value") === "install-model" || get("value") === "different-company" ? { action: "review-default", value: get("value") as "install-model" | "different-company", expectedRevision } : undefined;
  const stage = STAGE_IDS.find((candidate) => candidate === get("stage"));
  if (stage === undefined) return undefined;
  if (op === "clear") return { action: "clear", stage, expectedRevision };
  if (op !== "set") return undefined;
  const model = get("model") === "" ? undefined : modelRefOf(get("model"));
  const fallbackModel = get("fallback") === "" ? undefined : modelRefOf(get("fallback"));
  if ((get("model") !== "" && model === undefined) || (get("fallback") !== "" && fallbackModel === undefined)) return undefined;
  const thinking = get("thinking");
  const level = thinking === "" ? undefined : thinking === "default" ? null : StepThinkingLevelSchema.safeParse(thinking).data;
  if (thinking !== "" && level === undefined) return undefined;
  const different = get("different");
  if (different !== "" && different !== "model" && different !== "vendor") return undefined;
  const reference = STAGE_REFERENCE[stage as keyof typeof STAGE_REFERENCE] as StageId | undefined;
  if (different !== "" && reference === undefined) return undefined;
  return {
    action: "set", stage, expectedRevision,
    choice: {
      ...(model === undefined ? {} : { model }), ...(level === undefined ? {} : { thinkingLevel: level }), ...(fallbackModel === undefined ? {} : { fallbackModel }),
      ...(different === "" || reference === undefined ? {} : { differentFrom: { stage: reference, level: different } }),
    },
  };
}
/** The same request address with a notice code set, for a page that explains its own answer (a code that does not read). */
const withNotice = (url: URL, notice: string): URL => {
  const next = new URL(url.href);
  next.searchParams.set("n", notice);
  return next;
};

export async function createLocalPagesServer(options: LocalPagesOptions): Promise<LocalPagesServer> {
  const now = options.now ?? Date.now;
  const sessions = options.sessions ?? new LocalPageSessions(now);
  const forms = new FormTokens(randomBytes(32), now);
  // Single-use codes for `onceLink`: only a hash is kept, and at most a few at a time.
  const onceCodes = new Map<string, { path: string; label: string | undefined; fresh: boolean; expires: number }>();
  const limiter = new FailureLimiter(60, 60_000, now);
  let origin = "";
  let ownerToken: string | undefined;

  const contextFor = (request: Req): PageContext => {
    const notice = noticeOf(request.url);
    return {
      base: request.base, nonce: randomBytes(16).toString("base64url"), sessionId: request.session.id,
      formToken: (binding) => forms.issue({ ...binding, sessionId: request.session.id }),
      ...(notice === undefined ? {} : { notice }),
    };
  };
  const page = (request: Req, draw: (context: PageContext) => string | Promise<string>): Promise<Reply> =>
    Promise.resolve(contextFor(request)).then(async (context) => ({ ...html(await draw(context)), headers: { "content-security-policy": pagePolicy(context.nonce) } }));

  /** The proof an approval form carries: the page session is the evidence that the local owner is here. */
  const proofFor = (request: Req, offer: Pick<ApprovalOffer, "requestId" | "revision" | "artifactDigest">): ApprovalProof => ({
    proofId: randomUUID(), method: LOCAL_SESSION_METHOD, requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest,
    // Not the session's secret: a token signed over this session and exactly this request, revision and digest.
    token: sessions.issueProof(request.session.id, { requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest }),
  });

  /** The values a write form named, and whether its form token binds them. Every value a write uses comes from here, never from the form unchecked. */
  const verified = (request: Req, binding: Omit<FormBinding, "sessionId">): boolean => {
    const given = request.form?.get("ft") ?? undefined;
    // A form answers once: a second click on the same form, or a replay, finds its token used.
    return forms.verify(given, { ...binding, sessionId: request.session.id }) && forms.consume(given as string);
  };
  const text = (request: Req, name: string): string => {
    const value = request.form?.get(name) ?? "";
    return [...value].length > TEXT_MAX ? [...value].slice(0, TEXT_MAX).join("") : value;
  };
  const tokenPageIsFresh = (request: Req): boolean => now() - request.session.createdAt <= SCRIPT_TOKEN_FRESH_MS;
  const offerOf = (request: Req, kind: "plan" | "design" | "test-environment" | "setup" | "automation"): ApprovalOffer | undefined => {
    const revision = Number(request.form?.get("revision"));
    const requestId = request.form?.get("requestId") ?? "";
    const artifactDigest = request.form?.get("digest") ?? "";
    if (!Number.isSafeInteger(revision) || revision < 0 || requestId === "" || requestId.length > 200 || artifactDigest === "" || artifactDigest.length > 200) return undefined;
    return { requestId, revision, artifactDigest, kind };
  };

  const routes: Route[] = [
    { method: "GET", pattern: /^\/$/, handle: async (request) => page(request, async (context) => renderIndex(context, await options.data.listPending())) },
    { method: "GET", pattern: new RegExp(`^/plan/(${TASK_ID})$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const view = await options.data.getPlanPage(taskId);
      return view === undefined ? notFound() : page(request, (context) => renderPlanPage(context, view));
    } },
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/decide$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const offer = offerOf(request, "plan");
      const decision = request.form?.get("decision");
      if (offer === undefined || (decision !== "approve" && decision !== "changes")) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      if (!verified(request, { action: "plan.decide", taskId, requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      const note = text(request, "note").trim();
      if (decision === "changes" && note === "") return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      // One answer for each decision the plan's form carried (a radio each, AgentX's recommendation pre-chosen); the workflow checks them against the document's own decisions.
      const answers: Array<{ decisionId: string; optionId: string; opened: boolean }> = [];
      for (const name of [...(request.form?.keys() ?? [])].filter((key) => key.startsWith("answer-"))) {
        const decisionId = name.slice("answer-".length);
        const optionId = request.form?.get(name) ?? "";
        if (!/^[A-Za-z0-9_.-]{1,40}$/u.test(decisionId) || !/^[A-Za-z0-9_.-]{1,40}$/u.test(optionId) || answers.some((answer) => answer.decisionId === decisionId)) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
        answers.push({ decisionId, optionId, opened: true });
      }
      const result = await options.actions.decidePlan({ taskId, decision, ...(note === "" ? {} : { note }), ...(answers.length === 0 ? {} : { answers }), approval: offer, proof: proofFor(request, offer) });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, decision === "approve" ? "approved" : "changes")}`);
    } },
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/retry$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const revision = Number(request.form?.get("revision"));
      if (!Number.isSafeInteger(revision) || options.actions.retry === undefined) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      if (!verified(request, { action: "task.retry", taskId, revision })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      const result = await options.actions.retry({ taskId, revision });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, "retried")}`);
    } },
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/diagnose$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const requestId = request.form?.get("requestId") ?? "";
      const errorKey = request.form?.get("errorKey") ?? "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(requestId) || !/^[a-f0-9]{64}$/u.test(errorKey) || options.actions.diagnose === undefined) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      // The form is good only for the error the page showed and for this press: a second click, or a form drawn for another error, finds its token spent or wrong.
      if (!verified(request, { action: "task.diagnose", taskId, requestId, subject: errorKey })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      const result = await options.actions.diagnose({ taskId, requestId, errorKey });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, "diagnosing")}#fix-with-agent`);
    } },
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/thread$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const revision = Number(request.form?.get("revision"));
      const number = Number(request.form?.get("number"));
      const repository = (request.form?.get("repository") ?? "").trim();
      if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(number) || number < 1 || !/^[A-Za-z0-9_.-]{1,100}$/u.test(repository) || options.actions.attachThread === undefined) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      if (!verified(request, { action: "task.thread", taskId, revision })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      const result = await options.actions.attachThread({ taskId, revision, repository, number });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, "attached")}`);
    } },
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/answers$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const revision = Number(request.form?.get("revision"));
      const round = Number(request.form?.get("round"));
      if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(round) || options.actions.answerQuestions === undefined) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      if (!verified(request, { action: "task.answers", taskId, revision })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      // One answer for each question the form carried: a chosen option, or the person's own words (the workflow checks them against the questions it asked).
      const answers: Array<{ questionId: string; optionId?: string; text?: string }> = [];
      for (const name of [...(request.form?.keys() ?? [])].filter((key) => key.startsWith("text-") || key.startsWith("option-"))) {
        const questionId = name.slice(name.indexOf("-") + 1);
        if (!/^[A-Za-z0-9_-]{1,40}$/u.test(questionId) || answers.some((answer) => answer.questionId === questionId)) continue;
        const optionId = request.form?.get(`option-${questionId}`) ?? "";
        const words = text(request, `text-${questionId}`).trim();
        if (optionId === "" && words === "") continue;
        answers.push({ questionId, ...(optionId === "" ? {} : { optionId }), ...(words === "" ? {} : { text: words }) });
      }
      const result = await options.actions.answerQuestions({ taskId, revision, round, answers });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, "answered")}`);
    } },
    // Design review: a choice at the cost hold, through the approval gate (the page signs the proof over this request, revision and digest), and picking a paused review up again.
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/design-choice$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const offer = offerOf(request, "design");
      const choice = request.form?.get("choice");
      if (offer === undefined || options.actions.designChoice === undefined || (choice !== "run_unpriced" && choice !== "raise_cap" && choice !== "lower_tier" && choice !== "skip")) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      if (!verified(request, { action: "design.choice", taskId, requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      const result = await options.actions.designChoice({ taskId, choice, approval: offer, proof: proofFor(request, offer) });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, "chosen")}`);
    } },
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/design-resume$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const revision = Number(request.form?.get("revision"));
      if (!Number.isSafeInteger(revision) || options.actions.designResume === undefined) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      if (!verified(request, { action: "design.resume", taskId, revision })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      const result = await options.actions.designResume({ taskId, revision });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, "resumed")}`);
    } },
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/comment$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const revision = Number(request.form?.get("revision"));
      if (!Number.isSafeInteger(revision)) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      if (!verified(request, { action: "plan.comment", taskId, revision })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      const target = (request.form?.get("target") ?? "").trim();
      const body = text(request, "text").trim();
      if (body === "" || !/^(|[0-9]{1,3}(\.[0-9]{1,3}){0,2}|[A-Za-z0-9_-]{1,40})$/.test(target)) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      const result = await options.actions.addComment({ taskId, target, text: body, revision });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, "commented")}#comments`);
    } },
    { method: "GET", pattern: new RegExp(`^/design/(${TASK_ID})$`), handle: async (request, match) => {
      const view = await options.data.getDesignReview(match[1] ?? "");
      return view === undefined ? notFound() : page(request, (context) => renderDesignReview(context, view));
    } },
    { method: "GET", pattern: new RegExp(`^/design/(${TASK_ID})/mockup/(${ID})$`), handle: async (request, match) => {
      const view = await options.data.getDesignReview(match[1] ?? "");
      // Only a mockup the review names is served, whatever the id: the data source is not asked for arbitrary files.
      const mockup = view?.mockups.find((candidate) => candidate.id === match[2]);
      if (view === undefined || mockup === undefined) return notFound();
      const image = await options.data.readMockup(view.taskId, mockup.id);
      if (image === undefined || !ALLOWED_IMAGE_TYPES.has(image.contentType) || image.bytes.byteLength > MAX_IMAGE_BYTES) return notFound();
      return { status: 200, type: image.contentType, body: image.bytes, headers: { "content-security-policy": "default-src 'none'; sandbox", "content-disposition": "inline" } };
    } },
    { method: "POST", pattern: new RegExp(`^/design/(${TASK_ID})/decide$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const offer = offerOf(request, "design");
      const decision = request.form?.get("decision");
      if (offer === undefined || (decision !== "approve" && decision !== "reject")) return redirect(`${request.base}/design/${taskId}?n=invalid`);
      if (!verified(request, { action: "design.decide", taskId, requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest })) return redirect(`${request.base}/design/${taskId}?n=form`);
      const note = text(request, "note").trim();
      if (decision === "reject" && note === "") return redirect(`${request.base}/design/${taskId}?n=invalid`);
      const result = await options.actions.decideDesign({ taskId, decision, ...(note === "" ? {} : { note }), approval: offer, proof: proofFor(request, offer) });
      return redirect(`${request.base}/design/${taskId}?n=${outcomeCode(result, decision === "approve" ? "approved" : "rejected")}`);
    } },
    { method: "GET", pattern: /^\/lessons$/, handle: async (request) => page(request, async (context) => renderLessons(context, await options.data.listLessons(), await (options.data.listLessonRepos?.() ?? Promise.resolve([])).catch(() => []), await (options.data.listLessonLocalTools?.() ?? Promise.resolve(undefined)).catch(() => undefined))) },
    { method: "POST", pattern: /^\/lessons\/local-tools$/, handle: async (request) => {
      const scope = request.form?.get("scope");
      const project = request.form?.get("project") ?? "";
      const value = scope === "company" ? request.form?.get("stays") : request.form?.get("enabled");
      if (options.actions.lessonLocalToolsAction === undefined || (scope !== "company" && scope !== "project") || (value !== "true" && value !== "false") || (scope === "project" ? project === "" || project.length > 200 : (request.form?.get("project") ?? null) !== null)) return redirect(`${request.base}/lessons?n=invalid`);
      const on = value === "true";
      const subject = scope === "company" ? `company:${on ? "stay" : "open"}` : `project:${project}:${on ? "on" : "off"}`;
      if (!verified(request, { action: "lesson.local_tools", subject })) return redirect(`${request.base}/lessons?n=form`);
      // Letting lessons leave Rovara for every project is the larger change: like switching a repository's lessons file on, it asks for a page opened a few minutes ago.
      if (scope === "company" && !on && !tokenPageIsFresh(request)) return redirect(`${request.base}/lessons?n=lessonlocalfresh`);
      const result = await options.actions.lessonLocalToolsAction(scope === "company" ? { scope, stays: on } : { scope, project, enabled: on });
      return redirect(`${request.base}/lessons?n=${outcomeCode(result, "lessonlocal")}`);
    } },
    { method: "POST", pattern: /^\/lessons\/repo$/, handle: async (request) => {
      const project = request.form?.get("project") ?? "";
      const repo = request.form?.get("repo") ?? "";
      const action = request.form?.get("action");
      const actions = ["on", "off", "resume", "pointer_add", "pointer_decline", "retire_confirm", "retire_keep"] as const;
      const chosen = actions.find((candidate) => candidate === action);
      // Only the two answers about lessons missing from the file carry the digest of the set the person saw (16 hex); no other action takes one.
      const heldRaw = request.form?.get("held") ?? undefined;
      const retiring = chosen === "retire_confirm" || chosen === "retire_keep";
      const held = heldRaw !== undefined && /^[0-9a-f]{16}$/u.test(heldRaw) ? heldRaw : undefined;
      if (options.actions.lessonRepoAction === undefined || chosen === undefined || project === "" || project.length > 200 || repo === "" || repo.length > 200 || (retiring ? held === undefined : heldRaw !== undefined)) return redirect(`${request.base}/lessons?n=invalid`);
      if (!verified(request, { action: "lesson.repo", subject: `${project}:${repo}:${chosen}${held === undefined ? "" : `:${held}`}` })) return redirect(`${request.base}/lessons?n=form`);
      // Retiring lessons takes them out of use for good: like switching on, it asks for a page opened a few minutes ago.
      if (chosen === "retire_confirm" && !tokenPageIsFresh(request)) return redirect(`${request.base}/lessons?n=lessonfresh`);
      // Switching on makes Rovara open pull requests in a repository: it asks for a page opened a few minutes ago, as a long-lived credential does.
      if (chosen === "on" && !tokenPageIsFresh(request)) return redirect(`${request.base}/lessons?n=lessonfresh`);
      const result = await options.actions.lessonRepoAction({ project, repo, action: chosen, ...(held === undefined ? {} : { held }), fresh: tokenPageIsFresh(request) });
      return redirect(`${request.base}/lessons?n=${outcomeCode(result, retiring ? "lessonretire" : "lessonrepo")}`);
    } },
    { method: "POST", pattern: /^\/lessons\/act$/, handle: async (request) => {
      const lessonId = request.form?.get("lessonId") ?? "";
      const action = request.form?.get("action");
      if (!new RegExp(`^${ID}$`).test(lessonId) || (action !== "approve" && action !== "retire" && action !== "wrong")) return redirect(`${request.base}/lessons?n=invalid`);
      // The form is good only for the lesson as it was drawn: its state is part of what the token binds.
      const lesson = (await options.data.listLessons()).find((candidate) => candidate.id === lessonId);
      if (lesson === undefined) return redirect(`${request.base}/lessons?n=missing`);
      // An approval is bound to the lesson's own text and version too: the form names what the owner read, and the proof the page signs is for exactly that.
      const offer = action === "approve" ? lesson.offer : undefined;
      if (!verified(request, { action: "lesson.act", subject: `${lessonId}:${action}:${lesson.status}`, ...(offer === undefined ? {} : { requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest }) })) return redirect(`${request.base}/lessons?n=form`);
      const result = await options.actions.lessonAction({ lessonId, action, ...(offer === undefined ? {} : { offer, proof: proofFor(request, offer) }) });
      return redirect(`${request.base}/lessons?n=${outcomeCode(result, "lesson")}`);
    } },
    { method: "GET", pattern: /^\/test-environment\/([A-Za-z0-9._-]{1,100})$/, handle: async (request, match) => {
      const view = await options.data.getTestEnvironmentPage?.(match[1] ?? "");
      return view === undefined ? notFound() : page(request, (context) => renderTestEnvironment(context, view, { fresh: tokenPageIsFresh(request) && options.actions.approveServiceImage !== undefined }));
    } },
    { method: "POST", pattern: /^\/test-environment\/([A-Za-z0-9._-]{1,100})\/decide$/, handle: async (request, match) => {
      const project = match[1] ?? "";
      const back = `${request.base}/test-environment/${encodeURIComponent(project)}`;
      const offer = offerOf(request, "test-environment");
      if (offer === undefined || options.actions.decideTestEnvironment === undefined) return redirect(`${back}?n=invalid`);
      if (!verified(request, { action: "testenv.decide", taskId: project, requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest })) return redirect(`${back}?n=form`);
      const result = await options.actions.decideTestEnvironment({ project, approval: offer, proof: proofFor(request, offer) });
      return redirect(`${back}?n=${outcomeCode(result, "envapproved")}`);
    } },
    // A service image is approved by the owner alone: a page session opened in the last ten minutes and a form that answers once, bound to this project and this exact image.
    { method: "POST", pattern: new RegExp(`^/test-environment/(${PROJECT_SEGMENT})/images/(approve|remove)$`), handle: async (request, match) => {
      const project = match[1] ?? "";
      const verb = match[2] ?? "";
      const back = `${request.base}/test-environment/${encodeURIComponent(project)}`;
      const approve = options.actions.approveServiceImage?.bind(options.actions);
      const remove = options.actions.removeServiceImage?.bind(options.actions);
      if (approve === undefined || remove === undefined) return notFound();
      const subject = verb === "approve" ? (request.form?.get("requested") ?? "") : (request.form?.get("reference") ?? "");
      if (subject === "" || subject.length > 300) return redirect(`${back}?n=invalid`);
      // Checked before the form is used up: a page that is too old keeps its form, and says why.
      if (!tokenPageIsFresh(request)) return redirect(`${back}?n=imagefresh`);
      if (!verified(request, { action: `testenv.image-${verb}`, subject: `${project}:${subject}` })) return redirect(`${back}?n=form`);
      const result = verb === "approve" ? await approve({ project, requested: subject }) : await remove({ project, reference: subject });
      return redirect(`${back}?n=${result.ok ? (verb === "approve" ? "imageapproved" : "imageremoved") : result.reason === "refused" ? "imagerefused" : outcomeCode(result, "imageapproved")}`);
    } },
    { method: "GET", pattern: /^\/tokens$/, handle: async (request) => {
      const view = await options.data.listScriptTokens?.();
      if (view === undefined) return notFound();
      return page(request, (context) => renderScriptTokens(context, view, { canMake: tokenPageIsFresh(request) && options.actions.createScriptToken !== undefined }));
    } },
    { method: "POST", pattern: /^\/tokens\/create$/, handle: async (request) => {
      if (options.data.listScriptTokens === undefined || options.actions.createScriptToken === undefined) return notFound();
      const requestId = request.form?.get("requestId") ?? "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(requestId)) return redirect(`${request.base}/tokens?n=invalid`);
      // A form answers once. The token binds this form's request id, so a form drawn for one request cannot make another.
      if (!verified(request, { action: "tokens.create", requestId })) return redirect(`${request.base}/tokens?n=form`);
      // A long-lived credential: only from a page session opened a few minutes ago (checked again here, not only when the page was drawn).
      if (!tokenPageIsFresh(request)) return redirect(`${request.base}/tokens?n=tokenfresh`);
      const name = text(request, "name").trim();
      const days = (request.form?.get("days") ?? "").trim();
      const result = await options.actions.createScriptToken({
        requestId, name, projects: request.form?.getAll("project") ?? [], permissions: request.form?.getAll("permission") ?? [], ...(days === "" ? {} : { days: Number(days) }),
      });
      const view = (await options.data.listScriptTokens()) ?? { tokens: [], projects: [] };
      // The secret is on the answer to this one form post: not in an address, a redirect or any later page.
      if (!result.ok) return page(request, (context) => renderScriptTokens({ ...context, notice: result.message }, view, { canMake: true }));
      return page(request, (context) => renderScriptTokens(context, view, { canMake: false, created: result.created }));
    } },
    { method: "POST", pattern: /^\/tokens\/revoke$/, handle: async (request) => {
      if (options.actions.revokeScriptToken === undefined) return notFound();
      const tokenId = request.form?.get("tokenId") ?? "";
      if (!/^stk_[0-9a-z]{20}$/u.test(tokenId)) return redirect(`${request.base}/tokens?n=invalid`);
      if (!verified(request, { action: "tokens.revoke", subject: tokenId })) return redirect(`${request.base}/tokens?n=form`);
      const result = await options.actions.revokeScriptToken({ tokenId });
      return redirect(`${request.base}/tokens?n=${outcomeCode(result, "revoked")}`);
    } },
    { method: "GET", pattern: /^\/how-we-work$/, handle: async (request) => {
      if (options.data.howWeWork === undefined) return notFound();
      const projects = await options.data.howWeWork.projects();
      return page(request, (context) => renderHowWeWorkIndex(context, projects));
    } },
    { method: "GET", pattern: new RegExp(`^/how-we-work/(${PROJECT_SEGMENT})$`), handle: async (request, match) => {
      const project = match[1] ?? "";
      const state = await options.data.howWeWork?.state(project);
      return state === undefined ? notFound() : page(request, (context) => renderHowWeWork(context, project, state));
    } },
    // A draft is checked and shown, never saved: the page answers the form itself (the draft is not kept in an address or a redirect).
    { method: "POST", pattern: new RegExp(`^/how-we-work/(${PROJECT_SEGMENT})/check$`), handle: async (request, match) => {
      const project = match[1] ?? "";
      const data = options.data.howWeWork;
      if (data === undefined) return notFound();
      if (!verified(request, { action: "playbook.check", subject: project })) return redirect(`${request.base}/how-we-work/${project}?n=form`);
      const state = await data.state(project);
      if (state === undefined) return notFound();
      const draft = request.form?.get("text") ?? "";
      return page(request, async (context) => renderHowWeWork(context, project, state, { text: draft, result: await data.preview(project, draft) }));
    } },
    { method: "GET", pattern: /^\/connections$/, handle: async (request) => {
      const view = await options.data.getConnectionsPage?.();
      return view === undefined ? notFound() : page(request, (context) => renderConnections(context, view, { fresh: tokenPageIsFresh(request) }));
    } },
    { method: "POST", pattern: /^\/connections\/act$/, handle: async (request) => {
      const act = options.actions.connectionAction?.bind(options.actions);
      const parsed = connectionActionOf(request.form?.get("op") ?? "", request.form);
      if (act === undefined || options.data.getConnectionsPage === undefined) return notFound();
      if (parsed === undefined || parsed.action.op.startsWith("source-")) return redirect(`${request.base}/connections?n=invalid`);
      if (!verified(request, { action: "connections.act", subject: `${parsed.action.op}:${parsed.subject}`, ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }) })) return redirect(`${request.base}/connections?n=form`);
      // Adding a key, approving a server: only from a page session opened a few minutes ago (checked again here, not only when the page was drawn).
      const result = await act(parsed.action, { fresh: tokenPageIsFresh(request) });
      const view = await options.data.getConnectionsPage();
      // The answer to the one form post, drawn here: a refusal's words are Rovara's, and no secret is in them.
      return view === undefined ? notFound() : page(request, (context) => renderConnections({ ...context, notice: result.message ?? (result.ok ? "Done." : "That did not work.") }, view, { fresh: tokenPageIsFresh(request) }));
    } },
    { method: "GET", pattern: /^\/sources$/, handle: async (request) => {
      const project = request.url.searchParams.get("project") ?? "";
      // Listing a server's tools calls the server with its token: only from a page opened in the last few minutes, like every other owner act.
      const discover = tokenPageIsFresh(request) ? request.url.searchParams.get("discover") ?? undefined : undefined;
      if (project === "" || project.length > 200 || options.data.getSourcesPage === undefined) return notFound();
      const view = await options.data.getSourcesPage(project, discover);
      return view === undefined ? notFound() : page(request, (context) => renderSources(context, view, { fresh: tokenPageIsFresh(request) }));
    } },
    { method: "POST", pattern: /^\/sources\/act$/, handle: async (request) => {
      const act = options.actions.connectionAction?.bind(options.actions);
      const parsed = connectionActionOf(request.form?.get("op") ?? "", request.form);
      if (act === undefined || options.data.getSourcesPage === undefined) return notFound();
      if (parsed === undefined || !parsed.action.op.startsWith("source-")) return redirect(`${request.base}/connections?n=invalid`);
      if (!verified(request, { action: "connections.act", subject: `${parsed.action.op}:${parsed.subject}` })) return redirect(`${request.base}/connections?n=form`);
      const result = await act(parsed.action, { fresh: tokenPageIsFresh(request) });
      const project = "project" in parsed.action ? parsed.action.project : "";
      const view = await options.data.getSourcesPage(project);
      return view === undefined ? notFound() : page(request, (context) => renderSources({ ...context, notice: result.message ?? (result.ok ? "Done." : "That did not work.") }, view, { fresh: tokenPageIsFresh(request) }));
    } },
    { method: "GET", pattern: /^\/automation$/, handle: async (request) => {
      const view = await options.data.getAutomationPage?.();
      return view === undefined ? notFound() : page(request, (context) => renderAutomation(context, view));
    } },
    { method: "POST", pattern: /^\/automation\/act$/, handle: async (request) => {
      const back = `${request.base}/automation`;
      const op = request.form?.get("op") ?? "";
      const act = options.actions.automation?.bind(options.actions);
      if (act === undefined || !/^[a-z-]{1,20}$/u.test(op)) return redirect(`${back}?n=invalid`);
      const get = (name: string): string => request.form?.get(name) ?? "";
      const subject = op === "gate" ? `${get("runId")}#${get("seq")}#${get("decision")}` : op === "trigger-on" || op === "trigger-off" ? get("triggerId") : get("runId");
      if (!verified(request, { action: "automation.act", subject: `${op}:${subject}` })) return redirect(`${back}?n=form`);
      let input: AutomationPageAction | undefined;
      if (op === "trigger-on" || op === "gate") {
        const offer = offerOf(request, "automation");
        if (offer === undefined) return redirect(`${back}?n=invalid`);
        const seq = Number(get("seq"));
        const decision = get("decision");
        input = op === "trigger-on" ? { action: "trigger-on", triggerId: get("triggerId"), approval: offer, proof: proofFor(request, offer) }
          : (decision === "approved" || decision === "declined") && Number.isSafeInteger(seq) && seq > 0 ? { action: "gate", runId: get("runId"), seq, decision, approval: offer, proof: proofFor(request, offer) } : undefined;
      } else if (op === "trigger-off") input = { action: "trigger-off", triggerId: get("triggerId") };
      else if (op === "run-cancel") input = { action: "run-cancel", runId: get("runId") };
      if (input === undefined || ("triggerId" in input && !/^ctr_[0-9a-z]{20}$/u.test(input.triggerId)) || ("runId" in input && !/^crn_[0-9a-z]{20}$/u.test(input.runId))) return redirect(`${back}?n=invalid`);
      return redirect(`${back}?n=${outcomeCode(await act(input), "saved")}`);
    } },
    { method: "GET", pattern: /^\/second-review$/, handle: async (request) => {
      const state = await options.data.getSecondReview?.();
      return state === undefined ? notFound() : page(request, (context) => renderSecondReview(context, state));
    } },
    { method: "POST", pattern: /^\/second-review\/act$/, handle: async (request) => {
      const back = `${request.base}/second-review`;
      const op = request.form?.get("op") ?? "";
      const act = options.actions.secondReview?.bind(options.actions);
      if (act === undefined || !/^[a-z-]{1,20}$/u.test(op)) return redirect(`${back}?n=invalid`);
      if (!verified(request, { action: "second-review.act", subject: op })) return redirect(`${back}?n=form`);
      const parsed = secondReviewActionOf(op, request.form);
      if (parsed === undefined) return redirect(`${back}?n=invalid`);
      // A change that needs a recent sign-in (lowering, withdrawing, the evidence) is good only in a page session opened within the last ten minutes (the same check as making a script token).
      return redirect(`${back}?n=${outcomeCode(await act(parsed, { fresh: tokenPageIsFresh(request) }), "saved")}`);
    } },
    { method: "GET", pattern: /^\/models$/, handle: async (request) => {
      const state = await options.data.getModelSelection?.();
      return state === undefined ? notFound() : page(request, (context) => renderModelSelection(context, state));
    } },
    { method: "POST", pattern: /^\/models\/act$/, handle: async (request) => {
      const back = `${request.base}/models`;
      const op = request.form?.get("op") ?? "";
      const stage = request.form?.get("stage") ?? "";
      const act = options.actions.modelSelection?.bind(options.actions);
      if (act === undefined || !/^[a-z-]{1,20}$/u.test(op) || !/^[a-z_]{0,20}$/u.test(stage)) return redirect(`${back}?n=invalid`);
      if (!verified(request, { action: "models.act", subject: `${op}:${stage}` })) return redirect(`${back}?n=form`);
      const parsed = modelSelectionActionOf(op, request.form);
      if (parsed === undefined) return redirect(`${back}?n=invalid`);
      // Every change of the model setting is good only in a page session opened within the last ten minutes (the same check as making a script token).
      const result = await act(parsed, { fresh: tokenPageIsFresh(request) });
      return redirect(`${back}?n=${!result.ok && result.reason === "reauth" ? "modelreauth" : outcomeCode(result, "saved")}`);
    } },
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/second-review-acknowledge$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const revision = Number(request.form?.get("revision"));
      const key = request.form?.get("key") ?? "";
      if (!Number.isSafeInteger(revision) || !/^[a-f0-9]{64}$/u.test(key) || options.actions.acknowledgeSecondReview === undefined) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      if (!verified(request, { action: "second-review.acknowledge", taskId, revision, subject: key })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      const result = await options.actions.acknowledgeSecondReview({ taskId, revision, key });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, "acknowledged")}`);
    } },
    { method: "GET", pattern: /^\/chat$/, handle: async (request) => {
      const view = await options.data.getChatPage?.();
      if (view === undefined) return notFound();
      // A code in the address is only looked at: what it names is shown for the owner to confirm. Nothing changes until the confirmation form is posted.
      const code = (request.url.searchParams.get("code") ?? "").trim();
      const found = code === "" ? undefined : await options.data.previewChatLink?.(code);
      const notice = code !== "" && found === undefined ? "badcode" : undefined;
      return page({ ...request, url: notice === undefined ? request.url : withNotice(request.url, notice) }, (context) => renderChat(context, view, found === undefined ? {} : { preview: { code, ...found } }));
    } },
    { method: "POST", pattern: /^\/chat\/(link|unlink|bind|unbind|notice-add|notice-remove|mute|schedule)$/, handle: async (request, match) => {
      const action = match[1] ?? "";
      const back = `${request.base}/chat`;
      const data = options.actions;
      if (options.data.getChatPage === undefined) return notFound();
      const field = (name: string, max = 128): string => (request.form?.get(name) ?? "").trim().slice(0, max);
      const CHANNEL = /^[a-z][a-z0-9-]{1,31}$/u, OPAQUE = /^[A-Za-z0-9._:+@=-]{1,128}$/u;
      const subjectOf: Record<string, string> = {
        link: field("code", 64), unlink: `${field("channel")}/${field("tenant")}/${field("userId")}`, bind: "new", unbind: `${field("channel")}/${field("tenant")}/${field("space")}`,
        "notice-add": "new", "notice-remove": `${field("channel")}/${field("tenant")}/${field("space")}/${field("thread")}`, mute: field("muted") === "yes" ? "on" : "off",
        schedule: "schedule",
      };
      if (!verified(request, { action: `chat.${action}`, subject: subjectOf[action] ?? "" })) return redirect(`${back}?n=form`);
      // Linking an account, binding a space and choosing where task titles go change who can act as the owner: only from a page session opened a few minutes ago, checked here and not only when the page was drawn.
      if (!tokenPageIsFresh(request)) return redirect(`${back}?n=chatfresh`);
      const channel = field("channel"), tenant = field("tenant"), space = field("space"), thread = field("thread"), userId = field("userId");
      if (action === "link") {
        if (data.linkChatAccount === undefined || field("confirmed") !== "yes" || !/^[A-Za-z0-9_-]{32}$/u.test(field("code", 64))) return redirect(`${back}?n=invalid`);
        return redirect(`${back}?n=${outcomeCode(await data.linkChatAccount({ code: field("code", 64) }), "linked")}`);
      }
      if (action === "mute") {
        if (data.muteNotices === undefined) return redirect(`${back}?n=invalid`);
        const muted = field("muted") === "yes";
        return redirect(`${back}?n=${outcomeCode(await data.muteNotices({ muted }), muted ? "muted" : "unmuted")}`);
      }
      if (action === "schedule") {
        if (data.setNoticeSchedule === undefined) return redirect(`${back}?n=invalid`);
        return redirect(`${back}?n=${outcomeCode(await data.setNoticeSchedule({ quietStart: field("quietStart", 5), quietEnd: field("quietEnd", 5), timeZone: field("timeZone", 64), digestAt: field("digestAt", 5) }), "scheduled")}`);
      }
      if (!CHANNEL.test(channel) || !OPAQUE.test(tenant)) return redirect(`${back}?n=invalid`);
      if (action === "unlink") {
        if (data.unlinkChatAccount === undefined || !OPAQUE.test(userId)) return redirect(`${back}?n=invalid`);
        return redirect(`${back}?n=${outcomeCode(await data.unlinkChatAccount({ channel, tenant, userId }), "unlinked")}`);
      }
      if (!OPAQUE.test(space)) return redirect(`${back}?n=invalid`);
      if (action === "bind") {
        const project = field("project");
        if (data.bindChatSpace === undefined || project === "") return redirect(`${back}?n=invalid`);
        return redirect(`${back}?n=${outcomeCode(await data.bindChatSpace({ channel, tenant, space, project }), "bound")}`);
      }
      if (action === "unbind") {
        if (data.unbindChatSpace === undefined) return redirect(`${back}?n=invalid`);
        return redirect(`${back}?n=${outcomeCode(await data.unbindChatSpace({ channel, tenant, space }), "unbound")}`);
      }
      if (thread !== "" && !OPAQUE.test(thread)) return redirect(`${back}?n=invalid`);
      if (action === "notice-add") {
        if (data.addNoticeTarget === undefined) return redirect(`${back}?n=invalid`);
        return redirect(`${back}?n=${outcomeCode(await data.addNoticeTarget({ channel, tenant, space, ...(thread === "" ? {} : { thread }) }), "noticed")}`);
      }
      if (data.removeNoticeTarget === undefined || thread === "") return redirect(`${back}?n=invalid`);
      return redirect(`${back}?n=${outcomeCode(await data.removeNoticeTarget({ channel, tenant, space, thread }), "unnoticed")}`);
    } },
    { method: "GET", pattern: /^\/setup$/, handle: async (request) => {
      if (options.data.listSetupProjects === undefined) return notFound();
      const projects = await options.data.listSetupProjects();
      return page(request, (context) => renderSetupIndex(context, projects));
    } },
    { method: "GET", pattern: new RegExp(`^/setup/(${PROJECT})$`), handle: async (request, match) => {
      const view = await options.data.getSetupPage?.(match[1] ?? "");
      return view === undefined ? notFound() : page(request, (context) => renderSetupPage(context, view));
    } },
    { method: "POST", pattern: new RegExp(`^/setup/(${PROJECT})/(start|stop|command|confirm|discard|check|host|forget|apply)$`), handle: async (request, match) => {
      const project = match[1] ?? "";
      const verb = match[2] ?? "";
      const back = `${request.base}/setup/${project}`;
      const actions = options.actions;
      const requestId = request.form?.get("requestId") ?? "";
      const done = (result: LocalActionResult): Reply => redirect(`${back}?n=${outcomeCode(result, "setupdone")}`);
      if (options.data.getSetupPage === undefined) return redirect(`${back}?n=setupoff`);
      // A write that makes a request names it with a UUID the form carried; the form token binds the project, the action and that id.
      if (["start", "stop", "command", "confirm", "check"].includes(verb) && !UUID.test(requestId)) return redirect(`${back}?n=invalid`);
      switch (verb) {
        case "start": case "stop": case "check": {
          const name = verb === "start" ? "setupStart" : verb === "stop" ? "setupStop" : "setupCheck";
          if (actions[name] === undefined) return redirect(`${back}?n=setupoff`);
          if (!verified(request, { action: `setup.${verb}`, subject: project, requestId })) return redirect(`${back}?n=form`);
          return done(await actions[name]({ project, requestId }));
        }
        case "command": {
          if (actions.setupCommand === undefined) return redirect(`${back}?n=setupoff`);
          if (!verified(request, { action: "setup.command", subject: project, requestId })) return redirect(`${back}?n=form`);
          return done(await actions.setupCommand({ project, requestId, command: text(request, "command") }));
        }
        case "confirm": {
          const revision = Number(request.form?.get("revision"));
          if (actions.setupConfirm === undefined || !Number.isSafeInteger(revision) || revision < 0) return redirect(`${back}?n=invalid`);
          if (!verified(request, { action: "setup.confirm", subject: project, requestId, revision })) return redirect(`${back}?n=form`);
          const chosen = (request.form?.getAll("item") ?? []).filter((id) => /^[A-Za-z0-9_-]{1,100}$/u.test(id)).slice(0, 64);
          return done(await actions.setupConfirm({ project, requestId, expectedRevision: revision, itemIds: chosen.length === 0 ? undefined : chosen }));
        }
        case "discard": {
          if (actions.setupDiscard === undefined) return redirect(`${back}?n=setupoff`);
          if (!verified(request, { action: "setup.discard", subject: project })) return redirect(`${back}?n=form`);
          return done(await actions.setupDiscard({ project }));
        }
        case "forget": {
          const host = request.form?.get("host") ?? "";
          if (actions.setupForgetHost === undefined || !/^[A-Za-z0-9.-]{1,300}$/u.test(host)) return redirect(`${back}?n=invalid`);
          if (!verified(request, { action: "setup.forget", subject: `${project}:${host}` })) return redirect(`${back}?n=form`);
          return done(await actions.setupForgetHost({ project, host }));
        }
        case "host": {
          const offer = offerOf(request, "setup");
          const decision = request.form?.get("decision");
          const host = request.form?.get("host") ?? "";
          if (actions.setupDecideHost === undefined || offer === undefined || (decision !== "approve" && decision !== "reject") || !/^[A-Za-z0-9.-]{1,300}$/u.test(host)) return redirect(`${back}?n=invalid`);
          if (!verified(request, { action: "setup.host", subject: `${project}:${host}`, requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest })) return redirect(`${back}?n=form`);
          return done(await actions.setupDecideHost({ project, host, decision, approval: offer, proof: proofFor(request, offer) }));
        }
        default: {
          const offer = offerOf(request, "setup");
          const decision = request.form?.get("decision");
          if (actions.setupDecideProposal === undefined || offer === undefined || (decision !== "approve" && decision !== "reject")) return redirect(`${back}?n=invalid`);
          if (!verified(request, { action: "setup.apply", subject: project, requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest })) return redirect(`${back}?n=form`);
          return done(await actions.setupDecideProposal({ project, decision, approval: offer, proof: proofFor(request, offer) }));
        }
      }
    } },
    { method: "GET", pattern: new RegExp(`^/proof/(${TASK_ID})$`), handle: async (request, match) => {
      const view = await options.data.getProofReport(match[1] ?? "");
      return view === undefined ? notFound() : page(request, (context) => renderProof(context, view));
    } },
  ];

  const send = (response: ServerResponse, reply: Reply, head: boolean): void => {
    const body = typeof reply.body === "string" ? Buffer.from(reply.body, "utf8") : Buffer.from(reply.body);
    response.writeHead(reply.status, {
      "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "same-origin", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow", "cross-origin-resource-policy": "same-origin", "cross-origin-opener-policy": "same-origin",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'", ...reply.headers,
      "content-type": reply.type, "content-length": body.byteLength,
    });
    response.end(head ? undefined : body);
  };

  const readForm = async (request: IncomingMessage): Promise<URLSearchParams | undefined> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).byteLength;
      if (size > MAX_BODY_BYTES) return undefined;
      chunks.push(chunk as Buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  };

  const header = (request: IncomingMessage, name: string): string | undefined => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const head = request.method === "HEAD";
    const refusal = refuseRequest({
      method: request.method, host: header(request, "host"), origin: header(request, "origin"), referer: header(request, "referer"),
      secFetchSite: header(request, "sec-fetch-site"), remoteAddress: request.socket.remoteAddress, contentType: header(request, "content-type"), expectedOrigin: origin,
    });
    if (refusal !== undefined) return send(response, { status: refusal.status, type: "text/plain; charset=utf-8", body: "refused\n" }, head);
    let url: URL;
    try {
      url = new URL(request.url ?? "/", origin);
    } catch {
      return send(response, notFound(), head);
    }
    // /s/once/<code>: a single-use code (onceLink) is spent by the first GET and answered with a redirect to the owner's real page address. HEAD, POST and a spent, expired or unknown code are
    // answered like a path that does not exist.
    const once = /^\/s\/once\/([A-Za-z0-9_-]{32,64})$/.exec(url.pathname);
    if (once !== null) {
      const key = createHash("sha256").update(once[1] as string).digest("hex");
      const entry = request.method === "GET" ? onceCodes.get(key) : undefined;
      if (entry !== undefined) onceCodes.delete(key);
      if (entry === undefined || entry.expires <= now()) {
        if (limiter.failed()) return send(response, { status: 429, type: "text/plain; charset=utf-8", body: "slow down\n" }, head);
        return send(response, notFound(), head);
      }
      return send(response, redirect(ownerLink(entry.path, { label: entry.label, ...(entry.fresh ? { fresh: true } : {}) })), head);
    }
    // /s/<token>/<rest>. A wrong token is answered like a path that does not exist.
    const match = /^\/s\/([A-Za-z0-9_-]{43})(\/.*)?$/.exec(url.pathname);
    const session = sessions.find(match?.[1]);
    if (match === null || session === undefined) {
      if (limiter.failed()) return send(response, { status: 429, type: "text/plain; charset=utf-8", body: "slow down\n" }, head);
      return send(response, notFound(), head);
    }
    const token = match[1] as string;
    const rest = match[2] === undefined || match[2] === "" ? "/" : match[2];
    const method = request.method === "POST" ? "POST" : "GET";
    const route = routes.find((candidate) => candidate.method === method && candidate.pattern.test(rest));
    if (route === undefined) return send(response, notFound(), head);
    let form: URLSearchParams | undefined;
    if (method === "POST") {
      form = await readForm(request);
      if (form === undefined) return send(response, { status: 413, type: "text/plain; charset=utf-8", body: "too large\n" }, head);
    }
    // The route sees the path without the token, so its patterns and task ids read the same wherever the session lives.
    const inner = new URL(rest + url.search, origin);
    const reply = await route.handle({ session: { id: session.id, token, createdAt: session.createdAt }, url: inner, form, base: `/s/${token}`, origin }, route.pattern.exec(rest) as RegExpExecArray);
    send(response, reply, head);
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) send(response, { status: 500, type: "text/plain; charset=utf-8", body: "the page could not be drawn\n" }, false);
      else response.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port ?? 0, "127.0.0.1", () => { server.removeListener("error", onError); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the local pages did not bind a TCP port");
  origin = `http://127.0.0.1:${address.port}`;

  const linkIn = (token: string, path = "/"): string => `${origin}/s/${token}${path.startsWith("/") ? path : `/${path}`}`;
  const ownerLink = (path = "/", sessionOptions: { ttlMs?: number; label?: string | undefined; fresh?: boolean } = {}): string => {
    // One session serves the owner's links until it ends, so opening a second link does not push the first tab's session out of the cap.
    const mintOptions = { ...(sessionOptions.ttlMs === undefined ? {} : { ttlMs: sessionOptions.ttlMs }), ...(sessionOptions.label === undefined ? {} : { label: sessionOptions.label }) };
    if (sessionOptions.fresh !== true && (ownerToken === undefined || !sessions.isValidSecret(ownerToken))) ownerToken = sessions.mint(mintOptions).token;
    return linkIn(sessionOptions.fresh === true ? sessions.mint({ ...mintOptions, fresh: true }).token : (ownerToken as string), path);
  };
  return {
    origin, port: address.port, sessions,
    link: (path = "/", sessionOptions = {}) => ownerLink(path, sessionOptions),
    onceLink: (path = "/", onceOptions = {}) => {
      const code = randomBytes(24).toString("base64url");
      const at = now();
      for (const [key, entry] of onceCodes) if (entry.expires <= at) onceCodes.delete(key);
      // A few at a time: opening more than that in 30 seconds drops the oldest.
      while (onceCodes.size >= 8) onceCodes.delete(onceCodes.keys().next().value as string);
      onceCodes.set(createHash("sha256").update(code).digest("hex"), { path: path.startsWith("/") ? path : `/${path}`, label: onceOptions.label, fresh: onceOptions.fresh === true, expires: at + (onceOptions.ttlMs ?? 30_000) });
      return `${origin}/s/once/${code}`;
    },
    linkIn,
    async close() {
      sessions.revokeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

