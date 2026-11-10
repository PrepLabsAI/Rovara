// Second review: what the core asks of the install that it cannot know itself (nothing here names a provider or a store). Code fills these from the model providers (the `model-provider` plug-ins and
// the model-keys port: `local/app/second-review.ts`); the hosted product fills them from its model sources, guardrails and spend ledger. Everything the second review reads about models goes through this one interface.
import type {
  Admission, AuditSink, Approvers, InvocationModelRoute, ModelIdentifier, Principal,
} from "@agentx/contracts";
import type { SecondReviewPrice } from "./picker.js";
import type { SecondReviewCap } from "./store.js";
import type { SecondReviewStore } from "./settings.js";

/** The route a model is reached by, the way the broker checked it. */
export interface SecondReviewRoute {
  /** What the worker is told for this model (its proxy alias, the request format, the catalog entry for its limits). Absent: the model is called directly by its own name. */
  workerRoute?: InvocationModelRoute | undefined;
  /** The proxy alias the operation's model grant must let its token call (for a routed model). */
  alias?: string | undefined;
  /** What this model may spend in one operation (the model proxy enforces it, priced at the model's own rates). Absent: no cap. */
  cap?: SecondReviewCap | undefined;
}

export interface SecondReviewSeams {
  /** The models the install can serve for this project right now (its connected providers). Empty: not known, and the project's approved list stands in. */
  sources(project: string): Promise<readonly ModelIdentifier[]>;
  /** How `model` is reached: undefined when no usable route serves it (the model is left out of the plan). Never a person's own plan (the second reviewer is called by the install's key). */
  route(model: ModelIdentifier, project: string): Promise<SecondReviewRoute | undefined>;
  /**
   * The models that wrote the task's code in every round (`builds`, one entry per build operation; an entry the install never recorded is `undefined`, and one such entry makes the reviewer's fit unknown) and the
   * model the first reviewer ran on. Code records no per-operation model: every step of a task runs on the install's one chosen model, so it answers with that.
   */
  taskModels(task: { taskId: string; project: string }): Promise<{ builds: ReadonlyArray<ModelIdentifier | undefined>; firstReviewer: ModelIdentifier | undefined }>;
  /** A catalog price per model, for the picker's estimate. Absent: no price is known. */
  price?(model: ModelIdentifier): SecondReviewPrice | undefined;
  /** The models the company forbids, if it keeps such a list (the hosted product's guardrails). Absent: none. */
  forbidden?(): Promise<readonly ModelIdentifier[]>;
  /** Whether the company has this project (an unknown name is "not found"). Absent: every name is taken as known. */
  projectExists?(project: string): Promise<boolean>;
  /** The project's approved models, if it lists any. Absent: none listed. */
  approved?(project: string): Promise<readonly ModelIdentifier[] | undefined>;
}

/** What the second review is built on: the document store (the shared key layout), the policy seams and the install's model seams. */
export interface SecondReviewDeps {
  store: SecondReviewStore;
  companyId: string;
  audit: AuditSink;
  approvers: Approvers;
  admission: Admission;
  seams: SecondReviewSeams;
  /** Whether the feature exists on this install (Code: always; the hosted product: its install setting). Off: no second review is planned, run, recorded or shown, whatever a project or company set. Default on. */
  enabled?: () => boolean;
  /** Who may change the company's settings (Code: the owner; the hosted product: owner or admin of the company). Default: a person holding the `owner` or `admin` role. */
  mayAdminister?: (principal: Principal) => boolean;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export const isSecondReviewEnabled = (deps: Pick<SecondReviewDeps, "enabled">): boolean => deps.enabled === undefined || deps.enabled();
export const secondReviewNow = (deps: Pick<SecondReviewDeps, "now">): number => (deps.now ?? Date.now)();
export const defaultMayAdminister = (principal: Principal): boolean => principal.roles.includes("owner") || principal.roles.includes("admin");
