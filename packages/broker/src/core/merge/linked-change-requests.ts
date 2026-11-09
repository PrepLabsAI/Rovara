// P6 (Enterprise foundations), ported by lane L7a: the reverse link from a published change request to its task, keyed by the neutral repository identity.
//
// A link is `CODEHOST_CR#<kind>#<repository key>` / `CR#<id>` (the writer is the publish step, lane L7b / task flow). GitHub's older rows (`GITHUB_PR#<owner/repo>` / `PR#<number>`) are read
// too, so a store that holds Cloud's rows needs no migration. A row that does not say what its key says (another host, another repository, another id) is not a link.
import type { DocumentStore, PluginKind, TransactItem } from "@agentx/contracts";
import { when } from "@agentx/contracts";
import { codeHostRepositoryKey } from "./repository-key.js";
import type { LinkedChangeRequestFinder } from "./seams.js";
import { plain } from "./store.js";

export const LINKED_CHANGE_REQUEST_ENTITY = "CODEHOST_WORKFLOW_CR";
const LEGACY_ENTITY = "GITHUB_WORKFLOW_PR";

/** A change request id the key can hold: the host's own id, no `#`, no control characters. Whole numbers are zero-padded so they sort, as the old key's pull request numbers did. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

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

/** The Put for a new link (it only succeeds when absent, so a second task can never take a change request). Undefined when it cannot be keyed. */
export function linkedChangeRequestItem(input: Omit<LinkedChangeRequest, "source" | "repositoryKey"> & { repositoryAddress: string; createdAt: string }): TransactItem | undefined {
  const key = linkedChangeRequestKey(input.hostKind, input.repositoryAddress, input.changeRequestId);
  const repositoryKey = codeHostRepositoryKey(input.hostKind, input.repositoryAddress);
  if (key === undefined || repositoryKey === undefined) return undefined;
  const { hostKind, changeRequestId, repositoryId, number, url, taskId, workspaceId, candidateDigest, createdAt } = input;
  return { kind: "put", condition: when.absent(), item: plain({ ...key, entityType: LINKED_CHANGE_REQUEST_ENTITY, hostKind, repositoryKey, changeRequestId, repositoryId, number, url, taskId, workspaceId, candidateDigest, createdAt }) };
}

/** The old GitHub link's key: `GITHUB_PR#<owner/repo lower case>` / `PR#<number padded to ten digits>`. */
function legacyKey(repositoryFullName: string, number: number): { pk: string; sk: string } | undefined {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName) || !Number.isSafeInteger(number) || number < 1) return undefined;
  return { pk: `GITHUB_PR#${repositoryFullName.toLowerCase()}`, sk: `PR#${String(number).padStart(10, "0")}` };
}

/**
 * The task a change request is linked to, or undefined. Reads the neutral row, then the old GitHub row (GitHub only). A row that does not say what its key says is not a link. The old row is
 * read as it was: its repository name and number must match the ones asked for.
 */
export async function findLinkedChangeRequest(store: Pick<DocumentStore, "get">, query: { hostKind: PluginKind; repositoryAddress: string; id: string }): Promise<LinkedChangeRequest | undefined> {
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
  const oldKey = legacyKey(repositoryKey, Number(query.id));
  if (oldKey === undefined) return undefined;
  const legacy = await store.get(oldKey);
  if (legacy === undefined || legacy["entityType"] !== LEGACY_ENTITY || typeof legacy["repositoryFullName"] !== "string" || legacy["repositoryFullName"].toLowerCase() !== repositoryKey
    || legacy["number"] !== Number(query.id) || typeof legacy["repositoryId"] !== "string" || typeof legacy["taskId"] !== "string"
    || typeof legacy["workspaceId"] !== "string" || typeof legacy["candidateDigest"] !== "string" || typeof legacy["url"] !== "string") return undefined;
  return {
    source: "github-legacy", hostKind: "github", repositoryKey, changeRequestId: query.id, repositoryId: legacy["repositoryId"], number: legacy["number"], url: legacy["url"],
    taskId: legacy["taskId"], workspaceId: legacy["workspaceId"], candidateDigest: legacy["candidateDigest"],
  };
}

/** The finder merge code takes, read from the document store. */
export function storeLinkedChangeRequests(store: Pick<DocumentStore, "get">): LinkedChangeRequestFinder {
  return { find: async (query) => {
    const found = await findLinkedChangeRequest(store, query);
    return found === undefined ? undefined : { taskId: found.taskId, repositoryId: found.repositoryId, url: found.url };
  } };
}
