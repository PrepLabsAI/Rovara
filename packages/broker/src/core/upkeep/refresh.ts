// Nightly upkeep, the wiki part (lead 4 N1): one refresh of the pages that are out of date, started through the ONE unattended door (`startUnattendedRun`, core/automation/run-seam.ts).
//
//   - It is AI and it is unattended, so it needs what every unattended start needs: the switch (upkeep ON for THIS project), a dollar cap that is really enforced (the registered Admission declares `enforcesCost: true`;
//     a laptop does not, so nothing is started there), Admission's yes, and the host's SYSTEM-OWNER starter. Without an enforced cap the seam refuses and nothing is written.
//   - Its work origin is `nightly`: the task is started with origin `nightly`, so the TC-1 token it mints says `src: "nightly"` and the gateway holds the call to the project's upkeep cap. That origin is minted ONLY here:
//     a person's wiki build (`createWikiBuildStarter`) refuses it (tests/unit/upkeep-origin.test.ts pins both).
//   - It never builds the FIRST wiki (that is a person's decision and a person's click), only refreshes pages of a wiki that exists: the flagged pages, the pages whose cited files changed, and planned pages with no page yet.
//   - One run per night and project: the request id is the night's (`nightRequestId`), so a double fire starts one run; a run already in flight is "busy".
import { createHash } from "node:crypto";
import { ROVARA_CODE_AGENT_ID, agentXError, systemOwnerIdOf, type OrgId, type WikiIndexEntry, type WikiStore } from "@agentx/contracts";
import { startUnattendedRun, type AutomatedRunStarter, type UnattendedStartDeps } from "../automation/run-seam.js";
import { upkeepAutomationSwitch } from "./wiring.js";
import { prepareUnattendedWikiRefresh, wikiBuildRequestText, type UnattendedRefreshSkip, type WikiBuildDeps } from "../wiki-build/run.js";

/** One night's request id for a project: a version 4 shaped id derived from the company, the project and the day, so a double fire of the same night is the same request. */
export function nightRequestId(orgId: string, project: string, day: string): string {
  const hex = createHash("sha256").update("rovara-upkeep-night\0").update(orgId).update("\0").update(project).update("\0").update(day).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${["8", "9", "a", "b"][Number.parseInt(hex.slice(16, 17), 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface UpkeepRefreshDeps {
  /** The wiki build run's seams, with `starter` the host's SYSTEM-OWNER starter (never a person's). `build.companyId` is the company's own. */
  build: WikiBuildDeps;
  wiki: Pick<WikiStore, "readIndex">;
  /** The unattended door's own dependencies without the starter and the switch (this module supplies both: the starter is tonight's run, the switch is THIS project's upkeep row): admission, audit, whether a dollar cap is enforced, the open-run store. */
  run: Omit<UnattendedStartDeps, "starter" | "automation">;
}

export type UpkeepRefreshAnswer = { outcome: "started"; taskId: string; duplicate: boolean } | { outcome: UnattendedRefreshSkip | "no_cost_cap" };

const isStale = (entry: WikiIndexEntry): boolean => entry.flagged || entry.claims.changed > 0;

/** Starts tonight's refresh for one project, or says why not (nothing started, nothing written, no notice). A refusal the door gives for want of a cap is `no_cost_cap`; every other refusal is thrown as the door threw it. */
export async function startUpkeepWikiRefresh(deps: UpkeepRefreshDeps, input: { project: string; day: string; includeUnwritten?: boolean }): Promise<UpkeepRefreshAnswer> {
  const orgId: OrgId = deps.build.companyId;
  if (deps.run.companyId !== orgId) throw agentXError("CONFIG_INVALID", "the refresh is not for this company");
  const { project } = input;
  const index = await deps.wiki.readIndex(project);
  if (index.length === 0) return { outcome: "no_wiki" };
  const have = new Set(index.map((entry) => entry.pageId));
  const stale = new Set(index.filter(isStale).map((entry) => entry.pageId));
  const requestId = nightRequestId(orgId, project, input.day);
  const prepared = await prepareUnattendedWikiRefresh(deps.build, project, requestId, (page) => (input.includeUnwritten !== false && !have.has(page.id)) || stale.has(page.id), systemOwnerIdOf(orgId, project));
  if ("skip" in prepared) return { outcome: prepared.skip };
  const starter: AutomatedRunStarter = {
    start: () => prepared.launch(),
    read: async (id) => (id === requestId && prepared.existing !== undefined ? prepared.existing : undefined),
  };
  try {
    const started = await startUnattendedRun({ ...deps.run, starter, automation: upkeepAutomationSwitch({ store: deps.build.store, companyId: orgId }, project) }, {
      requestId, project, agent: { agentId: ROVARA_CODE_AGENT_ID }, input: { text: wikiBuildRequestText(project) }, origin: "nightly",
      limits: { maxRunUsd: prepared.limits.budgetCents / 100, maxMinutes: prepared.limits.wallClockMin },
    });
    return { outcome: "started", taskId: started.taskId, duplicate: started.duplicate };
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "AGENT_BUDGET_REQUIRED") return { outcome: "no_cost_cap" };
    throw error;
  }
}
