// S1: the task action registry's internal types. The declarations a surface sees (ids, input specs, offers, results, words) are in `@agentx/contracts` (`task-actions.ts`); these are what the Code side needs: the entry
// shape, the standing of the person pressing, and the capabilities a host wires. An entry is a plain object in one exported array (`entries.ts`): there is no registration function and no hook (the feature interface of F4
// later lets a feature contribute entries to the same list).
import type { ActionBinding, ActionOffer, ActionValues, ConfirmLines, InputSpec, OrgRole, TaskActionId, TaskActionRisk } from "@agentx/contracts";
import type { TaskCaller, TaskFlowDeps } from "../task-flow/deps.js";
import type { TaskActionsOptions, OwnerActing } from "../task-flow/owner-round.js";
import type { TaskRecord } from "../task-flow/records.js";

/** The person pressing, as the host knows them for this request (never from the press): the principal, and the role their membership gives them NOW in the task's company. */
export interface ActionCaller extends TaskCaller { companyRole?: OrgRole | undefined }

/** Who this person is to this task, read live for this press. `owner`: the owner rule (the person it runs for, or a People co-owner), with the live access fence. `admin`: a live company owner or admin. `reader`: may read it. */
export type Standing =
  | { kind: "owner"; acting: OwnerActing; admin: boolean }
  | { kind: "admin" }
  | { kind: "reader" };

/** The named rules of who may take an action (4.3): each evaluated in Code from the live standing, never from anything the surface sent. */
export type WhoRule = "owner" | "owner-or-admin" | "readers" | "merge" | "take-over" | "held";

/** The plan card's facts as the decision source projects them for this person: what a plan decision shows and what a raised limit asks. */
export interface PlanFacts {
  risk: "low" | "medium" | "high";
  riskReasons: readonly string[];
  /** The task's run limit now and the one approving sets; present only for a plan that sets a limit. */
  runLimit?: { currentUsd?: number | undefined; proposedUsd: number } | undefined;
  /** The one line a design with an open blocker needs before it is approved (the document's own rule). */
  reasonRequired: boolean;
  /** What approving starts, in the card's own fixed words. */
  next?: string | undefined;
  filesTouched?: number | undefined;
}

/** What the host gives the plan entries: the facts of the waiting document for this person, and the decision through the approval gate (as the chat's method). */
export interface PlanHost {
  facts(caller: ActionCaller, task: TaskRecord): Promise<PlanFacts | undefined>;
  decide(input: {
    caller: ActionCaller; task: TaskRecord; outcome: "approve" | "reject" | "request_changes"; binding: ActionBinding; requestId: string; reason?: string;
    selectedOptionalCheckIds?: readonly string[]; acknowledgedRunLimitUsd?: number;
  }): Promise<{ status: "decided" | "replayed" } | { status: "refused"; reason: string }>;
}

/** The merge core, as a person's press (`hosted-merge-routes.ts`). */
export interface MergeHost {
  standing(caller: ActionCaller, task: TaskRecord): Promise<{ may: boolean }>;
  readiness(caller: ActionCaller, task: TaskRecord): Promise<{ ready: boolean; message?: string | undefined; risk?: "low" | "medium" | "high" | undefined; heads?: Array<{ repositoryId: string; number: number; headSha: string }> | undefined }>;
  press(caller: ActionCaller, task: TaskRecord, input: { requestId: string; expectedHeads: Array<{ repositoryId: string; number: number; headSha: string }>; risk: "low" | "medium" | "high" }): Promise<void>;
}

/** The People moves a task offers in the first cut (the view, and taking over a task nobody owns). */
export interface PeopleHost {
  view(caller: ActionCaller, task: TaskRecord): Promise<{ lines: string[] } | undefined>;
  canTakeOwnership(caller: ActionCaller, task: TaskRecord): Promise<{ peopleRevision: number } | undefined>;
  takeOwnership(caller: ActionCaller, task: TaskRecord, input: { requestId: string; expectedPeopleRevision: number }): Promise<void>;
}

/** What a host wires for the registry. Every capability is optional: an entry whose capability is absent is not offered. */
export interface ActionEnv {
  deps: TaskFlowDeps;
  options: TaskActionsOptions;
  plan?: PlanHost | undefined;
  merge?: MergeHost | undefined;
  people?: PeopleHost | undefined;
  /** The task's own page, for a card's link (a host with an https address). */
  taskUrl?: ((taskId: string) => string | undefined) | undefined;
}

/** What `describe` answers for one entry: the form, and the confirm when the move needs one (`confirmDigest` hashes `lines` plus `bound`, so a press carries what was shown). */
export interface Description { spec: InputSpec; confirm?: ConfirmLines | undefined; bound?: unknown }

export interface PressContext {
  env: ActionEnv;
  /** `env.deps` with the audit sink naming the surface (`via`, bound by the entry point). */
  deps: TaskFlowDeps;
  caller: ActionCaller;
  task: TaskRecord;
  standing: Standing | undefined;
  binding: ActionBinding;
  /** One id per press, derived from the press itself: the same press twice is the same request. */
  requestId: string;
  values: ActionValues;
}

export interface Performed { status: "done" | "started" | "replayed"; said?: string | undefined; /** What the person may do next, from the move itself (the People view offers taking over). */ next?: ActionOffer[] | undefined }

export interface TaskActionEntry {
  id: TaskActionId;
  who: WhoRule;
  /** The risk of this move for these values (a finding answered "accept" is `high`, a limit-raising approve is `money`). Static for most. */
  risk(task: TaskRecord, values: ActionValues, facts?: PlanFacts): TaskActionRisk;
  /** The label for the task as it stands (a retry names its step). */
  label(task: TaskRecord): string;
  /** Pure over the stored task (and the host capability): what the person was shown to bind a press to, or undefined when the action is not offered. */
  when(env: ActionEnv, task: TaskRecord, caller: ActionCaller): Promise<ActionBinding | undefined> | ActionBinding | undefined;
  /**
   * Whether a card's button for this task opens a form or a confirm at once (layout only: Code judges the press again, and a press that needed one the card did not announce is described then). Absent: it does when the entry describes one. A move
   * whose form is only sometimes needed (an approval's limit tick, the checks choice) says no here and is described when the press finds it needs input.
   */
  dialog?(task: TaskRecord): boolean;
  /** The form and the confirm, from the live task (never from the press). Absent: the move takes no input and needs no confirm. */
  describe?(env: ActionEnv, caller: ActionCaller, task: TaskRecord, binding: ActionBinding, values: ActionValues): Promise<Description>;
  /** One call into the existing function; throws its refusals. */
  perform(context: PressContext): Promise<Performed>;
}
