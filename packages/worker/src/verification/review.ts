import { randomUUID } from "node:crypto";
import { WorkflowReviewReportSchema, createCandidateManifest, type CandidateRepository } from "@agentx/contracts";
import { assistantText } from "./extension.js";
import { readCandidateRepositories } from "./candidate.js";
import { parseWorkflowReviewerResponse } from "./review-output.js";
import { createWorkspacePiSession, type PiSessionAdapter, type PiSessionHandle, type WorkspaceModelConfiguration } from "../pi-session.js";

export { parseWorkflowReviewerResponse };

export async function runWorkflowReviews(input: {
  operationId: string;
  rootPath: string;
  model: WorkspaceModelConfiguration;
  candidate: readonly CandidateRepository[];
  repositories: readonly { repositoryId: string; directory: string }[];
  piAdapter?: PiSessionAdapter;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => string;
  onProgress?: (message: string) => void;
  onUsage?: (usage: { role: "CRITIC" | "SECURITY"; stats: ReturnType<PiSessionHandle["getSessionStats"]>; model: WorkspaceModelConfiguration; outcome: "SUCCEEDED" | "FAILED" }) => Promise<void>;
}): Promise<Array<ReturnType<typeof WorkflowReviewReportSchema.parse>>> {
  const manifest = createCandidateManifest(input.candidate);
  const reports: Array<ReturnType<typeof WorkflowReviewReportSchema.parse>> = [];
  const timeoutMs = input.timeoutMs ?? 5 * 60 * 1000;
  let interrupted = input.signal?.aborted ?? false;
  for (const role of ["CRITIC", "SECURITY"] as const) {
    const recordedAt = (input.now ?? (() => new Date().toISOString()))();
    let provider = input.model.provider;
    let version = input.model.modelId;
    let parsed: { status: "PASS" | "FINDINGS" | "UNKNOWN"; findings: string[] } = { status: "UNKNOWN", findings: [] };
    let session: Awaited<ReturnType<typeof createWorkspacePiSession>> | undefined;
    let unsubscribe: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let usageStats: ReturnType<PiSessionHandle["getSessionStats"]> | undefined;
    let usageOutcome: "SUCCEEDED" | "FAILED" = "FAILED";
    let statusOverride: "INTERRUPTED" | undefined = interrupted ? "INTERRUPTED" : undefined;
    try {
      if (statusOverride !== undefined) throw new Error("review interrupted");
      input.onProgress?.(`AgentX is running the ${role === "CRITIC" ? "code" : "security"} review on this candidate.`);
      const before = createCandidateManifest(await readCandidateRepositories(input.repositories));
      if (before.digest !== manifest.digest) throw new Error("candidate changed before review");
      session = await createWorkspacePiSession({
        rootPath: input.rootPath,
        model: input.model,
        workflowMode: "REVIEW",
        conversationId: randomUUID(),
      }, input.piAdapter);
      const actualModel = session.getModel();
      provider = actualModel.provider;
      version = actualModel.modelId;
      let response: string | undefined;
      unsubscribe = session.subscribe((event: unknown) => {
        const record = event as { type?: unknown; payload?: { type?: unknown }; message?: unknown };
        if (record.type === "message_end" || record.payload?.type === "message_end") response = assistantText(record.message ?? (event as { message?: unknown }).message);
      });
      const focus = role === "CRITIC"
        ? "Review logic, correctness, edge cases, compatibility, and whether tests cover the change."
        : "Review security boundaries, authorization, input validation, secret exposure, unsafe operations, and data handling.";
      const stopped = new Promise<"TIMEOUT" | "INTERRUPTED">((resolve) => {
        timeout = setTimeout(() => resolve("TIMEOUT"), timeoutMs);
        if (input.signal !== undefined) {
          abortListener = () => resolve("INTERRUPTED");
          input.signal.addEventListener("abort", abortListener, { once: true });
          if (input.signal.aborted) abortListener();
        }
      });
      const promptResult = await Promise.race([
        session.prompt([
        `Read-only ${role.toLowerCase()} review of the current candidate. Candidate digest: ${manifest.digest}.`,
        focus,
        "Do not edit files, run commands, or change state. Return only JSON with this shape: {\"findings\":[\"short actionable finding\"]}. Return an empty findings array only when you found no issue. If you cannot complete the review, return {\"findings\":[\"Review incomplete: ...\"]}.",
        ].join("\n\n")).then(() => "COMPLETED" as const),
        stopped,
      ]);
      if (promptResult !== "COMPLETED") {
        if (promptResult === "INTERRUPTED") {
          interrupted = true;
          statusOverride = "INTERRUPTED";
        }
        // Do not let a faulty adapter turn a timeout/cancel into another unbounded wait.
        try { void session.abort().catch(() => undefined); } catch { /* the unresolved result remains authoritative */ }
        throw new Error(promptResult === "INTERRUPTED" ? "review interrupted" : "review timed out");
      }
      const after = createCandidateManifest(await readCandidateRepositories(input.repositories));
      if (after.digest !== manifest.digest) throw new Error("candidate changed during review");
      parsed = response === undefined ? parsed : parseWorkflowReviewerResponse(response);
      usageOutcome = "SUCCEEDED";
    } catch {
      parsed = { status: "UNKNOWN", findings: [] };
      if (interrupted) statusOverride = "INTERRUPTED";
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abortListener !== undefined) input.signal?.removeEventListener("abort", abortListener);
      unsubscribe?.();
      try { usageStats = session?.getSessionStats(); } catch { usageStats = undefined; }
      session?.dispose();
    }
    if (usageStats !== undefined && input.onUsage !== undefined) {
      try { await input.onUsage({ role, stats: usageStats, model: { provider, modelId: version }, outcome: usageOutcome }); }
      catch { parsed = { status: "UNKNOWN", findings: [] }; }
    } else if (input.onUsage !== undefined) {
      parsed = { status: "UNKNOWN", findings: [] };
    }
    reports.push(WorkflowReviewReportSchema.parse({
      operationId: input.operationId,
      candidateDigest: manifest.digest,
      role,
      provider,
      version,
      status: parsed.status,
      ...(statusOverride === undefined ? {} : { status: statusOverride }),
      findings: parsed.findings,
      readOnly: true,
      recordedAt,
    }));
  }
  return reports;
}
