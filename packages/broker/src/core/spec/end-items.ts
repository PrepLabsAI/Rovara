// What the end of a SPEC_WRITE operation writes. The run's result becomes rendered files (the broker's own rendering, checked against the approved plan's digest), and the code step that waited for
// the spec is queued again. (The spec's publication is not an operation: the broker does it itself, see publish.ts.)
import type { SpecFile } from "@agentx/contracts";
import { acceptSpecWrite } from "./accept-draft.js";
import type { SpecDesignState } from "./approved-design.js";
import { specStateItem, type SpecStore, type TransactItem } from "./hooks.js";
import { specRendererFor } from "./index.js";
import { stepFailed, writeSucceeded, type SpecFailureCode, type SpecState } from "./state.js";

export interface SpecOperationFacts {
  id: string;
  kind: string;
  workflowMode?: string | undefined;
}

export interface SpecEndEnvironment {
  store: SpecStore;
  now(): string;
  /** The digest of the plan that is approved now. */
  approvedPlanDigest(taskId: string): Promise<string | undefined>;
  taskKey(taskId: string): string;
  /** Names of the folders in the parent of a numbered spec folder at the state's `knowledgeCommit`, listed by the broker through GitHub; undefined where unreadable. */
  existingFolders(state: SpecState, parent: string): Promise<readonly string[] | undefined>;
  /** The team's template files at the state's `knowledgeCommit` (`team_template` only), read by the broker through GitHub; undefined where unreadable. */
  template(state: SpecState): Promise<readonly SpecFile[] | undefined>;
  /** The project's own knowledge folders (steering, skills, runbooks, key docs): a spec is never written into one. */
  forbiddenFolders(state: SpecState): Promise<readonly string[]>;
  /** Design review: whether the task's spec waits for an approved design, and the approved design's text. Absent: design review is not part of this install's spec step. */
  design?(taskId: string): Promise<SpecDesignState>;
  /** The item that queues the held code step again, or none when the task is no longer waiting at one. */
  republishItem(taskId: string): Promise<TransactItem | undefined>;
}

export const isSpecOperation = (operation: SpecOperationFacts): boolean => operation.kind === "task" && operation.workflowMode === "SPEC_WRITE";

/** The parent folder of a spec folder that numbers itself with `{n}`, or undefined when the template does not number. */
export function numberedParentOf(state: SpecState): string | undefined {
  const template = state.target.pathTemplate ?? specRendererFor(state.target.format)?.defaultPathTemplate;
  if (template === undefined || !template.includes("{n}")) return undefined;
  return template.replace(/\/+$/u, "").split("/").slice(0, -1).join("/");
}

/** The items to write when a spec write ends. [] for an operation that is not the state's current one (a late or repeated end changes nothing). */
export async function specOperationEndItems(
  env: SpecEndEnvironment, taskId: string, operation: SpecOperationFacts, outcome: { status: string; result: unknown },
): Promise<TransactItem[]> {
  const { state } = await env.store.load(taskId);
  if (state === undefined) return [];
  const now = env.now();
  const fail = (code: SpecFailureCode): TransactItem[] => {
    const next = stepFailed(state, { operationId: operation.id, code }, now);
    return next === undefined ? [] : [specStateItem(next, state.revision)];
  };
  if (outcome.status !== "SUCCEEDED") return fail("write_failed");
  const approved = await env.approvedPlanDigest(taskId);
  if (approved === undefined) return fail("plan_changed");
  const parent = numberedParentOf(state);
  const [folders, template, forbiddenFolders] = await Promise.all([
    parent === undefined ? Promise.resolve([] as readonly string[]) : env.existingFolders(state, parent),
    state.target.format === "team_template" ? env.template(state) : Promise.resolve(undefined),
    env.forbiddenFolders(state),
  ]);
  if (folders === undefined) return fail("render_failed");
  let design: SpecDesignState | undefined;
  if (env.design !== undefined) {
    try { design = await env.design(taskId); } catch { return fail("write_failed"); }
  }
  const accepted = acceptSpecWrite({ result: outcome.result, state, approvedPlanDigest: approved, taskKey: env.taskKey(taskId), existingFolders: folders, forbiddenFolders, ...(template === undefined ? {} : { template }), ...(design === undefined ? {} : { design }) });
  if (!accepted.ok) return fail(accepted.code);
  const next = writeSucceeded(state, { operationId: operation.id, title: accepted.title, files: accepted.files, requirementCount: accepted.requirementCount }, now);
  if (next === undefined) return [];
  const again = await env.republishItem(taskId);
  return [specStateItem(next, state.revision), ...(again === undefined ? [] : [again])];
}
