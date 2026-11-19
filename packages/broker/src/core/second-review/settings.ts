// Second review: what the company and its projects set about it, on the document store. The KEYS are the shared layout, unchanged, so
// a company that moves between Code and the hosted product keeps its settings with no data move:
//   ORG#<company> / SECONDREVIEW#SETTINGS            the company's `default` mode and `lock` (a floor), its CHOICE of reviewer (`models`: a primary and an optional backup) and `context`, and `loweredAt`.
//   ORG#<company> / SECONDREVIEW#PROJECT#<project>   the project's `mode` (and `modeAt`) and its narrowing of the company's choice (`models`, a subset, never wider).
//   ORG#<company> / SECONDREVIEW#VERDICT#<key>       the evidence that lets a model run in `on`, and SECONDREVIEW#REPLAY#<runId> the replay run it names.
// Every read fails closed: a stored value that cannot be read never turns into a looser setting. An unreadable mode is `off`, an unreadable choice is a choice that holds nothing (nothing runs, and it is flagged;
// it never falls back to the default), an unreadable verdict or replay run is absent (so `on` is never reached on bad evidence).
import {
  COMPANY_KEY_PREFIX, SecondReviewContextSchema, change, SecondReviewModeSchema, SecondReviewModelListSchema, SecondReviewReplayRunSchema, SecondReviewVerdictSchema, queryAll,
  type DocumentKey, type DocumentStore, type JsonValue, type SecondReviewContext, type SecondReviewMode, type SecondReviewModelRef, type SecondReviewReplayRun, type SecondReviewVerdict, type TransactItem,
} from "@agentx/contracts";

/** What the second review needs of the store: reads, queries, conditional writes and transactions. */
export type SecondReviewStore = Pick<DocumentStore, "get" | "query" | "put" | "update" | "delete" | "transact">;

type Item = Record<string, unknown>;

export const SECOND_REVIEW_SETTINGS_SK = "SECONDREVIEW#SETTINGS";
const PROJECT_PREFIX = "SECONDREVIEW#PROJECT#";
const VERDICT_PREFIX = "SECONDREVIEW#VERDICT#";
const REPLAY_PREFIX = "SECONDREVIEW#REPLAY#";

/** The company's partition (`ORG#<company>`). The second review's rows all live in it. */
export const secondReviewPartition = (companyId: string): string => {
  if (companyId === "" || /[#\s]/u.test(companyId)) throw new Error("a company id has no '#' or white space");
  return `${COMPANY_KEY_PREFIX}${companyId}`;
};
export const secondReviewSettingsKey = (companyId: string): DocumentKey => ({ pk: secondReviewPartition(companyId), sk: SECOND_REVIEW_SETTINGS_SK });
export const secondReviewVerdictKey = (companyId: string, modelKey: string): DocumentKey => ({ pk: secondReviewPartition(companyId), sk: `${VERDICT_PREFIX}${modelKey.replace(/#/gu, "_")}` });
export const secondReviewReplayKey = (companyId: string, runId: string): DocumentKey => ({ pk: secondReviewPartition(companyId), sk: `${REPLAY_PREFIX}${runId.replace(/#/gu, "_")}` });
export const secondReviewProjectKey = (companyId: string, project: string): DocumentKey => {
  // A project name never holds the separator (project names are validated names); two names must never share a key.
  if (project.includes("#")) throw new Error("a project name cannot hold #");
  return { pk: secondReviewPartition(companyId), sk: `${PROJECT_PREFIX}${project}` };
};

export interface SecondReviewSettings {
  companyDefault?: SecondReviewMode | undefined;
  companyLock?: SecondReviewMode | undefined;
  /** The project's mode as it counts NOW. A project pinned `on` stops counting once the company has been LOWERED since the pin was written (the lowering reaches the project too); it counts again only when it is pinned afresh. */
  projectMode?: SecondReviewMode | undefined;
  /** When the company was last LOWERED (ms), as read. A pin written against it is conditional on it, so a pin racing a lowering fails. */
  companyLoweredAt?: number | undefined;
  /** The project's stored mode, whether or not it still counts. The writer guards its transaction with this one. */
  projectModeStored?: SecondReviewMode | undefined;
  /** What the second reviewer sees besides the change. Anything unreadable is `change_only`, the narrower. */
  context: SecondReviewContext;
  /** The company's choice (primary, then backup). Undefined: nobody chose. An empty list: a choice that could not be read. */
  companyModels?: SecondReviewModelRef[] | undefined;
  /** The project's narrowing. Same meaning as above. */
  projectModels?: SecondReviewModelRef[] | undefined;
  verdicts: SecondReviewVerdict[];
  replayRuns: SecondReviewReplayRun[];
}

const modeOf = (value: unknown): SecondReviewMode | undefined => { const parsed = SecondReviewModeSchema.safeParse(value); return parsed.success ? parsed.data : undefined; };
/** A stored model list: undefined when never set, [] when set but unreadable. */
function modelsOf(item: Item | undefined): SecondReviewModelRef[] | undefined {
  if (item === undefined || item["models"] === undefined) return undefined;
  const parsed = SecondReviewModelListSchema.safeParse(item["models"]);
  return parsed.success ? parsed.data : [];
}

/** Reads everything the plan needs. A read that fails is the caller's to handle (the start treats it as "no second review", never as a looser setting). */
export async function readSecondReviewSettings(store: SecondReviewStore, companyId: string, project: string): Promise<SecondReviewSettings> {
  const [company, projectItem, verdictRows] = await Promise.all([
    store.get(secondReviewSettingsKey(companyId)),
    project === "" ? Promise.resolve(undefined) : store.get(secondReviewProjectKey(companyId, project)),
    queryAll(store, { pk: secondReviewPartition(companyId), sk: { op: "beginsWith", prefix: VERDICT_PREFIX }, limit: 50 }),
  ]);
  const verdicts: SecondReviewVerdict[] = [];
  for (const row of verdictRows) { const parsed = SecondReviewVerdictSchema.safeParse(row["verdict"]); if (parsed.success) verdicts.push(parsed.data); }
  // The replay runs a verdict names, read by their key (a company may hold more runs than a page): a run that is missing or unreadable is absent, so the verdict does not hold.
  const replayRuns: SecondReviewReplayRun[] = [];
  for (const runId of new Set(verdicts.map((verdict) => verdict.replayRunId))) {
    const parsed = SecondReviewReplayRunSchema.safeParse((await store.get(secondReviewReplayKey(companyId, runId)))?.["run"]);
    if (parsed.success) replayRuns.push(parsed.data);
  }
  const stored = modeOf(projectItem?.["mode"]);
  const loweredAt = typeof company?.["loweredAt"] === "number" ? company["loweredAt"] : undefined;
  const pinnedAt = typeof projectItem?.["modeAt"] === "number" ? projectItem["modeAt"] : 0;
  const lapsed = stored === "on" && loweredAt !== undefined && pinnedAt <= loweredAt;
  return {
    companyDefault: modeOf(company?.["default"]), companyLock: modeOf(company?.["lock"]), projectMode: lapsed ? undefined : stored, projectModeStored: stored, companyLoweredAt: loweredAt,
    context: SecondReviewContextSchema.safeParse(company?.["context"]).data ?? "change_only", companyModels: modelsOf(company), projectModels: modelsOf(projectItem), verdicts, replayRuns,
  };
}

/** One write for a transaction: it changes ONLY the fields it names (never a read-modify-write of the whole item), so two changes to different settings cannot undo each other. */
function update(key: DocumentKey, entityType: string, field: "models" | "context", value: JsonValue | undefined, by: string, at: number): TransactItem {
  const stamps = [change.set("updatedAt", at), change.set("updatedBy", by), change.set("entityType", entityType)];
  return { kind: "update", key, ops: value === undefined ? [...stamps, change.remove(field)] : [...stamps, change.set(field, value)] };
}

/** Sets the company's choice (primary, optional backup), or clears it (`models` undefined: nobody has chosen, the default stands). Touches only `models`. */
export const companyChoiceUpdate = (change_: { companyId: string; models: SecondReviewModelRef[] | undefined; by: string; at: number }): TransactItem =>
  update(secondReviewSettingsKey(change_.companyId), "SECOND_REVIEW_SETTINGS", "models", change_.models?.map((model) => ({ ...model })), change_.by, change_.at);

/** Sets what the second reviewer sees besides the change (`change_only` or `same_as_first`). Touches only `context`. */
export const companyContextUpdate = (change_: { companyId: string; context: SecondReviewContext; by: string; at: number }): TransactItem =>
  update(secondReviewSettingsKey(change_.companyId), "SECOND_REVIEW_SETTINGS", "context", change_.context, change_.by, change_.at);

/** Sets a project's narrowing of the company's choice, or clears it. Touches only `models`. The project name is one the company has (the caller checked it exists) and cannot hold the key separator. */
export const projectNarrowingUpdate = (change_: { companyId: string; project: string; models: SecondReviewModelRef[] | undefined; by: string; at: number }): TransactItem =>
  update(secondReviewProjectKey(change_.companyId, change_.project), "SECOND_REVIEW_PROJECT", "models", change_.models?.map((model) => ({ ...model })), change_.by, change_.at);

/** Whether blocking is on anywhere: the company's mode is `on`, or any project is pinned `on` (a pin that lapsed with a lowering of the company does not count). */
export async function anyScopeOn(store: SecondReviewStore, companyId: string): Promise<boolean> {
  const company = await store.get(secondReviewSettingsKey(companyId));
  const loweredAt = typeof company?.["loweredAt"] === "number" ? company["loweredAt"] : undefined;
  if (modeOf(company?.["default"]) === "on" || modeOf(company?.["lock"]) === "on") return true;
  for (const item of await queryAll(store, { pk: secondReviewPartition(companyId), sk: { op: "beginsWith", prefix: PROJECT_PREFIX } })) {
    const pinnedAt = typeof item["modeAt"] === "number" ? item["modeAt"] : 0;
    if (modeOf(item["mode"]) === "on" && !(loweredAt !== undefined && pinnedAt <= loweredAt)) return true;
  }
  return false;
}
