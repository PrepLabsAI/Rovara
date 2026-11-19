// A small world for the automation tests: the document store, a clock, an admission that can refuse, a recording audit sink, a starter that records every unattended start, the owner's approvers, and the stores and
// dependencies built on them. Nothing here names a provider.
import { INDEX_EXPIRY_ATTRIBUTE, type Admission, type AdmissionRequest, type ApprovalProof, type AuditEvent, type AuditSink, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createLocalOwnerApprovers, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import type { AutomationSwitch } from "../../packages/broker/src/core/automation/switch.js";
import type { AutomatedRunRequest, AutomatedRunStarter, UnattendedStartDeps } from "../../packages/broker/src/core/automation/run-seam.js";
import { AgentStore } from "../../packages/broker/src/core/agents/store.js";
import type { ProjectRules } from "../../packages/broker/src/core/agents/rules.js";
import type { RosterDependencies } from "../../packages/broker/src/core/agents/roster.js";
import { ChainStore } from "../../packages/broker/src/core/chains/store.js";
import type { ChainRunnerDeps } from "../../packages/broker/src/core/chains/runner.js";
import { TriggerStore } from "../../packages/broker/src/core/triggers/store.js";
import type { TriggerDispatchDeps } from "../../packages/broker/src/core/triggers/dispatch.js";
import { SchedulerError, type DueSchedule, type ScheduleEntry, type Scheduler } from "@agentx/contracts";
import type { UnattendedTasks } from "../../packages/broker/src/core/automation/run-seam.js";

export const COMPANY = "org_00000000000000000000" as OrgId;
export const OWNER = localOwnerPrincipal();
export const PROJECT = "web";
export const START = Date.parse("2026-11-10T10:00:00.000Z");

export interface AutomationWorld {
  clock: { now: number };
  store: MemoryDocumentStore;
  table: { store: MemoryDocumentStore; now: () => number };
  audit: AuditEvent[];
  admissions: AdmissionRequest[];
  refuseAdmission: { code: string; message: string } | undefined;
  releases: string[];
  settles: Array<{ id: string; actual: { tokens?: number; cost?: { micros: number; currency: string } } }>;
  starts: AutomatedRunRequest[];
  starter: AutomatedRunStarter & { failWith: Error | undefined; failAfterCommit: boolean };
  switchOn: { value: boolean };
  projects: Map<string, Pick<ProjectDefinition, "actionPolicy"> & { archived?: boolean }>;
  agents: AgentStore;
  chains: ChainStore;
  triggers: TriggerStore;
  rules: ProjectRules;
  roster: RosterDependencies;
  unattended: UnattendedStartDeps;
  chainRuns: ChainRunnerDeps;
  /** What the fake host says of each task a start made: it ends when a test says so. */
  taskStates: Map<string, { end?: "succeeded" | "cancelled" | "failed"; waiting: boolean }>;
  enforces: { dollars: boolean };
  taskCosts: Map<string, number>;
  tasks: UnattendedTasks;
  scheduler: Scheduler & { entries: Map<string, ScheduleEntry>; /** When set, `put` is refused with these words (a scheduler that will not run the rule). */ refuse: string | undefined; fire(due: Partial<DueSchedule> & { scheduleId: string }): Promise<void>; handler: ((due: DueSchedule) => Promise<void>) | undefined };
  dispatch: TriggerDispatchDeps;
  proofFor(request: { requestId: string; revision: number; artifactDigest: string }, token?: string): ApprovalProof;
  cancelled: string[];
}

export function createAutomationWorld(options: { on?: boolean } = {}): AutomationWorld {
  const clock = { now: START };
  const store = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE, nowSeconds: () => Math.floor(clock.now / 1000) });
  const audit: AuditEvent[] = [];
  const auditSink: AuditSink = { stage: (event) => { audit.push(event); return []; }, async record(event) { audit.push(event); } };
  const world = { refuseAdmission: undefined as { code: string; message: string } | undefined };
  const admissions: AdmissionRequest[] = [];
  const releases: string[] = [];
  const settles: Array<{ id: string; actual: { tokens?: number; cost?: { micros: number; currency: string } } }> = [];
  const admission: Admission = {
    async admit(request) {
      admissions.push(request);
      if (world.refuseAdmission !== undefined) return { allowed: false, code: world.refuseAdmission.code, message: world.refuseAdmission.message };
      return { allowed: true, reservationId: `res-${String(admissions.length)}` };
    },
    async stage() { return { decision: { allowed: true }, items: [] }; },
    async settle(id, actual) { settles.push({ id, actual }); },
    async release(id) { releases.push(id); },
  };
  const starts: AutomatedRunRequest[] = [];
  const taskStates = new Map<string, { end?: "succeeded" | "cancelled" | "failed"; waiting: boolean }>();
  const made = new Map<string, string>();
  const starter = {
    failWith: undefined as Error | undefined,
    failAfterCommit: false,
    async start(request: AutomatedRunRequest) {
      if (starter.failWith !== undefined && !starter.failAfterCommit) throw starter.failWith;
      const existing = made.get(request.requestId);
      if (existing !== undefined) return { taskId: existing, duplicate: true };
      starts.push(request);
      const taskId = `task-${String(starts.length)}`;
      made.set(request.requestId, taskId);
      taskStates.set(taskId, { waiting: false });
      if (starter.failWith !== undefined) throw starter.failWith;
      return { taskId, duplicate: false };
    },
    async read(requestId: string) { const taskId = made.get(requestId); return taskId === undefined ? undefined : { taskId }; },
  };
  const switchOn = { value: options.on ?? true };
  const automation: AutomationSwitch = { enabled: () => switchOn.value };
  const table = { store, now: () => clock.now };
  const projects = new Map<string, Pick<ProjectDefinition, "actionPolicy"> & { archived?: boolean }>([[PROJECT, {}]]);
  const rules: ProjectRules = { async definition(project) { return projects.get(project); } };
  let counter = 0;
  const idBody = () => { counter += 1; return counter.toString(36).padStart(20, "0"); };
  const agents = new AgentStore({ ...table, audit: auditSink, companyId: COMPANY, newId: () => `agt_${idBody()}` });
  const chains = new ChainStore({ ...table, audit: auditSink, companyId: COMPANY, newId: () => `chn_${idBody()}` as never });
  const triggers = new TriggerStore({ ...table, newId: () => `ctr_${idBody()}` });
  const roster: RosterDependencies = { store: agents, rules };
  const enforces = { dollars: true };
  const cancelled: string[] = [];
  const taskCosts = new Map<string, number>();
  const tasks: UnattendedTasks = {
    async costUsd(taskId) { return taskCosts.get(taskId); },
    async read(taskId) { const state = taskStates.get(taskId); return state === undefined ? undefined : { ...(state.end === undefined ? {} : { end: state.end }), waiting: state.waiting }; },
    async cancel(taskId) { cancelled.push(taskId); const state = taskStates.get(taskId); if (state !== undefined) state.end = "cancelled"; },
  };
  const unattended: UnattendedStartDeps = { automation, companyId: COMPANY, admission, audit: auditSink, starter, enforces, store, tasks, now: () => clock.now };
  const chainRuns: ChainRunnerDeps = {
    ...table, companyId: COMPANY, chains, roster, unattended, cancelTask: (taskId) => tasks.cancel(taskId), log: () => undefined,
    taskOpen: async (taskId) => { const state = taskStates.get(taskId); return state !== undefined && state.end === undefined; }, taskWaiting: async (taskId) => taskStates.get(taskId)?.waiting === true,
  };
  const approvers = createLocalOwnerApprovers({ verifySession: (token) => token.startsWith("owner-page:") });
  const scheduler: AutomationWorld["scheduler"] = {
    entries: new Map(), handler: undefined, refuse: undefined, capabilities: { timezones: ["UTC"], minEveryMinutes: 1, deliversMissed: true },
    async get(_company: string, scheduleId: string) { return scheduler.entries.get(scheduleId); },
    async put(entry: ScheduleEntry) { if (scheduler.refuse !== undefined) throw new SchedulerError("refused", scheduler.refuse); scheduler.entries.set(entry.scheduleId, entry); },
    async remove(_company: string, scheduleId: string) { return scheduler.entries.delete(scheduleId); },
    subscribe(handler: (due: DueSchedule) => Promise<void>) { scheduler.handler = handler; return { stop: async () => { scheduler.handler = undefined; } }; },
    async fire(due: Partial<DueSchedule> & { scheduleId: string }) {
      const entry = scheduler.entries.get(due.scheduleId);
      await scheduler.handler!({ companyId: COMPANY, scheduledAt: new Date(clock.now).toISOString(), slotId: `slot-${String(clock.now)}`, attempt: 1, target: entry?.target ?? { kind: "trigger", ref: {} }, ...due });
    },
  };
  const requirements = { roster, chains, unattendedCap: () => (enforces.dollars ? undefined : "no dollar cap") };
  const dispatch: TriggerDispatchDeps = {
    ...table, companyId: COMPANY, automation, audit: auditSink, approvers, triggers, requirements, scheduler, chainRuns, unattended, owner: { developerId: OWNER.personId }, log: () => undefined,
  };
  return {
    clock, store, table, taskStates, taskCosts, enforces, tasks, audit, admissions, get refuseAdmission() { return world.refuseAdmission; }, set refuseAdmission(value) { world.refuseAdmission = value; }, releases, settles, starts, starter, switchOn, projects, agents, chains, triggers, rules, roster, unattended, chainRuns, scheduler, dispatch, cancelled,
    proofFor: (request, token = "owner-page:session") => ({ proofId: `proof-${String(Math.random()).slice(2)}`, method: "local-session", requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest, token }),
  };
}


/** The overlay of a report-only agent that an event, a schedule or a person may start. */
export const reporterOverlay = (extra: Record<string, unknown> = {}) => ({
  instructions: "Look at the change and report what you find.",
  sequence: [{ id: "look", name: "Look", kind: "agent", workspace: "read" }],
  triggers: [{ kind: "person" }, { kind: "event", source: "github", type: "pull_request.opened" }, { kind: "schedule", schedule: { kind: "interval", minutes: 60 }, timezone: "UTC", missed: "skip" }],
  ...extra,
});

/** Makes an agent and publishes its draft; returns its id and version. */
export async function publishAgent(world: AutomationWorld, overlay: unknown = reporterOverlay(), name = "Reporter"): Promise<{ agentId: string; version: number }> {
  const { resolveAgent } = await import("../../packages/broker/src/core/agents/store.js");
  const { validateRecipeForCompany } = await import("../../packages/broker/src/core/agents/guardrails.js");
  const record = await world.agents.create({ orgId: COMPANY, name, by: OWNER.personId, overlay });
  const recipe = await resolveAgent(world.agents, COMPANY, record.agentId, "draft");
  const problems = await validateRecipeForCompany(world.agents.table, COMPANY, recipe);
  const version = await world.agents.publish({ orgId: COMPANY, agentId: record.agentId, expectedDraftRevision: 1, by: OWNER.personId, recipe, problems });
  return { agentId: record.agentId, version: version.version };
}

/** Makes a one-step chain on `agentId`, publishes it (pinned) and returns its id. */
export async function publishChain(world: AutomationWorld, agentId: string, definition: Record<string, unknown> = {}, name = "Review chain"): Promise<string> {
  const { validateChainForPublish } = await import("../../packages/broker/src/core/chains/validate.js");
  const design = { start: "first", steps: [{ kind: "agent", id: "first", name: "First", agent: { agentId, version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 5 }, ...definition };
  const chain = await world.chains.create({ orgId: COMPANY, name, by: OWNER.personId, definition: design });
  const draft = (await world.chains.getDraft(COMPANY, chain.chainId))!;
  const checked = await validateChainForPublish(world.roster, COMPANY, draft.definition);
  await world.chains.publish({ orgId: COMPANY, chainId: chain.chainId, expectedDraftRevision: draft.revision, by: OWNER.personId, pinned: checked.pinned, problems: checked.problems, guardrailsRevision: checked.guardrailsRevision });
  return chain.chainId;
}

/** Publishes the next version of an agent: its draft is saved with `overlay` and published. */
export async function republishAgent(world: AutomationWorld, agentId: string, overlay: unknown): Promise<number> {
  const { resolveAgent } = await import("../../packages/broker/src/core/agents/store.js");
  const { validateRecipeForCompany } = await import("../../packages/broker/src/core/agents/guardrails.js");
  const draft = (await world.agents.getDraft(COMPANY, agentId))!;
  const saved = await world.agents.saveDraft({ orgId: COMPANY, agentId: agentId, overlay, expectedRevision: draft.revision, by: OWNER.personId });
  const recipe = await resolveAgent(world.agents, COMPANY, agentId, "draft");
  const problems = await validateRecipeForCompany(world.agents.table, COMPANY, recipe);
  return (await world.agents.publish({ orgId: COMPANY, agentId: agentId, expectedDraftRevision: saved.revision, by: OWNER.personId, recipe, problems })).version;
}

/** Publishes the next version of a chain with `definition`. */
export async function republishChain(world: AutomationWorld, chainId: string, definition: unknown): Promise<number> {
  const { validateChainForPublish } = await import("../../packages/broker/src/core/chains/validate.js");
  const draft = (await world.chains.getDraft(COMPANY, chainId))!;
  const saved = await world.chains.saveDraft({ orgId: COMPANY, chainId: chainId, definition, expectedRevision: draft.revision, by: OWNER.personId });
  const checked = await validateChainForPublish(world.roster, COMPANY, saved.definition);
  return (await world.chains.publish({ orgId: COMPANY, chainId: chainId, expectedDraftRevision: saved.revision, by: OWNER.personId, pinned: checked.pinned, problems: checked.problems, guardrailsRevision: checked.guardrailsRevision })).version;
}
