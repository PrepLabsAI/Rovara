// What the workspaces page and its local server say to each other (spec 041).
import type { DeveloperWorkspacesResponse } from "@agentx/contracts";

/** The session token minted for this run. Sent as a header by the page's own requests, and in the
 * query string only where a browser cannot set a header: the document and its module. */
export const UI_TOKEN_HEADER = "x-agentx-ui-token";
export const UI_TOKEN_QUERY = "t";

/** One workspace as the page draws it: the server's record plus the word shown on its pill. */
export interface UiWorkspace {
  id: string;
  projectName: string;
  projectRevision: number;
  /** A developer-facing word ("ready", "working", "closed"), resolved on this side of the wire. */
  state: string;
  createdAt: string;
  updatedAt: string;
}

export interface UiData {
  env: string;
  url: string;
  developer: { name: string };
  projects: DeveloperWorkspacesResponse["projects"];
  workspaces: UiWorkspace[];
  notices: DeveloperWorkspacesResponse["notices"];
  /** When the control plane was last read, so the page can say how fresh the list is. */
  readAt: string;
}

/** `GET /data`: the list, or why it could not be read, in words already safe to show. */
export type UiDataReply = { ok: true; data: UiData } | { ok: false; error: string };
