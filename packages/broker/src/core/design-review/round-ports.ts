// Design review stage: what the round's dispatch needs of the rest of the broker, as one small port. The broker builds it from its own dependencies (`design-review/wiring.ts`); a test builds it from fakes. Everything the
// round reads from outside the task record comes through here, so the orchestration (round-start.ts) reads no store and calls no host by itself.
import type { ContextSource, DesignReviewBinding, InvocationModelRoute, ModelSelection, OrgId } from "@agentx/contracts";
import type { DocumentStore } from "@agentx/contracts";
import type { TaskRecord as DeveloperTaskRecord } from "../task-flow/records.js";
import type { PriceLookup } from "./estimate.js";
import type { PacketReaders } from "./packet.js";
import type { PacketOriginItem } from "./mcp-allowlist.js";
import type { DesignReviewProxyCheck } from "./proxy-check.js";
import type { ProjectPlaybookReader } from "./playbook-store.js";

/** What a task's packets are read with: the broker's own readers (repository files at the pinned commits, the meta repository at its knowledgeCommit, MCP items through the allowlist), the repositories' names, and the request thread to keep out. */
export interface RoundSourceReaders {
  readers: PacketReaders;
  /** The names section 8 may use for a repository (the project's). */
  repositoryNames: readonly string[];
  /** The task's own request thread, passed to the packet builder and to the MCP reader (security M6/N8). */
  origin: readonly PacketOriginItem[];
}

export interface DesignReviewRoundPorts {
  /** The State table, for the packet store and the budget allocation. */
  table: Pick<DocumentStore, "get" | "put" | "update" | "query" | "transact">;
  now(): number;
  /** Whether a model proxy exists to mint reviewer keys from (`designReviewProxyCheck`). */
  proxy(): DesignReviewProxyCheck;
  /** The catalog price of a model (a model with none is "cost unavailable", never guessed). */
  price: PriceLookup;
  /** The company lock's cap ceiling for an org, when it has one. */
  capCeilingUsd(orgId: OrgId): Promise<number | undefined>;
  /** What is left of the task's run limit for model spend (`taskRunRoomUsd`). */
  taskRoomUsd(task: DeveloperTaskRecord): Promise<number>;
  /** The readers for this task's packets; `operationId` is the round's operation, under which the MCP route records what it fetched. */
  sourceReaders(task: DeveloperTaskRecord, operationId: string): Promise<RoundSourceReaders>;
  /** The model the planner last ran on, for the planner-revision part of the estimate. Absent or undefined: the reviewers' model is priced instead (high, never low). */
  plannerModel?(task: DeveloperTaskRecord): Promise<ModelSelection | undefined>;
  /** The context sources of the project, for naming the origin thread to withhold. Not used by the dispatch itself. */
  contextSources?(task: DeveloperTaskRecord): Promise<readonly ContextSource[]>;
}

/** What the operation's own resolution (the plan check's model and the route chosen for it) tells the round, handed to `prepare` inside the operation's creation. */
export interface DesignReviewResolved {
  /** The id the operation will have. The budgets and the packets are stored under it before the operation exists. */
  operationId: string;
  /** The model the plan_check stage resolved for this step; every reviewer and the merge step use it. */
  model: ModelSelection | undefined;
  /** The route the worker cannot reach by the model's own name (absent for the metered catalog, which is reached by name). */
  modelRoute: InvocationModelRoute | undefined;
  /** The source that serves the model. A person's ChatGPT plan has no alias and serves no reviewer. */
  sourceId: string | undefined;
}

/** `acceptTask`'s `designReview` option: the round's preparation, run inside `taskOperationParts` once the plan-check model is resolved and before the operation record exists. It answers the binding the operation is stored with (in the SAME write that creates it), or throws `DesignReviewRoundStop`. */
export interface DesignReviewDispatch {
  prepare(resolved: DesignReviewResolved): Promise<DesignReviewBinding>;
}

/** The model a design review runs on: one model, fixed by the install (a laptop has the owner's chosen model). The route is what the worker is told for each slot; the source names where the spend goes. */
export interface DesignReviewModel { selection: ModelSelection; route: InvocationModelRoute; sourceId: string }

/**
 * Everything the design review needs of the install beyond the task flow's own ports: the settings reader, the round's ports, the model, what the model proxy knows about the reviewers' keys and where
 * the worker's saved files are read from. `rovara up` builds it; a test builds it from fakes.
 */
export interface DesignReviewRuntime {
  /** The store the playbook, the company's lock and policy are read from, and what a company with no policy item has. */
  reader: ProjectPlaybookReader;
  env: NodeJS.ProcessEnv;
  /**
   * Whether the owner can answer the cost hold on this install (the choices on the plan page). When they cannot, a round that would wait for that choice ends the review as not run (`cost_declined`) and the design goes to the owner
   * unreviewed with a plain word, instead of waiting for a choice no one can make. Absent: false.
   */
  holdAnswerable?: boolean | undefined;
  ports: DesignReviewRoundPorts;
  model(): Promise<DesignReviewModel | undefined>;
  /** What the model proxy keeps of the reviewers' keys: blocks them and measures what each spent. */
  keys: { closeKeys(orgId: OrgId, keyIds: readonly string[]): Promise<void>; keySpend(keyIds: readonly string[]): Promise<number | undefined> };
  /** The text of the operation's saved file, bounded; undefined when it is not there. */
  readArtifactText(operation: { workspaceId: string; id: string }, name: string, maxBytes: number): Promise<string | undefined>;
  /** Stores the planner's revised design as a document. */
  putDocument(objectKey: string, body: string): Promise<void>;
}
