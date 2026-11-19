// The custom agent store on the document store: an agent's META (its name, owner, status and counters), its DRAFT, immutable numbered VERSION rows, the company's directory and the row that keeps a name unique.
// The keys are the shared layout, unchanged. Every multi-row write is one transaction, so a refused write leaves nothing behind. A published version holds the agent's own layer (its overlay and the base it builds
// on, pinned to a version); what it RUNS is `resolveAgent`: the layers applied base first, down to a built-in release or the empty recipe.
//
// Left to the hosted product (it needs companies, members or money): sharing, owner budgets, the agent's own monthly budget, the maintainer who answers for a project's agent, the skill registry and a step's
// model-approval proof. On a laptop the owner owns every agent.
import { createHash } from "node:crypto";
import {
  AGENT_DESCRIPTION_MAX, AGENT_NAME_MAX, BaseRefSchema, EMPTY_RECIPE, RecipeOverlaySchema, agentDirectoryKey, agentKey, agentNameKey, agentVersionSk, applyOverlay, builtinDefaultPin, builtinRecipe, canonicalJson, isBuiltinAgentId,
  newPrefixedId, overlayProblems, queryAll, recipeProblems, when,
  type AgentId, type AuditSink, type BaseRef, type OrgId, type RecipeLayer, type RecipeOverlay, type RecipeProblem, type ResolvedRecipe,
} from "@agentx/contracts";
import { coded, commit, iso, overwriteRow, putRow, strip, updateRow, type Item, type RequestMark, type Table } from "../automation/kit.js";

/** Agents can build on at most this many custom layers over a built-in. */
export const MAX_CUSTOM_LAYERS = 3;

export interface AgentRecord {
  orgId: OrgId;
  agentId: AgentId;
  name: string;
  description: string;
  /** The person who owns the agent. On a laptop, the owner. */
  owner: { kind: "member"; developerId: string };
  currentVersion?: number;
  latestVersion: number;
  draftRevision: number;
  status: "active" | "archived";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDraft { overlay: RecipeOverlay; extends?: BaseRef; revision: number; updatedBy: string; updatedAt: string }

export interface AgentVersion {
  version: number;
  overlay: RecipeOverlay;
  extends?: BaseRef;
  name: string;
  description: string;
  /** SHA-256 of the resolved recipe's canonical JSON at publish time. */
  digest: string;
  publishedBy: string;
  publishedAt: string;
  note?: string;
}

export interface AgentStoreInput extends Table {
  audit: AuditSink;
  companyId: string;
  newId?: () => AgentId;
}

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const notFound = () => coded("NOT_FOUND", "no agent has that ID");
const stale = () => coded("CHANGE_STALE", "Someone else changed this agent just now. Reload it and make your change again.");
const nameTaken = (name: string) => coded("CONFIG_INVALID", `name: another agent is called ${name}`);

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || [...trimmed].length > AGENT_NAME_MAX || CONTROL_OR_FORMAT.test(trimmed)) throw coded("CONFIG_INVALID", `name: 1 to ${String(AGENT_NAME_MAX)} characters, no control characters`);
  return trimmed;
}
function cleanDescription(text: string): string {
  if ([...text].length > AGENT_DESCRIPTION_MAX || CONTROL_OR_FORMAT.test(text.replace(/[\n\t]/gu, " "))) throw coded("CONFIG_INVALID", `description: at most ${String(AGENT_DESCRIPTION_MAX)} characters`);
  return text;
}
const parseOverlay = (value: unknown): RecipeOverlay => {
  const parsed = RecipeOverlaySchema.safeParse(value);
  if (!parsed.success) throw coded("CONFIG_INVALID", `overlay.${parsed.error.issues[0]?.path.join(".") ?? ""}: ${parsed.error.issues[0]?.message ?? "is not valid"}`);
  return parsed.data;
};
const parseBase = (value: unknown): BaseRef | undefined => {
  if (value === undefined) return undefined;
  const parsed = BaseRefSchema.safeParse(value);
  if (!parsed.success) throw coded("CONFIG_INVALID", "extends: an agent and one of its published versions");
  return parsed.data;
};

export class AgentStore {
  private readonly newId: () => AgentId;
  constructor(private readonly input: AgentStoreInput) {
    this.newId = input.newId ?? (() => newPrefixedId("agt"));
  }

  get table(): Table { return this.input; }

  async get(orgId: OrgId, agentId: AgentId): Promise<AgentRecord | undefined> {
    const item = await this.input.store.get(agentKey(orgId, agentId, "META"));
    return item === undefined || item["orgId"] !== orgId ? undefined : (strip(item as Item) as unknown as AgentRecord);
  }

  async getDraft(orgId: OrgId, agentId: AgentId): Promise<AgentDraft | undefined> {
    const item = await this.input.store.get(agentKey(orgId, agentId, "DRAFT"));
    return item === undefined ? undefined : (strip(item as Item) as unknown as AgentDraft);
  }

  async getVersion(orgId: OrgId, agentId: AgentId, version: number): Promise<AgentVersion | undefined> {
    const item = await this.input.store.get(agentKey(orgId, agentId, agentVersionSk(version)));
    return item === undefined ? undefined : (strip(item as Item) as unknown as AgentVersion);
  }

  async list(orgId: OrgId): Promise<AgentRecord[]> {
    const directory = await queryAll(this.input.store, { pk: agentDirectoryKey(orgId, "agt_x").pk });
    const records = await Promise.all(directory.map((row) => this.get(orgId, String(row["sk"]))));
    return records.filter((record): record is AgentRecord => record !== undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.agentId.localeCompare(b.agentId));
  }

  /** Makes a new agent: its META, its DRAFT, its directory row and its name, in one transaction. */
  async create(input: { orgId: OrgId; name: string; description?: string; by: string; overlay?: unknown; extends?: unknown; request?: RequestMark }): Promise<AgentRecord> {
    const name = cleanName(input.name);
    const now = iso(this.input);
    const agentId = this.newId();
    const record: AgentRecord = {
      orgId: input.orgId, agentId, name, description: cleanDescription(input.description ?? ""), owner: { kind: "member", developerId: input.by },
      latestVersion: 0, draftRevision: 1, status: "active", createdBy: input.by, createdAt: now, updatedAt: now,
    };
    const base = parseBase(input.extends);
    const draft = { overlay: parseOverlay(input.overlay ?? {}), ...(base === undefined ? {} : { extends: base }), revision: 1, updatedBy: input.by, updatedAt: now };
    await commit(this.input, [
      putRow(agentKey(input.orgId, agentId, "META"), "AGENT", record as unknown as Item),
      putRow(agentKey(input.orgId, agentId, "DRAFT"), "AGENT_DRAFT", draft),
      putRow(agentDirectoryKey(input.orgId, agentId), "AGENT_DIRECTORY", { orgId: input.orgId, agentId }),
      putRow(agentNameKey(input.orgId, name), "AGENT_NAME", { orgId: input.orgId, agentId }),
      ...this.input.audit.stage({ eventId: `evt_${createHash("sha256").update(`agent.created\0${agentId}`).digest("hex").slice(0, 40)}`, companyId: this.input.companyId, at: now, actor: { type: "person", id: input.by }, action: "agent.created", subject: { type: "agent", id: agentId } }),
    ], (failed) => (failed.has(3) ? nameTaken(name) : undefined), input.request, record);
    return record;
  }

  /** Saves the draft, only while it is at `expectedRevision` (a lost race is a conflict, never an overwrite). */
  async saveDraft(input: { orgId: OrgId; agentId: AgentId; overlay: unknown; extends?: unknown; expectedRevision: number; by: string }): Promise<AgentDraft> {
    const record = await this.get(input.orgId, input.agentId);
    if (record === undefined) throw notFound();
    if (record.status === "archived") throw coded("AGENT_UNAVAILABLE", `${record.name} is archived`);
    const base = parseBase(input.extends);
    const now = iso(this.input);
    const draft: AgentDraft = { overlay: parseOverlay(input.overlay), ...(base === undefined ? {} : { extends: base }), revision: input.expectedRevision + 1, updatedBy: input.by, updatedAt: now };
    await commit(this.input, [
      { ...overwriteRow(agentKey(input.orgId, input.agentId, "DRAFT"), "AGENT_DRAFT", draft as unknown as Item), condition: when.eq("revision", input.expectedRevision) },
      updateRow(agentKey(input.orgId, input.agentId, "META"), { set: { draftRevision: draft.revision, updatedAt: now }, condition: when.eq("draftRevision", input.expectedRevision) }),
    ], () => stale());
    return draft;
  }

  /**
   * Publishes the draft as the next version. `problems` is what the caller found wrong with the recipe the draft resolves to (guardrails, project-independent checks): a version is written only when there are none, and
   * only while the draft is still at `expectedDraftRevision`. A published version is never changed.
   */
  async publish(input: { orgId: OrgId; agentId: AgentId; expectedDraftRevision: number; by: string; note?: string; recipe: ResolvedRecipe; problems: readonly RecipeProblem[] }): Promise<AgentVersion> {
    if (input.problems.length > 0) throw coded("CONFIG_INVALID", input.problems.map((problem) => `${problem.path}: ${problem.message}`).join("; "));
    const record = await this.get(input.orgId, input.agentId);
    if (record === undefined) throw notFound();
    if (record.status === "archived") throw coded("AGENT_UNAVAILABLE", `${record.name} is archived`);
    const draft = await this.getDraft(input.orgId, input.agentId);
    if (draft === undefined || draft.revision !== input.expectedDraftRevision) throw stale();
    const now = iso(this.input);
    const version: AgentVersion = {
      version: record.latestVersion + 1, overlay: draft.overlay, ...(draft.extends === undefined ? {} : { extends: draft.extends }), name: record.name, description: record.description,
      digest: createHash("sha256").update(canonicalJson(input.recipe), "utf8").digest("hex"), publishedBy: input.by, publishedAt: now, ...(input.note === undefined ? {} : { note: input.note }),
    };
    await commit(this.input, [
      putRow(agentKey(input.orgId, input.agentId, agentVersionSk(version.version)), "AGENT_VERSION", version as unknown as Item),
      updateRow(agentKey(input.orgId, input.agentId, "META"), { set: { currentVersion: version.version, latestVersion: version.version, updatedAt: now }, condition: when.and(when.eq("latestVersion", record.latestVersion), when.eq("status", "active"), when.eq("draftRevision", record.draftRevision)) }),
      { kind: "check", key: agentKey(input.orgId, input.agentId, "DRAFT"), condition: when.eq("revision", input.expectedDraftRevision) },
      ...this.input.audit.stage({ eventId: `evt_${createHash("sha256").update(`agent.published\0${input.agentId}\0${String(version.version)}`).digest("hex").slice(0, 40)}`, companyId: this.input.companyId, at: now, actor: { type: "person", id: input.by }, action: "agent.published", subject: { type: "agent", id: input.agentId }, details: { version: version.version, digest: version.digest } }),
    ], () => stale());
    return version;
  }

  /** Archives an agent (it takes no new work; versions that pinned it keep running at their pin until a chain or trigger that uses it is checked again). */
  async setArchived(orgId: OrgId, agentId: AgentId, archived: boolean, by: string): Promise<AgentRecord> {
    const record = await this.get(orgId, agentId);
    if (record === undefined) throw notFound();
    const status = archived ? "archived" : "active";
    if (record.status === status) return record;
    const now = iso(this.input);
    await commit(this.input, [
      updateRow(agentKey(orgId, agentId, "META"), { set: { status, updatedAt: now }, condition: when.eq("status", record.status) }),
      ...this.input.audit.stage({ eventId: `evt_${createHash("sha256").update(`agent.${status}\0${agentId}\0${now}`).digest("hex").slice(0, 40)}`, companyId: this.input.companyId, at: now, actor: { type: "person", id: by }, action: archived ? "agent.archived" : "agent.unarchived", subject: { type: "agent", id: agentId } }),
    ], () => stale());
    return { ...record, status, updatedAt: now };
  }
}

/** The recipe an agent runs at a version: its own layer on the layers it builds on, each at the version it pinned, down to a built-in release or the empty recipe. A built-in resolves at the release this install ships. */
export async function resolveAgent(store: AgentStore, orgId: OrgId, agentId: AgentId, version: number | "current" | "draft", options: { problems?: RecipeProblem[]; draft?: AgentDraft } = {}): Promise<ResolvedRecipe> {
  async function layer(id: AgentId, wanted: number | "current" | "draft", trail: Array<{ agentId: AgentId; name: string }>): Promise<ResolvedRecipe> {
    if (isBuiltinAgentId(id)) return builtinRecipe(id, typeof wanted === "number" ? wanted : builtinDefaultPin(id));
    if (trail.some((above) => above.agentId === id)) throw coded("CONFIG_INVALID", "agents can't build on each other in a loop");
    if (trail.length >= MAX_CUSTOM_LAYERS) throw coded("CONFIG_INVALID", `agents can build on at most ${String(MAX_CUSTOM_LAYERS)} layers`);
    const agent = await store.get(orgId, id);
    if (agent === undefined) throw notFound();
    const child = trail.at(-1);
    if (child !== undefined && agent.status === "archived") throw coded("AGENT_UNAVAILABLE", `${child.name} builds on ${agent.name}, which is archived. Pick another base.`);
    let content: { overlay: RecipeOverlay; extends?: BaseRef; name: string; version: number | "draft" };
    if (wanted === "draft") {
      const draft = trail.length === 0 && options.draft !== undefined ? options.draft : await store.getDraft(orgId, id);
      if (draft === undefined) throw notFound();
      content = { overlay: draft.overlay, ...(draft.extends === undefined ? {} : { extends: draft.extends }), name: agent.name, version: "draft" };
    } else {
      const number = wanted === "current" ? agent.currentVersion : wanted;
      if (number === undefined) throw coded("NOT_FOUND", `${agent.name} has no published version`);
      const published = await store.getVersion(orgId, id, number);
      if (published === undefined) throw coded("NOT_FOUND", `${agent.name} has no version ${String(number)}`);
      content = { overlay: published.overlay, ...(published.extends === undefined ? {} : { extends: published.extends }), name: published.name, version: number };
    }
    const base = content.extends === undefined ? EMPTY_RECIPE : await layer(content.extends.agentId, content.extends.version, [...trail, { agentId: id, name: agent.name }]);
    const problems = overlayProblems(base, content.overlay);
    if (problems.length > 0) { if (options.problems) options.problems.push(...problems); else throw problemsError(problems); }
    // A skill registry is not on this install: an overlay that adds a skill is refused at publish (see `skillProblems`).
    const recipeLayer: RecipeLayer = { agentId: id, name: content.name, version: content.version, builtin: false };
    return applyOverlay(base, content.overlay, recipeLayer);
  }
  const recipe = await layer(agentId, version, []);
  const problems = recipeProblems(recipe);
  if (problems.length > 0) { if (options.problems) options.problems.push(...problems); else throw problemsError(problems); }
  return recipe;
}

const problemsError = (problems: readonly RecipeProblem[]) => coded("CONFIG_INVALID", problems.map((problem) => `${problem.path}: ${problem.message}`).join("; "));

/** The skills a recipe asks for, as problems: this install has no skill registry, so a recipe that adds one is refused rather than run without it. */
export function skillProblems(recipe: ResolvedRecipe): RecipeProblem[] {
  return recipe.skills.length === 0 ? [] : [{ path: "skills", message: "skills are not on this install yet; take them out of the agent" }];
}
