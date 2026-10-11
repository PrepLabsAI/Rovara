// Structured plan documents for tests: a small valid document, and the planner's final answer that carries it.
import { createHash } from "node:crypto";
import { PLAN_DOCUMENT_INFO_STRING, type PlanDocument } from "@agentx/contracts";

/** The planner's raw `checks` object (each proposed-check field plus the claims it proves). */
export interface RawChecksInput {
  checks: Array<{ label: string; cwd: string; executable: string; args: string[]; timeoutSeconds?: number; proves: string[] }>;
  none_reason?: string | null;
}

/** A small valid plan document: two claims (the first with a child), one decision, what stays and what could go wrong. */
export function planDocument(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    schemaVersion: 1,
    title: "Retry failed payments",
    why: [{ text: "Failed payments are dropped without a retry.", author: "Priya" }],
    claims: [
      {
        id: "1",
        text: "Payments that fail with a timeout are retried.",
        evidence: [{ kind: "code", path: "payments/src/charge.ts", startLine: 10, endLine: 24, note: "Today a timeout throws." }],
        children: [{ id: "1.1", text: "The retry waits longer each time." }],
      },
      { id: "2", text: "A payment is never charged twice." },
    ],
    notChanging: ["The refund flow stays as it is."],
    risks: ["A slow gateway could keep a retry open for a long time."],
    decisions: [{
      id: "d1",
      claimId: "1",
      question: "How many times should a payment be retried?",
      options: [
        { id: "three", label: "Three times", consequence: "Most timeouts clear by the third try." },
        { id: "five", label: "Five times", consequence: "Customers wait longer before seeing a failure." },
      ],
      recommended: "three",
    }],
    ...overrides,
  };
}

/**
 * The planner's final text for a plan document: a short sentence, then the fenced `agentx-plan` JSON. The block holds the
 * raw answer form, so a coding plan's checks go in as `{ checks: [...], none_reason }`, not as the stored shape.
 */
export function planAnswer(plan: PlanDocument, extra: { checks?: RawChecksInput } = {}): string {
  const body: PlanDocument = { ...plan };
  delete body.checks;
  const block = extra.checks === undefined ? body : { ...body, checks: extra.checks };
  return `Here is the plan.\n\n\`\`\`${PLAN_DOCUMENT_INFO_STRING}\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
}

/** The stored side of a task: its table and its artifact storage. */
export interface StoredPlans {
  db: { find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>>; set(item: Record<string, unknown>): void };
  s3: { objects: Map<string, string> };
}

/** What a test needs of a developer task broker harness to finish a planning step. */
interface PlanningHarness extends StoredPlans {
  artifact(workspaceId: string, operationId: string, name: string, content: string): Promise<unknown>;
  finish(workspaceId: string, operationId: string, status: "SUCCEEDED", detail: { result?: unknown }): Promise<unknown>;
}

/**
 * Puts a planning step's stored document back to the form a task started before plans became structured holds it: the
 * saved document is `markdown`, with no format and no evidence. Returns the stored document's artifact ID and object
 * key, and the Markdown's digest.
 */
export function turnPlanIntoMarkdown(harness: StoredPlans, workspaceId: string, operationId: string, markdown: string): { artifactId: string; objectKey: string; sha256: string } {
  const answer = harness.db.find((item) => item.entityType === "ARTIFACT" && item.operationId === operationId && item.name === "plan.md").at(-1);
  const task = harness.db.find((item) => item.entityType === "DEVELOPER_TASK" && item.workspaceId === workspaceId)[0];
  const workflow = task?.workflow as { artifacts: Array<Record<string, unknown>> } | undefined;
  if (answer === undefined || task === undefined || workflow === undefined) throw new Error("the planning step stored no document to turn into Markdown");
  const objectKey = String(answer.objectKey);
  harness.s3.objects.set(objectKey, markdown);
  const sha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
  const artifacts = workflow.artifacts.map((artifact) => {
    if (artifact.id !== answer.id) return artifact;
    const { format: _format, evidence: _evidence, ...legacy } = artifact;
    void _format;
    void _evidence;
    return { ...legacy, objectKey, sha256 };
  });
  harness.db.set({ ...task, workflow: { ...workflow, artifacts } });
  return { artifactId: String(answer.id), objectKey, sha256 };
}

/**
 * Finishes a planning step the way a task started before plans became structured holds it. The step first ends with a
 * structured answer (the only thing the broker accepts now), then its stored document is put back to the old form.
 * Returns the Markdown's digest.
 */
export async function finishPlanningWithMarkdown(harness: PlanningHarness, workspaceId: string, operationId: string, markdown: string): Promise<string> {
  await harness.artifact(workspaceId, operationId, "plan.md", planAnswer(planDocument()));
  await harness.finish(workspaceId, operationId, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  return turnPlanIntoMarkdown(harness, workspaceId, operationId, markdown).sha256;
}
