// Port lane L7a: the finder merge code takes, read from the document store through lane L7b's reader of the reverse link (`proof/revert/linked-change-requests.ts`).
import type { DocumentStore } from "@agentx/contracts";
import { findLinkedChangeRequest } from "../proof/revert/linked-change-requests.js";
import type { LinkedChangeRequestFinder } from "./seams.js";

export function storeLinkedChangeRequests(store: Pick<DocumentStore, "get">): LinkedChangeRequestFinder {
  return { find: async (query) => {
    const found = await findLinkedChangeRequest(store, query);
    return found === undefined ? undefined : { taskId: found.taskId, repositoryId: found.repositoryId, url: found.url };
  } };
}
