// Who may do what with a session: the hosted product's session levels (`agent-sessions/access.ts`), on the document store and a members seam. The level is the highest of the ways a person holds one,
// read live each time:
//   - owning it (the task's effective owner: the taker once someone took the task over): `edit`;
//   - a task session's project: the person's own grant (a maintainer grant `edit`, any other grant `view`), a company owner's or admin's role (`view`, and they may stop it), or, off the read-only
//     path, a role the members adapter finds elsewhere (the hosted product's project Slack channel) (`view`);
//   - a chain session: the readers the members adapter names (`view`) and a maintainer grant (`edit`);
//   - the shares on the session (`SHARE#` items): a person, a project the person has a role on, or the whole company;
//   - the task's People list (`commenter` is `use`, `viewer` is `view`, `owner` is `edit` until the task has been taken over).
// A project viewer who is not the owner only watches, whatever a share says; a People `denied` entry takes everything but a company admin's `view`; an auditor reads and works on nothing.
// A session of another company, a person who is not a member, or no level at all reads as a missing session, so a session's existence never leaks.
//
// Ask (decisions 103 and 104): a person with `use`, or anyone with `view` who holds a working role on the session's project (maintainer, contributor or collaborator), may ask about a task they can view; a
// project viewer, an auditor and a person a People entry denies may not. Steering needs `use`; stop, retry and close need `edit` (a company owner or admin may stop).
//
// The members seam is where a company's people come from. A Code install has one person: `localOwnerMembers` makes the local owner the company's owner and a maintainer of every project, so they hold
// `edit` on every session of the install and nobody else holds anything. The hosted product's members (org member rows, project grants, the Slack channel) plug in here with the same rules.
import { z } from "zod";
import {
  AgentPrincipalSchema, SessionLevelSchema, agentSessionKey, agentXError, atLeast, cleanSessionName, sessionLevelRequiredMessage, sessionViewerOnlyMessage,
  type AgentPrincipal, type AgentSessionRecord, type DocumentStore, type OrgId, type Principal, type SessionLevel,
} from "@agentx/contracts";
import { taskKey } from "../task-flow/keys.js";
import { developerIdOf } from "./create.js";

export type SessionCompanyRole = "owner" | "admin" | "member" | "auditor";
/** A role on a project. `collaborator` (decision 103) views, comments and asks; it never starts tasks or works on code. */
export type SessionProjectRole = "maintainer" | "contributor" | "collaborator" | "viewer";

/** The person asked about: their session id (`developerIdOf`), and the principal when the surface authenticated one (a follower's re-check has only the id). */
export interface SessionPerson { companyId: string; developerId: string; principal?: Principal | undefined }

export interface SessionMembers {
  /** The person's role in the company now, or undefined for a person who is not a member. Read from the company's own records, never from a token. */
  companyRole(person: SessionPerson): Promise<SessionCompanyRole | undefined> | SessionCompanyRole | undefined;
  /** The role the person's own grant gives on the project, or undefined. */
  projectGrant(person: SessionPerson, project: string): Promise<SessionProjectRole | undefined> | SessionProjectRole | undefined;
  /** A role on the project from somewhere other than a grant (the hosted product's project channel). Asked only off the read-only path. */
  projectRoleElsewhere?(person: SessionPerson, project: string, companyRole: SessionCompanyRole): Promise<SessionProjectRole | undefined>;
  /** Whether the person is one of a chain run's readers. Without it only the owner and shares see a chain session. */
  chainReadAccess?(person: SessionPerson, session: AgentSessionRecord): Promise<boolean>;
}

/**
 * A Code install's members: the local owner (a principal with the `owner` role of the install's company) is the company's owner and a maintainer of every project; nobody else is a member. The `owner` role is
 * trusted because on a Code install only the Identity seam's `localOwnerPrincipal` carries it (a code-host approver's principal carries `collaborator`), and a follower's re-check, which has no principal, finds no one.
 */
export function localOwnerMembers(): SessionMembers {
  const isOwner = (person: SessionPerson): boolean => person.principal !== undefined && person.principal.companyId === person.companyId && person.principal.roles.includes("owner");
  return {
    companyRole: (person) => (isOwner(person) ? "owner" : undefined),
    projectGrant: (person) => (isOwner(person) ? "maintainer" : undefined),
  };
}

export interface SessionAccessDependencies {
  store: Pick<DocumentStore, "get" | "query">;
  members: SessionMembers;
}

export interface SessionAccess {
  session: AgentSessionRecord;
  level: SessionLevel;
  /** Whether the person is the effective owner. */
  owner: boolean;
  /** The effective owner, named for an "ask <name>" message. */
  effectiveOwner: { developerId: string; name: string };
  projectRole?: SessionProjectRole;
  /** A company owner or admin, on a task or chain session: they may stop it (`view` plus Stop). */
  orgAdmin: boolean;
  companyRole: SessionCompanyRole;
  /** Whether the person may ask about this session now (decisions 103, 104). */
  mayAsk: boolean;
}

export interface SessionAccessOptions {
  /** The follower re-check's path: no role is looked up elsewhere. */
  readOnlyPath?: true;
}

export interface RequireOptions extends SessionAccessOptions {
  /** The action is a comment: a project viewer is refused even though it needs only `view`. */
  comment?: true;
  /** A company owner or admin may do this (Stop) although their level is only `view`. */
  orgAdminMay?: true;
}

export const SESSION_NOT_FOUND_TEXT = "There is no such session.";
export const TASK_OWNER_UNREADABLE_TEXT = "Rovara can't tell who owns this task right now, so it did nothing.";
const UNNAMED_MEMBER = "a member";
const RANK: Record<"none" | SessionLevel, number> = { none: 0, view: 1, use: 2, edit: 3 };
const best = (a: "none" | SessionLevel, b: "none" | SessionLevel): "none" | SessionLevel => (RANK[a] >= RANK[b] ? a : b);
const isAdminRole = (role: SessionCompanyRole): boolean => role === "owner" || role === "admin";
const isWriterRole = (role: SessionCompanyRole): boolean => role !== "auditor";
/** The project roles that may ask about a task they can view (decisions 103, 104). */
const ASKING_ROLES: ReadonlySet<SessionProjectRole> = new Set(["maintainer", "contributor", "collaborator"]);
const notFound = () => agentXError("NOT_FOUND", SESSION_NOT_FOUND_TEXT);

type Item = Record<string, unknown>;

// ---- the shares on a session

const ShareRowSchema = z.object({ principal: AgentPrincipalSchema, level: SessionLevelSchema }).passthrough();

/** Every share on a session, skipping an item that does not parse. */
export async function readSessionShares(store: Pick<DocumentStore, "query">, orgId: OrgId, sessionId: string): Promise<Array<{ principal: AgentPrincipal; level: SessionLevel }>> {
  const rows: Array<{ principal: AgentPrincipal; level: SessionLevel }> = [];
  let cursor: string | undefined;
  do {
    const page = await store.query({ pk: agentSessionKey(orgId, sessionId, "META").pk, sk: { op: "beginsWith", prefix: "SHARE#" }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      const row = ShareRowSchema.safeParse(item);
      if (row.success) rows.push({ principal: row.data.principal, level: row.data.level });
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return rows;
}

// ---- the task's People list

export type PeopleRole = "owner" | "commenter" | "viewer" | "denied";
const PEOPLE_ROLES: ReadonlySet<string> = new Set(["owner", "commenter", "viewer", "denied"]);

/** A People item: undefined for none, "unreadable" for one that does not parse (a denial for everyone). A person listed twice keeps their last entry. */
export function peopleOfItem(item: Item | undefined): Map<string, PeopleRole> | "unreadable" | undefined {
  if (item === undefined) return undefined;
  const people = item["people"];
  if (item["schemaVersion"] !== 1 || !Array.isArray(people)) return "unreadable";
  const roles = new Map<string, PeopleRole>();
  for (const entry of people as unknown[]) {
    const person = entry as { developerId?: unknown; role?: unknown } | null;
    if (typeof person !== "object" || person === null || typeof person.developerId !== "string" || typeof person.role !== "string" || !PEOPLE_ROLES.has(person.role)) return "unreadable";
    roles.set(person.developerId, person.role as PeopleRole);
  }
  return roles;
}

// ---- the effective owner

const SIGN_IN_METHODS: ReadonlySet<string> = new Set(["slack", "oidc", "cloud", "github", "saml"]);
const present = (value: unknown): value is string => typeof value === "string" && value !== "";

const isTakenOver = (task: Item): boolean => Object.hasOwn(task, "currentOwner") && task["currentOwner"] !== undefined;

/** The session's owner now: the taker once the task was taken over, else the session's own owner. A taker that does not read means nobody owns it, so nobody gets an owner's access. */
function effectiveOwnerOf(session: AgentSessionRecord, task: Item | undefined): { developerId: string; name: string } {
  if (task === undefined || !isTakenOver(task)) return session.owner;
  const taker = task["currentOwner"];
  if (typeof taker !== "object" || taker === null || Array.isArray(taker)) throw agentXError("TASK_ACCESS_DENIED", TASK_OWNER_UNREADABLE_TEXT);
  const fields = taker as Item;
  if (!present(fields["developerId"]) || !present(fields["provider"]) || !SIGN_IN_METHODS.has(fields["provider"]) || !present(fields["since"]) || !Number.isFinite(Date.parse(fields["since"]))) {
    throw agentXError("TASK_ACCESS_DENIED", TASK_OWNER_UNREADABLE_TEXT);
  }
  if (fields["developerId"] === session.owner.developerId) return session.owner;
  return { developerId: fields["developerId"], name: (typeof fields["name"] === "string" ? cleanSessionName(fields["name"]) : undefined) ?? UNNAMED_MEMBER };
}

// ---- the level

interface Computed {
  level: "none" | SessionLevel; owner: boolean; effectiveOwner: { developerId: string; name: string }; projectRole: SessionProjectRole | undefined; orgAdmin: boolean; denied: boolean;
  /** The project role a person really holds (a grant, or a role found elsewhere), never the maintainership a company owner or admin is given: the only role that opens Ask at `view`. */
  heldRole: SessionProjectRole | undefined;
}

async function compute(deps: SessionAccessDependencies, person: SessionPerson, companyRole: SessionCompanyRole, session: AgentSessionRecord, options: SessionAccessOptions): Promise<Computed> {
  const readOnly = options.readOnlyPath === true;
  const isAdmin = isAdminRole(companyRole);
  const roles = new Map<string, Promise<{ grant: SessionProjectRole | undefined; effective: SessionProjectRole | undefined }>>();
  /** The person's role on a project: their own grant, a company owner's or admin's maintainership, or (off the read-only path) a role found elsewhere. */
  const roleOn = (project: string) => {
    const known = roles.get(project);
    if (known !== undefined) return known;
    const read = (async () => {
      const grant = await deps.members.projectGrant(person, project);
      // A company owner or admin is a maintainer of every project whatever grant they hold; the grant only decides between `edit` and `view`.
      if (isAdmin) return { grant, effective: "maintainer" as SessionProjectRole };
      if (grant !== undefined) return { grant, effective: grant };
      if (readOnly || deps.members.projectRoleElsewhere === undefined) return { grant, effective: undefined };
      return { grant, effective: await deps.members.projectRoleElsewhere(person, project, companyRole) };
    })();
    roles.set(project, read);
    return read;
  };
  /** The role on a project for a share to it: a grant or a role found elsewhere. A company admin's maintainership does not count, so a project share never reaches an admin who is not in the project. */
  const shareRoleOn = async (project: string): Promise<SessionProjectRole | undefined> => {
    const { grant, effective } = await roleOn(project);
    if (!isAdmin) return effective;
    if (grant !== undefined || readOnly || deps.members.projectRoleElsewhere === undefined) return grant;
    return deps.members.projectRoleElsewhere(person, project, "member");
  };

  // The task, for a task session. A task of another company is not this session's task, and counts as no task.
  let task: Item | undefined;
  if (session.subject.kind === "task") {
    const found = await deps.store.get(taskKey(session.subject.taskId));
    if (found !== undefined && (found["orgId"] ?? found["companyId"]) === session.orgId) task = found;
  }
  const effectiveOwner = effectiveOwnerOf(session, task);
  const owner = person.developerId === effectiveOwner.developerId;
  const projectRoles = session.project === undefined ? undefined : await roleOn(session.project);
  const projectRole = projectRoles?.effective;
  const grantRole = projectRoles?.grant;
  const orgAdmin = isAdmin && session.kind !== "local";

  let level: "none" | SessionLevel = owner ? "edit" : "none";
  if (session.kind === "task" && session.project !== undefined) {
    if (grantRole === "maintainer") level = best(level, "edit");
    else if (projectRole !== undefined) level = best(level, "view");
  } else if (session.kind === "chain") {
    if (deps.members.chainReadAccess !== undefined && await deps.members.chainReadAccess(person, session)) level = best(level, "view");
    if (grantRole === "maintainer") level = best(level, "edit");
  }

  for (const share of await readSessionShares(deps.store, session.orgId, session.sessionId)) {
    const principal = share.principal;
    const applies = principal.kind === "org"
      || (principal.kind === "member" && principal.developerId === person.developerId)
      || (principal.kind === "project" && await shareRoleOn(principal.project) !== undefined);
    if (applies) level = best(level, share.level);
  }

  let denied = false;
  if (task !== undefined && session.subject.kind === "task") {
    const people = peopleOfItem(await deps.store.get({ pk: `DEVTASK#${session.subject.taskId}`, sk: "PEOPLE" }));
    const entry = people === undefined || people === "unreadable" ? people : people.get(person.developerId);
    if (entry === "denied" || entry === "unreadable") { level = orgAdmin ? "view" : "none"; denied = true; }
    else if (entry === "owner") level = best(level, isTakenOver(task) ? "none" : "edit");
    else if (entry === "commenter") level = best(level, "use");
    else if (entry === "viewer") level = best(level, "view");
  }

  // A project viewer who is not the owner only watches, whatever a share or a People entry says.
  if (!owner && projectRole === "viewer" && RANK[level] > RANK.view) level = "view";
  // An auditor reads and works on nothing, whatever it owns or is shared.
  if (!isWriterRole(companyRole) && RANK[level] > RANK.view) level = "view";
  return { level, owner, effectiveOwner, projectRole, orgAdmin, denied, heldRole: isAdmin ? grantRole : projectRole };
}

/** Whether the computed access may ask about the session (decisions 103, 104). */
function mayAskOf(session: AgentSessionRecord, companyRole: SessionCompanyRole, computed: Computed): boolean {
  if (session.subject.kind !== "task" || computed.level === "none" || computed.denied || !isWriterRole(companyRole)) return false;
  // (A project viewer who is not the owner is held to `view` above, and `viewer` is no asking role, so they never ask.)
  if (atLeast(computed.level, "use")) return true;
  // At `view`, only a project role the person really holds opens Ask; a company owner's or admin's maintainership does not (they ask with `use`, as anyone does).
  return computed.heldRole !== undefined && ASKING_ROLES.has(computed.heldRole);
}

function finish(session: AgentSessionRecord, companyRole: SessionCompanyRole, computed: Computed): SessionAccess {
  if (computed.level === "none") throw notFound();
  return {
    session, level: computed.level, owner: computed.owner, effectiveOwner: computed.effectiveOwner, orgAdmin: computed.orgAdmin, companyRole, mayAsk: mayAskOf(session, companyRole, computed),
    ...(computed.projectRole === undefined ? {} : { projectRole: computed.projectRole }),
  };
}

/** The person a principal is, for the access reads. */
export const sessionPersonOf = (principal: Principal): SessionPerson => ({ companyId: principal.companyId, developerId: developerIdOf(principal), principal });

/**
 * What the person may do with a session already read. Throws `NOT_FOUND` for a session of another company, a person who is not a member, and no level at all. The company role is the members seam's,
 * asked each time.
 */
export async function sessionAccessOf(deps: SessionAccessDependencies, person: SessionPerson, session: AgentSessionRecord, options: SessionAccessOptions = {}): Promise<SessionAccess> {
  if (person.companyId !== session.orgId) throw notFound();
  const companyRole = await deps.members.companyRole(person);
  if (companyRole === undefined) throw notFound();
  return finish(session, companyRole, await compute(deps, person, companyRole, session, options));
}

/** The level of a person on a session (`none` for no access, never a throw for one), on the read-only path unless `options` say otherwise. */
export async function sessionLevelOf(deps: SessionAccessDependencies, person: SessionPerson, session: AgentSessionRecord, options: SessionAccessOptions = { readOnlyPath: true }): Promise<"none" | SessionLevel> {
  if (person.companyId !== session.orgId) return "none";
  const companyRole = await deps.members.companyRole(person);
  if (companyRole === undefined) return "none";
  return (await compute(deps, person, companyRole, session, options)).level;
}

/**
 * `access`, if the person holds `needed`. `action` completes "to <action>" ("stop it"). A project viewer who is not the owner is refused comments and every `use` and `edit` action with the viewer
 * message. Short of the level (but at least `view`) is `SESSION_LEVEL_REQUIRED` with what is needed and whom to ask.
 */
export function requireLevelOf(access: SessionAccess, needed: SessionLevel, action: string, options: RequireOptions = {}): SessionAccess {
  if (!access.owner && access.projectRole === "viewer" && (needed !== "view" || options.comment === true)) {
    throw agentXError("SESSION_LEVEL_REQUIRED", sessionViewerOnlyMessage(access.session.project ?? "this project"));
  }
  if (options.orgAdminMay === true && access.orgAdmin) return access;
  if (!atLeast(access.level, needed)) throw agentXError("SESSION_LEVEL_REQUIRED", sessionLevelRequiredMessage(needed, action, access.effectiveOwner.name));
  return access;
}

/** The words a person who may view but not ask reads. */
export const ASK_NOT_ALLOWED_TEXT = "You can't ask about this task. Ask a maintainer of its project to add you to it.";

/** `access`, if the person may ask about the session (decisions 103, 104); else `SESSION_LEVEL_REQUIRED` with fixed words. */
export function requireAsk(access: SessionAccess): SessionAccess {
  if (!access.owner && access.projectRole === "viewer") throw agentXError("SESSION_LEVEL_REQUIRED", sessionViewerOnlyMessage(access.session.project ?? "this project"));
  if (!access.mayAsk) throw agentXError("SESSION_LEVEL_REQUIRED", ASK_NOT_ALLOWED_TEXT);
  return access;
}

/** The access reader the session modules share: over a store and members (default: the local owner). */
export function createSessionAccess(deps: { store: Pick<DocumentStore, "get" | "query">; members?: SessionMembers | undefined }) {
  const resolved: SessionAccessDependencies = { store: deps.store, members: deps.members ?? localOwnerMembers() };
  return {
    of: (principal: Principal, session: AgentSessionRecord, options?: SessionAccessOptions) => sessionAccessOf(resolved, sessionPersonOf(principal), session, options),
    levelOf: (person: SessionPerson, session: AgentSessionRecord, options?: SessionAccessOptions) => sessionLevelOf(resolved, person, session, options),
  };
}

export type SessionAccessReader = ReturnType<typeof createSessionAccess>;
