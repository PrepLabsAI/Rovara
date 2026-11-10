// Design review stage: the small pure readings the dispatch and the recording make of a task and its documents. Nothing here reads a store or calls a model.
//   - the design's reading list (§8) becomes the packet builder's `sources`: names only, never a tool or an argument (those are derived by code in mcp-allowlist.ts);
// - the approved requirements' ids, for the broker's own findings;
//   - the pinned commits, which are the BROKER's (the task's prepared base), never a worker's `baseCommits`;
//   - the task's own request thread, withheld from every packet (security M6/N8).
import { readDesignMeta, type ContextSource } from "@agentx/contracts";
import { parseMcpItemRef, type PacketOriginItem } from "./mcp-allowlist.js";
import type { DesignSourceRef } from "./packet.js";

/** At most this many requirement ids are looked for; more than that is a requirements document no reader could check against a design anyway. */
export const REQUIREMENT_IDS_MAX = 60;
/** A requirement id as the approved requirements write it: `R1`, `R12`. A line starts with it (after a list marker or emphasis), followed by a separator. */
const REQUIREMENT_LINE = /^[\s>*_#-]*\**(R[0-9]{1,3})\**(?=[\s:.)\]-]|$)/u;

/** The requirement ids the approved requirements name, in order of first appearance. A requirements document without `R<n>` ids gives none, so the broker adds no finding it cannot back (a document in an older form is not blamed for a template it never had). */
export function requirementIdsOf(requirementsMarkdown: string): string[] {
  const ids: string[] = [];
  for (const line of requirementsMarkdown.split(/\r?\n/u)) {
    const id = REQUIREMENT_LINE.exec(line)?.[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
    if (ids.length >= REQUIREMENT_IDS_MAX) break;
  }
  return ids;
}

/**
 * The reading list of the design (§8, the `rovara-design-meta` block) as the packet builder takes it. A design with no readable block has no reading list (the reviewers get the design and the requirements and say what they
 * could not check); a repository source that names no repository is read from the project's only repository, else left out. An MCP source that is not `sourceId:itemRef` is left out. The builder bounds the rest.
 */
export function designSourcesOf(designMarkdown: string, repositoryNames: readonly string[]): DesignSourceRef[] {
  const meta = readDesignMeta(designMarkdown);
  if (!meta.ok) return [];
  const sources: DesignSourceRef[] = [];
  for (const source of meta.meta.sources) {
    if (source.kind === "repo_file") {
      const repo = source.repo ?? (repositoryNames.length === 1 ? repositoryNames[0] : undefined);
      if (repo !== undefined) sources.push({ kind: "repo_file", repo, path: source.ref });
    } else if (source.kind === "meta_repo_file") {
      sources.push({ kind: "meta_repo_file", path: source.ref });
    } else {
      const item = parseMcpItemRef(source.ref);
      if (item !== undefined) sources.push({ kind: "mcp_item", sourceId: item.sourceId, itemRef: item.itemRef });
    }
  }
  return sources;
}

/** The task's prepared base as the pins a packet and a citation check use: repository name to commit. */
export function pinsOf(preparedBase: ReadonlyArray<{ repositoryId: string; baseCommitSha: string }> | undefined): Record<string, string> {
  return Object.fromEntries((preparedBase ?? []).map((entry) => [entry.repositoryId, entry.baseCommitSha] as const));
}

/** The tracker systems a task's `origin` came from. The task does not record WHICH item it came from, so the whole source of that system is withheld (an `itemRef` of "" names the source itself in `isOriginItem`). */
const ORIGIN_SYSTEMS: Readonly<Record<string, readonly string[]>> = {
  linear: ["linear"], jira: ["jira"], github_issue: ["github", "github_issues"], tracker: ["linear", "jira", "github", "github_issues"],
};

/** The request threads to keep out of the packets: for a task that came from a tracker, every configured source of that tracker. Fail closed: a task from a tracker whose sources cannot be told apart withholds all of the tracker kinds. */
export function originOf(taskOrigin: string | undefined, sources: readonly Pick<ContextSource, "sourceId" | "system">[]): PacketOriginItem[] {
  const systems = taskOrigin === undefined ? undefined : ORIGIN_SYSTEMS[taskOrigin];
  if (systems === undefined) return [];
  return sources.filter((source) => source.system === undefined || systems.includes(source.system.toLowerCase())).map((source) => ({ sourceId: source.sourceId, itemRef: "" }));
}
