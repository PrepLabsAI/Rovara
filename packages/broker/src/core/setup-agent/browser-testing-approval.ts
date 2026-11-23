// Browser testing: what an APPROVAL writes, in the decision's own transaction (apply.ts `createSetupProposalSubject`, for a SETUP_APPLY row that carries `browserTesting`).
//
// Approving makes the candidate the project's latest revision (apply.ts does that) and, here, in the same transaction:
//   - the candidate's row becomes the one the planning seam reads: `setupApproval` (the stored proposal, its digest and the candidate digest, bound to what the approver saw), the registrant and the runtime
//     binding of the base revision (a core-made project's candidate holds neither until now);
//   - the project's test accounts, written under the NAMED company (the old route wrote them under another one: that was the bug this replaces), one definition per kind of user the approved contract declares;
//   - who approved and when (for the page), and the removal of the draft the check was made from, but only while the draft is still the one the check used.
// Everything is read again here from the stored objects, never from the draft: what is approved is what was checked, whatever the draft says now. A candidate whose stored proposal does not match the
// policy it carries, or that cannot be read whole, is refused (`SubjectRefusal`).
//
// WHO decides is not decided here for the person: `mayDecide` is the host's live read of a COMPANY OWNER or ADMIN (never a project maintainer), asked for both answers.
import {
  E2EPolicySchema, Ec2RuntimeBindingSchema, canonicalJson, change, projectPk, projectRevisionKey, when,
  type DocumentStore, type ObjectStorage, type OrgId, type Principal, type TransactItem, type UpdateOp,
} from "@agentx/contracts";
import { E2EAccountRegistryError } from "../../e2e/application-account-registry.js";
import { SubjectRefusal } from "../decisions/approval-gate.js";
import { planSetupAccountWrites } from "../e2e/account-registry.js";
import { BROWSER_USER_KINDS_MAX, BROWSER_TESTING_WORDS, BrowserCandidateFactsSchema, browserDraftKey } from "./browser-testing-state.js";
import { readApproved, type BrowserRepository } from "./browser-testing-proposal.js";

export const browserApprovalKey = (orgId: OrgId, project: string) => ({ pk: projectPk(orgId, project), sk: "E2E_BROWSER_APPROVAL" });

/** What the approval adds to its transaction: the candidate row's attributes (merged into any other update of that row: a transaction names a key once) and the other steps. */
export interface BrowserApprovalWrites { candidateOps: UpdateOp[]; items: TransactItem[] }

export interface BrowserApprovalSteps {
  /** Whether this verified approver is a live company owner or admin of this company, read now. A throw or anything but `true` is a refusal. */
  mayDecide(approver: Principal, input: { project: string }): Promise<boolean>;
  /** The writes of an approval of this candidate, or a `SubjectRefusal` when it cannot be approved as it stands. */
  itemsFor(row: { project: string; baseRevision: number; candidateRevision: number; browserTesting?: unknown }, approver: Principal, at: string): Promise<BrowserApprovalWrites>;
}

const refuse = (detail: string): SubjectRefusal => new SubjectRefusal("invalid", detail);
/** The most account rows one approval writes (two per kind of user), beside the decision's own steps and the mirror. */
const ACCOUNT_ITEMS_MAX = BROWSER_USER_KINDS_MAX * 2 + 2;

export function createBrowserApprovalSteps(options: {
  store: Pick<DocumentStore, "get" | "query">; companyId: OrgId; objects: ObjectStorage;
  /** The approver's live company role, read now. Undefined: not a live member of this company. */
  standing: (personId: string, project: string) => Promise<{ companyRole: "owner" | "admin" | "member" } | undefined>;
}): BrowserApprovalSteps {
  const { store, companyId, objects } = options;
  return {
    async mayDecide(approver, input) {
      if (approver.companyId !== companyId) return false;
      const standing = await options.standing(approver.personId, input.project);
      return standing?.companyRole === "owner" || standing?.companyRole === "admin";
    },
    async itemsFor(row, approver, at) {
      const facts = BrowserCandidateFactsSchema.safeParse(row.browserTesting);
      if (!facts.success) throw refuse(BROWSER_TESTING_WORDS.stale);
      const [base, candidate] = await Promise.all([store.get(projectRevisionKey(companyId, row.project, row.baseRevision)), store.get(projectRevisionKey(companyId, row.project, row.candidateRevision))]);
      const binding = Ec2RuntimeBindingSchema.safeParse(base?.["runtimeBinding"]);
      const registeredBy = base?.["registeredBy"];
      if (base === undefined || candidate === undefined || !binding.success || typeof registeredBy !== "string" || registeredBy === "") throw refuse(BROWSER_TESTING_WORDS.sandboxUnavailable);
      const definition = candidate["definition"] as { repositories?: Array<{ name?: unknown; url?: unknown; defaultBranch?: unknown }>; e2e?: unknown } | undefined;
      const repository = definition?.repositories?.length === 1 ? definition.repositories[0] : undefined;
      const policy = E2EPolicySchema.safeParse(definition?.e2e);
      if (repository === undefined || typeof repository.name !== "string" || typeof repository.url !== "string" || !policy.success) throw refuse(BROWSER_TESTING_WORDS.stale);
      const repo: BrowserRepository = { name: repository.name, url: repository.url, defaultBranch: typeof repository.defaultBranch === "string" ? repository.defaultBranch : "main" };
      // The approver's own stored proposal, read again and re-verified: the policy inside it must be exactly the one the candidate carries.
      const approved = await readApproved(objects, { proposalRef: facts.data.proposalRef, proposalSha256: facts.data.proposalSha256, candidateDigest: facts.data.candidateDigest }, repo, registeredBy);
      if (approved === undefined || canonicalJson(approved.policy) !== canonicalJson(policy.data)) throw refuse(BROWSER_TESTING_WORDS.stale);
      let accounts: Awaited<ReturnType<typeof planSetupAccountWrites>>;
      try {
        accounts = await planSetupAccountWrites({ store: store as DocumentStore }, { orgId: companyId, projectId: row.project, snapshot: approved.snapshot,
          setup: { approvedAt: at, proposalSha256: facts.data.proposalSha256 }, now: Date.parse(at) });
      } catch (error) {
        if (error instanceof E2EAccountRegistryError) throw refuse(BROWSER_TESTING_WORDS.stale);
        throw error;
      }
      if (accounts.items.length > ACCOUNT_ITEMS_MAX) throw refuse(BROWSER_TESTING_WORDS.tooManyKinds);
      return {
        candidateOps: [
          change.set("setupApproval", { proposalRef: facts.data.proposalRef, proposalSha256: facts.data.proposalSha256, candidateDigest: facts.data.candidateDigest, decision: "approve" }),
          change.set("runtimeBinding", binding.data), change.set("registeredBy", registeredBy), change.set("registeredAt", at),
        ],
        items: [
          ...accounts.items,
          { kind: "put", item: { ...browserApprovalKey(companyId, row.project), entityType: "E2E_BROWSER_APPROVAL", orgId: companyId, project: row.project, revision: row.candidateRevision,
            proposalSha256: facts.data.proposalSha256, approvedAt: at, approvedBy: approver.personId } },
          { kind: "delete", key: browserDraftKey(companyId, row.project), condition: when.eq("draftRevision", facts.data.draftRevision) },
        ],
      };
    },
  };
}
