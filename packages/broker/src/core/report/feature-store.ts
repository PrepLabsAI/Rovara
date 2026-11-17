// The cost report's features (lead 4, slice A1): a named group of tasks in ONE company, and the feature each task is filed under. Both live in the company's own report partition
// (`reportPartition`), so every key is built from the company the caller checked and a feature of another company reads as absent.
//
//   FEATURE#<id>     the feature: name, state (open, done, merged), the tracker link, and `mergedInto` once merged away
//   FNAME#<name>     the lower-case name, so two features of one company never share a name (freed when the feature is renamed or merged away)
//   TASKFEAT#<task>  the feature a task is filed under, how it got there, or "No feature" chosen on purpose (`featureId: null`)
//
// The feature is NOT copied into work events or report rows: the report joins a task to its CURRENT feature when it reads (`resolveFeature` follows `mergedInto`), so moving a task or merging two
// features rewrites no history. A lower rule never replaces a higher one (`FEATURE_SOURCE_RANK`); only a person's own act (moved, chosen, confirmed at plan) may replace a rule of the same rank.
// Every change is one transaction with its audit record (who and when are in the audit record; no row here names a person, so a person erase has nothing to scrub). Every write that depends on
// what it read is conditional on the row's `version`; a lost race is a fixed conflict, never a silent overwrite.
import { randomBytes } from "node:crypto";
import {
  FEATURE_CANNOT_MERGE, FEATURE_CONFLICT, FEATURE_IS_DONE, FEATURE_LIMIT, FEATURE_NAME_MAX, FEATURE_NAME_TAKEN, FEATURE_NOT_FOUND, FEATURE_SOURCE_RANK, REPORT_UNAVAILABLE, FeatureIdSchema, FeatureSourceSchema,
  FeatureTrackerLinkSchema, OrgIdSchema, PERSON_FEATURE_SOURCES, REPORT_FEATURES_MAX, REPORT_SK, agentXError, redactText, reportFeatureKey, reportFeatureNameKey, reportPartition, reportTaskFeatureKey, when,
  type AuditActor, type AuditSink, type DocumentStore, type FeatureSource, type FeatureTrackerLink, type FeatureView, type OrgId, type StoredDocument, type TransactItem,
} from "@agentx/contracts";
import { rowBelongsToCompany } from "../company-read-rows.js";

/** How many `mergedInto` steps a read follows: a chain longer than this reads as no feature (a merge into a merged feature is refused, so real chains are a step or two). */
const MERGE_CHAIN_MAX = 8;
const STATES = ["open", "done", "merged"] as const;
type StoredState = (typeof STATES)[number];

export interface FeatureRecord {
  id: string;
  name: string;
  state: StoredState;
  trackerLink?: FeatureTrackerLink | undefined;
  mergedInto?: string | undefined;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface TaskFeatureRecord {
  taskId: string;
  project: string;
  /** `null`: filed under "No feature" on purpose. */
  featureId: string | null;
  source: FeatureSource;
  setAt: string;
  version: number;
}

export interface FeatureStoreDeps {
  store: Pick<DocumentStore, "get" | "getMany" | "query" | "transact">;
  companyId: OrgId;
  audit: Pick<AuditSink, "stage">;
  now: () => number;
  /** Tests: the id of a new feature. */
  newId?: () => string;
}
export interface FeatureActor { type: AuditActor["type"]; id: string }

/** A name as it is stored: no control or invisible characters, one line, redacted if it looks like a secret, cut to `FEATURE_NAME_MAX` characters. Empty after cleaning: undefined. */
export function cleanFeatureName(raw: string): string | undefined {
  const plain = redactText(raw).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  const cut = [...plain].slice(0, FEATURE_NAME_MAX).join("").trimEnd();
  return cut === "" ? undefined : cut;
}
/** The key form of a name: lower case, so "Checkout V2" and "checkout v2" are one feature. */
export const featureNameKeyOf = (name: string): string => name.toLowerCase();

const iso = (deps: Pick<FeatureStoreDeps, "now">): string => new Date(deps.now()).toISOString();
const conflict = () => agentXError("CONFIG_INVALID", FEATURE_CONFLICT);
const notFound = () => agentXError("NOT_FOUND", FEATURE_NOT_FOUND);

function plain(value: Record<string, unknown>): StoredDocument {
  return JSON.parse(JSON.stringify(value)) as StoredDocument;
}

export function featureOf(row: StoredDocument | undefined, companyId: OrgId): FeatureRecord | undefined {
  if (row === undefined || row["entityType"] !== "REPORT_FEATURE" || !rowBelongsToCompany(row, companyId)) return undefined;
  const id = FeatureIdSchema.safeParse(row["id"]);
  if (!id.success || row.sk !== `${REPORT_SK.feature}${id.data}`) return undefined;
  const name = row["name"];
  const state = row["state"];
  const link = row["trackerLink"] === undefined ? undefined : FeatureTrackerLinkSchema.safeParse(row["trackerLink"]);
  if (typeof name !== "string" || name === "" || !STATES.includes(state as StoredState) || typeof row["createdAt"] !== "string" || typeof row["updatedAt"] !== "string" || typeof row["version"] !== "number") return undefined;
  if (link !== undefined && !link.success) return undefined;
  if (state === "merged" && typeof row["mergedInto"] !== "string") return undefined;
  return {
    id: id.data, name, state: state as StoredState, ...(link === undefined ? {} : { trackerLink: link.data }), ...(typeof row["mergedInto"] === "string" ? { mergedInto: row["mergedInto"] } : {}),
    createdAt: row["createdAt"], updatedAt: row["updatedAt"], version: row["version"],
  };
}

export function taskFeatureOf(row: StoredDocument | undefined, companyId: OrgId): TaskFeatureRecord | undefined {
  if (row === undefined || row["entityType"] !== "REPORT_TASK_FEATURE" || !rowBelongsToCompany(row, companyId)) return undefined;
  const source = FeatureSourceSchema.safeParse(row["source"]);
  const featureId = row["featureId"];
  if (!source.success || typeof row["taskId"] !== "string" || row.sk !== `${REPORT_SK.taskFeature}${row["taskId"]}` || typeof row["project"] !== "string" || typeof row["setAt"] !== "string" || typeof row["version"] !== "number") return undefined;
  if (featureId !== null && !FeatureIdSchema.safeParse(featureId).success) return undefined;
  return { taskId: row["taskId"], project: row["project"], featureId: featureId as string | null, source: source.data, setAt: row["setAt"], version: row["version"] };
}

/** The public view of a feature (a merged one has none: its tasks read as the other's). */
export function featureView(record: FeatureRecord): FeatureView | undefined {
  if (record.state === "merged") return undefined;
  return { id: record.id, name: record.name, state: record.state, ...(record.trackerLink === undefined ? {} : { trackerLink: record.trackerLink }), createdAt: record.createdAt, updatedAt: record.updatedAt };
}

export interface FeatureStore {
  /** The company's features that are open or done, by name. */
  list(): Promise<FeatureRecord[]>;
  /** Every feature record of the company (merged ones included), for a reader that resolves task assignments. At most `REPORT_FEATURES_MAX`. */
  all(): Promise<Map<string, FeatureRecord>>;
  get(featureId: string): Promise<FeatureRecord | undefined>;
  create(input: { name: string; trackerLink?: FeatureTrackerLink | undefined }, actor: FeatureActor): Promise<FeatureRecord>;
  rename(featureId: string, name: string, actor: FeatureActor): Promise<FeatureRecord>;
  setState(featureId: string, state: "open" | "done", actor: FeatureActor): Promise<FeatureRecord>;
  /** Merges `from` into `into`: the tasks of `from` read as `into`'s from now on. Neither may be merged away already; not into itself. */
  merge(fromId: string, intoId: string, actor: FeatureActor): Promise<FeatureRecord>;
  taskFeature(taskId: string): Promise<TaskFeatureRecord | undefined>;
  /**
   * Files a task under a feature (or under no feature, `featureId: null`). A lower rule never replaces a higher one: the answer is `kept` with the stored record. The same rank replaces only for a person's own
   * act. The feature must be open (not done, not merged away).
   */
  setTaskFeature(input: { taskId: string; project: string; featureId: string | null; source: FeatureSource }, actor: FeatureActor): Promise<{ outcome: "set" | "kept"; record: TaskFeatureRecord }>;
  /** Rule 3: `to` takes the feature `from` is filed under (source `inherited`), when `from` is filed under one and `to` has nothing higher. Nothing to inherit: undefined. */
  inheritFeature(input: { from: string; to: string; project: string }): Promise<{ outcome: "set" | "kept"; record: TaskFeatureRecord } | undefined>;
}

/** The feature a feature id reads as now: itself, or the one it was merged into (followed at most `MERGE_CHAIN_MAX` steps). Undefined: unknown, or a chain that does not end. */
export function resolveFeature(features: ReadonlyMap<string, FeatureRecord>, featureId: string): FeatureRecord | undefined {
  let current = features.get(featureId);
  for (let step = 0; current !== undefined && step <= MERGE_CHAIN_MAX; step += 1) {
    if (current.state !== "merged") return current;
    current = current.mergedInto === undefined ? undefined : features.get(current.mergedInto);
  }
  return undefined;
}

/** Every feature record of the company, merged ones included: one bounded read (a company holds at most `REPORT_FEATURES_MAX`). More than that, or a page that never ends, is a fault, never a partial list. */
export async function loadFeatures(store: Pick<DocumentStore, "query">, companyId: OrgId): Promise<Map<string, FeatureRecord>> {
  const rows: StoredDocument[] = [];
  let cursor: string | undefined;
  for (let reads = 0; reads < 5; reads += 1) {
    const page = await store.query({ pk: reportPartition(companyId), sk: { op: "beginsWith", prefix: REPORT_SK.feature }, limit: REPORT_FEATURES_MAX + 1, ...(cursor === undefined ? {} : { cursor }) });
    rows.push(...page.items);
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  if (cursor !== undefined || rows.length > REPORT_FEATURES_MAX) throw agentXError("RUNTIME_UNAVAILABLE", REPORT_UNAVAILABLE);
  const out = new Map<string, FeatureRecord>();
  for (const row of rows) {
    const record = featureOf(row, companyId);
    if (record !== undefined) out.set(record.id, record);
  }
  return out;
}

export function createFeatureStore(deps: FeatureStoreDeps): FeatureStore {
  const companyId = OrgIdSchema.parse(deps.companyId);
  const partition = reportPartition(companyId);
  const newId = deps.newId ?? ((): string => `ft_${randomBytes(10).toString("hex")}`);
  const audit = (actor: FeatureActor, action: string, subject: { type: string; id: string }, version: number, details: Record<string, string | number | null>): readonly TransactItem[] =>
    deps.audit.stage({ eventId: `${action}:${subject.id}:${String(version)}`, companyId, at: iso(deps), actor, action, subject: { type: subject.type, id: subject.id }, details });

  const loadAll = (): Promise<Map<string, FeatureRecord>> => loadFeatures(deps.store, companyId);
  const get = async (featureId: string): Promise<FeatureRecord | undefined> => {
    if (!FeatureIdSchema.safeParse(featureId).success) return undefined;
    return featureOf(await deps.store.get(reportFeatureKey(companyId, featureId)), companyId);
  };
  const need = async (featureId: string): Promise<FeatureRecord> => (await get(featureId)) ?? (() => { throw notFound(); })();

  async function commit(items: TransactItem[]): Promise<void> {
    const result = await deps.store.transact(items);
    if (!result.applied) throw conflict();
  }

  const featureRow = (record: FeatureRecord): StoredDocument => plain({
    ...reportFeatureKey(companyId, record.id), entityType: "REPORT_FEATURE", companyId, id: record.id, name: record.name, state: record.state,
    ...(record.trackerLink === undefined ? {} : { trackerLink: record.trackerLink }), ...(record.mergedInto === undefined ? {} : { mergedInto: record.mergedInto }),
    createdAt: record.createdAt, updatedAt: record.updatedAt, version: record.version,
  });
  const nameRow = (record: Pick<FeatureRecord, "id" | "name">): StoredDocument => plain({ ...reportFeatureNameKey(companyId, featureNameKeyOf(record.name)), entityType: "REPORT_FEATURE_NAME", companyId, featureId: record.id });

  return {
    async list() {
      return [...(await loadAll()).values()].filter((record) => record.state !== "merged").sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },
    all: loadAll,
    get,

    async create(input, actor) {
      const name = cleanFeatureName(input.name);
      if (name === undefined) throw agentXError("CONFIG_INVALID", "the feature needs a name");
      const link = input.trackerLink === undefined ? undefined : FeatureTrackerLinkSchema.parse(input.trackerLink);
      // A soft cap: one read of the company's features is one page, so a company never holds more than a page of them.
      const held = await deps.store.query({ pk: partition, sk: { op: "beginsWith", prefix: REPORT_SK.feature }, limit: REPORT_FEATURES_MAX });
      if (held.items.length >= REPORT_FEATURES_MAX || held.cursor !== undefined) throw agentXError("CONFIG_INVALID", FEATURE_LIMIT);
      const at = iso(deps);
      const record: FeatureRecord = { id: newId(), name, state: "open", ...(link === undefined ? {} : { trackerLink: link }), createdAt: at, updatedAt: at, version: 1 };
      const result = await deps.store.transact([
        { kind: "put", item: nameRow(record), condition: when.absent() },
        { kind: "put", item: featureRow(record), condition: when.absent() },
        ...audit(actor, "report.feature_created", { type: "feature", id: record.id }, 1, { name: record.name }),
      ]);
      if (!result.applied) throw agentXError("CONFIG_INVALID", FEATURE_NAME_TAKEN);
      return record;
    },

    async rename(featureId, rawName, actor) {
      const name = cleanFeatureName(rawName);
      if (name === undefined) throw agentXError("CONFIG_INVALID", "the feature needs a name");
      const before = await need(featureId);
      if (before.state === "merged") throw notFound();
      const at = iso(deps);
      const next: FeatureRecord = { ...before, name, updatedAt: at, version: before.version + 1 };
      const sameKey = featureNameKeyOf(name) === featureNameKeyOf(before.name);
      const items: TransactItem[] = [
        ...(sameKey ? [] : [
          { kind: "put" as const, item: nameRow(next), condition: when.absent() },
          { kind: "delete" as const, key: reportFeatureNameKey(companyId, featureNameKeyOf(before.name)), condition: when.eq("featureId", before.id) },
        ]),
        { kind: "put", item: featureRow(next), condition: when.and(when.present(), when.eq("version", before.version), when.eq("companyId", companyId)) },
        ...audit(actor, "report.feature_renamed", { type: "feature", id: before.id }, next.version, { name }),
      ];
      const result = await deps.store.transact(items);
      if (!result.applied) {
        // The new name's row is item 0 when the keys differ: a lost condition there is the name being taken.
        if (!sameKey && result.failed.includes(0)) throw agentXError("CONFIG_INVALID", FEATURE_NAME_TAKEN);
        throw conflict();
      }
      return next;
    },

    async setState(featureId, state, actor) {
      const before = await need(featureId);
      if (before.state === "merged") throw notFound();
      const next: FeatureRecord = { ...before, state, updatedAt: iso(deps), version: before.version + 1 };
      await commit([
        { kind: "put", item: featureRow(next), condition: when.and(when.present(), when.eq("version", before.version), when.eq("companyId", companyId)) },
        ...audit(actor, "report.feature_state_changed", { type: "feature", id: before.id }, next.version, { state }),
      ]);
      return next;
    },

    async merge(fromId, intoId, actor) {
      if (fromId === intoId) throw agentXError("CONFIG_INVALID", FEATURE_CANNOT_MERGE);
      const [from, into] = await Promise.all([need(fromId), need(intoId)]);
      if (from.state === "merged" || into.state === "merged") throw agentXError("CONFIG_INVALID", FEATURE_CANNOT_MERGE);
      const next: FeatureRecord = { ...from, state: "merged", mergedInto: into.id, updatedAt: iso(deps), version: from.version + 1 };
      await commit([
        { kind: "put", item: featureRow(next), condition: when.and(when.present(), when.eq("version", from.version), when.eq("companyId", companyId)) },
        // The target must still be there, unchanged in the way that matters (not merged away meanwhile).
        { kind: "check", key: reportFeatureKey(companyId, into.id), condition: when.and(when.present(), when.eq("companyId", companyId), when.or(when.eq("state", "open"), when.eq("state", "done"))) },
        // The merged feature's name is free again.
        { kind: "delete", key: reportFeatureNameKey(companyId, featureNameKeyOf(from.name)), condition: when.eq("featureId", from.id) },
        ...audit(actor, "report.feature_merged", { type: "feature", id: from.id }, next.version, { into: into.id }),
      ]);
      return next;
    },

    async taskFeature(taskId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(taskId)) return undefined;
      return taskFeatureOf(await deps.store.get(reportTaskFeatureKey(companyId, taskId)), companyId);
    },

    async setTaskFeature(input, actor) {
      const source = FeatureSourceSchema.parse(input.source);
      const key = reportTaskFeatureKey(companyId, input.taskId);
      if (input.featureId !== null) {
        const target = await need(input.featureId);
        if (target.state === "merged") throw notFound();
        if (target.state === "done") throw agentXError("CONFIG_INVALID", FEATURE_IS_DONE);
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const existing = taskFeatureOf(await deps.store.get(key), companyId);
        if (existing !== undefined) {
          const [old, next] = [FEATURE_SOURCE_RANK[existing.source], FEATURE_SOURCE_RANK[source]];
          // A lower rule never replaces a higher one; the same rank replaces only for a person's own act.
          if (next < old || (next === old && !PERSON_FEATURE_SOURCES.includes(source))) return { outcome: "kept", record: existing };
          if (existing.featureId === input.featureId && existing.source === source) return { outcome: "kept", record: existing };
        }
        const record: TaskFeatureRecord = { taskId: input.taskId, project: input.project, featureId: input.featureId, source, setAt: iso(deps), version: (existing?.version ?? 0) + 1 };
        const row = plain({ ...key, entityType: "REPORT_TASK_FEATURE", companyId, taskId: record.taskId, project: record.project, featureId: record.featureId, source: record.source, setAt: record.setAt, version: record.version });
        const items: TransactItem[] = [
          { kind: "put", item: row, condition: existing === undefined ? when.absent() : when.and(when.present(), when.eq("version", existing.version)) },
          ...(input.featureId === null ? [] : [{ kind: "check" as const, key: reportFeatureKey(companyId, input.featureId), condition: when.and(when.present(), when.eq("companyId", companyId), when.eq("state", "open")) }]),
          ...audit(actor, "report.task_feature_set", { type: "task", id: input.taskId }, record.version, { featureId: record.featureId, source: record.source, project: record.project }),
        ];
        const result = await deps.store.transact(items);
        if (result.applied) return { outcome: "set", record };
      }
      throw conflict();
    },

    async inheritFeature(input) {
      const from = await this.taskFeature(input.from);
      if (from === undefined || from.featureId === null) return undefined;
      // The feature as it reads now (a merged one is its target); a feature that is done takes no new tasks, so nothing is inherited from it.
      const target = resolveFeature(await loadAll(), from.featureId);
      if (target === undefined || target.state !== "open") return undefined;
      return await this.setTaskFeature({ taskId: input.to, project: input.project, featureId: target.id, source: "inherited" }, { type: "system", id: "report" });
    },
  };
}
