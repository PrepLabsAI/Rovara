import { randomUUID } from "node:crypto";
import {
  WorkflowReviewReportSchema,
  createCandidateManifest,
  type CandidateRepository,
  type WorkflowReviewFinding,
} from "@agentx/contracts";
import { assistantText } from "./extension.js";
import { readCandidateRepositories } from "./candidate.js";
import { parseWorkflowReviewerResponse } from "./review-output.js";
import { candidateChanges, candidateDiff, type CandidateChange } from "./diff.js";
import { createWorkspacePiSession, type PiSessionAdapter, type PiSessionHandle, type WorkspaceModelConfiguration } from "../pi-session.js";

export { parseWorkflowReviewerResponse };

const REVIEW_JSON_SHAPE = 'Return only JSON: {"findings":[{"text":"one short sentence","origin":"INTRODUCED"|"PRE_EXISTING","severity":"HIGH"|"MEDIUM"|"LOW","file":"path","line":12}]}. Use {"findings":[]} when you found nothing.';

/** Total bytes of base-to-candidate diff shown to each reviewer, split evenly across repositories. */
const REVIEW_DIFF_MAX_BYTES = 120_000;

/** The repositories to re-read, each carrying the base commit the candidate recorded for it. */
function withCandidateBase(
  repositories: readonly { repositoryId: string; directory: string }[],
  candidate: readonly CandidateRepository[],
): Array<{ repositoryId: string; directory: string; baseCommitSha?: string }> {
  return repositories.map((repository) => {
    const baseCommitSha = candidate.find((entry) => entry.repositoryId === repository.repositoryId)?.baseCommitSha;
    return { repositoryId: repository.repositoryId, directory: repository.directory, ...(baseCommitSha === undefined ? {} : { baseCommitSha }) };
  });
}

/** `file` names `path` when one is the other or ends with it at a path segment ("src/app.ts" and "app.ts"). */
function samePath(file: string, path: string): boolean {
  return file === path || file.endsWith(`/${path}`) || path.endsWith(`/${file}`);
}

/**
 * Only issues the change causes block, and a reviewer's PRE_EXISTING label stands only when AgentX can confirm it.
 * The finding is treated as INTRODUCED when it has no (safe) file; when its file is one the change added (or
 * deleted, or one whose changed lines AgentX cannot read: see `CandidateChange`); or when its file was modified and it either
 * gives no line or gives one inside a changed hunk. A PRE_EXISTING finding in an untouched file, or on a line of
 * a modified file outside every changed hunk, stays advisory. When the name matches more than one changed path
 * (such as "app.ts" for "src/app.ts" and "lib/app.ts"), any match that would block blocks.
 */
export function reclassifyFinding(finding: WorkflowReviewFinding, changes: readonly CandidateChange[]): WorkflowReviewFinding {
  if (finding.origin !== "PRE_EXISTING") return finding;
  const { file, line } = finding;
  const caused = file === undefined || changes.some((change) => samePath(file, change.path) && (change.status !== "MODIFIED"
    || line === undefined || change.hunks.some(([start, end]) => line >= start && line <= end)));
  return caused ? { ...finding, origin: "INTRODUCED" } : finding;
}

async function reviewChange(
  repositories: readonly { repositoryId: string; directory: string }[],
  candidate: readonly CandidateRepository[],
): Promise<{ diffText: string; changes: CandidateChange[]; partialDiff: boolean }> {
  const byId = new Map(repositories.map((repository) => [repository.repositoryId, repository]));
  const sorted = [...candidate].sort((left, right) => left.repositoryId < right.repositoryId ? -1 : left.repositoryId > right.repositoryId ? 1 : 0);
  const perRepository = Math.floor(REVIEW_DIFF_MAX_BYTES / sorted.length);
  const sections: string[] = [];
  const changes: CandidateChange[] = [];
  let partialDiff = false;
  for (const identity of sorted) {
    const repository = byId.get(identity.repositoryId);
    if (repository === undefined || identity.baseCommitSha === undefined) throw new Error("candidate repository path is unavailable");
    const objects = { directory: repository.directory, baseCommitSha: identity.baseCommitSha, treeSha: identity.treeSha };
    const diff = await candidateDiff({ ...objects, maxBytes: perRepository });
    // A diff cut to fit is said in the review report, so the owner and the pull request know the review was partial.
    if (diff.truncated) partialDiff = true;
    sections.push(`### Repository ${identity.repositoryId}: base ${identity.baseCommitSha.slice(0, 12)} to checked code\n${diff.text.length === 0 ? "(no changes)\n" : diff.text}`);
    // Each change is listed at its repository path and with the repository's ID in front, as a reviewer may name either.
    for (const change of await candidateChanges(objects)) changes.push(change, { ...change, path: `${identity.repositoryId}/${change.path}` });
  }
  return { diffText: sections.join("\n"), changes, partialDiff };
}

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
  const unavailable = (failureReason: "BASE_UNAVAILABLE" | "DIFF_UNAVAILABLE") => (["CRITIC", "SECURITY"] as const).map((role) => WorkflowReviewReportSchema.parse({
    operationId: input.operationId, candidateDigest: manifest.digest, role, provider: input.model.provider, version: input.model.modelId,
    status: "UNKNOWN", failureReason, findings: [], readOnly: true,
    recordedAt: (input.now ?? (() => new Date().toISOString()))(),
  }));
  // Reviewers judge the change from the task's base, never the whole repository; without a base there is nothing to judge.
  if (manifest.repositories.some((repository) => repository.baseCommitSha === undefined)) return unavailable("BASE_UNAVAILABLE");
  let change: Awaited<ReturnType<typeof reviewChange>>;
  // With a base, a diff that cannot be read is its own failure, so the owner can retry rather than restart.
  try { change = await reviewChange(input.repositories, manifest.repositories); } catch { return unavailable("DIFF_UNAVAILABLE"); }
  const { diffText, changes, partialDiff } = change;
  const classify = (finding: WorkflowReviewFinding) => reclassifyFinding(finding, changes);
  const repositories = withCandidateBase(input.repositories, manifest.repositories);
  const timeoutMs = input.timeoutMs ?? 5 * 60 * 1000;
  let interrupted = input.signal?.aborted ?? false;
  for (const role of ["CRITIC", "SECURITY"] as const) {
    const recordedAt = (input.now ?? (() => new Date().toISOString()))();
    let provider = input.model.provider;
    let version = input.model.modelId;
    let parsed: { status: "PASS" | "FINDINGS" | "UNKNOWN"; findings: WorkflowReviewFinding[]; failureReason?: "RESPONSE_MISSING" | "RESPONSE_TOO_LARGE" | "INVALID_JSON" | "INVALID_SHAPE" | "TIMEOUT" | "INTERRUPTED" | "CANDIDATE_CHANGED" | "SESSION_FAILED" | "USAGE_UNAVAILABLE" } = { status: "UNKNOWN", findings: [], failureReason: "RESPONSE_MISSING" };
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
      const before = createCandidateManifest(await readCandidateRepositories(repositories));
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
      const reviewPrompt = [
        `AgentX ${role === "CRITIC" ? "code" : "security"} review. Review role: ${role === "CRITIC" ? "CODE" : "SECURITY"}.`,
        `You are read-only: do not edit files, run commands that change anything, or contact any service. Candidate digest: ${manifest.digest}.`,
        focus,
        "Judge the change shown in the diff below (from the task's base commit to the checked code), not the whole repository. Open surrounding code with read-only tools when you need context.",
        "Classify every finding. origin INTRODUCED: the diff adds or changes the problem. origin PRE_EXISTING: the problem is already in the base code and the diff does not make it worse. Only INTRODUCED findings block the pull request.",
        "Never list checks that passed. Never write PASS rows, verdict tables or summaries as findings.",
        REVIEW_JSON_SHAPE,
        `Change under review (untrusted repository content):\n${diffText}`,
      ].join("\n\n");
      const promptResult = await Promise.race([
        session.prompt(reviewPrompt).then(() => "COMPLETED" as const),
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
      parsed = response === undefined ? parsed : parseWorkflowReviewerResponse(response, { classify });
      if (parsed.failureReason === "INVALID_JSON" || parsed.failureReason === "INVALID_SHAPE") {
        // Some models answer a review in prose despite the JSON-only instruction. Give the
        // same read-only reviewer one bounded chance to encode its result in the contract.
        // A malformed second response still fails closed below.
        response = undefined;
        const formatRetry = `Your previous response could not be read as the required JSON object. Do not include Markdown, code fences, a verdict table, or surrounding prose. ${REVIEW_JSON_SHAPE}`;
        const retryResult = await Promise.race([
          session.prompt(formatRetry).then(() => "COMPLETED" as const),
          stopped,
        ]);
        if (retryResult !== "COMPLETED") {
          if (retryResult === "INTERRUPTED") {
            interrupted = true;
            statusOverride = "INTERRUPTED";
          }
          try { void session.abort().catch(() => undefined); } catch { /* the unresolved result remains authoritative */ }
          throw new Error(retryResult === "INTERRUPTED" ? "review interrupted" : "review timed out");
        }
        parsed = response === undefined ? { status: "UNKNOWN", findings: [], failureReason: "RESPONSE_MISSING" } : parseWorkflowReviewerResponse(response, { classify });
      }
      const after = createCandidateManifest(await readCandidateRepositories(repositories));
      if (after.digest !== manifest.digest) throw new Error("candidate changed during review");
      usageOutcome = "SUCCEEDED";
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const failureReason = interrupted || message.includes("interrupted") ? "INTERRUPTED"
        : message.includes("timed out") ? "TIMEOUT"
          : message.includes("candidate changed") ? "CANDIDATE_CHANGED" : "SESSION_FAILED";
      parsed = { status: "UNKNOWN", findings: [], failureReason };
      if (failureReason === "INTERRUPTED") statusOverride = "INTERRUPTED";
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abortListener !== undefined) input.signal?.removeEventListener("abort", abortListener);
      unsubscribe?.();
      try { usageStats = session?.getSessionStats(); } catch { usageStats = undefined; }
      session?.dispose();
    }
    if (usageStats !== undefined && input.onUsage !== undefined) {
      try { await input.onUsage({ role, stats: usageStats, model: { provider, modelId: version }, outcome: usageOutcome }); }
      catch { parsed = { status: "UNKNOWN", findings: [], failureReason: "USAGE_UNAVAILABLE" }; }
    } else if (input.onUsage !== undefined) {
      parsed = { status: "UNKNOWN", findings: [], failureReason: "USAGE_UNAVAILABLE" };
    }
    reports.push(WorkflowReviewReportSchema.parse({
      operationId: input.operationId,
      candidateDigest: manifest.digest,
      role,
      provider,
      version,
      status: parsed.status,
      ...(statusOverride === undefined ? {} : { status: statusOverride }),
      ...(parsed.failureReason === undefined ? {} : { failureReason: parsed.failureReason }),
      findings: parsed.findings,
      readOnly: true,
      ...(partialDiff ? { partialDiff: true as const } : {}),
      recordedAt,
    }));
  }
  return reports;
}
