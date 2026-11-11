// The engine's own functions behind `IntakePorts`, over Code's ports, so that `engine.ts` can be tested with others. Who a tracker account is comes only from the identity port
// (`resolveExternalAccount` over the neutral outside-account shape: a person the owner linked in the config, nobody else); the person is read live (`getPrincipal`), and so is their right to start work
// (`TaskAccess.checkStart`). The start is the task flow's own `start` as that person, so the project, the company's rules, the admission and the run limits are the ones that already exist: nothing here
// decides money or access, and a ticket NEVER approves anything. The plan still waits for the owner's page.
import {
  AgentXError, agentXError, agentSessionKey, change, cleanClientName, when, type DocumentStore, type ExternalAccountRef, type IdentityProvider, type OrgId, type Principal, type RunInput, type SessionBinding,
} from "@agentx/contracts";
import type { CodeIntentRequest } from "@agentx/contracts";
import { developerIdOf, taskSessionId } from "../sessions/create.js";
import { bindSessionSurface, sessionForSurface, unbindSessionSurface } from "../sessions/bindings.js";
import type { TaskCaller, TaskAccess } from "../task-flow/deps.js";
import type { TaskFlow } from "../task-flow/flow.js";
import { noteTicketTaskStarted, type MomentTable } from "../ticket-updates/moments.js";
import type { IntakePorts } from "./engine.js";
import { ticketFenceId, ticketRequestText } from "./ticket-text.js";

export interface IntakeWiring {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  identity: Pick<IdentityProvider, "resolveExternalAccount" | "getPrincipal">;
  access: Pick<TaskAccess, "checkStart">;
  flow: Pick<TaskFlow, "start">;
  /** A key only this install holds: the ticket's fence label is made from it (`ticketFenceId`), so a ticket's author cannot guess it. */
  fenceKey: Uint8Array;
  /** The install's one owner: the person who presses "Start" on a waiting ticket. */
  owner: Principal;
  /** The milestone seams, for the ticket's `started` moment. */
  milestones: MomentTable["milestones"];
  /** Tells the owner once that waiting tickets are not being stored (optional). */
  notifyWaitingFull?: IntakePorts["notifyWaitingFull"];
}

/**
 * The text a ticket's run input becomes in the task's request: the fixed sentence, then the ticket's own words (under the line that says who wrote them and that they are information only) in one fenced block
 * that nothing in the ticket can close (`ticketRequestText`).
 */
export function instructionsOfRunInput(input: RunInput, fenceId: string): string {
  const item = input.context?.[0];
  return ticketRequestText({ lead: input.text ?? "", title: item?.title, body: item?.body ?? "", fenceId });
}

const isPassing = (error: unknown): boolean => error instanceof AgentXError && error.statusCode < 500;

/** The ports of an intake engine, over Code's own dependencies. */
export function intakePortsOf(wiring: IntakeWiring): IntakePorts {
  const table = { store: wiring.store, now: wiring.now };
  const log = wiring.log ?? (() => undefined);
  // The people this process has seen resolve (bounded): the engine names a person by `developerId` (a hash of the person's id), and the flow needs the person.
  const people = new Map<string, Principal>([[developerIdOf(wiring.owner), wiring.owner]]);
  const principalOf = async (orgId: OrgId, developerId: string): Promise<Principal | undefined> => {
    const known = people.get(developerId);
    // Read live: a person who is removed, or in another company, is nobody here.
    const live = known === undefined || orgId !== wiring.companyId ? undefined : await wiring.identity.getPrincipal(orgId, known.personId);
    return live !== undefined && live.companyId === orgId && developerIdOf(live) === developerId ? live : undefined;
  };
  return {
    table,
    log,
    memberOfAccount: async (orgId: OrgId, account: ExternalAccountRef) => {
      if (orgId !== wiring.companyId) return undefined;
      const person = await wiring.identity.resolveExternalAccount(orgId, account);
      if (person === undefined || person.companyId !== orgId) return undefined;
      const developerId = developerIdOf(person);
      if (people.size >= 200 && !people.has(developerId)) people.clear();
      people.set(developerId, person);
      return (await principalOf(orgId, developerId)) === undefined ? undefined : developerId;
    },
    mayStart: async (orgId: OrgId, developerId: string, project: string) => {
      const principal = await principalOf(orgId, developerId);
      if (principal === undefined) return false;
      // A person who may not start work on the project, or a project that is not theirs or is archived: no. A read that failed is the delivery's to repeat.
      try {
        return (await wiring.access.checkStart(principal, project)).allowed;
      } catch (error) {
        if (isPassing(error)) return false;
        throw error;
      }
    },
    start: async (orgId: OrgId, developerId: string, request: CodeIntentRequest) => {
      const principal = await principalOf(orgId, developerId);
      if (principal === undefined) throw agentXError("FORBIDDEN", "The person this run is for isn't a member of the company.");
      if (request.input.text === undefined || request.binding?.kind !== "tracker_item") throw agentXError("CONFIG_INVALID", "A ticket's task needs the ticket's words and its link.");
      // `ticket` is how the task says its request is the ticket's: the plan credits the words to the ticket, not to the owner who started it.
      const caller: TaskCaller = { principal, client: cleanClientName(request.source), ticket: { system: request.binding.system, id: request.binding.id, url: request.binding.url } };
      const title = request.input.context?.[0]?.title;
      // The same start as any other: the task flow's own, so admission, run limits and the project's rules apply. The ticket's words ride in the request under their "information only" line; the task
      // starts as a workflow, so its plan waits for the owner's approval like every plan.
      const started = await wiring.flow.start(caller, {
        requestId: request.requestId, project: request.project, instructions: instructionsOfRunInput(request.input, ticketFenceId(wiring.fenceKey, request.requestId)), ...(title === undefined || title === "" ? {} : { title }), workflow: true,
      });
      const sessionId = taskSessionId(started.task.taskId);
      // The task follows its ticket (and a ticket follows one task): the binding the engine's lookup, the write-back and the merged milestone read. It was written in the start's own transaction (`startExtras`);
      // for a flow whose start does not carry it, and for a repeat, this binds the same (an already bound ticket answers `already_bound`).
      await bindSessionSurface({ store: wiring.store, now: wiring.now }, { orgId, sessionId, binding: request.binding });
      return { task: { taskId: started.task.taskId }, sessionId };
    },
    sessionOfTicket: async (orgId: OrgId, binding: Extract<SessionBinding, { kind: "tracker_item" }>) => {
      const session = await sessionForSurface(wiring.store, orgId, binding);
      return session === undefined ? undefined : { sessionId: session.sessionId, ended: session.endedAt !== undefined };
    },
    // A ticket asked for again after its task ended: the ended session lets go of the ticket (its binding and the surface item).
    freeTicket: async (orgId: OrgId, sessionId: string) => {
      await unbindSessionSurface(wiring.store, { orgId, sessionId: sessionId, kind: "tracker_item" });
    },
    // The new session points back to the one it follows (`retryOf`, written only if it has none).
    linkPrevious: async (orgId: OrgId, nextSessionId: string, previousSessionId: string) => {
      await wiring.store.update({
        key: agentSessionKey(orgId, nextSessionId, "META"), ops: [change.set("retryOf", previousSessionId), change.add("revision", 1)],
        condition: when.and(when.present(), when.eq("orgId", orgId), when.notExists("retryOf")),
      });
    },
    ...(wiring.notifyWaitingFull === undefined ? {} : { notifyWaitingFull: wiring.notifyWaitingFull }),
    // The ticket hears that work started (a `started` milestone; the ticket updates handler decides whether to write).
    started: async (orgId: OrgId, started: { taskId: string; sessionId?: string | undefined }) => {
      await noteTicketTaskStarted({ store: wiring.store, milestones: wiring.milestones, now: wiring.now, log }, { orgId, taskId: started.taskId, sessionId: started.sessionId });
    },
  };
}
