// The owner's per-step model setting on the document store. The row is the hosted product's company policy row, key and attributes unchanged, so a company that moves between Code and the hosted product keeps its
// setting with no data move: in Code the owner IS the company.
//   `ORG#<company>#SETTINGS` / `MODEL_SELECTION_POLICY`   { entityType, orgId, version: 1, revision, rankingVersion: "g3-v1", stepOverrides, updatedAt, updatedBy, reviewDefault? }
// `reviewDefault` is the one attribute Code adds (the hosted product's reader ignores it, and its own writer would drop it): whether a checking step nobody has set (plan check, code review) uses the install's one model
// (`install-model`, what a laptop always did) or the strongest model of a different AI company than the step it checks (`different-company`, the hosted product's rule). A row that does not carry it reads as the install's DEFAULT, which the host passes in
// (`defaultReviewDefault`): `install-model` on a laptop, `different-company` for a host whose rule that is (its rows never carry the attribute). Every write made here records it.
// No row is a virtual default (revision 0); a row that cannot be read is an error, never the default. A write is conditional on the revision it was made against.
import {
  ModelSelectionPolicyResponseSchema, orgSettingsKey, when, type DocumentStore, type JsonValue, type OrgId, type StoredDocument, type TransactItem,
} from "@agentx/contracts";
import type { z } from "zod";

export type ReviewDefault = "install-model" | "different-company";
export const REVIEW_DEFAULTS: readonly ReviewDefault[] = ["install-model", "different-company"];

export type StepOverrides = z.infer<typeof ModelSelectionPolicyResponseSchema>["stepOverrides"];

export interface ModelSelectionPolicy {
  revision: number;
  stepOverrides: StepOverrides;
  reviewDefault: ReviewDefault;
}

export const modelSelectionPolicyKey = (orgId: OrgId) => orgSettingsKey(orgId, "MODEL_SELECTION_POLICY");

export class PolicyUnreadable extends Error {
  constructor() { super("the model setting could not be read"); this.name = "PolicyUnreadable"; }
}

export async function readModelSelectionPolicy(store: Pick<DocumentStore, "get">, orgId: OrgId, defaultReviewDefault: ReviewDefault = "install-model"): Promise<ModelSelectionPolicy> {
  let item: StoredDocument | undefined;
  try { item = await store.get(modelSelectionPolicyKey(orgId)); } catch { throw new PolicyUnreadable(); }
  if (item === undefined) return { revision: 0, stepOverrides: {}, reviewDefault: defaultReviewDefault };
  if (item["orgId"] !== orgId || item["entityType"] !== "MODEL_SELECTION_POLICY") throw new PolicyUnreadable();
  const parsed = ModelSelectionPolicyResponseSchema.safeParse({ version: item["version"], revision: item["revision"], rankingVersion: item["rankingVersion"], stepOverrides: item["stepOverrides"] });
  if (!parsed.success) throw new PolicyUnreadable();
  const stored = item["reviewDefault"];
  const reviewDefault: ReviewDefault = stored === "different-company" || stored === "install-model" ? stored : defaultReviewDefault;
  return { revision: parsed.data.revision, stepOverrides: parsed.data.stepOverrides, reviewDefault };
}

/** The transaction step that writes the next policy, conditional on `seenRevision` (0: no row yet). */
export function policyWrite(input: { orgId: OrgId; seenRevision: number; stepOverrides: StepOverrides; reviewDefault: ReviewDefault; by: string; at: string }): TransactItem {
  const item: StoredDocument = {
    ...modelSelectionPolicyKey(input.orgId), entityType: "MODEL_SELECTION_POLICY", orgId: input.orgId, version: 1, revision: input.seenRevision + 1, rankingVersion: "g3-v1",
    stepOverrides: input.stepOverrides as unknown as JsonValue, updatedAt: input.at, updatedBy: input.by,
    reviewDefault: input.reviewDefault,
  };
  return { kind: "put", item, condition: input.seenRevision === 0 ? when.absent() : when.eq("revision", input.seenRevision) };
}
