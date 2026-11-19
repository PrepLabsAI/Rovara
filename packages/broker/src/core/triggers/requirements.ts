// What a trigger needs of the rest of the system, in one place: `triggerProblems` answers what a trigger needs and does not have. The routes ask it before they store or turn on a trigger; the rechecks ask it after a
// change that might have taken something away; dispatch and the schedule handler ask it again before every start, so a change that no recheck saw is still caught. It reads live and trusts nothing stored on the
// trigger but what the trigger itself says.
import {
  AgentXError, BUILTIN_AGENTS, BUILTIN_TRIGGER_SUGGESTIONS, ROVARA_CODE_AGENT_ID, agentXError, builtinDefaultPin, intakeEventRequiredFilter, isBuiltinAgentId, isIntakeEventSpec,
  type AgentId, type AgentXErrorCode, type OrgId, type ResolvedRecipe, type TriggerTarget,
} from "@agentx/contracts";
import { resolveAgentForAutonomousRun, type RosterDependencies } from "../agents/roster.js";
import { resolveAgent } from "../agents/store.js";
import { autonomousTriggerProblems, formatChainProblem, type ChainProblem } from "../chains/validate.js";
import type { ChainStore } from "../chains/store.js";
import type { TriggerRecord } from "./store.js";

/** One thing a trigger needs and does not have. `code` is the error a route refuses with when the problem is the one it is told (absent: `CONFIG_INVALID`, in the form `<path>: <message>`). */
export interface TriggerProblem extends ChainProblem { code?: AgentXErrorCode }

export function triggerProblemError(problem: TriggerProblem): AgentXError {
  return agentXError(problem.code ?? "CONFIG_INVALID", triggerProblemText(problem));
}

/** A problem as one line, for the trigger's `disabledReason` and the notices. */
export const triggerProblemText = (problem: TriggerProblem): string => (problem.code === undefined && problem.path !== "" ? formatChainProblem(problem) : problem.message);

/** A hook as a trigger's checks need it (the endpoint a vendor posts events to). Hooks need a reachable address; an install without them has no reader and says so. */
export interface TriggerHook { orgId: OrgId; hookId: string; project: string; source: string; disabled: boolean }
export interface TriggerHookReader { get(orgId: OrgId, hookId: string): Promise<TriggerHook | undefined> }

export interface TriggerRequirementDeps {
  roster: RosterDependencies;
  chains: ChainStore;
  hooks?: TriggerHookReader | undefined;
  /** Why this install can start no unattended paid work (no dollar cap is enforced), or undefined when it can. Asked of every trigger: a trigger that could never start is not turned on. */
  unattendedCap?: (() => string | undefined) | undefined;
}

const KIND_WORDS = { event: "events", schedule: "schedules" } as const;
const sentence = (text: string) => text.replace(/\.+$/u, "");
const reasonOf = (error: AgentXError): string => (error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message);

/** The target's display name; undefined when it is not there. */
async function nameOfTarget(deps: TriggerRequirementDeps, orgId: OrgId, target: TriggerTarget): Promise<string | undefined> {
  if (target.kind === "chain") return (await deps.chains.get(orgId, target.chainId))?.name;
  return isBuiltinAgentId(target.agentId) ? BUILTIN_AGENTS[target.agentId].name : (await deps.roster.store.get(orgId, target.agentId))?.name;
}

/** The words a notice or a route uses for what a trigger is on; `a deleted chain` when it is gone. */
export async function targetName(deps: TriggerRequirementDeps, orgId: OrgId, target: TriggerTarget): Promise<string> {
  return (await nameOfTarget(deps, orgId, target)) ?? (target.kind === "chain" ? "a chain that was deleted" : "an agent that was deleted");
}

/** The published version of a trigger's target now: a chain's or a custom agent's current version, a built-in's shipped release; undefined when it has none (or is gone). */
export async function targetVersionOf(deps: TriggerRequirementDeps, orgId: OrgId, target: TriggerTarget): Promise<number | undefined> {
  if (target.kind === "chain") return (await deps.chains.get(orgId, target.chainId))?.currentVersion;
  return isBuiltinAgentId(target.agentId) ? builtinDefaultPin(target.agentId) : (await deps.roster.store.get(orgId, target.agentId))?.currentVersion;
}

/** What the trigger does, in words: `github pull request opened` or `every 60 minutes`. */
export function triggerWords(trigger: Pick<TriggerRecord, "spec">): string {
  const { spec } = trigger;
  if (spec.kind === "event") return `${spec.source} ${spec.type.replaceAll(".", " ").replaceAll("_", " ")}`;
  const { schedule } = spec;
  if (schedule.kind === "interval") return `every ${String(schedule.minutes)} minutes`;
  if (schedule.kind === "daily") return `daily at ${schedule.at}${schedule.days === undefined ? "" : ` on ${schedule.days.join(", ")}`}`;
  return `weekly on ${schedule.day} at ${schedule.at}`;
}

const unavailable = (chain: string, step: string, agent: string, version: number, reason: string): TriggerProblem => ({
  path: "target", code: "CHAIN_UNAVAILABLE",
  message: `${chain}'s step "${step}" uses ${agent} version ${String(version)}, which can't run now: ${sentence(reason)}. Publish a new version.`,
});

/** What the chain's current version needs for an unattended start: its run limit and a gate the owner can decide, and each step's agent usable on the project at its pinned version. */
async function chainProblems(deps: TriggerRequirementDeps, trigger: TriggerRecord): Promise<TriggerProblem[]> {
  const { orgId } = trigger;
  if (trigger.target.kind !== "chain") return [];
  const chain = await deps.chains.get(orgId, trigger.target.chainId);
  if (chain === undefined) return [{ path: "target", code: "NOT_FOUND", message: "no chain has that ID" }];
  if (chain.status !== "active") return [{ path: "target", code: "CHAIN_UNAVAILABLE", message: `${chain.name} is archived, so it can't start new runs.` }];
  const version = chain.currentVersion === undefined ? undefined : await deps.chains.getVersion(orgId, chain.chainId, chain.currentVersion);
  if (version === undefined) return [{ path: "target", code: "CHAIN_UNAVAILABLE", message: `${chain.name} has no published version yet, so it can't start new runs.` }];
  const problems: TriggerProblem[] = autonomousTriggerProblems({ pinned: version.definition }).map((problem) => (
    problem.path === "limits.maxRunUsd" ? { path: problem.path, code: "CHAIN_BUDGET_REQUIRED" as const, message: `${chain.name} has no limit on one run, so events and schedules can't start it. Set one in the chain's design.` } : problem
  ));
  const seen = new Set<string>();
  for (const step of version.definition.steps) {
    if (step.kind !== "agent") continue;
    const { agentId, version: pinned } = step.agent;
    const key = `${agentId}@${String(pinned)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = (await nameOfTarget(deps, orgId, { kind: "agent", agentId })) ?? agentId;
    try {
      await resolveAgentForAutonomousRun(deps.roster, { orgId, project: trigger.project, agentId, version: pinned });
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      problems.push(unavailable(chain.name, step.name, name, pinned, reasonOf(error)));
    }
  }
  return problems;
}

/** Whether a recipe's (or a built-in's suggested) trigger specs list a spec of the same kind, and for an event the same source and type. */
function allows(specs: ReadonlyArray<{ kind: string; source?: string; type?: string }>, wanted: TriggerRecord["spec"]): boolean {
  return specs.some((spec) => spec.kind === wanted.kind && (wanted.kind !== "event" || (spec.source === wanted.source && spec.type === wanted.type)));
}

/** What an agent needs to be started by a trigger: it allows this way, and it resolves for an unattended run on the project. */
async function agentProblems(deps: TriggerRequirementDeps, trigger: TriggerRecord): Promise<TriggerProblem[]> {
  const { orgId } = trigger;
  if (trigger.target.kind !== "agent") return [];
  const agentId: AgentId = trigger.target.agentId;
  let recipe: ResolvedRecipe | undefined;
  let name: string;
  if (isBuiltinAgentId(agentId)) name = BUILTIN_AGENTS[agentId].name;
  else {
    const record = await deps.roster.store.get(orgId, agentId);
    if (record === undefined) return [{ path: "target", code: "NOT_FOUND", message: "no agent has that ID" }];
    name = record.name;
    if (record.status === "archived") return [{ path: "target", code: "AGENT_UNAVAILABLE", message: `${record.name} is archived, so it can't start new work.` }];
    if (record.currentVersion === undefined) return [{ path: "target", code: "AGENT_UNAVAILABLE", message: `${record.name} has no published version yet, so it can't start new work.` }];
    try {
      recipe = await resolveAgent(deps.roster.store, orgId, agentId, record.currentVersion);
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return [{ path: "target", code: "AGENT_UNAVAILABLE", message: `${record.name}'s version ${String(record.currentVersion)} can't run now: ${sentence(reasonOf(error))}.` }];
    }
  }
  const specs = recipe === undefined ? BUILTIN_TRIGGER_SUGGESTIONS[agentId as keyof typeof BUILTIN_TRIGGER_SUGGESTIONS] : recipe.triggers;
  if (!allows(specs, trigger.spec)) return [{ path: "spec", message: `${name} can't be started by ${KIND_WORDS[trigger.spec.kind]}; allow it in the agent first` }];
  // Rovara Code asked for by a label or an assignment on an issue: the trigger must name the label (or the assignee) that asks, so no other label and no other assignment starts work.
  if (agentId === ROVARA_CODE_AGENT_ID && trigger.spec.kind === "event" && isIntakeEventSpec(trigger.spec)) {
    const key = intakeEventRequiredFilter(trigger.spec);
    if ((trigger.spec.filter?.[key] ?? []).length === 0) return [{ path: `spec.filter.${key}`, message: key === "label" ? "name the label that asks Rovara Code for work, so no other label does" : "name who an issue is assigned to when it asks Rovara Code for work, so no other assignment does" }];
  }
  try {
    await resolveAgentForAutonomousRun(deps.roster, { orgId, project: trigger.project, agentId });
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
    return [{ path: "target", code: error.code === "NOT_FOUND" ? "AGENT_UNAVAILABLE" : error.code, message: reasonOf(error) }];
  }
  return [];
}

/** What an event trigger needs of the hook that receives its events. A code host's own events have no hook. */
async function eventProblems(deps: TriggerRequirementDeps, trigger: TriggerRecord): Promise<TriggerProblem[]> {
  const { spec, orgId } = trigger;
  if (spec.kind !== "event") return [];
  const problems: TriggerProblem[] = [];
  if (spec.source === "github") {
    if (trigger.hookId !== undefined) problems.push({ path: "hookId", message: "a code host's events come through its own connection and have no hook" });
  } else if (trigger.hookId === undefined) {
    problems.push({ path: "hookId", message: `name the ${spec.source} hook that receives these events` });
  } else if (deps.hooks === undefined) {
    problems.push({ path: "hookId", code: "RUNTIME_UNAVAILABLE", message: "event hooks are not set up on this install" });
  } else {
    const hook = await deps.hooks.get(orgId, trigger.hookId);
    if (hook === undefined || hook.orgId !== orgId || hook.project !== trigger.project || hook.source !== spec.source) problems.push({ path: "hookId", code: "NOT_FOUND", message: "no hook has that ID" });
    else if (hook.disabled) problems.push({ path: "hookId", message: "that hook is turned off" });
  }
  return problems;
}

/** Everything a trigger needs and does not have, the first problem first: the target (it exists, is active, has a current version), what the target needs, and the hook. Empty when it can start work. */
export async function triggerProblems(deps: TriggerRequirementDeps, trigger: TriggerRecord): Promise<TriggerProblem[]> {
  const problems: TriggerProblem[] = [];
  problems.push(...(trigger.target.kind === "chain" ? await chainProblems(deps, trigger) : await agentProblems(deps, trigger)));
  problems.push(...await eventProblems(deps, trigger));
  // A trigger that is on runs the target version the owner turned it on for, and nothing newer: a publish since then (by anyone, with the owner's own token too) turns it off until the owner looks again.
  if (trigger.enabled && problems.length === 0 && trigger.approvedVersion !== await targetVersionOf(deps, trigger.orgId, trigger.target)) {
    problems.push({ path: "target", message: `${await targetName(deps, trigger.orgId, trigger.target)} changed since you turned this trigger on; read it again and turn the trigger on again` });
  }
  const capped = deps.unattendedCap?.();
  if (capped !== undefined) problems.push({ path: "target", code: "AGENT_BUDGET_REQUIRED", message: capped });
  return problems;
}
