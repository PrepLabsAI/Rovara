// L4-ART: the flow's `artifacts` reader on a hosted root (the broker's and the dispatcher's runtime). The registry's `object-storage` point holds EVERY company's objects in one bucket, so the flow is never
// handed it as it is: this reader answers a key only when the key names a workspace of THIS company's own store (and, for the owner-keyed form, the owner that workspace was started for). Anything else
// is `undefined`, the same answer as an object that is not there, so a reader of the flow can never be made to show another task's or another company's document.
//
// Two key shapes are the flow's own (both are written by the engine, never by a worker or a person):
//   private/<ownerKey>/<workspaceId>/<...>                       plan, design and requirements documents (core/plan/store.ts) and the other task documents
//   workspaces/<workspaceId>/operations/<operationId>/<name>     (held to this company's own ARTIFACT row for it) a worker's saved artifacts (services/callbacks.ts `artifactObjectKey`: the plan Markdown, the diff, the critic's answer, the eval round)
// Every other shape (an install-wide or another point's key, a key with a dot part, a malformed key) is refused.
import { isValidObjectKey, type DocumentStore, type ObjectStorage, type OrgId } from "@agentx/contracts";
import { locateWorkspace } from "../core/task-flow/workspace-location.js";
import type { ArtifactReader } from "../core/task-flow/deps.js";

/** The most bytes one read may ask for, whatever the caller says: the largest reader of the flow (a design review's result, 1.5 MB) fits; nothing asks for more. */
export const COMPANY_ARTIFACT_READ_MAX_BYTES = 1_572_864;

/** Why a read gave nothing, in fixed words (never the key, the company or the cause). */
export type ArtifactReadRefusal = "bad_request" | "key_not_task_document" | "workspace_not_company" | "owner_mismatch" | "artifact_not_recorded" | "storage_unavailable" | "oversized";

export interface CompanyArtifactReaderOptions {
  blobs: Pick<ObjectStorage, "get">;
  /** The company's own store (the registry's `storage`): where the workspace record that binds a key to this company is read. */
  store: Pick<DocumentStore, "get">;
  companyId: OrgId;
  /** The most bytes one read may ask for, whatever the caller says. Absent: `COMPANY_ARTIFACT_READ_MAX_BYTES`. The evidence store raises it to what its own readers ask for (the raw file's 2 MiB cap, the pack's 4 MiB). */
  maxReadBytes?: number;
  /** Told, best effort, why a read gave nothing. Fixed words only; a fault in it never reaches the caller. */
  refused?: (reason: ArtifactReadRefusal) => void;
}

/** A workspace id or owner key as the engine writes them: letters, digits, `_` and `-`, up to 200. */
const COMPONENT = /^[A-Za-z0-9_-]{1,200}$/u;

export type KeyScope = { form: "owner"; ownerKey: string; workspaceId: string } | { form: "operation"; workspaceId: string; operationId: string; name: string };

/** Which workspace (and owner) a key says it belongs to, or undefined when it is not one of the flow's own shapes. Pure. */
export function artifactKeyScopeOf(objectKey: unknown): KeyScope | undefined {
  if (typeof objectKey !== "string" || !isValidObjectKey(objectKey)) return undefined;
  const parts = objectKey.split("/");
  if (parts[0] === "private" && parts.length >= 4) {
    const [, ownerKey, workspaceId] = parts;
    return COMPONENT.test(ownerKey!) && COMPONENT.test(workspaceId!) ? { form: "owner", ownerKey: ownerKey!, workspaceId: workspaceId! } : undefined;
  }
  // `<name>` is one part, or `<name>/<sha256>` for a replaceable artifact (the row's own key).
  if (parts[0] === "workspaces" && (parts.length === 5 || parts.length === 6) && parts[2] === "operations") {
    return COMPONENT.test(parts[1]!) && COMPONENT.test(parts[3]!) ? { form: "operation", workspaceId: parts[1]!, operationId: parts[3]!, name: parts[4]! } : undefined;
  }
  return undefined;
}

/** The workspace a key's scope names, held to THIS company (a legacy record counts only for the install's own company) and, for an owner-keyed form, to the owner that workspace was started for; otherwise the fixed reason it is not. */
export async function workspaceHoldingKey(options: Pick<CompanyArtifactReaderOptions, "store" | "companyId">, scope: KeyScope): Promise<NonNullable<Awaited<ReturnType<typeof locateWorkspace>>> | ArtifactReadRefusal> {
  let workspace: Awaited<ReturnType<typeof locateWorkspace>>;
  try {
    // Read from THIS company's own partition (a workspace of another company is not found here, and a legacy workspace is only the install's own company's).
    workspace = await locateWorkspace({ store: options.store, companyId: options.companyId }, scope.workspaceId);
  } catch {
    return "storage_unavailable";
  }
  // `locateWorkspace` has held the record to THIS company; the record must also be the workspace the key names.
  if (workspace === undefined || workspace.workspace["id"] !== scope.workspaceId) return "workspace_not_company";
  if (scope.form === "owner" && workspace.workspace["ownerKey"] !== scope.ownerKey) return "owner_mismatch";
  return workspace;
}

/**
 * The flow's `artifacts` reader for one company. Fails closed everywhere: a request that is not well formed, a key outside the company's own workspaces, an owner that is not the workspace's,
 * a store that cannot answer, an object that is missing, unreadable or bigger than the (bounded) limit all give `undefined`. It never throws and never answers from a key it did not check.
 */
export function createCompanyArtifactReader(options: CompanyArtifactReaderOptions): ArtifactReader {
  const { blobs, store, companyId } = options;
  const refuse = (reason: ArtifactReadRefusal): undefined => {
    try { options.refused?.(reason); } catch { /* a log never changes an answer */ }
    return undefined;
  };
  return {
    async get(objectKey, maxBytes) {
      if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return refuse("bad_request");
      const limit = Math.min(maxBytes, options.maxReadBytes ?? COMPANY_ARTIFACT_READ_MAX_BYTES);
      const scope = artifactKeyScopeOf(objectKey);
      if (scope === undefined) return refuse("key_not_task_document");
      const held = await workspaceHoldingKey({ store, companyId }, scope);
      if (typeof held === "string") return refuse(held);
      const workspace = held;
      if (scope.form === "operation") {
        // S3 keys carry no company, so a callback-shaped key is also held to THIS company's own record of the artifact: the row of that operation and name must exist in this workspace and name exactly this key.
        // (A key that merely looks right, whatever its workspace id, is never read.)
        let row: Awaited<ReturnType<typeof store.get>>;
        try {
          row = await store.get(workspace.row(`ARTIFACT#${scope.operationId}#${scope.name}`));
        } catch {
          return refuse("storage_unavailable");
        }
        if (row === undefined || row["objectKey"] !== objectKey) return refuse("artifact_not_recorded");
      }
      let bytes: Uint8Array | undefined;
      try {
        bytes = await blobs.get(objectKey, limit);
      } catch {
        return refuse("storage_unavailable");
      }
      if (bytes === undefined) return undefined;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > limit) return refuse("oversized");
      return bytes;
    },
  };
}
