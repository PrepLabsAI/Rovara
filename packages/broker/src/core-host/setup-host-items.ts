// The decision cards of a company's open setup website asks (a setup run needs a website its machine cannot reach). One card per open ask, drawn from the company's index of open asks (each ask read again),
// and only for the people who may decide one: a company owner or admin (`setupHostApproverAllows`, the rule the run page's host-decide route enforces); anyone else is shown none. The card opens the project's
// setup page, where the decision is made. Nothing here decides anything.
import type { DocumentStore, OrgId } from "@agentx/contracts";
import type { DecisionItem } from "../core/decisions/project.js";
import { HOST_ASK_REVISION, hostAskDigest, hostAskSubjectId, isInternationalName, listOpenHostAsksOfCompany, type SetupHostAsk } from "../core/setup-agent/host-ask.js";

/** The card item of one open ask. Rovara staff do not also approve a website on the deployed core (`staffStep` false). */
export function setupHostItemOf(companyId: OrgId, ask: SetupHostAsk): DecisionItem {
  const digest = hostAskDigest(ask);
  return {
    kind: "setup_host", subjectId: hostAskSubjectId(companyId, ask.project, ask.host), project: ask.project, title: `Website for setup: ${ask.host}`, createdAt: ask.askedAt,
    openPath: `/app/projects/${encodeURIComponent(ask.project)}/setup`, contentVersion: digest, binding: { revision: HOST_ASK_REVISION, artifactDigest: digest },
    host: ask.host, staffStep: false, ...(isInternationalName(ask.host) ? { international: true } : {}),
    ...(ask.from === undefined ? {} : { from: ask.from }), ...(ask.journalN === undefined ? {} : { journalN: ask.journalN }),
  };
}

/** The cards for `companyId`'s open asks, newest first; none unless `mayDecide`. A read that fails lists none (the run page still decides it) and is logged. */
export async function setupHostItems(table: { store: DocumentStore; now: () => number }, companyId: OrgId, mayDecide: boolean, log: (entry: Record<string, unknown>) => void): Promise<DecisionItem[]> {
  if (!mayDecide) return [];
  try {
    return (await listOpenHostAsksOfCompany(table, companyId)).map((ask) => setupHostItemOf(companyId, ask));
  } catch {
    log({ event: "core_engine.setup_host_cards_unreadable", companyId });
    return [];
  }
}
