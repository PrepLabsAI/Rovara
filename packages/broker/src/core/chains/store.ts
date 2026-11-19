// The chain store on the document store: a chain's META, its DRAFT, immutable numbered versions and the rows that keep its name unique and list it. The keys are the shared layout, unchanged. Every multi-row
// write is one transaction. A published version pins every agent step to a version number; publishing checks again, inside its transaction, that the guardrails are still at the revision the check read.
// Left to the hosted product: shares, the owner's monthly budget total, accountable maintainers.
import { createHash } from "node:crypto";
import {
  AGENT_DESCRIPTION_MAX, AGENT_NAME_MAX, ChainDefinitionSchema, PinnedChainDefinitionSchema, agentGuardrailsKey, canonicalJson, chainDirectoryKey, chainKey, chainNameKey, chainVersionSk, newPrefixedId, queryAll, when,
  type AuditSink, type ChainDefinition, type ChainId, type OrgId, type PinnedChainDefinition,
} from "@agentx/contracts";
import { coded, commit, iso, overwriteRow, putRow, strip, updateRow, type Item, type RequestMark, type Table } from "../automation/kit.js";
import { chainGraphProblems, formatChainProblem } from "./validate.js";

export interface ChainRecord {
  orgId: OrgId;
  chainId: ChainId;
  name: string;
  description: string;
  owner: { kind: "member"; developerId: string };
  currentVersion?: number;
  latestVersion: number;
  draftRevision: number;
  status: "active" | "archived";
  /** Runs that have started and not ended (kept by the runner). */
  openRuns: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChainDraft { definition: ChainDefinition; revision: number; updatedBy: string; updatedAt: string }

export interface ChainVersion { version: number; definition: PinnedChainDefinition; digest: string; publishedBy: string; publishedAt: string; note?: string }

export interface ChainStoreInput extends Table { audit: AuditSink; companyId: string; newId?: () => ChainId }

/** SHA-256 (hex) of a pinned definition's canonical JSON: equal designs have equal digests whatever their key order. */
export const chainDigest = (pinned: PinnedChainDefinition): string => createHash("sha256").update(canonicalJson(pinned), "utf8").digest("hex");

const notFound = () => coded("NOT_FOUND", "no chain has that ID");
const stale = () => coded("CHAIN_REVISION_CONFLICT", "Someone else changed this chain just now. Reload it and make your change again.");
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || [...trimmed].length > AGENT_NAME_MAX || CONTROL_OR_FORMAT.test(trimmed)) throw coded("CONFIG_INVALID", `name: 1 to ${String(AGENT_NAME_MAX)} characters, no control characters`);
  return trimmed;
}
function cleanDescription(text: string): string {
  if ([...text].length > AGENT_DESCRIPTION_MAX || CONTROL_OR_FORMAT.test(text.replace(/[\n\t]/gu, " "))) throw coded("CONFIG_INVALID", `description: at most ${String(AGENT_DESCRIPTION_MAX)} characters`);
  return text;
}
export function parseDefinition(value: unknown): ChainDefinition {
  const parsed = ChainDefinitionSchema.safeParse(value);
  if (!parsed.success) throw coded("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "definition"}: ${parsed.error.issues[0]?.message ?? "is not valid"}`);
  return parsed.data;
}

export class ChainStore {
  private readonly newId: () => ChainId;
  constructor(private readonly input: ChainStoreInput) {
    this.newId = input.newId ?? (() => newPrefixedId("chn"));
  }

  get table(): Table { return this.input; }

  async get(orgId: OrgId, chainId: ChainId): Promise<ChainRecord | undefined> {
    const item = await this.input.store.get(chainKey(orgId, chainId, "META"));
    return item === undefined || item["orgId"] !== orgId ? undefined : (strip(item as Item) as unknown as ChainRecord);
  }

  async getDraft(orgId: OrgId, chainId: ChainId): Promise<ChainDraft | undefined> {
    const item = await this.input.store.get(chainKey(orgId, chainId, "DRAFT"));
    return item === undefined ? undefined : (strip(item as Item) as unknown as ChainDraft);
  }

  async getVersion(orgId: OrgId, chainId: ChainId, version: number): Promise<ChainVersion | undefined> {
    const item = await this.input.store.get(chainKey(orgId, chainId, chainVersionSk(version)));
    if (item === undefined) return undefined;
    const row = strip(item as Item) as unknown as ChainVersion;
    // A version that does not parse as a pinned design is not runnable: it reads as absent.
    return PinnedChainDefinitionSchema.safeParse(row.definition).success ? row : undefined;
  }

  async list(orgId: OrgId): Promise<ChainRecord[]> {
    const directory = await queryAll(this.input.store, { pk: chainDirectoryKey(orgId, "chn_x").pk });
    const records = await Promise.all(directory.map((row) => this.get(orgId, String(row["sk"]))));
    return records.filter((record): record is ChainRecord => record !== undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.chainId.localeCompare(b.chainId));
  }

  async create(input: { orgId: OrgId; name: string; description?: string; by: string; definition: unknown; request?: RequestMark }): Promise<ChainRecord> {
    const name = cleanName(input.name);
    const definition = parseDefinition(input.definition);
    const now = iso(this.input);
    const chainId = this.newId();
    const record: ChainRecord = { orgId: input.orgId, chainId, name, description: cleanDescription(input.description ?? ""), owner: { kind: "member", developerId: input.by }, latestVersion: 0, draftRevision: 1, status: "active", openRuns: 0, createdBy: input.by, createdAt: now, updatedAt: now };
    const draft: ChainDraft = { definition, revision: 1, updatedBy: input.by, updatedAt: now };
    await commit(this.input, [
      putRow(chainKey(input.orgId, chainId, "META"), "CHAIN", record as unknown as Item),
      putRow(chainKey(input.orgId, chainId, "DRAFT"), "CHAIN_DRAFT", draft as unknown as Item),
      putRow(chainDirectoryKey(input.orgId, chainId), "CHAIN_DIRECTORY", { orgId: input.orgId, chainId }),
      putRow(chainNameKey(input.orgId, name), "CHAIN_NAME", { orgId: input.orgId, chainId }),
      ...this.input.audit.stage({ eventId: `evt_${createHash("sha256").update(`chain.created\0${chainId}`).digest("hex").slice(0, 40)}`, companyId: this.input.companyId, at: now, actor: { type: "person", id: input.by }, action: "chain.created", subject: { type: "chain", id: chainId } }),
    ], (failed) => (failed.has(3) ? coded("CONFIG_INVALID", `name: another chain is called ${name}`) : undefined), input.request, record);
    return record;
  }

  async saveDraft(input: { orgId: OrgId; chainId: ChainId; definition: unknown; expectedRevision: number; by: string }): Promise<ChainDraft> {
    const record = await this.get(input.orgId, input.chainId);
    if (record === undefined) throw notFound();
    if (record.status === "archived") throw coded("CHAIN_UNAVAILABLE", `${record.name} is archived`);
    const now = iso(this.input);
    const draft: ChainDraft = { definition: parseDefinition(input.definition), revision: input.expectedRevision + 1, updatedBy: input.by, updatedAt: now };
    await commit(this.input, [
      { ...overwriteRow(chainKey(input.orgId, input.chainId, "DRAFT"), "CHAIN_DRAFT", draft as unknown as Item), condition: when.eq("revision", input.expectedRevision) },
      updateRow(chainKey(input.orgId, input.chainId, "META"), { set: { draftRevision: draft.revision, updatedAt: now }, condition: when.eq("draftRevision", input.expectedRevision) }),
    ], () => stale());
    return draft;
  }

  /**
   * Publishes the draft as the next version. The caller has validated it (`validateChainForPublish`) and passes the pinned design, the problems and the revision of the guardrails it read; a version is written only
   * when there are no problems, the draft is still at `expectedDraftRevision` and the guardrails are still at `guardrailsRevision`. A published version is never changed.
   */
  async publish(input: { orgId: OrgId; chainId: ChainId; expectedDraftRevision: number; by: string; note?: string; pinned: PinnedChainDefinition; problems: ReadonlyArray<{ path: string; message: string }>; guardrailsRevision: number }): Promise<ChainVersion> {
    if (input.problems.length > 0) throw coded("CONFIG_INVALID", input.problems.map(formatChainProblem).join("; "));
    const pinned = PinnedChainDefinitionSchema.parse(input.pinned);
    const record = await this.get(input.orgId, input.chainId);
    if (record === undefined) throw notFound();
    if (record.status === "archived") throw coded("CHAIN_UNAVAILABLE", `${record.name} is archived`);
    const now = iso(this.input);
    const version: ChainVersion = { version: record.latestVersion + 1, definition: pinned, digest: chainDigest(pinned), publishedBy: input.by, publishedAt: now, ...(input.note === undefined ? {} : { note: input.note }) };
    const guardrails = agentGuardrailsKey(input.orgId);
    await commit(this.input, [
      putRow(chainKey(input.orgId, input.chainId, chainVersionSk(version.version)), "CHAIN_VERSION", version as unknown as Item),
      updateRow(chainKey(input.orgId, input.chainId, "META"), { set: { currentVersion: version.version, latestVersion: version.version, updatedAt: now }, condition: when.and(when.eq("latestVersion", record.latestVersion), when.eq("status", "active"), when.eq("draftRevision", record.draftRevision)) }),
      { kind: "check", key: chainKey(input.orgId, input.chainId, "DRAFT"), condition: when.eq("revision", input.expectedDraftRevision) },
      { kind: "check", key: guardrails, condition: input.guardrailsRevision === 0 ? when.absent() : when.eq("revision", input.guardrailsRevision) },
      ...this.input.audit.stage({ eventId: `evt_${createHash("sha256").update(`chain.published\0${input.chainId}\0${String(version.version)}`).digest("hex").slice(0, 40)}`, companyId: this.input.companyId, at: now, actor: { type: "person", id: input.by }, action: "chain.published", subject: { type: "chain", id: input.chainId }, details: { version: version.version, digest: version.digest } }),
    ], () => stale());
    return version;
  }

  async setArchived(orgId: OrgId, chainId: ChainId, archived: boolean, by: string): Promise<ChainRecord> {
    const record = await this.get(orgId, chainId);
    if (record === undefined) throw notFound();
    const status = archived ? "archived" : "active";
    if (record.status === status) return record;
    const now = iso(this.input);
    await commit(this.input, [
      updateRow(chainKey(orgId, chainId, "META"), { set: { status, updatedAt: now }, condition: when.eq("status", record.status) }),
      ...this.input.audit.stage({ eventId: `evt_${createHash("sha256").update(`chain.${status}\0${chainId}\0${now}`).digest("hex").slice(0, 40)}`, companyId: this.input.companyId, at: now, actor: { type: "person", id: by }, action: archived ? "chain.archived" : "chain.unarchived", subject: { type: "chain", id: chainId } }),
    ], () => stale());
    return { ...record, status, updatedAt: now };
  }
}

/** The graph problems of a draft, without pinning anything (what a page shows while the owner edits). */
export const draftProblems = (definition: ChainDefinition) => chainGraphProblems(definition).map(formatChainProblem);
