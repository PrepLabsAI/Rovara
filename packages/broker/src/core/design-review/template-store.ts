// Design review stage: what the planner's saved answer becomes when the DESIGN phase wrote the Rovara template (template.ts). The answer is read strictly (all eight sections, one `rovara-design-meta` block), stored as
// a Markdown design document under its own digest, and submitted for review by the workflow's ordinary move (`submitWorkflowArtifact`, which sends a design of a task with a design review to its review). A design that does not read
// is not stored: the caller asks the planner again with what was wrong, or blocks. Only reached when the task has a `designReview`; with it off the claims format is stored as before.
import { createHash } from "node:crypto";
import { submitWorkflowArtifact, type WorkflowSnapshot } from "@agentx/contracts";
import { readDesignTemplate } from "./template.js";

export interface DesignTemplateInput {
  workflow: WorkflowSnapshot;
  ownerKey: string;
  workspaceId: string;
  /** The planner's saved answer: id and creation time of its artifact, and its text. */
  artifact: { id: string; createdAt: string };
  content: string;
  /** Stores an object; a failure throws (the caller's result handling retries). */
  put(key: string, body: string): Promise<void>;
  now: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The key a design document is stored under: next to the structured documents, with its own extension. */
export const designDocumentKey = (ownerKey: string, workspaceId: string, artifactId: string): string => `private/${ownerKey}/${workspaceId}/plan-documents/${artifactId}.md`;

export async function storeDesignTemplate(input: DesignTemplateInput): Promise<{ ok: true; next: WorkflowSnapshot } | { ok: false; errors: string[] }> {
  const text = input.content.trim();
  const read = readDesignTemplate(text);
  if (!read.ok) return read;
  const objectKey = designDocumentKey(input.ownerKey, input.workspaceId, input.artifact.id);
  await input.put(objectKey, text);
  const next = submitWorkflowArtifact(input.workflow, {
    expectedRevision: input.workflow.revision, now: input.now,
    artifact: {
      id: input.artifact.id, type: "design", version: input.workflow.artifacts.filter((entry) => entry.type === "design").length + 1, sha256: sha256(text),
      producer: "agentx-worker-untrusted", objectKey, createdAt: input.artifact.createdAt, format: "markdown",
    },
  });
  return { ok: true, next };
}
