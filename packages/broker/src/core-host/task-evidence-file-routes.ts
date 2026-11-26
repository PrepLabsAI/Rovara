// RD-2d: the file behind a link of the task page's checks read, `GET /v1/app/tasks/{taskId}/evidence/{sha256}` (the hrefs `evidenceViewOf` writes: `evidenceHref`, core/proof/evidence-pack.ts). One stored artifact of the
// task's CURRENT evidence pack: a command output tail (text) or a screenshot (JPEG). Evidence is code-derived (command output and pictures can show a secret the trace scrubber never saw), so every rule below fails closed.
//
// ACCESS, in this order, each refusal the SAME answer as a task that does not exist (`TASK_NOT_FOUND`, same words, same status; nothing of the task, the pack or the file in it):
//   1. the one read rule (core/task-flow/read-rule.ts `decideTaskRead`, read "evidenceFile"), asked ONCE by the mount in dev-routes.ts before this file runs: another company's task, a colleague who may not read it, a company admin who
//      may not read it, a missing task. A share (the reader the owner shared the task with) is shown the task's summary and not its checks, so it is told TASK_PART_NOT_SHOWN (403), and the F2-E reduced admin view does not apply.
//      This file holds no access rule of its own: it is given `decision`.
//   2. `decision.codeDetails` (read-rule.ts `mayReadCodeDetails`: a live project grant proved on THIS request): a separate part of the decision for what is derived from the code, refused as the missing task before anything of the pack is read.
//   3. the sha must be a link of the task's CURRENT pack (the pack kept for the task's current code, read through the company-bound store, under THIS task's own key): never another task's file, never an object the pack does not
//      name, never one of an older candidate, never a kind this route does not serve (only text and JPEG; no video, trace or API sample).
// Only after those, and only for a reader of this task: a file past its retention, or bytes that are no longer the pack's (size, SHA-256, kind), answer fixed words (never the bytes); a store that cannot answer says so.
//
// THE FILE. The content type is fixed by the kind the pack recorded, never sniffed: JPEG as `image/jpeg`; command output as `text/plain; charset=utf-8` ONLY (never HTML, whatever it contains), with `x-content-type-options:
// nosniff`, a locked-down content policy (no script, no framing) and a safe `content-disposition` (a fixed file name made from the digest). `cache-control: no-store`. The size cap is the kind's own (`EVIDENCE_ARTIFACT_MAX_BYTES`):
// the read stops at the pack's own byte count. An audit line (who, task, sha, kind: never the bytes) is recorded BEFORE the bytes leave; no record, no file. The bytes are never logged.
import { randomUUID } from "node:crypto";
import { agentXError, servableEvidenceArtifact, type AuditEvent, type AuditSink, type EvidenceArtifactKind, type ObjectStorage } from "@agentx/contracts";
import { evidenceArtifactKey, readEvidenceArtifact } from "../core/proof/evidence-artifacts.js";
import { loadEvidencePack } from "../core/proof/evidence-keep.js";
import { evidenceViewOf } from "../core/proof/evidence-pack.js";
import { taskNotFound } from "../core/task-flow/access.js";
import type { TaskCaller } from "../core/task-flow/deps.js";
import type { TaskReadDecision } from "../core/task-flow/read-rule.js";
import type { TaskFlow } from "../core/task-flow/flow.js";
import type { BrokerResponse } from "../handler.js";
import { hostedEvidenceBlobs } from "./hosted-evidence.js";

/** `/v1/app/tasks/<uuid>/evidence/<sha256>`. The digest is not judged here: a malformed one is simply not a link of the pack, after the task read, and answers as every other refusal does. */
const EVIDENCE_FILE = /^\/v1\/app\/tasks\/([0-9a-f-]{36})\/evidence\/([^/]+)$/u;

/** The task and the digest the path names, when the path and method are this route's (GET only); otherwise undefined. */
export function taskEvidenceFileRoute(path: string, method: string): { taskId: string; sha256: string } | undefined {
  const match = EVIDENCE_FILE.exec(path);
  return match === null || method !== "GET" ? undefined : { taskId: match[1]!, sha256: match[2]! };
}

/** The fixed words of this route (the only text it ever says besides the missing task's). */
export const EVIDENCE_FILE_WORDS = {
  expired: "This file is past its retention period and is no longer kept.",
  withheld: "This file is not available.",
  unavailable: "Rovara couldn't read this file just now. Try again in a minute.",
  notRecorded: "Rovara couldn't record this read just now, so the file was not shown. Try again in a minute.",
} as const;

/** The audit action this route writes. */
export const EVIDENCE_READ_AUDIT = "task.evidence_read";

/** What is served, by the kind the pack recorded: the content type is this table's, never the object's own metadata and never sniffed. */
const SERVED: Readonly<Partial<Record<EvidenceArtifactKind, { type: string; extension: string; binary: boolean }>>> = {
  jpeg: { type: "image/jpeg", extension: "jpg", binary: true },
  log_txt: { type: "text/plain; charset=utf-8", extension: "txt", binary: false },
};

export interface EvidenceFileContext {
  flow: TaskFlow;
  blobs: ObjectStorage;
  caller: TaskCaller;
  audit: AuditSink;
  now: () => number;
  /** The one read rule's decision for this person and this file, made by the mount. */
  decision: TaskReadDecision;
  taskId: string;
  sha256: string;
}

const HEADERS = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
} as const;

export async function readTaskEvidenceFile(context: EvidenceFileContext): Promise<BrokerResponse> {
  const { flow, blobs, caller, sha256, decision } = context;
  // 1. The mount asked the one read rule before this ran: the task is the decision's.
  const record = decision.task;
  // 2. What is derived from the code is a part of the decision of its own (a live project grant proved on this request).
  if (!decision.codeDetails) throw taskNotFound();
  // 3. The sha must be a link of the task's current pack, read through the company-bound store under this task's own key.
  const evidence = hostedEvidenceBlobs({ blobs, store: flow.deps.store, companyId: flow.deps.companyId });
  const owner = { ownerKey: record.ownerKey, workspaceId: record.workspaceId, taskId: record.taskId };
  const candidateDigest = record.workflow?.candidate?.digest;
  const pack = await loadEvidencePack(evidence, owner, candidateDigest);
  const view = pack === undefined ? undefined : evidenceViewOf(pack, record.taskId, () => "available");
  const link = servableEvidenceArtifact(view, candidateDigest, sha256);
  const served = link === undefined ? undefined : SERVED[link.kind];
  if (link === undefined || served === undefined) throw taskNotFound();
  // A reader of this task, and a file the pack names: retention, then the bytes themselves (size, SHA-256 and kind are re-checked against the pack's own record before they leave).
  let held: Awaited<ReturnType<ObjectStorage["stat"]>>;
  try {
    held = await evidence.stat(evidenceArtifactKey(record.ownerKey, record.workspaceId, record.taskId, sha256));
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", EVIDENCE_FILE_WORDS.unavailable);
  }
  if (held === undefined) throw agentXError("NOT_FOUND", EVIDENCE_FILE_WORDS.expired);
  const read = await readEvidenceArtifact({ store: { blobs: evidence }, authorize: async () => ({ ...owner, candidateDigest, view }) }, sha256);
  if (read.status === 503) throw agentXError("RUNTIME_UNAVAILABLE", EVIDENCE_FILE_WORDS.unavailable);
  if (read.status !== 200) throw agentXError("NOT_FOUND", EVIDENCE_FILE_WORDS.withheld);
  // No record, no file. The line names the person, the task, the digest and the kind: never the bytes.
  const event: AuditEvent = {
    eventId: `${EVIDENCE_READ_AUDIT}:${flow.deps.companyId}:${record.taskId}:${randomUUID()}`, companyId: flow.deps.companyId, at: new Date(context.now()).toISOString(),
    actor: { type: "person", id: caller.principal.personId }, action: EVIDENCE_READ_AUDIT, subject: { type: "task", id: record.taskId }, details: { sha256, kind: link.kind },
  };
  try {
    await context.audit.record(event);
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", EVIDENCE_FILE_WORDS.notRecorded);
  }
  const headers = { ...HEADERS, "content-type": served.type, "content-disposition": `inline; filename="evidence-${sha256.slice(0, 12)}.${served.extension}"` };
  // A picture goes out as base64 (the gateway decodes it); text goes out as the text it was checked to be.
  return served.binary
    ? { statusCode: 200, headers, isBase64Encoded: true, body: Buffer.from(read.bytes).toString("base64") }
    : { statusCode: 200, headers, body: new TextDecoder("utf-8").decode(read.bytes) };
}
