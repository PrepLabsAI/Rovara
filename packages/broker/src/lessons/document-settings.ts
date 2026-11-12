// Where the learning settings are kept, in the document store, on the same items a hosted install keeps them on (so either can read the same rows):
//   project: pk of the project, sk `LESSONSET#SETTINGS`      (`tier0`: the project's tier0Approval)
//   company: pk of the company, sk `LESSONSET#COMPANY`        (`tier0`: the company floor, companyApproval.tier0)
//   proposals (preset and sole-owner switch only): the same pk, sk `LESSONSET#TIER0CHG#PRESET#<id>` and `LESSONSET#TIER0CHG#SOLE#<id>`
//   company sole-owner switch: the company pk, sk `LESSONSET#COMPANYSOLE` (`enabled`: whether the sole-owner exception may approve a loosening; absent means ON). It holds no person.
//   local coding tools (decision 46b): the project pk, sk `LESSONSET#LOCALTOOLS` (`enabled`: absent means ON), and the company pk, sk `LESSONSET#COMPANYSTAY` (`stays`: "lessons stay in Rovara"; absent means off). Neither holds a person.
// Every sort key starts with `LESSONSET`, which a project erase and a company erase wipe.
import {
  LEARNED_CONTEXT_MAX_BYTES, LEARNED_CONTEXT_MAX_LESSONS, learningModeKey, learningModeLockKey, queryAll, teamRecordPk, when, change,
  type Condition, type DocumentStore, type StoredDocument, type TransactItem,
} from "@agentx/contracts";
import { LOAD_BUDGET_MIN, TIER0_APPROVAL_DEFAULT, type LearningPreset, type LearningSettings, type LearningSettingsReader, type LoadBudgetSetting } from "./policy.js";
import type { PresetChange, PresetChangeStore, PresetScope, PresetStore } from "./preset-setting.js";
import type { LocalToolsSettings, LocalToolsSettingsStore } from "./local-tools.js";
import type { SoleOwnerSwitchChange, SoleOwnerSwitchStore, Tier0Fence, Tier0Level, Tier0Scope, Tier0SettingsStore } from "./sole-owner-switch.js";

type Item = StoredDocument;
const pkOf = (scope: Tier0Scope): string => teamRecordPk(scope.workspaceId, scope.kind === "project" ? scope.project : undefined);
const settingKey = (scope: Tier0Scope) => ({ pk: pkOf(scope), sk: scope.kind === "project" ? "LESSONSET#SETTINGS" : "LESSONSET#COMPANY" });
const SOLE_OWNER_SK = "LESSONSET#COMPANYSOLE";
// The switch's proposals live under the tier-0 proposals' prefix on purpose: the person erase replaces `proposedBy` on every row under it.
const SOLE_CHANGE_PREFIX = "LESSONSET#TIER0CHG#SOLE#";
const soleChangeKey = (workspaceId: string, id: string) => ({ pk: teamRecordPk(workspaceId, undefined), sk: `${SOLE_CHANGE_PREFIX}${id.replace(/#/gu, "_")}` });
const isLevel = (value: unknown): value is Tier0Level => value === "auto" || value === "one" || value === "two";
/** The contracts' mode names (lower case) and the policy's (capitalised). */
type Mode = NonNullable<LearningSettings["mode"]>;
const MODE_NAMES: Record<string, Mode> = { off: "Off", collect: "Collect", suggest: "Suggest", on: "On" };
/** The mode of a project that never chose one: lessons are made and each needs a person before it is used. */
const DEFAULT_PROJECT_MODE: Mode = "Suggest";

/** Writes one item conditionally; with a fence the item commits together with the membership conditions. A failed condition is `false`. */
async function putFenced(store: DocumentStore, item: Item, condition: Condition, fence: Tier0Fence | undefined): Promise<boolean> {
  if (fence?.conditions !== undefined && fence.conditions.length > 0) {
    const result = await store.transact([...(fence.conditions as TransactItem[]), { kind: "put", item, condition }]);
    return result.applied;
  }
  return (await store.put({ item, condition })).applied;
}

export class DocumentTier0Settings implements Tier0SettingsStore {
  constructor(private readonly store: DocumentStore) {}

  async read(scope: Tier0Scope): Promise<Tier0Level | undefined> {
    const item = await this.store.get(settingKey(scope));
    // A stored value that is not one of the three is not "unset" (which means the default): the call fails, and the caller fails closed.
    if (item === undefined) return undefined;
    if (!isLevel(item["tier0"])) throw new Error("the stored tier-0 setting is not valid");
    return item["tier0"];
  }

  async write(scope: Tier0Scope, value: Tier0Level, meta: { by: string; at: number }, from: Tier0Level, fence?: Tier0Fence): Promise<boolean> {
    // Conditional on the value the caller read; an absent item is the default, so it matches only when `from` is the default.
    const isDefault = from === (scope.kind === "project" ? TIER0_APPROVAL_DEFAULT : "auto");
    return putFenced(this.store, { ...settingKey(scope), entityType: "LESSON_SETTINGS", tier0: value, updatedBy: meta.by, updatedAt: meta.at }, isDefault ? when.or(when.absent(), when.eq("tier0", from)) : when.eq("tier0", from), fence);
  }
}

const presetKey = (scope: PresetScope) => ({ pk: pkOf(scope), sk: scope.kind === "project" ? "LESSONSET#PRESET" : "LESSONSET#COMPANYPRESET" });
// Proposals to loosen a preset live under the tier-0 proposals' prefix on purpose: the person erase replaces `proposedBy` on every row under it. The tier-0 reader skips them (another entity type).
const PRESET_CHANGE_PREFIX = "LESSONSET#TIER0CHG#PRESET#";
const presetChangeKey = (scope: PresetScope, id: string) => ({ pk: pkOf(scope), sk: `${PRESET_CHANGE_PREFIX}${id.replace(/#/gu, "_")}` });
const isPreset = (value: unknown): value is LearningPreset => value === "standard" || value === "regulated";

/** The learning preset (Standard / Regulated) of a project or the company, on items of their own so a tier-0 write never replaces it, and its loosening proposals. The setting item names no person. */
export class DocumentPresetStore implements PresetStore, PresetChangeStore {
  constructor(private readonly store: DocumentStore) {}
  async read(scope: PresetScope): Promise<LearningPreset | undefined> {
    const item = await this.store.get(presetKey(scope));
    if (item === undefined) return undefined;
    if (!isPreset(item["preset"])) throw new Error("the stored learning preset is not valid");
    return item["preset"];
  }
  async write(scope: PresetScope, value: LearningPreset, meta: { by: string; at: number }, from: LearningPreset, fence?: Tier0Fence): Promise<boolean> {
    // Conditional on the value the caller read; an absent item is Standard, so it matches only when `from` is Standard. The item holds no person (the audit event names who).
    return putFenced(this.store, { ...presetKey(scope), entityType: "LESSON_PRESET", preset: value, updatedAt: meta.at }, from === "standard" ? when.or(when.absent(), when.eq("preset", from)) : when.eq("preset", from), fence);
  }
  async create(changeRequest: PresetChange): Promise<boolean> {
    const written = await this.store.put({ item: { ...presetChangeKey(changeRequest.scope, changeRequest.id), entityType: "LESSON_PRESET_CHANGE", ...(structuredClone(changeRequest) as unknown as Record<string, never>) }, condition: when.absent() });
    return written.applied;
  }
  private parse(item: Item | undefined): PresetChange | undefined {
    if (item?.["entityType"] !== "LESSON_PRESET_CHANGE" || typeof item["id"] !== "string" || !isPreset(item["from"]) || !isPreset(item["to"])) return undefined;
    if (item["state"] !== "pending" && item["state"] !== "applied" && item["state"] !== "cancelled") return undefined;
    if (typeof item["proposedBy"] !== "string" || typeof item["at"] !== "number" || typeof item["expiresAt"] !== "number") return undefined;
    return { id: item["id"], scope: item["scope"] as unknown as PresetScope, from: item["from"], to: item["to"], proposedBy: item["proposedBy"], at: item["at"], expiresAt: item["expiresAt"], state: item["state"], ...(typeof item["soleEligibleAtProposal"] === "boolean" ? { soleEligibleAtProposal: item["soleEligibleAtProposal"] } : {}) };
  }
  async get(scope: PresetScope, id: string): Promise<PresetChange | undefined> { return this.parse(await this.store.get(presetChangeKey(scope, id))); }
  async open(scope: PresetScope, now: number): Promise<PresetChange | undefined> {
    const items = await queryAll(this.store, { pk: pkOf(scope), sk: { op: "beginsWith", prefix: PRESET_CHANGE_PREFIX } });
    return items.map((i) => this.parse(i)).find((c) => c !== undefined && c.state === "pending" && c.expiresAt > now);
  }
  async transition(scope: PresetScope, id: string, from: PresetChange["state"], to: PresetChange["state"]): Promise<boolean> {
    return (await this.store.update({ key: presetChangeKey(scope, id), ops: [change.set("state", to)], condition: when.eq("state", from) })).applied;
  }
}

/**
 * The company switch for the sole-owner exception on loosening, and its proposals. `read` is ON when never set; a stored value that is not a boolean throws (the caller counts it as OFF).
 * `write` is internal to `setSoleOwnerSwitch` / `approveSoleOwnerSwitch` (sole-owner-switch.ts): routes never call it, so an OFF switch can only come back ON through a second approver.
 */
export class DocumentSoleOwnerSwitch implements SoleOwnerSwitchStore {
  constructor(private readonly store: DocumentStore) {}
  async read(workspaceId: string): Promise<boolean> {
    const item = await this.store.get({ pk: teamRecordPk(workspaceId, undefined), sk: SOLE_OWNER_SK });
    if (item === undefined) return true;
    if (typeof item["enabled"] !== "boolean") throw new Error("the stored sole-owner setting is not valid");
    return item["enabled"];
  }
  async write(workspaceId: string, enabled: boolean, meta: { by: string; at: number }, from: boolean, fence?: Tier0Fence): Promise<boolean> {
    // The item holds no person (the audit event names who); an absent item is ON.
    return putFenced(this.store, { pk: teamRecordPk(workspaceId, undefined), sk: SOLE_OWNER_SK, entityType: "LESSON_SOLE_OWNER_SETTING", enabled, updatedAt: meta.at }, from ? when.or(when.absent(), when.eq("enabled", from)) : when.eq("enabled", from), fence);
  }
  async create(changeRequest: SoleOwnerSwitchChange): Promise<boolean> {
    const written = await this.store.put({ item: { ...soleChangeKey(changeRequest.workspaceId, changeRequest.id), entityType: "LESSON_SOLE_SWITCH_CHANGE", ...(structuredClone(changeRequest) as unknown as Record<string, never>) }, condition: when.absent() });
    return written.applied;
  }
  private parse(item: Item | undefined): SoleOwnerSwitchChange | undefined {
    if (item?.["entityType"] !== "LESSON_SOLE_SWITCH_CHANGE" || typeof item["id"] !== "string" || typeof item["workspaceId"] !== "string" || typeof item["from"] !== "boolean" || typeof item["to"] !== "boolean") return undefined;
    if (item["state"] !== "pending" && item["state"] !== "applied" && item["state"] !== "cancelled") return undefined;
    if (typeof item["proposedBy"] !== "string" || typeof item["at"] !== "number" || typeof item["expiresAt"] !== "number") return undefined;
    return { id: item["id"], workspaceId: item["workspaceId"], from: item["from"], to: item["to"], proposedBy: item["proposedBy"], at: item["at"], expiresAt: item["expiresAt"], state: item["state"] };
  }
  async get(workspaceId: string, id: string): Promise<SoleOwnerSwitchChange | undefined> { return this.parse(await this.store.get(soleChangeKey(workspaceId, id))); }
  async open(workspaceId: string, now: number): Promise<SoleOwnerSwitchChange | undefined> {
    const items = await queryAll(this.store, { pk: teamRecordPk(workspaceId, undefined), sk: { op: "beginsWith", prefix: SOLE_CHANGE_PREFIX } });
    return items.map((i) => this.parse(i)).find((c) => c !== undefined && c.state === "pending" && c.expiresAt > now);
  }
  async transition(workspaceId: string, id: string, from: SoleOwnerSwitchChange["state"], to: SoleOwnerSwitchChange["state"]): Promise<boolean> {
    return (await this.store.update({ key: soleChangeKey(workspaceId, id), ops: [change.set("state", to)], condition: when.eq("state", from) })).applied;
  }
}

const LOAD_BUDGET_SK = "LESSONSET#LOADBUDGET";
const loadBudgetKey = (workspaceId: string, project: string) => ({ pk: teamRecordPk(workspaceId, project), sk: LOAD_BUDGET_SK });

/**
 * The project's own load budget (how many lessons and how many bytes a stage may be told), within the caps. Stored under `LESSONSET#`, which a project erase and a company erase wipe; it holds no person.
 * A value outside the caps is refused here and ignored by `resolveLoadBudget` if one is ever found stored. Returns whether the value was stored.
 */
export async function writeLoadBudget(store: DocumentStore, scope: { workspaceId: string; project: string }, budget: LoadBudgetSetting, at: number): Promise<boolean> {
  const caps = { lessons: LEARNED_CONTEXT_MAX_LESSONS, bytes: LEARNED_CONTEXT_MAX_BYTES };
  const valid = (value: number | undefined, min: number, max: number): boolean => value === undefined || (Number.isInteger(value) && value >= min && value <= max);
  if (!valid(budget.lessons, LOAD_BUDGET_MIN.lessons, caps.lessons) || !valid(budget.bytes, LOAD_BUDGET_MIN.bytes, caps.bytes)) return false;
  await store.put({
    item: { ...loadBudgetKey(scope.workspaceId, scope.project), entityType: "LESSON_LOAD_BUDGET", ...(budget.lessons === undefined ? {} : { lessons: budget.lessons }), ...(budget.bytes === undefined ? {} : { bytes: budget.bytes }), updatedAt: at },
  });
  return true;
}

/**
 * The learning settings reader over the store: the project's mode and the company's lock (the `MODE` and `MODE_LOCK` items), the project's tier-0 setting and the company floor. A mode that is stored but not
 * valid is passed on as it is, so `resolveLearning` turns it into Off; an absent project mode is the default. Any read that fails throws, and `resolveLearning` then fails closed.
 */
export function documentLearningSettings(store: DocumentStore, settings: Tier0SettingsStore = new DocumentTier0Settings(store)): LearningSettingsReader {
  const mode = async (key: { pk: string; sk: string }): Promise<{ present: false } | { present: true; value: Mode }> => {
    const item = await store.get(key);
    if (item === undefined) return { present: false };
    return { present: true, value: (typeof item["mode"] === "string" ? MODE_NAMES[item["mode"]] ?? (item["mode"] as never) : ("invalid" as never)) };
  };
  const presets = new DocumentPresetStore(store);
  // (A stored "auto" is read as "one" while automatic go-live is off: that is `resolveLearning`'s gate, which every consumer goes through.)
  return {
    async read(workspaceId, project) {
      const org = workspaceId;
      const [own, lock, tier0, floor, preset, companyPreset, budget] = await Promise.all([
        mode(learningModeKey(org, project)), mode(learningModeLockKey(org)),
        settings.read({ kind: "project", workspaceId, project }), settings.read({ kind: "company", workspaceId }),
        presets.read({ kind: "project", workspaceId, project }).catch(() => "invalid" as never), presets.read({ kind: "company", workspaceId }).catch(() => "invalid" as never),
        store.get(loadBudgetKey(workspaceId, project)),
      ]);
      const loadBudget: LoadBudgetSetting | undefined = budget?.["entityType"] !== "LESSON_LOAD_BUDGET" ? undefined : {
        ...(typeof budget["lessons"] === "number" ? { lessons: budget["lessons"] } : {}), ...(typeof budget["bytes"] === "number" ? { bytes: budget["bytes"] } : {}),
      };
      return {
        mode: own.present ? own.value : DEFAULT_PROJECT_MODE,
        ...(lock.present ? { companyLock: lock.value } : {}),
        ...(tier0 === undefined ? {} : { tier0Approval: tier0 }),
        ...(floor === undefined ? {} : { companyApproval: { tier0: floor } }),
        // A preset that is stored but not valid is passed on as it is, so `resolveLearning` turns it into Off.
        ...(preset === undefined ? {} : { preset }), ...(companyPreset === undefined ? {} : { companyPreset }),
        ...(loadBudget === undefined ? {} : { loadBudget }),
      };
    },
  };
}

/** Writes the project's learning mode (`Off`, `Collect`, `Suggest`, `On`) on the `MODE` item the reader above reads. The owner's own choice; the audit event is the caller's. */
export async function writeLearningMode(store: DocumentStore, scope: { workspaceId: string; project: string }, mode: Mode, at: number): Promise<void> {
  await store.put({ item: { ...learningModeKey(scope.workspaceId, scope.project), entityType: "LESSON_MODE", mode: mode.toLowerCase(), updatedAt: at } });
}

const LOCAL_TOOLS_PROJECT_SK = "LESSONSET#LOCALTOOLS";
const LOCAL_TOOLS_COMPANY_SK = "LESSONSET#COMPANYSTAY";
/**
 * Lessons for local coding tools (decision 46b), read now on every call and never cached: the project's own "local coding tools can fetch lessons" choice and the company's "lessons stay in Rovara" switch, on the items a hosted
 * install keeps them on. A stored value that is not a boolean is not "unset": the read throws and the caller refuses.
 */
export class DocumentLocalToolsSettings implements LocalToolsSettingsStore {
  constructor(private readonly store: DocumentStore) {}
  private company(workspaceId: string): Promise<Item | undefined> { return this.store.get({ pk: teamRecordPk(workspaceId, undefined), sk: LOCAL_TOOLS_COMPANY_SK }); }
  private static stays(company: Item | undefined): boolean {
    if (company !== undefined && typeof company["stays"] !== "boolean") throw new Error("the stored lessons-stay-in-Rovara setting is not valid");
    return company === undefined ? false : company["stays"] as boolean;
  }
  async read(workspaceId: string, project: string): Promise<LocalToolsSettings> {
    const [own, company] = await Promise.all([this.store.get({ pk: teamRecordPk(workspaceId, project), sk: LOCAL_TOOLS_PROJECT_SK }), this.company(workspaceId)]);
    if (own !== undefined && typeof own["enabled"] !== "boolean") throw new Error("the stored local-tools setting is not valid");
    return { ...(own === undefined ? {} : { projectOn: own["enabled"] as boolean }), companyStays: DocumentLocalToolsSettings.stays(company) };
  }
  async readCompany(workspaceId: string): Promise<boolean> { return DocumentLocalToolsSettings.stays(await this.company(workspaceId)); }
  // The items name no person (the audit sink has the actor); the project erase and the company erase already wipe the `LESSONSET` prefix.
  async setProject(workspaceId: string, project: string, enabled: boolean, at: number): Promise<void> {
    await this.store.put({ item: { pk: teamRecordPk(workspaceId, project), sk: LOCAL_TOOLS_PROJECT_SK, entityType: "LESSON_SETTINGS", enabled, updatedAt: at } });
  }
  async setCompany(workspaceId: string, stays: boolean, at: number): Promise<void> {
    await this.store.put({ item: { pk: teamRecordPk(workspaceId, undefined), sk: LOCAL_TOOLS_COMPANY_SK, entityType: "LESSON_SETTINGS", stays, updatedAt: at } });
  }
}
