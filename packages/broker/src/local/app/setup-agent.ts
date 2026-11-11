// The setup agent on `rovara up`: the owner's routes, the worker's callback and what the owner's page reads and does, over the task flow, the code host the registry holds and the approval gate.
//
//   - Who: the owner of this install, on the API session. A script token never reaches these routes (a setup run spends model money by the minute and runs the repository's own commands).
//   - A person's command, a website, and the use of a setup are the owner's own acts on the page: the routes here answer them with the page's words and never decide them (`SETUP_COMMAND_WORDS.pageOnly`).
//   - The decision of a website or of a proposal goes through the approval gate, which asks the Approvers seam about the page's own session proof.
import { createHash } from "node:crypto";
import { AgentXError, IMPLICIT_COMPANY_ID, agentXError, setupItemsOf, setupItemHandling, type AdapterRegistry, type ApprovalProof, type OrgId, type Principal, type SetupVerification } from "@agentx/contracts";
import type { DecisionGate } from "../../core/decisions/approval-gate.js";
import { localResultOf } from "../../core/decisions/local-actions.js";
import { developerIdOf } from "../../core/sessions/create.js";
import type { ApprovalOffer, LocalActionResult, SetupHostAskView, SetupItemView, SetupPageView } from "../../core/local-pages/views.js";
import { codeHostForRecord } from "../../plugins/routing.js";
import { listProjects } from "./projects.js";
import { startTask } from "../../core/task-flow/start.js";
import type { TaskCaller, TaskFlowDeps } from "../../core/task-flow/deps.js";
import { readState, startSetupAgent, stopSetupAgent, verifiedView, getSetupAgent, type SetupAgentView } from "../../core/setup-agent/agent.js";
import { SETUP_APPLY_KIND, confirmSetupAgent, createSetupProposalSubject, discardSetupApply, readSetupApply, type SetupApplyDeps } from "../../core/setup-agent/apply.js";
import { setupStateOf, startProjectSetupCheck } from "../../core/setup-agent/check.js";
import { SETUP_COMMAND_WORDS, checkPersonCommand, queueSetupCommand } from "../../core/setup-agent/command.js";
import { SETUP_HOST_KIND, approvedHostsOf, forgetApprovedHost, createSetupHostSubject, hostAskDigest, hostAskSubjectId, HOST_ASK_REVISION, isInternationalName, listHostAsks, type SetupHostAsk } from "../../core/setup-agent/host-ask.js";
import type { SetupAgentCallbackDeps } from "../../core/setup-agent/callback.js";
import { readSetupJournal } from "../../core/setup-agent/journal.js";
import type { DecisionSubject } from "../../core/decisions/approval-gate.js";

/** The subjects the approval gate must know for the setup agent: a website a run asked for, and a project's waiting setup. */
export function setupDecisionSubjects(flow: TaskFlowDeps): DecisionSubject[] {
  return [createSetupHostSubject({ store: flow.store }), createSetupProposalSubject({ flow })];
}
import { createSessionControlHost } from "./host.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const ROUTE = /^\/v1\/app\/projects\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/(setup-agent|setup-check)(?:\/(stop|command|journal|confirm|discard))?$/u;
const bodyOf = (request: BrokerRequest): unknown => {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
};
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The request id a host ask's decision is made under: it names the ask as the owner saw it (the host and when it was asked), so a later ask for the same host is another decision. */
export const hostRequestId = (ask: Pick<SetupHostAsk, "orgId" | "project" | "host" | "askedAt">): string => `host-${sha(`${hostAskSubjectId(ask.orgId, ask.project, ask.host)}\n${ask.askedAt}`).slice(0, 40)}`;
/** The request id a proposal's decision is made under. */
export const proposalRequestId = (digest: string, candidateRevision: number): string => `setup-${digest.slice(0, 40)}-${String(candidateRevision)}`;

export interface LocalSetupAgentOptions {
  flow: TaskFlowDeps;
  registry: AdapterRegistry;
  gate: DecisionGate;
  owner: Principal;
  companyId?: OrgId | undefined;
  now: () => number;
  /** Whether the install has a model proxy that meters a run (the chosen model has a route). */
  modelAccessConfigured: () => Promise<boolean>;
  /** The websites the install's machines reach by their own list. */
  installDomains?: (() => readonly string[]) | undefined;
  /** `ROVARA_SETUP_AGENT=0`: the feature is off and every route and the worker's callback answer as an unknown path. */
  enabled: boolean;
}

export interface LocalSetupAgent {
  readonly enabled: boolean;
  /** What the worker's callback needs (`createCallbackHandler`'s `setupAgent`). */
  readonly callback: Omit<SetupAgentCallbackDeps, "store" | "companyId" | "now">;
  routes(request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined>;
  /** The owner's page: what it reads and what it does. */
  readonly page: {
    projects: () => Promise<string[]>;
    view: (project: string) => Promise<SetupPageView | undefined>;
    start: (input: { project: string; requestId: string }) => Promise<LocalActionResult>;
    stop: (input: { project: string; requestId: string }) => Promise<LocalActionResult>;
    command: (input: { project: string; requestId: string; command: string }) => Promise<LocalActionResult>;
    confirm: (input: { project: string; requestId: string; expectedRevision: number; itemIds: string[] | undefined }) => Promise<LocalActionResult>;
    discard: (input: { project: string }) => Promise<LocalActionResult>;
    forgetHost: (input: { project: string; host: string }) => Promise<LocalActionResult>;
    check: (input: { project: string; requestId: string }) => Promise<LocalActionResult>;
    decideHost: (input: { project: string; host: string; decision: "approve" | "reject"; approval: ApprovalOffer; proof: ApprovalProof }) => Promise<LocalActionResult>;
    decideProposal: (input: { project: string; decision: "approve" | "reject"; approval: ApprovalOffer; proof: ApprovalProof }) => Promise<LocalActionResult>;
  };
  /** The websites the owner approved for a project, for that project's machines to read when they start (an approval reaches no machine already running, and no other project's). A machine with no project gets none. */
  approvedHosts(project: string | undefined): Promise<string[]>;
}

const refusalOf = (error: unknown): LocalActionResult => {
  if (!(error instanceof AgentXError)) throw error;
  const reason = error.code === "NOT_FOUND" || error.code === "PROJECT_NOT_FOUND" ? "not_found" : error.code === "CONFIG_INVALID" ? "invalid" : error.code === "CHANGE_STALE" || error.code === "PROJECT_REVISION_MISMATCH" ? "stale" : "refused";
  return { ok: false, reason, message: error.message.slice(error.code.length + 2) };
};

export function createLocalSetupAgent(options: LocalSetupAgentOptions): LocalSetupAgent {
  const companyId = options.companyId ?? IMPLICIT_COMPANY_ID;
  const { flow } = options;
  const store = flow.store;
  const ownerDeveloperId = developerIdOf(options.owner);
  const control = createSessionControlHost(flow);
  const callerOf = (principal: Principal = options.owner): TaskCaller => ({ principal, client: "app" });

  const depsFor = async (principal: Principal = options.owner): Promise<SetupApplyDeps> => ({
    store, companyId, now: options.now, flow, modelAccessConfigured: await options.modelAccessConfigured(),
    starter: {
      async start(request) {
        const started = await startTask(flow, callerOf(principal), { requestId: request.requestId, project: request.project, instructions: request.text, title: `Set up ${request.project}` }, { setupAgent: { limits: request.limits, seenTaskId: request.seenTaskId } });
        return { taskId: started.task.taskId, duplicate: started.duplicate };
      },
      async cancel(request) { await control.cancelTask(request.taskId, request.requestId); },
    },
    async latest(project) {
      const found = await flow.projects.latest(project);
      return found === undefined ? undefined : { revision: found.definition.revision, definition: found.definition };
    },
    async requireNewWork(project) {
      const found = await flow.projects.latest(project);
      if (found?.archived === true) throw agentXError("PROJECT_ARCHIVED", `project \`${project}\` is archived; unarchive it to start new work`);
    },
    // The run's citations are read from the project's own code host at the commit the run read. A host that cannot answer leaves the item unchecked.
    readFile: (repository, path, commit, readOptions) => codeHostForRecord(options.registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } })
      .fileAtRevision({ url: repository.url }, path, commit, { orgId: companyId }, { ...(readOptions.untilLine === undefined ? {} : { untilLine: readOptions.untilLine }), timeoutMs: readOptions.timeoutMs, maxBytes: 262_144 }),
    stopperName: async (developerId) => (developerId === ownerDeveloperId ? options.owner.displayName : undefined),
  });

  const offerOfHost = (ask: SetupHostAsk): ApprovalOffer => ({ requestId: hostRequestId(ask), revision: HOST_ASK_REVISION, artifactDigest: hostAskDigest(ask), kind: "setup", risk: "high" });

  const view = async (project: string): Promise<SetupPageView | undefined> => {
    const deps = await depsFor();
    const latest = await deps.latest(project);
    if (latest === undefined) return undefined;
    const state: SetupAgentView = await verifiedView(deps, latest.definition, (await readState(deps, project, latest.revision)).view);
    const full = await flow.projects.latest(project);
    const check = full === undefined ? { status: "unchecked" as const } : await setupStateOf(flow, project, full.definition);
    const asks = await listHostAsks({ store, now: options.now }, companyId, project, ["open", "approved", "refused"]);
    const pointerTask = state.taskId;
    const journal = state.taskId === undefined ? [] : await readSetupJournal({ store }, { orgId: companyId, project, taskId: state.taskId });
    const verification = state.verification ?? {};
    const items: SetupItemView[] = state.proposal === undefined ? [] : setupItemsOf(state.proposal).map((item) => {
      const value = item.proposed.value as Record<string, unknown>;
      const commands = Array.isArray(value["commands"]) ? (value["commands"] as unknown[]).filter((line): line is string => typeof line === "string") : undefined;
      const lines = commands ?? [JSON.stringify(value).slice(0, 300)];
      const verdict: SetupVerification = verification[item.id] ?? "unchecked";
      return {
        id: item.id, kind: item.kind, lines: lines.slice(0, 20), verdict,
        from: item.proposed.from.slice(0, 4).map((citation) => (citation.path === undefined ? "inferred by Rovara, from no file" : `${citation.repo ?? ""}/${citation.path}${citation.line === undefined ? "" : `:${String(citation.line)}`}`)),
        usable: (item.kind === "setup" || item.kind === "tests") && setupItemHandling(item.kind, item.proposed.value) === "settings",
      };
    });
    const apply = await readSetupApply({ flow, store, companyId, now: options.now }, project);
    const waiting = apply !== undefined && apply.state === "checking";
    void pointerTask;
    const cannotStart = !options.enabled ? "Setting a project up with Rovara is off on this install." : (await options.modelAccessConfigured()) ? undefined : "Rovara has no model key on this install, so it cannot run a setup. Set a model key, then restart `rovara up`.";
    return {
      project, revision: latest.revision, status: state.status, ...(state.failure === undefined ? {} : { failure: state.failure }), ...(state.stoppedBy === undefined ? {} : { stoppedBy: state.stoppedBy.name }),
      limits: state.limits, ...(cannotStart === undefined ? {} : { cannotStart }),
      ...(state.summary === undefined ? {} : { summary: { commandsRun: state.summary.commandsRun, spendCents: state.summary.spendCents, elapsedMin: Math.round(state.summary.elapsedMs / 60_000), hostAsks: state.summary.hostAsks, partial: state.summary.partial, stop: state.summary.stop } }),
      items, verified: state.verified === true,
      journal: journal.map((entry) => ({ n: entry.n, source: entry.source, command: entry.command, exitCode: entry.exitCode, timedOut: entry.timedOut, flagged: entry.flagged, tail: entry.tail, blockedHosts: entry.blockedHosts })),
      hostAsks: asks.map((ask): SetupHostAskView => ({ host: ask.host, status: ask.state, international: isInternationalName(ask.host), ...(ask.from === undefined ? {} : { from: ask.from }), ...(ask.journalN === undefined ? {} : { journalN: ask.journalN }), ...(ask.state === "open" ? { approval: offerOfHost(ask) } : {}) })),
      check: { status: check.status, ...(check.failedStep === undefined ? {} : { failedStep: check.failedStep }) },
      ...(!waiting ? {} : { apply: {
        candidateRevision: apply.candidateRevision, setup: apply.setup, readiness: apply.readiness, check: { status: apply.checkState.status, ...(apply.checkState.failedStep === undefined ? {} : { failedStep: apply.checkState.failedStep }) },
        // The decision is offered only once the candidate check passed: before that there is nothing the owner could be asked to approve.
        ...(apply.checkState.status === "ready" ? { approval: { requestId: proposalRequestId(apply.digest, apply.candidateRevision), revision: apply.candidateRevision, artifactDigest: apply.digest, kind: "setup" as const, risk: "high" as const } } : {}),
      } }),
      approvedHosts: (await listHostAsks({ store, now: options.now }, companyId, project, ["approved"])).map((ask) => ({ host: ask.host, at: ask.decidedAt })),
    };
  };

  const decide = async (kind: string, subjectId: string, input: { decision: "approve" | "reject"; approval: ApprovalOffer; proof: ApprovalProof }, done: string): Promise<LocalActionResult> => {
    if (input.proof.requestId !== input.approval.requestId || input.proof.revision !== input.approval.revision || input.proof.artifactDigest !== input.approval.artifactDigest) return { ok: false, reason: "invalid", message: "That was not understood." };
    const result = await options.gate.decide({
      companyId, kind, subjectId, requestId: input.approval.requestId, outcome: input.decision === "approve" ? "approve" : "reject",
      seen: { revision: input.approval.revision, artifactDigest: input.approval.artifactDigest },
      credentials: [{ method: input.proof.method, token: input.proof.token, ...(input.proof.claimedAccount === undefined ? {} : { claimedAccount: input.proof.claimedAccount }) }],
      ...(input.decision === "reject" ? { reason: "Not now (setup)" } : {}), details: { via: "PAGE" },
    });
    return localResultOf(result, done);
  };

  const guarded = async (work: () => Promise<LocalActionResult>): Promise<LocalActionResult> => {
    if (!options.enabled) return { ok: false, reason: "not_found", message: "Setting a project up with Rovara is off on this install." };
    try { return await work(); } catch (error) { return refusalOf(error); }
  };

  const page: LocalSetupAgent["page"] = {
    async projects() { return options.enabled ? (await listProjects(store, companyId)).map((project) => project.name) : []; },
    view,
    start: (input) => guarded(async () => { const answer = await startSetupAgent(await depsFor(), input.project, { requestId: input.requestId }); return { ok: true, message: answer.status === 200 ? "That setup run is already going." : "Rovara is setting the project up." }; }),
    stop: (input) => guarded(async () => { await stopSetupAgent(await depsFor(), input.project, { requestId: input.requestId }, ownerDeveloperId); return { ok: true, message: "The setup run was stopped." }; }),
    command: (input) => guarded(async () => {
      const checked = checkPersonCommand(input.command);
      if (!checked.ok) return { ok: false, reason: "invalid", message: SETUP_COMMAND_WORDS[checked.reason] };
      const deps = await depsFor();
      const latest = await deps.latest(input.project);
      if (latest === undefined) return { ok: false, reason: "not_found", message: "That project is not here." };
      const state = await readState(deps, input.project, latest.revision);
      if (state.view.status !== "running" || state.pointer === undefined) return { ok: false, reason: "refused", message: SETUP_COMMAND_WORDS.notRunning };
      await queueSetupCommand({ store, now: options.now }, { orgId: companyId, project: input.project, taskId: state.pointer.taskId }, { requestId: input.requestId, command: checked.command, by: ownerDeveloperId });
      return { ok: true, message: "The command is queued. Its result appears in the journal." };
    }),
    confirm: (input) => guarded(async () => {
      await confirmSetupAgent(await depsFor(), input.project, { requestId: input.requestId, expectedRevision: input.expectedRevision, ...(input.itemIds === undefined ? {} : { itemIds: input.itemIds }) }, ownerDeveloperId);
      return { ok: true, message: "Rovara is checking those commands on a fresh workspace. You can approve them when the check passes." };
    }),
    discard: (input) => guarded(async () => ({ ok: true, message: (await discardSetupApply({ store, companyId, now: options.now }, input.project, ownerDeveloperId)) ? "That setup was discarded." : "There was no setup waiting." })),
    forgetHost: (input) => guarded(async () => ((await forgetApprovedHost({ store, now: options.now }, companyId, input.project, input.host, ownerDeveloperId)) ? { ok: true, message: "That website is taken back for the next machines of this project." } : { ok: false, reason: "not_found", message: "That website is not approved." })),
    check: (input) => guarded(async () => { await startProjectSetupCheck(flow, { project: input.project, requestId: input.requestId, startedBy: ownerDeveloperId }); return { ok: true, message: "Rovara is checking the project's setup." }; }),
    decideHost: (input) => guarded(() => decide(SETUP_HOST_KIND, hostAskSubjectId(companyId, input.project, input.host), input, input.decision === "approve" ? "That website is allowed for the next setup run." : "That website is refused.")),
    decideProposal: (input) => guarded(() => decide(SETUP_APPLY_KIND, input.project, input, input.decision === "approve" ? "The project now uses these setup commands." : "That setup was rejected.")),
  };

  const routes = async (request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined> => {
    const path = request.path.split("?")[0] ?? request.path;
    const match = ROUTE.exec(path);
    if (match === null || !options.enabled) return undefined;
    try {
      const project = match[1]!;
      const family = match[2]!;
      const tail = match[3];
      // The owner's own API session only: a script token holds no such right (a run spends money and runs repository code).
      if (caller.scriptToken !== undefined || !caller.principal.roles.includes("owner")) throw agentXError("FORBIDDEN", "only the owner of this install can set a project up");
      const deps = await depsFor(caller.principal);
      if (family === "setup-check") {
        if (tail !== undefined) return undefined;
        const latest = await flow.projects.latest(project);
        if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist`);
        if (request.method === "GET") return json(200, await setupStateOf(flow, project, latest.definition));
        if (request.method === "POST") {
          const requestId = (bodyOf(request) as { requestId?: unknown }).requestId;
          if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/u.test(requestId)) throw agentXError("CONFIG_INVALID", "requestId: name this request with a UUID");
          const started = await startProjectSetupCheck(flow, { project, requestId, startedBy: developerIdOf(caller.principal) });
          return json(started.duplicate ? 200 : 202, { workspaceId: started.workspaceId });
        }
        return undefined;
      }
      if (tail === undefined && request.method === "GET") return json(200, await getSetupAgent(deps, project));
      if (tail === undefined && request.method === "POST") { const answer = await startSetupAgent(deps, project, bodyOf(request)); return json(answer.status, answer.view); }
      if (tail === "stop" && request.method === "POST") { const answer = await stopSetupAgent(deps, project, bodyOf(request), developerIdOf(caller.principal)); return json(answer.status, answer.view); }
      if (tail === "command" && request.method === "POST") throw agentXError("FORBIDDEN", SETUP_COMMAND_WORDS.pageOnly);
      if (tail === "journal" && request.method === "GET") {
        const latest = await deps.latest(project);
        if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist`);
        const state = await readState(deps, project, latest.revision);
        const after = Number(new URL(request.path, "http://local").searchParams.get("after") ?? "0");
        if (!Number.isInteger(after) || after < 0 || after > 400) throw agentXError("CONFIG_INVALID", "after: a journal position");
        const asks = (await listHostAsks({ store, now: options.now }, companyId, project, ["open", "approved", "refused"])).slice(0, 50).map((ask) => ({ host: ask.host, status: ask.state, ...(ask.journalN === undefined ? {} : { journalN: ask.journalN }), ...(ask.from === undefined ? {} : { from: ask.from }) }));
        if (state.pointer === undefined) return json(200, { entries: [], status: state.view.status, hostAsks: asks });
        return json(200, { status: state.view.status, entries: await readSetupJournal({ store }, { orgId: companyId, project, taskId: state.pointer.taskId }, after), hostAsks: asks });
      }
      if (tail === "confirm" && request.method === "POST") return json(200, await confirmSetupAgent(deps, project, bodyOf(request), developerIdOf(caller.principal)));
      if (tail === "discard" && request.method === "POST") return json(200, { discarded: await discardSetupApply(deps, project, developerIdOf(caller.principal)) });
      return undefined;
    } catch (error) {
      if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
      throw error;
    }
  };

  return {
    enabled: options.enabled,
    callback: {
      installDomains: options.installDomains,
      // The owner is the only person who may type a command (read live at hand-over).
      mayStillRun: async (by) => by === ownerDeveloperId,
    },
    routes, page,
    async approvedHosts(project) {
      return project === undefined ? [] : approvedHostsOf({ store, now: options.now }, companyId, project);
    },
  };
}
