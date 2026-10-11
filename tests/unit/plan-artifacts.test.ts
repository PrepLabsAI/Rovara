// A workflow document read back from storage: legacy Markdown as it was, a structured plan checked and rendered.
import { createHash } from "node:crypto";
import { canonicalPlanJson, planDocumentMarkdown, type WorkflowArtifact } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { loadPlanEvidence, loadWorkflowDocument, shortenMarkdown } from "../../packages/broker/src/developer/plan-artifacts.js";
import { planDocument } from "../support/plan-documents.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const artifact = (text: string, extra: Partial<WorkflowArtifact> = {}): WorkflowArtifact => ({
  id: "a1", type: "plan", version: 3, sha256: sha(text), producer: "planner", objectKey: "tasks/t/plan-3.json", createdAt: "2026-10-09T10:00:00.000Z", ...extra,
});
const reading = (text: string | undefined) => vi.fn<(objectKey: string, maxBytes: number) => Promise<string | undefined>>(async () => text);

describe("loading a workflow document", () => {
  it("reads a legacy artifact as Markdown, up to 1,000,000 bytes, after checking its digest", async () => {
    const markdown = "# Plan\n\nFix it.\n";
    const read = reading(markdown);
    const loaded = await loadWorkflowDocument(read, artifact(markdown), {});
    expect(loaded).toEqual({ format: "markdown", artifact: artifact(markdown), markdown });
    expect(read).toHaveBeenCalledWith("tasks/t/plan-3.json", 1_000_000);
    expect(await loadWorkflowDocument(reading(markdown), artifact(markdown, { format: "markdown" }), {})).toMatchObject({ format: "markdown" });
  });

  it("reads a structured artifact as a plan, up to 32,768 bytes, and derives its Markdown with the owner's answers", async () => {
    const plan = planDocument();
    const json = canonicalPlanJson(plan);
    const stored = artifact(json, { format: "structured" });
    const read = reading(json);
    const loaded = await loadWorkflowDocument(read, stored, { answers: "recommended" });
    expect(read).toHaveBeenCalledWith("tasks/t/plan-3.json", 32_768);
    expect(loaded).toEqual({ format: "structured", artifact: stored, plan, markdown: planDocumentMarkdown(plan, { kind: "plan", version: 3, sha256: stored.sha256, answers: "recommended" }) });
    expect(loaded?.markdown).toContain("recommended answer to every decision");
    const without = await loadWorkflowDocument(reading(json), stored, {});
    expect(without?.markdown).not.toContain("recommended answer to every decision");
  });

  it("finds nothing when the object is missing, changed, or not a readable plan", async () => {
    const json = canonicalPlanJson(planDocument());
    expect(await loadWorkflowDocument(reading(undefined), artifact(json, { format: "structured" }), {})).toBeUndefined();
    expect(await loadWorkflowDocument(reading(`${json} `), artifact(json, { format: "structured" }), {})).toBeUndefined();
    expect(await loadWorkflowDocument(reading("# Plan\n"), artifact("# Plan\n"), {})).toMatchObject({ format: "markdown" });
    const notAPlan = JSON.stringify({ schemaVersion: 1, title: "x" });
    expect(await loadWorkflowDocument(reading(notAPlan), artifact(notAPlan, { format: "structured" }), {})).toBeUndefined();
    expect(await loadWorkflowDocument(reading("not json"), artifact("not json", { format: "structured" }), {})).toBeUndefined();
    expect(await loadWorkflowDocument(reading("# Plan\n"), artifact("# Plan changed\n"), {})).toBeUndefined();
  });

  it("finds nothing for a structured document of a kind that is not a plan document", async () => {
    const json = canonicalPlanJson(planDocument());
    expect(await loadWorkflowDocument(reading(json), artifact(json, { format: "structured", type: "review_report" }), {})).toBeUndefined();
  });
});

describe("loading a plan's evidence", () => {
  const bundle = { schemaVersion: 1, excerpts: [{ claimId: "1", index: 0, path: "payments/src/charge.ts", startLine: 10, endLine: 12, status: "ok", commit: "a".repeat(40), lines: ["a", "b", "c"] }] };
  const withEvidence = (text: string, evidenceText = text) => artifact("{}", { format: "structured", evidence: { objectKey: "tasks/t/plan-3.evidence.json", sha256: sha(evidenceText) } });

  it("reads the bundle up to 512 KB after checking its digest", async () => {
    const text = JSON.stringify(bundle);
    const read = reading(text);
    expect(await loadPlanEvidence(read, withEvidence(text))).toEqual(bundle);
    expect(read).toHaveBeenCalledWith("tasks/t/plan-3.evidence.json", 524_288);
  });

  it("finds nothing for a legacy document, a missing, changed or unreadable bundle", async () => {
    const text = JSON.stringify(bundle);
    expect(await loadPlanEvidence(reading(text), artifact("{}"))).toBeUndefined();
    expect(await loadPlanEvidence(reading(text), artifact("{}", { format: "structured" }))).toBeUndefined();
    expect(await loadPlanEvidence(reading(undefined), withEvidence(text))).toBeUndefined();
    expect(await loadPlanEvidence(reading(`${text} `), withEvidence(text))).toBeUndefined();
    expect(await loadPlanEvidence(reading("not json"), withEvidence("not json"))).toBeUndefined();
    const wrongShape = JSON.stringify({ schemaVersion: 1, excerpts: [{ claimId: "x" }] });
    expect(await loadPlanEvidence(reading(wrongShape), withEvidence(wrongShape))).toBeUndefined();
  });
});

describe("shortening a Markdown copy", () => {
  it("leaves a copy that fits as it is", () => {
    expect(shortenMarkdown("# Plan\nOne\n", 100)).toBe("# Plan\nOne\n");
  });

  it("ends with the note it is given instead, still within the limit", () => {
    const cut = shortenMarkdown("a line\n".repeat(100), 120, "… (cut)");
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(120);
    expect(cut.endsWith("a line\n… (cut)\n")).toBe(true);
  });

  it("keeps whole lines within the limit and ends with the note that says it was shortened", () => {
    const long = Array.from({ length: 200 }, (_, at) => `- claim ${at} with some words`).join("\n");
    const cut = shortenMarkdown(long, 500);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(500);
    expect(cut.trimEnd().split("\n").at(-1)).toBe("… (shortened; open the task page for the full plan)");
    expect(cut.startsWith("- claim 0 with some words\n- claim 1")).toBe(true);
    for (const line of cut.trimEnd().split("\n").slice(0, -1)) expect(line).toMatch(/^- claim \d+ with some words$/);
  });
});
