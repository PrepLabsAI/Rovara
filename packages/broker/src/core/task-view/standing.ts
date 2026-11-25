// F2-A: `taskStandingFor`, the ONE function that says where a task stands for one person: its phase, step and strip, the pill THIS reader sees, who it waits on when that is not them, and the moves they may make now. The person-free
// half is `stateOf` (`state.ts`, shared with the stored session summary); the moves are S1's `actionsFor`, unchanged (ONE actions field; the owner-or-admin rule of Stop stays S1's). The name `standingOf` is S1's (who a person is to a
// task) and stays; this is what the task looks like to them.
//
// The pill is derived from the reader, so no surface looks a decision up itself: `Needs you` for the person the decision waits on (the owner, a co-owner), `Needs the task owner` for anyone else who may read it, `In review` while a pull
// request waits (merge is never a "Needs you" move), `Waiting` for every system wait. A person who may not read the task gets no standing at all (undefined: the surface says "not found").
import { DECISION_MOVES, ROLE_WORDS, pillOf, type ActionOffer, type RoleKey, type TaskStandingMembers, type TaskStatus } from "@agentx/contracts";
import { actionsFor } from "../task-actions/offers.js";
import { standingOf } from "../task-actions/standing.js";
import type { ActionCaller, ActionEnv, Standing } from "../task-actions/types.js";
import type { TaskRecord } from "../task-flow/records.js";
import { standingFactsOf, type ExtraFacts } from "./facts.js";
import { stateOf } from "./state.js";

/** What `taskStandingFor` answers: the standing for this reader (served as `standing`), and the person-free status line (served as `statusView`, never person-specific). */
export interface TaskStanding { standing: TaskStandingMembers; statusView: TaskStatus }

/** Whether the person the decision waits on is this reader. The owner rule covers the owner and a People co-owner; a company admin stands for `company_admin`. */
function isAsked(role: RoleKey, standing: Standing): boolean {
  if (role === "company_admin") return standing.kind === "admin" || (standing.kind === "owner" && standing.admin);
  return standing.kind === "owner";
}

export async function taskStandingFor(env: ActionEnv, caller: ActionCaller, task: TaskRecord, extra: ExtraFacts = {}): Promise<TaskStanding | undefined> {
  const standing = await standingOf(env.deps, caller, task);
  if (standing === undefined) return undefined;
  const [facts, actions] = await Promise.all([standingFactsOf(env.deps, task, extra), actionsFor(env, caller, task)]);
  const state = stateOf(facts);
  let pill = state.pill === "decision" ? undefined : pillOf(state.pill);
  let waitingOn: TaskStandingMembers["waitingOn"];
  if (state.pill === "decision") {
    // A reader is "needed" when they are offered a decision move, or are the very person the decision waits on (a plan the host will not let them approve from here is still theirs).
    const needed = actions.some((offer: ActionOffer) => DECISION_MOVES.includes(offer.id)) || isAsked(state.role, standing);
    pill = needed ? pillOf("needs_you") : pillOf("needs_role", state.role);
    if (!needed) waitingOn = { role: state.role, words: ROLE_WORDS[state.role] };
  }
  const members: TaskStandingMembers = {
    pill: pill!, actions,
    ...(state.phase === undefined ? {} : { phase: state.phase }), ...(state.step === undefined ? {} : { step: state.step }), ...(state.steps === undefined ? {} : { steps: state.steps }),
    ...(waitingOn === undefined ? {} : { waitingOn }),
  };
  return { standing: members, statusView: state.status };
}
