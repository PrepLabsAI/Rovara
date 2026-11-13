// TE-B5a (testing plan, owner decision O30): `canDecide(actor, action, task, company)`, ONE table of who may do what. Pure and browser-safe: nothing here reads a store.
//
//   task-level exceptions   mark ready anyway, confirm a found contract, approve a recording set   the task's owner (the person who asked for it) or a maintainer
//   product AI keys         connect a customer product's model key (DECISIONS 157)                  a maintainer of the project or an admin
//   company-level things    provider keys, test-account writes, company locks                      an admin
//
// "Maintainer" and "admin" are read from the roles the caller passes IN THIS CALL: the caller reads them live from the people store at the moment of the press, and nothing here (or on the task) keeps a role, so a
// role change takes effect at once. A company owner or admin is a maintainer of every project of the company (as `app-projects.ts` says). Everything fails closed: an unknown action, a missing or malformed actor,
// task or company, a role the table does not know (including a name every object has, such as `constructor`), another company, or a project role for another project is a refusal, and the function never throws.
//
// Replaces: O18 (an admin approves exceptions) for the task-level actions; the company-level ones stay with an admin. This is the one table: Cloud reaches it through the vendored contracts, never a second copy.
import { isKnownOrgRole } from "./company-scope.js";

/** The level an action is decided at. `task`: the task's owner or a maintainer. `project`: a maintainer of the project (or an admin). `company`: an admin. */
export type DecisionLevel = "task" | "project" | "company";

/** Every action `canDecide` knows. A new action is one more row here, with its level. */
export const DECISION_ACTIONS = Object.freeze({
  mark_ready_anyway: "task",
  confirm_found_contract: "task",
  approve_recording_set: "task",
  connect_product_ai_key: "project",
  manage_provider_keys: "company",
  write_test_account: "company",
  set_company_lock: "company",
} as const satisfies Record<string, DecisionLevel>);
export type DecisionAction = keyof typeof DECISION_ACTIONS;

/** Who is asking. `orgRole` and `projectRole` are what the caller just read, not what the task or a session remembers. */
export interface DecideActor {
  personId: string;
  companyId: string;
  /** The person's company role: `owner`, `admin` or `member`. Anything else (or nothing) is not a member of the company for this table. */
  orgRole?: string | undefined;
  /** The person's role in ONE project (`maintainer`, `contributor` or `viewer`), and which project it is for: a role in another project gives nothing here. */
  projectRole?: { project: string; role: string } | undefined;
}
/** The task (or, for a project-level action, the project) the decision is about. `ownerId` is the person who owns the task now (the requester, or whoever took it over). */
export interface DecideTask {
  companyId: string;
  project: string;
  ownerId?: string | undefined;
}
export interface DecideCompany {
  companyId: string;
}

export const DECIDE_REASONS = ["task_owner", "maintainer", "admin", "not_a_member", "other_company", "not_allowed", "unknown_action", "unknown_actor", "no_task"] as const;
export type DecideReason = (typeof DECIDE_REASONS)[number];
export interface Decision {
  allowed: boolean;
  /** Why: who it was allowed for, or the plain reason it was refused. A fixed code, never text. */
  reason: DecideReason;
}

const refuse = (reason: DecideReason): Decision => ({ allowed: false, reason });
const allow = (reason: "task_owner" | "maintainer" | "admin"): Decision => ({ allowed: true, reason });
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 400;
/** An own property read, so a name every object has (`constructor`) is never an entry. */
const own = (object: object, key: string): unknown => (Object.hasOwn(object, key) ? (object as Record<string, unknown>)[key] : undefined);

/** Whether `role` is a role in a project the table knows. */
const PROJECT_ROLES: ReadonlySet<string> = new Set(["maintainer", "contributor", "viewer"]);

function decide(actor: unknown, action: string, task: unknown, company: unknown): Decision {
  const level = typeof action === "string" ? (own(DECISION_ACTIONS, action) as DecisionLevel | undefined) : undefined;
  if (level === undefined) return refuse("unknown_action");
  if (actor === null || typeof actor !== "object" || Array.isArray(actor)) return refuse("unknown_actor");
  if (company === null || typeof company !== "object" || Array.isArray(company)) return refuse("unknown_actor");
  const personId = own(actor, "personId");
  const actorCompany = own(actor, "companyId");
  const companyId = own(company, "companyId");
  if (!nonEmpty(personId) || !nonEmpty(actorCompany) || !nonEmpty(companyId)) return refuse("unknown_actor");
  if (actorCompany !== companyId) return refuse("other_company");
  const orgRole = own(actor, "orgRole");
  if (typeof orgRole !== "string" || !isKnownOrgRole(orgRole)) return refuse("not_a_member");
  const isAdmin = orgRole === "owner" || orgRole === "admin";
  if (level === "company" || (level === "project" && isAdmin)) return isAdmin ? allow("admin") : refuse("not_allowed");

  // The task (or the project) the decision is about: it must exist, be this company's, and name its project.
  if (task === null || task === undefined) return refuse("no_task");
  if (typeof task !== "object" || Array.isArray(task)) return refuse("unknown_actor");
  const taskCompany = own(task, "companyId");
  const project = own(task, "project");
  if (!nonEmpty(taskCompany) || !nonEmpty(project)) return refuse("unknown_actor");
  if (taskCompany !== companyId) return refuse("other_company");

  // An owner or admin of the company is a maintainer of every project. Anyone else is a maintainer only through a role read for THIS project.
  if (isAdmin) return allow("admin");
  const held = own(actor, "projectRole");
  const heldProject = held !== null && typeof held === "object" ? own(held, "project") : undefined;
  const heldRole = held !== null && typeof held === "object" ? own(held, "role") : undefined;
  const role = heldProject === project && typeof heldRole === "string" && PROJECT_ROLES.has(heldRole) ? heldRole : undefined;
  if (role === "maintainer") return allow("maintainer");
  if (level === "project") return refuse("not_allowed");
  // The task's owner decides their own task-level exceptions (O30), while they can still work in the project: a viewer, or a person whose role cannot be read, cannot.
  const ownerId = own(task, "ownerId");
  if (role === "contributor" && nonEmpty(ownerId) && ownerId === personId) return allow("task_owner");
  return refuse("not_allowed");
}

/**
 * Whether `actor` may take `action` on `task` in `company`. Pure; the roles are read live by the caller and passed in; unknown input is refused (see the file header). `task` is not needed for a company-level action.
 * Replaces: nothing in code (the table did not exist); the callers each had their own role check.
 */
export function canDecide(actor: DecideActor, action: string, task: DecideTask | undefined, company: DecideCompany): Decision {
  try {
    return decide(actor, action, task, company);
  } catch {
    // A hostile object (a getter that throws) is a refusal, never an exception that a caller might read as "no answer, carry on".
    return refuse("unknown_actor");
  }
}
