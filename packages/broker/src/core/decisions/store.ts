// What the card routes remember. Two things only: that a person opened a card's evidence (bound to the digest of what they saw, so the server can refuse a medium-risk approve that skipped it),
// and the decision itself (one row per request id, which is also the history behind "approvals later reversed"). The interface is small so a test (or another table) can stand in.
// The rows keep the hosted product's key layout (`DECISION#<org>#<developer>`), so one set of rows serves both; the storage is the document store port.
import { INDEX_EXPIRY_ATTRIBUTE, when, type DecisionKind, type DecisionRisk, type DecisionTabId, type DocumentStore, type StoredDocument } from "@agentx/contracts";

export interface DecisionWho { orgId: string; developerId: string }
export interface EvidenceOpenedKey extends DecisionWho { cardId: string; tab?: DecisionTabId | undefined }
export interface DecisionRecord extends DecisionWho {
  cardId: string;
  kind: DecisionKind;
  risk: DecisionRisk;
  outcome: "approved" | "rejected";
  reason?: string | undefined;
  tab?: DecisionTabId | undefined;
  requestId: string;
  createdAt: string;
  openedAt?: string | undefined;
  decidedAt: string;
}

export interface DecisionStore {
  /** Records that the person opened the evidence of what the digest names. Again with the same key replaces the earlier record. */
  recordEvidenceOpened(key: EvidenceOpenedKey, digest: string, at: string): Promise<void>;
  /** When the person opened exactly this digest, or undefined (never opened, opened another version, or expired). */
  evidenceOpenedAt(key: EvidenceOpenedKey, digest: string): Promise<string | undefined>;
  /** Records a decision once per request id; a repeat is a no-op. */
  recordDecision(record: DecisionRecord): Promise<void>;
  /** The decision this person recorded under this request id, so a retry after success gets the earlier answer. */
  findDecision(who: DecisionWho, requestId: string): Promise<DecisionRecord | undefined>;
}

/** An opened-evidence record counts for this long. */
export const DECISION_EVIDENCE_OPEN_TTL_MS = 3 * 86_400_000;
const DECISION_RECORD_TTL_DAYS = 400;

export function inMemoryDecisionStore(now: () => number = Date.now): DecisionStore & { decisions: DecisionRecord[] } {
  const opened = new Map<string, { digest: string; at: string }>();
  const decisions: DecisionRecord[] = [];
  const keyOf = (key: EvidenceOpenedKey) => `${key.orgId}|${key.developerId}|${key.cardId}|${key.tab ?? "-"}`;
  return {
    decisions,
    async recordEvidenceOpened(key, digest, at) { opened.set(keyOf(key), { digest, at }); },
    async evidenceOpenedAt(key, digest) {
      const found = opened.get(keyOf(key));
      return found !== undefined && found.digest === digest && now() - Date.parse(found.at) < DECISION_EVIDENCE_OPEN_TTL_MS ? found.at : undefined;
    },
    async recordDecision(record) { if (!decisions.some((existing) => existing.requestId === record.requestId && existing.developerId === record.developerId)) decisions.push(record); },
    async findDecision(who, requestId) { return decisions.find((existing) => existing.requestId === requestId && existing.developerId === who.developerId && existing.orgId === who.orgId); },
  };
}

export interface DocumentDecisionStoreDependencies {
  store: Pick<DocumentStore, "get" | "put">;
  now: () => number;
}

const partition = (who: DecisionWho) => `DECISION#${who.orgId}#${who.developerId}`;

/** The document-store form. Rows expire by the store's time-to-live attribute (`INDEX_EXPIRY_ATTRIBUTE`, epoch seconds). */
export function documentDecisionStore(deps: DocumentDecisionStoreDependencies): DecisionStore {
  return {
    async recordEvidenceOpened(key, digest, at) {
      const result = await deps.store.put({
        item: { pk: partition(key), sk: `OPENED#${key.cardId}#${key.tab ?? "-"}`, entityType: "DECISION_EVIDENCE_OPENED", orgId: key.orgId, developerId: key.developerId, cardId: key.cardId, digest, openedAt: at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1000) + Math.floor(DECISION_EVIDENCE_OPEN_TTL_MS / 1000) },
      });
      if (!result.applied) throw new Error("evidence-opened record was refused");
    },
    async evidenceOpenedAt(key, digest) {
      const item = await deps.store.get({ pk: partition(key), sk: `OPENED#${key.cardId}#${key.tab ?? "-"}` });
      if (item === undefined || item["digest"] !== digest || typeof item["openedAt"] !== "string") return undefined;
      return deps.now() - Date.parse(item["openedAt"]) < DECISION_EVIDENCE_OPEN_TTL_MS ? item["openedAt"] : undefined;
    },
    async findDecision(who, requestId) {
      const item = await deps.store.get({ pk: partition(who), sk: `DECIDED#${requestId}` });
      if (item === undefined || item["entityType"] !== "DECISION_RECORD") return undefined;
      const text = (key: string) => (typeof item[key] === "string" ? item[key] : undefined);
      const outcome = item["outcome"];
      const kind = text("kind"), risk = text("risk"), cardId = text("cardId"), createdAt = text("createdAt"), decidedAt = text("decidedAt");
      if ((outcome !== "approved" && outcome !== "rejected") || kind === undefined || risk === undefined || cardId === undefined || createdAt === undefined || decidedAt === undefined) return undefined;
      const tab = text("tab");
      const reason = text("reason");
      return { orgId: who.orgId, developerId: who.developerId, cardId, kind: kind as DecisionKind, risk: risk as DecisionRisk, outcome, requestId, createdAt, decidedAt, ...(reason === undefined ? {} : { reason }), ...(tab === "requirements" || tab === "design" ? { tab } : {}) };
    },
    async recordDecision(record) {
      const item: StoredDocument = {
        pk: partition(record), sk: `DECIDED#${record.requestId}`, entityType: "DECISION_RECORD", orgId: record.orgId, developerId: record.developerId, cardId: record.cardId, kind: record.kind, risk: record.risk, outcome: record.outcome,
        ...(record.reason === undefined ? {} : { reason: record.reason }), ...(record.tab === undefined ? {} : { tab: record.tab }), requestId: record.requestId, createdAt: record.createdAt,
        ...(record.openedAt === undefined ? {} : { openedAt: record.openedAt }), decidedAt: record.decidedAt, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1000) + DECISION_RECORD_TTL_DAYS * 86_400,
      };
      // Once per request id: a repeat is a lost condition, which is an ordinary answer and not an error.
      await deps.store.put({ item, condition: when.absent() });
    },
  };
}
