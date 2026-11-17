// The wiki build's callback (W3b): ONE worker-to-broker action, `POST /v1/internal/workspaces/{w}/operations/{o}/wiki-build`. It is granted (capability `wiki-build`) only to a WIKI_BUILD operation, and the route accepts it only
// for that operation while it RUNS.
//
// The run is never named by the body. The company, the project and the task come from the authenticated operation (its workspace's task pointer and the task's own record: a wiki build task of this company), and the build's
// own pointer must name that same task. The body is a strict union of two shapes:
//   next   "what page now?": the worker's metered spend so far; the answer is a page to write (with the commits, the instructions and the spend ceiling) or how the run ends;
//   page   the worker's answer for the page it was handed (a draft, or a failure word): the broker re-reads every citation and writes what survived.
// Nothing in a reply is repository text: the instructions are the broker's own fixed words around the page's plan.
import { z } from "zod";
import { agentXError, type DocumentStore, type OrgId, type WikiBuildRecord, type WikiPageSink } from "@agentx/contracts";
import type { CitationFileReader } from "../citations/citation-check.js";
import { taskKey } from "../task-flow/keys.js";
import { workspaceKeys } from "../task-flow/workspace-location.js";
import { WIKI_BUILD_WORKFLOW_MODE, nextWikiPage, submitWikiPage, type WikiBuildStanding, type WikiPageLoopDeps } from "./run.js";

export interface WikiBuildCallbackDeps {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  /** A person's standing on a project of this company, read live (the run's requester is checked again before every page). */
  standing(personId: string, project: string): Promise<WikiBuildStanding>;
  /** The code host's file read at a commit, for the citation re-read. Absent: no citation is found, so no claim is kept. */
  read: CitationFileReader | undefined;
  /**
   * W4: the same read made for ONE project (a repository name is only a name inside a project: two projects of a company can use the same name for different repositories). When it is given
   * it is used instead of `read`, with the run's own project taken from the operation, never from the body.
   */
  readFor?: ((project: string) => CitationFileReader) | undefined;
  fileVersion?: ((repo: string, path: string, commit: string) => Promise<string | undefined>) | undefined;
  /** The wiki store's write seam for ONE project of this company (W2 `WikiStore.pageSink(project)`). */
  sinkFor(project: string): WikiPageSink;
  /** The wiki store's build record write (W2 `WikiStore.writeBuild`). */
  recordBuild?: ((project: string, record: WikiBuildRecord) => Promise<void>) | undefined;
}

/** The authenticated operation, as the callback route read it. */
export interface WikiBuildOperation { kind: string; workflowMode?: string | undefined; status: string; workspaceId: string; companyId?: string | undefined }

export const WikiBuildCallbackBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("next"), spentCents: z.number().int().min(0).max(1_000_000) }).strict(),
  // The answer is checked by `submitWikiPage` (`WikiPageAnswerSchema` and `WikiPageDraftSchema`), so a bad draft is dropped and a bad envelope is refused in the build's own words.
  z.object({ kind: z.literal("page"), answer: z.unknown() }).strict(),
]);

/** The statuses of an operation whose worker has it: handed over, or running. */
const RUNNING_STATUSES: ReadonlySet<string> = new Set(["DISPATCHING", "RUNNING"]);

/** The run an operation belongs to: its task, which must be a wiki build task of this company. Undefined for anything else. */
export async function wikiBuildRunOfOperation(deps: Pick<WikiBuildCallbackDeps, "store" | "companyId">, operation: WikiBuildOperation): Promise<{ orgId: OrgId; project: string; taskId: string } | undefined> {
  if (operation.kind !== "task" || operation.workflowMode !== WIKI_BUILD_WORKFLOW_MODE || !RUNNING_STATUSES.has(operation.status)) return undefined;
  const pointer = await deps.store.get((await workspaceKeys(deps, operation.workspaceId)).taskPointerKey());
  if (typeof pointer?.["taskId"] !== "string") return undefined;
  const task = await deps.store.get(taskKey(pointer["taskId"]));
  if (task === undefined || task["purpose"] !== "wiki_build" || task["companyId"] !== deps.companyId || task["workspaceId"] !== operation.workspaceId || task["closedAt"] !== undefined || typeof task["project"] !== "string") return undefined;
  if (operation.companyId !== undefined && operation.companyId !== task["companyId"]) return undefined;
  return { orgId: deps.companyId, project: task["project"], taskId: pointer["taskId"] };
}

/** Handles one wiki build callback. Throws CALLBACK_FORBIDDEN for an operation that is not a running wiki build, CONFIG_INVALID for a body that is not one of the two shapes. */
export async function handleWikiBuildCallback(deps: WikiBuildCallbackDeps, operation: WikiBuildOperation, rawBody: unknown): Promise<object> {
  const run = await wikiBuildRunOfOperation(deps, operation);
  if (run === undefined) throw agentXError("CALLBACK_FORBIDDEN", "the wiki build callback is limited to a running wiki build");
  const parsed = WikiBuildCallbackBodySchema.safeParse(rawBody);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the wiki build callback body is not one of its shapes");
  const loop: WikiPageLoopDeps = {
    store: deps.store, companyId: deps.companyId, now: deps.now, standing: (personId, project) => deps.standing(personId, project), read: deps.readFor === undefined ? deps.read : deps.readFor(run.project), fileVersion: deps.fileVersion,
    // The sink is made for the run's own project, from the operation: a sink of any other company or project is refused by the loop.
    sink: deps.sinkFor(run.project),
    ...(deps.recordBuild === undefined ? {} : { recordBuild: (record: WikiBuildRecord) => deps.recordBuild!(run.project, record) }),
  };
  const body = parsed.data;
  return body.kind === "next" ? await nextWikiPage(loop, run, { spentCents: body.spentCents }) : await submitWikiPage(loop, run, body.answer);
}
