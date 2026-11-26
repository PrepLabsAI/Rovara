// RD-2a: the task's spec in ONE answer (`GET /v1/dev/tasks/{taskId}/spec`; the shape is `TaskSpecReadSchema` in packages/code-api): the layers the new task page's Spec panel shows (What and why, Approach and Steps on a Full task; Steps alone on a Quick one),
// each with its version, approval and state, the plan's decisions flattened with a status derived here (never stored), and the reasons a Quick plan looks bigger than Quick. Nothing is invented: every member is the stored workflow, the stored
// plan documents (through `readTaskPlanDocument`, so the digest is checked and every string redacted) or the stored comments.
//
// Rules this file keeps:
//  - A layer that is not written yet is a layer with state `not_written`, never an error (a Quick task has no requirements or design).
//  - NO silent fallback (arch rule 9): a structured document whose current version cannot be read or fails its digest is a layer with state `unreadable` and no content; an older version is never served in its place.
//  - Stored comments are read tolerantly (arch rule 8): by the few members read here, never through the strict schema, so a field a later version adds cannot make a comment vanish from the count.
//  - No comparison against error message text (arch rule 6): what failed is told from the stored snapshot (the artifact's own `format`), not from the words of an error.
// The mount has already asked the one read rule (`decideTaskRead`, core/task-flow/read-rule.ts); nothing here checks who is asking.
import { TASK_COMMENT_ITEMS_MAX, planHasSetupChanges, redactText, type DocumentStore, type PlanClaim, type PlanDocument, type WorkflowArtifact, type WorkflowSnapshot } from "@agentx/contracts";
import type { TaskSpecRead } from "@preplabsai/rovara-code-api";
import { redactedPlan } from "../../aws/task-plan-document.js";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { planIsTooBig } from "../../developer/plan-one-screen.js";
import { currentDocumentType, waitingDocumentDigest } from "../decisions/workflow-subject.js";
import { planFiles, withoutPathsInText } from "../decisions/plan-facts.js";
import { riskTierOf } from "../decisions/risk-tier.js";
import type { TaskRecord } from "../task-flow/records.js";

type Spec = NonNullable<TaskSpecRead["spec"]>;
type Layer = NonNullable<Spec["layers"]>[number];
type Decision = NonNullable<Spec["decisions"]>[number];
type Document = "requirements" | "design" | "plan";

/** Where a layer's words come from: the plan document it reads. A Quick task has the coding plan alone. */
const LAYERS: ReadonlyArray<{ layer: "what_and_why" | "approach" | "steps"; document: Document }> = [
  { layer: "what_and_why", document: "requirements" }, { layer: "approach", document: "design" }, { layer: "steps", document: "plan" },
];

/**
 * How a layer stands, as one fixed word: `not_written`, `waiting` (this is the document the task waits on, at its gate), `approved` (an approval holds this version's digest), `changes_requested`, `rejected`, `written` (stored, no decision on it, the task
 * is not at its gate), `superseded` (a coding plan written before the task went the Full way: history, the Full layers come first) and `unreadable` (a structured document that cannot be read or fails its digest).
 */
export type SpecLayerState = "not_written" | "waiting" | "approved" | "changes_requested" | "rejected" | "written" | "superseded" | "unreadable";

/** What the spec read needs: the company's store (comments) and a reader of stored documents by object key. */
export interface SpecReads {
  store: Pick<DocumentStore, "query">;
  read(objectKey: string, maxBytes: number): Promise<string | undefined>;
}

const atGate = (task: TaskRecord): boolean => task.closedAt === undefined && task.workflow?.stage === "PLAN_REVIEW" && task.workflow.state === "WAITING";

/** The decision (an approval, a request for changes, a rejection) that holds this exact document version, newest first. An approval is read as the plan route reads it (any approval of the digest); the others count only at a gate. */
function decisionOn(workflow: WorkflowSnapshot, artifact: WorkflowArtifact, which: "APPROVE" | "REQUEST_CHANGES" | "REJECT") {
  return [...workflow.decisions].reverse().find((decision) => decision.decision === which && decision.artifactDigest === artifact.sha256 && (which === "APPROVE" || (decision.source ?? "GATE") === "GATE"));
}

function stateOf(task: TaskRecord, workflow: WorkflowSnapshot, document: Document, latest: WorkflowArtifact | undefined): SpecLayerState {
  if (latest === undefined) return "not_written";
  if (document === "plan" && workflow.path === "FULL" && workflow.reviewPhase !== "IMPLEMENTATION_PLAN" && decisionOn(workflow, latest, "APPROVE") === undefined) return "superseded";
  if (decisionOn(workflow, latest, "APPROVE") !== undefined) return "approved";
  if (decisionOn(workflow, latest, "REJECT") !== undefined) return "rejected";
  if (decisionOn(workflow, latest, "REQUEST_CHANGES") !== undefined) return "changes_requested";
  return atGate(task) && currentDocumentType(workflow) === document ? "waiting" : "written";
}

/** Live comments of people (a person's reply in a thread is a comment and counts, as does a top-level one), per document and version, and how many of them a decision already took (tolerant: read by the members used here only). */
async function commentCounts(store: SpecReads["store"], taskId: string): Promise<Map<string, { count: number; resolved: number }>> {
  const counts = new Map<string, { count: number; resolved: number }>();
  let cursor: string | undefined;
  let read = 0;
  do {
    const page = await store.query({ pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "COMMENT#" }, limit: TASK_COMMENT_ITEMS_MAX - read, ...(cursor === undefined ? {} : { cursor }) });
    read += page.items.length;
    for (const item of page.items) {
      const author = item["author"] as { kind?: unknown } | undefined;
      if (item["taskId"] !== taskId || typeof item["document"] !== "string" || typeof item["version"] !== "number" || author?.kind !== "person" || item["deletedAt"] !== undefined) continue;
      const key = `${item["document"]}:${String(item["version"])}`;
      const entry = counts.get(key) ?? { count: 0, resolved: 0 };
      entry.count += 1;
      if (item["lockedBy"] !== undefined) entry.resolved += 1;
      counts.set(key, entry);
    }
    cursor = page.cursor;
  } while (cursor !== undefined && read < TASK_COMMENT_ITEMS_MAX);
  return counts;
}

/** The plan's decisions as the cards show them: where each stands, from what is stored (the approval's answers), never from a stored status. */
function decisionsOf(plan: PlanDocument, layer: string, state: SpecLayerState, approval: ReturnType<typeof decisionOn>): Decision[] {
  return plan.decisions.map((decision) => {
    const picked = approval?.answerOverrides?.find((answer) => answer.decisionId === decision.id)?.optionId;
    if (state === "approved" && picked !== undefined) return { ...decision, layer, status: "changed_by_reviewer", answer: redactText(picked) };
    if (state === "approved") return { ...decision, layer, status: "agreed", answer: decision.recommended };
    return { ...decision, layer, status: "proposed" };
  });
}

/** The design review's questions that wait for a person's answer: the latest round asked and nobody has answered. */
function openQuestionsOf(workflow: WorkflowSnapshot): Decision[] {
  const review = workflow.designReview;
  const round = review?.rounds.at(-1);
  if (review === undefined || review.status !== "waiting_answers" || round === undefined || round.answers !== undefined) return [];
  return (round.questions ?? []).map((question) => ({
    id: redactText(question.id), question: redactText(question.unclear), recommended: redactText(question.recommended), layer: "approach", status: "needs_you",
    options: question.options.map((option) => ({ id: redactText(option.id), label: redactText(option.label), consequence: redactText(option.consequence) })),
  }));
}

/**
 * A plan's PATHS are source code (the read rule's decision, `decision.sourceCode`, the same as the changes read's): the places a claim cites (path, lines and the exact line of code it anchors on). Without the proof they are not served:
 * a code citation keeps only its own note and says it is withheld; the work items' titles and descriptions say "(a file)" where a path stood (Opus S4); the plan's other words (claims, risks, decisions) stay as written.
 */
function claimsWithoutPaths(claims: readonly PlanClaim[]): PlanClaim[] {
  return claims.map((claim): PlanClaim => {
    const { evidence, children, ...rest } = claim;
    const shown = evidence?.map((item) => (item.kind === "code" ? { kind: "code" as const, withheld: true, ...(item.note === undefined ? {} : { note: item.note }) } : item));
    return { ...rest, ...(shown === undefined ? {} : { evidence: shown as unknown as NonNullable<PlanClaim["evidence"]> }), ...(children === undefined ? {} : { children: claimsWithoutPaths(children) }) };
  });
}
/** The work items' own words name paths too (`planWorkPaths` reads them from there): without the proof, the title and the description say "(a file)" where a path stood (Opus S4). The items' ids, repository and order stay. */
function workBreakdownWithoutPaths(breakdown: NonNullable<PlanDocument["workBreakdown"]>): NonNullable<PlanDocument["workBreakdown"]> {
  return { ...breakdown, items: breakdown.items.map((item) => ({ ...item, title: withoutPathsInText(item.title), description: withoutPathsInText(item.description) })) };
}
const planWithoutPaths = (plan: PlanDocument): PlanDocument => ({ ...plan, claims: claimsWithoutPaths(plan.claims), ...(plan.workBreakdown === undefined ? {} : { workBreakdown: workBreakdownWithoutPaths(plan.workBreakdown) }) });

/** The tier's sentences name up to two files after a colon ("Changes infrastructure, IAM or data files: a.tf, b.tf and 3 more."): without the proof the sentence stands and the files do not. */
const PATH_SENTENCES = [/^(Changes infrastructure, IAM or data files): .*\.$/u, /^(Touches sensitive paths): .*\.$/u, /^(Touches infrastructure, IAM or data): .*\.$/u];
const withoutPathsIn = (reason: string): string => { for (const pattern of PATH_SENTENCES) { const found = pattern.exec(reason); if (found !== null) return `${found[1]!}.`; } return reason; };

/** Why a Quick plan looks bigger than Quick, in fixed sentences from the same readers the plan card uses (the files it names and the tier rules, the setup change, the one-screen size). Empty when it does not. Files are named only where the reader may see source code. */
function biggerThanQuickOf(plan: PlanDocument, paths: boolean): string[] {
  const reasons = riskTierOf("approve_plan", { plan: { files: planFiles(plan), untestedClaims: 0, unread: false, setupChange: planHasSetupChanges(plan) } }).reasons;
  return [...(paths ? reasons : reasons.map(withoutPathsIn)), ...(planIsTooBig(plan) ? ["The plan is longer than fits on one screen."] : [])].map(redactText);
}

async function layerOf(reads: SpecReads, task: TaskRecord, workflow: WorkflowSnapshot, document: Document, layer: string, comments: Awaited<ReturnType<typeof commentCounts>>, paths: boolean): Promise<{ layer: Layer; state: SpecLayerState; plan?: PlanDocument; approval?: ReturnType<typeof decisionOn> }> {
  const versions = workflow.artifacts.filter((artifact) => artifact.type === document).sort((left, right) => left.version - right.version);
  const latest = versions.at(-1);
  const state = stateOf(task, workflow, document, latest);
  if (latest === undefined) return { layer: { layer, document, state, versions: [] }, state };
  const approval = decisionOn(workflow, latest, "APPROVE");
  const tally = comments.get(`${document}:${String(latest.version)}`) ?? { count: 0, resolved: 0 };
  const head: Layer = {
    layer, document, state, version: latest.version, versions: versions.map((artifact) => artifact.version), sha256: latest.sha256, approved: approval !== undefined, current: true,
    commentCount: tally.count, resolvedCommentCount: tally.resolved,
  };
  // A document stored as Markdown (before structured plans) has no canonical form to serve: its state and numbers stand, its content is absent.
  if (latest.format !== "structured") return { layer: head, state };
  // ONLY what the spec needs: the stored bytes, checked against the recorded digest and against this task's own object folder. (The plan route also builds a check summary and reads the self-check record; a failure
  // of that extra work must not hide a document whose bytes verify.) Any failure here is "unreadable" on purpose, and an older version is never read instead.
  const unreadable = { layer: { ...head, state: "unreadable", approved: false }, state: "unreadable" } as const;
  try {
    if (!latest.objectKey.startsWith(`private/${task.ownerKey}/${task.workspaceId}/`)) return unreadable;
    const loaded = await loadWorkflowDocument((key, max) => reads.read(key, max), latest, {});
    if (loaded === undefined || loaded.format !== "structured") return unreadable;
    const plan = redactedPlan(loaded.plan);
    const served = paths ? plan : planWithoutPaths(plan);
    return { layer: { ...head, content: served as Layer["content"] /* the wire schema is looser than the stored recursive claim type */ }, state, plan, approval };
  } catch {
    return unreadable;
  }
}

/** What the reader may be shown beyond the plan's words: `paths` is the read rule's `decision.sourceCode` (a live project grant proved on this request, or the owner's share of the code): the code a plan cites by place. Required, so no caller forgets to ask. */
export interface SpecShown { paths: boolean }

/** The task's spec. `task` is a task the caller may read; a task with no workflow snapshot has no layers. */
export async function specOf(reads: SpecReads, task: TaskRecord, shown: SpecShown): Promise<{ spec: Spec }> {
  const workflow = task.workflow;
  if (workflow === undefined) return { spec: { taskId: task.taskId, layers: [], decisions: [] } };
  const comments = await commentCounts(reads.store, task.taskId);
  const wanted = LAYERS.filter((entry) => workflow.path === "FULL" || entry.document === "plan");
  const built = [];
  for (const entry of wanted) built.push(await layerOf(reads, task, workflow, entry.document, entry.layer, comments, shown.paths));
  const decisions = [
    ...built.flatMap((entry) => entry.plan === undefined || entry.state === "superseded" ? [] : decisionsOf(entry.plan, entry.layer.layer ?? "", entry.state, entry.approval)),
    ...openQuestionsOf(workflow),
  ];
  const steps = built.find((entry) => entry.layer.document === "plan");
  const bigger = workflow.path === "QUICK" && steps?.plan !== undefined && (["waiting", "written", "changes_requested"] as SpecLayerState[]).includes(steps.state) ? biggerThanQuickOf(steps.plan, shown.paths) : [];
  // Offered only for a document the page can show (its bytes were read and verified): no invitation to decide on bytes nobody can read, or that were never checked (a Markdown-era document).
  const waitedOn = built.find((entry) => entry.layer.document === currentDocumentType(workflow));
  const digest = atGate(task) && waitedOn?.layer.content !== undefined ? waitingDocumentDigest(workflow) : undefined;
  return {
    spec: {
      taskId: task.taskId, path: workflow.path === "FULL" ? "full" : "quick", layers: built.map((entry) => entry.layer), decisions,
      ...(digest === undefined ? {} : { waitingDocumentDigest: digest }), ...(bigger.length === 0 ? {} : { biggerThanQuick: { reasons: bigger } }),
    },
  };
}
