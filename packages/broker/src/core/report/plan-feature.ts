// Lead 4 PCF: what a coding plan's card says about the task's feature, in ONE line, and what the person who may approve it can do about it ("Change", "No feature"). The one place the line is worded, so the
// hosted card, the task page, the laptop's plan page and the Slack card all say the same thing; the surfaces only draw it.
//
// Rules:
//  - Reading is best effort: a store fault gives no line (the card is still decided as it was), never an error that stops an approval.
//  - The line names a feature of THIS company only (the store is keyed by the company; the assignment must also belong to the task's project, as the task view reads it).
//  - Nothing here invents a rule about who may change it. A caller says who the person is by rules that already exist (`mayFile`: the plan's approver who is also allowed to file the task; `manager`: a project
//    maintainer, owner or admin; `admin`: a live company owner or admin, who may also make a feature), and `mayReplace` is the very check `POST /v1/app/tasks/{id}/feature` makes (a starter files a task once and
//    replaces a tracker or plan-confirmed suggestion; a deliberate filing is moved by a manager). A person who may not change it gets the line and no control.
//  - A change is the existing filing (`FeatureStore.setTaskFeature`, source `chosen`): this file writes nothing.
import { FEATURE_NAME_MAX, PLAN_FEATURE_CHOICES_MAX, type FeatureSource, type PlanFeature } from "@agentx/contracts";
import { createFeatureStore, resolveFeature, type FeatureRecord, type FeatureStoreDeps } from "./feature-store.js";

/** What a read needs of the store's deps: no audit sink, because nothing here writes. A write through this store would throw (`READ_ONLY`), never be recorded half-way. */
export type PlanFeatureReadDeps = Pick<FeatureStoreDeps, "store" | "companyId" | "now">;
const READ_ONLY: FeatureStoreDeps["audit"] = { stage: () => { throw new Error("the plan card's feature reads never write"); } };
const readStore = (deps: PlanFeatureReadDeps) => createFeatureStore({ store: deps.store, companyId: deps.companyId, now: deps.now, audit: READ_ONLY });

const TRACKER_WORDS: Readonly<Record<string, string>> = { linear: "from the Linear parent", jira: "from the Jira epic" };
const SOURCE_WORDS: Readonly<Record<Exclude<FeatureSource, "tracker">, string>> = { inherited: "from the task it follows", confirmed_at_plan: "confirmed at plan approval", chosen: "chosen", moved: "chosen" };

/** "Feature: Checkout v2 (from the Linear parent)", or "Feature: No feature". The name is cut for one line. */
export function planFeatureLine(feature: { name: string; source: FeatureSource; tracker?: string | undefined } | null): string {
  if (feature === null) return "Feature: No feature";
  const name = [...feature.name.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim()].slice(0, FEATURE_NAME_MAX).join("");
  const words = feature.source === "tracker" ? (feature.tracker === undefined ? undefined : TRACKER_WORDS[feature.tracker]) ?? "from the tracker" : SOURCE_WORDS[feature.source];
  return `Feature: ${name === "" ? "Unnamed feature" : name} (${words})`;
}

/**
 * Whether a person who may file the task replaces the row it has now. A manager always may (their move is the highest rule); the starter replaces no row at all (the first filing) or a suggestion: the tracker's, or
 * the one confirmed at plan approval. A deliberate filing (`chosen`, `moved`, `inherited`) is a manager's to move. `POST /v1/app/tasks/{id}/feature` makes this same check.
 */
export function mayReplaceTaskFeature(manager: boolean, existing: FeatureSource | undefined): boolean {
  return manager || existing === undefined || existing === "tracker" || existing === "confirmed_at_plan";
}

/** The features a picker lists: open ones, by name, at most `PLAN_FEATURE_CHOICES_MAX`. A done feature takes no new task, so it is not offered. */
export async function planFeatureChoices(deps: PlanFeatureReadDeps): Promise<Array<{ id: string; name: string }>> {
  return (await readStore(deps).list()).filter((record) => record.state === "open").slice(0, PLAN_FEATURE_CHOICES_MAX).map((record) => ({ id: record.id, name: record.name }));
}

/**
 * The plan card's feature view for one task, or undefined when it cannot be read. A merged feature reads as the one it was merged into (as the task view and the report do). The task's own row is
 * ignored when it names another project (the task view's rule).
 */
export async function readPlanFeature(deps: PlanFeatureReadDeps, task: { taskId: string; project: string }, who: { mayFile: boolean; manager: boolean; admin: boolean }): Promise<PlanFeature | undefined> {
  try {
    const features = readStore(deps);
    const assignment = await features.taskFeature(task.taskId);
    const own = assignment !== undefined && assignment.project === task.project ? assignment : undefined;
    let record: FeatureRecord | undefined;
    if (own !== undefined && own.featureId !== null) {
      record = resolveFeature(await features.all(), own.featureId);
      if (record === undefined) return undefined;
    }
    const feature = own === undefined || record === undefined ? null : { id: record.id, name: record.name, source: own.source };
    const canChange = who.mayFile && mayReplaceTaskFeature(who.manager, own?.source);
    return { line: planFeatureLine(feature === null ? null : { ...feature, tracker: record?.trackerLink?.tracker }), feature, canChange, canCreate: canChange && who.admin };
  } catch {
    return undefined;
  }
}
