// Spec 061: a workflow document read back from storage, whichever way it was stored.
import { createHash } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { PlanEvidenceBundleSchema, WORKFLOW_PLAN_MAX_BYTES, planDocumentMarkdown, readCanonicalPlan, type PlanDocument, type PlanEvidenceBundle, type WorkflowArtifact } from "@agentx/contracts";

/** The most bytes read for a legacy Markdown document. */
const MARKDOWN_MAX_BYTES = 1_000_000;
/** The most bytes read for a plan's evidence bundle (the bundle itself is kept to 512 KB). */
const EVIDENCE_MAX_BYTES = 524_288;
/** The last line of a Markdown copy that was cut to fit. */
const SHORTENED_NOTE = "… (shortened; open the task page for the full plan)";

/** An object's text, read at most `maxBytes` of it; undefined when it cannot be read. */
export async function readObjectText(s3: { send(command: never): Promise<unknown> }, bucket: string, key: string, maxBytes: number): Promise<string | undefined> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${maxBytes - 1}` }) as never) as { Body?: { transformToString(encoding?: string): Promise<string> } };
    return object.Body ? await object.Body.transformToString("utf8") : "";
  } catch {
    return undefined;
  }
}

export type LoadedDocument =
  | { format: "markdown"; artifact: WorkflowArtifact; markdown: string }
  | { format: "structured"; artifact: WorkflowArtifact; plan: PlanDocument; markdown: string };

/**
 * The document an artifact record points at, with the bytes checked against the recorded digest. A structured document
 * is read back as a plan (its `markdown` is derived from it, never stored); a legacy artifact is Markdown, as it always
 * was. Undefined when the object is missing, does not match its digest, or is not a readable plan document.
 */
export async function loadWorkflowDocument(
  read: (objectKey: string, maxBytes: number) => Promise<string | undefined>,
  artifact: WorkflowArtifact,
  input: { answers?: "recommended" },
): Promise<LoadedDocument | undefined> {
  const structured = artifact.format === "structured";
  const text = await read(artifact.objectKey, structured ? WORKFLOW_PLAN_MAX_BYTES : MARKDOWN_MAX_BYTES);
  if (text === undefined || createHash("sha256").update(text, "utf8").digest("hex") !== artifact.sha256) return undefined;
  if (!structured) return { format: "markdown", artifact, markdown: text };
  const plan = readCanonicalPlan(text);
  if (plan === undefined) return undefined;
  const kind = artifact.type;
  if (kind !== "requirements" && kind !== "design" && kind !== "plan") return undefined;
  return { format: "structured", artifact, plan, markdown: planDocumentMarkdown(plan, { kind, version: artifact.version, sha256: artifact.sha256, ...input }) };
}

/**
 * The cited code of a structured document, read back and checked against the digest recorded with it. Undefined for a
 * legacy document, or when the bundle is missing, does not match its digest or is not a readable bundle.
 */
export async function loadPlanEvidence(
  read: (objectKey: string, maxBytes: number) => Promise<string | undefined>,
  artifact: WorkflowArtifact,
  /** Told why a bundle that was recorded could not be used: "missing" (not readable) or "digest" (changed, or not a readable bundle). */
  failed?: (reason: "missing" | "digest") => void,
): Promise<PlanEvidenceBundle | undefined> {
  if (artifact.format !== "structured" || artifact.evidence === undefined) return undefined;
  const text = await read(artifact.evidence.objectKey, EVIDENCE_MAX_BYTES);
  if (text === undefined) { failed?.("missing"); return undefined; }
  if (createHash("sha256").update(text, "utf8").digest("hex") !== artifact.evidence.sha256) { failed?.("digest"); return undefined; }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    failed?.("digest");
    return undefined;
  }
  const parsed = PlanEvidenceBundleSchema.safeParse(value);
  if (!parsed.success) failed?.("digest");
  return parsed.success ? parsed.data : undefined;
}

/**
 * A Markdown copy kept to `maxBytes`: whole lines only, then a final line (`note`) that says it was shortened. A copy that
 * already fits is returned as it is.
 */
export function shortenMarkdown(markdown: string, maxBytes: number, note: string = SHORTENED_NOTE): string {
  if (Buffer.byteLength(markdown, "utf8") <= maxBytes) return markdown;
  const room = maxBytes - Buffer.byteLength(`\n${note}\n`, "utf8");
  const kept: string[] = [];
  let used = 0;
  for (const line of markdown.split("\n")) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (used + size > room) break;
    kept.push(line);
    used += size;
  }
  return `${kept.join("\n")}\n${note}\n`;
}
