// Switch-on lane L11: the decision cards, the session levels and how we work on the deployed core's developer routes (`core-host/dev-routes.ts`, `CoreDevWiring`), from the company's OWN records.
//
//   - Session levels (`deployedSessionMembers`): the person's company role is their LIVE membership (R4's `COMPANY_MEMBER#` row: owner, admin or member), and their role on a project is the broker's own
//     project grant (administrator: maintainer, developer: contributor; nothing else is a grant). The person is the principal the broker's sign-in vouched for, and it must be the same person the session
//     layer names (its developer id) in the same company; anything else, and a re-check that has no principal, finds no one (fail closed: a session then reads as missing).
//   - Decision cards (`deployedDecisionCards`): the cards of the documents a task waits on (the requirements, the design or the coding plan) for the task's OWNERS, while they are still a member with the
//     project grant: the task's own person, and (web task channel C6, decision D5) the co-owners its People list names, each under the live People rule the core's owner moves use (`TaskAccess.ownerActing`:
//     live membership, the live proof of the person, the project grant). Commenters and viewers never decide. A host without that rule (Code's laptop) keeps the task's own person. Acting on a card needs the signed-in person the route authenticated (DEC 254zzz73: no step-up); the performer re-checks the person's live authority (member, the task's own person, the grant)
//     and only then asks the approval gate, with a proof the deployment's approvers point issues and verifies (lane L2a: `DecisionProofIssuer`). The gate's Approvers seam (the policy hook's stricter-only
//     wrapper in front of it) and the workflow decision decide; nothing here approves anything. The gate records the approver as the task owner who decided (the task's own person, or the co-owner, with the People
//     revision fenced into the decision's transaction); there is no project approver path on the core yet.
//   - How we work (`deployedPlaybook`): the repository's `.rovara/playbook.yaml` through the company's code host, with the deployment's code settings. Without a code host or the settings it is not
//     built (the route answers "not on the core yet"): never "no file" and never the laptop's fixed settings, which would be a wrong answer about the company.
//
// Rules: every read is the company's (the runtime's company, never a claim); a caller of another company, a non-member and a malformed caller get nothing; one listing reads a bounded number of tasks.
import {
  OrgRoleSchema,
  type AdapterRegistry, type OrgId, type OrgRole, type Principal, type WorkflowArtifact, type WorkflowSnapshot,
} from "@agentx/contracts";
import { SETUP_CHANGE_CARD_WORDS, WorkflowSnapshotSchema, setupChangeLines } from "@agentx/contracts";
import { createDecisionService, type DecisionService } from "../services/decisions.js";
import { hostedKnownFailing } from "./known-failing.js";
import { createDecisionGate } from "../core/decisions/approval-gate.js";
import { CARD_REFUSAL_OF_GATE } from "../core/decisions/performer.js";
import type { Credential, DecisionOutcome } from "../core/decisions/approval-gate.js";
import { WORKFLOW_DOCUMENT_CARD_KINDS, createDecisionPerformer, workflowDocumentHandler, type KindHandler, type ProvingCaller } from "../core/decisions/performer.js";
import type { DecisionItem } from "../core/decisions/project.js";
import { planFactsOf } from "../core/decisions/plan-risk.js";
import type { DecisionPerformer, DecisionRouteDependencies, DecisionSources, PerformInput, PerformOutcome } from "../core/decisions/routes.js";
import { documentDecisionStore } from "../core/decisions/store.js";
import { currentDocumentType } from "../core/decisions/workflow-subject.js";
import { taskOpenPath } from "../core/decisions/open-path.js";
import { readPlanFeature } from "../core/report/plan-feature.js";
import { designApproveItem, designCardFactsOf } from "../core/design-review/card-source.js";
import { designTouchesOf, isReviewedDesign } from "../core/design-review/decision.js";
import type { CodeSettingsReader } from "../core/merge/seams.js";
import { createPlaybookService, type PlaybookService } from "../core/playbook/service.js";
import { createCodeHostPlaybookSource } from "../core/playbook/source.js";
import type { SessionCompanyRole, SessionMembers, SessionPerson, SessionProjectRole } from "../core/sessions/access.js";
import { developerIdOf } from "../core/sessions/create.js";
import { involvedTaskIds } from "../core/task-flow/involved.js";
import { listTasks, readTask } from "../core/task-flow/reads.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { createStoreProjectSource } from "../core/task-flow/project-source.js";
import { textReaderOf } from "../core/build-step/plan-input.js";
import { loadWorkflowDocument } from "../developer/plan-document-reader.js";
import { taskOwnerKey } from "../developer/task-records.js";
import type { CoreRuntime } from "./core-runtime.js";
import type { CoreDevWiring, DeployedDecisionCaller } from "./dev-routes.js";
import { APPROVAL_PROOF_METHOD, issueApprovalProof, issueKnownFailingApprovalProof, type HostedChatApproval, type ApprovalProofInput } from "./hosted-approvers.js";
import type { ChatThreads } from "./chat-threads.js";

/** The company's own records of its people, as the broker keeps them. A read that fails throws (the caller refuses); `undefined` is "none". */
export interface DeployedPeople {
  /** The person's LIVE company membership and role (`COMPANY_MEMBER#<person>`). Undefined: none, or revoked. */
  membershipOf: (personId: string) => Promise<{ companyId: OrgId; role: OrgRole } | undefined>;
  /** The person's project grant (`MEMBER#<person>` / `PROJECT#<name>`): `developer` or `administrator`, else undefined. */
  projectGrantRole: (personId: string, project: string) => Promise<"developer" | "administrator" | undefined>;
}

const PERSON_ID = /^[^#\s]{1,256}$/u;
const isPrincipal = (value: unknown): value is Principal => value !== null && typeof value === "object" && typeof (value as Principal).personId === "string" && typeof (value as Principal).provider === "string" && typeof (value as Principal).companyId === "string";

/** The person's live membership in THIS company, or undefined (another company's, none, revoked, malformed, or a read that failed). */
export async function liveMemberRole(people: DeployedPeople, companyId: OrgId, personId: string): Promise<OrgRole | undefined> {
  if (typeof personId !== "string" || !PERSON_ID.test(personId)) return undefined;
  let membership: { companyId: OrgId; role: OrgRole } | undefined;
  try { membership = await people.membershipOf(personId); } catch { return undefined; }
  if (membership === undefined || membership === null || typeof membership !== "object" || membership.companyId !== companyId || !OrgRoleSchema.safeParse(membership.role).success) return undefined;
  return membership.role;
}

/**
 * HW5b: the chat the approvers point lets a person approve a low or medium risk plan in, from the deployment's chat seam (`ChatThreads`) and the company's own records of its people. ONE chat that can name a person
 * (`personOf`), else none (the install takes the page's proof alone). Everything is read at each use: the workspace's company, the account's link or sign-in, the person's live membership in THAT company and their project grant.
 */
export function hostedChatApproval(threads: Pick<ChatThreads, "channels" | "companyOf" | "personOf"> | undefined, people: DeployedPeople, key: Buffer | undefined): HostedChatApproval | undefined {
  const personOf = threads?.personOf;
  // A seam of a test double may carry no `channels` at all: then it names no chat.
  const channels: readonly string[] | undefined = threads?.channels;
  const channel = channels !== undefined && channels.length === 1 ? channels[0] : undefined;
  if (threads === undefined || personOf === undefined || channel === undefined || key === undefined) return undefined;
  return {
    channel, key, companyOf: threads.companyOf,
    personOf: async (companyId, account) => (await personOf.call(threads, companyId, { channel: account.provider, tenant: account.tenant, userId: account.accountId }))?.personId,
    holdsProjectGrant: async (companyId, personId, project) => (await liveMemberRole(people, companyId, personId)) !== undefined && (await liveGrant(people, personId, project)) !== undefined,
  };
}

/** The person's live project grant, read fresh. A failed read is no grant. */
export async function liveGrant(people: DeployedPeople, personId: string, project: string): Promise<"developer" | "administrator" | undefined> {
  try {
    const role = await people.projectGrantRole(personId, project);
    return role === "developer" || role === "administrator" ? role : undefined;
  } catch {
    return undefined;
  }
}

// ---- session levels

/** The company role a session level reads: the membership role as it is (owner, admin, member). An auditor role is not a membership role on the broker, so none is given. */
const SESSION_COMPANY_ROLE: Readonly<Record<OrgRole, SessionCompanyRole>> = { owner: "owner", admin: "admin", member: "member" };
/** The project role a grant gives: a project administrator maintains it, a developer contributes. */
const SESSION_PROJECT_ROLE: Readonly<Record<"developer" | "administrator", SessionProjectRole>> = { administrator: "maintainer", developer: "contributor" };

/**
 * The deployed session levels for one company. The person is the principal the broker's sign-in vouched for: it must name this company and be the very person the session layer asks about (its
 * developer id is `developerIdOf(principal)`). A person without a principal (a follower's re-check) is found by no one.
 */
export function deployedSessionMembers(companyId: OrgId, people: DeployedPeople): SessionMembers {
  const personOf = (person: SessionPerson): string | undefined => {
    if (person === null || typeof person !== "object" || person.companyId !== companyId) return undefined;
    const principal = person.principal;
    if (!isPrincipal(principal) || principal.companyId !== companyId || developerIdOf(principal) !== person.developerId) return undefined;
    return principal.personId;
  };
  return {
    async companyRole(person) {
      const personId = personOf(person);
      if (personId === undefined) return undefined;
      const role = await liveMemberRole(people, companyId, personId);
      return role === undefined ? undefined : SESSION_COMPANY_ROLE[role];
    },
    async projectGrant(person, project) {
      const personId = personOf(person);
      if (personId === undefined || (await liveMemberRole(people, companyId, personId)) === undefined) return undefined;
      const grant = await liveGrant(people, personId, project);
      return grant === undefined ? undefined : SESSION_PROJECT_ROLE[grant];
    },
  };
}

// ---- decision cards

/**
 * The deployment's approvers point's own proof for one act on a card (lane L2a). The performer asks for it only after the route authenticated the signed-in person and the performer re-checked the person's live
 * authority; the token is handed to the approval gate, which hands it to the same point's `verify` (never stored or logged). A throw refuses the act (nothing is decided).
 */
export interface DecisionProofIssuer {
  /** The approval method the point accepts for this proof (one of its `ApprovalRequirement.methods`). */
  readonly method: string;
  issue: (act: DecisionAct) => Credential | Promise<Credential>;
}

/**
 * What one act on a card is, as the route and the performer checked it (lane L2a's `ApprovalProofInput`): the company, the person the sign-in vouched for, the
 * decision's request id and kind (the `ApprovalRequest.kind` the gate will ask about: the waiting document's type), the task, the revision and digest the card was drawn at, the answer, and
 * the card at that document version. Nothing here comes from the request body but the request id the card route validated.
 */
export type DecisionAct = ApprovalProofInput;

/** The deployed issuer: lane L2a's signed, card-bound, one-time proof (`issueApprovalProof`), under the install's proof key. */
export function approvalDecisionProofs(key: Buffer, nowMs: () => number): DecisionProofIssuer {
  return { method: APPROVAL_PROOF_METHOD, issue: (act) => act.kind === "known_failing" ? issueKnownFailingApprovalProof(key, { ...act, subjectId: act.taskId }, nowMs()) : issueApprovalProof(key, act, nowMs()) };
}

/** The `ApprovalRequest.kind` the workflow decision asks about for each document card (the subject's `currentDocumentType`), never the gate's subject kind. */
const APPROVAL_KIND_OF: Readonly<Partial<Record<string, "plan" | "requirements" | "design">>> = { approve_plan: "plan", approve_requirements: "requirements", approve_design: "design" };

/** Most task index rows one listing reads (five pages of a hundred, as the laptop's pending list), and how many tasks it reads at once. */
export const DECISION_SOURCE_TASKS_MAX = 500;
const DECISION_SOURCE_PAGE = 100;
const DECISION_SOURCE_PARALLEL = 20;

/** The caller the card routes pass, checked again here: of this company, the session id of the person the sign-in vouched for. Undefined: not a caller we act for. */
function personOfCaller(companyId: OrgId, caller: DeployedDecisionCaller): string | undefined {
  if (caller === null || typeof caller !== "object" || caller.orgId !== companyId || !isPrincipal(caller.principal)) return undefined;
  if (caller.principal.companyId !== companyId || developerIdOf(caller.principal) !== caller.developerId) return undefined;
  return caller.principal.personId;
}

/** The document a task waits on now, if it waits for its owner: the task is open, the workflow reads, and it waits at the plan review with a document of the waiting type. */
function waitingDocument(task: TaskRecord): { workflow: WorkflowSnapshot; artifact: WorkflowArtifact; type: "plan" | "requirements" | "design" } | undefined {
  if (task.closedAt !== undefined) return undefined;
  const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
  if (!parsed.success) return undefined;
  const workflow = parsed.data;
  if (workflow.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") return undefined;
  const type = currentDocumentType(workflow);
  const artifact = workflow.artifacts.filter((entry) => entry.type === type).at(-1);
  return artifact === undefined ? undefined : { workflow, artifact, type };
}

/**
 * The approval gate of one company's deployed core: over the company's approvers point (with the policy hook's wrapper the registry was sealed with), where the task's own person is the only decider of its documents.
 * One definition for the decision cards and for what only READS the gate (HW5: the plan card's `requirement`), so both ask the same gate, the same approvers and the same rule for who decides.
 */
export function hostedDecisionService(input: { deps: TaskFlowDeps; registry: AdapterRegistry; companyId: OrgId; now: () => Date }): DecisionService {
  const { deps, registry, companyId } = input;
  return createDecisionService({
    flow: deps, blobs: registry.require("object-storage"), store: deps.store, approvers: registry.require("approvers"), audit: deps.audit, companyId, identity: registry.require("identity"),
    now: input.now,
    workflowSubject: {
      actorFor: (approver, workflow) => (approver.companyId === companyId && typeof approver.personId === "string" && taskOwnerKey(approver.personId, workflow.taskId) === workflow.ownerId
        ? { actorId: workflow.ownerId, role: "TASK_OWNER" } : undefined),
    },
  });
}

export interface DeployedDecisionCardsOptions {
  runtime: CoreRuntime;
  registry: AdapterRegistry;
  people: DeployedPeople;
  proofs: DecisionProofIssuer;
  env?: NodeJS.ProcessEnv;
  /**
   * More tasks a person's listing reads besides their own index: the task ids of the tasks they were ADDED to (the involved rows of the involved list, C5). Only ids: every one is read as a task of this
   * company and judged by the live owner rule like any other, so a stale or foreign id shows nothing. At most INVOLVED_TASKS_MAX are read; a throw lists only the person's own. Absent: the person's own index.
   */
  involvedTaskIds?: (caller: DeployedDecisionCaller) => Promise<readonly string[]>;
  log?: (entry: Record<string, unknown>) => void;
}

/** Most involved task ids one listing reads. */
export const INVOLVED_TASKS_MAX = 100;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The card routes' dependencies for one company on the deployed core. */
export function deployedDecisionCards(options: DeployedDecisionCardsOptions): DecisionRouteDependencies<DeployedDecisionCaller> {
  const { runtime, registry, people, proofs } = options;
  const companyId = runtime.companyId;
  const deps = runtime.flow.deps;
  const blobs = registry.require("object-storage");
  const nowMs = (): number => (deps.now?.() ?? new Date()).getTime();
  const log = (entry: Record<string, unknown>): void => { try { options.log?.(entry); } catch { /* a log never changes an answer */ } };

  /**
   * Whether the principal is an owner of the task NOW, and as whom the engine records them: the company's live owner rule (`TaskAccess.ownerActing`: the task's own person, or a People co-owner under the
   * live proof, with the project grant). A throw (People or the proof unreadable) is no owner: nothing is decided on a guess. `authority` and `items` (the People revision fence) go to the decision's
   * transaction. Only meaningful where the host gave the rule; `isOwner` keeps the task's own person otherwise.
   */
  const ownerActingOf = async (principal: Principal, task: { taskId: string; developerId: string; project: string; ownerKey: string }): Promise<NonNullable<Awaited<ReturnType<NonNullable<typeof deps.access.ownerActing>>>> | undefined> => {
    const access = deps.access;
    if (access.ownerActing === undefined || typeof principal.personId !== "string") return undefined;
    try {
      const acting = await access.ownerActing(principal, task);
      if (acting === undefined) return undefined;
      // The engine records one actor under the owner id it knows: the person's own owner key. A rule that names another actor is not believed.
      const own = taskOwnerKey(principal.personId, task.taskId);
      return acting.authority === undefined ? (acting.actorId === task.ownerKey && own === task.ownerKey ? acting : undefined) : (acting.actorId === own ? acting : undefined);
    } catch {
      return undefined;
    }
  };
  const isOwner = async (principal: Principal, task: TaskRecord): Promise<boolean> => (deps.access.ownerActing === undefined
    ? task.developerId === principal.personId
    : (await ownerActingOf(principal, { taskId: task.taskId, developerId: task.developerId, project: task.project, ownerKey: task.workflow?.ownerId ?? task.ownerKey })) !== undefined);

  // The approval gate over the company's approvers point (with the policy hook's wrapper the registry was sealed with). The task's own person is the only decider of its documents.
  const decisions = createDecisionService({
    flow: deps, blobs, store: deps.store, approvers: registry.require("approvers"), audit: deps.audit, companyId, identity: registry.require("identity"),
    now: () => new Date(nowMs()),
    workflowSubject: {
      // Who decides as the task's owner: read live for each verified approver (`ownerOf`), never from the proof alone.
      actorFor: (approver, workflow) => (approver.companyId === companyId && typeof approver.personId === "string" && taskOwnerKey(approver.personId, workflow.taskId) === workflow.ownerId
        ? { actorId: workflow.ownerId, role: "TASK_OWNER" } : undefined),
      ...(deps.access.ownerActing === undefined ? {} : {
        ownerActing: async (approver, task, workflow) => {
          if (approver.companyId !== companyId || typeof approver.personId !== "string" || typeof task["developerId"] !== "string" || typeof task["project"] !== "string") return undefined;
          return await ownerActingOf(approver, { taskId: workflow.taskId, developerId: task["developerId"], project: task["project"], ownerKey: workflow.ownerId });
        },
      }),
    },
  });
  const handler = workflowDocumentHandler<ProvingCaller>(decisions.gate);
  const knownFailing = hostedKnownFailing({ flow: deps, blobs, people, ...(options.env === undefined ? {} : { env: options.env }) });
  const kfGate = createDecisionGate({ store: deps.store, audit: deps.audit, approvers: registry.require("approvers"), subjects: [knownFailing.subject], now: () => new Date(nowMs()) });


  /** The task, if the person may decide its document now: still a member, an owner of the task (its own person or a co-owner, live), in this company, with the project grant. */
  const ownTask = async (principal: Principal, taskId: string | undefined): Promise<TaskRecord | undefined> => {
    const personId = principal.personId;
    if (taskId === undefined || (await liveMemberRole(people, companyId, personId)) === undefined) return undefined;
    const task = await readTask(deps, taskId);
    if (task === undefined || task.companyId !== companyId || !(await isOwner(principal, task))) return undefined;
    return (await liveGrant(people, personId, task.project)) === undefined ? undefined : task;
  };

  /** The card for one task, or undefined when it waits on nothing the person can see. A structured document that does not read back is not offered (the decision would refuse it too). */
  const itemOf = async (task: TaskRecord, viewer: { principal: DeployedDecisionCaller["principal"]; admin: boolean }): Promise<DecisionItem | undefined> => {
    const waiting = waitingDocument(task);
    if (waiting === undefined) return undefined;
    const { workflow, artifact, type } = waiting;
    // Only this task's own stored documents are read (the laptop's rule): a pointer elsewhere is a document that does not read.
    const ownPrefix = `private/${task.ownerKey}/${task.workspaceId}/`;
    const loaded = artifact.objectKey.startsWith(ownPrefix) ? await loadWorkflowDocument(textReaderOf(blobs), artifact, {}).catch(() => undefined) : undefined;
    if (artifact.format === "structured" && loaded?.format !== "structured") return undefined;
    const facts = planFactsOf(loaded, workflow);
    const base = {
      subjectId: task.taskId, taskId: task.taskId, project: task.project, title: task.title, createdAt: artifact.createdAt, contentVersion: artifact.sha256,
      binding: { revision: workflow.revision, artifactDigest: artifact.sha256 }, openPath: taskOpenPath(task),
    };
    const claims = loaded?.format === "structured" ? loaded.plan.claims.length : 0;
    if (type === "plan") {
      const estimate = (task as { runEstimate?: { highUsd?: unknown } }).runEstimate?.highUsd;
      // Lead 4 PCF: the feature line. Only the task's own person is ever listed this card (`ownTask`), so a person who sees it may approve it; "Change" also needs the filing rule of
      // `POST /v1/app/tasks/{id}/feature` (the starter, or a manager: an owner, an admin or the project's administrator, read live), and "create" the live company owner or admin.
      const mayFile = await deps.access.canAct(viewer.principal, task).catch(() => false);
      const manager = viewer.admin || (await liveGrant(people, viewer.principal.personId, task.project).catch(() => undefined)) === "administrator";
      const planFeature = await readPlanFeature({ store: deps.store, companyId, now: nowMs }, task, { mayFile, manager, admin: viewer.admin });
      return {
        ...(planFeature === undefined ? {} : { planFeature }),
        ...base, kind: "approve_plan", path: workflow.path === "FULL" ? "full" : "quick", files: facts.files, claims, untestedClaims: facts.untestedClaims,
        ...(facts.unread ? { unread: true } : {}), ...(facts.setupChange === true && loaded?.format === "structured" && loaded.plan.setupChanges !== undefined ? { setupChange: true, details: [{ title: `Setup change (${String(loaded.plan.setupChanges.length)})`, lines: [...setupChangeLines(loaded.plan.setupChanges), SETUP_CHANGE_CARD_WORDS] }] } : {}), ...(typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0 ? { cost: { highUsd: estimate } } : {}),
      };
    }
    if (type === "requirements") return { ...base, kind: "approve_requirements", claims };
    if (isReviewedDesign(workflow) && workflow.designReview !== undefined) {
      return designApproveItem({ ...base, files: facts.files, review: designCardFactsOf(workflow.designReview, designTouchesOf(loaded?.markdown)) });
    }
    return { ...base, kind: "approve_design", files: facts.files, changesAllowed: true };
  };

  const sources: DecisionSources<DeployedDecisionCaller> = {
    async list(caller) {
      const personId = personOfCaller(companyId, caller);
      const memberRole = personId === undefined ? undefined : await liveMemberRole(people, companyId, personId);
      if (personId === undefined || memberRole === undefined) return [];
      const viewer = { principal: caller.principal, admin: memberRole === "owner" || memberRole === "admin" };
      const grants = new Map<string, Promise<boolean>>();
      const granted = (project: string): Promise<boolean> => {
        let found = grants.get(project);
        if (found === undefined) { found = liveGrant(people, personId, project).then((role) => role !== undefined); grants.set(project, found); }
        return found;
      };
      const items: DecisionItem[] = [];
      const seen = new Set<string>();
      /** One task's card, if the task waits on the person's decision now: this company's, waiting, with the grant, and the person an owner of it (read live). */
      const cardOf = async (taskId: string): Promise<DecisionItem | undefined> => {
        const task = await readTask(deps, taskId);
        if (task === undefined || task.companyId !== companyId || !(await granted(task.project)) || !(await isOwner(caller.principal, task))) return undefined;
        if (task.workflow !== undefined) await knownFailing.observeBlocked({ companyId, project: task.project, taskId, workflow: task.workflow });
        if (waitingDocument(task) === undefined) return undefined;
        return await itemOf(task, viewer);
      };
      let cursor: string | undefined;
      let read = 0;
      let calls = 0;
      do {
        calls += 1;
        const page = await listTasks(deps, { principal: caller.principal }, { limit: Math.min(DECISION_SOURCE_PAGE, DECISION_SOURCE_TASKS_MAX - read), ...(cursor === undefined ? {} : { cursor }) });
        read += page.tasks.length;
        for (let start = 0; start < page.tasks.length; start += DECISION_SOURCE_PARALLEL) {
          const drawn = await Promise.all(page.tasks.slice(start, start + DECISION_SOURCE_PARALLEL).map(async (row) => {
            if (seen.has(row.taskId)) return undefined;
            seen.add(row.taskId);
            return await cardOf(row.taskId);
          }));
          for (const item of drawn) if (item !== undefined) items.push(item);
        }
        cursor = page.cursor;
      // Bounded by rows AND by index reads: pages of another company's rows (read and dropped by listTasks) never walk the whole index.
      } while (cursor !== undefined && read < DECISION_SOURCE_TASKS_MAX && calls < DECISION_SOURCE_TASKS_MAX / DECISION_SOURCE_PAGE);
      // The tasks the person was added to (the involved rows): ids only, each judged like the rest.
      if (options.involvedTaskIds !== undefined) {
        let involved: readonly string[];
        try { involved = await options.involvedTaskIds(caller); } catch { involved = []; }
        const ids = (Array.isArray(involved) ? involved : []).filter((id): id is string => typeof id === "string" && TASK_ID.test(id) && !seen.has(id)).slice(0, INVOLVED_TASKS_MAX);
        for (let start = 0; start < ids.length; start += DECISION_SOURCE_PARALLEL) {
          const drawn = await Promise.all(ids.slice(start, start + DECISION_SOURCE_PARALLEL).map(async (id) => { seen.add(id); return await cardOf(id); }));
          for (const item of drawn) if (item !== undefined) items.push(item);
        }
      }
      // An older task past the bound is not shown here (it is still decided on its own page); the log says the listing was cut.
      if (cursor !== undefined) log({ event: "core_engine.decision_cards_cut", companyId, read });
      items.push(...await knownFailing.items(companyId, caller.principal));
      return items;
    },
    async locks() { return {}; },
  };

  /** One act: the person's live authority again, then the point's proof, then the gate (through the workflow decision). Anything that does not hold is refused; nothing is decided. */
  const act = (outcome: DecisionOutcome, run: NonNullable<KindHandler<ProvingCaller>["reject"]>) => async (caller: DeployedDecisionCaller, input: PerformInput & { reason?: string }): Promise<PerformOutcome> => {
    const personId = personOfCaller(companyId, caller);
    if (personId === undefined) return { kind: "refused", reason: "forbidden" };
    const task = await ownTask(caller.principal, input.item.taskId);
    if (task === undefined) return { kind: "refused", reason: "forbidden" };
    const binding = input.item.binding;
    if (binding === undefined) return { kind: "refused", reason: "stale" };
    const kind = APPROVAL_KIND_OF[input.item.kind];
    if (kind === undefined) return { kind: "refused", reason: "unsupported" };
    let credential: Credential;
    try {
      credential = await proofs.issue({
        companyId, personId, requestId: input.requestId, kind, taskId: task.taskId,
        revision: binding.revision, artifactDigest: binding.artifactDigest, outcome,
        // The card at the document version the gate is given (`workflowDocumentHandler`): the same card the gate names to the point.
        card: { cardId: input.card.id, contentVersion: binding.artifactDigest },
      });
    } catch {
      log({ event: "core_engine.decision_proof_unavailable", companyId });
      return { kind: "refused", reason: "forbidden" };
    }
    if (credential === null || typeof credential !== "object" || credential.method !== proofs.method || typeof credential.token !== "string" || credential.token === "") return { kind: "refused", reason: "forbidden" };
    return await run({ orgId: companyId, developerId: caller.developerId, credentials: [{ method: credential.method, token: credential.token }] }, input as PerformInput & { reason: string });
  };
  const deployedHandler: KindHandler<DeployedDecisionCaller> = {
    approve: act("approve", (who, input) => handler.approve(who, input)),
    reject: act("reject", (who, input) => handler.reject!(who, input)),
    requestChanges: act("request_changes", (who, input) => handler.requestChanges!(who, input)),
  };
  const kfAct = (outcome: "approve" | "reject") => async (caller: DeployedDecisionCaller, input: PerformInput): Promise<PerformOutcome> => {
    const personId = personOfCaller(companyId, caller), binding = input.item.binding;
    if (caller.webApp !== true || personId === undefined) return { kind: "refused", reason: "forbidden" };
    if (binding === undefined || input.item.kind !== "fix_setup") return { kind: "refused", reason: "stale" };
    const credential = await proofs.issue({ companyId, personId, requestId: input.requestId, kind: "known_failing", taskId: input.item.subjectId, revision: binding.revision, artifactDigest: binding.artifactDigest, outcome, card: { cardId: input.card.id, contentVersion: input.item.contentVersion } });
    const result = await kfGate.decide({ companyId, kind: "known_failing", subjectId: input.item.subjectId, requestId: input.requestId, outcome, seen: binding, credentials: [credential], card: { cardId: input.card.id, contentVersion: input.item.contentVersion }, details: { webApp: true } });
    return result.status === "refused" ? { kind: "refused", reason: CARD_REFUSAL_OF_GATE[result.reason] } : { kind: "done" };
  };
  const performer: DecisionPerformer<DeployedDecisionCaller> = createDecisionPerformer<DeployedDecisionCaller>({ ...Object.fromEntries(WORKFLOW_DOCUMENT_CARD_KINDS.map((kind) => [kind, deployedHandler])), fix_setup: { approve: kfAct("approve"), reject: kfAct("reject") } });

  return {
    sources, performer, store: documentDecisionStore({ store: deps.store, now: nowMs }), now: nowMs,
    // As in Code: a high-risk document is approved on its card (the gate asks the point for the strong proof itself), with its evidence opened first.
    highOnCard: new Set<string>(WORKFLOW_DOCUMENT_CARD_KINDS), evidenceFirstOnHigh: new Set<string>(WORKFLOW_DOCUMENT_CARD_KINDS),
  };
}

// ---- how we work

/**
 * How we work for one company: the repository's file through the company's code host, with the deployment's code settings. Undefined (not served) without a registered code host or without the
 * settings: the answer would otherwise be "no file" or the laptop's fixed settings, which says something untrue about the company.
 */
export function deployedPlaybook(options: { runtime: CoreRuntime; registry: AdapterRegistry; codeSettings: CodeSettingsReader | undefined }): PlaybookService | undefined {
  const { runtime, registry, codeSettings } = options;
  if (codeSettings === undefined || registry.names("code-host").length === 0) return undefined;
  const deps = runtime.flow.deps;
  const projects = createStoreProjectSource(deps.store, runtime.companyId);
  return createPlaybookService({
    companyId: runtime.companyId, store: deps.store, audit: deps.audit, projects, codeSettings, now: () => deps.now?.() ?? new Date(),
    source: createCodeHostPlaybookSource({ companyId: runtime.companyId, projects, codeHosts: registry, now: () => (deps.now?.() ?? new Date()).getTime() }),
  });
}

// ---- the parts the broker's root adds to each company's wiring

export interface DeployedDevWiringInputs {
  runtime: CoreRuntime;
  registry: AdapterRegistry;
  env?: NodeJS.ProcessEnv;
  people: DeployedPeople;
  /** The approvers point's proof issuer (lane L2a). Absent: no decision cards. */
  decisionProofs?: DecisionProofIssuer | undefined;
  /** The company's code settings. Absent: no how we work. */
  codeSettings?: CodeSettingsReader | undefined;
  log?: (entry: Record<string, unknown>) => void;
}

/** Lane L11's part of one company's `CoreDevWiring`: the session levels always, the decision cards with the point's proof issuer, how we work with a code host and the settings. */
export function deployedDevWiringParts(inputs: DeployedDevWiringInputs): Pick<CoreDevWiring, "members" | "decisions" | "playbook"> {
  const playbook = deployedPlaybook({ runtime: inputs.runtime, registry: inputs.registry, codeSettings: inputs.codeSettings });
  return {
    members: deployedSessionMembers(inputs.runtime.companyId, inputs.people),
    ...(inputs.decisionProofs === undefined ? {} : { decisions: deployedDecisionCards({ runtime: inputs.runtime, registry: inputs.registry, people: inputs.people, proofs: inputs.decisionProofs, ...(inputs.env === undefined ? {} : { env: inputs.env }), involvedTaskIds: (caller) => involvedTaskIds(inputs.runtime.flow.deps, caller.principal), ...(inputs.log === undefined ? {} : { log: inputs.log }) }) }),
    ...(playbook === undefined ? {} : { playbook }),
  };
}
