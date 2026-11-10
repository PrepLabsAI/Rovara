// P6 (Plug-in foundations): the reverse link from a published change request to its task, keyed by the neutral repository identity.
//
// A link has a neutral key, `CODEHOST_CR#<kind>#<repository key>` / `CR#<id>`, and every reader reads BOTH: the neutral row first, then (for GitHub only) the old row `GITHUB_PR#<owner/repo>` / `PR#<number>`
// (developer/task-records.ts `githubWorkflowPullRequestKey`). The writer is the task flow's (lane L6a), which publishes the change request; this module reads, and builds the step for a host other than GitHub.
import type { DocumentStore, PluginKind, TransactItem } from "@agentx/contracts";
import { when } from "@agentx/contracts";
import { githubWorkflowPullRequestKey, type GithubWorkflowPullRequestRecord } from "../../../developer/task-records.js";
import { codeHostRepositoryKey } from "./repository-key.js";

export const LINKED_CHANGE_REQUEST_ENTITY = "CODEHOST_WORKFLOW_CR";

/** A change request id the key can hold: the host's own id, no `#`, no control characters. Whole numbers are zero-padded so they sort, as the old key's pull request numbers did. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface LinkedChangeRequestRecord {
  pk: string;
  sk: string;
  entityType: typeof LINKED_CHANGE_REQUEST_ENTITY;
  hostKind: PluginKind;
  repositoryKey: string;
  changeRequestId: string;
  /** The project's name for the repository. */
  repositoryId: string;
  /** The change request's number, for a host whose ids are whole numbers (the workflow records one). */
  number: number;
  url: string;
  taskId: string;
  workspaceId: string;
  candidateDigest: string;
  createdAt: string;
}

/** The link as a reader sees it, whichever row held it. */
export interface LinkedChangeRequest {
  source: "neutral" | "github-legacy";
  hostKind: PluginKind;
  repositoryKey: string;
  changeRequestId: string;
  repositoryId: string;
  number: number;
  url: string;
  taskId: string;
  workspaceId: string;
  candidateDigest: string;
}

/** The neutral key of a link, or undefined when the repository address or the id cannot be keyed (a reader then finds no link). */
export function linkedChangeRequestKey(hostKind: PluginKind, repositoryAddress: string, id: string): { pk: string; sk: string } | undefined {
  const repositoryKey = codeHostRepositoryKey(hostKind, repositoryAddress);
  if (repositoryKey === undefined || !ID.test(id)) return undefined;
  return { pk: `CODEHOST_CR#${hostKind}#${repositoryKey}`, sk: `CR#${/^[0-9]{1,10}$/.test(id) ? id.padStart(10, "0") : id}` };
}

/** The step for a new link on a host other than GitHub (it only succeeds when absent, so a second task can never take a change request). Undefined when it cannot be keyed. */
export function linkedChangeRequestStep(input: Omit<LinkedChangeRequestRecord, "pk" | "sk" | "entityType" | "repositoryKey" | "changeRequestId"> & { repositoryAddress: string; changeRequestId: string }): TransactItem | undefined {
  const key = linkedChangeRequestKey(input.hostKind, input.repositoryAddress, input.changeRequestId);
  const repositoryKey = codeHostRepositoryKey(input.hostKind, input.repositoryAddress);
  if (key === undefined || repositoryKey === undefined) return undefined;
  const { hostKind, changeRequestId, repositoryId, number, url, taskId, workspaceId, candidateDigest, createdAt } = input;
  return { kind: "put", condition: when.absent(), item: { ...key, entityType: LINKED_CHANGE_REQUEST_ENTITY, hostKind, repositoryKey, changeRequestId, repositoryId, number, url, taskId, workspaceId, candidateDigest, createdAt } };
}

/** The old GitHub link (`GITHUB_PR#<owner/repo>`), as it was read before P6: only an already-published pull request, and only when the row says what its key says. */
export async function findLegacyGithubLink(store: Pick<DocumentStore, "get">, input: { repositoryFullName: string; number: number }): Promise<GithubWorkflowPullRequestRecord | undefined> {
  let key: ReturnType<typeof githubWorkflowPullRequestKey>;
  try {
    key = githubWorkflowPullRequestKey(input.repositoryFullName, input.number);
  } catch {
    return undefined;
  }
  const item = await store.get(key);
  if (item?.["entityType"] !== "GITHUB_WORKFLOW_PR" || typeof item["repositoryFullName"] !== "string" || item["repositoryFullName"].toLowerCase() !== input.repositoryFullName.toLowerCase()
    || item["number"] !== input.number || typeof item["repositoryId"] !== "string" || typeof item["taskId"] !== "string"
    || typeof item["workspaceId"] !== "string" || typeof item["candidateDigest"] !== "string" || typeof item["url"] !== "string") return undefined;
  return item as unknown as GithubWorkflowPullRequestRecord;
}

/**
 * The task a change request is linked to, or undefined. Reads the neutral row, then the old GitHub row (GitHub only). A row that does not say what its key says (another
 * host, another repository, another id) is not a link. The old row is read as it was: its repository name and number must match the ones asked for.
 */
export async function findLinkedChangeRequest(
  store: Pick<DocumentStore, "get">,
  query: { hostKind: PluginKind; connectionKind?: PluginKind | undefined; repositoryAddress: string; id: string },
): Promise<LinkedChangeRequest | undefined> {
  const found = await findLinkedChangeRequestOf(store, query);
  if (found !== undefined || query.connectionKind === undefined || query.connectionKind === query.hostKind) return found;
  // Dual read (lane P2, review L1): rows are filed by the connection's PROVIDER, so a connection can be renamed without orphaning them. A row an earlier build filed under the connection's own name is still found.
  return findLinkedChangeRequestOf(store, { hostKind: query.connectionKind, repositoryAddress: query.repositoryAddress, id: query.id });
}

async function findLinkedChangeRequestOf(
  store: Pick<DocumentStore, "get">,
  query: { hostKind: PluginKind; repositoryAddress: string; id: string },
): Promise<LinkedChangeRequest | undefined> {
  const key = linkedChangeRequestKey(query.hostKind, query.repositoryAddress, query.id);
  const repositoryKey = codeHostRepositoryKey(query.hostKind, query.repositoryAddress);
  if (key === undefined || repositoryKey === undefined) return undefined;
  const item = await store.get(key);
  if (item !== undefined) {
    const valid = item["entityType"] === LINKED_CHANGE_REQUEST_ENTITY && item["hostKind"] === query.hostKind && item["repositoryKey"] === repositoryKey && item["changeRequestId"] === query.id
      && typeof item["repositoryId"] === "string" && typeof item["number"] === "number" && Number.isSafeInteger(item["number"]) && typeof item["url"] === "string"
      && typeof item["taskId"] === "string" && typeof item["workspaceId"] === "string" && typeof item["candidateDigest"] === "string";
    // A row under this key that is not a link for it is a refusal, not a miss to be filled from the old row.
    if (!valid) return undefined;
    return {
      source: "neutral", hostKind: query.hostKind, repositoryKey, changeRequestId: query.id, repositoryId: item["repositoryId"] as string, number: item["number"] as number,
      url: item["url"] as string, taskId: item["taskId"] as string, workspaceId: item["workspaceId"] as string, candidateDigest: item["candidateDigest"] as string,
    };
  }
  if (query.hostKind !== "github" || !/^[1-9][0-9]{0,9}$/.test(query.id)) return undefined;
  const legacy = await findLegacyGithubLink(store, { repositoryFullName: repositoryKey, number: Number(query.id) });
  if (legacy === undefined) return undefined;
  return {
    source: "github-legacy", hostKind: "github", repositoryKey, changeRequestId: query.id, repositoryId: legacy.repositoryId, number: legacy.number, url: legacy.url,
    taskId: legacy.taskId, workspaceId: legacy.workspaceId, candidateDigest: legacy.candidateDigest,
  };
}
